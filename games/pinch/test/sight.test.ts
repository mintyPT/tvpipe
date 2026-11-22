import assert from "node:assert/strict";
import { test } from "node:test";

import { OPAQUE, TILE, generate, parseAscii, type Blueprint, type Camera } from "../game/map.ts";
import {
  FLASHLIGHT_RANGE,
  GUARD_RADIUS,
  LIGHT,
  THIEF_RADIUS,
  cameraSees,
  cameraView,
  decodeSeen,
  encodeSeen,
  fieldOfView,
  inCone,
  initialSight,
  isSeen,
  lightMask,
  lineOfSight,
  opacity,
  prepare,
  seenBy,
  seenMask,
  tileAt,
  type Flashlight,
  type SightState,
} from "../game/sight.ts";
import { benchmark, syntheticEstate } from "../scripts/sight-bench.ts";

// ---------------------------------------------------------------- helpers

/**
 * A fixture: map.ts's ASCII, where `@` (the viewer) and digits mark
 * places on floor of the kind `fill` (`,` grass, `.` dark, `:` lit).
 */
function fixture(rows: readonly string[], fill = ","): { map: Blueprint; at: Record<string, [number, number]> } {
  const at: Record<string, [number, number]> = {};
  const clean = rows.map((row, y) =>
    [...row]
      .map((c, x) => {
        if (c === "@" || (c >= "0" && c <= "9")) {
          at[c] = [x, y];
          return fill;
        }
        return c;
      })
      .join(""),
  );
  return { map: parseAscii(clean), at };
}

/** The mask on the map's see-through tiles (` ` where unset), the opaque ones as drawn, `@` the viewer. */
function render(rows: readonly string[], map: Blueprint, mask: Uint8Array, viewer?: [number, number]): string {
  return rows
    .map((row, y) =>
      [...row]
        .map((c, x) => {
          if (viewer && viewer[0] === x && viewer[1] === y) return "@";
          const i = y * map.w + x;
          if (OPAQUE[map.tiles[i]!] && c !== "+") return c;
          return mask[i] ? (c >= "0" && c <= "9" ? "," : c) : " ";
        })
        .join(""),
    )
    .join("\n");
}

const centre = (p: [number, number]): [number, number] => [p[0] + 0.5, p[1] + 0.5];

function state(map: Blueprint, patch: Partial<SightState> = {}): SightState {
  return { ...initialSight(map), ...patch };
}

function sightOf(rows: readonly string[], doorsOpen: number[] = [], fill = ","): string {
  const { map, at } = fixture(rows, fill);
  const doors = new Uint8Array(map.doors.length);
  for (const d of doorsOpen) doors[d] = 1;
  const v = at["@"]!;
  return render(rows, map, fieldOfView(map, opacity(map, doors), ...centre(v)), v);
}

// ---------------------------------------------------------------- line of sight

test("a wall casts a shadow", () => {
  const rows = [
    "%%%%%%%%%",
    "%,,,,,,,%",
    "%,,,#,,,%",
    "%,@,#,,,%",
    "%,,,#,,,%",
    "%,,,,,,,%",
    "%%%%%%%%%",
  ];
  assert.equal(
    sightOf(rows),
    [
      "%%%%%%%%%",
      "%,,,,   %",
      "%,,,#   %",
      "%,@,#   %",
      "%,,,#   %",
      "%,,,,   %",
      "%%%%%%%%%",
    ].join("\n"),
  );
});

test("a pillar hides a narrow wedge behind it", () => {
  const rows = [
    "%%%%%%%%%%",
    "%,,,,,,,,%",
    "%,@,T,,,,%",
    "%,,,,,,,,%",
    "%%%%%%%%%%",
  ];
  assert.equal(
    sightOf(rows),
    [
      "%%%%%%%%%%",
      "%,,,,,,  %",
      "%,@,T    %",
      "%,,,,,,  %",
      "%%%%%%%%%%",
    ].join("\n"),
  );
});

test("no peeking around corners", () => {
  const rows = [
    "%%%%%%%%%",
    "%#######%",
    "%#@,,,,#%",
    "%#,###,#%",
    "%#,#%#,#%",
    "%#,###,#%",
    "%#,,,,,#%",
    "%#######%",
    "%%%%%%%%%",
  ];
  assert.equal(
    sightOf(rows),
    [
      "%%%%%%%%%",
      "%#######%",
      "%#@,,,,#%",
      "%#,### #%",
      "%#,#%# #%",
      "%#,### #%",
      "%#,    #%",
      "%#######%",
      "%%%%%%%%%",
    ].join("\n"),
  );
});

test("one sees along a corridor and both ways at a crossing", () => {
  const rows = [
    "%%%%%%%%%%%",
    "%####,####%",
    "%####,####%",
    "%,,,,,,,,,%",
    "%####,####%",
    "%####@####%",
    "%%%%%%%%%%%",
  ];
  const { map, at } = fixture(rows);
  const vis = fieldOfView(map, opacity(map, []), ...centre(at["@"]!));
  for (let y = 1; y <= 5; y++) assert.equal(vis[y * map.w + 5], 1, `column at y=${y}`);
  // the crossing's arms open up only close to it
  assert.equal(vis[3 * map.w + 4], 1);
  assert.equal(vis[3 * map.w + 6], 1);
  assert.equal(vis[3 * map.w + 1], 0);
  assert.equal(vis[3 * map.w + 9], 0);
});

const ROOM = [
  "%%%%%%%%%%%",
  "%,,,,@,,,,%",
  "%,###+###,%",
  "%,#.....#,%",
  "%,#.....#,%",
  "%,#.....#,%",
  "%,###'###,%",
  "%,,,,,,,,,%",
  "%%%%%%%%%%%",
];

test("a closed door blocks sight, an open one shows a wedge of the room", () => {
  assert.equal(
    sightOf(ROOM),
    [
      "%%%%%%%%%%%",
      "%,,,,@,,,,%",
      "% ###+### %",
      "% #     # %",
      "% #     # %",
      "% #     # %",
      "% ###'### %",
      "%         %",
      "%%%%%%%%%%%",
    ].join("\n"),
  );
  assert.equal(
    sightOf(ROOM, [0]),
    [
      "%%%%%%%%%%%",
      "%,,,,@,,,,%",
      "% ###+### %",
      "% # ... # %",
      "% # ... # %",
      "% #.....# %",
      "% ###'### %",
      "%         %",
      "%%%%%%%%%%%",
    ].join("\n"),
  );
});

test("only an open door (1 or true) lets sight through; locked (2) and junk block", () => {
  const { map, at } = fixture(ROOM);
  const v = centre(at["@"]!);
  const seesIn = (doors: ArrayLike<number | boolean>) => fieldOfView(map, opacity(map, doors), ...v)[4 * map.w + 5] === 1;
  assert.ok(seesIn([1]) && seesIn([true]));
  for (const d of [[0], [2], [false], [3], [-1], [NaN], []]) assert.ok(!seesIn(d), `door state ${String(d[0])}`);
});

test("a curtained window always blocks sight", () => {
  const rows = ROOM.map((r) => r.replace("@", ",")).map((r, y) => (y === 7 ? "%,,,,@,,,,%" : r));
  assert.equal(
    sightOf(rows, [0]),
    [
      "%%%%%%%%%%%",
      "%         %",
      "% ### ### %",
      "% #     # %",
      "% #     # %",
      "% #     # %",
      "% ###'### %",
      "%,,,,@,,,,%",
      "%%%%%%%%%%%",
    ].join("\n"),
  );
});

test("inside a room one sees all of it, and nothing past closed doors", () => {
  const rows = ROOM.map((r) => r.replace("@", ",")).map((r, y) => (y === 4 ? "%,#..@..#,%" : r));
  const out = sightOf(rows, [], ".");
  assert.equal(
    out,
    [
      "%%%%%%%%%%%",
      "%         %",
      "%,###+###,%".replace(/,/g, " "),
      "% #.....# %",
      "% #..@..# %",
      "% #.....# %",
      "% ###'### %",
      "%         %",
      "%%%%%%%%%%%",
    ].join("\n"),
  );
});

/** A messy fixture: rooms, pillars, open and closed doors, a window, cover. */
const MESSY = [
  "%%%%%%%%%%%%%%%%%%%%",
  "%,,,,,,,,T,,,,,,,,,%",
  "%,,h,,,,,,,,,,c,,,,%",
  "%,,,,#####+######,,%",
  "%,T,,#....#.....#,,%",
  "%,,,,+..o.+..o..',,%",
  "%,,,,#.o..#.....#,,%",
  "%,,,,#....###+###,,%",
  "%,,,,#....#.....#,T%",
  "%,F,,#....+.....+,,%",
  "%,,,,##'###.....#,,%",
  "%,,,,,,,,,#######,,%",
  "%,,,,T,,,,,,,,,,,,,%",
  "%%%%%%%%%%%%%%%%%%%%",
];

test("sight is symmetric between see-through tiles, and lineOfSight agrees with the masks", () => {
  const map = parseAscii(MESSY);
  for (const open of [[], [0, 2, 4], [0, 1, 2, 3, 4, 5]]) {
    const doors = new Uint8Array(map.doors.length);
    for (const d of open) doors[d] = 1;
    const o = opacity(map, doors);
    const n = map.w * map.h;
    const masks: (Uint8Array | null)[] = [];
    for (let i = 0; i < n; i++) masks.push(o[i] ? null : fieldOfView(map, o, (i % map.w) + 0.5, Math.floor(i / map.w) + 0.5));
    let pairs = 0;
    for (let a = 0; a < n; a++) {
      const ma = masks[a];
      if (!ma) continue;
      for (let b = 0; b < n; b++) {
        const mb = masks[b];
        if (!mb) continue;
        assert.equal(ma[b], mb[a], `symmetry ${a % map.w},${Math.floor(a / map.w)} ↔ ${b % map.w},${Math.floor(b / map.w)}`);
        const los = lineOfSight(map, o, (a % map.w) + 0.2, Math.floor(a / map.w) + 0.7, (b % map.w) + 0.9, Math.floor(b / map.w) + 0.1);
        assert.equal(los, ma[b] === 1, "lineOfSight matches the mask");
        pairs++;
      }
    }
    assert.ok(pairs > 10000);
  }
});

test("sight is symmetric on generated estates, with doors open and closed", () => {
  for (const seed of [1, 2]) {
    const map = generate(8, seed).map;
    const doors = Uint8Array.from(map.doors, (_, k) => k % 2);
    const o = opacity(map, doors);
    const floor: number[] = [];
    for (let i = 0; i < map.w * map.h; i++) if (map.tiles[i] === TILE.FLOOR) floor.push(i);
    const pick = floor.filter((_, k) => k % 17 === 0);
    const xy = (i: number): [number, number] => [(i % map.w) + 0.5, Math.floor(i / map.w) + 0.5];
    const masks = pick.map((i) => fieldOfView(map, o, ...xy(i)));
    let seen = 0;
    for (let a = 0; a < pick.length; a++) {
      for (let b = 0; b < pick.length; b++) {
        assert.equal(masks[a]![pick[b]!], masks[b]![pick[a]!]);
        if (b % 7 === 0) assert.equal(lineOfSight(map, o, ...xy(pick[a]!), ...xy(pick[b]!)), masks[a]![pick[b]!] === 1);
        seen += masks[a]![pick[b]!]!;
      }
    }
    assert.ok(seen > pick.length * 2);
  }
});

test("lineOfSight reaches walls the masks show and refuses bad positions", () => {
  const { map, at } = fixture(ROOM);
  const o = opacity(map, [1]);
  const [vx, vy] = centre(at["@"]!);
  const vis = fieldOfView(map, o, vx, vy);
  for (let i = 0; i < map.w * map.h; i++) {
    assert.equal(lineOfSight(map, o, vx, vy, (i % map.w) + 0.5, Math.floor(i / map.w) + 0.5), vis[i] === 1);
  }
  assert.equal(lineOfSight(map, o, NaN, 1, 2, 2), false);
  assert.equal(lineOfSight(map, o, 1, 1, 2, Infinity), false);
  assert.equal(lineOfSight(map, o, vx, vy, vx, vy), true);
  assert.equal(lineOfSight(map, new Uint8Array(3), vx, vy, vx + 1, vy), false);
});

// ---------------------------------------------------------------- light

test("lit rooms light their floor and walls, dark rooms do not, and the switch is per room", () => {
  const rows = [
    "%%%%%%%%%%%%%",
    "%###########%",
    "%#:::#.....#%",
    "%#:::+.....#%",
    "%#:::#.....#%",
    "%###########%",
    "%%%%%%%%%%%%%",
  ];
  const map = parseAscii(rows);
  const lit = map.rooms.find((r) => r.lit)!;
  const dark = map.rooms.find((r) => !r.lit)!;
  const L = lightMask(map, initialSight(map));
  const at = (x: number, y: number) => L[y * map.w + x]!;
  assert.equal(at(3, 3), LIGHT.ROOM);
  assert.equal(at(1, 3), LIGHT.ROOM, "its wall");
  assert.equal(at(5, 3), LIGHT.ROOM, "its door");
  assert.equal(at(8, 3), 0);
  assert.equal(at(11, 3), 0, "the dark room's far wall");
  const rooms = new Uint8Array(map.rooms.length);
  rooms[dark.id] = 1;
  const L2 = lightMask(map, state(map, { rooms }));
  assert.equal(L2[3 * map.w + 3], 0);
  assert.equal(L2[3 * map.w + 8], LIGHT.ROOM);
  assert.ok(lit.id !== dark.id);
});

const LAWN = [
  "%%%%%%%%%%%%%%%",
  "%,,,,,,,,,,,,,%",
  "%,,,,,,,,,,,,,%",
  "%,,,,,,,,#,,,,%",
  "%,,,,,,,,#,,,,%",
  "%,,,,,,*,#,,,,%",
  "%,,,,,,,,#,,,,%",
  "%,,,,,,,,#,,,,%",
  "%,,,,,,,,,,,,,%",
  "%,,,,,,,,,,,,,%",
  "%,,,,,,,,,,,,,%",
  "%%%%%%%%%%%%%%%",
];

test("a lamp lights a pool of radius 4, not behind a wall, and not once smashed", () => {
  const map = parseAscii(LAWN);
  const L = lightMask(map, initialSight(map));
  const at = (x: number, y: number) => L[y * map.w + x]!;
  assert.equal(at(7, 5), LIGHT.LAMP);
  assert.equal(at(7, 1), LIGHT.LAMP, "4 tiles north");
  assert.equal(at(3, 5), LIGHT.LAMP, "4 tiles west");
  assert.equal(at(4, 3), LIGHT.LAMP, "3, 2 away");
  assert.equal(at(4, 2), 0, "3, 3 away is past the radius");
  assert.equal(at(3, 4), 0, "4, 1 away is past the radius");
  assert.equal(at(8, 5), LIGHT.LAMP);
  assert.equal(at(10, 5), 0, "behind the wall");
  assert.equal(at(11, 5), 0, "behind the wall");
  assert.equal(at(9, 8), LIGHT.LAMP, "around the wall's end");
  const off = lightMask(map, state(map, { lamps: [0] }));
  assert.ok(off.every((v) => v === 0));
});

test("a flashlight lights a 60° cone of 7 tiles in its holder's sight, and the holder's tile", () => {
  const rows = [
    "%%%%%%%%%%%%%%",
    "%,,,,,,,,,,,,%",
    "%,,,,,,,,,,,,%",
    "%,,,,,,,,,,,,%",
    "%,,,,,,,,,,,,%",
    "%,,,,,,,,,,,,%",
    "%,,,,,,,,,,,,%",
    "%,,,,,,,,,,,,%",
    "%,,,,,,,,,,,,%",
    "%,,,,,,,,,,,,%",
    "%%%%%%%%%%%%%%",
  ];
  const map = parseAscii(rows);
  const f: Flashlight = { x: 2.5, y: 5.5, facing: 0, on: true };
  const lit = (fl: Flashlight, m = map) => {
    const L = lightMask(m, state(m, { flashlights: [fl] }));
    return (x: number, y: number) => (L[y * m.w + x]! & LIGHT.TORCH) !== 0;
  };
  const at = lit(f);
  assert.ok(at(2, 5), "own tile");
  assert.ok(at(9, 5), "7 tiles ahead");
  assert.ok(!at(10, 5), "8 tiles ahead");
  assert.ok(at(6, 7), "27° off");
  assert.ok(!at(5, 8), "45° off");
  assert.ok(!at(1, 5), "behind");
  assert.ok(!at(2, 4), "beside");
  const south = lit({ ...f, facing: 90 });
  assert.ok(south(2, 9) && !south(5, 5));
  const off = lit({ ...f, on: false });
  assert.ok(!off(2, 5) && !off(5, 5));
  const nan = lit({ ...f, facing: NaN });
  assert.ok(nan(2, 5) && !nan(5, 5), "a bad facing lights the own tile only");
  // blocked by cover
  const treed = parseAscii(rows.map((r, y) => (y === 5 ? "%,,,,T,,,,,,,%" : r)));
  const t = lit(f, treed);
  assert.ok(t(4, 5) && !t(6, 5) && !t(8, 5));
  // the exact position matters for the cone, not just the tile
  const edge = lit({ x: 2.99, y: 5.5, facing: 0, on: true });
  assert.ok(edge(10, 5) === false && edge(9, 5));
  assert.ok(FLASHLIGHT_RANGE === 7);
});

test("inCone: angle, range, apex, wrap-around and bad input", () => {
  assert.ok(inCone(0, 0, 0, 60, 7, 5, 0));
  assert.ok(inCone(0, 0, 0, 60, 7, 5, 2.8)); // 29.2°
  assert.ok(!inCone(0, 0, 0, 60, 7, 5, 3)); // 31°
  assert.ok(inCone(0, 0, 0, 60, 7, 7, 0));
  assert.ok(!inCone(0, 0, 0, 60, 7, 7.01, 0));
  assert.ok(inCone(0, 0, 0, 60, 7, 0, 0));
  assert.ok(inCone(0, 0, 350, 60, 7, 5, 1), "wraps past 0°");
  assert.ok(inCone(0, 0, -170, 60, 7, -5, 1), "negative facings");
  assert.ok(inCone(0, 0, 90, 60, 7, 0, 5), "90 is south (y down)");
  assert.ok(!inCone(0, 0, 90, 60, 7, 0, -5));
  assert.ok(!inCone(0, 0, NaN, 60, 7, 1, 0));
  assert.ok(!inCone(0, 0, 0, 60, -1, 0, 0));
});

// ---------------------------------------------------------------- seeing

test("in the dark one sees only within one's own radius; light is seen from afar", () => {
  const map = parseAscii(LAWN.map((r) => r.replace("*", ",")));
  const st = initialSight(map);
  const count = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);
  const guard = seenMask(map, st, { x: 3.5, y: 5.5, radius: GUARD_RADIUS });
  assert.equal(count(guard), 9);
  const thief = seenMask(map, st, { x: 3.5, y: 5.5, radius: THIEF_RADIUS });
  assert.equal(count(thief), 21);
  assert.ok(isSeen(map, thief, 5.9, 6.1) && !isSeen(map, thief, 5.5, 7.5));
  // a guard's flashlight far away: its cone and the guard's tile are seen
  const fl: Flashlight = { x: 12.5, y: 9.5, facing: 180, on: true };
  const far = seenMask(map, state(map, { flashlights: [fl] }), { x: 3.5, y: 5.5, radius: THIEF_RADIUS });
  assert.ok(isSeen(map, far, 12.5, 9.5), "the guard's own tile");
  assert.ok(isSeen(map, far, 8.5, 9.5), "the cone");
  assert.ok(!isSeen(map, far, 12.5, 2.5));
});

test("a lit room is seen through an open door from outside, a dark one only up close", () => {
  const lit = ROOM.map((r) => r.replace(/\./g, ":"));
  const { map, at } = fixture(lit);
  const v = { x: at["@"]![0] + 0.5, y: at["@"]![1] + 0.5, radius: THIEF_RADIUS };
  const closed = seenMask(map, initialSight(map), v);
  assert.ok(!isSeen(map, closed, 5.5, 4.5));
  const open = seenMask(map, state(map, { doors: [1] }), v);
  assert.ok(isSeen(map, open, 5.5, 5.5) && isSeen(map, open, 3.5, 5.5) && !isSeen(map, open, 3.5, 3.5));
  // the same room dark: only the tiles within the radius
  const dark = parseAscii(ROOM.map((r) => r.replace("@", ",")));
  const d = seenMask(dark, state(dark, { doors: [1] }), v);
  assert.ok(isSeen(dark, d, 5.5, 3.5) && !isSeen(dark, d, 5.5, 4.5));
});

test("bad viewers see nothing or are clamped; missing state is closed and dark", () => {
  const { map } = fixture(ROOM);
  const st = initialSight(map);
  const empty = (m: Uint8Array) => m.every((v) => v === 0);
  assert.ok(empty(seenMask(map, st, { x: NaN, y: 2, radius: 2 })));
  assert.ok(empty(seenMask(map, st, { x: 2, y: -Infinity, radius: 2 })));
  assert.equal(tileAt(map, -5, 1.5), 1 * map.w);
  assert.equal(tileAt(map, 1e9, 1e9), map.w * map.h - 1);
  const clamped = seenMask(map, st, { x: -5, y: 1.5, radius: NaN });
  assert.ok(isSeen(map, clamped, 0.5, 1.5) && !isSeen(map, clamped, 1.5, 1.5), "clamped onto the edge, no radius: only its own tile");
  const bare = { doors: [], rooms: [], lamps: [], flashlights: [] } as SightState;
  const m = seenMask(map, bare, { x: 5.5, y: 1.5, radius: GUARD_RADIUS });
  assert.equal(m.reduce((a, b) => a + b, 0), 9);
  const junk = { doors: null, rooms: undefined, lamps: 3, flashlights: [null, { x: "a" }] } as unknown as SightState;
  assert.doesNotThrow(() => seenMask(map, junk, { x: 5.5, y: 1.5, radius: 2 }));
  assert.ok(!isSeen(map, m, -1, 0) && !isSeen(map, m, NaN, 1) && !isSeen(map, m, map.w, 1));
});

// ---------------------------------------------------------------- cameras

const GALLERY = [
  "%%%%%%%%%%%%%%%",
  "%#############%",
  "%#:::::::::::#%",
  "%#:::::::::::#%",
  "%#:::::::o:::#%",
  "%#:::::::::::#%",
  "%#:::::::::::#%",
  "%###:#####:###%",
  "%%%%%%%%%%%%%%%",
];

function camera(map: Blueprint, x: number, y: number, angle: number): Camera {
  return { id: 0, x, y, i: y * map.w + x, angle, fov: 50, range: 8, room: 0 };
}

test("a camera sees a lit thief in its cone and sight, not in the dark", () => {
  const rows = GALLERY.map((r) => r.replace("###:#####:###", "#############").replace("o", "#"));
  const map = parseAscii(rows);
  const cam = camera(map, 1, 4, 0); // on the west wall, looking east
  const world = prepare(map, initialSight(map));
  assert.ok(cameraSees(world, cam, 4.5, 4.5));
  assert.ok(cameraSees(world, cam, 8.5, 4.5), "7 tiles away");
  assert.ok(!cameraSees(world, cam, 9.5, 5.5), "8.06 tiles away is past 8");
  assert.ok(!cameraSees(world, cam, 10.5, 4.5), "behind the pillar");
  assert.ok(!cameraSees(world, cam, 12.5, 2.5), "past the range");
  assert.ok(!cameraSees(world, cam, 3.5, 2.5), "outside the 50° cone");
  assert.ok(cameraSees(world, cam, 6.5, 2.5), "22° off");
  assert.ok(!cameraSees(world, cam, NaN, 4.5));
  const dark = prepare(map, state(map, { rooms: [0] }));
  assert.ok(!cameraSees(dark, cam, 4.5, 4.5), "needs light");
  // a flashlight lights the thief for the camera
  const torch = prepare(map, state(map, { rooms: [0], flashlights: [{ x: 2.5, y: 4.5, facing: 0, on: true }] }));
  assert.ok(cameraSees(torch, cam, 5.5, 4.5));
  // the view mask agrees with cameraSees
  for (const w of [world, dark, torch]) {
    const view = cameraView(w, cam);
    for (let i = 0; i < map.w * map.h; i++) {
      if (OPAQUE[map.tiles[i]!]) continue;
      assert.equal(view[i] === 1, cameraSees(w, cam, (i % map.w) + 0.5, Math.floor(i / map.w) + 0.5));
    }
  }
  const unlit = cameraView(dark, cam, false);
  assert.ok(unlit[4 * map.w + 4] === 1 && cameraView(dark, cam)[4 * map.w + 4] === 0);
});

test("a camera does not see through a closed door", () => {
  const rows = [
    "%%%%%%%%%%%%%",
    "%###########%",
    "%#:::+:::::#%",
    "%###########%",
    "%%%%%%%%%%%%%",
  ];
  const map = parseAscii(rows);
  const cam = camera(map, 1, 2, 0);
  assert.ok(!cameraSees(prepare(map, initialSight(map)), cam, 7.5, 2.5));
  assert.ok(cameraSees(prepare(map, state(map, { doors: [1] })), cam, 7.5, 2.5));
  assert.ok(cameraSees(prepare(map, initialSight(map)), cam, 3.5, 2.5));
});

// ---------------------------------------------------------------- wire

test("seen masks round-trip through the wire form; garbage gives null", () => {
  const map = parseAscii(MESSY);
  const m = seenMask(map, state(map, { doors: [1, 1, 1, 1, 1, 1] }), { x: 12.5, y: 5.5, radius: THIEF_RADIUS });
  const s = encodeSeen(m);
  assert.deepEqual(decodeSeen(s, m.length), m);
  assert.ok(s.length < 60, `short: ${s.length}`);
  for (const mask of [new Uint8Array(0), new Uint8Array(10), new Uint8Array(10).fill(1), Uint8Array.from([1, 0, 1, 1, 0, 0, 0, 1])]) {
    assert.deepEqual(decodeSeen(encodeSeen(mask), mask.length), mask);
  }
  assert.deepEqual(decodeSeen(encodeSeen([0, 3, 0, true as unknown as number]), 4), Uint8Array.from([0, 1, 0, 1]));
  assert.equal(decodeSeen(s, m.length - 1), null);
  assert.equal(decodeSeen(s, m.length + 1), null);
  assert.equal(decodeSeen("!!", 8), null);
  assert.equal(decodeSeen(42, 8), null);
  assert.equal(decodeSeen(s, -1), null);
  assert.equal(decodeSeen(s, NaN), null);
});

// ---------------------------------------------------------------- speed

test("fast enough: 8 viewers at 20 Hz on an 86×54 map", () => {
  const map = syntheticEstate();
  assert.equal(map.w, 86);
  assert.equal(map.h, 54);
  const r = benchmark(map, 100);
  // a tick (prepare + 8 seen masks + 8 encodings) must stay far below the 50 ms step
  assert.ok(r.tickMs < 10, `a tick took ${r.tickMs.toFixed(3)} ms`);
});
