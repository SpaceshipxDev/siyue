-- Job classification — replaces the row-level boss pin (jobs.pinned_at) as
-- the single global priority signal AND adds duration/category tagging in one
-- field. 加急 ('rush') is one of the four values and behaves identically to
-- the old pin: floats to the top of every list (master grid + every station
-- workbench). The other three are passive labels driving color only.
--
--   'short'   — 短期 (≤ 7 days to 交期)
--   'medium'  — 中期 (8–30 days)
--   'long'    — 长期 (> 30 days)
--   'rush'    — 加急 (manual flag, pins to top in every view)
--
-- We keep jobs.pinned_at + job_stage_pins around as dead columns — nothing
-- reads them after this release, but a clean drop happens in a later
-- migration once we've verified the rollout has stuck.
alter table jobs
  add column if not exists job_type text
    check (job_type in ('short','medium','long','rush'));

-- Backfill: anything currently row-pinned becomes 加急. Existing pinned_at
-- timestamp is preserved on the row (we still use it as the secondary sort
-- key within the rush bucket: most recently flagged on top).
update jobs
   set job_type = 'rush'
 where pinned_at is not null
   and job_type is null;

-- Backfill the remaining ~300 live jobs from due-date math so the new
-- color stripe lights up on day 1 across every existing row. Mirrors
-- inferJobTypeFromDueDate() in lib/data.ts. Only touches NULLs — never
-- overrides a 'rush' or any value set after deploy.
update jobs
   set job_type = case
     when (due_date::date - current_date) <= 7 then 'short'
     when (due_date::date - current_date) <= 30 then 'medium'
     else 'long'
   end
 where job_type is null
   and due_date is not null;

-- Hot index — the rush bucket is what every list sort touches first.
-- Sub-sort is by pinned_at desc when present (the 'I just flagged it'
-- recency), else by created_at desc.
create index if not exists jobs_job_type_rush_idx
  on jobs (pinned_at desc nulls last, created_at desc)
  where job_type = 'rush';

create index if not exists jobs_job_type_idx
  on jobs (job_type)
  where job_type is not null;
