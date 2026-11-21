import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { BOARD, checkClue, MIN_CATEGORY, parseCategories, type Lang } from "../game/rules.ts";
import { lint } from "../scripts/words.ts";

const LISTS: [Lang, string][] = [
  ["en", "words.txt"],
  ["de", "words.de.txt"],
];

for (const [lang, file] of LISTS) {
  const cats = parseCategories(readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8"));
  const all = cats.flatMap((c) => c.words);

  test(`${file}: enough categories of enough words for a board, none saying another of its category`, () => {
    assert.deepEqual(lint(cats, lang), []);
    assert.ok(cats.length >= 12, `${cats.length} categories`);
    for (const c of cats) assert.ok(c.words.length >= Math.max(MIN_CATEGORY, BOARD), c.title);
  });

  test(`${file}: every name of a word is refused as a clue on a board with it, and as that word unless it says another one too`, () => {
    for (const c of cats) {
      for (const x of c.words) {
        for (const name of [x.word, ...x.also]) {
          const clue = name.replace(/\s+/g, "");
          const r = checkClue(clue, c.words, lang, all);
          assert.equal(r.ok, false, `${clue} (${c.title})`);
          // Another word only when the clue says that one too (Wiener Schnitzel has the Wiener, a name of Würstchen).
          if (!r.ok && r.word !== x.word) assert.equal(checkClue(clue, [x], lang, all).ok, false);
          if (!r.ok && r.word !== x.word) assert.equal(checkClue(clue, c.words.filter((o) => o.word === r.word), lang, all).ok, false);
        }
      }
    }
  });
}
