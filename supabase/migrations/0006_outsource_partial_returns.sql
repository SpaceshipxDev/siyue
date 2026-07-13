-- Partial outsourcing returns. A shipment (outsource_blocks) bundles N parts
-- (outsource_block_parts), but parts can come back from the vendor in
-- different batches on different days. Track returns at the part level, not
-- the block level: each membership row carries its own returned_at.
--
-- The block as a whole is "closed" when every member has a returned_at —
-- derived in the app (see blockClosedAt in lib/data.ts), no longer a stored
-- column on outsource_blocks.

alter table outsource_block_parts
  add column if not exists returned_at text;

-- Backfill: if the block was already closed at the block level, every member
-- inherits that closure date. Open blocks → all NULLs. Behavior on day 1 is
-- byte-identical to today.
update outsource_block_parts obp
   set returned_at = ob.actual_return
  from outsource_blocks ob
 where obp.block_id = ob.id
   and ob.actual_return is not null
   and obp.returned_at is null;

alter table outsource_blocks
  drop column if exists actual_return;
