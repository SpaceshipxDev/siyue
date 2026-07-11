-- Persist a public URL to the original Excel that 商务 dropped in. We
-- already keep the filename in jobs.source_file for display; this column
-- holds the storage URL so commerce can re-download the source long after
-- the import flow finishes, or replace it with a corrected version.
alter table jobs
  add column if not exists source_file_url text;
