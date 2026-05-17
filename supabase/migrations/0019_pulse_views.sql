-- 现场 (pulse) views. Powers /pulse (boss-only factory snapshot + activity
-- feed) and the per-station ¥在此 metric + recent-events strip on
-- /?stage=<x>. All read-only; no schema change to existing tables.
--
-- The shapes here mirror app/pulse usage 1:1 — no per-row JS aggregation
-- needed in the page handler. Same playbook as 0018_master_rollup.sql.

-- ---------------------------------------------------------------------------
-- 1. station_wip — one row per stage. "What is sitting at this station right
--    now, and how much is it worth?"
--
--    A part counts toward a station when its (job, stage) is effectively
--    in_progress OR pending-with-no-prior-unfinished-stage — i.e. the
--    boss-meaningful "mine here" definition that the master grid uses (see
--    0018 has_mine_pending + in_progress > 0). Done parts don't sit here;
--    upstream-blocked pending parts sit at their upstream station, not here.
--
--    wip_cny = sum of effective component subtotals (line_total_cny when
--    set, else unit_price_cny * qty) for those parts. Both prices may be
--    null on legacy/draft jobs — those contribute 0 silently so the chip
--    still renders (the row count is still meaningful even when prices
--    haven't been backfilled). The qty divisor is the part's total qty;
--    partial-done doesn't reduce the WIP $ on purpose — the part as a whole
--    is still sitting at the station until it's flipped to done.
-- ---------------------------------------------------------------------------
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
-- Per-(part, stage) outsource coverage — same definition as 0018, kept
-- self-contained so this view doesn't depend on the rollup view internals.
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
-- For each part_stage row, is any *earlier* in-route stage on the same
-- part still unfinished? If yes, this row is "upstream-blocked" — the part
-- doesn't count as sitting here yet.
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
-- "Mine here" = the master-grid definition of a job-part that the station
-- head can act on right now: in_progress OR (pending AND no prior unfinished).
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
-- Per-part effective line subtotal — same logic as data.ts#componentLineTotal:
-- prefer the explicit line total, else qty × unit price, else 0.
parts_here_money as (
  select
    stage,
    job_id,
    part_id,
    coalesce(
      line_total_cny,
      unit_price_cny * qty,
      0
    )::numeric as line_total
  from parts_here
)
select
  so.stage,
  so.ord                                                       as stage_ord,
  -- Distinct jobs sitting here (a job with 3 parts here = 1 job, 3 parts).
  count(distinct phm.job_id)::int                              as jobs_here,
  count(phm.part_id)::int                                      as parts_here,
  coalesce(sum(phm.line_total), 0)::numeric                    as wip_cny
from stage_order so
left join parts_here_money phm on phm.stage = so.stage
group by so.stage, so.ord
order by so.ord;


-- ---------------------------------------------------------------------------
-- 2. station_events — recent stage transitions, denormalized for display.
--    "What did each station click, in what order, by whom?"
--
--    Source: part_stages.started_at and finished_at. Each non-null timestamp
--    is one event; we UNION ALL the two columns so the same row can emit
--    both "开始" and "完成" events. by_user_id resolves to a display name,
--    falling back to the legacy free-text by_actor field for old rows.
--
--    LIMIT in the view caps the worst case (years of stage events × 9
--    stages) — the page handler does its own per-station LIMIT 20 on top.
--    The aggregate window keeps this cheap even on a multi-million-row
--    part_stages table.
-- ---------------------------------------------------------------------------
create or replace view station_events as
with raw_events as (
  -- 完成 events.
  select
    ps.finished_at as ts,
    ps.stage,
    'finished'::text as kind,
    ps.by_user_id,
    ps.by_actor,
    p.id as part_id,
    p.job_id,
    p.name as part_name,
    p.qty as part_qty,
    ps.done_qty
  from part_stages ps
  join parts p on p.id = ps.part_id
  where ps.finished_at is not null

  union all

  -- 开始 events.
  select
    ps.started_at as ts,
    ps.stage,
    'started'::text as kind,
    ps.by_user_id,
    ps.by_actor,
    p.id as part_id,
    p.job_id,
    p.name as part_name,
    p.qty as part_qty,
    ps.done_qty
  from part_stages ps
  join parts p on p.id = ps.part_id
  where ps.started_at is not null
)
select
  re.ts,
  re.stage,
  re.kind,
  re.by_user_id,
  coalesce(u.name, re.by_actor) as actor_name,
  re.part_id,
  re.part_name,
  re.part_qty,
  re.done_qty,
  re.job_id,
  j.job_no,
  j.customer,
  j.product
from raw_events re
join jobs j on j.id = re.job_id
left join users u on u.id = re.by_user_id
order by re.ts desc
limit 2000;


-- Schema-cache reload so PostgREST exposes the new views immediately on
-- next request — same as 0018.
notify pgrst, 'reload schema';
