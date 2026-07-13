-- 检验判定明细 — the inspectors asked for two more fields on a blocking
-- verdict (重做/返修/外修): 不良原因 (what's wrong) and 责任人 (whose station
-- caused it). Free text on the part_stages row alongside the existing
-- verdict trio; OK never clears them, so the audit trail of "why this part
-- bounced" survives the eventual release.
--
-- Write path is a targeted UPDATE separate from the general stage upsert
-- (lib/db setInspectionVerdictDetail) and tolerates this migration being
-- unapplied — the inputs just don't persist until the SQL lands.

alter table part_stages
  add column if not exists verdict_reason text,  -- 不良原因
  add column if not exists verdict_owner  text;  -- 责任人
