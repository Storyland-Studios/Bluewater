/* ===================================================================
   POST /api/beat — where the time went
   ===================================================================

   The deck sends its whole state, not a delta: total time, slides opened,
   and the full slide -> milliseconds map. That is what makes this safe to
   call as often as it likes, and safe to lose. A beat dropped on a flaky
   connection costs nothing because the next one carries the same ground
   truth, and the beacon fired as the tab closes cannot double-count.

   Every column that counts something is written with greatest() or a boolean
   OR, so an out-of-order arrival — the pagehide beacon overtaking a fetch sent
   moments earlier, two tabs on the same localStorage — cannot walk a total
   backwards.

   Two columns are deliberately not monotonic, because for them "latest" is
   more correct than "largest": slides_total and read_slides.title both
   describe the deck rather than the reading, and when the deck is edited the
   newer answer is the right one. Nothing aggregates over either, so a late
   arrival overwriting them costs nothing.

   Slides and events arrive as one jsonb parameter each and are expanded
   server-side. Passing them as Postgres arrays would mean escaping slide
   titles into an array literal; a title with a comma or a brace in it is
   exactly the kind of thing that works until it doesn't.
   =================================================================== */

import {
  api, tx, readJson, json, str, int, isUuid, HttpError,
  MAX_SLIDE_MS, MAX_TOTAL_MS, MAX_SLIDES
} from './_db.js';

/* Enough for a deck several times this size, and a hard stop on a payload
   built to be expensive. */
const MAX_ROWS   = 600;
const MAX_EVENTS = 60;

/* Slide titles are the one string this endpoint stores and later republishes
   to every reader through /api/stats, and this endpoint cannot be
   authenticated — the deck is a static file with no secret to hold. So the
   deck escapes these on the way into the page, which is the actual fix and
   the only one that covers rows already stored.

   This is the second line, not the first: angle brackets are never part of a
   real slide title, so dropping them keeps a payload from being stored at all
   and limits the damage if some future sink forgets to escape. Ampersands and
   quotes are left alone — they belong in legitimate titles, and mangling them
   here would be trading a real cost for no security. */
const cleanTitle = value => {
  const text = str(value, 200).replace(/[<>]/g, '');
  return text || null;
};

export default api(async (req, res) => {
  const body = await readJson(req);

  if (!isUuid(body.readId)) throw new HttpError(400, 'readId must be a uuid');

  /* ON CONFLICT cannot touch the same row twice in one statement, so a
     payload listing a slide twice would error the whole beat. Collapse on
     the way in and keep the larger dwell. */
  const bySlide = new Map();
  for (const row of Array.isArray(body.slides) ? body.slides.slice(0, MAX_ROWS) : []) {
    const i = int(row?.i, 0, MAX_SLIDES - 1, -1);
    if (i < 0) continue;

    const ms = int(row?.ms, 0, MAX_SLIDE_MS, 0);
    const previous = bySlide.get(i);
    if (previous && previous.m >= ms) continue;

    bySlide.set(i, {
      i,
      t: cleanTitle(row?.title),
      m: ms,
      o: int(row?.order, 0, MAX_SLIDES, -1)
    });
  }
  const slides = [...bySlide.values()].map(s => ({ ...s, o: s.o < 0 ? null : s.o }));

  /* Same reasoning for events, keyed on the browser's uuid. */
  const byKey = new Map();
  for (const event of Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : []) {
    const key  = event?.id;
    const kind = str(event?.kind, 60);
    if (!isUuid(key) || !kind || byKey.has(key)) continue;

    const slideIndex = int(event?.slide, 0, MAX_SLIDES - 1, -1);
    let meta = null;
    if (event?.meta && typeof event.meta === 'object') {
      const encoded = JSON.stringify(event.meta);
      if (encoded.length <= 2000) meta = event.meta;
    }
    byKey.set(key, { k: key, kind, si: slideIndex < 0 ? null : slideIndex, m: meta });
  }
  const events = [...byKey.values()];

  await tx(async client => {
    const read = await client.query(
      `update reads set
            total_ms     = greatest(reads.total_ms, $2),
            slides_seen  = greatest(reads.slides_seen, $3),
            slides_total = coalesce($4, reads.slides_total),
            visits       = greatest(reads.visits, $5),
            finished     = reads.finished    or $6,
            wrap_opened  = reads.wrap_opened or $7,
            last_beat_at = now()
        where id = $1
       returning viewer_id`,
      [
        body.readId,
        int(body.totalMs, 0, MAX_TOTAL_MS, 0),
        int(body.slidesSeen, 0, MAX_SLIDES, 0),
        int(body.slidesTotal, 0, MAX_SLIDES, 0) || null,
        int(body.visits, 1, 10_000, 1),
        body.finished === true,
        body.wrapOpened === true
      ]
    );

    /* No row means the browser has a readId we have never been told about
       — localStorage survived but the sign-in POST never landed. Say so
       plainly; the client answers a 409 by signing in again and retrying,
       which is the only thing that can fix it. */
    if (!read.rowCount) throw new HttpError(409, 'unknown readId — sign in first');
    const viewerId = read.rows[0].viewer_id;

    if (slides.length) {
      await client.query(
        `insert into read_slides (read_id, slide_index, title, ms, order_index)
              select $1, s.i, s.t, s.m, s.o
                from jsonb_to_recordset($2::jsonb) as s(i int, t text, m bigint, o int)
         on conflict (read_id, slide_index) do update set
              ms          = greatest(read_slides.ms, excluded.ms),
              title       = coalesce(excluded.title, read_slides.title),
              order_index = coalesce(read_slides.order_index, excluded.order_index)`,
        [body.readId, JSON.stringify(slides)]
      );
    }

    if (events.length) {
      /* at is stamped here rather than taken from the payload: a browser
         clock we do not control is not something to order a log by. */
      await client.query(
        `insert into events (client_key, read_id, viewer_id, kind, slide_index, meta)
              select e.k, $1, $2, e.kind, e.si, e.m
                from jsonb_to_recordset($3::jsonb)
                  as e(k uuid, kind text, si int, m jsonb)
         on conflict (client_key) do nothing`,
        [body.readId, viewerId, JSON.stringify(events)]
      );
    }
  });

  res.setHeader('Cache-Control', 'no-store');
  json(res, 200, { ok: true, slides: slides.length, events: events.length });
});
