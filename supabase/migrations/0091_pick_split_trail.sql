-- Partial-领料 metadata. ordered_qty freezes the originally ordered 数量 the
-- first time a row is split (qty then holds the remainder / picked share);
-- parent_id on a split-off done row points at the row it was taken from, so
-- the remainder's history can list every pick. Both null on never-split rows.
alter table public.procurements
  add column if not exists ordered_qty numeric,
  add column if not exists parent_id text;
