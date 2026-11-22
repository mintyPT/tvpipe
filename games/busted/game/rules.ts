/**
 * Busted's rules without a party (docs/busted-design.md): the question
 * lists and the deck that deals them, the texts players type (answers,
 * suggested questions and titles) cleaned the same way for everyone, the
 * podium ballots of a vote round and their tally, the anonymous cards of
 * an answer round with the guesses and their points, and the room's
 * ratings of suggested questions. Known answers in test/rules.test.ts.
 */

export const LANGS = ["en", "de"] as const;
export type Lang = (typeof LANGS)[number];

/** A language tag (`de-AT`, `en`, …) as one of {@link LANGS}, English by default. */
export function pickLang(tag: unknown): Lang {
  if (typeof tag !== "string") return "en";
  const base = tag.toLowerCase().split(/[-_]/)[0];
  return (LANGS as readonly string[]).includes(base ?? "") ? (base as Lang) : "en";
}

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;
/** Honorary candidates: people (or pets) who are not playing but can be voted for. */
export const MAX_EXTRAS = 3;

// ---------------------------------------------------------------------------
// Randomness

/** A small seeded generator (mulberry32): tests and fixed screenshots. */
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

// ---------------------------------------------------------------------------
// Questions

/** A vote round ranks people ("who would most likely …"), an answer round guesses who wrote what. */
export const KINDS = ["vote", "answer"] as const;
export type Kind = (typeof KINDS)[number];
/** `family`: fine with kids, grandparents and coworkers; `party`: cheekier, among friends. */
export const LEVELS = ["family", "party"] as const;
export type Level = (typeof LEVELS)[number];

export interface Question {
  kind: Kind;
  level: Level;
  text: string;
  /** A vote question's title for the winner ("Sleepyhead of the Year"). */
  title?: string | undefined;
}

export const MAX_QUESTION = 120;
export const MIN_QUESTION = 10;
export const MAX_TITLE = 28;
export const MAX_ANSWER = 80;

/** The kind of the round `n` (1-based): vote rounds first, then they alternate. */
export function kindOf(n: number): Kind {
  return n % 2 === 1 ? "vote" : "answer";
}

/** A question's identity in the room's memory of what was played. */
export function questionKey(q: Pick<Question, "kind" | "text">): string {
  return `${q.kind}:${q.text}`;
}

/**
 * The question list (`data/questions.txt`): `kind<TAB>level<TAB>question[<TAB>title]`
 * per line, `#` comments. Lines that do not fit are skipped (and listed in `errors`).
 */
export function parseQuestions(text: string, errors: string[] = []): Question[] {
  const out: Question[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const f = line.split("\t").map((x) => x.trim());
    const [kind, level, q, title] = f;
    const where = `line ${i + 1}`;
    if (!(KINDS as readonly string[]).includes(kind ?? "")) return void errors.push(`${where}: kind ${kind}`);
    if (!(LEVELS as readonly string[]).includes(level ?? "")) return void errors.push(`${where}: level ${level}`);
    if (!q || q.length < MIN_QUESTION || q.length > MAX_QUESTION) return void errors.push(`${where}: the question's length`);
    if (kind === "vote" && (!title || title.length > MAX_TITLE)) return void errors.push(`${where}: a vote needs a title of at most ${MAX_TITLE} characters`);
    if (kind === "answer" && f.length > 3) return void errors.push(`${where}: an answer question has no title`);
    const key = `${kind}:${q.toLowerCase()}`;
    if (seen.has(key)) return void errors.push(`${where}: twice`);
    seen.add(key);
    out.push({ kind: kind as Kind, level: level as Level, text: q, ...(kind === "vote" ? { title } : {}) });
  });
  return out;
}

/**
 * The room's deck of one language: a question of a kind and level that
 * was not played yet in this room (the host page keeps the keys of the
 * played ones across games); once every fitting one was played, they
 * all come back.
 */
export class QuestionDeck {
  readonly #all: readonly Question[];
  readonly #rng: () => number;
  readonly seen: Set<string>;

  constructor(questions: readonly Question[], rng: () => number, seen: Iterable<string> = []) {
    this.#all = questions;
    this.#rng = rng;
    this.seen = new Set(seen);
  }

  /** How many fit: `family` deals family questions only, `party` both levels. */
  #fits(q: Question, kind: Kind, level: Level): boolean {
    return q.kind === kind && (level === "party" || q.level === "family");
  }

  count(kind: Kind, level: Level): number {
    return this.#all.filter((q) => this.#fits(q, kind, level)).length;
  }

  /** The next question (marked as played), or undefined when the list has none of the kind. */
  draw(kind: Kind, level: Level, not: ReadonlySet<string> = new Set()): Question | undefined {
    const fit = this.#all.filter((q) => this.#fits(q, kind, level) && !not.has(questionKey(q)));
    if (fit.length === 0) return undefined;
    let fresh = fit.filter((q) => !this.seen.has(questionKey(q)));
    if (fresh.length === 0) {
      for (const q of fit) this.seen.delete(questionKey(q));
      fresh = fit;
    }
    // Party level: a cheekier one about every other time, not only when the family ones ran out.
    if (level === "party") {
      const cheeky = fresh.filter((q) => q.level === "party");
      if (cheeky.length > 0 && this.#rng() < 0.5) fresh = cheeky;
    }
    const q = fresh[Math.floor(this.#rng() * fresh.length)]!;
    this.seen.add(questionKey(q));
    return q;
  }
}

// ---------------------------------------------------------------------------
// Texts players type

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** One line: control and invisible characters gone, runs of spaces as one, trimmed. */
export function oneLine(text: string): string {
  return text.normalize("NFC").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/** The first letter as a capital, unless a number comes first (quotes and dashes may). */
export function capitalize(text: string): string {
  return text.replace(/^([^\p{L}\p{N}]*)(\p{L})/u, (_m, pre: string, c: string) => pre + c.toLocaleUpperCase());
}

/**
 * An answer as everyone sees it: one line, the first letter a capital,
 * no full stop at the end. Typing habits (all lower case, a final full
 * stop) would give the writer away every round; what is left is what
 * they wrote. `null`: nothing left.
 */
export function cleanAnswer(text: unknown): string | null {
  if (typeof text !== "string") return null;
  let t = oneLine(text);
  t = t.replace(/(?<![.])\.$/u, "").trim();
  if (t === t.toUpperCase() && / /.test(t) && (t.match(/\p{Lu}/gu) ?? []).length >= 6) t = t.toLowerCase();
  t = capitalize(t);
  if (!/[\p{L}\p{N}]/u.test(t)) return null;
  return [...t].slice(0, MAX_ANSWER).join("").trim();
}

/** A suggested question: one line, a capital first, ending in a question mark. */
export function cleanQuestion(text: unknown): string | null {
  if (typeof text !== "string") return null;
  let t = capitalize(oneLine(text));
  if ([...t].length > MAX_QUESTION) return null;
  if (!/[?!…]$/u.test(t)) t = `${t.replace(/[.,;:]+$/u, "")}?`;
  if ([...t].length < MIN_QUESTION || [...t].length > MAX_QUESTION) return null;
  return t;
}

/** A suggested title: one line, no closing punctuation; `null` when empty. */
export function cleanTitle(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = capitalize(oneLine(text).replace(/[.!?,;:]+$/u, "").trim());
  if (!t || [...t].length > MAX_TITLE) return null;
  return t;
}

/** The title when a vote question has none (a suggestion without one). */
export const DEFAULT_TITLE: Record<Lang, string> = { en: "Most Likely To", de: "Am ehesten" };

// ---------------------------------------------------------------------------
// Vote rounds: podiums and their tally

/** What the places of a podium are worth: gold, silver, bronze. */
export const MEDALS = [3, 2, 1] as const;

/** How many places a ballot has: three, or one fewer than the candidates (three candidates: gold and silver say it all). */
export function podiumSize(candidates: number): number {
  return Math.max(1, Math.min(MEDALS.length, candidates - 1));
}

/**
 * A ballot as sent (`{ podium: [id, …] }` or the list itself): distinct
 * candidates, one to `size` of them. Throws a message for the phone.
 */
export function readPodium(data: unknown, candidates: ReadonlySet<string>, size: number): string[] {
  const list = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as { podium?: unknown }).podium : data;
  if (!Array.isArray(list) || list.length === 0 || list.length > size) throw new Error(`Pick one to ${size}`);
  const out: string[] = [];
  for (const id of list) {
    if (typeof id !== "string" || !candidates.has(id)) throw new Error("Not a candidate");
    if (out.includes(id)) throw new Error("Once each");
    out.push(id);
  }
  return out;
}

export interface Tally {
  /** Points per candidate (every candidate, zeros included). */
  points: Map<string, number>;
  /** Gold medals per candidate. */
  golds: Map<string, number>;
  /** The candidates by points, then golds, then their order in `candidates`. */
  order: string[];
  /** Who wins the title: the most points, then the most golds; everyone still tied shares it. None without a point. */
  winners: string[];
  /** The room's top three: the first three of `order` with points, and anyone with as many points as the third. */
  top: string[];
}

export function tally(ballots: Iterable<readonly string[]>, candidates: readonly string[]): Tally {
  const points = new Map(candidates.map((c) => [c, 0]));
  const golds = new Map(candidates.map((c) => [c, 0]));
  for (const podium of ballots) {
    podium.forEach((id, place) => {
      if (!points.has(id)) return;
      points.set(id, points.get(id)! + (MEDALS[place] ?? 0));
      if (place === 0) golds.set(id, golds.get(id)! + 1);
    });
  }
  const pos = new Map(candidates.map((c, i) => [c, i]));
  const order = [...candidates].sort((a, b) => points.get(b)! - points.get(a)! || golds.get(b)! - golds.get(a)! || pos.get(a)! - pos.get(b)!);
  const same = (a: string, b: string) => points.get(a) === points.get(b) && golds.get(a) === golds.get(b);
  const first = order[0];
  const winners = first !== undefined && points.get(first)! > 0 ? order.filter((c) => same(c, first)) : [];
  const scored = order.filter((c) => points.get(c)! > 0);
  const third = scored[2];
  const top = third === undefined ? scored : scored.filter((c) => points.get(c)! >= points.get(third)!);
  return { points, golds, order, winners, top };
}

/** What a voter earns in a vote round. */
export interface VoteEarned {
  /** One per name on their podium in the room's top three. */
  room: number;
  /** Their gold went to a winner. */
  gold: number;
  /** They put themselves on gold and won. */
  self: number;
}

export const voteTotal = (e: VoteEarned): number => e.room + e.gold + e.self;

/** Reading the room: what each voter's podium earns against the tally. */
export function scoreVote(ballots: ReadonlyMap<string, readonly string[]>, t: Tally): Map<string, VoteEarned> {
  const out = new Map<string, VoteEarned>();
  for (const [voter, podium] of ballots) {
    const gold = podium[0];
    const won = gold !== undefined && t.winners.includes(gold);
    out.set(voter, {
      room: podium.filter((id) => t.top.includes(id)).length,
      gold: won ? 1 : 0,
      self: won && gold === voter ? 1 : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Answer rounds: anonymous cards, guesses, points

/** Answers each: two with three players (two names, four cards: more than a coin toss), else one. */
export function answersEach(players: number): number {
  return players <= 3 ? 2 : 1;
}

export interface Card {
  /** Its number on the TV (0-based), in the shuffled order. */
  id: number;
  author: string;
  text: string;
}

/** The answers as cards, shuffled (nobody's two cards next to each other where it can be helped). */
export function makeCards(answers: ReadonlyMap<string, readonly string[]>, rng: () => number): Card[] {
  const all = [...answers].flatMap(([author, texts]) => texts.map((text) => ({ author, text })));
  let best = shuffle(all, rng);
  for (let tries = 0; tries < 20; tries++) {
    if (best.every((c, i) => i === 0 || best[i - 1]!.author !== c.author)) break;
    best = shuffle(all, rng);
  }
  return best.map((c, id) => ({ id, ...c }));
}

/**
 * A guesser's matching (`{ guesses: { CARD: AUTHOR, … }, heart?: CARD }`):
 * only others' cards, only authors who are not the guesser, each author
 * at most `per` times (as many cards as they have). Cards left out are no
 * guess. Throws a message for the phone.
 */
export function readMatch(data: unknown, cards: readonly Card[], guesser: string, per: number): { guesses: Map<number, string>; heart: number | null } {
  const d = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as { guesses?: unknown; heart?: unknown }) : {};
  const raw = d.guesses ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("guesses: { card: author }");
  const authors = new Set(cards.map((c) => c.author));
  authors.delete(guesser);
  const guesses = new Map<number, string>();
  const uses = new Map<string, number>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(k);
    const card = cards.find((c) => c.id === id);
    if (!card || card.author === guesser) throw new Error("Not a card to guess");
    if (typeof v !== "string" || !authors.has(v)) throw new Error("Not one of the writers");
    const n = (uses.get(v) ?? 0) + 1;
    if (n > per) throw new Error(per === 1 ? "Each name once" : `Each name ${per} times at most`);
    uses.set(v, n);
    guesses.set(id, v);
  }
  let heart: number | null = null;
  if (d.heart !== undefined && d.heart !== null) {
    const card = cards.find((c) => c.id === d.heart);
    if (!card || card.author === guesser) throw new Error("Not a card to like");
    heart = card.id;
  }
  return { guesses, heart };
}

/** What a player earns in an answer round. */
export interface AnswerEarned {
  /** One per card they matched to its writer. */
  guess: number;
  /** One per wrong guess on their own cards. */
  fool: number;
}

export const answerTotal = (e: AnswerEarned): number => e.guess + e.fool;

export interface CardResult {
  card: Card;
  /** Who guessed whom: `[guesser, guessed author]`. */
  guesses: [string, string][];
  right: number;
  wrong: number;
  hearts: number;
  /** Most of those who guessed were right. */
  busted: boolean;
}

/**
 * Every guess is worth one point: to the guesser when right, to the
 * card's writer when wrong. Cards nobody guessed earn nothing.
 */
export function scoreMatch(cards: readonly Card[], matches: ReadonlyMap<string, { guesses: ReadonlyMap<number, string>; heart: number | null }>): { earned: Map<string, AnswerEarned>; results: CardResult[] } {
  const earned = new Map<string, AnswerEarned>();
  const of = (id: string) => {
    let e = earned.get(id);
    if (!e) earned.set(id, (e = { guess: 0, fool: 0 }));
    return e;
  };
  for (const c of cards) of(c.author);
  for (const g of matches.keys()) of(g);
  const results = cards.map((card) => {
    const guesses: [string, string][] = [];
    let hearts = 0;
    for (const [g, m] of matches) {
      const to = m.guesses.get(card.id);
      if (to !== undefined) guesses.push([g, to]);
      if (m.heart === card.id) hearts++;
    }
    const right = guesses.filter(([, to]) => to === card.author).length;
    const wrong = guesses.length - right;
    for (const [g, to] of guesses) {
      if (to === card.author) of(g).guess++;
      else of(card.author).fool++;
    }
    return { card, guesses, right, wrong, hearts, busted: right > 0 && right * 2 > guesses.length };
  });
  return { earned, results };
}

// ---------------------------------------------------------------------------
// Suggested questions and the room's ratings

/** Suggestions waiting per player. */
export const MAX_PENDING = 3;

export type Rating = 1 | -1;
export type SuggestionState = "pending" | "approved" | "dropped" | "played";

/**
 * Where a suggestion stands with `others` players who may rate it (all
 * but its author): approved with more 👍 than 👎 once at least half of
 * them rated it; dropped as soon as no ratings still to come can lift it
 * above zero. (A 🚫 drops it at once, before this.)
 */
export function ratingState(ups: number, downs: number, others: number): "pending" | "approved" | "dropped" {
  const rated = ups + downs;
  const open = Math.max(0, others - rated);
  if (ups - downs > 0 && rated >= Math.ceil(others / 2) && others > 0) return "approved";
  if (ups + open - downs <= 0 && rated > 0) return "dropped";
  return "pending";
}

export interface Rated {
  id: string;
  author: string;
  kind: Kind;
  seq: number;
  ups: number;
  downs: number;
  state: SuggestionState;
}

/**
 * The suggestion a round of `kind` plays: the approved one with the
 * highest score (👍 − 👎), the older one when tied; never the author of
 * the last suggestion played twice in a row. None: the deck's turn.
 */
export function pickSuggestion<T extends Rated>(list: readonly T[], kind: Kind, lastAuthor: string | null): T | undefined {
  return list
    .filter((s) => s.kind === kind && s.state === "approved" && s.author !== lastAuthor)
    .sort((a, b) => b.ups - b.downs - (a.ups - a.downs) || a.seq - b.seq)[0];
}
