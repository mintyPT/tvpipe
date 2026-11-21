/**
 * Fake players: clients that play Drawbluff by themselves (scribbles,
 * silly lies in the room's language, random votes). For the tests (in Node), and for trying the
 * game alone: the host page's "Add a bot" runs them in the window,
 * connected through tvpipe like a phone.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import { pickLang, type Drawing, type Lang } from "./rules.ts";

export interface BotOptions {
  /** The WebSocket URL (`ws://127.0.0.1:PORT/_tvpipe/ws`). */
  url: string;
  /** Default the global one (tests: a memory relay's). */
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
  /** The lies to write, as they are (default {@link LIES} in the room's language, now and then with the bot's name). */
  lies?: readonly string[] | undefined;
}

/** The bots' lies per language (the room's: `room.lang`). */
export const LIES: Record<Lang, readonly string[]> = {
  en: [
    "a sad potato",
    "my uncle on monday",
    "a confused banana",
    "the cat's revenge",
    "a dancing lamp",
    "abstract art",
    "a sneaky pancake",
    "a happy accident",
    "the evil teapot",
    "a very tired frog",
  ],
  de: [
    "eine traurige kartoffel",
    "mein onkel am montag",
    "eine verwirrte banane",
    "die rache der katze",
    "eine tanzende stehlampe",
    "moderne kunst",
    "ein hinterhältiger pfannkuchen",
    "ein glücklicher zufall",
    "die böse teekanne",
    "ein sehr müder frosch",
  ],
};

/**
 * A recognisable doodle: a face, a house or a sun, in a random spot, with
 * `pens` colours; with `frames` > 1 an animation, the doodle hopping
 * (each further frame moved a little).
 */
export function doodle(rng: () => number, pens = 8, frames = 1): Drawing {
  const d = sketch(rng);
  const strokes = d.strokes.map(([c, ...rest]) => [c! % Math.max(1, pens), ...rest]);
  if (frames <= 1) return { strokes };
  const dx = Math.round((rng() - 0.5) * 60);
  const dy = -20 - Math.floor(rng() * 40);
  const moved = (k: number) => strokes.map(([c, w, ...xy]) => [c!, w!, ...xy.map((v, i) => Math.max(0, Math.min(1000, v + k * (i % 2 === 0 ? dx : dy))))]);
  return { strokes, frames: Array.from({ length: frames - 1 }, (_, k) => moved(k + 1)) };
}

function sketch(rng: () => number): Drawing {
  const cx = 300 + Math.floor(rng() * 400);
  const cy = 300 + Math.floor(rng() * 400);
  const r = 120 + Math.floor(rng() * 80);
  const circle = (x: number, y: number, rad: number, color: number, width: number) => {
    const s = [color, width];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      s.push(Math.round(x + Math.cos(a) * rad), Math.round(y + Math.sin(a) * rad));
    }
    return s;
  };
  const kind = Math.floor(rng() * 3);
  if (kind === 0) {
    return {
      strokes: [
        circle(cx, cy, r, 0, 14),
        circle(cx - r / 3, cy - r / 4, 12, 0, 18),
        circle(cx + r / 3, cy - r / 4, 12, 0, 18),
        [2, 14, cx - r / 2, cy + r / 4, cx - r / 4, cy + r / 2, cx + r / 4, cy + r / 2, cx + r / 2, cy + r / 4],
      ].map((s) => s.map(Math.round)),
    };
  }
  if (kind === 1) {
    return {
      strokes: [
        [6, 16, cx - r, cy, cx - r, cy + r, cx + r, cy + r, cx + r, cy, cx - r, cy],
        [2, 16, cx - r - 30, cy, cx, cy - r, cx + r + 30, cy],
        [3, 14, cx - 25, cy + r, cx - 25, cy + r / 3, cx + 25, cy + r / 3, cx + 25, cy + r],
      ].map((s) => s.map(Math.round)),
    };
  }
  const rays: number[][] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    rays.push([3, 12, cx + Math.cos(a) * (r + 20), cy + Math.sin(a) * (r + 20), cx + Math.cos(a) * (r + 90), cy + Math.sin(a) * (r + 90)]);
  }
  return { strokes: [circle(cx, cy, r, 4, 30), ...rays].map((s) => s.map((v) => Math.max(0, Math.min(1000, Math.round(v))))) };
}

export class Bot {
  readonly client: PartyClient;
  readonly name: string;
  /** The last error the host answered with. */
  errors: string[] = [];
  readonly #o: BotOptions;
  readonly #rng: () => number;
  #handled = new Set<string>();
  /** Answers on their way (cleared by `close`: a closed bot never acts). */
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

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

  #onView(view: Record<string, any>): void {
    if (this.#o.silent) return;
    const me = view["me"] ?? {};
    const room = view["room"] ?? {};
    const c = this.client;
    // `me.key` names the drawing a lie or vote is for (`round.spot`).
    const turn = `${room.round}:${me.key ?? me.deadline ?? ""}`;
    switch (me.task) {
      case "lobby":
      case "final": {
        // A next game reuses the keys (`1.1`, …): answer them again
        // (also after a closed game; in the lobby not start twice).
        if (me.task === "final") this.#handled.clear();
        else for (const k of this.#handled) if (!k.startsWith("start:")) this.#handled.delete(k);
        const vip = (view["roster"] ?? []).find((r: { id: string }) => r.id === c.you?.id)?.vip;
        const ready = (view["roster"] ?? []).filter((r: { connected: boolean }) => r.connected).length;
        if (this.#o.autoStart && vip && me.task === "lobby" && ready >= (room.minPlayers ?? 3)) {
          this.#once(`start:${ready}`, () => c.act("start"));
        }
        return;
      }
      case "draw":
        if (!me.done) {
          // The TV's progress first (how much is drawn), then the drawing.
          if (!this.#handled.has(`draw:${turn}`)) c.input({ ink: 50 + Math.floor(this.#rng() * 300) });
          this.#once(`draw:${turn}`, () => c.act("draw", doodle(this.#rng, Array.isArray(me.palette) ? me.palette.length : 8, typeof me.frames === "number" ? me.frames : 1)));
        }
        return;
      case "lie":
        if (!me.done) {
          const own = this.#o.lies;
          const lies = own ?? LIES[pickLang(room.lang)];
          const base = lies[Math.floor(this.#rng() * lies.length)]!;
          // Now and then the same idea as another bot (merged lies).
          const lie = { text: own || this.#rng() < 0.3 ? base : `${base} ${this.name}` };
          if (!this.#handled.has(`lie:${turn}`)) c.input({ typing: true });
          this.#once(`lie:${turn}`, () => c.act("lie", lie));
        }
        return;
      case "vote":
        if (!me.done && Array.isArray(me.options) && me.options.length > 0) {
          const opts = me.options as { id: string; text: string }[];
          const pick = opts[Math.floor(this.#rng() * opts.length)]!;
          this.#once(`vote:${turn}`, () => c.act("vote", { option: pick.id }));
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
export async function bots(
  n: number,
  o: Omit<BotOptions, "name"> & { names?: string[] },
): Promise<Bot[]> {
  const names = o.names ?? ["Ada", "Bea", "Cy", "Dot", "Eli", "Fay", "Gus", "Hal"];
  const out: Bot[] = [];
  for (let i = 0; i < n; i++) {
    const b = new Bot({ ...o, name: names[i % names.length]! + (i >= names.length ? String(i) : ""), autoStart: o.autoStart && i === 0 });
    await b.join();
    out.push(b);
  }
  return out;
}
