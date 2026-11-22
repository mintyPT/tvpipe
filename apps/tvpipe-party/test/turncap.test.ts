// The monthly TURN cap: the Cron Trigger's analytics query, what it
// stores, and /api/turn going STUN only at the limit or without a recent
// check.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { handle } from "../src/app.ts";
import { FAILED_TTL, STUN, TURN_TTL, clearTurnCache } from "../src/turn.ts";
import {
  DEFAULT_LIMIT_GB,
  GRAPHQL_URL,
  STALE_CHECK_MS,
  TURN_USAGE_QUERY,
  checkTurnUsage,
  monthOf,
  resetTurnCapLog,
  turnCap,
  usageBytes,
} from "../src/turncap.ts";
import worker from "../src/worker.ts";
import { testEnv, type TestEnv } from "./shim.ts";

/** 2026-11-22T14:00:00Z */
const NOW = Date.UTC(2026, 10, 22, 14);
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const GB = 1e9;

let env: TestEnv;
let calls: { url: string; init: RequestInit }[];
/** The analytics answer: TURN traffic so far. */
let usage: { egress: unknown; ingress: unknown }[];
let analytics: () => Response;
let logs: string[];
const realFetch = globalThis.fetch;
const realConsole = { warn: console.warn, error: console.error };

function graphql(): Response {
  return Response.json({
    data: {
      viewer: {
        accounts: [{ callsTurnUsageAdaptiveGroups: usage.map((u) => ({ sum: { egressBytes: u.egress, ingressBytes: u.ingress } })) }],
      },
    },
    errors: null,
  });
}

beforeEach(() => {
  env = testEnv();
  env.TURN_KEY_ID = "key-id";
  env.TURN_KEY_API_TOKEN = "turn-token";
  env.TURN_ANALYTICS_TOKEN = "analytics-token";
  env.CF_ACCOUNT_ID = ACCOUNT;
  clearTurnCache();
  resetTurnCapLog();
  calls = [];
  usage = [];
  analytics = graphql;
  logs = [];
  console.warn = (...m: unknown[]) => void logs.push(m.join(" "));
  console.error = (...m: unknown[]) => void logs.push(m.join(" "));
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === GRAPHQL_URL) return analytics();
    return Response.json(
      { iceServers: [{ urls: ["turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" }] },
      { status: 201 },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realConsole.warn;
  console.error = realConsole.error;
});

function stored(): { month: string; bytes: number; checked: number }[] {
  // node:sqlite's rows have no prototype: plain copies compare.
  return (env.DB.sqlite.prepare("SELECT month, bytes, checked FROM turn_usage ORDER BY month").all() as {
    month: string;
    bytes: number;
    checked: number;
  }[]).map((r) => ({ ...r }));
}

async function turnAt(now: number): Promise<{ iceServers: unknown[]; ttl: number }> {
  const res = await handle(new Request("https://tvpipe.party/api/turn", { headers: { "CF-Connecting-IP": "192.0.2.1" } }), env, now);
  assert.equal(res.status, 200);
  return (await res.json()) as { iceServers: unknown[]; ttl: number };
}

function hasTurn(config: { iceServers: unknown[] }): boolean {
  return config.iceServers.length > STUN.length;
}

test("months are UTC calendar months", () => {
  assert.deepEqual(monthOf(NOW), { month: "2026-11", start: "2026-11-01T00:00:00.000Z" });
  assert.deepEqual(monthOf(Date.UTC(2026, 11, 31, 23, 59, 59, 999)), { month: "2026-12", start: "2026-12-01T00:00:00.000Z" });
  assert.deepEqual(monthOf(Date.UTC(2027, 0, 1)), { month: "2027-01", start: "2027-01-01T00:00:00.000Z" });
  assert.deepEqual(monthOf(Date.UTC(2028, 1, 29, 12)), { month: "2028-02", start: "2028-02-01T00:00:00.000Z" });
});

test("the check asks for this month's TURN traffic of our key and stores egress + ingress", async () => {
  usage = [{ egress: 3 * GB, ingress: 1 * GB }];
  assert.equal(await checkTurnUsage(env, NOW), 4 * GB);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0]!;
  assert.equal(url, GRAPHQL_URL);
  assert.equal(init.method, "POST");
  assert.equal((init.headers as Record<string, string>).Authorization, "Bearer analytics-token");
  const body = JSON.parse(init.body as string) as { query: string; variables: unknown };
  assert.equal(body.query, TURN_USAGE_QUERY);
  assert.match(body.query, /callsTurnUsageAdaptiveGroups\(limit: 1, filter: \$filter\)/);
  assert.match(body.query, /sum \{ egressBytes ingressBytes \}/);
  assert.deepEqual(body.variables, {
    account: ACCOUNT,
    filter: { datetimeMinute_geq: "2026-11-01T00:00:00.000Z", keyId: "key-id" },
  });
  assert.deepEqual(stored(), [{ month: "2026-11", bytes: 4 * GB, checked: NOW }]);

  // Later: the same row, updated.
  usage = [{ egress: 5 * GB, ingress: "2000000000" }];
  await checkTurnUsage(env, NOW + 600_000);
  assert.deepEqual(stored(), [{ month: "2026-11", bytes: 7 * GB, checked: NOW + 600_000 }]);

  // Without a TURN key (only the cap configured): account-wide.
  delete env.TURN_KEY_ID;
  await checkTurnUsage(env, NOW);
  const vars = JSON.parse(calls.at(-1)!.init.body as string).variables as { filter: Record<string, string> };
  assert.deepEqual(vars.filter, { datetimeMinute_geq: "2026-11-01T00:00:00.000Z" });
});

test("no traffic yet: no groups, 0 bytes", async () => {
  assert.equal(await checkTurnUsage(env, NOW), 0);
  assert.deepEqual(stored(), [{ month: "2026-11", bytes: 0, checked: NOW }]);
  assert.equal(usageBytes({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [] }] } }, errors: null }), 0);
});

test("failed checks store nothing", async () => {
  const answers: (() => Response)[] = [
    () => new Response("no", { status: 500 }),
    () => new Response("not json"),
    () => Response.json({ data: null, errors: [{ message: "not authorized" }] }),
    () => Response.json({ data: { viewer: { accounts: [] } }, errors: null }),
    () => {
      usage = [{ egress: "lots", ingress: 0 }];
      return graphql();
    },
    () => {
      usage = [{ egress: -1, ingress: 0 }];
      return graphql();
    },
    () => {
      throw new TypeError("network");
    },
  ];
  for (const answer of answers) {
    analytics = answer;
    assert.equal(await checkTurnUsage(env, NOW), null);
  }
  assert.deepEqual(stored(), []);
  assert.ok(logs.some((l) => l.includes("not authorized")));
  // No account: nothing asked.
  delete env.CF_ACCOUNT_ID;
  calls = [];
  assert.equal(await checkTurnUsage(env, NOW), null);
  assert.equal(calls.length, 0);
});

test("under the limit: TURN, with 1-hour credentials", async () => {
  usage = [{ egress: 800 * GB, ingress: 99 * GB }];
  await checkTurnUsage(env, NOW);
  const config = await turnAt(NOW + 60_000);
  assert.ok(hasTurn(config));
  assert.equal(config.ttl, TURN_TTL);
  assert.equal(TURN_TTL, 3600);
});

test("at the limit: STUN only, also with credentials cached", async () => {
  usage = [{ egress: 100 * GB, ingress: 0 }];
  await checkTurnUsage(env, NOW);
  assert.ok(hasTurn(await turnAt(NOW)));
  // Egress and ingress both count.
  usage = [{ egress: DEFAULT_LIMIT_GB * GB - 1, ingress: 1 }];
  await checkTurnUsage(env, NOW + 600_000);
  assert.deepEqual(await turnAt(NOW + 600_000), { iceServers: STUN, ttl: FAILED_TTL });
  assert.equal(await turnCap(env, NOW + 600_000), "over");
  assert.ok(logs.some((l) => l.includes("limit is reached")));
  // A lower limit from the var.
  env.TURN_MONTHLY_LIMIT_GB = "50";
  usage = [{ egress: 49 * GB, ingress: 0 }];
  await checkTurnUsage(env, NOW + 1_200_000);
  assert.ok(hasTurn(await turnAt(NOW + 1_200_000)));
  usage = [{ egress: 50 * GB, ingress: 0 }];
  await checkTurnUsage(env, NOW + 1_800_000);
  assert.equal(hasTurn(await turnAt(NOW + 1_800_000)), false);
  // Junk in the var: the default.
  env.TURN_MONTHLY_LIMIT_GB = "lots";
  assert.equal(await turnCap(env, NOW + 1_800_000), "ok");
});

test("a new month starts at 0, even before the first check of it", async () => {
  const lastOfMonth = Date.UTC(2026, 10, 30, 23, 55);
  usage = [{ egress: 2000 * GB, ingress: 0 }];
  await checkTurnUsage(env, lastOfMonth);
  assert.equal(await turnCap(env, lastOfMonth + 60_000), "over");
  // Midnight UTC: November's traffic no longer counts.
  const december = Date.UTC(2026, 11, 1, 0, 1);
  assert.equal(await turnCap(env, december), "ok");
  assert.ok(hasTurn(await turnAt(december)));
  // The cron's first December check asks from December 1st.
  usage = [{ egress: 1 * GB, ingress: 0 }];
  await checkTurnUsage(env, Date.UTC(2026, 11, 1, 0, 5));
  const vars = JSON.parse(calls.filter((c) => c.url === GRAPHQL_URL).at(-1)!.init.body as string).variables;
  assert.equal(vars.filter.datetimeMinute_geq, "2026-12-01T00:00:00.000Z");
  assert.deepEqual(stored().map((r) => [r.month, r.bytes]), [
    ["2026-11", 2000 * GB],
    ["2026-12", 1 * GB],
  ]);
  assert.equal(await turnCap(env, Date.UTC(2026, 11, 1, 0, 6)), "ok");
});

test("fails closed: no check yet, or none for 2 hours", async () => {
  assert.equal(await turnCap(env, NOW), "stale");
  assert.deepEqual(await turnAt(NOW), { iceServers: STUN, ttl: FAILED_TTL });
  assert.ok(logs.some((l) => l.includes("no recent usage check")));
  assert.equal(calls.length, 0, "no credentials asked for");

  await checkTurnUsage(env, NOW);
  assert.ok(hasTurn(await turnAt(NOW + STALE_CHECK_MS)));
  // The analytics break: the last good check grows old.
  analytics = () => new Response("down", { status: 503 });
  await checkTurnUsage(env, NOW + STALE_CHECK_MS);
  assert.equal(await turnCap(env, NOW + STALE_CHECK_MS + 1), "stale");
  assert.equal(hasTurn(await turnAt(NOW + STALE_CHECK_MS + 1)), false);
  // They come back.
  analytics = graphql;
  await checkTurnUsage(env, NOW + STALE_CHECK_MS + 600_000);
  assert.ok(hasTurn(await turnAt(NOW + STALE_CHECK_MS + 600_000)));
  assert.ok(logs.some((l) => l.includes("TURN is on again")));
});

test("D1 failing: fails closed", async () => {
  await checkTurnUsage(env, NOW);
  env.DB.sqlite.exec("DROP TABLE turn_usage");
  assert.equal(await turnCap(env, NOW), "stale");
});

test("no analytics token: no cap, logged once; no TURN key: no check needed", async () => {
  delete env.TURN_ANALYTICS_TOKEN;
  assert.ok(hasTurn(await turnAt(NOW)));
  assert.ok(hasTurn(await turnAt(NOW + 1)));
  assert.equal(await checkTurnUsage(env, NOW), null);
  assert.equal(calls.filter((c) => c.url === GRAPHQL_URL).length, 0);
  assert.equal(logs.filter((l) => l.includes("not capped")).length, 1);

  env.TURN_ANALYTICS_TOKEN = "analytics-token";
  delete env.TURN_KEY_ID;
  assert.equal(hasTurn(await turnAt(NOW)), false);
  assert.equal(calls.filter((c) => c.url !== GRAPHQL_URL).length, 1);
});

test("the Cron Trigger runs the check at its scheduled time", async () => {
  usage = [{ egress: 1, ingress: 2 }];
  const waits: Promise<unknown>[] = [];
  worker.scheduled({ scheduledTime: NOW, cron: "*/10 * * * *" }, env, { waitUntil: (p) => void waits.push(p) });
  assert.equal(waits.length, 1);
  await Promise.all(waits);
  assert.deepEqual(stored(), [{ month: "2026-11", bytes: 3, checked: NOW }]);
});
