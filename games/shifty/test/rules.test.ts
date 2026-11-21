import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addKey,
  BOARD,
  checkClue,
  clueOrder,
  cluesEach,
  dealBoard,
  deletions,
  earnedTotal,
  MAX_KEYS,
  parseCategories,
  pickPhony,
  POINTS,
  scoreRound,
  seeded,
  tally,
  type Earned,
  type Key,
  type Word,
} from "../game/rules.ts";

const w = (word: string, ...also: string[]): Word => ({ word, also });
const ZOO = [w("lion"), w("elephant"), w("sea horse", "seahorse"), w("fire truck", "fire engine"), w("polar bear", "ice bear"), w("zebra")];
const DE = [w("Löwe"), w("Elefant"), w("Seepferdchen"), w("Katze", "Kätzchen"), w("Hund")];

test("checkClue: one word, at most 24 characters, never a word of the board", () => {
  assert.deepEqual(checkClue("stripes", ZOO), { ok: true, text: "stripes" });
  assert.deepEqual(checkClue("  savanna ", ZOO), { ok: true, text: "savanna" });
  assert.deepEqual(checkClue("ice-cold", ZOO), { ok: true, text: "ice-cold" }, "a hyphen is one word");
  assert.deepEqual(checkClue("king's", ZOO), { ok: true, text: "king's" });
  assert.equal(checkClue("", ZOO).ok, false);
  assert.deepEqual(checkClue("   ", ZOO), { ok: false, reason: "empty" });
  assert.deepEqual(checkClue("!!", ZOO), { ok: false, reason: "empty" });
  assert.deepEqual(checkClue(42, ZOO), { ok: false, reason: "empty" });
  assert.deepEqual(checkClue("big cat", ZOO), { ok: false, reason: "space" });
  assert.deepEqual(checkClue("a".repeat(25), ZOO), { ok: false, reason: "long" });
  assert.equal(checkClue("a".repeat(24), ZOO).ok, true);
  // The word, its plural, another name, inside a longer word, a slip, in capitals.
  for (const [clue, word] of [
    ["lion", "lion"],
    ["LIONS", "lion"],
    ["babylion", "lion"],
    ["elefant", "elephant"],
    ["elephants", "elephant"],
    ["seahorse", "sea horse"],
    ["firetruck", "fire truck"],
    ["engine", "fire truck"],
    ["fire", "fire truck"],
    ["trucks", "fire truck"],
    ["sea", "sea horse"],
    ["ice", "polar bear"],
    ["bear", "polar bear"],
    ["zebras", "zebra"],
  ] as const) {
    assert.deepEqual(checkClue(clue, ZOO), { ok: false, reason: "board", word }, clue);
  }
  // Rhymes, other first letters and short words inside others are fine.
  for (const clue of ["mane", "trunk", "lying", "bra", "hose", "polarity", "fireplace"]) assert.equal(checkClue(clue, ZOO).ok, true, clue);
});

test("checkClue in German: umlauts written out, compounds, plurals", () => {
  for (const [clue, word] of [
    ["Loewe", "Löwe"],
    ["Löwen", "Löwe"],
    ["Babykatze", "Katze"],
    ["Elefanten", "Elefant"],
    ["Kaetzchen", "Katze"],
    ["Hunde", "Hund"],
    ["Seepferdchens", "Seepferdchen"],
  ] as const) {
    assert.deepEqual(checkClue(clue, DE, "de"), { ok: false, reason: "board", word }, clue);
  }
  for (const clue of ["Mähne", "Rüssel", "Streifen", "See", "Pferd", "miau"]) assert.equal(checkClue(clue, DE, "de").ok, true, clue);
});

test("checkClue: a slip of another word of the language is that word, not a refusal", () => {
  const all = [...DE, w("Laus"), w("Maus")];
  assert.equal(checkClue("Laus", [w("Maus")], "de", all).ok, true);
  assert.equal(checkClue("Mauss", [w("Maus")], "de", all).ok, false);
});

test("dealBoard: sixteen different words of the category, one the secret", () => {
  const cat = { title: "T", words: Array.from({ length: 24 }, (_, i) => w(`word${i}`)) };
  for (let seed = 1; seed < 30; seed++) {
    const { words, secret } = dealBoard(cat, seeded(seed));
    assert.equal(words.length, BOARD);
    assert.equal(new Set(words.map((x) => x.word)).size, BOARD);
    assert.ok(secret >= 0 && secret < BOARD);
  }
  const small = dealBoard({ title: "S", words: [w("a1"), w("b2"), w("c3")] }, seeded(1));
  assert.equal(small.words.length, 3);
});

test("pickPhony and clueOrder: anyone can be the phony, the phony never goes first", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const seen = new Set<string>();
  for (let seed = 1; seed < 200; seed++) {
    const rng = seeded(seed);
    const phony = pickPhony(ids, rng);
    seen.add(phony);
    const order = clueOrder(ids, phony, rng);
    assert.deepEqual([...order].sort(), ids);
    assert.notEqual(order[0], phony);
  }
  assert.deepEqual([...seen].sort(), ids);
  assert.throws(() => pickPhony([], Math.random));
});

test("cluesEach: two with up to five players (auto), else one; or the room's choice", () => {
  assert.equal(cluesEach(0, 4), 2);
  assert.equal(cluesEach(0, 5), 2);
  assert.equal(cluesEach(0, 6), 1);
  assert.equal(cluesEach(0, 10), 1);
  assert.equal(cluesEach(1, 4), 1);
  assert.equal(cluesEach(2, 9), 2);
});

test("addKey: changes only, counts never going back, the field's length bounded, at most MAX_KEYS", () => {
  const log: Key[] = [];
  assert.equal(addKey(log, 100, { n: 1, k: 1, d: 0 }), true);
  assert.equal(addKey(log, 150, { n: 1, k: 1, d: 0 }), false, "nothing changed");
  assert.equal(addKey(log, 200, { n: 0, k: 1, d: 1 }), true);
  assert.equal(addKey(log, 300, { n: 3, k: 0, d: 0 }), true, "counts cannot go back");
  assert.deepEqual(log.at(-1), [300, 3, 1, 1]);
  assert.equal(addKey(log, 250, { n: 4, k: 4, d: 1 }), true);
  assert.equal(log.at(-1)![0], 300, "time never goes back");
  assert.equal(addKey(log, 400, { n: 1e9, k: -5, d: "x" }), false, "not numbers");
  assert.equal(addKey(log, 400, null), false);
  assert.equal(addKey(log, 400, { n: 1e9, k: 1e9, d: 2 }), true);
  assert.deepEqual(log.at(-1), [400, 96, 10_000, 2]);
  assert.equal(deletions(log), 2);
  assert.equal(deletions([]), 0);
  const full: Key[] = [];
  for (let i = 0; i < MAX_KEYS + 20; i++) addKey(full, i, { n: i % 5, k: i, d: 0 });
  assert.equal(full.length, MAX_KEYS);
});

test("tally: the most accused alone, or nobody on a tie or without accusations", () => {
  assert.deepEqual(tally(new Map()), { counts: new Map(), top: null });
  assert.equal(tally(new Map([["a", "b"], ["c", "b"], ["b", "a"]])).top, "b");
  assert.equal(tally(new Map([["a", "b"], ["b", "a"]])).top, null);
  assert.equal(tally(new Map([["a", "b"], ["b", "a"], ["c", "d"], ["d", "a"]])).top, "a");
  assert.deepEqual([...tally(new Map([["a", "b"], ["c", "b"]])).counts], [["b", 2]]);
});

test("scoreRound: the points of docs/shifty-design.md §5", () => {
  const ids = ["p", "a", "b", "c"];
  const total = (m: Map<string, Earned>) => Object.fromEntries([...m].map(([id, e]) => [id, earnedTotal(e)]));
  // Caught (a and b accuse the phony), the word missed: the accusers 2, c 1, the phony 0.
  let r = scoreRound(ids, "p", new Map([["a", "p"], ["b", "p"], ["c", "a"], ["p", "c"]]), false);
  assert.equal(r.caught, true);
  assert.deepEqual(total(r.earned), { p: 0, a: POINTS.accuse + POINTS.team, b: 2, c: 1 });
  // Caught but the word named: the phony 2, the accusers 1.
  r = scoreRound(ids, "p", new Map([["a", "p"], ["b", "p"]]), true);
  assert.deepEqual(total(r.earned), { p: POINTS.word, a: 1, b: 1, c: 0 });
  // Not caught (a tie), the word named: the phony 4; whoever accused them 1.
  r = scoreRound(ids, "p", new Map([["a", "p"], ["b", "c"]]), true);
  assert.equal(r.caught, false);
  assert.deepEqual(total(r.earned), { p: POINTS.escape + POINTS.word, a: 1, b: 0, c: 0 });
  // Nobody accused: the phony escapes.
  r = scoreRound(ids, "p", new Map(), false);
  assert.deepEqual(total(r.earned), { p: 2, a: 0, b: 0, c: 0 });
});

test("parseCategories: categories, other names, comments; a word twice once", () => {
  const cats = parseCategories("# x\nlost\n== Zoo animals\nlion|big cat\n\nzebra\nLion\n== Empty ==\n== Birds ==\nowl\n");
  assert.deepEqual(cats, [
    { title: "Zoo animals", words: [w("lion", "big cat"), w("zebra")] },
    { title: "Birds", words: [w("owl")] },
  ]);
});
