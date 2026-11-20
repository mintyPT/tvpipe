#!/usr/bin/env node
// Jinx German word list: source.txt -> ../../../data/words.de.txt, plus lints and review reports.
//
//   node build.mjs            build words.de.txt, print counts and lint errors
//   node build.mjs --review   also check against the raw data in ../raw/de/ (./fetch.sh):
//                             Hunspell (igerman98) spelling, Wiktionary regional labels,
//                             subtitle frequency; writes ../raw/de/review.tsv (not committed)
//
// Node >= 18, no packages. See README.md.

import { readFileSync, writeFileSync, existsSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "source.txt");
const DROPPED = join(here, "dropped.tsv");
const EN = join(here, "../../../data/words.txt");
const OUT = join(here, "../../../data/words.de.txt");
const RAW = join(here, "../raw/de");

const CATEGORIES = ["animal", "food", "home", "nature", "people", "place", "sport", "fantasy", "music", "transport", "body", "tool", "clothing", "event", "science", "material", "action", "quality"];
const DIFF = { e: "easy", m: "medium", h: "hard" };
const review = process.argv.includes("--review");

/** The matcher's fold, roughly: lower case, umlauts as ae/oe/ue, ß as ss, accents off, letters and digits only. */
export function fold(s) {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/g, "");
}
const letters = (s) => s.replace(/[^\p{L}]/gu, "").length;
const wordsIn = (s) => s.trim().split(/\s+/).length;

// ---------------------------------------------------------------------------
// Parse source.txt

const errors = [];
const warnings = [];
const entries = [];
let category = null;
for (const [i, raw] of readFileSync(SOURCE, "utf8").split("\n").entries()) {
  const line = raw.trimEnd();
  const at = `source.txt:${i + 1}`;
  if (line.startsWith("## ")) {
    category = line.slice(3).trim();
    if (!CATEGORIES.includes(category)) errors.push(`${at}: unknown category ${category}`);
    continue;
  }
  if (line === "" || line.startsWith("#")) continue;
  const [word, d, also = "", banned = "", note = ""] = line.split("|").map((s) => s.trim());
  if (!DIFF[d]) errors.push(`${at}: ${word}: difficulty ${d}`);
  if (!category) errors.push(`${at}: no category`);
  const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
  entries.push({ word, difficulty: DIFF[d], category, alsoRight: list(also), banned: list(banned), note, at });
}

// Clean the lists: no duplicates, nothing equal to the word, banned minus also_right, at most two words.
for (const e of entries) {
  const key = fold(e.word);
  const seen = new Set([key]);
  const keep = (x, col) => {
    const k = fold(x);
    if (k === "" || seen.has(k)) return false;
    if (wordsIn(x) > 2) {
      warnings.push(`${e.word}: ${col} "${x}" has more than two words (dropped)`);
      return false;
    }
    seen.add(k);
    return true;
  };
  e.alsoRight = e.alsoRight.filter((x) => keep(x, "also_right"));
  e.banned = e.banned.filter((x) => keep(x, "banned"));
}

// ---------------------------------------------------------------------------
// Lints

const byKey = new Map();
for (const e of entries) {
  const k = fold(e.word);
  if (byKey.has(k)) errors.push(`${e.at}: duplicate ${e.word} (also ${byKey.get(k).at})`);
  else byKey.set(k, e);
  if (letters(e.word) < 3) errors.push(`${e.at}: ${e.word}: under 3 letters`);
  if (/\s/.test(e.word)) errors.push(`${e.at}: ${e.word}: more than one word`);
  if ([...e.word].length > 24) errors.push(`${e.at}: ${e.word}: longer than 24 characters`);
  const lower = e.word[0] === e.word[0].toLowerCase();
  if ((e.category === "action" || e.category === "quality") !== lower)
    errors.push(`${e.at}: ${e.word}: ${lower ? "lowercase" : "capitalised"} in ${e.category}`);
  if (/[,\t|]/.test(e.word)) errors.push(`${e.at}: ${e.word}: bad character`);
}
// A word's also_right is another secret: guessing that secret counts as right for this one.
for (const e of entries)
  for (const a of e.alsoRight) {
    const other = byKey.get(fold(a));
    if (other && process.argv.includes("--verbose")) warnings.push(`${e.word}: also_right ${a} is itself a secret word`);
  }

// Every English word is translated (in a German word, its banned list or an en: note) or listed in dropped.tsv.
const enWords = readFileSync(EN, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")[0]);
const covered = new Map();
for (const e of entries) {
  const mark = (w) => covered.set(fold(w), e.word);
  mark(e.word);
  for (const b of e.banned) mark(b);
  for (const a of e.alsoRight) mark(a);
  for (const m of e.note.matchAll(/en:([a-z]+)/g)) mark(m[1]);
}
const dropped = new Map();
if (existsSync(DROPPED))
  for (const l of readFileSync(DROPPED, "utf8").split("\n")) {
    if (!l || l.startsWith("#")) continue;
    const [en, de, reason] = l.split("\t");
    dropped.set(en, { de, reason });
    if (!enWords.includes(en)) errors.push(`dropped.tsv: ${en} is not in words.txt`);
    if (covered.has(fold(en))) warnings.push(`dropped.tsv: ${en} is also covered by ${covered.get(fold(en))}`);
  }
const uncovered = enWords.filter((w) => !covered.has(fold(w)) && !dropped.has(w));
if (uncovered.length) errors.push(`English words neither translated nor in dropped.tsv (${uncovered.length}): ${uncovered.join(" ")}`);

// ---------------------------------------------------------------------------
// Output

const collator = new Intl.Collator("de");
const sorted = [...entries].sort((a, b) => collator.compare(a.word, b.word));
const header = [
  "# Jinx secret words (German). word<TAB>difficulty<TAB>category<TAB>also_right<TAB>banned",
  "# also_right (accepted guesses) and banned (clues rejected as too close) are optional, comma-separated. Built from design/words/de/source.txt; see design/words/de/README.md.",
];
const body = sorted.map((e) => {
  const cols = [e.word, e.difficulty, e.category, e.alsoRight.join(","), e.banned.join(",")];
  while (cols.length > 3 && cols[cols.length - 1] === "") cols.pop();
  return cols.join("\t");
});
writeFileSync(OUT, [...header, ...body, ""].join("\n"));

const count = (f) => Object.entries(entries.reduce((m, e) => ((m[f(e)] = (m[f(e)] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
const n = entries.length;
console.log(`${n} words -> ${OUT}`);
console.log("difficulty: " + count((e) => e.difficulty).map(([k, v]) => `${k} ${v} (${Math.round((100 * v) / n)}%)`).join(", "));
console.log("category:   " + count((e) => e.category).map(([k, v]) => `${k} ${v}`).join(", "));
console.log(`also_right: ${entries.filter((e) => e.alsoRight.length).length} words; banned: ${entries.filter((e) => e.banned.length).length} words`);
console.log(`English list: ${enWords.length - dropped.size - uncovered.length} translated, ${dropped.size} dropped`);
for (const w of warnings) console.log("warning: " + w);
for (const e of errors) console.log("ERROR: " + e);

// ---------------------------------------------------------------------------
// Review against raw data (spelling, regional labels, frequency)

if (review) await reviewRaw();
process.exitCode = errors.length ? 1 : 0;

async function reviewRaw() {
  const need = ["de_DE_frami.dic", "de_50k.txt"];
  for (const f of need) if (!existsSync(join(RAW, f))) return console.log(`--review: ${f} missing; run ./fetch.sh`);

  // Hunspell (igerman98): stems with affix flags; a word is known if it is a stem or a stem plus one suffix rule.
  // Compounds are mostly built by compound flags, so also try two known parts (with a linking s, n, en, e, es, er).
  const stems = new Map();
  const rules = [];
  for (const v of ["de_DE", "de_AT", "de_CH"]) {
    const p = join(RAW, `${v}_frami.dic`);
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, "latin1").split("\n").slice(1)) {
      if (!l || l.startsWith("#") || l.startsWith("\t")) continue;
      const [w, flags = ""] = l.trim().split("/");
      stems.set(w, (stems.get(w) ?? "") + flags);
    }
    if (rules.length) continue;
    for (const l of readFileSync(join(RAW, `${v}_frami.aff`), "latin1").split("\n")) {
      const f = l.trim().split(/\s+/);
      if (f[0] !== "SFX" || f.length < 5) continue;
      const add = f[3].split("/")[0];
      rules.push({ flag: f[1], strip: f[2] === "0" ? "" : f[2], add: add === "0" ? "" : add, cond: new RegExp(f[4] === "." ? "$" : f[4] + "$") });
    }
  }
  const known = (w) => {
    if (stems.has(w)) return true;
    for (const r of rules) {
      if (!w.endsWith(r.add)) continue;
      const base = w.slice(0, w.length - r.add.length) + r.strip;
      const fl = stems.get(base);
      if (fl && fl.includes(r.flag) && r.cond.test(base)) return true;
    }
    return false;
  };
  const cap = (x) => x[0].toUpperCase() + x.slice(1);
  const splits = (w) => {
    for (let i = 3; i <= w.length - 3; i++) {
      const a = w.slice(0, i), b = cap(w.slice(i));
      if (!known(b) && !known(b.toLowerCase())) continue;
      for (const h of [a, a.replace(/(s|n|en|e|es|er)$/, "")]) {
        if (h.length < 2) continue;
        if (known(cap(h)) || known(h.toLowerCase())) return `${cap(h)}+${b}`;
      }
    }
    return null;
  };

  // Subtitle frequency rank (lowercase forms).
  const rank = new Map();
  readFileSync(join(RAW, "de_50k.txt"), "utf8").split("\n").forEach((l, i) => {
    const w = l.split(" ")[0];
    if (w && !rank.has(w)) rank.set(w, i + 1);
  });

  // Wiktionary (German entries, extracted with wiktextract) if present: part of speech, regional sense tags.
  const wikt = new Map();
  const jsonl = join(RAW, "de-entries.jsonl");
  if (existsSync(jsonl)) {
    const wanted = new Set();
    for (const e of entries) {
      wanted.add(e.word);
      for (const a of e.alsoRight) wanted.add(a);
    }
    const rl = createInterface({ input: createReadStream(jsonl), crlfDelay: Infinity });
    for await (const l of rl) {
      const m = l.match(/^\{"word": "([^"]+)"/);
      if (!m || !wanted.has(m[1])) continue;
      const d = JSON.parse(l);
      const info = wikt.get(d.word) ?? { pos: new Set(), tags: new Set() };
      info.pos.add(d.pos);
      for (const t of d.sense_tags ?? []) info.tags.add(t);
      for (const n of d.notes ?? []) if (/österreich|schweiz|süddeutsch|norddeutsch|regional/i.test(n)) info.tags.add("note:" + n.slice(0, 80));
      wikt.set(d.word, info);
    }
  }
  const regional = (w) => [...(wikt.get(w)?.tags ?? [])].filter((t) => !/Nachnamen/.test(t)).filter((t) => /Austria|Swiss|Switzerland|South|North|regional|dialect|Bavaria|East|West|note:/i.test(t)).join("; ");

  const rows = [["word", "difficulty", "category", "hunspell", "subtitle_rank", "wiktionary_pos", "regional_word", "regional_also_right"].join("\t")];
  let notSpelled = 0, rare = 0, reg = 0;
  for (const e of sorted) {
    const w = e.word.replace(/-/g, "");
    const hs = known(e.word) ? "stem" : known(w) ? "stem" : splits(e.word) ?? "UNKNOWN";
    if (hs === "UNKNOWN") notSpelled++;
    const r = rank.get(e.word.toLowerCase()) ?? "";
    if (r === "") rare++;
    const rw = regional(e.word);
    if (rw) reg++;
    const ra = e.alsoRight.map((a) => (regional(a) ? `${a}: ${regional(a)}` : "")).filter(Boolean).join(" | ");
    rows.push([e.word, e.difficulty, e.category, hs, r, [...(wikt.get(e.word)?.pos ?? [])].join(",") || (wikt.size ? "MISSING" : ""), rw, ra].join("\t"));
  }
  writeFileSync(join(RAW, "review.tsv"), rows.join("\n") + "\n");
  console.log(`review: ${notSpelled} not in Hunspell (stem or two-part compound), ${rare} not in the top 50k subtitle words, ${reg} with a regional Wiktionary label -> ${join(RAW, "review.tsv")}`);
}
