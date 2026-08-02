-- 0084 — Move 采购 ahead of 编程 in the stage order, per the floor:
--   工程 · 采购 · 编程 · 操机 · 检验 · 手工 · 打磨 · 表处 · 喷漆 · 丝印 · 质量 · 出货
--
-- 0083 put 采购 between 编程 and 操机, reasoning from the physical gate ("you
-- can't cut steel that hasn't arrived"). The shop reasons from when the work
-- STARTS instead: material lead time is the long pole, so buying kicks off the
-- moment 工程 has analyzed the part and runs in PARALLEL with 编程 (desk work
-- that needs no material). Their order is the true one — it's the order the
-- two jobs actually begin in.
--
-- Consequence handled in code, not here: cascadeBackStart auto-closes every
-- upstream stage when one starts, so with 采购 now upstream of 编程 a
-- programmer pressing ▶ would have silently claimed the steel landed. See
-- stageStartImpliesUpstreamDone() in lib/data.ts — 编程 no longer cascades
-- 采购; 操机 onward still does (those hands are on the metal).
--
-- Identical bodies to 0083 with ONLY the 采购/编程 ordinals swapped. Existing
-- data is untouched: no part has a 编程/采购 ordering dependency recorded, the
-- ordinal is derived at query time, and cells are keyed by stage NAME.

begin;

create or replace view job_stage_rollup as
with stage_order(stage, ord) as (
  values
    ('工程'::text, 1),
    ('采购',       2),
    ('编程',       3),
    ('操机',       4),
    ('检验',       5),
    ('手工',       6),
    ('打磨',       7),
    ('表处',       8),
    ('喷漆',       9),
    ('丝印',      10),
    ('质量',      11),
    ('出货',      12)
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
    ('采购',       2),
    ('编程',       3),
    ('操机',       4),
    ('检验',       5),
    ('手工',       6),
    ('打磨',       7),
    ('表处',       8),
    ('喷漆',       9),
    ('丝印',      10),
    ('质量',      11),
    ('出货',      12)
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

create or replace function master_board_facets(
  p_q text default null,
  p_job_no_only boolean default false,
  p_ship text default null,
  p_sort text default 'due',
  p_date_start text default null,
  p_date_end text default null,
  p_status_filters jsonb default '{}'::jsonb
)
returns table(stage text, pending int, partial int, done int, total int)
language sql
stable
as $$
  with stage_names(stage, ord) as (
    values
      ('工程', 1),
      ('采购', 2),
      ('编程', 3),
      ('操机', 4),
      ('检验', 5),
      ('手工', 6),
      ('打磨', 7),
      ('表处', 8),
      ('喷漆', 9),
      ('丝印', 10),
      ('质量', 11),
      ('出货', 12)
  ),
  filtered as (
    select m.*
    from master_board_rows m
    where coalesce(m.status, 'ready') not in ('parsing', 'draft', 'failed')
      and (
        nullif(trim(coalesce(p_q, '')), '') is null
        or (
          p_job_no_only
          and m.job_no ilike '%' || trim(p_q) || '%'
        )
        or (
          not p_job_no_only
          and m.search_haystack ilike '%' || lower(trim(p_q)) || '%'
        )
      )
      and (
        p_ship is null
        or (p_ship = 'shipped' and m.is_shipped)
        or (p_ship = 'paused' and not m.is_shipped and m.paused_at is not null)
        or (p_ship = 'live' and not m.is_shipped and m.paused_at is null)
      )
      and (
        p_date_start is null
        or case
          when p_sort = 'jobNo' then m.job_intake_date
          else m.effective_due_date
        end >= p_date_start
      )
      and (
        p_date_end is null
        or case
          when p_sort = 'jobNo' then m.job_intake_date
          else m.effective_due_date
        end <= p_date_end
      )
  )
  select
    sn.stage,
    count(*) filter (
      where master_board_stage_kind(f.cells, sn.stage) = 'pending'
    )::int as pending,
    count(*) filter (
      where master_board_stage_kind(f.cells, sn.stage) = 'partial'
    )::int as partial,
    count(*) filter (
      where master_board_stage_kind(f.cells, sn.stage) = 'done'
    )::int as done,
    count(*) filter (
      where master_board_stage_kind(f.cells, sn.stage) in ('pending', 'partial', 'done')
    )::int as total
  from stage_names sn
  left join filtered f
    on not exists (
      select 1
      from jsonb_each_text(coalesce(p_status_filters, '{}'::jsonb)) sf
      where sf.key <> sn.stage
        and master_board_stage_kind(f.cells, sf.key) <> sf.value
    )
  group by sn.stage, sn.ord
  order by sn.ord;
$$;

create or replace view master_board_summary as
with today_sh as (
  select (now() at time zone 'Asia/Shanghai')::date as d
),
ready as (
  select
    (select count(*) from master_board_rows) >=
    (select count(*) from jobs) as ok
),
base as (
  select
    m.job_id as id,
    m.amount_cny,
    m.external_spend_cny,
    m.effective_due_date::date as effective_due_date,
    m.paused_at,
    m.is_shipped
  from master_board_rows m
  cross join ready
  where ready.ok
    and coalesce(m.status, 'ready') not in ('parsing', 'draft', 'failed')
  union all
  select
    j.id,
    j.amount_cny,
    coalesce(js.external_spend_cny, 0)::numeric as external_spend_cny,
    coalesce(js.active_return_due_date, j.due_date)::date as effective_due_date,
    j.paused_at,
    coalesce(ship.total, 0) > 0
      and coalesce(ship.in_progress, 0) = 0
      and coalesce(ship.pending, 0) = 0 as is_shipped
  from jobs j
  cross join ready
  left join job_summary js on js.job_id = j.id
  left join job_stage_rollup ship
    on ship.job_id = j.id
   and ship.stage = '出货'
  where not ready.ok
    and coalesce(j.status, 'ready') not in ('parsing', 'draft', 'failed')
),
global_totals as (
  select
    count(*)::int as total_jobs,
    count(*) filter (where not is_shipped and paused_at is null)::int as in_progress_jobs,
    count(*) filter (where not is_shipped and paused_at is not null)::int as paused_jobs,
    count(*) filter (
      where not is_shipped
        and paused_at is null
        and effective_due_date < (select d from today_sh)
    )::int as overdue_jobs,
    count(*) filter (
      where not is_shipped
        and paused_at is null
        and effective_due_date = (select d from today_sh)
    )::int as due_today_jobs,
    coalesce(sum(amount_cny), 0)::numeric as total_amount_cny,
    coalesce(sum(external_spend_cny), 0)::numeric as total_external_spend_cny,
    coalesce(sum(coalesce(amount_cny, 0) - external_spend_cny), 0)::numeric as total_margin_cny
  from base
),
stage_names(stage, ord) as (
  values
    ('工程', 1),
    ('采购', 2),
    ('编程', 3),
    ('操机', 4),
    ('检验', 5),
    ('手工', 6),
    ('打磨', 7),
    ('表处', 8),
    ('喷漆', 9),
    ('丝印', 10),
    ('质量', 11),
    ('出货', 12)
),
rollup_source as (
  select
    m.job_id,
    sn.stage,
    (
      coalesce((m.cells -> sn.stage ->> 'inProgress')::int, 0) > 0
      or coalesce((m.cells -> sn.stage ->> 'hasMinePending')::boolean, false)
    ) as here,
    coalesce((m.cells -> sn.stage ->> 'total')::int, 0) as total
  from master_board_rows m
  cross join ready
  cross join stage_names sn
  where ready.ok
    and m.cells ? sn.stage
    and coalesce(m.status, 'ready') not in ('parsing', 'draft', 'failed')
  union all
  select
    r.job_id,
    r.stage,
    coalesce(r.in_progress, 0) > 0 or coalesce(r.has_mine_pending, false) as here,
    coalesce(r.total, 0) as total
  from job_stage_rollup r
  cross join ready
  where not ready.ok
),
stage_totals as (
  select
    sn.stage,
    sn.ord,
    count(b.id) filter (where rs.here)::int as here,
    count(b.id) filter (
      where rs.here
        and b.effective_due_date = (select d from today_sh)
    )::int as due_today,
    count(b.id) filter (
      where rs.here
        and b.effective_due_date < (select d from today_sh)
    )::int as overdue,
    coalesce(sum(rs.total) filter (where b.id is not null), 0)::int as parts
  from stage_names sn
  left join rollup_source rs on rs.stage = sn.stage
  left join base b on b.id = rs.job_id
  group by sn.stage, sn.ord
)
select
  gt.total_jobs,
  gt.in_progress_jobs,
  gt.paused_jobs,
  gt.overdue_jobs,
  gt.due_today_jobs,
  gt.total_amount_cny,
  gt.total_external_spend_cny,
  gt.total_margin_cny,
  (
    select jsonb_object_agg(
      st.stage,
      jsonb_build_object(
        'here', st.here,
        'dueToday', st.due_today,
        'overdue', st.overdue,
        'parts', st.parts
      )
      order by st.ord
    )
    from stage_totals st
  ) as by_stage
from global_totals gt;

commit;

notify pgrst, 'reload schema';
