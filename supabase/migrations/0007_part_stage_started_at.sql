-- Per-stage start/finish timestamps. completed_at stays MM-DD for the
-- existing checkmark-date display; the new timestamps power the live
-- station-floor timer ("在做 5h 20m") and the avg-flow-time stat.
--
-- We never clear them on undo/finish — they remain as audit traces and the
-- status field gates display. assignToStage resets started_at because the
-- clock truly does restart on re-routing.
alter table part_stages
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz;
