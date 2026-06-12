-- 联系人 — the customer-side contact for ONE order.
--
-- Order-level rather than on the customers directory: the same 客户 ships to
-- different 对接人 across orders (same reasoning as shipment_finance.contact,
-- migration 0026). AI-extracted on import when the workbook carries a
-- 联系人/对接人 field; editable in the job header. Shown as the third line of
-- the commerce dashboard's 客户 cell and searchable (see 0056).

alter table jobs
  add column if not exists contact text;
