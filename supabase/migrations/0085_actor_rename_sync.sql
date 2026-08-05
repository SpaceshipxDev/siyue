-- 0085_actor_rename_sync.sql
-- 报工 identity: renaming an account now carries their history with them.
--
-- WHY: part_stages attribution is free-text name snapshots (by_actor /
-- started_by_actor / verdict_by) — the app stopped writing by_user_id long ago,
-- so the worker views' coalesce(users.name, by_actor) rescue never fires on
-- real rows. 管理员工 rename (f4e9d59) updates users.name only, which stranded
-- each renamed worker's history under the old text name: /report showed the
-- new account with zero output and the old name as a ghost free-text actor
-- (e.g. 编程003 with 453 events vs 编程003 吴润静 with none).
--
-- ONE-TIME REPAIR (already applied by hand 2026-08-05, before this migration):
-- by_actor / started_by_actor / verdict_by rewritten old→new for the 8 renames
-- of 2026-08-05 (编程001..006 → 编程00X 姓名, 车工徐 → 车工徐兴旺, 车工李 →
-- 车工李元发): 2,115 part_stages rows across 569 jobs, chunked ≤100 jobs per
-- statement so the master-board statement trigger (refresh per touched job)
-- stays under statement_timeout. Pre-account test names from 2026-05-19
-- (编程部001/006/007/008, 质量001倪伟群, 车床-李) were left untouched —
-- ambiguous owners, 56 events total, launch-week noise.
--
-- MECHANISM (this migration): renames must not do the rewrite synchronously —
-- a heavy worker (质量周中华: ~12.8k events, hundreds of jobs) would blow the
-- service-role statement_timeout inside the rename request and roll the whole
-- rename back. Instead:
--   1. trigger on users(name) enqueues (old_name → new_name) into
--      actor_rename_queue — instant, so the rename UI never blocks;
--   2. a pg_cron job runs process_actor_renames() every minute, draining the
--      oldest queue entry one bounded chunk (≤80 jobs) per run. Chunks run as
--      postgres (generous timeout) and leave the part_stages statement trigger
--      enabled, so master_board_rows cells/rollups refresh per chunk for free.
-- Queue rows survive restarts; the drain is idempotent and strictly FIFO, so
-- rename A→B followed by B→C converges correctly.
--
-- New events are unaffected: sessions store only the user id and currentUser()
-- reads users.name fresh per request, so post-rename taps already write the
-- new name.
--
-- MANUAL MIGRATION (see AGENTS.md): apply to Supabase by hand / via MCP.

create extension if not exists pg_cron;

create table if not exists actor_rename_queue (
  id          bigserial primary key,
  old_name    text not null,
  new_name    text not null,
  enqueued_at timestamptz not null default now(),
  done_at     timestamptz
);

-- Not an app surface: no policies, RLS on = invisible to PostgREST roles;
-- the trigger and the cron worker run as table owner and bypass RLS.
alter table actor_rename_queue enable row level security;

create or replace function trg_enqueue_actor_rename()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.name is distinct from new.name
     and coalesce(btrim(old.name), '') <> ''
     and coalesce(btrim(new.name), '') <> '' then
    insert into actor_rename_queue (old_name, new_name)
    values (old.name, new.name);
  end if;
  return null;
end;
$$;

drop trigger if exists enqueue_actor_rename on users;
create trigger enqueue_actor_rename
  after update of name on users
  for each row
  execute function trg_enqueue_actor_rename();

-- Drain one chunk of the oldest pending rename. Bounded to p_job_limit jobs so
-- the cascaded master-board refresh (statement trigger, per touched job) stays
-- well inside a cron slot; marks the entry done when a pass rewrites 0 rows.
-- Serialized via advisory lock so overlapping cron runs never double-drain.
create or replace function process_actor_renames(p_job_limit int default 80)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  q   actor_rename_queue%rowtype;
  n   integer := 0;
begin
  -- Transaction-scoped: auto-released on commit/abort, so a crashed run can
  -- never wedge the queue.
  if not pg_try_advisory_xact_lock(hashtext('actor_rename_queue')) then
    return -1;  -- previous run still draining
  end if;

  select * into q
  from actor_rename_queue
  where done_at is null
  order by id
  limit 1;

  if not found then
    return 0;
  end if;

  with jobs_chunk as (
    select distinct p.job_id
    from part_stages ps
    join parts p on p.id = ps.part_id
    where ps.by_actor = q.old_name
       or ps.started_by_actor = q.old_name
       or ps.verdict_by = q.old_name
    limit greatest(1, least(p_job_limit, 100))
  ), upd as (
    update part_stages ps
    set by_actor         = case when ps.by_actor         = q.old_name then q.new_name else ps.by_actor         end,
        started_by_actor = case when ps.started_by_actor = q.old_name then q.new_name else ps.started_by_actor end,
        verdict_by       = case when ps.verdict_by       = q.old_name then q.new_name else ps.verdict_by       end
    where ps.part_id in (select id from parts where job_id in (select job_id from jobs_chunk))
      and (ps.by_actor = q.old_name
        or ps.started_by_actor = q.old_name
        or ps.verdict_by = q.old_name)
    returning 1
  )
  select count(*) into n from upd;

  if n = 0 then
    update actor_rename_queue set done_at = now() where id = q.id;
  end if;
  return n;
end;
$$;

revoke all on function process_actor_renames(int) from public, anon, authenticated;

-- Every minute; a no-op (one indexed SELECT) when the queue is empty.
select cron.schedule(
  'actor-rename-sync',
  '* * * * *',
  $$select process_actor_renames()$$
);
