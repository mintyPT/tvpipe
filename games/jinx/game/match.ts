// Jinx: clue cleaning and duplicate ("jinx") matching for English.
//
// Erasable TypeScript, browser APIs only, no dependencies. See SPEC.md for the
// rules and their reasons; match.test.ts holds the known-answer table.
//
//   clean(raw)                    phone input -> Clue (or an input error)
//   sameClue(a, b)                do two clues jinx? -> Reason | null
//   invalidClue(clue, secret)     is a clue too close to the secret word?
//   judgeGuess(guess, secret)     is the typed guess the secret word?
//   groupClues(clues, secret)     struck clues + jinx groups (transitive)
//
// Everything is deterministic and depends only on the two strings (plus the
// optional `known` dictionary predicate), so every device computes the same.

/** A lookup table without a prototype: typed words like "constructor" are not in it. */
function table<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

export const MAX_CHARS = 24;
export const MAX_WORDS = 2;

export type Reason =
  | "same word"
  | "same number"
  | "spelling"
  | "plural"
  | "verb form"
  | "word form"
  | "same family"
  | "typo"
  | "sounds the same"
  | "contains the word"
  | "part of the word"
  | "backwards"
  | "too close";

/** Short text for the TV, e.g. `cats = cat · plural`. */
export const REASON_TEXT: Record<Reason, string> = {
  "same word": "same word",
  "same number": "same number",
  spelling: "other spelling",
  plural: "plural",
  "verb form": "verb form",
  "word form": "word form",
  "same family": "same family",
  typo: "typo",
  "sounds the same": "sounds the same",
  "contains the word": "contains the word",
  "part of the word": "part of the word",
  backwards: "backwards",
  "too close": "too close",
};

export interface Clue {
  /** What the TV shows: trimmed, spaces collapsed, NFC, original case. */
  display: string;
  /** Canonical form: a-z0-9 only, words joined, number words as digits; "~…" for symbol clues. */
  key: string;
  /** Canonical words (key = parts.join("")). */
  parts: string[];
  kind: "word" | "number" | "symbol";
}

/** TV line for a pair: "cats = cat · plural", "elefant ≈ elephant · typo". */
export function explain(a: Clue, b: Clue, r: Reason): string {
  const sign = r === "typo" || r === "sounds the same" || r === "spelling" || r === "backwards" ? "≈" : r === "contains the word" ? "⊃" : r === "part of the word" ? "⊂" : "=";
  return `${a.display} ${sign} ${b.display} · ${REASON_TEXT[r]}`;
}

export type CleanError = "empty" | "too-long" | "too-many-words" | "not-english";
export type Cleaned = { ok: true; clue: Clue } | { ok: false; error: CleanError; message: string };

export interface MatchOptions {
  /**
   * Optional dictionary. When given, two known words are never typos of each
   * other, and a word the dictionary does not know gets the looser typo
   * budget (missing or doubled letters count as one edit).
   */
  known?: (word: string) => boolean;
}

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

const MESSAGES: Record<CleanError, string> = {
  empty: "Type a clue",
  "too-long": `Too long (${MAX_CHARS} characters at most)`,
  "too-many-words": "One word please (two at most, for names)",
  "not-english": "English letters and numbers only",
};

const FOLD: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i", ĸ: "k" };

/** A single symbol typed as the whole clue reads as its name. */
const SYMBOL_NAMES: Record<string, string> = table({
  $: "dollar",
  "€": "euro",
  "£": "pound",
  "¥": "yen",
  "%": "percent",
  "&": "and",
  "+": "plus",
  "@": "at",
  "°": "degree",
});

const EMOJI_EXTRA = /[\u{FE0E}\u{FE0F}\u{1F3FB}-\u{1F3FF}]/gu;

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

  // Fold case and diacritics: "Café" -> "cafe", "Straße" -> "strasse".
  let f = s.toLowerCase();
  f = f.replace(/[ßæœøłđðþıĸ]/g, (c) => FOLD[c] ?? c);
  f = f.normalize("NFD").replace(/\p{M}/gu, "");

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
    // Emoji and symbols are decoration; punctuation is dropped ("Bang!" = "bang").
    const pictures = t.match(/[\p{Extended_Pictographic}\p{S}\u{1F1E6}-\u{1F1FF}\u200D]/gu);
    if (pictures) decor += pictures.join("");
    const rest = t.replace(/[\p{Extended_Pictographic}\p{S}\p{P}\u{1F1E6}-\u{1F1FF}\u200D\uFE0E\uFE0F]/gu, "");
    if (rest === "") continue;
    if (!/^[a-z0-9]+$/.test(rest)) return fail("not-english");
    parts.push(rest);
  }

  if (parts.length === 0) {
    const sym = decor.replace(EMOJI_EXTRA, "").replace(/\u200D/g, "");
    if (sym === "") return fail("empty");
    return { ok: true, clue: { display, key: "~" + collapseRuns(sym), parts: [], kind: "symbol" } };
  }
  // Hyphenated or slashed compounds count as one word; spaces separate words.
  const wordCount = words.filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (wordCount > MAX_WORDS) return fail("too-many-words");

  parts = parts.map(collapseRuns);
  // "a cat", "the Beatles", "to run": a leading article or "to" does not make a different clue.
  if (parts.length > 1 && LEADING.has(parts[0]!)) parts = parts.slice(1);
  parts = numberParts(parts);
  const key = parts.join("");
  const kind = /^\d+(st|nd|rd|th)?$/.test(key) ? "number" : "word";
  return { ok: true, clue: { display, key, parts, kind } };
}

const LEADING = new Set(["a", "an", "the", "to"]);

/** "riiiing" -> "riing", "zzzz" -> "zz": three or more of a letter become two. */
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

type NumTok = { v: number; t: "zero" | "unit" | "teen" | "tens" | "hundred" | "scale" };
const NUM_WORDS = new Map<string, NumTok>();
["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].forEach((w, i) =>
  NUM_WORDS.set(w, { v: i, t: i === 0 ? "zero" : "unit" }),
);
["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"].forEach(
  (w, i) => NUM_WORDS.set(w, { v: 10 + i, t: "teen" }),
);
["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"].forEach((w, i) =>
  NUM_WORDS.set(w, { v: 20 + 10 * i, t: "tens" }),
);
NUM_WORDS.set("hundred", { v: 100, t: "hundred" });
NUM_WORDS.set("thousand", { v: 1000, t: "scale" });
NUM_WORDS.set("million", { v: 1e6, t: "scale" });
NUM_WORDS.set("billion", { v: 1e9, t: "scale" });
const NUM_LIST = [...NUM_WORDS.keys()].sort((a, b) => b.length - a.length);

/** Ordinals that are not also common words ("second" is a unit of time). */
const ORDINALS: Record<string, string> = table({
  first: "1st",
  third: "3rd",
  fourth: "4th",
  fifth: "5th",
  sixth: "6th",
  seventh: "7th",
  eighth: "8th",
  ninth: "9th",
  tenth: "10th",
  eleventh: "11th",
  twelfth: "12th",
});

/** "twentyone", "onehundred" -> "21", "100"; null unless the whole string is number words. */
export function parseNumberWords(s: string): string | null {
  const toks: NumTok[] = [];
  let i = 0;
  outer: while (i < s.length) {
    for (const w of NUM_LIST) {
      if (s.startsWith(w, i)) {
        toks.push(NUM_WORDS.get(w)!);
        i += w.length;
        continue outer;
      }
    }
    if (s.startsWith("and", i) && toks.length > 0) {
      i += 3; // "one hundred and one"
      continue;
    }
    return null;
  }
  if (toks.length === 0) return null;
  if (toks[0]!.t === "zero") return toks.length === 1 ? "0" : null;
  let total = 0;
  let cur = 0;
  let last: NumTok["t"] | null = null;
  for (const k of toks) {
    switch (k.t) {
      case "zero":
        return null;
      case "unit":
        if (last === "unit" || last === "teen") return null;
        cur += k.v;
        break;
      case "teen":
      case "tens":
        if (last === "unit" || last === "teen" || last === "tens") return null;
        cur += k.v;
        break;
      case "hundred":
        if (last === "hundred") return null;
        cur = (cur === 0 ? 1 : cur) * 100;
        break;
      case "scale":
        if (last === "scale") return null;
        total += (cur === 0 ? 1 : cur) * k.v;
        cur = 0;
        break;
    }
    last = k.t;
  }
  return String(total + cur);
}

function numberParts(parts: string[]): string[] {
  const whole = parseNumberWords(parts.join(""));
  if (whole !== null) return [whole];
  return parts.map((p) => ORDINALS[p] ?? parseNumberWords(p) ?? p);
}

// ---------------------------------------------------------------------------
// Letters and syllables
// ---------------------------------------------------------------------------

function isVowelAt(w: string, i: number): boolean {
  const c = w[i];
  if (c === "u" && i > 0 && w[i - 1] === "q") return false; // squat, quit
  if (c === "a" || c === "e" || c === "i" || c === "o" || c === "u") return true;
  return c === "y" && i > 0 && !isVowelAt(w, i - 1);
}

function hasVowel(w: string): boolean {
  for (let i = 0; i < w.length; i++) if (isVowelAt(w, i)) return true;
  return false;
}

function isConsonantAt(w: string, i: number): boolean {
  return i >= 0 && i < w.length && /[a-z]/.test(w[i]!) && !isVowelAt(w, i);
}

/** Ends in a short syllable (Porter): consonant-vowel-consonant (not w, x, y), or vowel-consonant as the whole word. */
function endsCVC(w: string): boolean {
  const n = w.length;
  if (n === 2) return isVowelAt(w, 0) && isConsonantAt(w, 1);
  if (n < 3) return false;
  return isConsonantAt(w, n - 3) && isVowelAt(w, n - 2) && isConsonantAt(w, n - 1) && !/[wxy]/.test(w[n - 1]!);
}

/** One vowel group and a short syllable at the end: "hop", "stop", "car". Such stems double before -ed/-ing/-er. */
function isShort(w: string): boolean {
  if (!endsCVC(w)) return false;
  let groups = 0;
  for (let i = 0; i < w.length; i++) if (isVowelAt(w, i) && !isVowelAt(w, i - 1)) groups++;
  return groups === 1;
}

/** Ends in a doubled consonant that English doubles before a suffix (not ss: kiss, mass). */
function endsDouble(w: string): boolean {
  const n = w.length;
  return n >= 3 && w[n - 1] === w[n - 2] && isConsonantAt(w, n - 1) && w[n - 1] !== "s";
}

// ---------------------------------------------------------------------------
// Spelling variants (UK -> US) and phonetic key
// ---------------------------------------------------------------------------

const SPELLING_TABLE: Record<string, string> = table(Object.fromEntries(
  (
    "grey:gray tyre:tire kerb:curb plough:plow mould:mold moult:molt smoulder:smolder aluminium:aluminum " +
    "pyjama:pajama pyjamas:pajamas moustache:mustache doughnut:donut sceptic:skeptic sceptical:skeptical sulphur:sulfur " +
    "storey:story tonne:ton draught:draft gaol:jail cosy:cozy mum:mom mummy:mommy arse:ass aeroplane:airplane " +
    "axe:ax whisky:whiskey yoghurt:yogurt yoghourt:yogurt ageing:aging artefact:artifact cheque:check disc:disk " +
    "judgement:judgment practise:practice programme:program speciality:specialty maths:math jewellery:jewelry " +
    "woollen:woolen skilful:skillful wilful:willful fulfil:fulfill enrol:enroll instalment:installment " +
    "defence:defense offence:offense licence:license pretence:pretense encyclopaedia:encyclopedia " +
    "anaemia:anemia paediatric:pediatric orthopaedic:orthopedic haemoglobin:hemoglobin mediaeval:medieval " +
    "foetus:fetus oesophagus:esophagus diarrhoea:diarrhea amoeba:ameba manoeuvre:maneuver gramme:gram " +
    "kilogramme:kilogram cancelled:canceled travelling:traveling traveller:traveler jeweller:jeweler " +
    "catalog:catalog analog:analog pyjamas:pajamas chilli:chili omelette:omelet kebab:kabob " +
    "neighbour:neighbor neighbourhood:neighborhood"
  )
    .split(/\s+/)
    .map((p) => p.split(":") as [string, string]),
));

/** Words the -re/-er rule must not touch: a different word in its -er form. */
const SPELLING_KEEP = new Set(["timbre"]);

/** UK -> US spelling and ph -> f; both clues go through it, so only equality matters. */
export function spellNorm(w: string): string {
  if (!/[a-z]/.test(w)) return w;
  let s = SPELLING_TABLE[w] ?? w;
  if (s === w && !SPELLING_KEEP.has(w)) {
    s = s.replace(/^([a-z]{2,})our(s|ed|ing|ful|fully|less|able|ably|ite|ites|er|ers|ist|ists|y|hood|hoods)?$/, "$1or$2");
    s = s.replace(/^([a-z]{2,}[bcdfgkmnpqstvz])re(s?)$/, "$1er$2");
    s = s.replace(/^([a-z]{2,}[bcdfgkmnpqstvz])red$/, "$1ered");
    s = s.replace(/^([a-z]{3,})is(e|es|ed|ing|er|ers|ation|ations)$/, "$1iz$2");
    s = s.replace(/^([a-z]{3,})ys(e|es|ed|ing)$/, "$1yz$2");
    s = s.replace(/^([a-z]{4,})ogue(s?)$/, "$1og$2");
  }
  return s.replace(/ph/g, "f");
}

/**
 * A coarse sound key, used only against the secret word and for guesses:
 * hard c = k, qu = kw, x = ks, silent kn-/wr-/wh-, ph = f. Doubled letters
 * are kept (diner/dinner).
 */
function soundKey(w: string): string {
  let s = spellNorm(w);
  s = s.replace(/^kn/, "n").replace(/^wr/, "r").replace(/^wh/, "w").replace(/^sch/, "sk");
  // Hard c only: "rice" is not "rise", "backed" is not "baked".
  s = s.replace(/c(?![eiyhk])/g, "k").replace(/qu/g, "kw").replace(/q/g, "k");
  s = s.replace(/x/g, "ks");
  return s;
}

const HOMOPHONES: string[][] = (
  "night knight|weather whether|flower flour|bear bare|hair hare|sea see|sun son|sale sail|tail tale|mail male|" +
  "pair pear pare|meat meet|peace piece|plain plane|right write rite|road rode rowed|rose rows|nose knows|" +
  "new knew gnu|knot not|hole whole|hour our|eye i|which witch|wood would|wait weight|week weak|deer dear|" +
  "bee be|tea tee|pea pee|toe tow|sew so sow|ate eight|one won|two too to|four for fore|berry bury|cell sell|" +
  "cent scent sent|flu flew|heel heal|here hear|steal steel|stair stare|sweet suite|wail whale|way weigh|" +
  "wear where|yolk yoke|bored board|break brake|buy by bye|cereal serial|chili chilly|colonel kernel|dew due|" +
  "die dye|fair fare|fir fur|flea flee|groan grown|guest guessed|horse hoarse|jeans genes|knead need|lead led|" +
  "mane main|maze maize|medal meddle|mussel muscle|nun none|oar or ore|pain pane|pause paws|peak peek|" +
  "pole poll|pray prey|principal principle|rain reign rein|read reed|ring wring|root route|sole soul|some sum|" +
  "stake steak|tide tied|vain vein|waist waste|whine wine|wrap rap|aloud allowed|ball bawl|beat beet|" +
  "beach beech|blew blue|boy buoy|bread bred|chord cord|claws clause|coarse course|creek creak|doe dough|" +
  "dual duel|gate gait|great grate|hall haul|heard herd|high hi|hymn him|idle idol|in inn|isle aisle|" +
  "loan lone|made maid|missed mist|moose mousse|morning mourning|naval navel|pail pale|plum plumb|" +
  "profit prophet|raise rays|roll role|scene seen|seam seem|sight site cite|stationary stationery|" +
  "symbol cymbal|threw through|throne thrown|warn worn|wade weighed|knit nit|gorilla guerrilla|ewe you yew|" +
  "hay hey|pedal peddle|toad towed|wrote rote|wrest rest|whale wale|sword soared|cheap cheep|bean been|" +
  "brews bruise|ceiling sealing|days daze|find fined|lessen lesson|marshal martial|mince mints|" +
  "packed pact|patience patients|plaice place|presence presents|rapped rapt wrapped|sore soar|tacks tax|" +
  "trussed trust|wax whacks"
)
  .split("|")
  .map((g) => g.split(" "));

const HOMOPHONE_ID = new Map<string, number[]>();
HOMOPHONES.forEach((g, i) => g.forEach((w) => HOMOPHONE_ID.set(w, [...(HOMOPHONE_ID.get(w) ?? []), i])));

// ---------------------------------------------------------------------------
// Inflection: plurals and verb forms
// ---------------------------------------------------------------------------

type Kind = "plural" | "verb form" | "same family";

const IRREGULAR = new Map<string, { base: string; kind: Kind }>();
function irregular(kind: Kind, table: string): void {
  for (const entry of table.split(/\s+/)) {
    if (!entry) continue;
    const [base, forms] = entry.split(":") as [string, string];
    for (const f of forms.split(",")) IRREGULAR.set(f, { base, kind });
  }
}
irregular(
  "plural",
  "man:men woman:women child:children foot:feet tooth:teeth goose:geese mouse:mice louse:lice person:people " +
    "ox:oxen cactus:cacti fungus:fungi octopus:octopi nucleus:nuclei radius:radii alumnus:alumni stimulus:stimuli " +
    "criterion:criteria phenomenon:phenomena bacterium:bacteria larva:larvae antenna:antennae formula:formulae " +
    "index:indices appendix:appendices matrix:matrices vertex:vertices die:dice penny:pence axis:axes",
);
irregular(
  "verb form",
  "be:am,is,are,was,were,been,being have:has,had,having do:does,did,done,doing go:goes,went,gone " +
    "run:ran see:seen eat:ate,eaten fly:flew,flown swim:swam,swum sing:sang,sung ring:rang,rung drink:drank,drunk " +
    "write:wrote,written drive:drove,driven ride:rode,ridden take:took,taken give:gave,given break:broke,broken " +
    "speak:spoke,spoken freeze:froze,frozen choose:chose,chosen steal:stole,stolen wake:woke,woken wear:wore,worn " +
    "tear:tore,torn begin:began,begun fall:fell,fallen hold:held lose:lost make:made pay:paid say:said sell:sold " +
    "tell:told think:thought bring:brought buy:bought catch:caught teach:taught fight:fought seek:sought " +
    "build:built send:sent spend:spent bend:bent lend:lent mean:meant sleep:slept keep:kept weep:wept " +
    "sweep:swept creep:crept deal:dealt dream:dreamt learn:learnt burn:burnt spell:spelt spill:spilt " +
    "kneel:knelt hear:heard find:found sit:sat meet:met feed:fed bleed:bled flee:fled shoot:shot stand:stood " +
    "understand:understood win:won dig:dug hang:hung strike:struck swing:swung spin:spun sting:stung " +
    "cling:clung fling:flung shake:shook forget:forgot,forgotten get:got,gotten hide:hid,hidden bite:bitten " +
    "blow:blew,blown grow:grew,grown know:knew,known throw:threw,thrown draw:drew,drawn show:shown " +
    "sink:sank,sunk shrink:shrank,shrunk stink:stank,stunk spring:sprang,sprung forgive:forgave,forgiven " +
    "die:dying lie:lying tie:tying come:came weave:wove,woven bear:borne shine:shone slide:slid lead:led " +
    "become:became overcome:overcame lay:laid rise:risen,arose arise:arisen,arose shake:shaken swear:swore,sworn " +
    "leap:leapt breed:bred sew:sewn sow:sown prove:proven spoil:spoilt slay:slain awake:awoke,awoken free:freed " +
    "mistake:mistook,mistaken undertake:undertook,undertaken overtake:overtook,overtaken undo:undid,undone " +
    "rebuild:rebuilt repay:repaid foresee:foresaw,foreseen forbid:forbade,forbidden undergo:underwent,undergone",
);
irregular("same family", "good:better,best bad:worse,worst far:further,farther,furthest,farthest");

/** Irregular plurals inside compounds: "snowmen", "grandchildren", "dormice". */
const IRREGULAR_SUFFIX: [string, string][] = [
  ["men", "man"],
  ["children", "child"],
  ["feet", "foot"],
  ["teeth", "tooth"],
  ["geese", "goose"],
  ["mice", "mouse"],
];

/** Words whose ending looks like an inflection but is not one. */
const NO_INFLECT = new Set(
  (
    "news series species his has was this thus yes is us as its plus lens chaos iris always perhaps towards " +
    "whereas evening herring during nothing something anything everything ceiling pudding united wicked naked " +
    "sacred hundred kindred bus gas mars wales athens paris texas cosmos christmas thanks physics maths " +
    "mathematics politics economics ethics athletics gymnastics olympics glasses scissors trousers jeans " +
    "shorts pants clothes news innings earnings ring king thing sing wing spring string swing sling bring"
  ).split(" "),
);

/** Words that are plural but should still meet their singular (they are in NO_INFLECT for other reasons). */
const PLURAL_ALSO: Record<string, string> = table({ glasses: "glass", shorts: "short" });

function addVerbStem(out: Map<string, Kind>, s: string): void {
  if (s.length < 2 || !hasVowel(s)) return;
  if (s.endsWith("u")) out.set(s + "e", "verb form"); // arguing -> argue, glued -> glue
  if (s.endsWith("ick") && s.length >= 5) out.set(s.slice(0, -1), "verb form"); // panicked -> panic
  if (endsDouble(s)) {
    const d = s.slice(0, -1);
    if (endsCVC(d) || s.endsWith("ll")) out.set(d, "verb form"); // hopped -> hop, travelled -> travel
    // filled -> fill, buzzed -> buzz, egged -> egg; but not hopped -> hopp, earring -> earr
    if (/(ll|ff|zz)$/.test(s) || s.length === 3) out.set(s, "verb form");
    return;
  }
  if (isShort(s)) {
    out.set(s + "e", "verb form"); // hoped -> hope (hop would be hopped)
    return;
  }
  out.set(s, "verb form");
  if (isConsonantAt(s, s.length - 1)) out.set(s + "e", "verb form"); // danced -> dance
}

/** Candidate base forms of a word (not including the word itself). */
export function inflections(w: string): Map<string, Kind> {
  const out = new Map<string, Kind>();
  const irr = IRREGULAR.get(w);
  if (irr) out.set(irr.base, irr.kind);
  for (const [form, base] of IRREGULAR_SUFFIX) {
    if (w.endsWith(form) && w.length > form.length + 1) out.set(w.slice(0, -form.length) + base, "plural");
  }
  const also = PLURAL_ALSO[w];
  if (also) out.set(also, "plural");
  if (NO_INFLECT.has(w) || !/^[a-z]+$/.test(w) || w.length < 3) return out;

  // Plurals and third person -s.
  if (w.endsWith("ies") && w.length >= 4) {
    out.set(w.slice(0, -3) + "y", "plural"); // cities -> city
    out.set(w.slice(0, -1), "plural"); // pies -> pie
  } else if (w.endsWith("ves") && w.length >= 5) {
    const s = w.slice(0, -3);
    out.set(s + "f", "plural"); // wolves -> wolf
    if (s.endsWith("i")) out.set(s + "fe", "plural"); // knives -> knife (not caves -> cafe)
    out.set(w.slice(0, -1), "plural"); // gloves -> glove
  } else if (w.endsWith("es") && w.length >= 4) {
    const s = w.slice(0, -2);
    if (/(s|x|z|ch|sh|o)$/.test(s) && s.length >= 3) out.set(s, "plural"); // boxes -> box, heroes -> hero
    if (s.endsWith("zz")) out.set(s.slice(0, -1), "plural"); // quizzes -> quiz
    if (w.endsWith("ses")) out.set(w.slice(0, -3) + "sis", "plural"); // crises -> crisis
    out.set(w.slice(0, -1), "plural"); // horses -> horse
  } else if (w.endsWith("s") && !w.endsWith("ss")) {
    const s = w.slice(0, -1);
    // ads -> ad, ups -> up; but not gas -> ga, bus -> bu
    if ((s.length >= 3 || (s.length === 2 && isConsonantAt(s, 1))) && hasVowel(s)) out.set(s, "plural");
  }

  // Past tense / participle.
  if (w.endsWith("oed")) out.set(w.slice(0, -1), "verb form"); // tiptoed -> tiptoe, canoed -> canoe
  if (w.endsWith("eed")) {
    // agreed -> agree, but not need/seed/speed (no vowel-consonant before "eed").
    const pre = w.slice(0, -3);
    if (/[aeiou][^aeiou]/.test(pre)) out.set(w.slice(0, -1), "verb form");
  } else if (w.endsWith("ied") && w.length >= 4) {
    out.set(w.slice(0, -3) + "y", "verb form"); // cried -> cry
    out.set(w.slice(0, -1), "verb form"); // tied -> tie
  } else if (w.endsWith("ed") && w.length >= 4) {
    addVerbStem(out, w.slice(0, -2));
  }

  // Present participle.
  if (w.endsWith("ing") && w.length >= 5) addVerbStem(out, w.slice(0, -3));
  return out;
}

// ---------------------------------------------------------------------------
// Word family: derivational suffixes
// ---------------------------------------------------------------------------

interface Suffix {
  suf: string;
  min: number; // minimum stem length
  restore?: boolean; // may restore a dropped final e (bake -> baker)
  noStem?: boolean; // only the extra candidates
  extra?: (stem: string) => string[];
}

const SUFFIXES: Suffix[] = [
  { suf: "er", min: 3, restore: true },
  { suf: "est", min: 3, restore: true },
  { suf: "or", min: 3, extra: (s) => (s.endsWith("at") ? [s + "e"] : []) },
  { suf: "ess", min: 3, restore: true },
  { suf: "ness", min: 3 },
  { suf: "ly", min: 4, extra: (s) => (/[bdgkt]$|mp$|zz$/.test(s) ? [s + "le"] : []) },
  { suf: "y", min: 3, restore: true },
  { suf: "ful", min: 3 },
  { suf: "less", min: 3 },
  { suf: "ish", min: 3, restore: true },
  { suf: "ist", min: 3, restore: true },
  { suf: "ism", min: 3, restore: true },
  { suf: "ese", min: 3, extra: (s) => [s + "a"] },
  { suf: "ian", min: 2, extra: (s) => [s + "y", s + "a", s + "ia"] },
  { suf: "an", min: 4, noStem: true, extra: (s) => [s + "a"] }, // american -> america
  { suf: "ic", min: 4, extra: (s) => [s + "y", s + "e"] },
  { suf: "al", min: 4, restore: true },
  { suf: "ion", min: 3, restore: true },
  { suf: "ation", min: 3, restore: true },
  { suf: "ment", min: 3 },
  { suf: "hood", min: 3 },
  { suf: "ship", min: 3 },
  { suf: "dom", min: 4 },
  { suf: "able", min: 3, restore: true },
  { suf: "ible", min: 3, restore: true },
  { suf: "ive", min: 3, restore: true },
  { suf: "ous", min: 3, restore: true },
  { suf: "en", min: 4 },
];

/** Words that end like a derivation but are not one (corner is not corn + er). */
const NOT_DERIVED = new Set(
  (
    // -er / -or / -ess
    "shower mother brother corner letter number manner hammer summer dinner master cover liver flower power " +
    "tower hunger sewer butter matter copper banner ladder caper clover cower gutter better supper pepper " +
    "skipper badger litter bitter offer water crater wager homer tailor mayor sector after other under " +
    "over ever never river silver finger ginger anger danger paper timber member chamber wafer later " +
    "slipper poster ponder wonder order border corner cancer soccer lobster hamster mister sister " +
    "caress mattress fortress buttress witness harness business princess " +
    // -y
    "party army belly carry penny bunny kitty poppy every fairy ready study bully brandy early weary irony " +
    "story gravy holy city navy copy tidy phony baby pony duty jury wary body lady buddy hobby lobby county " +
    "canny putty petty jetty nappy hippy paddy telly silly billy wally parry tarry pansy pasty many any " +
    "candy handy honey money ivy jelly berry cherry curry hurry worry sorry marry merry ferry chilly " +
    "mummy tummy dummy granny nanny ditty pretty gritty fussy bossy messy sunny " +
    // -ly
    "early apply supply reply comply only family holy belly jelly bully italy july rally ally silly lily " +
    "butterfly pearly curly surly burly " +
    // -ish / -al / -ic / -able / -ive / -ous / -ment / -en / -ion
    "finish polish parish banish vanish punish lavish perish relish radish " +
    "final metal petal sandal portal medal pedal total rival naval moral coral " +
    "capable table cable stable fable " +
    "archive olive " +
    "callous " +
    "pigment apartment department comment cement garment " +
    "listen pollen heathen warden kitten often linen garden " +
    "onion union lion million billion opinion region legion champion mansion notion lotion motion potion " +
    "portion station nation ration " +
    "basement animal question mission passion session forest honest modest assist " +
    // found by sweep.ts
    "shoulder happen heaven bother wander former easter arrest rubbish mental mention jackal oliver " +
    "accordion canal compassion daisy factory fanny partial plaster policy treasury vegetation waver " +
    "whisky whisker gradual " +
    "toaster"
  ).split(" "),
);
// Some words above are real derivations of something else; drop those from the block list.
for (const w of ["princess", "basement", "toaster", "sunny", "messy", "bossy", "fussy", "chilly", "curly", "jelly", "handy"])
  NOT_DERIVED.delete(w);

/** Same-family groups the suffix rules cannot reach. */
const FAMILY_GROUPS: string[][] = (
  "france french|greece greek|ireland irish|scotland scottish scot scots|england english|britain british brit|" +
  "wales welsh|spain spanish spaniard|netherlands holland dutch|denmark danish dane|sweden swedish swede|" +
  "norway norwegian|finland finnish finn|switzerland swiss|thailand thai|iceland icelandic|turkey turkish turk|" +
  "peru peruvian|mexico mexican|rome roman|paris parisian|arabia arab arabic|israel israeli|iraq iraqi|" +
  "pakistan pakistani|portugal portuguese|holland dutch|" +
  "actor actress|waiter waitress|duke duchess|emperor empress|tiger tigress|hero heroine|fiance fiancee|" +
  "blond blonde|masseur masseuse|" +
  "deep depth|long length|strong strength|wide width|high height|warm warmth|true truth|young youth|" +
  "dead death|speak speech|fly flight|choose choice|lose loss|believe belief|prove proof|thief theft|" +
  "sing song|bath bathe|breath breathe|cloth clothe clothes|glass glasses|grief grieve|life live|" +
  "volcano volcanic|piano pianist|banjo banjoist|cello cellist|solo soloist"
)
  .split("|")
  .map((g) => g.split(" "));

const FAMILY_ID = new Map<string, string[]>();
FAMILY_GROUPS.forEach((g, i) => {
  for (const w of g) {
    const ids = FAMILY_ID.get(w) ?? [];
    ids.push("#" + i);
    FAMILY_ID.set(w, ids);
  }
});

/** Suffixes that may sit outside another one: care-ful-ly, hope-less-ness, music-al-ly. */
const OUTER_SUFFIXES = new Set(["ly", "ness", "ful", "less", "ship", "hood", "ment", "dom"]);

/** Candidate roots one derivational step below w, with the suffix removed. */
export function derivations(w: string): [string, string][] {
  if (NOT_DERIVED.has(w) || !/^[a-z]+$/.test(w)) return [];
  const out: [string, string][] = [];
  for (const r of SUFFIXES) {
    if (!w.endsWith(r.suf) || w.length <= r.suf.length) continue;
    const s = w.slice(0, -r.suf.length);
    if (!hasVowel(s)) continue;
    const c: string[] = [];
    if (r.noStem) {
      // extra candidates only
    } else if (/^[aeiouy]/.test(r.suf)) {
      // English drops a final e before a vowel suffix: career is not care + er (that is carer).
      if (s.endsWith("e") && !/(ee|ge|ce|oe|ye)$/.test(s)) continue;
      if (s.endsWith("i")) c.push(s.slice(0, -1) + "y"); // happier -> happy
      if (endsDouble(s)) {
        const d = s.slice(0, -1);
        if (endsCVC(d)) c.push(d); // bigger -> big
        c.push(s); // taller -> tall
      } else if (isShort(s)) {
        if (r.restore) c.push(s + "e"); // baker -> bake (bak would be bakker)
      } else {
        c.push(s);
        if (r.restore && s.length >= 4 && isConsonantAt(s, s.length - 1)) c.push(s + "e"); // creation -> create
      }
    } else {
      if (s.endsWith("i")) c.push(s.slice(0, -1) + "y"); // happiness -> happy
      c.push(s);
    }
    if (r.extra && s.length >= r.min) c.push(...r.extra(s));
    for (const x of c) if (x.length >= r.min && hasVowel(x) && x !== w) out.push([x, r.suf]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Forms of a word, cached
// ---------------------------------------------------------------------------

interface Forms {
  key: string;
  spell: string;
  /** spell plus plural bases: what typos are measured on (verb stems like "teache" are too noisy) */
  typo: string[];
  /** spelled base forms -> how they were reached ("self" for the word itself) */
  infl: Map<string, Kind | "self">;
  /** spelled roots and family group ids, including infl keys */
  fam: Set<string>;
}

const FORMS_CACHE = new Map<string, Forms>();

export function forms(key: string): Forms {
  const hit = FORMS_CACHE.get(key);
  if (hit) return hit;
  const spell = spellNorm(key);
  const infl = new Map<string, Kind | "self">();
  infl.set(spell, "self");
  const raw = new Set<string>([key]);
  for (const w of [key, spell]) {
    for (const [b, k] of inflections(w)) {
      raw.add(b);
      const sb = spellNorm(b);
      if (!infl.has(sb)) infl.set(sb, k);
    }
  }
  const fam = new Set<string>(infl.keys());
  const addFamily = (w: string) => {
    for (const id of FAMILY_ID.get(w) ?? []) fam.add(id);
  };
  // One derivational step, and a second one only below an outer -ly/-ness/-ful/...
  // (carefully, hopelessness): chains through other suffixes reach junk roots
  // (soldier -> soldy -> sold, minister -> minist -> mine).
  let frontier = [...raw, ...infl.keys()].map((w) => ({ w, outer: true }));
  for (const { w } of frontier) addFamily(w);
  for (let depth = 0; depth < 2; depth++) {
    const next: { w: string; outer: boolean }[] = [];
    for (const { w, outer } of frontier) {
      if (!outer) continue;
      for (const [r, suf] of derivations(w)) {
        if (!fam.has(r)) {
          fam.add(r);
          next.push({ w: r, outer: OUTER_SUFFIXES.has(suf) });
        }
        addFamily(r);
      }
    }
    frontier = next;
  }
  const typo = [spell, ...[...infl].filter(([, k]) => k === "plural").map(([x]) => x)];
  const f = { key, spell, typo, infl, fam };
  if (FORMS_CACHE.size > 100000) FORMS_CACHE.clear();
  FORMS_CACHE.set(key, f);
  return f;
}

// ---------------------------------------------------------------------------
// Typos: weighted Damerau (optimal string alignment) on a QWERTY keyboard
// ---------------------------------------------------------------------------

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const KEY_POS = new Map<string, [number, number]>();
ROWS.forEach((row, r) => [...row].forEach((c, i) => KEY_POS.set(c, [r, i])));

/** Neighbouring keys: same row +-1; the row below at i-1, i; the row above at i, i+1. */
export function adjacentKeys(a: string, b: string): boolean {
  const p = KEY_POS.get(a);
  const q = KEY_POS.get(b);
  if (!p || !q || a === b) return false;
  const [r1, i1] = p;
  const [r2, i2] = q;
  if (r1 === r2) return Math.abs(i1 - i2) === 1;
  if (r2 === r1 + 1) return i2 === i1 || i2 === i1 - 1;
  if (r2 === r1 - 1) return i2 === i1 || i2 === i1 + 1;
  return false;
}

export interface TypoCostOptions {
  /** every insertion and deletion costs 1 (used with a dictionary, for unknown words) */
  loose?: boolean;
  /** a doubled letter added or dropped costs 1 (default true) */
  doubles?: boolean;
  /** a vowel for another vowel costs 1 (spelling mistakes: seperate, accordian) */
  vowels?: boolean;
}

const VOWELS = "aeiouy";

/**
 * Cost of turning a into b (optimal string alignment). Typo-like edits cost
 * 1: a neighbouring key, two letters swapped, a letter doubled or dropped
 * from a double, an extra key next to its neighbour. Every other edit costs 2.
 */
export function typoCost(a: string, b: string, o: TypoCostOptions = {}): number {
  const doubles = o.doubles ?? true;
  const n = a.length;
  const m = b.length;
  const indel = (s: string, i: number): number => {
    // cost of inserting/deleting s[i]
    if (o.loose) return 1;
    const c = s[i]!;
    const p = s[i - 1];
    const q = s[i + 1];
    if (c === p || c === q) return doubles ? 1 : 2; // doubled letter
    if ((p && adjacentKeys(c, p)) || (q && adjacentKeys(c, q))) return 1; // fat finger
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

/** Allowed typo cost by the length of the shorter word. */
export function typoBudget(n: number): number {
  if (n < 5) return 0;
  if (n <= 7) return 1;
  if (n <= 11) return 2;
  return 3;
}

/** Typo leniency: clues (default) or guesses (doubled letters and vowels forgiven earlier). */
interface Leniency {
  doublesFrom: number;
  vowelsFrom: number;
}
const CLUE_LENIENCY: Leniency = { doublesFrom: 7, vowelsFrom: 99 };
const GUESS_LENIENCY: Leniency = { doublesFrom: 5, vowelsFrom: 6 };

function isTypo(a: string, b: string, opt: MatchOptions, len: Leniency = CLUE_LENIENCY): boolean {
  if (a === b || !/^[a-z]+$/.test(a) || !/^[a-z]+$/.test(b)) return false;
  const n = Math.min(a.length, b.length);
  const budget = typoBudget(n);
  if (budget === 0 || Math.abs(a.length - b.length) > budget) return false;
  if (n <= 7 && a[0] !== b[0]) return false;
  let loose = false;
  if (opt.known) {
    const ka = opt.known(a);
    const kb = opt.known(b);
    if (ka && kb) return false;
    loose = true;
  }
  // A doubled letter is a typo only in long words: diner/dinner, later/latter, desert/dessert are words.
  return typoCost(a, b, { loose, doubles: n >= len.doublesFrom, vowels: n >= len.vowelsFrom }) <= budget;
}

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

function inflectionReason(a: Forms, b: Forms): Reason | null {
  let best: Reason | null = null;
  for (const [x, ka] of a.infl) {
    const kb = b.infl.get(x);
    if (kb === undefined) continue;
    const kinds = [ka, kb];
    const r: Reason = kinds.includes("verb form")
      ? "verb form"
      : kinds.includes("same family")
        ? "same family"
        : "plural";
    if (r === "plural") return r;
    if (best === null || (best === "same family" && r === "verb form")) best = r;
  }
  return best;
}

function familyMatch(a: Forms, b: Forms): boolean {
  for (const x of a.fam) if (b.fam.has(x)) return true;
  return false;
}

function typoMatch(a: Forms, b: Forms, opt: MatchOptions, len: Leniency = CLUE_LENIENCY): boolean {
  // Two real words are never typos of each other (elegant is not a typo of elephant -> "elefant").
  if (opt.known && opt.known(a.key) && opt.known(b.key)) return false;
  for (const x of a.typo) for (const y of b.typo) if (isTypo(x, y, opt, len)) return true;
  return false;
}

/** Same word, spelling, plural / verb form, same family (no typo). */
function related(a: string, b: string): Reason | null {
  if (a === b) return "same word";
  const fa = forms(a);
  const fb = forms(b);
  if (fa.spell === fb.spell) return "spelling";
  const r = inflectionReason(fa, fb);
  if (r) return r;
  if (familyMatch(fa, fb)) return "same family";
  return null;
}

/** "Kcalb" -> "black". */
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
 * secret): a known word with letters stretched (doog, ddoogg for dog; short
 * words have no typos) or written backwards (kcalb for black, 4+ letters).
 * Strict on purpose, so that no real word is caught: the disguise must be
 * unknown to the dictionary and the other word known, only letters doubled
 * (never undoubled), exactly reversed (no forms). Dinner and diner, star
 * and rats are words of their own. Needs the dictionary; without it,
 * nothing is a disguise.
 */
function disguised(a: string, b: string, opt: MatchOptions): Reason | null {
  if (!opt.known || a === b || !/^[a-z]+$/.test(a) || !/^[a-z]+$/.test(b)) return null;
  const ka = opt.known(a);
  const kb = opt.known(b);
  for (const [x, y, kx, ky] of [[a, b, ka, kb], [b, a, kb, ka]] as const) {
    if (kx || !ky) continue;
    if (stretches(x, y)) return "spelling";
    if (y.length >= 4 && reverse(x) === y) return "backwards";
  }
  return null;
}

/**
 * Is `c` the English word `t` (a translation a German secret bans: dog for
 * Hund), or the same word otherwise: another spelling (color for colour),
 * an inflection of it (dogs, monkeys, swam for swim, weddings for wedding),
 * a typo (monky for monkey, with the dictionary) or a disguise (doog)? Only
 * the translation's own forms, never what it is a form of or its family,
 * parts or sounds: wed for wedding, glass for glasses, died for dice, outer
 * for outing, carpet for car, hair for hare are other words. `opt.known` is
 * the English dictionary.
 */
export function nearTranslation(c: Clue, t: Clue, opt: MatchOptions = {}): Reason | null {
  if (c.key === t.key) return "same word";
  if (c.kind !== "word" || t.kind !== "word") return null;
  const fc = forms(c.key);
  const ft = forms(t.key);
  if (fc.spell === ft.spell) return "spelling";
  const k = fc.infl.get(ft.spell);
  if (k !== undefined && k !== "self" && k !== "same family") return k;
  // A typo is no word of its own: transmutations is not "trainstation".
  if (opt.known && !opt.known(c.key) && typoMatch(fc, ft, opt)) return "typo";
  return disguised(c.key, t.key, opt);
}

/**
 * Two-word clues that share a word: "black car" and "black", "car black"
 * and "black car". The cards say the same word, whatever comes with it
 * (closed compounds that share a part still do not jinx: fire/firetruck).
 */
function sharedWord(a: Clue, b: Clue): Reason | null {
  if (a.parts.length < 2 && b.parts.length < 2) return null;
  const pa = a.parts.length > 1 ? a.parts : [a.key];
  const pb = b.parts.length > 1 ? b.parts : [b.key];
  if (pa.length === pb.length && [...pa].sort().join(" ") === [...pb].sort().join(" ")) return "same word";
  for (const x of pa) {
    if (x.length < 3 || !/^[a-z]+$/.test(x)) continue;
    for (const y of pb) if (y.length >= 3 && /^[a-z]+$/.test(y) && related(x, y)) return "contains the word";
  }
  return null;
}

/** Do two clues jinx each other? Returns the reason, or null. */
export function sameClue(a: Clue, b: Clue, opt: MatchOptions = {}): Reason | null {
  if (a.key === b.key) {
    if (a.kind === "number") return a.display.toLowerCase() === b.display.toLowerCase() ? "same word" : "same number";
    return "same word";
  }
  if (a.kind !== "word" || b.kind !== "word") return null;
  const r = related(a.key, b.key);
  if (r) return r;
  if (typoMatch(forms(a.key), forms(b.key), opt)) return "typo";
  return disguised(a.key, b.key, opt) ?? sharedWord(a, b);
}

function soundsSame(a: string, b: string): boolean {
  const fa = forms(a);
  const fb = forms(b);
  // Only the words and their plurals: "is" -> "be" must not sound like "bee".
  const ids = new Set<number>();
  for (const x of fa.typo) for (const id of HOMOPHONE_ID.get(x) ?? []) ids.add(id);
  for (const y of fb.typo) for (const id of HOMOPHONE_ID.get(y) ?? []) if (ids.has(id)) return true;
  const ka = new Set(fa.typo.map(soundKey));
  for (const y of fb.typo) if (ka.has(soundKey(y))) return true;
  return false;
}

/** Prefixes that count as a word part: "unhappy" contains "happy". */
const PREFIXES = new Set(
  "un re dis mis non pre over under super mini mega anti semi sub ex co de in im micro tele".split(" "),
);

/**
 * Closed compound containment: `long` starts or ends with `short` and the
 * rest has 3+ letters (or is a prefix: un-happy). With a dictionary the rest
 * must also be a known word: "carpet" is still "car" + "pet", but "elephant"
 * is not "eleph" + "ant" and "history" is not "hi" + "story".
 */
function containsPart(long: string, short: string, opt: MatchOptions): boolean {
  if (short.length < 3 || !/^[a-z]+$/.test(short) || !/^[a-z]+$/.test(long) || long.length <= short.length) return false;
  if (long.startsWith(short)) {
    const tail = long.slice(short.length);
    if (tail.length >= 3 && (!opt.known || opt.known(tail) || knownInflected(tail, opt))) return true;
  }
  if (long.endsWith(short)) {
    const head = long.slice(0, long.length - short.length);
    if (PREFIXES.has(head) || (head.length >= 3 && (!opt.known || opt.known(head)))) return true;
  }
  return false;
}

function knownInflected(w: string, opt: MatchOptions): boolean {
  for (const [b, k] of inflections(w)) if (k !== "same family" && opt.known!(b)) return true;
  return false;
}

/** The word and its plural / verb bases (not irregular relatives like further -> far). */
function inflectedForms(f: Forms): string[] {
  return [...f.infl].filter(([, k]) => k !== "same family").map(([x]) => x);
}

function containment(c: Clue, s: Clue, opt: MatchOptions): Reason | null {
  // Explicit words: "ice cream" for "ice", "cream" for "ice cream".
  if (c.parts.length > 1) for (const p of c.parts) if (related(p, s.key)) return "contains the word";
  if (s.parts.length > 1) for (const p of s.parts) if (related(p, c.key)) return "part of the word";
  const sForms = [forms(s.key).spell, s.key];
  // The clue contains the secret when every reading of it does: an inflected
  // clue is read as its bases, so "catching" (catch) and "climbed" (climb) do
  // not contain "cat" and "bed", while "snowmen" (snowman) and "hotdogs"
  // (hotdog) do.
  const bases = inflectedForms(forms(c.key)).filter((x) => x !== forms(c.key).spell);
  const readings = bases.length > 0 ? bases : [c.key];
  for (const y of sForms) {
    const long = readings.filter((x) => x.length >= y.length);
    if (long.length > 0 && long.every((x) => containsPart(x, y, opt))) return "contains the word";
  }
  // The secret contains the clue: snow in snowman (the clue and its plurals only).
  for (const y of sForms) for (const x of forms(c.key).typo) if (containsPart(y, x, opt)) return "part of the word";
  return null;
}

/**
 * Is `c` an invalid clue for the secret word `s`? `banned` are extra forms the
 * word list forbids for this word (translations, irregular relatives).
 */
export function invalidClue(c: Clue, s: Clue, opt: MatchOptions = {}, banned: readonly string[] = []): Reason | null {
  if (c.key === s.key) return c.kind === "number" ? "same number" : "same word";
  if (c.kind !== "word" || s.kind !== "word") return null;
  const r = related(c.key, s.key);
  if (r) return r;
  if (soundsSame(c.key, s.key)) return "sounds the same";
  if (typoMatch(forms(c.key), forms(s.key), opt)) return "typo";
  const d = disguised(c.key, s.key, opt);
  if (d) return d;
  const k = containment(c, s, opt);
  if (k) return k;
  for (const b of banned) {
    const bc = clean(b);
    if (bc.ok && (bc.clue.key === c.key || related(c.key, bc.clue.key))) return "too close";
  }
  return null;
}

/**
 * Is the guess right? Same word, spelling, plural or verb form, homophone,
 * typo; not family. `alsoRight` are extra accepted forms from the word list
 * (bbq for barbecue, bike for bicycle).
 */
export function judgeGuess(g: Clue, s: Clue, opt: MatchOptions = {}, alsoRight: readonly string[] = []): Reason | null {
  // The secret itself first, so its own guess is "same word" even when an
  // also_right form is close to it (barbeque, ukelele, die for dice).
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

function judgeAgainst(g: Clue, s: Clue, opt: MatchOptions): Reason | null {
  if (g.key === s.key) return g.kind === "number" && g.display.toLowerCase() !== s.display.toLowerCase() ? "same number" : "same word";
  if (g.kind !== "word" || s.kind !== "word") return null;
  const fg = forms(g.key);
  const fs = forms(s.key);
  if (fg.spell === fs.spell) return "spelling";
  const r = inflectionReason(fg, fs);
  if (r === "plural" || r === "verb form") return r;
  if (soundsSame(g.key, s.key)) return "sounds the same";
  // Guesses forgive a doubled letter from five letters on (girafe) and a wrong
  // vowel from six (accordian): a wrong word accepted is rarer than a right one refused.
  if (typoMatch(fg, fs, opt, GUESS_LENIENCY)) return "typo";
  return null;
}

// ---------------------------------------------------------------------------
// Grouping a round's clues
// ---------------------------------------------------------------------------

export interface Link {
  a: number;
  b: number;
  reason: Reason;
}
export interface RoundResult {
  /** Clues struck against the secret word, by index. */
  invalid: { index: number; reason: Reason }[];
  /** Jinx groups (indices, ascending) with every matching pair inside. */
  groups: { members: number[]; links: Link[] }[];
  /** Indices of the clues that survive, ascending. */
  survivors: number[];
}

/**
 * Strike invalid clues, then jinx the rest. Matching is transitive: if a
 * matches b and b matches c, all three are lost (connected components).
 */
export function groupClues(clues: readonly Clue[], secret: Clue, opt: MatchOptions = {}, banned: readonly string[] = []): RoundResult {
  const invalid: RoundResult["invalid"] = [];
  const valid: number[] = [];
  clues.forEach((c, i) => {
    const r = invalidClue(c, secret, opt, banned);
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
  for (const i of valid) {
    const r = find(i);
    const g = byRoot.get(r) ?? [];
    g.push(i);
    byRoot.set(r, g);
  }
  const groups = [...byRoot.values()]
    .filter((m) => m.length > 1)
    .map((members) => ({ members, links: links.filter((l) => members.includes(l.a)) }));
  const jinxed = new Set(groups.flatMap((g) => g.members));
  return { invalid, groups, survivors: valid.filter((i) => !jinxed.has(i)) };
}

// ---------------------------------------------------------------------------
// Submit check (host page, answering the phone)
// ---------------------------------------------------------------------------

export type SubmitResult =
  | { ok: true; clue: Clue }
  | { ok: false; code: CleanError | "too-close" | "own-clue"; reason?: Reason; message: string };

/** Phone wording per reason for a clue too close to the secret word. */
const TOO_CLOSE_TEXT: Record<Reason, string> = {
  "same word": "That's the word itself",
  "same number": "That's the word itself",
  spelling: "That's the word, spelled differently",
  plural: "That's the word in the plural",
  "verb form": "That's another form of the word",
  "word form": "That's another form of the word",
  "same family": "Too close to the word: same family",
  typo: "That's the word with a typo",
  "sounds the same": "Sounds like the word",
  "contains the word": "Contains the word",
  "part of the word": "Part of the word",
  backwards: "That's the word backwards",
  "too close": "Too close to the word",
};

/**
 * Check a clue when the giver submits it. Rejections go back to the phone
 * with a message, and the giver can type again; nothing reaches the TV.
 * `banned` and `alsoRight` come from the word list (an accepted guess is
 * also too close as a clue); `own` are the giver's other clues this round
 * (3 players: two clues each).
 */
export function checkSubmit(
  raw: string,
  secret: Clue,
  opt: MatchOptions & { banned?: readonly string[]; alsoRight?: readonly string[]; own?: readonly Clue[] } = {},
): SubmitResult {
  const c = clean(raw);
  if (!c.ok) return { ok: false, code: c.error, message: c.message };
  const r = invalidClue(c.clue, secret, opt, [...(opt.banned ?? []), ...(opt.alsoRight ?? [])]);
  if (r) return { ok: false, code: "too-close", reason: r, message: `${TOO_CLOSE_TEXT[r]}. Try another clue` };
  for (const o of opt.own ?? []) {
    const m = sameClue(c.clue, o, opt);
    if (m) {
      const why = m === "same word" ? "" : ` (${REASON_TEXT[m]})`;
      return { ok: false, code: "own-clue", reason: m, message: `Same as your other clue${why}. Try another clue` };
    }
  }
  return { ok: true, clue: c.clue };
}

// ---------------------------------------------------------------------------
// Word list
// ---------------------------------------------------------------------------

export interface WordEntry {
  word: string;
  difficulty: string;
  category: string;
  /** guesses accepted as right besides the word's own forms (bbq for barbecue) */
  alsoRight: string[];
  /** clues rejected as too close besides the rules (translations; with `english`) */
  banned: string[];
  /**
   * The English translations (German list: its own column): in a German room
   * also rejected in their English forms, typos and disguises (dogs for dog);
   * every other translation only as written.
   */
  english: string[];
}

/**
 * Parse words.txt: tab-separated `word difficulty category [also_right [banned]]`,
 * lists separated by commas, lines starting with # are comments. A leading
 * comment naming the columns (`word<TAB>…` or `word, difficulty, …`) may
 * reorder them.
 */
export function parseWordList(text: string): WordEntry[] {
  let cols = ["word", "difficulty", "category", "also_right", "banned", "english"];
  const out: WordEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (line.startsWith("#")) {
      const m = line.match(/\bword(?:<TAB>|\t|,\s*)[a-z_<>\t, ]+/i);
      if (m && out.length === 0) {
        const named = m[0].split(/<TAB>|\t|,\s*/).map((s) => s.trim().toLowerCase().replace(/[^a-z_].*$/, ""));
        if (named.includes("word")) {
          cols = named;
          for (const extra of ["also_right", "banned", "english"]) if (!cols.includes(extra)) cols.push(extra);
        }
      }
      continue;
    }
    const f = line.split("\t");
    const get = (name: string) => {
      const i = cols.indexOf(name);
      return i >= 0 ? (f[i] ?? "").trim() : "";
    };
    const list = (name: string) =>
      get(name)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    const english = list("english");
    out.push({ word: get("word"), difficulty: get("difficulty"), category: get("category"), alsoRight: list("also_right"), banned: [...english, ...list("banned")], english });
  }
  return out.filter((e) => e.word !== "");
}

/** MatchOptions.known from dict.txt (one lowercase word per line). */
export function dictionary(text: string): (word: string) => boolean {
  const set = new Set(text.split(/\r?\n/).filter((w) => w !== ""));
  return (w) => set.has(w);
}
