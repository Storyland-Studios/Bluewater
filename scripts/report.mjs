#!/usr/bin/env node
/* ===================================================================
   npm run report — who has read the deck
   ===================================================================

   The same data as GET /api/viewers, printed to a terminal. It exists
   because the quickest question about this database — "has anyone opened
   it yet?" — should not need a deployed endpoint, an admin token and a
   JSON viewer to answer.

     npm run report                 the readers, newest first
     npm run report -- --slides     and where each of them spent the time
     npm run report -- --csv        machine-readable instead

   Uses DATABASE_URL from .env or the environment.
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

const args     = process.argv.slice(2);
const wantCsv  = args.includes('--csv');
const wantAll  = args.includes('--slides');

const dur = ms => {
  const s = Math.round(Number(ms) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

const client = new pg.Client({ connectionString: url, ssl: sslFor(url) });

try {
  await client.connect();

  const { rows } = await client.query(`
    select email, name, org, phone, total_ms, slides_seen, slides_total,
           visits, reads, finished, wrap_opened, last_read_at
      from viewer_summary
     order by last_seen_at desc
  `);

  if (wantCsv) {
    const columns = Object.keys(rows[0] ?? { email: null });
    console.log(columns.join(','));
    for (const row of rows) {
      console.log(columns.map(c => {
        const value = row[c];
        if (value === null || value === undefined) return '';
        const text = value instanceof Date ? value.toISOString() : String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      }).join(','));
    }
  } else if (!rows.length) {
    console.log('\nNobody has signed in yet.\n');
    console.log('The tables are there and empty — which is also what you would see');
    console.log('if the deck were pointed at a different database, so if you expected');
    console.log('readers here, check API_ORIGIN in the deck and DATABASE_URL on Vercel.\n');
  } else {
    console.log(`\n${rows.length} reader${rows.length === 1 ? '' : 's'}\n`);
    for (const row of rows) {
      const flags = [
        row.finished ? 'finished' : null,
        row.wrap_opened ? 'saw the read-back' : null,
        Number(row.reads) > 1 ? `${row.reads} devices` : null,
        row.visits > 1 ? `${row.visits} visits` : null
      ].filter(Boolean);

      console.log(`  ${row.name}${row.org ? `  ·  ${row.org}` : ''}`);
      console.log(`    ${row.email}${row.phone ? `  ·  ${row.phone}` : ''}`);
      console.log(`    ${dur(row.total_ms)} across ${row.slides_seen}` +
                  `${row.slides_total ? ` of ${row.slides_total}` : ''} slides` +
                  `${flags.length ? `  ·  ${flags.join(', ')}` : ''}`);
      if (row.last_read_at) {
        console.log(`    last read ${new Date(row.last_read_at).toISOString().slice(0, 16).replace('T', ' ')}`);
      }
      console.log('');
    }

    if (wantAll) {
      /* Keyed on v.id, not v.name. Only email is unique, so two investors who
         happen to share a name were being summed into one block — while the
         listing above correctly showed them as two people, so a single run
         could contradict itself. Grouping on title had the same problem as the
         export did: a slide retitled between two reads split into two rows. */
      const detail = await client.query(`
        select v.id, v.name, v.email,
               d.slide_index + 1 as slide,
               (array_agg(d.title order by (d.title is null), d.ms desc))[1] as title,
               sum(d.ms)::bigint as ms
          from read_slides d
          join reads r   on r.id = d.read_id
          join viewers v on v.id = r.viewer_id
         group by v.id, v.name, v.email, d.slide_index
         order by v.id, ms desc
      `);

      let current = null;
      for (const row of detail.rows) {
        if (row.id !== current) {
          current = row.id;
          console.log(`  ${row.name} <${row.email}> — where the time went`);
        }
        console.log(`    ${String(row.slide).padStart(3)}  ${dur(row.ms).padEnd(8)} ` +
                    `${row.title ?? ''}`);
      }
      if (detail.rows.length) console.log('');
    }
  }
} catch (err) {
  if (/relation .* does not exist/i.test(err.message)) {
    console.error('\nThe tables are not there yet. Run: npm run migrate\n');
  } else {
    console.error(`\n${err.message}\n`);
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
