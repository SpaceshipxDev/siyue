-- 0062 — A returned (closed) outsource block reverts the stage to in-house.
--
-- PROBLEM. An outsource block carries a stages[] list. When that list covers a
-- stage the part still needs FINISHED in-house after it comes back (the classic
-- 外协回来还要经过手工作业 case), the old model locked the worker out at three
-- layers: canStartStage returned false for any covered stage, the cell rendered
-- a dead vendor ✓, and THIS view mapped `has_closed → 'done'` so the part never
-- entered the station's queue. 手工 had nowhere to 报工; the part stalled red.
--
-- FIX. A *closed* block means the part is physically back. From that moment the
-- in-house status governs again — a still-pending stage becomes a normal pending
-- cell so the worker can report the remaining finishing work, and only re-counts
-- as done once they actually click ✓. An *open* block (part still at the vendor)
-- stays locked exactly as before.
--
-- Two changes vs. the 0048 body, everything else byte-identical:
--   1. Drop the `has_closed → 'done'` arm in eff_kind so a returned stage falls
--      through to ps.status (pending / in_progress / done).
--   2. Tighten the outsourced_closed count to `is_outsourced_closed AND
--      eff_kind = 'done'` so it means "returned AND in-house confirmed done."
--      This keeps 0060's inHouseDone subtraction and master.ts's done-aggregate
--      correct: a returned-but-unconfirmed stage is counted as `pending` only,
--      never double-counted, and surfaces via has_mine_pending.
--
-- The TS path (lib/data.ts canStartStage / effectiveStageState, app/_stagecell)
-- is updated in the same change so the job-detail cell agrees with this rollup.
--
-- NOTE: we deliberately do NOT backfill part_stages — historical closed-block
-- stages whose in-house status is still 'pending' are exactly the parts that
-- need the new report flow, so they should re-surface as pending confirm/finish
-- taps rather than be auto-marked done (which would re-bury the 手工 work this
-- change exists to expose). Shipped jobs are unaffected: isShipped keys off the
-- 出货 cell, which is always in-house.

create or replace view job_stage_rollup as
with stage_order(stage, ord) as (
  values
    ('工程'::text, 1),
    ('编程',       2),
    ('操机',       3),
    ('检验',       4),
    ('手工',       5),
    ('打磨',       6),
    ('喷漆',       7),
    ('丝印',       8),
    ('质量',       9),
    ('出货',      10)
),
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
    ps.by_actor,
    case
      -- Still at the vendor (open block) — locked, vendor owns it.
      when ps.stage <> '出货' and coalesce(psb.has_open, false)   then 'outsourced_open'
      -- Returned (closed block): in-house status governs. No has_closed arm here
      -- on purpose — that's the fix. A pending stage stays pending and report-
      -- able; it counts done only once the worker clicks ✓.
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
  count(*) filter (where is_outsourced_closed and eff_kind = 'done')::int    as outsourced_closed,
  count(*) filter (where eff_kind = 'outsourced_open')::int                  as outsourced_open,
  count(*) filter (where eff_kind = 'in_progress')::int                      as in_progress,
  count(*) filter (where eff_kind = 'pending')::int                          as pending,
  coalesce(sum(done_qty) filter (where eff_kind = 'in_progress'), 0)::int    as in_progress_done_qty_sum,
  min(started_at) filter (where eff_kind = 'in_progress')                    as earliest_in_progress_at,
  max(coalesce(finished_at::text, completed_at)) filter (where eff_kind = 'done') as latest_finished_at,
  max(completed_at) filter (where eff_kind = 'done')                         as latest_completed_at,
  bool_or(eff_kind = 'pending' and not coalesce(any_prior_unfinished, false)) as has_mine_pending,
  bool_or(coalesce(any_prior_unfinished, false))                              as has_upstream_active,
  (array_agg(by_actor order by finished_at desc nulls last)
     filter (where eff_kind = 'done' and by_actor is not null and finished_at is not null)
  )[1]                                                                        as latest_by_actor
from ps_aug
group by job_id, stage;

-- The materialized master_board_rows table is trigger-maintained per job and
-- won't recompute from the new view on its own. We do NOT call
-- refresh_master_board_rows() — looping every job blows the SQL-editor timeout
-- (same 0060 sensitivity that broke imports). It's also unnecessary: the only
-- jobs whose rollup this migration can change are jobs that actually have an
-- outsource block (the changed eff_kind/outsourced_closed arms fire only when
-- has_closed is true). Recompute just those — a small, fast set.
select count(*) as recomputed_outsource_jobs from (
  select refresh_master_board_row(j.id)
  from jobs j
  where exists (
    select 1
    from parts p
    join outsource_block_parts obp on obp.part_id = p.id
    where p.job_id = j.id
  )
) t;
