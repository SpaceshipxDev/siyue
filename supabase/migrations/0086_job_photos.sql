-- 0086 — photos that can be added to an existing job at any time.
--
-- Packet pages remain the immutable intake record. job_photos are the
-- append-later reference set: an editor can create a job with no upload,
-- find it from a phone, and add one or more photos that the matcher enrolls.

create table if not exists job_photos (
  id text primary key,
  job_id text not null references jobs(id) on delete cascade,
  part_id text not null references parts(id) on delete cascade,
  storage_key text not null unique,
  uploaded_by text,
  registered boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists job_photos_job_idx
  on job_photos (job_id, created_at);
create index if not exists job_photos_part_idx
  on job_photos (part_id, created_at);
create index if not exists job_photos_unregistered_idx
  on job_photos (registered) where registered = false;
