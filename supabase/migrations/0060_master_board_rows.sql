-- Master board fast path.
--
-- 0059 added the shell aggregate view but used an older stage list. This
-- migration replaces that view with the current canonical STAGES and adds a
-- maintained one-row-per-job table for the board body. The app keeps the old
-- multi-view loader as a fallback when this table is absent.

create extension if not exists pg_trgm;

create or replace function master_board_job_intake_date(p_job_no text)
returns text
language plpgsql
immutable
as $$
declare
  m text[];
  yy int;
  mm int;
  dd int;
begin
  if p_job_no is null then
    return null;
  end if;
  m := regexp_match(
    trim(p_job_no),
    '^[A-Z][A-Z0-9]*-(\d{2})-(\d{1,2})-(\d{1,2})-(\d+)$',
    'i'
  );
  if m is null then
    return null;
  end if;
  yy := m[1]::int;
  mm := m[2]::int;
  dd := m[3]::int;
  if mm < 1 or mm > 12 or dd < 1 or dd > 31 then
    return null;
  end if;
  return '20' || lpad(yy::text, 2, '0') || '-' ||
    lpad(mm::text, 2, '0') || '-' ||
    lpad(dd::text, 2, '0');
end;
$$;

create or replace function master_board_job_no_sort_key(p_job_no text)
returns text
language plpgsql
immutable
as $$
declare
  m text[];
  intake text;
  seq int;
begin
  if p_job_no is null then
    return chr(65535);
  end if;
  m := regexp_match(
    trim(p_job_no),
    '^[A-Z][A-Z0-9]*-(\d{2})-(\d{1,2})-(\d{1,2})-(\d+)$',
    'i'
  );
  if m is null then
    return chr(65535);
  end if;
  intake := master_board_job_intake_date(p_job_no);
  if intake is null then
    return chr(65535);
  end if;
  seq := least(99999, m[4]::int);
  return translate(intake, '0123456789', '9876543210') ||
    '-' ||
    lpad((99999 - seq)::text, 5, '0');
end;
$$;

create table if not exists master_board_rows (
  job_id text primary key references jobs(id) on delete cascade,
  position numeric,
  job_no text not null,
  job_no_sort_key text not null default chr(65535),
  job_intake_date text,
  customer text not null,
  product text not null,
  engineer text,
  amount_cny numeric,
  due_date text not null,
  effective_due_date text not null,
  secondary_due_date text,
  notes text,
  status text not null,
  created_at timestamptz,
  pinned_at timestamptz,
  job_type text,
  is_product boolean,
  paused_at timestamptz,
  pause_reason text,
  needs_outsource boolean,
  outsource_note text,
  drawing_change_open boolean,
  drawing_change_note text,
  has_open_outsource boolean not null default false,
  has_open_inspection_verdict boolean not null default false,
  external_spend_cny numeric not null default 0,
  margin_cny numeric,
  is_shipped boolean not null default false,
  component_count int not null default 0,
  search_haystack text not null default '',
  active_return_id text,
  active_return_due_date text,
  active_return_reason text,
  cells jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table master_board_rows
  add column if not exists job_no_sort_key text not null default chr(65535);
alter table master_board_rows
  add column if not exists job_intake_date text;

create index if not exists master_board_rows_status_idx
  on master_board_rows(status);
create index if not exists master_board_rows_position_idx
  on master_board_rows(position);
create index if not exists master_board_rows_effective_due_idx
  on master_board_rows(effective_due_date, job_id);
create index if not exists master_board_rows_job_no_idx
  on master_board_rows(job_no);
create index if not exists master_board_rows_job_no_sort_idx
  on master_board_rows(job_no_sort_key, job_id);
create index if not exists master_board_rows_job_intake_idx
  on master_board_rows(job_intake_date);
create index if not exists master_board_rows_search_haystack_idx
  on master_board_rows using gin (search_haystack gin_trgm_ops);

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

create or replace function refresh_master_board_rows()
returns void
language plpgsql
as $$
declare
  r record;
begin
  for r in select id from jobs loop
    perform refresh_master_board_row(r.id);
  end loop;
end;
$$;

create or replace function refresh_master_board_row_for_part(p_part_id text)
returns void
language plpgsql
as $$
declare
  v_job_id text;
begin
  select job_id into v_job_id from parts where id = p_part_id;
  if v_job_id is not null then
    perform refresh_master_board_row(v_job_id);
  end if;
end;
$$;

create or replace function trg_refresh_master_board_from_jobs()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    delete from master_board_rows where job_id = old.id;
    return old;
  end if;
  perform refresh_master_board_row(new.id);
  return new;
end;
$$;

create or replace function trg_refresh_master_board_from_parts()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform refresh_master_board_row(old.job_id);
    return old;
  end if;
  perform refresh_master_board_row(new.job_id);
  if tg_op = 'UPDATE' and old.job_id is distinct from new.job_id then
    perform refresh_master_board_row(old.job_id);
  end if;
  return new;
end;
$$;

create or replace function trg_refresh_master_board_from_part_stages()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform refresh_master_board_row_for_part(old.part_id);
    return old;
  end if;
  perform refresh_master_board_row_for_part(new.part_id);
  if tg_op = 'UPDATE' and old.part_id is distinct from new.part_id then
    perform refresh_master_board_row_for_part(old.part_id);
  end if;
  return new;
end;
$$;

create or replace function trg_refresh_master_board_from_job_id()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform refresh_master_board_row(old.job_id);
    return old;
  end if;
  perform refresh_master_board_row(new.job_id);
  if tg_op = 'UPDATE' and old.job_id is distinct from new.job_id then
    perform refresh_master_board_row(old.job_id);
  end if;
  return new;
end;
$$;

create or replace function trg_refresh_master_board_from_outsource_blocks()
returns trigger
language plpgsql
as $$
declare
  v_block_id text;
  r record;
begin
  v_block_id := case when tg_op = 'DELETE' then old.id else new.id end;
  for r in
    select distinct p.job_id
    from outsource_block_parts obp
    join parts p on p.id = obp.part_id
    where obp.block_id = v_block_id
  loop
    perform refresh_master_board_row(r.job_id);
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function trg_refresh_master_board_from_outsource_block_parts()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    perform refresh_master_board_row_for_part(old.part_id);
    return old;
  end if;
  perform refresh_master_board_row_for_part(new.part_id);
  if tg_op = 'UPDATE' and old.part_id is distinct from new.part_id then
    perform refresh_master_board_row_for_part(old.part_id);
  end if;
  return new;
end;
$$;

drop trigger if exists refresh_master_board_jobs on jobs;
create trigger refresh_master_board_jobs
after insert or update or delete on jobs
for each row execute function trg_refresh_master_board_from_jobs();

drop trigger if exists refresh_master_board_parts on parts;
create trigger refresh_master_board_parts
after insert or update or delete on parts
for each row execute function trg_refresh_master_board_from_parts();

drop trigger if exists refresh_master_board_part_stages on part_stages;
create trigger refresh_master_board_part_stages
after insert or update or delete on part_stages
for each row execute function trg_refresh_master_board_from_part_stages();

drop trigger if exists refresh_master_board_returns on returns;
create trigger refresh_master_board_returns
after insert or update or delete on returns
for each row execute function trg_refresh_master_board_from_job_id();

drop trigger if exists refresh_master_board_stage_pins on job_stage_pins;
create trigger refresh_master_board_stage_pins
after insert or update or delete on job_stage_pins
for each row execute function trg_refresh_master_board_from_job_id();

drop trigger if exists refresh_master_board_outsource_blocks on outsource_blocks;
create trigger refresh_master_board_outsource_blocks
after update or delete on outsource_blocks
for each row execute function trg_refresh_master_board_from_outsource_blocks();

drop trigger if exists refresh_master_board_outsource_block_parts on outsource_block_parts;
create trigger refresh_master_board_outsource_block_parts
after insert or update or delete on outsource_block_parts
for each row execute function trg_refresh_master_board_from_outsource_block_parts();

create or replace function master_board_stage_kind(p_cells jsonb, p_stage text)
returns text
language sql
immutable
as $$
  with c as (
    select
      coalesce((p_cells -> p_stage ->> 'total')::int, 0) as total,
      coalesce((p_cells -> p_stage ->> 'inHouseDone')::int, 0) as in_house_done,
      coalesce((p_cells -> p_stage ->> 'outsourcedClosed')::int, 0) as outsourced_closed,
      coalesce((p_cells -> p_stage ->> 'outsourcedOpen')::int, 0) as outsourced_open,
      coalesce((p_cells -> p_stage ->> 'inProgress')::int, 0) as in_progress
  )
  select case
    when total = 0 then 'na'
    when in_house_done + outsourced_closed + outsourced_open = total then 'done'
    when in_house_done + outsourced_closed + outsourced_open = 0 and in_progress = 0 then 'pending'
    else 'partial'
  end
  from c;
$$;

create or replace function master_board_facets(
  p_q text default null,
  p_job_no_only boolean default false,
  p_ship text default null,
  p_sort text default 'due',
  p_date_start text default null,
  p_date_end text default null,
  p_status_filters jsonb default '{}'::jsonb
)
returns table(stage text, pending int, partial int, done int, total int)
language sql
stable
as $$
  with stage_names(stage, ord) as (
    values
      ('工程', 1),
      ('编程', 2),
      ('操机', 3),
      ('检验', 4),
      ('手工', 5),
      ('打磨', 6),
      ('喷漆', 7),
      ('丝印', 8),
      ('质量', 9),
      ('出货', 10)
  ),
  filtered as (
    select m.*
    from master_board_rows m
    where coalesce(m.status, 'ready') not in ('parsing', 'draft', 'failed')
      and (
        nullif(trim(coalesce(p_q, '')), '') is null
        or (
          p_job_no_only
          and m.job_no ilike '%' || trim(p_q) || '%'
        )
        or (
          not p_job_no_only
          and m.search_haystack ilike '%' || lower(trim(p_q)) || '%'
        )
      )
      and (
        p_ship is null
        or (p_ship = 'shipped' and m.is_shipped)
        or (p_ship = 'paused' and not m.is_shipped and m.paused_at is not null)
        or (p_ship = 'live' and not m.is_shipped and m.paused_at is null)
      )
      and (
        p_date_start is null
        or case
          when p_sort = 'jobNo' then m.job_intake_date
          else m.effective_due_date
        end >= p_date_start
      )
      and (
        p_date_end is null
        or case
          when p_sort = 'jobNo' then m.job_intake_date
          else m.effective_due_date
        end <= p_date_end
      )
  )
  select
    sn.stage,
    count(*) filter (
      where master_board_stage_kind(f.cells, sn.stage) = 'pending'
    )::int as pending,
    count(*) filter (
      where master_board_stage_kind(f.cells, sn.stage) = 'partial'
    )::int as partial,
    count(*) filter (
      where master_board_stage_kind(f.cells, sn.stage) = 'done'
    )::int as done,
    count(*) filter (
      where master_board_stage_kind(f.cells, sn.stage) in ('pending', 'partial', 'done')
    )::int as total
  from stage_names sn
  left join filtered f
    on not exists (
      select 1
      from jsonb_each_text(coalesce(p_status_filters, '{}'::jsonb)) sf
      where sf.key <> sn.stage
        and master_board_stage_kind(f.cells, sf.key) <> sf.value
    )
  group by sn.stage, sn.ord
  order by sn.ord;
$$;

select refresh_master_board_rows();

create or replace view master_board_summary as
with today_sh as (
  select (now() at time zone 'Asia/Shanghai')::date as d
),
base as (
  select
    job_id,
    amount_cny,
    external_spend_cny,
    effective_due_date::date as effective_due_date,
    paused_at,
    is_shipped
  from master_board_rows
  where coalesce(status, 'ready') not in ('parsing', 'draft', 'failed')
),
global_totals as (
  select
    count(*)::int as total_jobs,
    count(*) filter (where not is_shipped and paused_at is null)::int as in_progress_jobs,
    count(*) filter (where not is_shipped and paused_at is not null)::int as paused_jobs,
    count(*) filter (
      where not is_shipped
        and paused_at is null
        and effective_due_date < (select d from today_sh)
    )::int as overdue_jobs,
    count(*) filter (
      where not is_shipped
        and paused_at is null
        and effective_due_date = (select d from today_sh)
    )::int as due_today_jobs,
    coalesce(sum(amount_cny), 0)::numeric as total_amount_cny,
    coalesce(sum(external_spend_cny), 0)::numeric as total_external_spend_cny,
    coalesce(sum(coalesce(amount_cny, 0) - external_spend_cny), 0)::numeric as total_margin_cny
  from base
),
stage_names(stage, ord) as (
  values
    ('工程', 1),
    ('编程', 2),
    ('操机', 3),
    ('检验', 4),
    ('手工', 5),
    ('打磨', 6),
    ('喷漆', 7),
    ('丝印', 8),
    ('质量', 9),
    ('出货', 10)
),
stage_totals as (
  select
    sn.stage,
    sn.ord,
    count(m.job_id) filter (
      where coalesce((m.cells -> sn.stage ->> 'inProgress')::int, 0) > 0
        or coalesce((m.cells -> sn.stage ->> 'hasMinePending')::boolean, false)
    )::int as here,
    count(m.job_id) filter (
      where (
          coalesce((m.cells -> sn.stage ->> 'inProgress')::int, 0) > 0
          or coalesce((m.cells -> sn.stage ->> 'hasMinePending')::boolean, false)
        )
        and m.effective_due_date::date = (select d from today_sh)
    )::int as due_today,
    count(m.job_id) filter (
      where (
          coalesce((m.cells -> sn.stage ->> 'inProgress')::int, 0) > 0
          or coalesce((m.cells -> sn.stage ->> 'hasMinePending')::boolean, false)
        )
        and m.effective_due_date::date < (select d from today_sh)
    )::int as overdue,
    coalesce(sum(coalesce((m.cells -> sn.stage ->> 'total')::int, 0)), 0)::int as parts
  from stage_names sn
  left join master_board_rows m
    on m.cells ? sn.stage
   and coalesce(m.status, 'ready') not in ('parsing', 'draft', 'failed')
  group by sn.stage, sn.ord
)
select
  gt.total_jobs,
  gt.in_progress_jobs,
  gt.paused_jobs,
  gt.overdue_jobs,
  gt.due_today_jobs,
  gt.total_amount_cny,
  gt.total_external_spend_cny,
  gt.total_margin_cny,
  (
    select jsonb_object_agg(
      st.stage,
      jsonb_build_object(
        'here', st.here,
        'dueToday', st.due_today,
        'overdue', st.overdue,
        'parts', st.parts
      )
      order by st.ord
    )
    from stage_totals st
  ) as by_stage
from global_totals gt;

notify pgrst, 'reload schema';
