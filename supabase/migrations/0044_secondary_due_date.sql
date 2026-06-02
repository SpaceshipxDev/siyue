-- 二次交期 — an optional second delivery date alongside the contract 交期
-- (jobs.due_date). Purely informational: it does NOT drive the master-grid
-- color stripe, urgency, or float-to-top sort — jobs.due_date still owns all
-- of that. Nullable with no default, so every existing job starts blank and
-- the floor fills it in by hand when a job picks up a second ship date.
alter table jobs add column if not exists secondary_due_date date;
