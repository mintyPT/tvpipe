import assert from "node:assert/strict";
import { test } from "node:test";

import { generate } from "../game/map.ts";
import { play, secrecy } from "./sim-play.ts";

for (const [players, seed] of [[3, 21], [6, 22], [8, 23]] as const) {
  test(`secrecy over a whole heist where nobody chases (loot, alarms, pings): ${players} players, seed ${seed}`, () => {
    const e = generate(players, seed);
    const s = secrecy(e);
    const h = play(e, players, seed, 210, (h, pub, frames) => s.check(h, pub, frames), 0, 0);
    console.log(`# ${players} players: ${h.result?.outcome ?? "running"} at ${h.t.toFixed(1)} s, ${s.frames} frames, ticker ${[...new Set(h.ticker.map((x) => x.k))].join(" ")}, took ${h.peek("T")!.slots.join(",")}`);
    assert.equal(h.faults, 0);
    assert.ok(h.peek("T")!.slots.length > 0, "the thief took something");
  });
}

