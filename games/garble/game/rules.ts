/**
 * Garble's rules, without a party: drawings and guesses as they arrive
 * from phones, the word lists (`cat|kitten|kitty`), the matcher that
 * judges a guess, the seating (who works on which picture at which
 * step), the decks and the points. Pure functions with known-answer tests
 * (test/rules.test.ts). The design: docs/garble-design.md.
 *
 * A round: every player starts a picture with a word they pick and
 * draw; the picture then goes seat to seat, and each next player first
 * guesses what it is now, then draws the word they are dealt on top of
 * it. After `L` layers, one more player only guesses. Step `k` of
 * picture `c` is done by seat `(c + k) % n`, so every step every player
 * works on exactly one picture, and a picture never visits a player
 * twice (`L + 1 <= n`).
 */

import { cleanText, PartyError } from "@tvpipe/party";

// ---------------------------------------------------------------------------
// Drawings: strokes on a square grid.

/** Drawings are on a GRID × GRID square. */
export const GRID = 1000;
/** The pens' widths (fine, medium, thick) on the grid. */
export const WIDTHS = [7, 16, 38] as const;
export const MAX_WIDTH = 80;
/** The most strokes and points of one layer. */
export const MAX_STROKES = 400;
export const MAX_POINTS = 16_000;
/** The longest guess (characters): a word or two. */
export const MAX_GUESS = 28;

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

/** The layers of a picture as one drawing (what the next player sees: one ink, no seams). */
export function flatten(layers: readonly { drawing: Drawing }[]): Drawing {
  return { strokes: layers.flatMap((l) => l.drawing.strokes) };
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
// Words: folding, stems, the matcher.

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

/**
 * A word without one plural or inflection ending, when at least three
 * letters stay. English: `-s`, `-es` (after s, x, z, ch, sh, o), `-ies`
 * (→ `-y`), never `-ss`, `-us`, `-is` (`glass`, `cactus`). German: `-en`,
 * `-er`, `-e`, `-s`, and `-n` after `-el` or `-er` in longer words
 * (`Gabeln`, `Federn`, not `Stern`).
 */
export function stem(word: string, lang: Lang = "en"): string {
  const cut = (n: number) => (word.length - n >= 3 ? word.slice(0, -n) : word);
  if (lang === "de") {
    for (const e of ["en", "er", "e", "s"]) if (word.endsWith(e) && word.length - e.length >= 3) return word.slice(0, -e.length);
    return /(el|er)n$/.test(word) && word.length >= 6 ? word.slice(0, -1) : word;
  }
  if (word.endsWith("ies") && word.length >= 5) return word.slice(0, -3) + "y";
  if (/(s|x|z|ch|sh|o)es$/.test(word)) return cut(2);
  if (word.endsWith("s") && !/(ss|us|is)$/.test(word)) return cut(1);
  return word;
}

/** Whether one folded token says one folded word (no spaces): the same, the same stem, or inside it. */
function tokenSays(t: string, w: string, lang: Lang): boolean {
  if (t === w) return true;
  const st = stem(t, lang);
  const sw = stem(w, lang);
  // German `Häuser` and `Haus` share a stem; `Kerzen` (→ `kerz`) and `Kerze` too.
  if (st === sw || st === w) return true;
  // Inside a longer word, from four letters: `Piratenschiff`, `rocketship`, `Kätzchen`.
  return sw.length >= 4 && t.includes(sw);
}

/**
 * Whether `text` says `word` (in `lang`): one of its words is the word
 * (folded), has the same stem (`pirates` for `pirate`, `Piraten` for
 * `Pirat`), or, for stems of four letters and more, has it inside
 * (`Piratenoma`, `rocketship`). A word of several (`fire truck`) is said
 * by those words in a row, or by them written as one (`firetruck`).
 */
export function says(text: string, word: string, lang: Lang = "en"): boolean {
  const ws = tokens(word);
  if (ws.length === 0) return false;
  const ts = tokens(text);
  if (ws.length === 1) return ts.some((t) => tokenSays(t, ws[0]!, lang));
  const joined = ws.join("");
  if (ts.some((t) => tokenSays(t, joined, lang))) return true;
  for (let i = 0; i + ws.length <= ts.length; i++) if (ws.every((w, j) => tokenSays(ts[i + j]!, w, lang))) return true;
  return false;
}

/** An entry of a word list: the word, and the other words people write for it. */
export interface Word {
  word: string;
  also: string[];
}

/** Whether a guess names a word: the word itself or one of its synonyms ({@link says}). */
export function judge(guess: string, word: Word, lang: Lang = "en"): boolean {
  return says(guess, word.word, lang) || word.also.some((a) => says(guess, a, lang));
}

// ---------------------------------------------------------------------------
// Data files

/** A data file: one entry per line, `#` comments and blank lines left out, duplicates once. */
export function parseList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = cleanText(raw, 120);
    if (!line || line.startsWith("#")) continue;
    const k = fold(line);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(line);
  }
  return out;
}

/** A word list (`data/words.txt`): `cat|kitten|kitty`, the word first, then its synonyms. */
export function parseWords(text: string): Word[] {
  return parseList(text)
    .map((line) => {
      const [word = "", ...also] = line
        .split("|")
        .map((x) => x.trim())
        .filter(Boolean);
      return { word, also };
    })
    .filter((w) => w.word);
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

/**
 * Cards dealt without repeats until all were dealt (then reshuffled),
 * kept from game to game by the room.
 */
export class Deck<T> {
  readonly #all: readonly T[];
  readonly #rng: () => number;
  #pile: T[] = [];

  constructor(cards: readonly T[], rng: () => number) {
    if (cards.length === 0) throw new Error("an empty deck");
    this.#all = cards;
    this.#rng = rng;
  }

  get size(): number {
    return this.#all.length;
  }

  /** The next card that `ok` accepts (any, when none in a whole pile does). */
  draw(ok: (card: T) => boolean = () => true): T {
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

/**
 * The words of one picture: two to pick from for the first layer, then
 * one per further layer, none twice and none saying another.
 */
export function dealPicture(deck: Deck<Word>, layers: number, lang: Lang = "en"): { choices: [Word, Word]; words: Word[] } {
  const taken: Word[] = [];
  const fits = (w: Word) => !taken.some((x) => x.word === w.word || judge(x.word, w, lang) || judge(w.word, x, lang));
  const next = () => {
    const w = deck.draw(fits);
    taken.push(w);
    return w;
  };
  const choices: [Word, Word] = [next(), next()];
  const words = Array.from({ length: Math.max(0, layers - 1) }, next);
  return { choices, words };
}

// ---------------------------------------------------------------------------
// The seating

/** Layers per picture the room can pick: short, normal, long. */
export const LENGTHS = [3, 5, 7] as const;
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 12;

/**
 * Layers per picture: the room's length, at most one less than the
 * players (every picture visits `L + 1` different players: `L` drawers
 * and the last guesser), at least 1.
 */
export function layerCount(players: number, length: number): number {
  return Math.max(1, Math.min(length, players - 1));
}

/** The seat that does step `k` of picture `c` (of `n` seats). */
export function seatOf(c: number, k: number, n: number): number {
  return (((c + k) % n) + n) % n;
}

/** The picture seat `s` works on at step `k`. */
export function pictureAt(s: number, k: number, n: number): number {
  return (((s - k) % n) + n) % n;
}

// ---------------------------------------------------------------------------
// A picture and its points

/** A guess: what the next player wrote, and whether it says the layer's word. */
export interface Guess {
  by: string;
  text: string;
  right: boolean;
}

/** One layer: its word, its drawer, their strokes, and the next player's guess. */
export interface Layer {
  by: string;
  word: Word;
  drawing: Drawing;
  /** Null until the next player guessed (or the step ended without a guess). */
  guess: Guess | null;
}

export interface Picture {
  /** The seat that started it (the picture's index). */
  id: number;
  layers: Layer[];
}

/** A guess at a layer, judged (an empty one is wrong). */
export function guessAt(layer: Layer, by: string, text: string, lang: Lang = "en"): Guess {
  return { by, text, right: !!text && judge(text, layer.word, lang) };
}

export const POINTS = {
  /** Layer `k` (from 1) read right: `base + step·k`, to its drawer and its reader each. */
  base: 50,
  step: 50,
  /** The best move (the most votes, at least two; ties split it, in tens). */
  best: 200,
} as const;

/** What layer `k` (from 0) pays its drawer and its reader when read right: 100, 150, 200, … */
export function layerPoints(k: number): number {
  return POINTS.base + POINTS.step * (k + 1);
}

/** One player's points of a round, by kind. */
export interface Earned {
  /** Their layers that the next player read right. */
  drawn: number;
  /** Layers they read right. */
  read: number;
  /** The best move. */
  best: number;
}

export function earnedTotal(e: Earned): number {
  return e.drawn + e.read + e.best;
}

/** A layer of a round, as `picture:layer` (a best-move vote). */
export function layerId(picture: number, layer: number): string {
  return `${picture}:${layer}`;
}

/** Votes a best move needs: one vote alone is a taste, not a verdict. */
export const BEST_VOTES = 2;

/**
 * The best move: the layers with the most votes (at least
 * {@link BEST_VOTES}), and what each pays its drawer (200, split between
 * ties, in tens).
 */
export function bestMove(votes: ReadonlyMap<string, string>): { ids: string[]; count: number; points: number } {
  const count = new Map<string, number>();
  for (const id of votes.values()) count.set(id, (count.get(id) ?? 0) + 1);
  const top = Math.max(0, ...count.values());
  const ids = top >= BEST_VOTES ? [...count].filter(([, n]) => n === top).map(([id]) => id) : [];
  ids.sort((a, b) => {
    const [pa, la] = a.split(":").map(Number);
    const [pb, lb] = b.split(":").map(Number);
    return pa! - pb! || la! - lb!;
  });
  return { ids, count: ids.length ? top : 0, points: ids.length ? Math.round(POINTS.best / ids.length / 10) * 10 : 0 };
}

/**
 * The round's points: every layer read right pays its drawer and its
 * reader (a blank one pays nobody); the best move pays its drawer.
 */
export function scoreRound(pictures: readonly Picture[], votes: ReadonlyMap<string, string>): Map<string, Earned> {
  const earned = new Map<string, Earned>();
  const get = (id: string) => {
    let e = earned.get(id);
    if (!e) earned.set(id, (e = { drawn: 0, read: 0, best: 0 }));
    return e;
  };
  for (const p of pictures) {
    p.layers.forEach((l, k) => {
      get(l.by);
      if (!l.guess) return;
      get(l.guess.by);
      // A blank layer pays nobody: there was nothing to read.
      if (!l.guess.right || l.drawing.strokes.length === 0) return;
      get(l.by).drawn += layerPoints(k);
      get(l.guess.by).read += layerPoints(k);
    });
  }
  const best = bestMove(votes);
  for (const id of best.ids) {
    const [pi, li] = id.split(":").map(Number);
    const layer = pictures.find((p) => p.id === pi)?.layers[li!];
    if (layer) get(layer.by).best += best.points;
  }
  return earned;
}
