-- 0092_cascade_start_attribution.sql
-- 谁完成 shows on EVERY done cell — cascade-on-start rows get a name, without
-- polluting the 报工 scoreboard.
--
-- THE GAP THE FLOOR SAW: hovering a ✓ cell answers "谁完成" — except at 检验/
-- 手工/喷漆 and friends, which often show nobody. Those stages are usually
-- closed by cascadeBackStart (lib/db.ts): starting a later stage is physical
-- evidence the part passed the earlier ones, so the ▶ auto-closes them — and
-- deliberately wrote by_actor NULL so the starter was never credited in
-- worker_output. Honest for the scoreboard, blank for the board.
--
-- THE FIX, in three parts:
--   1. (code, lib/db.ts) cascadeBackStart now stamps by_actor = the starter —
--      their ▶ IS the click that closed the row, so the hover names them.
--   2. (here) worker_output + worker_stage_events exclude those rows from
--      finish credit by TIMESTAMP, the same exact-detection trick 0071 used
--      for the 出货 cascade: cascadeBackStart writes finished_at equal to the
--      downstream row's started_at, in the same upsert. A finish stamped at
--      the very instant another stage on the same part started is an
--      auto-close, not real work. Real taps land in separate requests and
--      can never share an ISO-millisecond timestamp with another stage's ▶.
--   3. (here) one-time backfill: historical cascade-on-start rows (by_actor
--      NULL, finished_at = a sibling stage's started_at) get that sibling's
--      started_by_actor, so existing boards light up too. Pre-0028 legacy
--      rows with no matching start stay blank — we don't guess.
--
-- Ordering matters: the views gain the exclusion BEFORE the backfill writes
-- any names, so at no point does a starter get scoreboard credit for
-- upstream auto-closes (the exact bug 0071 killed for shippers).
--
-- MANUAL MIGRATION (see AGENTS.md): apply to Supabase by hand / via MCP.
-- Views/function are CREATE OR REPLACE (rolls back by re-running 0087); the
-- backfill only fills NULLs and can be re-run — it is idempotent.

-- ---------------------------------------------------------------------------
-- worker_output(from, to, stage) — 报工 scoreboard. Identical to 0087 except
-- the finished branch gains the cascade-on-start exclusion.
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
      (coalesce(v.sale_cny, 0) * baogong_value_rate())::numeric as value_cny,
      (v.value_source = 'none') as is_unpriced
    from part_stages ps
    join parts p on p.id = ps.part_id
    join part_sale_value v on v.part_id = p.id
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
      -- 0092: a finish stamped at the same instant ANOTHER stage on the same
      -- part STARTED is a cascade-on-start auto-close. The starter's name now
      -- rides by_actor for the board hover — never credit it here.
      and not exists (
        select 1 from part_stages st
        where st.part_id = ps.part_id
          and st.stage <> ps.stage
          and st.started_at = ps.finished_at
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
-- worker_stage_events — per-event feed behind the drill-downs and the 导出.
-- Identical to 0087 except the finished branch gains the same exclusion.
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
      (coalesce(v.sale_cny, 0) * baogong_value_rate())::numeric as value_cny,
      (v.value_source = 'none') as is_unpriced,
      (v.value_source = 'allocated') as is_allocated,
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
    join part_sale_value v on v.part_id = p.id
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
      -- 0092: exclude cascade-on-start auto-closes (see worker_output).
      and not exists (
        select 1 from part_stages st
        where st.part_id = ps.part_id
          and st.stage <> ps.stage
          and st.started_at = ps.finished_at
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
      (coalesce(v.sale_cny, 0) * baogong_value_rate())::numeric as value_cny,
      (v.value_source = 'none') as is_unpriced,
      (v.value_source = 'allocated') as is_allocated,
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
    join part_sale_value v on v.part_id = p.id
    where ps.started_at is not null
  )
  select
    ts, kind, actor_name, stage, part_id, part_name, part_qty,
    value_cny, is_unpriced, job_id, job_no, customer,
    part_no, material, surface_treatment, image_url,
    is_allocated
  from ev
  order by ts desc;

-- ---------------------------------------------------------------------------
-- Backfill: name historical cascade-on-start rows after the starter whose ▶
-- closed them. Only fills NULLs; the views above already exclude these rows
-- from finish credit, so this changes hover attribution and nothing else.
-- ---------------------------------------------------------------------------
update part_stages ps
set by_actor = st.started_by_actor
from part_stages st
where ps.by_actor is null
  and ps.status = 'done'
  and ps.finished_at is not null
  and st.part_id = ps.part_id
  and st.stage <> ps.stage
  and st.started_at = ps.finished_at
  and st.started_by_actor is not null;
