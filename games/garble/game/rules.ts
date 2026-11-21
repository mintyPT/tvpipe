/**
 * Garble's rules, without a party: drawings and guesses as they arrive
 * from phones, the word lists (`cat|kitten|kitty`), the matcher that
 * judges a guess (spelling slips forgiven, never towards another word
 * of the list), the seating (who works on which picture at which
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

import { GRID, MAX_POINTS, MAX_STROKES, MAX_WIDTH } from "./ink.ts";

// ---------------------------------------------------------------------------
// Drawings: strokes on a square grid (the grid and the limits: game/ink.ts, shared with the pages).

export { GRID, MAX_POINTS, MAX_STROKES, MAX_WIDTH, WIDTHS } from "./ink.ts";

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

/**
 * The edit distance of two words (insert, delete, replace, and two
 * neighbours swapped, each 1), or `max + 1` when it is more than `max`.
 */
export function distance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: lb + 1 }, (_, j) => j);
  for (let i = 1; i <= la; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return Math.min(prev[lb]!, max + 1);
}

/** Letters a guess may be off a word of that length and still count: none up to 4, one up to 7, two from 8. */
export function slips(length: number): number {
  return length <= 4 ? 0 : length <= 7 ? 1 : 2;
}

/**
 * German written without umlauts on the keyboard: `ae`, `oe`, `ue` as
 * the folded `a`, `o`, `u` (`Kaese`, `Schildkroete`, `Kuehe`). Only
 * the guess's other reading; the guess as typed counts too (`Feuer`).
 */
function umlautsOff(text: string): string {
  return text.replace(/([aou])e/gi, "$1");
}

/** Whether a run of a guess (folded, written as one) is a form as written: the same letters or the same stem, nothing inside. */
function isForm(t: string, w: string, lang: Lang): boolean {
  if (t === w) return true;
  const st = stem(t, lang);
  const sw = stem(w, lang);
  return st === sw || st === w || t === sw;
}

/** A word's names (the word, its synonyms), each folded and written as one, with its number of words. */
function formsOf(word: Word): { joined: string; count: number }[] {
  return [word.word, ...word.also]
    .map((f) => {
      const ts = tokens(f);
      return { joined: ts.join(""), count: ts.length };
    })
    .filter((f) => f.joined);
}

/**
 * Whether a run of a guess (folded, written as one) is a spelling slip
 * of a name (`joined`): the same first letter (a rhyme is another word:
 * `house` is no `mouse`, `power` no `tower`), and at most
 * {@link slips} letters off it, as typed or without an ending
 * (`elefants`, `girafe`, `Krokodiel`).
 */
function slipOf(t: string, joined: string, lang: Lang): boolean {
  const allowed = slips(joined.length);
  if (allowed === 0 || t[0] !== joined[0]) return false;
  if (distance(t, joined, allowed) <= allowed) return true;
  const st = stem(t, lang);
  if (st !== t && distance(st, joined, allowed) <= allowed) return true;
  // Stem to stem, as many slips as the shorter stem allows (`kuh` is no slip of `Kuchen`).
  const sw = stem(joined, lang);
  const few = slips(sw.length);
  return few > 0 && distance(st, sw, few) <= few;
}

/**
 * Whether a guess reads a word right through a spelling slip: some run
 * of its words (one word, or as many as the name has, or one more:
 * `fire truk`, `firetruk`, `snow mann`) is a slip of one of the word's
 * names ({@link slipOf}), and that run is not itself another word of
 * `others` (`mouse` is a word of its own, not a misspelt `moose`).
 * `readings` are the guess as typed and its other readings (German
 * umlauts written out: the same words); a run is another word when it
 * is in any of them.
 */
function slipped(readings: readonly string[], word: Word, lang: Lang, others: readonly Word[]): boolean {
  const all = readings.map((g) => tokens(g));
  let rivalForms: string[] | undefined;
  // The other words' names, only once a run is a slip (most are not).
  const rivals = () => {
    const own = fold(word.word);
    return (rivalForms ??= others.filter((o) => fold(o.word) !== own).flatMap(formsOf).map((f) => f.joined));
  };
  for (const w of formsOf(word)) {
    if (slips(w.joined.length) === 0) continue;
    for (const ts of all) {
      for (let size = 1; size <= w.count + 1; size++) {
        for (let i = 0; i + size <= ts.length; i++) {
          if (!slipOf(ts.slice(i, i + size).join(""), w.joined, lang)) continue;
          const runs = all.map((x) => x.slice(i, i + size).join(""));
          if (rivals().some((r) => runs.some((t) => isForm(t, r, lang)))) continue;
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Whether a guess names a word: it says the word or one of its
 * synonyms ({@link says}), or, failing that, a run of it is a spelling
 * slip away from one ({@link slipped}) and is not another word of
 * `others` (the room's word list). German guesses count with `ae`,
 * `oe`, `ue` for umlauts too.
 */
export function judge(guess: string, word: Word, lang: Lang = "en", others: readonly Word[] = []): boolean {
  const readings = lang === "de" && /[aou]e/i.test(guess) ? [guess, umlautsOff(guess)] : [guess];
  for (const g of readings) if (says(g, word.word, lang) || word.also.some((a) => says(g, a, lang))) return true;
  return slipped(readings, word, lang, others);
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

/** Whether a name of one word would be right for the other (as written or by a slip: `horse` and `house`). */
function clash(a: Word, b: Word, lang: Lang): boolean {
  return a.word === b.word || [a.word, ...a.also].some((f) => judge(f, b, lang)) || [b.word, ...b.also].some((f) => judge(f, a, lang));
}

/**
 * The words of one picture: two to pick from for the first layer, then
 * one per further layer, none twice and none whose name would be right
 * for another, even by a slip (a `horse` drawn into a `house` could not
 * be told from it by the guess).
 */
export function dealPicture(deck: Deck<Word>, layers: number, lang: Lang = "en"): { choices: [Word, Word]; words: Word[] } {
  const taken: Word[] = [];
  const fits = (w: Word) => !taken.some((x) => clash(x, w, lang));
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

/** A guess at a layer, judged against the room's word list `others` (an empty one is wrong). */
export function guessAt(layer: Layer, by: string, text: string, lang: Lang = "en", others: readonly Word[] = []): Guess {
  return { by, text, right: !!text && judge(text, layer.word, lang, others) };
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
