-- 思跃 industrial — initial schema
-- Six flat tables. Compound text PKs match the legacy file-db shape so the
-- TypeScript layer (lib/db.ts) can keep its existing function signatures.

create table if not exists jobs (
  id            text primary key,
  job_no        text not null,
  customer      text not null,
  product       text not null,
  amount_cny    numeric,
  due_date      date  not null,
  notes         text,
  status        text  not null default 'ready'
                check (status in ('parsing','draft','ready','failed')),
  source_file   text,
  parse_error   text,
  created_at    timestamptz not null default now(),
  position      integer not null default 0
);

create index if not exists jobs_position_idx on jobs (position);

create table if not exists parts (
  id                 text primary key,
  job_id             text not null references jobs(id) on delete cascade,
  position           integer not null default 0,
  name               text not null default '',
  qty                integer not null default 0,
  material           text,
  surface_treatment  text,
  notes              text,
  image_url          text
);

create index if not exists parts_job_id_idx on parts (job_id);

create table if not exists part_stages (
  id            text primary key,
  part_id       text not null references parts(id) on delete cascade,
  stage         text not null,
  status        text not null default 'pending'
                check (status in ('pending','in_progress','done')),
  completed_at  text,
  by_actor      text,
  unique (part_id, stage)
);

create index if not exists part_stages_part_id_idx on part_stages (part_id);

create table if not exists vendors (
  id     text primary key,
  name   text not null,
  notes  text
);

create table if not exists outsource_blocks (
  id              text primary key,
  part_id         text not null references parts(id) on delete cascade,
  vendor_id       text not null references vendors(id),
  stages          text[] not null,
  amount_cny      numeric not null default 0,
  sent_date       text not null,
  expected_return text not null,
  actual_return   text,
  notes           text
);

create index if not exists outsource_blocks_part_id_idx on outsource_blocks (part_id);
create index if not exists outsource_blocks_vendor_id_idx on outsource_blocks (vendor_id);
