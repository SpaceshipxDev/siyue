-- 采购 (procurement) — a standalone purchasing ledger anyone on the team can
-- write to. Same design thesis as 工作交接单: passive, visible state, no
-- messaging. A person records what they're buying — the part, the price, the
-- supplier, the date they ordered it, and the date it should come back — and
-- everyone reads one calm ordered list of what's on the way.
--
-- Deliberately flat (one row per purchase, no line-item child table). A
-- procurement entry is atomic: it's ONE thing being bought, unlike a handover
-- sheet which bundles a person's many open matters. Text PK matches the rest
-- of the schema so lib/db.ts keeps its uid()-generated id convention.
create table if not exists procurements (
  id              text primary key,
  item            text not null,          -- 采购项 / 所需零件
  qty             numeric,                 -- 数量 (optional)
  unit_price_cny  numeric,                 -- 单价 (optional)
  supplier        text,                    -- 供应商 / 采购自
  order_date      date not null,           -- 采购日期 — the date they ordered from
  expected_date   date,                    -- 预计到货 — when it should come back
  -- 'ordered' (在途 / 采购中) | 'arrived' (已到货). The whole product is the
  -- lifecycle: you buy it, then it shows up. Default ordered.
  status          text not null default 'ordered',
  arrived_date    date,                    -- 实际到货日期 (set when marked 到货)
  buyer           text not null,           -- 采购人 — who is buying
  notes           text,                    -- 备注
  created_by      text,
  created_at      timestamptz not null default now()
);

-- The list sorts in-transit items by 预计到货 (soonest / overdue float to top),
-- so that's the hot index. status partials keep the "采购中" view cheap.
create index if not exists procurements_expected_date_idx
  on procurements (expected_date);
create index if not exists procurements_status_idx
  on procurements (status);
create index if not exists procurements_created_at_idx
  on procurements (created_at desc);
