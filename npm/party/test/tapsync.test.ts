/** TV sync by tapping along: offsets, runs, the TV's lag. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BEAT_MS, beatOf, displayLag, median, SKIP_TAPS, TAPS, tapOffset, tapRun } from "../src/tapsync.ts";

/** Taps `lag` ms after beats (from beat 1000 on), with a little jitter and a few early ones to skip. */
function taps(lag: number, jitter: readonly number[] = [0]): number[] {
  const out: number[] = [];
  for (let i = 0; i < SKIP_TAPS + TAPS; i++) {
    const t = (1000 + i) * BEAT_MS + lag + jitter[i % jitter.length]!;
    out.push(i < SKIP_TAPS ? t + 300 : t);
  }
  return out;
}

test("a tap answers the beat nearest to where it is expected", () => {
  const beat = 2000 * BEAT_MS;
  assert.equal(tapOffset(beat + 30, 0), 30);
  assert.equal(tapOffset(beat - 40, 0), -40);
  // A TV about 450 ms behind: a tap 500 ms after a beat is late, not early.
  assert.equal(tapOffset(beat + 500, 450), 500);
  assert.equal(tapOffset(beat + 500, 0), 500 - BEAT_MS);
  assert.equal(tapOffset(beat + BEAT_MS + 100, 450), 100 + BEAT_MS - BEAT_MS);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test("runs: the first taps are skipped, uneven ones are refused", () => {
  const here = tapRun(taps(-25, [0, 10, -10, 5, -5]), 0);
  assert.equal(here.taps, TAPS);
  assert.equal(here.offset, -25);
  assert.ok(here.ok && here.spread <= 10, `${here.spread}`);
  const short = tapRun(taps(0).slice(0, SKIP_TAPS + TAPS - 1), 0);
  assert.equal(short.ok, false, "too few taps");
  const wild = tapRun(taps(0, [0, 200, -150, 90, -220, 160]), 0);
  assert.equal(wild.ok, false, "too uneven");
});

test("the TV's lag: what it adds beyond its playout delay", () => {
  const here = tapRun(taps(-25), 0);
  // The TV's flashes come 412 ms after this screen's: 300 ms of playout, 112 of the TV.
  const tv = tapRun(taps(-25 + 412, [0, 8, -8]), 300 + 150);
  assert.ok(tv.ok);
  assert.deepEqual(displayLag(here, tv, 300), { total: 412, displayMs: 112 });
  // A TV quicker than its playout delay says (never below 0).
  assert.deepEqual(displayLag(here, tapRun(taps(-25 + 280), 450), 300), { total: 280, displayMs: 0 });
});

test("beats: an accent every bar", () => {
  assert.deepEqual(beatOf(4 * BEAT_MS + 10), { index: 4, phase: 10, accent: true });
  assert.equal(beatOf(5 * BEAT_MS).accent, false);
});
