-- Add the 检验 (inspection) stage between 操机 and 手工.
--
-- The factory's quality gap: parts finish 操机 and flow straight to 手工 with
-- no inspection gate. 检验 adds that gate. At the station the inspector marks
-- each part 重做 / 返修 / 外修 (blocking — part stays at 检验 with a red tag)
-- or OK (finishes the stage; part flows to 手工). Verdicts live on the
-- part_stages row itself; inspection photos get their own table (part_photos)
-- so they never clobber parts.image_url, which prints on 外协单 / 出货单.
--
-- New canonical stage order (lib/data.ts STAGES):
--   工程 编程 操机 检验 手工 打磨 喷漆 丝印 质量 出货
--
-- Backfill decision (confirmed with the shop): every existing part gets a
-- 检验 row so in-flight work starts flowing through the gate immediately.
--   done    — the part has effectively already passed 操机: any stage at or
--             after 操机 (excluding 检验 itself) has a non-pending row. These
--             are auto-checked with no actor, same spirit as 0040's
--             "clicked-in by default" back-fill.
--   pending — everything else (parts still sitting in 工程 / 编程).
-- This keeps legacy mid-production parts from suddenly reading as blocked at
-- a stage that didn't exist when they passed machining.
--
-- Pure insertion: outsource_blocks.stages needs no token rewrite (unlike the
-- 0020 merge / 0040 split), and users.default_stage has nobody to remap —
-- inspectors get assigned via the admin picker, which lists 检验 automatically.

begin;

-- 1. part_stages — back-fill a 检验 row for every part that lacks one.
--    Re-runnable via the NOT EXISTS guard.

with verdicted as (
  select
    p.id as part_id,
    exists (
      select 1 from part_stages s
      where s.part_id = p.id
        and s.stage in ('操机', '手工', '打磨', '喷漆', '丝印', '质量', '出货')
        and s.status <> 'pending'
    ) as past_machining
  from parts p
)
insert into part_stages (id, part_id, stage, status, completed_at)
select
  v.part_id || ':检验',  -- app id convention: `${partId}:${stage}` (setPartRoute / fillParsedJob)
  v.part_id,
  '检验',
  case when v.past_machining then 'done' else 'pending' end,
  case when v.past_machining then to_char(now(), 'MM-DD') else null end
from verdicted v
where not exists (
  select 1 from part_stages ps where ps.part_id = v.part_id and ps.stage = '检验'
);

-- 2. Verdict columns. Only the 检验 row ever sets them, but part_stages is
--    the natural home — the verdict IS the stage's state, not a parallel
--    entity. Text holds the literal Chinese verdict ('重做'|'返修'|'外修'|'OK').

alter table part_stages add column if not exists verdict text;
alter table part_stages add column if not exists verdict_at timestamptz;
alter table part_stages add column if not exists verdict_by text;

-- 3. part_photos — inspection photo gallery, N photos per part. Append-only
--    in practice (UI offers delete); cascade with the part.

create table if not exists part_photos (
  id          text primary key,
  part_id     text not null references parts(id) on delete cascade,
  url         text not null,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists part_photos_part_id_idx on part_photos(part_id);

-- 4. Re-create the stage-ordered views (job_stage_rollup, station_wip) with
--    the new 10-stage order. Only the stage_order CTE changes — bodies are
--    byte-identical to 0040. CREATE OR REPLACE keeps the column order.

create or replace view job_stage_rollup as
with stage_order(stage, ord) as (
  values
    ('工程'::text, 1),
    ('编程',       2),
    ('操机',       3),
    ('检验',       4),
    ('手工',       5),
    ('打磨',       6),
    ('喷漆',       7),
    ('丝印',       8),
    ('质量',       9),
    ('出货',      10)
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
    ('编程',       2),
    ('操机',       3),
    ('检验',       4),
    ('手工',       5),
    ('打磨',       6),
    ('喷漆',       7),
    ('丝印',       8),
    ('质量',       9),
    ('出货',      10)
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

commit;

-- Reload the PostgREST schema cache so the updated views + new table are
-- exposed immediately (same playbook as 0019 / 0020 / 0028 / 0040).
notify pgrst, 'reload schema';
