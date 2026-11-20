// The German word list (data/words.de.txt, built by design/words/de/build.mjs)
// against the German matcher: every secret cleans and is rejected as its own
// clue, its also_right forms are judged right and rejected as clues, and its
// banned forms are rejected. Mirrors the words.txt test in match.test.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { checkSubmit, clean, dictionary, judgeGuess, parseWordList } from "../game/match-de.ts";

const WORDS = new URL("../data/words.de.txt", import.meta.url);
const DICT = new URL("../data/dict.de.txt", import.meta.url);

const CATEGORIES = new Set(["animal", "food", "home", "nature", "people", "place", "sport", "fantasy", "music", "transport", "body", "tool", "clothing", "event", "science", "material", "action", "quality"]);

test("words.de.txt: columns, categories, difficulties, no duplicates", { skip: !existsSync(WORDS) && "no data/words.de.txt" }, () => {
  const entries = parseWordList(readFileSync(WORDS, "utf8"));
  assert.ok(entries.length >= 900, `${entries.length} words`);
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!["easy", "medium", "hard"].includes(e.difficulty)) bad.push(`${e.word}: difficulty ${e.difficulty}`);
    if (!CATEGORIES.has(e.category)) bad.push(`${e.word}: category ${e.category}`);
    if (e.word.replace(/[^\p{L}]/gu, "").length < 3) bad.push(`${e.word}: under 3 letters`);
    const k = e.word.toLowerCase();
    if (seen.has(k)) bad.push(`${e.word}: duplicate`);
    seen.add(k);
    // Verbs and adjectives lowercase, nouns capitalised (Duden).
    const lower = e.word[0] === e.word[0]!.toLowerCase();
    if (lower !== (e.category === "action" || e.category === "quality")) bad.push(`${e.word}: capitalisation in ${e.category}`);
  }
  assert.deepEqual(bad, []);
});

test("words.de.txt: every secret, also_right and banned form behaves", { skip: !existsSync(WORDS) && "no data/words.de.txt" }, () => {
  const entries = parseWordList(readFileSync(WORDS, "utf8"));
  const dict = existsSync(DICT) ? dictionary(readFileSync(DICT, "utf8")) : {};
  const bad: string[] = [];
  for (const e of entries) {
    const c = clean(e.word);
    if (!c.ok) {
      bad.push(`${e.word}: does not clean (${c.error})`);
      continue;
    }
    const secret = c.clue;
    const opt = { ...dict, banned: e.banned, alsoRight: e.alsoRight };
    if (checkSubmit(e.word, secret, opt).ok) bad.push(`${e.word}: accepted as its own clue`);
    if (judgeGuess(secret, secret, opt, e.alsoRight) !== "same word") bad.push(`${e.word}: own guess not right`);
    for (const a of e.alsoRight) {
      const g = clean(a);
      if (!g.ok) bad.push(`${e.word}: also_right ${a} does not clean`);
      else if (!judgeGuess(g.clue, secret, opt, e.alsoRight)) bad.push(`${e.word}: also_right ${a} not judged right`);
      if (checkSubmit(a, secret, opt).ok) bad.push(`${e.word}: also_right ${a} accepted as a clue`);
    }
    for (const b of e.banned) if (checkSubmit(b, secret, opt).ok) bad.push(`${e.word}: banned ${b} accepted as a clue`);
  }
  assert.deepEqual(bad, []);
});
