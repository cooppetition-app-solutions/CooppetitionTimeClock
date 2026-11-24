import "server-only";
// Minimal SQL client for the timeclock-db Edge Function
// (supabase/functions/timeclock-db). Each call is one HTTPS request; a
// batch runs in a single transaction.

export class DbError extends Error {
  constructor(message: string, public code: string | null) {
    super(message);
    this.name = "DbError";
  }
}

export interface Query {
  text: string;
  params?: unknown[];
}

function config() {
  const url = process.env.TIMECLOCK_DB_URL;
  const key = process.env.TIMECLOCK_DB_KEY;
  if (!url || !key) throw new DbError("TIMECLOCK_DB_URL and TIMECLOCK_DB_KEY must be set when DATA_BACKEND=supabase.", null);
  return { url, key };
}

/** Runs queries in one transaction and returns each query's rows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function batch(queries: Query[]): Promise<any[][]> {
  const { url, key } = config();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-timeclock-key": key },
    body: JSON.stringify({ queries }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { results?: unknown[][]; error?: string; code?: string };
  if (!res.ok || !body.results) throw new DbError(body.error ?? `Database request failed (${res.status})`, body.code ?? null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return body.results as any[][];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await batch([{ text, params }]))[0] as T[];
}

/** Builds "col = $n" assignments for the columns present in `patch`. */
export function setClause(patch: Record<string, unknown>, columns: Record<string, string>, startAt = 1): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [field, column] of Object.entries(columns)) {
    if (field in patch && patch[field] !== undefined) {
      params.push(patch[field]);
      parts.push(`${column} = $${startAt + params.length - 1}`);
    }
  }
  return { sql: parts.join(", "), params };
}
