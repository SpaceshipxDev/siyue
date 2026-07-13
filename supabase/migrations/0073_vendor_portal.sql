-- 外协厂商门户 (vendor portal) — the other side of the 外协 loop.
--
-- Each vendor gets ONE stable, unguessable link (siyue.ai/w/<token>) that the
-- 外协员 pastes into the existing per-vendor WeChat thread. No login, no
-- install: the vendor opens it in the WeChat webview and sees every block
-- we've sent them — parts, photos, quantities, 要求交期, amounts — and
-- answers with one-tap state: 确认收到 / 承诺交期 / 已发回.
--
-- vendors.portal_token is generated lazily by the app the first time a link
-- is needed (ensureVendorPortalTokens), so new vendors keep working with no
-- backfill step.

alter table vendors
  add column if not exists portal_token text;

-- Unique so a token resolves to exactly one vendor. Partial index: legacy
-- rows stay NULL until their first link is composed.
create unique index if not exists vendors_portal_token_key
  on vendors (portal_token)
  where portal_token is not null;

-- Vendor-reported state, one set of columns per block. All nullable — NULL
-- means "vendor hasn't said anything", which renders as absence on the
-- 外协台 (no fake defaults, no migration backfill).
--
--   vendor_seen_at       last time the vendor's portal rendered this block
--                        while it was still open ("已读" — WeChat can't do this)
--   vendor_ack_at        vendor tapped 确认收到 (goods arrived at their shop)
--   vendor_promised_date vendor's own committed return date; compared against
--                        expected_return to derive the 延期 signal
--   vendor_delay_reason  one-tap reason chip (材料未到 / 排队中 / 图纸问题 / 其他)
--   vendor_shipped_at    vendor tapped 已发回 (parts on their way back to us)
alter table outsource_blocks
  add column if not exists vendor_seen_at timestamptz,
  add column if not exists vendor_ack_at timestamptz,
  add column if not exists vendor_promised_date date,
  add column if not exists vendor_delay_reason text,
  add column if not exists vendor_shipped_at timestamptz;
