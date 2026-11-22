import assert from "node:assert/strict";
import { test } from "node:test";

import { generate } from "../game/map.ts";
import { decodeTrack } from "../game/protocol.ts";
import { Rng } from "../game/rng.ts";
import { Heist } from "../game/sim.ts";
import { fuzz, IDS, play, secrecy, walkable } from "./sim-play.ts";

for (const [players, seed] of [[3, 1], [5, 2], [8, 3], [4, 7]] as const) {
  test(`secrecy over a whole heist: ${players} players, seed ${seed}`, () => {
    const e = generate(players, seed);
    const s = secrecy(e);
    const h = play(e, players, seed * 77 + 1, 120, (h, pub, frames) => s.check(h, pub, frames));
    assert.equal(h.faults, 0);
    console.log(`# ${players} players: ${h.result?.outcome ?? "running"} at ${h.t.toFixed(1)} s, ${s.frames} frames, ticker ${[...new Set(h.ticker.map((x) => x.k))].join(" ")}`);
    assert.ok(s.frames > 100);
    const tape = h.tape();
    for (const t of tape.tracks) {
      const d = decodeTrack(t)!;
      assert.equal(d.length, tape.samples);
    }
    assert.ok(JSON.stringify(tape).length < 120_000, `tape ${JSON.stringify(tape).length} bytes`);
  });
}

test("unknown players and junk never throw", () => {
  const e = generate(3, 5);
  const h = new Heist(e, { thief: "T", guards: ["A", "B"] });
  const rng = new Rng(9);
  for (let k = 0; k < 5000; k++) {
    const who = rng.pick(["T", "A", "B", "nobody", "", "__proto__"])!;
    assert.doesNotThrow(() => h.act(who, fuzz(rng)));
    if (k % 10 === 0) h.step(rng.pick([0.05, NaN, -1, 1e9, 0])!);
    if (k % 50 === 0) assert.doesNotThrow(() => h.frames());
  }
  assert.equal(h.frame("nobody"), null);
  assert.equal(h.faults, 0);
  assert.equal(h.act("A", { a: "go", x: 1e300, y: 0 }), "invalid");
  assert.equal(h.act("A", "go"), "invalid");
  assert.equal(h.act("nobody", { a: "stop" }), "invalid");
});

test("deterministic: the same inputs give the same heist", () => {
  const e = generate(5, 4);
  const run = () => JSON.stringify(play(e, 5, 99, 60, () => undefined, 0.05).tape());
  assert.equal(run(), run());
});

test("performance: a step with 8 players, and all frames, in a few ms", () => {
  const e = generate(8, 6);
  const h = new Heist(e, { thief: "T", guards: IDS.slice(1) });
  for (const g of IDS.slice(1)) h.flashlight(g, true);
  const floor = walkable(e);
  const rng = new Rng(3);
  let stepMs = 0;
  let frameMs = 0;
  let n = 0;
  for (let k = 0; k < 800 && !h.over; k++) {
    if (k % 40 === 0) for (const id of IDS) {
      const i = rng.pick(floor)!;
      h.go(id, (i % e.map.w) + 0.5, Math.floor(i / e.map.w) + 0.5);
    }
    const a = performance.now();
    h.step();
    const b = performance.now();
    h.frames();
    const c = performance.now();
    stepMs += b - a;
    frameMs += c - b;
    n++;
  }
  const perStep = stepMs / n;
  const perFrames = frameMs / n;
  console.log(`# 8 players: step ${perStep.toFixed(2)} ms, 8 frames + public ${perFrames.toFixed(2)} ms`);
  assert.ok(perStep + perFrames < 6, `${perStep} + ${perFrames} ms`);
});
