-- Server role for the app's data layer.
--
-- Until Supabase Auth is wired in, the Next.js server reads and writes
-- through the `timeclock-db` Edge Function (supabase/functions/timeclock-db),
-- which switches to this role for every request. The role can touch the
-- `timeclock` schema and nothing else, so it can share a project with other
-- apps safely. The app still enforces permissions (src/lib/domain/permissions.ts);
-- the per-user RLS policies take over once requests run as signed-in users.

set search_path = timeclock, extensions, public;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'timeclock_app') then
    create role timeclock_app nologin;
  end if;
end $$;

-- Let the project owner (the Edge Function's connection) switch into it.
grant timeclock_app to postgres;

grant usage on schema timeclock to timeclock_app;
grant usage on schema extensions to timeclock_app;   -- crypt()/gen_salt() for kiosk PINs
grant select, insert, update, delete on all tables in schema timeclock to timeclock_app;
grant usage, select on all sequences in schema timeclock to timeclock_app;
grant execute on all functions in schema timeclock to timeclock_app;
alter default privileges in schema timeclock grant select, insert, update, delete on tables to timeclock_app;
alter default privileges in schema timeclock grant usage, select on sequences to timeclock_app;

-- RLS is on for every table; give the server role full access through an
-- explicit policy on each (rather than BYPASSRLS, which needs a superuser).
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'timeclock' loop
    execute format('create policy "server role" on timeclock.%I to timeclock_app using (true) with check (true)', t);
  end loop;
end $$;
