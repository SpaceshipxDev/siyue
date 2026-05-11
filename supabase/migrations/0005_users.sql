-- Role-based access. Two roles: commerce (boss / sales / 商务) and production
-- (station heads / 生产). Production users are pinned to one default_stage and
-- only see their own station's queue. Commerce users see everything.
--
-- Auth lives entirely in this table — there is no Supabase auth.users layer.
-- The app verifies a 4-digit PIN against pin_hash, then issues a signed JWT
-- cookie. RLS is not used (server still calls Supabase with the service role
-- key); scope checks are enforced in app/actions.ts and proxy.ts.

create table if not exists users (
  id            text primary key,
  name          text not null,
  pin_hash      text not null,
  role          text not null check (role in ('commerce','production')),
  default_stage text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Production users MUST have a default_stage; commerce users MUST NOT (they
-- see all stations). Enforced via check so a misclick can't strand a worker.
alter table users
  add constraint users_role_stage_check
  check (
    (role = 'production' and default_stage is not null) or
    (role = 'commerce'   and default_stage is null)
  );

-- Case-insensitive uniqueness on display name — duplicate "王师傅" rows would
-- make the login tile grid ambiguous.
create unique index if not exists users_name_lower_uniq on users (lower(name));
create index if not exists users_active_idx on users (active);

-- Audit columns — who created the row / completed the stage. Free-text by_actor
-- on part_stages stays for backward display compatibility; new writes populate
-- both by_actor (name) and the new FK (id).
alter table jobs
  add column if not exists created_by_user_id text references users(id) on delete set null;

alter table outsource_blocks
  add column if not exists created_by_user_id text references users(id) on delete set null;

alter table part_stages
  add column if not exists by_user_id text references users(id) on delete set null;

-- Bootstrap of a first commerce user happens in code (lib/db.ts
-- ensureBootstrapUser) so we can hash the configured BOOTSTRAP_PIN with
-- bcryptjs at runtime instead of pinning a literal hash here.
