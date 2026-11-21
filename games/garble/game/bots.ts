/**
 * Fake players: clients that play Garble by themselves (doodles on top,
 * guesses in the room's language, a vote for the best move). For the
 * tests (in Node) and the live check: the host page's bot buttons (only
 * with `?bots`) run them in the window, connected through tvpipe like a
 * phone.
 *
 * A bot cannot see a drawing. With an `oracle` (the host page's, which
 * knows what each layer was meant to be) it reads it right most of the
 * time, sometimes with a synonym, a plural or a spelling slip, and now
 * and then not.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import { pickLang, type Drawing, type Lang, type Word } from "./rules.ts";

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
  /** Never answer (to test deadlines). */
  silent?: boolean;
  /** Tasks it leaves to the test (`vote`, …). */
  skip?: string[];
  /** What the picture this bot guesses was meant to be now (its player id), if known. */
  oracle?: ((id: string) => Word | undefined) | undefined;
}

/** Guesses when a bot has no idea, per language. */
export const GUESSES: Record<Lang, readonly string[]> = {
  en: ["a potato", "my uncle", "a lamp", "abstract art", "a pancake", "a cloud", "a tired frog", "a toaster", "spaghetti", "a mess"],
  de: ["eine Kartoffel", "mein Onkel", "eine Lampe", "moderne Kunst", "ein Pfannkuchen", "eine Wolke", "ein müder Frosch", "ein Toaster", "Spaghetti", "Chaos"],
};

/**
 * A word as typed in a hurry: a letter in the middle of a word of five
 * letters and more doubled (`elephhant`), the matcher's one slip; a
 * shorter word as it is (no slips there).
 */
export function misspelt(word: string): string {
  if (word.length < 5 || word.includes(" ")) return word;
  const i = Math.floor(word.length / 2);
  return word.slice(0, i) + word[i] + word.slice(i);
}

/** A doodle: a face, a house, a sun or a cat, in a random spot (bots draw it on top of whatever is there). */
export function doodle(rng: () => number): Drawing {
  const cx = 300 + Math.floor(rng() * 400);
  const cy = 300 + Math.floor(rng() * 400);
  const r = 90 + Math.floor(rng() * 80);
  const clamp = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));
  const circle = (x: number, y: number, rad: number, width: number) => {
    const s = [width];
    for (let i = 0; i <= 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      s.push(clamp(x + Math.cos(a) * rad * (1 + (rng() - 0.5) * 0.06)), clamp(y + Math.sin(a) * rad * (1 + (rng() - 0.5) * 0.06)));
    }
    return s;
  };
  const line = (w: number, ...pts: number[]) => [w, ...pts.map(clamp)];
  switch (Math.floor(rng() * 4)) {
    case 0:
      return { strokes: [circle(cx, cy, r, 16), [24, clamp(cx - r / 3), clamp(cy - r / 4)], [24, clamp(cx + r / 3), clamp(cy - r / 4)], line(12, cx - r / 2, cy + r / 4, cx - r / 4, cy + r / 2, cx + r / 4, cy + r / 2, cx + r / 2, cy + r / 4)] };
    case 1:
      return {
        strokes: [
          line(16, cx - r, cy, cx - r, cy + r, cx + r, cy + r, cx + r, cy, cx - r, cy),
          line(16, cx - r - 30, cy, cx, cy - r, cx + r + 30, cy),
          line(12, cx - 25, cy + r, cx - 25, cy + r / 3, cx + 25, cy + r / 3, cx + 25, cy + r),
        ],
      };
    case 2: {
      const rays: number[][] = [];
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        rays.push(line(10, cx + Math.cos(a) * (r + 25), cy + Math.sin(a) * (r + 25), cx + Math.cos(a) * (r + 95), cy + Math.sin(a) * (r + 95)));
      }
      return { strokes: [circle(cx, cy, r, 18), ...rays] };
    }
    default:
      return {
        strokes: [
          circle(cx, cy, r * 0.7, 14),
          line(14, cx - r * 0.6, cy - r * 0.35, cx - r * 0.55, cy - r * 1.05, cx - r * 0.2, cy - r * 0.68),
          line(14, cx + r * 0.6, cy - r * 0.35, cx + r * 0.55, cy - r * 1.05, cx + r * 0.2, cy - r * 0.68),
          [22, clamp(cx - r * 0.25), clamp(cy - r * 0.1)],
          [22, clamp(cx + r * 0.25), clamp(cy - r * 0.1)],
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
  /** Pending answers, cleared by {@link close}: a closed bot never acts. */
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

  #once(key: string, fn: () => Promise<unknown>): void {
    if (this.#handled.has(key)) return;
    this.#handled.add(key);
    const delay = this.#o.think ? this.#o.think() : this.#rng() * 300;
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn().catch((e: { code?: string }) => this.errors.push(e.code ?? String(e)));
    }, delay);
    this.#timers.add(t);
  }

  /** A guess: the word (mostly), one of its synonyms, its plural or a slip of it, or nonsense. */
  #guess(lang: Lang): string {
    const known = this.client.you ? this.#o.oracle?.(this.client.you.id) : undefined;
    const silly = GUESSES[lang];
    const any = silly[Math.floor(this.#rng() * silly.length)]!;
    if (!known) return any;
    const x = this.#rng();
    if (x < 0.5) return known.word;
    if (x < 0.65 && known.also.length > 0) return known.also[Math.floor(this.#rng() * known.also.length)]!;
    if (x < 0.75) return lang === "de" ? `viele ${known.word}` : `${known.word}s`;
    if (x < 0.82) return misspelt(known.word);
    return any;
  }

  #onView(view: Record<string, any>): void {
    const me = view["me"] ?? {};
    if (this.#o.silent || this.#o.skip?.includes(me.task)) return;
    const room = view["room"] ?? {};
    const c = this.client;
    const turn = `${room.round}:${me.step ?? ""}`;
    switch (me.task) {
      case "lobby":
      case "final": {
        if (me.task === "final" || me.task === "lobby") this.#handled.clear();
        const vip = (view["roster"] ?? []).find((r: { id: string }) => r.id === c.you?.id)?.vip;
        const ready = (view["roster"] ?? []).filter((r: { connected: boolean }) => r.connected).length;
        if (this.#o.autoStart && vip && me.task === "lobby" && ready >= (room.minPlayers ?? 3)) this.#once(`start:${ready}`, () => c.act("start"));
        return;
      }
      case "draw":
        if (!me.done) {
          const choice = Array.isArray(me.choices) ? Math.floor(this.#rng() * 2) : undefined;
          this.#once(`draw:${turn}`, () => c.act("draw", { ...doodle(this.#rng), ...(choice === undefined ? {} : { choice }) }));
        }
        return;
      case "guess":
        if (!me.done) this.#once(`guess:${turn}`, () => c.act("guess", { text: this.#guess(pickLang(room.lang)) }));
        return;
      case "vote":
        if (!me.done) {
          const mine = new Set<string>(me.mine ?? []);
          const ids: string[] = [];
          for (const p of room.gallery ?? []) (p.layers ?? []).forEach((l: { drawing?: Drawing }, k: number) => (l.drawing?.strokes?.length ?? 0) > 0 && ids.push(`${p.id}:${k}`));
          const pool = ids.filter((id) => !mine.has(id));
          if (pool.length > 0) this.#once(`vote:${room.round}`, () => c.act("vote", { layer: pool[Math.floor(this.#rng() * pool.length)] }));
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
