/* ===================================================================
   BLUEWATER — shared plumbing for the reader-record API
   ===================================================================

   Vercel does not route files in /api whose name starts with an
   underscore, so this is a library rather than an endpoint.

   Everything the four handlers have in common lives here: the connection
   pool, a transaction helper, CORS, body reading, and the validators. The
   handlers themselves are then short enough to read in one go.
   =================================================================== */

import pg from 'pg';
import { createHash, timingSafeEqual } from 'node:crypto';

const { Pool } = pg;

/* An error that knows what status it deserves. Anything else thrown by a
   handler is a bug and comes back as a bare 500 with nothing leaked. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---- the pool -----------------------------------------------------
   One pool per warm instance, parked on globalThis so a module reload
   inside the same instance cannot quietly open a second one.

   max:1 is deliberate. A serverless instance serves one request at a
   time, so a bigger pool here buys no concurrency — it only burns
   through the database's connection limit faster when several instances
   are warm at once. Point DATABASE_URL at the provider's pooled
   connection string and this scales as wide as the pooler does.
   ------------------------------------------------------------------ */
function sslFor(url) {
  if (/[?&]sslmode=disable/.test(url)) return false;

  let host = '';
  try { host = new URL(url).hostname; } catch { /* unparseable — assume remote */ }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;

  /* Neon, Supabase and RDS all present publicly trusted certificates, so
     verification is the default. PGSSL_NO_VERIFY exists for a provider
     with a private CA — it downgrades to encryption without proof of who
     is on the other end, so it is opt-in and not the default. */
  if (/^(1|true|yes)$/i.test(process.env.PGSSL_NO_VERIFY ?? '')) {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

export function pool() {
  if (!globalThis.__bwPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new HttpError(503, 'DATABASE_URL is not set');

    globalThis.__bwPool = new Pool({
      connectionString: url,
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      ssl: sslFor(url)
    });

    /* An idle socket dropped by the pooler arrives as an error event on
       the pool. Unhandled, it takes the whole instance down; the next
       query just opens a fresh connection, so swallowing it is right. */
    globalThis.__bwPool.on('error', () => {});
  }
  return globalThis.__bwPool;
}

export const q = (text, params) => pool().query(text, params);

export async function tx(fn) {
  const client = await pool().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    try { await client.query('rollback'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/* ---- CORS ---------------------------------------------------------
   The deck is served from two places: the Vercel deployment itself, and
   storylandstudios.com/bluewater via the WordPress proxy. That proxy
   only forwards GET and HEAD, so a POST from the proxied copy has to go
   straight to the Vercel origin — which makes it cross-origin, which
   makes these headers load-bearing rather than decorative.

   This is not a security boundary. The write endpoints are unauthenticated
   by necessity (the deck is a static file with no secret to keep), so CORS
   only raises the cost of casual cross-site noise. The PII export is the
   thing that actually needs protecting, and it has a token.
   ------------------------------------------------------------------ */
const BUILTIN_ORIGINS = [
  'https://storylandstudios.com',
  'https://www.storylandstudios.com'
];

function originAllowed(origin) {
  if (!origin) return false;                       /* file:// sends "null" */

  const extra = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (extra.includes('*')) return true;
  if (BUILTIN_ORIGINS.includes(origin) || extra.includes(origin)) return true;

  let host;
  try { host = new URL(origin).hostname; } catch { return false; }

  /* Every deployment of this project — production, previews, and the
     local `vercel dev` — without having to list them. */
  return /\.vercel\.app$/.test(host) || host === 'localhost' || host === '127.0.0.1';
}

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/* A URL fit to log.
   /api/viewers documents ?token= as a way to paste the export into a browser,
   so the query string can carry ADMIN_TOKEN. The error log below only fires for
   a non-HttpError — which by definition is after requireAdmin has already
   PASSED — so every token that could ever reach it is a valid one. Any plain
   database error on that route (an un-migrated view, a dropped pooler
   connection, a connect timeout) would therefore write a working credential
   into Vercel's logs, and from there into any log drain, for as long as
   retention lasts.
   Wrapped, because req.url is attacker-influenced and need not parse. */
export function safeUrl(url) {
  const raw = String(url ?? '');
  try {
    const parsed = new URL(raw, 'http://placeholder.invalid');
    parsed.searchParams.delete('token');
    return parsed.pathname + (parsed.search || '');
  } catch {
    return raw.split('?')[0];
  }
}

/* Wraps a handler with CORS, the preflight, a method guard and the error
   funnel. `methods` is the list this endpoint actually answers. */
export function api(handler, { methods = ['POST'] } = {}) {
  const allow = [...methods, 'OPTIONS'].join(', ');

  return async (req, res) => {
    /* Vary goes on unconditionally, and that is load-bearing rather than
       tidy. /api/stats is cached at the CDN with s-maxage, and the
       Access-Control-Allow-Origin below depends on the request's Origin. Set
       Vary only when the origin happens to be allowed and the first caller
       decides what everyone else gets: one request without an Origin header —
       a curl, a warmer, a health check — stores a copy carrying no CORS header
       at all, and the CDN then serves that copy to real browsers, whose
       cross-origin fetch fails. The deck falls back to its sample figures and
       the real benchmark never appears, with nothing visibly broken to explain
       why. */
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', allow);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

    if (!methods.includes(req.method)) {
      res.setHeader('Allow', allow);
      json(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    try {
      await handler(req, res);
    } catch (err) {
      /* The split is deliberate-versus-bug, not 4xx-versus-5xx. An HttpError
         is a sentence we wrote for whoever is wiring this up — including the
         503s that mean "DATABASE_URL is not set" and "ADMIN_TOKEN is not
         set", which are the two most useful things the API can ever say and
         are worthless if they arrive as a generic 500. Anything else that
         reaches here is a bug: log it, and tell the caller nothing. */
      const deliberate = err instanceof HttpError;
      if (!deliberate) console.error('[bluewater]', req.method, safeUrl(req.url), err);
      json(res, deliberate ? err.status : 500,
           { ok: false, error: deliberate ? err.message : 'server error' });
    }
  };
}

/* ---- reading the request ------------------------------------------
   Vercel parses a JSON body for us, but the deck's final write leaves on
   navigator.sendBeacon, which arrives as a Blob and does not always get
   the same treatment. So handle all three shapes: parsed object, string
   or Buffer, and nothing at all (read the stream ourselves).
   ------------------------------------------------------------------ */
const MAX_BODY = 256 * 1024;

export async function readJson(req) {
  let raw = req.body;

  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;

  if (raw === undefined || raw === null) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'payload too large');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks);
  }

  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (text.length > MAX_BODY) throw new HttpError(413, 'payload too large');
  if (!text.trim()) return {};

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new HttpError(400, 'body is not valid JSON'); }

  /* Valid JSON is not necessarily an object. A body of `null`, `7` or `[]`
     parses fine and then every handler's first `body.readId` throws a
     TypeError — which is not an HttpError, so it comes back as a 500 and
     writes a stack trace into the channel reserved for real bugs. It is a
     malformed request, so say so. */
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return parsed;
}

export function query(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try { return Object.fromEntries(new URL(req.url, 'http://x').searchParams); }
  catch { return {}; }
}

/* ---- validators ---------------------------------------------------
   Anything arriving from the browser is untrusted, including the honest
   copy of the deck — a stale tab can send nonsense. Every field is
   coerced and bounded here rather than trusted and stored.
   ------------------------------------------------------------------ */
export function str(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

export function int(value, min, max, fallback = 0) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const isUuid = value =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export const isEmail = value =>
  typeof value === 'string' && value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

/* A read is one browser's whole run through the deck, so the ceilings are
   generous — a deck left open across a working week is plausible. They are
   here to keep a broken clock or a hand-rolled POST from writing a
   nonsense figure that then poisons the medians on the summary card. */
export const MAX_SLIDE_MS = 6 * 60 * 60 * 1000;    /* 6h on one slide     */
export const MAX_TOTAL_MS = 72 * 60 * 60 * 1000;   /* 72h across the deck */
export const MAX_SLIDES   = 500;

/* ---- who opened it ------------------------------------------------
   A salted hash, never the address itself, and only when IP_SALT is set.
   Unset means the column stays null: recording where a confidential deck
   was opened from should be a decision someone made on purpose, not a
   default that arrives with a database.
   ------------------------------------------------------------------ */
export function ipHash(req) {
  const salt = process.env.IP_SALT;
  if (!salt) return null;

  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  const ip = forwarded || req.socket?.remoteAddress || '';
  if (!ip) return null;

  return createHash('sha256').update(`${salt}|${ip}`).digest('hex').slice(0, 32);
}

/* ---- the export gate ----------------------------------------------
   Guards the one endpoint that returns names, emails and phone numbers.
   No token configured means the export is shut, not open: a missing
   environment variable must never be the thing standing between an
   investor list and the internet.
   ------------------------------------------------------------------ */
export function requireAdmin(req) {
  const want = process.env.ADMIN_TOKEN ?? '';
  if (!want) {
    throw new HttpError(503, 'ADMIN_TOKEN is not set — the export stays closed until it is');
  }

  const header = String(req.headers.authorization ?? '');
  const got = header.startsWith('Bearer ')
    ? header.slice(7)
    : String(query(req).token ?? '');

  const a = Buffer.from(got);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(401, 'unauthorised');
  }
}
