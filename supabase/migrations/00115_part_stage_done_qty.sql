-- Per-stage partial-completion count. Workers at a station can record
-- "did 3 of 5" without flipping the stage to done. While status='in_progress'
-- this column is the running count of finished units; status flips to 'done'
-- only when the count reaches the part's qty (we route through the normal
-- finish path at that point and clear done_qty back to null).
--
-- Null (the default) means "no partial entered" — which for in_progress reads
-- as 0 done so far, and for done reads as fully complete (qty/qty). Keeping
-- it null in the done state means existing rows need no backfill.
alter table part_stages
  add column if not exists done_qty integer;
