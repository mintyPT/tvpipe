/**
 * Fake players: clients that play Shifty by themselves. For the tests (in
 * Node) and the live check: the host page's bot buttons (test mode, or
 * `?bots`) run them in the window, connected through tvpipe like a phone.
 *
 * A bot types its clue letter by letter (the TV's tiles and needle move;
 * now and then it deletes a few letters and types again), with a word
 * from a short list of vague clues (another one when the board refuses
 * it), accuses someone, and as the phony picks a word of the board. With
 * an `oracle` (the host page's, which knows the phony and the word) an
 * innocent bot accuses the phony sometimes and a phony bot names the
 * word sometimes; without one it guesses.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import { pickLang, type Lang } from "./rules.ts";

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
  /** Between two keys, ms (default 90–260 random). */
  keyGap?: () => number;
  /** After a false start, before deleting it, ms (default 400–1300 random). */
  hesitate?: () => number;
  /** Never answer (to test deadlines). */
  silent?: boolean;
  /** Tasks it leaves to the test (`clue`, `accuse`, `pick`, …). */
  skip?: string[];
  /** Clues it gives (default {@link CLUES} of the room's language). */
  clues?: readonly string[] | undefined;
  /** What the host knows: the phony's id and the secret's index on the board. */
  oracle?: (() => { phony: string; secret: number } | undefined) | undefined;
  /** With the oracle: how often an innocent accuses the phony, and a phony names the word (0–1). */
  sharp?: number | undefined;
}

/** Vague clues: they fit about anything and are on no board. */
export const CLUES: Record<Lang, readonly string[]> = {
  en: ["fluffy", "loud", "round", "shiny", "wild", "tiny", "sweet", "speedy", "ancient", "noisy", "heavy", "soft", "famous", "pointy", "colourful", "spooky", "useful", "smelly", "bouncy", "classic"],
  de: ["flauschig", "laut", "rund", "glänzend", "wild", "winzig", "süß", "flott", "uralt", "schwer", "weich", "berühmt", "spitz", "bunt", "gruselig", "nützlich", "stinkig", "hüpfend", "klassisch", "praktisch"],
};

export class Bot {
  readonly client: PartyClient;
  readonly name: string;
  /** Errors the host answered with. */
  errors: string[] = [];
  /** Clues the board refused. */
  refused: string[] = [];
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

  #pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.#rng() * xs.length)]!;
  }

  /**
   * Types `word` letter by letter as continuous input (`{ turn, n, k, d }`),
   * sometimes a false start deleted first, then sends it; another word
   * when the board refuses it.
   */
  #type(turn: string, lang: Lang, tries = 0): void {
    const c = this.client;
    const list = this.#o.clues ?? CLUES[lang];
    const word = this.#pick(list);
    const gap = () => (this.#o.keyGap ? this.#o.keyGap() : 90 + this.#rng() * 170);
    let n = 0;
    let k = 0;
    let d = 0;
    let at = 0;
    const step = (fn: () => void) => {
      at += gap();
      this.#later(at, fn);
    };
    const report = () => c.input({ turn, n, k, d });
    // A false start: a few letters, then deleted (the needle kicks).
    if (this.#rng() < 0.4) {
      const false_ = 2 + Math.floor(this.#rng() * 5);
      for (let i = 0; i < false_; i++)
        step(() => {
          n++;
          k++;
          report();
        });
      at += this.#o.hesitate ? this.#o.hesitate() : 400 + this.#rng() * 900;
      for (let i = 0; i < false_; i++)
        step(() => {
          n--;
          d++;
          report();
        });
    }
    for (let i = 0; i < [...word].length; i++)
      step(() => {
        n++;
        k++;
        report();
      });
    at += 200;
    this.#later(
      at,
      async () => {
        const res = (await c.act("clue", { key: turn, text: word })) as { ok?: boolean } | null;
        if (res && res.ok === false) {
          this.refused.push(word);
          if (tries < 5) this.#type(turn, lang, tries + 1);
        }
      },
      ["not-now", "not-yours"],
    );
  }

  #onView(view: Record<string, any>): void {
    const me = view["me"] ?? {};
    if (this.#o.silent || this.#o.skip?.includes(me.task)) return;
    const room = view["room"] ?? {};
    const c = this.client;
    const lang = pickLang(room["lang"]);
    const you = c.you?.id;
    switch (me.task) {
      case "lobby":
      case "final": {
        if (me.task === "final" || [...this.#handled].some((k) => !k.startsWith("start:"))) this.#handled.clear();
        const vip = (view["roster"] ?? []).find((r: { id: string }) => r.id === you)?.vip;
        const ready = (view["roster"] ?? []).filter((r: { connected: boolean }) => r.connected).length;
        if (this.#o.autoStart && vip && me.task === "lobby" && ready >= (room.minPlayers ?? 3)) this.#once(`start:${ready}`, () => c.act("start"));
        return;
      }
      case "clue":
        if (me.mine && !me.sent) {
          const turn = me.turn;
          if (room.mode === "spoken") this.#once(`clue:${turn}`, () => c.act("clue", { key: turn, text: this.#rng() < 0.5 ? "" : this.#pick(this.#o.clues ?? CLUES[lang]) }), ["not-now", "not-yours"]);
          else this.#once(`clue:${turn}`, () => this.#type(turn, lang));
        }
        return;
      case "accuse":
        if (!me.done) {
          const others = ((room.order ?? []) as string[]).filter((id) => id !== you);
          const truth = this.#o.oracle?.();
          const sharp = this.#o.sharp ?? 0.5;
          const id = truth && truth.phony !== you && this.#rng() < sharp ? truth.phony : this.#pick(others);
          if (others.length > 0) this.#once(`accuse:${room.round}`, () => c.act("accuse", { id }), ["not-now"]);
        }
        return;
      case "pick":
        if (!me.done) {
          const truth = this.#o.oracle?.();
          const n = (room.board ?? []).length || 16;
          const index = truth && this.#rng() < (this.#o.sharp ?? 0.5) ? truth.secret : Math.floor(this.#rng() * n);
          this.#once(`pick:${room.round}`, () => c.act("pick", { index }), ["not-now"]);
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
