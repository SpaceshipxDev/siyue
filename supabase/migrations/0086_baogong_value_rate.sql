-- 0086_baogong_value_rate.sql
-- 经手金额 becomes 经手金额（按5%）— the number stops being a lie.
--
-- WHY: until now 经手金额 credited the part's FULL sale value at EVERY 工序.
-- A ¥10,000 part crossing its 8.6 average stages minted ¥86,000 of "output"
-- across the floor — the same yuan counted once per person who touched it.
-- Nobody could add the column up and get anything meaningful.
--
-- 于海伟's rule (2026-08-10): 每个报工工序按销售单价的5%进行分配价格，通过报工
-- 能体现出当班的产出。Each reported 工序 is worth 5% of the part's sale price,
-- so a shift's taps sum to the value that shift actually produced. At ~8 工序
-- per part that allocates ~43% of the sale price to floor labour, which is a
-- believable labour+overhead share for 手板 CNC.
--
-- WHAT CHANGES: only the ¥ on 报工 surfaces (/report 经手金额 + its 导出, the
-- station page's 经手金额, the floor dashboard's 今日经手). Finish counts,
-- 件数, 未定价 flags, cascade exclusion (0071) and 订单金额 (jobs.amount_cny)
-- are all untouched. Expect every 经手金额 to drop roughly 20× overnight.
--
-- NOT FIXED HERE: only ~19% of parts carry a price at all (11% of August's),
-- so ~88% of taps still score ¥0 and keep their 未定价 badge. The rate change
-- makes the priced ones honest; it does not conjure prices for the rest.
--
-- done_qty is NULL on all 22,215 finishes in the last 30 days — nobody ever
-- reports a partial quantity, every tap means "all of it". So 5% of the whole
-- line is exactly right and no per-piece proration is needed.
--
-- MANUAL MIGRATION (see AGENTS.md): apply to Supabase by hand / via MCP.
-- Read-only — CREATE OR REPLACE of one function and one view. No DML, no DDL
-- on tables, nothing to back out but a re-run with a different rate.

-- ---------------------------------------------------------------------------
-- The rate lives in ONE place. 5% is a first guess and the boss will tune it;
-- when he does, this function is the only thing that changes — the RPC and the
-- view below both fold it in. IMMUTABLE so the planner constant-folds it.
-- ---------------------------------------------------------------------------
create or replace function baogong_value_rate()
returns numeric
language sql
immutable
parallel safe
as $$ select 0.05::numeric $$;

comment on function baogong_value_rate() is
  '报工 经手金额 allocation rate — share of a part''s sale price credited to each reported 工序. 0086.';

-- ---------------------------------------------------------------------------
-- worker_output(from, to, stage) — 报工 scoreboard, one row per worker.
-- Identical to 0071 except value_cny is now rated. Keeping the whole body here
-- (rather than a wrapper) so the cascade-exclusion predicate stays readable in
-- one piece; it is load-bearing and must not drift.
-- ---------------------------------------------------------------------------
create or replace function worker_output(
  p_from  timestamptz,
  p_to    timestamptz,
  p_stage text default null
)
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
as $function$
  with ev as (
    select
      coalesce(fu.name, ps.by_actor) as actor_name,
      ps.finished_at as ts,
      'finished'::text as kind,
      p.qty as part_qty,
      (coalesce(p.line_total_cny, p.unit_price_cny * p.qty, 0) * baogong_value_rate())::numeric as value_cny,
      (p.line_total_cny is null and p.unit_price_cny is null) as is_unpriced
    from part_stages ps
    join parts p on p.id = ps.part_id
    left join users fu on fu.id = ps.by_user_id
    where ps.finished_at is not null
      and ps.finished_at >= p_from and ps.finished_at < p_to
      and (p_stage is null or ps.stage = p_stage)
      -- 0071: a non-出货 finish stamped at the same instant as that part's 出货
      -- is a cascade back-fill, not real work. Never credit it.
      and not (
        ps.stage <> '出货'
        and exists (
          select 1 from part_stages sh
          where sh.part_id = ps.part_id
            and sh.stage = '出货'
            and sh.finished_at = ps.finished_at
        )
      )
    union all
    select
      ps.started_by_actor as actor_name,
      ps.started_at as ts,
      'started'::text as kind,
      p.qty as part_qty,
      0::numeric as value_cny,
      false as is_unpriced
    from part_stages ps
    join parts p on p.id = ps.part_id
    where ps.started_at is not null
      and ps.started_at >= p_from and ps.started_at < p_to
      and (p_stage is null or ps.stage = p_stage)
  )
  select
    ev.actor_name,
    count(*) filter (where ev.kind = 'finished')::bigint as finishes,
    count(*) filter (where ev.kind = 'started')::bigint as starts,
    coalesce(sum(ev.part_qty) filter (where ev.kind = 'finished'), 0)::bigint as pieces,
    coalesce(sum(ev.value_cny) filter (where ev.kind = 'finished'), 0)::numeric as value_cny,
    count(*) filter (where ev.kind = 'finished' and ev.is_unpriced)::bigint as unpriced,
    max(ev.ts) as last_active
  from ev
  where ev.actor_name is not null and ev.actor_name <> ''
  group by ev.actor_name
  order by finishes desc, starts desc, value_cny desc;
$function$;

-- ---------------------------------------------------------------------------
-- worker_stage_events — the per-event feed behind the drill-downs and the
-- 导出 sheets (lib/pulse.ts getWorkerTimeline / getStationDetailByOrder).
-- Rated on BOTH branches: a 起步 row showing full value next to a 完成 row
-- showing 5% would read as a bug on the timeline.
-- ---------------------------------------------------------------------------
create or replace view worker_stage_events as
  with ev as (
    select
      ps.finished_at as ts,
      'finished'::text as kind,
      coalesce(fu.name, ps.by_actor) as actor_name,
      ps.stage,
      p.id as part_id,
      p.name as part_name,
      p.qty as part_qty,
      (coalesce(p.line_total_cny, p.unit_price_cny * p.qty, 0) * baogong_value_rate())::numeric as value_cny,
      (p.line_total_cny is null and p.unit_price_cny is null) as is_unpriced,
      p.job_id,
      j.job_no,
      j.customer,
      p.part_no,
      p.material,
      p.surface_treatment,
      p.image_url
    from part_stages ps
    join parts p on p.id = ps.part_id
    join jobs j on j.id = p.job_id
    left join users fu on fu.id = ps.by_user_id
    where ps.finished_at is not null
      and not (
        ps.stage <> '出货'
        and exists (
          select 1 from part_stages sh
          where sh.part_id = ps.part_id
            and sh.stage = '出货'
            and sh.finished_at = ps.finished_at
        )
      )
    union all
    select
      ps.started_at as ts,
      'started'::text as kind,
      ps.started_by_actor as actor_name,
      ps.stage,
      p.id as part_id,
      p.name as part_name,
      p.qty as part_qty,
      (coalesce(p.line_total_cny, p.unit_price_cny * p.qty, 0) * baogong_value_rate())::numeric as value_cny,
      (p.line_total_cny is null and p.unit_price_cny is null) as is_unpriced,
      p.job_id,
      j.job_no,
      j.customer,
      p.part_no,
      p.material,
      p.surface_treatment,
      p.image_url
    from part_stages ps
    join parts p on p.id = ps.part_id
    join jobs j on j.id = p.job_id
    where ps.started_at is not null
  )
  select
    ts, kind, actor_name, stage, part_id, part_name, part_qty,
    value_cny, is_unpriced, job_id, job_no, customer,
    part_no, material, surface_treatment, image_url
  from ev
  order by ts desc;
