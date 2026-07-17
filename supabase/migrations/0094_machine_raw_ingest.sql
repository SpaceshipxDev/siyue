-- 0094 — lossless edge relay for server-side synthesis.
--
-- Each collector cycle is retained as one idempotent JSON document. The
-- Windows edge process can stay stable while server-side models and products
-- are rebuilt from the original controller readings later.

create table if not exists machine_ingest_batches (
  id text primary key,
  collector_id text not null,
  collector_version text not null,
  observed_at timestamptz not null,
  raw_payload jsonb not null,
  received_at timestamptz not null default now()
);

create index if not exists machine_ingest_batches_observed_idx
  on machine_ingest_batches (observed_at desc);
create index if not exists machine_ingest_batches_collector_idx
  on machine_ingest_batches (collector_id, observed_at desc);

alter table machine_ingest_batches enable row level security;
revoke all on table machine_ingest_batches from anon, authenticated;
grant all on table machine_ingest_batches to service_role;

alter table machine_snapshots
  add column if not exists raw_telemetry jsonb not null default '{}'::jsonb;

alter table machine_snapshots
  drop constraint if exists machine_snapshots_telemetry_source_check;

alter table machine_snapshots
  add constraint machine_snapshots_telemetry_source_check
  check (telemetry_source in (
    'controller_macro',
    'controller_macro_auto',
    'mtconnect',
    'focas',
    'ezsocket',
    'unavailable'
  ));
