-- 报功, round 2 — attribute STARTS to a worker (not just finishes), and add
-- a "last active" signal. Supersedes the views/function from 0025.
--
-- ⚠️ DEPLOY ORDERING: apply this BEFORE shipping the matching app code. Unlike
-- the read-only 0025, this adds a column the WRITE path now references
-- (lib/db.ts#toPartStage always serializes started_by_actor). If the app
-- deploys first, every ✓/▶ on the floor would fail on "column does not exist".
-- Reads still degrade gracefully; writes do not.

-- ---------------------------------------------------------------------------
-- started_by_actor — who clicked ▶, distinct from by_actor (who clicked ✓).
-- Starts were previously anonymous (startStage cleared the actor), so the
-- 开始 column can only attribute starts recorded AFTER this migration; older
-- in-progress rows show no starter and are excluded from the per-person
-- counts (NULL actor).
-- ---------------------------------------------------------------------------
alter table part_stages add column if not exists started_by_actor text;

-- worker_output's return shape changes (adds starts + last_active), so the
-- old function must be dropped before recreate. Drop the function first
-- (it depends on the view), then the view.
drop function if exists worker_output(timestamptz, timestamptz);
drop view if exists worker_finish_events;

-- ---------------------------------------------------------------------------
-- worker_stage_events — one row per 开始 OR 完成 event, denormalized with the
-- part's ¥ value. Mirrors 0019's station_events shape but adds value_cny and,
-- crucially, attributes each event to the right actor per kind:
--   finished → by_actor   (who clicked ✓)
--   started  → started_by_actor (who clicked ▶)
-- The 报功 drill-down reads this directly; the daily roll-up aggregates it.
-- ---------------------------------------------------------------------------
create or replace view worker_stage_events as
with ev as (
  -- 完成 events.
  select
    ps.finished_at                               as ts,
    'finished'::text                             as kind,
    coalesce(fu.name, ps.by_actor)               as actor_name,
    ps.stage,
    p.id                                         as part_id,
    p.name                                       as part_name,
    p.qty                                        as part_qty,
    coalesce(p.line_total_cny, p.unit_price_cny * p.qty, 0)::numeric as value_cny,
    (p.line_total_cny is null and p.unit_price_cny is null)         as is_unpriced,
    p.job_id,
    j.job_no,
    j.customer
  from part_stages ps
  join parts p on p.id = ps.part_id
  join jobs  j on j.id = p.job_id
  left join users fu on fu.id = ps.by_user_id
  where ps.finished_at is not null

  union all

  -- 开始 events.
  select
    ps.started_at                                as ts,
    'started'::text                              as kind,
    ps.started_by_actor                          as actor_name,
    ps.stage,
    p.id                                         as part_id,
    p.name                                       as part_name,
    p.qty                                        as part_qty,
    coalesce(p.line_total_cny, p.unit_price_cny * p.qty, 0)::numeric as value_cny,
    (p.line_total_cny is null and p.unit_price_cny is null)         as is_unpriced,
    p.job_id,
    j.job_no,
    j.customer
  from part_stages ps
  join parts p on p.id = ps.part_id
  join jobs  j on j.id = p.job_id
  where ps.started_at is not null
)
select * from ev
order by ts desc;

-- ---------------------------------------------------------------------------
-- worker_output(from, to) — the daily 报功 scoreboard. One row per worker in
-- the [from, to) window. Aggregation runs in Postgres so a month-wide window
-- still returns a handful of rows.
--
-- Only attributable events count: rows with a NULL actor (legacy / anonymous
-- starts) are dropped, so the scoreboard never shows a phantom "—" worker.
--   finishes / pieces / value_cny ← 完成 events only
--   starts                        ← 开始 events only
--   last_active                   ← most recent event of either kind
-- ---------------------------------------------------------------------------
create or replace function worker_output(p_from timestamptz, p_to timestamptz)
returns table (
  actor_name  text,
  finishes    bigint,
  starts      bigint,
  pieces      bigint,
  value_cny   numeric,
  unpriced    bigint,
  last_active timestamptz
)
language sql
stable
as $$
  select
    wse.actor_name,
    count(*) filter (where wse.kind = 'finished')::bigint                       as finishes,
    count(*) filter (where wse.kind = 'started')::bigint                        as starts,
    coalesce(sum(wse.part_qty) filter (where wse.kind = 'finished'), 0)::bigint as pieces,
    coalesce(sum(wse.value_cny) filter (where wse.kind = 'finished'), 0)::numeric as value_cny,
    count(*) filter (where wse.kind = 'finished' and wse.is_unpriced)::bigint   as unpriced,
    max(wse.ts)                                                                 as last_active
  from worker_stage_events wse
  where wse.ts >= p_from and wse.ts < p_to and wse.actor_name is not null
  group by wse.actor_name
  order by finishes desc, starts desc, value_cny desc;
$$;

-- Schema-cache reload so PostgREST exposes the new view + function next request.
notify pgrst, 'reload schema';
