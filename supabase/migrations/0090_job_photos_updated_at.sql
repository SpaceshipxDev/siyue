-- 0090 — job_photos gain updated_at so a rotated (re-encoded) photo busts the
-- immutable /api/img cache.
--
-- Rotation overwrites the SAME storage_key with new bytes. The proxy serves
-- every stable key with `Cache-Control: immutable`, so unless the ?v= version
-- changes, browsers and the edge keep the old orientation forever. We feed
-- updated_at into proxiedKeyUrl's ?v= and bump it on every rotate.

alter table job_photos
  add column if not exists updated_at timestamptz not null default now();
