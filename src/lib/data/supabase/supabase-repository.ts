// SupabaseRepository — the production data layer.
//
// Implements the same Repository interface as MemoryRepository against the
// `timeclock` schema (supabase/migrations/). Queries go through the
// timeclock-db Edge Function (see db-client.ts), which runs them as the
// `timeclock_app` role. Enable with DATA_BACKEND=supabase plus
// TIMECLOCK_DB_URL / TIMECLOCK_DB_KEY.
//
// Notes on the mapping:
//   - A User is a profile + its membership. User.id is the profile id.
//   - Kiosk PINs are stored as bcrypt hashes and never read back, so
//     User.kioskPin is always "" from this repository.
//   - Timestamps come back as ISO strings; dates and numerics are cast in SQL.

import type { NewRecord, Repository } from "../repository";
import type {
  AuditEntry, Company, CostCode, IntegrationConnection, Job, LocationPing, Message, MessageDelivery, PayrollExport, Punch,
  Shift, Timesheet, User,
} from "../../domain/types";
import { batch, query, setClause } from "./db-client";

// ── Row → domain mappers ────────────────────────────────────────────────

const COMPANY_COLS = `id, name, slug, app_name, logo_path, primary_color, accent_color, timezone, labour_rule_set,
  week_starts_on, pay_period_type, pay_period_anchor::text as pay_period_anchor, gps_mode_default`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const toCompany = (r: Row): Company => ({
  id: r.id, name: r.name, slug: r.slug,
  branding: { appName: r.app_name, logoUrl: r.logo_path, primaryColor: r.primary_color, accentColor: r.accent_color },
  timezone: r.timezone, labourRuleSet: r.labour_rule_set, weekStartsOn: r.week_starts_on,
  payPeriod: { type: r.pay_period_type, anchorDate: r.pay_period_anchor }, gpsModeDefault: r.gps_mode_default,
});

const USER_SELECT = `select p.id, m.company_id, p.full_name, coalesce(p.email, '') as email, p.phone, m.role,
  m.hourly_rate::float8 as hourly_rate, m.payroll_external_id, m.active, m.location_consent_at
  from memberships m join profiles p on p.id = m.profile_id`;

const toUser = (r: Row): User => ({
  id: r.id, companyId: r.company_id, name: r.full_name, email: r.email, phone: r.phone, role: r.role, kioskPin: "",
  hourlyRate: r.hourly_rate, payrollExternalId: r.payroll_external_id, active: r.active, locationConsentAt: r.location_consent_at,
});

const JOB_SELECT = `select j.*, coalesce((select array_agg(f.profile_id::text) from job_foremen f where f.job_id = j.id), '{}') as foreman_ids from jobs j`;

const toJob = (r: Row): Job => ({
  id: r.id, companyId: r.company_id, name: r.name, code: r.code, address: r.address, lat: r.lat, lng: r.lng,
  geofenceRadiusM: r.geofence_radius_m, geofenceEnforcement: r.geofence_enforcement, requireQr: r.require_qr, qrToken: r.qr_token,
  offlineMode: r.offline_mode, gpsMode: r.gps_mode, labourRuleOverride: r.labour_rule_override, foremanIds: r.foreman_ids ?? [], status: r.status,
});

const toShift = (r: Row): Shift => ({
  id: r.id, companyId: r.company_id, jobId: r.job_id, userId: r.profile_id, start: r.starts_at, end: r.ends_at, costCodeId: r.cost_code_id, notes: r.notes,
});

const toPunch = (r: Row): Punch => ({
  id: r.id, companyId: r.company_id, userId: r.profile_id, jobId: r.job_id, type: r.type, occurredAt: r.occurred_at, receivedAt: r.received_at,
  source: r.source, gps: r.gps_lat === null ? null : { lat: r.gps_lat, lng: r.gps_lng, accuracyM: r.gps_accuracy_m },
  distanceM: r.distance_m, withinGeofence: r.within_geofence, qrVerified: r.qr_verified, costCodeId: r.cost_code_id, offline: r.offline,
  createdBy: r.created_by, voided: r.voided, replacesPunchId: r.replaces_punch_id, note: r.note, clientId: r.client_id,
});

const TIMESHEET_SELECT = `select t.id, t.company_id, t.profile_id, t.period_start::text as period_start, t.period_end::text as period_end, t.status,
  coalesce((select json_agg(json_build_object('byUserId', a.by_profile_id, 'role', a.role, 'at', a.at, 'status', a.status) order by a.id)
    from timesheet_approvals a where a.timesheet_id = t.id), '[]') as approvals
  from timesheets t`;

const toTimesheet = (r: Row): Timesheet => ({
  id: r.id, companyId: r.company_id, userId: r.profile_id, periodStart: r.period_start, periodEnd: r.period_end, status: r.status, approvals: r.approvals,
});

// Enum arrays (channel_key[]) arrive as Postgres array text, e.g. "{in_app,sms}".
const pgArray = (v: unknown): string[] => (Array.isArray(v) ? v : String(v ?? "").replace(/^\{|\}$/g, "").split(",").filter(Boolean));

const toMessage = (r: Row): Message => ({
  id: r.id, companyId: r.company_id, senderId: r.sender_id, subject: r.subject, body: r.body, channels: pgArray(r.channels) as Message["channels"], createdAt: r.created_at,
  audience: r.audience_type === "job" ? { type: "job", jobId: r.audience_job_id } : r.audience_type === "user" ? { type: "user", userId: r.audience_user_id } : { type: "company" },
});

const toDelivery = (r: Row): MessageDelivery => ({ messageId: r.message_id, userId: r.profile_id, channel: r.channel, status: r.status, readAt: r.read_at });

const first = <T>(rows: T[]): T | null => rows[0] ?? null;

// Ids come from URLs and cookies (including ones from the demo store, like
// "u-dana"). Anything that isn't a UUID can't exist, so treat it as not
// found instead of letting Postgres reject the cast with a 500.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string | null | undefined): v is string => typeof v === "string" && UUID.test(v);
const must = <T>(rows: T[], what: string): T => {
  if (!rows[0]) throw new Error(`${what} not found`);
  return rows[0];
};

// Enum arrays are sent as Postgres array literals and cast in SQL.
const channelArray = (c: string[]) => `{${c.join(",")}}`;

export class SupabaseRepository implements Repository {
  // ── Companies ──
  async listCompanies() {
    return (await query(`select ${COMPANY_COLS} from companies order by name`)).map(toCompany);
  }
  async getCompany(id: string) {
    if (!isUuid(id)) return null;
    const r = first(await query(`select ${COMPANY_COLS} from companies where id = $1`, [id]));
    return r && toCompany(r);
  }
  async updateCompany(id: string, patch: Parameters<Repository["updateCompany"]>[1]) {
    const flat: Record<string, unknown> = {
      name: patch.name, slug: patch.slug, timezone: patch.timezone, labourRuleSet: patch.labourRuleSet, weekStartsOn: patch.weekStartsOn,
      gpsModeDefault: patch.gpsModeDefault,
      appName: patch.branding?.appName, logoUrl: patch.branding ? patch.branding.logoUrl : undefined,
      primaryColor: patch.branding?.primaryColor, accentColor: patch.branding?.accentColor,
      payPeriodType: patch.payPeriod?.type, payPeriodAnchor: patch.payPeriod?.anchorDate,
    };
    const set = setClause(flat, {
      name: "name", slug: "slug", timezone: "timezone", labourRuleSet: "labour_rule_set", weekStartsOn: "week_starts_on",
      gpsModeDefault: "gps_mode_default", appName: "app_name", logoUrl: "logo_path", primaryColor: "primary_color", accentColor: "accent_color",
      payPeriodType: "pay_period_type", payPeriodAnchor: "pay_period_anchor",
    }, 2);
    if (set.sql) await query(`update companies set ${set.sql} where id = $1`, [id, ...set.params]);
    return (await this.getCompany(id))!;
  }

  // ── People ──
  async listUsers(companyId: string) {
    if (!isUuid(companyId)) return [];
    return (await query(`${USER_SELECT} where m.company_id = $1 order by p.full_name`, [companyId])).map(toUser);
  }
  async getUser(id: string) {
    if (!isUuid(id)) return null;
    const r = first(await query(`${USER_SELECT} where p.id = $1 order by m.created_at limit 1`, [id]));
    return r && toUser(r);
  }
  async findUserByPin(companyId: string, pin: string) {
    if (!isUuid(companyId)) return null;
    const r = first(await query(`${USER_SELECT} where m.company_id = $1 and m.active and m.kiosk_pin_hash is not null
      and m.kiosk_pin_hash = extensions.crypt($2, m.kiosk_pin_hash) limit 1`, [companyId, pin]));
    return r && toUser(r);
  }
  async createUser(input: NewRecord<User>) {
    const id = crypto.randomUUID();
    await batch([
      { text: `insert into profiles (id, full_name, email, phone) values ($1, $2, $3, $4)`, params: [id, input.name, input.email || null, input.phone] },
      {
        text: `insert into memberships (company_id, profile_id, role, kiosk_pin_hash, hourly_rate, payroll_external_id, active, location_consent_at)
          values ($1, $2, $3, case when $4 = '' then null else extensions.crypt($4, extensions.gen_salt('bf')) end, $5, $6, $7, $8)`,
        params: [input.companyId, id, input.role, input.kioskPin ?? "", input.hourlyRate, input.payrollExternalId, input.active, input.locationConsentAt],
      },
    ]);
    return (await this.getUser(id))!;
  }
  async updateUser(id: string, patch: Parameters<Repository["updateUser"]>[1]) {
    const queries = [];
    const prof = setClause(patch, { name: "full_name", email: "email", phone: "phone" }, 2);
    if (prof.sql) queries.push({ text: `update profiles set ${prof.sql} where id = $1`, params: [id, ...prof.params] });
    const mem = setClause(patch, { role: "role", hourlyRate: "hourly_rate", payrollExternalId: "payroll_external_id", active: "active", locationConsentAt: "location_consent_at" }, 2);
    if (mem.sql) queries.push({ text: `update memberships set ${mem.sql} where profile_id = $1`, params: [id, ...mem.params] });
    if (patch.kioskPin) queries.push({ text: `update memberships set kiosk_pin_hash = extensions.crypt($2, extensions.gen_salt('bf')) where profile_id = $1`, params: [id, patch.kioskPin] });
    if (queries.length) await batch(queries);
    const u = await this.getUser(id);
    if (!u) throw new Error(`User ${id} not found`);
    return u;
  }

  // ── Jobs & cost codes ──
  async listJobs(companyId: string) {
    if (!isUuid(companyId)) return [];
    return (await query(`${JOB_SELECT} where j.company_id = $1 order by j.created_at`, [companyId])).map(toJob);
  }
  async getJob(id: string) {
    if (!isUuid(id)) return null;
    const r = first(await query(`${JOB_SELECT} where j.id = $1`, [id]));
    return r && toJob(r);
  }
  async findJobByQrToken(token: string) {
    const r = first(await query(`${JOB_SELECT} where j.qr_token = $1`, [token]));
    return r && toJob(r);
  }
  async createJob(input: NewRecord<Job>) {
    const id = crypto.randomUUID();
    await batch([
      {
        text: `insert into jobs (id, company_id, name, code, address, lat, lng, geofence_radius_m, geofence_enforcement, require_qr, qr_token,
          offline_mode, gps_mode, labour_rule_override, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        params: [id, input.companyId, input.name, input.code, input.address, input.lat, input.lng, input.geofenceRadiusM, input.geofenceEnforcement,
          input.requireQr, input.qrToken, input.offlineMode, input.gpsMode, input.labourRuleOverride, input.status],
      },
      { text: `insert into job_foremen (job_id, profile_id) select $1, unnest($2::uuid[])`, params: [id, input.foremanIds] },
    ]);
    return (await this.getJob(id))!;
  }
  async updateJob(id: string, patch: Parameters<Repository["updateJob"]>[1]) {
    const queries = [];
    const set = setClause(patch, {
      name: "name", code: "code", address: "address", lat: "lat", lng: "lng", geofenceRadiusM: "geofence_radius_m",
      geofenceEnforcement: "geofence_enforcement", requireQr: "require_qr", qrToken: "qr_token", offlineMode: "offline_mode",
      gpsMode: "gps_mode", labourRuleOverride: "labour_rule_override", status: "status",
    }, 2);
    if (set.sql) queries.push({ text: `update jobs set ${set.sql} where id = $1`, params: [id, ...set.params] });
    if (patch.foremanIds) {
      queries.push({ text: `delete from job_foremen where job_id = $1`, params: [id] });
      queries.push({ text: `insert into job_foremen (job_id, profile_id) select $1, unnest($2::uuid[])`, params: [id, patch.foremanIds] });
    }
    if (queries.length) await batch(queries);
    const j = await this.getJob(id);
    if (!j) throw new Error(`Job ${id} not found`);
    return j;
  }
  async listCostCodes(companyId: string) {
    return (await query(`select id, company_id, code, name from cost_codes where company_id = $1 and active order by code`, [companyId]))
      .map((r): CostCode => ({ id: r.id, companyId: r.company_id, code: r.code, name: r.name }));
  }
  async createCostCode(input: NewRecord<CostCode>) {
    const r = must(await query(`insert into cost_codes (company_id, code, name) values ($1, $2, $3) returning id, company_id, code, name`, [input.companyId, input.code, input.name]), "Cost code");
    return { id: r.id, companyId: r.company_id, code: r.code, name: r.name };
  }

  // ── Schedule ──
  async listShifts(companyId: string, r: Parameters<Repository["listShifts"]>[1]) {
    return (await query(
      `select * from shifts where company_id = $1 and starts_at < $3 and ends_at > $2
        and ($4::uuid is null or profile_id = $4) and ($5::uuid is null or job_id = $5) order by starts_at`,
      [companyId, r.from, r.to, r.userId ?? null, r.jobId ?? null],
    )).map(toShift);
  }
  async getShift(id: string) {
    if (!isUuid(id)) return null;
    const r = first(await query(`select * from shifts where id = $1`, [id]));
    return r && toShift(r);
  }
  async createShift(input: NewRecord<Shift>) {
    return toShift(must(await query(
      `insert into shifts (company_id, job_id, profile_id, starts_at, ends_at, cost_code_id, notes) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [input.companyId, input.jobId, input.userId, input.start, input.end, input.costCodeId, input.notes],
    ), "Shift"));
  }
  async deleteShift(id: string) {
    await query(`delete from shifts where id = $1`, [id]);
  }

  // ── Punches ──
  async listPunches(companyId: string, f: Parameters<Repository["listPunches"]>[1]) {
    return (await query(
      `select * from punches where company_id = $1 and ($2::uuid is null or profile_id = $2) and ($3::uuid is null or job_id = $3)
        and ($4::timestamptz is null or occurred_at >= $4) and ($5::timestamptz is null or occurred_at <= $5) order by occurred_at`,
      [companyId, f.userId ?? null, f.jobId ?? null, f.from ?? null, f.to ?? null],
    )).map(toPunch);
  }
  async getPunch(id: string) {
    if (!isUuid(id)) return null;
    const r = first(await query(`select * from punches where id = $1`, [id]));
    return r && toPunch(r);
  }
  async findPunchByClientId(companyId: string, clientId: string) {
    const r = first(await query(`select * from punches where company_id = $1 and client_id = $2`, [companyId, clientId]));
    return r && toPunch(r);
  }
  async createPunch(input: NewRecord<Punch>) {
    return toPunch(must(await query(
      `insert into punches (company_id, profile_id, job_id, type, occurred_at, received_at, source, gps_lat, gps_lng, gps_accuracy_m, distance_m,
        within_geofence, qr_verified, cost_code_id, offline, client_id, created_by, voided, replaces_punch_id, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning *`,
      [input.companyId, input.userId, input.jobId, input.type, input.occurredAt, input.receivedAt, input.source, input.gps?.lat ?? null,
        input.gps?.lng ?? null, input.gps ? Math.round(input.gps.accuracyM) : null, input.distanceM, input.withinGeofence, input.qrVerified,
        input.costCodeId, input.offline, input.clientId, input.createdBy, input.voided, input.replacesPunchId, input.note],
    ), "Punch"));
  }
  async updatePunch(id: string, patch: Parameters<Repository["updatePunch"]>[1]) {
    const set = setClause(patch, { voided: "voided", note: "note" }, 2);
    return toPunch(must(await query(`update punches set ${set.sql} where id = $1 returning *`, [id, ...set.params]), "Punch"));
  }
  async createLocationPing(input: NewRecord<LocationPing>) {
    const r = must(await query(
      `insert into location_pings (company_id, profile_id, job_id, at, gps_lat, gps_lng, gps_accuracy_m, within_geofence)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id::text`,
      [input.companyId, input.userId, input.jobId, input.at, input.gps.lat, input.gps.lng, Math.round(input.gps.accuracyM), input.withinGeofence],
    ), "Ping");
    return { ...input, id: r.id };
  }
  async listLocationPings(companyId: string, f: { userId: string; from: string }) {
    return (await query(`select *, id::text as id from location_pings where company_id = $1 and profile_id = $2 and at >= $3 order by at`, [companyId, f.userId, f.from]))
      .map((r): LocationPing => ({ id: r.id, companyId: r.company_id, userId: r.profile_id, jobId: r.job_id, at: r.at, gps: { lat: r.gps_lat, lng: r.gps_lng, accuracyM: r.gps_accuracy_m }, withinGeofence: r.within_geofence }));
  }

  // ── Timesheets ──
  async getTimesheet(companyId: string, userId: string, periodStart: string) {
    const r = first(await query(`${TIMESHEET_SELECT} where t.company_id = $1 and t.profile_id = $2 and t.period_start = $3`, [companyId, userId, periodStart]));
    return r && toTimesheet(r);
  }
  async listTimesheets(companyId: string, periodStart: string) {
    return (await query(`${TIMESHEET_SELECT} where t.company_id = $1 and t.period_start = $2`, [companyId, periodStart])).map(toTimesheet);
  }
  async upsertTimesheet(input: NewRecord<Timesheet>) {
    // Approvals are append-only: insert only the entries beyond what's stored.
    const existing = await this.getTimesheet(input.companyId, input.userId, input.periodStart);
    const id = existing?.id ?? crypto.randomUUID();
    const fresh = input.approvals.slice(existing?.approvals.length ?? 0);
    await batch([
      {
        text: `insert into timesheets (id, company_id, profile_id, period_start, period_end, status) values ($1,$2,$3,$4,$5,$6)
          on conflict (company_id, profile_id, period_start) do update set status = excluded.status, period_end = excluded.period_end`,
        params: [id, input.companyId, input.userId, input.periodStart, input.periodEnd, input.status],
      },
      ...fresh.map((a) => ({
        text: `insert into timesheet_approvals (timesheet_id, by_profile_id, role, status, at) values ($1,$2,$3,$4,$5)`,
        params: [id, a.byUserId, a.role, a.status, a.at],
      })),
    ]);
    return (await this.getTimesheet(input.companyId, input.userId, input.periodStart))!;
  }

  // ── Audit ──
  async appendAudit(input: NewRecord<AuditEntry>) {
    await query(
      `insert into audit_log (company_id, actor_id, action, entity, entity_id, reason, before, after, at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
      [input.companyId, input.actorId, input.action, input.entity, input.entityId, input.reason, JSON.stringify(input.before ?? null), JSON.stringify(input.after ?? null), input.at],
    );
  }
  async listAudit(companyId: string, f: { entity?: string; entityId?: string; limit?: number } = {}) {
    return (await query(
      `select id::text, company_id, actor_id, action, entity, entity_id, reason, before, after, at from audit_log
        where company_id = $1 and ($2::text is null or entity = $2) and ($3::text is null or entity_id = $3) order by at desc limit $4`,
      [companyId, f.entity ?? null, f.entityId ?? null, f.limit ?? 100],
    )).map((r): AuditEntry => ({ id: r.id, companyId: r.company_id, actorId: r.actor_id, action: r.action, entity: r.entity, entityId: r.entity_id, reason: r.reason, before: r.before, after: r.after, at: r.at }));
  }

  // ── Messaging ──
  async createMessage(input: NewRecord<Message>, deliveries: Omit<MessageDelivery, "messageId">[]) {
    const id = crypto.randomUUID();
    const a = input.audience;
    await batch([
      {
        text: `insert into messages (id, company_id, sender_id, audience_type, audience_job_id, audience_user_id, subject, body, channels, created_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9::channel_key[],$10)`,
        params: [id, input.companyId, input.senderId, a.type, a.type === "job" ? a.jobId : null, a.type === "user" ? a.userId : null,
          input.subject, input.body, channelArray(input.channels), input.createdAt],
      },
      {
        text: `insert into message_deliveries (message_id, profile_id, channel, status)
          select $1, unnest($2::uuid[]), unnest($3::channel_key[]), unnest($4::delivery_status[])`,
        params: [id, deliveries.map((d) => d.userId), channelArray(deliveries.map((d) => d.channel)), `{${deliveries.map((d) => d.status).join(",")}}`],
      },
    ]);
    return { ...input, id };
  }
  async listMessagesForUser(companyId: string, userId: string) {
    return (await query(
      `select m.*, d.message_id, d.profile_id, d.channel, d.status, d.read_at from message_deliveries d join messages m on m.id = d.message_id
        where d.profile_id = $2 and d.channel = 'in_app' and m.company_id = $1 order by m.created_at desc`,
      [companyId, userId],
    )).map((r) => ({ ...toMessage(r), delivery: toDelivery(r) }));
  }
  async listSentMessages(companyId: string) {
    return (await query(
      `select m.*, coalesce((select json_agg(json_build_object('message_id', d.message_id, 'profile_id', d.profile_id, 'channel', d.channel, 'status', d.status, 'read_at', d.read_at))
        from message_deliveries d where d.message_id = m.id), '[]') as deliveries
        from messages m where m.company_id = $1 order by m.created_at desc limit 100`,
      [companyId],
    )).map((r) => ({ ...toMessage(r), deliveries: (r.deliveries as Row[]).map(toDelivery) }));
  }
  async markMessageRead(messageId: string, userId: string) {
    await query(`update message_deliveries set read_at = now() where message_id = $1 and profile_id = $2 and read_at is null`, [messageId, userId]);
  }

  // ── Integrations ──
  async listIntegrationConnections(companyId: string) {
    return (await query(`select id, company_id, provider, kind, status, settings from integration_connections where company_id = $1`, [companyId]))
      .map((r): IntegrationConnection => ({ id: r.id, companyId: r.company_id, provider: r.provider, kind: r.kind, status: r.status, settings: r.settings }));
  }
  async recordPayrollExport(input: NewRecord<PayrollExport>) {
    const r = must(await query(
      `insert into payroll_exports (company_id, provider, period_start, period_end, status, row_count, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [input.companyId, input.provider, input.periodStart, input.periodEnd, input.status, input.rowCount, input.createdBy, input.createdAt],
    ), "Export");
    return { ...input, id: r.id };
  }
  async listPayrollExports(companyId: string) {
    return (await query(
      `select id, company_id, provider, period_start::text as period_start, period_end::text as period_end, status, row_count, created_by, created_at
        from payroll_exports where company_id = $1 order by created_at desc`,
      [companyId],
    )).map((r): PayrollExport => ({ id: r.id, companyId: r.company_id, provider: r.provider, periodStart: r.period_start, periodEnd: r.period_end, status: r.status, rowCount: r.row_count, createdBy: r.created_by, createdAt: r.created_at }));
  }
}
