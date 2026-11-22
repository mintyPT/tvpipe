/**
 * Crosstalk's rules, without a party (docs/crosstalk-design.md): the
 * teams and the colours, the board of 25 words and how it is dealt (its
 * categories tangled, so the teams' themes run into each other), the
 * check that a clue says no face-down word (Jinx's matchers, `lang.ts`),
 * how a locked card ends a team's round, who wins, the pins' majority,
 * the pad's lines. Pure functions with known-answer tests
 * (test/rules.test.ts).
 */

import { cleanText, stripEmoji } from "@tvpipe/party";

import { LANGS, matcher, pickLang, type Lang, type Matcher } from "./lang.ts";
import type { Clue, MatchOptions, Reason, WordEntry } from "./match.ts";

export { LANGS, matcher, pickLang, type Lang, type Matcher, type Clue, type MatchOptions, type Reason, type WordEntry };

// ---------------------------------------------------------------------------
// Teams and colours

export type Team = "red" | "blue";
export const TEAMS: readonly Team[] = ["red", "blue"];
/** A card's colour: a team's, neutral, or the assassin. */
export type Color = Team | "neutral" | "assassin";

export function otherTeam(t: Team): Team {
  return t === "red" ? "blue" : "red";
}

export function isTeam(x: unknown): x is Team {
  return x === "red" || x === "blue";
}

/** The board: 25 cards, 8 of each team, 8 neutral, 1 assassin. Neither team starts, so neither gets a ninth. */
export const BOARD = { size: 25, team: 8, neutral: 8, assassin: 1 } as const;

/** A game needs four players: a spymaster and an operative on each team. */
export const MIN_PLAYERS = 4;
/** A team needs a spymaster and an operative. */
export const MIN_TEAM = 2;

/** A clue's number. */
export const MIN_NUMBER = 1;
export const MAX_NUMBER = 9;

// ---------------------------------------------------------------------------
// Random

/** A copy of `items` in random order (Fisher–Yates). */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** A seeded random number generator (mulberry32), for tests and fixed boards. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The board

export type Difficulty = "easy" | "normal" | "hard";
export const DIFFICULTIES: readonly Difficulty[] = ["easy", "normal", "hard"];
export type BoardMode = "tangled" | "mixed";
export const BOARD_MODES: readonly BoardMode[] = ["tangled", "mixed"];

/** How likely a word of each difficulty is, per setting (Jinx's mix). */
export const MIX: Record<Difficulty, Record<string, number>> = {
  easy: { easy: 1 },
  normal: { easy: 0.36, medium: 0.54, hard: 0.1 },
  hard: { medium: 0.5, hard: 0.5 },
};

/** A card on the board, as the host keeps it. */
export interface Card {
  word: string;
  color: Color;
  category: string;
  /** The word list's extras: clues rejected as too close (translations), accepted forms, English translations. */
  banned: readonly string[];
  alsoRight: readonly string[];
  english: readonly string[];
}

/** A tangled board: this many categories, each with this many words. */
export const TANGLE = { categories: 6, min: 3, max: 6 } as const;

/** The clue form of a word (by the matcher of its language), or undefined when it does not clean. */
export function wordClue(word: string, m: Matcher): Clue | undefined {
  const c = m.clean(word);
  return c.ok ? c.clue : undefined;
}

/**
 * Two words a board never has together: one is a clue too close to the
 * other (fire and firework, cat and cats, a banned translation). A clue
 * could not tell them apart, and one of them could never be clued.
 */
export function related(a: WordEntry, b: WordEntry, m: Matcher, opt: MatchOptions = {}): boolean {
  if (a.word === b.word) return true;
  const ca = wordClue(a.word, m);
  const cb = wordClue(b.word, m);
  if (!ca || !cb) return false;
  return m.tooClose(ca, cb, opt, b) !== null || m.tooClose(cb, ca, opt, a) !== null;
}

/**
 * The words in the order a deal tries them: by difficulty (each word's
 * weight from {@link MIX}, as a random key: Efraimidis–Spirakis), words
 * the room has not had (`used`) before those it had.
 */
export function candidates(words: readonly WordEntry[], difficulty: Difficulty, rng: () => number, used: ReadonlySet<string> = new Set()): WordEntry[] {
  const mix = MIX[difficulty];
  const keyed = words.flatMap((w) => {
    const weight = mix[w.difficulty] ?? 0;
    return weight > 0 ? [{ w, key: Math.pow(rng(), 1 / weight), used: used.has(w.word) }] : [];
  });
  keyed.sort((a, b) => Number(a.used) - Number(b.used) || b.key - a.key);
  const out = keyed.map((k) => k.w);
  // Too few words of the setting's difficulties: the others after them.
  if (out.length < BOARD.size) out.push(...shuffle(words.filter((w) => !(mix[w.difficulty] ?? 0)), rng));
  return out;
}

/**
 * How many words each of `n` categories gives to a board of `total`:
 * between `min` and `max` each, as even as chance makes it.
 */
export function categorySizes(n: number, total: number, rng: () => number, min: number = TANGLE.min, max: number = TANGLE.max): number[] {
  if (n * min > total || n * max < total) throw new Error(`crosstalk: ${n} categories cannot make ${total}`);
  const sizes = Array.from({ length: n }, (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0));
  for (let k = 0; k < n * 3; k++) {
    const from = Math.floor(rng() * n);
    const to = Math.floor(rng() * n);
    if (from !== to && sizes[from]! > min && sizes[to]! < max) {
      sizes[from]!--;
      sizes[to]!++;
    }
  }
  return shuffle(sizes, rng);
}

/** The 8 + 8 + 8 + 1 colours of a board, in order. */
export function boardColors(): Color[] {
  return [...Array<Color>(BOARD.team).fill("red"), ...Array<Color>(BOARD.team).fill("blue"), ...Array<Color>(BOARD.neutral).fill("neutral"), "assassin"];
}

/**
 * Whether the colours tangle the categories: every category with four
 * cards or more has two colours at least, and the assassin's category has
 * a red and a blue card (a category clue is a risk for both teams).
 */
export function tangled(cards: readonly Pick<Card, "category" | "color">[]): boolean {
  const by = new Map<string, Color[]>();
  for (const c of cards) by.set(c.category, [...(by.get(c.category) ?? []), c.color]);
  for (const colors of by.values()) if (colors.length >= 4 && new Set(colors).size < 2) return false;
  const assassin = cards.find((c) => c.color === "assassin");
  if (!assassin) return true;
  const its = by.get(assassin.category) ?? [];
  return its.includes("red") && its.includes("blue");
}

export interface DealOptions {
  mode?: BoardMode | undefined;
  difficulty?: Difficulty | undefined;
  rng?: (() => number) | undefined;
  /** Words the room had (they come after the others). */
  used?: ReadonlySet<string> | undefined;
  /** The language's matcher (related words never share a board). */
  matcher: Matcher;
  opt?: MatchOptions | undefined;
}

/**
 * A board: 25 cards in their places with their colours. Tangled: from
 * {@link TANGLE.categories} categories ({@link categorySizes}), coloured
 * so that {@link tangled} holds (up to 400 tries, then as it comes);
 * mixed: any 25 words. Never two related words ({@link related}).
 */
export function dealBoard(words: readonly WordEntry[], o: DealOptions): Card[] {
  const rng = o.rng ?? Math.random;
  const m = o.matcher;
  const opt = o.opt ?? {};
  const order = candidates(words, o.difficulty ?? "normal", rng, o.used);
  const picked: WordEntry[] = [];
  const fits = (w: WordEntry) => !picked.some((p) => related(p, w, m, opt));
  const take = (pool: readonly WordEntry[], n: number) => {
    let got = 0;
    for (const w of pool) {
      if (got >= n) break;
      if (!fits(w)) continue;
      picked.push(w);
      got++;
    }
    return got;
  };
  const mode = o.mode ?? "tangled";
  if (mode === "tangled") {
    const byCat = new Map<string, WordEntry[]>();
    for (const w of order) byCat.set(w.category, [...(byCat.get(w.category) ?? []), w]);
    const cats = shuffle(
      [...byCat].filter(([, ws]) => ws.length >= TANGLE.max + 2).map(([c]) => c),
      rng,
    );
    if (cats.length >= TANGLE.categories) {
      const sizes = categorySizes(TANGLE.categories, BOARD.size, rng);
      let i = 0;
      for (const cat of cats) {
        if (i >= sizes.length) break;
        if (take(byCat.get(cat)!, sizes[i]!) < sizes[i]!) {
          // Too few that fit: give back what it took, try the next category.
          while (picked.length > 0 && picked.at(-1)!.category === cat) picked.pop();
          continue;
        }
        i++;
      }
    }
  }
  if (picked.length < BOARD.size) take(order, BOARD.size - picked.length);
  if (picked.length < BOARD.size) throw new Error("crosstalk: too few words for a board");
  let cards: Card[] = [];
  for (let tries = 0; tries < 400; tries++) {
    const colors = shuffle(boardColors(), rng);
    cards = picked.map((w, i) => ({ word: w.word, color: colors[i]!, category: w.category, banned: w.banned, alsoRight: w.alsoRight, english: w.english }));
    if (mode !== "tangled" || tangled(cards)) break;
  }
  return shuffle(cards, rng);
}

// ---------------------------------------------------------------------------
// Clues

export type ClueCheck =
  | { ok: true; clue: Clue; number: number }
  | { ok: false; code: "empty" | "too-long" | "too-many-words" | "not-english" | "bad-number"; message: string }
  | { ok: false; code: "too-close"; reason: Reason; card: number; message: string };

/**
 * Checks a clue against the board: one word (two are joined, three are
 * refused), at most 24 characters, a number from 1 to 9, and not too
 * close to a face-down card (`hidden[i]`): the same word, its plural, a
 * form or family of it, a typo, sounds the same, contains or is part of
 * it, a banned translation (Jinx's matcher of the room's language). The
 * first such card, in board order, is the one named.
 */
export function checkClue(raw: unknown, number: unknown, board: readonly Card[], hidden: readonly boolean[], m: Matcher, opt: MatchOptions = {}): ClueCheck {
  const c = m.clean(typeof raw === "string" ? stripEmoji(raw) : "");
  if (!c.ok) return { ok: false, code: c.error, message: c.message };
  if (typeof number !== "number" || !Number.isInteger(number) || number < MIN_NUMBER || number > MAX_NUMBER) {
    return { ok: false, code: "bad-number", message: `A number from ${MIN_NUMBER} to ${MAX_NUMBER}` };
  }
  for (let i = 0; i < board.length; i++) {
    if (!hidden[i]) continue;
    const card = board[i]!;
    const s = wordClue(card.word, m);
    if (!s) continue;
    const r = m.tooClose(c.clue, s, opt, card);
    if (r) return { ok: false, code: "too-close", reason: r, card: i, message: `Too close to ${card.word}` };
  }
  return { ok: true, clue: c.clue, number };
}

// ---------------------------------------------------------------------------
// Guessing

/** What a pin or a lock is: a card (its index), or passing. */
export type Choice = number | "pass";

/** What a locked card means for the team that turned it. */
export type Result = "right" | "neutral" | "theirs" | "assassin";

export function resultOf(team: Team, color: Color): Result {
  if (color === team) return "right";
  if (color === "assassin") return "assassin";
  return color === "neutral" ? "neutral" : "theirs";
}

/** Why a team stopped for the round. */
export type Stop = "neutral" | "theirs" | "assassin" | "used" | "pass" | "timeout" | "no-clue" | "nobody" | "found";

/**
 * After a team's card: whether it guesses on, and if not why. A clue for
 * `number` allows `number + 1` cards (the extra one for a word left from
 * an earlier clue); `turned` counts this round's cards with this one.
 */
export function afterCard(result: Result, turned: number, number: number): Stop | null {
  if (result === "neutral" || result === "theirs" || result === "assassin") return result;
  return turned >= number + 1 ? "used" : null;
}

/**
 * The choice that has a majority of the team's operatives who are there
 * (`voters`): more than half of them pinned it. Pins of others (away,
 * not of the team) do not count.
 */
export function majority(pins: ReadonlyMap<string, Choice>, voters: readonly string[]): Choice | null {
  if (voters.length === 0) return null;
  const count = new Map<Choice, number>();
  for (const id of voters) {
    const c = pins.get(id);
    if (c !== undefined) count.set(c, (count.get(c) ?? 0) + 1);
  }
  for (const [c, n] of count) if (n * 2 > voters.length) return c;
  return null;
}

export type EndReason = "found" | "assassin" | "fewer-mistakes" | "draw" | "too-few";

export interface Outcome {
  /** The winner, null for a draw (or a game that ended early). */
  winner: Team | null;
  reason: EndReason;
}

/**
 * Whether the game is over after a step's flip. `found` are the teams'
 * cards turned so far (whoever turned them), `wrong` each team's wrong
 * cards this game (neutral and the other team's), `assassin` the teams
 * that turned it in this step.
 *
 * - The assassin loses the game for the team that turned it (both: a draw).
 * - A team with all its cards wins; both in the same step: the one with
 *   fewer wrong cards, else a draw.
 */
export function outcome(found: Readonly<Record<Team, number>>, wrong: Readonly<Record<Team, number>>, assassin: readonly Team[]): Outcome | null {
  if (assassin.length >= 2) return { winner: null, reason: "draw" };
  if (assassin.length === 1) return { winner: otherTeam(assassin[0]!), reason: "assassin" };
  const done = TEAMS.filter((t) => found[t] >= BOARD.team);
  if (done.length === 1) return { winner: done[0]!, reason: "found" };
  if (done.length === 2) {
    if (wrong.red === wrong.blue) return { winner: null, reason: "draw" };
    return { winner: wrong.red < wrong.blue ? "red" : "blue", reason: "fewer-mistakes" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Teams

/**
 * The team for a newcomer: the smaller one (a tie: the one that came out
 * of `rng`).
 */
export function smallerTeam(counts: Readonly<Record<Team, number>>, rng: () => number): Team {
  if (counts.red !== counts.blue) return counts.red < counts.blue ? "red" : "blue";
  return rng() < 0.5 ? "red" : "blue";
}

/**
 * Teams that can play: every team with at least {@link MIN_TEAM}
 * players. Moves the last to come (in `order`) of the bigger team over
 * while a team is short and the other can spare one; the moved ids.
 */
export function balance(teams: Map<string, Team>, order: readonly string[]): string[] {
  const moved: string[] = [];
  for (;;) {
    const of = (t: Team) => order.filter((id) => teams.get(id) === t);
    const short = TEAMS.find((t) => of(t).length < MIN_TEAM);
    if (!short) return moved;
    const big = of(otherTeam(short));
    if (big.length <= MIN_TEAM) return moved;
    const id = big.at(-1)!;
    teams.set(id, short);
    moved.push(id);
  }
}

/**
 * The next spymaster of a team: the player after `last` in `members`
 * (their order of joining), round and round; the first when `last` is
 * not (or no longer) in it.
 */
export function nextSpymaster(members: readonly string[], last: string | null): string | null {
  if (members.length === 0) return null;
  const i = last === null ? -1 : members.indexOf(last);
  return members[(i + 1) % members.length]!;
}

// ---------------------------------------------------------------------------
// The pad

/** A pad: this many lines of this many characters. */
export const PAD = { lines: 24, chars: 80 } as const;

export interface PadLine {
  id: number;
  text: string;
  /** Who wrote it last (player id). */
  by: string;
  /** Who is editing it now (player id), if anyone. */
  edit: string | null;
}

/** A line's text as the pad keeps it: one line, spaces collapsed, at most {@link PAD.chars} characters. */
export function cleanNote(text: unknown): string {
  return cleanText(text, PAD.chars);
}

