-- Persist printed-doc numbers so a re-print of the same job/block keeps the
-- same YNMX-yy-m-d-NNN string. NULL until the doc is first opened.
alter table jobs
  add column if not exists shipping_doc_no text;

alter table outsource_blocks
  add column if not exists doc_no text;

create index if not exists jobs_shipping_doc_no_idx on jobs (shipping_doc_no);
create index if not exists outsource_blocks_doc_no_idx on outsource_blocks (doc_no);

-- Vendor address for the printed 外协单 (供应商地址 row).
alter table vendors
  add column if not exists address text;
