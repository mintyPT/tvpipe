import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { handle } from "../src/app.ts";
import { clearTurnCache, FAILED_TTL, STUN, STUN_TTL, TURN_TTL, turnServers } from "../src/turn.ts";
import { testEnv, type TestEnv } from "./shim.ts";

const T0 = 1_700_000_000_000;

/** Cloudflare's answer (developers.cloudflare.com/realtime/turn/generate-credentials/). */
const CLOUDFLARE = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "user-1",
      credential: "cred-1",
    },
  ],
};

const TURN = {
  urls: [
    "turn:turn.cloudflare.com:3478?transport=udp",
    "turn:turn.cloudflare.com:3478?transport=tcp",
    "turns:turn.cloudflare.com:5349?transport=tcp",
    "turn:turn.cloudflare.com:80?transport=tcp",
    "turns:turn.cloudflare.com:443?transport=tcp",
  ],
  username: "user-1",
  credential: "cred-1",
};

let env: TestEnv;
let calls: { url: string; init: RequestInit }[];
let answer: () => Response;
const realFetch = globalThis.fetch;

beforeEach(() => {
  env = testEnv();
  clearTurnCache();
  calls = [];
  answer = () => Response.json(CLOUDFLARE, { status: 201 });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function get(now = T0, ip = "192.0.2.1"): Promise<Response> {
  return handle(new Request("https://tvpipe.party/api/turn", { headers: { "CF-Connecting-IP": ip } }), env, now);
}

test("without a TURN key: public STUN only", async () => {
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await res.json(), { iceServers: STUN, ttl: STUN_TTL });
  assert.deepEqual(STUN, [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }]);
  assert.equal(calls.length, 0);
});

test("with a TURN key: Cloudflare's TURN servers, port 53 left out, shared for half their life", async () => {
  env.TURN_KEY_ID = "key-id";
  env.TURN_KEY_API_TOKEN = "token";
  let res = await get();
  assert.deepEqual(await res.json(), { iceServers: [...STUN, TURN], ttl: TURN_TTL });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer token");
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { ttl: 3600 });
  assert.equal(TURN_TTL, 3600);

  // 10 minutes later: the same credentials, with what is left of their life.
  res = await get(T0 + 600_000);
  assert.deepEqual(await res.json(), { iceServers: [...STUN, TURN], ttl: TURN_TTL - 600 });
  assert.equal(calls.length, 1);
  // After half their life: new ones.
  res = await get(T0 + (TURN_TTL / 2) * 1000);
  assert.equal(((await res.json()) as { ttl: number }).ttl, TURN_TTL);
  assert.equal(calls.length, 2);
});

test("when Cloudflare fails: STUN only, asked again soon", async () => {
  env.TURN_KEY_ID = "key-id";
  env.TURN_KEY_API_TOKEN = "token";
  const errors = console.error;
  console.error = () => {};
  try {
    for (const bad of [
      () => new Response("nope", { status: 500 }),
      () => new Response("not json", { status: 201 }),
      () => Response.json({ iceServers: [{ urls: "stun:x" }] }, { status: 201 }),
      () => {
        throw new TypeError("network");
      },
    ]) {
      answer = bad;
      const res = await get();
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { iceServers: STUN, ttl: FAILED_TTL });
    }
  } finally {
    console.error = errors;
  }
  // Nothing was cached: the next request asks again.
  answer = () => Response.json(CLOUDFLARE, { status: 201 });
  assert.equal(((await (await get()).json()) as { ttl: number }).ttl, TURN_TTL);
});

test("turnServers takes the old single-object answer too and drops junk", () => {
  assert.deepEqual(
    turnServers({ iceServers: { urls: "turn:turn.cloudflare.com:3478", username: "u", credential: "c" } }),
    [{ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" }],
  );
  assert.deepEqual(turnServers({ iceServers: [{ urls: ["turn:x:53"], username: "u", credential: "c" }] }), []);
  assert.deepEqual(turnServers({ iceServers: [{ urls: ["turn:x"], username: 1, credential: "c" }] }), []);
  assert.deepEqual(turnServers({ iceServers: [{ urls: ["https://evil"], username: "u", credential: "c" }] }), []);
  assert.deepEqual(turnServers(null), []);
  assert.deepEqual(turnServers({}), []);
});

test("GET only, rate limited: 60 a minute per client", async () => {
  let res = await handle(new Request("https://tvpipe.party/api/turn", { method: "POST" }), env, T0);
  assert.equal(res.status, 405);
  for (let i = 0; i < 60; i++) assert.equal((await get()).status, 200);
  res = await get();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal((await get(T0, "192.0.2.2")).status, 200);
});
