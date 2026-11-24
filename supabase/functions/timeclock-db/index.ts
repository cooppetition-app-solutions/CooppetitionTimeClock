// timeclock-db — the app's database bridge (Supabase Edge Function, Deno).
//
// The Next.js server (src/lib/data/supabase/) sends parameterised SQL here
// over HTTPS. Vercel can't reach Supabase's direct Postgres host (IPv6
// only), and this keeps database credentials out of Vercel entirely: the
// function uses the SUPABASE_DB_URL Supabase injects.
//
// Safety:
//   - Callers must send `x-timeclock-key`; its SHA-256 must match the hash in
//     timeclock_private.server_keys (readable only by the project owner).
//   - Every batch runs in one transaction as `timeclock_app`, a role that can
//     touch the `timeclock` schema and nothing else in the project.
//   - Deployed with verify_jwt = false because the key check above replaces it.
//
// Request:  { "queries": [{ "text": "select ... $1", "params": [...] }, ...] }
// Response: { "results": [[row, ...], ...] }  or  { "error", "code" } (status 400/401)

import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 4, idle_timeout: 20 });

let keyHashes: { at: number; hashes: string[] } | null = null;

async function validKeyHashes(): Promise<string[]> {
  if (!keyHashes || Date.now() - keyHashes.at > 60_000) {
    const rows = await sql`select key_sha256 from timeclock_private.server_keys where revoked_at is null`;
    keyHashes = { at: Date.now(), hashes: rows.map((r) => r.key_sha256 as string) };
  }
  return keyHashes.hashes;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = req.headers.get("x-timeclock-key") ?? "";
  const hash = await sha256(key);
  const allowed = key.length >= 32 && (await validKeyHashes()).some((h) => safeEqual(h, hash));
  if (!allowed) return json({ error: "Unauthorized" }, 401);

  let queries: { text: string; params?: unknown[] }[];
  try {
    ({ queries } = await req.json());
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(queries) || queries.length === 0 || queries.length > 100 || queries.some((q) => typeof q?.text !== "string")) {
    return json({ error: "Body must be { queries: [{ text, params }] } with 1-100 queries" }, 400);
  }

  try {
    const results = await sql.begin(async (tx) => {
      await tx`set local role timeclock_app`;
      await tx`set local search_path = timeclock, extensions`;
      const out: unknown[][] = [];
      // deno-lint-ignore no-explicit-any
      for (const q of queries) out.push([...(await tx.unsafe(q.text, (q.params ?? []) as any[]))]);
      return out;
    });
    return json({ results });
  } catch (e) {
    const err = e as { message?: string; code?: string };
    return json({ error: err.message ?? "Query failed", code: err.code ?? null }, 400);
  }
});
