-- Row Level Security: the database enforces the same role matrix as
-- src/lib/domain/permissions.ts, so a bug in the app can't leak another
-- company's data or let an employee edit time.
--
--   employee        own punches/shifts/timesheets/messages, read own company's jobs
--   foreman         + crew on jobs they lead: read time, insert punches/corrections, foreman-approve
--   office_payroll  + read everything in the company, approve timesheets, payroll exports
--   owner_admin     everything in their company
--
-- Background jobs use the service role, which bypasses RLS. Every policy
-- here is scoped `to authenticated`; the server role has its own (…_server_role.sql).

set search_path = timeclock, extensions, public;

-- ── Helpers (security definer so policies don't recurse into memberships) ─

create function timeclock.my_profile_id() returns uuid
language sql stable security definer set search_path = timeclock as $$
  select id from profiles where auth_user_id = auth.uid()
$$;

create function timeclock.has_role(company uuid, roles app_role[]) returns boolean
language sql stable security definer set search_path = timeclock as $$
  select exists (
    select 1 from memberships m
    where m.company_id = company and m.profile_id = timeclock.my_profile_id() and m.active and m.role = any (roles)
  )
$$;

create function timeclock.is_member(company uuid) returns boolean
language sql stable security definer set search_path = timeclock as $$
  select timeclock.has_role(company, enum_range(null::app_role))
$$;

create function timeclock.is_office(company uuid) returns boolean
language sql stable security definer set search_path = timeclock as $$
  select timeclock.has_role(company, array['owner_admin', 'office_payroll']::app_role[])
$$;

create function timeclock.is_admin(company uuid) returns boolean
language sql stable security definer set search_path = timeclock as $$
  select timeclock.has_role(company, array['owner_admin']::app_role[])
$$;

create function timeclock.leads_job(job uuid) returns boolean
language sql stable security definer set search_path = timeclock as $$
  select exists (select 1 from job_foremen f where f.job_id = job and f.profile_id = timeclock.my_profile_id())
$$;

-- Foreman's crew: anyone with a shift on a job they lead in the last/next 14 days.
create function timeclock.in_my_crew(company uuid, person uuid) returns boolean
language sql stable security definer set search_path = timeclock as $$
  select timeclock.has_role(company, array['foreman']::app_role[]) and exists (
    select 1 from shifts s join job_foremen f on f.job_id = s.job_id
    where s.company_id = company and s.profile_id = person and f.profile_id = timeclock.my_profile_id()
      and s.starts_at > now() - interval '14 days' and s.starts_at < now() + interval '14 days'
  )
$$;

-- messages and message_deliveries each need to look at the other. Doing that
-- inside policies directly makes Postgres recurse forever, so these
-- security-definer helpers read the other table without re-applying RLS.
create function timeclock.is_message_recipient(msg uuid) returns boolean
language sql stable security definer set search_path = timeclock as $$
  select exists (select 1 from message_deliveries d where d.message_id = msg and d.profile_id = timeclock.my_profile_id())
$$;

create function timeclock.sent_message(msg uuid, include_office boolean) returns boolean
language sql stable security definer set search_path = timeclock as $$
  select exists (
    select 1 from messages m
    where m.id = msg and (m.sender_id = timeclock.my_profile_id() or (include_office and timeclock.is_office(m.company_id)))
  )
$$;

-- ── Enable RLS everywhere ────────────────────────────────────────────────

alter table companies                enable row level security;
alter table profiles                 enable row level security;
alter table memberships              enable row level security;
alter table jobs                     enable row level security;
alter table job_foremen              enable row level security;
alter table cost_codes               enable row level security;
alter table shifts                   enable row level security;
alter table punches                  enable row level security;
alter table location_pings           enable row level security;
alter table timesheets               enable row level security;
alter table timesheet_approvals      enable row level security;
alter table audit_log                enable row level security;
alter table messages                 enable row level security;
alter table message_deliveries       enable row level security;
alter table notification_preferences enable row level security;
alter table devices                  enable row level security;
alter table integration_connections  enable row level security;
alter table external_ids             enable row level security;
alter table integration_outbox       enable row level security;   -- no policies: service role only
alter table payroll_exports          enable row level security;

-- ── Companies & people ───────────────────────────────────────────────────

create policy "members read their company" on companies for select to authenticated using (timeclock.is_member(id));
create policy "admins update their company" on companies for update to authenticated using (timeclock.is_admin(id)) with check (timeclock.is_admin(id));

create policy "read self" on profiles for select to authenticated using (id = timeclock.my_profile_id());
create policy "read co-workers" on profiles for select to authenticated using (
  exists (select 1 from memberships m where m.profile_id = profiles.id and timeclock.is_member(m.company_id))
);
create policy "update self" on profiles for update to authenticated using (id = timeclock.my_profile_id()) with check (id = timeclock.my_profile_id());
create policy "admins manage people" on profiles for all to authenticated using (
  exists (select 1 from memberships m where m.profile_id = profiles.id and timeclock.is_admin(m.company_id))
);

create policy "members read memberships" on memberships for select to authenticated using (timeclock.is_member(company_id));
create policy "admins manage memberships" on memberships for all to authenticated using (timeclock.is_admin(company_id)) with check (timeclock.is_admin(company_id));

-- ── Jobs ─────────────────────────────────────────────────────────────────

create policy "members read jobs" on jobs for select to authenticated using (timeclock.is_member(company_id));
create policy "admins manage jobs" on jobs for all to authenticated using (timeclock.is_admin(company_id)) with check (timeclock.is_admin(company_id));
-- Foremen change site modes through timeclock.set_site_modes() (bottom of file).

create policy "members read job foremen" on job_foremen for select to authenticated using (exists (select 1 from jobs j where j.id = job_id and timeclock.is_member(j.company_id)));
create policy "admins manage job foremen" on job_foremen for all to authenticated using (exists (select 1 from jobs j where j.id = job_id and timeclock.is_admin(j.company_id)));

create policy "members read cost codes" on cost_codes for select to authenticated using (timeclock.is_member(company_id));
create policy "admins manage cost codes" on cost_codes for all to authenticated using (timeclock.is_admin(company_id)) with check (timeclock.is_admin(company_id));

-- ── Schedule ─────────────────────────────────────────────────────────────

create policy "read own shifts" on shifts for select to authenticated using (profile_id = timeclock.my_profile_id());
create policy "foremen read crew shifts" on shifts for select to authenticated using (timeclock.leads_job(job_id));
create policy "office reads shifts" on shifts for select to authenticated using (timeclock.is_office(company_id));
create policy "admins manage shifts" on shifts for all to authenticated using (timeclock.is_admin(company_id)) with check (timeclock.is_admin(company_id));

-- ── Punches ──────────────────────────────────────────────────────────────

create policy "read own punches" on punches for select to authenticated using (profile_id = timeclock.my_profile_id());
create policy "foremen read crew punches" on punches for select to authenticated using (timeclock.leads_job(job_id));
create policy "office reads punches" on punches for select to authenticated using (timeclock.is_office(company_id));

create policy "employees punch themselves" on punches for insert to authenticated with check (
  profile_id = timeclock.my_profile_id() and created_by = timeclock.my_profile_id()
  and source = 'phone' and timeclock.is_member(company_id)
);
create policy "foremen punch crew on their jobs" on punches for insert to authenticated with check (
  timeclock.leads_job(job_id) and created_by = timeclock.my_profile_id() and source in ('foreman', 'admin_edit')
);
create policy "office enters corrections" on punches for insert to authenticated with check (
  timeclock.is_office(company_id) and created_by = timeclock.my_profile_id() and source = 'admin_edit'
);
-- Voiding (trigger allows only voided/note to change).
create policy "foremen void on their jobs" on punches for update to authenticated using (timeclock.leads_job(job_id));
create policy "office voids" on punches for update to authenticated using (timeclock.is_office(company_id));
-- Kiosk punches arrive through the server with the service role after the
-- device token and PIN are checked, so no anon insert policy exists.

create policy "read own pings" on location_pings for select to authenticated using (profile_id = timeclock.my_profile_id());
create policy "foremen read crew pings" on location_pings for select to authenticated using (timeclock.leads_job(job_id));
create policy "office reads pings" on location_pings for select to authenticated using (timeclock.is_office(company_id));
create policy "employees send own pings" on location_pings for insert to authenticated with check (profile_id = timeclock.my_profile_id());

-- ── Timesheets ───────────────────────────────────────────────────────────

create policy "read own timesheets" on timesheets for select to authenticated using (profile_id = timeclock.my_profile_id());
create policy "foremen read crew timesheets" on timesheets for select to authenticated using (timeclock.in_my_crew(company_id, profile_id));
create policy "office reads timesheets" on timesheets for select to authenticated using (timeclock.is_office(company_id));
create policy "employees submit own" on timesheets for insert to authenticated with check (profile_id = timeclock.my_profile_id() and status in ('open', 'submitted'));
create policy "employees update own open" on timesheets for update to authenticated using (profile_id = timeclock.my_profile_id() and status = 'open') with check (status = 'submitted');
create policy "foremen approve crew" on timesheets for update to authenticated using (timeclock.in_my_crew(company_id, profile_id)) with check (status in ('open', 'submitted', 'foreman_approved'));
create policy "office approves" on timesheets for all to authenticated using (timeclock.is_office(company_id)) with check (timeclock.is_office(company_id));

create policy "read approvals of visible timesheets" on timesheet_approvals for select to authenticated using (exists (select 1 from timesheets t where t.id = timesheet_id));
create policy "approvers record approvals" on timesheet_approvals for insert to authenticated with check (by_profile_id = timeclock.my_profile_id());

-- ── Audit ────────────────────────────────────────────────────────────────

create policy "office reads audit" on audit_log for select to authenticated using (timeclock.is_office(company_id));
create policy "members append audit" on audit_log for insert to authenticated with check (timeclock.is_member(company_id) and actor_id = timeclock.my_profile_id());

-- ── Messaging ────────────────────────────────────────────────────────────

create policy "recipients read messages" on messages for select to authenticated using (timeclock.is_message_recipient(id));
create policy "senders read sent" on messages for select to authenticated using (timeclock.is_office(company_id) or sender_id = timeclock.my_profile_id());
create policy "office sends" on messages for insert to authenticated with check (timeclock.is_office(company_id) and sender_id = timeclock.my_profile_id());
create policy "foremen message their crews" on messages for insert to authenticated with check (
  sender_id = timeclock.my_profile_id() and timeclock.has_role(company_id, array['foreman']::app_role[])
  and audience_type in ('job', 'user') and (audience_job_id is null or timeclock.leads_job(audience_job_id))
);

create policy "read own deliveries" on message_deliveries for select to authenticated using (profile_id = timeclock.my_profile_id());
create policy "senders read deliveries" on message_deliveries for select to authenticated using (timeclock.sent_message(message_id, true));
create policy "mark own read" on message_deliveries for update to authenticated using (profile_id = timeclock.my_profile_id()) with check (profile_id = timeclock.my_profile_id());
create policy "senders create deliveries" on message_deliveries for insert to authenticated with check (timeclock.sent_message(message_id, false));

create policy "own notification prefs" on notification_preferences for all to authenticated using (profile_id = timeclock.my_profile_id()) with check (profile_id = timeclock.my_profile_id());

create policy "own push devices" on devices for all to authenticated using (kind = 'push' and profile_id = timeclock.my_profile_id()) with check (kind = 'push' and profile_id = timeclock.my_profile_id());
create policy "admins and foremen manage kiosks" on devices for all to authenticated using (kind = 'kiosk' and (timeclock.is_admin(company_id) or timeclock.leads_job(job_id)));

-- ── Integrations ─────────────────────────────────────────────────────────

create policy "admins manage integrations" on integration_connections for all to authenticated using (timeclock.is_admin(company_id)) with check (timeclock.is_admin(company_id));
create policy "office reads integrations" on integration_connections for select to authenticated using (timeclock.is_office(company_id));
create policy "admins manage external ids" on external_ids for all to authenticated using (timeclock.is_admin(company_id)) with check (timeclock.is_admin(company_id));
create policy "office reads external ids" on external_ids for select to authenticated using (timeclock.is_office(company_id));
create policy "office runs exports" on payroll_exports for all to authenticated using (timeclock.is_office(company_id)) with check (timeclock.is_office(company_id));

-- ── RPCs (callable via supabase.schema('timeclock').rpc() once exposed) ──

-- Foremen change only the two site-mode columns, through this function.
create function timeclock.set_site_modes(job uuid, new_offline offline_mode, new_gps gps_mode)
returns void language plpgsql security definer set search_path = timeclock as $$
begin
  if not (timeclock.leads_job(job) or timeclock.is_admin((select company_id from jobs where id = job))) then
    raise exception 'not allowed';
  end if;
  update jobs set offline_mode = new_offline, gps_mode = new_gps where id = job;
end $$;

create function timeclock.record_location_consent(company uuid)
returns void language sql security definer set search_path = timeclock as $$
  update memberships set location_consent_at = coalesce(location_consent_at, now())
  where company_id = company and profile_id = timeclock.my_profile_id();
$$;

-- Policies call the timeclock.* helpers as the signed-in role.
grant usage on schema timeclock to authenticated, anon;
grant execute on all functions in schema timeclock to authenticated;

-- Table privileges for signed-in users (custom schemas don't get Supabase's
-- default grants). RLS above decides which rows each user actually sees.
grant select, insert, update, delete on all tables in schema timeclock to authenticated;
grant usage, select on all sequences in schema timeclock to authenticated;
