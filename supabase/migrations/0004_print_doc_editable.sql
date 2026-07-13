-- Make the printed 外协单 / 出货单 fully editable inline, with a customer
-- directory symmetric to vendors. Edits on the doc fall through to the
-- canonical row (vendor / customer); per-doc-only fields live on the job
-- or outsource_block.

-- Customer directory (mirrors `vendors` shape: id, name, plus contact info).
create table if not exists customers (
  id      text primary key,
  name    text not null,
  contact text,
  address text,
  phone   text
);

-- Case-insensitive uniqueness so "傅" and "傅 " (or 'foo' vs 'Foo') don't
-- spawn duplicate rows on autosave-by-name.
create unique index if not exists customers_name_lower_uniq
  on customers (lower(name));

-- Link jobs to a customer record. Keep jobs.customer (text) as a display
-- fallback for legacy jobs without a directory entry.
alter table jobs
  add column if not exists customer_id  text references customers(id) on delete set null,
  add column if not exists created_by   text,
  add column if not exists contract_no  text,
  add column if not exists batch_no     text;

create index if not exists jobs_customer_id_idx on jobs (customer_id);

-- Per-doc outsource fields. NULL = use the default (vendor row / BRAND const).
alter table outsource_blocks
  add column if not exists created_by              text,
  add column if not exists recipient_address       text,
  add column if not exists recipient_contact_name  text,
  add column if not exists recipient_contact_phone text;
