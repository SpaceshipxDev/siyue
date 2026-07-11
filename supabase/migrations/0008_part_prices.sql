-- Per-component price tracking. 商务 needs to see what each part of a job is
-- quoted at, not just the job-level 总价. Both columns nullable so legacy
-- rows continue to render and AI extractions that find no price fall back
-- gracefully. unit_price_cny and line_total_cny are stored independently
-- (no enforced qty * unit = total) so quote-line discounts, tax tweaks, or
-- AI mistakes can be hand-corrected without one side stomping the other.

alter table parts
  add column if not exists unit_price_cny numeric,
  add column if not exists line_total_cny numeric;
