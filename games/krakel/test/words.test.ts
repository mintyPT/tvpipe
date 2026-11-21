import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { fold, judge, MIN_CATEGORY, parseCategories, says, shapeOf, type Lang, type Word } from "../game/rules.ts";
import { lint } from "../scripts/words.ts";

/** A slip: the middle letter doubled (`elephhant`), on a word of five letters and more. */
function misspelt(word: string): string {
  if (word.length < 5 || word.includes(" ")) return word;
  const i = Math.floor(word.length / 2);
  return word.slice(0, i) + word[i] + word.slice(i);
}

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

  test(`${file}: every word misspelt reads right, and no word of the list reads as a slip of another`, () => {
    const all = cats.flatMap((c) => c.words);
    for (const w of all) {
      const m = misspelt(w.word);
      // Unless the slip is another word of the list (`Dönner` is a Donner, a name of Blitz).
      if (all.some((o) => o !== w && says(m, o, lang))) continue;
      assert.equal(judge(m, w, lang, all), "right", `${m} for ${w.word}`);
    }
    // Every pair that could be a slip: the same first letter, at most two letters apart in length.
    const names = all.flatMap((w) => [w.word, ...w.also].map((name) => ({ name, w, f: fold(name).replace(/ /g, "") })));
    for (const a of names) {
      for (const b of all) {
        if (a.w === b) continue;
        const f = fold(b.word).replace(/ /g, "");
        if (f[0] !== a.f[0] || Math.abs(f.length - a.f.length) > 4) continue;
        if (says(a.name, b, lang)) continue; // as written (never in one category, the test above)
        assert.notEqual(judge(a.name, b, lang, all), "right", `${a.name} (${a.w.word}) reads as a slip of ${b.word}`);
      }
    }
  });
}

test("known answers against the lists: slips, rhymes, umlauts written out, words of the list", () => {
  const lists = Object.fromEntries(LISTS.map(([lang, file]) => [lang, parseCategories(readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8")).flatMap((c) => c.words)])) as Record<Lang, Word[]>;
  const of = (lang: Lang, word: string) => {
    const w = lists[lang].find((x) => x.word === word);
    assert.ok(w, `${word} is in the ${lang} list`);
    return w;
  };
  const right: [string, string, Lang][] = [
    ["elefant", "elephant", "en"],
    ["elefants", "elephant", "en"],
    ["a girafe", "giraffe", "en"],
    ["girafes", "giraffe", "en"],
    ["pengiun", "penguin", "en"],
    ["umbrela", "umbrella", "en"],
    ["snow mann", "snowman", "en"],
    ["fire truk", "fire truck", "en"],
    ["firetruk", "fire truck", "en"],
    ["a mous", "mouse", "en"],
    ["Krokodiel", "Krokodil", "de"],
    ["Schmeterling", "Schmetterling", "de"],
    ["Gieraffe", "Giraffe", "de"],
    ["Pingiun", "Pinguin", "de"],
    ["Schneman", "Schneemann", "de"],
    // Umlauts written out.
    ["Kaese", "Käse", "de"],
    ["Schildkroete", "Schildkröte", "de"],
    ["Kuehe", "Kuh", "de"],
    ["Baer", "Bär", "de"],
    ["Loewe", "Löwe", "de"],
    ["Fuechse", "Fuchs", "de"],
  ];
  for (const [g, word, lang] of right) assert.equal(judge(g, of(lang, word), lang, lists[lang]), "right", `${g} reads ${word}`);
  const wrong: [string, string, Lang][] = [
    // Another word of the list, not a slip.
    ["a mouse", "moose", "en"],
    ["Birne", "Biene", "de"],
    ["Kirche", "Kirsche", "de"],
    // A rhyme is another word: the first letter stays.
    ["house", "mouse", "en"],
    ["power", "tower", "en"],
    ["rouse", "mouse", "en"],
    // No slips in short words, or in short stems.
    ["cap", "cat", "en"],
    ["Kuh", "Torte", "de"],
    // Two slips are too many for seven letters.
    ["pinguen", "penguin", "en"],
  ];
  for (const [g, word, lang] of wrong) assert.notEqual(judge(g, of(lang, word), lang, lists[lang]), "right", `${g} does not read ${word}`);
});
