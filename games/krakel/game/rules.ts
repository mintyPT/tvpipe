/**
 * Krakel's rules, without a party: drawings and guesses as they arrive
 * from phones, the word lists (categories of `fox|red fox`), the matcher
 * that judges a typed guess (spelling slips forgiven, never towards
 * another word of the list), the deal of a round, and the points. Pure
 * functions with known-answer tests (test/rules.test.ts). The design:
 * docs/krakel-design.md.
 *
 * A round: one category for the room, a different word of it for every
 * player (three to pick from when the category has enough), or, mixed,
 * three words from three categories each. Everyone draws at once. Then the TV redraws each picture stroke by stroke, stretched
 * or squeezed to the guess time, and the others type what it is: the
 * sooner, the more points, and the artist earns with every one of them.
 */

import { cleanText, PartyError } from "@tvpipe/party";

import { ERASER, GRID, MAX_POINTS, MAX_STROKES, MAX_WIDTH, PALETTE } from "./ink.ts";

export { ERASER, GRID, MAX_POINTS, MAX_STROKES, MAX_WIDTH, PALETTE, PAPER, WIDTHS } from "./ink.ts";

// ---------------------------------------------------------------------------
// Drawings: strokes in colour on a square grid.

/** The longest guess (characters): a word or two. */
export const MAX_GUESS = 28;

/** A drawing: strokes `[colour, width, x0, y0, x1, y1, …]` on the grid (one point: a dot). */
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
    if (!Array.isArray(s) || s.length < 4 || s.length % 2 !== 0) throw bad("a stroke is [colour, width, x, y, …]");
    for (const v of s) if (typeof v !== "number" || !Number.isInteger(v)) throw bad("whole numbers only");
    const [color, w, ...xy] = s as number[];
    if (color! < 0 || color! >= PALETTE.length) throw bad("colour");
    if (w! < 1 || w! > MAX_WIDTH) throw bad("width");
    for (const v of xy) if (v < 0 || v > GRID) throw bad("off the paper");
    points += xy.length / 2;
    if (points > MAX_POINTS) throw bad("too many points");
    out.push([color!, w!, ...xy]);
  }
  return { strokes: out };
}

/** Whether there is anything to see: a stroke that is not the eraser's. */
export function hasInk(d: Drawing | undefined): boolean {
  return !!d && d.strokes.some((s) => s[0] !== ERASER);
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

/** Words a guess may start with that say nothing ("a fox", "der Fuchs"). */
const ARTICLES: Record<Lang, ReadonlySet<string>> = {
  en: new Set(["a", "an", "the", "some"]),
  de: new Set(["ein", "eine", "einen", "einem", "einer", "der", "die", "das", "den", "dem"]),
};

/** A text's words, folded, without leading articles (never all of them). */
export function tokens(text: string, lang: Lang = "en"): string[] {
  const f = fold(text);
  const ts = f ? f.split(" ") : [];
  while (ts.length > 1 && ARTICLES[lang].has(ts[0]!)) ts.shift();
  return ts;
}

/**
 * A word without one plural or inflection ending, when at least three
 * letters stay. English: `-s`, `-es` (after s, x, z, ch, sh, o), `-ies`
 * (→ `-y`), never `-ss`, `-us`, `-is` (`glass`, `cactus`). German: `-en`,
 * `-er`, `-e`, `-s`, `-n`, and `-n` after `-el` or `-er` in longer words.
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

/** An entry of a word list: the word, and the other words people write for it. */
export interface Word {
  word: string;
  also: string[];
}

/** A category: its title (shown to everyone) and its words. */
export interface Category {
  title: string;
  words: Word[];
}

/** A word of a guess or of a list as the matcher compares it: its words folded, and written as one. */
interface Form {
  parts: string[];
  joined: string;
}

function form(text: string, lang: Lang): Form {
  const parts = tokens(text, lang);
  return { parts, joined: parts.join("") };
}

/**
 * Whether guess `g` says the form `w` as written (no slips): the same
 * letters (written as one or apart), the same stem (`foxes`, `Füchse`),
 * or, for a guess of no more words than the form and a stem of four
 * letters and more, the form inside it (`Babykatze`, `rocketship`).
 */
function saysForm(g: Form, w: Form, lang: Lang, inside = true): boolean {
  if (!g.joined || !w.joined) return false;
  if (g.joined === w.joined) return true;
  const sg = stem(g.joined, lang);
  const sw = stem(w.joined, lang);
  if (sg === sw || sg === w.joined || g.joined === sw) return true;
  return inside && sw.length >= 4 && g.parts.length <= Math.max(1, w.parts.length) && g.joined.includes(sw);
}

/** Whether a guess says a word of the list as written: the word or one of the words people write for it. */
export function says(guess: string, word: Word, lang: Lang = "en"): boolean {
  const g = form(guess, lang);
  return [word.word, ...word.also].some((w) => saysForm(g, form(w, lang), lang));
}

/** Whether a guess is a word of the list itself (its letters or its stem; not merely a longer word with it inside). */
function names(g: Form, word: Word, lang: Lang): boolean {
  return [word.word, ...word.also].some((w) => saysForm(g, form(w, lang), lang, false));
}

export type Verdict = "right" | "close" | "wrong";

/**
 * Judges a guess at a word. Right: it says the word or one of its other
 * names ({@link says}), or is a spelling slip away from one
 * ({@link slips}: `elefant`, `Krokodiel`), unless it is another word of
 * `others` (`Laus` is not a misspelt `Maus`; `swordfis` is still a
 * swordfish, though it has a `sword` inside). Close: one more slip than
 * that. A guess of several words is never taken apart: it
 * has to be the word.
 */
export function judge(guess: string, word: Word, lang: Lang = "en", others: readonly Word[] = []): Verdict {
  const g = form(guess, lang);
  if (!g.joined) return "wrong";
  const forms = [word.word, ...word.also].map((w) => form(w, lang));
  if (forms.some((w) => saysForm(g, w, lang))) return "right";
  if (others.some((o) => o !== word && o.word !== word.word && names(g, o, lang))) return "wrong";
  let best: Verdict = "wrong";
  for (const w of forms) {
    const allowed = slips(w.joined.length);
    const d = distance(g.joined, w.joined, allowed + 1);
    if (d <= allowed) return "right";
    if (d === allowed + 1 && w.joined.length >= 4) best = "close";
  }
  return best;
}

/**
 * The shape of a word for the easy mode: a `_` for every letter and
 * digit, anything else as it is (`fire truck` → `____ _____`).
 */
export function shapeOf(word: string): string {
  return [...word.normalize("NFC")].map((c) => (/[\p{L}\p{N}]/u.test(c) ? "_" : c)).join("");
}

// ---------------------------------------------------------------------------
// Data files

/** A line starting a category: `== Zoo animals`. */
const HEADER = /^==\s*(.+?)\s*(?:==)?$/;

/**
 * A word list (`data/words.txt`): categories started by `== Title`, then
 * one entry per line, `fox|red fox` (the word first, then the other
 * words people write for it). `#` comments and blank lines are left out,
 * a word twice in a category once, entries before the first category
 * dropped.
 */
export function parseCategories(text: string): Category[] {
  const out: Category[] = [];
  let seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = cleanText(raw, 160);
    if (!line || line.startsWith("#")) continue;
    const head = HEADER.exec(line);
    if (head) {
      out.push({ title: head[1]!, words: [] });
      seen = new Set();
      continue;
    }
    const cat = out.at(-1);
    if (!cat) continue;
    const [word = "", ...also] = line
      .split("|")
      .map((x) => x.trim())
      .filter(Boolean);
    const k = fold(word);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    cat.words.push({ word, also });
  }
  return out.filter((c) => c.words.length > 0);
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

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;
/** Words each player picks from, when there are enough. */
export const CHOICES = 3;
/** Words a category of our lists has at least: two to pick from for each of {@link MAX_PLAYERS} players. */
export const MIN_CATEGORY = 2 * MAX_PLAYERS;

/**
 * Words each player picks from in a round of one category: three
 * ({@link CHOICES}) when the category has enough for everyone, else two,
 * else one.
 */
export function choicesFor(size: number, players: number): number {
  return Math.max(1, Math.min(CHOICES, Math.floor(size / Math.max(1, players))));
}

/**
 * The words of a round: for each of `players` players the words to pick
 * from ({@link choicesFor}), no word twice. A category with fewer words
 * than players deals some twice (our lists have none).
 */
export function dealRound(category: Category, players: number, rng: () => number): Word[][] {
  const per = choicesFor(category.words.length, players);
  let pile = shuffle(category.words, rng);
  const next = () => {
    if (pile.length === 0) pile = shuffle(category.words, rng);
    return pile.pop()!;
  };
  return Array.from({ length: players }, () => Array.from({ length: per }, next));
}

/** A word with the category it is from: what a player is dealt. */
export interface Card {
  word: Word;
  category: string;
}

/** Every word of a list as a card. */
export function cardsOf(categories: readonly Category[]): Card[] {
  return categories.flatMap((c) => c.words.map((word) => ({ word, category: c.title })));
}

/** Whether one word's name is right for the other (the same word, or a name that says it). */
function clash(a: Word, b: Word, lang: Lang): boolean {
  return a.word === b.word || [a.word, ...a.also].some((f) => says(f, b, lang)) || [b.word, ...b.also].some((f) => says(f, a, lang));
}

/**
 * The words of a mixed round: for each of `players` players
 * {@link CHOICES} words from as many categories, no word twice, and none
 * whose name would be right for another of the round (`ball` and
 * `balloon` are in different categories).
 */
export function dealMixed(deck: Deck<Card>, players: number, lang: Lang = "en"): Card[][] {
  const dealt: Card[] = [];
  return Array.from({ length: players }, () => {
    const mine: Card[] = [];
    for (let i = 0; i < CHOICES; i++) {
      const c = deck.draw((x) => !mine.some((m) => m.category === x.category) && !dealt.some((d) => clash(d.word, x.word, lang)));
      mine.push(c);
      dealt.push(c);
    }
    return mine;
  });
}

// ---------------------------------------------------------------------------
// Points

export const POINTS = {
  /** A right guess the moment the replay starts, and when it ends; between them by time. */
  max: 1000,
  min: 200,
  /** The first right guess of a drawing, on top. */
  first: 200,
  /** The artist's share of what the guessers earned by time. */
  artist: 0.5,
  /** The round's favourite drawing (the most hearts, at least two; ties split it, in tens). */
  favourite: 500,
} as const;

/** To the next ten. */
function tens(v: number): number {
  return Math.round(v / 10) * 10;
}

/** A right guess after the share `f` (0–1) of the guess time: 1000 down to 200, in tens. */
export function guessPoints(f: number): number {
  const x = Math.max(0, Math.min(1, Number.isFinite(f) ? f : 1));
  return tens(POINTS.max - (POINTS.max - POINTS.min) * x);
}

/**
 * What a drawing earns its artist: half of what its guessers earned by
 * time (the bonus for the first is theirs alone). A picture people name
 * early pays; one nobody names pays nothing.
 */
export function artistPoints(guessed: readonly number[]): number {
  return tens(guessed.reduce((a, b) => a + b, 0) * POINTS.artist);
}

/** Hearts a favourite needs: one heart alone is a taste, not a verdict. */
export const FAVOURITE_VOTES = 2;

/**
 * The favourite: the drawings (by their artist's id) with the most
 * hearts (at least {@link FAVOURITE_VOTES}), and what each pays its
 * artist (500, split between ties, in tens).
 */
export function favourite(votes: ReadonlyMap<string, string>): { ids: string[]; count: number; points: number } {
  const count = new Map<string, number>();
  for (const id of votes.values()) count.set(id, (count.get(id) ?? 0) + 1);
  const top = Math.max(0, ...count.values());
  const ids = top >= FAVOURITE_VOTES ? [...count].filter(([, n]) => n === top).map(([id]) => id) : [];
  ids.sort();
  return { ids, count: ids.length ? top : 0, points: ids.length ? tens(POINTS.favourite / ids.length) : 0 };
}

/** One player's points of a round, by kind. */
export interface Earned {
  /** Their drawing: what the others made of it. */
  drawn: number;
  /** Their guesses, by time. */
  guessed: number;
  /** Bonuses for being the first to name a drawing. */
  first: number;
  /** The favourite. */
  favourite: number;
}

export function earnedTotal(e: Earned): number {
  return e.drawn + e.guessed + e.first + e.favourite;
}

/** A right guess: who, when (the share of the guess time), and what it paid. */
export interface Hit {
  by: string;
  /** The share of the guess time that had passed (0–1). */
  at: number;
  points: number;
  first: boolean;
}

/** One drawing of a round and what became of it. */
export interface Entry {
  /** The artist's id. */
  by: string;
  word: Word;
  /** The word's category (its title). */
  category: string;
  drawing: Drawing;
  /** The players who could guess it. */
  guessers: string[];
  /** The right guesses, in order. */
  hits: Hit[];
  /** Whether it was shown (a blank page is not). */
  shown: boolean;
}

/** What a drawing earned its artist ({@link artistPoints} of its hits). */
export function entryPoints(e: Entry): number {
  return artistPoints(e.hits.map((h) => h.points));
}

/**
 * The round's drawings from the clearest to the least clear: by the
 * artist's points, then by how many named it, then by the first right
 * guess; drawings that were not shown last. Equal ones share a place.
 */
export function rankEntries(entries: readonly Entry[]): { entry: Entry; place: number; points: number }[] {
  const key = (e: Entry) => [e.shown ? 1 : 0, entryPoints(e), e.hits.length, -(e.hits[0]?.at ?? 2)] as const;
  const sorted = entries.map((entry) => ({ entry, k: key(entry) })).sort((a, b) => b.k[0] - a.k[0] || b.k[1] - a.k[1] || b.k[2] - a.k[2] || b.k[3] - a.k[3]);
  let place = 0;
  let last = "";
  return sorted.map(({ entry, k }, i) => {
    const same = k.join("/");
    if (same !== last) place = i + 1;
    last = same;
    return { entry, place, points: k[1] };
  });
}

/** The round's points: every hit pays its guesser (and the first its bonus), every drawing its artist, the favourite its artist. */
export function scoreRound(entries: readonly Entry[], votes: ReadonlyMap<string, string>): Map<string, Earned> {
  const earned = new Map<string, Earned>();
  const get = (id: string) => {
    let e = earned.get(id);
    if (!e) earned.set(id, (e = { drawn: 0, guessed: 0, first: 0, favourite: 0 }));
    return e;
  };
  for (const e of entries) {
    get(e.by).drawn += entryPoints(e);
    for (const h of e.hits) {
      get(h.by).guessed += h.points;
      if (h.first) get(h.by).first += POINTS.first;
    }
  }
  const fav = favourite(votes);
  for (const id of fav.ids) get(id).favourite += fav.points;
  return earned;
}
