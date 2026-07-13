-- 0084 — worker roster + the no-match valve.
--
-- workers: the floor roster. A worker picks their name once from a grid on
-- first 报工 (no account, no PIN); free-text stays possible for a new hire,
-- which lazily adds the row. Gives the boss clean per-worker tallies with
-- no typo-split identities (王师傅 vs 王师父).
--
-- pending_reports: a worker's photo that matched nothing must never be a
-- dead end. The photo + claimed stage + qty land here, and the PMC attaches
-- them to the right part from her desk (待归档 queue) instead of the worker
-- walking to find 编程. Append-only until resolved.

create table if not exists workers (
  name text primary key,
  created_at timestamptz not null default now()
);

create table if not exists pending_reports (
  id text primary key,
  photo_key text not null,
  claimed_stage text,
  qty integer,
  actor text,
  status text not null default 'pending', -- pending | attached | dismissed
  part_id text references parts(id) on delete set null,
  applied_stage text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);
create index if not exists pending_reports_status_idx on pending_reports (status, created_at desc);
