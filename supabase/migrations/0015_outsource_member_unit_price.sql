-- Per-member unit price on outsource blocks. The 外协单 we send to the
-- vendor is a purchase order, and small Chinese vendors expect to see
-- 单价 × 数量 = 小计 broken out per part — a single block-level total
-- is too coarse. block.amount_cny remains the manually-entered grand
-- total (with 加急/待补金额 semantics intact); unit_price_cny on each
-- member is the per-unit vendor price for that specific part on this
-- block. The PDF prefers per-line subtotals when set and falls back to
-- block.amount_cny otherwise.
--
-- numeric (no precision) is consistent with parts.unit_price_cny in
-- 0008_part_prices.sql. Nullable — backfill is "unknown" and the UI
-- shows it as a dash.

alter table outsource_block_parts
  add column if not exists unit_price_cny numeric;
