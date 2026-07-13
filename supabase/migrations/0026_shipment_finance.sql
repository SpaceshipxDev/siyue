-- 财务 / 应收账款 — invoicing (开票) + collection (回款) tracking.
--
-- One ledger row per 出货单 (shipments row), so the finance ledger is keyed
-- on shipment_id and the printed 派单号 (shipments.doc_no, YNMX-yy-m-d-NNN)
-- is the row's identity — exactly the granularity 王雪梅's hand-kept AR
-- spreadsheet uses (mixed-month running list, one line per delivery).
--
-- This is a 1:1 SIDE table rather than columns on `shipments`: shipments is
-- an immutable batch audit-log written by the 制作出货单 picker, whereas this
-- data is mutated by 商务/财务 long after the goods leave. Keeping it separate
-- means the shipment write path stays untouched and a delivery with no
-- finance activity yet simply has no row here (LEFT JOIN / map-miss = blank).
--
-- Amounts are nullable on purpose:
--   sale_amount_cny   — 金额. NULL ⇒ fall back to the auto value computed from
--                       the shipment's part unit prices (see lib/db getFinanceRows).
--                       A non-NULL value is finance's explicit override.
--   invoice_amount_cny / payment_amount_cny — 开票金额 / 回款金额. The
--                       outstanding 应收余额 is invoice − payment, derived in app.
--
-- contact (名称/对接人) lives here, not on customers: it varies per delivery
-- (the same 客户 ships to different 对接人 across orders), so it's a property
-- of the line, not the customer directory.

create table if not exists shipment_finance (
  shipment_id        text primary key references shipments(id) on delete cascade,
  sale_amount_cny    numeric,           -- 金额 (override; NULL ⇒ computed)
  contact            text,              -- 名称 / 对接人
  pending_flag       text,              -- 待确定 (manual highlight / follow-up note)
  invoice_no         text,              -- 发票号
  invoice_date       date,              -- 开票日期
  invoice_amount_cny numeric,           -- 开票金额
  payment_date       date,              -- 回款时间
  payment_amount_cny numeric,           -- 回款金额
  updated_at         timestamptz not null default now(),
  updated_by         text
);

-- AR aging chases unpaid invoices: "invoiced, not (fully) collected" is the
-- hot query. Partial index keeps it tiny — most historical rows are paid.
create index if not exists shipment_finance_open_idx
  on shipment_finance (invoice_date)
  where invoice_date is not null
    and (payment_amount_cny is null
         or (invoice_amount_cny is not null and payment_amount_cny < invoice_amount_cny));
