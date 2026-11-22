import assert from "node:assert/strict";
import { test } from "node:test";

import { armiesFor, throwOutcomes, winChance } from "../game/odds.ts";
import { fight, seeded } from "../game/rules.ts";

const close = (a: number, b: number, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const outcome = (a: number, d: number, la: number, ld: number) => throwOutcomes(a, d).find(([x, y]) => x === la && y === ld)?.[2] ?? 0;

test("one throw: the known chances", () => {
  close(outcome(1, 1, 0, 1), 15 / 36);
  close(outcome(2, 1, 0, 1), 125 / 216);
  close(outcome(3, 1, 0, 1), 855 / 1296);
  close(outcome(1, 2, 0, 1), 55 / 216);
  close(outcome(2, 2, 0, 2), 295 / 1296);
  close(outcome(2, 2, 1, 1), 420 / 1296);
  close(outcome(3, 2, 0, 2), 2890 / 7776);
  close(outcome(3, 2, 1, 1), 2611 / 7776);
  close(outcome(3, 2, 2, 0), 2275 / 7776);
  for (const [a, d] of [[1, 1], [2, 2], [3, 2]] as const) close(throwOutcomes(a, d).reduce((s, [, , p]) => s + p, 0), 1);
});

test("a fight to the end: known answers", () => {
  assert.equal(winChance(0, 3), 0);
  assert.equal(winChance(3, 0), 1);
  close(winChance(1, 1), 15 / 36);
  // Two against one: win the first throw, or lose one and win one against one.
  close(winChance(2, 1), 125 / 216 + (91 / 216) * (15 / 36));
  // One against two: the defender throws two dice, then one.
  close(winChance(1, 2), (55 / 216) * (15 / 36));
  assert.ok(winChance(10, 3) > winChance(5, 3));
  assert.ok(winChance(5, 3) > winChance(5, 5));
});

test("the odds agree with fights thrown", () => {
  const rng = seeded(7);
  for (const [a, d] of [[3, 2], [5, 4], [8, 3]] as const) {
    let wins = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) if (fight(a, d, rng).def === 0) wins++;
    assert.ok(Math.abs(wins / N - winChance(a, d)) < 0.015, `${a} vs ${d}: ${wins / N} vs ${winChance(a, d)}`);
  }
});

test("armiesFor: the fewest that do it", () => {
  const n = armiesFor(3, 0.8, 50);
  assert.ok(n > 0 && winChance(n, 3) >= 0.8 && winChance(n - 1, 3) < 0.8);
  assert.equal(armiesFor(10, 0.8, 3), 0);
});
