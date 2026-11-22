// Drives a running tvpipe.party (wrangler dev, or a deployment) through a
// web room's signaling with Node's own WebSocket. Not part of `npm test`:
//
//   npm run dev                                   # another terminal
//   node test/live-signaling.ts [BASE] [--slow]   # BASE: http://localhost:8787
//
// --slow also waits for the 15 s answer timeout.

import assert from "node:assert/strict";

const args = process.argv.slice(2);
const slow = args.includes("--slow");
const BASE = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:8787").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

function log(...m: unknown[]): void {
  console.log("·", ...m);
}

function randomCode(): string {
  let c = "";
  for (let i = 0; i < 4; i++) c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return c;
}

/** A WebSocket with a queue of what it received and its close. */
class Socket {
  ws: WebSocket;
  queue: string[] = [];
  waiters: (() => void)[] = [];
  closed: { code: number; reason: string } | null = null;
  opened: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)));
    });
    this.ws.addEventListener("message", (e) => {
      this.queue.push(String(e.data));
      this.wake();
    });
    this.ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
      this.wake();
    });
  }
  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
  static async open(url: string): Promise<Socket> {
    const s = new Socket(url);
    await s.opened;
    return s;
  }
  send(m: unknown): void {
    this.ws.send(typeof m === "string" ? m : JSON.stringify(m));
  }
  async next(timeout = 5000): Promise<string> {
    const deadline = Date.now() + timeout;
    while (this.queue.length === 0) {
      if (this.closed) throw new Error(`closed ${this.closed.code} ${this.closed.reason}, nothing received`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("no message in time");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return this.queue.shift()!;
  }
  async json(timeout?: number): Promise<Record<string, unknown>> {
    return JSON.parse(await this.next(timeout)) as Record<string, unknown>;
  }
  async closeCode(timeout = 5000): Promise<number> {
    const deadline = Date.now() + timeout;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error("not closed in time");
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.closed.code;
  }
}

async function api(method: string, path: string, body?: unknown, secret?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
}

const KEY = "LiveKeyLiveKey_-0123456789";
const GAME = { name: "drawbluff", title: "Draw Bluff", release: "1.0.0", phone: "/g/drawbluff/1.0.0/phone.html" };

// The origin the Worker sees (its `short` links): web links must be on it.
const probe = await api("POST", "/api/links", { url: `https://live-probe.trycloudflare.com/?r=PROBE#k=${KEY}` });
assert.equal(probe.status, 201, `POST probe: ${probe.status}`);
const probed = (await probe.json()) as { code: string; short: string; secret: string };
const ORIGIN = new URL(probed.short).origin;
await api("DELETE", `/api/links/${probed.code}`, undefined, probed.secret);
log("the Worker's origin:", ORIGIN);

const turn = (await (await api("GET", "/api/turn")).json()) as { iceServers: unknown[]; ttl: number };
log("GET /api/turn:", JSON.stringify(turn));
assert.ok(Array.isArray(turn.iceServers) && turn.ttl > 0);

// Register a web room under a free code.
let code = "";
let secret = "";
for (let i = 0; i < 8 && !secret; i++) {
  code = randomCode();
  const res = await api("POST", "/api/links", { url: `${ORIGIN}/r/?r=${code}#k=${KEY}`, code });
  if (res.status === 409) continue;
  assert.equal(res.status, 201, `POST: ${res.status} ${await res.clone().text()}`);
  secret = ((await res.json()) as { secret: string }).secret;
}
assert.ok(secret, "no free code in 8 tries");
log("registered", code);

let res = await api("POST", "/api/links", { url: `${ORIGIN}/r/?r=${code}#k=${KEY}`, code });
assert.equal(res.status, 409);
log("again: 409", ((await res.json()) as { error: { code: string } }).error.code);

res = await api("GET", `/${code.toLowerCase()}`);
assert.equal(res.status, 302);
assert.equal(res.headers.get("Location"), `/r/?r=${code}#k=${KEY}`);
log(`GET /${code.toLowerCase()}: 302 →`, res.headers.get("Location"));

assert.deepEqual(await (await api("GET", `/api/rooms/${code}`)).json(), { code, host: false, game: null });
log("GET room before the host: no host, no game");

// A join without a host.
let join = await Socket.open(`${WS_BASE}/api/rooms/${code}/join?role=player`);
join.send({ t: "offer", sdp: "v=0 early" });
assert.deepEqual(await join.json(), { t: "no-host" });
assert.equal(await join.closeCode(), 1013);
log("join without a host: no-host, 1013");

// A bad secret.
const bad = await Socket.open(`${WS_BASE}/api/rooms/${code}/host`);
bad.send({ t: "host", secret: "wrong" });
assert.deepEqual(await bad.json(), { t: "error", code: "bad-secret" });
assert.equal(await bad.closeCode(), 4003);
log("bad secret: 4003");

// The host.
let host = await Socket.open(`${WS_BASE}/api/rooms/${code}/host`);
host.send({ t: "host", secret });
assert.deepEqual(await host.json(), { t: "hosted" });
host.send("ping");
assert.equal(await host.next(), "pong");
host.send({ t: "game", game: GAME });
log("hosted; ping → pong; game sent");
await new Promise((r) => setTimeout(r, 100));
assert.deepEqual(await (await api("GET", `/api/rooms/${code}`)).json(), { code, host: true, game: GAME });
log("GET room:", JSON.stringify(GAME));

// Offer → answer.
join = await Socket.open(`${WS_BASE}/api/rooms/${code}/join?role=player&p=TOKEN`);
join.send({ t: "offer", sdp: "v=0 offer" });
const offer = await host.json();
assert.equal(offer.t, "offer");
assert.equal(offer.sdp, "v=0 offer");
assert.equal(offer.query, "role=player&p=TOKEN");
log("host got", JSON.stringify(offer));
host.send({ t: "answer", conn: offer.conn, sdp: "v=0 answer" });
assert.deepEqual(await join.json(), { t: "answer", sdp: "v=0 answer" });
assert.equal(await join.closeCode(), 1000);
log("join got the answer, closed 1000");

// Reject.
join = await Socket.open(`${WS_BASE}/api/rooms/${code}/join?screen=1&token=T`);
join.send({ t: "offer", sdp: "v=0 screen" });
const offer2 = await host.json();
assert.equal(offer2.conn, (offer.conn as number) + 1);
host.send({ t: "reject", conn: offer2.conn, reason: "denied" });
assert.deepEqual(await join.json(), { t: "reject", reason: "denied" });
assert.equal(await join.closeCode(), 1000);
log("reject: conn", offer2.conn, "closed 1000");

// Too large.
join = await Socket.open(`${WS_BASE}/api/rooms/${code}/join`);
join.send({ t: "offer", sdp: "x".repeat(17000) });
assert.equal(await join.closeCode(), 1009);
log("17 KB offer: 1009");

if (slow) {
  join = await Socket.open(`${WS_BASE}/api/rooms/${code}/join`);
  join.send({ t: "offer", sdp: "v=0 unanswered" });
  await host.json();
  assert.deepEqual(await join.json(20_000), { t: "timeout" });
  assert.equal(await join.closeCode(), 1000);
  log("unanswered: timeout after 15 s");
}

// A second host replaces the first; an open offer hears no-host.
join = await Socket.open(`${WS_BASE}/api/rooms/${code}/join`);
join.send({ t: "offer", sdp: "v=0 pending" });
await host.json();
const host2 = await Socket.open(`${WS_BASE}/api/rooms/${code}/host`);
host2.send({ t: "host", secret });
assert.deepEqual(await host2.json(), { t: "hosted" });
assert.deepEqual(await host.json(), { t: "replaced" });
assert.equal(await host.closeCode(), 4009);
assert.deepEqual(await join.json(), { t: "no-host" });
assert.equal(await join.closeCode(), 1013);
log("replaced: old host 4009, pending offer no-host 1013");
host = host2;

// The host leaves: no host, the game stays.
host.ws.close(1000);
await host.closeCode();
await new Promise((r) => setTimeout(r, 200));
assert.deepEqual(await (await api("GET", `/api/rooms/${code}`)).json(), { code, host: false, game: GAME });
log("host gone: GET room says host false, game kept");

res = await api("DELETE", `/api/links/${code}`, undefined, secret);
assert.equal(res.status, 204);
res = await api("GET", `/api/rooms/${code}`);
assert.equal(res.status, 404);
log("deleted: GET room 404", ((await res.json()) as { error: { code: string } }).error.code);
console.log("all good");
