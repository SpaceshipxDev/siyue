-- 出货 history. Every 制作出货单 submission emits one row here plus N
-- shipment_parts rows for the batch. The 出货 stage's done_qty (in
-- part_stages) is kept in sync as the running cumulative across all
-- shipments — the stage table is the rollup, this pair is the audit trail.
--
-- doc_no is the printed YNMX-yy-m-d-NNN string for the batch (own sequence,
-- independent of jobs.shipping_doc_no — that column is now legacy and only
-- read by old jobs that haven't been re-shipped yet).

create table if not exists shipments (
  id          text primary key,
  job_id      text not null references jobs(id) on delete cascade,
  doc_no      text unique,
  created_at  timestamptz not null default now(),
  created_by  text
);

create index if not exists shipments_job_id_idx on shipments (job_id);
create index if not exists shipments_doc_no_idx on shipments (doc_no);
create index if not exists shipments_created_at_idx on shipments (created_at);

create table if not exists shipment_parts (
  shipment_id  text not null references shipments(id) on delete cascade,
  part_id      text not null references parts(id) on delete cascade,
  qty          integer not null check (qty > 0),
  primary key (shipment_id, part_id)
);

create index if not exists shipment_parts_shipment_id_idx on shipment_parts (shipment_id);
create index if not exists shipment_parts_part_id_idx on shipment_parts (part_id);
