#!/usr/bin/env node
/* ===================================================================
   npm run dev — the deck and the API, locally, with nothing to set up
   ===================================================================

   Serves the deck on http://localhost:3000 and routes /api/* to the real
   handlers, backed by PGlite: Postgres compiled to WebAssembly, running in
   this process. No Postgres to install, no connection string to find, no
   Vercel CLI, no network.

   The database is in memory and goes away when this stops. That is the
   point — it is for seeing the wiring work, not for keeping anything.

     npm run dev                 in-memory database, fresh every time
     npm run dev -- --port 4000  somewhere else
     npm run dev -- --seed       with a few readers already recorded, so
                                 the read-back shows real benchmark figures

   To run against a real database instead, set DATABASE_URL and use
   `vercel dev`, which is what production actually looks like.

   The deck's own door asks for a passphrase before the sign-in card. To
   skip it while testing, open the console and run:

     sessionStorage.setItem('nateland-door-v1', '1'); location.reload()
   =================================================================== */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

const portIndex = args.indexOf('--port');
const PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : 3000;
const PG_PORT = PORT + 10000;
const DECK = 'nateland-investor-deck-EXTERNAL.html';

const db = await PGlite.create();
const pgServer = new PGLiteSocketServer({
  db, port: PG_PORT, host: '127.0.0.1', maxConnections: 6
});

/* Both ports are derived from --port, so a dev server left running in another
   terminal collides here. Say which port and what to do about it, rather than
   printing an EADDRINUSE stack trace that looks like a bug in this script. */
try {
  await pgServer.start();
} catch (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PG_PORT} is taken, so the in-memory database cannot start.`);
    console.error('Almost always another `npm run dev` still running.\n');
    console.error('Either stop that one:');
    console.error(`  Windows:  netstat -ano | findstr ${PG_PORT}   then  taskkill /PID <pid> /F`);
    console.error(`  macOS/Linux:  lsof -ti tcp:${PG_PORT} | xargs kill`);
    console.error('\nOr run this one somewhere else:');
    console.error('  npm run dev -- --port 4000\n');
    await db.close().catch(() => {});
    process.exit(1);
  }
  throw err;
}

process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres?sslmode=disable`;
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-token';

await db.exec(await readFile(path.join(root, 'db', 'schema.sql'), 'utf8'));

/* Imported after DATABASE_URL is set. The pool is lazy so the order is not
   strictly required, but relying on that would be a trap for the next
   person to add a handler that connects at import time. */
const routes = {
  '/api/signin':  (await import('../api/signin.js')).default,
  '/api/beat':    (await import('../api/beat.js')).default,
  '/api/stats':   (await import('../api/stats.js')).default,
  '/api/viewers': (await import('../api/viewers.js')).default
};

/* Titles for the seeded slides, matching the deck's own data-title values so
   the benchmark column reads the way it will in production. 0-based, as the
   database stores them. */
const TITLES = {
  0: 'Cover',
  16: 'The team',
  19: 'Site strategy',
  20: 'Attendance methodology',
  21: 'Economic projections'
};

if (args.includes('--seed')) {
  /* Four readers, which clears the deck's MIN_REAL_READERS floor of three,
     so the benchmark column shows real figures instead of the samples and
     the difference is visible on screen. */
  const people = [
    ['ada@example.com',   'Ada Lovelace', 'Analytical Engines', [[21, 96_000], [20, 74_000], [16, 55_000], [0, 12_000]]],
    ['grace@example.com', 'Grace Hopper', 'UNIVAC',             [[21, 120_000], [16, 61_000], [19, 44_000], [0, 9_000]]],
    ['alan@example.com',  'Alan Turing',  'NPL',                [[21, 71_000], [20, 88_000], [16, 40_000], [0, 15_000]]],
    ['katherine@example.com', 'Katherine Johnson', 'NASA',      [[21, 104_000], [20, 66_000], [19, 58_000], [0, 11_000]]]
  ];

  for (const [email, name, org, slides] of people) {
    const viewer = await db.query(
      `insert into viewers (email, name, first_name, org)
            values ($1, $2, $3, $4)
       on conflict (email) do update set name = excluded.name
         returning id`,
      [email, name, name.split(' ')[0], org]
    );
    const readId = randomUUID();
    const total = slides.reduce((sum, [, ms]) => sum + ms, 0);

    await db.query(
      `insert into reads (id, viewer_id, visits, total_ms, slides_seen, slides_total,
                          finished, wrap_opened, user_agent)
            values ($1, $2, 1, $3, $4, 30, true, true, 'seed')`,
      [readId, viewer.rows[0].id, total, slides.length]
    );

    let order = 0;
    for (const [index, ms] of slides) {
      await db.query(
        `insert into read_slides (read_id, slide_index, title, ms, order_index)
              values ($1, $2, $3, $4, $5)`,
        [readId, index, TITLES[index] ?? `Slide ${index + 1}`, ms, order++]
      );
    }
  }
  console.log(`\n  seeded ${people.length} readers`);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = routes[url.pathname];

  if (route) {
    /* Vercel hands handlers a parsed query; the raw Node request does not
       have one. The rest — reading the body off the stream, the headers —
       the handlers already do for themselves. */
    req.query = Object.fromEntries(url.searchParams);
    try {
      await route(req, res);
    } catch (err) {
      console.error(err);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: 'server error' }));
      }
    }
    console.log(`  ${String(res.statusCode).padEnd(4)} ${req.method.padEnd(7)} ${url.pathname}`);
    return;
  }

  /* Static, from the repo root. The rewrite in vercel.json maps / to the
     deck; do the same here so the local URL matches the deployed one. */
  const name = url.pathname === '/' ? `/${DECK}` : url.pathname;
  const file = path.join(root, path.normalize(name).replace(/^[\\/]+/, ''));

  if (!file.startsWith(root)) { res.statusCode = 403; res.end('no'); return; }

  /* Nothing dot-prefixed, ever. The repo root holds .env — DATABASE_URL and
     ADMIN_TOKEN — and .git, and a static server rooted here would hand either
     to anyone who asked. path.normalize already blocks climbing above root;
     this blocks the files sitting inside it that are not ours to serve. */
  if (path.relative(root, file).split(/[\\/]/).some(seg => seg.startsWith('.'))) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.statusCode = 200;
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.on('error', async (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is taken, so the deck cannot be served.`);
    console.error('Try:  npm run dev -- --port 4000\n');
  } else {
    console.error(err);
  }
  await pgServer.stop().catch(() => {});
  await db.close().catch(() => {});
  process.exit(1);
});

/* 127.0.0.1, not every interface. Without a host argument Node binds 0.0.0.0
   and ::, which puts an unauthenticated view of this repo — and an admin token
   that defaults to a guessable string — on whatever café or office network the
   laptop is joined to. The banner has always printed localhost URLs; this makes
   that the truth rather than a suggestion. */
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  deck   http://localhost:${PORT}/`);
  console.log(`  api    http://localhost:${PORT}/api/stats`);
  console.log(`  export http://localhost:${PORT}/api/viewers?token=${process.env.ADMIN_TOKEN}`);
  console.log(`\n  Postgres is in memory and goes away when this stops.`);
  console.log(`  To skip the passphrase, run this in the browser console:`);
  console.log(`    sessionStorage.setItem('nateland-door-v1', '1'); location.reload()\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await pgServer.stop();
    await db.close();
    process.exit(0);
  });
}
