-- 0083 — the photo-traveller loop.
--
-- packets / packet_pages: the programmer photographs every page of a printed
-- order packet (2D drawing + CNC程序单 pages). Those photos ARE the matching
-- references — the worker later photographs the same physical sheet, and the
-- matcher service resolves it back to the part. Pages live in the `uploads`
-- bucket; these rows are the index.
--
-- report_events: append-only 报工 history. part_stages only keeps the LATEST
-- state per (part, stage) — "first guy did 50, second guy finished 30" is
-- exactly the history the PMC and the workers' daily tallies need, so every
-- shop-floor report also writes one immutable event row here.

alter table parts add column if not exists drawing_no text;
create index if not exists parts_drawing_no_idx on parts (drawing_no);

create table if not exists packets (
  id text primary key,
  part_id text not null references parts(id) on delete cascade,
  created_by text,
  op_count integer,
  extract jsonb,
  created_at timestamptz not null default now()
);
create index if not exists packets_part_idx on packets (part_id);

create table if not exists packet_pages (
  id text primary key,
  packet_id text not null references packets(id) on delete cascade,
  part_id text not null references parts(id) on delete cascade,
  idx integer not null,
  kind text,
  op_no integer,
  storage_key text not null,
  -- false until the matcher service has confirmed this page is in its
  -- embedding bank; a retry sweep re-registers any stragglers.
  registered boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists packet_pages_part_idx on packet_pages (part_id);
create index if not exists packet_pages_unregistered_idx
  on packet_pages (registered) where registered = false;

create table if not exists report_events (
  id bigint generated always as identity primary key,
  part_id text not null references parts(id) on delete cascade,
  job_id text not null,
  stage text not null,
  actor text not null,
  qty integer not null,
  cumulative integer not null,
  source text not null default 'scan',
  created_at timestamptz not null default now()
);
create index if not exists report_events_part_idx on report_events (part_id, created_at desc);
create index if not exists report_events_actor_idx on report_events (actor, created_at desc);
create index if not exists report_events_created_idx on report_events (created_at desc);
