-- 暂停 — a job deliberately blocked / on hold. Like 产品 (migration 0023) it is
-- an INDEPENDENT flag, not a job_type value: a job can be 加急 AND 暂停 at once,
-- so pausing must never disturb the mutually-exclusive 短期/中期/长期/加急 bucket.
--
-- Why a column at all: the 在产 / 已出货 split is auto-DERIVED from shipping
-- progress, so the system always knows it. "Paused" is the opposite — a human
-- gesture ("stop working on this, here's why") that nothing in the data records
-- today, which is exactly why a blocked job is currently indistinguishable from
-- a flowing one (both just count as 在产). This column captures that gesture so
-- 暂停 can be carved out of 在产 into its own third column.
--
-- paused_at doubles as the flag (NULL = actively flowing) AND the "blocked since"
-- timestamp for how-long-stuck display. pause_reason is the optional free-text
-- why; paused_by stamps who paused it.
alter table jobs
  add column if not exists paused_at timestamptz,
  add column if not exists pause_reason text,
  add column if not exists paused_by text;

create index if not exists jobs_paused_idx
  on jobs (paused_at)
  where paused_at is not null;
