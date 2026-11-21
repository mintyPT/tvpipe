import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { judge, MIN_CATEGORY, parseCategories, shapeOf, type Lang } from "../game/rules.ts";
import { lint } from "../scripts/words.ts";

const LISTS: [Lang, string][] = [
  ["en", "words.txt"],
  ["de", "words.de.txt"],
];

for (const [lang, file] of LISTS) {
  const cats = parseCategories(readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8"));

  test(`${file}: enough categories of enough words, every word in one category, none saying another of its category`, () => {
    assert.deepEqual(lint(cats, lang), []);
    assert.ok(cats.length >= 12, `${cats.length} categories`);
    for (const c of cats) assert.ok(c.words.length >= MIN_CATEGORY, c.title);
  });

  test(`${file}: every word and every other name is right for its entry, and never for another of its category`, () => {
    const all = cats.flatMap((c) => c.words);
    for (const c of cats) {
      for (const w of c.words) {
        for (const name of [w.word, ...w.also]) {
          assert.equal(judge(name, w, lang, all), "right", `${name} for ${w.word}`);
          assert.equal(judge(name.toUpperCase(), w, lang, all), "right", `${name.toUpperCase()} for ${w.word}`);
          for (const o of c.words) if (o !== w) assert.notEqual(judge(name, o, lang, all), "right", `${name} for ${o.word} (${c.title})`);
        }
        assert.ok(shapeOf(w.word).includes("_"));
      }
    }
  });
}
