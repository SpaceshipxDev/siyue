-- Row-level boss pin for the master grid. Independent from job_stage_pins
-- (which is per-station and tells a floor head "do this today"). This pin
-- is the boss's OWN priority sort on the holistic grid — a single per-job
-- mark that floats the row to the top of 商务/工程's view, shared between
-- those two roles. Persistent until unpinned.
--
-- pinned_at also acts as the secondary sort key within the pinned bucket,
-- so the most recently starred row floats above older pins — matches the
-- "I just clicked it, where did it go?" instinct.
alter table jobs
  add column if not exists pinned_at  timestamptz,
  add column if not exists pinned_by  text;

create index if not exists jobs_pinned_at_idx
  on jobs (pinned_at)
  where pinned_at is not null;
