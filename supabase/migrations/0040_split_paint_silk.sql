-- Split the merged 喷漆丝印 工段 back into two independent stages: 喷漆 and 丝印.
--
-- The reverse of 0020_merge_paint_silk.sql. Operationally the shop found that
-- 喷漆 (spray paint) and 丝印 (silk-screen) are run by different people / shops
-- often enough that collapsing them lost real signal — a part can sit done at
-- paint while silk hasn't started. We're putting the two columns back.
--
-- New canonical stage order (lib/data.ts STAGES):
--   工程 编程 操机 手工 打磨 喷漆 丝印 质量 出货
--
-- The merge (0020) was lossy: it collapsed each part's two rows into one, so
-- the original per-leg status / timestamps / actors no longer exist. And every
-- order created while the stages were merged has only a 喷漆丝印 row (or none).
-- Leaving the new columns empty makes historical orders read as "paint/silk
-- not done" on the board.
--
-- Decision (shop call): back-fill so EVERY existing part ends with a DONE 喷漆
-- row and a DONE 丝印 row — the two columns are "clicked-in" by default for all
-- existing work, regardless of the part's current status. This deliberately
-- force-dones paint/silk even on parts still mid-production; the alternative
-- (blank columns on every legacy order) was worse for the floor. NEW jobs from
-- here route normally — the 工艺卡 / routing chips decide applies per part.
--
-- Symmetric for pins. users.default_stage can hold only one value, so workers
-- who were on the merged station land on 喷漆 (the upstream of the two).

begin;

-- 1. part_stages — split the merged rows AND back-fill both stages as done for
--    every part. Order matters: duplicate the merged row to 丝印 first (while
--    it still reads '喷漆丝印'), rename the original to 喷漆, then top up every
--    part that had neither. ON CONFLICT / NOT EXISTS make this re-runnable.

-- 1a. Duplicate existing 喷漆丝印 rows onto 丝印 (forced done), preserving the
--     merged audit trail (actor / timestamps) where it exists.
insert into part_stages (
  id, part_id, stage, status, completed_at, by_actor, by_user_id,
  started_at, finished_at, done_qty, started_by_actor
)
select
  gen_random_uuid()::text, part_id, '丝印', 'done', completed_at, by_actor,
  by_user_id, started_at, finished_at, done_qty, started_by_actor
from part_stages
where stage = '喷漆丝印'
on conflict (part_id, stage) do nothing;

-- 1b. Rename the merged row to 喷漆 and force it done.
update part_stages set stage = '喷漆', status = 'done' where stage = '喷漆丝印';

-- 1c. Back-fill a done 喷漆 row for every part that still lacks one.
insert into part_stages (id, part_id, stage, status)
select gen_random_uuid()::text, p.id, '喷漆', 'done'
from parts p
where not exists (
  select 1 from part_stages ps where ps.part_id = p.id and ps.stage = '喷漆'
);

-- 1d. Back-fill a done 丝印 row for every part that still lacks one.
insert into part_stages (id, part_id, stage, status)
select gen_random_uuid()::text, p.id, '丝印', 'done'
from parts p
where not exists (
  select 1 from part_stages ps where ps.part_id = p.id and ps.stage = '丝印'
);

-- 1e. Force every 喷漆 / 丝印 row to done — the explicit statement of "all
--     existing work checked-in." Also catches rows left pending by a prior
--     partial run of this migration (the NOT EXISTS guards above would skip
--     them). Clear done_qty so we never leave a 'done' row with a partial
--     count (the app invariant: done ⇒ all qty). One-shot migration, so this
--     only touches the current data set; new jobs route normally afterwards.
update part_stages
set status = 'done', done_qty = null
where stage in ('喷漆', '丝印') and status <> 'done';

-- 2. outsource_blocks.stages — replace the merged token with BOTH stages,
--    dedupe, and re-order canonically (production order, new 9-stage list).
with canon(stage, ord) as (
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
)
update outsource_blocks ob set stages = (
  select coalesce(array_agg(c.stage order by c.ord), array[]::text[])
  from (
    -- expand 喷漆丝印 into the two real stages; pass everything else through
    select '喷漆' as stage from unnest(ob.stages) as s where s = '喷漆丝印'
    union
    select '丝印' as stage from unnest(ob.stages) as s where s = '喷漆丝印'
    union
    select s     as stage from unnest(ob.stages) as s where s <> '喷漆丝印'
  ) m
  join canon c on c.stage = m.stage
)
where '喷漆丝印' = any(ob.stages);

-- 3. job_stage_pins — duplicate the merged pin onto 丝印, then rename to 喷漆.
insert into job_stage_pins (job_id, stage, pinned_at, pinned_by)
select job_id, '丝印', pinned_at, pinned_by
from job_stage_pins
where stage = '喷漆丝印'
on conflict (job_id, stage) do nothing;

update job_stage_pins set stage = '喷漆' where stage = '喷漆丝印';

-- 4. users.default_stage — workers on the merged station move to 喷漆.
update users set default_stage = '喷漆' where default_stage = '喷漆丝印';

-- 5. Re-create the stage-ordered views (job_stage_rollup from 0028,
--    station_wip from 0019/0020). Only the stage_order CTE changes — bodies
--    are byte-identical to their current definitions. CREATE OR REPLACE keeps
--    the column order, so the leading columns are unchanged.

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
  bool_or(coalesce(any_prior_unfinished, false))                              as has_upstream_active,
  (array_agg(by_actor order by finished_at desc nulls last)
     filter (where eff_kind = 'done' and by_actor is not null and finished_at is not null)
  )[1]                                                                        as latest_by_actor
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
    ('喷漆',       6),
    ('丝印',       7),
    ('质量',       8),
    ('出货',       9)
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
-- immediately (same playbook as 0019 / 0020 / 0028).
notify pgrst, 'reload schema';
