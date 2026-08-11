-- 0087_baogong_allocate_order_amount.sql
-- 经手金额 stops reading ¥0 on orders that plainly have money.
--
-- THE BUG 于海伟 SAW: he pulled 车工李元发's July (报工 → 找人 → 月 → 导出) and
-- 工单汇总 showed 微影 订单金额 ¥175,935 sitting next to 经手金额 ¥0. Same for
-- 华诺康 ¥89,720 → ¥0, 五八智能 ¥27,520 → ¥0. 30 of the 39 orders he touched
-- scored nothing. His whole month came to ¥782 on orders worth ¥500,219.
--
-- WHY: the two numbers have nothing to do with each other.
--   订单金额 = jobs.amount_cny — ONE number, typed by hand by 商务. 74% filled.
--   经手金额 = 5% × parts.line_total_cny / unit_price_cny — a price PER PART,
--             only ever written by the Gemini import, and only when the
--             customer's own file carried a 单价/小计 column (lib/gemini.ts).
-- Nobody hand-fills 39 part prices, so it is all-or-nothing per job: 海康威视
-- 数字技术股份有限公司 97% priced, 思看 69%, 微影 47% — but 五八智能 2%, 大华 4%,
-- 道禾 0%, 海康汽车 0%. Same customer under a short name = 0%, because those
-- were typed rather than imported. 5% was working fine; it was 5% of nothing.
--
-- THE FIX: when a part has no quoted price, fall back to its share of the
-- order total — jobs.amount_cny ÷ that job's part count. July tap coverage
-- 21.5% → 90.3%. 李元发's July ¥782 → ~¥5,324.
--
-- WHY EQUAL-PER-PART AND NOT PER-PIECE: measured against the 19% of jobs that
-- DO carry real per-part prices, both allocators are equally wrong on a single
-- part (median 51% error) — but per-piece blows up at the tail, because one
-- 3,000-piece screw line eats an entire order's value. Per-person-per-month,
-- equal-split lands within 1-2% for high-volume people (质量周中华 −1%,
-- 于海伟 −2%, 彭炳才 0%) vs per-piece's +78% worst case.
--
-- ⚠ THE HONEST LIMIT — DO NOT LET THIS BECOME PAYROLL UNMARKED. The error only
-- cancels with volume. In the same July test, 程江华 (47 taps) came out −42%
-- and 编程004 毛伟超 (51 taps) +48%. This number is good for 产出 visibility,
-- NOT for setting a low-volume worker's wage. Which is why every surface can
-- now tell the two apart, and the 导出 labels every row 报价 / 摊分 / 无单价.
-- The real cure is still 商务 filling 单价 at import.
--
-- MANUAL MIGRATION (see AGENTS.md): apply to Supabase by hand / via MCP.
-- Read-only — CREATE OR REPLACE of two functions and one view. No DML, no DDL
-- on tables. Rolls back by re-running 0086.

-- ---------------------------------------------------------------------------
-- part_sale_value — ONE definition of "what is this part worth, and how sure
-- are we". Both the RPC and the view read it, so the allocation rule can never
-- drift between the scoreboard and its export.
--
--   quoted    — the part carries a real price. Trust it.
--   allocated — 摊分: no part price, but the order has a total. Estimate.
--   none      — no money anywhere. Scores ¥0 and keeps its 未定价 badge.
-- ---------------------------------------------------------------------------
create or replace view part_sale_value as
  select
    p.id as part_id,
    p.job_id,
    coalesce(
      p.line_total_cny,
      p.unit_price_cny * p.qty,
      -- 摊分 — equal share of the order total, NOT weighted by qty (see above).
      nullif(j.amount_cny, 0) / nullif(pc.n, 0)
    ) as sale_cny,
    case
      when p.line_total_cny is not null or p.unit_price_cny is not null then 'quoted'
      when nullif(j.amount_cny, 0) is not null and pc.n > 0 then 'allocated'
      else 'none'
    end as value_source
  from parts p
  join jobs j on j.id = p.job_id
  join (select job_id, count(*) as n from parts group by job_id) pc on pc.job_id = p.job_id;

comment on view part_sale_value is
  'Per-part sale value for 报工 经手金额, with provenance: quoted (real 单价) / allocated (摊分 of 订单金额) / none. 0087.';

-- ---------------------------------------------------------------------------
-- worker_output(from, to, stage) — 报工 scoreboard, one row per worker.
-- Identical to 0086 except value_cny now folds in the 摊分 fallback, and
-- `unpriced` changes meaning: it counted "no per-part price", it now counts
-- "no money at all". That is deliberate — a 未定价 badge next to a non-zero ¥
-- would be a lie. Signature unchanged, so no drop/recreate.
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
-- Gains is_allocated so the export can stamp every row 报价 / 摊分 / 无单价.
-- Appended at the END of the select list: CREATE OR REPLACE VIEW can only add
-- columns there, and this way there is no window where the view is missing.
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
