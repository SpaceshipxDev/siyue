-- Name the work, not the range.
--
-- The old model treated outsourcing as "vendor covers stage range X..Y".
-- The boss thinks in named activities (外发氧化, 外发CNC, 外发电镀, …) — that's
-- the vocabulary 金蝶 uses and the language of the shop. Store the activity
-- directly so the displayed label is the boss's word, not a derived range.
--
-- Activity is a free text string. There is no separate "activities" table —
-- the list of valid activities is just `SELECT DISTINCT activity FROM
-- outsource_blocks WHERE activity IS NOT NULL`. The boss adds a new one by
-- typing it once; autocomplete on subsequent blocks. No admin page, no
-- schema change to extend the vocabulary.
--
-- Existing rows: backfill with the same heuristic the UI used to derive a
-- label (single stage → stage name; full coverage → 全程; otherwise
-- "first → last"). Nobody loses data; new blocks get real names going
-- forward.

alter table outsource_blocks add column if not exists activity text;

update outsource_blocks
set activity = case
  when array_length(stages, 1) is null then null
  when array_length(stages, 1) = 1 then stages[1]
  when array_length(stages, 1) >= 7 then '全程'
  else stages[1] || ' → ' || stages[array_length(stages, 1)]
end
where activity is null;
