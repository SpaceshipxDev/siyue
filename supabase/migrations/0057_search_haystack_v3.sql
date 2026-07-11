-- Search haystack v3 — 工程师 IS the 联系人.
--
-- Founder clarification (2026-06-12): the 工程师 on a job is the customer's
-- representative for that order — the same person source workbooks label
-- 联系人/对接人/跟单. 0055/0056 wrongly modelled them as two fields; the app
-- now extracts and edits a single jobs.engineer, and jobs.contact is dead
-- (column stays, never written — it was applied before any deploy, so it
-- holds no data).
--
-- This rebuild swaps jobs.contact for jobs.engineer in search_haystack so
-- searching the person's name works. Everything else is identical to 0056.

create or replace view job_summary as
select
  j.id                            as job_id,
  coalesce(ext.total_spend, 0)::numeric as external_spend_cny,
  coalesce(oo.has_open, false)    as has_open_outsource,
  ro.id                           as active_return_id,
  ro.due_date                     as active_return_due_date,
  ro.reason                       as active_return_reason,
  coalesce(pc.cnt, 0)::int        as component_count,
  lower(coalesce(j.job_no,'')      || ' ' ||
        coalesce(j.customer,'')    || ' ' ||
        coalesce(j.product,'')     || ' ' ||
        coalesce(j.contract_no,'') || ' ' ||
        coalesce(j.engineer,'')    || ' ' ||
        coalesce(j.notes,'')       || ' ' ||
        coalesce(pn.haystack, '')) as search_haystack
from jobs j
left join lateral (
  -- Sum of distinct block amounts attached to any part of this job.
  select sum(amount_cny) as total_spend
  from (
    select distinct ob.id, ob.amount_cny
    from outsource_blocks ob
    join outsource_block_parts obp on obp.block_id = ob.id
    join parts p on p.id = obp.part_id
    where p.job_id = j.id and ob.amount_cny is not null
  ) blk
) ext on true
left join lateral (
  -- Has at least one part with an open block covering a non-出货 stage.
  -- Openness respects the per-member qty override (0045).
  select true as has_open
  from outsource_block_parts obp
  join outsource_blocks ob on ob.id = obp.block_id
  join parts p on p.id = obp.part_id
  where p.job_id = j.id
    and coalesce(obp.returned_qty, 0) < coalesce(obp.qty, p.qty)
    and exists (select 1 from unnest(ob.stages) s where s <> '出货')
  limit 1
) oo on true
left join lateral (
  select id, due_date, reason
  from returns
  where job_id = j.id and status = 'open'
  order by created_at desc
  limit 1
) ro on true
left join lateral (
  select count(*) as cnt from parts where job_id = j.id
) pc on true
left join lateral (
  select string_agg(
    coalesce(name,'')     || ' ' ||
    coalesce(material,'') || ' ' ||
    coalesce(part_no,'')  || ' ' ||
    coalesce(process,''), ' ') as haystack
  from parts where job_id = j.id
) pn on true;
