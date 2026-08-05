#!/usr/bin/env node
/* ===================================================================
   npm run migrate — apply db/schema.sql
   ===================================================================

   There is no psql on the machine this was written on, and asking whoever
   deploys this to install Postgres locally just to create four tables is
   a poor trade. So the schema is applied through the driver we already
   depend on.

   schema.sql is idempotent, so this is safe to run against a live
   database and safe to run twice. It is the only way the schema is meant
   to be applied — if a column needs adding later, add it to schema.sql as
   another `alter table ... add column if not exists` and run this again.

   Reads .env if there is one, so the connection string does not have to be
   pasted into the shell each time.
   =================================================================== */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try { process.loadEnvFile(path.join(root, '.env')); }
catch { /* no .env — the variables are expected to be in the environment */ }

/* The pooled connection string is what the API should use; a pooler in
   transaction mode can reject a multi-statement script like this one. Neon
   and Vercel Postgres both expose the direct string as DATABASE_URL_UNPOOLED,
   so prefer it when it is there. */
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is not set.\n');
  console.error('Copy .env.example to .env and put the connection string in it,');
  console.error('or set it for one command:\n');
  console.error('  DATABASE_URL="postgres://..." npm run migrate\n');
  process.exit(1);
}

function sslFor(connectionString) {
  if (/[?&]sslmode=disable/.test(connectionString)) return false;
  let host = '';
  try { host = new URL(connectionString).hostname; } catch { /* assume remote */ }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  if (/^(1|true|yes)$/i.test(process.env.PGSSL_NO_VERIFY ?? '')) {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

const sql = await readFile(path.join(root, 'db', 'schema.sql'), 'utf8');
const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });

let host = 'the database';
try { host = new URL(url).host; } catch { /* keep the generic label */ }

console.log(`Applying db/schema.sql to ${host} …`);

try {
  await client.connect();

  /* One transaction: a schema half-applied because statement nine failed is
     worse than one not applied at all. Postgres can roll back DDL, so this
     genuinely is all-or-nothing. */
  await client.query('begin');
  await client.query(sql);
  await client.query('commit');
} catch (err) {
  try { await client.query('rollback'); } catch { /* connection already gone */ }
  console.error('\nMigration failed — nothing was applied.\n');
  console.error(err.message);
  if (/self[- ]signed|certificate/i.test(err.message)) {
    console.error('\nA certificate error usually means a provider with a private CA.');
    console.error('If that is expected, retry with PGSSL_NO_VERIFY=1.');
  }
  await client.end().catch(() => {});
  process.exit(1);
}

/* Separate from the apply, and deliberately so: the schema is committed by
   this point, so a stumble while listing what landed is not a failed
   migration and must not be reported as one. */
try {
  const { rows } = await client.query(`
    select c.relname as name,
           case c.relkind when 'v' then 'view' else 'table' end as kind,
           coalesce(s.n_live_tup, 0)::bigint as rows
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_user_tables s on s.relid = c.oid
     where n.nspname = current_schema()
       and c.relkind in ('r', 'v')
       and c.relname in ('viewers', 'reads', 'read_slides', 'events', 'viewer_summary')
     order by c.relkind, c.relname
  `);

  console.log('\nDone. In place now:\n');
  for (const row of rows) {
    const count = row.kind === 'view' ? '' : `  ~${row.rows} rows`;
    console.log(`  ${row.kind.padEnd(5)} ${row.name.padEnd(16)}${count}`);
  }
  console.log('\nSet the same DATABASE_URL in the Vercel project and redeploy.');
} catch (err) {
  console.log('\nSchema applied. Could not list what landed, which is cosmetic:');
  console.log(`  ${err.message}`);
} finally {
  await client.end().catch(() => {});
}
