-- 0087 — Yingma route: OP1..OP6 -> optional 铣床 -> required 检验 -> 出货.
--
-- Stable database keys are retained:
--   丝印 = 铣床 in the Yingma UI
--   检验 = the required final inspection gate
--
-- 0048 originally placed 检验 between 操机 and 手工. The Yingma product later
-- hid that stage and created some parts without it. This migration restores the
-- invariant for every part and updates the two ordered views to the factory's
-- current physical route.

begin;

-- Parts created after the Yingma fork may have no inspection row. Shipped
-- parts are historical and stay complete; every active part enters the new
-- required inspection gate as pending.
insert into part_stages (
  id,
  part_id,
  stage,
  status,
  completed_at,
  finished_at
)
select
  p.id || ':检验',
  p.id,
  '检验',
  case when ship.status = 'done' then 'done' else 'pending' end,
  case when ship.status = 'done' then ship.completed_at else null end,
  case when ship.status = 'done' then ship.finished_at else null end
from parts p
left join part_stages ship
  on ship.part_id = p.id and ship.stage = '出货'
where not exists (
  select 1
  from part_stages inspection
  where inspection.part_id = p.id and inspection.stage = '检验'
);

-- The old OP2->检验->OP3 cascade auto-completed inspection without an actor or
-- verdict. Re-open only those machine-generated rows on active parts. Genuine
-- inspector decisions and shipped history remain untouched.
update part_stages inspection
set
  status = 'pending',
  completed_at = null,
  started_at = null,
  finished_at = null,
  done_qty = null
where inspection.stage = '检验'
  and inspection.status = 'done'
  and inspection.verdict is null
  and inspection.by_actor is null
  and not exists (
    select 1
    from part_stages ship
    where ship.part_id = inspection.part_id
      and ship.stage = '出货'
      and ship.status = 'done'
  );

create or replace view job_stage_rollup as
with stage_order(stage, ord) as (
  values
    ('工程'::text, 1),
    ('编程',       2),
    ('操机',       3),
    ('手工',       4),
    ('打磨',       5),
    ('喷漆',       6),
    ('质量',       7),
    ('丝印',       8),
    ('检验',       9),
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
      when ps.stage <> '出货' and coalesce(psb.has_open, false)   then 'outsourced_open'
      when ps.stage <> '出货' and coalesce(psb.has_closed, false) then 'done'
      when ps.status = 'done'                                     then 'done'
      when ps.status = 'in_progress'                              then 'in_progress'
      else                                                              'pending'
    end as eff_kind,
    (ps.stage <> '出货' and coalesce(psb.has_closed, false)) as is_outsourced_closed
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
  count(*)::int                                                               as total,
  count(*) filter (where is_outsourced_closed)::int                           as outsourced_closed,
  count(*) filter (where eff_kind = 'outsourced_open')::int                   as outsourced_open,
  count(*) filter (where eff_kind = 'in_progress')::int                       as in_progress,
  count(*) filter (where eff_kind = 'pending')::int                           as pending,
  coalesce(sum(done_qty) filter (where eff_kind = 'in_progress'), 0)::int     as in_progress_done_qty_sum,
  min(started_at) filter (where eff_kind = 'in_progress')                     as earliest_in_progress_at,
  max(coalesce(finished_at::text, completed_at)) filter (where eff_kind = 'done') as latest_finished_at,
  max(completed_at) filter (where eff_kind = 'done')                          as latest_completed_at,
  bool_or(eff_kind = 'pending' and not coalesce(any_prior_unfinished, false)) as has_mine_pending,
  bool_or(coalesce(any_prior_unfinished, false))                               as has_upstream_active,
  (array_agg(by_actor order by finished_at desc nulls last)
     filter (where eff_kind = 'done' and by_actor is not null and finished_at is not null)
  )[1]                                                                         as latest_by_actor
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
    ('质量',       7),
    ('丝印',       8),
    ('检验',       9),
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
    coalesce(line_total_cny, unit_price_cny * qty, 0)::numeric as line_total,
    (line_total_cny is null and unit_price_cny is null) as is_unpriced
  from parts_here
)
select
  so.stage,
  so.ord                                                  as stage_ord,
  count(distinct phm.job_id)::int                         as jobs_here,
  count(phm.part_id)::int                                 as parts_here,
  coalesce(sum(phm.line_total), 0)::numeric               as wip_cny,
  count(phm.part_id) filter (where phm.is_unpriced)::int  as parts_unpriced
from stage_order so
left join parts_here_money phm on phm.stage = so.stage
group by so.stage, so.ord
order by so.ord;

-- The materialized board rows cache rollup cells; refresh them after changing
-- the view's upstream/downstream interpretation.
select refresh_master_board_rows();

notify pgrst, 'reload schema';

commit;
