-- 随工单扫码 (traveller QR, /s/<token>).
--
-- One stable unguessable token per PART — the traveller sheet travels with
-- the physical parts, and its QR is the worker's credential for the narrow
-- report surface (this part, current OP, quantity). Minted lazily the first
-- time a traveller is printed (ensurePartQrToken), same pattern as
-- vendors.portal_token in 0073.
alter table parts
  add column if not exists qr_token text;

create unique index if not exists parts_qr_token_key
  on parts (qr_token)
  where qr_token is not null;
