-- Fix: order import (导入订单) fails with a statement timeout.
--
-- 0060 installed master-board refresh triggers as FOR EACH ROW on `parts` and
-- `part_stages`. The import pipeline (lib/db.ts fillParsedJob) bulk-inserts a
-- job's parts in one statement and ALL their stage rows (DEFAULT_NEW_PART_STAGES
-- = 10 stages × N parts) in a second statement. Each inserted row fires
-- refresh_master_board_row(), and that function is a heavy aggregate (~270ms
-- per call against the live board). A 7-part order = 70 stage rows = 70 refreshes
-- in a single INSERT ≈ 19s, which blows the role's statement_timeout. Postgres
-- raises SQLSTATE 57014 ("canceling statement due to statement timeout"); the
-- app threw the raw PostgrestError, which surfaced on the import page as the
-- infamous "[object Object]". Every AI import was failing; staff had been
-- limping along via the "手动填写" (manual fill) bypass.
--
-- Fix: make these two triggers FOR EACH STATEMENT, using transition tables to
-- collect the DISTINCT affected job_ids and refresh each ONCE per statement.
-- A 70-row insert now fires a single refresh instead of 70. Single-row updates
-- from the shop floor (a worker marking one stage done) still refresh exactly
-- one job — identical behaviour, just no longer O(rows).
--
-- MANUAL MIGRATION (see AGENTS.md): apply this to Supabase by hand (SQL editor).
-- The app code does not depend on it, but imports stay broken until it runs.

-- parts: refresh each distinct job touched by the statement.
create or replace function trg_refresh_master_board_parts_stmt()
returns trigger
language plpgsql
as $$
begin
  perform refresh_master_board_row(jid)
  from (
    select distinct job_id as jid
    from (
      select job_id from new_rows
      union all
      select job_id from old_rows
    ) u
    where job_id is not null
  ) s;
  return null;
end;
$$;

drop trigger if exists refresh_master_board_parts on parts;
create trigger refresh_master_board_parts
after insert or update or delete on parts
referencing old table as old_rows new table as new_rows
for each statement
execute function trg_refresh_master_board_parts_stmt();

-- part_stages: rows carry part_id, not job_id — resolve to job via parts.
create or replace function trg_refresh_master_board_part_stages_stmt()
returns trigger
language plpgsql
as $$
begin
  perform refresh_master_board_row(jid)
  from (
    select distinct p.job_id as jid
    from parts p
    where p.id in (
      select part_id from new_rows
      union all
      select part_id from old_rows
    )
      and p.job_id is not null
  ) s;
  return null;
end;
$$;

drop trigger if exists refresh_master_board_part_stages on part_stages;
create trigger refresh_master_board_part_stages
after insert or update or delete on part_stages
referencing old table as old_rows new table as new_rows
for each statement
execute function trg_refresh_master_board_part_stages_stmt();

-- trg_refresh_master_board_from_parts() is now unused (its trigger was just
-- repointed). Drop it to avoid confusion. We deliberately KEEP
-- trg_refresh_master_board_from_part_stages() and refresh_master_board_row_for_part()
-- because the outsource_block_parts trigger from 0060 still calls
-- refresh_master_board_row_for_part().
drop function if exists trg_refresh_master_board_from_parts();

notify pgrst, 'reload schema';
