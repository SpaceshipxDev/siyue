-- Partial-quantity returns. A vendor may ship back only some of a part's
-- units in one batch (e.g. 6 of 11 painted today, 5 more next week). We
-- track returns as a counter so the same member row can record multiple
-- partial receives without splitting it.
--
-- A member is "fully returned" when returned_qty >= the part's qty (parts.qty).
-- The existing returned_at column now reflects the date of the *latest*
-- return event; it remains useful as the member's closure stamp once
-- returned_qty reaches qty.

alter table outsource_block_parts
  add column if not exists returned_qty integer not null default 0;

-- Backfill: any member that already had returned_at set is treated as fully
-- returned (since the old model only allowed all-or-nothing). Pull the qty
-- from the parts table.
update outsource_block_parts obp
   set returned_qty = p.qty
  from parts p
 where obp.part_id = p.id
   and obp.returned_at is not null
   and obp.returned_qty = 0;
