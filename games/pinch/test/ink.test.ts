import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeInk, encodeInk, Ink, INK_DISC, inkMask } from "../game/ink.ts";
import { generate, parseAscii } from "../game/map.ts";
import { CLIMB_TIME, SPEED } from "../game/move.ts";
import { Rng } from "../game/rng.ts";

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

/** Row y as a string: `#` inked, `.` not. */
const row = (ink: Ink, y: number) => {
  let s = "";
  for (let x = 0; x < ink.map.w; x++) s += ink.inked[y * ink.map.w + x] ? "#" : ".";
  return s;
};

//          x: 0123456789012
const CORRIDOR = ["%%%%%%%%%%%%%", "%P__________%", "%%%%%%%%%%%%%"];

test("spreads along a corridor at the thief's speed (known answers)", () => {
  const ink = new Ink(parseAscii(CORRIDOR));
  ink.start(0);
  assert.equal(row(ink, 1), ".#...........");
  assert.equal(ink.count, 1);
  ink.step(1 / SPEED - 1e-9);
  assert.equal(row(ink, 1), ".#...........");
  ink.step(1 / SPEED);
  assert.equal(row(ink, 1), ".##..........");
  ink.step(1);
  assert.equal(row(ink, 1), ".####........", "3.5 tiles in a second: d ≤ 3");
  ink.step(2);
  assert.equal(row(ink, 1), ".########....", "d ≤ 7");
  ink.step(100);
  for (let d = 0; d <= 10; d++) near(ink.at[13 + 1 + d]!, d / SPEED);
  assert.equal(ink.count, 11);
});

test("the timing does not depend on the step length", () => {
  const map = parseAscii(["%%%%%%%%%%%", "%P_______%%", "%________%%", "%___hh___%%", "%________%%", "%%%%%%%%%%%"]);
  const a = new Ink(map);
  const b = new Ink(map);
  a.start(0);
  b.start(0);
  for (let k = 1; k <= 200; k++) a.step(k * 0.05);
  b.step(10);
  assert.deepEqual([...a.at], [...b.at]);
  // a diagonal costs √2
  near(a.at[2 * map.w + 2]!, Math.SQRT2 / SPEED);
  near(a.at[3 * map.w + 3]!, (2 * Math.SQRT2) / SPEED);
  // no cutting the hedge's corner at (4, 3): (3, 3) → (4, 4) is not a move
  near(a.at[4 * map.w + 4]!, (2 + 2 * Math.SQRT2) / SPEED);
  near(a.at[4 * map.w + 5]!, (3 + 2 * Math.SQRT2) / SPEED);
});

test("doors and windows: doors cost nothing extra, windows the climb, locked doors as asked", () => {
  //          x: 0123456789
  const rows = ["##########", "#P__+__'_#", "##########"];
  const ink = new Ink(parseAscii(rows));
  ink.start(0);
  ink.step(100);
  const at = (x: number) => ink.at[10 + x]!;
  near(at(4), 3 / SPEED, 1e-9);
  near(at(6), 5 / SPEED);
  near(at(7), 5 / SPEED + CLIMB_TIME / 2, 1e-9);
  near(at(8), 5 / SPEED + CLIMB_TIME);
  const locked = new Ink(parseAscii(["######", "#P_X_#", "######"]), { locked: 3 });
  locked.start(0);
  locked.step(100);
  near(locked.at[6 + 3]!, 2 / SPEED + 3);
  near(locked.at[6 + 4]!, 3 / SPEED + 3);
  // windows only straight across, never along the wall
  const wall = new Ink(parseAscii(["%%%%%", "%P__%", "%#''%", "%%%%%"]));
  wall.start(0);
  wall.step(100);
  assert.equal(wall.count, 5, "the spot, two tiles and two windows (each from the tile above it)");
});

test("restarts: at a tile, at a point, as a disc", () => {
  const rows = ["%%%%%%%%%%%%%", ...Array.from({ length: 9 }, () => "%P__________%"), "%%%%%%%%%%%%%"];
  const map = parseAscii(rows);
  const ink = new Ink(map);
  ink.start(0);
  ink.step(5);
  assert.ok(ink.count > 50);
  ink.restartAt(6, 7.2, 5.9);
  assert.equal(ink.count, 1);
  assert.equal(ink.inked[5 * map.w + 7], 1);
  ink.step(6 + 1 / SPEED);
  assert.equal(ink.count, 5, "the four orthogonal neighbours");
  ink.step(6 + Math.SQRT2 / SPEED);
  assert.equal(ink.count, 9, "and the diagonal ones");
  // a disc of radius 3 through everything inkable
  ink.restartDisc(10, 6.5, 5.5);
  let want = 0;
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const d = (x + 0.5 - 6.5) ** 2 + (y + 0.5 - 5.5) ** 2;
      if (d <= INK_DISC * INK_DISC && ink.inkable(y * map.w + x)) want++;
    }
  }
  assert.equal(ink.count, want);
  assert.equal(want, 29);
  for (let i = 0; i < map.w * map.h; i++) if (ink.inked[i]) assert.equal(ink.at[i], 10);
  // time never goes back
  ink.restartAt(3, 2.5, 2.5);
  assert.equal(ink.now, 10);
  assert.equal(ink.at[2 * map.w + 2], 10);
  // junk is ignored
  ink.restartAt(11, NaN, 2);
  ink.restartDisc(11, 2, Infinity);
  assert.equal(ink.count, 1);
});

test("Clear erases a room, which fills again from its doors at the same speed", () => {
  //          x: 0123456789012345678
  const rows = [
    "###################",
    "#P____+.....+_____#",
    "###################",
  ];
  const map = parseAscii(rows);
  assert.equal(map.rooms.length, 1);
  assert.equal(map.rooms[0]!.rect.x, 7);
  const ink = new Ink(map);
  ink.start(0);
  ink.clearRoom(2, 0);
  // inked up to d ≤ 7 (x ≤ 8) by t = 2, then x 7..11 erased
  assert.equal(row(ink, 1), ".######............");
  ink.step(100);
  for (let x = 1; x <= 6; x++) near(ink.at[19 + x]!, (x - 1) / SPEED);
  // from the inked door at x = 6, starting at the Clear
  for (let x = 7; x <= 17; x++) near(ink.at[19 + x]!, 2 + (x - 6) / SPEED);
});

test("a cleared room fills from both doors", () => {
  //          x: 01234567890123456
  const rows = [
    "#################",
    "#P____+...+____P#",
    "#################",
  ];
  const map = parseAscii(rows);
  const ink = new Ink(map);
  ink.start(0);
  ink.step(1.5); // d ≤ 5.25 from both spots: x 1..6 and 10..15
  ink.clearRoom(1.5, 0);
  ink.step(100);
  const at = (x: number) => ink.at[17 + x]!;
  near(at(7), 1.5 + 1 / SPEED);
  near(at(9), 1.5 + 1 / SPEED);
  near(at(8), 1.5 + 2 / SPEED);
  // the ink had not reached the room: the doors keep their times, the room starts at the Clear
  near(at(6), 5 / SPEED);
  near(at(10), 5 / SPEED);
});

test("Clear of an outside area, and a restart inside the cleared room", () => {
  const rows = [
    "##########",
    "#P,,,,,,,#",
    "#,,,,,,,,#",
    "####+#####",
    "#........#",
    "##########",
  ];
  const map = parseAscii(rows);
  assert.equal(map.areas.length, 1);
  const ink = new Ink(map);
  ink.start(0);
  ink.step(10);
  const outside = map.areas[0]!;
  const before = ink.count;
  ink.clearArea(10, outside.id);
  let left = 0;
  for (let i = 0; i < map.w * map.h; i++) if (ink.inked[i] && map.areaAt[i] === outside.id) left++;
  assert.equal(left, 0);
  assert.equal(ink.count, before - 16);
  // flows back from the door (4, 3) at t = 10
  ink.step(100);
  const d = map.doors[0]!;
  near(ink.at[2 * map.w + 4]!, 10 + 1 / SPEED);
  near(ink.at[1 * map.w + 1]!, 10 + (3 + Math.SQRT2) / SPEED);
  assert.equal(d.x, 4);
  // junk ids: nothing
  ink.clearRoom(100, -1);
  ink.clearArea(100, 1.5);
  assert.equal(ink.count, before);
});

test("the encoding round-trips: runs, bitsets and deltas", () => {
  const rng = new Rng(3);
  const kinds = new Set<string>();
  for (const n of [0, 1, 2, 7, 8, 9, 100, 4644]) {
    for (const p of [0, 0.01, 0.5, 0.99, 1]) {
      const mask = new Uint8Array(n).map(() => (rng.chance(0.7) ? 1 : 0));
      const bits = new Uint8Array(n);
      for (let i = 0; i < n; i++) bits[i] = mask[i] && rng.chance(p) ? 1 : 0;
      const k = encodeInk(bits, mask);
      kinds.add(k[0]!);
      assert.deepEqual(decodeInk(k, mask), bits);
      const prev = bits.map((b, i) => (mask[i] && rng.chance(0.02) ? b ^ 1 : b));
      const d = encodeInk(bits, mask, prev);
      kinds.add(d[0]!);
      assert.deepEqual(decodeInk(d, mask, prev), bits, `n ${n} p ${p}`);
    }
  }
  assert.deepEqual([...kinds].sort(), ["B", "D", "K"]);
  // known strings: 0011 1000 is shortest as a bitset (0x1c), long runs as runs
  const all = [1, 1, 1, 1, 1, 1, 1, 1];
  assert.equal(encodeInk([0, 0, 1, 1, 1, 0, 0, 0], all), "BHA");
  const long = Array.from({ length: 64 }, (_, i) => (i >= 10 && i < 30 ? 1 : 0));
  assert.equal(encodeInk(long, new Array(64).fill(1)), "KChQi", "runs 10, 20, 34");
  assert.deepEqual(decodeInk("KAgMD", all), Uint8Array.from([0, 0, 1, 1, 1, 0, 0, 0]), "runs 2, 3, 3");
  // tiles outside the mask are not sent: 1?1 with the middle masked out
  assert.equal(encodeInk([1, 1, 1], [1, 0, 1]), "BAw");
  assert.deepEqual(decodeInk("KAAI", [1, 0, 1]), Uint8Array.from([1, 0, 1]), "runs 0, 2");
  assert.deepEqual(decodeInk("BBQ", [1, 1, 1]), Uint8Array.from([1, 0, 1]));
});

test("the decoder refuses junk", () => {
  const mask = [1, 1, 1, 1];
  const good = encodeInk([0, 1, 1, 0], mask);
  for (const bad of [null, 3, {}, "", "K", "X" + good.slice(1), good + "A", "K!!!!", "KAgMD", "BAAA", "KAAA"]) {
    assert.equal(decodeInk(bad, mask), null, String(bad));
  }
  assert.equal(decodeInk(good, new Array(12).fill(1)), null, "a different mask");
  assert.equal(decodeInk(good, null as unknown as number[]), null);
  const prev = Uint8Array.from({ length: 64 }, (_, i) => i & 1);
  const next = Uint8Array.from(prev);
  next[5] = 0;
  const d = encodeInk(next, new Uint8Array(64).fill(1), prev);
  assert.equal(d[0], "D");
  assert.equal(decodeInk(d, new Uint8Array(64).fill(1)), null, "a delta needs its frame");
  assert.equal(decodeInk(d, new Uint8Array(64).fill(1), [1, 1]), null);
  assert.deepEqual(decodeInk(d, new Uint8Array(64).fill(1), prev), next);
});

test("a heist's ink on an 86×54 estate: timings and sizes", (t) => {
  const e = generate(8, 2);
  const map = e.map;
  const mask = inkMask(map);
  const ink = new Ink(map);
  ink.start(0);
  let prev = Uint8Array.from(ink.inked);
  let keyMax = 0;
  let deltaMax = 0;
  let worst = 0;
  const s0 = performance.now();
  let frames = 0;
  const rooms = map.rooms.filter((r) => r.kind !== "vault");
  for (let k = 1; k <= 600; k++) {
    const now = k * 0.1;
    const s = performance.now();
    if (k % 150 === 75) ink.restartDisc(now, map.w / 2, map.h / 2);
    if (k % 40 === 0) ink.clearRoom(now, rooms[k % rooms.length]!.id);
    ink.step(now);
    worst = Math.max(worst, performance.now() - s);
    frames++;
    const key = encodeInk(ink.inked, mask);
    const delta = encodeInk(ink.inked, mask, prev);
    keyMax = Math.max(keyMax, key.length);
    deltaMax = Math.max(deltaMax, delta.length);
    assert.deepEqual(decodeInk(key, mask), ink.inked);
    assert.deepEqual(decodeInk(delta, mask, prev), ink.inked);
    prev = Uint8Array.from(ink.inked);
  }
  const avg = (performance.now() - s0) / frames;
  t.diagnostic(`ink on 86×54: step ${worst.toFixed(2)} ms at worst (encoding included: ${avg.toFixed(2)} ms a frame); keyframe ≤ ${keyMax} chars, frame to send ≤ ${deltaMax} chars`);
  assert.ok(ink.count > 300);
});
