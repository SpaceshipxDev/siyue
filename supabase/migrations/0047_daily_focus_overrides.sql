-- 重点 v2 — Excel-cell semantics for 产品 / 交期 on the daily focus board.
-- NULL ⇒ the cell shows the linked job's live value; non-null ⇒ this text
-- verbatim. Editing on the board NEVER writes back to the job (the boss
-- annotates his list; he doesn't reschedule the contract from it). Free-text
-- 交期 like "月底前" is expected — display-only, tones apply only when it
-- parses as a date.
--
-- Split from 0046 because 0046 was already applied to prod before these
-- landed. lib/db.ts tolerates the missing columns through the deploy window
-- (read falls back to the base column set, same pattern as procurement 0043).
alter table daily_focus_items add column if not exists product_text text;
alter table daily_focus_items add column if not exists due_text text;
