// The web rooms' signaling end to end: app.ts's routes, the Room object
// on the fake Durable Object runtime (test/shim.ts), D1 on node:sqlite.

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { handle } from "../src/app.ts";
import { ANSWER_MS, CLEANUP_MS, FIRST_MS, MAX_JOINS, MAX_MESSAGE } from "../src/room.ts";
import { STALE_MS } from "../src/links.ts";
import { clock, lastClient, testEnv, type FakeClient, type TestEnv } from "./shim.ts";

const ORIGIN = "https://tvpipe.party";
const KEY = "AbCdEfGhIjKlMnOp_-12";
const T0 = 1_700_000_000_000;
const GAME = { name: "drawbluff", title: "Draw Bluff", release: "1.2.0", phone: "/g/drawbluff/1.2.0/phone.html" };

let env: TestEnv;
beforeEach(() => {
  env = testEnv();
  clock.now = T0;
});

function req(method: string, path: string, headers: Record<string, string> = {}, body?: string): Request {
  return new Request(ORIGIN + path, {
    method,
    headers: { "CF-Connecting-IP": "192.0.2.1", ...headers },
    body,
    redirect: "manual",
  });
}

/** Registers the web room `code`; its secret. */
async function register(code = "BCDF", url = `${ORIGIN}/r/?r=${code}#k=${KEY}`): Promise<string> {
  const res = await handle(req("POST", "/api/links", {}, JSON.stringify({ url, code })), env, clock.now);
  assert.equal(res.status, 201);
  return ((await res.json()) as { secret: string }).secret;
}

async function connect(path: string, headers: Record<string, string> = {}): Promise<FakeClient> {
  const res = await handle(req("GET", path, { Upgrade: "websocket", ...headers }), env, clock.now);
  assert.equal(res.headers.get("X-Fake-Upgrade"), "1", `${path}: ${res.status}`);
  return lastClient!;
}

async function host(secret: string, code = "BCDF"): Promise<FakeClient> {
  const ws = await connect(`/api/rooms/${code}/host`);
  await ws.send({ t: "host", secret });
  assert.deepEqual(ws.last(), { t: "hosted" });
  return ws;
}

async function join(query = "", ip = "192.0.2.7", code = "BCDF"): Promise<FakeClient> {
  return connect(`/api/rooms/${code}/join${query}`, { "CF-Connecting-IP": ip, "User-Agent": "Phone/1.0" });
}

async function roomGet(code = "BCDF", ip = "192.0.2.1"): Promise<Response> {
  return handle(req("GET", `/api/rooms/${code}`, { "CF-Connecting-IP": ip }), env, clock.now);
}

function state(code = "BCDF") {
  return env.ROOMS.state(code);
}

/** Advances the clock and runs the room's alarm when due. */
async function advance(ms: number, code = "BCDF"): Promise<void> {
  clock.now += ms;
  await state(code).fire();
}

test("a host with the room's secret is hosted; GET /api/rooms/CODE tells", async () => {
  const secret = await register();
  let res = await roomGet();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await res.json(), { code: "BCDF", host: false, game: null });

  const h = await host(secret);
  assert.deepEqual(await (await roomGet("bcdf")).json(), { code: "BCDF", host: true, game: null });
  await h.send({ t: "game", game: GAME });
  assert.deepEqual(await (await roomGet()).json(), { code: "BCDF", host: true, game: GAME });
  // The game outlives the host (a reload, the next game's page).
  await h.close();
  assert.deepEqual(await (await roomGet()).json(), { code: "BCDF", host: false, game: GAME });
  // A reconnecting host has it still; null clears it.
  const h2 = await host(secret);
  assert.deepEqual(await (await roomGet()).json(), { code: "BCDF", host: true, game: GAME });
  await h2.send({ t: "game", game: null });
  assert.deepEqual(await (await roomGet()).json(), { code: "BCDF", host: true, game: null });
  // Pings are answered without the object.
  await h2.send("ping");
  assert.equal(h2.received.at(-1), "pong");
});

test("bad secrets, tunnels' links and wrong first messages are refused", async () => {
  const secret = await register();
  let ws = await connect("/api/rooms/BCDF/host");
  await ws.send({ t: "host", secret: "wrong" });
  assert.deepEqual(ws.last(), { t: "error", code: "bad-secret" });
  assert.equal(ws.closeCode, 4003);

  // A code of a tunnel's link (tvpipe's) is no web room.
  const tunnel = await register("GHJK", `https://x.trycloudflare.com/?r=GHJK#k=${KEY}`);
  ws = await connect("/api/rooms/GHJK/host");
  await ws.send({ t: "host", secret: tunnel });
  assert.equal(ws.closeCode, 4003);
  // Another room's secret.
  ws = await connect("/api/rooms/GHJK/host");
  await ws.send({ t: "host", secret });
  assert.equal(ws.closeCode, 4003);
  // No room at all.
  ws = await connect("/api/rooms/ZZZZ/host");
  await ws.send({ t: "host", secret });
  assert.equal(ws.closeCode, 4003);

  for (const first of [{ t: "game", game: GAME }, { t: "host" }, { t: "host", secret: 7 }, [1], "nope"]) {
    ws = await connect("/api/rooms/BCDF/host");
    await ws.send(first);
    assert.deepEqual(ws.last(), { t: "error", code: "bad-message" }, JSON.stringify(first));
    assert.equal(ws.closeCode, 1008);
  }
  assert.deepEqual(await (await roomGet()).json(), { code: "BCDF", host: false, game: null });
});

test("a host must say who it is within 10 s", async () => {
  await register();
  const ws = await connect("/api/rooms/BCDF/host");
  assert.equal(state().storage.alarm, T0 + FIRST_MS);
  await advance(FIRST_MS - 1);
  assert.equal(ws.closed, null);
  await advance(1);
  assert.deepEqual(ws.last(), { t: "error", code: "timeout" });
  assert.equal(ws.closeCode, 4002);
});

test("a newer host replaces the older one", async () => {
  const secret = await register();
  const h1 = await host(secret);
  const j = await join();
  await j.send({ t: "offer", sdp: "v=0 offer" });
  assert.equal(h1.last()!.t, "offer");
  const h2 = await host(secret);
  assert.deepEqual(h1.last(), { t: "replaced" });
  assert.equal(h1.closeCode, 4009);
  assert.equal(h2.closed, null);
  // The old host's offer is not going to be answered: the client retries.
  assert.deepEqual(j.last(), { t: "no-host" });
  assert.equal(j.closeCode, 1013);
  assert.deepEqual(await (await roomGet()).json(), { code: "BCDF", host: true, game: null });
  // New offers go to the new host.
  const j2 = await join();
  await j2.send({ t: "offer", sdp: "v=0 again" });
  assert.equal(h2.last()!.sdp, "v=0 again");
});

test("offer → answer, the connection numbered and never reused, across hibernation", async () => {
  const h = await host(await register());
  const j1 = await join("?role=player&p=TOKEN", "198.51.100.4");
  assert.deepEqual(j1.messages(), []);
  await j1.send({ t: "offer", sdp: "v=0 one" });
  assert.deepEqual(h.last(), {
    t: "offer",
    conn: 1,
    sdp: "v=0 one",
    query: "role=player&p=TOKEN",
    addr: "198.51.100.4",
    agent: "Phone/1.0",
  });
  await h.send({ t: "answer", conn: 1, sdp: "v=0 answer" });
  assert.deepEqual(j1.messages(), [{ t: "answer", sdp: "v=0 answer" }]);
  assert.equal(j1.closeCode, 1000);
  // A late or repeated answer goes nowhere.
  await h.send({ t: "answer", conn: 1, sdp: "v=0 answer" });
  assert.equal(h.closed, null);

  const j2 = await join();
  // The object hibernates: memory is gone, attachments and storage stay.
  state().hibernate();
  await j2.send({ t: "offer", sdp: "v=0 two" });
  assert.equal(h.last()!.conn, 2);
  state().hibernate();
  await h.send({ t: "answer", conn: 2, sdp: "v=0 answer two" });
  assert.deepEqual(j2.last(), { t: "answer", sdp: "v=0 answer two" });
});

test("connections are never renumbered after a host comes back", async () => {
  const secret = await register();
  let h = await host(secret);
  const j1 = await join();
  await j1.send({ t: "offer", sdp: "a" });
  assert.equal(h.last()!.conn, 1);
  await h.close();
  state().hibernate();
  h = await host(secret);
  const j2 = await join();
  await j2.send({ t: "offer", sdp: "b" });
  assert.equal(h.last()!.conn, 2);
});

test("reject", async () => {
  const h = await host(await register());
  const j = await join("?screen=1&token=T");
  await j.send({ t: "offer", sdp: "v=0" });
  await h.send({ t: "reject", conn: 1, reason: "full" });
  assert.deepEqual(j.messages(), [{ t: "reject", reason: "full" }]);
  assert.equal(j.closeCode, 1000);
  const j2 = await join();
  await j2.send({ t: "offer", sdp: "v=0" });
  await h.send({ t: "reject", conn: 2 });
  assert.deepEqual(j2.last(), { t: "reject", reason: "" });
});

test("no answer within 15 s: timeout; no offer within 10 s: closed", async () => {
  const h = await host(await register());
  clock.now += 1000;
  const idle = await join();
  const j = await join();
  await j.send({ t: "offer", sdp: "v=0" });
  await advance(FIRST_MS);
  assert.deepEqual(idle.last(), { t: "error", code: "timeout" });
  assert.equal(idle.closeCode, 4002);
  assert.equal(j.closed, null);
  await advance(ANSWER_MS - FIRST_MS - 1);
  assert.equal(j.closed, null);
  await advance(1);
  assert.deepEqual(j.messages(), [{ t: "timeout" }]);
  assert.equal(j.closeCode, 1000);
  // The host's answer after that goes nowhere; the host stays.
  await h.send({ t: "answer", conn: 1, sdp: "late" });
  assert.equal(h.closed, null);
  assert.equal(state().storage.alarm, null);
});

test("no host: no-host and 1013; also when the host leaves with offers open", async () => {
  const secret = await register();
  let j = await join();
  await j.send({ t: "offer", sdp: "v=0" });
  assert.deepEqual(j.messages(), [{ t: "no-host" }]);
  assert.equal(j.closeCode, 1013);
  // Unregistered codes too (nobody can host them).
  j = await join("", "192.0.2.7", "ZZZZ");
  await j.send({ t: "offer", sdp: "v=0" });
  assert.equal(j.closeCode, 1013);

  const h = await host(secret);
  j = await join();
  await j.send({ t: "offer", sdp: "v=0" });
  const waiting = await join();
  await h.close(1001);
  assert.deepEqual(j.last(), { t: "no-host" });
  assert.equal(j.closeCode, 1013);
  // One without an offer yet hears it when it offers.
  assert.equal(waiting.closed, null);
  await waiting.send({ t: "offer", sdp: "v=0" });
  assert.equal(waiting.closeCode, 1013);
});

test("join messages: one offer, JSON text, at most 16 KiB", async () => {
  const h = await host(await register());
  let j = await join();
  await j.send({ t: "offer", sdp: "x".repeat(MAX_MESSAGE) });
  assert.equal(j.closeCode, 1009);
  // Multi-byte characters count as bytes.
  j = await join();
  await j.send({ t: "offer", sdp: "é".repeat(MAX_MESSAGE / 2) });
  assert.equal(j.closeCode, 1009);
  for (const bad of ["nope", { t: "answer", sdp: "x" }, { t: "offer" }, { t: "offer", sdp: "" }, { t: "offer", sdp: 1 }, null]) {
    j = await join();
    await j.send(bad);
    assert.deepEqual(j.last(), { t: "error", code: "bad-message" }, JSON.stringify(bad));
    assert.equal(j.closeCode, 1008);
  }
  j = await join();
  await j.send({ t: "offer", sdp: "v=0" });
  await j.send({ t: "offer", sdp: "v=0" });
  assert.equal(j.closeCode, 1008);
  // A just-fitting offer passes.
  j = await join();
  const sdp = "x".repeat(MAX_MESSAGE - JSON.stringify({ t: "offer", sdp: "" }).length);
  await j.send({ t: "offer", sdp });
  assert.equal(j.closed, null);
  assert.equal(h.last()!.sdp, sdp);
  // The host's bad messages close the host.
  await h.send({ t: "game", game: { name: "x" } });
  assert.equal(h.closeCode, 1008);
});

test("offers: 30 a minute per address", async () => {
  const h = await host(await register());
  for (let i = 0; i < 30; i++) {
    const j = await join("", "203.0.113.1");
    await j.send({ t: "offer", sdp: `v=0 ${i}` });
    assert.equal(j.closed, null, `offer ${i}`);
    await h.send({ t: "reject", conn: i + 1 });
    clock.now += 200; // the room's bucket refills meanwhile
  }
  let j = await join("", "203.0.113.1");
  await j.send({ t: "offer", sdp: "v=0" });
  assert.deepEqual(j.last(), { t: "error", code: "rate-limited" });
  assert.equal(j.closeCode, 4008);
  j = await join("", "203.0.113.2");
  await j.send({ t: "offer", sdp: "v=0" });
  assert.equal(j.closed, null);
  clock.now = T0 + 60_000;
  j = await join("", "203.0.113.1");
  await j.send({ t: "offer", sdp: "v=0" });
  assert.equal(j.closed, null);
});

test("offers: 5 a second per room, a burst of 30", async () => {
  const h = await host(await register());
  void h;
  const offer = async (i: number): Promise<FakeClient> => {
    const j = await join("", `198.51.100.${i}`);
    await j.send({ t: "offer", sdp: "v=0" });
    return j;
  };
  for (let i = 0; i < 30; i++) assert.equal((await offer(i)).closed, null, `offer ${i}`);
  assert.equal((await offer(30)).closeCode, 4008);
  clock.now += 1000;
  for (let i = 31; i < 36; i++) assert.equal((await offer(i)).closed, null, `offer ${i}`);
  assert.equal((await offer(36)).closeCode, 4008);
});

test("at most 2 × 64 + 16 open joins per room", async () => {
  await register();
  const joins: FakeClient[] = [];
  for (let i = 0; i < MAX_JOINS; i++) joins.push(await join());
  assert.ok(joins.every((j) => j.closed === null));
  const extra = await join();
  assert.deepEqual(extra.last(), { t: "error", code: "full" });
  assert.equal(extra.closeCode, 1013);
  await joins[0]!.close();
  assert.equal((await join()).closed, null);
});

test("GET /api/rooms/CODE: 404 no-room, rate limited, the old owner's game hidden", async () => {
  for (const code of ["GHJK", "ABCD", "BCDFG", "BC%20DF"]) {
    const res = await roomGet(code);
    assert.equal(res.status, 404, code);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "no-room");
  }
  // A tunnel's link is no web room.
  await register("GHJK", `https://x.trycloudflare.com/?r=GHJK#k=${KEY}`);
  assert.equal((await roomGet("GHJK")).status, 404);

  const secret = await register();
  const h = await host(secret);
  await h.send({ t: "game", game: GAME });
  await h.close();
  // The code goes stale and to another web room: the old game is not its.
  clock.now += STALE_MS + 1;
  const other = await register();
  assert.notEqual(other, secret);
  assert.deepEqual(await (await roomGet()).json(), { code: "BCDF", host: false, game: null });
  await host(other);
  assert.deepEqual(await (await roomGet()).json(), { code: "BCDF", host: true, game: null });

  // Hits and misses count alike (invalid codes are not lookups).
  assert.equal(env.ROOM_LOOKUPS.counts.get("192.0.2.1"), 4);
  for (let i = 4; i < 120; i++) assert.equal((await roomGet()).status, 200);
  const res = await roomGet();
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
  assert.equal((await roomGet("BCDF", "192.0.2.99")).status, 200);
});

test("the room's storage goes 25 hours after its host left", async () => {
  const h = await host(await register());
  await h.send({ t: "game", game: GAME });
  await h.close();
  const storage = state().storage;
  // The host's first-message deadline was due first; then the cleanup.
  await advance(FIRST_MS);
  assert.equal(storage.alarm, T0 + CLEANUP_MS);
  await advance(CLEANUP_MS - FIRST_MS - 1);
  assert.ok(storage.data.has("game"));
  await advance(1);
  assert.equal(storage.data.size, 0);
  assert.equal(storage.alarm, null);
});

test("sockets: WebSocket upgrades only, GET only, short queries, any case", async () => {
  await register();
  let res = await handle(req("GET", "/api/rooms/BCDF/join"), env, T0);
  assert.equal(res.status, 426);
  res = await handle(req("POST", "/api/rooms/BCDF/host", { Upgrade: "websocket" }), env, T0);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "GET");
  res = await handle(req("PUT", "/api/rooms/BCDF"), env, T0);
  assert.equal(res.status, 405);
  res = await handle(req("GET", `/api/rooms/BCDF/join?q=${"x".repeat(1100)}`, { Upgrade: "websocket" }), env, T0);
  assert.equal(res.status, 414);
  res = await handle(req("GET", "/api/rooms/ABCD/join", { Upgrade: "websocket" }), env, T0);
  assert.equal(res.status, 404);
  res = await handle(req("GET", "/api/rooms/BCDF/other", { Upgrade: "websocket" }), env, T0);
  assert.equal(res.status, 404);
  // Lower case reaches the same object.
  const j = await join("", "192.0.2.7", "bcdf");
  void j;
  assert.equal(state("BCDF").sockets.length, 1);
});
