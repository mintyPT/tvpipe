import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { dictionary, parseWordList, type WordEntry } from "../game/match.ts";
import {
  addLate,
  awards,
  banked,
  goals,
  guesserOrder,
  guessesEach,
  nextGoal,
  pairKey,
  parts,
  pot,
  related,
  roomTitle,
  seeded,
  validateFace,
  web,
  WordDeck,
  type PlayerStats,
} from "../game/rules.ts";

const WORDS = parseWordList(readFileSync(new URL("../data/words.txt", import.meta.url), "utf8"));
const known = dictionary(readFileSync(new URL("../data/dict.txt", import.meta.url), "utf8"));

const entry = (word: string, difficulty = "easy", category = "thing"): WordEntry => ({ word, difficulty, category, alsoRight: [], banned: [], english: [] });

test("the pot: 10, −1 per jinxed clue (−3 bold), −2 per card after the first, +2 per bold card, never below 2", () => {
  assert.equal(pot({ jinxed: 0, turned: 0 }), 10);
  assert.equal(pot({ jinxed: 0, turned: 1 }), 10);
  assert.equal(pot({ jinxed: 0, turned: 2 }), 8);
  assert.equal(pot({ jinxed: 2, turned: 3 }), 4);
  assert.equal(pot({ jinxed: 3, turned: 3 }), 3);
  assert.equal(pot({ jinxed: 6, turned: 4 }), 2);
  assert.equal(pot({ jinxed: 20, turned: 9 }), 2);
  // Bold: a jinxed one costs 3, a turned one pays 2 (a second card that is bold is free).
  assert.equal(pot({ jinxed: 1, boldJinxed: 1, turned: 0 }), 7);
  assert.equal(pot({ jinxed: 0, turned: 1, boldTurned: 1 }), 12);
  assert.equal(pot({ jinxed: 0, turned: 2, boldTurned: 1 }), 10);
  assert.equal(pot({ jinxed: 4, boldJinxed: 2, turned: 1 }), 2);
});

test("the bank: the pot when right, −2 when wrong (never below 0), else nothing", () => {
  assert.equal(banked("right", 7, 0), 7);
  assert.equal(banked("wrong", 7, 10), -2);
  assert.equal(banked("wrong", 7, 1), -1);
  assert.ok(Object.is(banked("wrong", 7, 0), 0));
  assert.equal(banked("pass", 7, 10), 0);
  assert.equal(banked("lost", 2, 10), 0);
});

test("what a player's cards did for the room", () => {
  const cards = [
    { author: "b", bold: false, fate: "alive" as const, turned: true },
    { author: "c", bold: true, fate: "alive" as const, turned: true },
    { author: "d", bold: false, fate: "alive" as const, turned: false },
    { author: "e", bold: true, fate: "jinxed" as const, turned: false },
    { author: "f", bold: false, fate: "jinxed" as const, turned: false },
    { author: "f", bold: false, fate: "alive" as const, turned: true },
  ];
  assert.deepEqual(parts("b", "right", cards), ["turned"]);
  assert.deepEqual(parts("b", "wrong", cards), []);
  assert.deepEqual(parts("c", "right", cards), ["bold"]);
  assert.deepEqual(parts("c", "pass", cards), [], "a pot that was not won paid nothing");
  assert.deepEqual(parts("d", "right", cards), []);
  assert.deepEqual(parts("e", "right", cards), ["bold-jinxed"]);
  assert.deepEqual(parts("f", "right", cards), ["jinxed", "turned"]);
  assert.deepEqual(parts("a", "right", cards), []);
});

test("related words: one is an invalid clue for the other", () => {
  assert.equal(related(entry("fire"), entry("firework"), { known }), true);
  assert.equal(related(entry("cat"), entry("cats"), { known }), true);
  assert.equal(related(entry("snow"), entry("snowman"), { known }), true);
  assert.equal(related(entry("cat"), entry("dog"), { known }), false);
  assert.equal(related(entry("ant"), entry("elephant"), { known }), false);
  assert.equal(related(entry("cat", "easy", "animal"), { ...entry("chat"), banned: [] }, { known }), false);
  assert.equal(related({ ...entry("cat"), banned: ["gato"] }, entry("gato"), { known }), true);
});

test("the deck: no word twice until all are dealt, no related words in a game, by difficulty", () => {
  const words = ["apple", "pear", "plum", "grape", "melon", "fire", "firework", "kiwi"].map((w) => entry(w));
  const deck = new WordDeck(words, seeded(3), [], { known });
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) seen.push(deck.deal("easy", []).word);
  assert.equal(new Set(seen).size, 6);
  // A game never gets fire and firework.
  for (let s = 0; s < 40; s++) {
    const d = new WordDeck(words, seeded(s), [], { known });
    const game: WordEntry[] = [];
    for (let i = 0; i < 7; i++) game.push(d.deal("easy", game));
    const ws = game.map((g) => g.word);
    assert.ok(!(ws.includes("fire") && ws.includes("firework")), ws.join(" "));
    assert.equal(new Set(ws).size, ws.length);
  }
  // Across games (the kept `used`), every word before any repeats.
  let used: string[] = [];
  const all: string[] = [];
  for (let g = 0; g < 4; g++) {
    const d = new WordDeck(words, seeded(100 + g), used, { known });
    all.push(d.deal("easy", []).word, d.deal("easy", []).word);
    used = d.used;
  }
  assert.equal(new Set(all).size, 8, all.join(" "));
  // Difficulty: easy only; hard: no easy word.
  const real = new WordDeck(WORDS, seeded(9), [], { known });
  const diff = (w: string) => WORDS.find((e) => e.word === w)!.difficulty;
  const easy: WordEntry[] = [];
  for (let i = 0; i < 16; i++) easy.push(real.deal("easy", easy));
  assert.ok(easy.every((e) => e.difficulty === "easy"));
  const hard: WordEntry[] = [];
  for (let i = 0; i < 16; i++) hard.push(real.deal("hard", hard));
  assert.ok(hard.every((e) => diff(e.word) !== "easy"));
  const counts: Record<string, number> = { easy: 0, medium: 0, hard: 0 };
  const normal = new WordDeck(WORDS, seeded(10), [], { known });
  for (let i = 0; i < 600; i++) counts[normal.deal("normal", []).difficulty]!++;
  assert.ok(counts["hard"]! > 30 && counts["hard"]! < 100, JSON.stringify(counts));
  assert.ok(counts["medium"]! > counts["easy"]!, JSON.stringify(counts));
});

test("guesser order: join order rotated per game, twice with 3–5 players", () => {
  assert.equal(guessesEach("auto", 3), 2);
  assert.equal(guessesEach("auto", 5), 2);
  assert.equal(guessesEach("auto", 6), 1);
  assert.equal(guessesEach(1, 4), 1);
  assert.equal(guessesEach(2, 8), 2);
  const ids = (t: { id: string }[]) => t.map((x) => x.id).join("");
  assert.equal(ids(guesserOrder(["a", "b", "c"], 0, 2)), "abcabc");
  assert.equal(ids(guesserOrder(["a", "b", "c"], 1, 1)), "bca");
  assert.equal(ids(guesserOrder(["a", "b", "c"], 5, 1)), "cab");
  // A late joiner: at the end of each pass.
  const q = guesserOrder(["a", "b", "c"], 0, 2).slice(1); // a is guessing
  assert.equal(ids(addLate(q, "d", 2)), "bcdabcd");
  // In the second pass already: first after the next guesser, then at the end.
  const q2 = guesserOrder(["a", "b", "c"], 0, 2).slice(4);
  assert.equal(ids(addLate(q2, "d", 2)), "bdcd");
  assert.equal(ids(addLate([], "d", 1)), "d");
});

test("room titles and goals: 2, 4, 6, 8 chips a round", () => {
  assert.deepEqual(goals(8), { "mixed signals": 16, "in sync": 32, "mind readers": 48, telepaths: 64 });
  assert.deepEqual(goals(0), goals(1));
  assert.equal(roomTitle(64, 8), "telepaths");
  assert.equal(roomTitle(63, 8), "mind readers");
  assert.equal(roomTitle(48, 8), "mind readers");
  assert.equal(roomTitle(32, 8), "in sync");
  assert.equal(roomTitle(16, 8), "mixed signals");
  assert.equal(roomTitle(15, 8), "total jinx");
  assert.equal(roomTitle(0, 0), "total jinx");
  assert.deepEqual(nextGoal(0, 4), { title: "mixed signals", chips: 8 });
  assert.deepEqual(nextGoal(17, 4), { title: "mind readers", chips: 24 });
  assert.deepEqual(nextGoal(31, 4), { title: "telepaths", chips: 32 });
  assert.equal(nextGoal(32, 4), undefined);
});

test("awards: mind meld and telepath, at least 2, nobody blamed", () => {
  const s = (id: string, jinxed = 0, turnedRight = 0, bestClues = 0): PlayerStats => ({ id, bestClues, jinxed, turnedRight });
  const pairs = new Map([
    [pairKey("b", "a"), 3],
    [pairKey("c", "d"), 3],
    [pairKey("a", "c"), 1],
  ]);
  assert.deepEqual(awards([s("a", 4, 1), s("b", 3, 2), s("c"), s("d")], pairs), [
    { kind: "mind meld", ids: ["a", "b"], count: 3 },
    { kind: "telepath", ids: ["b"], count: 2 },
  ]);
  assert.deepEqual(awards([s("a", 9, 1)], new Map([[pairKey("a", "b"), 1]])), []);
});

test("the word web links clues used for more than one word", () => {
  const c = (display: string) => ({ display, key: display.toLowerCase().replace(/[^a-z0-9]/g, "") });
  const w = web([
    { word: "volcano", found: true, clues: [c("Lava"), c("hot"), c("LAVA")] },
    { word: "sun", found: false, clues: [c("Hot"), c("sky")] },
    { word: "oven", found: true, clues: [c("hot"), c("bake")] },
  ]);
  assert.deepEqual(w.words, [
    { word: "volcano", found: true, clues: ["Lava", "hot"] },
    { word: "sun", found: false, clues: ["Hot", "sky"] },
    { word: "oven", found: true, clues: ["hot", "bake"] },
  ]);
  assert.deepEqual(w.links, [{ clue: "hot", words: [0, 1, 2] }]);
});

test("faces", () => {
  assert.deepEqual(validateFace({ preset: 3 }), { preset: 3 });
  assert.equal(validateFace({ preset: 8 }), null);
  assert.deepEqual(validateFace({ strokes: [[0, 0, 1200.4, -3, 500.6, 500]] }), { strokes: [[0, 0, 1000, 0, 501, 500]] });
  assert.equal(validateFace({ strokes: [[1, 2, 3]] }), null);
  assert.equal(validateFace({ strokes: Array.from({ length: 41 }, () => [1, 1]) }), null);
  assert.equal(validateFace({ strokes: [Array.from({ length: 4002 }, () => 1)] }), null);
  assert.equal(validateFace("x"), null);
});
