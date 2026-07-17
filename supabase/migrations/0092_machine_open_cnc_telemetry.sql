-- 0092 — multi-controller discovery, MTConnect, and read-only NC source capture.

alter table machine_snapshots
  add column if not exists manufacturer text,
  add column if not exists model text,
  add column if not exists driver text not null default 'inventory',
  add column if not exists capabilities jsonb not null default '{}'::jsonb,
  add column if not exists discovery_notes jsonb not null default '[]'::jsonb,
  add column if not exists program_source text,
  add column if not exists program_source_truncated boolean not null default false,
  add column if not exists program_source_sha256 text,
  add column if not exists program_source_captured_at timestamptz;

alter table machine_snapshots
  drop constraint if exists machine_snapshots_telemetry_source_check;

alter table machine_snapshots
  add constraint machine_snapshots_telemetry_source_check
  check (telemetry_source in ('controller_macro', 'controller_macro_auto', 'mtconnect', 'unavailable'));

alter table machine_snapshots
  drop constraint if exists machine_snapshots_work_signal_check;

alter table machine_snapshots
  add constraint machine_snapshots_work_signal_check
  check (work_signal in ('controller_cycle', 'controller_cutting_timer', 'mtconnect_execution', 'program_activity', 'unavailable'));
