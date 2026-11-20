/**
 * Fake players: clients that play Garble by themselves (doodles, guesses
 * in the room's language, random verdicts and suspects). For the tests
 * (in Node), and for trying the game alone: the host page's "Add a bot"
 * runs them in the window, connected through tvpipe like a phone.
 *
 * A bot cannot read a drawing. With an `oracle` (the host page's, which
 * knows the chains) it guesses what the drawing was meant to be, more or
 * less, so a game with bots has chains that survive, drift and die.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import { pickLang, type Drawing, type Lang } from "./rules.ts";

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
  /** What the drawing this bot guesses was meant to show (its player id), if known. */
  oracle?: ((id: string) => { text: string; word?: string | undefined } | undefined) | undefined;
}

/** Guesses when a bot has no idea, per language. */
export const GUESSES: Record<Lang, readonly string[]> = {
  en: ["a sad potato", "my uncle on monday", "a confused banana", "a dancing lamp", "abstract art", "a sneaky pancake", "an angry cloud", "a very tired frog", "a pirate ship", "a haunted toaster"],
  de: ["eine traurige Kartoffel", "mein Onkel am Montag", "eine verwirrte Banane", "eine tanzende Lampe", "moderne Kunst", "ein frecher Pfannkuchen", "eine wütende Wolke", "ein müder Frosch", "ein Piratenschiff", "ein Toaster, in dem es spukt"],
};

/** A doodle in black ink: a face, a house, a sun or a cat, in a random spot. */
export function doodle(rng: () => number): Drawing {
  const cx = 300 + Math.floor(rng() * 400);
  const cy = 300 + Math.floor(rng() * 400);
  const r = 110 + Math.floor(rng() * 90);
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
          line(7, cx - r * 0.9, cy + r * 0.1, cx - r * 0.3, cy + r * 0.2),
          line(7, cx + r * 0.9, cy + r * 0.1, cx + r * 0.3, cy + r * 0.2),
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
    setTimeout(() => {
      fn().catch((e: { code?: string }) => this.errors.push(e.code ?? String(e)));
    }, delay);
  }

  /** A guess: what the oracle says (often), a part of it, or nonsense. */
  #guess(lang: Lang): string {
    const known = this.client.you ? this.#o.oracle?.(this.client.you.id) : undefined;
    const silly = GUESSES[lang];
    const any = silly[Math.floor(this.#rng() * silly.length)]!;
    if (!known) return any;
    const truth = known.text;
    const x = this.#rng();
    // The drawer smuggled their word in, and the bot fell for it.
    if (known.word && x < 0.2) return `${truth.split(" ").slice(0, 3).join(" ")} ${lang === "de" ? "mit" : "with"} ${known.word}`.slice(0, 40);
    if (x < 0.65) return truth;
    if (x < 0.85) {
      const words = truth.split(" ");
      return words.slice(0, Math.max(1, words.length - 1)).join(" ") + (lang === "de" ? " mit Hut" : " with a hat");
    }
    return any;
  }

  #onView(view: Record<string, any>): void {
    if (this.#o.silent) return;
    const me = view["me"] ?? {};
    const room = view["room"] ?? {};
    const c = this.client;
    const turn = `${room.round}:${room.step ?? ""}:${me.deadline ?? ""}`;
    switch (me.task) {
      case "lobby":
      case "final": {
        if (me.task === "final") this.#handled.clear();
        const vip = (view["roster"] ?? []).find((r: { id: string }) => r.id === c.you?.id)?.vip;
        const ready = (view["roster"] ?? []).filter((r: { connected: boolean }) => r.connected).length;
        if (this.#o.autoStart && vip && me.task === "lobby" && ready >= (room.minPlayers ?? 4)) this.#once(`start:${ready}`, () => c.act("start"));
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
      case "judge":
        if (!me.done) {
          const n = (me.chain?.links ?? []).filter((l: { kind: string }) => l.kind === "guess").length;
          const died = this.#rng() < 0.3 ? null : Math.floor(this.#rng() * Math.max(1, n));
          this.#once(`judge:${turn}:${me.chain?.id}`, () => c.act("judge", { died }));
        }
        return;
      case "accuse":
        if (!me.done && Array.isArray(me.suspects) && me.suspects.length > 0) {
          const s = me.suspects[Math.floor(this.#rng() * me.suspects.length)];
          this.#once(`accuse:${turn}`, () => c.act("accuse", { suspect: s.id }));
        }
        return;
    }
  }

  close(): void {
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
