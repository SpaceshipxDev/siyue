-- 0088_part_seq_label.sql
-- 零件进度 的 # 可以手改.
--
-- The # column has always been derived: a part's index in the job's part list,
-- printed 01 / 02 / 03. That is right until the customer's own drawing set
-- numbers the parts differently — their BOM says 01..08, the imported sheet
-- came out in another order, and the floor then reads two different numbers for
-- the same part out loud.
--
-- seq_label is an OVERRIDE, not a replacement: null (the case for all 9,005
-- existing parts) means "keep deriving it", so nothing on screen moves until
-- someone types over a number. Clearing the field writes null and hands the row
-- back to the derived sequence.
--
-- Free text, not an integer — real drawings number parts 1-1 / 2A as often as
-- they do 03. Written only by updateComponent (lib/db.ts); part INSERTs leave
-- it out entirely, exactly like shipment_log (0069), so nothing about 导入订单
-- depends on this migration having run.

alter table public.parts add column if not exists seq_label text;

comment on column public.parts.seq_label is
  '零件进度 # 的手改值. null = 用派生序号 (该零件在工单里的位置). 自由文本 — 图纸会写 1-1 / 2A.';
