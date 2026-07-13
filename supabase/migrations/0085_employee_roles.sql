-- Employee accounts describe a job, not a station scope.
-- Keep commerce/production as the internal authorization boundary while the
-- factory-facing role is one of 管理、操机、后处理.

alter table users drop constraint if exists users_role_stage_check;

alter table users add column if not exists employee_role text;

update users
set employee_role = case
  when role = 'commerce' then 'management'
  when default_stage in ('丝印', '后处理') then 'post_processing'
  else 'machine'
end
where employee_role is null;

update users set default_stage = null;

alter table users
  alter column employee_role set default 'machine',
  alter column employee_role set not null;

alter table users drop constraint if exists users_employee_role_check;
alter table users add constraint users_employee_role_check check (
  (employee_role = 'management' and role = 'commerce') or
  (employee_role in ('machine', 'post_processing') and role = 'production')
);

