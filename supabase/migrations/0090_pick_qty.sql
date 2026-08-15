-- 领用数量 — how many the 领料人 actually walked off with when the 待领料 row
-- closed. Nullable: every done row born before this migration has no count.
alter table public.procurements
  add column if not exists pick_qty numeric;
