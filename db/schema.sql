-- ===================================================================
-- BLUEWATER — the reader record
-- ===================================================================
--
-- Four tables. A person, their reads, the per-slide time inside a read,
-- and an append-only log of anything else worth keeping.
--
--   viewers      one row per person, keyed on a lowercased email
--   reads        one row per browser that person read from
--   read_slides  slide -> milliseconds, inside one read
--   events       milestones, for whatever we want to ask later
--
-- WHY "reads" AND NOT "sessions"
--
-- The deck keeps its dwell totals in localStorage and they are cumulative
-- across visits — reload the page and the same record continues, with a
-- visit counter going up. So a row here is not one page load: it is one
-- browser's whole running read, and the deck sends the absolute totals
-- every time. That makes every write idempotent. A retried beat, a
-- duplicated beacon, or two tabs racing all converge on the same numbers
-- instead of adding to them, which is what a per-page-load table would do.
--
-- Every counted value below is written monotonically (greatest(), or bool OR),
-- so a beacon from an earlier state landing after a later one cannot walk the
-- totals backwards. The two exceptions are deliberate: reads.slides_total and
-- read_slides.title describe the deck rather than the reading, so there the
-- newest answer is the correct one and both are last-write-wins. Nothing
-- aggregates over either.
--
-- Applying it: `npm run migrate`. It is idempotent, so it is safe to run
-- against a live database — every statement is IF NOT EXISTS or a no-op
-- second time round. Use the direct (unpooled) connection string; some
-- poolers reject multi-statement scripts.
--
-- No extensions. Emails are lowercased in the API rather than relying on
-- citext, and uuids come from the browser rather than gen_random_uuid(),
-- so this applies on a database where we are not superuser.
-- ===================================================================

-- ---- people --------------------------------------------------------
-- Email is the identity. It is stored already lowercased and trimmed by
-- the API, so the unique constraint below is the real one — no need for
-- a functional index or the citext extension.
create table if not exists viewers (
  id            bigserial   primary key,
  email         text        not null unique,
  name          text        not null,
  first_name    text,
  phone         text,
  org           text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  notes         text
);

create index if not exists viewers_last_seen_idx on viewers (last_seen_at desc);
create index if not exists viewers_org_idx       on viewers (org);

-- ---- a read --------------------------------------------------------
-- id is generated in the browser and kept in localStorage next to the
-- dwell totals, so the same browser keeps writing to the same row across
-- visits. Deleting a viewer takes their reads, slides and events with it
-- (see the cascades) — that is the erasure path.
create table if not exists reads (
  id            uuid        primary key,
  viewer_id     bigint      not null references viewers (id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_beat_at  timestamptz not null default now(),
  visits        integer     not null default 1,
  total_ms      bigint      not null default 0,
  slides_seen   integer     not null default 0,
  slides_total  integer,
  finished      boolean     not null default false,  -- reached the last slide
  wrap_opened   boolean     not null default false,  -- found the read-back
  user_agent    text,
  referrer      text,
  screen        text,
  tz            text,
  ip_hash       text        -- salted sha256, and only when IP_SALT is set
);

create index if not exists reads_viewer_idx on reads (viewer_id);
create index if not exists reads_beat_idx   on reads (last_beat_at desc);

-- ---- where the time went -------------------------------------------
-- slide_index is 0-based, matching the deck's own indices. The API adds
-- one on the way out, because the deck talks about slide numbers.
-- order_index is where the slide fell in the reading order, so the route
-- strip on the summary card can be rebuilt from the database.
create table if not exists read_slides (
  read_id     uuid    not null references reads (id) on delete cascade,
  slide_index integer not null,
  title       text,
  ms          bigint  not null default 0,
  order_index integer,
  primary key (read_id, slide_index)
);

create index if not exists read_slides_slide_idx on read_slides (slide_index);

-- ---- the log -------------------------------------------------------
-- client_key is the browser's own uuid for the event and is unique, which
-- is the whole deduplication story: a retried beat re-sends the event and
-- the insert does nothing. Postgres allows many nulls in a unique column,
-- so server-generated events can leave it empty.
create table if not exists events (
  id          bigserial   primary key,
  client_key  uuid        unique,
  read_id     uuid        references reads (id)   on delete cascade,
  viewer_id   bigint      references viewers (id) on delete cascade,
  kind        text        not null,
  slide_index integer,
  meta        jsonb,
  at          timestamptz not null default now()
);

create index if not exists events_read_idx on events (read_id, at desc);
create index if not exists events_kind_idx on events (kind, at desc);

-- ---- one row per person, for reading by eye ------------------------
-- What the export endpoint and the console report both select from.
-- A person who read on a laptop and a phone has two reads; their time
-- is the sum and their coverage is the better of the two.
create or replace view viewer_summary as
select
  v.id,
  v.email,
  v.name,
  v.org,
  v.phone,
  v.first_seen_at,
  v.last_seen_at,
  count(r.id)                                        as reads,
  coalesce(sum(r.visits), 0)::int                    as visits,
  coalesce(sum(r.total_ms), 0)::bigint               as total_ms,
  coalesce(max(r.slides_seen), 0)::int               as slides_seen,
  max(r.slides_total)::int                           as slides_total,
  bool_or(r.finished)                                as finished,
  bool_or(r.wrap_opened)                             as wrap_opened,
  max(r.last_beat_at)                                as last_read_at
from viewers v
left join reads r on r.viewer_id = v.id
group by v.id;
