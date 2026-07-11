-- 报功 (worker output) — the person-axis read of the floor. Where 0019's
-- station_events answers "what happened, in what order, by whom", this
-- answers "how much did each worker push through, per day/week/month".
--
-- All read-only. No new columns, no new writes. Every number here is
-- derived from part_stages.finished_at + by_actor — data the floor has been
-- generating on every ✓ since day one. The feature is pure reporting.
--
-- ¥ semantics: a part crosses ~7 stages, so its value is counted once per
-- finished stage. This is THROUGHPUT through a worker's hands ("经手"), not
-- revenue — company-wide it sums to more than total order value, on purpose.
-- The UI labels it 经手, never 产值/收入.

-- ---------------------------------------------------------------------------
-- worker_finish_events — one row per 完成 (finish) event, denormalized with
-- the part's effective ¥ value and job context. The 报功 drill-down (one
-- worker's timeline) reads this directly; the daily roll-up aggregates it
-- via worker_output() below.
--
-- actor_name mirrors station_events: coalesce(users.name, by_actor). In this
-- app by_user_id is never written (finishStage only sets by_actor = the
-- logged-in name), so the coalesce resolves to by_actor today — but it stays
-- forward-compatible if by_user_id starts getting populated.
--
-- value_cny mirrors data.ts#componentLineTotal: explicit line total, else
-- qty × unit price, else 0. is_unpriced flags the all-NULL-price rows so a
-- ¥0 contribution reads as "unknown", not "worthless" — same split as 0019.
--
-- Reuses the part_stages_finished_at_desc_idx partial index from 0019, so
-- range scans over finished_at stay O(rows-returned).
-- ---------------------------------------------------------------------------
create or replace view worker_finish_events as
select
  ps.finished_at                               as ts,
  coalesce(u.name, ps.by_actor)                as actor_name,
  ps.by_user_id,
  ps.stage,
  p.id                                         as part_id,
  p.name                                       as part_name,
  p.qty                                        as part_qty,
  coalesce(p.line_total_cny, p.unit_price_cny * p.qty, 0)::numeric as value_cny,
  (p.line_total_cny is null and p.unit_price_cny is null)         as is_unpriced,
  p.job_id,
  j.job_no,
  j.customer,
  j.product
from part_stages ps
join parts p on p.id = ps.part_id
join jobs  j on j.id = p.job_id
left join users u on u.id = ps.by_user_id
where ps.finished_at is not null
order by ps.finished_at desc;


-- ---------------------------------------------------------------------------
-- worker_output(from, to) — the daily 报功 scoreboard. One row per worker
-- within the [from, to) window. Aggregation happens in Postgres (not the
-- page handler) so a month-wide window returns a handful of worker rows
-- instead of shipping every finish event to the app to fold in JS.
--
-- Window boundaries are passed as UTC instants; the caller computes them
-- from the factory's Asia/Shanghai local day (lib/today.ts#shanghaiWindow).
-- ---------------------------------------------------------------------------
create or replace function worker_output(p_from timestamptz, p_to timestamptz)
returns table (
  actor_name text,
  finishes   bigint,   -- 完成零件 — count of part-stage completions ("flowed through")
  pieces     bigint,   -- 件 — sum of part qty
  value_cny  numeric,  -- ¥ 经手 — throughput value
  unpriced   bigint    -- finishes whose part had no price set
)
language sql
stable
as $$
  select
    wfe.actor_name,
    count(*)::bigint                                  as finishes,
    coalesce(sum(wfe.part_qty), 0)::bigint            as pieces,
    coalesce(sum(wfe.value_cny), 0)::numeric          as value_cny,
    count(*) filter (where wfe.is_unpriced)::bigint   as unpriced
  from worker_finish_events wfe
  where wfe.ts >= p_from and wfe.ts < p_to
  group by wfe.actor_name
  order by finishes desc, value_cny desc;
$$;


-- Schema-cache reload so PostgREST exposes the new view + function on the
-- next request — same as 0018 / 0019.
notify pgrst, 'reload schema';
