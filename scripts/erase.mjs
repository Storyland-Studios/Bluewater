#!/usr/bin/env node
/* ===================================================================
   npm run erase — remove one person from the record
   ===================================================================

     npm run erase -- someone@example.com          shows what would go
     npm run erase -- someone@example.com --yes     removes it

   DATABASE.md documents this as a one-line DELETE, and it is. This script
   exists anyway, for two reasons.

   First, a deletion request is exactly the wrong moment to be composing
   SQL by hand against production. A mistyped WHERE clause on `viewers` is
   unrecoverable, and there is no undo.

   Second, it prints what it is about to remove and does nothing at all
   unless --yes is passed. A dry run by default is the whole point: you get
   to see that you matched one person and not forty before anything happens.

   The foreign keys cascade, so removing the viewer row takes their reads,
   their per-slide times and their events with it. This verifies that
   afterwards rather than assuming it.
   =================================================================== */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { loadEnv, connectionString, sslFor, noConnectionStringMessage } from './_lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(root);

const url = connectionString({ preferDirect: true });
if (!url) {
  console.error(noConnectionStringMessage());
  process.exit(1);
}

const args    = process.argv.slice(2);
const confirm = args.includes('--yes');
const email   = (args.find(a => !a.startsWith('--')) ?? '').trim().toLowerCase();

if (!email) {
  console.error('\nWhich email address?\n');
  console.error('  npm run erase -- someone@example.com          # dry run');
  console.error('  npm run erase -- someone@example.com --yes    # do it\n');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });

try {
  await client.connect();

  /* Exact match on the stored form. The API lowercases and trims before
     writing, and this lowercases and trims before reading, so the two agree.
     No LIKE, no wildcards — a deletion tool must not be able to match more
     than what was typed. */
  const { rows } = await client.query(
    `select v.id, v.email, v.name, v.org, v.first_seen_at,
            (select count(*) from reads       r where r.viewer_id = v.id) as reads,
            (select count(*) from read_slides d
               join reads r on r.id = d.read_id where r.viewer_id = v.id)  as slide_rows,
            (select count(*) from events      e where e.viewer_id = v.id) as events
       from viewers v
      where v.email = $1`,
    [email]
  );

  if (!rows.length) {
    console.log(`\nNo record of ${email}. Nothing to remove.\n`);
    process.exit(0);
  }

  const v = rows[0];
  console.log('');
  console.log(`  ${v.name}${v.org ? `  ·  ${v.org}` : ''}`);
  console.log(`  ${v.email}`);
  console.log(`  first seen ${new Date(v.first_seen_at).toISOString().slice(0, 10)}`);
  console.log('');
  console.log(`  would remove:  1 viewer, ${v.reads} read${v.reads === '1' ? '' : 's'}, ` +
              `${v.slide_rows} slide row${v.slide_rows === '1' ? '' : 's'}, ` +
              `${v.events} event${v.events === '1' ? '' : 's'}`);
  console.log('');

  if (!confirm) {
    console.log('  Dry run. Nothing was changed.');
    console.log(`  To go ahead:  npm run erase -- ${email} --yes\n`);
    process.exit(0);
  }

  await client.query('begin');
  const gone = await client.query('delete from viewers where id = $1', [v.id]);

  /* Trust the cascade only after checking it. If any of these is non-zero the
     foreign keys are not what the schema says, and this is the moment to find
     out — inside a transaction that can still be rolled back. */
  const left = await client.query(
    `select (select count(*) from reads  where viewer_id = $1) as reads,
            (select count(*) from events where viewer_id = $1) as events`,
    [v.id]
  );

  if (Number(left.rows[0].reads) || Number(left.rows[0].events)) {
    await client.query('rollback');
    console.error('  Rolled back: rows survived that should have cascaded.');
    console.error(`  reads left ${left.rows[0].reads}, events left ${left.rows[0].events}`);
    console.error('  The foreign keys do not match db/schema.sql. Re-run: npm run migrate\n');
    process.exitCode = 1;
  } else {
    await client.query('commit');
    console.log(`  Removed. ${gone.rowCount} viewer row, and everything that hung off it.\n`);
  }
} catch (err) {
  try { await client.query('rollback'); } catch { /* connection already gone */ }
  if (/relation .* does not exist/i.test(err.message)) {
    console.error('\nThe tables are not there. Run: npm run migrate\n');
  } else {
    console.error(`\n${err.message}\n`);
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
