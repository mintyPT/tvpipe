import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { misspelt } from "../game/bots.ts";
import {
  bestMove,
  cleanGuess,
  dealPicture,
  Deck,
  distance,
  flatten,
  fold,
  guessAt,
  judge,
  layerCount,
  layerPoints,
  parseList,
  parseWords,
  pickLang,
  pictureAt,
  POINTS,
  says,
  scoreRound,
  seatOf,
  seeded,
  slips,
  stem,
  validateDrawing,
  type Lang,
  type Layer,
  type Picture,
  type Word,
} from "../game/rules.ts";

const LISTS: [string, Lang][] = [
  ["words.txt", "en"],
  ["words.de.txt", "de"],
];
const list = (f: string) => parseWords(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));

test("folding and stems", () => {
  assert.equal(fold("Piratenoma!"), "piratenoma");
  assert.equal(fold("Größe  Füße"), "grosse fusse");
  assert.equal(fold("  a CAT's   hat "), "a cat s hat");
  assert.equal(fold("Crème brûlée"), "creme brulee");
  // English: plurals only.
  assert.equal(stem("pirates"), "pirate");
  assert.equal(stem("boxes"), "box");
  assert.equal(stem("cherries"), "cherry");
  assert.equal(stem("volcanoes"), "volcano");
  assert.equal(stem("glass"), "glass");
  assert.equal(stem("cactus"), "cactus");
  assert.equal(stem("bus"), "bus", "three letters stay");
  assert.equal(stem("tower"), "tower", "no German endings in English");
  // German: plural and inflection endings.
  assert.equal(stem("piraten", "de"), "pirat");
  assert.equal(stem("katze", "de"), "katz");
  assert.equal(stem("hauser", "de"), "haus");
  assert.equal(stem("gabeln", "de"), "gabel");
  assert.equal(stem("stern", "de"), "stern", "a word of its own, not a plural");
});

test("says: words, plurals, compounds, phrases", () => {
  const yes: [string, string, Lang][] = [
    ["two pirates on a boat", "pirate", "en"],
    ["a ROCKETSHIP", "rocket", "en"],
    ["kites", "kite", "en"],
    ["cherries", "cherries", "en"],
    ["Piratenschiff", "Pirat", "de"],
    ["eine Oma mit Piratenhut", "Pirat", "de"],
    ["Schneckenhaus", "Schnecke", "de"],
    ["ein Kätzchen", "Katze", "de"],
    ["Häuser", "Haus", "de"],
    ["ein wurstchen", "Würstchen", "de"],
    ["a big fire truck", "fire truck", "en"],
    ["firetruck", "fire truck", "en"],
  ];
  for (const [text, word, lang] of yes) assert.ok(says(text, word, lang), `${text} says ${word}`);
  const no: [string, string, Lang][] = [
    ["a kitten", "kite", "en"],
    ["grandma", "pirate", "en"],
    ["an ant", "pants", "en"],
    ["", "pirate", "en"],
    ["pirate", "", "en"],
    ["a cow", "cowboy", "en"],
    ["catfish", "cat", "en"],
    ["a fire", "fire truck", "en"],
    ["truck fire", "fire truck", "en"],
    ["Fenster", "Stern", "de"],
  ];
  for (const [text, word, lang] of no) assert.ok(!says(text, word, lang), `${text} does not say ${word}`);
});

test("judge: the word or any synonym, with plurals", () => {
  const cat: Word = { word: "cat", also: ["kitten", "kitty"] };
  for (const g of ["cat", "Cats!", "a little kitten", "kittens", "KITTY"]) assert.ok(judge(g, cat), g);
  for (const g of ["dog", "catfish", "kit", ""]) assert.ok(!judge(g, cat), g);
  const hedgehog: Word = { word: "hedgehog", also: ["porcupine"] };
  assert.ok(judge("a porcupine", hedgehog));
  assert.ok(judge("hedgehogs", hedgehog));
  const igel: Word = { word: "Igel", also: [] };
  assert.ok(judge("ein Igelchen", igel, "de"));
});

test("distance: inserts, deletes, replacements and swaps", () => {
  assert.equal(distance("elephant", "elephant"), 0);
  assert.equal(distance("elefant", "elephant"), 2);
  assert.equal(distance("girafe", "giraffe"), 1);
  assert.equal(distance("pengiun", "penguin"), 1, "two neighbours swapped");
  assert.equal(distance("krokodiel", "krokodil"), 1);
  assert.equal(distance("cat", "elephant", 2), 3, "more than max: max + 1");
  assert.deepEqual([3, 4, 5, 7, 8, 14].map(slips), [0, 0, 1, 1, 2, 2]);
});

test("judge: spelling slips count, unless they are another word", () => {
  const en = list("words.txt");
  const de = list("words.de.txt");
  const of = (words: Word[], w: string) => words.find((x) => x.word === w) ?? { word: w, also: [] };
  const right: [string, string, Lang][] = [
    ["elefant", "elephant", "en"],
    ["elefants", "elephant", "en"],
    ["a girafe", "giraffe", "en"],
    ["pengiun", "penguin", "en"],
    ["umbrela", "umbrella", "en"],
    ["snow mann", "snowman", "en"],
    ["a big firetruk", "fire truck", "en"],
    ["fire truk", "fire truck", "en"],
    ["a mous", "mouse", "en"],
    ["Krokodiel", "Krokodil", "de"],
    ["Schmeterling", "Schmetterling", "de"],
    ["Gieraffe", "Giraffe", "de"],
    ["Pingiun", "Pinguin", "de"],
    ["Schneman", "Schneemann", "de"],
    // Umlauts written out.
    ["Kaese", "Käse", "de"],
    ["Schildkroete", "Schildkröte", "de"],
    ["zwei Kuehe", "Kuh", "de"],
  ];
  for (const [g, w, lang] of right) assert.ok(judge(g, of(lang === "de" ? de : en, w), lang, lang === "de" ? de : en), `${g} reads ${w}`);
  const wrong: [string, string, Lang][] = [
    // Another word of the list, not a slip.
    ["house", "horse", "en"],
    ["a mouse", "moose", "en"],
    ["Birne", "Biene", "de"],
    ["Kirche", "Kirsche", "de"],
    ["Feuer", "Feder", "de"],
    // A rhyme is another word: the first letter stays.
    ["power", "tower", "en"],
    ["rouse", "mouse", "en"],
    // No slips in short words, or in short stems.
    ["cap", "cat", "en"],
    ["Kuh", "Torte", "de"],
    ["frying pan", "trousers", "en"],
    // Two slips are too many for seven letters.
    ["pinguen", "penguin", "en"],
  ];
  for (const [g, w, lang] of wrong) assert.ok(!judge(g, of(lang === "de" ? de : en, w), lang, lang === "de" ? de : en), `${g} does not read ${w}`);
  // Without a list, only the word itself guards: a word of the list may then be a slip.
  assert.ok(judge("house", of(en, "horse"), "en"));
  // A bot's slip is one.
  assert.equal(misspelt("elephant"), "elephhant");
  assert.equal(misspelt("owl"), "owl");
  for (const w of en) if (!w.word.includes(" ")) assert.ok(judge(misspelt(w.word), w, "en", en), `${misspelt(w.word)} reads ${w.word}`);
  for (const w of de) if (!w.word.includes(" ")) assert.ok(judge(misspelt(w.word), w, "de", de), `${misspelt(w.word)} reads ${w.word}`);
});

test("the word lists: drawable entries with synonyms, none saying another", () => {
  for (const [f, lang] of LISTS) {
    const words = list(f);
    assert.ok(words.length >= 180, `${f}: ${words.length} words`);
    assert.ok(words.filter((w) => w.also.length > 0).length >= words.length / 3, `${f}: synonyms`);
    const forms = new Map<string, string>();
    for (const w of words) {
      for (const form of [w.word, ...w.also]) {
        assert.ok(form.length <= 24, `${f}: ${form} is short`);
        const k = fold(form);
        assert.ok(!forms.has(k), `${f}: ${form} twice (${forms.get(k)} and ${w.word})`);
        forms.set(k, w.word);
        assert.ok(judge(form, w, lang), `${f}: ${form} reads ${w.word} right`);
      }
    }
    for (const a of words) {
      for (const b of words) {
        if (a === b) continue;
        for (const form of [a.word, ...a.also]) {
          assert.ok(!says(form, b.word, lang) && !b.also.some((x) => says(form, x, lang)), `${f}: ${form} (${a.word}) says ${b.word}`);
          assert.ok(!judge(form, b, lang, words), `${f}: ${form} (${a.word}) reads as a slip of ${b.word}`);
        }
      }
    }
  }
});

test("data files", () => {
  assert.deepEqual(parseList("# comment\n\na cat\nA Cat\n  a dog  \n"), ["a cat", "a dog"]);
  assert.deepEqual(parseWords("cat|kitten| kitty \n# no\ndog\n|x\n"), [
    { word: "cat", also: ["kitten", "kitty"] },
    { word: "dog", also: [] },
    { word: "x", also: [] },
  ]);
});

test("drawings from phones", () => {
  assert.deepEqual(validateDrawing({ strokes: [[16, 0, 0, 1000, 1000], [7, 5, 5]] }), { strokes: [[16, 0, 0, 1000, 1000], [7, 5, 5]] });
  assert.deepEqual(validateDrawing({ strokes: [], extra: 1 }), { strokes: [] });
  for (const bad of [null, {}, { strokes: [[16, 0]] }, { strokes: [[0, 1, 1]] }, { strokes: [[16, 1, 1001]] }, { strokes: [[16, 1.5, 1]] }, { strokes: [["16", 1, 1]] }, { strokes: Array(401).fill([7, 1, 1]) }]) {
    assert.throws(() => validateDrawing(bad), /Bad drawing/, JSON.stringify(bad).slice(0, 40));
  }
  assert.throws(() => validateDrawing({ strokes: Array.from({ length: 10 }, () => [7, ...Array(3400).fill(5)]) }), /too many points/);
  // The next player sees one ink: the layers' strokes in order.
  assert.deepEqual(flatten([{ drawing: { strokes: [[7, 1, 1]] } }, { drawing: { strokes: [[16, 2, 2, 3, 3]] } }]), { strokes: [[7, 1, 1], [16, 2, 2, 3, 3]] });
});

test("guesses are cleaned", () => {
  assert.equal(cleanGuess("  a   cat\u200b on\ta hat "), "a cat on a hat");
  assert.equal(cleanGuess(42), "");
  assert.equal(cleanGuess("x".repeat(60)).length, 28);
});

test("languages", () => {
  assert.equal(pickLang("de-AT"), "de");
  assert.equal(pickLang("fr"), "en");
  assert.equal(pickLang(undefined), "en");
});

test("the seating: every step a permutation, no picture visits anyone twice", () => {
  for (let n = 3; n <= 12; n++) {
    for (const len of [3, 5, 7]) {
      const layers = layerCount(n, len);
      assert.ok(layers <= len && layers <= n - 1 && layers >= Math.min(3, n - 1), `${n} players, length ${len}: ${layers}`);
      // Steps 0 … layers: the drawers of layers 1 … L, then the last guesser.
      for (let k = 0; k <= layers; k++) {
        const seats = new Set<number>();
        for (let c = 0; c < n; c++) {
          const s = seatOf(c, k, n);
          seats.add(s);
          assert.equal(pictureAt(s, k, n), c);
        }
        assert.equal(seats.size, n, "every seat busy, every step");
      }
      for (let c = 0; c < n; c++) {
        const visited = new Set(Array.from({ length: layers + 1 }, (_, k) => seatOf(c, k, n)));
        assert.equal(visited.size, layers + 1);
        assert.equal(seatOf(c, 0, n), c, "the picture's starter draws first");
      }
    }
  }
  assert.equal(layerCount(3, 5), 2);
  assert.equal(layerCount(4, 5), 3);
  assert.equal(layerCount(6, 5), 5);
  assert.equal(layerCount(12, 7), 7);
  assert.equal(layerCount(5, 7), 4);
});

test("decks deal everything before repeating, and skip what does not fit", () => {
  const d = new Deck(["a", "b", "c"], seeded(1));
  const first = [d.draw(), d.draw(), d.draw()].sort();
  assert.deepEqual(first, ["a", "b", "c"]);
  const e = new Deck(["a", "b", "c"], seeded(2));
  for (let i = 0; i < 10; i++) assert.notEqual(e.draw((c) => c !== "b"), "b");
  assert.equal(new Deck(["x"], seeded(1)).draw(() => false), "x", "nothing fits: any card");
});

test("a picture's words: two to pick from, then one per layer, none twice", () => {
  for (const [f, lang] of LISTS) {
    const deck = new Deck(list(f), seeded(5));
    for (let i = 0; i < 60; i++) {
      const { choices, words } = dealPicture(deck, 7, lang);
      assert.equal(words.length, 6);
      const all = [...choices, ...words];
      assert.equal(new Set(all.map((w) => w.word)).size, 8, "never twice in one picture");
      for (const a of all) for (const b of all) if (a !== b) assert.ok(!judge(a.word, b, lang), `${a.word} and ${b.word} in one picture: one reads as the other`);
    }
  }
  // Words a slip apart never share a picture.
  const near = new Deck<Word>([{ word: "horse", also: [] }, { word: "house", also: [] }, { word: "cat", also: [] }, { word: "dog", also: [] }], seeded(4));
  for (let i = 0; i < 20; i++) {
    const { choices, words } = dealPicture(near, 2);
    const all = [...choices, ...words].map((w) => w.word);
    assert.ok(!(all.includes("horse") && all.includes("house")), all.join(", "));
  }
  // A tiny deck: still a deal (the deck reshuffles).
  const small = new Deck<Word>([{ word: "cat", also: [] }, { word: "dog", also: [] }, { word: "owl", also: [] }], seeded(3));
  const { choices, words } = dealPicture(small, 3);
  assert.equal(choices.length, 2);
  assert.equal(words.length, 2);
});

// ---------------------------------------------------------------------------
// Points

const D = { strokes: [[16, 1, 1, 2, 2]] };
const w = (word: string, ...also: string[]): Word => ({ word, also });

/** cat (a) → submarine (b) → hedgehog (c), read by b, c, d. */
function picture(): Picture {
  const layers: Layer[] = [
    { by: "a", word: w("cat", "kitten"), drawing: D, guess: null },
    { by: "b", word: w("submarine", "sub"), drawing: D, guess: null },
    { by: "c", word: w("hedgehog", "porcupine"), drawing: D, guess: null },
  ];
  layers[0]!.guess = guessAt(layers[0]!, "b", "kitten");
  layers[1]!.guess = guessAt(layers[1]!, "c", "a whale");
  layers[2]!.guess = guessAt(layers[2]!, "d", "porcupines");
  return { id: 0, layers };
}

test("layers pay more the later they are", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(layerPoints), [100, 150, 200, 250, 300, 350, 400]);
  assert.equal(POINTS.best, 200);
});

test("guesses are judged against their layer's word", () => {
  const p = picture();
  assert.deepEqual(
    p.layers.map((l) => l.guess?.right),
    [true, false, true],
  );
  assert.equal(guessAt(p.layers[0]!, "b", "").right, false, "no guess is wrong");
});

test("the best move: most votes, ties split", () => {
  assert.deepEqual(bestMove(new Map()), { ids: [], count: 0, points: 0 });
  assert.deepEqual(
    bestMove(
      new Map([
        ["a", "0:1"],
        ["b", "0:1"],
        ["c", "1:2"],
      ]),
    ),
    { ids: ["0:1"], count: 2, points: 200 },
  );
  assert.deepEqual(
    bestMove(
      new Map([
        ["a", "1:0"],
        ["b", "0:2"],
        ["c", "0:1"],
        ["d", "0:1"],
        ["e", "0:2"],
        ["f", "1:0"],
      ]),
    ),
    { ids: ["0:1", "0:2", "1:0"], count: 2, points: 70 },
    "a three-way tie: 200 / 3, in tens",
  );
  assert.equal(
    bestMove(
      new Map([
        ["a", "1:0"],
        ["b", "1:0"],
        ["c", "0:2"],
        ["d", "0:2"],
      ]),
    ).points,
    100,
  );
  assert.deepEqual(
    bestMove(
      new Map([
        ["a", "1:0"],
        ["b", "0:2"],
      ]),
    ),
    { ids: [], count: 0, points: 0 },
    "one vote each: no best move",
  );
});

test("a round's points: drawer and reader of each layer read right, the best move", () => {
  const p = picture();
  const earned = scoreRound(
    [p],
    new Map([
      ["a", "0:1"],
      ["d", "0:1"],
      ["b", "0:2"],
    ]),
  );
  // Layer 1 (cat, 100): a drew it, b read it. Layer 2 (submarine): misread. Layer 3 (hedgehog, 200): c drew, d read.
  assert.deepEqual(earned.get("a"), { drawn: 100, read: 0, best: 0 });
  assert.deepEqual(earned.get("b"), { drawn: 0, read: 100, best: 200 }, "the submarine was the best move");
  assert.deepEqual(earned.get("c"), { drawn: 200, read: 0, best: 0 });
  assert.deepEqual(earned.get("d"), { drawn: 0, read: 200, best: 0 });
  // A blank layer read right (by luck) pays nobody.
  const blank: Picture = { id: 2, layers: [{ by: "f", word: w("owl"), drawing: { strokes: [] }, guess: null }] };
  blank.layers[0]!.guess = guessAt(blank.layers[0]!, "g", "owl");
  assert.equal(blank.layers[0]!.guess.right, true);
  const none = scoreRound([blank], new Map());
  assert.deepEqual([none.get("f"), none.get("g")], [{ drawn: 0, read: 0, best: 0 }, { drawn: 0, read: 0, best: 0 }]);
  // No guess yet (or none at all): nothing.
  const bare: Picture = { id: 1, layers: [{ by: "e", word: w("owl"), drawing: D, guess: null }] };
  assert.deepEqual(scoreRound([bare], new Map()).get("e"), { drawn: 0, read: 0, best: 0 });
});
