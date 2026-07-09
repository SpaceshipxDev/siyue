-- 0080: access_log learns two more questions.
--
-- 0076 answered "does anyone open the station tabs" (board renders only).
-- It cannot answer the two follow-ups the owner asked next:
--   (a) which view do people click INTO jobs from (dashboard? their station?)
--   (b) where do 报工 taps physically happen — board cell, station queue,
--       or inside the job page?
--
--   action — null for page views; the mutate `kind` for stage taps
--            (startStage/finishStage/undoStage/setStageDoneQty + *JobStage)
--   ref    — referer path+query of the page the user was on when the row
--            was born (for job views: where they came from; for actions:
--            same as path)
alter table public.access_log
  add column if not exists action text,
  add column if not exists ref text;
