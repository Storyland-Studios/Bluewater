/* ===================================================================
   POST /api/signin — who is reading
   ===================================================================

   Called twice over a reader's life: when they fill in the sign-in card,
   and on every later boot where the deck already knows them (the gate is
   skipped for a returning reader, so without the second call their visits
   would never be counted).

   Both paths are the same upsert. The browser supplies readId and keeps it
   in localStorage, so a returning reader lands on the row they already
   have instead of starting a new one.

   Returns the viewer id so the client has something to quote, but nothing
   here depends on the client believing it.
   =================================================================== */

import {
  api, tx, readJson, json, str, int, isUuid, isEmail, ipHash,
  HttpError, MAX_SLIDES
} from './_db.js';

export default api(async (req, res) => {
  const body = await readJson(req);

  if (!isUuid(body.readId)) throw new HttpError(400, 'readId must be a uuid');

  const email = str(body.email, 254).toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, 'a valid email is required');

  const name = str(body.name, 160);
  if (!name) throw new HttpError(400, 'name is required');

  const firstName = str(body.firstName, 80) || name.split(' ')[0];
  const phone     = str(body.phone, 60);
  const org       = str(body.org, 160);
  const returning = body.returning === true;

  const out = await tx(async client => {
    /* Blank optional fields must not erase what an earlier visit gave us:
       the sign-in card is only shown once, so a later boot sends whatever
       localStorage held, and that may be less than the first time. */
    const viewer = await client.query(
      `insert into viewers (email, name, first_name, phone, org)
            values ($1, $2, $3, nullif($4, ''), nullif($5, ''))
       on conflict (email) do update set
            name         = excluded.name,
            first_name   = excluded.first_name,
            phone        = coalesce(excluded.phone, viewers.phone),
            org          = coalesce(excluded.org,   viewers.org),
            last_seen_at = now()
         returning id`,
      [email, name, firstName, phone, org]
    );
    const viewerId = viewer.rows[0].id;

    const read = await client.query(
      `insert into reads
            (id, viewer_id, visits, slides_total, user_agent, referrer, screen, tz, ip_hash)
            values ($1, $2, $3, $4, $5, nullif($6, ''), nullif($7, ''), nullif($8, ''), $9)
       on conflict (id) do update set
            viewer_id    = excluded.viewer_id,
            visits       = greatest(reads.visits, excluded.visits),
            slides_total = coalesce(excluded.slides_total, reads.slides_total),
            user_agent   = coalesce(excluded.user_agent, reads.user_agent),
            referrer     = coalesce(reads.referrer, excluded.referrer),
            last_beat_at = now()
         returning visits`,
      [
        body.readId,
        viewerId,
        int(body.visits, 1, 10_000, 1),
        int(body.slidesTotal, 0, MAX_SLIDES, 0) || null,
        str(req.headers['user-agent'], 400) || null,
        str(body.referrer, 400),
        str(body.screen, 40),
        str(body.tz, 60),
        ipHash(req)
      ]
    );

    /* One row per boot, which makes this table the visit log. client_key is
       left null on purpose — these are server-stamped and each call is a
       genuinely separate arrival, so there is nothing to deduplicate. */
    await client.query(
      `insert into events (read_id, viewer_id, kind) values ($1, $2, $3)`,
      [body.readId, viewerId, returning ? 'return' : 'signin']
    );

    return { viewerId, visits: read.rows[0].visits };
  });

  res.setHeader('Cache-Control', 'no-store');
  json(res, 200, { ok: true, readId: body.readId, ...out });
});
