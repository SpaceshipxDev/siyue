-- 0095_gai_access.sql
-- 改一下 (self-serve: edit the app on the mirror, ship to prod) is scoped per person.
-- users.can_gai — granted/revoked by the boss in 管理员工; the boss always qualifies in code
-- (lib/auth canGai), so a stored false on the boss row is rejected in lib/db updateUser.
-- Additive, default off: nobody gains anything until the boss flips a switch — except the
-- three the boss named at launch (2026-08-28): 老板, Harry, 于海伟.

alter table users add column if not exists can_gai boolean not null default false;

update users set can_gai = true where name in ('老板', 'Harry', '于海伟');
