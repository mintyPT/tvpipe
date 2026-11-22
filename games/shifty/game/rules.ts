/**
 * Shifty's rules, without a party: the word lists (categories of
 * `fox|red fox`, Krakel's), the board of a round and its secret word,
 * the phony and the order of the clues, the check that a clue does not
 * say a word of the board (Krakel's matcher), the typing log the TV
 * draws the needle from, the accusations and the points. Pure functions
 * with known-answer tests (test/rules.test.ts). The design:
 * docs/shifty-design.md.
 */

import { cleanText, stripEmoji } from "@tvpipe/party";

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
// Words: folding, stems, the matcher (Krakel's, game/rules.ts there).

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

/** Words a text may start with that say nothing ("a fox", "der Fuchs"). */
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

/** Letters a text may be off a word of that length and still say it: none up to 4, one up to 7, two from 8. */
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

/** A text as the matcher compares it: its words folded, and written as one. */
interface Form {
  parts: string[];
  joined: string;
}

function form(text: string, lang: Lang): Form {
  const parts = tokens(text, lang);
  return { parts, joined: parts.join("") };
}

/**
 * Whether text `g` says the form `w` as written (no slips): the same
 * letters (written as one or apart), the same stem (`foxes`, `Füchse`),
 * or, for a text of no more words than the form and a stem of four
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

/** Whether a text says a word of the list as written: the word or one of the words people write for it. */
export function says(text: string, word: Word, lang: Lang = "en"): boolean {
  const g = form(text, lang);
  return [word.word, ...word.also].some((w) => saysForm(g, form(w, lang), lang));
}

/** Whether a text is a word of the list itself (its letters or its stem; not merely a longer word with it inside). */
function names(g: Form, word: Word, lang: Lang): boolean {
  return [word.word, ...word.also].some((w) => saysForm(g, form(w, lang), lang, false));
}

export type Verdict = "right" | "close" | "wrong";

/** German written without umlauts on the keyboard: `ae`, `oe`, `ue` as the folded `a`, `o`, `u` (`Kaese`, `Loewe`). */
function umlautsOff(text: string): string {
  return text.replace(/([aou])e/gi, "$1");
}

/**
 * How far a text (folded, written as one) is from a name (`joined`) by
 * spelling slips: `right` at most {@link slips} letters off it, as typed
 * or without its ending, stem to stem as many as the shorter stem
 * allows; `close` one more than that on a name of four letters and
 * more; else `wrong`. Never with another first letter: a rhyme is
 * another word (`house` is no `mouse`).
 */
function slipOf(t: string, joined: string, lang: Lang): Verdict {
  if (!t || t[0] !== joined[0]) return "wrong";
  const allowed = slips(joined.length);
  const d = distance(t, joined, allowed + 1);
  if (d <= allowed) return "right";
  if (allowed > 0) {
    const st = stem(t, lang);
    if (st !== t && distance(st, joined, allowed) <= allowed) return "right";
    const sw = stem(joined, lang);
    const few = slips(Math.min(st.length, sw.length));
    if (few > 0 && distance(st, sw, few) <= few) return "right";
  }
  return d === allowed + 1 && joined.length >= 4 ? "close" : "wrong";
}

/**
 * Whether a text says a word: right when it says the word or one of its
 * other names ({@link says}) or is a spelling slip away from one
 * (`elefant`, `Krokodiel`; the same first letter), unless it is another
 * word of `others` (`Laus` is not a misspelt `Maus`). German texts count
 * with `ae`, `oe`, `ue` for umlauts too (`Kaese`, `Baer`).
 */
export function judge(text: string, word: Word, lang: Lang = "en", others: readonly Word[] = []): Verdict {
  const readings = lang === "de" && /[aou]e/i.test(text) ? [text, umlautsOff(text)] : [text];
  const gs = readings.map((r) => form(r, lang)).filter((g) => g.joined);
  if (gs.length === 0) return "wrong";
  const forms = [word.word, ...word.also].map((w) => form(w, lang)).filter((w) => w.joined);
  if (gs.some((g) => forms.some((w) => saysForm(g, w, lang)))) return "right";
  if (others.some((o) => o !== word && o.word !== word.word && gs.some((g) => names(g, o, lang)))) return "wrong";
  let best: Verdict = "wrong";
  for (const w of forms) {
    for (const g of gs) {
      const v = slipOf(g.joined, w.joined, lang);
      if (v === "right") return v;
      if (v === "close") best = v;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Clues

/** The longest clue, characters. */
export const MAX_CLUE = 24;

export type ClueCheck = { ok: true; text: string } | { ok: false; reason: "empty" | "space" | "long" | "board"; word?: string };

/**
 * Checks a clue against the board (docs/shifty-design.md §3): one word
 * (no spaces; hyphens and apostrophes are fine) of at most
 * {@link MAX_CLUE} characters that does not say a word of the board
 * (`judge`: as written, its stem, inside a longer word, a spelling slip)
 * and is not a part of a board word of several (`sea` for `sea horse`).
 * The same for everyone, so a refusal tells the phony nothing about the
 * secret. `all` is the language's whole list (a slip is never another
 * word of it).
 */
export function checkClue(text: unknown, board: readonly Word[], lang: Lang = "en", all: readonly Word[] = []): ClueCheck {
  // No emoji: a picture of the word is no clue.
  const raw = typeof text === "string" ? stripEmoji(text.normalize("NFC")).trim() : "";
  if (!raw || !fold(raw)) return { ok: false, reason: "empty" };
  if (/\s/u.test(raw)) return { ok: false, reason: "space" };
  const clean = cleanText(raw, MAX_CLUE + 1);
  if ([...clean].length > MAX_CLUE) return { ok: false, reason: "long" };
  for (const w of board) if (judge(clean, w, lang, all) === "right") return { ok: false, reason: "board", word: w.word };
  const mine = form(clean, lang);
  for (const w of board) {
    for (const name of [w.word, ...w.also]) {
      const parts = tokens(name, lang);
      if (parts.length < 2) continue;
      if (parts.some((p) => p.length >= 3 && saysForm(mine, { parts: [p], joined: p }, lang, false))) return { ok: false, reason: "board", word: w.word };
    }
  }
  return { ok: true, text: clean };
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

// ---------------------------------------------------------------------------
// A round: the board, the phony, the order

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;
/** Words on the board. */
export const BOARD = 16;
/** Words a category of our lists has at least. */
export const MIN_CATEGORY = 20;

/** The board of a round: {@link BOARD} words of the category in a random order, and which is the secret. */
export function dealBoard(category: Category, rng: () => number): { words: Word[]; secret: number } {
  const words = shuffle(category.words, rng).slice(0, BOARD);
  return { words, secret: Math.floor(rng() * words.length) };
}

/** The phony: anyone of the round, at random (no rotation: the room could count). */
export function pickPhony(ids: readonly string[], rng: () => number): string {
  if (ids.length === 0) throw new Error("nobody to pick");
  return ids[Math.floor(rng() * ids.length)]!;
}

/** The order of the clues: shuffled, and the phony never first (the first clue is given blind). */
export function clueOrder(ids: readonly string[], phony: string, rng: () => number): string[] {
  const order = shuffle(ids, rng);
  if (order.length > 1 && order[0] === phony) [order[0], order[1]] = [order[1]!, order[0]!];
  return order;
}

/** Clues each player gives in a round: the room's choice, or (auto) two with up to five players, else one. */
export function cluesEach(setting: number, players: number): number {
  if (setting === 1 || setting === 2) return setting;
  return players <= 5 ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Typing: the log the TV draws the needle and the tiles from

/** One sample: ms since the turn began, letters in the field, keys typed, keys deleted (both counted from the turn's start). */
export type Key = [ms: number, n: number, k: number, d: number];

/** The most samples a turn keeps. */
export const MAX_KEYS = 400;
/** The most letters, keys or deletions a phone can report. */
export const MAX_TYPED = 10_000;

/**
 * A phone's typing report (`{ turn, n, k, d }`) added to a turn's log:
 * kept when it changed something, counts never going back (a phone
 * cannot undo a deletion), at most {@link MAX_KEYS} samples. Whether it
 * was added.
 */
export function addKey(log: Key[], ms: number, data: unknown): boolean {
  if (log.length >= MAX_KEYS || typeof data !== "object" || data === null) return false;
  const v = data as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.round(Math.max(0, Math.min(MAX_TYPED, x))) : null);
  const n = num(v["n"]);
  const k = num(v["k"]);
  const d = num(v["d"]);
  if (n === null || k === null || d === null) return false;
  const last = log.at(-1);
  const next: Key = [Math.max(0, Math.round(ms)), Math.min(n, MAX_CLUE * 4), Math.max(k, last?.[2] ?? 0), Math.max(d, last?.[3] ?? 0)];
  if (last && last[1] === next[1] && last[2] === next[2] && last[3] === next[3]) return false;
  if (last && next[0] < last[0]) next[0] = last[0];
  log.push(next);
  return true;
}

/** Deletions in a turn's log. */
export function deletions(log: readonly Key[]): number {
  return log.at(-1)?.[3] ?? 0;
}

// ---------------------------------------------------------------------------
// Accusations and points

/**
 * The accusations (accuser id → accused id) counted: per accused, and
 * the one with the most, alone (null on a tie at the top or with none).
 */
export function tally(votes: ReadonlyMap<string, string>): { counts: Map<string, number>; top: string | null } {
  const counts = new Map<string, number>();
  for (const to of votes.values()) counts.set(to, (counts.get(to) ?? 0) + 1);
  let top: string | null = null;
  let best = 0;
  for (const [id, n] of counts) {
    if (n > best) {
      best = n;
      top = id;
    } else if (n === best) top = null;
  }
  return { counts, top };
}

export const POINTS = {
  /** An innocent who accused the phony. */
  accuse: 1,
  /** Every innocent, when the phony is caught and misses the word. */
  team: 1,
  /** The phony, not caught. */
  escape: 2,
  /** The phony, naming the word. */
  word: 2,
} as const;

/** Points of a round by kind. */
export interface Earned {
  accuse: number;
  team: number;
  escape: number;
  word: number;
}

export function earnedTotal(e: Earned): number {
  return e.accuse + e.team + e.escape + e.word;
}

/**
 * The points of a round (docs/shifty-design.md §5) for `players`: the
 * phony, the accusations, whether the phony named the word. The phony
 * is caught when the accusations' top (alone) is the phony.
 */
export function scoreRound(players: readonly string[], phony: string, votes: ReadonlyMap<string, string>, named: boolean): { caught: boolean; earned: Map<string, Earned> } {
  const { top } = tally(votes);
  const caught = top === phony;
  const earned = new Map<string, Earned>();
  for (const id of players) {
    const e: Earned = { accuse: 0, team: 0, escape: 0, word: 0 };
    if (id === phony) {
      if (!caught) e.escape = POINTS.escape;
      if (named) e.word = POINTS.word;
    } else {
      if (votes.get(id) === phony) e.accuse = POINTS.accuse;
      if (caught && !named) e.team = POINTS.team;
    }
    earned.set(id, e);
  }
  return { caught, earned };
}
