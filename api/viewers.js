/* ===================================================================
   GET /api/viewers — the list, for us
   ===================================================================

   Names, emails, phone numbers, firms, and how each person read the deck.
   This is the endpoint that exists because "saved for later use" is the
   point of the database, and it is the one place in this project where
   personal data leaves the server.

   So: a token, compared in constant time, and no token configured means
   closed rather than open. No caching, and no CORS origin will be echoed
   unless it is one of ours — though the token is the real gate, since
   CORS stops browsers and not curl.

     GET /api/viewers                      JSON, newest reader first
     GET /api/viewers?format=csv           the same, for a spreadsheet
     GET /api/viewers?slides=1             adds each reader's per-slide time
     GET /api/viewers?limit=500

   Authenticate with a header, which keeps the token out of proxy logs and
   browser history:

     curl -H "Authorization: Bearer $ADMIN_TOKEN" .../api/viewers

   ?token= works too, for pasting into a browser. Prefer the header.
   =================================================================== */

import { api, q, json, int, str, query, requireAdmin } from './_db.js';

const SQL = `
select s.id, s.email, s.name, s.org, s.phone,
       s.first_seen_at, s.last_seen_at, s.last_read_at,
       s.reads, s.visits, s.total_ms, s.slides_seen, s.slides_total,
       s.finished, s.wrap_opened
  from viewer_summary s
 order by s.last_seen_at desc
 limit $1
`;

/* Per-slide detail, only when asked for: it is one row per slide per
   reader, so it is the part that grows.

   Grouped on slide_index alone, deliberately. title is a value column that
   read_slides carries per read, and beat.js takes the newest non-null one for
   whichever read is writing — so a slide retitled between someone's laptop
   read and their phone read ends up with two different titles for the same
   slide. Group by it as well and that person's slide appears twice in the
   export, each row holding only part of their time, which is the one thing
   this endpoint must not do. Pick a representative title instead, the same way
   stats.js does. */
const SQL_SLIDES = `
select r.viewer_id,
       d.slide_index + 1 as slide,
       (array_agg(d.title order by (d.title is null), d.ms desc))[1] as title,
       sum(d.ms)::bigint  as ms,
       min(d.order_index) as order_index
  from read_slides d
  join reads r on r.id = d.read_id
 where r.viewer_id = any($1::bigint[])
 group by r.viewer_id, d.slide_index
 order by r.viewer_id, ms desc
`;

const CSV_COLUMNS = [
  'email', 'name', 'org', 'phone', 'minutes', 'slides_seen', 'slides_total',
  'visits', 'reads', 'finished', 'wrap_opened', 'first_seen_at', 'last_read_at'
];

/* Excel reads a leading =, +, - or @ as a formula, so a name starting with
   one becomes executable when the export is opened. Prefix with a quote to
   keep it text. The rest is ordinary RFC 4180 quoting. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export default api(async (req, res) => {
  requireAdmin(req);

  const params = query(req);
  const limit  = int(params.limit, 1, 5000, 1000);

  const { rows } = await q(SQL, [limit]);

  const viewers = rows.map(row => ({
    id: Number(row.id),
    email: row.email,
    name: row.name,
    org: row.org,
    phone: row.phone,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastReadAt: row.last_read_at,
    reads: Number(row.reads),
    visits: row.visits,
    totalMs: Number(row.total_ms),
    minutes: Math.round(Number(row.total_ms) / 60000),
    slidesSeen: row.slides_seen,
    slidesTotal: row.slides_total,
    finished: row.finished === true,
    wrapOpened: row.wrap_opened === true
  }));

  if (str(params.slides, 8) === '1' && viewers.length) {
    const detail = await q(SQL_SLIDES, [viewers.map(v => v.id)]);
    const grouped = new Map();
    for (const row of detail.rows) {
      const list = grouped.get(Number(row.viewer_id)) ?? [];
      list.push({
        slide: row.slide,
        title: row.title,
        ms: Number(row.ms),
        order: row.order_index
      });
      grouped.set(Number(row.viewer_id), list);
    }
    for (const viewer of viewers) viewer.slides = grouped.get(viewer.id) ?? [];
  }

  /* Personal data: never cached, never stored by an intermediary. */
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (str(params.format, 8).toLowerCase() === 'csv') {
    const lines = [CSV_COLUMNS.join(',')];
    for (const viewer of viewers) {
      lines.push(CSV_COLUMNS.map(column => csvCell(
        column === 'first_seen_at' ? viewer.firstSeenAt?.toISOString?.() ?? viewer.firstSeenAt
      : column === 'last_read_at'  ? viewer.lastReadAt?.toISOString?.()  ?? viewer.lastReadAt
      : column === 'slides_seen'   ? viewer.slidesSeen
      : column === 'slides_total'  ? viewer.slidesTotal
      : column === 'wrap_opened'   ? viewer.wrapOpened
      : viewer[column]
      )).join(','));
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bluewater-readers.csv"');
    /* A BOM, so Excel on Windows opens it as UTF-8 rather than mangling
       any name with an accent in it. */
    res.end('﻿' + lines.join('\r\n') + '\r\n');
    return;
  }

  json(res, 200, { ok: true, count: viewers.length, viewers });
}, { methods: ['GET'] });
