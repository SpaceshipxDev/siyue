-- Dashboard search v2 — the floor asked for more searchable fields:
-- "搜索项增加，合同号、料号" (+ the new 联系人 / 加工工艺 / 订单备注).
--
-- job_summary.search_haystack grows: 合同号 (jobs.contract_no), 联系人
-- (jobs.contact, 0055), 订单备注 (jobs.notes), and per part 料号
-- (parts.part_no) + 加工工艺 (parts.process, 0054). The haystack is a
-- lowercased blob consumed by substring match only — never rendered — so the
-- production scope's display scrubbing (lib/dto.ts) is unaffected.
--
-- Also fixes a latent bug in has_open_outsource while rebuilding: member
-- "openness" must respect the per-member outsource qty override (0045) —
-- a block that sent 5 of a 12-qty part and got 5 back is closed, but the
-- old `returned_qty < p.qty` comparison kept it open forever.

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
        coalesce(j.contact,'')     || ' ' ||
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
