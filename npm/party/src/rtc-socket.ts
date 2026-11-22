/**
 * The client side of web mode's transport (docs/browser-party-design.md,
 * "The transport"): a data channel to the host page, behind the
 * WebSocket interface `PartyClient` takes.
 *
 * API:
 * - `DataChannelSocket` (`implements WebSocketLike`): `new
 *   DataChannelSocket(joinUrl(origin, code, query))` makes a peer
 *   connection with one channel (`party`, reliable, ordered), sends its
 *   offer on the room's join socket, takes the host's answer, and is
 *   open once the channel is. A refusal or no host: closed 1006/1013
 *   (the client tries again). Close codes travel in `!` control frames.
 *   `PartyClient.fromLocation()` uses it in web mode by itself.
 * - `dataChannelSocket(deps)`: the class with other browser APIs (tests).
 * - `joinUrl(origin, code, query?)`: `wss://HOST/api/rooms/CODE/join?QUERY`.
 * - `requestScreen(code, {token, agent?})`: an extra screen's request
 *   (`/tv/`): resolves `{ok: true, url}` (the TV page to show, `role=watch`)
 *   or `{ok: false, reason}` (`refused`, `no-host`, `closed`, …).
 */

import type { WebSocketLike } from "./client.ts";
import { CHANNEL_LABEL, ChannelEnd, gathered, iceServers, webDeps, type ChannelLike, type PeerLike, type WebDeps } from "./rtc.ts";
import { httpOrigin, joinSignal, SignalError, wsOrigin } from "./signaling.ts";

/** A room's join socket URL on `origin` (`https://tvpipe.party`). */
export function joinUrl(origin: string, code: string, query = ""): string {
  return `${wsOrigin(origin)}/api/rooms/${encodeURIComponent(code.toUpperCase())}/join${query ? `?${query.replace(/^\?/, "")}` : ""}`;
}

/** A channel that does not open within this after the answer: given up, ms. */
const OPEN_MS = 15_000;

export class DataChannelSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  /** Control frames other than close and pings (`!{"t":"screen",…}`). */
  oncontrol: ((msg: Record<string, unknown>) => void) | null = null;
  readonly url: string;
  /** Why it closed before it opened (a {@link SignalError}'s code), if so. */
  failure: string | undefined;
  readonly #deps: WebDeps;
  #pc: PeerLike | undefined;
  #end: ChannelEnd | undefined;
  #cancel: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The page goes (closed, reloaded, another page): the channel closes
   * with 1001 at once, as a WebSocket would. Without it the browser drops
   * the peer connection silently and the host sees the phone away only
   * after the pings' 45 s.
   */
  readonly #onPageHide = () => this.close(1001, "going away");

  constructor(url: string, deps: WebDeps = webDeps()) {
    this.url = url;
    this.#deps = deps;
    void this.#start();
  }

  async #start(): Promise<void> {
    const deps = this.#deps;
    try {
      const ice = await iceServers({ ...deps, origin: httpOrigin(this.url) });
      if (this.readyState !== 0) return;
      const pc = new deps.RTCPeerConnection({ iceServers: ice });
      this.#pc = pc;
      const ch = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      if (this.readyState !== 0) return;
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new SignalError("failed");
      const join = joinSignal(this.url, sdp, deps);
      this.#cancel = join.cancel;
      const answer = await join.answer;
      this.#cancel = undefined;
      if (this.readyState !== 0) return;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      this.#timer = setTimeout(() => this.#fail("timeout"), OPEN_MS);
      if (ch.readyState === "open") this.#opened(ch);
      else ch.onopen = () => this.#opened(ch);
      ch.onclose = () => this.#fail("closed");
    } catch (err) {
      this.#fail(err instanceof SignalError ? err.code : "failed");
    }
  }

  #opened(ch: ChannelLike): void {
    if (this.readyState !== 0) return;
    clearTimeout(this.#timer);
    this.#end = new ChannelEnd(ch, {
      peer: this.#pc,
      onmessage: (data) => this.onmessage?.({ data }),
      oncontrol: (msg) => this.oncontrol?.(msg),
      onclose: (code, reason) => this.#closed(code, reason),
    });
    this.readyState = 1;
    (globalThis as any).addEventListener?.("pagehide", this.#onPageHide);
    this.onopen?.({});
  }

  /** Not open and never will be: the client tries again (1013 when the host refused or is not there). */
  #fail(why: string): void {
    if (this.readyState === 3 || this.#end) return;
    this.failure = why;
    this.onerror?.({});
    this.#closed(why === "rejected" || why === "no-host" || why === "full" ? 1013 : 1006, why);
  }

  #closed(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearTimeout(this.#timer);
    (globalThis as any).removeEventListener?.("pagehide", this.#onPageHide);
    this.#cancel?.();
    const pc = this.#pc;
    // The close frame needs a moment on the wire before the peer goes.
    setTimeout(() => {
      try {
        pc?.close();
      } catch {}
    }, 1000);
    this.onclose?.({ code, reason });
  }

  send(data: string): void {
    if (this.readyState === 1) this.#end?.send(data);
  }

  /** Sends a control frame (`!` and JSON). */
  control(msg: Record<string, unknown>): void {
    if (this.readyState === 1) this.#end?.control(msg);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    if (this.#end) {
      this.readyState = 2;
      this.#end.close(code, reason);
    } else this.#closed(code, reason);
  }
}

/** {@link DataChannelSocket} with other browser APIs (tests). */
export function dataChannelSocket(deps: WebDeps): new (url: string) => DataChannelSocket {
  return class extends DataChannelSocket {
    constructor(url: string) {
      super(url, deps);
    }
  };
}

/**
 * An extra screen asks the host of room `code` to show the game
 * (docs/browser-party-design.md, "Extra screens"): `token` is the
 * screen's own (random, kept in its `localStorage`). Waits while the host
 * asks a person.
 */
export function requestScreen(
  code: string,
  opts: { token: string; agent?: string | undefined; origin?: string | undefined; deps?: WebDeps | undefined },
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const deps = opts.deps ?? webDeps();
  const origin = opts.origin ?? deps.origin;
  const ws = new DataChannelSocket(joinUrl(origin, code, `screen=1&token=${encodeURIComponent(opts.token)}`), deps);
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: { ok: true; url: string } | { ok: false; reason: string }) => {
      if (done) return;
      done = true;
      resolve(r);
      ws.close(1000);
    };
    ws.onopen = () => ws.control({ t: "screen", agent: opts.agent ?? (globalThis as any).navigator?.userAgent ?? "" });
    ws.oncontrol = (msg) => {
      if (msg["t"] !== "screen") return;
      if (msg["ok"] === true && typeof msg["url"] === "string") finish({ ok: true, url: msg["url"] });
      else finish({ ok: false, reason: "refused" });
    };
    ws.onclose = (ev) => finish({ ok: false, reason: ws.failure ?? (ev.code === 1000 ? "refused" : "closed") });
  });
}
