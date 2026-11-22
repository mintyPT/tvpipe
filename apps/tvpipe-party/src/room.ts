// The `Room` Durable Object: WebRTC signaling for one web room
// (docs/browser-party-design.md, "Signaling"). One object per code
// (`env.ROOMS.idFromName(CODE)`), SQLite-backed, with hibernating
// WebSockets: what must outlive hibernation is in the sockets'
// attachments (who they are, their deadlines) and in storage (the game,
// the connection counter, the owner); the rate limiters are in memory
// and start afresh after hibernation, which only makes them kinder.

import type { DurableObjectState, Env, WorkerWebSocket } from "./env.ts";
import { hashSecret, lookupRow, webLink } from "./links.ts";

/** The host's `{t: "host"}` and a join's offer: within 10 s of the upgrade. */
export const FIRST_MS = 10_000;
/** The host's answer to an offer: within 15 s. */
export const ANSWER_MS = 15_000;
/** Messages up to 16 KiB (close 1009). */
export const MAX_MESSAGE = 16 * 1024;
/** Open join sockets per room: `2 × 64 + 16`. */
export const MAX_JOINS = 2 * 64 + 16;
/** Host sockets per room (the host, its replacement, some waiting for `host`). */
export const MAX_HOSTS = 8;
/** Offers per address: 30 a minute. */
export const ADDRESS_OFFERS = 30;
export const ADDRESS_WINDOW_MS = 60_000;
/** Offers per room: 5 a second, a burst of 30. */
export const ROOM_RATE = 5;
export const ROOM_BURST = 30;
/** Storage is dropped after this long without any socket and with no host. */
export const CLEANUP_MS = 25 * 60 * 60 * 1000;
export const MAX_QUERY = 1024;
export const MAX_AGENT = 256;
const MAX_FIELD = 200;
const MAX_PHONE = 300;
const OPEN = 1;

/** What the object answers `GET /api/rooms/CODE` with (the code added by app.ts). */
export interface RoomState {
  host: boolean;
  game: Game | null;
}

export interface Game {
  name: string;
  title: string;
  release: string;
  phone: string;
}

/** A host socket's attachment. */
interface HostInfo {
  r: "host";
  code: string;
  origin: string;
  /** The secret was checked. */
  ok: boolean;
  /** SHA-256 of its secret, once ok. */
  hash?: string;
  /** Deadline of the `host` message, 0 once ok. */
  d: number;
}

/** A join socket's attachment. */
interface JoinInfo {
  r: "join";
  addr: string;
  agent: string;
  query: string;
  /** 0: waiting for the offer; 1: offered, waiting for the answer. */
  s: 0 | 1;
  conn?: number;
  /** Deadline of the offer (s 0) or of the answer (s 1). */
  d: number;
}

type Info = HostInfo | JoinInfo;

/**
 * What the runtime gives that Node does not (WebSocketPair, a 101
 * response, the auto-response pair) and the clock: tests replace them.
 */
export const runtime = {
  now: (): number => Date.now(),
  pair(): [WorkerWebSocket, WorkerWebSocket] {
    const Pair = (globalThis as unknown as { WebSocketPair: new () => Record<0 | 1, WorkerWebSocket> }).WebSocketPair;
    const p = new Pair();
    return [p[0], p[1]];
  },
  upgraded(client: WorkerWebSocket): Response {
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  },
  autoResponse(): unknown {
    const Pair = (globalThis as unknown as { WebSocketRequestResponsePair: new (a: string, b: string) => unknown })
      .WebSocketRequestResponsePair;
    return new Pair("ping", "pong");
  },
};

/** The header app.ts passes the registry's secret hash in, for `GET`. */
export const OWNER_HEADER = "X-Tvpipe-Owner";

const ROOM_PATH = /^\/api\/rooms\/([A-Z]{4})(?:\/(host|join))?$/;

function utf8Length(s: string): number {
  // Cheap bounds first: UTF-16 units ≤ bytes ≤ 3 × units.
  if (s.length > MAX_MESSAGE) return s.length;
  if (s.length * 3 <= MAX_MESSAGE) return s.length;
  return new TextEncoder().encode(s).byteLength;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function shortString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max;
}

function isConn(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 0xffffffff;
}

function parseGame(v: unknown): Game | null | undefined {
  if (v === null) return null;
  if (!isObject(v)) return undefined;
  const { name, title, release, phone } = v;
  if (!shortString(name, MAX_FIELD) || !shortString(title, MAX_FIELD) || !shortString(release, MAX_FIELD)) {
    return undefined;
  }
  if (!shortString(phone, MAX_PHONE)) return undefined;
  return { name, title, release, phone };
}

function send(ws: WorkerWebSocket, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Closed meanwhile: nothing to tell.
  }
}

function close(ws: WorkerWebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

/** `{t: "error", code}`, then close. */
function fail(ws: WorkerWebSocket, closeCode: number, code: string): void {
  send(ws, { t: "error", code });
  close(ws, closeCode, code);
}

function info(ws: WorkerWebSocket): Info | null {
  try {
    return (ws.deserializeAttachment() as Info | null) ?? null;
  } catch {
    return null;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export class Room {
  ctx: DurableObjectState;
  env: Env;
  /** Offers per address in the current minute. */
  private perAddress = new Map<string, { start: number; n: number }>();
  /** The room's token bucket of offers. */
  private bucket = { tokens: ROOM_BURST, at: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    // `ping` → `pong` without waking the object.
    ctx.setWebSocketAutoResponse(runtime.autoResponse());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const m = ROOM_PATH.exec(url.pathname);
    if (!m) return json(404, { error: { code: "not-found", message: "No such API." } });
    const code = m[1]!;
    if (m[2] === undefined) return this.state(request.headers.get(OWNER_HEADER) ?? "");
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
      return json(426, { error: { code: "upgrade-required", message: "This is a WebSocket." } });
    }
    const now = runtime.now();
    const [client, server] = runtime.pair();
    if (m[2] === "host") {
      const full = this.open("host").length >= MAX_HOSTS;
      this.ctx.acceptWebSocket(server, ["host"]);
      if (full) {
        fail(server, 1013, "full");
      } else {
        const a: HostInfo = { r: "host", code, origin: url.origin, ok: false, d: now + FIRST_MS };
        server.serializeAttachment(a);
        await this.schedule(a.d);
      }
    } else {
      const full = this.open("join").length >= MAX_JOINS;
      this.ctx.acceptWebSocket(server, ["join"]);
      if (full) {
        fail(server, 1013, "full");
      } else {
        const a: JoinInfo = {
          r: "join",
          addr: (request.headers.get("CF-Connecting-IP") ?? "unknown").slice(0, 64),
          agent: (request.headers.get("User-Agent") ?? "").slice(0, MAX_AGENT),
          query: url.search.slice(1, 1 + MAX_QUERY),
          s: 0,
          d: now + FIRST_MS,
        };
        server.serializeAttachment(a);
        await this.schedule(a.d);
      }
    }
    return runtime.upgraded(client);
  }

  async webSocketMessage(ws: WorkerWebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = info(ws);
    if (a === null) return;
    if (typeof message !== "string") return fail(ws, 1003, "bad-message");
    if (utf8Length(message) > MAX_MESSAGE) return close(ws, 1009, "too-large");
    let m: unknown;
    try {
      m = JSON.parse(message);
    } catch {
      return fail(ws, 1008, "bad-message");
    }
    if (!isObject(m) || typeof m.t !== "string") return fail(ws, 1008, "bad-message");
    if (a.r === "host") await this.hostMessage(ws, a, m);
    else await this.joinMessage(ws, a, m);
  }

  async webSocketClose(ws: WorkerWebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    // Finish the closing handshake (1005/1006 cannot be sent).
    close(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
    await this.closed(ws);
  }

  async webSocketError(ws: WorkerWebSocket): Promise<void> {
    await this.closed(ws);
  }

  /** The deadlines: hosts and joins waiting for their first message, offers for an answer. */
  async alarm(): Promise<void> {
    const now = runtime.now();
    let next = Infinity;
    const sockets = this.open();
    for (const ws of sockets) {
      const a = info(ws);
      if (a === null || a.d === 0) continue;
      if (a.d > now) {
        next = Math.min(next, a.d);
      } else if (a.r === "join" && a.s === 1) {
        send(ws, { t: "timeout" });
        close(ws, 1000, "timeout");
      } else {
        fail(ws, 4002, "timeout");
      }
    }
    if (sockets.length === 0) {
      const seen = await this.ctx.storage.get<number>("seen");
      if (seen !== undefined && seen + CLEANUP_MS <= now) {
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.deleteAlarm();
        return;
      }
      if (seen !== undefined) next = Math.min(next, seen + CLEANUP_MS);
    }
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
  }

  /** `GET /api/rooms/CODE`: what the room knows, for the registry's owner `owner`. */
  private async state(owner: string): Promise<Response> {
    const host = this.host();
    const stored = await this.ctx.storage.get<string>("owner");
    const game = stored === owner ? ((await this.ctx.storage.get<Game>("game")) ?? null) : null;
    const state: RoomState = { host: host !== null && (info(host) as HostInfo).hash === owner, game };
    return json(200, state);
  }

  private async hostMessage(ws: WorkerWebSocket, a: HostInfo, m: Record<string, unknown>): Promise<void> {
    if (!a.ok) {
      if (m.t !== "host" || !shortString(m.secret, 256)) return fail(ws, 1008, "bad-message");
      let hash: string | null;
      try {
        hash = await this.verify(a, m.secret);
      } catch {
        return fail(ws, 1011, "unavailable");
      }
      if (ws.readyState !== OPEN) return;
      if (hash === null) return fail(ws, 4003, "bad-secret");
      await this.hosted(ws, a, hash);
      return;
    }
    switch (m.t) {
      case "game": {
        const game = parseGame(m.game);
        if (game === undefined) return fail(ws, 1008, "bad-message");
        await this.ctx.storage.put("game", game);
        return;
      }
      case "answer": {
        if (!isConn(m.conn) || typeof m.sdp !== "string") return fail(ws, 1008, "bad-message");
        const join = this.offered(m.conn);
        if (join === null) return;
        send(join, { t: "answer", sdp: m.sdp });
        close(join, 1000, "answer");
        return;
      }
      case "reject": {
        const reason = m.reason ?? "";
        if (!isConn(m.conn) || !shortString(reason, MAX_FIELD)) return fail(ws, 1008, "bad-message");
        const join = this.offered(m.conn);
        if (join === null) return;
        send(join, { t: "reject", reason });
        close(join, 1000, "reject");
        return;
      }
      default:
        // Newer hosts may say more; nothing to do.
        return;
    }
  }

  /** The secret's hash when it is the registry's for this code and the row is a web room's link. */
  private async verify(a: HostInfo, secret: string): Promise<string | null> {
    const hash = await hashSecret(secret);
    const row = await lookupRow(this.env.DB, a.code);
    if (row === null || row.secret !== hash) return null;
    return webLink(row.url, a.origin)?.code === a.code ? hash : null;
  }

  private async hosted(ws: WorkerWebSocket, a: HostInfo, hash: string): Promise<void> {
    a.ok = true;
    a.hash = hash;
    a.d = 0;
    ws.serializeAttachment(a);
    const storage = this.ctx.storage;
    if ((await storage.get<string>("owner")) !== hash) {
      // The code belongs to another room now: the old one's game is not this one's.
      await storage.delete("game");
      await storage.put("owner", hash);
    }
    await storage.delete("seen");
    send(ws, { t: "hosted" });
    for (const other of this.open("host")) {
      if (other === ws || !(info(other) as HostInfo | null)?.ok) continue;
      send(other, { t: "replaced" });
      close(other, 4009, "replaced");
    }
    // Offers made to the old host will not be answered: their clients retry.
    this.dropOffers();
  }

  private async joinMessage(ws: WorkerWebSocket, a: JoinInfo, m: Record<string, unknown>): Promise<void> {
    if (a.s !== 0 || m.t !== "offer" || typeof m.sdp !== "string" || m.sdp === "") {
      return fail(ws, 1008, "bad-message");
    }
    const now = runtime.now();
    if (!this.allowOffer(a.addr, now)) return fail(ws, 4008, "rate-limited");
    if (this.host() === null) {
      send(ws, { t: "no-host" });
      return close(ws, 1013, "no-host");
    }
    const storage = this.ctx.storage;
    const last = (await storage.get<number>("conn")) ?? 0;
    const conn = last >= 0xffffffff ? 1 : last + 1;
    await storage.put("conn", conn);
    const host = this.host();
    if (ws.readyState !== OPEN) return;
    if (host === null) {
      send(ws, { t: "no-host" });
      return close(ws, 1013, "no-host");
    }
    a.s = 1;
    a.conn = conn;
    a.d = now + ANSWER_MS;
    ws.serializeAttachment(a);
    await this.schedule(a.d);
    send(host, { t: "offer", conn, sdp: m.sdp, query: a.query, addr: a.addr, agent: a.agent });
  }

  /** 30 offers a minute per address, 5 a second (burst 30) per room. */
  private allowOffer(addr: string, now: number): boolean {
    if (this.perAddress.size > 1000) {
      for (const [k, v] of this.perAddress) if (now - v.start >= ADDRESS_WINDOW_MS) this.perAddress.delete(k);
    }
    let w = this.perAddress.get(addr);
    if (w === undefined || now - w.start >= ADDRESS_WINDOW_MS) {
      w = { start: now, n: 0 };
      this.perAddress.set(addr, w);
    }
    const b = this.bucket;
    b.tokens = Math.min(ROOM_BURST, b.tokens + ((now - b.at) / 1000) * ROOM_RATE);
    b.at = now;
    if (w.n >= ADDRESS_OFFERS || b.tokens < 1) return false;
    w.n++;
    b.tokens--;
    return true;
  }

  private async closed(ws: WorkerWebSocket): Promise<void> {
    const a = info(ws);
    if (a === null || a.r !== "host" || !a.ok) return;
    // Another host took over already (it replaced this one): nothing changes.
    if (this.host(ws) !== null) return;
    this.dropOffers();
    const now = runtime.now();
    await this.ctx.storage.put("seen", now);
    await this.schedule(now + CLEANUP_MS);
  }

  /** Offers waiting for an answer get `no-host`: the host that had them is gone. */
  private dropOffers(): void {
    for (const join of this.open("join")) {
      const j = info(join);
      if (j?.r === "join" && j.s === 1) {
        send(join, { t: "no-host" });
        close(join, 1013, "no-host");
      }
    }
  }

  /** The checked host's socket (other than `except`), or null. */
  private host(except?: WorkerWebSocket): WorkerWebSocket | null {
    for (const ws of this.open("host")) {
      if (ws !== except && (info(ws) as HostInfo | null)?.ok) return ws;
    }
    return null;
  }

  /** The join socket of `conn` waiting for its answer, or null. */
  private offered(conn: number): WorkerWebSocket | null {
    for (const ws of this.open("join")) {
      const j = info(ws);
      if (j?.r === "join" && j.s === 1 && j.conn === conn) return ws;
    }
    return null;
  }

  private open(tag?: string): WorkerWebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === OPEN);
  }

  /** The alarm at `at` at the latest. */
  private async schedule(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }
}
