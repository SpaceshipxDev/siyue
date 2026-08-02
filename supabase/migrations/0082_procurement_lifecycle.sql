-- 采购 lifecycle v2 — the three asks the factory has now made three times:
-- 是否已下单 / 是否到料 / 到料检验. Plus the missing link: which 工单 the
-- purchase feeds.
--
-- 1. status gains 'pending' (待下单) in FRONT of 'ordered'. A purchase row can
--    now exist before anyone has actually placed the order — the want-list
--    state ("要买，还没买"). No constraint change needed: status is free text
--    by design (0042). Existing rows are all 'ordered'/'arrived' and keep
--    meaning exactly what they meant.
--
-- 2. job link — job_id references the owning 工单, job_no is a display
--    snapshot so the ledger renders without a join (job numbers are
--    immutable in practice). Nullable: plenty of buys are shop supplies
--    (刀具/耗材) that belong to no job.
--
-- 3. arrival inspection — inspect_result 'ok' | 'defect' (null = not yet
--    inspected), inspect_note for the 不良 story. This is the seed of
--    supplier grading (良率 per supplier falls out of these rows for free).

alter table procurements add column if not exists job_id text;
alter table procurements add column if not exists job_no text;
alter table procurements add column if not exists inspect_result text;
alter table procurements add column if not exists inspect_note text;

-- The job page / board will ask "purchases for this job" — hot path.
create index if not exists procurements_job_id_idx on procurements (job_id);
