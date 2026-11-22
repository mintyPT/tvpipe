import assert from "node:assert/strict";
import { test } from "node:test";

import { generate, parseAscii, TILE, type Blueprint } from "../game/map.ts";
import {
  climbTarget,
  DOOR_CLOSED,
  DOOR_LOCKED,
  DOOR_OPEN,
  DOOR_PAUSE,
  doorsInReach,
  doorStates,
  DT,
  facing,
  findPath,
  fits,
  goTo,
  nearestWalkable,
  PICK_TIME,
  RADIUS,
  settle,
  slide,
  SPEED,
  step,
  sweepClear,
  validPoint,
  windowsInReach,
  type Body,
  type Path,
  type World,
} from "../game/move.ts";
import { Rng } from "../game/rng.ts";

const world = (rows: string[]): World => {
  const map = parseAscii(rows);
  return { map, doors: doorStates(map) };
};
const at = (map: Blueprint, x: number, y: number) => y * map.w + x;
const xy = (map: Blueprint, i: number): [number, number] => [i % map.w, Math.floor(i / map.w)];
const centre = (x: number, y: number) => ({ x: x + 0.5, y: y + 0.5 });
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

/** Reference shortest path costs (Dijkstra, quadratic, the same move rules) to check A* against. */
function reference(w: World, from: number, locked: number | null): Float64Array {
  const m = w.map;
  const n = m.w * m.h;
  const d = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  d[from] = 0;
  const enter = (j: number) => {
    const t = m.tiles[j];
    if (t === TILE.FLOOR) return 0;
    if (t !== TILE.DOOR) return -1;
    const s = w.doors[m.doorAt[j]!];
    if (s === DOOR_OPEN) return 0;
    if (s === DOOR_LOCKED) return locked === null ? -1 : (DOOR_PAUSE + locked) * SPEED;
    return DOOR_PAUSE * SPEED;
  };
  for (;;) {
    let i = -1;
    for (let k = 0; k < n; k++) if (!done[k] && d[k]! < Infinity && (i < 0 || d[k]! < d[i]!)) i = k;
    if (i < 0) return d;
    done[i] = 1;
    const [x, y] = xy(m, i);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const j = at(m, x + dx!, y + dy!);
      const c = enter(j);
      if (c >= 0 && d[i]! + 1 + c < d[j]!) d[j] = d[i]! + 1 + c;
    }
    if (m.tiles[i] !== TILE.FLOOR) continue;
    for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const j = at(m, x + dx!, y + dy!);
      const F = TILE.FLOOR;
      if (m.tiles[j] === F && m.tiles[at(m, x + dx!, y)] === F && m.tiles[at(m, x, y + dy!)] === F && d[i]! + Math.SQRT2 < d[j]!) d[j] = d[i]! + Math.SQRT2;
    }
  }
}

/** Checks a tile path: neighbours, standable, no corner cutting, doors only straight. */
function checkTiles(w: World, p: Path) {
  const m = w.map;
  for (let k = 1; k < p.tiles.length; k++) {
    const [ax, ay] = xy(m, p.tiles[k - 1]!);
    const [bx, by] = xy(m, p.tiles[k]!);
    const dx = bx - ax;
    const dy = by - ay;
    assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx || dy), "neighbours");
    const t = m.tiles[p.tiles[k]!];
    assert.ok(t === TILE.FLOOR || t === TILE.DOOR, "walkable");
    if (dx && dy) {
      for (const i of [p.tiles[k - 1]!, p.tiles[k]!, at(m, bx, ay), at(m, ax, by)]) assert.equal(m.tiles[i], TILE.FLOOR, "no corner cutting");
    }
  }
}

/** Every smoothed segment is clear for a body (doors on the path open). */
function checkSmooth(w: World, from: { x: number; y: number }, p: Path) {
  const m = w.map;
  const onPath = new Set(p.tiles.filter((i) => m.tiles[i] === TILE.DOOR));
  const solid = (i: number) => !(m.tiles[i] === TILE.FLOOR || onPath.has(i));
  let a = from;
  for (const b of p.points) {
    assert.ok(sweepClear(m, solid, a, b, RADIUS - 1e-9), `segment ${a.x},${a.y} → ${b.x},${b.y}`);
    a = b;
  }
}

/** Walks a path to the end; returns the events and steps. */
function walk(w: World, body: Body, p: Path, max = 2000, onDoor?: (id: number) => void) {
  const events: string[] = [];
  for (let k = 0; k < max; k++) {
    const e = step(body, p, DT, w);
    if (!e) continue;
    events.push(e.kind);
    if (e.kind === "door") {
      if (onDoor) onDoor(e.door);
      else return { events, steps: k + 1 };
    } else return { events, steps: k + 1 };
  }
  return { events, steps: max };
}

// ---------------------------------------------------------------- paths

test("a straight corridor costs its length and smooths to one segment", () => {
  const w = world(["############", "#..........#", "############"]);
  const p = findPath(w, centre(1, 1), centre(10, 1))!;
  assert.equal(p.complete, true);
  assert.equal(p.cost, 9);
  assert.equal(p.tiles.length, 10);
  assert.deepEqual(p.points, [centre(10, 1)]);
  assert.deepEqual(p.doors, [-1]);
});

test("paths go around walls with the optimal cost", () => {
  const rows = [
    "##########",
    "#........#",
    "#.######.#",
    "#......#.#",
    "#####..#.#",
    "#........#",
    "##########",
  ];
  const w = world(rows);
  const p = findPath(w, centre(1, 3), centre(8, 3))!;
  assert.equal(p.complete, true);
  checkTiles(w, p);
  const ref = reference(w, at(w.map, 1, 3), null);
  near(p.cost, ref[at(w.map, 8, 3)]!);
  checkSmooth(w, centre(1, 3), p);
  assert.ok(p.points.length < p.tiles.length - 1, "smoothed");
});

test("no corner cutting", () => {
  const w = world(["#####", "#.#.#", "#...#", "#####"]);
  const p = findPath(w, centre(1, 1), centre(3, 1))!;
  assert.deepEqual(p.tiles, [at(w.map, 1, 1), at(w.map, 1, 2), at(w.map, 2, 2), at(w.map, 3, 2), at(w.map, 3, 1)]);
  near(p.cost, 4);
  checkTiles(w, p);
  // diagonal walls that touch at a corner only: not a way through
  const d = world(["#####", "#.#.#", "##..#", "#####"]);
  const q = findPath(d, centre(1, 1), centre(3, 1))!;
  assert.equal(q.complete, false);
  assert.deepEqual(q.tiles, [at(d.map, 1, 1)]);
});

test("A* matches the reference on random maps with doors", () => {
  const rng = new Rng(7);
  for (let round = 0; round < 40; round++) {
    const W = 14;
    const H = 10;
    const rows: string[] = [];
    for (let y = 0; y < H; y++) {
      let r = "";
      for (let x = 0; x < W; x++) {
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) r += "#";
        else {
          const v = rng.float();
          r += v < 0.25 ? "#" : v < 0.3 ? "+" : v < 0.32 ? "X" : ".";
        }
      }
      rows.push(r);
    }
    const w = world(rows);
    // some doors open
    for (let k = 0; k < w.map.doors.length; k++) if (!w.map.doors[k]!.locked && rng.chance(0.5)) (w.doors as Uint8Array)[k] = DOOR_OPEN;
    const floors = [...w.map.tiles.keys()].filter((i) => w.map.tiles[i] === TILE.FLOOR);
    for (let k = 0; k < 6; k++) {
      const a = rng.pick(floors)!;
      const b = rng.pick(floors)!;
      for (const locked of [null, 0, PICK_TIME]) {
        const ref = reference(w, a, locked)[b]!;
        const p = findPath(w, centre(...xy(w.map, a)), centre(...xy(w.map, b)), { locked })!;
        assert.equal(p.complete, ref < Infinity, `round ${round}`);
        if (p.complete) {
          near(p.cost, ref, 1e-9);
          checkTiles(w, p);
          checkSmooth(w, centre(...xy(w.map, a)), p);
        }
      }
    }
  }
});

test("doors: closed cost the pause, open nothing, locked only when allowed", () => {
  const rows = ["#########", "#...+...#", "#########"];
  const w = world(rows);
  const from = centre(1, 1);
  const to = centre(7, 1);
  const closed = findPath(w, from, to)!;
  near(closed.cost, 6 + DOOR_PAUSE * SPEED);
  assert.ok(closed.tiles.includes(at(w.map, 4, 1)));
  assert.equal(closed.doors.filter((d) => d >= 0).length, 1, "the door is a waypoint");
  (w.doors as Uint8Array)[0] = DOOR_OPEN;
  near(findPath(w, from, to)!.cost, 6);

  const l = world(["#########", "#...X...#", "#########"]);
  assert.equal(l.doors[0], DOOR_LOCKED);
  const none = findPath(l, from, to)!;
  assert.equal(none.complete, false);
  assert.equal(none.tiles.at(-1), at(l.map, 3, 1), "as near as it gets");
  near(findPath(l, from, to, { locked: 0 })!.cost, 6 + DOOR_PAUSE * SPEED);
  near(findPath(l, from, to, { locked: PICK_TIME })!.cost, 6 + (DOOR_PAUSE + PICK_TIME) * SPEED);
});

test("the thief picks a lock or walks around, whichever is quicker", () => {
  // around: 14; the lock: 2 + (0.3 + 3) · 3.5 = 13.55
  const long = world(["#########", "#...X...#", "#.#####.#", "#.......#", "#########"]);
  const a = findPath(long, centre(3, 1), centre(5, 1), { locked: PICK_TIME })!;
  assert.ok(a.tiles.includes(at(long.map, 4, 1)), "picks");
  near(a.cost, 13.55, 1e-9);
  // around: 4
  const short = world(["#####", "#.X.#", "#...#", "#####"]);
  const b = findPath(short, centre(1, 1), centre(3, 1), { locked: PICK_TIME })!;
  assert.ok(!b.tiles.includes(at(short.map, 2, 1)), "walks around");
  near(b.cost, 4);
  const guard = findPath(short, centre(1, 1), centre(3, 1), { locked: 0 })!;
  assert.ok(guard.tiles.includes(at(short.map, 2, 1)), "the keys: 2 + 1.05");
});

test("windows are not part of paths", () => {
  const w = world(["#######", "#..'..#", "#######"]);
  const p = findPath(w, centre(1, 1), centre(5, 1))!;
  assert.equal(p.complete, false);
});

test("the budget bounds the search", () => {
  const rows = ["#".repeat(60), ...Array.from({ length: 40 }, () => "#" + ".".repeat(58) + "#"), "#".repeat(60)];
  rows[20] = "#" + "#".repeat(57) + ".#";
  const w = world(rows);
  const full = findPath(w, centre(1, 30), centre(1, 10))!;
  assert.equal(full.complete, true);
  const cut = findPath(w, centre(1, 30), centre(1, 10), { budget: 50 })!;
  assert.equal(cut.complete, false);
  assert.ok(cut.tiles.length > 1 && cut.tiles.length < 50);
});

test("an unreachable goal costs one flood and leads as near as possible", () => {
  const w = world(["#########", "#...#...#", "#...#...#", "#########"]);
  const p = findPath(w, centre(1, 1), centre(7, 2))!;
  assert.equal(p.complete, false);
  assert.equal(p.tiles.at(-1), at(w.map, 3, 2));
  assert.deepEqual(p.points.at(-1), centre(3, 2));
});

test("smoothing keeps the tapped point and cuts across an open room", () => {
  const rows = ["##############", ...Array.from({ length: 8 }, () => "#" + ".".repeat(12) + "#"), "##############"];
  const w = world(rows);
  const p = findPath(w, { x: 1.4, y: 1.6 }, { x: 11.2, y: 6.7 })!;
  assert.deepEqual(p.points, [{ x: 11.2, y: 6.7 }]);
  // the goal is pulled in so the body fits its tile
  const q = findPath(w, { x: 1.4, y: 1.6 }, { x: 12.99, y: 8.01 })!;
  assert.equal(q.points.length, 1);
  near(q.points[0]!.x, 13 - RADIUS - 0.05);
  near(q.points[0]!.y, 8 + RADIUS + 0.05);
});

test("junk input gives null, never a throw", () => {
  const w = world(["#####", "#...#", "#####"]);
  for (const [x, y] of [[NaN, 1], [1, Infinity], ["1", 1], [null, 1], [undefined, undefined], [-1, 1], [99, 1], [1e300, 1], [{}, []]] as const) {
    assert.equal(goTo(w, centre(1, 1), x, y), null, `${String(x)}, ${String(y)}`);
    assert.equal(validPoint(w.map, x, y), null);
  }
  assert.equal(findPath(w, { x: NaN, y: 1 }, centre(2, 1)), null);
  assert.equal(findPath(w, centre(1, 1), centre(0, 0)), null, "a wall as goal");
  assert.equal(findPath(w, centre(1, 1), centre(9, 9)), null);
  assert.equal(nearestWalkable(w.map, NaN, 1), null);
  assert.equal(nearestWalkable(w.map, 1000, 1), null);
  assert.equal(nearestWalkable(w.map, 2.5, 0.2), at(w.map, 2, 1), "a tap on the wall snaps to the floor");
  const g = goTo(w, centre(1, 1), 3.5, 0.1)!;
  assert.deepEqual(g.points.at(-1), centre(3, 1));
});

// ---------------------------------------------------------------- moving

test("walking a corridor: speed, arrival, facing", () => {
  const w = world(["############", "#..........#", "############"]);
  const body: Body = { x: 1.5, y: 1.5, angle: 90 };
  const p = findPath(w, body, centre(10, 1))!;
  for (let k = 1; k <= 10; k++) {
    assert.equal(step(body, p, DT, w), null);
    near(body.x, 1.5 + k * SPEED * DT, 1e-9);
    near(body.y, 1.5);
  }
  assert.equal(body.angle, 0);
  const { events, steps } = walk(w, body, p);
  assert.deepEqual(events, ["arrived"]);
  assert.equal(10 + steps, Math.ceil(9 / (SPEED * DT)));
  assert.deepEqual([body.x, body.y], [10.5, 1.5]);
  near(facing(0, 1), 90);
  near(facing(-1, 0), 180);
  near(facing(0, -1), 270);
});

test("sliding along a wall at a shallow angle", () => {
  const w = world(["##############", "#............#", "#............#", "##############"]);
  const body: Body = { x: 1.5, y: 1.5, angle: 0 };
  // into the north wall, 5° off it
  const dx = Math.cos((5 * Math.PI) / 180) * 0.175;
  const dy = -Math.sin((5 * Math.PI) / 180) * 0.175;
  let x = body.x;
  for (let k = 0; k < 80; k++) {
    slide(w, body, dx, dy);
    assert.ok(fits(w, body.x, body.y));
    assert.ok(body.y >= 1 + RADIUS - 1e-9);
    if (body.x < 12.5) {
      assert.ok(body.x - x >= dx * 0.999, "keeps nearly all of its speed along the wall");
    }
    x = body.x;
  }
  near(body.y, 1 + RADIUS, 1e-6);
  near(body.x, 13 - RADIUS, 1e-6);
});

test("sliding round a convex corner", () => {
  const w = world(["#######", "#.....#", "#.###.#", "#.###.#", "#.....#", "#######"]);
  const body: Body = { x: 1.5, y: 3.5, angle: 0 };
  // push north-east into the block's corner: it slides up the block's west face
  for (let k = 0; k < 30; k++) slide(w, body, 0.1, -0.1);
  assert.ok(fits(w, body.x, body.y));
  assert.ok(body.y < 2, "got past the corner");
});

test("never tunnels through walls or corners, at any angle (property)", () => {
  const rng = new Rng(20241122);
  const maps: World[] = [];
  // random rubble and closed doors
  for (let k = 0; k < 6; k++) {
    const rows: string[] = [];
    for (let y = 0; y < 16; y++) {
      let r = "";
      for (let x = 0; x < 20; x++) {
        if (x === 0 || y === 0 || x === 19 || y === 15) r += "#";
        else {
          const v = rng.float();
          r += v < 0.3 ? "#" : v < 0.36 ? "+" : v < 0.4 ? "'" : ".";
        }
      }
      rows.push(r);
    }
    maps.push(world(rows));
  }
  // a diagonal staircase: walls touching at corners only
  const stair: string[] = [];
  for (let y = 0; y < 16; y++) {
    let r = "";
    for (let x = 0; x < 16; x++) r += x === 0 || y === 0 || x === 15 || y === 15 || x === y ? "#" : ".";
    stair.push(r);
  }
  maps.push(world(stair));
  // a checkerboard: every gap is a corner gap
  const check: string[] = [];
  for (let y = 0; y < 12; y++) {
    let r = "";
    for (let x = 0; x < 12; x++) r += x === 0 || y === 0 || x === 11 || y === 11 || (x + y) % 2 === 0 ? "#" : ".";
    check.push(r);
  }
  maps.push(world(check));

  for (const w of maps) {
    const m = w.map;
    // 4-connected components of free tiles: a body may only change component by a diagonal? never: corner gaps are shut
    const comp = new Int32Array(m.w * m.h).fill(-1);
    let c = 0;
    for (let s = 0; s < comp.length; s++) {
      if (comp[s]! >= 0 || m.tiles[s] !== TILE.FLOOR) continue;
      const q = [s];
      comp[s] = c;
      for (let k = 0; k < q.length; k++) {
        const [x, y] = xy(m, q[k]!);
        for (const j of [at(m, x + 1, y), at(m, x - 1, y), at(m, x, y + 1), at(m, x, y - 1)]) {
          if (m.tiles[j] === TILE.FLOOR && comp[j]! < 0) {
            comp[j] = c;
            q.push(j);
          }
        }
      }
      c++;
    }
    const floors = [...m.tiles.keys()].filter((i) => m.tiles[i] === TILE.FLOOR);
    for (let trial = 0; trial < 60; trial++) {
      const s = rng.pick(floors)!;
      const [sx, sy] = xy(m, s);
      const body: Body = { x: sx + 0.3 + rng.float() * 0.4, y: sy + 0.3 + rng.float() * 0.4, angle: 0 };
      assert.ok(fits(w, body.x, body.y));
      const home = comp[s]!;
      const a = rng.float() * 2 * Math.PI;
      for (let k = 0; k < 120; k++) {
        // mostly one heading (pressing into walls and corners), sometimes a new one
        const h = rng.chance(0.1) ? rng.float() * 2 * Math.PI : a;
        const len = rng.float() * 0.6;
        const px = body.x;
        const py = body.y;
        slide(w, body, Math.cos(h) * len, Math.sin(h) * len);
        assert.ok(fits(w, body.x, body.y), "never overlaps");
        assert.ok(sweepClear(m, (i) => m.tiles[i] !== TILE.FLOOR, { x: px, y: py }, body, 1e-6), "the centre never crossed a solid tile");
        assert.equal(comp[at(m, Math.floor(body.x), Math.floor(body.y))], home, "stays on its side");
      }
    }
  }
});

test("walking random paths keeps every invariant", () => {
  const rng = new Rng(99);
  const rows: string[] = [];
  for (let y = 0; y < 20; y++) {
    let r = "";
    for (let x = 0; x < 30; x++) r += x === 0 || y === 0 || x === 29 || y === 19 || rng.chance(0.22) ? "#" : ".";
    rows.push(r);
  }
  const w = world(rows);
  const m = w.map;
  const floors = [...m.tiles.keys()].filter((i) => m.tiles[i] === TILE.FLOOR);
  let arrived = 0;
  for (let trial = 0; trial < 150; trial++) {
    const [sx, sy] = xy(m, rng.pick(floors)!);
    const body: Body = { x: sx + 0.5, y: sy + 0.5, angle: 0 };
    const [gx, gy] = xy(m, rng.pick(floors)!);
    const p = findPath(w, body, { x: gx + rng.float(), y: gy + rng.float() })!;
    for (let k = 0; k < 1000; k++) {
      const px = body.x;
      const py = body.y;
      const e = step(body, p, DT, w);
      assert.ok(fits(w, body.x, body.y));
      const d = Math.sqrt((body.x - px) ** 2 + (body.y - py) ** 2);
      assert.ok(d <= SPEED * DT + 1e-9, `no faster than walking: ${d}`);
      if (e?.kind === "arrived") {
        if (p.complete) {
          const g = p.points.at(-1)!;
          assert.deepEqual([body.x, body.y], [g.x, g.y]);
        }
        arrived++;
        break;
      }
      assert.notEqual(e?.kind, "stuck", "a body on its path never sticks");
    }
  }
  assert.ok(arrived === 150);
});

test("a closed door stops the walk until the sim opens it", () => {
  const w = world(["###########", "#....+....#", "###########"]);
  const body: Body = { x: 1.5, y: 1.5, angle: 0 };
  const p = findPath(w, body, centre(9, 1))!;
  let e = null;
  let k = 0;
  for (; k < 200 && !e; k++) e = step(body, p, DT, w);
  assert.deepEqual(e, { kind: "door", door: 0, locked: false });
  near(body.x, 5 - RADIUS, 1e-3);
  const x = body.x;
  // waiting: reported again, no movement
  assert.deepEqual(step(body, p, DT, w), { kind: "door", door: 0, locked: false });
  assert.equal(body.x, x);
  (w.doors as Uint8Array)[0] = DOOR_OPEN;
  const r = walk(w, body, p);
  assert.deepEqual(r.events, ["arrived"]);
  assert.deepEqual([body.x, body.y], [9.5, 1.5]);

  const l = world(["###########", "#....X....#", "###########"]);
  const b2: Body = { x: 1.5, y: 1.5, angle: 0 };
  const p2 = findPath(l, b2, centre(9, 1), { locked: PICK_TIME })!;
  const events: string[] = [];
  walk(l, b2, p2, 400, (id) => {
    events.push("door");
    (l.doors as Uint8Array)[id] = DOOR_OPEN;
  });
  assert.equal(events.length, 1);
  assert.deepEqual([b2.x, b2.y], [9.5, 1.5]);
  // a door closed in its way stops a body that was not told about it too (it slides, then sticks)
  const s = world(["###########", "#....+....#", "###########"]);
  (s.doors as Uint8Array)[0] = DOOR_OPEN;
  const b3: Body = { x: 1.5, y: 1.5, angle: 0 };
  const p3 = findPath(s, b3, centre(9, 1))!;
  (s.doors as Uint8Array)[0] = DOOR_CLOSED;
  assert.equal(walk(s, b3, p3).events[0], "door");
});

test("settle frees a body a door closed on", () => {
  const w = world(["#######", "#..+..#", "#######"]);
  (w.doors as Uint8Array)[0] = DOOR_OPEN;
  const body: Body = { x: 3.5, y: 1.5, angle: 0 };
  assert.ok(fits(w, body.x, body.y));
  (w.doors as Uint8Array)[0] = DOOR_CLOSED;
  assert.ok(!fits(w, body.x, body.y));
  assert.ok(settle(w, body));
  assert.ok(fits(w, body.x, body.y));
});

test("reach: doors, windows, climbing", () => {
  const w = world(["#########", "#...+...#", "#.......#", "####'####", ",,,,,,,,,", "%%%%%%%%%"]);
  const m = w.map;
  assert.deepEqual(doorsInReach(m, centre(4, 2)), [0]);
  assert.deepEqual(doorsInReach(m, centre(3, 2)), [0], "diagonally next to it");
  assert.deepEqual(doorsInReach(m, centre(2, 2)), []);
  assert.deepEqual(windowsInReach(m, centre(4, 2)), [0]);
  assert.deepEqual(climbTarget(w, 0, centre(4, 2)), centre(4, 4));
  assert.deepEqual(climbTarget(w, 0, centre(4, 4)), centre(4, 2));
  assert.equal(climbTarget(w, 0, centre(1, 1)), null, "too far");
  assert.equal(climbTarget(w, 5, centre(4, 2)), null);
  assert.equal(climbTarget(w, NaN, centre(4, 2)), null);
});

// ---------------------------------------------------------------- real estates

test("timings on an 86×54 estate", (t) => {
  const e = generate(8, 1);
  const m = e.map;
  assert.equal(m.w, 86);
  const w: World = { map: m, doors: doorStates(m) };
  const rng = new Rng(5);
  const floors = [...m.tiles.keys()].filter((i) => m.tiles[i] === TILE.FLOOR);
  const pairs: [number, number][] = [];
  for (let k = 0; k < 200; k++) pairs.push([rng.pick(floors)!, rng.pick(floors)!]);
  let worst = 0;
  let complete = 0;
  const t0 = performance.now();
  for (const [a, b] of pairs) {
    const s = performance.now();
    const p = findPath(w, centre(...xy(m, a)), centre(...xy(m, b)), { locked: PICK_TIME });
    worst = Math.max(worst, performance.now() - s);
    if (p?.complete) complete++;
  }
  const avg = (performance.now() - t0) / pairs.length;
  // a bad target: the vault without keys floods everything else once
  const vault = m.rooms.find((r) => r.kind === "vault")!;
  const s = performance.now();
  const inVault = floors.find((i) => m.roomAt[i] === vault.id)!;
  const bad = findPath(w, centre(...xy(m, m.spawn[0]!)), centre(...xy(m, inVault)));
  const ms = performance.now() - s;
  assert.equal(bad?.complete, false);
  t.diagnostic(`A* on 86×54: ${avg.toFixed(3)} ms a path on average, worst ${worst.toFixed(2)} ms, ${complete}/${pairs.length} complete; unreachable goal ${ms.toFixed(2)} ms`);
  assert.ok(complete >= 190, "random pairs are connected (through locks, not windows)");
  // walking every pair to its end, opening doors on the way (the door pause left out)
  let steps = 0;
  let time = 0;
  for (const [a, b] of pairs) {
    const doors = doorStates(m);
    const wd: World = { map: m, doors };
    const body: Body = { ...centre(...xy(m, a)), angle: 0 };
    const p = findPath(wd, body, centre(...xy(m, b)), { locked: 0 })!;
    checkSmooth(wd, body, p);
    const s0 = performance.now();
    let e = null;
    for (let k = 0; k < 4000 && e?.kind !== "arrived"; k++) {
      e = step(body, p, DT, wd);
      steps++;
      assert.notEqual(e?.kind, "stuck");
      if (e?.kind === "door") doors[e.door] = DOOR_OPEN;
    }
    time += performance.now() - s0;
    assert.equal(e?.kind, "arrived");
    assert.deepEqual([body.x, body.y], [p.points.at(-1)!.x, p.points.at(-1)!.y]);
  }
  t.diagnostic(`step: ${((time / steps) * 1000).toFixed(2)} µs a body a step (${steps} steps)`);
});
