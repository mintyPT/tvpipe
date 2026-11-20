// Build the German lexicon the game ships (data/dict.de.txt): the word forms
// of about 50,000 German lemmas and the derivations between them, from the
// German Wiktionary. Node only:
//
//   ./fetch.sh                 # raw data into ../../words/raw/de/ (git-ignored)
//   node build-lexicon.ts      # -> ../../../data/dict.de.txt + dict.de-LICENSE.txt
//   node build-lexicon.ts --explain WORD...   # what the lexicon says about some words
//
// Inputs: the German Wiktionary as JSON lines (kaikki.org's wiktextract dump,
// CC BY-SA 4.0) and OpenSubtitles word frequencies (only to choose lemmas).
// The format of dict.de.txt is in SPEC.md §2 and in match-de.ts `lexicon()`.

import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createGunzip, gzipSync } from "node:zlib";

import { foldWord } from "../../../game/match-de.ts";

const here = dirname(fileURLToPath(import.meta.url));
const raw = join(here, "..", "..", "words", "raw", "de");
const DUMP = join(raw, "raw-wiktextract-data.jsonl.gz");
const ENTRIES = join(raw, "de-entries.jsonl"); // the German entries of DUMP, cached
const FREQ = join(raw, "de_full.txt");

/** A lemma goes in when its forms occur this often in the subtitles (sum of counts). */
const MIN_COUNT = Number(process.env["MIN_COUNT"] ?? 20);

type Pos = "n" | "v" | "a" | "e" | "x";

interface Rec {
  key: string;
  pos: Pos;
  /** n: singular case forms; v: finite forms; a: declension bases (key included) */
  forms: Set<string>;
  /** n: plural forms; v: participles (decline like adjectives) */
  more: Set<string>;
  family: Set<string>;
  /** a noun declined like an adjective (der Alte, ein Alter): not an independent word */
  adjNoun: boolean;
  /** derived words named by this entry (Wortbildungen), checked against suffix rules */
  derived: string[];
  first: boolean;
  /** verb forms that are only subjunctive or imperative (ihr planet, miss!, wiese) */
  rare: Set<string>;
  /** the etymology calls it a compound (Hühnerei: Huhn + Ei, not a derivation of Huhn) */
  compound: boolean;
  /** what the etymology says it is made of (Schnee + Mann, weg + laufen); null: not a compound (a derivation, a loan) */
  parts: string[] | null | undefined;
}

const WORD = /^[a-zäöüß]+$/;
const BAD_TAGS = new Set(["variant", "archaic", "obsolete", "rare", "uncommon", "outdated", "regional", "Switzerland", "Liechtenstein", "Austrian German", "abbreviation", "dialectal", "colloquial", "poetic"]);
const FORM_TITLES = /Deklinierte Form|Konjugierte Form|Partizip|Komparativ|Superlativ|Erweiterter Infinitiv|Dekliniertes Gerundivum|Gerundivum/;

function posOf(pos: string, title: string | undefined): Pos | null {
  switch (pos) {
    case "noun":
      return "n";
    case "verb":
      return "v";
    case "adj":
      return "a";
    case "name":
      return title && /Toponym|Eigenname/.test(title) ? "e" : "x";
    case "adv":
    case "prep":
    case "conj":
    case "pron":
    case "num":
    case "particle":
    case "intj":
    case "det":
    case "postp":
      return "x";
    default:
      return null;
  }
}

async function* lines(path: string, gz: boolean): AsyncGenerator<string> {
  const input = createReadStream(path);
  const rl = createInterface({ input: gz ? input.pipe(createGunzip()) : input, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

async function ensureEntries(): Promise<void> {
  if (existsSync(ENTRIES)) return;
  if (!existsSync(DUMP)) {
    console.error(`missing ${DUMP}: run ./fetch.sh first`);
    process.exit(1);
  }
  console.error("extracting the German entries (once)…");
  const out = createWriteStream(ENTRIES);
  for await (const line of lines(DUMP, true)) {
    if (!line.includes('"lang_code": "de"')) continue;
    const d = JSON.parse(line);
    if (d.lang_code !== "de") continue;
    delete d.translations;
    delete d.sounds;
    delete d.hyphenations;
    const senses = d.senses ?? [];
    delete d.senses;
    d.glosses = senses.flatMap((s: { glosses?: string[] }) => s.glosses ?? []).slice(0, 3);
    if (!out.write(JSON.stringify(d) + "\n")) await new Promise((r) => out.once("drain", r));
  }
  await new Promise((r) => out.end(r));
}

const freq = new Map<string, number>();
function count(w: string): number {
  return freq.get(w) ?? 0;
}

const recs = new Map<string, Rec>(); // `${key}\t${pos}`
/** Movierung and diminutives named by a lemma's own entry: derived key -> base key. */
const named = new Map<string, Set<string>>();
/** Etymology bases by key (first entry per key and part of speech only). */
const etyBases = new Map<string, Set<string>>();

function rec(key: string, pos: Pos): Rec {
  const id = `${key}\t${pos}`;
  let r = recs.get(id);
  if (!r) {
    r = { key, pos, forms: new Set(), more: new Set(), family: new Set(), adjNoun: false, derived: [], first: true, compound: false, rare: new Set(), parts: undefined };
    recs.set(id, r);
  } else r.first = false;
  return r;
}

interface Form {
  form: string;
  tags?: string[];
  raw_tags?: string[];
  source?: string;
}

const DERIV = /Ableitung|Derivation|Derivat|Substantivierung|Verkleinerungsform|Diminutiv|Konversion|Rückbildung|Movierung|Nominalisierung|Adjektivierung|implizite|Partizip|Verbalisierung/;
const COMPOUND = /kompositum|Komposition|Zusammensetzung|zusammengesetzt|Zusammenrückung|Kontamination|Kurzwort|Kunstwort|Initialwort|Wortkreuzung|Zusammenbildung/i;
const TERMS = /^(Ableitung|Derivation|Derivatem|Ableitungsmorphem|Suffix|Präfix|Stamm|Substantiv|Verb|Adjektiv|Adverb|Partizip|Umlaut|Konversion|Diminutiv|Substantivierung|Derivat|Verkleinerungsform|Nachsilbe|Vorsilbe|Movierung|Rückbildung|Nominalisierung|Wortstamm|Fugenelement|Infinitiv|Komparativ|Superlativ|Motion|Form|Kurzform|Aktiv|Passiv|Futur|Präsens|Präteritum|Perfekt|Muster|Endung|Femininum|Maskulinum|Neutrum|Plural|Singular|Genitiv|Dativ|Akkusativ|Nominativ)$/;

/** The word a segment derives from: "Ableitung vom Stamm des Verbs backen", "zum Substantiv Freund", "des Adjektivs kalt". */
const FROM = /(?:\bzu[mr]?|\bvo[mn]|\bdes|\bder|\baus|\bvon dem|Stamm(?:es)?(?: des| von| der)?)\s+(?:(?:dem|den|der|des)\s+)?(?:(?:Substantiv|Verb|Adjektiv|Adverb|Partizip|Numerale|Eigenname|Toponym)s?\s+)?([A-ZÄÖÜa-zäöüß]+)/g;

function etymology(key: string, d: { etymology_texts?: string[]; etymology_links?: [string, string][] }): Set<string> {
  const out = new Set<string>();
  const links = new Set((d.etymology_links ?? []).filter(([w, t]) => !t.includes("#") && !TERMS.test(w)).map(([w]) => w));
  for (const text of d.etymology_texts ?? []) {
    for (const seg of text.split(/(?<=[.;])\s+|\s*\[\d+\]\s*/)) {
      if (!DERIV.test(seg) || COMPOUND.test(seg)) continue;
      for (const m of seg.matchAll(FROM)) {
        const w = m[1]!;
        if (!links.has(w) || TERMS.test(w)) continue;
        const k = foldWord(w);
        // Derivations keep the start of their base (Kälte/kalt, Flug/fliegen, Fahrt/fahren).
        if (k !== key && alike(k, key, 2)) out.add(k);
      }
    }
  }
  return out;
}

const MADE_OF = /kompositum|komposition|zusammengesetzt|zusammensetzung|zusammenrückung|partikelverb|verbzusatz|gebildet aus/i;
const LOAN = /entlehnt|Entlehnung|Lehnwort|Fremdwort|übernommen|von (englisch|französisch|lateinisch|italienisch|spanisch|griechisch|arabisch|türkisch|japanisch|niederländisch|portugiesisch|russisch|altgriechisch|mittellateinisch|neulateinisch)|aus dem (Englischen|Französischen|Lateinischen|Italienischen|Spanischen|Griechischen|Arabischen|Japanischen|Niederländischen)/;

/**
 * What a word is made of, from its etymology: the linked words of a
 * "Determinativkompositum aus Schnee und Mann" or "gebildet aus der Partikel
 * weg … und dem Verb laufen" segment. Null when the etymology says it is a
 * derivation or a loan and not a compound (Unglück, Sandale, Tornado);
 * undefined when it does not say.
 */
function partsOf(key: string, d: { etymology_texts?: string[]; etymology_links?: [string, string][] }): string[] | null | undefined {
  const texts = d.etymology_texts ?? [];
  if (texts.length === 0) return undefined;
  const links = (d.etymology_links ?? []).filter(([w, t]) => !t.includes("#") && !TERMS.test(w) && !w.startsWith("-") && /^[A-ZÄÖÜa-zäöüß]+$/.test(w)).map(([w]) => w);
  for (const text of texts) {
    for (const seg of text.split(/(?<=[.;])\s+|\s*\[\d+\]\s*/)) {
      if (!MADE_OF.test(seg)) continue;
      const parts = links.filter((w) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, "u").test(seg)).map(foldWord).filter((w) => w !== key && !/^(determinativkompositum|kopulativkompositum|possessivkompositum|partikel|verbzusatz|nomen|subst)$/.test(w));
      // The parts must be the word's start and end (the dump sometimes gives a
      // compound its head's etymology: Kühlschrank gets Schrank's).
      const plain = (w: string) => w.replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u");
      // Only words that are in the word (not "Substantiven", "Stamm").
      const inWord = parts.filter((p) => plain(key).includes(plain(p).slice(0, 3)));
      parts.splice(0, parts.length, ...inWord);
      const first = parts[0];
      const last = parts.at(-1);
      const k = plain(key);
      if (parts.length >= 2 && first && last && k.startsWith(plain(first).slice(0, 3)) && k.slice(Math.floor(k.length / 2)).includes(plain(last).slice(0, 3)))
        return [...new Set(parts)];
    }
  }
  if (texts.some((t) => MADE_OF.test(t))) return undefined;
  // Not a compound, if the etymology is this word's: not its head's (Kühlschrank's is Schrank's).
  const words = new Set([...links.map(foldWord), ...texts.join(" ").split(/[^\p{L}]+/u).map(foldWord)]);
  for (let i = 1; i <= key.length - 3; i++) if (words.has(key.slice(i))) return undefined;
  if (texts.some((t) => DERIV.test(t) || LOAN.test(t))) return null;
  return undefined;
}

/** Two words that start alike, umlauts aside (Hund/Hündin, Lehrer/Lehrerin, Kater/Katze; not Taube/Männchen). */
function alike(a: string, b: string, n = 3): boolean {
  const d = (s: string) => s.replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u");
  const x = d(a);
  const y = d(b);
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  return p >= Math.min(n, x.length, y.length);
}

function strip(form: string, lower = false): string | null {
  // "ich laufe", "er/sie/es läuft", "lauf!", "laufen Sie!"
  let f = form.replace(/!$/, "").trim();
  f = f.replace(/^(ich|du|er\/sie\/es|er|sie|es|wir|ihr|man) /, "");
  if (f.includes(" ") || (lower && /^\p{Lu}/u.test(f))) return null;
  const k = foldWord(f);
  return WORD.test(k) ? k : null;
}

function addEntry(d: any): void {
  const word: string = d.word;
  if (!word || /[\s\-'.\d]/.test(word)) return;
  if ((d.tags ?? []).includes("form-of") || FORM_TITLES.test(d.pos_title ?? "")) return;
  const pos = posOf(d.pos, d.pos_title);
  if (!pos) return;
  const key = foldWord(word);
  if (!WORD.test(key) || key.length < 2) return;
  const r = rec(key, pos);
  const first = r.first;
  const forms: Form[] = d.forms ?? [];
  const bad = (f: Form) => (f.tags ?? []).some((t) => BAD_TAGS.has(t));
  if (pos === "n" || pos === "e") {
    for (const f of forms) {
      const tags = f.tags ?? [];
      if (tags.includes("feminine") || tags.includes("masculine") || tags.includes("diminutive")) {
        const k = strip(f.form);
        if (k && k !== key && alike(k, key) && (tags.includes("diminutive") || tags.includes("feminine"))) {
          // Hund names Hündin and Hündchen: those derive from Hund.
          if (!named.has(k)) named.set(k, new Set());
          named.get(k)!.add(key);
        }
        if (k && k !== key && alike(k, key) && tags.includes("masculine") && tags.length === 1) {
          // Lehrerin names Lehrer: Lehrerin derives from it.
          if (!named.has(key)) named.set(key, new Set());
          named.get(key)!.add(k);
        }
        continue;
      }
      if (bad(f)) continue;
      if (tags.includes("strong") || tags.includes("weak") || tags.includes("mixed")) r.adjNoun = true;
      const k = strip(f.form);
      if (!k || k === key) continue;
      // The old dative -e (dem Hunde, dem Reise for Reis) is not a form players write.
      if (tags.includes("dative") && tags.includes("singular") && k === key + "e") continue;
      if (tags.includes("plural")) r.more.add(k);
      else if (tags.includes("singular") || r.adjNoun) r.forms.add(k);
    }
  } else if (pos === "a") {
    r.forms.add(key);
    for (const f of forms) {
      if (bad(f)) continue;
      const tags = f.tags ?? [];
      let k = strip(f.form.replace(/^(er|sie|es) (ist|sind) /, "").replace(/^am /, ""), true);
      if (!k) continue;
      if (tags.includes("superlative") && k.endsWith("sten") && f.form.startsWith("am ")) k = k.slice(0, -2);
      else if (/(e|em|en|er|es)$/.test(k) && f.source && tags.includes("nominative") && tags.includes("feminine") && tags.includes("strong"))
        k = k.slice(0, -1); // "hohe" -> base "hoh", "rötere" -> "röter"
      else if (f.source) continue; // other declined forms: generated from the bases
      if (k !== key) r.forms.add(k);
    }
  } else if (pos === "v") {
    const common = new Set<string>();
    for (const f of forms) {
      if (bad(f)) continue;
      const tags = f.tags ?? [];
      if (tags.some((t) => /passive|perfect|pluperfect|future|gerundive|extended/.test(t)) && !tags.includes("participle-2")) continue;
      if (tags.includes("auxiliary") && !tags.includes("active") && !tags.includes("participle") && !tags.includes("participle-2") && !tags.includes("imperative") && !tags.includes("present") && !tags.includes("past")) continue;
      if (f.form === "haben" || f.form === "sein") continue;
      const k = strip(f.form, true);
      if (!k || k === key) continue;
      if (tags.includes("participle") || tags.includes("participle-2")) r.more.add(k);
      else r.forms.add(k);
      // Imperatives, subjunctives, the second person past and the bare stem ("ich wein'", "lauf!") are rare forms.
      const rare =
        tags.includes("imperative") ||
        ((tags.includes("subjunctive-i") || tags.includes("subjunctive-ii")) && !tags.includes("indicative")) ||
        (tags.includes("second-person") && tags.includes("past")) || // du schliefst, ihr schlicht (schlicht), ihr last (Last)
        k === key.replace(/e?n$/, "");
      if (rare && !common.has(k)) r.rare.add(k);
      else {
        common.add(k);
        r.rare.delete(k);
      }
    }
  }
  if (first && (d.etymology_texts ?? []).some((t: string) => COMPOUND.test(t) && !DERIV.test(t))) r.compound = true;
  if (first) r.parts = partsOf(key, d);
  if (first) {
    const e = etymology(key, d);
    if (e.size > 0) etyBases.set(`${key}\t${pos}`, new Set([...(etyBases.get(`${key}\t${pos}`) ?? []), ...e]));
  }
  for (const x of d.derived ?? []) if (typeof x.word === "string" && !x.word.includes(" ")) r.derived.push(foldWord(x.word));
}

// ---------------------------------------------------------------------------
// Derivations named in "Wortbildungen": keep the ones that are base + suffix

const SUFFIXES = ["", "e", "er", "in", "chen", "lein", "ung", "heit", "keit", "schaft", "lich", "ig", "isch", "bar", "sam", "los", "haft", "ei", "nis", "tum", "ling", "t", "st", "el", "ler", "ner", "ist", "ismus", "ität", "ieren", "en", "n", "s", "ie", "iker"];

function umlaut(s: string): string[] {
  const m = s.match(/^(.*?)(au|a|o|u)([^aeiouäöü]*)$/);
  if (!m) return [];
  const u = m[2] === "au" ? "äu" : m[2] === "a" ? "ä" : m[2] === "o" ? "ö" : "ü";
  return [m[1] + u + m[3]];
}

function stems(base: string, pos: Pos): string[] {
  const out = new Set<string>([base]);
  if (pos === "v") {
    if (base.endsWith("en")) out.add(base.slice(0, -2));
    else if (base.endsWith("n")) out.add(base.slice(0, -1));
  }
  if (pos === "n" && base.endsWith("e")) out.add(base.slice(0, -1));
  // Feuer -> feur-ig, angeln -> angl-er, Hunger -> hungr-ig, dunkel -> dunkl-er
  for (const s of [...out]) if (/(er|el)$/.test(s) && s.length >= 4) out.add(s.slice(0, -2) + s.slice(-1));
  for (const s of [...out]) for (const u of umlaut(s)) out.add(u);
  return [...out].filter((s) => s.length >= 2);
}

/** The part of speech a suffix makes: verbs (-en, -ieren), adjectives (-ig, -lich), else nouns. */
function suffixPos(suf: string): Pos {
  if (["en", "n", "ieren"].includes(suf)) return "v";
  if (["ig", "lich", "isch", "bar", "sam", "los", "haft"].includes(suf)) return "a";
  return "n";
}

/**
 * `d` (of part of speech `pos`) is `base` plus a suffix (Bäcker = back + er,
 * Kätzchen = kätz + chen), not a compound: the rest is not a noun of its own
 * (Hühnerei is Hühner + Ei).
 */
function isDerivation(d: string, dPos: Pos, base: string, pos: Pos, nouns: (w: string) => boolean): boolean {
  if (d === base) return false;
  for (const s of stems(base, pos)) {
    if (!d.startsWith(s)) continue;
    const rest = d.slice(s.length);
    const ok = (suf: string, tail: string) => {
      const last = tail === "" ? suf : tail;
      if (suffixPos(last) !== dPos && !(dPos === "n" && last === "")) return false;
      // The rest is a word of its own: a compound (Hühner-ei, Lauf-band).
      for (const r of [rest, tail]) if (r.length >= 2 && nouns(r) && !["er", "in", "el", "en", "ie", "ler", "ner", "chen", "lein", "ling", "tum", "heit", "keit", "schaft", "nis"].includes(r)) return false;
      return true;
    };
    if (SUFFIXES.includes(rest) && ok(rest, "")) return true;
    // two suffixes: Freundlichkeit, Lehrerin
    for (const a of SUFFIXES) if (a !== "" && rest.startsWith(a) && SUFFIXES.includes(rest.slice(a.length)) && ok(a, rest.slice(a.length))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------

function encode(key: string, form: string): string {
  let p = 0;
  while (p < key.length && p < form.length && key[p] === form[p]) p++;
  const drop = key.length - p;
  return (drop > 0 ? String(drop) : "") + form.slice(p);
}

async function main(): Promise<void> {
  const explain = process.argv.includes("--explain") ? process.argv.slice(process.argv.indexOf("--explain") + 1).map(foldWord) : null;
  await ensureEntries();
  for await (const line of lines(FREQ, false)) {
    const [w, c] = line.split(" ");
    if (w && c) {
      const k = foldWord(w);
      freq.set(k, (freq.get(k) ?? 0) + Number(c));
    }
  }
  for await (const line of lines(ENTRIES, false)) addEntry(JSON.parse(line));

  // Choose the lemmas: how often their forms occur.
  const score = (r: Rec) => {
    let s = count(r.key);
    for (const f of [...r.forms, ...r.more]) if (f !== r.key) s += count(f);
    return s;
  };
  // Every secret word and its accepted guesses go in, however rare.
  const forced = new Set<string>();
  const list = join(here, "..", "..", "..", "data", "words.de.txt");
  if (existsSync(list)) {
    for (const line of readFileSync(list, "utf8").split("\n")) {
      if (line.startsWith("#") || !line.trim()) continue;
      const [w, , , also] = line.split("\t");
      for (const x of [w ?? "", ...(also ?? "").split(",")]) if (x.trim()) forced.add(foldWord(x.trim()));
    }
  }
  const chosen = new Map<string, Rec>();
  for (const [id, r] of recs) if (score(r) >= MIN_COUNT || forced.has(r.key)) chosen.set(id, r);
  const keys = new Map<string, Rec[]>();
  for (const r of chosen.values()) keys.set(r.key, [...(keys.get(r.key) ?? []), r]);

  // Family: etymology, named derivations, Wortbildungen that are base + suffix.
  for (const r of chosen.values()) {
    for (const b of etyBases.get(`${r.key}\t${r.pos}`) ?? []) if (b !== r.key && keys.has(b)) r.family.add(b);
    for (const b of named.get(r.key) ?? []) if (b !== r.key && keys.has(b)) r.family.add(b);
  }
  const isNoun = (w: string) => (keys.get(w) ?? []).some((r) => r.pos === "n");
  for (const b of chosen.values()) {
    if (b.pos === "x" || b.pos === "e") continue;
    for (const d of b.derived) {
      for (const r of keys.get(d) ?? []) if (r.pos !== "x" && r.pos !== "e" && !r.compound && isDerivation(d, r.pos, b.key, b.pos, isNoun)) r.family.add(b.key);
    }
  }
  // Links people would not call a family (curated: family-deny.tsv).
  for (const line of readFileSync(join(here, "family-deny.tsv"), "utf8").split("\n")) {
    if (line.startsWith("#") || !line.trim()) continue;
    const [d, b] = line.split("\t").map((x) => foldWord(x.trim()));
    for (const r of keys.get(d!) ?? []) r.family.delete(b!);
  }
  // Pronouns, articles and the like derive from nothing (and nothing from them).
  for (const r of chosen.values()) if (r.pos === "x") r.family.clear();

  // A form that is a lemma of the same part of speech, not of the same family,
  // is that lemma and not this form: Reise is not Reis's plural, Schale not
  // Schal's, lauter (pure) not laut's comparative.
  const related = (a: string, b: string) => {
    const fa = new Set([a]);
    for (const r of keys.get(a) ?? []) for (const x of r.family) fa.add(x);
    for (const r of keys.get(b) ?? []) {
      if (fa.has(b)) return true;
      for (const x of r.family) if (fa.has(x)) return true;
    }
    return fa.has(b);
  };
  let dropped = 0;
  const lemmaOf = (k: string, pos: Pos) => (keys.get(k) ?? []).some((r) => r.pos === pos && !r.adjNoun);
  const anyLemma = (k: string) => (keys.get(k) ?? []).some((r) => (r.pos === "n" || r.pos === "v" || r.pos === "a") && !r.adjNoun);
  for (const r of chosen.values()) {
    for (const set of [r.forms, r.more]) {
      for (const f of [...set]) {
        if (f === r.key) continue;
        // Subjunctives and imperatives give way to any word of their spelling: Planet
        // is not "ihr planet" (planen), Eis not "eis!" (eisen). Past tenses do not (sang, schwamm).
        if ((lemmaOf(f, r.pos) || (r.rare.has(f) && anyLemma(f))) && !related(f, r.key)) {
          set.delete(f);
          dropped++;
          if (explain?.includes(f) || explain?.includes(r.key)) console.log(`drop ${f} from ${r.key} (${r.pos}): a lemma of its own`);
        }
      }
    }
  }

  if (explain) {
    for (const k of explain) {
      for (const r of keys.get(k) ?? []) {
        console.log(`${k} ${r.pos}${r.adjNoun ? " (adj. noun)" : ""} parts ${r.parts === null ? "-" : (r.parts?.join("+") ?? "?")} rare ${[...r.rare].join(",")} score ${score(r)}: forms ${[...r.forms].join(",")} | ${[...r.more].join(",")} | family ${[...r.family].join(",")}`);
      }
      if (!keys.has(k)) console.log(`${k}: not in the lexicon${[...recs.values()].some((r) => r.key === k) ? ` (below MIN_COUNT)` : ""}`);
    }
    return;
  }

  const out: string[] = [];
  for (const r of [...chosen.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.pos < b.pos ? -1 : 1))) {
    const enc = (s: Set<string>) => [...s].filter((f) => f !== r.key).sort().map((f) => encode(r.key, f)).join(",");
    let forms = "";
    if (r.pos === "n" || r.pos === "e" || r.pos === "v") forms = `${enc(r.forms)}|${enc(r.more)}`;
    else if (r.pos === "a") forms = enc(r.forms);
    if (forms === "|") forms = "";
    const fam = [...r.family].sort().join(",");
    const parts = r.parts === null ? "-" : r.parts ? r.parts.join("+") : "";
    out.push([r.key, r.pos + (r.adjNoun ? "*" : ""), forms, fam, parts].join("\t").replace(/\t+$/, ""));
  }
  const header =
    "# Jinx German lexicon: lemma<TAB>pos<TAB>forms<TAB>family<TAB>parts (see design/matching/de/SPEC.md §2).\n" +
    "# From the German Wiktionary (de.wiktionary.org, CC BY-SA 4.0), see dict.de-LICENSE.txt.\n";
  const text = header + out.join("\n") + "\n";
  const data = join(here, "..", "..", "..", "data");
  writeFileSync(join(data, "dict.de.txt"), text);
  writeFileSync(join(data, "dict.de-LICENSE.txt"), readFileSync(join(here, "LICENSE-NOTICE.txt"), "utf8"));
  const forms = [...chosen.values()].reduce((s, r) => s + r.forms.size + r.more.size + 1, 0);
  const fam = [...chosen.values()].filter((r) => r.family.size > 0).length;
  console.log(
    `dict.de.txt: ${chosen.size} lemmas (${recs.size} in the Wiktionary, MIN_COUNT ${MIN_COUNT}), ${forms} stored forms, ` +
      `${fam} with a family, ${dropped} forms dropped as lemmas of their own; ` +
      `${Buffer.byteLength(text)} bytes, ${gzipSync(text, { level: 9 }).length} gzipped`,
  );
}

await main();
