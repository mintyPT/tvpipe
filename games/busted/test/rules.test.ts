import assert from "node:assert/strict";
import { test } from "node:test";

import { doodle, FACE, MAX_POINTS, pathOf, readPortrait, thin } from "../game/face.ts";
import {
  answersEach,
  cleanAnswer,
  cleanQuestion,
  cleanTitle,
  kindOf,
  makeCards,
  parseQuestions,
  pickSuggestion,
  podiumSize,
  QuestionDeck,
  questionKey,
  ratingState,
  readMatch,
  readPodium,
  scoreMatch,
  scoreVote,
  seeded,
  tally,
  type Card,
} from "../game/rules.ts";

test("the question list: kinds, levels, titles; bad lines are skipped and named", () => {
  const errors: string[] = [];
  const qs = parseQuestions(
    [
      "# a comment",
      "vote\tfamily\tWho would most likely sleep through a whole day?\tSleepyhead of the Year",
      "answer\tparty\tWhat would be your most useless superpower?",
      "",
      "vote\tfamily\tWho would most likely get lost in a lift?", // no title
      "answer\tfamily\tWhat would be your most useless superpower?", // twice (same kind, same text)
      "quiz\tfamily\tWhat is the capital of France?",
      "answer\tspicy\tWhat is in your pockets right now?",
    ].join("\n"),
    errors,
  );
  assert.deepEqual(qs, [
    { kind: "vote", level: "family", text: "Who would most likely sleep through a whole day?", title: "Sleepyhead of the Year" },
    { kind: "answer", level: "party", text: "What would be your most useless superpower?" },
  ]);
  assert.equal(errors.length, 4);
  assert.match(errors[0]!, /line 5: a vote needs a title/);
  assert.match(errors[1]!, /line 6: twice/);
});

test("rounds alternate: vote first", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(kindOf), ["vote", "answer", "vote", "answer", "vote"]);
});

test("the deck: no question twice until all fitting were played; family never deals party", () => {
  const qs = parseQuestions(
    [
      "vote\tfamily\tWho would most likely bake a cake at midnight?\tMidnight Baker",
      "vote\tfamily\tWho would most likely adopt ten cats?\tCat Magnet",
      "vote\tparty\tWho would most likely text the wrong person?\tWrong Number",
      "answer\tfamily\tWhat would your robot butler be called?",
    ].join("\n"),
  );
  const deck = new QuestionDeck(qs, seeded(3));
  const fam = [deck.draw("vote", "family")!, deck.draw("vote", "family")!].map((q) => q.text).sort();
  assert.deepEqual(fam, ["Who would most likely adopt ten cats?", "Who would most likely bake a cake at midnight?"]);
  // Both played: they come back.
  assert.equal(deck.draw("vote", "family")!.level, "family");
  // Party deals both levels; the one party question comes within a few draws.
  const party = new Set(Array.from({ length: 6 }, () => deck.draw("vote", "party")!.level));
  assert.deepEqual([...party].sort(), ["family", "party"]);
  assert.equal(deck.count("vote", "family"), 2);
  assert.equal(deck.count("vote", "party"), 3);
  // What the room played before is dealt last.
  const seen = new QuestionDeck(qs, seeded(1), [questionKey(qs[0]!)]);
  assert.equal(seen.draw("vote", "family")!.text, "Who would most likely adopt ten cats?");
});

test("answers: one line, a capital first, no full stop, no shouting", () => {
  assert.equal(cleanAnswer("  a llama\n in a   tiny hat. "), "A llama in a tiny hat");
  assert.equal(cleanAnswer("wait for it..."), "Wait for it...");
  assert.equal(cleanAnswer("WHAT IS THIS"), "What is this");
  assert.equal(cleanAnswer("NASA"), "NASA");
  assert.equal(cleanAnswer("„äpfel“"), "„Äpfel“");
  assert.equal(cleanAnswer("42 hamsters!"), "42 hamsters!");
  assert.equal(cleanAnswer(" ... "), null);
  assert.equal(cleanAnswer(7), null);
  assert.equal([...cleanAnswer("x".repeat(200))!].length, 80);
});

test("suggested questions and titles", () => {
  assert.equal(cleanQuestion("who would most likely eat cake for breakfast"), "Who would most likely eat cake for breakfast?");
  assert.equal(cleanQuestion("wer würde am ehesten tanzen."), "Wer würde am ehesten tanzen?");
  assert.equal(cleanQuestion("Why?"), null);
  assert.equal(cleanQuestion("x".repeat(130)), null);
  assert.equal(cleanTitle(" cake  boss! "), "Cake boss");
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle("x".repeat(29)), null);
});

test("podiums: three places, two with three candidates; checked", () => {
  assert.equal(podiumSize(3), 2);
  assert.equal(podiumSize(4), 3);
  assert.equal(podiumSize(13), 3);
  assert.equal(podiumSize(2), 1);
  const c = new Set(["a", "b", "c", "d"]);
  assert.deepEqual(readPodium({ podium: ["b", "a", "d"] }, c, 3), ["b", "a", "d"]);
  assert.deepEqual(readPodium(["c"], c, 3), ["c"]);
  assert.throws(() => readPodium(["a", "a"], c, 3), /Once each/);
  assert.throws(() => readPodium(["a", "b", "c", "d"], c, 3), /one to 3/);
  assert.throws(() => readPodium(["z"], c, 3), /Not a candidate/);
  assert.throws(() => readPodium([], c, 3));
});

test("the tally: 3/2/1, golds break ties, a shared title, the room's top three", () => {
  const cands = ["a", "b", "c", "d", "x"];
  const t = tally(
    [
      ["a", "b", "c"],
      ["b", "a", "d"],
      ["a", "c", "b"],
      ["b", "a", "x"],
    ],
    cands,
  );
  assert.deepEqual(Object.fromEntries(t.points), { a: 10, b: 9, c: 3, d: 1, x: 1 });
  assert.deepEqual(t.winners, ["a"]);
  assert.deepEqual(t.order, ["a", "b", "c", "d", "x"]);
  assert.deepEqual(t.top, ["a", "b", "c"]);
  // Points and golds tied: shared.
  const tie = tally(
    [
      ["a", "b"],
      ["b", "a"],
    ],
    ["a", "b", "c"],
  );
  assert.deepEqual(tie.winners, ["a", "b"]);
  // Points tied, golds not.
  const g = tally(
    [
      ["a", "c", "b"],
      ["c", "b", "a"],
      ["b", "a", "c"],
    ],
    ["a", "b", "c"],
  );
  assert.deepEqual(g.winners, ["a", "b", "c"]);
  const g2 = tally([["a"], ["b", "c"], ["c"]], ["a", "b", "c"]);
  assert.deepEqual(Object.fromEntries(g2.points), { a: 3, b: 3, c: 5 });
  assert.deepEqual(g2.winners, ["c"]);
  // Tied with the third: in the top too.
  const wide = tally([["a", "b", "c"], ["a", "b", "d"]], ["a", "b", "c", "d"]);
  assert.deepEqual(wide.top, ["a", "b", "c", "d"]);
  // No ballots: no winner.
  assert.deepEqual(tally([], ["a", "b"]).winners, []);
});

test("reading the room: names in the top three, a gold on the winner, self-aware", () => {
  const ballots = new Map([
    ["a", ["a", "b", "c"]],
    ["b", ["b", "a", "d"]],
    ["c", ["a", "c", "b"]],
    ["d", ["d", "x", "c"]],
  ]);
  const t = tally(ballots.values(), ["a", "b", "c", "d", "x"]);
  assert.deepEqual(t.winners, ["a"]);
  const e = scoreVote(ballots, t);
  // a 8, b 6, c 4, d 4 (tied with the third on points: in the top), x 2.
  assert.deepEqual(t.top, ["a", "b", "d", "c"]);
  assert.deepEqual(e.get("a"), { room: 3, gold: 1, self: 1 });
  assert.deepEqual(e.get("b"), { room: 3, gold: 0, self: 0 });
  assert.deepEqual(e.get("c"), { room: 3, gold: 1, self: 0 });
  assert.deepEqual(e.get("d"), { room: 2, gold: 0, self: 0 });
});

test("answers each: two with three players", () => {
  assert.equal(answersEach(3), 2);
  assert.equal(answersEach(4), 1);
});

test("cards: shuffled, numbered, nobody's two side by side where it can be helped", () => {
  const cards = makeCards(
    new Map([
      ["a", ["a1", "a2"]],
      ["b", ["b1", "b2"]],
      ["c", ["c1", "c2"]],
    ]),
    seeded(4),
  );
  assert.deepEqual(
    cards.map((c) => c.id),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(cards.map((c) => c.text).sort(), ["a1", "a2", "b1", "b2", "c1", "c2"]);
  for (let i = 1; i < cards.length; i++) assert.notEqual(cards[i]!.author, cards[i - 1]!.author);
});

const CARDS: Card[] = [
  { id: 0, author: "a", text: "A's" },
  { id: 1, author: "b", text: "B's" },
  { id: 2, author: "c", text: "C's" },
  { id: 3, author: "d", text: "D's" },
];

test("matching: others' cards, others' names, each name once (or as often as allowed)", () => {
  assert.deepEqual(readMatch({ guesses: { 1: "c", 2: "b" }, heart: 3 }, CARDS, "a", 1), { guesses: new Map([[1, "c"], [2, "b"]]), heart: 3 });
  assert.throws(() => readMatch({ guesses: { 0: "b" } }, CARDS, "a", 1), /Not a card to guess/);
  assert.throws(() => readMatch({ guesses: { 1: "a" } }, CARDS, "a", 1), /Not one of the writers/);
  assert.throws(() => readMatch({ guesses: { 1: "c", 2: "c" } }, CARDS, "a", 1), /Each name once/);
  assert.doesNotThrow(() => readMatch({ guesses: { 1: "c", 2: "c" } }, CARDS, "a", 2));
  assert.throws(() => readMatch({ guesses: {}, heart: 0 }, CARDS, "a", 1), /Not a card to like/);
  assert.throws(() => readMatch({ guesses: { 9: "b" } }, CARDS, "a", 1));
  // Someone who wrote nothing guesses every card.
  assert.equal(readMatch({ guesses: { 0: "a", 1: "b" } }, CARDS, "z", 1).guesses.size, 2);
});

test("every guess is one point: to the guesser when right, to the writer when wrong; busted when most were right", () => {
  const m = (g: Record<number, string>, heart: number | null = null) => ({ guesses: new Map(Object.entries(g).map(([k, v]) => [Number(k), v])), heart });
  const { earned, results } = scoreMatch(
    CARDS,
    new Map([
      ["a", m({ 1: "b", 2: "d", 3: "c" }, 1)],
      ["b", m({ 0: "a", 2: "c", 3: "d" }, 2)],
      ["c", m({ 0: "d", 1: "b" }, 1)],
      ["d", m({})],
    ]),
  );
  assert.deepEqual(Object.fromEntries(earned), {
    a: { guess: 1, fool: 1 },
    b: { guess: 3, fool: 0 },
    c: { guess: 1, fool: 1 },
    d: { guess: 0, fool: 1 },
  });
  assert.deepEqual(
    results.map((r) => [r.card.id, r.right, r.wrong, r.hearts, r.busted]),
    [
      [0, 1, 1, 0, false],
      [1, 2, 0, 2, true],
      [2, 1, 1, 1, false],
      [3, 1, 1, 0, false],
    ],
  );
});

test("ratings: approved with more 👍 once half rated; dropped when it can no longer get there", () => {
  assert.equal(ratingState(0, 0, 4), "pending");
  assert.equal(ratingState(1, 0, 4), "pending");
  assert.equal(ratingState(2, 0, 4), "approved");
  assert.equal(ratingState(2, 1, 4), "approved");
  assert.equal(ratingState(1, 1, 4), "pending");
  assert.equal(ratingState(0, 1, 4), "pending");
  assert.equal(ratingState(0, 2, 4), "dropped");
  assert.equal(ratingState(0, 3, 4), "dropped");
  assert.equal(ratingState(1, 3, 4), "dropped");
  // Three players: two others, one 👍 is half.
  assert.equal(ratingState(1, 0, 2), "approved");
  assert.equal(ratingState(0, 1, 2), "dropped");
  assert.equal(ratingState(0, 1, 5), "pending");
  assert.equal(ratingState(0, 2, 2), "dropped");
  assert.equal(ratingState(0, 0, 0), "pending");
});

test("the suggestion a round plays: the best liked of its kind, never the same author twice in a row", () => {
  const s = (id: string, author: string, kind: "vote" | "answer", ups: number, downs: number, seq: number, state: "approved" | "pending" = "approved") => ({ id, author, kind, ups, downs, seq, state });
  const list = [s("1", "a", "vote", 2, 0, 1), s("2", "b", "vote", 3, 0, 2), s("3", "c", "vote", 3, 0, 3), s("4", "d", "answer", 5, 0, 4), s("5", "e", "vote", 9, 0, 5, "pending")];
  assert.equal(pickSuggestion(list, "vote", null)?.id, "2");
  assert.equal(pickSuggestion(list, "vote", "b")?.id, "3");
  assert.equal(pickSuggestion(list, "answer", null)?.id, "4");
  assert.equal(pickSuggestion(list, "answer", "d"), undefined);
});

test("portraits: whole numbers on the grid, within the limits", () => {
  assert.deepEqual(readPortrait({ strokes: [[1.4, 2.6, 150, -3]] }), [[1, 3, FACE, 0]]);
  assert.deepEqual(readPortrait([]), []);
  assert.equal(readPortrait([[1, 2, 3]]), null);
  assert.equal(readPortrait([["a", 1]]), null);
  assert.equal(readPortrait({ strokes: [Array.from({ length: (MAX_POINTS + 1) * 2 }, () => 5)] }), null);
  assert.equal(pathOf([10, 10]), "M10 10l0.01 0");
  assert.equal(pathOf([0, 0, 10, 0]), "M0 0L10 0");
  assert.equal(pathOf([0, 0, 10, 0, 10, 10]), "M0 0Q10 0 10 5L10 10");
  assert.deepEqual(thin([0, 0, 0.5, 0, 1, 0, 3, 0, 3.2, 0]), [0, 0, 3, 0, 3.2, 0]);
});

test("doodles: the same name, the same face; a portrait's size", () => {
  const a = doodle("Anna");
  assert.deepEqual(a, doodle("anna"));
  assert.notDeepEqual(a, doodle("Ben"));
  for (const name of ["Anna", "Ben", "Cleo", "Dmitri", "Eve", "Fritz", "Gül", "Hiro"]) {
    const d = doodle(name);
    assert.ok(readPortrait(d), name);
    assert.ok(d.length >= 5, name);
    for (const s of d) for (const v of s) assert.ok(v >= 0 && v <= FACE && Number.isInteger(v));
  }
});
