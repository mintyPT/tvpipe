import assert from "node:assert/strict";
import { test } from "node:test";

import {
  artistPoints,
  choicesFor,
  cleanGuess,
  dealRound,
  Deck,
  distance,
  earnedTotal,
  ERASER,
  favourite,
  fold,
  guessPoints,
  hasInk,
  judge,
  MAX_POINTS,
  MAX_STROKES,
  PALETTE,
  parseCategories,
  pickLang,
  POINTS,
  rankEntries,
  says,
  scoreRound,
  seeded,
  shapeOf,
  slips,
  stem,
  tokens,
  validateDrawing,
  type Category,
  type Entry,
  type Word,
} from "../game/rules.ts";

const w = (word: string, ...also: string[]): Word => ({ word, also });

test("drawings: strokes of [colour, width, x, y, …] on the grid, whole numbers, within the limits", () => {
  const ok = { strokes: [[1, 14, 0, 0, 1000, 1000], [3, 30, 500, 500]] };
  assert.deepEqual(validateDrawing(ok), ok);
  assert.deepEqual(validateDrawing({ strokes: [], extra: 1 }), { strokes: [] });
  for (const bad of [
    null,
    {},
    { strokes: "x" },
    { strokes: [[1, 14]] },
    { strokes: [[1, 14, 5]] },
    { strokes: [[1, 14, 5, 5, 6]] },
    { strokes: [[1, 14, 5.5, 5]] },
    { strokes: [[1, 14, "5", 5]] },
    { strokes: [[PALETTE.length, 14, 5, 5]] },
    { strokes: [[-1, 14, 5, 5]] },
    { strokes: [[1, 0, 5, 5]] },
    { strokes: [[1, 121, 5, 5]] },
    { strokes: [[1, 14, 5, 1001]] },
    { strokes: [[1, 14, -1, 5]] },
    { strokes: Array.from({ length: MAX_STROKES + 1 }, () => [1, 14, 5, 5]) },
    { strokes: [[1, 14, ...Array.from({ length: 2 * (MAX_POINTS + 1) }, () => 5)]] },
  ]) {
    assert.throws(() => validateDrawing(bad), { code: "bad-drawing" }, JSON.stringify(bad)?.slice(0, 60));
  }
  assert.equal(validateDrawing({ strokes: [[1, 14, ...Array.from({ length: 2 * MAX_POINTS }, () => 5)]] }).strokes.length, 1);
});

test("a page with only the eraser on it is blank", () => {
  assert.equal(hasInk(undefined), false);
  assert.equal(hasInk({ strokes: [] }), false);
  assert.equal(hasInk({ strokes: [[ERASER, 64, 1, 1, 9, 9]] }), false);
  assert.equal(hasInk({ strokes: [[ERASER, 64, 1, 1], [5, 6, 2, 2]] }), true);
});

test("languages and folding", () => {
  assert.equal(pickLang("de-AT"), "de");
  assert.equal(pickLang("fr"), "en");
  assert.equal(pickLang(undefined), "en");
  assert.equal(fold("  Größe-Maß, Café!  "), "grosse mass cafe");
  assert.deepEqual(tokens("The Fire-Truck"), ["fire", "truck"]);
  assert.deepEqual(tokens("ein Der Hund", "de"), ["hund"]);
  assert.deepEqual(tokens("the", "en"), ["the"], "never all of it");
  assert.deepEqual(tokens("die Ente", "en"), ["die", "ente"], "German articles only in German");
  assert.equal(cleanGuess("  a   cat \u0007 "), "a cat");
  assert.equal(cleanGuess(5), "");
});

test("stems: one plural or inflection ending", () => {
  for (const [a, b] of [["foxes", "fox"], ["cats", "cat"], ["cherries", "cherry"], ["glass", "glass"], ["cactus", "cactus"], ["bus", "bus"], ["tomatoes", "tomato"]] as const) assert.equal(stem(a, "en"), b, a);
  for (const [a, b] of [["katzen", "katz"], ["katze", "katz"], ["hunde", "hund"], ["fuchse", "fuchs"], ["gabeln", "gabel"], ["autos", "auto"], ["ei", "ei"], ["bar", "bar"]] as const) assert.equal(stem(a, "de"), b, a);
});

test("the edit distance: insert, delete, replace, a swap of neighbours; capped", () => {
  assert.equal(distance("fox", "fox"), 0);
  assert.equal(distance("elefant", "elephant"), 2);
  assert.equal(distance("gitarre", "gitare"), 1);
  assert.equal(distance("giraffe", "girafef"), 1, "two neighbours swapped");
  assert.equal(distance("abc", "ca"), 3);
  assert.equal(distance("", "abc"), 3);
  assert.equal(distance("kitten", "sitting"), 3);
  assert.equal(distance("abcdef", "uvwxyz", 2), 3, "more than max: max + 1");
  assert.equal(distance("a", "abcdefgh", 2), 3);
  assert.deepEqual([3, 4, 5, 7, 8, 14].map(slips), [0, 0, 1, 1, 2, 2]);
});

test("a guess that says the word as written: the word, its plural, another name, written as one, inside a longer word", () => {
  const fox = w("fox", "red fox");
  const truck = w("fire truck", "fire engine");
  for (const g of ["fox", "Fox!", "a fox", "the foxes", "FOX ", "red fox", "redfox"]) assert.ok(says(g, fox), g);
  for (const g of ["wolf", "", "fo", "foxwolf", "fox wolf", "box"]) assert.ok(!says(g, fox), g);
  for (const g of ["fire truck", "firetruck", "fire-truck", "a fire engine", "fire trucks"]) assert.ok(says(g, truck), g);
  for (const g of ["truck", "fire", "red fire truck"]) assert.ok(!says(g, truck), g);
  const katze = w("Katze");
  for (const g of ["Katze", "katzen", "eine Katze", "die Katzen", "Babykatze", "Kätzchen", "KATZE"]) assert.ok(says(g, katze, "de"), g);
  for (const g of ["Kater", "Hund Katze", "Katze Hund", "Tatze"]) assert.ok(!says(g, katze, "de"), g);
  assert.ok(says("Füchse", w("Fuchs"), "de"));
  assert.ok(says("Gänse", w("Gans"), "de"));
  assert.ok(says("Segelschiff", w("Schiff"), "de"), "a compound with the word inside");
  assert.ok(!says("Schiff", w("Segelschiff"), "de"), "but not the other way round");
  assert.ok(!says("Eisbär", w("Bär"), "de"), "short words are not found inside others");
});

test("judging a guess: slips are forgiven (none up to 4 letters, one up to 7, two from 8), one more is close", () => {
  const cases: [string, Word, "en" | "de", string][] = [
    ["elephant", w("elephant"), "en", "right"],
    ["elefant", w("elephant"), "en", "right"],
    ["elefent", w("elephant"), "en", "close"],
    ["elefnt", w("elephant"), "en", "close"],
    ["elfnt", w("elephant"), "en", "wrong"],
    ["girafe", w("giraffe"), "en", "right"],
    ["jiraf", w("giraffe"), "en", "wrong"],
    ["crocodil", w("crocodile", "croc"), "en", "right"],
    ["krokodil", w("crocodile", "croc"), "en", "close"],
    ["krokodile", w("crocodile", "croc"), "en", "right"],
    ["krokodiel", w("Krokodil"), "de", "right"],
    ["croc", w("crocodile", "croc"), "en", "right"],
    ["cat", w("cat"), "en", "right"],
    ["cot", w("cat"), "en", "wrong"],
    ["hose", w("Hase"), "de", "close"],
    ["tiger", w("tiger"), "en", "right"],
    ["tigr", w("tiger"), "en", "right"],
    ["tgr", w("tiger"), "en", "close"],
    ["", w("tiger"), "en", "wrong"],
    ["   ", w("tiger"), "en", "wrong"],
    ["lion tiger", w("tiger"), "en", "wrong"],
    ["a tiger", w("tiger"), "en", "right"],
    ["Feuerwehrauto", w("Feuerwehrauto", "Feuerwehr"), "de", "right"],
    ["Feuerwer", w("Feuerwehrauto", "Feuerwehr"), "de", "right"],
    ["die Feuerwehr", w("Feuerwehrauto", "Feuerwehr"), "de", "right"],
  ];
  for (const [g, word, lang, verdict] of cases) assert.equal(judge(g, word, lang), verdict, `${g} for ${word.word}`);
});

test("a slip never turns one word of the list into another", () => {
  const maus = w("Maus");
  const laus = w("Laus");
  const katze = w("Katze");
  const tatze = w("Tatze", "Pfote");
  const list = [maus, laus, katze, tatze];
  assert.equal(judge("Tatze", katze, "de"), "right", "alone it would be a slip");
  assert.equal(judge("Tatze", katze, "de", list), "wrong");
  assert.equal(judge("Tatzen", katze, "de", list), "wrong");
  assert.equal(judge("Pfote", katze, "de", list), "wrong");
  assert.equal(judge("Katse", katze, "de", list), "right");
  assert.equal(judge("Katze", katze, "de", list), "right", "the word itself is in the list");
  assert.equal(judge("Laus", maus, "de", list), "wrong");
  // A slip in a long word that has a short one of the list inside is still a slip.
  const sword = w("sword");
  const swordfish = w("swordfish");
  assert.equal(judge("swordfis", swordfish, "en", [sword, swordfish]), "right");
  assert.equal(judge("sordfish", swordfish, "en", [sword, swordfish]), "right");
  assert.equal(judge("swords", swordfish, "en", [sword, swordfish]), "wrong");
  assert.equal(judge("swordfish", sword, "en", [sword, swordfish]), "right", "the longer word says the shorter one (they are never in one category)");
  // A copy of the word (another object) is the word.
  assert.equal(judge("Katze", w("Katze"), "de", list), "right");
});

test("the easy mode's blanks", () => {
  assert.equal(shapeOf("fox"), "___");
  assert.equal(shapeOf("fire truck"), "____ _____");
  assert.equal(shapeOf("T-Shirt"), "_-_____");
  assert.equal(shapeOf("Bär"), "___");
  assert.equal(shapeOf("Ba\u0308r"), "___", "a decomposed umlaut is one letter");
});

test("word lists: categories of words with their other names", () => {
  const cats = parseCategories(`# a comment
stray|before any category

== Zoo animals
lion
polar bear | ice bear |
Lion
# another comment
hippo|hippopotamus

==  Fruit  ==
apple
== Empty
`);
  assert.deepEqual(cats, [
    { title: "Zoo animals", words: [w("lion"), w("polar bear", "ice bear"), w("hippo", "hippopotamus")] },
    { title: "Fruit", words: [w("apple")] },
  ]);
});

test("decks deal every card before any twice", () => {
  const deck = new Deck(["a", "b", "c", "d"], seeded(3));
  const first = [deck.draw(), deck.draw(), deck.draw(), deck.draw()];
  assert.deepEqual([...first].sort(), ["a", "b", "c", "d"]);
  const next = [deck.draw(), deck.draw(), deck.draw(), deck.draw()];
  assert.deepEqual([...next].sort(), ["a", "b", "c", "d"]);
  assert.equal(new Deck(["a", "b"], seeded(1)).draw((x) => x === "b"), "b");
  assert.equal(new Deck(["a", "b"], seeded(1)).draw(() => false).length, 1, "none fits: any");
  assert.throws(() => new Deck([], seeded(1)));
});

test("the deal: two words each to pick from when the category has enough, no word twice", () => {
  const cat: Category = { title: "T", words: Array.from({ length: 20 }, (_, i) => w(`w${i}`)) };
  assert.equal(choicesFor(20, 10), 2);
  assert.equal(choicesFor(19, 10), 1);
  assert.equal(choicesFor(6, 3), 2);
  for (const n of [3, 7, 10]) {
    const deal = dealRound(cat, n, seeded(n));
    assert.equal(deal.length, n);
    assert.ok(deal.every((d) => d.length === 2));
    assert.equal(new Set(deal.flat().map((x) => x.word)).size, 2 * n);
  }
  const small: Category = { title: "S", words: cat.words.slice(0, 7) };
  const deal = dealRound(small, 5, seeded(1));
  assert.ok(deal.every((d) => d.length === 1));
  assert.equal(new Set(deal.flat().map((x) => x.word)).size, 5);
});

test("points: a right guess pays by time, the artist half of what the guessers earned by time", () => {
  assert.equal(guessPoints(0), 1000);
  assert.equal(guessPoints(1), 200);
  assert.equal(guessPoints(0.5), 600);
  assert.equal(guessPoints(0.123), 900);
  assert.equal(guessPoints(-1), 1000);
  assert.equal(guessPoints(7), 200);
  assert.equal(guessPoints(Number.NaN), 200);
  assert.equal(artistPoints([]), 0);
  assert.equal(artistPoints([1000, 600]), 800);
  assert.equal(artistPoints([990]), 500, "to the next ten");
  assert.equal(POINTS.first, 200);
});

test("the favourite: the most hearts, at least two; ties split it", () => {
  const votes = (pairs: [string, string][]) => new Map(pairs);
  assert.deepEqual(favourite(votes([])), { ids: [], count: 0, points: 0 });
  assert.deepEqual(favourite(votes([["a", "b"], ["b", "c"], ["c", "a"]])), { ids: [], count: 0, points: 0 }, "one heart each: no favourite");
  assert.deepEqual(favourite(votes([["a", "b"], ["c", "b"], ["b", "a"]])), { ids: ["b"], count: 2, points: 500 });
  assert.deepEqual(favourite(votes([["a", "b"], ["c", "b"], ["b", "a"], ["d", "a"]])), { ids: ["a", "b"], count: 2, points: 250 });
  assert.deepEqual(favourite(votes([["a", "d"], ["b", "d"], ["c", "e"], ["d", "e"], ["e", "f"], ["f", "f2"], ["g", "f"]])).points, 170, "three share 500: 170 each");
});

const entry = (by: string, hits: [string, number][], shown = true): Entry => ({
  by,
  word: w(`word of ${by}`),
  drawing: { strokes: shown ? [[1, 14, 1, 1]] : [] },
  guessers: ["a", "b", "c", "d"].filter((x) => x !== by),
  hits: hits.map(([id, at], i) => ({ by: id, at, points: guessPoints(at), first: i === 0 })),
  shown,
});

test("the round's points and the drawings ranked", () => {
  const entries = [
    entry("a", [["b", 0], ["c", 0.5]]), // 1000 + 600 → the artist 800
    entry("b", [["a", 0.25], ["c", 0.25], ["d", 0.5]]), // 800 + 800 + 600 → 1100
    entry("c", []), // nobody: 0
    entry("d", [], false), // a blank page
  ];
  const earned = scoreRound(entries, new Map([["a", "b"], ["c", "b"], ["b", "a"]]));
  assert.deepEqual(earned.get("a"), { drawn: 800, guessed: 800, first: 200, favourite: 0 });
  assert.deepEqual(earned.get("b"), { drawn: 1100, guessed: 1000, first: 200, favourite: 500 });
  assert.deepEqual(earned.get("c"), { drawn: 0, guessed: 1400, first: 0, favourite: 0 });
  assert.deepEqual(earned.get("d"), { drawn: 0, guessed: 600, first: 0, favourite: 0 });
  assert.equal(earnedTotal(earned.get("b")!), 2800);
  assert.deepEqual(
    rankEntries(entries).map((r) => [r.entry.by, r.place, r.points]),
    [["b", 1, 1100], ["a", 2, 800], ["c", 3, 0], ["d", 4, 0]],
  );
  // The same points: more guessers first, then the earlier first guess; all the same share a place.
  const tied = [entry("a", [["b", 0.5]]), entry("b", [["a", 0.75], ["c", 0.75]]), entry("c", [["a", 0.75], ["b", 0.75]])];
  assert.deepEqual(
    rankEntries(tied).map((r) => [r.entry.by, r.place, r.points]),
    [["b", 1, 400], ["c", 1, 400], ["a", 3, 300]],
  );
});
