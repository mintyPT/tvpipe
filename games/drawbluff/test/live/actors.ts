/**
 * Players for the screenshots (`play.ts --shots`): they play the round of
 * `scenario.ts` with people's names: each draws the drawing made for the
 * prompt they are dealt and writes, for each other drawing, the fake
 * title written for it, so the pictures on the site show a round of
 * friends, not a test.
 */

import { memoryStorage, PartyClient } from "@tvpipe/party/client";

import { dealt, lieFor, PLAYERS, scene } from "./scenario.ts";

/** The others' names (Phil is on the phone). */
export const NAMES = PLAYERS.slice(1);

/** A player who joins, draws, writes titles and votes by itself. */
export class Actor {
  readonly client: PartyClient;
  readonly name: string;
  readonly #handled = new Set<string>();
  readonly #think: () => number;

  constructor(o: { url: string; room: string; key: string; name: string; think: () => number }) {
    this.name = o.name;
    this.#think = o.think;
    this.client = new PartyClient({ url: o.url, room: o.room, key: o.key, storage: memoryStorage() });
    this.client.on("view", (v) => this.#onView(v));
  }

  #once(key: string, fn: () => Promise<unknown>): void {
    if (this.#handled.has(key)) return;
    this.#handled.add(key);
    setTimeout(() => void fn().catch(() => {}), this.#think());
  }

  #onView(view: Record<string, any>): void {
    const me = view["me"] ?? {};
    const room = view["room"] ?? {};
    const turn = `${room.round}:${me.key ?? me.deadline ?? ""}`;
    const c = this.client;
    if (me.task === "draw" && !me.done && typeof me.prompt === "string") {
      const strokes = scene(me.prompt).strokes;
      dealt.set(this.name, me.prompt);
      if (!this.#handled.has(`draw:${turn}`)) c.input({ ink: strokes.length * 40 });
      this.#once(`draw:${turn}`, () => c.act("draw", { strokes }));
    } else if (me.task === "lie" && !me.done && typeof me.artist?.name === "string") {
      if (!this.#handled.has(`lie:${turn}`)) c.input({ typing: true });
      this.#once(`lie:${turn}`, () => c.act("lie", { text: lieFor(this.name, me.artist.name) }));
    } else if (me.task === "vote" && !me.done && Array.isArray(me.options) && me.options.length > 0) {
      const opts = me.options as { id: string }[];
      this.#once(`vote:${turn}`, () => c.act("vote", { option: opts[Math.floor(Math.random() * opts.length)]!.id }));
    } else if (me.task === "final") {
      this.#handled.clear();
    }
  }

  close(): void {
    this.client.close();
  }
}

/** The actors ({@link NAMES}) joined to a party, one after the other. */
export async function actors(o: { url: string; room: string; key: string; think: () => number }): Promise<Actor[]> {
  const out: Actor[] = [];
  for (const name of NAMES) {
    const a = new Actor({ ...o, name });
    await a.client.join(name);
    out.push(a);
  }
  return out;
}
