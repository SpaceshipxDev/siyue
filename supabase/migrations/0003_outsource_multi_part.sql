-- An outsource block now bundles multiple parts going to the same vendor on
-- the same shipment. Replace outsource_blocks.part_id (1:1) with a join
-- table outsource_block_parts (N:N).

create table if not exists outsource_block_parts (
  block_id text not null references outsource_blocks(id) on delete cascade,
  part_id  text not null references parts(id) on delete cascade,
  position integer not null default 0,
  primary key (block_id, part_id)
);

create index if not exists outsource_block_parts_block_idx
  on outsource_block_parts (block_id);
create index if not exists outsource_block_parts_part_idx
  on outsource_block_parts (part_id);

-- Backfill from the legacy single-part column.
insert into outsource_block_parts (block_id, part_id, position)
select id, part_id, 0 from outsource_blocks
where part_id is not null
on conflict do nothing;

-- The legacy part_id column is now redundant. Drop it (cascade behavior is
-- now handled by outsource_block_parts).
alter table outsource_blocks drop column if exists part_id;
