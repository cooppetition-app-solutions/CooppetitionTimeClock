# TimeClock

A white-label time clock for construction companies. Crews clock in and out
of the jobs they're scheduled on, from their phone or a site kiosk. Foremen
run their crews. The office schedules, approves time and exports it to
payroll. One deployment serves many companies, each with its own name, logo
and colours.

Built by Co-oppetition Consulting. Next.js + Supabase on Vercel.

## What's in it

**Employees** (phone, installable web app)
- Today's shifts and a two-week schedule, with directions
- Clock in, breaks and clock out on assigned jobs, choosing a task or cost code
- GPS check against the site geofence, or a QR scan at the gate
- Works with no signal on sites that allow it: punches are saved on the
  phone and sync later
- Hours by day (regular, overtime, double time), timesheet submission and messages

**Site kiosk** (shared tablet): PIN pad for crews without phones, locked
to one site, works offline on "save and sync" sites

**Foremen**
- Live crew status with flags: off site, missed clock-out, not clocked in,
  still on the clock after shift end
- Punch crew in or out, add missed punches and void wrong ones (with a
  reason and an audit trail)
- First-step timesheet approval
- Per-site settings: offline behaviour, GPS mode, QR code, kiosk mode

**Office / Payroll**: on-site dashboard, final timesheet approval, payroll
export (CSV works now; QuickBooks, Wagepoint, Dayforce and ADP are
scaffolded), messaging

**Owner / Admin**: everything above, plus scheduling (with worker
notifications), jobs and sites, cost codes, people and roles, branding,
labour rules (every province and territory plus US) and integrations

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000. The app runs on built-in demo data: two
companies (Northline Builders, Toronto, Ontario rules; Ridgeview
Contracting, Vancouver, BC rules) with jobs, crews, three weeks of punches
and an approved pay period. Pick any person on the sign-in page to see their
role. Kiosk PINs are shown there too.

The hosted version (Vercel) saves to a live Supabase database instead, so
changes persist, and PINs are stored hashed and not shown. Demo kiosk PINs:

| Person | Company | Role | PIN |
| --- | --- | --- | --- |
| Dana Reyes | Northline | Owner / Admin | 1001 |
| Priya Shah | Northline | Office / Payroll | 1002 |
| Marco Bianchi, Sam Okafor | Northline | Foreman | 2001, 2002 |
| Tyler Chen, Aisha Mohamed, Ben Kowalski, Jordan Lee, Ravi Patel | Northline | Employee | 3001–3005 |
| Claire Dubois / Hank Morrison | Ridgeview | Owner / Foreman | 1001 / 2001 |
| Mei Tanaka, Oscar Silva | Ridgeview | Employee | 3001, 3002 |

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run build
```

## Connecting the real services

Nothing external is connected yet. That was deliberate for this first build.
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains where each piece is
housed (Vercel for the app; Supabase in Canada for the database, auth,
storage and realtime) and gives the steps to connect the database, sign-in,
payroll providers, SMS, email, push, webhooks and background jobs.

## Layout

```
src/app/            pages: /me (employee) /crew (foreman) /admin (office, admin) /kiosk /punch/qr
src/app/api/        punches, location, payroll export, webhooks (stub), cron (stub)
src/app/actions/    server actions behind every form
src/lib/domain/     pure logic: hours + overtime engine, labour rules, geofence, permissions
src/lib/services/   business rules (punching, timesheets, payroll, messaging, schedule)
src/lib/data/       Repository interface; memory (demo) and Supabase (stub) adapters
src/lib/integrations/  payroll providers and messaging channels
supabase/           migrations (schema, RLS, storage), RLS tests, Edge Function stubs
docs/               architecture and decisions
```
