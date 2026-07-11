-- 图纸变更报警 — the customer revised drawings mid-production. The system's
-- one true ALARM: an event with a lifecycle (商务/工程 raises it with a note →
-- it headlines the job everywhere → 工程/商务 clears it once new drawings are
-- confirmed distributed). Inform-only by design: stations keep working —
-- unaffected parts shouldn't freeze. Single live alarm per job, no history;
-- clearing wipes the fields. Same shape as the needs_outsource flag (0041).
alter table jobs
  add column if not exists drawing_change_open boolean not null default false;
alter table jobs
  add column if not exists drawing_change_note text;
alter table jobs
  add column if not exists drawing_change_by text;
alter table jobs
  add column if not exists drawing_change_at timestamptz;

-- Partial index: the master-board 图纸变更 facet only ever scans live alarms.
create index if not exists jobs_drawing_change_open_idx
  on jobs (drawing_change_open)
  where drawing_change_open = true;
