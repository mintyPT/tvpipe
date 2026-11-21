/**
 * Fake players: clients that play Krakel by themselves (a doodle in
 * colour, guesses at the drawing on stage, a heart for a drawing). For
 * the tests (in Node) and the live check: the host page's bot buttons
 * (test mode, or `?bots`) run them in the window, connected through
 * tvpipe like a phone.
 *
 * A bot cannot see a drawing. With an `oracle` (the host page's, which
 * knows the word of the drawing on stage) it names it after a while,
 * sometimes with a wrong guess first; without one it guesses nonsense.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import { PALETTE, pickLang, type Drawing, type Lang, type Word } from "./rules.ts";

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
  /** Delay before answering, ms (default 0–300 random). */
  think?: () => number;
  /** When a bot that knows the word types it: a share (0–1) of the guess time (default: random, 0.15–0.9). */
  guessAt?: () => number;
  /** Never answer (to test deadlines). */
  silent?: boolean;
  /** Tasks it leaves to the test (`vote`, `guess`, …). */
  skip?: string[];
  /** The word of the drawing this bot guesses now (its player id), if known. */
  oracle?: ((id: string) => Word | undefined) | undefined;
}

/** Guesses when a bot has no idea, per language. */
export const GUESSES: Record<Lang, readonly string[]> = {
  en: ["potato", "my uncle", "lamp", "modern art", "pancake", "cloud", "tired frog", "toaster", "spaghetti", "a mess"],
  de: ["Kartoffel", "mein Onkel", "Lampe", "moderne Kunst", "Pfannkuchen", "Wolke", "müder Frosch", "Toaster", "Spaghetti", "Chaos"],
};

/** A doodle in a few colours: a face, a house, a sun or a cat, in a random spot. */
export function doodle(rng: () => number): Drawing {
  const cx = 300 + Math.floor(rng() * 400);
  const cy = 300 + Math.floor(rng() * 400);
  const r = 110 + Math.floor(rng() * 90);
  const clamp = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));
  /** A colour that is not the eraser's. */
  const ink = () => 1 + Math.floor(rng() * (PALETTE.length - 1));
  const main = ink();
  const other = ink();
  const circle = (color: number, x: number, y: number, rad: number, width: number) => {
    const s = [color, width];
    for (let i = 0; i <= 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      s.push(clamp(x + Math.cos(a) * rad * (1 + (rng() - 0.5) * 0.06)), clamp(y + Math.sin(a) * rad * (1 + (rng() - 0.5) * 0.06)));
    }
    return s;
  };
  const line = (color: number, w: number, ...pts: number[]) => [color, w, ...pts.map(clamp)];
  const dot = (color: number, w: number, x: number, y: number) => [color, w, clamp(x), clamp(y)];
  switch (Math.floor(rng() * 4)) {
    case 0:
      return {
        strokes: [circle(main, cx, cy, r, 14), dot(1, 30, cx - r / 3, cy - r / 4), dot(1, 30, cx + r / 3, cy - r / 4), line(other, 14, cx - r / 2, cy + r / 4, cx - r / 4, cy + r / 2, cx + r / 4, cy + r / 2, cx + r / 2, cy + r / 4)],
      };
    case 1:
      return {
        strokes: [
          line(main, 14, cx - r, cy, cx - r, cy + r, cx + r, cy + r, cx + r, cy, cx - r, cy),
          line(other, 30, cx - r - 30, cy, cx, cy - r, cx + r + 30, cy),
          line(1, 14, cx - 25, cy + r, cx - 25, cy + r / 3, cx + 25, cy + r / 3, cx + 25, cy + r),
        ],
      };
    case 2: {
      const rays: number[][] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        rays.push(line(4, 14, cx + Math.cos(a) * (r + 25), cy + Math.sin(a) * (r + 25), cx + Math.cos(a) * (r + 95), cy + Math.sin(a) * (r + 95)));
      }
      return { strokes: [circle(5, cx, cy, r, 30), ...rays] };
    }
    default:
      return {
        strokes: [
          circle(main, cx, cy, r * 0.7, 14),
          line(main, 14, cx - r * 0.6, cy - r * 0.35, cx - r * 0.55, cy - r * 1.05, cx - r * 0.2, cy - r * 0.68),
          line(main, 14, cx + r * 0.6, cy - r * 0.35, cx + r * 0.55, cy - r * 1.05, cx + r * 0.2, cy - r * 0.68),
          dot(1, 30, cx - r * 0.25, cy - r * 0.1),
          dot(1, 30, cx + r * 0.25, cy - r * 0.1),
          line(other, 6, cx - r * 0.9, cy + r * 0.1, cx - r * 0.3, cy + r * 0.2),
          line(other, 6, cx + r * 0.9, cy + r * 0.1, cx + r * 0.3, cy + r * 0.2),
        ],
      };
  }
}

export class Bot {
  readonly client: PartyClient;
  readonly name: string;
  /** Errors the host answered with. */
  errors: string[] = [];
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

  #later(ms: number, fn: () => Promise<unknown>, ignore: readonly string[] = []): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn().catch((e: { code?: string }) => {
        if (!ignore.includes(e.code ?? "")) this.errors.push(e.code ?? String(e));
      });
    }, ms);
    this.#timers.add(t);
  }

  #once(key: string, fn: () => Promise<unknown>): void {
    if (this.#handled.has(key)) return;
    this.#handled.add(key);
    this.#later(this.#o.think ? this.#o.think() : this.#rng() * 300, fn);
  }

  /** The drawing on stage: a wrong guess early (sometimes), then the word, a synonym or its plural. */
  #guess(room: Record<string, any>, me: Record<string, any>): void {
    const c = this.client;
    const spot = room["spot"] ?? {};
    const lang = pickLang(room["lang"]);
    const key = me["key"];
    // One plan per drawing, made when it comes on stage (views keep coming).
    if (this.#handled.has(`plan:${key}`)) return;
    this.#handled.add(`plan:${key}`);
    const span = Math.max(1, (spot.end ?? 0) - (spot.start ?? 0));
    const wait = (share: number) => Math.max(0, (spot.start ?? 0) + span * share - c.now()) + 15;
    const silly = GUESSES[lang];
    const any = () => silly[Math.floor(this.#rng() * silly.length)]!;
    // Too late is no mistake: the drawing may be off the stage by then.
    const late = ["not-now", "already", "locked"];
    const known = c.you ? this.#o.oracle?.(c.you.id) : undefined;
    const at = this.#o.guessAt ? this.#o.guessAt() : 0.15 + this.#rng() * 0.75;
    if (this.#rng() < 0.35 || !known) this.#later(wait(at * 0.4), () => c.act("guess", { key, text: any() }), late);
    if (!known) return;
    const x = this.#rng();
    const text = x < 0.7 ? known.word : x < 0.85 && known.also.length > 0 ? known.also[Math.floor(this.#rng() * known.also.length)]! : lang === "de" ? `eine ${known.word}` : `the ${known.word}`;
    const lock = (room["lockout"] ?? 0) * 1000;
    this.#later(wait(at) + lock, () => c.act("guess", { key, text }), late);
  }

  #onView(view: Record<string, any>): void {
    const me = view["me"] ?? {};
    if (this.#o.silent || this.#o.skip?.includes(me.task)) return;
    const room = view["room"] ?? {};
    const c = this.client;
    switch (me.task) {
      case "lobby":
      case "final": {
        if (me.task === "final") this.#handled.clear();
        const vip = (view["roster"] ?? []).find((r: { id: string }) => r.id === c.you?.id)?.vip;
        const ready = (view["roster"] ?? []).filter((r: { connected: boolean }) => r.connected).length;
        if (this.#o.autoStart && vip && me.task === "lobby" && ready >= (room.minPlayers ?? 3)) this.#once(`start:${ready}`, () => c.act("start"));
        return;
      }
      case "draw":
        if (!me.done) {
          const choice = Math.floor(this.#rng() * (me.choices?.length ?? 1));
          this.#once(`draw:${room.round}`, () => c.act("draw", { ...doodle(this.#rng), choice }));
        }
        return;
      case "guess":
        if (!me.right) this.#guess(room, me);
        return;
      case "vote":
        if (!me.done) {
          const pool = ((room.gallery ?? []) as { id: string }[]).map((g) => g.id).filter((id) => id !== c.you?.id);
          if (pool.length > 0) this.#once(`vote:${room.round}`, () => c.act("vote", { id: pool[Math.floor(this.#rng() * pool.length)] }));
        }
        return;
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
  const names = o.names ?? ["Ada", "Bea", "Cy", "Dot", "Eli", "Fay", "Gus", "Hal", "Ivy", "Jo", "Kit", "Lu"];
  const out: Bot[] = [];
  for (let i = 0; i < n; i++) {
    const b = new Bot({ ...o, name: names[i % names.length]! + (i >= names.length ? String(i) : ""), autoStart: o.autoStart && i === 0 });
    await b.join();
    out.push(b);
  }
  return out;
}
