// Checks a Busted question deck:
//   node scripts/check-questions.mjs [--lang en|de] [file]
// (default: data/questions.txt; the language follows the file name,
// questions.de.txt is German). Errors exit with 1; warnings (overused
// title words, similar questions, possibly gendered titles) only inform.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const langAt = args.indexOf("--lang");
const langArg = langAt >= 0 ? args.splice(langAt, 2)[1] : undefined;
const file = args[0] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "questions.txt");
const lang = langArg ?? (/\.de\.[^/]*$/.test(file) ? "de" : "en");
if (!["en", "de"].includes(lang)) throw new Error(`unknown language ${lang}`);
const de = lang === "de";
const lines = readFileSync(file, "utf8").split("\n");

const KINDS = ["vote", "answer"];
const LEVELS = ["family", "party"];
const MAX_QUESTION = 100;
const MAX_TITLE = 28;
// Words a Title Case title keeps lowercase (unless first).
const SMALL_EN = new Set(
  "a an the of in on at to for and or but nor by with from as per vs".split(" "),
);
// Words ignored when comparing questions for similarity.
const STOP_EN = new Set(
  (
    "a an the of in on at to for and or but by with from as is are be been would " +
    "most likely who what which where how when your you you'd you're yours their " +
    "them they it its it's that this than then if do does did have has had just " +
    "every all one some any ever even into out up about so very really most " +
    "someone something somebody else own still can could will i i'd me my we us " +
    "here there no not never what's where's who's s"
  ).split(" "),
);

// German: words that stay lowercase inside a title (unless after : ? !).
const SMALL_DE = new Set(
  (
    "der die das des dem den ein eine einer eines einem einen im in am an auf aus bei mit " +
    "nach von vom zum zur für und oder als wie über unter ohne gegen um zu bis ins aufs"
  ).split(" "),
);
const STOP_DE = new Set(
  (
    "wer würde würdest wäre wärst am ehesten von euch was wie wo wann warum welche welcher " +
    "welches welchen welchem du dich dir dein deine deinen deinem deiner der die das des dem den " +
    "ein eine einer eines einem einen im in an auf aus bei mit nach vom zum zur für und oder als " +
    "über unter ohne um zu es sie er man sich ist sind hat hast hätte hättest kann kannst könnte " +
    "könntest wird wirst nicht nur noch schon je mal ganz sehr so dann wenn dass ob alle allen " +
    "jede jeden jedem jeder jedes eigene eigenen tun machen sagen"
  ).split(" "),
);
// German: an answer question needs an interrogative word …
const W_WORD =
  /(?<!\p{L})(wer|wen|wem|wessen|was|wie|wo|wann|warum|weshalb|wieso|welch\p{L}*|wo(?:hin|her|für|rüber|mit|von|vor|ran|rauf|zu|bei|rin|raus|nach|durch|rum))(?!\p{L})/iu;
// … and must not open with a verb (a yes/no question).
const YES_NO_DE =
  /^(Hast|Hattest|Hättest|Bist|Warst|Wärst|Wärest|Würdest|Wirst|Kannst|Könntest|Magst|Möchtest|Willst|Sollst|Solltest|Musst|Darfst|Gibt|Gab|Ist|Sind|War|Hat|Isst|Gehst|Liebst|Kennst|Glaubst|Findest|Machst|Tust|Weißt)\b/u;
// Gendered or slashed forms read badly on a front page: Leser:in, Leser*in,
// Leser_in, Leser/in, LeserIn.
const GENDER_MARK = /\p{L}[:*_/](in|innen)(?!\p{L})|\p{Ll}(In|Innen)(?!\p{L})/u;
// Title words that fit only one gender; a hint, the human decides.
const GENDERED_WORD =
  /(meister|meisterin|könig|königin|held|heldin|prinz|prinzessin|kaiser|kaiserin|herr|frau|mann|männer|dame|junge|mädchen|onkel|tante|detektiv|detektivin|experte|expertin|spezialist|künstler|fahrer|spieler|sieger|gänger|erin|istin|antin|entin|eurin|ärin)$/iu;
const GENDERED_OK = new Set(["siebenschläfer"]);
// Words that differ between Germany, Austria and Switzerland or are regional.
const REGIONAL = [
  /brötchen|semmel|weggli|schrippe/i,
  /sahne|\bobers\b|schlagrahm/i,
  /pfannkuchen|palatschinke|krapfen|kräppel/i,
  /abitur|matura|\babi\b/i,
  /sonnabend|jänner|feber/i,
  /paradeiser|erdäpfel|erdapfel|marille|topfen|quark|rüebli|möhre/i,
  /\bvelo\b|trottoir|gehsteig|parkier|grillier/i,
  /\bstiege|sackerl|tüte/i,
  /fasching|fasnacht|karneval/i,
  /\bjause|brotzeit|vesper|znüni|zvieri/i,
  /\bglace|guetzli|plätzchen/i,
  /\bkasten\b|\bsessel\b/i,
];
const SMALL = de ? SMALL_DE : SMALL_EN;
const STOP = de ? STOP_DE : STOP_EN;

const errors = [];
const warnings = [];
const entries = [];
const seenQuestions = new Map();
const seenTitles = new Map();

const normalize = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

lines.forEach((raw, i) => {
  const n = i + 1;
  const line = raw.replace(/\r$/, "");
  const err = (msg) => errors.push(`${file}:${n}: ${msg}`);
  if (line.trim() === "" || line.startsWith("#")) return;
  if (line.normalize("NFC") !== line) err("not NFC");
  if (de) {
    // German quotes: „…“ in pairs; straight ' for apostrophes.
    if (/["\u2018\u2019\u201a\u201d\u00ab\u00bb\u2039\u203a]/.test(line)) err("quotes: use „…“ (and ' for apostrophes)");
    const marks = line.replace(/[^\u201e\u201c]/g, "");
    if (!/^(\u201e\u201c)*$/.test(marks)) err("unbalanced „…“");
    for (const re of REGIONAL) if (re.test(line)) err(`regional word (${re.source}): use one all of DE/AT/CH share`);
  } else if (/[\u2018\u2019\u201c\u201d]/.test(line)) err("curly quotes: use ' and \"");
  if (/ {2}/.test(line)) err("double space");
  const fields = line.split("\t");
  const [kind, level, question, title] = fields;
  if (!KINDS.includes(kind)) return err(`unknown kind ${JSON.stringify(kind)}`);
  if (!LEVELS.includes(level)) err(`unknown level ${JSON.stringify(level)}`);
  const want = kind === "vote" ? 4 : 3;
  if (fields.length !== want) return err(`${kind} needs ${want} fields, has ${fields.length}`);
  for (const f of fields) if (f !== f.trim() || f === "") err(`empty or padded field ${JSON.stringify(f)}`);

  if (question.length > MAX_QUESTION) err(`question has ${question.length} > ${MAX_QUESTION} chars`);
  if (!question.endsWith("?")) err("question must end with ?");
  if (!/^\p{Lu}/u.test(question)) err("question must start with a capital");
  // German abbreviations (Dr., Prof., z. B.) do not end a sentence.
  const prose = de ? question.replace(/\b(Dr|Prof|St|Nr|bzw|ca|z\. B|d\. h)\. /g, "$1 ") : question;
  if (/[.!?] \p{Lu}/u.test(prose.slice(0, -1))) err("question looks like more than one sentence");
  if (de) {
    if (kind === "vote" && !/^Wer\b/.test(question)) err("vote question must start with Wer");
    if (kind === "answer" && (YES_NO_DE.test(question) || !W_WORD.test(question)))
      err("answer question looks like yes/no (no W-word)");
    if (/\b(Sie|Ihr|Ihre|Ihnen)\b/.test(question.slice(1))) err("formal address: use du");
  } else {
    if (kind === "vote" && !/^Who\b/.test(question)) err("vote question must start with Who");
    if (kind === "answer" && /^(Do|Does|Did|Is|Are|Was|Were|Have|Has|Can|Could|Would|Will|Should)\b/.test(question))
      err("answer question looks like yes/no");
  }

  const qk = normalize(question);
  if (seenQuestions.has(qk)) err(`duplicate question (line ${seenQuestions.get(qk)})`);
  else seenQuestions.set(qk, n);

  if (kind === "vote") {
    if (title.length > MAX_TITLE) err(`title has ${title.length} > ${MAX_TITLE} chars`);
    if (/[.,;:!?\-…]$/.test(title) && !(de && /\b(Dr|Prof|h\. c)\.$/.test(title))) err("title has trailing punctuation");
    if (title === title.toUpperCase()) err("title is all caps");
    if (de) checkGermanTitle(title, err, n);
    else checkEnglishTitle(title, err);
    const tk = normalize(title);
    if (seenTitles.has(tk)) err(`duplicate title (line ${seenTitles.get(tk)})`);
    else seenTitles.set(tk, n);
  }
  entries.push({ n, kind, level, question, title });
});

// English: Title Case.
function checkEnglishTitle(title, err) {
  // The first word and the first part of a hyphenated compound are
  // capitalized ("On-My-Way"), small words elsewhere stay lowercase
  // ("Hide-and-Sleep", "Minister of Just in Case").
  const parts = title
    .split(" ")
    .flatMap((word, wi) => word.split("-").map((w, pi) => ({ w, first: (wi === 0 && pi === 0) || (pi === 0 && word.includes("-")) })));
  parts.forEach(({ w, first }) => {
    const core = w.replace(/^[("']+|[)"',]+$/g, "");
    if (core === "" || !/^\p{L}/u.test(core)) return;
    const small = SMALL.has(core.toLowerCase());
    if (first || !small) {
      if (!/^\p{Lu}/u.test(core)) err(`title word "${w}" should be capitalized`);
    } else if (core !== core.toLowerCase()) {
      err(`title word "${w}" should be lowercase`);
    }
  });
}

// German: normal capitalization (first letter up, articles and
// prepositions down unless after : ? !), no gender marks; gendered nouns warn.
function checkGermanTitle(title, err, n) {
  if (!/^[\p{Lu}\p{N}]/u.test(title)) err("title must start with a capital or a digit");
  if (GENDER_MARK.test(title)) err("title uses a gender mark (:in, *in, _in, /in, -In): find an epicene phrase");
  const words = title.split(" ");
  words.forEach((w, i) => {
    const core = w.replace(/^[„(']+|[“)',.:?!]+$/g, "");
    if (i > 0 && !/[:?!]$/.test(words[i - 1]) && SMALL_DE.has(core.toLowerCase()) && core !== core.toLowerCase())
      err(`title word "${w}" should be lowercase`);
    for (const part of core.split("-"))
      if (GENDERED_WORD.test(part) && !GENDERED_OK.has(part.toLowerCase()))
        warnings.push(`${file}:${n}: title word "${part}" may fit only one gender`);
  });
}

// Overused title words: titles should vary their patterns.
const wordCount = new Map();
for (const e of entries) {
  if (!e.title) continue;
  for (const w of new Set(normalize(e.title).split(" "))) {
    if (SMALL.has(w)) continue;
    wordCount.set(w, [...(wordCount.get(w) ?? []), e.n]);
  }
}
for (const [w, at] of wordCount)
  if (at.length > 3) warnings.push(`title word "${w}" used ${at.length} times (lines ${at.join(", ")})`);

// Similar questions: content-word overlap, a hint for near-duplicates.
const stem = de ? (w) => w.replace(/(ern|em|en|er|es|e|n|s)$/, "") : (w) => w.replace(/(ing|ed|es|s)$/, "");
const content = entries.map((e) => ({
  e,
  words: new Set(
    normalize(e.question)
      .split(" ")
      .filter((w) => !STOP.has(w))
      .map(stem),
  ),
}));
for (let i = 0; i < content.length; i++) {
  for (let j = i + 1; j < content.length; j++) {
    const a = content[i].words;
    const b = content[j].words;
    if (a.size === 0 || b.size === 0) continue;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    const jaccard = shared / (a.size + b.size - shared);
    if (shared >= 2 && jaccard >= 0.4)
      warnings.push(
        `similar (${jaccard.toFixed(2)}): ${content[i].e.n} "${content[i].e.question}" / ${content[j].e.n} "${content[j].e.question}"`,
      );
  }
}

for (const w of warnings) console.log(`warning: ${w}`);
for (const e of errors) console.log(`error: ${e}`);

const counts = {};
for (const e of entries) counts[`${e.kind} ${e.level}`] = (counts[`${e.kind} ${e.level}`] ?? 0) + 1;
for (const kind of KINDS)
  for (const level of LEVELS) console.log(`${kind} ${level}: ${counts[`${kind} ${level}`] ?? 0}`);
console.log(`total: ${entries.length}, ${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);
