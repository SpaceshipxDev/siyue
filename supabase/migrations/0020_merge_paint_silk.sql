-- Merge 喷漆 + 丝印 into a single 喷漆丝印 工段.
--
-- The two operations are almost always run by the same person, often the same
-- shop, sometimes back-to-back without an intermediate handoff. Tracking them
-- as separate stages doubled the data entry without adding signal. This
-- migration collapses them — in-flight data, pins, outsource blocks, and user
-- station assignments all rewrite atomically.
--
-- Merge rules for in-flight part_stages rows (a part may have one or both):
--   status:       done iff BOTH legs are done. If either is in_progress, the
--                 merged row is in_progress. Else pending.
--   completed_at: max(both) only if merged status is 'done'. NULL otherwise.
--   started_at:   earliest non-null (LEAST ignores NULLs in Postgres).
--   finished_at:  latest non-null only if merged status is 'done'. NULL otherwise.
--   done_qty:     max — preserves the larger partial-progress signal.
--   by_actor / by_user_id: coalesce 喷漆 first, then 丝印 (arbitrary but stable).
--
-- We keep the existing 喷漆 row's id when both legs exist (preserves audit FKs
-- and indexes), then delete the orphaned 丝印 row. Parts with only one of the
-- two stages get a plain stage rename.

begin;

-- 1. part_stages — merge the paired rows, then rename the singletons.

with paired as (
  select
    p.id          as paint_id,
    p.status      as paint_status,
    p.completed_at as paint_completed_at,
    p.started_at  as paint_started_at,
    p.finished_at as paint_finished_at,
    p.done_qty    as paint_done_qty,
    p.by_actor    as paint_by_actor,
    p.by_user_id  as paint_by_user_id,
    s.id          as silk_id,
    s.status      as silk_status,
    s.completed_at as silk_completed_at,
    s.started_at  as silk_started_at,
    s.finished_at as silk_finished_at,
    s.done_qty    as silk_done_qty,
    s.by_actor    as silk_by_actor,
    s.by_user_id  as silk_by_user_id
  from part_stages p
  join part_stages s on s.part_id = p.part_id
  where p.stage = '喷漆' and s.stage = '丝印'
)
update part_stages ps set
  stage  = '喷漆丝印',
  status = case
    when paired.paint_status = 'done' and paired.silk_status = 'done' then 'done'
    when paired.paint_status = 'in_progress' or paired.silk_status = 'in_progress' then 'in_progress'
    else 'pending'
  end,
  completed_at = case
    when paired.paint_status = 'done' and paired.silk_status = 'done'
      then greatest(paired.paint_completed_at, paired.silk_completed_at)
    else null
  end,
  started_at = least(paired.paint_started_at, paired.silk_started_at),
  finished_at = case
    when paired.paint_status = 'done' and paired.silk_status = 'done'
      then greatest(paired.paint_finished_at, paired.silk_finished_at)
    else null
  end,
  done_qty = (
    case
      when paired.paint_done_qty is null and paired.silk_done_qty is null then null
      else greatest(coalesce(paired.paint_done_qty, 0), coalesce(paired.silk_done_qty, 0))
    end
  ),
  by_actor   = coalesce(paired.paint_by_actor,   paired.silk_by_actor),
  by_user_id = coalesce(paired.paint_by_user_id, paired.silk_by_user_id)
from paired
where ps.id = paired.paint_id;

-- Drop the orphaned 丝印 rows for parts we just merged (the matching 喷漆 row
-- is now '喷漆丝印'). The remaining 丝印 rows (no matching 喷漆) get renamed
-- by the next step.
delete from part_stages
where stage = '丝印'
  and part_id in (select part_id from part_stages where stage = '喷漆丝印');

-- Singleton renames — parts that had only one of the two.
update part_stages set stage = '喷漆丝印' where stage in ('喷漆', '丝印');

-- 2. outsource_blocks.stages — replace either token with the merged name,
--    dedupe, and re-order canonically so the route reads in production order.

with canon(stage, ord) as (
  values
    ('工程'::text, 1),
    ('编程',       2),
    ('操机',       3),
    ('手工',       4),
    ('打磨',       5),
    ('喷漆丝印',   6),
    ('质量',       7),
    ('出货',       8)
)
update outsource_blocks ob set stages = (
  select coalesce(array_agg(c.stage order by c.ord), array[]::text[])
  from (
    select distinct case when s in ('喷漆', '丝印') then '喷漆丝印' else s end as stage
    from unnest(ob.stages) as s
  ) m
  join canon c on c.stage = m.stage
)
where '喷漆' = any(ob.stages) or '丝印' = any(ob.stages);

-- 3. job_stage_pins — same merge story. Both pins on one job collapse into
--    a single 喷漆丝印 pin; choose the earliest pinned_at to preserve the
--    "first starred" signal.

with paired_pins as (
  select
    p.job_id,
    least(p.pinned_at, s.pinned_at) as merged_pinned_at,
    coalesce(p.pinned_by, s.pinned_by) as merged_pinned_by
  from job_stage_pins p
  join job_stage_pins s on s.job_id = p.job_id
  where p.stage = '喷漆' and s.stage = '丝印'
)
update job_stage_pins jp set
  stage     = '喷漆丝印',
  pinned_at = paired_pins.merged_pinned_at,
  pinned_by = paired_pins.merged_pinned_by
from paired_pins
where jp.job_id = paired_pins.job_id and jp.stage = '喷漆';

delete from job_stage_pins
where stage = '丝印'
  and job_id in (select job_id from job_stage_pins where stage = '喷漆丝印');

update job_stage_pins set stage = '喷漆丝印' where stage in ('喷漆', '丝印');

-- 4. users.default_stage — any worker pinned to either old stage now belongs
--    to the merged station. No CHECK constraint complications: default_stage
--    is just a free-text column gated by the users_role_stage_check (which
--    only checks for nullness vs role, not the value).

update users set default_stage = '喷漆丝印' where default_stage in ('喷漆', '丝印');

-- 5. Re-create the views from 0018 + 0019 with the updated stage_order. The
--    CTE values list is the only thing that changes — body is byte-identical
--    to the original migrations.

create or replace view job_stage_rollup as
with stage_order(stage, ord) as (
  values
    ('工程'::text, 1),
    ('编程',       2),
    ('操机',       3),
    ('手工',       4),
    ('打磨',       5),
    ('喷漆丝印',   6),
    ('质量',       7),
    ('出货',       8)
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

create or replace view station_wip as
with stage_order(stage, ord) as (
  values
    ('工程'::text, 1),
    ('编程',       2),
    ('操机',       3),
    ('手工',       4),
    ('打磨',       5),
    ('喷漆丝印',   6),
    ('质量',       7),
    ('出货',       8)
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
    p.id as part_id,
    p.qty,
    p.unit_price_cny,
    p.line_total_cny,
    ps.stage,
    so.ord as stage_ord,
    case
      when ps.stage <> '出货' and coalesce(psb.has_open, false)   then 'outsourced_open'
      when ps.stage <> '出货' and coalesce(psb.has_closed, false) then 'done'
      when ps.status = 'done'                                     then 'done'
      when ps.status = 'in_progress'                              then 'in_progress'
      else                                                              'pending'
    end as eff_kind
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
),
parts_here as (
  select
    job_id,
    stage,
    part_id,
    qty,
    unit_price_cny,
    line_total_cny
  from ps_aug
  where
    eff_kind = 'in_progress'
    or (eff_kind = 'pending' and not coalesce(any_prior_unfinished, false))
),
parts_here_money as (
  select
    stage,
    job_id,
    part_id,
    coalesce(
      line_total_cny,
      unit_price_cny * qty,
      0
    )::numeric as line_total,
    (line_total_cny is null and unit_price_cny is null) as is_unpriced
  from parts_here
)
select
  so.stage,
  so.ord                                                       as stage_ord,
  count(distinct phm.job_id)::int                              as jobs_here,
  count(phm.part_id)::int                                      as parts_here,
  coalesce(sum(phm.line_total), 0)::numeric                    as wip_cny,
  count(phm.part_id) filter (where phm.is_unpriced)::int       as parts_unpriced
from stage_order so
left join parts_here_money phm on phm.stage = so.stage
group by so.stage, so.ord
order by so.ord;

commit;

-- Reload the PostgREST schema cache so the updated views are exposed
-- immediately (same playbook as 0018 / 0019).
notify pgrst, 'reload schema';
