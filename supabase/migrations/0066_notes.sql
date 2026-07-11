-- 笔记 — the boss's freeform scratchpad (Apple-Notes style): random thoughts,
-- reminders, anything. Per-author; each commerce user sees only their own.
-- Additive only — no existing table touched, safe to apply on the live DB.
create table if not exists notes (
  id          text primary key,
  author_id   text not null,
  body        text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The board lists a user's notes newest-edited first.
create index if not exists notes_author_updated_idx
  on notes (author_id, updated_at desc);
