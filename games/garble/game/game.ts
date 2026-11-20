/**
 * Garble on a party, for 4 to 12 players (docs/garble-design.md): the
 * lobby, then per round a secret word for everyone and one secret
 * Wrecker, the chains passed seat to seat (draw, guess, draw, …), the
 * reveal (each chain shown on the TV, judged by its author), the hunt
 * for the Wrecker, the scores; the final podium. The host is the only
 * authority: phones and screens only ever get views.
 *
 * Views:
 * - `party.room` (every phone): `{ phase, lang, round, rounds, step?, steps?, deadline?, undo, twists, length, minPlayers }`
 * - `player.state` (one phone): `{ task, word?, wrecker?, color, score, rank, of, … }`, `task` one of
 *   `lobby`, `wait` (a late joiner), `secret` (the round's word and role), `draw` (`text` or `choices`,
 *   `from`, `next`, `undo`, `deadline`, `done`), `guess` (`drawing`, `from`, `next`, `twist`, `deadline`,
 *   `done`), `judge` (`chain`, `deadline`, `done`), `watch` (`author`), `accuse` (`suspects`, `deadline`,
 *   `done`, `choice`), `scores` (`earned`, `delta`), `final`
 * - `party.screen` (the TV): `{ phase, lang, colors, … }` per phase, see each method.
 *
 * The secret words reach only their own phone (and the TV once
 * smuggled, or at the scores); who the Wrecker is reaches only the
 * Wrecker's phone until the unmasking.
 */

import { Emitter, PartyError, type Json, type Party, type Player } from "@tvpipe/party";

import {
  autoVerdict,
  breakOf,
  chainAt,
  chainSteps,
  cleanGuess,
  Deck,
  earnedTotal,
  guesses,
  lastText,
  LENGTHS,
  marks,
  MIN_PLAYERS,
  pickWrecker,
  says,
  scoreRound,
  shuffle,
  smuggles,
  stepKind,
  twistOf,
  validateDrawing,
  type Chain,
  type Drawing,
  type Earned,
  type Lang,
  type Twist,
} from "./rules.ts";

export interface Timings {
  /** The secret words and the Wrecker's card. */
  intro: number;
  /** The first step: pick a prompt, draw it. */
  firstDraw: number;
  draw: number;
  guess: number;
  /** The reveal on the TV, per card. */
  showPrompt: number;
  showDrawing: number;
  showGuess: number;
  /** The whole chain at a glance before the author judges. */
  overview: number;
  /** The author's verdict (at most). */
  judge: number;
  /** The verdict's animation: the base, per guess, per smuggled word. */
  verdictBase: number;
  verdictStep: number;
  verdictSmuggle: number;
  accuse: number;
  unmask: number;
  scores: number;
}

export const DEFAULT_TIMINGS: Timings = {
  intro: 11_000,
  firstDraw: 80_000,
  draw: 60_000,
  guess: 30_000,
  showPrompt: 2600,
  showDrawing: 4600,
  showGuess: 2800,
  overview: 2200,
  judge: 30_000,
  verdictBase: 3000,
  verdictStep: 650,
  verdictSmuggle: 2000,
  accuse: 35_000,
  unmask: 9000,
  scores: 12_000,
};

export const FAST_TIMINGS: Timings = {
  intro: 7000,
  firstDraw: 45_000,
  draw: 35_000,
  guess: 20_000,
  showPrompt: 1800,
  showDrawing: 3200,
  showGuess: 2000,
  overview: 1500,
  judge: 20_000,
  verdictBase: 2200,
  verdictStep: 450,
  verdictSmuggle: 1500,
  accuse: 25_000,
  unmask: 7000,
  scores: 8000,
};

/** The room's settings: the host page's, or the VIP's in the lobby. */
export interface Settings {
  /** Undo (and clear) on the drawing pad; off: every stroke counts. */
  undo: boolean;
  /** A twist per round on the guesses (glimpse, peephole). */
  twists: boolean;
  /** Steps per chain (4, 6, 8), at most the players. */
  length: number;
}

export interface GameOptions {
  /** The prompts per language (`data/prompts.txt`, …). */
  prompts: Partial<Record<Lang, readonly string[]>>;
  /** The secret words per language (`data/words.txt`, …). */
  words: Partial<Record<Lang, readonly string[]>>;
  lang?: Lang | undefined;
  rounds?: number | undefined;
  minPlayers?: number | undefined;
  timings?: Partial<Timings> | undefined;
  rng?: (() => number) | undefined;
  undo?: boolean | undefined;
  twists?: boolean | undefined;
  length?: number | undefined;
}

export interface ScoreLine {
  id: string;
  name: string;
  score: number;
  delta: number;
}

export interface GameEvents {
  phase: [phase: Phase];
  end: [scores: ScoreLine[]];
  settings: [settings: Settings];
}

export type Phase = "lobby" | "intro" | "play" | "reveal" | "accuse" | "unmask" | "scores" | "final";

/** Avatar colours on the TV and the phones (never the ink: drawings are black). */
export const COLORS = [
  "#e5484d",
  "#3e63dd",
  "#f5a524",
  "#12a594",
  "#8e4ec6",
  "#e54666",
  "#0090ff",
  "#ad7f58",
  "#46a758",
  "#d6409f",
  "#6e56cf",
  "#f76b15",
] as const;

/** Reactions phones can send during the reveal (the TV draws them). */
export const REACTIONS = 4;
/** A player's reactions: at most one per this many ms. */
export const REACT_EVERY = 600;

/** What the game itself names, per language. */
const SOMEONE: Record<Lang, string> = { en: "someone", de: "jemand" };

/** A round as it is played. */
interface Round {
  n: number;
  seats: Player[];
  steps: number;
  twist: Twist;
  wrecker: Player | undefined;
  words: Map<string, string>;
  chains: Chain[];
  /** The prompts each chain's author picks from. */
  choices: [string, string][];
  /** Per chain (by id): the verdict, once judged. */
  died: Map<number, number | null>;
  /** Players at a break, per id (the hunt's hint). */
  breaks: Map<string, number>;
}

export class Garble extends Emitter<GameEvents> {
  readonly party: Party;
  rounds: number;
  readonly minPlayers: number;
  timings: Timings;
  readonly #rng: () => number;
  readonly #prompts = new Map<Lang, readonly string[]>();
  readonly #words = new Map<Lang, readonly string[]>();
  /** The room's decks (`prompts:en`, `words:de`, …), kept from game to game. */
  readonly #decks = new Map<string, Deck>();
  #lang: Lang;
  #settings: Settings;
  /** Each player's avatar colour (an index of {@link COLORS}), by id. */
  readonly #colors = new Map<string, number>();
  /** Names by id, kept after a player left (chains still name them). */
  readonly #names = new Map<string, string>();
  /** Points per player id (players in the game). */
  readonly scores = new Map<string, number>();
  /** Times each player was the Wrecker this game. */
  readonly #wrecked = new Map<string, number>();
  /** The last reaction per player id (the throttle). */
  readonly #reacted = new Map<string, number>();
  #phase: Phase = "lobby";
  #running = false;
  #abort = new AbortController();
  #roundNo = 0;
  #round: Round | undefined;
  /** The step being played (0-based). */
  #k = 0;
  /** The last round's points by kind (the scores). */
  #earned = new Map<string, Earned>();

  constructor(party: Party, options: GameOptions) {
    super();
    this.party = party;
    this.rounds = options.rounds ?? 2;
    this.minPlayers = options.minPlayers ?? MIN_PLAYERS;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    this.#rng = options.rng ?? Math.random;
    this.#lang = options.lang ?? "en";
    for (const [l, list] of Object.entries(options.prompts) as [Lang, readonly string[]][]) if (list.length > 0) this.#prompts.set(l, list);
    for (const [l, list] of Object.entries(options.words) as [Lang, readonly string[]][]) if (list.length > 0) this.#words.set(l, list);
    if (!this.#prompts.has(this.#lang) || !this.#words.has(this.#lang)) throw new Error(`garble: no prompts or words in ${this.#lang}`);
    this.#settings = {
      undo: options.undo ?? false,
      twists: options.twists ?? true,
      length: LENGTHS.includes(options.length as never) ? options.length! : 6,
    };
  }

  get settings(): Settings {
    return { ...this.#settings };
  }

  get phase(): Phase {
    return this.#phase;
  }

  get running(): boolean {
    return this.#running;
  }

  get lang(): Lang {
    return this.#lang;
  }

  /** The languages there are prompts and words for. */
  get langs(): Lang[] {
    return [...this.#prompts.keys()].filter((l) => this.#words.has(l));
  }

  /** The round being played (tests: who is the Wrecker, the words). */
  get round(): Readonly<Round> | undefined {
    return this.#round;
  }

  /**
   * What the drawing a player guesses now was meant to show, and its
   * drawer's secret word (the bots' oracle in the host page, so games
   * with bots survive, drift and smuggle; never sent to a phone).
   */
  meant(id: string): { text: string; word: string | undefined } | undefined {
    const r = this.#round;
    if (!r || this.#phase !== "play" || stepKind(this.#k) !== "guess") return undefined;
    const s = r.seats.findIndex((p) => p.id === id);
    if (s < 0) return undefined;
    const c = r.chains[chainAt(s, this.#k, r.seats.length)]!;
    const drawer = c.links.at(-1)?.by;
    return { text: lastText(c), word: drawer ? r.words.get(drawer) : undefined };
  }

  colorOf(id: string): number {
    return this.#colors.get(id) ?? 0;
  }

  /** Shows the lobby and waits for the VIP to start. */
  open(): void {
    const party = this.party;
    const vipOnly = (from: { role: string; vip?: boolean }) => {
      if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can do this");
    };
    party.handle("start", (_d, from) => {
      vipOnly(from as Player);
      if (this.#running) throw new PartyError("running", "The game is on");
      const ready = party.connectedPlayers.length;
      if (ready < this.minPlayers) throw new PartyError("too-few", `Wait for ${this.minPlayers - ready} more`);
      void this.play();
      return null;
    });
    party.handle("kick", (d, from) => {
      vipOnly(from as Player);
      if (this.#running) throw new PartyError("running", "Not during a game");
      const id = typeof d === "object" && d !== null && "id" in d ? (d as { id: unknown }).id : undefined;
      const p = typeof id === "string" ? party.player(id) : undefined;
      if (!p || p === from) throw new PartyError("no-player", "No such player");
      party.kick(p);
      return null;
    });
    party.handle("settings", (d, from) => {
      vipOnly(from as Player);
      if (typeof d !== "object" || d === null || Array.isArray(d)) throw new PartyError("bad-settings", "undo, twists, length");
      const o: Partial<Settings> = {};
      for (const k of ["undo", "twists"] as const) {
        const v = (d as Record<string, Json>)[k];
        if (v === undefined) continue;
        if (typeof v !== "boolean") throw new PartyError("bad-settings", `${k}: true or false`);
        o[k] = v;
      }
      const len = (d as Record<string, Json>)["length"];
      if (len !== undefined) {
        if (!LENGTHS.includes(len as never)) throw new PartyError("bad-settings", "length: 4, 6 or 8");
        o.length = len as number;
      }
      this.configure(o);
      return null;
    });
    party.handle("react", (d, from) => {
      if (from.role !== "player") throw new PartyError("not-player", "Players only");
      const r = typeof d === "object" && d !== null && "r" in d ? (d as { r: unknown }).r : d;
      if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r >= REACTIONS) throw new PartyError("bad-reaction", "No such reaction");
      if (this.#phase !== "reveal" && this.#phase !== "unmask") return null;
      const now = party.now();
      const p = from as Player;
      if (now - (this.#reacted.get(p.id) ?? 0) < REACT_EVERY) return null;
      this.#reacted.set(p.id, now);
      const msg = { r, name: p.name, color: COLORS[this.colorOf(p.id)] };
      party.broadcast("react", msg, "screen");
      party.broadcast("react", msg, "watch");
      return null;
    });
    party.on("join", (p) => {
      this.#names.set(p.id, p.name);
      this.#colors.set(p.id, this.#freeColor());
      this.#colorsChanged();
      if (!this.#running) p.state.replace(this.#lobbyState(p));
      else p.state.replace(this.#waitState(p));
    });
    party.on("leave", (p) => {
      this.#colors.delete(p.id);
      this.#colorsChanged();
    });
    this.#lobby();
  }

  /**
   * Changes the rounds, the timers, the language or the settings before
   * a game; every phone and the TV follow.
   */
  configure(o: { rounds?: number | undefined; timings?: Partial<Timings> | undefined; lang?: Lang | undefined } & { [K in keyof Settings]?: Settings[K] | undefined }): void {
    if (this.#running) throw new PartyError("running", "Not during a game");
    if (o.lang !== undefined && !this.langs.includes(o.lang)) throw new PartyError("bad-lang", `Nothing to play in ${o.lang}`);
    if (o.rounds !== undefined) this.rounds = Math.max(1, Math.min(4, Math.round(o.rounds)));
    if (o.timings) this.timings = { ...DEFAULT_TIMINGS, ...o.timings };
    if (o.lang !== undefined) this.#lang = o.lang;
    const was = JSON.stringify(this.#settings);
    if (o.undo !== undefined) this.#settings.undo = o.undo;
    if (o.twists !== undefined) this.#settings.twists = o.twists;
    if (o.length !== undefined && LENGTHS.includes(o.length as never)) this.#settings.length = o.length;
    if (this.#phase === "lobby" || this.#phase === "final") {
      this.party.room.set({ lang: this.#lang, rounds: this.rounds, ...this.#settings });
      this.party.screen.set({ lang: this.#lang, rounds: this.rounds, ...this.#settings });
    }
    if (JSON.stringify(this.#settings) !== was) this.emit("settings", this.settings);
  }

  /** Ends the game and its timers (the party stays). */
  close(): void {
    this.#abort.abort();
  }

  // -------------------------------------------------------------------------
  // Views

  #setPhase(phase: Phase): void {
    this.#phase = phase;
    this.emit("phase", phase);
  }

  #freeColor(): number {
    const used = COLORS.map(() => 0);
    for (const p of this.party.players) {
      const c = this.#colors.get(p.id);
      if (c !== undefined) used[c]!++;
    }
    const least = Math.min(...used);
    return used.indexOf(least);
  }

  /** Everybody's colour, by id (the TV's avatars). */
  #colorMap(): Record<string, string> {
    return Object.fromEntries(this.party.players.map((p) => [p.id, COLORS[this.colorOf(p.id)]!]));
  }

  #colorsChanged(): void {
    const colors = this.#colorMap();
    this.party.room.set({ colors });
    if (this.#phase === "lobby" || this.#phase === "final") this.party.screen.set({ colors });
  }

  #name(id: string): string {
    return this.party.player(id)?.name ?? this.#names.get(id) ?? SOMEONE[this.#lang];
  }

  #who(id: string): { id: string; name: string; color: string } {
    return { id, name: this.#name(id), color: COLORS[this.colorOf(id)]! };
  }

  #rank(p: Player | undefined): { score: number; rank: number; of: number } {
    const scores = [...this.scores].filter(([id]) => this.party.player(id)).map(([, s]) => s);
    const s = p ? (this.scores.get(p.id) ?? 0) : 0;
    return { score: s, rank: 1 + scores.filter((x) => x > s).length, of: scores.length };
  }

  /** What every phone of a round carries: the word and role (the hold-to-peek tab), the score. */
  #mine(p: Player): Record<string, unknown> {
    const r = this.#round;
    const word = r?.words.get(p.id);
    return {
      color: this.colorOf(p.id),
      ...this.#rank(this.scores.has(p.id) ? p : undefined),
      ...(word ? { word, wrecker: r?.wrecker === p } : {}),
    };
  }

  #lobbyState(p: Player): Record<string, unknown> {
    return { task: this.#phase === "final" ? "final" : "lobby", color: this.colorOf(p.id), ...this.#rank(this.scores.has(p.id) ? p : undefined) };
  }

  #waitState(p: Player): Record<string, unknown> {
    return { task: "wait", note: this.#roundNo < this.rounds ? "round" : "game", color: this.colorOf(p.id) };
  }

  #room(fields: Record<string, unknown>): void {
    this.party.room.replace({ lang: this.#lang, round: this.#roundNo, rounds: this.rounds, ...this.#settings, minPlayers: this.minPlayers, colors: this.#colorMap(), ...fields });
  }

  #screen(fields: Record<string, unknown>): void {
    this.party.screen.replace({ lang: this.#lang, colors: this.#colorMap(), ...fields });
  }

  #lobby(): void {
    const party = this.party;
    this.#setPhase("lobby");
    this.#room({ phase: "lobby", maxPlayers: party.maxPlayers });
    this.#screen({ phase: "lobby", rounds: this.rounds, minPlayers: this.minPlayers, maxPlayers: party.maxPlayers, ...this.#settings });
    for (const p of party.players) p.state.replace(this.#lobbyState(p));
  }

  // -------------------------------------------------------------------------
  // A game

  /** Plays a whole game with the players who are there (and those who join). */
  async play(): Promise<ScoreLine[]> {
    const party = this.party;
    this.#running = true;
    this.#abort = new AbortController();
    party.inProgress = true;
    this.scores.clear();
    this.#wrecked.clear();
    try {
      for (let r = 1; r <= this.rounds; r++) {
        this.#roundNo = r;
        for (const p of party.players) {
          if (p.waiting) party.activate(p);
          if (!this.scores.has(p.id)) this.scores.set(p.id, 0);
        }
        const players = party.players.filter((p) => this.scores.has(p.id));
        if (players.length < 3) break;
        const before = new Map(this.scores);
        await this.#playRound(r, players);
        if (this.#abort.signal.aborted) break;
        await this.#scores(r, before);
        if (this.#abort.signal.aborted) break;
      }
      return this.#final();
    } finally {
      this.#round = undefined;
      this.#running = false;
      party.inProgress = false;
      for (const p of party.players) party.activate(p);
    }
  }

  #deck(kind: "prompts" | "words"): Deck {
    const key = `${kind}:${this.#lang}`;
    let d = this.#decks.get(key);
    if (!d) this.#decks.set(key, (d = new Deck((kind === "prompts" ? this.#prompts : this.#words).get(this.#lang)!, this.#rng)));
    return d;
  }

  async #playRound(n: number, players: Player[]): Promise<void> {
    const seats = shuffle(players, this.#rng);
    const count = seats.length;
    const steps = chainSteps(count, this.#settings.length);
    const prompts = this.#deck("prompts");
    const choices = seats.map((): [string, string] => {
      const a = prompts.draw();
      return [a, prompts.draw((c) => c !== a)];
    });
    const all = choices.flat();
    const deck = this.#deck("words");
    const words = new Map<string, string>();
    for (const p of seats) {
      const taken = [...words.values()];
      words.set(p.id, deck.draw((w) => !all.some((t) => says(t, w)) && !taken.some((x) => says(x, w) || says(w, x))));
    }
    const wreckerId = pickWrecker(
      seats.map((p) => p.id),
      this.#wrecked,
      this.#rng,
    );
    if (wreckerId) this.#wrecked.set(wreckerId, (this.#wrecked.get(wreckerId) ?? 0) + 1);
    const round: Round = {
      n,
      seats,
      steps,
      twist: twistOf(n, this.#settings.twists),
      wrecker: seats.find((p) => p.id === wreckerId),
      words,
      chains: seats.map((p, i) => ({ id: i, author: p.id, prompt: "", links: [] })),
      choices,
      died: new Map(),
      breaks: new Map(),
    };
    this.#round = round;
    await this.#intro(round);
    for (let k = 0; k < steps && !this.#abort.signal.aborted; k++) await this.#step(round, k);
    if (this.#abort.signal.aborted) return;
    await this.#reveal(round);
    if (this.#abort.signal.aborted) return;
    await this.#hunt(round);
  }

  /** The secret words and the Wrecker: every phone shows the same card, held to read. */
  async #intro(r: Round): Promise<void> {
    const party = this.party;
    this.#setPhase("intro");
    const deadline = this.#deadline(this.timings.intro);
    this.#room({ phase: "intro", steps: r.steps, twist: r.twist, deadline });
    this.#screen({ phase: "intro", round: r.n, rounds: this.rounds, steps: r.steps, twist: r.twist, players: r.seats.map((p) => this.#who(p.id)), deadline, duration: this.timings.intro });
    for (const p of r.seats) p.state.replace({ task: "secret", twist: r.twist, ...this.#mine(p) });
    for (const p of party.players) if (!r.seats.includes(p)) p.state.replace(this.#waitState(p));
    await this.#sleep(this.timings.intro);
  }

  /** One step: every seat works on one chain (draws its last text, or guesses its last drawing). */
  async #step(r: Round, k: number): Promise<void> {
    const party = this.party;
    const kind = stepKind(k);
    const count = r.seats.length;
    this.#k = k;
    this.#setPhase("play");
    const duration = k === 0 ? this.timings.firstDraw : kind === "draw" ? this.timings.draw : this.timings.guess;
    const deadline = this.#deadline(duration);
    const seatOfPlayer = new Map(r.seats.map((p, s) => [p, s]));
    const chainOf = (p: Player) => r.chains[chainAt(seatOfPlayer.get(p)!, k, count)]!;
    // Who gets this chain next (none after the last step).
    const next = (s: number) => (k + 1 < r.steps ? this.#name(r.seats[(s + 1) % count]!.id) : null);
    this.#room({ phase: "play", step: k + 1, steps: r.steps, kind, twist: r.twist, deadline });
    const seats = r.seats.map((p) => this.#who(p.id));
    this.#screen({ phase: "play", round: r.n, rounds: this.rounds, step: k + 1, steps: r.steps, kind, twist: r.twist, deadline, duration, seats, done: [] });
    r.seats.forEach((p, s) => {
      const c = chainOf(p);
      const base = { step: k + 1, steps: r.steps, deadline, done: false, next: next(s), ...this.#mine(p) };
      if (kind === "draw") {
        const prev = c.links.at(-1);
        p.state.replace({
          task: "draw",
          ...base,
          undo: this.#settings.undo,
          ...(k === 0 ? { choices: r.choices[c.id] } : { text: lastText(c), from: prev ? this.#name(prev.by) : null }),
        });
      } else {
        const prev = c.links.at(-1)!;
        p.state.replace({ task: "guess", ...base, twist: r.twist, drawing: prev.kind === "draw" ? prev.drawing : { strokes: [] }, from: this.#name(prev.by) });
      }
    });
    for (const p of party.players) if (!seatOfPlayer.has(p)) p.state.replace(this.#waitState(p));
    const answers = await party.collect<{ drawing?: Drawing; choice?: number; text?: string }>(kind, {
      from: r.seats,
      until: deadline,
      signal: this.#abort.signal,
      validate: (d) => {
        if (kind === "guess") {
          const text = cleanGuess(typeof d === "object" && d !== null && !Array.isArray(d) ? (d as { text?: unknown }).text : d);
          if (!text) throw new PartyError("empty", "Write a guess");
          return { text };
        }
        const drawing = validateDrawing(d);
        if (k > 0) return { drawing };
        const choice = (d as { choice?: unknown }).choice;
        if (choice !== 0 && choice !== 1) throw new PartyError("no-choice", "Pick a prompt");
        return { drawing, choice };
      },
      onAnswer: (p, _v, got) => {
        p.state.set({ done: true });
        party.screen.set({ done: [...got.keys()].map((x) => x.id) });
      },
    });
    if (this.#abort.signal.aborted) return;
    for (const p of r.seats) {
      const c = chainOf(p);
      const a = answers.get(p);
      if (kind === "draw") {
        if (k === 0) c.prompt = r.choices[c.id]![a?.choice ?? 0]!;
        c.links.push({ kind: "draw", by: p.id, drawing: a?.drawing ?? { strokes: [] } });
      } else {
        c.links.push({ kind: "guess", by: p.id, text: a?.text ?? "" });
      }
    }
  }

  // -------------------------------------------------------------------------
  // The reveal

  /** A chain as phones and the TV see it (names, not ids). */
  #chainView(c: Chain): Record<string, unknown> {
    return {
      id: c.id,
      author: this.#who(c.author),
      prompt: c.prompt,
      links: c.links.map((l) => (l.kind === "draw" ? { kind: "draw", by: this.#who(l.by), drawing: l.drawing } : { kind: "guess", by: this.#who(l.by), text: l.text })),
    };
  }

  /** The cards of a chain in order (the prompt, then each link) and how long the TV shows each. */
  #cardTimes(c: Chain): number[] {
    return [this.timings.showPrompt, ...c.links.map((l) => (l.kind === "draw" ? this.timings.showDrawing : this.timings.showGuess))];
  }

  async #reveal(r: Round): Promise<void> {
    const party = this.party;
    this.#setPhase("reveal");
    // A random start, then seat order: chains of neighbours rarely follow each other closely.
    const start = Math.floor(this.#rng() * r.chains.length);
    const order = r.chains.map((_, i) => r.chains[(start + i) % r.chains.length]!);
    for (let i = 0; i < order.length; i++) {
      if (this.#abort.signal.aborted) return;
      await this.#showChain(r, order[i]!, i, order.length);
    }
  }

  async #showChain(r: Round, c: Chain, index: number, of: number): Promise<void> {
    const party = this.party;
    const view = this.#chainView(c);
    const author = party.player(c.author);
    const base = { phase: "reveal", round: r.n, rounds: this.rounds, index: index + 1, of, chain: view };
    this.#room({ phase: "reveal", index: index + 1, of });
    this.#screen({ ...base, stage: "show", cursor: 0 });
    for (const p of party.players) {
      if (!this.scores.has(p.id)) p.state.replace(this.#waitState(p));
      else p.state.replace({ task: "watch", author: this.#name(c.author), mine: p.id === c.author, index: index + 1, of, ...this.#mine(p) });
    }
    const times = this.#cardTimes(c);
    for (let cursor = 0; cursor < times.length; cursor++) {
      if (cursor > 0) party.screen.set({ cursor });
      await this.#sleep(times[cursor]!);
      if (this.#abort.signal.aborted) return;
    }
    // The author judges: the first guess that no longer says the prompt.
    const g = guesses(c);
    let died: number | null;
    let judged = false;
    if (author && author.connected) {
      const deadline = this.#deadline(this.timings.judge);
      party.screen.set({ stage: "judge", deadline, duration: this.timings.judge });
      author.state.replace({ task: "judge", chain: view, deadline, done: false, ...this.#mine(author) });
      await this.#sleep(this.timings.overview);
      const got = await party.collect<number | null>("judge", {
        from: [author],
        until: deadline,
        signal: this.#abort.signal,
        validate: (d) => {
          const v = typeof d === "object" && d !== null && !Array.isArray(d) ? (d as { died?: unknown }).died : d;
          if (v === null) return null;
          if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= g.length) throw new PartyError("bad-verdict", "Pick a guess");
          return v;
        },
        onAnswer: (p) => p.state.set({ done: true }),
      });
      judged = got.has(author);
      died = judged ? got.get(author)! : autoVerdict(c);
      if (this.#abort.signal.aborted) return;
    } else {
      party.screen.set({ stage: "judge", deadline: this.#deadline(this.timings.overview), duration: this.timings.overview });
      await this.#sleep(this.timings.overview);
      died = autoVerdict(c);
    }
    r.died.set(c.id, died);
    const br = breakOf(c, died);
    if (br) for (const id of new Set([br.drawer, br.guesser])) r.breaks.set(id, (r.breaks.get(id) ?? 0) + 1);
    const found = smuggles(c, r.words);
    party.screen.set({
      stage: "verdict",
      verdict: {
        died,
        judged,
        break: br ? { drawer: this.#who(br.drawer), guesser: this.#who(br.guesser), at: br.at } : null,
        smuggles: found.map((s) => {
          const l = c.links[s.at]!;
          return { by: this.#who(s.by), word: s.word, at: s.at, marks: l.kind === "guess" ? marks(l.text, s.word) : [] };
        }),
      },
    });
    if (author) author.state.replace({ task: "watch", author: this.#name(c.author), mine: true, index: index + 1, of, ...this.#mine(author) });
    const alive = died === null ? g.length : died;
    await this.#sleep(this.timings.verdictBase + this.timings.verdictStep * (alive + 1) + this.timings.verdictSmuggle * found.length);
  }

  // -------------------------------------------------------------------------
  // The hunt

  async #hunt(r: Round): Promise<void> {
    const party = this.party;
    this.#setPhase("accuse");
    const deadline = this.#deadline(this.timings.accuse);
    const suspects = r.seats.map((p) => ({ ...this.#who(p.id), breaks: r.breaks.get(p.id) ?? 0 }));
    const voters = r.seats.filter((p) => party.players.includes(p));
    this.#room({ phase: "accuse", deadline });
    this.#screen({ phase: "accuse", round: r.n, rounds: this.rounds, deadline, duration: this.timings.accuse, suspects, done: [] });
    for (const p of voters) p.state.replace({ task: "accuse", suspects: suspects.filter((s) => s.id !== p.id), deadline, done: false, ...this.#mine(p) });
    const votes = await party.collect<string>("accuse", {
      from: voters,
      until: deadline,
      signal: this.#abort.signal,
      validate: (d, p) => {
        const id = typeof d === "object" && d !== null && !Array.isArray(d) ? (d as { suspect?: unknown }).suspect : d;
        if (typeof id !== "string" || id === p.id || !r.seats.some((s) => s.id === id)) throw new PartyError("bad-suspect", "Pick someone else");
        return id;
      },
      onAnswer: (p, id, got) => {
        p.state.set({ done: true, choice: id });
        party.screen.set({ done: [...got.keys()].map((x) => x.id) });
      },
    });
    if (this.#abort.signal.aborted) return;
    const accusations = new Map([...votes].map(([p, id]) => [p.id, id]));
    const result = scoreRound(
      r.chains.map((c) => ({ chain: c, died: r.died.get(c.id) ?? null })),
      r.words,
      r.wrecker?.id,
      accusations,
    );
    for (const [id, e] of result.earned) if (this.scores.has(id)) this.scores.set(id, (this.scores.get(id) ?? 0) + earnedTotal(e));
    this.#earned = result.earned;
    // Unmasking: the votes, then the Wrecker.
    this.#setPhase("unmask");
    const w = r.wrecker;
    const wrecks = result.chains.filter((c) => c.wrecked).length;
    this.#room({ phase: "unmask" });
    this.#screen({
      phase: "unmask",
      round: r.n,
      rounds: this.rounds,
      suspects: suspects.map((s) => ({ ...s, votes: result.hunt.votes.get(s.id) ?? 0 })),
      wrecker: w ? this.#who(w.id) : null,
      caught: result.hunt.caught,
      wrecks,
    });
    for (const p of party.players) {
      if (!this.scores.has(p.id)) continue;
      const mine = accusations.get(p.id);
      p.state.replace({
        task: "unmask",
        wreckerName: w ? this.#name(w.id) : null,
        you: w === p,
        caught: result.hunt.caught,
        right: !!w && mine === w.id,
        ...this.#mine(p),
      });
    }
    await this.#sleep(this.timings.unmask);
  }

  #table(before?: ReadonlyMap<string, number>): ScoreLine[] {
    return this.party.players
      .filter((p) => this.scores.has(p.id))
      .map((p) => {
        const s = this.scores.get(p.id) ?? 0;
        return { id: p.id, name: p.name, score: s, delta: s - (before?.get(p.id) ?? s) };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  async #scores(round: number, before: ReadonlyMap<string, number>): Promise<void> {
    const party = this.party;
    const r = this.#round;
    this.#setPhase("scores");
    const table = this.#table(before);
    const smuggled = new Map<string, number>();
    if (r) for (const c of r.chains) for (const s of smuggles(c, r.words)) smuggled.set(s.by, (smuggled.get(s.by) ?? 0) + 1);
    const lines = table.map((l) => ({
      ...l,
      earned: this.#earned.get(l.id) ?? null,
      word: r?.words.get(l.id) ?? null,
      smuggled: smuggled.get(l.id) ?? 0,
      wrecker: r?.wrecker?.id === l.id,
    }));
    this.#room({ phase: "scores" });
    this.#screen({ phase: "scores", round, rounds: this.rounds, lines, last: round >= this.rounds });
    for (const p of party.players) {
      if (!this.scores.has(p.id)) {
        p.state.replace(this.#waitState(p));
        continue;
      }
      const line = lines.find((l) => l.id === p.id);
      p.state.replace({ task: "scores", earned: line?.earned ?? null, delta: line?.delta ?? 0, smuggled: line?.smuggled ?? 0, ...this.#mine(p) });
    }
    await this.#sleep(this.timings.scores);
  }

  #final(): ScoreLine[] {
    const party = this.party;
    this.#round = undefined;
    this.#setPhase("final");
    const table = this.#table();
    this.#room({ phase: "final", maxPlayers: party.maxPlayers });
    this.#screen({ phase: "final", lines: table, rounds: this.rounds, ...this.#settings });
    for (const p of party.players) p.state.replace({ task: "final", color: this.colorOf(p.id), ...this.#rank(this.scores.has(p.id) ? p : undefined) });
    this.emit("end", table);
    return table;
  }

  // -------------------------------------------------------------------------

  #deadline(ms: number): number {
    return this.party.now() + ms;
  }

  #sleep(ms: number): Promise<void> {
    const signal = this.#abort.signal;
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
}
