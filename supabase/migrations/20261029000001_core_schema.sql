-- TimeClock core schema (multi-tenant, white-label).
--
-- Target: Supabase Postgres, region ca-central-1 (Canada) for data residency.
-- All objects live in the `timeclock` schema. Every tenant-owned row carries company_id, and Row Level Security (see the
-- next migration) scopes every query to the caller's companies and role.
--
-- TypeScript mirror: src/lib/domain/types.ts. Naming: snake_case here,
-- camelCase in TS (e.g. occurred_at ↔ occurredAt).

create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;   -- no-overlap constraint on shifts

-- Everything lives in its own schema, so the app can share a Supabase
-- project with other apps without name clashes.
create schema if not exists timeclock;
set search_path = timeclock, extensions, public;

-- ── Enums ────────────────────────────────────────────────────────────────

create type app_role             as enum ('owner_admin', 'office_payroll', 'foreman', 'employee');
create type offline_mode         as enum ('queue', 'require_online');
create type gps_mode             as enum ('punch_only', 'continuous');
create type geofence_enforcement as enum ('flag', 'block');
create type job_status           as enum ('active', 'on_hold', 'complete');
create type punch_type           as enum ('in', 'out', 'break_start', 'break_end');
create type punch_source         as enum ('phone', 'kiosk', 'foreman', 'admin_edit');
create type timesheet_status     as enum ('open', 'submitted', 'foreman_approved', 'approved', 'exported');
create type channel_key          as enum ('in_app', 'sms', 'email', 'push');
create type delivery_status      as enum ('delivered', 'queued', 'not_connected', 'failed');
create type pay_period_type      as enum ('weekly', 'biweekly');
create type integration_kind     as enum ('payroll', 'messaging');
create type integration_status   as enum ('not_connected', 'configured', 'error');
create type outbox_status        as enum ('pending', 'sending', 'sent', 'failed', 'dead');

-- ── Tenants ──────────────────────────────────────────────────────────────

create table companies (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),   -- subdomain: <slug>.yourtimeclock.com
  custom_domain       text unique,                                               -- optional white-label domain
  -- branding (TS: Company.branding)
  app_name            text not null,
  logo_path           text,                                                      -- storage: branding/<company_id>/logo.*
  primary_color       text not null default '#2f4f4f' check (primary_color ~* '^#[0-9a-f]{6}$'),
  accent_color        text not null default '#e8a33d' check (accent_color ~* '^#[0-9a-f]{6}$'),
  -- time rules
  timezone            text not null default 'America/Toronto',
  labour_rule_set     text not null default 'CA-ON',                             -- key into src/lib/domain/labour-rules.ts
  week_starts_on      smallint not null default 0 check (week_starts_on between 0 and 6),
  pay_period_type     pay_period_type not null default 'biweekly',
  pay_period_anchor   date not null,
  gps_mode_default    gps_mode not null default 'punch_only',
  created_at          timestamptz not null default now()
);

-- A person. Crews without phones (kiosk-only) have no auth user, so the
-- link to auth.users is optional.
create table profiles (
  id                  uuid primary key default gen_random_uuid(),
  auth_user_id        uuid unique references auth.users (id) on delete set null,
  full_name           text not null,
  email               text,
  phone               text,                                                      -- E.164, used for SMS sign-in + texts
  created_at          timestamptz not null default now()
);

-- A person's role at a company (TS: User = profile + membership).
create table memberships (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies (id) on delete cascade,
  profile_id          uuid not null references profiles (id) on delete cascade,
  role                app_role not null default 'employee',
  kiosk_pin_hash      text,                                                      -- crypt(pin, gen_salt('bf'))
  hourly_rate         numeric(10, 2),
  payroll_external_id text,
  active              boolean not null default true,
  location_consent_at timestamptz,
  created_at          timestamptz not null default now(),
  unique (company_id, profile_id)
);
create index on memberships (profile_id);

-- ── Jobs, sites, cost codes ──────────────────────────────────────────────

create table jobs (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references companies (id) on delete cascade,
  name                  text not null,
  code                  text not null,
  address               text not null,
  lat                   double precision not null check (lat between -90 and 90),
  lng                   double precision not null check (lng between -180 and 180),
  geofence_radius_m     integer not null default 150 check (geofence_radius_m between 25 and 5000),
  geofence_enforcement  geofence_enforcement not null default 'flag',
  require_qr            boolean not null default false,
  qr_token              text not null unique default encode(gen_random_bytes(16), 'hex'),
  offline_mode          offline_mode not null default 'queue',
  gps_mode              gps_mode,                                                -- null = company default
  labour_rule_override  text,                                                    -- null = company rule set
  status                job_status not null default 'active',
  created_at            timestamptz not null default now(),
  unique (company_id, code)
);

create table job_foremen (
  job_id      uuid not null references jobs (id) on delete cascade,
  profile_id  uuid not null references profiles (id) on delete cascade,
  primary key (job_id, profile_id)
);

create table cost_codes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies (id) on delete cascade,
  code        text not null,
  name        text not null,
  active      boolean not null default true,
  unique (company_id, code)
);

-- ── Schedule ─────────────────────────────────────────────────────────────

create table shifts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies (id) on delete cascade,
  job_id        uuid not null references jobs (id) on delete cascade,
  profile_id    uuid not null references profiles (id) on delete cascade,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  cost_code_id  uuid references cost_codes (id) on delete set null,
  notes         text,
  created_by    uuid references profiles (id),
  created_at    timestamptz not null default now(),
  check (ends_at > starts_at),
  -- One person can't be double-booked.
  exclude using gist (profile_id with =, tstzrange(starts_at, ends_at) with &&)
);
create index on shifts (company_id, starts_at);
create index on shifts (job_id, starts_at);

-- ── Time ─────────────────────────────────────────────────────────────────

-- Punches are effectively immutable: only `voided`/`note` can change
-- (trigger below). Corrections are new rows with source 'admin_edit'.
create table punches (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies (id) on delete cascade,
  profile_id         uuid not null references profiles (id) on delete cascade,
  job_id             uuid not null references jobs (id),
  type               punch_type not null,
  occurred_at        timestamptz not null,                                      -- device time for offline punches
  received_at        timestamptz not null default now(),
  source             punch_source not null,
  gps_lat            double precision,
  gps_lng            double precision,
  gps_accuracy_m     integer,
  distance_m         integer,
  within_geofence    boolean,
  qr_verified        boolean not null default false,
  cost_code_id       uuid references cost_codes (id) on delete set null,
  offline            boolean not null default false,
  client_id          text,                                                      -- device-generated; makes offline sync idempotent
  created_by         uuid not null references profiles (id),
  voided             boolean not null default false,
  replaces_punch_id  uuid references punches (id),
  note               text,
  unique (company_id, client_id),
  check (occurred_at <= received_at + interval '2 minutes'),
  check ((gps_lat is null) = (gps_lng is null))
);
create index on punches (company_id, profile_id, occurred_at);
create index on punches (job_id, occurred_at);

create table location_pings (
  id               bigint generated always as identity primary key,
  company_id       uuid not null references companies (id) on delete cascade,
  profile_id       uuid not null references profiles (id) on delete cascade,
  job_id           uuid not null references jobs (id) on delete cascade,
  at               timestamptz not null default now(),
  gps_lat          double precision not null,
  gps_lng          double precision not null,
  gps_accuracy_m   integer not null,
  within_geofence  boolean not null
);
create index on location_pings (company_id, profile_id, at);

create table timesheets (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies (id) on delete cascade,
  profile_id    uuid not null references profiles (id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  status        timesheet_status not null default 'open',
  updated_at    timestamptz not null default now(),
  unique (company_id, profile_id, period_start),
  check (period_end >= period_start)
);

create table timesheet_approvals (
  id            bigint generated always as identity primary key,
  timesheet_id  uuid not null references timesheets (id) on delete cascade,
  by_profile_id uuid not null references profiles (id),
  role          app_role not null,
  status        timesheet_status not null,
  reason        text,
  at            timestamptz not null default now()
);

-- Append-only (no update/delete policies, plus a trigger).
create table audit_log (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references companies (id) on delete cascade,
  actor_id    uuid references profiles (id),
  action      text not null,
  entity      text not null,
  entity_id   text not null,
  reason      text,
  before      jsonb,
  after       jsonb,
  at          timestamptz not null default now()
);
create index on audit_log (company_id, entity, entity_id);

-- ── Messaging ────────────────────────────────────────────────────────────

create table messages (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies (id) on delete cascade,
  sender_id        uuid references profiles (id),                               -- null = system notification
  audience_type    text not null check (audience_type in ('company', 'job', 'user')),
  audience_job_id  uuid references jobs (id) on delete set null,
  audience_user_id uuid references profiles (id) on delete set null,
  subject          text,
  body             text not null check (length(body) between 1 and 4000),
  channels         channel_key[] not null default '{in_app}',
  created_at       timestamptz not null default now()
);

create table message_deliveries (
  message_id  uuid not null references messages (id) on delete cascade,
  profile_id  uuid not null references profiles (id) on delete cascade,
  channel     channel_key not null,
  status      delivery_status not null,
  provider_message_id text,                                                     -- e.g. Twilio SID, for receipts
  read_at     timestamptz,
  primary key (message_id, profile_id, channel)
);
create index on message_deliveries (profile_id) where channel = 'in_app';

create table notification_preferences (
  profile_id   uuid not null references profiles (id) on delete cascade,
  channel      channel_key not null,
  enabled      boolean not null default true,
  quiet_start  time,                                                            -- no SMS/push between these local times
  quiet_end    time,
  primary key (profile_id, channel)
);

-- Kiosk tablets and push subscriptions.
create table devices (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references companies (id) on delete cascade,
  kind               text not null check (kind in ('kiosk', 'push')),
  job_id             uuid references jobs (id) on delete cascade,               -- kiosk: the site it is locked to
  profile_id         uuid references profiles (id) on delete cascade,           -- push: whose phone
  token_hash         text unique,                                               -- kiosk device token (sha256)
  push_subscription  jsonb,                                                     -- Web Push endpoint + keys
  created_by         uuid references profiles (id),
  last_seen_at       timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now()
);

-- ── Integrations ─────────────────────────────────────────────────────────

-- One row per company per connected provider. Secrets (OAuth tokens, API
-- keys) are NEVER stored here: they live in Supabase Vault, referenced by id.
create table integration_connections (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies (id) on delete cascade,
  provider         text not null,                                               -- 'quickbooks' | 'wagepoint' | 'ceridian' | 'adp' | 'twilio' | ...
  kind             integration_kind not null,
  status           integration_status not null default 'not_connected',
  settings         jsonb not null default '{}',                                 -- non-secret: realm id, payroll group code...
  vault_secret_id  uuid,                                                        -- vault.secrets.id
  connected_by     uuid references profiles (id),
  connected_at     timestamptz,
  last_sync_at     timestamptz,
  last_error       text,
  unique (company_id, provider)
);

-- Employee / job IDs in each external system.
create table external_ids (
  company_id   uuid not null references companies (id) on delete cascade,
  provider     text not null,
  entity       text not null check (entity in ('profile', 'job', 'cost_code')),
  local_id     uuid not null,
  external_id  text not null,
  primary key (company_id, provider, entity, local_id)
);

-- Work for background jobs (SMS/email/push sends, payroll pushes). Request
-- handlers only insert here; supabase/functions/* or /api/cron/* drain it.
create table integration_outbox (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references companies (id) on delete cascade,
  provider    text not null,
  kind        text not null,                                                    -- 'sms.send' | 'email.send' | 'push.send' | 'payroll.push'
  payload     jsonb not null,
  status      outbox_status not null default 'pending',
  attempts    integer not null default 0,
  run_after   timestamptz not null default now(),
  last_error  text,
  created_at  timestamptz not null default now()
);
create index on integration_outbox (status, run_after) where status in ('pending', 'failed');

create table payroll_exports (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies (id) on delete cascade,
  provider      text not null,
  period_start  date not null,
  period_end    date not null,
  status        text not null check (status in ('succeeded', 'not_connected', 'failed')),
  row_count     integer not null default 0,
  file_path     text,                                                           -- storage: exports/<company_id>/<id>.csv
  created_by    uuid references profiles (id),
  created_at    timestamptz not null default now()
);

-- ── Integrity triggers ───────────────────────────────────────────────────

-- Punches: only voided/note may change after insert.
create function timeclock.punches_guard() returns trigger language plpgsql as $$
begin
  if (new.company_id, new.profile_id, new.job_id, new.type, new.occurred_at, new.source, new.created_by)
     is distinct from (old.company_id, old.profile_id, old.job_id, old.type, old.occurred_at, old.source, old.created_by) then
    raise exception 'punches are immutable; void and add a correction instead';
  end if;
  if old.voided and not new.voided then
    raise exception 'a voided punch cannot be restored';
  end if;
  return new;
end $$;
create trigger punches_guard before update on punches for each row execute function timeclock.punches_guard();

create function timeclock.append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger audit_log_append_only before update or delete on audit_log for each row execute function timeclock.append_only();

-- Exported timesheets are locked.
create function timeclock.timesheets_guard() returns trigger language plpgsql as $$
begin
  if old.status = 'exported' and new.status <> 'exported' then
    raise exception 'exported timesheets are locked';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger timesheets_guard before update on timesheets for each row execute function timeclock.timesheets_guard();
