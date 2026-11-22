/**
 * Fake players: clients that play Busted by themselves. For the tests (in
 * Node) and the live check: the host page's bot buttons (test mode, or
 * `?bots`) run them in the window, connected through tvpipe like a phone.
 *
 * A bot draws a scribble of a face in the lobby (sometimes), ranks a
 * random podium, writes an answer from a short list, matches the cards
 * at random (each name as often as it may), likes a card now and then,
 * rates the suggestions on the desk and, when told to, suggests some.
 */

import { memoryStorage, PartyClient, type WebSocketFactory } from "@tvpipe/party/client";

import { doodle } from "./face.ts";
import { pickLang, type Kind, type Lang } from "./rules.ts";

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
  /** Never answer (to test deadlines). */
  silent?: boolean;
  /** Tasks it leaves to the test (`rank`, `write`, `match`, …). */
  skip?: string[];
  /** Answers it writes (default {@link ANSWERS} of the room's language). */
  answers?: readonly string[] | undefined;
  /** Suggestions it makes once it joined. */
  suggest?: readonly { kind: Kind; text: string; title?: string }[] | undefined;
  /** How it rates suggestions: always 👍, always 👎, at random (mostly 👍), or not at all. */
  rate?: "up" | "down" | "random" | "never" | undefined;
  /** Sends a press photo when it joins (a doodle of another name). */
  portrait?: boolean | undefined;
  /** Names it ranks first, in this order (the live check's pictures); the rest at random. */
  favor?: readonly string[] | undefined;
}

/** Answers that fit about any question. */
export const ANSWERS: Record<Lang, readonly string[]> = {
  en: [
    "A llama in a tiny hat",
    "Definitely pizza at 3 a.m.",
    "Singing in the shower, badly",
    "My grandma's secret pancake recipe",
    "Talking to my houseplants",
    "Forty-seven browser tabs",
    "A nap that lasts a week",
    "Dancing when nobody is looking",
    "Collecting rubber ducks",
    "Pretending to know the lyrics",
    "Socks with sandals, proudly",
    "Eating cereal for dinner",
  ],
  de: [
    "Ein Lama mit einem winzigen Hut",
    "Pizza um drei Uhr nachts",
    "Unter der Dusche singen, schief",
    "Omas geheimes Pfannkuchenrezept",
    "Mit meinen Zimmerpflanzen reden",
    "Siebenundvierzig offene Tabs",
    "Ein Mittagsschlaf von einer Woche",
    "Tanzen, wenn keiner hinschaut",
    "Quietscheentchen sammeln",
    "So tun, als kenne ich den Text",
    "Socken in Sandalen, mit Stolz",
    "Müsli zum Abendessen",
  ],
};

export class Bot {
  readonly client: PartyClient;
  readonly name: string;
  /** Errors the host answered with. */
  errors: string[] = [];
  readonly #o: BotOptions;
  readonly #rng: () => number;
  #handled = new Set<string>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #rated = new Set<string>();

  constructor(o: BotOptions) {
    this.#o = o;
    this.name = o.name;
    this.#rng = o.rng ?? Math.random;
    this.client = new PartyClient({ url: o.url, room: o.room, key: o.key, storage: memoryStorage(), WebSocket: o.WebSocket });
    this.client.on("view", (view) => this.#onView(view));
  }

  async join(): Promise<void> {
    await this.client.join(this.name);
    if (this.#o.portrait) await this.client.act("portrait", { strokes: doodle(`${this.name}*`) }).catch((e: { code?: string }) => this.errors.push(e.code ?? String(e)));
    for (const s of this.#o.suggest ?? []) await this.client.act("suggest", s).catch((e: { code?: string }) => this.errors.push(e.code ?? String(e)));
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

  #shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.#rng() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  #rate(desk: { rate?: { id: string } | null } | undefined): void {
    const mode = this.#o.rate ?? "random";
    const next = desk?.rate;
    if (mode === "never" || !next || this.#rated.has(next.id)) return;
    this.#rated.add(next.id);
    const rating = mode === "up" ? 1 : mode === "down" ? -1 : this.#rng() < 0.8 ? 1 : -1;
    this.#later(this.#o.think ? this.#o.think() : this.#rng() * 300, () => this.client.act("rate", { id: next.id, rating }), ["no-tip"]);
  }

  #onView(view: Record<string, any>): void {
    const me = view["me"] ?? {};
    if (this.#o.silent) return;
    this.#rate(me.desk);
    if (this.#o.skip?.includes(me.task)) return;
    const room = view["room"] ?? {};
    const c = this.client;
    const lang = pickLang(room["lang"]);
    const you = c.you?.id;
    const r = room.round ?? 0;
    switch (me.task) {
      case "lobby":
      case "final": {
        if (me.task === "final" || [...this.#handled].some((k) => !k.startsWith("start:"))) this.#handled.clear();
        const vip = (view["roster"] ?? []).find((x: { id: string }) => x.id === you)?.vip;
        const ready = (view["roster"] ?? []).filter((x: { connected: boolean }) => x.connected).length;
        if (this.#o.autoStart && vip && me.task === "lobby" && ready >= (room.minPlayers ?? 3)) this.#once(`start:${ready}`, () => c.act("start"));
        return;
      }
      case "rank":
        if (!me.done) {
          const candidates = (room.candidates ?? []) as string[];
          const named = (this.#o.favor ?? []).flatMap((n) => candidates.filter((id) => room.people?.[id]?.name === n));
          const podium = [...named, ...this.#shuffle(candidates.filter((id) => !named.includes(id)))].slice(0, room.podium ?? 3);
          if (podium.length > 0) this.#once(`rank:${r}:${room.question?.text}`, () => c.act("rank", { podium }), ["not-asked", "already-answered"]);
        }
        return;
      case "write":
        if (!me.done) {
          const list = this.#shuffle(this.#o.answers ?? ANSWERS[lang]).slice(0, me.n ?? 1);
          this.#once(`write:${r}:${room.question?.text}`, () => c.act("answer", { texts: list }), ["not-asked", "already-answered"]);
        }
        return;
      case "match":
        if (!me.done) {
          const own = new Set<number>(me.own ?? []);
          const cards = ((room.cards ?? []) as { id: number }[]).filter((x) => !own.has(x.id)).map((x) => x.id);
          const per = room.per ?? 1;
          const names = this.#shuffle(((room.authors ?? []) as string[]).filter((id) => id !== you).flatMap((id) => Array.from({ length: per }, () => id)));
          const guesses: Record<string, string> = {};
          this.#shuffle(cards).forEach((id, i) => {
            if (names[i] !== undefined) guesses[id] = names[i]!;
          });
          const heart = cards.length > 0 && this.#rng() < 0.7 ? this.#pick(cards) : null;
          this.#once(`match:${r}`, () => c.act("match", { guesses, heart }), ["not-asked", "already-answered"]);
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
