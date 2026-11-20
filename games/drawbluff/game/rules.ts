/**
 * Drawbluff's rules as pure functions: drawings, titles, options, votes
 * and points. No I/O, no clocks; `game.ts` drives them.
 */

import { cleanText, PartyError } from "@tvpipe/party";

/**
 * The colours of a drawing without its own palette (index → CSS colour):
 * the fallback of the pages; a game's drawings carry their artist's
 * {@link palette}.
 */
export const PALETTE = ["#1d1d1f", "#ffffff", "#e5383b", "#f9a620", "#ffd60a", "#2a9d8f", "#3a86ff", "#8338ec"] as const;

/**
 * A drawing on a 1000×1000 grid: strokes of `[colour, width, x0, y0, x1,
 * y1, …]`, `colour` an index into `palette` (the artist's pens, set by
 * the host; {@link PALETTE} without one).
 */
export interface Drawing {
  strokes: number[][];
  palette?: string[];
}

// ---------------------------------------------------------------------------
// Colours: every player picks a colour and draws with pens made from it in
// OKLCH (perceptual lightness, chroma, hue), mapped into sRGB.

/** An OKLCH colour: lightness 0–1, chroma (0–~0.37), hue in degrees. */
export type Oklch = readonly [l: number, c: number, h: number];

/** OKLCH to sRGB (gamma-encoded, 0–1 per channel, may be out of range), after Björn Ottosson's Oklab. */
export function oklchToRgb([l, c, h]: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const gamma = (x: number) => (Math.abs(x) <= 0.0031308 ? 12.92 * x : Math.sign(x) * (1.055 * Math.abs(x) ** (1 / 2.4) - 0.055));
  return [gamma(lin[0]!), gamma(lin[1]!), gamma(lin[2]!)];
}

const inGamut = (rgb: readonly number[]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/**
 * An OKLCH colour as `#rrggbb`: out of the sRGB gamut, its chroma is
 * lowered (lightness and hue kept) until it fits.
 */
export function oklchHex(color: Oklch): string {
  const [l, c, h] = color;
  const L = clamp(l, 0, 1);
  let rgb = oklchToRgb([L, c, h]);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = Math.max(0, c);
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToRgb([L, mid, h]))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToRgb([L, lo, h]);
  }
  return `#${rgb.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** The colours a player can pick (OKLCH): red, orange, yellow, lime, green, teal, sky, blue, violet, pink. */
export const PLAYER_COLORS: readonly Oklch[] = [
  [0.63, 0.22, 27],
  [0.72, 0.18, 55],
  [0.86, 0.17, 95],
  [0.8, 0.2, 128],
  [0.65, 0.17, 150],
  [0.7, 0.12, 190],
  [0.72, 0.13, 235],
  [0.56, 0.2, 265],
  [0.56, 0.22, 300],
  [0.68, 0.21, 350],
];

/** The player colours as CSS colours (the picker's swatches). */
export function playerColors(): string[] {
  return PLAYER_COLORS.map(oklchHex);
}

/** The lightness of a player's two pens (dark, light). */
export const SHADES = [0.42, 0.76] as const;

/** Colour mode's four pens before they lean to the player's colour (red, yellow, green, blue), and black. */
export const FULL_COLORS: readonly Oklch[] = [
  [0.62, 0.21, 29],
  [0.85, 0.17, 92],
  [0.66, 0.17, 148],
  [0.55, 0.2, 262],
];
export const FULL_BLACK: Oklch = [0.24, 0.035, 0];
/** How far colour mode's pens move to the player's colour: of the hue's way, of the lightness's and chroma's. */
export const LEAN = { hue: 0.3, lc: 0.2 } as const;

/** `a` moved `t` of the way to `b` on the colour wheel (the short way round). */
function towards(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (((a + d * t) % 360) + 360) % 360;
}

/**
 * A player's pens (`#rrggbb`, index = a stroke's colour): their colour
 * dark and light; in colour mode black and four colours leaning towards
 * theirs (black tinted with its hue). An unknown colour: the first.
 */
export function palette(color: number, colorMode = false): string[] {
  const base = PLAYER_COLORS[color] ?? PLAYER_COLORS[0]!;
  const [bl, bc, bh] = base;
  if (!colorMode) return SHADES.map((l) => oklchHex([l, bc, bh]));
  const pens = FULL_COLORS.map(([l, c, h]): Oklch => [l + (bl - l) * LEAN.lc, c + (bc - c) * LEAN.lc, towards(h, bh, LEAN.hue)]);
  return [oklchHex([FULL_BLACK[0], FULL_BLACK[1], bh]), ...pens.map(oklchHex)];
}

export const GRID = 1000;
export const MAX_STROKES = 300;
export const MAX_POINTS = 12_000;
export const MAX_TITLE = 48;

/** Checks and normalises a drawing from a phone with `colors` pens (throws `PartyError("bad-drawing")`); its strokes only. */
export function validateDrawing(data: unknown, colors: number = PALETTE.length): Drawing {
  const bad = (why: string) => new PartyError("bad-drawing", `That drawing cannot be sent (${why})`);
  if (typeof data !== "object" || data === null || !Array.isArray((data as Drawing).strokes)) throw bad("no strokes");
  const strokes = (data as Drawing).strokes;
  if (strokes.length > MAX_STROKES) throw bad("too many strokes");
  let points = 0;
  const out: number[][] = [];
  for (const s of strokes) {
    if (!Array.isArray(s) || s.length < 4 || s.length % 2 !== 0) throw bad("a broken stroke");
    if (!s.every((v) => typeof v === "number" && Number.isFinite(v))) throw bad("not numbers");
    const [color, width, ...xy] = s as number[];
    if (!Number.isInteger(color) || color! < 0 || color! >= colors) throw bad("unknown colour");
    points += xy.length / 2;
    if (points > MAX_POINTS) throw bad("too many points");
    out.push([color!, clamp(Math.round(width!), 2, 120), ...xy.map((v) => clamp(Math.round(v), 0, GRID))]);
  }
  return { strokes: out };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** A title as typed: cleaned up for display (or "" when nothing is left). */
export function cleanTitle(text: unknown): string {
  return cleanText(text, MAX_TITLE);
}

/**
 * The longest lie a phone lets you type: the longest prompt
 * (`data/prompts.txt` stays within it), so a long title is no tell. The
 * host accepts up to {@link MAX_TITLE}.
 */
export const LIE_SOFT = 40;

/**
 * A title as the TV and the phones show it, the truth and the lies alike,
 * so formatting gives nothing away (the typed text is kept): quotes and
 * apostrophes unified (German „…“ too), commas gone but in numbers (a
 * German relative clause takes one, the prompts have none), spacing
 * collapsed, lowercase, no trailing `.`, `!`, `?`, `…`, no surrounding
 * quotes.
 */
export function displayTitle(text: string): string {
  let s = text
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/gu, '"')
    .replace(/(?<!\p{N}),|,(?!\p{N})/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  for (;;) {
    const was = s;
    s = s.replace(/[.!?\u2026]+$/u, "").trim();
    if (s.startsWith('"')) s = s.slice(1);
    if (s.endsWith('"')) s = s.slice(0, -1);
    if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1);
    s = s.trim();
    if (s === was) return s;
  }
}

/** The languages Drawbluff speaks (`data/prompts.txt`, `data/prompts.de.txt`); a room has one. */
export const LANGS = ["en", "de"] as const;
export type Lang = (typeof LANGS)[number];

/** A language tag (`de-AT`, `en`, …) as one of {@link LANGS}: German for `de…`, else English. */
export function pickLang(tag: unknown): Lang {
  return typeof tag === "string" && /^de\b/i.test(tag) ? "de" : "en";
}

/** The leading articles {@link titleKey} drops, per language. */
const ARTICLES: Record<Lang, RegExp> = {
  en: /^(a|an|the) /,
  de: /^(der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines) /,
};

/**
 * How titles compare, on their display form: case, accents, punctuation,
 * spacing and a leading article do not matter ("A nervous cactus!" =
 * "nervous cactus"); `ß` is `ss`, and in German `ä`, `ö`, `ü` are `ae`,
 * `oe`, `ue` ("Der Bär" = "baer"), elsewhere their letter ("café" =
 * "cafe").
 */
export function titleKey(text: string, lang: Lang = "en"): string {
  let s = displayTitle(text).normalize("NFC").replace(/ß/g, "ss");
  if (lang === "de") s = s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue");
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(ARTICLES[lang] ?? ARTICLES.en, "")
    .replace(/ /g, "");
}

/** One choice on the vote screen. */
export interface Option {
  id: string;
  text: string;
  /** The real title. */
  truth: boolean;
  /** Who wrote this lie (ids; several when their lies were the same). */
  authors: string[];
  /** A lie the game added (too few players' lies). */
  decoy: boolean;
}

/**
 * The options for one drawing: the truth, the players' lies (equal lies
 * merged), decoys from `spares` until there are at least `min`, in a
 * shuffled order; texts in their display form ({@link displayTitle}).
 */
export function buildOptions(
  truth: string,
  lies: ReadonlyMap<string, string>,
  spares: readonly string[],
  rng: () => number,
  min = 4,
  lang: Lang = "en",
): Option[] {
  const byKey = new Map<string, Option>();
  const truthKey = titleKey(truth, lang);
  let n = 0;
  for (const [author, text] of lies) {
    const k = titleKey(text, lang);
    if (!k || k === truthKey) continue; // refused when typed; never shown
    const o = byKey.get(k);
    if (o) o.authors.push(author);
    else byKey.set(k, { id: `o${++n}`, text: displayTitle(text), truth: false, authors: [author], decoy: false });
  }
  const options = [{ id: `o${++n}`, text: displayTitle(truth), truth: true, authors: [], decoy: false }, ...byKey.values()];
  for (const s of spares) {
    if (options.length >= min) break;
    const k = titleKey(s, lang);
    if (k === truthKey || byKey.has(k)) continue;
    byKey.set(k, { id: "", text: s, truth: false, authors: [], decoy: true });
    options.push({ id: `o${++n}`, text: displayTitle(s), truth: false, authors: [], decoy: true });
  }
  return shuffle(options, rng);
}

export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Points for one drawing. */
export interface Scoring {
  /** Points per player id, in the order they were first given. */
  points: Map<string, number>;
  /** Per option: who picked it. */
  voters: Map<string, string[]>;
  /** Per option: its exposure, how many counted voters were shown it. */
  seen: Map<string, number>;
}

export const POINTS = {
  /** A voter who found the truth. */
  guess: 1000,
  /** The artist, per voter who found the truth (scaled, see `share`). */
  artist: 1000,
  /** A liar, per voter who fell for the lie (scaled, see `share`). */
  fooled: 500,
  /** Each author of a lie several liars wrote ("same idea"). */
  same: 100,
} as const;

/** Voters beyond which points per voter are scaled down (today's most: 8 players). */
export const REF_VOTERS = 7;

/**
 * `n` voters' worth of `base` points out of `seen` who could have: `n ·
 * base` up to {@link REF_VOTERS}, else `n · base · 7 / seen`, rounded
 * half up (integers, the same in Rust).
 */
export function share(n: number, base: number, seen: number): number {
  if (seen <= REF_VOTERS) return n * base;
  return Math.floor((2 * n * base * REF_VOTERS + seen) / (2 * seen));
}

/**
 * Scores one drawing. `shown` is what each voter's phone offered (option
 * ids); `votes` are voter → option id. Votes of the artist, for one's own
 * lie, or for an option the voter was not shown count for nothing (and
 * the voter not as exposure). Round r counts r times.
 */
export function score(
  artist: string,
  options: readonly Option[],
  shown: ReadonlyMap<string, readonly string[]>,
  votes: ReadonlyMap<string, string>,
  round: number,
): Scoring {
  const points = new Map<string, number>();
  const voters = new Map<string, string[]>(options.map((o) => [o.id, []]));
  const seen = new Map<string, number>(options.map((o) => [o.id, 0]));
  const add = (id: string, n: number) => points.set(id, (points.get(id) ?? 0) + n * round);
  const counted: [string, Option][] = [];
  for (const [voter, optionId] of votes) {
    const mine = shown.get(voter);
    const o = options.find((x) => x.id === optionId);
    if (!o || !mine || !mine.includes(o.id) || voter === artist || o.authors.includes(voter)) continue;
    counted.push([voter, o]);
    voters.get(o.id)!.push(voter);
    for (const id of mine) if (seen.has(id)) seen.set(id, seen.get(id)! + 1);
  }
  for (const [voter, o] of counted) if (o.truth) add(voter, POINTS.guess);
  for (const o of options) {
    const n = voters.get(o.id)!.length;
    if (o.truth) {
      if (n > 0) add(artist, share(n, POINTS.artist, seen.get(o.id)!));
      continue;
    }
    if (n > 0) for (const a of o.authors) add(a, share(n, POINTS.fooled, seen.get(o.id)!));
    if (o.authors.length > 1) for (const a of o.authors) add(a, POINTS.same);
  }
  return { points, voters, seen };
}

// ---------------------------------------------------------------------------
// Scale: spotlights, liars, samples (docs/drawbluff-scale.md)

/** Spotlight drawings per round (all of them with fewer players). */
export const SPOTLIGHTS = 6;
/** Liars per drawing at most (8 options on the TV, as with 8 players). */
export const MAX_LIARS = 7;
/** Lies a phone shows at most (with the truth: 6 buttons). */
export const PHONE_LIES = 5;
/** From this many players the next drawing's liars write during the current vote. */
export const PIPELINE_FROM = 13;

/** How a round goes with `n` players. */
export interface Plan {
  /** Drawings that get lies, votes and a reveal on the TV. */
  spotlights: number;
  /** Liars per drawing. */
  liars: number;
  /** Whether the next drawing's liars write during the current vote. */
  pipelined: boolean;
}

export function plan(n: number): Plan {
  const spotlights = Math.max(0, Math.min(n, SPOTLIGHTS));
  if (n >= PIPELINE_FROM) return { spotlights, liars: Math.min(MAX_LIARS, Math.floor((n - 1) / 2)), pipelined: true };
  return { spotlights, liars: Math.max(0, Math.min(n - 1, MAX_LIARS)), pipelined: false };
}

/**
 * Takes `n` of `pool` by rotation: the lowest `key` first, ties at
 * random (a shuffle, then a stable sort).
 */
export function rotate(pool: readonly string[], key: (id: string) => number, n: number, rng: () => number): string[] {
  const order = shuffle(pool, rng);
  const keys = new Map(order.map((id) => [id, key(id)]));
  order.sort((a, b) => keys.get(a)! - keys.get(b)!);
  return order.slice(0, Math.max(0, n));
}

/** A drawing's liars: `first` (when in the pool), then by rotation on `lied` (lies so far). */
export function pickLiars(
  pool: readonly string[],
  lied: ReadonlyMap<string, number>,
  n: number,
  rng: () => number,
  first?: string,
): string[] {
  const head = first !== undefined && n > 0 && pool.includes(first) ? [first] : [];
  const rest = pool.filter((id) => !head.includes(id));
  return [...head, ...rotate(rest, (id) => lied.get(id) ?? 0, n - head.length, rng)];
}

/**
 * What each voter's phone shows: the truth and at most `max` lies (never
 * their own), in the options' order. With more lies than that, voters
 * are dealt in random order and each gets the lies dealt least so far
 * (ties at random), so every lie reaches as many voters as the others ±1.
 */
export function deal(options: readonly Option[], voters: readonly string[], max: number, rng: () => number): Map<string, string[]> {
  const dealt = new Map<string, number>(options.map((o) => [o.id, 0]));
  const out = new Map<string, string[]>();
  for (const v of shuffle(voters, rng)) {
    let lies = options.filter((o) => !o.truth && !o.authors.includes(v));
    if (lies.length > max) {
      lies = shuffle(lies, rng);
      lies.sort((a, b) => dealt.get(a.id)! - dealt.get(b.id)!);
      lies = lies.slice(0, max);
    }
    const ids = new Set(lies.map((o) => o.id));
    for (const id of ids) dealt.set(id, dealt.get(id)! + 1);
    out.set(
      v,
      options.filter((o) => o.truth || ids.has(o.id)).map((o) => o.id),
    );
  }
  return out;
}

/** The options a voter sees: all but the ones they wrote. */
export function optionsFor(voter: string, options: readonly Option[]): { id: string; text: string }[] {
  return options.filter((o) => !o.authors.includes(voter)).map((o) => ({ id: o.id, text: o.text }));
}

/**
 * The reveal order: lies nobody picked are skipped, the others from the
 * fewest to the most votes, the truth last.
 */
export function revealOrder(options: readonly Option[], voters: ReadonlyMap<string, string[]>): Option[] {
  const lies = options.filter((o) => !o.truth && (voters.get(o.id)?.length ?? 0) > 0);
  lies.sort((a, b) => (voters.get(a.id)!.length - voters.get(b.id)!.length));
  return [...lies, ...options.filter((o) => o.truth)];
}

// ---------------------------------------------------------------------------
// Prompts (docs/drawbluff-scale.md "Prompts")

/** A prompt to draw, its structure (`odd`, `idiom`, `moment`, …; "" for none) and its decoys. */
export interface Prompt {
  text: string;
  tag: string;
  /** Lies written for the prompt's drawing: the game's, when the players wrote too few. */
  decoys?: readonly string[] | undefined;
}

/**
 * Reads `data/prompts.txt`: `[tag]` starts a structure, then one prompt
 * per line, its decoys after it, each after `|` (all trimmed); blank
 * lines, lines without a prompt and `#` comments are skipped; prompts
 * before any `[tag]` have the tag "".
 */
export function parsePrompts(text: string): Prompt[] {
  const out: Prompt[] = [];
  let tag = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^\[([a-z]+)\]$/.exec(line);
    if (m) {
      tag = m[1]!;
      continue;
    }
    const [text, ...decoys] = line.split("|").map((s) => s.trim());
    if (text) out.push({ text, tag, decoys: decoys.filter((d) => d !== "") });
  }
  return out;
}

/**
 * Prompts in a row among which a structure appears at most once, when it
 * can: with 17 structures, a round of up to 8 players draws 8 kinds of
 * prompt.
 */
export const SPREAD = 8;

/**
 * Reorders `items` so that no tag comes twice among `window` in a row
 * where the rest allows it: each next item is the first one left whose
 * tag is not among the last `window - 1` taken, else not among the last
 * `window - 2`, …, else simply the first one left. Deterministic (shuffle
 * first for a random order); a stable no-op when every tag differs.
 */
export function spread<T>(items: readonly T[], tag: (item: T) => string, window = SPREAD): T[] {
  const rest = [...items];
  const out: T[] = [];
  const tags: string[] = [];
  while (rest.length > 0) {
    let at = 0;
    for (let w = Math.max(0, window - 1); w > 0; w--) {
      const recent = tags.slice(-w);
      const i = rest.findIndex((x) => !recent.includes(tag(x)));
      if (i >= 0) {
        at = i;
        break;
      }
    }
    const [item] = rest.splice(at, 1);
    out.push(item!);
    tags.push(tag(item!));
  }
  return out;
}

/**
 * A game's deck: the prompts shuffled, then spread by structure
 * ({@link spread}), reversed, so that `pop()` deals them in the spread
 * order (a round's prompts, one per player in join order, mix the
 * structures).
 */
export function deck(prompts: readonly Prompt[], rng: () => number, window = SPREAD): Prompt[] {
  return spread(shuffle(prompts, rng), (p) => p.tag, window).reverse();
}

/** Prompts a room's deck keeps undealt when it deals: the decoys come from them. */
export const DECK_RESERVE = 16;

/**
 * A room's deck, kept from game to game: it deals no prompt twice until
 * it dealt (or discarded) all of them. When fewer than a hand and
 * {@link DECK_RESERVE} are left, a new {@link deck} of the others goes
 * under the rest, so the rest comes first and nothing is dealt twice in
 * a row; with fewer prompts than a hand, prompts repeat.
 */
export class PromptDeck {
  readonly prompts: readonly Prompt[];
  readonly #rng: () => number;
  /** Undealt, the next one last (`pop()`). */
  #cards: Prompt[] = [];

  constructor(prompts: readonly Prompt[], rng: () => number) {
    if (prompts.length === 0) throw new Error("drawbluff: no prompts");
    this.prompts = prompts;
    this.#rng = rng;
  }

  /** The prompts not dealt yet, the next one first. */
  get left(): Prompt[] {
    return [...this.#cards].reverse();
  }

  /** The next `n` prompts. */
  deal(n: number): Prompt[] {
    if (this.#cards.length < n + DECK_RESERVE) this.#refill();
    const out: Prompt[] = [];
    while (out.length < n) {
      if (this.#cards.length === 0) this.#cards = deck(this.prompts, this.#rng);
      out.push(this.#cards.pop()!);
    }
    return out;
  }

  /** Takes prompts out of this pass (decoys shown on the TV): they are not dealt as prompts until the next one. */
  discard(texts: Iterable<string>): void {
    const gone = new Set(texts);
    this.#cards = this.#cards.filter((p) => !gone.has(p.text));
  }

  #refill(): void {
    const keep = new Set(this.#cards.map((p) => p.text));
    this.#cards = [...deck(this.prompts.filter((p) => !keep.has(p.text)), this.#rng), ...this.#cards];
  }
}

/** Prompts to fall back on as decoys (a drawing's own ran out): the spares of its own structure first, each part in its order. */
export function decoyOrder(spares: readonly Prompt[], tag: string): Prompt[] {
  return [...spares.filter((p) => p.tag === tag), ...spares.filter((p) => p.tag !== tag)];
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
