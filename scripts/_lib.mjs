/* ===================================================================
   Shared bits for the scripts in this directory
   ===================================================================

   Three of them needed the same two things — find the connection string,
   and decide how to TLS it — and had their own copy of each. One copy now,
   because the copies were identical and would not have stayed that way.
   =================================================================== */

import path from 'node:path';

/* ---- finding the environment --------------------------------------
   Both file names are read, and the order below looks backwards on
   purpose.

   `process.loadEnvFile` fills in variables that are not already set and
   never overwrites one that is. So the FIRST file to define a key wins,
   and anything already in the shell beats both files. Loading .env.local
   first is therefore what produces the precedence everyone expects:

     DATABASE_URL=… npm run migrate     an explicit variable, highest
     .env.local                         what `vercel env pull` writes
     .env                               what you keep by hand

   .env.local matters because `vercel env pull` is the normal way to get a
   connection string onto a developer's machine, and it writes that name.
   Reading only .env meant pulling the credential correctly and then being
   told it was not set, which is a poor way to spend twenty minutes.
   ------------------------------------------------------------------ */
/* The variables these scripts and the API read. Listed so the blank-clearing
   below stays scoped to our own settings and never touches PATH or anything
   else that happens to be empty. */
const OURS = [
  'DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'ADMIN_TOKEN',
  'IP_SALT', 'PGSSL_NO_VERIFY', 'ALLOWED_ORIGINS'
];

export function loadEnv(root) {
  /* An empty variable still counts as set, and loadEnvFile will not overwrite
     anything that is set — so a stray `DATABASE_URL=` in the shell, or a CI
     job that defines it blank, silently shadows a perfectly good .env.local
     and every script then insists the connection string is missing while it
     sits right there in the file. An empty value carries no information, so
     drop ours before reading, and let the files answer. */
  for (const key of OURS) {
    if (key in process.env && String(process.env[key]).trim() === '') {
      delete process.env[key];
    }
  }

  const loaded = [];
  for (const name of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(path.join(root, name));
      loaded.push(name);
    } catch {
      /* absent, or unreadable — the variables may be in the environment */
    }
  }
  return loaded;
}

/* The pooled string is what the API should use. Migrations want the direct
   one, because a pooler in transaction mode can refuse a multi-statement
   script; providers expose it as DATABASE_URL_UNPOOLED. */
export function connectionString({ preferDirect = true } = {}) {
  const direct = (process.env.DATABASE_URL_UNPOOLED ?? '').trim();
  const pooled = (process.env.DATABASE_URL ?? '').trim();
  if (preferDirect && direct) return direct;
  return pooled || direct;
}

/* ---- TLS ----------------------------------------------------------
   Verification on by default. Neon, Supabase and RDS all present publicly
   trusted certificates, so this works without ceremony; PGSSL_NO_VERIFY is
   the escape hatch for a provider with a private CA, and it downgrades to
   encryption without proof of who is on the other end, which is why it is
   opt-in. Local sockets are not encrypted at all.
   ------------------------------------------------------------------ */
export function sslFor(url) {
  if (/[?&]sslmode=disable/.test(url)) return false;

  let host = '';
  try { host = new URL(url).hostname; } catch { /* unparseable — assume remote */ }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;

  if (/^(1|true|yes)$/i.test(process.env.PGSSL_NO_VERIFY ?? '')) {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

/* What to print when there is no connection string. Every script needs the
   same paragraph and it is the most likely thing anyone will read. */
export function noConnectionStringMessage() {
  return [
    'DATABASE_URL is not set.',
    '',
    'If the database exists on Vercel already, pull its settings:',
    '',
    '  npx vercel link        # once, to attach this folder to the project',
    '  npx vercel env pull    # writes .env.local, which these scripts read',
    '',
    'Or set it by hand — copy .env.example to .env and fill it in.',
    'Or for one command only:',
    '',
    '  DATABASE_URL="postgres://…" npm run migrate',
    ''
  ].join('\n');
}
