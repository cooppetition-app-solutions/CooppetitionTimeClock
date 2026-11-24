"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/components/action-form";
import { requireCap } from "@/lib/auth/session";
import { repo } from "@/lib/data";
import { LABOUR_RULE_PRESETS } from "@/lib/domain/labour-rules";
import type { Role } from "@/lib/domain/types";
import { createShift, deleteShift } from "@/lib/services/schedule-service";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const num = (fd: FormData, k: string) => (str(fd, k) === "" ? null : Number(str(fd, k)));
const ROLES: Role[] = ["owner_admin", "office_payroll", "foreman", "employee"];
const HEX = /^#[0-9a-f]{6}$/i;

function saved(message: string): ActionState {
  revalidatePath("/", "layout");
  return { message };
}

async function audit(companyId: string, actorId: string, action: string, entity: string, entityId: string, before: unknown, after: unknown) {
  await repo().appendAudit({ companyId, actorId, action, entity, entityId, reason: null, before, after, at: new Date().toISOString() });
}

// ── Schedule ──────────────────────────────────────────────────────────────

export async function addShift(_: ActionState, fd: FormData): Promise<ActionState> {
  const { user, company } = await requireCap("schedule.manage");
  const r = await createShift({
    company, actor: user, userId: str(fd, "userId"), jobId: str(fd, "jobId"), date: str(fd, "date"),
    startTime: str(fd, "start") || "07:00", endTime: str(fd, "end") || "15:30", costCodeId: str(fd, "costCodeId") || null,
    notes: str(fd, "notes") || null, notify: fd.get("notify") === "on",
  });
  return r.ok ? saved("Shift added.") : { error: r.error };
}

export async function removeShift(fd: FormData) {
  const { user, company } = await requireCap("schedule.manage");
  await deleteShift({ company, actor: user, shiftId: str(fd, "shiftId"), notify: true });
  revalidatePath("/", "layout");
}

// ── Jobs ──────────────────────────────────────────────────────────────────

const JobFields = z.object({
  name: z.string().min(2, "Name is required."),
  code: z.string().min(1, "Job code is required."),
  address: z.string().min(3, "Address is required."),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  geofenceRadiusM: z.coerce.number().int().min(25).max(5000),
});

export async function addJob(_: ActionState, fd: FormData): Promise<ActionState> {
  const { user, company } = await requireCap("jobs.manage");
  const parsed = JobFields.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const job = await repo().createJob({
    companyId: company.id, ...parsed.data, geofenceEnforcement: "flag", requireQr: false, qrToken: crypto.randomUUID().replace(/-/g, ""),
    offlineMode: "queue", gpsMode: null, labourRuleOverride: null, foremanIds: fd.getAll("foremanIds").map(String), status: "active",
  });
  await audit(company.id, user.id, "job.create", "job", job.id, null, job);
  redirect(`/admin/jobs/${job.id}`);
}

export async function editJob(_: ActionState, fd: FormData): Promise<ActionState> {
  const { user, company } = await requireCap("jobs.manage");
  const job = await repo().getJob(str(fd, "jobId"));
  if (!job || job.companyId !== company.id) return { error: "Job not found." };
  const parsed = JobFields.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const override = str(fd, "labourRuleOverride");
  const after = await repo().updateJob(job.id, {
    ...parsed.data,
    geofenceEnforcement: str(fd, "geofenceEnforcement") === "block" ? "block" : "flag",
    requireQr: fd.get("requireQr") === "on",
    labourRuleOverride: override && LABOUR_RULE_PRESETS[override] ? override : null,
    foremanIds: fd.getAll("foremanIds").map(String),
    status: (["active", "on_hold", "complete"].includes(str(fd, "status")) ? str(fd, "status") : "active") as "active",
  });
  await audit(company.id, user.id, "job.update", "job", job.id, job, after);
  return saved("Job saved.");
}

export async function rotateQr(fd: FormData) {
  const { user, company } = await requireCap("jobs.manage");
  const job = await repo().getJob(str(fd, "jobId"));
  if (!job || job.companyId !== company.id) return;
  await repo().updateJob(job.id, { qrToken: crypto.randomUUID().replace(/-/g, "") });
  await audit(company.id, user.id, "job.qr_rotate", "job", job.id, null, null);
  revalidatePath("/", "layout");
}

export async function addCostCode(_: ActionState, fd: FormData): Promise<ActionState> {
  const { company } = await requireCap("jobs.manage");
  if (!str(fd, "code") || !str(fd, "name")) return { error: "Code and name are required." };
  const existing = await repo().listCostCodes(company.id);
  if (existing.some((c) => c.code === str(fd, "code"))) return { error: "That code already exists." };
  await repo().createCostCode({ companyId: company.id, code: str(fd, "code"), name: str(fd, "name") });
  return saved("Cost code added.");
}

// ── People ────────────────────────────────────────────────────────────────

// PINs may be stored hashed, so check by lookup rather than comparing values.
async function pinTaken(companyId: string, pin: string, exceptId?: string) {
  const holder = await repo().findUserByPin(companyId, pin);
  return Boolean(holder && holder.id !== exceptId);
}

export async function addPerson(_: ActionState, fd: FormData): Promise<ActionState> {
  const { user, company } = await requireCap("people.manage");
  const role = str(fd, "role") as Role;
  const pin = str(fd, "kioskPin");
  if (!str(fd, "name") || !str(fd, "email")) return { error: "Name and email are required." };
  if (!ROLES.includes(role)) return { error: "Pick a role." };
  if (!/^\d{4,6}$/.test(pin)) return { error: "Kiosk PIN must be 4–6 digits." };
  if (await pinTaken(company.id, pin)) return { error: "That PIN is already used in this company." };
  const created = await repo().createUser({
    companyId: company.id, name: str(fd, "name"), email: str(fd, "email"), phone: str(fd, "phone") || null, role, kioskPin: pin,
    hourlyRate: num(fd, "hourlyRate"), payrollExternalId: str(fd, "payrollExternalId") || null, active: true, locationConsentAt: null,
  });
  await audit(company.id, user.id, "user.create", "user", created.id, null, { ...created, kioskPin: "****" });
  // Production: also send the Supabase Auth invite (SMS code or email link) here.
  return saved(`${created.name} added. In production they'd get an invite by text or email.`);
}

export async function editPerson(_: ActionState, fd: FormData): Promise<ActionState> {
  const { user, company } = await requireCap("people.manage");
  const target = await repo().getUser(str(fd, "userId"));
  if (!target || target.companyId !== company.id) return { error: "Person not found." };
  const role = str(fd, "role") as Role;
  const pin = str(fd, "kioskPin");
  if (!ROLES.includes(role)) return { error: "Pick a role." };
  if (pin && !/^\d{4,6}$/.test(pin)) return { error: "Kiosk PIN must be 4–6 digits." };
  if (pin && (await pinTaken(company.id, pin, target.id))) return { error: "That PIN is already used." };
  if (target.id === user.id && role !== "owner_admin") return { error: "You can't remove your own admin access." };
  const after = await repo().updateUser(target.id, {
    role, phone: str(fd, "phone") || null, hourlyRate: num(fd, "hourlyRate"), payrollExternalId: str(fd, "payrollExternalId") || null,
    active: fd.get("active") === "on", ...(pin ? { kioskPin: pin } : {}),
  });
  await audit(company.id, user.id, "user.update", "user", target.id, { ...target, kioskPin: "****" }, { ...after, kioskPin: "****" });
  return saved(`${after.name} saved.`);
}

// ── Company & branding ────────────────────────────────────────────────────

export async function saveCompany(_: ActionState, fd: FormData): Promise<ActionState> {
  const { user, company } = await requireCap("settings.manage");
  const primary = str(fd, "primaryColor");
  const accent = str(fd, "accentColor");
  if (!HEX.test(primary) || !HEX.test(accent)) return { error: "Colours must be hex values like #1f5f8b." };
  const rules = str(fd, "labourRuleSet");
  if (!LABOUR_RULE_PRESETS[rules]) return { error: "Pick a labour rule set." };
  const tz = str(fd, "timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    return { error: "Unknown timezone." };
  }
  const anchor = str(fd, "anchorDate");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return { error: "Pay period start date is required." };
  const logoUrl = str(fd, "logoUrl");
  if (logoUrl && !/^https:\/\//.test(logoUrl)) return { error: "Logo URL must start with https://" };

  const after = await repo().updateCompany(company.id, {
    name: str(fd, "name") || company.name,
    branding: { appName: str(fd, "appName") || company.branding.appName, logoUrl: logoUrl || null, primaryColor: primary, accentColor: accent },
    timezone: tz,
    labourRuleSet: rules,
    weekStartsOn: Number(str(fd, "weekStartsOn")) || 0,
    payPeriod: { type: str(fd, "payPeriodType") === "weekly" ? "weekly" : "biweekly", anchorDate: anchor },
    gpsModeDefault: str(fd, "gpsModeDefault") === "continuous" ? "continuous" : "punch_only",
  });
  await audit(company.id, user.id, "company.update", "company", company.id, company, after);
  return saved("Settings saved. Branding updates everywhere on the next page load.");
}
