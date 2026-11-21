/** TV sync by matching flashes: the pattern and the TV's own lag. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CYCLE_MS, displayLag, FLASH_MS, flashAt, INTERVALS, MAX_LAG_MS } from "../src/flashsync.ts";

/** The flash times of one cycle, ms from its start. */
const starts = INTERVALS.map((_, i) => INTERVALS.slice(0, i).reduce((a, b) => a + b, 0));

test("the pattern: numbered flashes at uneven intervals, the same every cycle", () => {
  assert.equal(CYCLE_MS, 5600);
  const base = 250_000 * CYCLE_MS;
  assert.deepEqual(flashAt(base), { n: 1, phase: 0, lit: true });
  assert.deepEqual(flashAt(base + FLASH_MS - 1), { n: 1, phase: FLASH_MS - 1, lit: true });
  assert.deepEqual(flashAt(base + FLASH_MS), { n: 1, phase: FLASH_MS, lit: false });
  assert.deepEqual(flashAt(base + 700), { n: 2, phase: 0, lit: true });
  assert.deepEqual(flashAt(base + 1199), { n: 2, phase: 499, lit: false });
  assert.deepEqual(flashAt(base + 1200), { n: 3, phase: 0, lit: true });
  assert.deepEqual(flashAt(base + CYCLE_MS - 1), { n: INTERVALS.length, phase: 1099, lit: false });
  assert.deepEqual(flashAt(base + CYCLE_MS), { n: 1, phase: 0, lit: true });
  // Before the epoch too (a clock that is way off).
  assert.deepEqual(flashAt(-CYCLE_MS + 700), { n: 2, phase: 0, lit: true });
});

test("the pattern lines up with itself only at whole cycles", () => {
  // An even beat flashes "together" with a copy one beat late; this
  // pattern, shifted by anything up to the largest lag, never does.
  const flashes = new Set(starts);
  for (let shift = 10; shift <= MAX_LAG_MS; shift += 10) {
    const together = starts.filter((t) => flashes.has((t + shift) % CYCLE_MS)).length;
    assert.ok(together <= 1, `shift ${shift}: ${together} flashes together`);
  }
});

test("the TV's lag: what it adds beyond its playout delay", () => {
  assert.equal(displayLag(412, 300), 112);
  // A TV quicker than its playout delay says: never below 0.
  assert.equal(displayLag(280, 300), 0);
  assert.equal(displayLag(5000, 300), MAX_LAG_MS);
  assert.equal(displayLag(412.4, 300), 112);
});
