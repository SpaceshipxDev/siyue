-- 报功, round 3 — the boss wants the drill-down to read like the Excel sheet:
-- each completed component as a real row with its photo + specs, not a terse
-- text line. worker_stage_events already joins parts; this widens it with the
-- columns the components table shows (料号 / 材料 / 表面处理 / 图).
--
-- Read-only. CREATE OR REPLACE only (no DROP), and the new columns are appended
-- at the tail of each UNION branch's select list so the view's column set only
-- grows — Postgres allows that, and worker_output (which reads named columns
-- off this view) is unaffected.

create or replace view worker_stage_events as
with ev as (
  -- 完成 events.
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

  union all

  -- 开始 events.
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
