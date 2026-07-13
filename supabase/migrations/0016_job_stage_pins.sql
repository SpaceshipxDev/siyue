-- Boss/management pinning. The boss runs the daily 排产 ritual by walking
-- the per-station workbench and starring the jobs he wants pushed to the
-- top at that station today. Pin lives per (job_id, stage) — a job can be
-- pinned at multiple stations independently (pin at 编程 today, also pin
-- at 操机 tomorrow when it lands there). Persistent until unstarred; no
-- daily auto-reset for now (the boss controls the lifecycle).
--
-- pinned_at is the insertion timestamp — secondary sort within the pinned
-- bucket so the most recently starred row is the freshest call to action.
-- pinned_by is best-effort, written as the actor's display name (parallel
-- to part_stages.by_actor). Nullable in case a future automated path
-- writes pins without a user context.
create table if not exists job_stage_pins (
  job_id     text        not null references jobs(id) on delete cascade,
  stage      text        not null,
  pinned_at  timestamptz not null default now(),
  pinned_by  text,
  primary key (job_id, stage)
);

create index if not exists job_stage_pins_stage_idx on job_stage_pins (stage);
