-- 重点 (daily focus) — the platform version of the hand-kept "today's
-- important jobs" Excel (columns: 单号 交期 外协 反馈). One list per day,
-- curated by a human.
--
-- Deliberately minimal: of the Excel's four columns, 交期 and 外协 are
-- ALREADY live MES data, and 单号 names a job that already exists — so the
-- table stores only the two genuinely human facts: which jobs made the
-- day's list, and the 反馈 note. Due date / outsource status are joined
-- live at read time and can never go stale the way the hand-copied Excel
-- cells did. Same design thesis as 交接 / 采购: passive visible state, no
-- messaging.
create table if not exists daily_focus_items (
  id          text primary key,
  day         date not null,             -- which day's list this row is on
  -- Linked job. Nullable: the Excel had rows for things not in the MES too
  -- (e.g. an inbound order with no 工号 yet) — adding must never block.
  job_id      text,
  -- 单号 as typed. Survives job deletion / renumbering, and IS the display
  -- text for unlinked rows.
  job_no_text text not null,
  feedback    text,                       -- 反馈 — the human note, the point
  position    numeric not null default 0, -- order within the day (append-grow)
  created_by  text,
  created_at  timestamptz not null default now()
);

-- The page reads exactly one day at a time.
create index if not exists daily_focus_items_day_idx
  on daily_focus_items (day);
