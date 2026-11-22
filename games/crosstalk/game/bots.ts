/**
 * Fake players: clients that play Crosstalk by themselves. For the tests
 * (in Node) and the live check: the host page's bot buttons (test mode,
 * or `?bots`) run them in the window, connected through tvpipe like a
 * phone.
 *
 * A bot cannot read a clue. A bot spymaster sends a word from a short
 * list (whatever the board allows) for one or two cards. Bot operatives
 * of a team agree on a card without talking: they all pick the same one
 * from the step and the board. With an `oracle` (the host's key) they
 * mostly pick their own colour, else any card face down; they lock when
 * their pin is the majority's, pass after their clue's cards, and write
 * a line on the pad now and then.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import type { Color, Lang, Team } from "./rules.ts";

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
  /** Delay before acting, ms (default 0–300 random). */
  think?: () => number;
  /** Never act (to test deadlines). */
  silent?: boolean;
  /** Tasks it leaves to the test (`spymaster`, `operative`). */
  skip?: string[];
  /** The board's colours for this bot's player (the host's key), if known. */
  oracle?: ((id: string) => Color[] | undefined) | undefined;
  /** How often a bot operative with the oracle picks a wrong card (0–1, default 0.2). */
  miss?: number;
  /** Write on the pad (default true). */
  notes?: boolean;
}

/** Clues a bot spymaster tries, per language (the first the board allows). */
export const CLUES: Record<Lang, readonly string[]> = {
  en: ["thing", "stuff", "maybe", "spark", "orbit", "velvet", "gadget", "puzzle", "breeze", "riddle", "pocket", "marble"],
  de: ["Ding", "Zeug", "vielleicht", "Funke", "Umlaufbahn", "Samt", "Rätsel", "Brise", "Tasche", "Murmel", "Krempel", "Kram"],
};

/** Lines a bot writes on the pad. */
export const NOTES: Record<Lang, readonly string[]> = {
  en: ["they whispered something about", "ours? maybe", "NOT this one:", "left over from last clue:", "careful with"],
  de: ["die haben was geflüstert von", "unsere? vielleicht", "NICHT die hier:", "übrig vom letzten Hinweis:", "Vorsicht bei"],
};

/** A stable number in [0, 1) for a key: every bot of a team gets the same. */
export function hash(key: string): number {
  let x = 2166136261;
  for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 16777619);
  x ^= x >>> 13;
  x = Math.imul(x, 0x5bd1e995);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

/**
 * The card a team's bots go for in a step: one of their own colour that
 * is face down (with the key), unless the step's hash says they miss;
 * then (and without a key) any card face down. -1: none left.
 */
export function botCard(hidden: readonly number[], key: readonly Color[] | undefined, team: Team, seed: string, miss: number): number {
  if (hidden.length === 0) return -1;
  const own = key ? hidden.filter((i) => key[i] === team) : [];
  const r = hash(seed);
  if (own.length > 0 && r >= miss) return own[Math.floor(hash(`${seed}:own`) * own.length)]!;
  // A miss is never the assassin when the bot can know (a bot that loses every game tests little).
  const any = key ? hidden.filter((i) => key[i] !== "assassin") : hidden;
  const pool = any.length > 0 ? any : hidden;
  return pool[Math.floor(hash(`${seed}:any`) * pool.length)]!;
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

  #once(key: string, fn: () => Promise<unknown>, ignore: readonly string[] = []): void {
    if (this.#handled.has(key)) return;
    this.#handled.add(key);
    this.#later(this.#o.think ? this.#o.think() : this.#rng() * 300, fn, ignore);
  }

  /** Clues from the list until the board takes one. */
  async #giveClue(lang: Lang, hidden: number): Promise<void> {
    const list = CLUES[lang];
    const start = Math.floor(this.#rng() * list.length);
    const number = Math.max(1, Math.min(hidden, 1 + Math.floor(this.#rng() * 2)));
    for (let i = 0; i < list.length; i++) {
      try {
        await this.client.act("clue", { word: list[(start + i) % list.length]!, number });
        return;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "too-close" || code === "refused") continue;
        if (code !== "not-now" && code !== "already") this.errors.push(code ?? String(e));
        return;
      }
    }
  }

  #onView(view: Record<string, any>): void {
    const me = view["me"] ?? {};
    if (this.#o.silent || this.#o.skip?.includes(me.task)) return;
    const room = view["room"] ?? {};
    const c = this.client;
    const lang: Lang = room.lang === "de" ? "de" : "en";
    // Too late is no mistake: the step may be over by then.
    const late = ["not-now", "already", "no-majority", "not-yours", "bad-card", "no-pass", "busy", "no-line"];
    switch (me.task) {
      case "lobby":
      case "end": {
        if (me.task === "end" || [...this.#handled].some((k) => !k.startsWith("start:"))) this.#handled.clear();
        const roster = view["roster"] ?? [];
        const vip = roster.find((r: { id: string }) => r.id === c.you?.id)?.vip;
        const ready = roster.filter((r: { connected: boolean }) => r.connected).length;
        if (this.#o.autoStart && vip && me.task === "lobby" && ready >= (room.minPlayers ?? 4)) this.#once(`start:${ready}`, () => c.act("start"));
        return;
      }
      case "spymaster": {
        if (room.phase !== "clue" || me.clue) return;
        const board = (room.board ?? []) as { color: Color | null }[];
        const left = (me.key as Color[] | null)?.filter((k, i) => k === me.team && !board[i]?.color).length ?? 1;
        this.#once(`clue:${room.round}`, () => this.#giveClue(lang, left));
        return;
      }
      case "operative":
        return this.#operative(room, me, lang, late);
    }
  }

  #operative(room: Record<string, any>, me: Record<string, any>, lang: Lang, late: readonly string[]): void {
    const c = this.client;
    const id = c.you?.id ?? "";
    const board = (room.board ?? []) as { word: string; color: Color | null }[];
    const hidden = board.flatMap((b, i) => (b.color === null ? [i] : []));
    const key = this.#o.oracle?.(id);
    // A note now and then (once a round, by chance).
    if ((this.#o.notes ?? true) && room.round > 0 && me.pad && hidden.length > 0 && !this.#handled.has(`note:${room.round}`)) {
      this.#handled.add(`note:${room.round}`);
      if (this.#rng() < 0.5) {
        const word = board[hidden[Math.floor(this.#rng() * hidden.length)]!]!.word;
        const pre = NOTES[lang][Math.floor(this.#rng() * NOTES[lang].length)]!;
        this.#later(this.#o.think ? this.#o.think() : 200, () => c.act("pad", { op: "add", text: `${pre} ${word}` }), [...late, "pad-full"]);
      }
    }
    if (room.phase !== "guess" || !me.active || me.locked !== null || !me.clue) return;
    const step = `${room.round}:${room.roundStep}:${me.team}`;
    // After the clue's cards: pass (the extra card is for people who remember).
    const choice: number | "pass" = me.canPass && me.turned >= me.clue.number ? "pass" : botCard(hidden, key, me.team, `${room.step}:${me.team}`, this.#o.miss ?? 0.2);
    if (choice === -1) return;
    if (me.mine !== choice) {
      this.#once(`pin:${step}:${choice}`, () => c.act("pin", { card: choice }), late);
      return;
    }
    if (me.majority === choice) this.#once(`lock:${step}`, () => c.act("lock"), late);
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
