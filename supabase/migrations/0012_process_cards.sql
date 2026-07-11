-- 工艺卡 — Gemini-3.1-Pro-generated per-job process card.
-- One card per job, replaced on regenerate. Source files (PDFs/images that
-- fed the generation) are tracked here so the UI can show what produced
-- this card and the operator can re-upload to refresh.
create table if not exists process_cards (
  job_id        text primary key references jobs(id) on delete cascade,
  card          jsonb not null,
  source_files  jsonb not null default '[]'::jsonb,
  model         text  not null,
  generated_at  timestamptz not null default now(),
  generated_by  text
);

create index if not exists process_cards_generated_at_idx
  on process_cards (generated_at desc);
