-- 0074: /x — the paste-first production sheet ("genius excel").
--
-- A deliberately tiny, flexible schema: the sheet's column set lives as jsonb
-- ON the sheet row (factories paste arbitrary WPS columns — we keep whatever
-- they had), each part row stores its cell values as {colId: text} jsonb, and
-- stage taps (报工) land in stage_done as {stageName: {at, by}}. No joins into
-- jobs/parts — /x is a standalone primitive; if it earns PMF we bridge later.
--
-- Access is service-role only (same as the whole app): RLS intentionally not
-- enabled, anon key is never shipped to clients.

create table if not exists public.x_sheets (
  id uuid primary key default gen_random_uuid(),
  name text not null default '生产表',
  stages jsonb not null default '["编程","操机","手工","表面","质检","出货"]',
  columns jsonb not null default '[]',
  -- Monotone change counter. Every mutation batch bumps it; clients poll
  -- GET /api/x?v=<n> and only re-download state when the number moved.
  version bigint not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists public.x_groups (
  id uuid primary key,
  sheet_id uuid not null references public.x_sheets(id) on delete cascade,
  title text not null default '',      -- 客户 / whatever the boss calls the 单
  order_no text not null default '',
  due text not null default '',        -- free text; client renders date-likes
  pos double precision not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.x_rows (
  id uuid primary key,
  sheet_id uuid not null references public.x_sheets(id) on delete cascade,
  group_id uuid not null references public.x_groups(id) on delete cascade,
  cells jsonb not null default '{}',       -- {colId: value}; img col holds a /api/img URL
  stage_done jsonb not null default '{}',  -- {stage: {at:'YYYY-MM-DD', by:'name'}}
  flag boolean not null default false,     -- 重点
  pos double precision not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists x_groups_sheet_idx on public.x_groups (sheet_id, pos);
create index if not exists x_rows_sheet_idx on public.x_rows (sheet_id);
create index if not exists x_rows_group_idx on public.x_rows (group_id, pos);

-- Atomic change-counter bump. Two phones tapping in the same second must not
-- lose an increment (read-modify-write would), or pollers stop seeing news.
create or replace function public.x_bump_version(p_sheet uuid)
returns bigint
language sql
as $$
  update public.x_sheets set version = version + 1 where id = p_sheet returning version;
$$;
