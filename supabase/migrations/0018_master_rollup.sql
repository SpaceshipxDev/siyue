-- Pre-aggregated read shape for the master grid (app/page.tsx → MasterSheet)
-- and the per-station header (StationSummary). Replaces the cross-border
-- 12-table loadSnapshot() with two views Postgres aggregates against the
-- existing part_id / job_id indexes.
--
-- v2: the first cut used correlated EXISTS subqueries per (part, stage) to
-- compute has_mine_pending / has_upstream_active. With ~150k part_stages
-- rows that scaled as N² and tripped Supabase's statement timeout.
--
-- This version pre-aggregates outsource coverage per (part, stage) once,
-- then derives the cross-stage flags with a single window function pass
-- over (part_id, stage_ord). All in one sort, no nested loops.

-- Per-(job, stage) effective rollup.
--
-- Columns:
--   total                  parts whose route includes this stage
--   outsourced_closed      parts the vendor has fully returned (count as done)
--   outsourced_open        parts still at the vendor (rollup = done, jobStageCounts ignores)
--   in_progress            in-house in_progress, NOT covered by an open block
--   pending                in-house pending, NOT covered by an open block
--   in_progress_done_qty_sum  partial-completion count across in_progress (UI)
--   earliest_in_progress_at  ISO ts — oldest still-running start (timer chip)
--   latest_finished_at     ISO ts — most recent finish (done tier sort)
--   latest_completed_at    MM-DD — most recent finish display string
--   has_mine_pending       at least one PENDING in-house part where every
--                          prior in-route stage is effectively done. Drives
--                          jobIsMineAtStage when in_progress = 0.
--   has_upstream_active    at least one prior in-route stage has unfinished
--                          (pending/in_progress/open) work. Drives
--                          jobIsUpstreamOfStage.
create or replace view job_stage_rollup as
with stage_order(stage, ord) as (
  values
    ('工程'::text, 1),
    ('编程',       2),
    ('操机',       3),
    ('手工',       4),
    ('打磨',       5),
    ('喷漆',       6),
    ('丝印',       7),
    ('质量',       8),
    ('出货',       9)
),
-- Per-(part, stage) outsource coverage flags, computed once.
-- Replaces the N×M EXISTS scan the v1 view did per part_stage row.
part_stage_blocks as (
  select
    obp.part_id,
    s as stage,
    bool_or(coalesce(obp.returned_qty, 0) < p.qty)  as has_open,
    bool_or(coalesce(obp.returned_qty, 0) >= p.qty) as has_closed
  from outsource_block_parts obp
  join outsource_blocks ob on ob.id = obp.block_id
  join parts p on p.id = obp.part_id
  cross join unnest(ob.stages) as s
  group by obp.part_id, s
),
-- Per part_stage row with the effective kind baked in.
ps_eff as (
  select
    p.job_id,
    ps.part_id,
    ps.stage,
    so.ord as stage_ord,
    ps.started_at,
    ps.finished_at,
    ps.completed_at,
    ps.done_qty,
    case
      when ps.stage <> '出货' and coalesce(psb.has_open, false)   then 'outsourced_open'
      when ps.stage <> '出货' and coalesce(psb.has_closed, false) then 'done'
      when ps.status = 'done'                                     then 'done'
      when ps.status = 'in_progress'                              then 'in_progress'
      else                                                              'pending'
    end as eff_kind,
    (ps.stage <> '出货' and coalesce(psb.has_closed, false))      as is_outsourced_closed
  from part_stages ps
  join parts p on p.id = ps.part_id
  join stage_order so on so.stage = ps.stage
  left join part_stage_blocks psb
    on psb.part_id = ps.part_id and psb.stage = ps.stage
),
-- Cross-stage flag via window function. For each part_stage row:
-- "is any earlier in-route stage on this same part still unfinished?"
ps_aug as (
  select
    *,
    bool_or(eff_kind in ('pending','in_progress','outsourced_open'))
      over (
        partition by part_id
        order by stage_ord
        rows between unbounded preceding and 1 preceding
      ) as any_prior_unfinished
  from ps_eff
)
select
  job_id,
  stage,
  count(*)::int                                                              as total,
  count(*) filter (where is_outsourced_closed)::int                          as outsourced_closed,
  count(*) filter (where eff_kind = 'outsourced_open')::int                  as outsourced_open,
  count(*) filter (where eff_kind = 'in_progress')::int                      as in_progress,
  count(*) filter (where eff_kind = 'pending')::int                          as pending,
  coalesce(sum(done_qty) filter (where eff_kind = 'in_progress'), 0)::int    as in_progress_done_qty_sum,
  min(started_at) filter (where eff_kind = 'in_progress')                    as earliest_in_progress_at,
  max(coalesce(finished_at::text, completed_at)) filter (where eff_kind = 'done') as latest_finished_at,
  max(completed_at) filter (where eff_kind = 'done')                         as latest_completed_at,
  bool_or(eff_kind = 'pending' and not coalesce(any_prior_unfinished, false)) as has_mine_pending,
  bool_or(coalesce(any_prior_unfinished, false))                              as has_upstream_active
from ps_aug
group by job_id, stage;

-- One row per job. Centralizes the cross-component bits the master grid
-- needs once per row (external spend, has_open_outsource, component_count,
-- searchable haystack) so the page handler doesn't iterate components in JS.
-- v2: rebuilt as a single LEFT JOIN chain over LATERAL subqueries so each
-- expensive aggregate runs once per job, not once per output column.
create or replace view job_summary as
select
  j.id                            as job_id,
  coalesce(ext.total_spend, 0)::numeric as external_spend_cny,
  coalesce(oo.has_open, false)    as has_open_outsource,
  ro.id                           as active_return_id,
  ro.due_date                     as active_return_due_date,
  ro.reason                       as active_return_reason,
  coalesce(pc.cnt, 0)::int        as component_count,
  lower(coalesce(j.job_no,'')  || ' ' ||
        coalesce(j.customer,'') || ' ' ||
        coalesce(j.product,'')  || ' ' ||
        coalesce(pn.haystack, '')) as search_haystack
from jobs j
left join lateral (
  -- Sum of distinct block amounts attached to any part of this job.
  select sum(amount_cny) as total_spend
  from (
    select distinct ob.id, ob.amount_cny
    from outsource_blocks ob
    join outsource_block_parts obp on obp.block_id = ob.id
    join parts p on p.id = obp.part_id
    where p.job_id = j.id and ob.amount_cny is not null
  ) blk
) ext on true
left join lateral (
  -- Has at least one part with an open block covering a non-出货 stage.
  select true as has_open
  from outsource_block_parts obp
  join outsource_blocks ob on ob.id = obp.block_id
  join parts p on p.id = obp.part_id
  where p.job_id = j.id
    and coalesce(obp.returned_qty, 0) < p.qty
    and exists (select 1 from unnest(ob.stages) s where s <> '出货')
  limit 1
) oo on true
left join lateral (
  select id, due_date, reason
  from returns
  where job_id = j.id and status = 'open'
  order by created_at desc
  limit 1
) ro on true
left join lateral (
  select count(*) as cnt from parts where job_id = j.id
) pc on true
left join lateral (
  select string_agg(coalesce(name,'') || ' ' || coalesce(material,''), ' ') as haystack
  from parts where job_id = j.id
) pn on true;

-- Per-stage average flow time, derived from the most recent 50 jobs whose
-- in-route parts at that stage are all done with both start/finish stamps.
-- Mirrors lib/data.ts#avgStageFlowMinutes — earliest start to latest finish
-- per job, then averaged across the most-recent window.
create or replace view stage_flow_minutes as
with job_stage_window as (
  select
    p.job_id,
    ps.stage,
    min(ps.started_at)  as earliest_start,
    max(ps.finished_at) as latest_finish,
    bool_and(ps.status = 'done' and ps.started_at is not null and ps.finished_at is not null)
      as all_done_with_stamps,
    count(*) as parts_routed
  from part_stages ps
  join parts p on p.id = ps.part_id
  group by p.job_id, ps.stage
),
windowed as (
  select
    stage,
    extract(epoch from (latest_finish - earliest_start)) / 60.0 as minutes,
    latest_finish,
    row_number() over (partition by stage order by latest_finish desc) as rn
  from job_stage_window
  where all_done_with_stamps
    and parts_routed > 0
    and latest_finish > earliest_start
)
select
  stage,
  avg(minutes) as avg_minutes,
  count(*)::int as sample_count
from windowed
where rn <= 50
group by stage
having count(*) >= 3;

-- Nudge PostgREST to reload its schema cache so the new views are exposed
-- through the REST API immediately. Without this, lib/db.ts#getMasterRows
-- fails the first few minutes with "Could not find a relation named
-- job_stage_rollup" until the cache TTL expires on its own.
notify pgrst, 'reload schema';
