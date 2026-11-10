// Prints SQL that loads the demo companies (the same data MemoryRepository
// uses) into the `timeclock` schema. Dates are relative to now.
//
//   npx tsx scripts/seed-demo-sql.ts > /tmp/demo-seed.sql
//
// IDs are derived deterministically from the demo ids, and every insert is
// `on conflict do nothing`, so running it twice changes nothing.

import { createHash } from "node:crypto";
import { buildSeed } from "../src/lib/data/memory/seed";

const s = buildSeed();

/** Stable UUID (v5-style) from a demo id like "u-dana". */
function uuid(id: string): string {
  const h = createHash("sha1").update(`timeclock-demo:${id}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function lit(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return `'${String(v).replace(/'/g, "''")}'`;
}

const id = (v: string | null) => (v ? lit(uuid(v)) : "null");
const out: string[] = ["begin;", "set local search_path = timeclock, extensions;"];
const insert = (table: string, cols: string[], rows: unknown[][]) => {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map((r) => `  (${r.join(", ")})`).join(",\n");
    out.push(`insert into ${table} (${cols.join(", ")}) values\n${chunk}\non conflict do nothing;`);
  }
};

insert("companies", ["id", "name", "slug", "app_name", "logo_path", "primary_color", "accent_color", "timezone", "labour_rule_set", "week_starts_on", "pay_period_type", "pay_period_anchor", "gps_mode_default"],
  s.companies.map((c) => [id(c.id), lit(c.name), lit(c.slug), lit(c.branding.appName), lit(c.branding.logoUrl), lit(c.branding.primaryColor), lit(c.branding.accentColor), lit(c.timezone), lit(c.labourRuleSet), c.weekStartsOn, lit(c.payPeriod.type), lit(c.payPeriod.anchorDate), lit(c.gpsModeDefault)]));

insert("profiles", ["id", "full_name", "email", "phone"], s.users.map((u) => [id(u.id), lit(u.name), lit(u.email), lit(u.phone)]));

insert("memberships", ["company_id", "profile_id", "role", "kiosk_pin_hash", "hourly_rate", "payroll_external_id", "active"],
  s.users.map((u) => [id(u.companyId), id(u.id), lit(u.role), `crypt(${lit(u.kioskPin)}, gen_salt('bf'))`, lit(u.hourlyRate), lit(u.payrollExternalId), lit(u.active)]));

insert("jobs", ["id", "company_id", "name", "code", "address", "lat", "lng", "geofence_radius_m", "geofence_enforcement", "require_qr", "qr_token", "offline_mode", "gps_mode", "labour_rule_override", "status"],
  s.jobs.map((j) => [id(j.id), id(j.companyId), lit(j.name), lit(j.code), lit(j.address), j.lat, j.lng, j.geofenceRadiusM, lit(j.geofenceEnforcement), lit(j.requireQr), lit(j.qrToken), lit(j.offlineMode), lit(j.gpsMode), lit(j.labourRuleOverride), lit(j.status)]));

insert("job_foremen", ["job_id", "profile_id"], s.jobs.flatMap((j) => j.foremanIds.map((f) => [id(j.id), id(f)])));

insert("cost_codes", ["id", "company_id", "code", "name"], s.costCodes.map((c) => [id(c.id), id(c.companyId), lit(c.code), lit(c.name)]));

insert("shifts", ["id", "company_id", "job_id", "profile_id", "starts_at", "ends_at", "cost_code_id", "notes"],
  s.shifts.map((sh) => [id(sh.id), id(sh.companyId), id(sh.jobId), id(sh.userId), lit(sh.start), lit(sh.end), id(sh.costCodeId), lit(sh.notes)]));

insert("punches", ["id", "company_id", "profile_id", "job_id", "type", "occurred_at", "received_at", "source", "gps_lat", "gps_lng", "gps_accuracy_m", "distance_m", "within_geofence", "qr_verified", "cost_code_id", "offline", "created_by", "voided", "note"],
  s.punches.map((p) => [id(p.id), id(p.companyId), id(p.userId), id(p.jobId), lit(p.type), lit(p.occurredAt), lit(p.receivedAt), lit(p.source), lit(p.gps?.lat), lit(p.gps?.lng), lit(p.gps?.accuracyM), lit(p.distanceM), lit(p.withinGeofence), lit(p.qrVerified), id(p.costCodeId), lit(p.offline), id(p.createdBy), lit(p.voided), lit(p.note)]));

insert("timesheets", ["id", "company_id", "profile_id", "period_start", "period_end", "status"],
  s.timesheets.map((t) => [id(t.id), id(t.companyId), id(t.userId), lit(t.periodStart), lit(t.periodEnd), lit(t.status)]));
for (const t of s.timesheets) {
  for (const a of t.approvals) {
    out.push(`insert into timesheet_approvals (timesheet_id, by_profile_id, role, status, at) select ${id(t.id)}, ${id(a.byUserId)}, ${lit(a.role)}, ${lit(a.status)}, ${lit(a.at)} where not exists (select 1 from timesheet_approvals where timesheet_id = ${id(t.id)});`);
  }
}

insert("messages", ["id", "company_id", "sender_id", "audience_type", "audience_job_id", "audience_user_id", "subject", "body", "channels", "created_at"],
  s.messages.map((m) => [id(m.id), id(m.companyId), id(m.senderId), lit(m.audience.type), m.audience.type === "job" ? id(m.audience.jobId) : "null", m.audience.type === "user" ? id(m.audience.userId) : "null", lit(m.subject), lit(m.body), `${lit(`{${m.channels.join(",")}}`)}::channel_key[]`, lit(m.createdAt)]));

insert("message_deliveries", ["message_id", "profile_id", "channel", "status"], s.deliveries.map((d) => [id(d.messageId), id(d.userId), lit(d.channel), lit(d.status)]));

out.push("commit;");
console.log(out.join("\n\n"));
