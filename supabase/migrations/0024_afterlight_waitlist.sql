-- afterlight_waitlist — creator sign-ups captured by the /join landing page.
-- This table is independent of the MES domain; it backs a marketing waitlist
-- for the "Afterlight" creator product and shares only the Postgres instance.
--
-- Captured in a short Typeform-style flow:
--   email            (required) — the contact address
--   tiktok_handle    (optional) — normalized to a bare handle, no leading @ / URL
--   instagram_handle (optional) — same normalization
--   brands           (optional) — free text: brands they work with or want to
create extension if not exists "pgcrypto";

create table if not exists afterlight_waitlist (
  id               uuid primary key default gen_random_uuid(),
  email            text not null,
  tiktok_handle    text,
  instagram_handle text,
  brands           text,
  created_at       timestamptz not null default now()
);

-- Newest sign-ups first when reviewing the list.
create index if not exists afterlight_waitlist_created_at_idx
  on afterlight_waitlist (created_at desc);

-- One row per email (case-insensitive). A repeat submit is treated as a no-op
-- "you're already on the list" by the server action, not an error.
create unique index if not exists afterlight_waitlist_email_key
  on afterlight_waitlist (lower(email));
