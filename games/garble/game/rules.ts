/**
 * Garble's rules, without a party: drawings and guesses as they arrive
 * from phones, the seating (who works on which chain at which step),
 * the decks of prompts and secret words, the word matcher (smuggled
 * words, the fallback verdict) and the points. Pure functions with
 * known-answer tests (test/rules.test.ts). The design:
 * docs/garble-design.md.
 *
 * A round: every player starts a chain with a prompt they draw; the
 * chain then passes seat to seat, guess, draw, guess, …, always ending
 * with a guess. Step `k` of chain `c` is done by seat `(c + k) % n`, so
 * every step every player works on exactly one chain, and a chain never
 * visits a player twice (`steps <= n`).
 */

import { cleanText, PartyError } from "@tvpipe/party";

// ---------------------------------------------------------------------------
// Drawings: black ink only.

/** Drawings are on a GRID × GRID square. */
export const GRID = 1000;
/** The pens' widths (fine, medium, thick) on the grid. */
export const WIDTHS = [7, 16, 38] as const;
export const MAX_WIDTH = 80;
export const MAX_STROKES = 400;
export const MAX_POINTS = 16_000;
/** The longest guess (characters). */
export const MAX_GUESS = 40;

/** A drawing: strokes `[width, x0, y0, x1, y1, …]` on the grid (one point: a dot). */
export interface Drawing {
  strokes: number[][];
}

function bad(why: string): PartyError {
  return new PartyError("bad-drawing", `Bad drawing: ${why}`);
}

/** Checks a drawing from a phone; throws {@link PartyError} `bad-drawing`. */
export function validateDrawing(data: unknown): Drawing {
  if (typeof data !== "object" || data === null || !Array.isArray((data as Drawing).strokes)) throw bad("no strokes");
  const strokes = (data as Drawing).strokes;
  if (strokes.length > MAX_STROKES) throw bad("too many strokes");
  let points = 0;
  const out: number[][] = [];
  for (const s of strokes) {
    if (!Array.isArray(s) || s.length < 3 || s.length % 2 === 0) throw bad("a stroke is [width, x, y, …]");
    for (const v of s) if (typeof v !== "number" || !Number.isInteger(v)) throw bad("whole numbers only");
    const [w, ...xy] = s as number[];
    if (w! < 1 || w! > MAX_WIDTH) throw bad("width");
    for (const v of xy) if (v < 0 || v > GRID) throw bad("off the paper");
    points += xy.length / 2;
    if (points > MAX_POINTS) throw bad("too many points");
    out.push([w!, ...xy]);
  }
  return { strokes: out };
}

/** A guess as typed: cleaned, at most {@link MAX_GUESS} characters (may be empty). */
export function cleanGuess(text: unknown): string {
  return cleanText(text, MAX_GUESS);
}

// ---------------------------------------------------------------------------
// Languages

export const LANGS = ["en", "de"] as const;
export type Lang = (typeof LANGS)[number];

/** A language tag (`de-AT`, `en`) to one of ours (default English). */
export function pickLang(tag: unknown): Lang {
  if (typeof tag !== "string") return "en";
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return (LANGS as readonly string[]).includes(base ?? "") ? (base as Lang) : "en";
}

// ---------------------------------------------------------------------------
// Words: folding, tokens, the matcher.

/** Lowercase, `ß` → `ss`, accents and umlauts folded, anything else than letters and digits a space. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokens(text: string): string[] {
  const f = fold(text);
  return f ? f.split(" ") : [];
}

/** Endings taken off before comparing (plurals and inflections, English and German), longest first. */
const ENDINGS = ["es", "en", "er", "e", "s", "n"];

/** A word without one plural or inflection ending, when at least three letters stay. */
export function stem(word: string): string {
  for (const e of ENDINGS) if (word.length - e.length >= 3 && word.endsWith(e)) return word.slice(0, -e.length);
  return word;
}

/**
 * Whether `text` says `word`: the same word (folded), the same stem
 * (`pirates`, `Piraten` for `pirate`), or, for stems of four letters and
 * more, inside a longer word (`Piratenoma`, `rocketship`).
 */
export function says(text: string, word: string): boolean {
  const w = fold(word).replace(/ /g, "");
  if (!w) return false;
  const sw = stem(w);
  for (const t of tokens(text)) {
    if (t === w || stem(t) === sw) return true;
    if (sw.length >= 4 && t.includes(sw)) return true;
  }
  return false;
}

/**
 * Where a text says a word: the `[start, end)` ranges (UTF-16) of its
 * words that do (the TV's highlighter on a smuggled word).
 */
export function marks(text: string, word: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) if (says(m[0], word)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Words that carry no meaning on their own (left out when comparing a guess to its prompt). */
const STOP = new Set(
  (
    "a an the of in on at to with and or for from by into onto over under is are his her its their my your " +
    "ein eine einer einem einen eines der die das den dem des mit und oder auf im am in an zu zum zur vom von bei beim fur uber unter ist sind sein seine ihr ihre"
  ).split(" "),
);

/** The words of a text that mean something (folded, stop words out). */
export function content(text: string): string[] {
  return tokens(text).filter((t) => !STOP.has(t) && t.length >= 2);
}

/**
 * Whether a guess still says what the prompt said, as the machine sees
 * it (the fallback when the chain's author does not judge): a meaningful
 * word in common (same stem, or one inside the other from four letters).
 */
export function alike(prompt: string, guess: string): boolean {
  const g = content(guess);
  for (const p of content(prompt)) {
    const sp = stem(p);
    for (const t of g) {
      const st = stem(t);
      if (st === sp) return true;
      if (sp.length >= 4 && st.includes(sp)) return true;
      if (st.length >= 4 && sp.includes(st)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Randomness and decks

/** A seeded generator (mulberry32) for tests and replays. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A data file: one entry per line, `#` comments and blank lines left out, duplicates once. */
export function parseList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = cleanText(raw, 60);
    if (!line || line.startsWith("#")) continue;
    const k = fold(line);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(line);
  }
  return out;
}

/**
 * Cards dealt without repeats until all were dealt (then reshuffled),
 * kept from game to game by the room.
 */
export class Deck {
  readonly #all: readonly string[];
  readonly #rng: () => number;
  #pile: string[] = [];

  constructor(cards: readonly string[], rng: () => number) {
    if (cards.length === 0) throw new Error("an empty deck");
    this.#all = cards;
    this.#rng = rng;
  }

  get size(): number {
    return this.#all.length;
  }

  /** The next card that `ok` accepts (any, when none in a whole pile does). */
  draw(ok: (card: string) => boolean = () => true): string {
    for (let tries = 0; tries < 2; tries++) {
      if (this.#pile.length === 0) this.#pile = shuffle(this.#all, this.#rng);
      const i = this.#pile.findIndex(ok);
      if (i >= 0) return this.#pile.splice(i, 1)[0]!;
      if (tries === 0) this.#pile = [];
    }
    if (this.#pile.length === 0) this.#pile = shuffle(this.#all, this.#rng);
    return this.#pile.pop()!;
  }
}

// ---------------------------------------------------------------------------
// The seating

/** Chain lengths the room can pick: short, normal, long (steps, always even). */
export const LENGTHS = [4, 6, 8] as const;
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 12;

/**
 * Steps per chain: the room's length, at most the players (rounded down
 * to even: a chain ends with a guess and visits nobody twice), at least 2.
 */
export function chainSteps(players: number, length: number): number {
  const n = Math.min(players, length);
  return Math.max(2, n - (n % 2));
}

/** What step `k` is: chains start with a drawing, then guesses and drawings take turns. */
export function stepKind(k: number): "draw" | "guess" {
  return k % 2 === 0 ? "draw" : "guess";
}

/** The seat that does step `k` of chain `c` (of `n` seats). */
export function seatOf(c: number, k: number, n: number): number {
  return (((c + k) % n) + n) % n;
}

/** The chain seat `s` works on at step `k`. */
export function chainAt(s: number, k: number, n: number): number {
  return (((s - k) % n) + n) % n;
}

/**
 * The Wrecker of a round: one of those who were it least often this
 * game (`times`), at random.
 */
export function pickWrecker(ids: readonly string[], times: ReadonlyMap<string, number>, rng: () => number): string | undefined {
  if (ids.length === 0) return undefined;
  const least = Math.min(...ids.map((id) => times.get(id) ?? 0));
  const pool = ids.filter((id) => (times.get(id) ?? 0) === least);
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * The twist of a round's guesses (progressive disclosure): `clear` (the
 * drawing draws itself, then stays), `glimpse` (it draws itself, then
 * fades: guess from memory), `peephole` (only what is under your finger).
 */
export const TWISTS = ["clear", "glimpse", "peephole"] as const;
export type Twist = (typeof TWISTS)[number];

export function twistOf(round: number, on: boolean): Twist {
  return on ? TWISTS[(round - 1) % TWISTS.length]! : "clear";
}

// ---------------------------------------------------------------------------
// A chain and its verdict

/** One step of a chain: a drawing or a guess, and who did it. */
export type Link = { kind: "draw"; by: string; drawing: Drawing } | { kind: "guess"; by: string; text: string };

export interface Chain {
  /** The seat that started it (the chain's index). */
  id: number;
  /** Who started it: drew the prompt, and judges it. */
  author: string;
  prompt: string;
  links: Link[];
}

/** The guesses of a chain, as `[link index, text]`. */
export function guesses(chain: Chain): { at: number; by: string; text: string }[] {
  const out: { at: number; by: string; text: string }[] = [];
  chain.links.forEach((l, at) => {
    if (l.kind === "guess") out.push({ at, by: l.by, text: l.text });
  });
  return out;
}

/**
 * What the next drawer reads: the latest text of the chain that is not
 * empty (a skipped guess passes the text before it on).
 */
export function lastText(chain: Chain): string {
  for (let i = chain.links.length - 1; i >= 0; i--) {
    const l = chain.links[i]!;
    if (l.kind === "guess" && l.text) return l.text;
  }
  return chain.prompt;
}

/**
 * The machine's verdict (when the author does not judge): the first
 * guess, counted from 0, that no longer says the prompt, or null when
 * every guess does.
 */
export function autoVerdict(chain: Chain): number | null {
  const g = guesses(chain);
  for (let i = 0; i < g.length; i++) if (!alike(chain.prompt, g[i]!.text)) return i;
  return null;
}

// ---------------------------------------------------------------------------
// Points

export const POINTS = {
  /** Each drawing → guess that still says it: to the drawer and the guesser each. */
  link: 100,
  /** Your secret word in a later guess of a chain you worked on (once per chain). */
  smuggle: 300,
  /** The Wrecker: a chain that died at their drawing or guess. */
  wreck: 300,
  /** Each player who named the Wrecker. */
  spot: 200,
  /** The Wrecker, when the room did not catch them. */
  escape: 400,
} as const;

/** A smuggled word: whose, which, in which guess (link index). */
export interface Smuggle {
  by: string;
  word: string;
  at: number;
}

/**
 * The smuggled words of a chain: a player's word counts where it first
 * shows up in a guess written by someone else, after the player's own
 * step, and not already in the prompt (writing your own word into your
 * guess is not smuggling: it counts for nobody).
 */
export function smuggles(chain: Chain, words: ReadonlyMap<string, string>): Smuggle[] {
  const out: Smuggle[] = [];
  for (const [id, word] of words) {
    const mine = chain.links.findIndex((l) => l.by === id);
    if (mine < 0 || says(chain.prompt, word)) continue;
    const first = chain.links.findIndex((l) => l.kind === "guess" && says(l.text, word));
    if (first < 0 || first <= mine) continue;
    if (chain.links[first]!.by === id) continue;
    out.push({ by: id, word, at: first });
  }
  return out.sort((a, b) => a.at - b.at || a.by.localeCompare(b.by));
}

/**
 * Where a chain died, as the drawing and the guess around it: `died` is
 * the first dead guess (counted from 0), null when the chain survived.
 */
export function breakOf(chain: Chain, died: number | null): { drawer: string; guesser: string; at: number } | null {
  if (died === null) return null;
  const g = guesses(chain)[died];
  if (!g) return null;
  const drawing = chain.links[g.at - 1];
  return { drawer: drawing?.by ?? chain.author, guesser: g.by, at: g.at };
}

/** One player's points of a round, by kind. */
export interface Earned {
  links: number;
  smuggles: number;
  wrecks: number;
  spot: number;
  escape: number;
}

export function earnedTotal(e: Earned): number {
  return e.links + e.smuggles + e.wrecks + e.spot + e.escape;
}

/** A chain's outcome (what the TV shows after the verdict). */
export interface ChainScore {
  /** Guesses that still said it. */
  alive: number;
  died: number | null;
  break: { drawer: string; guesser: string; at: number } | null;
  smuggles: Smuggle[];
  /** The Wrecker was at the break. */
  wrecked: boolean;
}

/** The Wrecker hunt: votes per suspect, whether the Wrecker had the most (alone). */
export interface Hunt {
  votes: Map<string, number>;
  caught: boolean;
}

export function hunt(wrecker: string | undefined, accusations: ReadonlyMap<string, string>): Hunt {
  const votes = new Map<string, number>();
  for (const [voter, suspect] of accusations) if (voter !== suspect) votes.set(suspect, (votes.get(suspect) ?? 0) + 1);
  const top = Math.max(0, ...votes.values());
  const leaders = [...votes].filter(([, n]) => n === top && top > 0).map(([id]) => id);
  return { votes, caught: wrecker !== undefined && leaders.length === 1 && leaders[0] === wrecker };
}

/**
 * The round's points: links that survived (drawer and guesser), smuggled
 * words, chains the Wrecker broke (void when caught), the hunt.
 */
export function scoreRound(
  chains: readonly { chain: Chain; died: number | null }[],
  words: ReadonlyMap<string, string>,
  wrecker: string | undefined,
  accusations: ReadonlyMap<string, string>,
): { earned: Map<string, Earned>; chains: ChainScore[]; hunt: Hunt } {
  const earned = new Map<string, Earned>();
  const get = (id: string) => {
    let e = earned.get(id);
    if (!e) earned.set(id, (e = { links: 0, smuggles: 0, wrecks: 0, spot: 0, escape: 0 }));
    return e;
  };
  for (const id of words.keys()) get(id);
  if (wrecker) get(wrecker);
  const out: ChainScore[] = [];
  for (const { chain, died } of chains) {
    const g = guesses(chain);
    const alive = died === null ? g.length : Math.max(0, Math.min(died, g.length));
    for (let i = 0; i < alive; i++) {
      const at = g[i]!.at;
      const drawer = chain.links[at - 1]?.by;
      if (drawer) get(drawer).links += POINTS.link;
      get(g[i]!.by).links += POINTS.link;
    }
    const s = smuggles(chain, words);
    for (const x of s) get(x.by).smuggles += POINTS.smuggle;
    const br = breakOf(chain, died);
    const wrecked = !!wrecker && !!br && (br.drawer === wrecker || br.guesser === wrecker);
    if (wrecked) get(wrecker!).wrecks += POINTS.wreck;
    out.push({ alive, died: died === null ? null : alive, break: br, smuggles: s, wrecked });
  }
  const h = hunt(wrecker, accusations);
  if (wrecker) {
    for (const [voter, suspect] of accusations) if (suspect === wrecker && voter !== wrecker) get(voter).spot += POINTS.spot;
    if (h.caught) get(wrecker).wrecks = 0;
    else get(wrecker).escape += POINTS.escape;
  }
  return { earned, chains: out, hunt: h };
}
