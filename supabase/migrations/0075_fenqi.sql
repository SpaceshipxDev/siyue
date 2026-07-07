-- 0075 — 分期账 (installment ledger).
--
-- The finance clerk's real primitive, lifted from her Excel: money hangs off
-- the 订单号 (PO line), not the job. A job carries 1..n PO lines; each line
-- accumulates append-only 开票 / 收款 events. NO balance is ever stored —
-- 待开票 = amount − Σinvoice, 未收 = Σinvoice − Σpayment, both derived at
-- read time (lib/fenqi.ts). Corrections are 红冲: a reversal row pointing at
-- the event it voids; both stay in the book forever.
--
-- jobs.billable mirrors her 是否收费 column: NULL/true = 收费, false = 免收
-- (补件/样品) — the row grays out of every total.

create table if not exists public.po_lines (
  id text primary key,
  job_id text not null references public.jobs(id) on delete cascade,
  po_no text not null default '',
  material_no text,
  amount_cny numeric not null default 0,
  position integer not null default 0,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists po_lines_job_idx on public.po_lines(job_id);
alter table public.po_lines enable row level security;

create table if not exists public.money_events (
  id text primary key,
  po_line_id text not null references public.po_lines(id) on delete cascade,
  kind text not null check (kind in ('invoice', 'payment')),
  amount_cny numeric not null,
  event_date date not null,
  invoice_no text,
  note text,
  reversal_of text references public.money_events(id),
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists money_events_line_idx on public.money_events(po_line_id);
alter table public.money_events enable row level security;

alter table public.jobs add column if not exists billable boolean;
