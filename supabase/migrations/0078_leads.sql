-- 0078 — leads: inbound contact requests from the public siyue.ai landing.
--
-- The marketing landing page (built separately, fronted by Caddy) has one
-- job: capture a phone number from a boss who wants a callback. Each submit
-- lands here as one row. There is no auth on the write path — the POST at
-- /api/leads is public — so the table is deliberately minimal and carries
-- request provenance (user_agent / referer / ip) for spam triage rather than
-- trusting anything the form claims.
--
-- The boss works this list from /backend/leads: newest first, tap-to-call the
-- 手机, and stamp contacted_at once he's rung them (清 the follow-up queue).
--
-- Same service-role-only posture as the rest of the schema: reached solely via
-- the service-role key server-side, never from a browser client. RLS stays OFF
-- (no anon/authed client ever touches this table directly).

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  phone text not null,
  name text,
  company text,
  source text not null default 'landing',
  user_agent text,
  referer text,
  ip text,
  contacted_at timestamptz,
  note text
);

-- The ledger is always read newest-first; the boss never paginates deep.
create index if not exists leads_created_at_idx on public.leads (created_at desc);
