-- 零件图纸变更 — drawing changes come DOWN to the part (零件), with a revision
-- history (一次 / 二次 / 三次 …), not a single job-level free-text alarm. Each
-- row is ONE revision: what changed, who/when, an optional new drawing, and a
-- clear stamp once the floor has the new sheet. The job-level alarm (0049)
-- stays as the page headline + board badge; per-part changes flip it on/off.
-- Additive only — nothing existing is touched, safe on the live DB.
create table if not exists part_drawing_changes (
  id          text primary key,
  part_id     text not null references parts(id) on delete cascade,
  revision    integer not null,          -- 1 = 一次, 2 = 二次, 3 = 三次 …
  note        text,                       -- what changed (孔位 / 厚度 / …)
  image_url   text,                       -- optional: the new drawing
  raised_by   text,
  raised_at   timestamptz not null default now(),
  cleared_at  timestamptz,                -- null = still open (floor not caught up)
  cleared_by  text,
  unique (part_id, revision)
);

create index if not exists part_drawing_changes_part_idx
  on part_drawing_changes (part_id);

-- Open (uncleared) changes only — the floor's "this part's drawing moved" flag.
create index if not exists part_drawing_changes_open_idx
  on part_drawing_changes (part_id)
  where cleared_at is null;
