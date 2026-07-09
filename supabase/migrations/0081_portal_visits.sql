-- 0081: vendor-portal visit log — "did a real vendor open it" as data.
--
-- vendor_seen_at (0077) is a one-time first-seen stamp per block: it cannot
-- count repeat visits and cannot tell a vendor's phone from the clerk (or
-- the founder) previewing the same public token link. This table records
-- EVERY portal render with its user-agent — a China-daytime phone UA is a
-- vendor; a desktop UA in founder-evening hours is not.
--
-- Rows with vendor_id null are hits on invalid/revoked tokens (probing or
-- stale links) — logged on purpose.
create table public.portal_visits (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  token text not null,
  vendor_id text,
  vendor_name text,
  user_agent text
);

create index portal_visits_at_idx on public.portal_visits (at desc);
create index portal_visits_vendor_idx on public.portal_visits (vendor_id, at desc);

-- Service-role access only, like access_log.
alter table public.portal_visits enable row level security;
