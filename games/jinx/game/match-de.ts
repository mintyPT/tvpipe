// Jinx: clue cleaning and duplicate ("jinx") matching for German.
//
// Erasable TypeScript, browser APIs only, no dependencies. The same API and
// the same reasons as match.ts (English); the rules and their reasons are in
// design/matching/de/SPEC.md, the known-answer table in test/match-de.test.ts.
//
// English gets by with rules: a handful of endings and a list of exceptions.
// German does not: every noun has its own plural (Hund/Hunde, Haus/Häuser,
// Mutter/Mütter, Museum/Museen), adjectives and verbs have dozens of forms
// (lief, gelaufen, läuft; größer, größte), and a rule that strips an -e or an
// -en finds Reis in Reise and Schal in Schale. So the forms come from a
// lexicon (data/dict.de.txt, from the German Wiktionary: every form of about
// 47,000 lemmas, and which lemma derives from which), and the rules only do
// what a lexicon cannot: compounds, which German writes as one word and makes
// up on the spot (Schneemänner is Schneemann's plural because Männer is
// Mann's), and words the lexicon does not know.
//
//   clean(raw)                    phone input -> Clue (or an input error)
//   sameClue(a, b, opt)           do two clues jinx? -> Reason | null
//   invalidClue(clue, secret)     is a clue too close to the secret word?
//   judgeGuess(guess, secret)     is the typed guess the secret word?
//   groupClues(clues, secret)     struck clues + jinx groups (transitive)
//   checkSubmit(raw, secret)      the phone's submit, with a German message
//   dictionary(text)              dict.de.txt -> MatchOptions (lexicon, known)
//
// Keys keep ä, ö, ü and ß ("Bär" -> "bär"); "Baer", "Strasse" or "Bar" for
// Bär are other spellings, found by comparing spelled forms (spell()).

import { clean as cleanEn, nearTranslation, parseWordList, sameClue as sameClueEn } from "./match.ts";
import type { Clue, Cleaned, CleanError, Link, MatchOptions, Reason, RoundResult, SubmitResult } from "./match.ts";

export { parseWordList };
export type { Clue, Cleaned, Reason, RoundResult, SubmitResult };

/** A lookup table without a prototype: typed words like "constructor" are not in it. */
function table<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

export const MAX_CHARS = 24;
export const MAX_WORDS = 2;

/** Short text for the TV, e.g. `Hunde = Hund · Plural`. */
export const REASON_TEXT: Record<Reason, string> = {
  "same word": "gleiches Wort",
  "same number": "gleiche Zahl",
  spelling: "andere Schreibweise",
  plural: "Plural",
  "verb form": "Verbform",
  "word form": "andere Form",
  "same family": "Wortfamilie",
  typo: "Tippfehler",
  "sounds the same": "klingt gleich",
  "contains the word": "enthält das Wort",
  "part of the word": "Teil des Wortes",
  backwards: "rückwärts",
  "too close": "zu nah",
};

/** TV line for a pair: "Hunde = Hund · Plural", "Schokolode ≈ Schokolade · Tippfehler". */
export function explain(a: Clue, b: Clue, r: Reason): string {
  const sign = r === "typo" || r === "sounds the same" || r === "spelling" || r === "backwards" ? "≈" : r === "contains the word" ? "⊃" : r === "part of the word" ? "⊂" : "=";
  return `${a.display} ${sign} ${b.display} · ${REASON_TEXT[r]}`;
}

/** MatchOptions with the lexicon (`dictionary(text)` gives both). */
export interface DeOptions extends MatchOptions {
  lexicon?: Lexicon | undefined;
  /**
   * The English dictionary (the host page has every language's): an English
   * word is a word, never a German word in disguise (tall is not Tal
   * stretched, repo not Oper backwards), and the typos of an English
   * translation are measured with it (monky for monkey, not shirt for short).
   */
  englishKnown?: ((word: string) => boolean) | undefined;
}

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

const MESSAGES: Record<CleanError, string> = {
  empty: "Schreib einen Hinweis",
  "too-long": `Zu lang (höchstens ${MAX_CHARS} Zeichen)`,
  "too-many-words": "Ein Wort bitte (höchstens zwei, für Namen)",
  "not-english": "Nur Buchstaben und Ziffern",
};

const FOLD: Record<string, string> = { æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i", ĸ: "k" };
const UMLAUT_IN: Record<string, string> = { ä: "\u0001", ö: "\u0002", ü: "\u0003" };
const UMLAUT_OUT: Record<string, string> = { "\u0001": "ä", "\u0002": "ö", "\u0003": "ü" };

/**
 * A word as the German key writes it: lowercase, ä ö ü ß kept, other
 * diacritics off (Café = cafe, Niño = nino). Also used by the lexicon
 * builder (design/matching/de/build-lexicon.ts), so keys and dictionary agree.
 */
export function foldWord(s: string): string {
  let f = s.normalize("NFC").toLowerCase().replace(/ẞ/g, "ß");
  f = f.replace(/[æœøłđðþıĸ]/g, (c) => FOLD[c] ?? c);
  // Keep the umlauts through NFD: protect, strip the marks, restore.
  f = f.replace(/[äöü]/g, (c) => UMLAUT_IN[c]!);
  f = f.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
  return f.replace(/[\u0001-\u0003]/g, (c) => UMLAUT_OUT[c]!);
}

/** A single symbol typed as the whole clue reads as its name. */
const SYMBOL_NAMES: Record<string, string> = table({
  $: "dollar",
  "€": "euro",
  "£": "pfund",
  "¥": "yen",
  "%": "prozent",
  "&": "und",
  "+": "plus",
  "@": "at",
  "°": "grad",
  "§": "paragraf",
});

const EMOJI_EXTRA = /[\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu;

/** Articles that do not make a different clue: "der Hund", "eine Katze", "am besten". */
const LEADING = new Set(["der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "eines", "am"]);

/** Particles of separable verbs: "steht auf" is "aufsteht", a form of aufstehen. */
const PARTICLES = new Set(
  "ab an auf aus bei ein fest fort her hin los mit nach vor weg zu zurück zusammen weiter heim hoch runter rauf raus rein rüber um durch über unter wieder".split(" "),
);

function fail(error: CleanError): Cleaned {
  return { ok: false, error, message: MESSAGES[error] };
}

export function clean(raw: string): Cleaned {
  let s = raw.normalize("NFKC");
  s = s.replace(/[\u200B\u200C\u2060\uFEFF\u00AD]/g, ""); // invisible (keeps U+200D for emoji)
  s = s.replace(/[\u2018\u2019\u201B\u02BC\u0060\u00B4]/g, "'");
  s = s.replace(/[\u2010-\u2015\u2212]/g, "-");
  s = s.replace(/\s+/gu, " ").trim();
  if (s === "") return fail("empty");
  const display = s.normalize("NFC");
  if ([...display].length > MAX_CHARS) return fail("too-long");

  const f = foldWord(s);
  const words = f.split(" ");
  const tokens = f.split(/[ \-_/]+/).filter((t) => t !== "");

  let parts: string[] = [];
  let decor = "";
  for (const t of tokens) {
    const symbolName = SYMBOL_NAMES[t];
    if (symbolName !== undefined) {
      parts.push(symbolName);
      continue;
    }
    // "3." is an ordinal: the dot stays (3. = dritte).
    if (/^\d+\.$/.test(t)) {
      parts.push(t);
      continue;
    }
    const pictures = t.match(/[\p{Extended_Pictographic}\p{S}\u{1F1E6}-\u{1F1FF}\u200D]/gu);
    if (pictures) decor += pictures.join("");
    const rest = t.replace(/[\p{Extended_Pictographic}\p{S}\p{P}\u{1F1E6}-\u{1F1FF}\u200D\uFE0E\uFE0F]/gu, "");
    if (rest === "") continue;
    if (!/^[a-zäöüß0-9]+$/.test(rest)) return fail("not-english");
    parts.push(rest);
  }

  if (parts.length === 0) {
    const sym = decor.replace(EMOJI_EXTRA, "").replace(/\u200D/g, "");
    if (sym === "") return fail("empty");
    return { ok: true, clue: { display, key: "~" + collapseRuns(sym), parts: [], kind: "symbol" } };
  }
  const wordCount = words.filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (wordCount > MAX_WORDS) return fail("too-many-words");

  parts = parts.map(collapseRuns);
  if (parts.length > 1 && LEADING.has(parts[0]!)) parts = parts.slice(1);
  // "steht auf", "mach zu": the particle goes in front, as German writes the verb.
  if (parts.length === 2 && wordCount === 2 && PARTICLES.has(parts[1]!) && !PARTICLES.has(parts[0]!)) parts = [parts[1]!, parts[0]!];
  parts = numberParts(parts);
  const key = parts.join("");
  const kind = /^\d+\.?$/.test(key) ? "number" : "word";
  return { ok: true, clue: { display, key, parts, kind } };
}

/** "Brrrr" -> "brr", "Hmmmm" -> "hmm": three or more of a letter become two. */
function collapseRuns(s: string): string {
  return s.replace(/(.)\1{2,}/gu, "$1$1");
}

/** Clean or throw; convenient for tests and tools. */
export function clue(raw: string): Clue {
  const c = clean(raw);
  if (!c.ok) throw new Error(`clean(${JSON.stringify(raw)}): ${c.error}`);
  return c.clue;
}

// ---- number words ---------------------------------------------------------

const UNITS: Record<string, number> = table({ ein: 1, eins: 1, eine: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9 });
const TEENS: Record<string, number> = table({
  zehn: 10,
  elf: 11,
  zwölf: 12,
  dreizehn: 13,
  vierzehn: 14,
  fünfzehn: 15,
  sechzehn: 16,
  siebzehn: 17,
  achtzehn: 18,
  neunzehn: 19,
});
const TENS: Record<string, number> = table({ zwanzig: 20, dreißig: 30, dreissig: 30, vierzig: 40, fünfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90 });
const UNIT_RE = "(ein|zwei|zwo|drei|vier|fünf|sechs|sieben|acht|neun)";
const SMALL_RE = new RegExp(`^(?:${UNIT_RE}und)?(${Object.keys(TENS).join("|")})$`);

/** 1–99 in words, or null. */
function small(s: string): number | null {
  if (s in UNITS && s !== "ein" && s !== "eine") return UNITS[s]!;
  if (s in TEENS) return TEENS[s]!;
  const m = s.match(SMALL_RE);
  if (m) return (m[1] ? UNITS[m[1]]! : 0) + TENS[m[2]!]!;
  return null;
}

/** 1–999 in words: "dreihundertzwölf", "hundert", "einhunderteins". */
function belowThousand(s: string): number | null {
  const i = s.indexOf("hundert");
  if (i < 0) return small(s);
  const head = s.slice(0, i);
  const tail = s.slice(i + 7);
  const h = head === "" || head === "ein" ? 1 : small(head);
  if (h === null) return null; // (neunzehnhundert: 1900)
  const t = tail === "" ? 0 : tail === "eins" ? 1 : small(tail);
  return t === null ? null : h * 100 + t;
}

/** "einundzwanzig", "zweitausendvierundzwanzig", "null" -> digits; null unless the whole string is a number. */
export function parseNumberWords(s: string): string | null {
  if (s === "null") return "0";
  const i = s.indexOf("tausend");
  if (i < 0) {
    const n = belowThousand(s);
    return n === null ? null : String(n);
  }
  const head = s.slice(0, i);
  const tail = s.slice(i + 7);
  const h = head === "" || head === "ein" ? 1 : belowThousand(head);
  const t = tail === "" ? 0 : tail === "eins" ? 1 : belowThousand(tail);
  return h === null || t === null ? null : String(h * 1000 + t);
}

const ORDINAL_SPECIAL: Record<string, number> = table({ erst: 1, dritt: 3, siebt: 7, acht: 8 });

/** "erste", "dritter", "zwanzigste", "hundertstes" -> "1.", "3.", "20.", "100.". */
function ordinal(s: string): string | null {
  const w = s.replace(/(?<=te)[rs]$/, "");
  if (!w.endsWith("te")) return null;
  const stem = w.slice(0, -1); // erst-e, zweit-e, zwanzigst-e
  if (stem in ORDINAL_SPECIAL) return ORDINAL_SPECIAL[stem] + ".";
  // zweite (zwei-te), zwanzigste (zwanzig-ste), hundertste
  const n = stem.endsWith("st") && stem.length > 4 ? parseNumberWords(stem.slice(0, -2)) : stem.endsWith("t") ? parseNumberWords(stem.slice(0, -1)) : null;
  return n === null || n === "0" || n === "1" ? null : n + ".";
}

const SCALES: Record<string, number> = table({ million: 1e6, millionen: 1e6, milliarde: 1e9, milliarden: 1e9 });

function numberParts(parts: string[]): string[] {
  // "zwei Millionen", "eine Million"
  if (parts.length === 2 && parts[1]! in SCALES) {
    const n = parts[0] === "ein" || parts[0] === "eine" ? "1" : (parseNumberWords(parts[0]!) ?? (/^\d+$/.test(parts[0]!) ? parts[0]! : null));
    if (n !== null) return [String(Number(n) * SCALES[parts[1]!]!)];
  }
  if (parts.length === 1 && parts[0]! in SCALES) return [String(SCALES[parts[0]!])];
  const whole = parts.join("");
  const w = parseNumberWords(whole) ?? ordinal(whole);
  if (w !== null && !/^(ein|eine)$/.test(whole)) return [w];
  return parts.map((p) => (/^(ein|eine)$/.test(p) ? p : (parseNumberWords(p) ?? ordinal(p) ?? p)));
}

// ---------------------------------------------------------------------------
// The lexicon (data/dict.de.txt)
// ---------------------------------------------------------------------------

/** How a form relates to its lemma. */
type Kind = "self" | "plural" | "verb form" | "word form";

export interface Lexicon {
  /** A stored form -> its lemmas: `lemma kind` pairs. */
  readonly forms: Map<string, [string, Kind][]>;
  /** Declension bases (adjectives, comparatives, participles) -> lemmas; + e/em/en/er/es. */
  readonly bases: Map<string, [string, Kind][]>;
  /** Lemma -> parts of speech ("n", "v", "a", "e", "x"; "n*" a noun declined like an adjective). */
  readonly pos: Map<string, string[]>;
  /** Lemma -> the lemmas it derives from. */
  readonly family: Map<string, string[]>;
  /** Lemma -> what it is made of (Schnee, Mann); null: no compound (a derivation, a loan); absent: unknown. */
  readonly parts: Map<string, string[] | null>;
}

const DECL = ["e", "em", "en", "er", "es"];

function decode(key: string, enc: string): string {
  const m = enc.match(/^(\d*)(.*)$/)!;
  const drop = m[1] ? Number(m[1]) : 0;
  return key.slice(0, key.length - drop) + m[2];
}

function push<K, V>(map: Map<K, V[]>, k: K, v: V): void {
  const a = map.get(k);
  if (a) a.push(v);
  else map.set(k, [v]);
}

/**
 * Parse dict.de.txt: `lemma<TAB>pos<TAB>forms<TAB>family<TAB>parts`, one line per
 * lemma and part of speech. Forms are written against the lemma: a number of
 * letters to drop from its end, then the rest ("hund": "e" is hunde; "haus":
 * "3äuser" is häuser). Nouns and names: `singular forms|plural forms`; verbs:
 * `finite forms|participles` (participles decline: gelaufene); adjectives: the
 * declension bases besides the lemma (comparative, superlative: röter, rötest).
 * Family: the lemmas it derives from. Parts: what a compound is made of
 * (schnee+mann), or "-" for a word that is no compound.
 */
export function lexicon(text: string): Lexicon {
  const lex: Lexicon = { forms: new Map(), bases: new Map(), pos: new Map(), family: new Map(), parts: new Map() };
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const [key, pos, formText, fam, parts] = line.split("\t") as [string, string, string | undefined, string | undefined, string | undefined];
    push(lex.pos, key, pos);
    push(lex.forms, key, [key, "self"]);
    const p = pos[0];
    const [one, two] = (formText ?? "").split("|");
    const list = (s: string | undefined) => (s ? s.split(",").map((e) => decode(key, e)) : []);
    if (p === "n" || p === "e") {
      for (const f of list(one)) push(lex.forms, f, [key, "word form"]);
      for (const f of list(two)) push(lex.forms, f, [key, "plural"]);
      if (pos === "n*") push(lex.bases, key.replace(/(e|er|es)$/, ""), [key, "word form"]);
    } else if (p === "v") {
      for (const f of list(one)) push(lex.forms, f, [key, "verb form"]);
      for (const f of list(two)) {
        push(lex.forms, f, [key, "verb form"]);
        push(lex.bases, f, [key, "verb form"]);
      }
    } else if (p === "a") {
      push(lex.bases, key, [key, "self"]);
      for (const f of list(one)) {
        // A superlative base is only a base: rötest-e, not "rötest" (and herbst is not herb's).
        if (!f.endsWith("st")) push(lex.forms, f, [key, "word form"]);
        push(lex.bases, f, [key, "word form"]);
      }
    }
    if (fam) lex.family.set(key, [...(lex.family.get(key) ?? []), ...fam.split(",")]);
    if (parts === "-") {
      if (!lex.parts.has(key)) lex.parts.set(key, null);
    } else if (parts) lex.parts.set(key, parts.split("+"));
  }
  return lex;
}

/** MatchOptions from dict.de.txt: the lexicon, and `known` for typos. */
export function dictionary(text: string): DeOptions {
  const lex = lexicon(text);
  return { lexicon: lex, known: (w) => forms(w, { lexicon: lex }).known };
}

/** Lemma readings of a word the lexicon knows (empty if it does not). */
function lookup(w: string, lex: Lexicon): Map<string, Kind> {
  const out = new Map<string, Kind>();
  const add = (lemma: string, kind: Kind) => {
    const was = out.get(lemma);
    if (was === undefined || was === "self" ? was === undefined : rank(kind) < rank(was)) out.set(lemma, kind);
  };
  for (const [l, k] of lex.forms.get(w) ?? []) add(l, k);
  for (const d of DECL) {
    if (!w.endsWith(d) || w.length - d.length < 2) continue;
    for (const [l, k] of lex.bases.get(w.slice(0, -d.length)) ?? []) {
      // A declined form that is a noun or a verb of its own is that word:
      // "Taube" is not "taub" declined, "Rinde" not "rind".
      if (l !== w && independent(w, l, lex)) continue;
      add(l, k === "self" ? "word form" : k);
    }
  }
  return out;
}

function rank(k: Kind): number {
  return k === "self" ? 0 : k === "plural" ? 1 : k === "verb form" ? 2 : 3;
}

/** `w` is a noun, verb or adjective lemma that is not of `lemma`'s family (lecker is not leck + er). */
function independent(w: string, lemma: string, lex: Lexicon): boolean {
  const ps = lex.pos.get(w);
  if (!ps || !ps.some((p) => p === "n" || p === "v" || p === "a")) return false;
  return !familyOf([w], lex).has(lemma) && !familyOf([lemma], lex).has(w);
}

function familyOf(lemmas: Iterable<string>, lex: Lexicon): Set<string> {
  const out = new Set<string>();
  let frontier = [...lemmas];
  for (const l of frontier) out.add(l);
  // Two steps up: Bäckerei -> Bäcker -> backen.
  for (let depth = 0; depth < 2; depth++) {
    const next: string[] = [];
    for (const l of frontier) for (const b of lex.family.get(l) ?? []) if (!out.has(b)) (out.add(b), next.push(b));
    frontier = next;
  }
  return out;
}

/** Fugen elements: what may sit between the parts of a compound (Sonne-n-blume, Arbeit-s-platz, Hund-e-hütte). */
const FUGEN = ["s", "es", "n", "en", "e", "er", "ens", "ns"];

/**
 * A content word: a noun, adjective or verb, or a noun's or adjective's form
 * (Kinder, rote); not a function word (mat, bam), a name or a finite verb
 * form (zeig, kam, wich), which are no parts of compounds.
 */
function content(w: string, lex: Lexicon): boolean {
  for (const [l, k] of lookup(w, lex)) {
    if (k === "verb form") continue;
    if ((lex.pos.get(l) ?? []).some((p) => p[0] === "n" || p[0] === "a" || p[0] === "v")) return true;
  }
  return false;
}

/** The first part of a compound: a content word, with or without Fugen (Arbeits-, Sonnen-), a noun without its -e (Schul-bus), a verb stem (Back-ofen) or a particle (Vor-garten). */
function modifier(m: string, lex: Lexicon, depth = 0): boolean {
  if (m.length < 2) return false;
  if (PARTICLES.has(m)) return true;
  if (m.length >= 3 && content(m, lex)) return true;
  for (const f of FUGEN) if (m.length - f.length >= 3 && m.endsWith(f) && content(m.slice(0, -f.length), lex)) return true;
  if (m.length >= 3 && (lex.forms.get(m + "e") ?? []).some(([l]) => l === m + "e")) return true; // Schul-, Kirch-
  if (m.length >= 3 && (lex.pos.get(m + "en") ?? []).includes("v")) return true; // Back-ofen, Wasch-maschine
  if (m.length >= 3 && (lex.pos.get(m + "n") ?? []).includes("v")) return true; // Wander-weg
  return depth === 0 && m.length >= 6 && compound(m, lex, 1) !== null;
}

interface Split {
  head: string;
  mod: string;
  readings: Map<string, Kind>;
}

const SPLIT_CACHE = new Map<string, Split | null>();

/**
 * A compound the lexicon does not know as a whole: the longest known word at
 * the end (the head, which German inflects) after a known first part.
 * Schneemänner = schnee + männer (Mann, plural).
 */
function compound(w: string, lex: Lexicon, depth = 0): Split | null {
  const id = depth + w;
  const hit = SPLIT_CACHE.get(id);
  if (hit !== undefined) return hit;
  let out: Split | null = null;
  for (let i = 2; i <= w.length - 3; i++) {
    const head = w.slice(i);
    if (!content(head, lex)) continue;
    const readings = lookup(head, lex);
    const mod = w.slice(0, i);
    if (!modifier(mod, lex, depth)) continue;
    out = { head, mod, readings };
    break;
  }
  if (SPLIT_CACHE.size > 50000) SPLIT_CACHE.clear();
  SPLIT_CACHE.set(id, out);
  return out;
}

// ---------------------------------------------------------------------------
// Forms of a word, cached
// ---------------------------------------------------------------------------

interface Forms {
  key: string;
  /** spelled the plain way: ä = ae, ß = ss, ph = f, … */
  spell: string;
  /** lemmas -> how the word relates to them ("self" for a lemma) */
  infl: Map<string, Kind>;
  /** lemmas and what they derive from (two steps up), and family group ids */
  fam: Set<string>;
  /** what the lemmas derive from directly (siblings: Fahrer and Fahrt both from fahren) */
  parents: Set<string>;
  /** the lemmas the family is reckoned from: the word itself if it is one, else its lemmas */
  own: string[];
  /** the word known to the lexicon, or a compound of known words with a noun at the end (Flugzeug; not Flug + zeig) */
  known: boolean;
  /** the word is a lemma of the lexicon (Reise, Reis), not only a form of one */
  lemma: boolean;
  /** what typos are measured on: the word and the lemmas it is a plural of */
  typo: string[];
  /** the lexicon's spelling of a word typed without umlauts or ß (Konig: könig) */
  re?: string;
}

const CACHE = new WeakMap<object, Map<string, Forms>>();
const NO_LEXICON = {};

/** Rule-based readings for words outside the lexicon: endings off (Zwergs, Xylofone). */
function guessReadings(w: string): Map<string, Kind> {
  const out = new Map<string, Kind>([[w, "self"]]);
  if (w.length < 4 || !/^[a-zäöüß]+$/.test(w)) return out;
  for (const e of ["s", "es", "n", "en", "e", "er", "ern", "nen"]) {
    if (w.endsWith(e) && w.length - e.length >= 3) out.set(w.slice(0, -e.length), "plural");
  }
  return out;
}

/** Country names and their people and adjectives (no suffix reaches Frankreich from französisch). */
const FAMILY_GROUPS: string[][] = (
  "frankreich franzose französin französisch|deutschland deutsche deutscher deutsch|england engländer engländerin englisch|" +
  "spanien spanier spanierin spanisch|italien italiener italienerin italienisch|griechenland grieche griechin griechisch|" +
  "türkei türke türkin türkisch|holland niederlande holländer niederländer holländisch niederländisch|" +
  "schweiz schweizer schweizerin schweizerisch|österreich österreicher österreicherin österreichisch|" +
  "polen pole polin polnisch|russland russe russin russisch|china chinese chinesin chinesisch|japan japaner japanerin japanisch|" +
  "amerika amerikaner amerikanerin amerikanisch|afrika afrikaner afrikanerin afrikanisch|europa europäer europäerin europäisch|" +
  "schweden schwede schwedin schwedisch|dänemark däne dänin dänisch|norwegen norweger norwegerin norwegisch|" +
  "finnland finne finnin finnisch|ungarn ungar ungarin ungarisch|tschechien tscheche tschechin tschechisch|" +
  "indien inder inderin indisch|ägypten ägypter ägypterin ägyptisch|mexiko mexikaner mexikanerin mexikanisch|" +
  "brasilien brasilianer brasilianerin brasilianisch|irland ire irin irisch|schottland schotte schottin schottisch|" +
  "portugal portugiese portugiesin portugiesisch|belgien belgier belgierin belgisch|kanada kanadier kanadierin kanadisch|" +
  "australien australier australierin australisch|arabien araber araberin arabisch|asien asiate asiatin asiatisch|" +
  "gut besser beste am|viel mehr meiste|hoch höher höchste|nah näher nächste|" +
  "gehen gang|stehen stand|singen gesang sänger|fliegen flug flieger|springen sprung|ziehen zug|trinken trank getränk|" +
  "schneiden schnitt|reiten ritt reiter|greifen griff|schließen schlüssel|binden band bund|sitzen sitz|" +
  "werfen wurf|treffen treff|helfen hilfe helfer|sprechen sprache|geben gabe|sehen sicht|wachsen wuchs|graben grab grube"
)
  .split("|")
  .map((g) => g.split(" "));

const FAMILY_ID = new Map<string, string[]>();
FAMILY_GROUPS.forEach((g, i) => g.forEach((w) => push(FAMILY_ID, w, "#" + i)));

export function forms(key: string, opt: DeOptions = {}): Forms {
  const lex = opt.lexicon;
  const scope = lex ?? NO_LEXICON;
  let cache = CACHE.get(scope);
  if (!cache) CACHE.set(scope, (cache = new Map()));
  const hit = cache.get(key);
  if (hit) return hit;

  let infl: Map<string, Kind>;
  let fam: Set<string>;
  let parents = new Set<string>();
  let own: string[] = [key];
  let isKnown = false;
  let isLemma = false;
  if (!lex) {
    infl = guessReadings(key);
    fam = new Set(infl.keys());
    own = [...infl.keys()];
  } else {
    infl = lookup(key, lex);
    const re = infl.size === 0 ? respell(key, lex) : null;
    if (re) {
      // Written without umlauts or with ss (Konigin, vergrössern): the word's own forms.
      const base = forms(re, opt);
      const f: Forms = { ...base, key, spell: spell(key), infl: new Map([...base.infl, [key, "self"]]), typo: [key, ...base.typo], re };
      cache.set(key, f);
      return f;
    }
    if (infl.size > 0) {
      isKnown = true;
      isLemma = infl.get(key) === "self";
      // A word of its own has its own family: Rate (the instalment) is also "ich
      // rate", but raten's family is not Rate's.
      own = isLemma ? [key] : [...infl.keys()];
      fam = familyOf(own, lex);
      for (const l of own) for (const p of lex.family.get(l) ?? []) parents.add(p);
    } else {
      const c = compound(key, lex);
      // A female form the lexicon does not list: Bergsteigerin(nen) is Bergsteiger's.
      const m = key.match(/^(.{4,}?)(in|innen)$/);
      if (m && (lookup(m[1]!, lex).size > 0 || compound(m[1]!, lex))) {
        isKnown = true;
        infl = new Map([[key, "self"]]);
        if (m[2] === "innen") infl.set(m[1] + "in", "plural");
        fam = new Set(infl.keys());
        own = [...infl.keys()];
        for (const x of [m[1]!, ...forms(m[1]!, opt).fam]) fam.add(x);
        parents.add(m[1]!);
      } else if (c) {
        // Schneemänner: Schnee + Mann (plural) -> Schneemann (plural); the
        // compound itself is a lemma too (its own singular).
        isKnown = [...c.readings.keys()].some((l) => (lex.pos.get(l) ?? []).some((p) => p[0] === "n"));
        infl = new Map([[key, "self"]]);
        // A compound with a noun at the end inflects as a noun (Minirock is no "minirocken").
        const nounHead = (lex.pos.get(c.head) ?? []).includes("n");
        for (const [l, k] of c.readings) if (k !== "self" && !(nounHead && k === "verb form")) infl.set(c.mod + l, k);
        fam = new Set(infl.keys());
        own = [...infl.keys()];
        for (const x of familyOf(c.readings.keys(), lex)) fam.add(c.mod + x);
        for (const l of c.readings.keys()) for (const p of lex.family.get(l) ?? []) parents.add(c.mod + p);
      } else {
        infl = guessReadings(key);
        fam = new Set(infl.keys());
        own = [...infl.keys()];
      }
    }
  }
  for (const l of [...fam]) for (const id of FAMILY_ID.get(l) ?? []) fam.add(id);
  if (!infl.has(key)) infl.set(key, "self");
  const typo = [key, ...[...infl].filter(([l, k]) => k === "plural" && l !== key).map(([l]) => l)];
  const f: Forms = { key, spell: spell(key), infl, fam, parents, own, known: isKnown, lemma: isLemma, typo };
  if (cache.size > 100000) cache.clear();
  cache.set(key, f);
  return f;
}

/**
 * The lexicon's spelling of a word typed without umlauts or ß: ae/oe/ue for
 * ä/ö/ü, ss for ß, or a plain vowel for an umlaut (one at a time). Null if
 * none, or more than one, is a word.
 */
function respell(w: string, lex: Lexicon): string | null {
  if (!/^[a-zäöüß]+$/.test(w) || w.length < 4) return null;
  const tries = new Set<string>();
  const ae = w.replace(/ae/g, "ä").replace(/oe/g, "ö").replace(/ue/g, "ü");
  if (ae !== w) tries.add(ae);
  for (const v of [w, ae]) {
    for (let i = v.indexOf("ss"); i >= 0; i = v.indexOf("ss", i + 1)) tries.add(v.slice(0, i) + "ß" + v.slice(i + 2));
  }
  if (tries.size === 0 || ![...tries].some((t) => lookup(t, lex).size > 0)) {
    for (let i = 0; i < w.length; i++) {
      const u = UMLAUT_OF[w[i]!];
      if (u && w[i + 1] !== "u" && w[i - 1] !== "e") tries.add(w.slice(0, i) + u + w.slice(i + 1));
    }
  }
  const hits = [...tries].filter((t) => lookup(t, lex).size > 0);
  return hits.length === 1 ? hits[0]! : null;
}

const UMLAUT_OF: Record<string, string> = { a: "ä", o: "ö", u: "ü" };

// ---------------------------------------------------------------------------
// Spelling and sound
// ---------------------------------------------------------------------------

/** Old and new, German and foreign spellings of one word (both sides go through spell()). */
const SPELLING_TABLE: Record<string, string> = table(Object.fromEntries(
  (
    "jogurt:joghurt ketschup:ketchup portmonee:portemonnaie majonäse:mayonnaise majonaese:mayonnaise spagetti:spaghetti " +
    "känguruh:känguru panter:panther tunfisch:thunfisch schi:ski frisör:friseur frisoer:friseur grislibär:grizzlybär " +
    "kollier:collier creme:krem kreme:krem soße:sauce sosse:sauce ketschups:ketchups buljong:bouillon " +
    "club:klub circus:zirkus nougat:nugat jacht:yacht " +
    "delphin:delfin photo:foto telephon:telefon tschüs:tschüss tschüß:tschüss"
  )
    .split(/\s+/)
    .map((p) => p.split(":") as [string, string]),
));

/** The plain spelling: ä = ae, ß = ss, ph = f, th = t, foreign c = k or z; equal spellings are "other spelling". */
export function spell(w: string): string {
  let s = SPELLING_TABLE[w] ?? w;
  s = s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
  s = s.replace(/ph/g, "f").replace(/th/g, "t").replace(/rh/g, "r");
  // Foreign c: Circus = Zirkus, Club = Klub, Creme = Kreme (not ch, ck, sch).
  s = s.replace(/c(?=[eiy])/g, "z").replace(/c(?![hkz])/g, "k");
  return s;
}

/** Without umlauts: "Bar" for "Bär", "Schlussel" for "Schlüssel". */
function bare(w: string): string {
  return spell(w).replace(/([aou])e/g, "$1");
}

/**
 * A coarse German sound key (against the secret word and for guesses only):
 * ä = e, äu = eu, ai = ei, ie/ih = i, a lengthening h is silent (Wahl = Wal),
 * doubled vowels are one (Meer = mehr), final b d g sound p t k (Rad = Rat),
 * v = f, ck = k, dt = t, chs/x = ks, qu = kw, y = ü. Doubled consonants stay
 * (Ofen is not offen).
 */
function soundKey(w: string): string {
  let s = (SPELLING_TABLE[w] ?? w).replace(/ß/g, "ss").replace(/ph/g, "f").replace(/th/g, "t").replace(/rh/g, "r");
  s = s.replace(/äu/g, "eu").replace(/ä/g, "e").replace(/ai/g, "ei").replace(/ay/g, "ei");
  s = s.replace(/ieh|ih|ie/g, "i");
  s = s.replace(/([aeiouöü])h(?![aeiouäöü])/g, "$1");
  s = s.replace(/aa/g, "a").replace(/ee/g, "e").replace(/oo/g, "o");
  s = s.replace(/dt/g, "t").replace(/tz/g, "z").replace(/ck/g, "k").replace(/chs|x/g, "ks").replace(/qu/g, "kw").replace(/v/g, "f").replace(/y/g, "ü");
  s = s.replace(/c(?=[eiy])/g, "z").replace(/c(?![hkz])/g, "k");
  s = s.replace(/ig$/, "ich");
  s = s.replace(/b$/, "p").replace(/d$/, "t").replace(/g$/, "k").replace(/b(?=[st]$)/, "p").replace(/d(?=[st]$)/, "t").replace(/g(?=[st]$)/, "k");
  return s;
}

const HOMOPHONES: string[][] = "stadt statt|mann man|das dass|wen wenn|ist isst|kam kamm|bis biss|in inn|fast fasst|rast rasst|hast hasst"
  .split("|")
  .map((g) => g.split(" "));
const HOMOPHONE_ID = new Map<string, number[]>();
HOMOPHONES.forEach((g, i) => g.forEach((w) => push(HOMOPHONE_ID, w, i)));

function soundsSame(a: Forms, b: Forms): boolean {
  const ids = new Set<number>();
  for (const x of a.typo) for (const id of HOMOPHONE_ID.get(x) ?? []) ids.add(id);
  for (const y of b.typo) for (const id of HOMOPHONE_ID.get(y) ?? []) if (ids.has(id)) return true;
  const ka = new Set(a.typo.map(soundKey));
  for (const y of b.typo) if (ka.has(soundKey(y))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Typos: weighted Damerau (optimal string alignment) on a QWERTZ keyboard
// ---------------------------------------------------------------------------

const ROWS = ["qwertzuiopü", "asdfghjklöä", "yxcvbnm"];
const KEY_POS = new Map<string, [number, number]>();
ROWS.forEach((row, r) => [...row].forEach((c, i) => KEY_POS.set(c, [r, i])));
const UMLAUT_BASE: Record<string, string> = { ä: "a", ö: "o", ü: "u" };

/** Neighbouring keys on a German keyboard; an umlaut and its vowel count as neighbours (a keyboard without umlauts). */
export function adjacentKeys(a: string, b: string): boolean {
  if (a === b) return false;
  if (UMLAUT_BASE[a] === b || UMLAUT_BASE[b] === a) return true;
  if ((a === "ß" && b === "s") || (a === "s" && b === "ß")) return true;
  const p = KEY_POS.get(a);
  const q = KEY_POS.get(b);
  if (!p || !q) return false;
  const [r1, i1] = p;
  const [r2, i2] = q;
  if (r1 === r2) return Math.abs(i1 - i2) === 1;
  if (r2 === r1 + 1) return i2 === i1 || i2 === i1 - 1;
  if (r2 === r1 - 1) return i2 === i1 || i2 === i1 + 1;
  return false;
}

const VOWELS = "aeiouyäöü";

interface TypoCostOptions {
  loose?: boolean;
  doubles?: boolean;
  vowels?: boolean;
}

export function typoCost(a: string, b: string, o: TypoCostOptions = {}): number {
  const doubles = o.doubles ?? true;
  const n = a.length;
  const m = b.length;
  const indel = (s: string, i: number): number => {
    if (o.loose) return 1;
    const c = s[i]!;
    const p = s[i - 1];
    const q = s[i + 1];
    if (c === p || c === q) return doubles ? 1 : 2;
    if ((p && adjacentKeys(c, p)) || (q && adjacentKeys(c, q))) return 1;
    return 2;
  };
  const d: number[][] = [];
  for (let i = 0; i <= n; i++) d.push(new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) d[i]![0] = d[i - 1]![0]! + indel(a, i - 1);
  for (let j = 1; j <= m; j++) d[0]![j] = d[0]![j - 1]! + indel(b, j - 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const x = a[i - 1]!;
      const y = b[j - 1]!;
      const sub = x === y ? 0 : adjacentKeys(x, y) || (o.vowels && VOWELS.includes(x) && VOWELS.includes(y)) ? 1 : 2;
      let v = Math.min(d[i - 1]![j]! + indel(a, i - 1), d[i]![j - 1]! + indel(b, j - 1), d[i - 1]![j - 1]! + sub);
      if (i > 1 && j > 1 && x === b[j - 2] && a[i - 2] === y && x !== y) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[n]![m]!;
}

/** Allowed typo cost by the length of the shorter word (German words are long: as English). */
export function typoBudget(n: number): number {
  if (n < 5) return 0;
  if (n <= 7) return 1;
  if (n <= 11) return 2;
  return 3;
}

interface Leniency {
  doublesFrom: number;
  vowelsFrom: number;
}
const CLUE_LENIENCY: Leniency = { doublesFrom: 7, vowelsFrom: 99 };
const GUESS_LENIENCY: Leniency = { doublesFrom: 5, vowelsFrom: 6 };

function isTypo(a: string, b: string, loose: boolean, len: Leniency): boolean {
  if (a === b || !/^[a-zäöüß]+$/.test(a) || !/^[a-zäöüß]+$/.test(b)) return false;
  const n = Math.min(a.length, b.length);
  const budget = typoBudget(n);
  if (budget === 0 || Math.abs(a.length - b.length) > budget) return false;
  const first = (s: string) => UMLAUT_BASE[s[0]!] ?? s[0];
  if (n <= 7 && first(a) !== first(b)) return false;
  return typoCost(a, b, { loose, doubles: n >= len.doublesFrom, vowels: n >= len.vowelsFrom }) <= budget;
}

function typoMatch(a: Forms, b: Forms, opt: DeOptions, len: Leniency = CLUE_LENIENCY): boolean {
  // Two real words are never typos of each other (Hose is not a typo of Rose, nor Kiste of Küste).
  const lex = opt.lexicon;
  if (lex && a.known && b.known) return false;
  if (!lex && opt.known && opt.known(a.key) && opt.known(b.key)) return false;
  const loose = lex !== undefined || opt.known !== undefined;
  for (const x of a.typo) for (const y of b.typo) if (isTypo(x, y, loose, len)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

function inflectionReason(a: Forms, b: Forms): Reason | null {
  let best: Reason | null = null;
  const order: Reason[] = ["plural", "verb form", "word form", "same family"];
  for (const [x, ka] of a.infl) {
    const kb = b.infl.get(x);
    if (kb === undefined) continue;
    // Two words of their own that are also forms of a third are those words:
    // Reise and Reis are not both "reisen" (ich reise, reis!), Rate and Rat not "raten".
    if (ka !== "self" && kb !== "self" && a.lemma && b.lemma) continue;
    const kinds = [ka, kb];
    // Two words of their own, one also the bare stem of the other (Lauf and
    // laufen, "lauf!"): a family, more than a form. A plural stays a plural
    // (Windel and windeln: die Windeln), a participle a verb form (gewaschen).
    const stem = x === a.key + "en" || x === a.key + "n" || x === b.key + "en" || x === b.key + "n";
    const r: Reason = kinds.includes("plural") ? "plural" : a.lemma && b.lemma && stem ? "same family" : kinds.includes("verb form") ? "verb form" : "word form";
    if (best === null || order.indexOf(r) < order.indexOf(best)) best = r;
  }
  return best;
}

/**
 * Same family: one word derives from the other (two steps: Bäckerei, Bäcker,
 * backen), or both derive from one word (Fahrer and Fahrt from fahren), or
 * both are in one family group (Frankreich, französisch). Not cousins: langsam
 * and Länge are both from lang, two steps apart, and that is too far.
 */
function familyMatch(a: Forms, b: Forms): boolean {
  for (const x of a.own) if (b.fam.has(x)) return true;
  for (const x of b.own) if (a.fam.has(x)) return true;
  for (const x of a.parents) if (b.parents.has(x)) return true;
  for (const x of a.fam) if (x.startsWith("#") && b.fam.has(x)) return true;
  return false;
}

/** Same word, spelling, plural / verb form / word form, same family (no typo). */
function related(a: string, b: string, opt: DeOptions): Reason | null {
  if (a === b) return "same word";
  const fa = forms(a, opt);
  const fb = forms(b, opt);
  if (fa.spell === fb.spell || (fa.re ?? fa.key) === (fb.re ?? fb.key)) return "spelling";
  const r = inflectionReason(fa, fb);
  if (r) return r;
  if (familyMatch(fa, fb)) return "same family";
  return null;
}

/** Umlauts left out ("Schlussel"): the same word unless both are words (Bar and Bär are two). */
function umlautSlip(a: Forms, b: Forms, strict: boolean): boolean {
  if (a.key === b.key || bare(a.key) !== bare(b.key)) return false;
  return !strict || !(a.known && b.known);
}

/** Does the dictionary know the word? Undefined without one: the disguise rules need it. */
function knownWord(w: string, opt: DeOptions): boolean | undefined {
  if (opt.lexicon) return forms(w, opt).known || (opt.englishKnown?.(w) ?? false);
  return opt.known ? opt.known(w) : undefined;
}

/** "Zrawhcs" -> "schwarz". */
function reverse(w: string): string {
  return [...w].reverse().join("");
}

/** `x` is `y` with letters doubled (or more), nothing else: radd, rrad for rad; not lam for lamm, feel for fell. */
function stretches(x: string, y: string): boolean {
  const rx = x.match(/(.)\1*/gu) ?? [];
  const ry = y.match(/(.)\1*/gu) ?? [];
  return x.length > y.length && rx.length === ry.length && rx.every((r, i) => r[0] === ry[i]![0] && r.length >= ry[i]!.length);
}

/**
 * A word in disguise, to slip past the jinx (and the check against the
 * secret): a known word with letters stretched (Radd, Hhuunndd, Auuto for
 * Rad, Hund, Auto; short words have no typos) or written backwards (Otua
 * for Auto, Zrawhcs for Schwarz, 4+ letters). Strict on purpose, so that no
 * real word is caught: the disguise must be unknown to the lexicon and the
 * other word known, only letters doubled (never undoubled: Lam for Lamm,
 * feel for Fell are not), exactly reversed (no forms: gilben is not
 * "nebelig"). Ofen and offen, Tor and rot are words of their own. Needs the
 * lexicon; without it, nothing is a disguise.
 */
function disguised(a: string, b: string, opt: DeOptions): Reason | null {
  if (a === b || !/^[a-zäöüß]+$/.test(a) || !/^[a-zäöüß]+$/.test(b)) return null;
  const ka = knownWord(a, opt);
  const kb = knownWord(b, opt);
  if (ka === undefined || kb === undefined) return null;
  for (const [x, y, kx, ky] of [[a, b, ka, kb], [b, a, kb, ka]] as const) {
    if (kx || !ky) continue;
    if (stretches(x, y)) return "spelling";
    if (y.length >= 4 && reverse(x) === y) return "backwards";
  }
  return null;
}

/**
 * Two-word clues that share a word: "Schwarz Auto" and "Schwarz", "Auto
 * Schwarz" and "Schwarz Auto". The cards say the same word, whatever comes
 * with it (one-word compounds that share a part still do not jinx).
 */
function sharedWord(a: Clue, b: Clue, opt: DeOptions): Reason | null {
  if (a.parts.length < 2 && b.parts.length < 2) return null;
  const pa = a.parts.length > 1 ? a.parts : [a.key];
  const pb = b.parts.length > 1 ? b.parts : [b.key];
  if (pa.length === pb.length && [...pa].sort().join(" ") === [...pb].sort().join(" ")) return "same word";
  for (const x of pa) {
    if (x.length < 3 || !/^[a-zäöüß]+$/.test(x)) continue;
    for (const y of pb) if (y.length >= 3 && /^[a-zäöüß]+$/.test(y) && related(x, y, opt)) return "contains the word";
  }
  return null;
}

/** Every word of the clue is an English word (with the English dictionary). */
function englishToo(c: Clue, opt: DeOptions): boolean {
  const known = opt.englishKnown;
  return known !== undefined && c.kind === "word" && c.parts.length > 0 && c.parts.every((p) => known(p));
}

/**
 * An English word and no German one (dogs, chops, tall): it plays by English
 * rules, never German ones (better is no plural of Bett, chops no typo of
 * Chips, auditor does not contain Tor).
 */
function englishOnly(c: Clue, opt: DeOptions): boolean {
  return englishToo(c, opt) && !forms(c.key, opt).known;
}

/** Two clues by the English matcher. */
function sameEnglish(a: Clue, b: Clue, opt: DeOptions): Reason | null {
  const ea = cleanEn(a.display);
  const eb = cleanEn(b.display);
  return ea.ok && eb.ok ? sameClueEn(ea.clue, eb.clue, { known: opt.englishKnown }) : null;
}

/** Do two clues jinx each other? Returns the reason, or null. */
export function sameClue(a: Clue, b: Clue, opt: DeOptions = {}): Reason | null {
  if (a.key === b.key) {
    if (a.kind === "number") return a.display.toLowerCase() === b.display.toLowerCase() ? "same word" : "same number";
    return "same word";
  }
  if (a.kind !== "word" || b.kind !== "word") return null;
  // An English word against another English one (planets, Planet) by English rules; against a German word never.
  if (englishOnly(a, opt) || englishOnly(b, opt)) return englishToo(a, opt) && englishToo(b, opt) ? sameEnglish(a, b, opt) : null;
  const r = related(a.key, b.key, opt);
  if (r) return r;
  const fa = forms(a.key, opt);
  const fb = forms(b.key, opt);
  if (umlautSlip(fa, fb, opt.lexicon !== undefined || opt.known !== undefined)) return "spelling";
  if (typoMatch(fa, fb, opt)) return "typo";
  return disguised(a.key, b.key, opt) ?? sharedWord(a, b, opt);
}

/**
 * Prefixes and verb particles that count as a part: "Unglück" contains
 * "Glück", "weglaufen" contains "laufen". Not the inseparable verb prefixes
 * (be-, ge-, er-, ver-, zer-, ent-): gestern is not ge + Stern, entdecken not ent + Decke.
 */
const PREFIXES = new Set(
  (
    "un ur miss anti super mega mini ex " +
    "ab an auf aus bei ein fest fort her hin los mit nach vor weg zu zurück zusammen weiter heim hoch runter rauf raus rein rüber um durch über unter wieder"
  ).split(" "),
);

/** Ways a word starts a compound: Sonne -> Sonnen-, Schule -> Schul-, Kind -> Kinder-, Arbeit -> Arbeits-. */
function joins(w: string): string[] {
  const out = new Set<string>([w]);
  for (const f of FUGEN) out.add(w + f);
  if (w.endsWith("e") && w.length >= 4) out.add(w.slice(0, -1));
  if (w.endsWith("en") && w.length >= 5) out.add(w.slice(0, -2)); // verbs: Back-ofen
  return [...out];
}

/** A word that can be a compound's part: a noun, adjective or verb (or its forms), or a compound of them; not a function word or a finite verb form. */
function knownPart(w: string, opt: DeOptions): boolean {
  const lex = opt.lexicon;
  if (!lex) return opt.known ? opt.known(w) : true;
  if (content(w, lex)) return true;
  const c = compound(w, lex);
  return c !== null && [...c.readings.keys()].some((l) => (lex.pos.get(l) ?? []).some((p) => p[0] === "n"));
}

/** What a lemma is made of, by the lexicon, with the parts of its parts (Feuerwehrauto: feuerwehr, auto, feuer, wehr); null if it is no compound. */
function partsOf(w: string, lex: Lexicon, depth = 0): string[] | null | undefined {
  const p = lex.parts.get(w);
  if (!p) return p;
  const out = [...p];
  if (depth < 2) for (const x of p) out.push(...(partsOf(x, lex, depth + 1) ?? []));
  return out;
}

/** The same word, spelled or inflected otherwise (no family): a part of a compound and the word. */
function sameLemma(a: string, b: string, opt: DeOptions): boolean {
  const r = related(a, b, opt);
  return r !== null && r !== "same family";
}

/**
 * Does `long` contain `short` as a part? The lexicon's parts decide when it
 * has them (Reisepass is Reise + Pass, not Reis; Butterbrot is no rot) or
 * knows the word is no compound (Sandale, Tornado, Unglück: a derivation).
 * Otherwise the rule: `long` starts with `short` as a compound's first part
 * (with its Fugen and plurals) and the rest is a word, or ends with it after
 * a known first part or a prefix.
 */
function containsPart(long: string, short: string, opt: DeOptions, plurals: readonly string[] = []): boolean {
  if (short.length < 3 || !/^[a-zäöüß]+$/.test(short) || !/^[a-zäöüß]+$/.test(long) || long.length <= short.length) return false;
  const lex = opt.lexicon;
  if (lex) {
    const parts = partsOf(long, lex);
    if (parts === null) return false;
    if (parts !== undefined) return parts.some((p) => p === short || sameLemma(p, short, opt));
  }
  for (const j of new Set([...joins(short), ...plurals])) {
    if (!long.startsWith(j)) continue;
    // A first part that is another word: Reise- is not Reis + e.
    if (lex && j !== short && !plurals.includes(j) && otherNoun(j, short, lex)) continue;
    const tail = long.slice(j.length);
    if (tail.length >= 3 && knownPart(tail, opt)) return true;
    if (tail === "ei") return true; // Hühner-ei
    // Schifffahrt: the key wrote "schiffahrt" (three letters are two), Schiff + fahrt.
    if (tail.length >= 2 && j === short && /(.)\1$/.test(short) && knownPart(short.at(-1)! + tail, opt)) return true;
  }
  if (long.endsWith(short)) {
    const head = long.slice(0, long.length - short.length);
    if (PREFIXES.has(head)) return true;
    if (head.length >= 3) {
      if (!lex) return opt.known ? opt.known(head) : true;
      // Any known word in front (Wer-wolf, Eis-bär, Fahr-rad), as long as it is no finite verb form.
      if (modifier(head, lex) || [...lookup(head, lex).values()].some((k) => k !== "verb form")) return true;
    }
  }
  return false;
}

/** `j` reads as a noun other than `short` (Reise- for Reis, Fall- for Falle, Rinden- for Rind); a noun spelled `short` + n is the same (der Socken). */
function otherNoun(j: string, short: string, lex: Lexicon): boolean {
  const lemmas = [...lookup(j, lex)].filter(([l, k]) => k !== "verb form" && (lex.pos.get(l) ?? []).includes("n")).map(([l]) => l);
  return lemmas.length > 0 && !lemmas.some((l) => l === short || l === short + "n" || l === short + "en");
}

/** The word's lemmas it is an inflected form of (not itself). */
function bases(f: Forms): string[] {
  return [...f.infl].filter(([l, k]) => k !== "self" && l !== f.key).map(([l]) => l);
}

function pluralsOf(w: string, opt: DeOptions): string[] {
  const lex = opt.lexicon;
  if (!lex) return [];
  const out: string[] = [];
  // The lexicon stores forms against lemmas: try the plural endings and umlauts.
  for (const e of ["er", "e", "en", "n", "s"]) {
    const p = w + e;
    if ((lex.forms.get(p) ?? []).some(([l, k]) => l === w && k === "plural")) out.push(p);
  }
  const u = w.replace(/(au|a|o|u)([^aeiouäöü]*)$/, (_, v: string, c: string) => (v === "au" ? "äu" : v === "a" ? "ä" : v === "o" ? "ö" : "ü") + c);
  for (const e of ["er", "e", ""]) {
    const p = u + e;
    if (p !== w && (lex.forms.get(p) ?? []).some(([l, k]) => l === w && k === "plural")) out.push(p);
  }
  return out;
}

function containment(c: Clue, s: Clue, opt: DeOptions): Reason | null {
  // Explicit words: "Eis Bär" for "Eis", "Bär" for "Eis Bär".
  if (c.parts.length > 1) for (const p of c.parts) if (related(p, s.key, opt)) return "contains the word";
  if (s.parts.length > 1) for (const p of s.parts) if (related(p, c.key, opt)) return "part of the word";
  const fc = forms(c.key, opt);
  const fs = forms(s.key, opt);
  // A secret that is a word of its own is only that word: Kohle is not "ich kohle"
  // (kohlen, in Blumenkohl), Wand not "wand" (winden), Falle not "falle" (fallen).
  const sForms = fs.lemma ? [s.key] : [s.key, ...bases(fs).filter((x) => x.length >= 3)];
  // The clue contains the secret when every reading of it does: an inflected
  // clue is read as its lemmas ("Schneemänner" is Schneemann, which contains Schnee).
  const b = bases(fc);
  const readings = b.length > 0 ? b : [c.key];
  for (const y of sForms) {
    const plurals = pluralsOf(y, opt);
    const long = readings.filter((x) => x.length > y.length);
    if (long.length > 0 && long.every((x) => containsPart(x, y, opt, plurals))) return "contains the word";
  }
  // The secret contains the clue: Schnee in Schneemann, Blume in Sonnenblume.
  for (const y of sForms) for (const x of fc.typo) if (containsPart(y, x, opt, pluralsOf(x, opt))) return "part of the word";
  return null;
}

/**
 * Is `c` an invalid clue for the secret word `s`? `banned` are extra words
 * the word list forbids for this word (translations: perro, chien for Hund):
 * they match as they are written, or spelled otherwise, nothing more.
 * `english` are its English translations (dog): the same, and a clue that is
 * no German word also in their English forms, typos and disguises (dogs,
 * doggy, doog), but never a German word (bell for Glocke must not reject
 * bellen). `alsoRight` (accepted guesses: Rad for Fahrrad) also match in
 * their own forms (Räder), not their family or parts.
 */
export function invalidClue(
  c: Clue,
  s: Clue,
  opt: DeOptions = {},
  banned: readonly string[] = [],
  alsoRight: readonly string[] = [],
  english: readonly string[] = [],
): Reason | null {
  if (c.key === s.key) return c.kind === "number" ? "same number" : "same word";
  if (c.kind !== "word" || s.kind !== "word") return null;
  if (englishOnly(c, opt)) return invalidEnglish(c, s, opt, banned, alsoRight, english);
  const r = related(c.key, s.key, opt);
  if (r) return r;
  const fc = forms(c.key, opt);
  const fs = forms(s.key, opt);
  if (umlautSlip(fc, fs, false)) return "spelling";
  if (soundsSame(fc, fs)) return "sounds the same";
  if (typoMatch(fc, fs, opt)) return "typo";
  const d = disguised(c.key, s.key, opt);
  if (d) return d;
  const k = containment(c, s, opt);
  if (k) return k;
  for (const b of new Set([...banned, ...english])) {
    const bc = clean(b);
    if (!bc.ok) continue;
    if (bc.clue.key === c.key) return "too close";
    // German spellings only for the other languages (thon ~ Ton); English has
    // its own below: bat is no "bath", hearth no "heart".
    if (!english.includes(b) && fc.spell === spell(bc.clue.key)) return "too close";
  }
  // The English translations also in their typos and disguises (monky,
  // doog), unless the clue is a German word (bellen is no form of bell, Rock
  // no rocket). The other languages' only as written.
  const en = fc.known ? null : cleanEn(c.display);
  if (en?.ok)
    for (const b of english) {
      const be = cleanEn(b);
      if (be.ok && nearTranslation(en.clue, be.clue, { known: opt.englishKnown })) return "too close";
    }
  for (const a of alsoRight) {
    const ac = clean(a);
    if (!ac.ok) continue;
    if (ac.clue.key === c.key || sameLemma(c.key, ac.clue.key, opt)) return "too close";
  }
  return null;
}

/**
 * An English clue (no German word) for a German secret: only an English
 * translation in its English forms, typos and disguises (dogs, monkeys,
 * swam for schwimmen; planets for Planet, which the word list gives as its
 * own translation), or a listed word as written. Never another English
 * word: tall for Tal, chops for Chips, better for Bett, auditor for Tor,
 * wed for Hochzeit (wedding), singing for Affe (French singe), hoses for
 * Hose (a false friend: not listed).
 */
function invalidEnglish(c: Clue, s: Clue, opt: DeOptions, banned: readonly string[], alsoRight: readonly string[], english: readonly string[]): Reason | null {
  const ce = cleanEn(c.display);
  if (!ce.ok) return null;
  const eo = { known: opt.englishKnown };
  const se = cleanEn(s.display);
  for (const b of english) {
    const be = cleanEn(b);
    const r = be.ok ? nearTranslation(ce.clue, be.clue, eo) : null;
    // The word itself in English (planets for Planet): the reason; a translation: too close.
    if (r) return se.ok && be.ok && se.clue.key === be.clue.key ? r : "too close";
  }
  for (const b of [...banned, ...alsoRight]) {
    const bc = clean(b);
    if (bc.ok && bc.clue.key === c.key) return "too close";
  }
  return null;
}

/**
 * Is the guess right? Same word, spelling (umlauts left out too), plural,
 * verb form, word form, sounds the same, typo; not family, not a part.
 * `alsoRight` are extra accepted forms from the word list (Rad for Fahrrad).
 */
export function judgeGuess(g: Clue, s: Clue, opt: DeOptions = {}, alsoRight: readonly string[] = []): Reason | null {
  const r = judgeAgainst(g, s, opt);
  if (r) return r;
  for (const a of alsoRight) {
    const ac = clean(a);
    if (!ac.ok) continue;
    const ra = judgeAgainst(g, ac.clue, opt);
    if (ra) return ra === "same word" ? "spelling" : ra;
  }
  return null;
}

function judgeAgainst(g: Clue, s: Clue, opt: DeOptions): Reason | null {
  if (g.key === s.key) return g.kind === "number" && g.display.toLowerCase() !== s.display.toLowerCase() ? "same number" : "same word";
  if (g.kind !== "word" || s.kind !== "word") return null;
  const fg = forms(g.key, opt);
  const fs = forms(s.key, opt);
  if (fg.spell === fs.spell || umlautSlip(fg, fs, false)) return "spelling";
  const r = inflectionReason(fg, fs);
  if (r) return r;
  if (soundsSame(fg, fs)) return "sounds the same";
  if (typoMatch(fg, fs, opt, GUESS_LENIENCY)) return "typo";
  // Lehrerin for Lehrer, Ärztin for Arzt (and back): the same job or animal, not another word.
  if (moved(fg.key, fs.key) || moved(fs.key, fg.key)) return "word form";
  return null;
}

/** `f` is the female form of `m`: + in, with or without an umlaut (Ärztin, Köchin), Löwe -> Löwin. */
function moved(f: string, m: string): boolean {
  const g = f.replace(/innen$/, "in");
  if (!g.endsWith("in") || g.length < 5) return false;
  const stem = g.slice(0, -2);
  const plain = (x: string) => x.replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u");
  return plain(stem) === plain(m) || plain(stem) === plain(m.replace(/e$/, ""));
}

// ---------------------------------------------------------------------------
// Grouping a round's clues
// ---------------------------------------------------------------------------

/**
 * Strike invalid clues, then jinx the rest. Matching is transitive: if a
 * matches b and b matches c, all three are lost (connected components).
 */
export function groupClues(clues: readonly Clue[], secret: Clue, opt: DeOptions = {}, banned: readonly string[] = [], english: readonly string[] = []): RoundResult {
  const invalid: RoundResult["invalid"] = [];
  const valid: number[] = [];
  clues.forEach((c, i) => {
    const r = invalidClue(c, secret, opt, banned, [], english);
    if (r) invalid.push({ index: i, reason: r });
    else valid.push(i);
  });
  const parent = new Map<number, number>(valid.map((i) => [i, i]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const links: Link[] = [];
  for (let x = 0; x < valid.length; x++) {
    for (let y = x + 1; y < valid.length; y++) {
      const a = valid[x]!;
      const b = valid[y]!;
      const reason = sameClue(clues[a]!, clues[b]!, opt);
      if (!reason) continue;
      links.push({ a, b, reason });
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
    }
  }
  const byRoot = new Map<number, number[]>();
  for (const i of valid) push(byRoot, find(i), i);
  const groups = [...byRoot.values()].filter((m) => m.length > 1).map((members) => ({ members, links: links.filter((l) => members.includes(l.a)) }));
  const jinxed = new Set(groups.flatMap((g) => g.members));
  return { invalid, groups, survivors: valid.filter((i) => !jinxed.has(i)) };
}

// ---------------------------------------------------------------------------
// Submit check (host page, answering the phone)
// ---------------------------------------------------------------------------

/** Phone wording per reason for a clue too close to the secret word. */
const TOO_CLOSE_TEXT: Record<Reason, string> = {
  "same word": "Das ist das Wort selbst",
  "same number": "Das ist das Wort selbst",
  spelling: "Das ist das Wort, nur anders geschrieben",
  plural: "Das ist das Wort im Plural",
  "verb form": "Das ist eine Form des Wortes",
  "word form": "Das ist eine Form des Wortes",
  "same family": "Zu nah am Wort: gleiche Wortfamilie",
  typo: "Das ist das Wort mit Tippfehler",
  "sounds the same": "Klingt wie das Wort",
  "contains the word": "Enthält das Wort",
  "part of the word": "Ein Teil des Wortes",
  backwards: "Das ist das Wort rückwärts",
  "too close": "Zu nah am Wort",
};

/**
 * Check a clue when the giver submits it. Rejections go back to the phone
 * with a German message; `banned` and `alsoRight` come from the word list,
 * `own` are the giver's other clues this round (3 players: two clues each).
 */
export function checkSubmit(
  raw: string,
  secret: Clue,
  opt: DeOptions & { banned?: readonly string[]; alsoRight?: readonly string[]; english?: readonly string[]; own?: readonly Clue[] } = {},
): SubmitResult {
  const c = clean(raw);
  if (!c.ok) return { ok: false, code: c.error, message: c.message };
  const r = invalidClue(c.clue, secret, opt, opt.banned ?? [], opt.alsoRight ?? [], opt.english ?? []);
  if (r) return { ok: false, code: "too-close", reason: r, message: `${TOO_CLOSE_TEXT[r]}. Versuch einen anderen Hinweis` };
  for (const o of opt.own ?? []) {
    const m = sameClue(c.clue, o, opt);
    if (m) {
      const why = m === "same word" ? "" : ` (${REASON_TEXT[m]})`;
      return { ok: false, code: "own-clue", reason: m, message: `Wie dein anderer Hinweis${why}. Versuch einen anderen Hinweis` };
    }
  }
  return { ok: true, clue: c.clue };
}
