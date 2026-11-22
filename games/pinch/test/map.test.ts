import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { pickCatalogue } from "../game/items.ts";
import {
  ascii,
  CAMERA_FOV,
  CAMERA_RANGE,
  checkEstate,
  COVER,
  decodeBlueprint,
  encodeBlueprint,
  generate,
  inRect,
  lootCount,
  lootPlaces,
  mapSize,
  MIN_LOOT_DEPTH,
  parseAscii,
  ROOM_KINDS,
  sidesOf,
  stepsFrom,
  TILE,
  tryEstate,
  type Estate,
} from "../game/map.ts";
import { Rng } from "../game/rng.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
/** Seeds per player count for the invariants (PINCH_SEEDS=200 for a longer run). */
const SEEDS = Number(process.env["PINCH_SEEDS"] ?? 40);

const cache = new Map<string, Estate>();
function estate(players: number, seed: number): Estate {
  const k = `${players}:${seed}`;
  let e = cache.get(k);
  if (!e) cache.set(k, (e = generate(players, seed)));
  return e;
}

function invariants(e: Estate): void {
  const m = e.map;
  const { w, h } = m;
  const at = (i: number) => `(${i % w},${Math.floor(i / w)})`;
  assert.deepEqual({ w, h }, mapSize(e.players));
  assert.equal(checkEstate(e), null);
  assert.equal(m.buildings.length, e.players <= 4 ? 1 : 2);
  assert.equal(m.buildings.filter((b) => b.main).length, 1);
  // the map's border never lets anyone off it
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) assert.ok(!COVER[m.tiles[y * w + x]!] && m.tiles[y * w + x] !== TILE.FLOOR, `border ${x},${y}`);
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) assert.notEqual(m.tiles[y * w + x], TILE.FLOOR, `border ${x},${y}`);
  // rooms: kinds, sizes, tiles
  const kinds = m.rooms.map((r) => r.kind);
  for (const k of kinds) assert.ok(ROOM_KINDS.includes(k));
  assert.equal(kinds.filter((k) => k === "vault").length, 1);
  assert.equal(kinds.filter((k) => k === "security").length, 1);
  assert.equal(kinds.filter((k) => k === "shed").length, 1);
  assert.ok(kinds.filter((k) => k === "foyer").length >= 1);
  const nth = new Map<string, number>();
  for (const r of m.rooms) {
    assert.equal(r.nth, nth.get(r.kind) ?? 0, `nth of ${r.kind}`);
    nth.set(r.kind, r.nth + 1);
    if (r.kind !== "corridor") assert.ok(r.rect.w >= 3 && r.rect.h >= 3 && r.rect.w <= 9 && r.rect.h <= 9, `room ${r.id} ${r.kind} ${JSON.stringify(r.rect)}`);
    for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) {
      for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) {
        const t = m.tiles[y * w + x];
        assert.ok(t === TILE.FLOOR || t === TILE.FURNITURE, `room tile ${x},${y}`);
        assert.equal(m.roomAt[y * w + x], r.id);
        assert.equal(m.areaAt[y * w + x], -1);
      }
    }
    assert.ok(r.doors.length >= 1, `room ${r.id} has a door`);
    assert.equal(new Set(r.switches).size, r.switches.length);
    for (const s of r.switches) {
      assert.equal(m.roomAt[s], r.id);
      assert.equal(m.tiles[s], TILE.FLOOR, `switch ${at(s)} free`);
    }
    if (r.building >= 0) assert.ok(inRect(m.buildings[r.building]!.rect, r.rect.x, r.rect.y));
  }
  const vault = m.rooms.find((r) => r.kind === "vault")!;
  assert.equal(vault.windows.length, 0);
  assert.equal(vault.doors.length, 1);
  assert.equal(vault.lit, false);
  assert.ok(m.doors[vault.doors[0]!]!.locked);
  // doors and windows sit in walls, between the rooms they name
  for (const d of m.doors) {
    assert.equal(m.tiles[d.i], TILE.DOOR);
    assert.equal(m.doorAt[d.i], d.id);
    const [a, b] = sidesOf(d);
    assert.deepEqual([m.roomAt[a[1] * w + a[0]], m.roomAt[b[1] * w + b[0]]], d.rooms, `door ${d.id}`);
    assert.equal(d.outside, d.rooms.includes(-1));
    const along = d.wall === "h" ? [[d.x - 1, d.y], [d.x + 1, d.y]] : [[d.x, d.y - 1], [d.x, d.y + 1]];
    for (const [x, y] of along) assert.ok([TILE.WALL, TILE.SHED].includes(m.tiles[y! * w + x!] as 1 | 10), `door ${d.id} in a wall`);
    for (const [x, y] of [a, b]) assert.equal(m.tiles[y * w + x], TILE.FLOOR, `door ${d.id} free on both sides`);
  }
  for (let b = 0; b < m.buildings.length; b++) {
    const out = m.doors.filter((d) => d.outside && m.rooms[Math.max(...d.rooms)]!.building === b).length;
    assert.ok(out >= 2 && out <= 3, `building ${b}: ${out} doors out`);
    const win = m.windows.filter((p) => m.rooms[p.room]!.building === b).length;
    assert.ok(win >= 1 && win <= 6, `building ${b}: ${win} windows`);
  }
  for (const p of m.windows) {
    assert.equal(m.tiles[p.i], TILE.WINDOW);
    const sides = sidesOf(p).map(([x, y]) => m.roomAt[y * w + x]);
    assert.ok(sides.includes(p.room) && sides.includes(-1), `window ${p.id} between its room and outside`);
  }
  // outside: every walkable tile outside a room is in an area
  for (let i = 0; i < w * h; i++) {
    if (m.tiles[i] === TILE.FLOOR && m.roomAt[i]! < 0) assert.ok(m.areaAt[i]! >= 0, `area at ${at(i)}`);
    if (m.areaAt[i]! >= 0) assert.equal(m.roomAt[i], -1);
  }
  for (const a of m.areas) assert.ok(m.areaAt.includes(a.id), `area ${a.id} has tiles`);
  // spots, gates, lamps, cameras
  assert.ok(m.spots.length >= 3 && m.spots.length <= 4);
  for (const s of m.spots) {
    for (let y = s.rect.y; y < s.rect.y + s.rect.h; y++) for (let x = s.rect.x; x < s.rect.x + s.rect.w; x++) assert.equal(m.tiles[y * w + x], TILE.FLOOR);
    assert.ok(s.area >= 0);
  }
  assert.ok(m.gates.length >= 2 && m.gates.length <= 4, `${m.gates.length} gates`);
  for (const g of m.gates) assert.equal(m.tiles[g.rect.y * w + g.rect.x], TILE.FLOOR);
  assert.ok(m.lamps.length >= 4, `${m.lamps.length} lamps`);
  for (const l of m.lamps) assert.equal(m.tiles[l.i], TILE.FLOOR);
  for (const c of m.cameras) {
    assert.ok(m.tiles[c.i] === TILE.WALL || m.tiles[c.i] === TILE.LOT_WALL, `camera ${c.id} on a wall`);
    assert.ok(c.angle >= 0 && c.angle < 360 && c.fov === CAMERA_FOV && c.range === CAMERA_RANGE);
  }
  assert.ok(m.cameras.some((c) => c.room < 0), "a camera outside");
  // props: blocking ones are on blocking tiles
  for (const p of m.props) {
    for (let y = p.rect.y; y < p.rect.y + p.rect.h; y++) {
      for (let x = p.rect.x; x < p.rect.x + p.rect.w; x++) {
        const t = m.tiles[y * w + x]!;
        if (p.block === 1) assert.equal(t, TILE.FURNITURE, `${p.kind} at ${x},${y}`);
        if (p.block === 2) assert.ok(COVER[t], `${p.kind} at ${x},${y}`);
        if (p.block === 0) assert.equal(t, TILE.FLOOR);
        if (p.room >= 0) assert.equal(m.roomAt[y * w + x], p.room);
      }
    }
  }
  // the workbench, guards' start
  const wb = m.props[m.workbench.prop]!;
  assert.equal(wb.kind, "workbench");
  assert.ok(["garage", "shed"].includes(m.rooms[m.workbench.room]!.kind));
  assert.equal(m.tiles[m.workbench.access], TILE.FLOOR);
  assert.equal(m.rooms[m.security]!.kind, "security");
  assert.ok(m.spawn.length >= Math.max(e.players - 1, 4));
  for (const s of m.spawn) {
    assert.equal(m.tiles[s], TILE.FLOOR);
    assert.equal(m.roomAt[s], m.security);
  }
  // loot places: deep, on holders, wings
  assert.ok(e.places.length >= lootCount(e.players) + 2, `${e.places.length} places`);
  assert.equal(e.places.filter((p) => p.keep === "pedestal").length, 1);
  assert.equal(m.rooms[e.places.find((p) => p.keep === "pedestal")!.room]!.kind, "vault");
  const fromOut = stepsFrom(m.tiles, w, h, m.doors.filter((d) => d.outside).map((d) => d.i));
  for (const p of e.places) {
    assert.ok(p.depth > MIN_LOOT_DEPTH && fromOut[p.access] === p.depth);
    assert.equal(m.tiles[p.i], TILE.FURNITURE);
    assert.equal(m.tiles[p.access], TILE.FLOOR);
    assert.equal(Math.abs((p.i % w) - (p.access % w)) + Math.abs(Math.floor(p.i / w) - Math.floor(p.access / w)), 1);
    const prop = m.props[p.prop]!;
    assert.ok(inRect(prop.rect, p.x, p.y));
    assert.equal(p.room, prop.room);
    assert.equal(p.wing.building, m.rooms[p.room]!.building);
    const B = m.buildings[p.wing.building]!.rect;
    assert.ok(B.w >= B.h ? ["e", "w"].includes(p.wing.half) : ["n", "s"].includes(p.wing.half));
  }
  assert.ok(e.car >= 0 && e.car < m.spots.length);
}

for (let players = 3; players <= 8; players++) {
  test(`estates for ${players} players pass every check (${SEEDS} seeds)`, () => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const e = estate(players, seed);
      try {
        invariants(e);
      } catch (err) {
        console.log(ascii(e.map, { car: e.car, places: e.places }));
        throw new Error(`${players} players, seed ${seed}: ${(err as Error).stack}`);
      }
    }
  });
}

test("the generator is deterministic and tries are independent", () => {
  assert.equal(ascii(generate(5, 77).map), ascii(generate(5, 77).map));
  assert.notEqual(ascii(generate(5, 77).map), ascii(generate(5, 78).map));
  const e = generate(6, 3);
  const again = tryEstate(6, 3, e.attempt);
  assert.ok(typeof again !== "string");
  assert.equal(ascii(again.map, again), ascii(e.map, e));
});

test("the generator is quick enough", () => {
  const t0 = performance.now();
  for (let seed = 1000; seed < 1010; seed++) generate(8, seed);
  const ms = (performance.now() - t0) / 10;
  assert.ok(ms < 100, `${ms.toFixed(1)} ms a map`);
});

test("the blueprint round-trips through its wire form, as JSON", () => {
  for (const [p, seed] of [[3, 1], [5, 2], [8, 3]] as const) {
    const m = estate(p, seed).map;
    const json = JSON.stringify(encodeBlueprint(m));
    assert.ok(json.length < 16_000, `${json.length} bytes`);
    const back = decodeBlueprint(JSON.parse(json));
    assert.ok(back);
    assert.deepEqual(back, m);
  }
});

test("the wire form holds no secrets", () => {
  const e = estate(5, 9);
  const json = JSON.stringify(encodeBlueprint(e.map));
  for (const k of ["car", "places", "depth", "keep", "wing"]) assert.ok(!json.includes(`"${k}"`), k);
  // every spot looks the same: the car is not in it
  const other = { ...e, car: (e.car + 1) % e.map.spots.length };
  assert.equal(JSON.stringify(encodeBlueprint(other.map)), json);
});

test("decodeBlueprint refuses tampered wire forms", () => {
  const good = encodeBlueprint(estate(4, 5).map);
  const bad: unknown[] = [
    { ...good, v: 2 },
    { ...good, w: good.w + 1 },
    { ...good, cells: good.cells.slice(0, -4) },
    { ...good, doors: [[0, 0, 0, -1, -1, 0]] },
    { ...good, rooms: [[99, 0, 0, 1, 1, 3, 3, 0]] },
    { ...good, props: [[0, 1, 1, 500, 1, 1, -1, -1]] },
    { ...good, cameras: [[1, 1, 400, 50, 8, -1]] },
    { ...good, spawn: [-3] },
    { ...good, security: 1e6 },
    { ...good, workbench: [1e6, 0, 0] },
    { ...good, front: "up" },
    { ...good, lamps: [[1.5, 2]] },
  ];
  for (const b of bad) assert.equal(decodeBlueprint(b), null);
  assert.equal(decodeBlueprint(JSON.parse(JSON.stringify(good)))?.w, good.w);
});

test("lootPlaces feeds the catalogue: every item gets a distinct place that suits it", () => {
  for (let p = 3; p <= 8; p++) {
    const e = estate(p, 4);
    const places = lootPlaces(e);
    const items = pickCatalogue(lootCount(p), () => new Rng(p).float(), places);
    assert.ok(items.length >= 8, `${items.length} items for ${p}`);
    const used = items.map((it) => it.place);
    assert.equal(new Set(used).size, used.length);
    for (const it of items) assert.ok(it.place >= 0 && it.place < e.places.length);
  }
});

test("the fixtures still look the same", () => {
  for (const [p, seed] of [[3, 1], [5, 1], [8, 2]] as const) {
    const e = estate(p, seed);
    const text = `${ascii(e.map, { car: e.car, places: e.places })}\n`;
    const file = join(FIXTURES, `estate-${p}-${seed}.txt`);
    if (process.env["UPDATE_FIXTURES"]) writeFileSync(file, text);
    assert.equal(text, readFileSync(file, "utf8"), `${file} (UPDATE_FIXTURES=1 npm test to accept a change)`);
  }
});

test("parseAscii reads rooms, doors, windows, lamps and spots", () => {
  const m = parseAscii([
    "%%%%%%%%%%",
    "%,,*,,,,,%",
    "%,#####,,%",
    "%,#:.o#,,%",
    "%,#...',,%",
    "%,##+##,P%",
    "%,#..X,,P%",
    "%,####,,,%",
    "%%%%%%%%%%",
  ]);
  assert.equal(m.rooms.length, 2);
  assert.ok(m.rooms[0]!.lit && !m.rooms[1]!.lit);
  assert.deepEqual(m.rooms[0]!.rect, { x: 3, y: 3, w: 3, h: 2 });
  assert.equal(m.doors.length, 2);
  assert.deepEqual(m.doors[0]!.rooms, [0, 1]);
  assert.equal(m.doors[0]!.wall, "h");
  assert.deepEqual(m.doors[1]!.rooms, [1, -1]);
  assert.ok(m.doors[1]!.locked && m.doors[1]!.outside && m.doors[1]!.wall === "v");
  assert.equal(m.windows.length, 1);
  assert.equal(m.windows[0]!.room, 0);
  assert.equal(m.lamps.length, 1);
  assert.equal(m.spots.length, 1);
  assert.deepEqual(m.spots[0]!.rect, { x: 8, y: 5, w: 1, h: 2 });
  assert.equal(m.tiles[3 * m.w + 5], TILE.FURNITURE);
  assert.equal(m.props.length, 1);
  assert.deepEqual(m.rooms[0]!.switches, [4 * 10 + 4]);
  assert.deepEqual(m.rooms[1]!.switches, [6 * 10 + 4]);
});
