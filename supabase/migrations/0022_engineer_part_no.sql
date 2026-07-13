-- Two new fields surfaced on the printed 出货单 / 外协单:
--   jobs.engineer  — 工程师 (the engineering owner of the job). Auto-extracted
--                    by the AI importer when present in the source workbook,
--                    blank otherwise. Treated like createdBy / contractNo:
--                    free text, editable inline on the print pages.
--   parts.part_no  — 料号 (vendor / customer part number). Never extracted;
--                    operators fill it manually on the job detail page once
--                    they know the number. Replaces the stand-in we used to
--                    render in the shipping table's 料号 column (which just
--                    duplicated the part name).
alter table jobs
  add column if not exists engineer text;

alter table parts
  add column if not exists part_no text;
