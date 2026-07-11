-- Master board shell aggregates.
--
-- The dashboard shell should not load every MasterRow just to render top-bar
-- pills and the per-station summary strip. This view keeps those counts as a
-- single-row read; the full grid body is fetched separately by
-- /api/master/rows after hydration.

create or replace view master_board_summary as
with today_sh as (
  select (now() at time zone 'Asia/Shanghai')::date as d
),
base as (
  select
    j.id,
    j.amount_cny,
    j.paused_at,
    coalesce(js.external_spend_cny, 0)::numeric as external_spend_cny,
    coalesce(js.active_return_due_date, j.due_date)::date as effective_due_date,
    coalesce(ship.total, 0) > 0
      and coalesce(ship.in_progress, 0) = 0
      and coalesce(ship.pending, 0) = 0 as is_shipped
  from jobs j
  left join job_summary js on js.job_id = j.id
  left join job_stage_rollup ship
    on ship.job_id = j.id
   and ship.stage = '出货'
  where coalesce(j.status, 'ready') not in ('parsing', 'draft', 'failed')
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
    ('编程', 1),
    ('下料', 2),
    ('焊接', 3),
    ('打磨', 4),
    ('喷塑', 5),
    ('丝印', 6),
    ('组装', 7),
    ('检验', 8),
    ('出货', 9)
),
stage_totals as (
  select
    sn.stage,
    sn.ord,
    count(b.id) filter (
      where coalesce(r.in_progress, 0) > 0 or coalesce(r.has_mine_pending, false)
    )::int as here,
    count(b.id) filter (
      where (coalesce(r.in_progress, 0) > 0 or coalesce(r.has_mine_pending, false))
        and b.effective_due_date = (select d from today_sh)
    )::int as due_today,
    count(b.id) filter (
      where (coalesce(r.in_progress, 0) > 0 or coalesce(r.has_mine_pending, false))
        and b.effective_due_date < (select d from today_sh)
    )::int as overdue,
    coalesce(sum(r.total) filter (where b.id is not null), 0)::int as parts
  from stage_names sn
  left join job_stage_rollup r on r.stage = sn.stage
  left join base b on b.id = r.job_id
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
