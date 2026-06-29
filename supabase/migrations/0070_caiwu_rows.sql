-- 财务 (caiwu) — the finance clerk's two working spreadsheets, rebuilt as
-- editable grids with the 重点 (daily_focus) Excel-cell model. She kept these
-- in raw Excel; the platform just removes the retyping — it does NOT change
-- how she thinks. Nothing is computed: 剩余 / 分期 etc. live inside her
-- free-text log exactly as in Excel.
--
--   未开票 (weikaipiao) — orders delivered/ordered but not yet (fully) invoiced.
--                         Her "未开票金额 / 开票情况" sheet (海康 type).
--   已开票 (kaipiao)    — invoices issued, now chasing 收款.
--                         Her "发票号码 / 收款记录" sheet (思看 type).
--
-- Same thesis as 0046_daily_focus: store ONLY what a human typed. The job link
-- (job_id) carries 工号 / 客户名称 / 联系人 live from the master read; NULL on an
-- override column ⇒ show the job's value, non-null ⇒ this text verbatim.
-- Editing a cell NEVER writes back to the job. One table, a `sheet`
-- discriminator, union of both sheets' columns (all nullable) — the column
-- overlap (job, customer, an amount, a running log) is real, so two tables
-- would just be duplicated CRUD.
create table if not exists caiwu_rows (
  id             text primary key,
  sheet          text not null,              -- 'weikaipiao' | 'kaipiao'
  position       numeric not null default 0, -- order within a sheet (fractional)
  -- Linked job. Nullable: she bundles several 工号 into one 对账 row, or keeps
  -- rows for orders with no 工号 yet — adding must never block.
  job_id         text,
  job_no_text    text not null default '',   -- 单号 / 内部流水号 as typed

  -- Live-join + override (NULL ⇒ show the job's value; non-null ⇒ verbatim).
  customer_text  text,                        -- 客户名称 (override job.customer)
  contact_text   text,                        -- 联系人  (override job.engineer)

  -- Pure human cells — never computed, never joined.
  date_text        text,   -- 日期 / 开票日期  ("4月15日")
  order_no_text    text,   -- 订单号/物料号
  qty_text         text,   -- 下单数量
  billable_text    text,   -- 是否收费 ('是')
  amount_text      text,   -- 未开票金额 / 订单金额
  tax_text         text,   -- 税金金额
  amount_incl_text text,   -- 含税金额
  invoice_no_text  text,   -- 发票号码
  log_text         text,   -- 开票情况 / 收款记录  (the running money log)

  created_by  text,
  created_at  timestamptz not null default now()
);

-- The page reads exactly one sheet at a time, in position order.
create index if not exists caiwu_rows_sheet_idx on caiwu_rows (sheet, position);
