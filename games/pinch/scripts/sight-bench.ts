/**
 * Timings of game/sight.ts: a tick of the heist (prepare: opacity and
 * light with every lamp and 7 flashlights, then 8 seen masks and their
 * wire forms), 8 viewers at 20 Hz on real 8-player estates and on a
 * synthetic 86×54 map.
 *
 *   node scripts/sight-bench.ts [ticks]
 */

import { fileURLToPath } from "node:url";

import { generate, parseAscii, TILE, type Blueprint } from "../game/map.ts";
import { GUARD_RADIUS, THIEF_RADIUS, encodeSeen, initialSight, lineOfSight, prepare, seenBy, type Flashlight } from "../game/sight.ts";

/** An 86×54 map: a lawn with trees and lamps around a house of 4×4 rooms (half lit) with doors. */
export function syntheticEstate(): Blueprint {
  const w = 86;
  const h = 54;
  const g: string[][] = [];
  for (let y = 0; y < h; y++) g.push(Array.from({ length: w }, (_, x) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 ? "%" : ",")));
  for (let k = 0; k < 60; k++) {
    const x = 2 + ((k * 37) % (w - 4));
    const y = 2 + ((k * 23) % (h - 4));
    g[y]![x] = k % 7 === 0 ? "*" : "T";
  }
  // the house: x 20..65, y 12..41, rooms 10×6 inside walls
  const x0 = 20;
  const y0 = 12;
  const cols = 4;
  const rows = 4;
  const rw = 10;
  const rh = 6;
  for (let y = y0; y <= y0 + rows * (rh + 1); y++) {
    for (let x = x0; x <= x0 + cols * (rw + 1); x++) {
      const wall = (x - x0) % (rw + 1) === 0 || (y - y0) % (rh + 1) === 0;
      const cx = Math.floor((x - x0) / (rw + 1));
      const cy = Math.floor((y - y0) / (rh + 1));
      g[y]![x] = wall ? "#" : (cx + cy) % 2 ? ":" : ".";
    }
  }
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx <= cols; cx++) {
      g[y0 + cy * (rh + 1) + 3]![x0 + cx * (rw + 1)] = "+";
    }
  }
  for (let cx = 0; cx < cols; cx++) {
    for (let cy = 0; cy <= rows; cy++) g[y0 + cy * (rh + 1)]![x0 + cx * (rw + 1) + 5] = cy === 0 || cy === rows ? "'" : "+";
  }
  return parseAscii(g.map((r) => r.join("")));
}

export interface BenchResult {
  /** Mean ms of one tick: prepare + 8 seen masks + 8 encodings. */
  tickMs: number;
  prepareMs: number;
  seenMs: number;
  encodeMs: number;
  /** Mean ms of one lineOfSight between random floor tiles. */
  losMs: number;
  /** Mean length of an encoded seen mask. */
  wireChars: number;
}

/** Runs `ticks` ticks with walkers moving over the floor, doors half open. */
export function benchmark(map: Blueprint, ticks = 200): BenchResult {
  const floor: number[] = [];
  for (let i = 0; i < map.w * map.h; i++) if (map.tiles[i] === TILE.FLOOR) floor.push(i);
  const st = initialSight(map);
  const doors = st.doors as Uint8Array;
  for (let d = 0; d < doors.length; d++) doors[d] = d % 2;
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const pos = () => {
    const i = floor[Math.floor(rand() * floor.length)] ?? 0;
    return [(i % map.w) + 0.5, Math.floor(i / map.w) + 0.5] as const;
  };
  let tPrep = 0;
  let tSeen = 0;
  let tEnc = 0;
  let chars = 0;
  for (let t = 0; t < ticks; t++) {
    const viewers = Array.from({ length: 8 }, (_, k) => {
      const [x, y] = pos();
      return { x, y, radius: k === 0 ? THIEF_RADIUS : GUARD_RADIUS };
    });
    const flashlights: Flashlight[] = viewers.slice(1).map((v) => ({ x: v.x, y: v.y, facing: rand() * 360, on: true }));
    const a = performance.now();
    const world = prepare(map, { ...st, flashlights });
    const b = performance.now();
    const masks = viewers.map((v) => seenBy(world, v));
    const c = performance.now();
    for (const m of masks) chars += encodeSeen(m).length;
    const d = performance.now();
    tPrep += b - a;
    tSeen += c - b;
    tEnc += d - c;
  }
  const opaque = prepare(map, st).opaque;
  const pairs = Array.from({ length: 2000 }, () => [...pos(), ...pos()] as const);
  const l0 = performance.now();
  for (const [ax, ay, bx, by] of pairs) lineOfSight(map, opaque, ax, ay, bx, by);
  const losMs = (performance.now() - l0) / pairs.length;
  return {
    tickMs: (tPrep + tSeen + tEnc) / ticks,
    prepareMs: tPrep / ticks,
    seenMs: tSeen / ticks,
    encodeMs: tEnc / ticks,
    losMs,
    wireChars: chars / ticks / 8,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ticks = Number(process.argv[2]) || 400;
  const show = (name: string, r: BenchResult) =>
    console.log(
      `${name}: tick ${r.tickMs.toFixed(3)} ms (prepare ${r.prepareMs.toFixed(3)}, 8 seen ${r.seenMs.toFixed(3)}, 8 encode ${r.encodeMs.toFixed(3)}), ` +
        `lineOfSight ${(r.losMs * 1000).toFixed(1)} µs, wire ${r.wireChars.toFixed(0)} chars; ${(r.tickMs * 20 / 10).toFixed(2)}% of a core at 20 Hz`,
    );
  benchmark(syntheticEstate(), 50); // warm up
  show("synthetic 86×54", benchmark(syntheticEstate(), ticks));
  for (const seed of [1, 2, 3]) {
    try {
      const e = generate(8, seed);
      show(`estate 8 players seed ${seed} (${e.map.w}×${e.map.h}, ${e.map.doors.length} doors, ${e.map.lamps.length} lamps)`, benchmark(e.map, ticks));
    } catch (err) {
      console.log(`estate seed ${seed}: ${(err as Error).message}`);
    }
  }
}
