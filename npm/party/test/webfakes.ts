/**
 * Fakes of what web mode uses (docs/browser-party-design.md): a
 * tvpipe.party in memory (`FakeService`: the links registry, `/api/turn`,
 * `/g/index.json`, the rooms' signaling as the Room object answers it),
 * WebSockets to it, RTCPeerConnection pairs whose data channels deliver
 * in order and asynchronously (with a backlog a test can hold), and
 * BroadcastChannel. `service.deps` goes to `setWebDeps`.
 */

import type { BroadcastLike, ChannelLike, Description, PeerLike, SocketLike, WebDeps } from "../src/rtc.ts";
import type { WebGames } from "../src/webhub.ts";

const later = (f: () => void) => setTimeout(f, 0);

// ---------------------------------------------------------------------------
// Data channels

export class FakeChannel implements ChannelLike {
  readonly label: string;
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = "blob";
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onbufferedamountlow: ((ev: any) => void) | null = null;
  peer: FakeChannel | undefined;
  /** Hold what is sent (backpressure tests): it waits in `bufferedAmount`. */
  hold = false;
  #queue: (string | Uint8Array)[] = [];
  /** Everything this side sent, for checks. */
  readonly sent: (string | Uint8Array)[] = [];

  constructor(label: string) {
    this.label = label;
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== "open") throw new Error("InvalidStateError");
    this.sent.push(data);
    const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    this.bufferedAmount += size;
    this.#queue.push(typeof data === "string" ? data : data.slice());
    if (!this.hold) this.flush();
  }

  /** Delivers the backlog (`hold` off). */
  flush(): void {
    const items = this.#queue;
    this.#queue = [];
    for (const d of items) {
      later(() => {
        const size = typeof d === "string" ? Buffer.byteLength(d) : d.byteLength;
        const before = this.bufferedAmount;
        this.bufferedAmount -= size;
        if (this.peer && this.peer.readyState === "open") this.peer.onmessage?.({ data: typeof d === "string" ? d : d.buffer });
        if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) this.onbufferedamountlow?.({});
      });
    }
  }

  close(): void {
    if (this.readyState === "closed" || this.readyState === "closing") return;
    this.readyState = "closing";
    // What is queued goes out first.
    later(() => {
      const peer = this.peer;
      this.finish();
      peer?.finish();
    });
  }

  /** @internal */
  finish(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.({});
  }

  /** A network loss: both sides close without a close frame. */
  cut(): void {
    this.finish();
    this.peer?.finish();
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.({});
  }
}

/** Offers waiting for their answer, by the offer's SDP. */
const peers = new Map<string, FakePeer>();
let peerSeq = 0;

export class FakePeer implements PeerLike {
  localDescription: Description | null = null;
  remoteDescription: Description | null = null;
  iceGatheringState = "new";
  connectionState = "new";
  onicegatheringstatechange: ((ev: any) => void) | null = null;
  ondatachannel: ((ev: { channel: ChannelLike }) => void) | null = null;
  onconnectionstatechange: ((ev: any) => void) | null = null;
  channel: FakeChannel | undefined;
  closed = false;
  readonly config: unknown;
  static all: FakePeer[] = [];

  constructor(config: unknown) {
    this.config = config;
    FakePeer.all.push(this);
  }

  createDataChannel(label: string): ChannelLike {
    this.channel = new FakeChannel(label);
    return this.channel;
  }

  async createOffer(): Promise<Description> {
    return { type: "offer", sdp: `offer:${++peerSeq}` };
  }

  async createAnswer(): Promise<Description> {
    return { type: "answer", sdp: `answer:${this.remoteDescription?.sdp}` };
  }

  async setLocalDescription(d?: Description): Promise<void> {
    this.localDescription = d ?? null;
    if (d?.type === "offer" && d.sdp) peers.set(d.sdp, this);
    // Gathering takes a moment, then completes.
    this.iceGatheringState = "gathering";
    later(() => {
      this.iceGatheringState = "complete";
      this.onicegatheringstatechange?.({});
    });
  }

  async setRemoteDescription(d: Description): Promise<void> {
    this.remoteDescription = d;
    if (d.type !== "answer" || !d.sdp) return;
    const offer = d.sdp.replace(/^answer:/, "");
    const host = [...FakePeer.all].find((p) => p.remoteDescription?.sdp === offer && p !== this);
    peers.delete(offer);
    if (!host || !this.channel) return;
    // Connected: the host gets the channel, both open.
    const mine = this.channel;
    const theirs = new FakeChannel(mine.label);
    mine.peer = theirs;
    theirs.peer = mine;
    later(() => {
      if (this.closed || host.closed) return;
      theirs.readyState = "open";
      host.ondatachannel?.({ channel: theirs });
      theirs.onopen?.({});
      mine.open();
    });
  }

  close(): void {
    this.closed = true;
    this.channel?.cut();
  }
}

// ---------------------------------------------------------------------------
// WebSockets to the fake service

export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  readonly url: string;
  /** The service's side. */
  server: { message(text: string): void; closed(): void } | undefined;

  constructor(service: FakeService, url: string) {
    this.url = url;
    later(() => {
      if (this.readyState !== 0) return;
      this.server = service.accept(this);
      if (!this.server) {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({ code: 1006, reason: "" });
        return;
      }
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    const s = this.server;
    later(() => s?.message(data));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    later(() => {
      this.server?.closed();
      this.readyState = 3;
      this.onclose?.({ code, reason });
    });
  }

  /** From the service. */
  deliver(text: string): void {
    if (this.readyState === 1) later(() => this.readyState === 1 && this.onmessage?.({ data: text }));
  }

  /** The service closes it. */
  kill(code: number, reason = ""): void {
    if (this.readyState === 3) return;
    later(() => {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.server?.closed();
      this.onclose?.({ code, reason });
    });
  }
}

// ---------------------------------------------------------------------------
// BroadcastChannel

const channels = new Map<string, Set<FakeBroadcast>>();

export class FakeBroadcast implements BroadcastLike {
  readonly name: string;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  #closed = false;

  constructor(name: string) {
    this.name = name;
    let set = channels.get(name);
    if (!set) channels.set(name, (set = new Set()));
    set.add(this);
  }

  postMessage(msg: unknown): void {
    if (this.#closed) throw new Error("closed");
    const copy = structuredClone(msg);
    for (const other of channels.get(this.name) ?? []) {
      if (other !== this) later(() => !other.#closed && other.onmessage?.({ data: copy }));
    }
  }

  close(): void {
    this.#closed = true;
    channels.get(this.name)?.delete(this);
  }
}

// ---------------------------------------------------------------------------
// The service

interface Link {
  url: string;
  secret: string;
}

interface RoomState {
  host: FakeSocket | undefined;
  conn: number;
  joins: Map<number, FakeSocket>;
  game: unknown;
}

type Reply = { status: number; ok: boolean; headers: { get(n: string): string | null }; json(): Promise<any> };

function reply(status: number, body: unknown = null, headers: Record<string, string> = {}): Reply {
  return { status, ok: status >= 200 && status < 300, headers: { get: (n) => headers[n] ?? headers[n.toLowerCase()] ?? null }, json: async () => body };
}

export const ORIGIN = "https://tvpipe.test";

export function gamesList(): WebGames {
  const game = (name: string, release: string) => ({
    name,
    title: name[0]!.toUpperCase() + name.slice(1),
    summary: "",
    release,
    players: { min: 2, max: 8 },
    languages: ["en"],
    tv: { width: 1920, height: 1080, resolution: "fixed" as const },
    path: `/g/${name}/${release}/`,
    pages: { host: `/g/${name}/${release}/host/index.html`, tv: `/g/${name}/${release}/screen/index.html`, phone: `/g/${name}/${release}/phone/index.html` },
  });
  return { v: 1, games: [game("quiz", "1.0.0"), game("snug", "0.2.0")] };
}

export class FakeService {
  readonly links = new Map<string, Link>();
  readonly rooms = new Map<string, RoomState>();
  readonly requests: string[] = [];
  /** Codes `POST /api/links` refuses (409) once each. */
  readonly taken = new Set<string>();
  /** `POST /api/links` answers 429 (Retry-After 0) this many times first. */
  busy = 0;
  /** `POST /api/links` answers 409 this many times first (taken codes). */
  refuse = 0;
  readonly deps: WebDeps;
  #secrets = 0;

  constructor() {
    const service = this;
    this.deps = {
      origin: ORIGIN,
      fetch: (url, init) => this.fetch(url, init),
      WebSocket: class extends FakeSocket {
        constructor(url: string) {
          super(service, url);
        }
      },
      RTCPeerConnection: FakePeer,
      BroadcastChannel: FakeBroadcast,
    };
  }

  async fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
    const method = init.method ?? "GET";
    const path = url.replace(ORIGIN, "");
    this.requests.push(`${method} ${path}`);
    if (path === "/api/turn") return reply(200, { iceServers: [{ urls: "stun:stun.test:3478" }], ttl: 3600 });
    if (path === "/g/index.json") return reply(200, gamesList());
    if (path === "/api/links" && method === "POST") {
      if (this.busy > 0) {
        this.busy--;
        return reply(429, { error: { code: "rate-limited" } }, { "Retry-After": "0" });
      }
      const body = JSON.parse(init.body ?? "{}");
      const code = String(body.code);
      if (this.refuse > 0 || this.taken.has(code) || this.links.has(code)) {
        if (this.refuse > 0) this.refuse--;
        this.taken.delete(code);
        return reply(409, { error: { code: "code-taken" } });
      }
      const secret = `secret${++this.#secrets}`;
      this.links.set(code, { url: body.url, secret });
      return reply(201, { code, short: `${ORIGIN}/${code}`, url: body.url, secret });
    }
    const m = /^\/api\/links\/([A-Z]+)$/.exec(path);
    if (m) {
      const link = this.links.get(m[1]!);
      const ok = link && init.headers?.["authorization"] === `Bearer ${link.secret}`;
      if (method === "PUT") return ok ? reply(200, { code: m[1], short: `${ORIGIN}/${m[1]}`, url: link!.url }) : reply(404, { error: { code: "not-found" } });
      if (method === "DELETE") {
        if (ok) this.links.delete(m[1]!);
        return reply(204);
      }
    }
    return reply(404, { error: { code: "not-found" } });
  }

  #room(code: string): RoomState {
    let r = this.rooms.get(code);
    if (!r) this.rooms.set(code, (r = { host: undefined, conn: 0, joins: new Map(), game: null }));
    return r;
  }

  /** A WebSocket to the service: the room's host or join socket. */
  accept(ws: FakeSocket): FakeSocket["server"] {
    const u = new URL(ws.url.replace(/^ws/, "http"));
    const m = /^\/api\/rooms\/([A-Z]+)\/(host|join)$/.exec(u.pathname);
    if (!m) return undefined;
    const code = m[1]!;
    const room = this.#room(code);
    if (m[2] === "host") {
      let hosted = false;
      return {
        message: (text) => {
          if (text === "ping") return ws.deliver("pong");
          const msg = JSON.parse(text);
          if (!hosted) {
            const link = this.links.get(code);
            if (msg.t !== "host" || !link || link.secret !== msg.secret) {
              ws.deliver(JSON.stringify({ t: "error", code: "bad-secret" }));
              return ws.kill(4003, "bad secret");
            }
            hosted = true;
            const old = room.host;
            room.host = ws;
            if (old) {
              old.deliver(JSON.stringify({ t: "replaced" }));
              old.kill(4009, "replaced");
            }
            return ws.deliver(JSON.stringify({ t: "hosted" }));
          }
          if (msg.t === "game") room.game = msg.game;
          const join = room.joins.get(msg.conn);
          if (!join) return;
          room.joins.delete(msg.conn);
          if (msg.t === "answer") join.deliver(JSON.stringify({ t: "answer", sdp: msg.sdp }));
          else if (msg.t === "reject") join.deliver(JSON.stringify({ t: "reject", reason: msg.reason }));
          join.kill(1000);
        },
        closed: () => {
          if (room.host === ws) room.host = undefined;
        },
      };
    }
    const query = u.search.replace(/^\?/, "");
    let conn = 0;
    return {
      message: (text) => {
        const msg = JSON.parse(text);
        if (msg.t !== "offer" || conn) return;
        if (!room.host) {
          ws.deliver(JSON.stringify({ t: "no-host" }));
          return ws.kill(1013, "no host");
        }
        conn = ++room.conn;
        room.joins.set(conn, ws);
        room.host.deliver(JSON.stringify({ t: "offer", conn, sdp: msg.sdp, query, addr: "203.0.113.9", agent: "FakePhone/1.0" }));
      },
      closed: () => {
        if (conn) room.joins.delete(conn);
      },
    };
  }
}

/** Resolves once `cond()` holds, or fails after `ms`. */
export async function until(cond: () => boolean, ms = 3000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
