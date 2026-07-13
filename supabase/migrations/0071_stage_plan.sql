-- 0071_stage_plan.sql
-- 计划交期 (排产) — a per-工段 PLANNED finish date for each job, holistic (one
-- plan covers every part). Values are 'YYYY-MM-DD', or 'YYYY-MM-DDTHH:mm' when a
-- specific hour is pinned, keyed by 工段 name (工程/编程/操机/手工/打磨/喷漆/丝印/质量).
-- Purely for visibility + planning: it NEVER feeds the contract-交期 color, sort,
-- urgency, or the station queue order. Mirrors the secondary_due_date pattern —
-- a jsonb column on jobs, mirrored onto master_board_rows so the board fast-path
-- carries it with zero new queries. Apply by hand to Supabase (deploy.sh does
-- NOT run migrations).

-- 1. Source column on jobs. Defaults to '{}' so every existing job starts with
--    no plan (identical to today) — no jobs backfill needed.
alter table jobs
  add column if not exists stage_plan jsonb not null default '{}'::jsonb;

-- 2. Mirror column on the denormalized board fast-path. Also defaults '{}', so
--    existing master_board_rows are already correct for "no plan". The per-job
--    trigger (refresh_master_board_jobs, migration 0060) repopulates a row the
--    moment its plan changes, so NO mass backfill is required here either.
alter table master_board_rows
  add column if not exists stage_plan jsonb not null default '{}'::jsonb;

-- 3. Re-declare refresh_master_board_row to carry j.stage_plan. Body is
--    byte-identical to migration 0068 except for the one new column in the
--    insert list, the select list, and the on-conflict update set. No new join,
--    so the single board select is unchanged (the undici 16KB .in() header
--    ceiling is never touched).
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
    stage_plan,
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
    j.stage_plan,
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
    stage_plan = excluded.stage_plan,
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
