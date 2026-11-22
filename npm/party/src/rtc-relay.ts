/**
 * The host side of web mode's transport (docs/browser-party-design.md,
 * "The transport"): `WebRtcRelay` implements `Relay` with a
 * `RTCPeerConnection` per phone or screen, offered through the room's
 * signaling ({@link HostSignal}), and takes the local transport's
 * connections ({@link LocalHost}) too.
 *
 *   const relay = new WebRtcRelay({ signal: new HostSignal(url, secret), publicUrl, maxConnections });
 *   relay.addLocal(new LocalHost(code, relay.nextId));
 *   party.listen(relay);
 *   relay.onscreen = (req) => req.answer(ok, tvUrl);   // extra screens (`?screen=1&token=T`)
 *
 * It keeps tvpipe's relay limits (playshare-design.md §6.3, the web's
 * numbers) on data channels: messages up to 64 KiB (1009), 20 a second
 * with a burst of 50 (4008), `maxConnections` (a refused offer), the
 * first message within 10 s (4002); pings every 15 s, closed after 45 s
 * of silence, or 1006 once the peer connection is `disconnected` for 5 s
 * or `failed` (a closed tab says nothing; ICE notices). Connections of another game's page (`g=NAME/RELEASE` in
 * the query, not {@link WebRtcRelay.game}) are closed with 4014.
 */

import { TokenBucket } from "./limits.ts";
import type { LocalHost } from "./local.ts";
import type { Relay, RelayConn } from "./relay.ts";
import { CHANNEL_LABEL, ChannelEnd, gathered, iceServers, LOST_MS, MAX_MESSAGE, utf8Over, webDeps, type ChannelLike, type IceServer, type PeerLike, type WebDeps } from "./rtc.ts";
import type { Offer } from "./signaling.ts";

/** What the relay needs of the signaling (a {@link HostSignal}, or a test's). */
export interface HostSignaling {
  onoffer: ((offer: Offer) => void) | undefined;
  answer(conn: number, sdp: string): boolean;
  reject(conn: number, reason: string): boolean;
  close(): void;
}

/** An extra screen asks to show the game (`!{"t":"screen",…}` on a `screen=1` connection). */
export interface ScreenRequest {
  /** The screen's token (its `localStorage`'s), from the query. */
  token: string;
  /** Its browser (`User-Agent`, as the screen says it). */
  agent: string;
  address: string;
  /** Answers: `ok` with the TV page to show (`role=watch`), then the connection closes (1000). */
  answer(ok: boolean, url?: string): void;
  /** The screen went away before an answer. */
  onclose: (() => void) | undefined;
}

export interface WebRtcRelayOptions {
  signal: HostSignaling;
  /** The base URL phones use (`https://tvpipe.party/r/`). */
  publicUrl: string;
  /** Data channel connections at most (`2 × players.max + 16`); default 32. */
  maxConnections?: number | undefined;
  /** Default `GET /api/turn`. */
  iceServers?: (() => Promise<IceServer[]>) | undefined;
  deps?: WebDeps | undefined;
  limits?: { message?: number; rate?: number; burst?: number; firstMs?: number; pingMs?: number; deadMs?: number; lostMs?: number } | undefined;
}

/** A data channel's connection as the host sees it. */
class RtcConn implements RelayConn {
  readonly id: number;
  readonly via = "public" as const;
  readonly address: string;
  readonly query: string;
  readonly agent: string;
  closed = false;
  onmessage: ((data: string | Uint8Array) => void) | undefined;
  onclose: ((code: number, reason: string) => void) | undefined;
  ondrain: (() => void) | undefined;
  /** @internal */ oncontrol: ((msg: Record<string, unknown>) => void) | undefined;
  readonly #end: ChannelEnd;
  #first: ReturnType<typeof setTimeout> | undefined;
  #ended = false;

  constructor(id: number, offer: Offer, ch: ChannelLike, pc: PeerLike, limits: Required<NonNullable<WebRtcRelayOptions["limits"]>>, done: (c: RtcConn) => void) {
    this.id = id;
    this.address = offer.addr;
    this.query = offer.query;
    this.agent = offer.agent;
    const bucket = new TokenBucket(limits.rate, limits.burst);
    this.#first = setTimeout(() => this.close(4002, "no message"), limits.firstMs);
    const seen = () => {
      if (this.#first) clearTimeout(this.#first);
      this.#first = undefined;
    };
    this.#end = new ChannelEnd(ch, {
      pingMs: limits.pingMs,
      deadMs: limits.deadMs,
      peer: pc,
      lostMs: limits.lostMs,
      onmessage: (data) => {
        if (this.closed) return;
        seen();
        const big = typeof data === "string" ? utf8Over(data, limits.message) : data.length > limits.message;
        if (big) return this.close(1009, "too big");
        if (!bucket.take()) return this.close(4008, "too fast");
        this.onmessage?.(data);
      },
      oncontrol: (msg) => {
        if (this.closed) return;
        seen();
        if (!bucket.take()) return this.close(4008, "too fast");
        this.oncontrol?.(msg);
      },
      ondrain: () => this.ondrain?.(),
      onclose: (code, reason) => {
        if (this.#ended) return;
        this.#ended = true;
        this.closed = true;
        seen();
        done(this);
        this.onclose?.(code, reason);
      },
    });
  }

  get busy(): boolean {
    return this.#end.busy;
  }

  send(text: string): void {
    if (!this.closed) this.#end.send(text);
  }

  sendBinary(data: Uint8Array): void {
    if (!this.closed) this.#end.send(data);
  }

  /** @internal */
  control(msg: Record<string, unknown>): void {
    if (!this.closed) this.#end.control(msg);
  }

  close(code: number, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.#end.close(code, reason);
  }
}

/** The relay over data channels and the local transport; see the module docs. */
export class WebRtcRelay implements Relay {
  onopen: ((conn: RelayConn) => void) | undefined;
  onclosing: (() => void) | undefined;
  /** An extra screen's request; without a handler every one is refused. */
  onscreen: ((req: ScreenRequest) => void) | undefined;
  readonly publicUrl: string;
  maxConnections: number;
  /**
   * The game of this host page (`NAME/RELEASE`): a connection that names
   * another (`g=` in its query: a page of an earlier game) is closed 4014.
   */
  game: string | undefined;
  readonly #signal: HostSignaling;
  readonly #ice: () => Promise<IceServer[]>;
  readonly #deps: WebDeps;
  readonly #limits: Required<NonNullable<WebRtcRelayOptions["limits"]>>;
  readonly #conns = new Set<RelayConn>();
  readonly #peers = new Set<PeerLike>();
  readonly #locals: LocalHost[] = [];
  #next = 0;
  #closed = false;
  /** Connection numbers (shared with {@link LocalHost}s). */
  readonly nextId = (): number => ++this.#next;

  constructor(o: WebRtcRelayOptions) {
    this.#signal = o.signal;
    this.publicUrl = o.publicUrl;
    this.maxConnections = o.maxConnections ?? 32;
    this.#deps = o.deps ?? webDeps();
    this.#ice = o.iceServers ?? (() => iceServers(this.#deps));
    this.#limits = { message: MAX_MESSAGE, rate: 20, burst: 50, firstMs: 10_000, pingMs: 15_000, deadMs: 45_000, lostMs: LOST_MS, ...o.limits };
    o.signal.onoffer = (offer) => void this.#offer(offer);
  }

  /** Takes the connections of a local transport too (`via: "local"`; no limits). */
  addLocal(host: LocalHost): void {
    this.#locals.push(host);
    host.onopen = (conn) => this.#opened(conn);
    host.onend = (conn) => this.#conns.delete(conn);
  }

  /** Open connections (both transports). */
  get size(): number {
    return this.#conns.size;
  }

  connections(): Iterable<RelayConn> {
    return [...this.#conns];
  }

  async #offer(offer: Offer): Promise<void> {
    if (this.#closed) return;
    // Peers being set up count: a burst of offers cannot pass the limit.
    const rtc = [...this.#conns].filter((c) => c.via === "public").length + this.#peers.size;
    if (rtc >= this.maxConnections) {
      this.#signal.reject(offer.conn, "full");
      return;
    }
    let pc: PeerLike;
    try {
      pc = new this.#deps.RTCPeerConnection({ iceServers: await this.#ice() });
    } catch {
      this.#signal.reject(offer.conn, "failed");
      return;
    }
    this.#peers.add(pc);
    let conn: RtcConn | undefined;
    const drop = () => {
      clearTimeout(timer);
      this.#peers.delete(pc);
      try {
        pc.close();
      } catch {}
    };
    // A channel that does not open: given up.
    const timer = setTimeout(() => {
      if (!conn) drop();
    }, 20_000);
    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      if (ch.label !== CHANNEL_LABEL || conn) {
        try {
          ch.close();
        } catch {}
        return;
      }
      const ready = () => {
        if (conn || this.#closed) return;
        clearTimeout(timer);
        this.#peers.delete(pc);
        conn = new RtcConn(this.nextId(), offer, ch, pc, this.#limits, (c) => {
          this.#conns.delete(c);
          setTimeout(drop, 1000);
        });
        this.#opened(conn);
      };
      if (ch.readyState === "open") ready();
      else ch.onopen = ready;
    };
    try {
      await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      const sdp = pc.localDescription?.sdp;
      if (!sdp || this.#closed) throw new Error("no answer");
      if (!this.#signal.answer(offer.conn, sdp)) throw new Error("signaling closed");
    } catch {
      this.#signal.reject(offer.conn, "failed");
      drop();
    }
  }

  #opened(conn: RelayConn): void {
    this.#conns.add(conn);
    const q = new URLSearchParams(conn.query);
    const g = q.get("g");
    if (this.#closed) return conn.close(4011, "closed");
    if (g && this.game && g !== this.game) return conn.close(4014, "next game");
    if (q.get("screen") === "1" && conn instanceof RtcConn) return this.#screen(conn, q.get("token") ?? "");
    if (this.onopen) this.onopen(conn);
    else conn.close(1013, "no host");
  }

  #screen(conn: RtcConn, token: string): void {
    let asked = false;
    let answered = false;
    const req: ScreenRequest = {
      token,
      agent: conn.agent,
      address: conn.address,
      onclose: undefined,
      answer: (ok, url) => {
        if (answered || conn.closed) return;
        answered = true;
        conn.control(ok && url ? { t: "screen", ok: true, url } : { t: "screen", ok: false });
        conn.close(1000, ok ? "approved" : "refused");
      },
    };
    conn.onclose = () => {
      if (!answered) req.onclose?.();
    };
    conn.oncontrol = (msg) => {
      if (msg["t"] !== "screen" || asked) return;
      asked = true;
      if (typeof msg["agent"] === "string") (req as { agent: string }).agent = msg["agent"].slice(0, 300);
      if (!this.onscreen || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) return req.answer(false);
      this.onscreen(req);
    };
  }

  /** Closes every connection (`code`: 4011 at the end, 4014 for the next game). */
  closeAll(code: number, reason: string): void {
    for (const c of [...this.#conns]) c.close(code, reason);
  }

  /** Stops: the signaling and local transports end, connections close with `code` (default 1001). */
  close(code = 1001, reason = "going away"): void {
    if (this.#closed) return;
    this.closeAll(code, reason);
    this.#closed = true;
    this.#signal.close();
    for (const l of this.#locals) l.close();
    for (const pc of this.#peers) {
      try {
        pc.close();
      } catch {}
    }
    this.#peers.clear();
  }
}
