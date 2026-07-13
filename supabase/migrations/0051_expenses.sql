-- 财务 / 支出台账 (cash-out ledger) — the expense side of 财务.
--
-- The boss's annotation on the 财务 page listed exactly what he wants tracked:
-- 工资（人员名单）、房租、水电、耗材、税费、原材料、日常开支（员工报销）.
-- One row = one cash event. Deliberately flat — no child tables, no recurrence
-- engine, no employee directory:
--   工资   — N rows per payday, payee = person's name. The 人员名单 the boss
--            asked for is DERIVED (distinct payee where category='payroll')
--            and re-entry is one click via 复制上月工资 in the UI.
--   房租等 — same trick: 复制上月 prefills, a human confirms every cash event.
--
-- category is app-validated (lib/expenses.ts), no CHECK constraint — adding a
-- category must never need a migration. Values:
--   payroll | rent | utilities | consumables | tax | materials | daily | other
--
-- 外协 and 采购 money deliberately do NOT mirror into this table — they have
-- their own systems of record (outsource_blocks.amount_cny keyed by closure,
-- procurements keyed by order_date) and the 月度 cashflow tab joins them at
-- read time. Mirroring would double-count and drift.

create table if not exists expenses (
  id           text primary key,            -- uid('exp')
  expense_date date not null,               -- 日期 — when the money left
  category     text not null,
  amount_cny   numeric not null,
  payee        text,                        -- 对象 — 工资/报销 = 人名; 房租/水电 = 收款方
  note         text,                        -- 备注
  created_by   text,
  created_at   timestamptz not null default now()
);

create index if not exists expenses_date_idx     on expenses (expense_date desc);
create index if not exists expenses_category_idx on expenses (category);

-- 财务可见性 — payroll amounts are sensitive. The 支出/月度 tabs are gated to
-- the boss + designated finance users; ordinary 商务 keep seeing 应收 only.
-- The 老板 bootstrap row is granted in code regardless (lib/auth canSeeExpenses)
-- so the boss is never locked out of his own books on a half-applied DB.
alter table users
  add column if not exists is_finance boolean not null default false;

update users set is_finance = true where id = 'u-bootstrap-commerce';
