import assert from "node:assert/strict";
import { test } from "node:test";

import { generate, parseAscii, WALKABLE, type Blueprint } from "../game/map.ts";
import { doorStates } from "../game/move.ts";
import { fieldOfView, opacity } from "../game/sight.ts";
import { area, INSET, inside, sight, walls, type Box } from "../game/vision.ts";

const close = (a: number, b: number, tol: number, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not ${b} ± ${tol}`);

function mapOf(rows: readonly string[], open: number[] = []): { map: Blueprint; box: Box; wl: ReturnType<typeof walls> } {
  const map = parseAscii(rows);
  const doors = new Uint8Array(map.doors.length);
  for (const d of open) doors[d] = 1;
  return { map, box: { x0: 0, y0: 0, x1: map.w, y1: map.h }, wl: walls(map, opacity(map, doors)) };
}

const ROOM = [
  "%%%%%%%%%",
  "%#######%",
  "%#.....#%",
  "%#.....#%",
  "%#.....+,",
  "%#.....#%",
  "%#######%",
  "%%%%%%%%%",
];

test("a closed room: its floor and the near half of its walls, wherever one stands in it", () => {
  const { wl, box } = mapOf(ROOM);
  for (const [x, y] of [[4.5, 4.5], [2.4, 2.4], [6.6, 5.7], [3.1, 3.9]] as const) {
    const p = sight(wl, x, y, box);
    // Floor 5 × 4 plus half a tile all round: 6 × 5.
    close(area(p), 30, 1e-6, `area from ${x},${y}`);
    for (let k = 0; k < p.length; k += 2) {
      assert.ok(p[k]! >= 1.5 - 1e-6 && p[k]! <= 7.5 + 1e-6 && p[k + 1]! >= 1.5 - 1e-6 && p[k + 1]! <= 6.5 + 1e-6, `point ${p[k]},${p[k + 1]} outside the room`);
    }
  }
});

test("clockwise on screen, so a path of several fills their union", () => {
  const { wl, box } = mapOf(ROOM);
  assert.ok(area(sight(wl, 4.5, 4.5, box)) > 0);
  assert.ok(area(sight(wl, 4.5, 4.5, box, { radius: 2 })) > 0);
  assert.ok(area(sight(wl, 4.5, 4.5, box, { radius: 3, facing: 30, fov: 60 })) > 0);
});

test("an open door lets one see out along the line of sight, a closed one does not", () => {
  const shut = mapOf(ROOM);
  const open = mapOf(ROOM, [0]);
  const inRoom: [number, number] = [3.5, 4.5];
  // Straight out of the door (row 4) and off to the side behind the wall.
  assert.ok(!inside(sight(shut.wl, ...inRoom, shut.box), 8.5, 4.5));
  assert.ok(inside(sight(open.wl, ...inRoom, open.box), 8.5, 4.5));
  assert.ok(inside(sight(open.wl, ...inRoom, open.box), 7.5, 4.5));
  assert.ok(!inside(sight(open.wl, ...inRoom, open.box), 8.5, 2.5));
  // Through the open door, the room is bigger than with it closed.
  assert.ok(area(sight(open.wl, ...inRoom, open.box)) > area(sight(shut.wl, ...inRoom, shut.box)) + 0.4);
});

test("the doorway stays a tile wide: the walls either side end at its edges", () => {
  const { wl, box } = mapOf(ROOM, [0]);
  // From outside, looking in through the door at (7, 4): straight in yes, along the inside of the wall no.
  const p = sight(wl, 8.5, 4.5, box);
  assert.ok(inside(p, 4.5, 4.5));
  assert.ok(!inside(p, 6.5, 2.2));
  assert.ok(!inside(p, 6.5, 6.2 + 0.5));
});

test("radius: a circle in the open, cut at the box", () => {
  const rows = Array.from({ length: 21 }, (_, y) => (y === 0 || y === 20 ? "%".repeat(21) : "%" + ",".repeat(19) + "%"));
  const { wl, box } = mapOf(rows);
  const p = sight(wl, 10.5, 10.5, box, { radius: 4 });
  close(area(p), Math.PI * 16, Math.PI * 16 * 0.01, "circle");
  const cone = sight(wl, 10.5, 10.5, box, { radius: 4, facing: 90, fov: 60 });
  close(area(cone), (Math.PI * 16) / 6, (Math.PI * 16) / 6 * 0.01, "cone");
  assert.ok(inside(cone, 10.5, 13.5));
  assert.ok(!inside(cone, 10.5, 7.5));
  assert.ok(!inside(cone, 13.5, 10.5));
  // At the map's edge the edge's own half tile is seen, no more.
  const edge = sight(wl, 1.5, 10.5, box, { radius: 4 });
  for (let k = 0; k < edge.length; k += 2) assert.ok(edge[k]! >= 0.5 - 1e-6);
});

test("a lone tree blocks along the cross through its centre, as shadowcasting does", () => {
  const rows = [
    "%%%%%%%%%%%",
    "%,,,,,,,,,%",
    "%,,,,,,,,,%",
    "%,,,,T,,,,%",
    "%,,,,,,,,,%",
    "%,,,,,,,,,%",
    "%,,,,,,,,,%",
    "%%%%%%%%%%%",
  ];
  const { wl, box } = mapOf(rows);
  const p = sight(wl, 5.5, 1.5, box);
  assert.ok(!inside(p, 5.5, 5.5), "behind the tree");
  assert.ok(inside(p, 3.5, 5.5) && inside(p, 7.5, 5.5), "beside its shadow");
  assert.ok(inside(p, 5.5, 3.45) && !inside(p, 5.5, 3.55), "its near half");
  // From the side, diagonally: the cross's arm.
  const q = sight(wl, 2.5, 1.5, box);
  assert.ok(!inside(q, 6.5, 4.6), "behind it diagonally");
  assert.equal(INSET, 0.5);
});

test("an eye inside a blocker or outside the box sees nothing; odd input never throws", () => {
  const { wl, box } = mapOf(ROOM);
  assert.deepEqual(sight(wl, 1.5, 4.5, box), []); // on the wall's middle line
  assert.deepEqual(sight(wl, -3, 4, box), []);
  assert.deepEqual(sight(wl, NaN, 4, box), []);
  assert.deepEqual(sight(wl, 4, 4, { x0: NaN, y0: 0, x1: 1, y1: 1 }), []);
  assert.equal(walls({ w: 0, h: 0 } as Blueprint, []).n, 0);
});

test("generated estates: the lines of sight never pass through a blocker deeper than its inset, and the polygon is sight.ts's floor, give or take a little", () => {
  for (const [players, seed] of [[3, 1], [5, 7], [8, 3]] as const) {
    const map = generate(players, seed).map;
    const doors = doorStates(map);
    // Every other door open.
    for (let d = 0; d < doors.length; d += 2) if (doors[d] === 0) doors[d] = 1;
    const opaque = opacity(map, doors);
    const wl = walls(map, opaque);
    const box: Box = { x0: 0, y0: 0, x1: map.w, y1: map.h };
    const clear = (x: number, y: number) => x >= 0 && y >= 0 && x < map.w && y < map.h && !opaque[y * map.w + x];
    /** How deep a point lies in blockers: its distance (L∞) to the nearest clear tile, 0 on a clear one. */
    const deep = (x: number, y: number) => {
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      if (clear(tx, ty)) return 0;
      let d = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!clear(tx + dx, ty + dy)) continue;
          const ex = Math.max(tx + dx - x, x - (tx + dx + 1), 0);
          const ey = Math.max(ty + dy - y, y - (ty + dy + 1), 0);
          d = Math.min(d, Math.max(ex, ey));
        }
      }
      return d;
    };
    let tried = 0;
    for (let i = 0; i < map.w * map.h && tried < 16; i += 83) {
      if (!WALKABLE[map.tiles[i]!] || opaque[i]) continue;
      tried++;
      const ox = (i % map.w) + 0.5;
      const oy = Math.floor(i / map.w) + 0.5;
      const p = sight(wl, ox, oy, box);
      assert.ok(p.length >= 6, `a polygon from ${ox},${oy}`);
      for (let k = 0; k < p.length; k += 6) {
        const len = Math.hypot(p[k]! - ox, p[k + 1]! - oy);
        for (let t = 0; t < len - 0.01; t += 0.07) {
          const x = ox + ((p[k]! - ox) * t) / len;
          const y = oy + ((p[k + 1]! - oy) * t) / len;
          assert.ok(deep(x, y) <= INSET + 1e-6, `seed ${seed}: from ${ox},${oy} towards ${p[k]!.toFixed(2)},${p[k + 1]!.toFixed(2)} through a blocker at ${x.toFixed(2)},${y.toFixed(2)}`);
        }
      }
      // What sight.ts sees of the floor, the polygon shows (all but a few tiles at the edges of shadows, which shadowcasting rounds its own way).
      const fov = fieldOfView(map, opaque, ox, oy);
      let floor = 0;
      let shown = 0;
      for (let j = 0; j < fov.length; j++) {
        if (!fov[j] || opaque[j]) continue;
        floor++;
        const cx = (j % map.w) + 0.5;
        const cy = Math.floor(j / map.w) + 0.5;
        // Centres exactly on a shadow's edge count (ties: shadowcasting takes them, a ray may not).
        if ([[0, 0], [0.08, 0], [-0.08, 0], [0, 0.08], [0, -0.08]].some(([dx, dy]) => inside(p, cx + dx!, cy + dy!))) shown++;
      }
      assert.ok(shown >= floor * 0.97, `seed ${seed}: from ${ox},${oy} only ${shown} of ${floor} tiles in sight`);
      // And it shows little more: floor tiles well inside the polygon that sight.ts does not see.
      let extra = 0;
      for (let j = 0; j < fov.length; j++) {
        if (fov[j] || opaque[j]) continue;
        const cx = (j % map.w) + 0.5;
        const cy = Math.floor(j / map.w) + 0.5;
        if ([[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]].every(([dx, dy]) => inside(p, cx + dx!, cy + dy!))) extra++;
      }
      assert.ok(extra <= Math.max(2, floor * 0.02), `seed ${seed}: from ${ox},${oy} ${extra} tiles shown that sight.ts does not see (of ${floor})`);
    }
    assert.ok(tried >= 12);
  }
});
