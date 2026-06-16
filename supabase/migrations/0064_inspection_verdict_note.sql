-- 0064 — 检验 OK 备注. Additive column: an inspector can attach a 责任人 + 备注
-- to a PASSING (OK) verdict, kept separate from the blocking-verdict 不良原因
-- (verdict_reason). 责任人 reuses the existing verdict_owner column.
--
-- Plain additive column on part_stages — it is NOT read by any rollup view, so
-- there is nothing to recompute and no master-board impact. Safe to apply by
-- hand any time (before or after the code deploy); the read path degrades to
-- "doesn't persist yet" on a DB that hasn't run it (see isMissingColumnError).

alter table part_stages add column if not exists verdict_note text;
