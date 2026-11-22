/**
 * Fake players: clients that play Landgrab by themselves. For the tests
 * (in Node) and the live check: the host page's bot buttons (test mode,
 * or `?bots`) run them in the window, connected through tvpipe like a
 * phone.
 *
 * A bot's plan ({@link botPlan}) is simple and greedy: most of its
 * armies on the border territory next to its best target (weak, and in
 * a continent it nearly holds), attacks wherever it has clearly more,
 * and armies inland marched toward the border. It sends a draft first
 * (not ready), then the plan, ready.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import { autoPlace, CASH_ARMIES, frontier, STARS_TO_CASH, territoriesOf, type Board, type Order, type Plan } from "./rules.ts";
import type { World } from "./world.ts";

export interface BotOptions {
  /** The WebSocket URL (`ws://127.0.0.1:PORT/_tvpipe/ws`). */
  url: string;
  WebSocket?: WebSocketFactory | undefined;
  room: string;
  key: string;
  name: string;
  world: World;
  rng?: () => number;
  /** Start the game when VIP and enough players are there. */
  autoStart?: boolean;
  /** Delay before acting, ms (default 0–300 random). */
  think?: () => number;
  /** Never plan (to test deadlines and the automatic placing). */
  silent?: boolean;
  /** How much more it wants than the defender before it attacks (default 1.3: 30 % more). */
  caution?: number;
}

/**
 * A greedy plan for player `id` with `armies` to place and `stars`
 * (cashed in when there are enough).
 */
export function botPlan(world: World, board: Board, id: string, armies: number, stars: number, rng: () => number, caution = 1.3): Plan {
  const cash = stars >= STARS_TO_CASH;
  const budget = armies + (cash ? CASH_ARMIES : 0);
  const mine = territoriesOf(board, id);
  const idx = (t: string) => world.byId.get(t)!.index;
  const hostile = (t: number) => world.territories[t]!.neighbors.map(idx).filter((n) => board.own[n] !== id);
  // How much of each continent the bot holds (targets there are worth more).
  const share = new Map(world.continents.map((c) => [c.id, c.territories.filter((t) => board.own[idx(t)] === id).length / c.territories.length]));
  let best: { from: number; score: number } | undefined;
  for (const t of mine) {
    for (const e of hostile(t)) {
      const cont = world.territories[e]!.continent;
      const score = ((1 + 2 * (share.get(cont) ?? 0)) * (board.arm[t]! + budget)) / (board.arm[e]! + 1) + rng() * 0.5;
      if (!best || score > best.score) best = { from: t, score };
    }
  }
  const place: Record<string, number> = {};
  let left = budget;
  if (best) {
    const n = Math.max(1, Math.round(budget * 0.7));
    place[world.territories[best.from]!.id] = n;
    left -= n;
  }
  for (const [t, n] of Object.entries(autoPlace(world, board, id, left))) place[t] = (place[t] ?? 0) + n;
  const have = (t: number) => board.arm[t]! + (place[world.territories[t]!.id] ?? 0);
  const orders: Order[] = [];
  for (const t of mine) {
    let a = have(t) - 1;
    if (a <= 0) continue;
    const foes = hostile(t).sort((x, y) => board.arm[x]! - board.arm[y]!);
    if (foes.length === 0) {
      // Inland: march toward the border.
      const toward = world.territories[t]!.neighbors.map(idx).find((n) => frontier(world, board, n)) ?? idx(world.territories[t]!.neighbors[Math.floor(rng() * world.territories[t]!.neighbors.length)]!);
      if (board.own[toward] === id) orders.push({ from: world.territories[t]!.id, to: world.territories[toward]!.id, n: a });
      continue;
    }
    for (const e of foes) {
      if (a < Math.max(2, board.arm[e]! * caution + 1)) break;
      // Leave some behind when it has more than it needs and other foes are around.
      const send = foes.length > 1 ? Math.min(a, Math.ceil(board.arm[e]! * 2 + 2)) : a;
      orders.push({ from: world.territories[t]!.id, to: world.territories[e]!.id, n: send });
      a -= send;
      if (a <= 0) break;
    }
  }
  return { place, orders, cash, ready: true };
}

export class Bot {
  readonly client: PartyClient;
  readonly name: string;
  /** Errors the host answered with. */
  errors: string[] = [];
  /** Plans it sent (the last one per round). */
  readonly sent = new Map<number, Plan>();
  readonly #o: BotOptions;
  readonly #rng: () => number;
  #handled = new Set<string>();
  #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(o: BotOptions) {
    this.#o = o;
    this.name = o.name;
    this.#rng = o.rng ?? Math.random;
    this.client = new PartyClient({ url: o.url, room: o.room, key: o.key, storage: memoryStorage(), WebSocket: o.WebSocket });
    this.client.on("view", (view) => this.#onView(view));
  }

  async join(): Promise<void> {
    await this.client.join(this.name);
  }

  #later(ms: number, fn: () => Promise<unknown> | void, ignore: readonly string[] = []): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      Promise.resolve()
        .then(fn)
        .catch((e: { code?: string }) => {
          if (!ignore.includes(e.code ?? "")) this.errors.push(e.code ?? String(e));
        });
    }, ms);
    this.#timers.add(t);
  }

  #once(key: string, fn: () => Promise<unknown> | void, ignore: readonly string[] = []): void {
    if (this.#handled.has(key)) return;
    this.#handled.add(key);
    this.#later(this.#o.think ? this.#o.think() : this.#rng() * 300, fn, ignore);
  }

  #onView(view: Record<string, any>): void {
    const me = view["me"] ?? {};
    if (this.#o.silent) return;
    const room = view["room"] ?? {};
    const c = this.client;
    const you = c.you?.id as string | undefined;
    switch (me.task) {
      case "lobby":
      case "final": {
        if (me.task === "final" || [...this.#handled].some((k) => !k.startsWith("start:"))) this.#handled.clear();
        const vip = (view["roster"] ?? []).find((r: { id: string }) => r.id === you)?.vip;
        const ready = (view["roster"] ?? []).filter((r: { connected: boolean }) => r.connected).length;
        if (this.#o.autoStart && vip && me.task === "lobby" && ready >= (room.minPlayers ?? 2)) this.#once(`start:${ready}`, () => c.act("start"));
        return;
      }
      case "plan": {
        if (!you || !room.board) return;
        const round = Number(room.round ?? 0);
        this.#once(
          `plan:${round}`,
          async () => {
            const board = c.view?.room?.board as Board;
            const plan = botPlan(this.#o.world, board, you, Number(me.reinf?.total ?? 0), Number(me.stars ?? 0), this.#rng, this.#o.caution);
            // A draft first, as a person tapping along would.
            await c.act("plan", { ...plan, ready: false } as any);
            await c.act("plan", plan as any);
            this.sent.set(round, plan);
          },
          ["not-now", "not-playing"],
        );
        return;
      }
    }
  }

  close(): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.client.close();
  }
}

/** `n` bots joined to a party; the first starts the game when `autoStart`. */
export async function bots(n: number, o: Omit<BotOptions, "name"> & { names?: string[] }): Promise<Bot[]> {
  const names = o.names ?? ["Ada", "Bea", "Cy", "Dot", "Eli", "Fay", "Gus", "Hal"];
  const out: Bot[] = [];
  for (let i = 0; i < n; i++) {
    const b = new Bot({ ...o, name: names[i % names.length]! + (i >= names.length ? String(i) : ""), autoStart: o.autoStart && i === 0 });
    await b.join();
    out.push(b);
  }
  return out;
}
