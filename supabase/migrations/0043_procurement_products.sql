-- 物料库 (procurement product catalog) — the reusable half of 采购. A CNC shop
-- buys the same things over and over: 刀具, 量具, 标准件, 原材料, 耗材. Instead of
-- retyping the part name, the 淘宝/1688 链接, the shop and the price on every
-- single purchase, you save it once as a 物料 and pick it next time. The picker
-- searches this table; "新建物料" writes a row here.
--
-- Each 采购 row may reference one 物料 (product_id) but also SNAPSHOTS the link
-- and price at purchase time onto the 采购 row itself — so editing a 物料's price
-- or deleting it never rewrites what a past purchase actually cost.
create table if not exists procurement_products (
  id              text primary key,
  name            text not null,         -- 品名
  category        text,                  -- 类别 (刀具/量具/夹具/原材料/标准件/耗材/外协/其他)
  supplier        text,                  -- 默认供应商 / 店铺
  link            text,                  -- 链接 (淘宝 / 1688 / 京东 …)
  unit_price_cny  numeric,               -- 参考单价
  notes           text,                  -- 规格 / 型号
  -- bumped to now() each time a 采购 picks this 物料; drives the picker sort so
  -- the things you buy most float to the top of the search.
  last_used_at    timestamptz,
  created_by      text,
  created_at      timestamptz not null default now()
);

-- The picker lists most-recently-used first, then newest; that's the hot sort.
create index if not exists procurement_products_last_used_idx
  on procurement_products (last_used_at desc nulls last, created_at desc);

-- Link each purchase back to its catalog 物料 (optional — a true one-off can
-- still create a 物料, so in practice this is almost always set). on delete set
-- null: deleting a 物料 keeps the historical 采购 rows intact, they just lose the
-- live catalog link (the snapshotted item/supplier/link/price still render).
alter table procurements
  add column if not exists product_id text references procurement_products(id) on delete set null;

-- 链接 snapshot on the purchase itself, so the ledger row stays clickable even
-- after the 物料's link changes or the 物料 is deleted.
alter table procurements
  add column if not exists link text;

create index if not exists procurements_product_id_idx
  on procurements (product_id);
