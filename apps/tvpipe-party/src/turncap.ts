// A soft monthly cap on Cloudflare TURN (docs/browser-party-design.md,
// "TURN credentials"): a Cron Trigger reads this calendar month's TURN
// traffic from Cloudflare's GraphQL Analytics API every 10 minutes and
// keeps it in D1; /api/turn hands out TURN credentials only while it is
// under the limit and the last check is recent.

import type { D1Database, Env } from "./env.ts";

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
/** The default limit: under the free 1,000 GB a month, with room for what is in flight. */
export const DEFAULT_LIMIT_GB = 900;
/** Without a successful check for this long, TURN is off (the cron or the analytics broke). */
export const STALE_CHECK_MS = 2 * 60 * 60 * 1000;
export const ANALYTICS_TIMEOUT_MS = 10_000;

export const TURN_USAGE_QUERY = `query TurnUsage($account: string!, $filter: AccountCallsTurnUsageAdaptiveGroupsFilter_InputObject!) {
  viewer {
    accounts(filter: {accountTag: $account}) {
      callsTurnUsageAdaptiveGroups(limit: 1, filter: $filter) {
        sum { egressBytes ingressBytes }
      }
    }
  }
}`;

/** The calendar month (UTC) of `now`, `"2026-11"`, and its first moment. */
export function monthOf(now: number): { month: string; start: string } {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const month = `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}`;
  return { month, start: new Date(Date.UTC(y, m, 1)).toISOString() };
}

/** The limit in bytes (GB: 10⁹ bytes, as Cloudflare bills). */
export function limitBytes(env: Env): number {
  const gb = Number(env.TURN_MONTHLY_LIMIT_GB);
  return (Number.isFinite(gb) && gb > 0 ? gb : DEFAULT_LIMIT_GB) * 1e9;
}

function count(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error("analytics: not a byte count");
  return n;
}

/**
 * Egress plus ingress of the analytics answer, all groups together.
 * Throws on errors or an answer without the account (a wrong account id
 * or a token without Account Analytics Read).
 */
export function usageBytes(body: unknown): number {
  const b = body as {
    data?: { viewer?: { accounts?: { callsTurnUsageAdaptiveGroups?: unknown }[] } } | null;
    errors?: { message?: unknown }[] | null;
  } | null;
  if (b === null || typeof b !== "object") throw new Error("analytics: not JSON");
  if (Array.isArray(b.errors) && b.errors.length > 0) {
    throw new Error(`analytics: ${String(b.errors[0]?.message ?? "error")}`);
  }
  const groups = b.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups;
  if (!Array.isArray(groups)) throw new Error("analytics: no such account");
  let bytes = 0;
  for (const g of groups as { sum?: { egressBytes?: unknown; ingressBytes?: unknown } }[]) {
    bytes += count(g.sum?.egressBytes ?? 0) + count(g.sum?.ingressBytes ?? 0);
  }
  return bytes;
}

let warnedNoCap = false;

/** Logs once per isolate that TURN is not capped. */
function warnNoCap(): void {
  if (warnedNoCap) return;
  warnedNoCap = true;
  console.warn("TURN is not capped: no TURN_ANALYTICS_TOKEN");
}

/** Forgets what was logged (tests). */
export function resetTurnCapLog(): void {
  warnedNoCap = false;
}

/**
 * The Cron Trigger: reads this month's TURN traffic (of our key, when
 * there is one) and stores it. Failures are logged and store nothing, so
 * the last check grows old and /api/turn stops TURN after 2 hours.
 */
export async function checkTurnUsage(env: Env, now: number, fetcher: typeof fetch = fetch): Promise<number | null> {
  const token = env.TURN_ANALYTICS_TOKEN;
  if (!token) {
    warnNoCap();
    return null;
  }
  try {
    if (!env.CF_ACCOUNT_ID) throw new Error("no CF_ACCOUNT_ID");
    const { month, start } = monthOf(now);
    const filter: Record<string, string> = { datetimeMinute_geq: start };
    if (env.TURN_KEY_ID) filter.keyId = env.TURN_KEY_ID;
    const res = await fetcher(GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: TURN_USAGE_QUERY, variables: { account: env.CF_ACCOUNT_ID, filter } }),
      signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`analytics: HTTP ${res.status}`);
    const bytes = usageBytes(await res.json());
    await env.DB.prepare(
      `INSERT INTO turn_usage (month, bytes, checked) VALUES (?1, ?2, ?3)
ON CONFLICT (month) DO UPDATE SET bytes = ?2, checked = ?3`,
    )
      .bind(month, bytes, now)
      .run();
    if (bytes >= limitBytes(env)) console.warn(`TURN is off for ${month}: ${bytes} bytes used`);
    return bytes;
  } catch (e) {
    console.error("TURN usage check failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

export type TurnCap = "ok" | "over" | "stale";

/**
 * Whether TURN may be handed out now: `over` when this month's stored
 * usage reached the limit, `stale` when the last successful check is
 * older than 2 hours or missing (failing closed); `ok` without an
 * analytics token (no cap).
 */
export async function turnCap(env: Env, now: number): Promise<TurnCap> {
  if (!env.TURN_ANALYTICS_TOKEN) {
    warnNoCap();
    return "ok";
  }
  let row: { month: string; bytes: number; checked: number } | null;
  try {
    row = await latestUsage(env.DB);
  } catch (e) {
    console.error("TURN usage read failed:", e instanceof Error ? e.message : e);
    return "stale";
  }
  if (row === null || now - row.checked > STALE_CHECK_MS) return "stale";
  // A check of last month (just before midnight): this month starts at 0.
  if (row.month === monthOf(now).month && row.bytes >= limitBytes(env)) return "over";
  return "ok";
}

async function latestUsage(db: D1Database): Promise<{ month: string; bytes: number; checked: number } | null> {
  return db
    .prepare("SELECT month, bytes, checked FROM turn_usage ORDER BY checked DESC LIMIT 1")
    .first<{ month: string; bytes: number; checked: number }>();
}
