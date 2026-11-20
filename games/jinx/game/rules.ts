/**
 * Jinx's rules, pure (docs/jinx-design.md): the pot and the room's bank
 * (§4), dealing the secret words by difficulty (§5.1), the guesser order
 * (§2), the room's title, the awards and the word web (§6). No party, no
 * timers: game.ts drives them.
 */

import { matcher, type Matcher } from "./lang.ts";
import type { Clue, MatchOptions, WordEntry } from "./match.ts";
import type { Award, Goals, Part, RoomTitle, Web } from "./views.ts";

// ---------------------------------------------------------------------------
// The pot and the bank (§4)
// ---------------------------------------------------------------------------

export const POT = {
  start: 10,
  /** Lost per jinxed clue, at the jinx check. */
  jinx: 1,
  /** Lost on top per bold clue that jinxed. */
  boldJinx: 2,
  /** Lost per turned card after the first. */
  turn: 2,
  /** Won per bold card turned. */
  bold: 2,
  /** The pot never goes below this: a right guess always pays. */
  min: 2,
} as const;

/** What a wrong guess takes out of the bank. */
export const WRONG = 2;

/** What the pot has seen: jinxed and turned cards, and how many of each were bold. */
export interface PotCount {
  jinxed: number;
  boldJinxed?: number;
  turned: number;
  boldTurned?: number;
}

/** The pot after the jinx check and the turns so far. */
export function pot(c: PotCount): number {
  const raw = POT.start - POT.jinx * c.jinxed - POT.boldJinx * (c.boldJinxed ?? 0) - POT.turn * Math.max(0, c.turned - 1) + POT.bold * (c.boldTurned ?? 0);
  return Math.max(POT.min, raw);
}

export type Result = "right" | "wrong" | "pass" | "lost";

/** What a round does to the bank (`bank` before it): the pot when right, −2 when wrong (never below 0), else 0. */
export function banked(result: Result, potNow: number, bank: number): number {
  if (result === "right") return potNow;
  if (result === "wrong") return 0 - Math.min(WRONG, Math.max(0, bank));
  return 0;
}

/** A card as the result line sees it. */
export interface PartCard {
  author: string;
  bold: boolean;
  fate: "alive" | "jinxed";
  /** Turned in the reveal. */
  turned: boolean;
}

/** What `id`'s cards did for the room this round (views.ts `Part`), one per card that did something. */
export function parts(id: string, result: Result, cards: readonly PartCard[]): Part[] {
  const out: Part[] = [];
  for (const c of cards) {
    if (c.author !== id) continue;
    if (c.fate === "jinxed") out.push(c.bold ? "bold-jinxed" : "jinxed");
    else if (c.turned && result === "right") out.push(c.bold ? "bold" : "turned");
  }
  return out;
}

/**
 * The room titles' marks for a game of `rounds` rounds: 2, 4, 6 and 8
 * chips a round (a word found at once with nothing jinxed is 10).
 */
export function goals(rounds: number): Goals {
  const n = Math.max(1, rounds);
  return { "mixed signals": 2 * n, "in sync": 4 * n, "mind readers": 6 * n, telepaths: 8 * n };
}

const TITLES: readonly Exclude<RoomTitle, "total jinx">[] = ["telepaths", "mind readers", "in sync", "mixed signals"];

/** The room's title for `chips` in a game of `rounds` rounds. */
export function roomTitle(chips: number, rounds: number): RoomTitle {
  const g = goals(rounds);
  return TITLES.find((t) => chips >= g[t]) ?? "total jinx";
}

/** The next title to reach and its mark, or undefined at the top. */
export function nextGoal(chips: number, rounds: number): { title: RoomTitle; chips: number } | undefined {
  const g = goals(rounds);
  const t = [...TITLES].reverse().find((x) => chips < g[x]);
  return t ? { title: t, chips: g[t] } : undefined;
}

// ---------------------------------------------------------------------------
// Dealing (§5.1)
// ---------------------------------------------------------------------------

export type Difficulty = "easy" | "normal" | "hard";
export const DIFFICULTIES: readonly Difficulty[] = ["easy", "normal", "hard"];

/** The chance of each word difficulty per setting. */
export const MIX: Record<Difficulty, Record<string, number>> = {
  easy: { easy: 1 },
  // Easy and medium about 2:3, one hard word in ten.
  normal: { easy: 0.36, medium: 0.54, hard: 0.1 },
  hard: { medium: 0.5, hard: 0.5 },
};

/** The clue form of a word (for matching, by the word's language), or undefined if it does not clean. */
export function wordClue(word: string, m: Matcher = matcher("en")): Clue | undefined {
  const c = m.clean(word);
  return c.ok ? c.clue : undefined;
}

/**
 * Two secret words too close for one game: one is an invalid clue for the
 * other (fire and firework, cat and cats, a banned translation), by the
 * words' language.
 */
export function related(a: WordEntry, b: WordEntry, opt: MatchOptions = {}, m: Matcher = matcher("en")): boolean {
  const ca = wordClue(a.word, m);
  const cb = wordClue(b.word, m);
  if (!ca || !cb) return a.word === b.word;
  return m.invalidClue(ca, cb, opt, b.banned) !== null || m.invalidClue(cb, ca, opt, a.banned) !== null;
}

/**
 * The room's words in one language: deals no word twice until it dealt
 * them all (per difficulty, across games: `used` comes from and goes to
 * the host page's `localStorage`), never two related words in one game
 * (by the language's matcher, `m`).
 */
export class WordDeck {
  readonly words: readonly WordEntry[];
  readonly #rng: () => number;
  readonly #opt: MatchOptions;
  readonly #m: Matcher;
  readonly #used: Set<string>;

  constructor(words: readonly WordEntry[], rng: () => number = Math.random, used: Iterable<string> = [], opt: MatchOptions = {}, m: Matcher = matcher("en")) {
    if (words.length === 0) throw new Error("jinx: no words");
    this.words = words;
    this.#rng = rng;
    this.#opt = opt;
    this.#m = m;
    const known = new Set(words.map((w) => w.word));
    this.#used = new Set([...used].filter((w) => known.has(w)));
  }

  /** Words dealt in this pass (to keep). */
  get used(): string[] {
    return [...this.#used];
  }

  /** The next word for a game that dealt `game` so far. */
  deal(difficulty: Difficulty, game: readonly WordEntry[] = []): WordEntry {
    const mix = MIX[difficulty];
    const tiers = Object.keys(mix).filter((t) => this.words.some((w) => w.difficulty === t));
    let tier = tiers[tiers.length - 1];
    let r = this.#rng() * tiers.reduce((s, t) => s + mix[t]!, 0);
    for (const t of tiers) {
      r -= mix[t]!;
      if (r < 0) {
        tier = t;
        break;
      }
    }
    const inGame = new Set(game.map((w) => w.word));
    const fits = (w: WordEntry) => !inGame.has(w.word) && !game.some((g) => related(w, g, this.#opt, this.#m));
    // This tier's unused words, else (a new pass of the tier) its used ones,
    // else any tier of the setting, else any word.
    const pools: (readonly WordEntry[])[] = [];
    const ofTier = tier !== undefined ? this.words.filter((w) => w.difficulty === tier) : [];
    const ofMix = this.words.filter((w) => tiers.includes(w.difficulty));
    pools.push(ofTier.filter((w) => !this.#used.has(w.word)), ofTier, ofMix.filter((w) => !this.#used.has(w.word)), ofMix, this.words);
    for (const pool of pools) {
      // Random candidates first; the relation check is the expensive part.
      const order = shuffle(pool, this.#rng);
      const pick = order.find(fits);
      if (!pick) continue;
      if (pool === ofTier && this.#used.has(pick.word)) for (const w of ofTier) this.#used.delete(w.word);
      if (pool === ofMix && this.#used.has(pick.word)) for (const w of ofMix) this.#used.delete(w.word);
      this.#used.add(pick.word);
      return pick;
    }
    throw new Error("jinx: no word left to deal");
  }
}

// ---------------------------------------------------------------------------
// Guesser order (§2)
// ---------------------------------------------------------------------------

export type RoundsSetting = "auto" | 1 | 2;

/** How often each player guesses: twice with 3–5 players, once with 6–8 (`auto`). */
export function guessesEach(setting: RoundsSetting, players: number): 1 | 2 {
  if (setting === 1 || setting === 2) return setting;
  return players <= 5 ? 2 : 1;
}

/** A turn in the guesser queue: who, and in which pass of the order. */
export interface Turn {
  id: string;
  pass: number;
}

/** The game's guessers: the join order rotated by `game` (0, 1, …), `times` passes. */
export function guesserOrder(ids: readonly string[], game: number, times: number): Turn[] {
  const n = ids.length;
  if (n === 0) return [];
  const k = ((game % n) + n) % n;
  const rotated = [...ids.slice(k), ...ids.slice(0, k)];
  const out: Turn[] = [];
  for (let pass = 1; pass <= times; pass++) for (const id of rotated) out.push({ id, pass });
  return out;
}

/**
 * A late joiner's turns in the queue of turns still to play: one per
 * pass, each at the end of its pass (never first, so they give clues once
 * before guessing, when there is a turn to go before).
 */
export function addLate(queue: readonly Turn[], id: string, times: number): Turn[] {
  const out = [...queue];
  for (let pass = 1; pass <= times; pass++) {
    let at = 0;
    for (let i = 0; i < out.length; i++) if (out[i]!.pass <= pass) at = i + 1;
    out.splice(Math.max(at, Math.min(1, out.length)), 0, { id, pass });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The end (§4, §6)
// ---------------------------------------------------------------------------

/** What a player did this game (for the awards and the best clues). */
export interface PlayerStats {
  id: string;
  /** Their clues the guesser picked as best clue. */
  bestClues: number;
  /** Their clues jinxed. */
  jinxed: number;
  /** Their clues that survived and were turned before a right guess. */
  turnedRight: number;
}

/** Awards need at least this count. */
export const AWARD_MIN = 2;

/**
 * The awards: mind meld (the pair that jinxed together most often) and
 * telepath (most clues turned before a right guess); each only with a
 * count of at least 2, ties to the first in `stats`' order. `pairs`:
 * jinxes per pair of ids, keyed `a|b`. Nobody is singled out for losing
 * chips: the room plays as one.
 */
export function awards(stats: readonly PlayerStats[], pairs: ReadonlyMap<string, number>): Award[] {
  const out: Award[] = [];
  const order = new Map(stats.map((s, i) => [s.id, i]));
  let meld: { ids: string[]; count: number } | undefined;
  for (const [key, count] of pairs) {
    const ids = key.split("|");
    if (ids.length !== 2 || !ids.every((id) => order.has(id))) continue;
    ids.sort((a, b) => order.get(a)! - order.get(b)!);
    const pos = (x: string[]) => order.get(x[0]!)! * 1000 + order.get(x[1]!)!;
    if (!meld || count > meld.count || (count === meld.count && pos(ids) < pos(meld.ids))) meld = { ids, count };
  }
  if (meld && meld.count >= AWARD_MIN) out.push({ kind: "mind meld", ids: meld.ids, count: meld.count });
  const top = (key: (s: PlayerStats) => number) => stats.reduce<PlayerStats | undefined>((b, s) => (!b || key(s) > key(b) ? s : b), undefined);
  const tele = top((s) => s.turnedRight);
  if (tele && tele.turnedRight >= AWARD_MIN) out.push({ kind: "telepath", ids: [tele.id], count: tele.turnedRight });
  return out;
}

/** The key of a pair of ids (order-free). */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** A round as the web sees it. */
export interface WebRound {
  word: string;
  found: boolean;
  /** The clues (as shown, and cleaned keys). */
  clues: { display: string; key: string }[];
}

/**
 * The word web: every word with its clues (one per cleaned form), and the
 * clues the room used for more than one word (by cleaned form), linked.
 */
export function web(rounds: readonly WebRound[]): Web {
  const words: Web["words"] = [];
  const byKey = new Map<string, { clue: string; words: number[] }>();
  rounds.forEach((r, i) => {
    const seen = new Set<string>();
    const clues: string[] = [];
    for (const c of r.clues) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      clues.push(c.display);
      const l = byKey.get(c.key);
      if (l) l.words.push(i);
      else byKey.set(c.key, { clue: c.display, words: [i] });
    }
    words.push({ word: r.word, found: r.found, clues });
  });
  return { words, links: [...byKey.values()].filter((l) => l.words.length > 1) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

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

/** A face from the phone: a preset 0–7, or strokes on the 1000 grid (≤ 40 strokes, ≤ 2000 points). */
export const FACE = { presets: 8, strokes: 40, points: 2000, grid: 1000 } as const;

export type FaceData = { preset: number } | { strokes: number[][] };

/** Checks and normalises a face; null when it is not one. */
export function validateFace(data: unknown): FaceData | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if ("preset" in d) {
    const p = d["preset"];
    return typeof p === "number" && Number.isInteger(p) && p >= 0 && p < FACE.presets ? { preset: p } : null;
  }
  const s = d["strokes"];
  if (!Array.isArray(s) || s.length > FACE.strokes) return null;
  let points = 0;
  const strokes: number[][] = [];
  for (const stroke of s) {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length % 2 !== 0) return null;
    points += stroke.length / 2;
    if (points > FACE.points) return null;
    const out: number[] = [];
    for (const v of stroke) {
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      out.push(Math.max(0, Math.min(FACE.grid, Math.round(v))));
    }
    strokes.push(out);
  }
  return { strokes };
}
