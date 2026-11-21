/**
 * The client side of the party protocol (docs/party-protocol.md): phones
 * and TV pages import it from tvpipe (`/_tvpipe/lib/client.js`). It runs
 * in browsers and in Node ≥ 22 (tests and bots use it as fake phones).
 *
 *   import { PartyClient } from "/_tvpipe/lib/client.js";
 *   const party = PartyClient.fromLocation();
 *   party.on("view", (view) => render(view));
 *   await party.join("Ann");                 // or party.connect() with a saved identity
 *   await party.act("answer", { text: "…" }); // acked, resent after reconnects
 *   party.input({ x: 0.3, y: -1 });          // continuous input, latest wins
 */

import { RejoinBadge, type Corner, type RejoinBadgeOptions } from "./rejoin.ts";

export type { Corner, RejoinBadgeOptions } from "./rejoin.ts";

export const PROTOCOL = 1;

/** `bye` reasons after which the client does not reconnect. */
const FINAL = new Set([
  "bad-key",
  "no-room",
  "no-player",
  "name-taken",
  "name-invalid",
  "replaced",
  "kicked",
  "room-closed",
  "full",
  "locked",
  "in-progress",
  "protocol",
  "left",
  "rate-limited",
  "too-big",
  "next-game",
]);

/**
 * Close codes that are final without a `bye` (tvpipe's own closes:
 * the game ended, too fast, too big; the host's codes when its `bye`
 * got lost).
 */
const FINAL_CODES: Record<number, string> = {
  1009: "too-big",
  4002: "protocol",
  4003: "bad-key",
  4004: "no-room",
  4005: "no-player",
  4006: "name-taken",
  4007: "name-invalid",
  4008: "rate-limited",
  4009: "replaced",
  4010: "kicked",
  4011: "room-closed",
  4014: "next-game",
  4029: "full",
  4030: "in-progress",
};

/**
 * What a phone was in the room's last game (docs/game-switching.md):
 * its name, and what that game stashed with {@link PartyClient.carry}.
 */
export interface Carried {
  name?: string;
  data?: unknown;
}

/** {@link PartyClient.carry}'s data at most, bytes of JSON. */
export const CARRY_LIMIT = 4096;

/** tvpipe's cookie naming the game a page was loaded with. */
const GAME_COOKIE = "tvpipe-game";

/** Unacknowledged actions kept at most. */
const MAX_PENDING = 32;
/** `input()` at most this often, ms (latest wins). */
const INPUT_INTERVAL = 100;

/** An action the host refused, or one that could not be sent. */
export class PartyActionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PartyActionError";
    this.code = code;
  }
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Applies a `state` diff to a view in place (`set` merges objects,
 * replaces everything else; then `del` paths are removed). The host's
 * `applyDiff` (sync.ts) follows the same rules.
 */
export function applyDiff(view: Record<string, any>, d: { set?: Record<string, any>; del?: string[][] }): Record<string, any> {
  if (d.set) merge(view, d.set);
  for (const path of d.del ?? []) {
    let o: any = view;
    for (let i = 0; i < path.length - 1 && isObject(o); i++) o = o[path[i]!];
    if (isObject(o)) delete o[path[path.length - 1]!];
  }
  return view;
}

function merge(target: Record<string, any>, patch: Record<string, any>): void {
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    if (isObject(pv) && isObject(target[k])) merge(target[k], pv);
    else target[k] = pv;
  }
}

export interface QrRows {
  size: number;
  rows: string[];
}

/**
 * What a TV or host page shows people to type (`view.join` on screens,
 * `party.joinInfo` on the host): the short link without its scheme
 * (`tvpipe.party/BCDF`), or `null` when there is none: then show only the
 * QR code (the direct link is too long to type, and without its key it
 * lets nobody in).
 */
export function joinText(join: { short?: string | null | undefined } | null | undefined): string | null {
  const s = join?.short;
  if (typeof s !== "string" || !/^https?:\/\/[^/?#\s]+\/[A-Za-z]{1,16}$/.test(s)) return null;
  return s.replace(/^https?:\/\//, "");
}

/**
 * An SVG document of a QR code (`view.join.qr` on screens): dark modules
 * on a light square with a quiet zone. Insert it as markup (it holds no
 * text from players).
 */
export function qrSvg(qr: QrRows | null | undefined, opts: { dark?: string; light?: string; quiet?: number } = {}): string {
  if (!qr) return "";
  const quiet = opts.quiet ?? 4;
  const n = qr.size + 2 * quiet;
  const color = (c: string) => (/^[#a-zA-Z0-9(),.% ]+$/.test(c) ? c : "#000");
  let d = "";
  qr.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== "1") continue;
      let w = 1;
      while (row[x + w] === "1") w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w - 1;
    }
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="${color(opts.light ?? "#fff")}"/>` +
    `<path d="${d}" fill="${color(opts.dark ?? "#000")}"/></svg>`
  );
}

/** A 2D context (or anything with `fillStyle` and `fillRect`). */
export interface FillContext {
  fillStyle: any;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/** Draws a QR code into a 2D canvas context: `size` px square including the quiet zone. */
export function drawQr(
  ctx: FillContext,
  qr: QrRows | null | undefined,
  x: number,
  y: number,
  size: number,
  opts: { dark?: string; light?: string; quiet?: number } = {},
): void {
  if (!qr) return;
  const quiet = opts.quiet ?? 4;
  const px = size / (qr.size + 2 * quiet);
  ctx.fillStyle = opts.light ?? "#fff";
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = opts.dark ?? "#000";
  qr.rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== "1") continue;
      let w = 1;
      while (row[c + w] === "1") w++;
      // Snap to whole pixels so neighbouring modules leave no seams.
      const x0 = Math.round(x + (c + quiet) * px);
      const x1 = Math.round(x + (c + w + quiet) * px);
      const y0 = Math.round(y + (r + quiet) * px);
      const y1 = Math.round(y + (r + 1 + quiet) * px);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      c += w - 1;
    }
  });
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** What `PartyClient` needs of a WebSocket (the browser's, Node's, or a test's). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: any) => void) | null;
}

export type WebSocketFactory = new (url: string) => WebSocketLike;

export type Role = "player" | "screen" | "watch";

export interface PartyClientOptions {
  /** The WebSocket URL (`ws(s)://HOST/_tvpipe/ws`). */
  url: string;
  /** The room code. */
  room: string;
  /** The join key (players) or the screen/watch key. */
  key?: string | undefined;
  role?: Role | undefined;
  /** Where the identity is kept (default `localStorage` when there is one). */
  storage?: StorageLike | null | undefined;
  /**
   * Where what goes along to the room's next game is kept (default
   * `sessionStorage`: this tab only).
   */
  session?: StorageLike | null | undefined;
  /**
   * Players in a page: when the room goes on with another game, go to
   * the join link (the next game's phone page). Default `true`.
   */
  followGames?: boolean | undefined;
  /** Default the global one. */
  WebSocket?: WebSocketFactory | undefined;
  /**
   * Screens in a page: the join badge ({@link PartyClient.rejoinBadge}),
   * on by default; `{ corner, layout }` places and shapes it, `false`
   * turns it off (a game that draws its own).
   */
  rejoinBadge?: RejoinBadgeOptions | false | undefined;
}

export type Status = "idle" | "connecting" | "open" | "reconnecting" | "closed";

interface Pending {
  type: string;
  data: unknown;
  /** When it was sent, on the host's clock. */
  at: number;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

type Waiting = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Messages that keep their order behind one held for the TV (`at`). */
const HELD = new Set(["state", "msg", "ack"]);

/** The default socket path on the page's origin. */
export const SOCKET_PATH = "/_tvpipe/ws";

export class PartyClient {
  /**
   * The party of the page's link: `?r=CODE` (or `#r=CODE`), `#k=KEY` and
   * `#role=screen|watch` (players: none).
   */
  static fromLocation(opts: Partial<PartyClientOptions> = {}): PartyClient {
    const loc = globalThis.location;
    const q = new URLSearchParams(loc.search);
    const h = new URLSearchParams(loc.hash.replace(/^#/, ""));
    const room = opts.room ?? h.get("r") ?? q.get("r") ?? "";
    const key = opts.key ?? h.get("k") ?? q.get("k") ?? undefined;
    let url = opts.url ?? `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}${SOCKET_PATH}`;
    // The game this page is of: tvpipe sends a page of an earlier game
    // on to its join link (docs/game-switching.md).
    const game = opts.url ? null : cookieValue(GAME_COOKIE);
    if (game) url += `?g=${encodeURIComponent(game)}`;
    const r = opts.role ?? h.get("role") ?? "player";
    const role: Role = r === "screen" || r === "watch" ? r : "player";
    const client = new PartyClient({ ...opts, url, room, key, role });
    // A rejoin link (`#…&p=TOKEN`, Party.rejoinLink): this phone is that
    // player now. The token goes to storage and out of the address bar.
    const resume = h.get("p");
    if (role === "player" && resume) {
      client.#save({ resume });
      h.delete("p");
      try {
        const rest = h.toString();
        globalThis.history?.replaceState(globalThis.history.state, "", `${loc.pathname}${loc.search}${rest ? `#${rest}` : ""}`);
      } catch {}
    }
    return client;
  }

  readonly url: string;
  readonly room: string;
  readonly key: string | undefined;
  readonly role: Role;
  readonly storage: StorageLike | null;
  readonly session: StorageLike | null;
  readonly followGames: boolean;
  /** The current view (`{ roster, room, me }` or `{ roster, screen, join }`). */
  view: Record<string, any> = {};
  /** Who this client is, from `welcome`. */
  you: Record<string, any> | null = null;
  status: Status = "idle";
  /** The reason of the last `bye`, if any. */
  byeReason: string | null = null;
  /**
   * A screen's join badge (TV and watch pages in a browser; `null`
   * elsewhere or when turned off): a small card in a corner with the
   * join QR code and the short link the whole time (but while
   * {@link joinVisible}): for joining and for coming back. Set
   * `rejoinBadge.corner` to keep it clear of the game's picture; the
   * page's `<html>` tells the game where it is and how much room it
   * takes (`data-tvpipe-join`, `--tvpipe-join-w`, `--tvpipe-join-h`).
   */
  readonly rejoinBadge: RejoinBadge | null = null;
  /** Not before this (`Date.now()`): reconnects after a test's {@link drop}. */
  #holdUntil = 0;

  readonly #WS: WebSocketFactory;
  readonly #listeners = new Map<string, Set<(...args: any[]) => void>>();
  #ws: WebSocketLike | null = null;
  #rev = 0;
  #attempt = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #pinger: ReturnType<typeof setInterval> | null = null;
  #name: string | undefined;
  /** Whether this connect joins with the carried name. */
  #joinsCarried = false;
  /** What goes along to the next game ({@link carry}). */
  #outgoing: string | undefined;
  #nextAct = 1;
  readonly #pending = new Map<number, Pending>();
  #inSeq = 0;
  #inLast = 0;
  #inQueued: { data: unknown } | null = null;
  #inTimer: ReturnType<typeof setTimeout> | null = null;
  /** Clock: server time = Date.now() + offset. */
  #offset = 0;
  #bestRtt = Infinity;
  #samples: { rtt: number; offset: number }[] = [];
  #waiting: Waiting | null = null;
  #tvDelay = 0;
  /** Messages waiting for their time (`at`), and what came after them. */
  #held: Record<string, any>[] = [];
  #heldTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #onVisible = () => {
    if ((globalThis as any).document?.visibilityState !== "visible") return;
    if (this.status === "reconnecting") {
      this.#attempt = 0;
      this.#open();
    }
  };

  constructor(opts: PartyClientOptions) {
    this.url = opts.url;
    this.room = opts.room.toUpperCase();
    this.key = opts.key;
    this.role = opts.role ?? "player";
    this.storage = opts.storage !== undefined ? opts.storage : safeStorage();
    this.session = opts.session !== undefined ? opts.session : safeStorage("sessionStorage");
    this.followGames = opts.followGames ?? true;
    this.#WS = opts.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketFactory);
    const doc = (globalThis as any).document as Document | undefined;
    if (this.role !== "player" && opts.rejoinBadge !== false && doc?.createElement) {
      const badge = new RejoinBadge(doc, { qrSvg, joinText }, opts.rejoinBadge || {});
      this.rejoinBadge = badge;
      this.on("view", (view) => badge.update(view));
    }
  }

  /**
   * Whether the game shows the join code itself right now (the lobby's
   * big one): the join badge steps aside meanwhile. Set it whenever that
   * changes.
   */
  get joinVisible(): boolean {
    return this.rejoinBadge?.suppressed ?? false;
  }

  set joinVisible(on: boolean) {
    if (this.rejoinBadge) this.rejoinBadge.suppressed = on;
  }

  get #storageKey(): string {
    let host = "";
    try {
      host = new URL(this.url).host;
    } catch {}
    return `tvpipe-party:${host}:${this.room}:${this.role}`;
  }

  /** The saved identity (`resume`, `name`) of this room, if any. */
  get saved(): { resume?: string; name?: string } | null {
    try {
      const s = this.storage?.getItem(this.#storageKey);
      const v: unknown = s ? JSON.parse(s) : null;
      return isObject(v) ? v : null;
    } catch {
      return null;
    }
  }

  #save(identity: { resume: string; name?: string }): void {
    try {
      this.storage?.setItem(this.#storageKey, JSON.stringify(identity));
    } catch {}
  }

  /** Whether `connect()` can come back as an earlier player (or join with the name of the last game). */
  get canResume(): boolean {
    return this.role !== "player" || typeof this.saved?.resume === "string" || typeof this.carried?.name === "string";
  }

  get #carryKey(): string {
    return `${this.#storageKey.replace(/:[^:]*$/, "")}:carry`;
  }

  /**
   * What this phone was in the room's last game, when it came here with
   * the room (docs/game-switching.md): `{name, data}`, or `null`. The
   * game may use it or not; `connect()` joins with the name when there
   * is no saved identity.
   */
  get carried(): Carried | null {
    if (this.role !== "player") return null;
    try {
      const s = this.session?.getItem(this.#carryKey);
      const v: unknown = s ? JSON.parse(s) : null;
      if (!isObject(v)) return null;
      const out: Carried = {};
      if (typeof v["name"] === "string") out.name = v["name"];
      if ("data" in v) out.data = v["data"];
      return out;
    } catch {
      return null;
    }
  }

  /**
   * Stashes `data` (JSON, at most {@link CARRY_LIMIT} bytes) for the
   * room's next game: it gets it as `carried.data`. `undefined` drops it.
   */
  carry(data: unknown): void {
    const text = data === undefined ? undefined : JSON.stringify(data);
    if (text !== undefined && text.length > CARRY_LIMIT) throw new RangeError(`carry: more than ${CARRY_LIMIT} bytes`);
    this.#outgoing = text;
    try {
      if (text === undefined) this.session?.removeItem(`${this.#carryKey}-out`);
      else this.session?.setItem(`${this.#carryKey}-out`, text);
    } catch {}
  }

  /** The room goes on with another game: what goes along, and to the join link. */
  #nextGame(): void {
    if (this.role !== "player") return;
    const carried: Carried = {};
    const name = this.saved?.name ?? this.you?.["name"] ?? this.#name;
    if (typeof name === "string") carried.name = name;
    let out = this.#outgoing;
    try {
      out ??= this.session?.getItem(`${this.#carryKey}-out`) ?? undefined;
      this.session?.removeItem(`${this.#carryKey}-out`);
    } catch {}
    if (out !== undefined) {
      try {
        carried.data = JSON.parse(out);
      } catch {}
    }
    try {
      this.session?.setItem(this.#carryKey, JSON.stringify(carried));
    } catch {}
    this.#forget();
    const loc = (globalThis as any).location;
    if (!this.followGames || !loc || typeof loc.replace !== "function") return;
    const key = this.key ? `#k=${encodeURIComponent(this.key)}` : "";
    loc.replace(`/?r=${encodeURIComponent(this.room)}${key}`);
  }

  /** Events: `view`, `welcome`, `msg`, `status`, `bye`, `ack`, `tv` (the {@link tvDelay}). */
  on(event: string, fn: (...args: any[]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  off(event: string, fn: (...args: any[]) => void): void {
    this.#listeners.get(event)?.delete(fn);
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const fn of [...(this.#listeners.get(event) ?? [])]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(err);
      }
    }
  }

  /**
   * Joins as a new player with this name (or comes back as the saved one).
   * Rejects with a {@link PartyActionError} (`name-taken`, `full`, …).
   */
  join(name: string): Promise<Record<string, any>> {
    this.#name = name;
    return this.connect();
  }

  /** Connects: a screen, or a player with a saved identity. Resolves with `welcome`. */
  connect(): Promise<Record<string, any>> {
    if (this.#name === undefined) this.#name = this.saved?.name;
    if (this.#name === undefined && this.role === "player" && typeof this.saved?.resume !== "string") {
      const name = this.carried?.name;
      if (name !== undefined) {
        this.#name = name;
        this.#joinsCarried = true;
      }
    }
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
      this.byeReason = null;
      this.#attempt = 0;
      (globalThis as any).document?.addEventListener?.("visibilitychange", this.#onVisible);
      this.#open();
    });
  }

  #open(): void {
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    if (this.#ws) {
      const old = this.#ws;
      this.#ws = null;
      old.onclose = null;
      try {
        old.close();
      } catch {}
    }
    this.#setStatus(this.you ? "reconnecting" : "connecting");
    let ws: WebSocketLike;
    try {
      ws = new this.#WS(this.url);
    } catch (err) {
      return this.#fail("protocol", String(err));
    }
    this.#ws = ws;
    ws.onopen = () => {
      const saved = this.saved;
      const hello: Record<string, unknown> = { t: "hello", v: PROTOCOL, room: this.room, role: this.role, key: this.key };
      if (this.role === "player") {
        if (saved?.resume) hello["resume"] = saved.resume;
        if (this.#name !== undefined) hello["name"] = this.#name;
      }
      hello["agent"] = (globalThis as any).navigator?.userAgent ?? "";
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (isObject(msg)) this.#onMessage(msg);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#stopPing();
      const reason = this.byeReason ?? FINAL_CODES[ev.code] ?? null;
      if (reason && FINAL.has(reason)) {
        if (!this.byeReason) {
          this.byeReason = reason;
          this.#emit("bye", reason, ev.reason || undefined);
        }
        return this.#fail(reason, ev.reason || reason);
      }
      if (this.status === "closed") return;
      this.#setStatus(this.you ? "reconnecting" : "connecting");
      const delay = Math.min(5000, 250 * 2 ** this.#attempt++) * (0.75 + Math.random() * 0.5);
      this.#retry = setTimeout(() => this.#open(), Math.max(delay, this.#holdUntil - Date.now()));
    };
  }

  #fail(reason: string, message: string): void {
    this.#setStatus("closed");
    if (reason === "no-player" || reason === "kicked" || reason === "bad-key") this.#forget();
    if (reason === "next-game") this.#nextGame();
    else if (this.#joinsCarried && !this.you) {
      // The carried name did not get in (taken, refused): the game asks.
      this.#joinsCarried = false;
      this.#name = undefined;
      try {
        this.session?.removeItem(this.#carryKey);
      } catch {}
    }
    const err = new PartyActionError(reason, message);
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
    if (this.#waiting) {
      this.#waiting.reject(err);
      this.#waiting = null;
    }
    this.#stopInput();
    (globalThis as any).document?.removeEventListener?.("visibilitychange", this.#onVisible);
  }

  #forget(): void {
    try {
      this.storage?.removeItem(this.#storageKey);
    } catch {}
  }

  #setStatus(s: Status): void {
    if (this.status === s) return;
    this.status = s;
    this.#emit("status", s);
  }

  /**
   * A message from the host. One with an `at` (a change the host synced
   * with the TV: `party.withTv`) waits until the picture with it is on
   * the TV, and everything after it waits behind it, in order.
   */
  #onMessage(msg: Record<string, any>): void {
    if (HELD.has(msg["t"]) && (this.#held.length > 0 || (typeof msg["at"] === "number" && msg["at"] > this.now()))) {
      this.#held.push(msg);
      this.#release();
      return;
    }
    this.#handle(msg);
  }

  /** Handles the held messages that are due, and waits for the next. */
  #release(): void {
    if (this.#heldTimer) clearTimeout(this.#heldTimer);
    this.#heldTimer = null;
    while (this.#held.length > 0) {
      const at = this.#held[0]!["at"];
      const wait = typeof at === "number" ? at - this.now() : 0;
      if (wait > 0) {
        this.#heldTimer = setTimeout(() => this.#release(), Math.min(wait, 10_000));
        return;
      }
      this.#handle(this.#held.shift()!);
    }
  }

  #dropHeld(): void {
    this.#held = [];
    if (this.#heldTimer) clearTimeout(this.#heldTimer);
    this.#heldTimer = null;
  }

  #handle(msg: Record<string, any>): void {
    switch (msg["t"]) {
      case "welcome": {
        const first = this.you === null;
        // A whole view: what was held is in it (or older than it).
        this.#dropHeld();
        const tv = typeof msg["tv"]?.delay === "number" ? msg["tv"].delay : 0;
        const tvChanged = tv !== this.#tvDelay;
        this.#tvDelay = tv;
        this.you = msg["you"];
        this.view = msg["view"] ?? {};
        this.#rev = msg["rev"] ?? 0;
        this.#attempt = 0;
        this.#sample(0, msg["now"]);
        if (this.role === "player" && msg["you"]?.resume) this.#save({ resume: msg["you"].resume, name: msg["you"].name });
        this.#setStatus("open");
        // Continue after what the host has seen; resend what it has not acked.
        const last = Number(msg["you"]?.lastAct ?? 0);
        if (first) {
          // Actions queued before the first welcome were numbered blindly
          // (a reloaded page starts at 1): number them after the host's.
          const queued = [...this.#pending.values()];
          this.#pending.clear();
          this.#nextAct = last + 1;
          for (const p of queued) this.#pending.set(this.#nextAct++, p);
        }
        for (const [id, p] of this.#pending) this.#send({ t: "act", id, type: p.type, data: p.data, at: p.at });
        this.#startPing();
        if (tvChanged) this.#emit("tv", tv);
        this.#emit("welcome", msg);
        this.#emit("view", this.view, null);
        if (this.#waiting) {
          this.#waiting.resolve(msg);
          this.#waiting = null;
        }
        return;
      }
      case "state": {
        if (typeof msg["rev"] === "number" && msg["rev"] <= this.#rev) return;
        if (msg["full"]) {
          this.view = msg["full"];
        } else {
          if (msg["rev"] !== this.#rev + 1) this.#send({ t: "resync" });
          applyDiff(this.view, msg);
        }
        this.#rev = msg["rev"];
        this.#emit("view", this.view, msg);
        return;
      }
      case "ack": {
        const p = this.#pending.get(msg["id"]);
        if (!p) return;
        this.#pending.delete(msg["id"]);
        if (msg["ok"]) p.resolve(msg["result"] ?? null);
        else p.reject(new PartyActionError(msg["error"]?.code ?? "error", msg["error"]?.message ?? "refused"));
        this.#emit("ack", msg);
        return;
      }
      case "msg":
        this.#emit("msg", msg["type"], msg["data"]);
        return;
      case "pong":
        this.#sample(msg["c"], msg["now"]);
        return;
      case "tv":
        if (typeof msg["delay"] !== "number" || msg["delay"] === this.#tvDelay) return;
        this.#tvDelay = msg["delay"];
        this.#emit("tv", this.#tvDelay);
        this.#release();
        return;
      case "bye":
        this.byeReason = String(msg["reason"]);
        this.#emit("bye", this.byeReason, msg["message"]);
        return;
    }
  }

  /**
   * One clock sample: `c` is when the ping left (Date.now()), `now` the
   * host's time when it answered. Keeps the offset of the fastest of the
   * last 16 round trips.
   */
  #sample(c: number, now: unknown): void {
    if (typeof now !== "number") return;
    const t = Date.now();
    const rtt = c > 0 ? t - c : 1000; // welcome: a rough first guess
    this.#samples.push({ rtt, offset: now - (c > 0 ? (c + t) / 2 : t) });
    if (this.#samples.length > 16) this.#samples.shift();
    const best = this.#samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.#offset = best.offset;
    this.#bestRtt = best.rtt;
  }

  #startPing(): void {
    this.#stopPing();
    let n = 0;
    const ping = () => this.#send({ t: "ping", c: Date.now() });
    ping();
    this.#pinger = setInterval(() => {
      ping();
      if (++n === 4 && this.#pinger) {
        clearInterval(this.#pinger);
        this.#pinger = setInterval(ping, 10_000);
      }
    }, 300);
  }

  #stopPing(): void {
    if (this.#pinger) clearInterval(this.#pinger);
    this.#pinger = null;
  }

  /**
   * The clock to show things by (ms since the epoch): the host's clock,
   * on a TV page ahead by {@link tvDelay}: the time at which what the
   * page draws now is on the TV. Deadlines in views use it, so a
   * countdown on the TV and on the phones reach zero together.
   */
  now(): number {
    return Date.now() + this.#offset + (this.role === "screen" ? this.#tvDelay : 0);
  }

  /** The host's clock (ms since the epoch), on every page. */
  hostNow(): number {
    return Date.now() + this.#offset;
  }

  /**
   * How far the TV picture is behind the host, ms (0 without a TV).
   * Phones get the host's TV-synced changes when the TV shows them by
   * themselves; this is for anything else timed to the TV picture (a
   * sound on the phone with a flash on the TV: at `hostNow() + tvDelay`).
   */
  get tvDelay(): number {
    return this.#tvDelay;
  }

  /** The fastest recent round trip to the host, ms. */
  get rtt(): number {
    return this.#bestRtt;
  }

  #send(msg: Record<string, unknown>): boolean {
    const ws = this.#ws;
    if (!ws || ws.readyState !== 1 || this.status !== "open") return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  /**
   * Sends continuous input (a stick, a tilt): latest wins, never acked,
   * may be lost; at most every 100 ms (the latest data then). The host
   * sees it as `player.input` and the `input` event.
   */
  input(data: unknown): void {
    if (this.status !== "open") return;
    this.#inQueued = { data };
    if (this.#inTimer) return;
    const wait = this.#inLast + INPUT_INTERVAL - Date.now();
    if (wait <= 0) return this.#flushInput();
    this.#inTimer = setTimeout(() => {
      this.#inTimer = null;
      this.#flushInput();
    }, wait);
  }

  #flushInput(): void {
    const q = this.#inQueued;
    this.#inQueued = null;
    if (!q || this.status !== "open") return;
    this.#inLast = Date.now();
    this.#send({ t: "in", s: ++this.#inSeq, data: q.data });
  }

  #stopInput(): void {
    if (this.#inTimer) clearTimeout(this.#inTimer);
    this.#inTimer = null;
    this.#inQueued = null;
  }

  /**
   * Sends an action; resolves with the host's result, rejects with a
   * {@link PartyActionError} when the host refuses it. Survives reconnects
   * (sent again, applied once).
   */
  act(type: string, data: unknown = null): Promise<any> {
    if (this.status === "closed") return Promise.reject(new PartyActionError("closed", "Not connected"));
    if (this.#pending.size >= MAX_PENDING) return Promise.reject(new PartyActionError("busy", "Too many actions waiting"));
    const id = this.#nextAct++;
    const at = Math.round(this.hostNow());
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { type, data, at, resolve, reject });
      this.#send({ t: "act", id, type, data, at });
    });
  }

  /** Leaves the party for good (the identity is forgotten). */
  leave(): void {
    this.#send({ t: "leave" });
    this.byeReason = "left";
    this.#forget();
    this.close();
  }

  /** Closes the connection (no reconnect). */
  close(): void {
    this.#setStatus("closed");
    this.#dropHeld();
    if (this.#retry) clearTimeout(this.#retry);
    this.#stopPing();
    this.#stopInput();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {}
    }
    for (const p of this.#pending.values()) p.reject(new PartyActionError("closed", "Closed"));
    this.#pending.clear();
    (globalThis as any).document?.removeEventListener?.("visibilitychange", this.#onVisible);
  }

  /**
   * For tests: drop the socket as a network loss would; the client
   * reconnects by itself, after `away` ms at the earliest. `forget`:
   * as if the page came back on another phone (the saved token is gone;
   * the player comes back by name).
   */
  drop(opts: { away?: number; forget?: boolean } = {}): void {
    if (opts.forget) this.#forget();
    this.#holdUntil = Date.now() + (opts.away ?? 0);
    // Not open from here on: the socket's close event comes later (on
    // Windows long enough for a check of `status` to see it still open).
    if (this.#ws && this.status === "open") this.#setStatus(this.you ? "reconnecting" : "connecting");
    try {
      this.#ws?.close(4999, "dropped");
    } catch {}
  }
}

/** A cookie of this page's origin, if any. */
function cookieValue(name: string): string | null {
  try {
    const all: unknown = (globalThis as any).document?.cookie;
    if (typeof all !== "string") return null;
    for (const kv of all.split(";")) {
      const i = kv.indexOf("=");
      if (i > 0 && kv.slice(0, i).trim() === name) return decodeURIComponent(kv.slice(i + 1).trim());
    }
  } catch {}
  return null;
}

function safeStorage(which: "localStorage" | "sessionStorage" = "localStorage"): StorageLike | null {
  try {
    const s = (globalThis as any)[which] as StorageLike | undefined;
    if (!s) return null;
    s.getItem("x");
    return s;
  } catch {
    return null;
  }
}

/** A tiny in-memory storage (for tests, or browsers that refuse `localStorage`). */
export function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}
