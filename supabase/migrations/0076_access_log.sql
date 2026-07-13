-- 0076 — access_log: who opened which board view, when.
--
-- One row per real render of the master board — bare `/` (dashboard) and
-- `/?stage=…` (per-station view) both land here, distinguished by `stage`
-- (null = dashboard). Prefetch requests are filtered out at the app layer.
--
-- Exists because the station tabs were removed on inference (557d69c) and
-- rolled back on worker complaint — next time the tab row is debated, the
-- answer comes from this table, not vibes:
--
--   select stage, count(*) from access_log
--   where at > now() - interval '30 days' group by 1 order by 2 desc;

create table if not exists public.access_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_name text not null,
  role text not null,
  default_stage text,
  path text not null,
  stage text
);

create index if not exists access_log_at_idx on public.access_log (at);
create index if not exists access_log_user_idx on public.access_log (user_name, at);

-- Service-role-only access (same posture as the rest of the schema): RLS on,
-- no policies — anon/authed clients can't read or write it.
alter table public.access_log enable row level security;
