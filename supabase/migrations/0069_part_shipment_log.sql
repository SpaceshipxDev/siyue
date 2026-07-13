-- 出货记录 — a literally-editable, free-text shipment record per part.
--
-- The 零件进度 table's 出货记录 column used to be a read-only render of the
-- 制作出货单 batch audit-log (shipments → ShipmentEntry rows, summed per part).
-- The boss asked for it to be plain editable text: click the cell, type
-- whatever the real shipping situation is. This column holds that manual text.
--
-- Semantics: when NULL, the column still shows the derived batch log so nothing
-- already recorded disappears. The moment someone types here, this manual text
-- wins (parts.shipment_log overrides the derived view). Free text, nullable,
-- never AI-extracted, never drives any rollup.

alter table parts
  add column if not exists shipment_log text;
