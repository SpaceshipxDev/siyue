-- 0089: 采购 approval flow — the tab becomes a four-step conveyor:
--   requested (待审批) → approved (待下单) → ordered (在途) → arrived (待领料)
--   → done (已领料, the month ledger) · rejected (驳回, dim in the ledger)
--
-- Legacy mapping:
--   'pending' (待下单)  → 'approved'  — the old want-list was by definition approved.
--   'arrived' (已到货)  → 'done'      — the old terminal state IS the ledger;
--                                       counted as picked the day it arrived, by its buyer,
--                                       so the 已到货 month ledger + 导出 carry over unchanged.
--
-- Applied in two phases (columns are additive and safe under the old build;
-- the status remap runs seconds before the pm2 restart so the old build never
-- renders the new states as 采购中):

-- phase 1 — columns + requester backfill
alter table public.procurements
  add column if not exists requester text,
  add column if not exists req_date date,
  add column if not exists picker text,
  add column if not exists approver text,
  add column if not exists approve_date date,
  add column if not exists rejected_by text,
  add column if not exists reject_date date,
  add column if not exists reject_note text,
  add column if not exists pick_date date;

-- Every legacy row was created directly by its buyer (self-serve, no approval).
update public.procurements
  set requester = coalesce(requester, buyer),
      req_date  = coalesce(req_date, order_date);

-- phase 2 — status remap, at deploy switchover
update public.procurements set status = 'approved' where status = 'pending';
update public.procurements
  set status    = 'done',
      pick_date = coalesce(pick_date, arrived_date, order_date),
      picker    = coalesce(picker, buyer)
  where status = 'arrived';
