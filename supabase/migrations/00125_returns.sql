-- 退货 (customer returns). After 出货 has shipped a job, the customer may
-- send selected parts back for rework. A return is opened against a job,
-- names which parts come back (with qty), records a reason and an internal
-- due date, and re-opens 工程 on those parts so the floor sees them again.
--
-- The 工程 head decides the actual rework route — partRoute editor rights
-- already include 工程 (lib/auth.ts canEditPartRoute), so they trim or
-- restore stages as needed once the part is back in their hands. We don't
-- preemptively re-open every downstream stage; that would be guesswork.
--
-- Modeled OUTSIDE the STAGES enum on purpose. 退货 is not a production
-- stage — it's a status overlay. Putting it in STAGES would poison every
-- rollup, route, and flow-time helper in lib/data.ts. Master grid renders
-- it as a column driven by activeReturn, not by a part_stages row.
--
-- One open return at a time per job (enforced by the partial unique index
-- below). Closed returns stay as history.
  
                                                                         
create table if not exists returns (
  id                  text primary key,
  job_id              text not null references jobs(id) on delete cascade,
  reason              text not null
                      check (reason in (
                        '尺寸不符','表面瑕疵','装配问题','客户要求修改','其他'
                      )),
  reason_text         text,
  due_date            date not null,
  status              text not null default 'open'
                      check (status in ('open','closed')),
  created_at          timestamptz not null default now(),
  closed_at           timestamptz,
  created_by_user_id  text references users(id) on delete set null
);

-- One open return per job. Closed rows are history and may stack.
create unique index if not exists returns_one_open_per_job
  on returns (job_id) where status = 'open';

create index if not exists returns_job_id_idx on returns (job_id);
create index if not exists returns_status_idx on returns (status);

create table if not exists return_parts (
  return_id  text not null references returns(id) on delete cascade,
  part_id    text not null references parts(id) on delete cascade,
  qty        integer not null check (qty > 0),
  primary key (return_id, part_id)
);

create index if not exists return_parts_return_id_idx on return_parts (return_id);
create index if not exists return_parts_part_id_idx on return_parts (part_id);
