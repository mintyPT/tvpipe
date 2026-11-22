/**
 * The local transport (docs/browser-party-design.md, "The transport"):
 * the host's tab and its own screens (the TV page full screen in the
 * tab, a window of it on the cable, the host page's preview, bots in the
 * host's tab) talk over `BroadcastChannel("tvpipe-local:CODE")`, never
 * leaving the browser (the screen key stays in it).
 *
 * Messages on the channel (structured clones):
 * `{t: "open", id, query}` (a client), `{t: "accept", id}`,
 * `{t: "data", id, from, data}`, `{t: "close", id, from, code, reason}`,
 * `{t: "ping", id}` / `{t: "pong", id}` (clients ping every 5 s, a host
 * that does not answer for 15 s is gone: 1006), `{t: "up"}` (a host
 * started: open clients close 1012 and reconnect). `from`: `h` or `c`.
 */

import type { WebSocketLike } from "./client.ts";
import type { RelayConn } from "./relay.ts";
import { webDeps, type BroadcastLike, type WebDeps } from "./rtc.ts";

export const LOCAL_CHANNEL = (code: string) => `tvpipe-local:${code.toUpperCase()}`;

const CLIENT_PING_MS = 5000;
const CLIENT_DEAD_MS = 15_000;
const ACCEPT_MS = 3000;

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

class LocalConn implements RelayConn {
  readonly id: number;
  readonly via = "local" as const;
  readonly address = "local";
  readonly query: string;
  readonly agent = "local";
  readonly busy = false;
  closed = false;
  onmessage: ((data: string | Uint8Array) => void) | undefined;
  onclose: ((code: number, reason: string) => void) | undefined;
  ondrain: (() => void) | undefined;
  readonly key: string;
  readonly #host: LocalHost;
  #ended = false;

  constructor(host: LocalHost, id: number, key: string, query: string) {
    this.#host = host;
    this.id = id;
    this.key = key;
    this.query = query;
  }

  send(text: string): void {
    if (!this.closed) this.#host.post({ t: "data", id: this.key, from: "h", data: text });
  }

  sendBinary(data: Uint8Array): void {
    if (!this.closed) this.#host.post({ t: "data", id: this.key, from: "h", data: data.slice() });
  }

  close(code: number, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.#host.post({ t: "close", id: this.key, from: "h", code, reason: reason.slice(0, 120) });
    // The host hears of its own close too, as from tvpipe's relay.
    setTimeout(() => this.ended(code, reason), 0);
  }

  ended(code: number, reason: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.closed = true;
    this.#host.forget(this);
    this.onclose?.(code, reason);
  }
}

/** The host's side: hands out a `RelayConn` per client (`via: "local"`). */
export class LocalHost {
  readonly code: string;
  onopen: ((conn: RelayConn) => void) | undefined;
  /** A connection ended (either side). */
  onend: ((conn: RelayConn) => void) | undefined;
  readonly #ch: BroadcastLike;
  readonly #conns = new Map<string, LocalConn>();
  readonly #nextId: () => number;
  #closed = false;

  /** `nextId`: connection numbers (the relay's, shared with its other connections). */
  constructor(code: string, nextId: () => number, deps: WebDeps = webDeps()) {
    this.code = code.toUpperCase();
    this.#nextId = nextId;
    this.#ch = new deps.BroadcastChannel(LOCAL_CHANNEL(this.code));
    this.#ch.onmessage = (ev) => this.#receive(ev.data);
    this.post({ t: "up" });
  }

  /** @internal */
  post(msg: Record<string, unknown>): void {
    if (this.#closed) return;
    try {
      this.#ch.postMessage(msg);
    } catch {}
  }

  /** @internal */
  forget(c: LocalConn): void {
    if (this.#conns.get(c.key) === c) this.#conns.delete(c.key);
    this.onend?.(c);
  }

  #receive(m: any): void {
    if (!m || typeof m !== "object" || typeof m.id !== "string" || m.from === "h") return;
    const c = this.#conns.get(m.id);
    switch (m.t) {
      case "open": {
        if (c || !this.onopen) return;
        const conn = new LocalConn(this, this.#nextId(), m.id, typeof m.query === "string" ? m.query : "");
        this.#conns.set(m.id, conn);
        this.post({ t: "accept", id: m.id });
        this.onopen(conn);
        return;
      }
      case "data":
        if (!c) return this.post({ t: "close", id: m.id, from: "h", code: 1012, reason: "host restart" });
        if (c.closed) return;
        if (typeof m.data === "string") c.onmessage?.(m.data);
        else if (m.data instanceof Uint8Array) c.onmessage?.(m.data);
        return;
      case "ping":
        if (!c) return this.post({ t: "close", id: m.id, from: "h", code: 1012, reason: "host restart" });
        return this.post({ t: "pong", id: m.id });
      case "close":
        c?.ended(Number(m.code) || 1005, String(m.reason ?? ""));
        return;
    }
  }

  get size(): number {
    return this.#conns.size;
  }

  connections(): Iterable<RelayConn> {
    return this.#conns.values();
  }

  /** Stops (the page goes): open clients reconnect to the next host. */
  close(): void {
    if (this.#closed) return;
    for (const c of [...this.#conns.values()]) c.ended(1012, "host restart");
    this.#closed = true;
    try {
      this.#ch.close();
    } catch {}
  }
}

/**
 * A client's side as a WebSocket for `PartyClient`: the URL's last path
 * part is the room code (`…/_tvpipe/local/CODE`), its query goes to the
 * host. See {@link localSocketFor}.
 */
export class LocalSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  readonly url: string;
  readonly #id = randomId();
  readonly #query: string = "";
  readonly #ch: BroadcastLike;
  #lastSeen = Date.now();
  #timer: ReturnType<typeof setInterval> | undefined;
  #acceptTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(url: string, deps: WebDeps = webDeps()) {
    this.url = url;
    let code = "";
    let query = "";
    try {
      const u = new URL(url);
      code = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
      query = u.search.replace(/^\?/, "");
    } catch {}
    this.#query = query;
    this.#ch = new deps.BroadcastChannel(LOCAL_CHANNEL(code));
    this.#ch.onmessage = (ev) => this.#receive(ev.data);
    this.#post({ t: "open", id: this.#id, query });
    this.#acceptTimer = setTimeout(() => this.#end(1006, "no host"), ACCEPT_MS);
  }

  #post(msg: Record<string, unknown>): void {
    try {
      this.#ch.postMessage(msg);
    } catch {}
  }

  #receive(m: any): void {
    if (!m || typeof m !== "object" || this.readyState === 3) return;
    if (m.t === "up") {
      // A (new) host: an open connection belonged to the last one.
      if (this.readyState === 1) this.#end(1012, "host restart");
      else this.#post({ t: "open", id: this.#id, query: this.#query });
      return;
    }
    if (m.id !== this.#id || m.from === "c") return;
    this.#lastSeen = Date.now();
    switch (m.t) {
      case "accept":
        if (this.readyState !== 0) return;
        clearTimeout(this.#acceptTimer);
        this.readyState = 1;
        this.#timer = setInterval(() => {
          if (Date.now() - this.#lastSeen > CLIENT_DEAD_MS) this.#end(1006, "host gone");
          else this.#post({ t: "ping", id: this.#id });
        }, CLIENT_PING_MS);
        this.onopen?.({});
        return;
      case "data":
        if (this.readyState === 1) this.onmessage?.({ data: m.data });
        return;
      case "close":
        this.#end(Number(m.code) || 1005, String(m.reason ?? ""));
        return;
    }
  }

  send(data: string): void {
    if (this.readyState === 1) this.#post({ t: "data", id: this.#id, from: "c", data });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    if (this.readyState === 1) this.#post({ t: "close", id: this.#id, from: "c", code, reason });
    setTimeout(() => this.#end(code, reason), 0);
    this.readyState = 2;
  }

  #end(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearTimeout(this.#acceptTimer);
    if (this.#timer) clearInterval(this.#timer);
    try {
      this.#ch.close();
    } catch {}
    this.onclose?.({ code, reason });
  }
}

/** The URL a {@link LocalSocket} takes for `code` on `origin`. */
export function localUrl(origin: string, code: string, query = ""): string {
  return `${origin}/_tvpipe/local/${encodeURIComponent(code.toUpperCase())}${query ? `?${query}` : ""}`;
}

/** A WebSocket class for `PartyClient` whose sockets are local (any URL: they go to `code`'s host). */
export function localSocketFor(code: string, deps?: WebDeps): new (url: string) => WebSocketLike {
  return class extends LocalSocket {
    constructor(url: string) {
      super(url.includes("/_tvpipe/local/") ? url : localUrl("https://local", code), deps ?? webDeps());
    }
  };
}
