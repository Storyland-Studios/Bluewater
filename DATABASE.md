# The reader record

The deck used to keep everything in the reader's own browser. The sign-in card
said as much, and the read-back's benchmark column carried invented figures with
a footnote admitting it. This adds a database behind both: the sign-in details
are kept, the per-slide dwell times go with them, and the benchmark column
reports real readers once there are enough of them to be worth reporting.

Four tables, four endpoints, and about 200 lines in the deck. Postgres, but not
a particular Postgres — anything you can reach with a connection string works.

## Set it up

**1. A database.** Any Postgres. From the Vercel dashboard, Storage → Create →
Neon is the shortest path and sets `DATABASE_URL` on the project for you.
Supabase, Railway, RDS or a local Postgres are all fine; you just set the
variable yourself.

**2. Environment variables.** Copy `.env.example` to `.env` for local work, and
set the same values on Vercel under Settings → Environment Variables. Only
`DATABASE_URL` is required — see the file for what the optional ones do.

**3. Create the tables.**

```bash
npm install && npm run migrate
```

Idempotent, so it is safe to run against a live database and safe to run twice.
If your provider gives both a pooled and a direct connection string, put the
direct one in `DATABASE_URL_UNPOOLED` — a pooler in transaction mode can refuse
a multi-statement script.

**4. Deploy.** `git push`, or `vercel --prod`.

## Check it works

```bash
curl https://bluewater-tau.vercel.app/api/stats
```

`{"ok":true,"viewers":0,...}` means the deck and the database are talking.
`503 DATABASE_URL is not set` means step 2 did not reach the deployment —
environment variables only apply to builds made after they were set, so
redeploy.

## Get the data out

```bash
npm run report                 # the readers, newest first
npm run report -- --slides     # and where each of them spent their time
npm run report -- --csv        # for a spreadsheet
```

Or over HTTP, with `ADMIN_TOKEN` set:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://bluewater-tau.vercel.app/api/viewers?format=csv" -o readers.csv
```

This is the only endpoint that returns names, emails and phone numbers. It
compares the token in constant time, sends `no-store`, and refuses outright
when `ADMIN_TOKEN` is unset — a missing environment variable must not be the
only thing between an investor list and the internet. Prefer the header over
`?token=`, which lands in browser history and proxy logs.

## Working on it locally

```bash
npm run dev              # deck + API on localhost:3000
npm run dev -- --seed    # with four readers already recorded
npm test                 # everything below, in order
npm run test:api         # the API against a real Postgres, no setup
npm run test:client      # the deck's transport, no browser
npm run lint:php         # parse the WordPress plugin
```

`test:api` runs the handlers against PGlite — Postgres compiled to
WebAssembly — behind a real socket, so `pg` connects the way it connects to
Neon and the real schema is applied. `test:client` lifts the deck's own
transport code out of the HTML between its marker comments and runs it with
stubbed browser globals, which is how the offline-first behaviour and the
retry bounds get checked without a browser. Neither needs a network,
credentials, or Docker.

`lint:php` exists because that plugin runs on storylandstudios.com, where a
syntax error white-screens the whole site rather than just the deck, and
`php -l` is not on every machine that edits this repo.

Both run Postgres compiled to WebAssembly, in process. No database to install,
no connection string, no network. The data is in memory and goes away when you
stop it — the point is to see the wiring work, not to keep anything. For
something closer to production, set `DATABASE_URL` and use `npm run dev:vercel`.

The deck's passphrase door sits in front of the sign-in card. To skip it while
testing, in the browser console:

```
sessionStorage.setItem('nateland-door-v1', '1'); location.reload()
```

## The endpoints

| | |
| --- | --- |
| `POST /api/signin` | Upserts the viewer and opens their read. Called when the card is filled in, and again on each later visit — the card only appears once, so this is the only thing that counts a second visit. |
| `POST /api/beat` | The dwell times. Sent every few seconds while anything is changing, and once more on a `sendBeacon` as the tab closes. |
| `GET /api/stats` | Aggregate figures for the read-back. No personal data, so no token; cached for a minute. |
| `GET /api/viewers` | The list. Needs `ADMIN_TOKEN`. |

Two properties are worth knowing because they are what make this safe to lose:

**Every write carries the whole state, never a delta.** A dropped beat costs
nothing, because the next one carries the same truth. A retried or duplicated
beacon cannot double-count.

**Every write is monotonic.** Totals move with `greatest()` and flags with a
boolean OR, so a request that overtakes another cannot walk a figure backwards.

**And every retry is bounded.** A `409` from `/api/beat` means the browser holds
a `readId` the server has never seen, and the answer is to sign in again — but
`recSignIn` calls `recFlush` on success and the 409 is handled inside
`recFlush`, so those two form a closed cycle if the server keeps answering 409.
It runs in promise callbacks, so it never yields: the tab pegs a core and posts
as fast as the network allows. `REC_MAX_REIDENTIFY` caps it at two attempts and
then switches the transport off for the rest of the page. This was not
hypothetical — holding `/api/beat` at 409 hung the test suite outright, which is
exactly what a reader's browser would have done.

## How the deck decides whether to use it

`API_ORIGIN` near the top of the record section in the deck. **Update it if the
Vercel project is renamed.**

- **`file:`, or an email attachment** — no network at all. The deck stays the
  offline artefact the README promises.
- **`*.vercel.app`, `localhost`** — same origin, relative paths. A preview
  deployment writes to whatever database that preview is configured with, not to
  production.
- **anything else** — posts to `API_ORIGIN` cross-origin.

That last case is the WordPress proxy at `storylandstudios.com/bluewater`,
and it is why it exists: [the proxy](wordpress/bluewater-proxy.php) only
forwards GET and HEAD, so a POST from the proxied copy would hit WordPress and
404. It goes straight to Vercel instead, which allows the origin by name. If the
deck gets proxied somewhere new, add that origin to `ALLOWED_ORIGINS`.

`localStorage` is still the source of truth for the reader's own experience, and
deliberately so — the read-back has to work on a plane. The database is a
mirror. If it is unreachable, nothing about the deck changes.

## What the reader is told

The sign-in card used to say *"Nothing entered here is transmitted anywhere."*
It now says what actually happens:

> What you enter here is recorded by Nateland Experiences, along with which
> slides you open and how long you spend on each, so that we know who we are
> speaking to and what you wanted to see.

**If the recording is ever taken out, that copy has to go back.** A deck that
tells an investor it collects nothing while collecting something is a worse
problem than any missing analytics. Point it at a privacy policy if there is
one.

Stored: name, email, phone, firm, and per-slide dwell times. Also user agent,
referrer, screen size and time zone, because they were free and they explain a
read that looks odd. Not stored: IP addresses, unless you set `IP_SALT`, in
which case a salted hash — useful for noticing a confidential deck opened
somewhere it should not be, and off by default because that should be a
decision someone made rather than a default that arrived with a database.

Erasure is one statement. The foreign keys cascade, so this takes the reads,
the slide times and the events with it:

```sql
delete from viewers where email = 'someone@example.com';
```

## The benchmark column

`GET /api/stats` aggregates per viewer, not per read, so somebody who opened the
deck on a laptop and then a phone counts once.

Per-slide figures are **medians across readers, and only for slides more than
one person opened**. Both guards are there for the same reason: one deck left
open over a lunch break is enough to put an unremarkable slide at the top of the
list and keep it there. A mean cannot survive that, and a single reader is not a
benchmark.

The deck applies its own floor on top — `MIN_REAL_READERS`, which is 3. Below
it, the card keeps the sample figures and its footnote says they are samples.
"Median across two readers" is not a benchmark, and showing one to an investor
as though it were is worse than showing nothing.

## What this does not fix

**The door is still a doorplate.** The passphrase is checked in the reader's own
browser, so it is discoverable by anyone who opens the source. Real gating means
the passphrase never reaching the browser: a `POST /api/door` that sets a signed
cookie, with the deck body served only to a request that carries it. That is a
different shape of change — the deck stops being one self-contained file — and
it is worth doing before this is sent anywhere wide.

**The write endpoints are unauthenticated**, necessarily: the deck is a static
file with no secret to keep. They are validated and bounded — field lengths,
dwell ceilings, payload size — but somebody who reads the source can post junk.
CORS raises the cost of casual cross-site noise and stops nobody determined. The
door is the practical gate, and it is weak. Rate limiting would want a store;
Vercel's WAF is the shorter path if it becomes a problem.

There is one consequence of that worth spelling out, because it is easy to undo
by accident. A slide title posted to `/api/beat` is republished by `/api/stats`
to every reader, so it is **untrusted text that ends up in the read-back's
`innerHTML`**. Unescaped, that is stored XSS running in the origin whose
`localStorage` holds the reader's name, email, phone and firm. The deck escapes
it at the sink — `esc()` and `num()`, next to `wrapSummaryHTML` — and `beat.js`
additionally drops angle brackets on the way in. **If you touch the benchmark
column's markup, keep `esc()` around anything from the server.** A test asserts
it is still there (`npm run test:client`), because the unit test proving `esc()`
works would keep passing after someone stopped calling it.

**Slide indices are positional.** `read_slides.slide_index` is the slide's
position in the deck, so inserting a slide re-points every historical row after
it. The stored title is the tiebreaker when reading old data. If the deck is
reordered substantially, note the date — the alternative is stable per-slide ids
in the markup, which is a bigger change than it sounds.
