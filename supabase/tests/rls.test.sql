-- Row Level Security checks. Runs against a database with the migrations
-- applied (Supabase local: `supabase db reset` then
-- `psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.test.sql`).
-- Everything happens in a transaction that is rolled back.

begin;

set local search_path = timeclock, extensions, public;

-- Two tenants, one person of each role in tenant A, one employee in tenant B.
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000a3'), ('00000000-0000-0000-0000-0000000000a4'),
  ('00000000-0000-0000-0000-0000000000a5'), ('00000000-0000-0000-0000-0000000000b1');

insert into companies (id, name, slug, app_name, pay_period_anchor) values
  ('10000000-0000-0000-0000-00000000000a', 'Alpha Builders', 'alpha', 'Alpha Clock', '2026-01-04'),
  ('10000000-0000-0000-0000-00000000000b', 'Beta Contracting', 'beta', 'Beta Clock', '2026-01-04');

insert into profiles (id, auth_user_id, full_name) values
  ('20000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'Admin A'),
  ('20000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000a2', 'Office A'),
  ('20000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a3', 'Foreman A'),
  ('20000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a4', 'Worker A1'),
  ('20000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000a5', 'Worker A2'),
  ('20000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', 'Worker B1');

insert into memberships (company_id, profile_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a1', 'owner_admin'),
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a2', 'office_payroll'),
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a3', 'foreman'),
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a4', 'employee'),
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a5', 'employee'),
  ('10000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-0000000000b1', 'employee');

insert into jobs (id, company_id, name, code, address, lat, lng) values
  ('30000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-00000000000a', 'Job led by foreman', 'A-1', 'x', 43.6, -79.4),
  ('30000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-00000000000a', 'Other job', 'A-2', 'x', 43.6, -79.4),
  ('30000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-00000000000b', 'Beta job', 'B-1', 'x', 49.2, -123.1);
insert into job_foremen values ('30000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a3');

-- A1 works the foreman's job; A2 works the other job.
insert into shifts (company_id, job_id, profile_id, starts_at, ends_at) values
  ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a4', now() - interval '1 hour', now() + interval '7 hours'),
  ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a2', '20000000-0000-0000-0000-0000000000a5', now() - interval '1 hour', now() + interval '7 hours');

insert into punches (company_id, profile_id, job_id, type, occurred_at, source, created_by) values
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a4', '30000000-0000-0000-0000-0000000000a1', 'in', now() - interval '1 hour', 'phone', '20000000-0000-0000-0000-0000000000a4'),
  ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a5', '30000000-0000-0000-0000-0000000000a2', 'in', now() - interval '1 hour', 'phone', '20000000-0000-0000-0000-0000000000a5'),
  ('10000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-0000000000b1', '30000000-0000-0000-0000-0000000000b1', 'in', now() - interval '1 hour', 'phone', '20000000-0000-0000-0000-0000000000b1');

insert into messages (id, company_id, sender_id, audience_type, audience_user_id, body) values
  ('40000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a2', 'user', '20000000-0000-0000-0000-0000000000a4', 'Bring your harness');
insert into message_deliveries (message_id, profile_id, channel, status) values
  ('40000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a4', 'in_app', 'delivered');

create function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', uid, true);
  execute 'set local role authenticated';
end $$;

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin
  if not ok then raise exception 'RLS TEST FAILED: %', label; end if;
  raise notice 'ok  %', label;
end $$;

-- ── Employee A1 ──
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a4');
select pg_temp.check('employee sees only own punches', (select count(*) from punches) = 1);
select pg_temp.check('employee sees one company', (select count(*) from companies) = 1);
select pg_temp.check('recipient reads their message and delivery', (select count(*) from messages) = 1 and (select count(*) from message_deliveries) = 1);
select pg_temp.check('employee cannot see other tenant jobs', not exists (select 1 from jobs where company_id = '10000000-0000-0000-0000-00000000000b'));
do $$ declare n int; begin
  insert into punches (company_id, profile_id, job_id, type, occurred_at, source, created_by)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a4', '30000000-0000-0000-0000-0000000000a1', 'break_start', now(), 'phone', '20000000-0000-0000-0000-0000000000a4');
  get diagnostics n = row_count;
  perform pg_temp.check('employee can punch self', n = 1);
end $$;
do $$ begin
  insert into punches (company_id, profile_id, job_id, type, occurred_at, source, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a5', '30000000-0000-0000-0000-0000000000a2', 'out', now(), 'phone', '20000000-0000-0000-0000-0000000000a4');
  raise exception 'RLS TEST FAILED: employee punched someone else';
exception when insufficient_privilege then raise notice 'ok  employee cannot punch for someone else';
end $$;
do $$ declare n int; begin
  update jobs set name = 'hacked';
  get diagnostics n = row_count;
  perform pg_temp.check('employee cannot edit jobs', n = 0);
end $$;
reset role;

-- ── Foreman A ──
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a3');
select pg_temp.check('non-recipient cannot read the message', (select count(*) from messages) = 0);
select pg_temp.check('foreman sees crew punches on own job only', (select count(*) from punches where job_id = '30000000-0000-0000-0000-0000000000a1') >= 1 and not exists (select 1 from punches where job_id = '30000000-0000-0000-0000-0000000000a2'));
do $$ declare n int; begin
  insert into punches (company_id, profile_id, job_id, type, occurred_at, source, created_by)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a4', '30000000-0000-0000-0000-0000000000a1', 'break_end', now(), 'foreman', '20000000-0000-0000-0000-0000000000a3');
  get diagnostics n = row_count;
  perform pg_temp.check('foreman can punch crew on own job', n = 1);
end $$;
do $$ begin
  insert into punches (company_id, profile_id, job_id, type, occurred_at, source, created_by)
  values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-0000000000a5', '30000000-0000-0000-0000-0000000000a2', 'out', now(), 'foreman', '20000000-0000-0000-0000-0000000000a3');
  raise exception 'RLS TEST FAILED: foreman punched on a job they do not lead';
exception when insufficient_privilege then raise notice 'ok  foreman cannot punch on other jobs';
end $$;
select timeclock.set_site_modes('30000000-0000-0000-0000-0000000000a1', 'require_online', 'continuous');
select pg_temp.check('foreman can set site modes on own job', (select offline_mode = 'require_online' from jobs where id = '30000000-0000-0000-0000-0000000000a1'));
do $$ begin
  perform timeclock.set_site_modes('30000000-0000-0000-0000-0000000000a2', 'require_online', 'continuous');
  raise exception 'RLS TEST FAILED: foreman changed another site';
exception when raise_exception then
  if sqlerrm like 'RLS TEST FAILED%' then raise; end if;
  raise notice 'ok  foreman cannot set modes on other jobs';
end $$;
reset role;

-- ── Office A ──
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
select pg_temp.check('sender sees the delivery and read state', (select count(*) from message_deliveries where message_id = '40000000-0000-0000-0000-0000000000a1') = 1);
select pg_temp.check('office sees all company punches, no other tenant', (select count(*) from punches) >= 4 and not exists (select 1 from punches where company_id = '10000000-0000-0000-0000-00000000000b'));
do $$ declare n int; begin
  update companies set name = 'x';
  get diagnostics n = row_count;
  perform pg_temp.check('office cannot change company settings', n = 0);
end $$;
reset role;

-- ── Admin A ──
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare n int; begin
  update companies set app_name = 'Alpha TimeClock';
  get diagnostics n = row_count;
  perform pg_temp.check('admin updates own company', n = 1);
end $$;
do $$ declare n int; begin
  update jobs set name = 'x' where company_id = '10000000-0000-0000-0000-00000000000b';
  get diagnostics n = row_count;
  perform pg_temp.check('admin cannot touch other tenant', n = 0);
end $$;
reset role;

-- ── Integrity triggers ──
do $$ begin
  update punches set occurred_at = now() - interval '5 hours' where profile_id = '20000000-0000-0000-0000-0000000000a4';
  raise exception 'RLS TEST FAILED: punch time was edited';
exception when raise_exception then
  if sqlerrm like 'RLS TEST FAILED%' then raise; end if;
  raise notice 'ok  punch times are immutable';
end $$;
do $$ begin
  insert into shifts (company_id, job_id, profile_id, starts_at, ends_at)
  values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a2', '20000000-0000-0000-0000-0000000000a4', now(), now() + interval '2 hours');
  raise exception 'RLS TEST FAILED: double-booked a shift';
exception when exclusion_violation then raise notice 'ok  overlapping shifts are rejected';
end $$;

-- ── Server role (used by the timeclock-db Edge Function) ──
create table public.other_app_data (secret text);
insert into public.other_app_data values ('not yours');
set local role timeclock_app;
select pg_temp.check('server role reads every timeclock tenant', (select count(distinct company_id) from punches) >= 2);
do $$ begin
  perform * from public.other_app_data;
  raise exception 'RLS TEST FAILED: server role read another app''s table';
exception when insufficient_privilege then raise notice 'ok  server role cannot read other apps in the project';
end $$;
reset role;

rollback;
