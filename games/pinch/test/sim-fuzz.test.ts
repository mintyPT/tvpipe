import assert from "node:assert/strict";
import { test } from "node:test";

import { generate } from "../game/map.ts";
import { play, secrecy } from "./sim-play.ts";

test("secrecy with fuzzed inputs mixed in, and fuzzed inputs never throw", () => {
  for (const seed of [11, 12, 13, 14, 15, 16]) {
    const e = generate(3 + (seed % 6), seed);
    const s = secrecy(e);
    const h = play(e, 3 + (seed % 6), seed, 40, (h, pub, frames) => s.check(h, pub, frames), 0.2);
    assert.equal(h.faults, 0);
  }
});

