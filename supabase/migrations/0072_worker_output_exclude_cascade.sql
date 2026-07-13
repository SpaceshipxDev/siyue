-- 0071_worker_output_exclude_cascade.sql
-- 报工 truthfulness: exclude 出货 cascade back-fills from worker attribution.
--
-- WHY: cascadeBackFinish (lib/db.ts) closes every earlier not-yet-done stage of
-- a part the moment 出货 is finished, stamping each with the SAME finished_at
-- instant and by_actor = the shipper. Nobody actually tapped those stages, yet
-- the shipper was credited thousands of cross-stage 完成 — a 商务 who ships a
-- job outranked the real 编程/打磨 workers on the 报工 scoreboard (e.g. 俞予悦,
-- a 商务, showed 574 打磨 finishes; after this fix, 10). Genuinely-tapped stages
-- are SKIPPED by the cascade (it only touches non-'done' rows), so their
-- attribution is real work and is preserved.
--
-- DETECTION (exact, no heuristic): a non-'出货' finish whose finished_at equals
-- that same part's '出货' finished_at is a cascade back-fill — exclude it from
-- finish counts / pieces / value / timeline. 起步 (starts) are untouched: the
-- cascade never writes started_at / started_by_actor.
--
-- MANUAL MIGRATION (see AGENTS.md): apply to Supabase by hand / via MCP. This is
-- read-only (CREATE OR REPLACE of a view + an RPC); it changes only reporting
-- surfaces, NOT how the master board shows a shipped part's stages as done.

-- ---------------------------------------------------------------------------
-- worker_output(from, to, stage) — 报工 scoreboard, one row per worker over
-- [from,to), optionally scoped to one stage. Same signature as 0039; only the
-- finished branch gains the cascade-exclusion predicate.
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
      -- exclude 出货 cascade back-fills (see header)
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
$$;

-- ---------------------------------------------------------------------------
-- worker_stage_events — per-event drill-down (started + finished). Same column
-- set as 0029; the finished branch gains the same cascade-exclusion predicate
-- so a worker's timeline shows only stages they actually tapped.
-- ---------------------------------------------------------------------------
create or replace view worker_stage_events as
with ev as (
  -- 完成 events (cascade back-fills excluded).
  select
    ps.finished_at                               as ts,
    'finished'::text                             as kind,
    coalesce(fu.name, ps.by_actor)               as actor_name,
    ps.stage,
    p.id                                         as part_id,
    p.name                                       as part_name,
    p.qty                                        as part_qty,
    coalesce(p.line_total_cny, p.unit_price_cny * p.qty, 0)::numeric as value_cny,
    (p.line_total_cny is null and p.unit_price_cny is null)         as is_unpriced,
    p.job_id,
    j.job_no,
    j.customer,
    p.part_no,
    p.material,
    p.surface_treatment,
    p.image_url
  from part_stages ps
  join parts p on p.id = ps.part_id
  join jobs  j on j.id = p.job_id
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

  -- 开始 events (unchanged — the cascade never writes started_at).
  select
    ps.started_at                                as ts,
    'started'::text                              as kind,
    ps.started_by_actor                          as actor_name,
    ps.stage,
    p.id                                         as part_id,
    p.name                                       as part_name,
    p.qty                                        as part_qty,
    coalesce(p.line_total_cny, p.unit_price_cny * p.qty, 0)::numeric as value_cny,
    (p.line_total_cny is null and p.unit_price_cny is null)         as is_unpriced,
    p.job_id,
    j.job_no,
    j.customer,
    p.part_no,
    p.material,
    p.surface_treatment,
    p.image_url
  from part_stages ps
  join parts p on p.id = ps.part_id
  join jobs  j on j.id = p.job_id
  where ps.started_at is not null
)
select * from ev
order by ts desc;

notify pgrst, 'reload schema';
