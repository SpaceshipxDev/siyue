-- 0079 — print_log: one row per REAL PDF generation, starting now.
--
-- Why this exists: "how many 外协单 do we print a day?" was unanswerable in
-- July 2026 — the PDF route (/print/outsource/<id>/pdf/raw) rendered on demand
-- and wrote nothing, access_log (0076) only covers the master board, Caddy has
-- no access-log directive, and Next logs no successful GETs. The number was
-- simply never recorded. This table records it from deploy-day forward.
--
-- `kind` keeps it general so other PDFs (shipping 出货单, inspection) can log
-- here later without a new table. Reprints are intentionally distinct rows —
-- pressing 打印 three times on the same doc is three generations.
--
--   select date(at at time zone 'Asia/Shanghai') d, count(*)
--   from print_log where kind = 'outsource'
--   group by 1 order by 1 desc;

create table if not exists public.print_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null,               -- 'outsource' | (future: 'shipping', 'inspection')
  ref_id text,                      -- outsource block id (or job id, per kind)
  doc_no text,                      -- 外协单号 at time of print
  job_no text,                      -- owning 工号, for readable reports
  user_name text not null,
  role text not null
);

create index if not exists print_log_at_idx on public.print_log (at);
create index if not exists print_log_kind_at_idx on public.print_log (kind, at);

-- Service-role-only (same posture as access_log and the rest of the schema):
-- RLS on, no policies — anon/authed clients can neither read nor write it.
alter table public.print_log enable row level security;
