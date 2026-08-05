/* ===================================================================
   GET /api/stats — the benchmark on the summary card
   ===================================================================

   The read-back's right-hand column, "Across all readers", was a hardcoded
   sample in the deck. This is where the real version comes from.

   Aggregated per viewer, not per read: someone who opened the deck on a
   laptop and then a phone is one reader whose time is the sum of both, or
   the medians would count them twice and the slide averages would be
   weighted towards whoever has the most devices.

   Everything here is aggregate. No name, email or firm appears in the
   response, which is why it can be read without a token — the deck itself
   has no secret to authenticate with. Reader counts are visible to anyone
   who finds the URL; the export next door is where the identities live and
   that one needs a token.
   =================================================================== */

import { api, q, json, int, query } from './_db.js';

const SQL = `
with per_viewer as (
  select r.viewer_id,
         sum(r.total_ms)::bigint  as total_ms,
         max(r.slides_seen)::int  as slides_seen
    from reads r
   group by r.viewer_id
  having sum(r.total_ms) > 0
),
head as (
  select count(*)::int as viewers,
         coalesce(percentile_cont(0.5) within group (order by total_ms),    0)::bigint as median_total_ms,
         coalesce(percentile_cont(0.5) within group (order by slides_seen), 0)::int    as median_slides_seen
    from per_viewer
),
per_viewer_slide as (
  select r.viewer_id,
         d.slide_index,
         sum(d.ms)::bigint as ms,
         (array_agg(d.title order by (d.title is null), d.ms desc))[1] as title
    from read_slides d
    join reads r on r.id = d.read_id
   where d.ms > 0
   group by r.viewer_id, d.slide_index
),
/* Median per slide, not mean, and only slides more than one person opened.
   Both guards are there for the same reason: with a reader count in the
   dozens, one deck left open over a lunch break is enough to put an
   otherwise unremarkable slide at the top of the list and keep it there.
   A mean cannot survive that and a single-reader row is not a benchmark.

   The threshold relaxes to one reader while there is only one reader in the
   database, so a first read still returns something rather than an empty
   list that looks like a broken query. The deck applies its own floor
   before it shows any of this as real. */
top as (
  select * from (
    select slide_index + 1 as slide,
           (array_agg(title order by (title is null), ms desc))[1] as title,
           percentile_cont(0.5) within group (order by ms)::bigint  as ms,
           count(*)::int                                           as readers
      from per_viewer_slide
     group by slide_index
    having count(*) >= (case when (select viewers from head) >= 2 then 2 else 1 end)
  ) ranked
  order by ranked.ms desc
  limit $1
)
select (select row_to_json(head) from head)                              as head,
       coalesce((select json_agg(to_jsonb(top) order by top.ms desc)
                   from top), '[]'::json)                                as top,
       (select count(*)::int from reads)                                 as reads,
       (select count(*)::int from reads where finished)                  as finishers
`;

export default api(async (req, res) => {
  const limit = int(query(req).limit, 1, 12, 5);
  const { rows } = await q(SQL, [limit]);

  /* A minute of CDN cache. The figures move slowly and the read-back is
     opened rarely, but a reader who reloads should not each time cost a
     cold start and four aggregate scans. Vary: Origin is set by the CORS
     wrapper, so the cached copy stays correct per origin. */
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

  const row  = rows[0] ?? {};
  const head = row.head ?? { viewers: 0, median_total_ms: 0, median_slides_seen: 0 };

  /* bigint comes back from pg as a string so a 2^53 overflow cannot happen
     silently. These are millisecond counts, nowhere near it — but they have
     to be numbers before the deck can format them. */
  json(res, 200, {
    ok: true,
    viewers: head.viewers,
    reads: row.reads ?? 0,
    finishers: row.finishers ?? 0,
    medianTotalMs: Number(head.median_total_ms),
    medianSlidesSeen: head.median_slides_seen,
    top: (row.top ?? []).map(t => ({
      slide: t.slide,
      title: t.title ?? null,
      ms: Number(t.ms),
      readers: t.readers
    })),
    updatedAt: new Date().toISOString()
  });
}, { methods: ['GET'] });
