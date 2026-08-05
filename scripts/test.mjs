#!/usr/bin/env node
/* ===================================================================
   npm test — exercise the API against a real Postgres
   ===================================================================

   PGlite is Postgres compiled to WebAssembly, and pglite-socket puts it
   behind a TCP socket speaking the ordinary wire protocol. So `pg`
   connects to it the same way it connects to Neon, the real schema is
   applied, and the handlers under test are the ones that ship — no mocked
   database, no stubbed queries, nothing to drift out of step.

   Only the request and response objects are stand-ins, shaped like the
   ones Vercel passes in.

   Needs no network, no Docker and no credentials. Run it after touching
   anything under api/ or db/.
   =================================================================== */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 55432;

/* ---- the smallest test runner that does the job ------------------- */
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [32m✓[0m ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  [31m✗[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed');
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? 'not equal'}: expected ${expected}, got ${actual}`);
  }
}

/* ---- stand-ins for Vercel's req and res -------------------------- */
function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    end(chunk) { if (chunk !== undefined) this.body += chunk; this.ended = true; return this; }
  };
  return res;
}

/* body as an object mirrors Vercel having parsed it. Pass `stream: true` to
   send it the way navigator.sendBeacon does, unparsed, so the handler has to
   read the request stream itself. */
function mockReq({ method = 'POST', url = '/', body, headers = {}, stream = false } = {}) {
  const base = {
    method,
    url,
    headers: { 'user-agent': 'test-suite/1.0', ...headers },
    socket: { remoteAddress: '198.51.100.7' }
  };

  if (body === undefined) return base;

  if (stream) {
    const raw = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
    return Object.assign(raw, base);
  }
  return { ...base, body };
}

async function call(handler, options) {
  const res = mockRes();
  await handler(mockReq(options), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* csv or empty */ }
  return { res, json, status: res.statusCode };
}

/* ---- bring up the database --------------------------------------- */
console.log('\nStarting PGlite on 127.0.0.1:%d …', PORT);

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: PORT, host: '127.0.0.1', maxConnections: 6 });

/* The port is fixed, so a previous run that was killed mid-flight — or a
   `npm test` still going in another terminal — makes this fail. Unhandled it
   surfaces as a raw EADDRINUSE stack trace, which reads like a broken test
   suite rather than as "something else is already listening". */
try {
  await server.start();
} catch (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use, so the test database cannot start.`);
    console.error('Usually a previous run that did not shut down cleanly.\n');
    console.error('Find and stop it:');
    console.error(`  Windows:  netstat -ano | findstr ${PORT}   then  taskkill /PID <pid> /F`);
    console.error(`  macOS/Linux:  lsof -ti tcp:${PORT} | xargs kill\n`);
    await db.close().catch(() => {});
    process.exit(1);
  }
  throw err;
}

process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${PORT}/postgres?sslmode=disable`;
delete process.env.ADMIN_TOKEN;
delete process.env.IP_SALT;
delete process.env.ALLOWED_ORIGINS;

const schema = await readFile(path.join(root, 'db', 'schema.sql'), 'utf8');
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();

/* Handlers are imported after DATABASE_URL is set. The pool is lazy, so this
   is belt and braces rather than a requirement. */
const { default: signin }  = await import('../api/signin.js');
const { default: beat }    = await import('../api/beat.js');
const { default: stats }   = await import('../api/stats.js');
const { default: viewers } = await import('../api/viewers.js');
const dbLib = await import('../api/_db.js');

const READ_A = randomUUID();
const READ_B = randomUUID();

console.log('\nschema\n');

await test('schema applies', async () => {
  await admin.query(schema);
  const { rows } = await admin.query(`
    select count(*)::int as n from information_schema.tables
     where table_schema = current_schema()
       and table_name in ('viewers','reads','read_slides','events')`);
  equal(rows[0].n, 4, 'four tables');
});

await test('schema applies twice (idempotent)', async () => {
  await admin.query(schema);
});

await test('viewer_summary view resolves', async () => {
  const { rows } = await admin.query('select count(*)::int as n from viewer_summary');
  equal(rows[0].n, 0, 'empty to start');
});

console.log('\nsignin\n');

await test('rejects a body with no readId', async () => {
  const { status } = await call(signin, { body: { email: 'a@b.co', name: 'A' } });
  equal(status, 400);
});

await test('rejects a malformed email', async () => {
  const { status, json } = await call(signin, {
    body: { readId: READ_A, email: 'not-an-email', name: 'A' }
  });
  equal(status, 400);
  assert(/email/.test(json.error), 'says which field');
});

await test('rejects a missing name', async () => {
  const { status } = await call(signin, { body: { readId: READ_A, email: 'a@b.co', name: '  ' } });
  equal(status, 400);
});

await test('records a sign-in', async () => {
  const { status, json } = await call(signin, {
    body: {
      readId: READ_A, name: 'Ada Lovelace', email: '  ADA@Example.COM ',
      phone: '+44 7700 900123', org: 'Analytical Engines',
      slidesTotal: 30, visits: 1, screen: '1920x1080', tz: 'Europe/London'
    }
  });
  equal(status, 200);
  assert(json.ok && json.viewerId, 'returns a viewer id');

  const { rows } = await admin.query('select * from viewers');
  equal(rows.length, 1, 'one viewer');
  equal(rows[0].email, 'ada@example.com', 'email lowercased and trimmed');
  equal(rows[0].first_name, 'Ada', 'first name derived');
  equal(rows[0].org, 'Analytical Engines');
});

await test('logs the arrival as an event', async () => {
  const { rows } = await admin.query(`select kind from events where read_id = $1`, [READ_A]);
  equal(rows.length, 1);
  equal(rows[0].kind, 'signin');
});

await test('leaves ip_hash null when IP_SALT is unset', async () => {
  const { rows } = await admin.query('select ip_hash from reads where id = $1', [READ_A]);
  equal(rows[0].ip_hash, null);
});

await test('a returning reader does not duplicate the viewer', async () => {
  const { status } = await call(signin, {
    body: { readId: READ_A, name: 'Ada Lovelace', email: 'ada@example.com', visits: 2, returning: true }
  });
  equal(status, 200);
  const { rows } = await admin.query('select count(*)::int as n from viewers');
  equal(rows[0].n, 1, 'still one viewer');
});

await test('a blank optional field does not erase what is stored', async () => {
  const { rows } = await admin.query('select phone, org from viewers');
  equal(rows[0].phone, '+44 7700 900123', 'phone survived a payload without it');
  equal(rows[0].org, 'Analytical Engines', 'org survived too');
});

await test('visits only ever climb', async () => {
  await call(signin, {
    body: { readId: READ_A, name: 'Ada Lovelace', email: 'ada@example.com', visits: 1, returning: true }
  });
  const { rows } = await admin.query('select visits from reads where id = $1', [READ_A]);
  equal(rows[0].visits, 2, 'a stale visits:1 did not overwrite 2');
});

console.log('\nbeat\n');

await test('rejects an unknown readId with 409', async () => {
  const { status, json } = await call(beat, {
    body: { readId: randomUUID(), totalMs: 1000, slidesSeen: 1, slides: [] }
  });
  equal(status, 409);
  assert(/sign in/.test(json.error), 'tells the client what to do');
});

await test('stores per-slide dwell', async () => {
  const { status } = await call(beat, {
    body: {
      readId: READ_A, totalMs: 300_000, slidesSeen: 3, slidesTotal: 30, visits: 2,
      slides: [
        { i: 0,  ms: 40_000,  title: 'Cover',                order: 0 },
        { i: 21, ms: 200_000, title: 'Economic projections',  order: 1 },
        { i: 15, ms: 60_000,  title: 'The team',              order: 2 }
      ]
    }
  });
  equal(status, 200);

  const { rows } = await admin.query(
    'select slide_index, ms, title, order_index from read_slides where read_id = $1 order by slide_index',
    [READ_A]
  );
  equal(rows.length, 3);
  equal(Number(rows[1].ms), 60_000, 'slide 15 stored');
  equal(rows[2].title, 'Economic projections');
});

await test('a duplicated slide in one payload does not error', async () => {
  const { status } = await call(beat, {
    body: {
      readId: READ_A, totalMs: 300_000, slidesSeen: 3,
      slides: [{ i: 0, ms: 10_000, title: 'Cover' }, { i: 0, ms: 44_000, title: 'Cover' }]
    }
  });
  equal(status, 200);
  const { rows } = await admin.query(
    'select ms from read_slides where read_id = $1 and slide_index = 0', [READ_A]
  );
  equal(Number(rows[0].ms), 44_000, 'kept the larger of the two');
});

await test('a late beat cannot walk the totals backwards', async () => {
  /* No title in the payload either, so this doubles as a check that a beat
     which does not carry one leaves the stored title alone. */
  await call(beat, {
    body: { readId: READ_A, totalMs: 1000, slidesSeen: 1, slides: [{ i: 21, ms: 5 }] }
  });
  const read = await admin.query('select total_ms, slides_seen from reads where id = $1', [READ_A]);
  equal(Number(read.rows[0].total_ms), 300_000, 'total held');
  equal(read.rows[0].slides_seen, 3, 'slides_seen held');

  const slide = await admin.query(
    'select ms, title from read_slides where read_id = $1 and slide_index = 21', [READ_A]
  );
  equal(Number(slide.rows[0].ms), 200_000, 'slide dwell held');
  equal(slide.rows[0].title, 'Economic projections', 'title survived a payload without one');
});

await test('finished and wrap_opened latch on', async () => {
  await call(beat, {
    body: { readId: READ_A, totalMs: 320_000, slidesSeen: 3, finished: true, wrapOpened: true, slides: [] }
  });
  await call(beat, {
    body: { readId: READ_A, totalMs: 320_000, slidesSeen: 3, finished: false, wrapOpened: false, slides: [] }
  });
  const { rows } = await admin.query('select finished, wrap_opened from reads where id = $1', [READ_A]);
  assert(rows[0].finished === true, 'finished stayed true');
  assert(rows[0].wrap_opened === true, 'wrap_opened stayed true');
});

await test('clamps an absurd dwell instead of storing it', async () => {
  await call(beat, {
    body: {
      readId: READ_A, totalMs: Number.MAX_SAFE_INTEGER, slidesSeen: 3,
      slides: [{ i: 5, ms: 99 * 24 * 3600 * 1000, title: 'Broken clock' }]
    }
  });
  const read = await admin.query('select total_ms from reads where id = $1', [READ_A]);
  equal(Number(read.rows[0].total_ms), dbLib.MAX_TOTAL_MS, 'total clamped');
  const slide = await admin.query(
    'select ms from read_slides where read_id = $1 and slide_index = 5', [READ_A]
  );
  equal(Number(slide.rows[0].ms), dbLib.MAX_SLIDE_MS, 'slide clamped');
});

await test('accepts a body read off the stream (the beacon path)', async () => {
  const res = mockRes();
  await beat(mockReq({
    stream: true,
    headers: { 'content-type': 'application/json' },
    body: { readId: READ_A, totalMs: 330_000, slidesSeen: 3, slides: [{ i: 2, ms: 7_000, title: 'Why now' }] }
  }), res);
  equal(res.statusCode, 200);
  const { rows } = await admin.query(
    'select ms from read_slides where read_id = $1 and slide_index = 2', [READ_A]
  );
  equal(Number(rows[0].ms), 7_000);
});

await test('stores events and ignores a replayed one', async () => {
  const eventId = randomUUID();
  const payload = {
    readId: READ_A, totalMs: 330_000, slidesSeen: 3, slides: [],
    events: [{ id: eventId, kind: 'wrap_opened', slide: 29, meta: { via: 'hotkey' } }]
  };
  await call(beat, { body: payload });
  await call(beat, { body: payload });          /* the retry */

  const { rows } = await admin.query(
    `select kind, slide_index, meta from events where client_key = $1`, [eventId]
  );
  equal(rows.length, 1, 'stored exactly once');
  equal(rows[0].kind, 'wrap_opened');
  equal(rows[0].slide_index, 29);
  equal(rows[0].meta.via, 'hotkey');
});

await test('drops an event with a non-uuid id rather than failing the beat', async () => {
  const { status } = await call(beat, {
    body: {
      readId: READ_A, totalMs: 330_000, slidesSeen: 3, slides: [],
      events: [{ id: 'nope', kind: 'junk' }, { id: randomUUID(), kind: 'good' }]
    }
  });
  equal(status, 200);
  const { rows } = await admin.query(`select count(*)::int as n from events where kind = 'junk'`);
  equal(rows[0].n, 0);
});

await test('rejects a body that is not JSON', async () => {
  const res = mockRes();
  const req = Object.assign(Readable.from([Buffer.from('{ not json', 'utf8')]), {
    method: 'POST', url: '/', headers: {}, socket: {}
  });
  await beat(req, res);
  equal(res.statusCode, 400);
});

await test('rejects valid JSON that is not an object, with 400 not 500', async () => {
  /* `null`, `7` and `[]` all parse. Each used to reach body.readId and throw a
     TypeError, which is not an HttpError — so a malformed request came back as
     a 500 and logged a stack trace as though it were a bug in the handler. */
  for (const payload of ['null', '7', '[]', '"hello"']) {
    const res = mockRes();
    const req = Object.assign(Readable.from([Buffer.from(payload, 'utf8')]), {
      method: 'POST', url: '/', headers: {}, socket: {}
    });
    await beat(req, res);
    equal(res.statusCode, 400, `body ${payload}`);
    assert(/JSON object/.test(JSON.parse(res.body).error), `explains why for ${payload}`);
  }
});

await test('strips angle brackets from a stored slide title', async () => {
  /* Belt to the deck's braces: the deck escapes on output, which is the real
     fix and the only one that covers rows already stored. This keeps a payload
     out of the table in the first place. Ampersands must survive — they belong
     in real titles. */
  await call(beat, {
    body: {
      readId: READ_A, totalMs: 330_000, slidesSeen: 3,
      slides: [
        { i: 9, ms: 4000, title: '<img src=x onerror=alert(1)>Pricing' },
        { i: 10, ms: 3000, title: 'Costs & reserve' }
      ]
    }
  });
  const { rows } = await admin.query(
    'select slide_index, title from read_slides where read_id = $1 and slide_index in (9,10) order by slide_index',
    [READ_A]
  );
  assert(!rows[0].title.includes('<'), `no < in ${rows[0].title}`);
  assert(!rows[0].title.includes('>'), `no > in ${rows[0].title}`);
  assert(rows[0].title.includes('Pricing'), 'the readable part survives');
  equal(rows[1].title, 'Costs & reserve', 'an ampersand is left alone');
});

console.log('\nstats\n');

await test('a second reader, for a median to mean anything', async () => {
  await call(signin, {
    body: {
      readId: READ_B, name: 'Grace Hopper', email: 'grace@example.com',
      org: 'UNIVAC', slidesTotal: 30, visits: 1
    }
  });
  const { status } = await call(beat, {
    body: {
      readId: READ_B, totalMs: 100_000, slidesSeen: 2, slidesTotal: 30, finished: true,
      slides: [
        { i: 21, ms: 100_000, title: 'Economic projections', order: 0 },
        { i: 15, ms: 20_000,  title: 'The team',             order: 1 }
      ]
    }
  });
  equal(status, 200);
});

await test('aggregates per viewer', async () => {
  const { status, json } = await call(stats, { method: 'GET', url: '/api/stats' });
  equal(status, 200);
  equal(json.viewers, 2, 'two readers');
  equal(json.reads, 2, 'two reads');
  equal(json.finishers, 2, 'both finished');
  assert(json.medianTotalMs > 0, 'a median came back');
  assert(Array.isArray(json.top) && json.top.length > 0, 'top slides came back');
});

await test('reports slide numbers, not indices', async () => {
  const { json } = await call(stats, { method: 'GET', url: '/api/stats' });
  const top = json.top[0];
  equal(top.slide, 22, 'slide_index 21 surfaced as slide 22');
  equal(top.title, 'Economic projections');
  equal(top.readers, 2, 'both readers counted');
  /* Ada 200s, Grace 100s -> median 150s */
  equal(top.ms, 150_000, 'median across readers');
});

await test('a lone reader’s runaway tab cannot top the benchmark', async () => {
  /* The clamp test above parked six hours on slide_index 5 for Ada alone.
     By mean it would outrank everything; it should not appear at all. */
  const { json } = await call(stats, { method: 'GET', url: '/api/stats?limit=12' });
  const lone = json.top.find(t => t.slide === 6);
  assert(!lone, 'the single-reader outlier is excluded');
  assert(json.top.every(t => t.readers >= 2), 'every row has at least two readers');
});

await test('honours ?limit', async () => {
  const { json } = await call(stats, { method: 'GET', url: '/api/stats?limit=1' });
  equal(json.top.length, 1);
});

await test('is CDN-cacheable', async () => {
  const { res } = await call(stats, { method: 'GET', url: '/api/stats' });
  assert(/s-maxage=\d+/.test(res.getHeader('cache-control') ?? ''), 'has s-maxage');
});

await test('refuses a POST', async () => {
  const { status, res } = await call(stats, { method: 'POST', url: '/api/stats', body: {} });
  equal(status, 405);
  assert(/GET/.test(res.getHeader('allow') ?? ''), 'says what it allows');
});

console.log('\nviewers (the export)\n');

await test('stays closed while ADMIN_TOKEN is unset', async () => {
  const { status, json } = await call(viewers, { method: 'GET', url: '/api/viewers' });
  equal(status, 503);
  assert(/ADMIN_TOKEN/.test(json.error), 'says why');
});

await test('rejects a wrong token', async () => {
  process.env.ADMIN_TOKEN = 'correct-horse-battery-staple';
  const { status } = await call(viewers, {
    method: 'GET', url: '/api/viewers', headers: { authorization: 'Bearer wrong' }
  });
  equal(status, 401);
});

await test('rejects a token of the right length but wrong content', async () => {
  /* The point of this case is the timingSafeEqual branch, which is only
     reached when the lengths match — an off-by-one here silently tests the
     cheap length check again instead. So derive it from the real token rather
     than hand-counting a literal. */
  const real = process.env.ADMIN_TOKEN;
  const wrong = 'X' + real.slice(1);
  equal(wrong.length, real.length, 'same length, so the comparison is reached');
  assert(wrong !== real, 'but not the same token');

  const { status } = await call(viewers, {
    method: 'GET', url: '/api/viewers', headers: { authorization: `Bearer ${wrong}` }
  });
  equal(status, 401);
});

await test('rejects a token that is a prefix of the real one', async () => {
  const { status } = await call(viewers, {
    method: 'GET', url: '/api/viewers',
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN.slice(0, -1)}` }
  });
  equal(status, 401);
});

await test('returns the readers to a correct token', async () => {
  const { status, json } = await call(viewers, {
    method: 'GET', url: '/api/viewers',
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` }
  });
  equal(status, 200);
  equal(json.count, 2);
  const ada = json.viewers.find(v => v.email === 'ada@example.com');
  assert(ada, 'Ada is in the list');
  equal(ada.org, 'Analytical Engines');
  assert(ada.minutes > 0, 'minutes computed');
});

await test('never caches personal data', async () => {
  const { res } = await call(viewers, {
    method: 'GET', url: '/api/viewers',
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` }
  });
  assert(/no-store/.test(res.getHeader('cache-control') ?? ''), 'no-store set');
});

await test('adds per-slide detail on ?slides=1', async () => {
  const { json } = await call(viewers, {
    method: 'GET', url: '/api/viewers?slides=1',
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` }
  });
  const ada = json.viewers.find(v => v.email === 'ada@example.com');
  assert(Array.isArray(ada.slides) && ada.slides.length > 0, 'slides present');
  assert(ada.slides.every(s => s.slide >= 1), 'slide numbers are 1-based');
});

await test('a slide retitled between two reads is one row, not two halves', async () => {
  /* The realistic trigger: someone reads on a laptop, the deck is edited, they
     read again on a phone. The two reads hold different titles for the same
     slide. Grouping on title as well as index used to emit that slide twice,
     each row carrying only part of their time — in the export that goes to
     whoever is following up. */
  const second = randomUUID();
  const viewer = await admin.query(`select id from viewers where email = 'ada@example.com'`);
  await admin.query(
    `insert into reads (id, viewer_id, visits, total_ms, slides_seen, finished)
          values ($1, $2, 1, 50000, 1, false)`,
    [second, viewer.rows[0].id]
  );
  await admin.query(
    `insert into read_slides (read_id, slide_index, title, ms, order_index)
          values ($1, 21, 'Economic projections (rev B)', 50000, 0)`,
    [second]
  );

  const { json } = await call(viewers, {
    method: 'GET', url: '/api/viewers?slides=1',
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` }
  });
  const ada = json.viewers.find(v => v.email === 'ada@example.com');
  const slide22 = ada.slides.filter(s => s.slide === 22);
  equal(slide22.length, 1, 'one row for slide 22, not one per title');
  equal(slide22[0].ms, 250_000, 'and it holds the sum of both reads');

  await admin.query('delete from reads where id = $1', [second]);
});

await test('exports CSV with a BOM and a header row', async () => {
  const { res } = await call(viewers, {
    method: 'GET', url: '/api/viewers?format=csv',
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` }
  });
  equal(res.statusCode, 200);
  assert(res.body.startsWith('﻿'), 'BOM for Excel');
  assert(res.body.includes('email,name,org'), 'header row');
  assert(res.body.includes('ada@example.com'), 'a row of data');
  assert(/attachment; filename=/.test(res.getHeader('content-disposition') ?? ''), 'downloads');
});

await test('neutralises a name that Excel would run as a formula', async () => {
  await admin.query(
    `insert into viewers (email, name, org) values ($1, $2, $3)`,
    ['sneaky@example.com', '=HYPERLINK("http://evil.test","clickme")', '+1']
  );
  const { res } = await call(viewers, {
    method: 'GET', url: '/api/viewers?format=csv',
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` }
  });
  assert(res.body.includes(`"'=HYPERLINK`), 'leading = quoted out');
  assert(!/(^|,)=HYPERLINK/m.test(res.body), 'no bare formula anywhere');
  await admin.query(`delete from viewers where email = 'sneaky@example.com'`);
});

console.log('\nCORS and the wrapper\n');

await test('answers a preflight with 204', async () => {
  const { status, res } = await call(beat, {
    method: 'OPTIONS', headers: { origin: 'https://storylandstudios.com' }
  });
  equal(status, 204);
  equal(res.getHeader('access-control-allow-origin'), 'https://storylandstudios.com');
});

await test('allows the WordPress origin that proxies the deck', async () => {
  const { res } = await call(stats, {
    method: 'GET', url: '/api/stats', headers: { origin: 'https://www.storylandstudios.com' }
  });
  equal(res.getHeader('access-control-allow-origin'), 'https://www.storylandstudios.com');
});

await test('allows any preview deployment', async () => {
  const { res } = await call(stats, {
    method: 'GET', url: '/api/stats',
    headers: { origin: 'https://bluewater-git-abc123-storyland.vercel.app' }
  });
  assert(res.getHeader('access-control-allow-origin'), 'echoed the preview origin');
});

await test('does not echo an origin it does not know', async () => {
  const { res } = await call(stats, {
    method: 'GET', url: '/api/stats', headers: { origin: 'https://evil.test' }
  });
  equal(res.getHeader('access-control-allow-origin'), undefined);
});

await test('varies on Origin even when it refuses one', async () => {
  /* Not tidiness. /api/stats is CDN-cached and its CORS header depends on the
     request Origin, so without Vary the first response cached — possibly one
     with no Origin and therefore no CORS header — is replayed to browsers,
     whose cross-origin fetch then fails and whose deck silently falls back to
     the sample benchmark. */
  for (const headers of [{}, { origin: 'https://evil.test' }, { origin: 'https://storylandstudios.com' }]) {
    const { res } = await call(stats, { method: 'GET', url: '/api/stats', headers });
    equal(res.getHeader('vary'), 'Origin',
      `Vary set for ${JSON.stringify(headers)}`);
  }
});

await test('a cacheable response never carries CORS without Vary', async () => {
  const { res } = await call(stats, { method: 'GET', url: '/api/stats', headers: {} });
  const cache = String(res.getHeader('cache-control') ?? '');
  if (/s-maxage/.test(cache)) {
    equal(res.getHeader('vary'), 'Origin', 'shared caches are told what it depends on');
  }
});

await test('is not fooled by an origin that merely ends in the right letters', async () => {
  const { res } = await call(stats, {
    method: 'GET', url: '/api/stats',
    headers: { origin: 'https://notstorylandstudios.com' }
  });
  equal(res.getHeader('access-control-allow-origin'), undefined);
});

await test('honours ALLOWED_ORIGINS', async () => {
  process.env.ALLOWED_ORIGINS = 'https://investors.example.com';
  const { res } = await call(stats, {
    method: 'GET', url: '/api/stats', headers: { origin: 'https://investors.example.com' }
  });
  equal(res.getHeader('access-control-allow-origin'), 'https://investors.example.com');
  delete process.env.ALLOWED_ORIGINS;
});

await test('hashes the IP once IP_SALT is set', async () => {
  process.env.IP_SALT = 'pepper';
  const readC = randomUUID();
  await call(signin, {
    body: { readId: readC, name: 'Alan Turing', email: 'alan@example.com' },
    headers: { 'x-forwarded-for': '203.0.113.9, 70.41.3.18' }
  });
  const { rows } = await admin.query('select ip_hash from reads where id = $1', [readC]);
  assert(/^[0-9a-f]{32}$/.test(rows[0].ip_hash), 'a hex digest');
  assert(!rows[0].ip_hash.includes('203.0.113.9'), 'not the address itself');
  delete process.env.IP_SALT;
});

console.log('\nerasure\n');

await test('deleting a viewer takes their reads, slides and events with them', async () => {
  await admin.query(`delete from viewers where email = 'grace@example.com'`);
  const reads  = await admin.query('select count(*)::int as n from reads where id = $1', [READ_B]);
  const slides = await admin.query('select count(*)::int as n from read_slides where read_id = $1', [READ_B]);
  const events = await admin.query('select count(*)::int as n from events where read_id = $1', [READ_B]);
  equal(reads.rows[0].n, 0, 'read gone');
  equal(slides.rows[0].n, 0, 'slides gone');
  equal(events.rows[0].n, 0, 'events gone');
});

/* ---- down ---------------------------------------------------------- */
await admin.end().catch(() => {});
await dbLib.pool().end().catch(() => {});
await server.stop();
await db.close();

console.log(`\n${passed} passed, ${failures.length} failed\n`);

if (failures.length) {
  for (const { name, err } of failures) {
    console.log(`[31m${name}[0m`);
    console.log(err.stack ?? err.message);
    console.log('');
  }
  process.exit(1);
}
