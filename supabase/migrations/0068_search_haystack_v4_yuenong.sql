-- Search haystack v4 — 越侬商务 becomes searchable, and rides onto the board row.
--
-- 0065 added jobs.yuenong_business (OUR salesperson, the in-house counterpart to
-- jobs.engineer / 客户工程师) but the search haystack was built in 0057, before
-- the column existed — so searching a salesperson's name found nothing, and the
-- board never carried the value to show WHY a row matched.
--
-- This migration:
--   1. rebuilds job_summary.search_haystack to include yuenong_business (the one
--      source — master_board_rows.search_haystack is copied from it on refresh),
--   2. adds master_board_rows.yuenong_business so the board can surface the
--      matched salesperson inline (mirrors how engineer is already shown),
--   3. re-declares refresh_master_board_row to populate that column,
--   4. backfills both columns on existing rows in one pass (the per-row aggregate
--      is heavy; this bulk UPDATE only touches the two changed columns).
--
-- yuenong_business is customer-facing context: it's scrubbed for pure-production
-- scopes alongside engineer (lib/master_wire#scrubForWire, lib/dto#scrubJob), so
-- the floor neither searches nor sees it — same as today's engineer behaviour.

-- 1. Rebuild the haystack view (identical to 0057 + yuenong_business).
create or replace view job_summary as
select
  j.id                            as job_id,
  coalesce(ext.total_spend, 0)::numeric as external_spend_cny,
  coalesce(oo.has_open, false)    as has_open_outsource,
  ro.id                           as active_return_id,
  ro.due_date                     as active_return_due_date,
  ro.reason                       as active_return_reason,
  coalesce(pc.cnt, 0)::int        as component_count,
  lower(coalesce(j.job_no,'')          || ' ' ||
        coalesce(j.customer,'')        || ' ' ||
        coalesce(j.product,'')         || ' ' ||
        coalesce(j.contract_no,'')     || ' ' ||
        coalesce(j.engineer,'')        || ' ' ||
        coalesce(j.yuenong_business,'') || ' ' ||
        coalesce(j.notes,'')           || ' ' ||
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

-- 2. Carry the salesperson onto the materialized board row (display only).
alter table master_board_rows
  add column if not exists yuenong_business text;

-- 3. Re-declare the per-row refresh so it populates yuenong_business. Body is
--    identical to 0060 except for the one new column in the insert list, the
--    select list, and the on-conflict update set.
create or replace function refresh_master_board_row(p_job_id text)
returns void
language plpgsql
as $$
begin
  if p_job_id is null then
    return;
  end if;

  if not exists (select 1 from jobs where id = p_job_id) then
    delete from master_board_rows where job_id = p_job_id;
    return;
  end if;

  insert into master_board_rows (
    job_id,
    position,
    job_no,
    job_no_sort_key,
    job_intake_date,
    customer,
    product,
    engineer,
    yuenong_business,
    amount_cny,
    due_date,
    effective_due_date,
    secondary_due_date,
    notes,
    status,
    created_at,
    pinned_at,
    job_type,
    is_product,
    paused_at,
    pause_reason,
    needs_outsource,
    outsource_note,
    drawing_change_open,
    drawing_change_note,
    has_open_outsource,
    has_open_inspection_verdict,
    external_spend_cny,
    margin_cny,
    is_shipped,
    component_count,
    search_haystack,
    active_return_id,
    active_return_due_date,
    active_return_reason,
    cells,
    updated_at
  )
  select
    j.id,
    j.position,
    j.job_no,
    master_board_job_no_sort_key(j.job_no),
    master_board_job_intake_date(j.job_no),
    j.customer,
    j.product,
    j.engineer,
    j.yuenong_business,
    j.amount_cny,
    j.due_date,
    coalesce(js.active_return_due_date, j.due_date),
    j.secondary_due_date,
    j.notes,
    coalesce(j.status, 'ready'),
    j.created_at,
    j.pinned_at,
    j.job_type,
    j.is_product,
    j.paused_at,
    j.pause_reason,
    j.needs_outsource,
    j.outsource_note,
    j.drawing_change_open,
    j.drawing_change_note,
    coalesce(js.has_open_outsource, false),
    exists (
      select 1
      from part_stages ps
      join parts p on p.id = ps.part_id
      where p.job_id = j.id
        and ps.stage = '检验'
        and ps.status <> 'done'
        and ps.verdict in ('重做', '返修', '外修')
    ),
    coalesce(js.external_spend_cny, 0)::numeric,
    case
      when j.amount_cny is null then null
      else j.amount_cny - coalesce(js.external_spend_cny, 0)::numeric
    end,
    coalesce(ship.total, 0) > 0
      and coalesce(ship.in_progress, 0) = 0
      and coalesce(ship.pending, 0) = 0,
    coalesce(js.component_count, 0),
    coalesce(js.search_haystack, ''),
    js.active_return_id,
    js.active_return_due_date,
    js.active_return_reason,
    coalesce(cell_rows.cells, '{}'::jsonb),
    now()
  from jobs j
  left join job_summary js on js.job_id = j.id
  left join job_stage_rollup ship
    on ship.job_id = j.id
   and ship.stage = '出货'
  left join lateral (
    select jsonb_object_agg(
      r.stage,
      jsonb_build_object(
        'total', r.total,
        'inHouseDone',
          greatest(
            0,
            coalesce(r.total, 0)
              - coalesce(r.outsourced_closed, 0)
              - coalesce(r.outsourced_open, 0)
              - coalesce(r.in_progress, 0)
              - coalesce(r.pending, 0)
          ),
        'outsourcedClosed', r.outsourced_closed,
        'outsourcedOpen', r.outsourced_open,
        'inProgress', r.in_progress,
        'pending', r.pending,
        'inProgressDoneQtySum', r.in_progress_done_qty_sum,
        'earliestInProgressAt', r.earliest_in_progress_at,
        'latestFinishedAt', r.latest_finished_at,
        'latestCompletedAt', r.latest_completed_at,
        'latestBy', r.latest_by_actor,
        'hasMinePending', r.has_mine_pending,
        'hasUpstreamActive', r.has_upstream_active,
        'pinnedAt', jsp.pinned_at
      )
    ) as cells
    from job_stage_rollup r
    left join job_stage_pins jsp
      on jsp.job_id = r.job_id
     and jsp.stage = r.stage
    where r.job_id = j.id
  ) cell_rows on true
  where j.id = p_job_id
  on conflict (job_id) do update set
    position = excluded.position,
    job_no = excluded.job_no,
    job_no_sort_key = excluded.job_no_sort_key,
    job_intake_date = excluded.job_intake_date,
    customer = excluded.customer,
    product = excluded.product,
    engineer = excluded.engineer,
    yuenong_business = excluded.yuenong_business,
    amount_cny = excluded.amount_cny,
    due_date = excluded.due_date,
    effective_due_date = excluded.effective_due_date,
    secondary_due_date = excluded.secondary_due_date,
    notes = excluded.notes,
    status = excluded.status,
    created_at = excluded.created_at,
    pinned_at = excluded.pinned_at,
    job_type = excluded.job_type,
    is_product = excluded.is_product,
    paused_at = excluded.paused_at,
    pause_reason = excluded.pause_reason,
    needs_outsource = excluded.needs_outsource,
    outsource_note = excluded.outsource_note,
    drawing_change_open = excluded.drawing_change_open,
    drawing_change_note = excluded.drawing_change_note,
    has_open_outsource = excluded.has_open_outsource,
    has_open_inspection_verdict = excluded.has_open_inspection_verdict,
    external_spend_cny = excluded.external_spend_cny,
    margin_cny = excluded.margin_cny,
    is_shipped = excluded.is_shipped,
    component_count = excluded.component_count,
    search_haystack = excluded.search_haystack,
    active_return_id = excluded.active_return_id,
    active_return_due_date = excluded.active_return_due_date,
    active_return_reason = excluded.active_return_reason,
    cells = excluded.cells,
    updated_at = excluded.updated_at;
end;
$$;

-- 4. Backfill existing rows in one pass — only the two columns this migration
--    touches, so we skip the heavy per-row cell aggregate. New edits keep them
--    fresh via the refresh_master_board_jobs trigger (fires on any jobs change).
update master_board_rows mbr
set search_haystack = coalesce(js.search_haystack, ''),
    yuenong_business = j.yuenong_business
from jobs j
left join job_summary js on js.job_id = j.id
where mbr.job_id = j.id;
