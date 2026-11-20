/**
 * Fake players: clients that play Jinx by themselves. For the tests (in
 * Node), and for trying the game alone: the host page's "Add a bot" runs
 * them in the window, connected through tvpipe like a phone.
 *
 * Clue-givers write the word's category or a random dictionary word (so
 * bots jinx each other now and then), sometimes bold, and write another
 * clue when one is refused. A bot guesser turns a random number of cards,
 * then guesses: it cheats (`peek`, the host's secret word) to be right
 * most of the time, else guesses a random word or passes. It picks a
 * random MVP clue. Bots write in the room's language (`room.lang`): the
 * category in its words ("Tier" for `animal`), that language's words.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import { pickLang, type Lang } from "./lang.ts";
import type { WordEntry } from "./match.ts";

export type GuessStyle = "mixed" | "right" | "wrong" | "pass" | "silent";
export type ClueStyle = "mixed" | "category" | "random";

export interface BotOptions {
  /** The WebSocket URL (`ws://127.0.0.1:PORT/_tvpipe/ws`). */
  url: string;
  /** Default the global one (tests: a memory relay's). */
  WebSocket?: WebSocketFactory | undefined;
  room: string;
  key: string;
  name: string;
  rng?: (() => number) | undefined;
  /** Start the game when VIP and enough players are there. */
  autoStart?: boolean | undefined;
  /** Delay before each move, ms (default 0–300 random). */
  think?: (() => number) | undefined;
  /** Never act (to test the timers). */
  silent?: boolean | undefined;
  /** The secret word (the host's), for guessing right. */
  peek?: (() => string | undefined) | undefined;
  /** The word lists (any languages), for the categories. */
  words?: readonly WordEntry[] | undefined;
  /** Words for random clues and wrong guesses: for every language, or per language. */
  dict?: readonly string[] | Partial<Record<Lang, readonly string[]>> | undefined;
  /** How this bot guesses (default `mixed`: mostly right, now and then wrong or a pass). */
  guess?: GuessStyle | undefined;
  /** How this bot writes clues (default `mixed`). */
  clues?: ClueStyle | undefined;
  /** Chance of a bold clue (default 0.2). */
  bold?: number | undefined;
}

/** Words for random clues when no dictionary is given, per language. */
export const FALLBACK: Record<Lang, readonly string[]> = {
  en: [
    "red", "big", "small", "fast", "loud", "home", "summer", "night", "water", "metal", "wood", "round", "soft", "cold", "warm",
    "old", "new", "happy", "dark", "sweet", "green", "blue", "tall", "fun", "paper", "glass", "kitchen", "school", "garden", "music",
  ],
  de: [
    "rot", "groß", "klein", "schnell", "laut", "Zuhause", "Sommer", "Nacht", "Wasser", "Metall", "Holz", "rund", "weich", "kalt", "warm",
    "alt", "neu", "fröhlich", "dunkel", "süß", "grün", "blau", "hoch", "Spaß", "Papier", "Glas", "Küche", "Schule", "Garten", "Musik",
  ],
};

/** The word list's categories (English ids) as a German clue. */
export const CATEGORY_DE: Record<string, string> = {
  animal: "Tier",
  food: "Essen",
  home: "Haushalt",
  nature: "Natur",
  people: "Mensch",
  place: "Ort",
  sport: "Sport",
  fantasy: "Märchen",
  music: "Musik",
  transport: "Fahrzeug",
  body: "Körper",
  tool: "Werkzeug",
  clothing: "Kleidung",
  science: "Wissenschaft",
  event: "Fest",
  material: "Material",
  action: "Bewegung",
  quality: "Eigenschaft",
  thing: "Ding",
};

/** A category as a clue in a language. */
export function categoryClue(category: string, lang: Lang): string {
  return lang === "de" ? (CATEGORY_DE[category] ?? "Ding") : category;
}

export class Bot {
  readonly client: PartyClient;
  readonly name: string;
  /** Error codes the host answered with. */
  errors: string[] = [];
  readonly #o: BotOptions;
  readonly #rng: () => number;
  readonly #category = new Map<string, string>();
  #handled = new Set<string>();
  /** Per round: how many cards to turn before guessing, and how to end. */
  #plan: { key: string; target: number; end: "right" | "wrong" | "pass" } | undefined;

  constructor(o: BotOptions) {
    this.#o = o;
    this.name = o.name;
    this.#rng = o.rng ?? Math.random;
    for (const w of o.words ?? []) this.#category.set(w.word, w.category);
    this.client = new PartyClient({ url: o.url, room: o.room, key: o.key, storage: memoryStorage(), WebSocket: o.WebSocket });
    this.client.on("view", (view) => this.#onView(view));
  }

  async join(): Promise<void> {
    await this.client.join(this.name);
  }

  #delay(): number {
    return this.#o.think ? this.#o.think() : this.#rng() * 300;
  }

  #once(key: string, fn: () => Promise<unknown>, delay = this.#delay()): void {
    if (this.#handled.has(key)) return;
    this.#handled.add(key);
    setTimeout(() => {
      fn().catch((e: { code?: string }) => this.errors.push(e.code ?? String(e)));
    }, delay);
  }

  #pick<T>(xs: readonly T[]): T | undefined {
    return xs[Math.floor(this.#rng() * xs.length)];
  }

  /** The room's language (the room view's). */
  get lang(): Lang {
    return pickLang(this.client.view?.["room"]?.lang);
  }

  #randomWord(): string {
    const lang = this.lang;
    const d = this.#o.dict;
    const dict = (Array.isArray(d) ? d : (d as Partial<Record<Lang, readonly string[]>> | undefined)?.[lang]) ?? [];
    const pool = dict.length > 0 ? dict : FALLBACK[lang];
    for (let i = 0; i < 20; i++) {
      const w = this.#pick(pool)!;
      if (/^\p{L}{3,12}$/u.test(w)) return w;
    }
    return this.#pick(FALLBACK[lang])!;
  }

  #clue(word: string, attempt: number): string {
    const style = this.#o.clues ?? "mixed";
    const cat = categoryClue(this.#category.get(word) ?? "thing", this.lang);
    if (attempt > 0) return this.#randomWord();
    if (style === "category") return cat;
    if (style === "random") return this.#randomWord();
    return this.#rng() < 0.4 ? cat : this.#randomWord();
  }

  #write(round: string, word: string, slot: number, attempt: number): void {
    if (attempt > 8) return;
    const text = this.#clue(word, attempt);
    const bold = this.#rng() < (this.#o.bold ?? 0.2);
    this.#once(`clue:${round}:${slot}:${attempt}`, () =>
      this.client.act("clue", { text, bold, slot }).catch((e: { code?: string }) => {
        if (e.code === "late" || e.code === "not-asked") return;
        this.#write(round, word, slot, attempt + 1);
      }),
    );
  }

  #onView(view: Record<string, any>): void {
    if (this.#o.silent) return;
    const me = view["me"] ?? {};
    const room = view["room"] ?? {};
    const c = this.client;
    const round = `${room.round ?? 0}:${room.guesser ?? ""}`;
    switch (me.task) {
      case "lobby":
      case "final": {
        // A next game reuses the round numbers: answer them again.
        this.#handled = new Set([...this.#handled].filter((k) => k.startsWith("start:")));
        this.#plan = undefined;
        const vip = (view["roster"] ?? []).find((r: { id: string }) => r.id === c.you?.["id"])?.vip;
        const ready = (view["roster"] ?? []).filter((r: { connected: boolean }) => r.connected).length;
        if (this.#o.autoStart && vip && me.task === "lobby" && ready >= (room.minPlayers ?? 3)) {
          this.#once(`start:${ready}`, () => c.act("start"));
        }
        return;
      }
      case "write": {
        const sent = (me.sent ?? []) as unknown[];
        sent.forEach((s, slot) => {
          if (s === null) this.#write(round, String(me.word), slot, 0);
        });
        return;
      }
      case "guess":
        return this.#guess(round, me);
      case "mvp": {
        const card = this.#pick((me.cards ?? []) as { id: string }[]);
        if (card) this.#once(`mvp:${round}`, () => c.act("mvp", { card: card.id }));
        return;
      }
    }
  }

  #guess(round: string, me: { cards?: { id: string; turned?: number }[] }): void {
    const style = this.#o.guess ?? "mixed";
    if (style === "silent") return;
    const cards = me.cards ?? [];
    if (this.#plan?.key !== round) {
      const r = this.#rng();
      const mixed = r < 0.75 ? "right" : r < 0.88 ? "wrong" : "pass";
      const end = style === "mixed" ? mixed : style;
      this.#plan = { key: round, target: 1 + Math.floor(this.#rng() * cards.length), end };
    }
    const plan = this.#plan;
    const turned = cards.filter((x) => x.turned !== undefined).length;
    const down = cards.filter((x) => x.turned === undefined);
    const c = this.client;
    if (turned < plan.target && down.length > 0) {
      const card = this.#pick(down)!;
      this.#once(`pick:${round}:${turned}`, () => c.act("pick", { card: card.id }));
      return;
    }
    if (plan.end === "pass") {
      this.#once(`end:${round}`, () => c.act("pass"));
      return;
    }
    const word = plan.end === "right" ? (this.#o.peek?.() ?? this.#randomWord()) : this.#randomWord();
    // Typed letter by letter (the TV shows the draft), then sent.
    this.#once(`end:${round}`, async () => {
      for (let i = 1; i <= word.length; i++) {
        c.input({ draft: word.slice(0, i) });
        await new Promise((r) => setTimeout(r, Math.min(120, this.#delay() / 4)));
      }
      await c.act("guess", { text: word });
    });
  }

  close(): void {
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
