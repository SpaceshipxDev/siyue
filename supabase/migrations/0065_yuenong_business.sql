-- 越侬商务 — OUR commercial owner for this order (越侬 = the factory side).
--
-- The in-house counterpart to jobs.engineer. After the 2026-06 relabel the
-- two contacts on an order are:
--   jobs.engineer          → 客户：工程师  — the CUSTOMER's rep (AI-extracted)
--   jobs.yuenong_business  → 越侬商务       — OUR salesperson (human-filled)
--
-- Never AI-extracted: humans type it in the job header. Free text, editable
-- inline exactly like engineer / contract_no. Treated as customer-facing
-- context (scrubbed for pure production scopes alongside engineer in scrubJob).
alter table jobs
  add column if not exists yuenong_business text;
