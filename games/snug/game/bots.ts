/**
 * Fake players: clients that play Snug by themselves. For the tests (in
 * Node) and the live check: the host page's bot buttons (test mode, or
 * `?bots`) run them in the window, connected through tvpipe like a phone.
 *
 * A bot looks at its hand and the board and, after thinking, places a
 * piece. With an `oracle` (the host page's, which knows where the
 * solution has each piece) it puts a piece where the solution has it
 * when those cells are free, and now and then first drops it somewhere
 * else that fits and lifts it again (a second thought); without one it
 * tries places that fit. It wanders its cursor about and pings.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import { fitsAnywhere, key, placements, type Cell } from "./rules.ts";

export interface BotOptions {
  /** The WebSocket URL (`ws://127.0.0.1:PORT/_tvpipe/ws`). */
  url: string;
  WebSocket?: WebSocketFactory | undefined;
  room: string;
  key: string;
  name: string;
  rng?: () => number;
  /** Start the game when VIP and enough players are there. */
  autoStart?: boolean;
  /** Before each move, ms (default 1–4 s). */
  think?: () => number;
  /** Never move (to test deadlines and hand-offs). */
  silent?: boolean;
  /** Where the solution has a piece (the host's knowledge). */
  oracle?: ((piece: string) => Cell[] | null) | undefined;
  /** How often a move is a wrong one first (0–1). */
  wrong?: number;
  /** Wander the cursor and ping. */
  point?: boolean;
}

export class Bot {
  readonly client: PartyClient;
  readonly name: string;
  /** Errors the host answered with. */
  errors: string[] = [];
  /** Refusals (`taken`, …). */
  refused: string[] = [];
  readonly #o: BotOptions;
  readonly #rng: () => number;
  #busy = false;
  #pending: ReturnType<typeof setTimeout> | null = null;
  #pointer: ReturnType<typeof setInterval> | null = null;
  #pings = 0;
  /** Pieces it dropped somewhere wrong on purpose, to lift. */
  readonly #wrong = new Set<string>();
  #closed = false;

  constructor(o: BotOptions) {
    this.#o = o;
    this.name = o.name;
    this.#rng = o.rng ?? Math.random;
    this.client = new PartyClient({ url: o.url, room: o.room, key: o.key, storage: memoryStorage(), WebSocket: o.WebSocket });
    this.client.on("view", () => this.#onView());
  }

  async join(): Promise<void> {
    await this.client.join(this.name);
  }

  close(): void {
    this.#closed = true;
    if (this.#pending) clearTimeout(this.#pending);
    if (this.#pointer) clearInterval(this.#pointer);
    this.client.close();
  }

  #onView(): void {
    if (this.#closed) return;
    const v = this.client.view as { room?: Record<string, any>; me?: Record<string, any>; roster?: { id: string; vip: boolean; connected: boolean }[] } | null;
    const room = v?.room ?? {};
    const me = v?.me ?? {};
    if ((me["task"] === "lobby" || me["task"] === "final") && this.#o.autoStart) {
      const mine = v?.roster?.find((r) => r.id === this.client.you?.id);
      const ready = (v?.roster ?? []).filter((r) => r.connected).length;
      if (mine?.vip && ready >= (room["minPlayers"] ?? 2) && !this.#pending) {
        this.#pending = setTimeout(() => {
          this.#pending = null;
          this.client.act("start").catch((e) => this.errors.push(String(e?.code ?? e)));
        }, 20);
      }
    }
    if (this.#o.point && room["phase"] === "board" && !this.#pointer) this.#startPointing();
    if (room["phase"] !== "board" && this.#pointer) {
      clearInterval(this.#pointer);
      this.#pointer = null;
    }
    if (this.#o.silent || room["phase"] !== "board" || me["task"] !== "play" || this.#busy || this.#pending) return;
    const hand = (me["hand"] ?? []) as { id: string; cells: Cell[] }[];
    const wrong = [...this.#wrong].filter((id) => (room["placed"] ?? []).some((p: { id: string; owner: string }) => p.id === id && p.owner === this.client.you?.id));
    if (hand.length === 0 && wrong.length === 0) return;
    const think = this.#o.think?.() ?? 1000 + this.#rng() * 3000;
    this.#pending = setTimeout(() => {
      this.#pending = null;
      void this.#move();
    }, think);
  }

  #startPointing(): void {
    this.#pointer = setInterval(() => {
      const room = (this.client.view as { room?: Record<string, any> } | null)?.room;
      const shape = room?.["shape"] as { w: number; h: number } | undefined;
      if (!shape || this.#rng() < 0.5) return;
      if (this.#rng() < 0.15) this.#pings++;
      this.client.input({ x: this.#rng() * shape.w, y: this.#rng() * shape.h, on: this.#rng() < 0.8, ping: this.#pings });
    }, 400);
  }

  async #move(): Promise<void> {
    const v = this.client.view as { room?: Record<string, any>; me?: Record<string, any> } | null;
    const room = v?.room ?? {};
    const me = v?.me ?? {};
    if (room["phase"] !== "board" || me["task"] !== "play") return;
    const board = room["board"] as number;
    const shape = room["shape"] as { w: number; h: number; rows: string[] };
    const placed = (room["placed"] ?? []) as { id: string; owner: string; cells: Cell[] }[];
    const occupied = new Set(placed.flatMap((p) => p.cells.map(([x, y]) => key(x, y))));
    const free: Cell[] = [];
    shape.rows.forEach((r, y) => [...r].forEach((c, x) => c === "#" && !occupied.has(key(x, y)) && free.push([x, y])));
    this.#busy = true;
    try {
      // A wrong piece of its own on the board: lift it.
      for (const id of this.#wrong) {
        this.#wrong.delete(id);
        if (placed.some((p) => p.id === id)) return void (await this.#act("lift", { board, piece: id }));
      }
      const hand = [...((me["hand"] ?? []) as { id: string; cells: Cell[] }[])].sort(() => this.#rng() - 0.5);
      for (const piece of hand) {
        const home = this.#o.oracle?.(piece.id);
        if (this.#o.oracle && home === null) continue;
        if (home && home.every(([x, y]) => !occupied.has(key(x, y)))) {
          if (this.#rng() < (this.#o.wrong ?? 0)) {
            const spots = placements(free, piece.cells).filter((c) => key(...c[0]!) !== key(...home[0]!));
            if (spots.length > 0) {
              const ok = await this.#act("place", { board, piece: piece.id, cells: spots[Math.floor(this.#rng() * spots.length)] });
              if (ok) this.#wrong.add(piece.id);
              return;
            }
          }
          await this.#act("place", { board, piece: piece.id, cells: home });
          return;
        }
        if (!home && !this.#o.oracle && fitsAnywhere(free, piece.cells)) {
          const spots = placements(free, piece.cells);
          await this.#act("place", { board, piece: piece.id, cells: spots[Math.floor(this.#rng() * spots.length)] });
          return;
        }
      }
    } finally {
      this.#busy = false;
      setTimeout(() => this.#onView(), 0);
    }
  }

  async #act(type: string, data: unknown): Promise<boolean> {
    try {
      const r = (await this.client.act(type, data)) as { ok?: boolean; reason?: string } | null;
      if (r && r.ok === false) {
        this.refused.push(r.reason ?? "?");
        return false;
      }
      return true;
    } catch (e) {
      const code = String((e as { code?: string })?.code ?? e);
      // A move sent as the board ends (solved, time's up) is refused with
      // not-now: a race on a slow machine, not a bot's mistake.
      if (code === "not-now") this.refused.push(code);
      else this.errors.push(code);
      return false;
    }
  }
}

/** Bots named Bot1, Bot2, … that join. */
export async function bots(n: number, o: Omit<BotOptions, "name">): Promise<Bot[]> {
  const out: Bot[] = [];
  for (let i = 0; i < n; i++) {
    const b = new Bot({ ...o, name: `Bot${i + 1}`, autoStart: i === 0 && o.autoStart });
    await b.join();
    out.push(b);
  }
  return out;
}
