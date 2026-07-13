-- 0088 — read-only CNC edge telemetry.
--
-- The Windows watcher is the only writer. Browser clients never touch these
-- tables directly: authenticated pages read through /api/machines and the
-- watcher writes through /api/machines/ingest with a dedicated bearer token.

create table if not exists machine_snapshots (
  machine_id text primary key,
  machine_name text not null,
  ip_address text not null,
  connected boolean not null default false,
  state text not null default 'unknown'
    check (state in ('programming', 'ready', 'idle', 'offline', 'error', 'unknown')),
  observed_at timestamptz not null,
  last_seen_at timestamptz,
  job_started_at timestamptz,
  current_program text,
  program_fingerprint text,
  program_modified_at timestamptz,
  program_size_bytes bigint,
  program_count integer not null default 0,
  main_program_count integer not null default 0,
  program_number text,
  source_part text,
  source_part_path text,
  controller text,
  cam_programmed_at timestamptz,
  estimated_duration_seconds integer,
  operation_count integer,
  current_operation integer,
  operations jsonb not null default '[]'::jsonb,
  tool_numbers jsonb not null default '[]'::jsonb,
  spindle_rpm integer,
  feed_mm_min numeric,
  completed_parts integer,
  target_parts integer,
  execution_state text not null default 'unknown'
    check (execution_state in ('running', 'paused', 'stopped', 'unknown')),
  work_signal text not null default 'unavailable'
    check (work_signal in ('controller_cycle', 'program_activity', 'unavailable')),
  work_day date not null,
  worked_today_seconds integer not null default 0 check (worked_today_seconds >= 0),
  online_today_seconds integer not null default 0 check (online_today_seconds >= 0),
  current_cycle_started_at timestamptz,
  ftp_latency_ms integer,
  recent_programs jsonb not null default '[]'::jsonb,
  collector_id text not null,
  collector_version text not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists machine_snapshots_observed_idx
  on machine_snapshots (observed_at desc);

create table if not exists machine_events (
  id text primary key,
  machine_id text not null references machine_snapshots(machine_id) on delete cascade,
  event_type text not null
    check (event_type in ('first_seen', 'program_changed', 'state_changed', 'connected', 'disconnected')),
  observed_at timestamptz not null,
  state text not null,
  program_name text,
  source_part text,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists machine_events_machine_time_idx
  on machine_events (machine_id, observed_at desc);
create index if not exists machine_events_time_idx
  on machine_events (observed_at desc);

alter table machine_snapshots enable row level security;
alter table machine_events enable row level security;

revoke all on table machine_snapshots from anon, authenticated;
revoke all on table machine_events from anon, authenticated;
grant all on table machine_snapshots to service_role;
grant all on table machine_events to service_role;
