-- 产品 — a standalone tag that coexists with the existing job_type chip.
-- Unlike 短期/中期/长期/加急 (which are mutually exclusive duration/priority
-- buckets), 产品 is an independent flag: a job can be both 加急 AND 产品.
-- Modeled as a boolean column so existing job_type semantics + indexes stay
-- untouched.
alter table jobs
  add column if not exists is_product boolean not null default false;

create index if not exists jobs_is_product_idx
  on jobs (is_product)
  where is_product = true;
