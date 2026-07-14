-- 0089 — authoritative LYNUC runtime macros.
--
-- These values come from verified, read-only controller mappings. They are
-- kept separate from CAM estimates and FTP-derived program activity.

alter table machine_snapshots
  add column if not exists total_completed_parts integer,
  add column if not exists current_cycle_seconds numeric,
  add column if not exists current_cutting_seconds numeric,
  add column if not exists controller_boot_cycle_seconds numeric,
  add column if not exists cutting_today_seconds integer not null default 0
    check (cutting_today_seconds >= 0),
  add column if not exists telemetry_source text not null default 'unavailable'
    check (telemetry_source in ('controller_macro', 'controller_macro_auto', 'unavailable')),
  add column if not exists runtime_observed_at timestamptz,
  add column if not exists runtime_latency_ms integer,
  add column if not exists runtime_error text,
  add column if not exists discovery_status text not null default 'not_started',
  add column if not exists discovery_confidence integer not null default 0
    check (discovery_confidence between 0 and 100),
  add column if not exists discovered_services jsonb not null default '[]'::jsonb;

alter table machine_snapshots
  drop constraint if exists machine_snapshots_work_signal_check;

alter table machine_snapshots
  add constraint machine_snapshots_work_signal_check
  check (work_signal in ('controller_cycle', 'controller_cutting_timer', 'program_activity', 'unavailable'));
