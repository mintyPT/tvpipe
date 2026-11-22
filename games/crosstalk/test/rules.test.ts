import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  afterCard,
  balance,
  BOARD,
  boardColors,
  candidates,
  categorySizes,
  checkClue,
  cleanNote,
  dealBoard,
  majority,
  matcher,
  nextSpymaster,
  outcome,
  PAD,
  related,
  resultOf,
  seeded,
  smallerTeam,
  tangled,
  TANGLE,
  type Card,
  type Choice,
  type Lang,
  type Team,
  type WordEntry,
} from "../game/rules.ts";

const DATA = (f: string) => readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8");
const LISTS = Object.fromEntries(
  (["en", "de"] as const).map((l) => {
    const m = matcher(l);
    return [l, { m, words: m.parseWordList(DATA(m.files.words)), opt: m.dictionary(DATA(m.files.dict)) }];
  }),
) as Record<Lang, { m: ReturnType<typeof matcher>; words: WordEntry[]; opt: ReturnType<ReturnType<typeof matcher>["dictionary"]> }>;

const entry = (word: string, category = "x", difficulty = "easy"): WordEntry => ({ word, difficulty, category, alsoRight: [], banned: [], english: [] });
const card = (word: string, color: Card["color"] = "neutral"): Card => ({ word, color, category: "", banned: [], alsoRight: [], english: [] });

test("colours: 8 red, 8 blue, 8 neutral, 1 assassin", () => {
  const c = boardColors();
  assert.equal(c.length, BOARD.size);
  for (const [color, n] of [["red", 8], ["blue", 8], ["neutral", 8], ["assassin", 1]] as const) assert.equal(c.filter((x) => x === color).length, n, color);
});

test("categorySizes: six categories of three to six make 25", () => {
  for (let seed = 1; seed < 200; seed++) {
    const s = categorySizes(TANGLE.categories, BOARD.size, seeded(seed));
    assert.equal(s.length, 6);
    assert.equal(
      s.reduce((a, b) => a + b, 0),
      25,
    );
    assert.ok(s.every((n) => n >= 3 && n <= 6), s.join(","));
  }
  assert.throws(() => categorySizes(3, 25, seeded(1)));
});

test("tangled: big categories have two colours, the assassin's has red and blue", () => {
  const c = (category: string, color: Card["color"]) => ({ category, color });
  assert.equal(tangled([c("a", "red"), c("a", "red"), c("a", "red"), c("a", "red")]), false, "four red animals");
  assert.equal(tangled([c("a", "red"), c("a", "red"), c("a", "red")]), true, "three of one colour are fine");
  assert.equal(tangled([c("a", "red"), c("a", "red"), c("a", "blue"), c("a", "red")]), true);
  assert.equal(tangled([c("a", "assassin"), c("a", "red"), c("a", "neutral")]), false, "the assassin with no blue");
  assert.equal(tangled([c("a", "assassin"), c("a", "red"), c("a", "blue")]), true);
});

test("candidates: by difficulty, the room's used words last", () => {
  const words = [entry("a", "x", "easy"), entry("b", "x", "hard"), entry("c", "x", "easy"), entry("d", "x", "medium")];
  const easy = candidates(words, "easy", seeded(3));
  assert.deepEqual(easy.slice(0, 2).map((w) => w.word).sort(), ["a", "c"], "easy words first");
  const used = candidates(words, "easy", seeded(3), new Set(["a"]));
  assert.equal(used[0]!.word, "c", "an unused word before a used one");
});

test("related: a word and its forms never share a board", () => {
  const { m, opt } = LISTS.en;
  assert.equal(related(entry("fire"), entry("firework"), m, opt), true, "contains");
  assert.equal(related(entry("cat"), entry("cats"), m, opt), true, "plural");
  assert.equal(related(entry("cat"), entry("dog"), m, opt), false);
  assert.equal(related(entry("bear"), entry("beer"), m, opt), false, "two dictionary words are no typo");
});

test("dealBoard: 25 different words, the colours, tangled, no two related", () => {
  for (const lang of ["en", "de"] as const) {
    const { m, words, opt } = LISTS[lang];
    for (let seed = 1; seed <= 12; seed++) {
      const b = dealBoard(words, { matcher: m, opt, rng: seeded(seed) });
      assert.equal(b.length, 25);
      assert.equal(new Set(b.map((c) => c.word)).size, 25, "no word twice");
      assert.deepEqual(
        b.map((c) => c.color).sort(),
        boardColors().sort(),
      );
      assert.ok(tangled(b), `${lang} ${seed}: tangled`);
      const cats = new Set(b.map((c) => c.category));
      assert.equal(cats.size, TANGLE.categories, `${lang} ${seed}: six categories`);
      for (let i = 0; i < b.length; i++)
        for (let j = i + 1; j < b.length; j++) {
          const a = words.find((w) => w.word === b[i]!.word)!;
          const z = words.find((w) => w.word === b[j]!.word)!;
          assert.equal(related(a, z, m, opt), false, `${a.word} / ${z.word}`);
        }
    }
  }
});

test("dealBoard: mixed takes any words; used words come last", () => {
  const { m, words, opt } = LISTS.en;
  const b = dealBoard(words, { matcher: m, opt, rng: seeded(5), mode: "mixed", difficulty: "easy" });
  assert.equal(b.length, 25);
  assert.ok(b.every((c) => words.find((w) => w.word === c.word)!.difficulty === "easy"), "easy words only");
  const used = new Set(b.map((c) => c.word));
  const next = dealBoard(words, { matcher: m, opt, rng: seeded(5), mode: "mixed", difficulty: "easy", used });
  assert.ok(next.every((c) => !used.has(c.word)), "none of the last board while there are others");
});

test("checkClue: one word, a number, nothing too close to a face-down card", () => {
  const { m, opt } = LISTS.en;
  const board = [card("planet", "red"), card("fire", "blue"), card("night", "neutral"), card("snowman", "assassin")];
  const all = board.map(() => true);
  const no = (raw: string, n = 2, hidden = all) => checkClue(raw, n, board, hidden, m, opt);
  assert.ok(no("ocean").ok);
  assert.deepEqual(
    (({ ok, number }) => ({ ok, number }))(no("ocean", 3) as { ok: boolean; number: number }),
    { ok: true, number: 3 },
  );
  for (const [raw, word, reason] of [
    ["planets", "planet", "plural"],
    ["Planet", "planet", "same word"],
    ["fireworks", "fire", "contains the word"],
    ["midnight", "night", "contains the word"],
    ["snow", "snowman", "part of the word"],
    ["knight", "night", "sounds the same"],
  ] as const) {
    const r = no(raw);
    assert.equal(r.ok, false, raw);
    if (r.ok || r.code !== "too-close") throw new Error(`${raw}: ${JSON.stringify(r)}`);
    assert.equal(board[r.card]!.word, word, raw);
    assert.equal(r.reason, reason, raw);
  }
  assert.ok(no("midnight", 2, [true, true, false, true]).ok, "a card turned no longer counts");
  assert.equal((no("ice cream cone") as { code: string }).code, "too-many-words");
  assert.ok(no("ice cream").ok, "two words are joined");
  assert.equal((no("") as { code: string }).code, "empty");
  assert.equal((no("\u{1F525}") as { code: string }).code, "empty", "no emoji: a picture of fire is no clue");
  assert.deepEqual((no("ocean \u{1F30A}") as { clue: { display: string } }).clue.display, "ocean");
  for (const n of [0, 10, 1.5, "2", null]) assert.equal((checkClue("ocean", n, board, all, m, opt) as { code: string }).code, "bad-number", String(n));
});

test("checkClue in German: forms, compounds and translations", () => {
  const { m, opt, words } = LISTS.de;
  const hund = words.find((w) => w.word === "Hund")!;
  const board = [{ ...card("Hund", "red"), banned: hund.banned, english: hund.english }, card("Schiff", "blue")];
  const all = board.map(() => true);
  for (const raw of ["Hunde", "Segelschiff", "dog", "dogs"]) assert.equal(checkClue(raw, 1, board, all, m, opt).ok, false, raw);
  assert.ok(checkClue("Katze", 1, board, all, m, opt).ok);
});

test("resultOf and afterCard: a round goes on while the cards are right and allowed", () => {
  assert.equal(resultOf("red", "red"), "right");
  assert.equal(resultOf("red", "blue"), "theirs");
  assert.equal(resultOf("blue", "neutral"), "neutral");
  assert.equal(resultOf("blue", "assassin"), "assassin");
  assert.equal(afterCard("right", 1, 2), null);
  assert.equal(afterCard("right", 2, 2), null, "the extra card");
  assert.equal(afterCard("right", 3, 2), "used");
  assert.equal(afterCard("neutral", 1, 3), "neutral");
  assert.equal(afterCard("theirs", 1, 3), "theirs");
  assert.equal(afterCard("assassin", 1, 3), "assassin");
});

test("majority: more than half of the operatives who are there", () => {
  const pins = (...xs: [string, Choice][]) => new Map<string, Choice>(xs);
  assert.equal(majority(pins(["a", 3]), ["a"]), 3, "one operative");
  assert.equal(majority(pins(["a", 3], ["b", 4]), ["a", "b"]), null, "a tie");
  assert.equal(majority(pins(["a", 3], ["b", 3]), ["a", "b", "c"]), 3, "two of three");
  assert.equal(majority(pins(["a", 3], ["b", 3], ["c", 4], ["d", 4]), ["a", "b", "c", "d"]), null, "two of four is not more than half");
  assert.equal(majority(pins(["a", "pass"], ["b", "pass"]), ["a", "b", "c"]), "pass");
  assert.equal(majority(pins(["a", 3], ["x", 3]), ["a", "b", "c"]), null, "pins of the away do not count");
  assert.equal(majority(pins(), []), null, "nobody there");
});

test("outcome: all cards, the assassin, the same step, fewer mistakes", () => {
  const f = (red: number, blue: number) => ({ red, blue });
  assert.deepEqual(outcome(f(7, 8), f(0, 0), []), { winner: "blue", reason: "found" });
  assert.deepEqual(outcome(f(8, 5), f(3, 0), []), { winner: "red", reason: "found" });
  assert.deepEqual(outcome(f(3, 5), f(0, 0), []), null);
  assert.deepEqual(outcome(f(3, 5), f(0, 0), ["red"]), { winner: "blue", reason: "assassin" });
  assert.deepEqual(outcome(f(3, 8), f(0, 0), ["blue"]), { winner: "red", reason: "assassin" }, "the assassin before the last card");
  assert.deepEqual(outcome(f(3, 5), f(0, 0), ["red", "blue"]), { winner: null, reason: "draw" });
  assert.deepEqual(outcome(f(8, 8), f(2, 1), []), { winner: "blue", reason: "fewer-mistakes" });
  assert.deepEqual(outcome(f(8, 8), f(1, 1), []), { winner: null, reason: "draw" });
});

test("teams: the smaller one, balanced at the start, the next spymaster", () => {
  assert.equal(smallerTeam({ red: 2, blue: 3 }, seeded(1)), "red");
  assert.equal(smallerTeam({ red: 3, blue: 1 }, seeded(1)), "blue");
  const teams = new Map<string, Team>([
    ["a", "red"],
    ["b", "red"],
    ["c", "red"],
    ["d", "red"],
    ["e", "blue"],
  ]);
  assert.deepEqual(balance(teams, ["a", "b", "c", "d", "e"]), ["d"], "the last to come of the bigger team moves");
  assert.equal(teams.get("d"), "blue");
  const two = new Map<string, Team>([
    ["a", "red"],
    ["b", "red"],
  ]);
  assert.deepEqual(balance(two, ["a", "b"]), [], "two cannot make two teams");
  assert.equal(nextSpymaster(["a", "b", "c"], "a"), "b");
  assert.equal(nextSpymaster(["a", "b", "c"], "c"), "a");
  assert.equal(nextSpymaster(["a", "b", "c"], "x"), "a", "the last one left");
  assert.equal(nextSpymaster(["a", "b"], null), "a");
  assert.equal(nextSpymaster([], "a"), null);
});

test("cleanNote: one line, at most 80 characters", () => {
  assert.equal(cleanNote("  they   said\nsky?  "), "they said sky?");
  assert.equal([...cleanNote("x".repeat(200))].length, PAD.chars);
  assert.equal(cleanNote(42), "");
});
