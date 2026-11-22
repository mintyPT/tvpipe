/**
 * Prints a generated estate as text (the legend: `ascii` in game/map.ts)
 * with how long it took, for debugging the generator.
 *
 *   node scripts/map.ts [players=5] [seed=1] [--secrets] [--stats N]
 *
 * `--secrets` marks the getaway car (G) and the loot places ($);
 * `--stats N` generates N seeds per player count and prints tries and times.
 */

import { ascii, generate, mapSize, MAX_ATTEMPTS, tryEstate } from "../game/map.ts";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const nums = args.filter((a) => /^\d+$/.test(a)).map(Number);
const statsAt = args.indexOf("--stats");

if (statsAt >= 0) {
  const n = Number(args[statsAt + 1] ?? 50);
  for (let p = 3; p <= 8; p++) {
    let tries = 0;
    let worst = 0;
    const fails = new Map<string, number>();
    const t0 = performance.now();
    for (let seed = 0; seed < n; seed++) {
      const s0 = performance.now();
      for (let a = 0; ; a++) {
        if (a >= MAX_ATTEMPTS) {
          fails.set("NO ESTATE AT ALL", (fails.get("NO ESTATE AT ALL") ?? 0) + 1);
          break;
        }
        const r = tryEstate(p, seed, a);
        tries++;
        if (typeof r !== "string") break;
        fails.set(r, (fails.get(r) ?? 0) + 1);
      }
      worst = Math.max(worst, performance.now() - s0);
    }
    const ms = (performance.now() - t0) / n;
    const { w, h } = mapSize(p);
    console.log(`${p} players ${w}×${h}: ${(tries / n).toFixed(2)} tries, ${ms.toFixed(1)} ms a map (worst ${worst.toFixed(1)} ms)`);
    for (const [why, k] of [...fails].sort((a, b) => b[1] - a[1])) console.log(`    ${k}× ${why}`);
  }
} else {
  const players = nums[0] ?? 5;
  const seed = nums[1] ?? 1;
  const t0 = performance.now();
  const e = generate(players, seed);
  const ms = performance.now() - t0;
  console.log(ascii(e.map, flag("--secrets") ? { car: e.car, places: e.places } : undefined));
  const m = e.map;
  console.log(
    `${players} players, seed ${seed}: ${m.w}×${m.h}, try ${e.attempt + 1}, ${ms.toFixed(1)} ms; ` +
      `${m.rooms.length} rooms, ${m.areas.length} areas, ${m.doors.length} doors, ${m.windows.length} windows, ` +
      `${m.lamps.length} lamps, ${m.cameras.length} cameras, ${m.spots.length} spots, ${e.places.length} loot places`,
  );
}
