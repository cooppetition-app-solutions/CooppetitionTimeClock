# Architecture

White-label, multi-company time clock for construction crews. Employees punch
in and out on their phone or on a site kiosk. Foremen run their crews. The
office approves time and sends it to payroll.

This document covers where each piece lives, what's built, what's only
scaffolded, and the steps to connect each service.

## Status at a glance

| Area | Status |
| --- | --- |
| App (all four roles, every screen) | **Built.** Runs today on built-in demo data. |
| Hours, overtime, break rules (16 jurisdictions) | **Built.** Unit-tested. |
| GPS geofence, QR check-in, kiosk PIN pad | **Built.** |
| Offline queue (per-site setting) | **Built.** IndexedDB on device, idempotent sync. |
| Continuous GPS (per-job setting) | **Built** while the app is open. Background tracking needs a native app (see below). |
| CSV payroll export | **Built.** Works with any payroll service. |
| Database schema, RLS, storage, realtime | **Live** in Supabase project `cooppetition-portfolio-tracking` (us-east-1), in its own `timeclock` schema. Tested on Postgres 16 first. |
| Supabase data adapter (`SupabaseRepository`) | **Built and live.** Production runs with `DATA_BACKEND=supabase`; `memory` is still available for local work. |
| Sign-in (Supabase Auth) | **Stub.** Hosted demo: one admin email + password (`ACCESS_EMAIL` / `ACCESS_PASSWORD`) guards the whole site, then you pick a sample person on `/login`. |
| QuickBooks, Wagepoint, Dayforce, ADP | **Scaffolded.** Interface, env var names and a payload preview. No network calls. |
| SMS, email, push | **Scaffolded.** Deliveries are logged as `not_connected`. |
| Webhooks, cron jobs, Edge Functions | **Scaffolded.** Routes exist and return 501 / `not_connected`. |

## Where things are housed

```
┌──────────────────────────────── Vercel ────────────────────────────────┐
│ Next.js app (this repo)                                                │
│   Pages (React Server Components)      /me  /crew  /admin  /kiosk      │
│   API routes                           /api/punches   (phone + kiosk + │
│                                                       offline sync)    │
│                                        /api/location  (continuous GPS) │
│                                        /api/payroll/export             │
│                                        /api/webhooks/:provider  (501)  │
│                                        /api/cron/:job           (stub) │
│   Service layer   src/lib/services/*   all business rules              │
│   Domain          src/lib/domain/*     pure logic: hours, OT, geofence │
│   Data layer      src/lib/data/*       Repository interface            │
│                     ├─ MemoryRepository   (demo, active)               │
│                     └─ SupabaseRepository (live) ────────┐             │
│   Integrations    src/lib/integrations/*                 │             │
│                     ├─ payroll/   csv ✔ qbo wagepoint dayforce adp     │
│                     └─ messaging/ in-app ✔ sms email push              │
└──────────────────────────────────────────────────────────│─────────────┘
                                                           │
┌──────────────────────── Supabase (ca-central-1) ─────────▼─────────────┐
│ Postgres     supabase/migrations/*   20 tables, RLS on every table     │
│ Auth         phone OTP (crews), email magic link (office)              │
│ Storage      branding/<company_id>/…   exports/<company_id>/…          │
│ Realtime     punches, message_deliveries, shifts                       │
│ Vault        per-company OAuth tokens / API keys                       │
│ Edge Fns     supabase/functions/notify-dispatch, payroll-sync (stubs)  │
└────────────────────────────────────────────────────────────────────────┘
        ▲                         ▲                          ▲
   phones (web app,          site kiosk tablet         payroll / SMS / email
   installable, offline)     (PIN pad, offline)        providers (not connected)
```

**Why this stack:** it matches the Adminspace and Quotes apps (Next.js +
Supabase on Vercel), so there's one set of tools to run. Supabase's Canadian
region keeps employee location and pay data in Canada. Postgres suits payroll
reporting better than a document database.

## Multi-tenancy and white-label

- Every tenant-owned table has `company_id`. RLS policies restrict every
  read and write to the caller's companies and role. `supabase/tests/rls.test.sql`
  checks tenant isolation and each role's limits.
- Branding (`app_name`, logo, primary and accent colours) is set per company
  and applied as CSS variables (`--brand`, `--accent`). Every themed element
  uses `bg-brand` / `text-brand`, so a client's colours reach the phone app,
  kiosk and admin screens without code changes.
- Tenant routing (planned): `companies.slug` gives `<slug>.yourdomain.com`
  and `companies.custom_domain` supports a client's own domain. Add both as
  Vercel domains, then resolve the company from the `Host` header in
  middleware. Today the company comes from the signed-in user.

## Roles

| Capability | Employee | Foreman | Office/Payroll | Owner/Admin |
| --- | :-: | :-: | :-: | :-: |
| Clock self in/out, breaks, cost code | ✔ | ✔ | ✔ | ✔ |
| See own schedule, hours, messages; submit timesheet | ✔ | ✔ | ✔ | ✔ |
| See crew status, punch crew in/out, fix missed punches | | own jobs | ✔ (fix) | ✔ |
| Set offline and GPS mode per site; launch kiosk | | own jobs | | ✔ |
| Approve timesheets | | crew (first step) | ✔ (final) | ✔ (final) |
| Message | | own job crews / individuals | everyone | everyone |
| On-site dashboard, people list | | | ✔ | ✔ |
| Payroll export | | | ✔ | ✔ |
| Schedule, jobs, people, branding, rules, integrations | | | | ✔ |

The same matrix lives in `src/lib/domain/permissions.ts` (UI and server
actions) and `supabase/migrations/…_rls_policies.sql` (database).

## Time rules

- **Punches are immutable.** Fixes are new `admin_edit` punches, or voids
  that need a reason. Every change goes to `audit_log`, which is append-only
  and enforced by a trigger.
- **Hours engine** (`src/lib/domain/hours.ts`): pairs punches into work
  segments, deducts unpaid breaks, then charges each minute against running
  daily and weekly counters. Overtime therefore lands on the hours actually
  worked past the threshold, on the right job and cost code. Weekly overtime
  counts only regular minutes, so daily overtime is never counted twice.
- **Labour rule presets** (`src/lib/domain/labour-rules.ts`) cover all 13
  provinces and territories, federally regulated work, US federal (FLSA) and
  California. Each company picks one, and a job can override it (for example
  a crew working in another province). These are starting defaults, not legal
  advice.
- **Timesheet workflow:** open → submitted → foreman approved → approved →
  exported. A punch change inside an approved period sends it back to
  "submitted" automatically. Exported periods are locked by a database
  trigger.

## On-site verification

- **GPS geofence per job:** a radius in metres, plus a setting to either
  *flag* or *block* phone punches made off site. A fix counts as inside if
  its accuracy circle overlaps the fence, so poor GPS at the gate isn't
  wrongly flagged.
- **QR per job:** a printable code that opens `/punch/qr/<token>`. Jobs can
  require it for phone clock-in. The code can be replaced if a photo of it
  gets passed around.
- **Kiosk:** a foreman or admin locks a tablet to a site. Workers punch in
  with their PIN. Exiting needs a foreman PIN. Production replaces the
  cookie with a device token (`devices` table) and hashed PINs
  (`public.kiosk_identify`).

## Offline and location settings (per site)

| Setting | Options | Who sets it |
| --- | --- | --- |
| Offline mode | **Save and sync later**: punch stored on the device with its real time and GPS, sent when signal returns, de-duplicated by `client_id`, marked `offline` for review. **Require connection**: no punch without signal. | Foreman (own sites) or admin |
| GPS mode | **At punches only** (default), or **continuous while clocked in** | Admin sets the company default; foreman or admin per job |

Offline punches older than 72 hours, or with a clock more than 2 minutes
ahead, are rejected and the worker is told to see their foreman. The
service worker (`public/sw.js`) keeps the app shell loading with no signal.

**Continuous GPS limit:** a web app can only read location while it's open
and in the foreground. The breadcrumbs (`location_pings`) and the setting
are in place. True background tracking with the screen off needs a native
wrapper (Capacitor or Expo) using the same `/api/punches` and
`/api/location` endpoints. Continuous tracking also needs clear written
notice to employees; Ontario employers with 25 or more staff need an
electronic monitoring policy.

## Integrations

### Payroll: `src/lib/integrations/payroll/`

`PayrollProvider.exportBatch(batch)` receives a provider-neutral
`PayrollBatch`: one row per employee, day, job and cost code, with
regular, overtime and double-time hours, built from **approved timesheets
only**.

| Provider | File | Auth | Env var names |
| --- | --- | --- | --- |
| CSV (works now) | `csv.ts` | none | none |
| QuickBooks Online | `providers.ts` | OAuth2 | `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REDIRECT_URI`, `QUICKBOOKS_ENVIRONMENT` |
| Wagepoint | `providers.ts` | API key | `WAGEPOINT_API_KEY`, `WAGEPOINT_COMPANY_ID` |
| Dayforce (Ceridian) | `providers.ts` | OAuth2 | `DAYFORCE_CLIENT_ID`, `DAYFORCE_CLIENT_SECRET`, `DAYFORCE_COMPANY_NAMESPACE` |
| ADP | `providers.ts` | OAuth2 + mTLS | `ADP_CLIENT_ID`, `ADP_CLIENT_SECRET`, `ADP_CERT_PEM`, `ADP_KEY_PEM` |

**To connect one:**
1. Register a developer app with the provider and put the app-level
   credentials in Vercel env vars.
2. Add an OAuth callback route (`/api/integrations/<provider>/callback`) that
   stores the company's tokens in **Supabase Vault** and writes an
   `integration_connections` row (status `configured`, non-secret settings
   such as the QuickBooks realm ID).
3. Map employees and jobs to provider IDs in `external_ids`. A "sync
   employees" step can pre-fill this.
4. Replace the placeholder `exportBatch` with real calls, run from the
   `payroll-sync` job, not inside a page request.
5. Add the provider's webhook handler and signature check in
   `src/app/api/webhooks/[provider]/route.ts`.

### Messaging: `src/lib/integrations/messaging/channels.ts`

| Channel | Today | Suggested service | Env var names |
| --- | --- | --- | --- |
| In-app | **Works** | built in (Supabase Realtime when connected) | none |
| SMS | logged `not_connected` | Twilio (Canadian number, STOP handling) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` |
| Email | logged `not_connected` | Resend or Postmark | `EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM_ADDRESS` |
| Push | logged `not_connected` | Web Push (VAPID); FCM/APNs if a native app is added | `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |

**To connect one:** change the channel's `send()` to insert an
`integration_outbox` row rather than sending inline, then implement the
send in `supabase/functions/notify-dispatch`. It should respect
`notification_preferences` (on/off and quiet hours) and SMS opt-outs. Shift
changes already trigger notifications (`schedule-service.ts`).

### Background jobs

Stubs live in `src/app/api/cron/[job]/route.ts` (Vercel Cron) and
`supabase/functions/*` (Edge Functions with pg_cron). Use one or the other.

| Job | Schedule | Purpose |
| --- | --- | --- |
| `clock-out-reminders` | every 15 min | push/SMS anyone still clocked in 30 min after shift end |
| `auto-close-shifts` | nightly | flag (never silently close) punches open > 16 h |
| `notify-dispatch` | every minute | drain the messaging outbox |
| `payroll-sync` | nightly | push approved periods to connected providers |

When ready, add this to a `vercel.json`. Every-minute schedules need a paid
Vercel plan, which is why the file isn't committed yet:

```json
{
  "crons": [
    { "path": "/api/cron/clock-out-reminders", "schedule": "*/15 * * * *" },
    { "path": "/api/cron/auto-close-shifts", "schedule": "10 8 * * *" },
    { "path": "/api/cron/notify-dispatch", "schedule": "* * * * *" },
    { "path": "/api/cron/payroll-sync", "schedule": "15 9 * * *" }
  ]
}
```

## Database connection (how it works today)

```
Next.js server ──HTTPS──▶ Edge Function `timeclock-db` ──▶ Postgres, schema `timeclock`
 (Vercel)      x-timeclock-key      (Supabase)         runs as role `timeclock_app`
```

- **Why an Edge Function:** Vercel can't reach Supabase's direct Postgres host
  (IPv6 only), and this keeps database credentials out of Vercel entirely. The
  function uses the `SUPABASE_DB_URL` that Supabase injects.
- **Shared project:** the app lives in the `timeclock` schema of the
  `cooppetition-portfolio-tracking` project, next to that project's own tables.
  `timeclock_app` can reach the `timeclock` schema and nothing else, which is
  checked in `supabase/tests/rls.test.sql`. Data is in us-east-1, not Canada;
  moving to a dedicated ca-central-1 project later is a `supabase db push`
  plus a data copy.
- **Keys:** Vercel holds `TIMECLOCK_DB_KEY`. The database stores only its
  SHA-256 in `timeclock_private.server_keys`, a schema with no API grants. To
  rotate it, insert a new hash, set the new key in Vercel, redeploy, then set
  `revoked_at` on the old row.
- **App settings:** `DATA_BACKEND=supabase`, `TIMECLOCK_DB_URL` (the function's
  URL) and `TIMECLOCK_DB_KEY`.
- **Kiosk PINs:** stored as bcrypt hashes and never read back, so the
  sign-in picker no longer shows them. Demo PINs are in the README.
- **Sample data:** `npx tsx scripts/seed-demo-sql.ts` prints SQL for the
  two demo companies, with dates relative to today. Running it again is a
  no-op.

## Moving to real sign-in (Supabase Auth)

1. In Auth settings, enable phone sign-in (an SMS provider such as Twilio)
   and email magic links.
2. Expose the `timeclock` schema to the API (Settings → API → Exposed schemas).
3. `npm i @supabase/supabase-js @supabase/ssr`. Replace `getSession()` in
   `src/lib/auth/session.ts` with `supabase.auth.getUser()` plus a membership
   lookup, and link `profiles.auth_user_id`.
4. Run user requests through the signed-in user's client, so the RLS policies
   in `…_rls_policies.sql` apply per person. Keep the Edge Function for
   background jobs and kiosk punches.
5. Remove the demo gate: `src/lib/auth/access-gate.ts`, the gate in
   `src/middleware.ts` and `src/app/access/`.
6. Optional: swap `AutoRefresh` for Realtime subscriptions on `punches` and
   `message_deliveries`.

## Hosted demo environment

Vercel project `cooppetition-timeclock` (team "Jeff's Projects") deploys
`main` automatically.

- `src/middleware.ts` sends every request to `/access` until the visitor
  enters `ACCESS_EMAIL` and `ACCESS_PASSWORD` (Vercel env vars). The
  deployed site refuses to serve if either is missing. Cron and webhook
  routes skip the gate because they carry their own auth.
- Data is saved in Supabase, so changes persist across visits and devices.
- To rotate the password, change `ACCESS_PASSWORD` in Vercel and redeploy.
  Everyone is signed out.

## Testing

| Command | What it checks |
| --- | --- |
| `npm test` | hours, overtime (Ontario, BC), breaks, geofence, DST, pay periods, role matrix |
| `npm run typecheck` | TypeScript |
| `npm run build` | production build |
| `supabase/tests/rls.test.sql` | tenant isolation, role limits, message visibility, immutable punches, no double-booking, server role fenced to its schema |
