-- Two features the boss asked for, sharing one design thesis (passive
-- broadcast — no messaging; information lives as calm visible state).
--
-- 1) 外协 flag (待外协). The engineer's UPSTREAM "this needs outsourcing"
--    intent, recorded the moment 工程 looks at the drawing — BEFORE the
--    operational outsource_blocks vendor record (vendor / price / dates)
--    exists. It's the missing first stage of the outsourcing lifecycle:
--      待外协 (工程 flags) → 外协中 (商务 makes the block) → 已回 (vendor returns)
--    商务 reads needs_outsource as a pending-action signal on the master
--    grid. The flag is CLEARED in lib/db.ts#createOutsourceBlockAt the moment
--    the first block is created for the job (商务 acted → it's now 外协中),
--    so needs_outsource and an open block never coexist.
alter table jobs
  add column if not exists needs_outsource boolean not null default false;
alter table jobs
  add column if not exists outsource_note text;
alter table jobs
  add column if not exists outsource_flagged_by text;
alter table jobs
  add column if not exists outsource_flagged_at timestamptz;

-- Partial index: the 商务 "待外协" filter only ever scans the flagged rows.
create index if not exists jobs_needs_outsource_idx
  on jobs (needs_outsource)
  where needs_outsource = true;

-- 2) 工作交接单 — shift / absence handover sheets. When someone stops working
--    for a day (break, leave, day off) and a factory has a lot of open jobs,
--    they record what's pending so whoever covers has the context. A unified
--    tab (/handover) shows them all. Standalone from outsourcing on purpose —
--    different scope (a person's absence, not an order), different lifetime
--    (one shift, not weeks), different reader. Mirrors the paper 工作交接单:
--    a header (交出人 / 部门 / 日期 / 交出原因 / 承接人) plus N line items
--    (单号 / 相关事宜 / 责任人 / 备注). Text PKs match the rest of the schema
--    so lib/db.ts keeps its uid()-generated id convention.
create table if not exists handovers (
  id            text primary key,
  giver         text not null,          -- 交出人
  department    text,                    -- 部门
  handover_date date not null,           -- 日期
  reason        text,                    -- 交出原因
  receiver      text,                    -- 承接人
  created_by    text,
  created_at    timestamptz not null default now()
);

create index if not exists handovers_date_idx on handovers (handover_date desc);
create index if not exists handovers_created_at_idx on handovers (created_at desc);

create table if not exists handover_items (
  id          text primary key,
  handover_id text not null references handovers(id) on delete cascade,
  position    integer not null default 0,
  order_no    text,                      -- 单号 (free text; may match a job_no)
  -- Optional resolved link when 单号 matches a real job. ON DELETE SET NULL so
  -- archiving a job never deletes the handover history that referenced it.
  job_id      text references jobs(id) on delete set null,
  matter      text,                      -- 相关事宜
  owner       text,                      -- 责任人
  note        text                       -- 备注
);

create index if not exists handover_items_handover_id_idx
  on handover_items (handover_id);
