-- 0039_worker_output_by_stage.sql
-- 报功 gains a station axis. Until now worker_output() aggregated each actor's
-- throughput across *every* stage they touched — so "编程 output, by person"
-- was unanswerable, and a worker who runs both 操机 and 手工 showed one blended
-- count. The boss navigates the floor by station tab and wants the 报功 lens
-- scoped to the station he's standing on.
--
-- This adds an optional p_stage filter. NULL (or omitted) preserves the old
-- global behaviour exactly; a stage value re-scopes both the counts and the
-- value to that one station. worker_stage_events already carries `stage`, and
-- migration 0019 indexed part_stages on (stage, started_at) / (stage,
-- finished_at), so the filtered path is cheap. The drill-down timeline filters
-- on `stage` in the app layer (lib/pulse.ts getWorkerTimeline).

-- Drop the 2-arg signature and replace with a 3-arg overload carrying a default
-- so existing callers (rpc with only p_from/p_to) keep working unchanged.
drop function if exists worker_output(timestamptz, timestamptz);

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
as $$
  with ev as (
    select
      coalesce(fu.name, ps.by_actor) as actor_name,
      ps.finished_at as ts,
      'finished'::text as kind,
      p.qty as part_qty,
      coalesce(p.line_total_cny, p.unit_price_cny * p.qty, 0)::numeric as value_cny,
      (p.line_total_cny is null and p.unit_price_cny is null) as is_unpriced
    from part_stages ps
    join parts p on p.id = ps.part_id
    left join users fu on fu.id = ps.by_user_id
    where ps.finished_at is not null
      and ps.finished_at >= p_from and ps.finished_at < p_to
      and (p_stage is null or ps.stage = p_stage)

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
$$;
