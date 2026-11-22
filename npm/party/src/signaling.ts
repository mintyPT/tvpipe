/**
 * Signaling through tvpipe.party's room objects
 * (docs/browser-party-design.md, "Signaling"): JSON over WebSockets,
 * one offer and one answer per connection (no trickle).
 *
 * - {@link joinSignal}: a phone's or screen's join socket
 *   (`/api/rooms/CODE/join?QUERY`): sends the offer, resolves with the
 *   host's answer.
 * - {@link HostSignal}: the host page's socket (`/api/rooms/CODE/host`):
 *   offers in, answers and refusals out, the room's game; reconnects with
 *   backoff, pings every 30 s.
 */

import { webDeps, type SocketLike, type WebDeps } from "./rtc.ts";

/** A join that did not get an answer: `no-host`, `rejected` (`reason`), `timeout`, `rate-limited`, `full`, `closed`. */
export class SignalError extends Error {
  readonly code: string;
  readonly reason: string;
  constructor(code: string, reason = "") {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "SignalError";
    this.code = code;
    this.reason = reason;
  }
}

/** `wss://HOST` for `https://HOST`. */
export function wsOrigin(origin: string): string {
  return origin.replace(/^http(s?):/, "ws$1:");
}

/** `https://HOST` for `wss://HOST/…`. */
export function httpOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol === "wss:" || u.protocol === "https:" ? "https:" : "http:"}//${u.host}`;
  } catch {
    return webDeps().origin;
  }
}

/** Close codes of a join socket that say why, when no message did. */
const JOIN_CLOSES: Record<number, string> = { 1013: "no-host", 4008: "rate-limited", 1009: "bad-message", 1008: "bad-message", 4002: "timeout" };

/**
 * Sends `sdp` (an offer) on a join socket at `url`; resolves with the
 * answer's SDP, rejects with a {@link SignalError}. `cancel()` closes the
 * socket (the promise rejects `closed`).
 */
export function joinSignal(url: string, sdp: string, deps: WebDeps = webDeps()): { answer: Promise<string>; cancel(): void } {
  let ws: SocketLike | undefined;
  let settled = false;
  let fail: (e: SignalError) => void = () => {};
  const answer = new Promise<string>((resolve, reject) => {
    const done = (f: () => void) => {
      if (settled) return;
      settled = true;
      f();
      try {
        ws?.close(1000);
      } catch {}
    };
    fail = (e) => done(() => reject(e));
    try {
      ws = new deps.WebSocket(url);
    } catch (err) {
      return fail(new SignalError("closed", String(err)));
    }
    ws.onopen = () => ws!.send(JSON.stringify({ t: "offer", sdp }));
    ws.onmessage = (ev) => {
      let m: any;
      try {
        m = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
      } catch {
        return;
      }
      if (!m || typeof m !== "object") return;
      switch (m.t) {
        case "answer":
          if (typeof m.sdp === "string") done(() => resolve(m.sdp));
          return;
        case "reject":
          return fail(new SignalError("rejected", String(m.reason ?? "")));
        case "no-host":
          return fail(new SignalError("no-host"));
        case "timeout":
          return fail(new SignalError("timeout"));
        case "error":
          return fail(new SignalError(String(m.code ?? "error")));
      }
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => fail(new SignalError(JOIN_CLOSES[ev.code] ?? "closed", ev.reason ?? ""));
  });
  return { answer, cancel: () => fail(new SignalError("closed")) };
}

/** An offer the room passed on to the host. */
export interface Offer {
  conn: number;
  sdp: string;
  query: string;
  addr: string;
  agent: string;
}

/** The room's game (`GET /api/rooms/CODE` answers it; `/r/` opens its phone page). */
export interface RoomGame {
  name: string;
  title: string;
  release: string;
  /** The phone page, an absolute path. */
  phone: string;
}

/** `connecting`, `hosted`, then `connecting` again after a drop; `replaced` (another tab hosts) and `bad-secret` are final. */
export type HostState = "connecting" | "hosted" | "replaced" | "bad-secret" | "closed";

/** Pings this often, ms (the room answers `pong` without waking up). */
export const HOST_PING_MS = 30_000;

/** The host page's signaling socket; see the module docs. */
export class HostSignal {
  readonly url: string;
  readonly #secret: string;
  readonly #deps: WebDeps;
  #ws: SocketLike | undefined;
  #state: HostState = "connecting";
  #attempt = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #pinger: ReturnType<typeof setInterval> | undefined;
  #game: RoomGame | undefined;
  onoffer: ((offer: Offer) => void) | undefined;
  onstate: ((state: HostState) => void) | undefined;

  /** `url`: `wss://HOST/api/rooms/CODE/host`; `secret`: the room's registration secret. */
  constructor(url: string, secret: string, deps: WebDeps = webDeps()) {
    this.url = url;
    this.#secret = secret;
    this.#deps = deps;
    this.#open();
  }

  /** The URL of a room's host socket on `origin`. */
  static url(origin: string, code: string): string {
    return `${wsOrigin(origin)}/api/rooms/${encodeURIComponent(code)}/host`;
  }

  get state(): HostState {
    return this.#state;
  }

  #set(s: HostState): void {
    if (this.#state === s) return;
    this.#state = s;
    this.onstate?.(s);
  }

  #open(): void {
    this.#retry = undefined;
    if (this.#state === "closed" || this.#state === "replaced" || this.#state === "bad-secret") return;
    let ws: SocketLike;
    try {
      ws = new this.#deps.WebSocket(this.url);
    } catch {
      return this.#again();
    }
    this.#ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "host", secret: this.#secret }));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let m: any;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!m || typeof m !== "object") return;
      switch (m.t) {
        case "hosted":
          this.#attempt = 0;
          this.#set("hosted");
          if (this.#game) this.#sendNow({ t: "game", game: this.#game });
          if (this.#pinger) clearInterval(this.#pinger);
          this.#pinger = setInterval(() => this.#sendRaw("ping"), HOST_PING_MS);
          return;
        case "offer":
          if (typeof m.sdp !== "string" || typeof m.conn !== "number") return;
          this.onoffer?.({ conn: m.conn, sdp: m.sdp, query: String(m.query ?? ""), addr: String(m.addr ?? "?"), agent: String(m.agent ?? "") });
          return;
        case "replaced":
          this.#set("replaced");
          return;
        case "error":
          if (m.code === "bad-secret") this.#set("bad-secret");
          return;
      }
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      if (this.#pinger) clearInterval(this.#pinger);
      this.#pinger = undefined;
      if (ev.code === 4009) this.#set("replaced");
      else if (ev.code === 4003) this.#set("bad-secret");
      this.#again();
    };
  }

  #again(): void {
    if (this.#state === "closed" || this.#state === "replaced" || this.#state === "bad-secret") return;
    this.#set("connecting");
    const delay = Math.min(30_000, 1000 * 2 ** this.#attempt++) * (0.75 + Math.random() * 0.5);
    this.#retry = setTimeout(() => this.#open(), delay);
  }

  #sendRaw(text: string): boolean {
    const ws = this.#ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  #sendNow(msg: Record<string, unknown>): boolean {
    return this.#sendRaw(JSON.stringify(msg));
  }

  /** An answer to the offer of `conn`. */
  answer(conn: number, sdp: string): boolean {
    return this.#state === "hosted" && this.#sendNow({ t: "answer", conn, sdp });
  }

  /** Refuses the offer of `conn` (`full`, `failed`). */
  reject(conn: number, reason: string): boolean {
    return this.#state === "hosted" && this.#sendNow({ t: "reject", conn, reason });
  }

  /** The room's game: sent now and after every reconnect. */
  setGame(game: RoomGame): void {
    this.#game = game;
    if (this.#state === "hosted") this.#sendNow({ t: "game", game });
  }

  /** For tests: drops the socket as a network loss would (it reconnects). */
  drop(): void {
    try {
      this.#ws?.close(4999, "dropped");
    } catch {}
  }

  close(): void {
    this.#set("closed");
    if (this.#retry) clearTimeout(this.#retry);
    if (this.#pinger) clearInterval(this.#pinger);
    const ws = this.#ws;
    this.#ws = undefined;
    try {
      ws?.close(1000);
    } catch {}
  }
}
