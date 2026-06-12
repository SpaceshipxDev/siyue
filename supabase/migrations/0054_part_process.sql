-- 加工工艺 — how a part is made (机加 / 3D打印 / 打印 / CNC …).
--
-- The 越侬生产单 Excel carries 加工方式 + 工艺要求 columns that the AI import
-- used to drop entirely; the floor circled the missing column in feedback
-- ("零件进度 needs 加工工艺"). Free text, AI-extracted on import, editable
-- inline on the job detail's new 加工工艺 column. Informational only — it
-- never drives the stage route (商务/工程 still prune 工序 chips by hand).

alter table parts
  add column if not exists process text;
