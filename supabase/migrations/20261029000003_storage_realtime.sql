-- Storage buckets, Realtime publication and kiosk helpers.

set search_path = timeclock, extensions, public;

-- ── Storage ──────────────────────────────────────────────────────────────
-- Paths are prefixed with the company id: timeclock-branding/<company_id>/logo.png,
-- timeclock-exports/<company_id>/<export_id>.csv. Both buckets are private.

insert into storage.buckets (id, name, public) values
  ('timeclock-branding', 'timeclock-branding', false),
  ('timeclock-exports', 'timeclock-exports', false)
on conflict (id) do nothing;

create policy "members read branding" on storage.objects for select to authenticated
  using (bucket_id = 'timeclock-branding' and timeclock.is_member(((storage.foldername(name))[1])::uuid));
create policy "admins write branding" on storage.objects for insert to authenticated
  with check (bucket_id = 'timeclock-branding' and timeclock.is_admin(((storage.foldername(name))[1])::uuid));
create policy "admins replace branding" on storage.objects for update to authenticated
  using (bucket_id = 'timeclock-branding' and timeclock.is_admin(((storage.foldername(name))[1])::uuid));
create policy "office reads exports" on storage.objects for select to authenticated
  using (bucket_id = 'timeclock-exports' and timeclock.is_office(((storage.foldername(name))[1])::uuid));

-- ── Realtime ─────────────────────────────────────────────────────────────
-- Dashboards and inboxes subscribe to these instead of polling. RLS still
-- applies to what each subscriber receives.

alter publication supabase_realtime add table punches, message_deliveries, shifts;

-- ── Kiosk ────────────────────────────────────────────────────────────────

-- Identify a worker at a kiosk by PIN. Called by the server (service role)
-- after it has verified the kiosk device token for that job.
create function timeclock.kiosk_identify(company uuid, pin text)
returns table (profile_id uuid, full_name text)
language sql stable security definer set search_path = timeclock, extensions as $$
  select p.id, p.full_name
  from memberships m join profiles p on p.id = m.profile_id
  where m.company_id = company and m.active and m.kiosk_pin_hash = crypt(pin, m.kiosk_pin_hash)
  limit 1
$$;
revoke execute on function timeclock.kiosk_identify(uuid, text) from public, anon, authenticated;
grant execute on function timeclock.kiosk_identify(uuid, text) to service_role;

create function timeclock.set_kiosk_pin(membership uuid, pin text)
returns void language plpgsql security definer set search_path = timeclock, extensions as $$
begin
  if pin !~ '^\d{4,6}$' then raise exception 'PIN must be 4-6 digits'; end if;
  if not timeclock.is_admin((select company_id from memberships where id = membership)) then raise exception 'not allowed'; end if;
  update memberships set kiosk_pin_hash = crypt(pin, gen_salt('bf')) where id = membership;
end $$;

-- ── Scheduled jobs (optional: pg_cron instead of Vercel Cron) ────────────
-- select cron.schedule('clock-out-reminders', '*/15 * * * *', $$ select net.http_post(url := '<edge function url>/clock-out-reminders') $$);
-- select cron.schedule('notify-dispatch',     '* * * * *',    $$ select net.http_post(url := '<edge function url>/notify-dispatch') $$);
-- select cron.schedule('payroll-sync',        '15 7 * * *',   $$ select net.http_post(url := '<edge function url>/payroll-sync') $$);
