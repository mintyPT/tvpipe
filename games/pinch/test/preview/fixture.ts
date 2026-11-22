/**
 * Writes the preview's sample (test/preview/sample-P-S.json): a generated
 * estate's blueprint (typed arrays as plain arrays), its loot with items,
 * and a made-up moment of a heist: a guard with the flashlight in a
 * corridor, the thief nearby, what the guard sees (sight.ts) and has
 * seen, the light, an ink that spread from the parking spots.
 *
 *   node test/preview/fixture.ts [players=5] [seed=1]
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ITEMS } from "../../game/items.ts";
import { generate, lootCount, TILE, type Blueprint } from "../../game/map.ts";
import { initialSight, prepare, seenBy } from "../../game/sight.ts";

const args = process.argv.slice(2).map(Number);
const players = args[0] || 5;
const seed = args[1] || 1;
const e = generate(players, seed);
const map = e.map;
const W = map.w;

// A corridor (or the biggest room) for the guard.
const corridor = map.rooms.filter((r) => r.kind === "corridor").sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0] ?? map.rooms[0]!;
const wide = corridor.rect.w >= corridor.rect.h;
const gx = corridor.rect.x + (wide ? Math.floor(corridor.rect.w * 0.3) : Math.floor(corridor.rect.w / 2)) + 0.5;
const gy = corridor.rect.y + (wide ? Math.floor(corridor.rect.h / 2) : Math.floor(corridor.rect.h * 0.3)) + 0.5;
const facing = wide ? 0 : 90;
const tx = wide ? gx + 4.2 : gx + 0.1;
const ty = wide ? gy + 0.2 : gy + 4.2;

const state = initialSight(map);
const doors = new Uint8Array(map.doors.length);
map.doors.forEach((d, k) => (doors[k] = d.rooms.includes(corridor.id) || d.outside || k % 3 === 0 ? 1 : 0));
state.doors = doors;
const rooms = Uint8Array.from(map.rooms, (r) => (r.lit ? 1 : 0));
rooms[corridor.id] = 0;
state.rooms = rooms;
const lamps = new Uint8Array(map.lamps.length).fill(1);
if (lamps.length > 2) lamps[1] = 0;
state.lamps = lamps;
state.flashlights = [{ x: gx, y: gy, facing, on: true }];
const world = prepare(map, state);
const seen = seenBy(world, { x: gx, y: gy, radius: 1.5 });

// A second moment: a guard in the biggest lit room (or the biggest), its door open, flashlight off.
const litRoom = [...map.rooms].filter((r) => r.kind !== "corridor").sort((a, b) => Number(rooms[b.id]) - Number(rooms[a.id]) || b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0]!;
const g2 = { x: litRoom.rect.x + litRoom.rect.w / 2 + 0.3, y: litRoom.rect.y + litRoom.rect.h / 2 + 0.2, facing: 200 };
for (const d of litRoom.doors) doors[d] = 1;
const state2 = { ...state, doors, flashlights: [{ x: gx, y: gy, facing, on: true }] };
const world2 = prepare(map, state2);
const seen2 = seenBy(world2, { x: g2.x, y: g2.y, radius: 1.5 });

// Memory: what the guard saw walking in from the security office.
const memory = new Float64Array(W * map.h).fill(-1);
const sec = map.rooms[map.security]!.rect;
const path: [number, number][] = [];
for (let k = 0; k <= 8; k++) {
  const t = k / 8;
  path.push([sec.x + sec.w / 2 + (gx - sec.x - sec.w / 2) * t, sec.y + sec.h / 2 + (gy - sec.y - sec.h / 2) * t]);
}
path.forEach(([x, y], k) => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (map.tiles[iy * W + ix] !== TILE.FLOOR) return;
  const s = seenBy(world, { x, y, radius: 3.5 });
  for (let i = 0; i < s.length; i++) if (s[i]) memory[i] = 100 + k * 6;
});
const now = 160;

// The ink: from the spots, spread 28 steps over walkable ground and doors.
const ink = new Float32Array(W * map.h);
const dist = new Int32Array(W * map.h).fill(-1);
const queue: number[] = [];
for (const s of map.spots) {
  for (let y = s.rect.y; y < s.rect.y + s.rect.h; y++) for (let x = s.rect.x; x < s.rect.x + s.rect.w; x++) {
    dist[y * W + x] = 0;
    queue.push(y * W + x);
  }
}
const pass = (t: number) => t === TILE.FLOOR || t === TILE.DOOR || t === TILE.WINDOW;
for (let q = 0; q < queue.length; q++) {
  const i = queue[q]!;
  if (dist[i]! >= 30) continue;
  const x = i % W;
  for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
    if (j < 0 || j >= dist.length || dist[j]! >= 0 || !pass(map.tiles[j]!)) continue;
    dist[j] = dist[i]! + 1;
    queue.push(j);
  }
}
for (let i = 0; i < ink.length; i++) if (dist[i]! >= 0) ink[i] = 1 - dist[i]! / 40;
// A Clear mark erased the foyer (or the first room).
const cleared = map.rooms.find((r) => r.kind === "foyer") ?? map.rooms[0]!;
for (let y = cleared.rect.y; y < cleared.rect.y + cleared.rect.h; y++) for (let x = cleared.rect.x; x < cleared.rect.x + cleared.rect.w; x++) ink[y * W + x] = 0;

// Loot: an item per place, the valuable ones deep.
const places = [...e.places].sort((a, b) => b.depth - a.depth).slice(0, lootCount(players));
const byValue = [...ITEMS].sort((a, b) => b.value - a.value);
const loot = places.map((p, k) => {
  const pool = byValue.filter((it) => it.keep.includes(p.keep));
  const it = pool[(k * 7) % Math.max(1, pool.length)] ?? byValue[k % byValue.length]!;
  return { x: p.x, y: p.y, icon: it.id, large: it.size === "large", tagged: it.tagged, keep: p.keep, empty: k === 3 };
});

const plain = (m: Blueprint) => ({
  ...m,
  tiles: [...m.tiles],
  floors: [...m.floors],
  roomAt: [...m.roomAt],
  areaAt: [...m.areaAt],
  doorAt: [...m.doorAt],
  windowAt: [...m.windowAt],
});

const out = {
  players,
  seed,
  map: plain(map),
  car: e.car,
  loot,
  guard: { x: gx, y: gy, facing },
  thief: { x: tx, y: ty, facing: facing + 180 },
  cleared: cleared.id,
  now,
  seen: [...seen],
  guard2: g2,
  seen2: [...seen2],
  light2: [...world2.light],
  memory: [...memory],
  light: [...world.light],
  doors: [...doors],
  rooms: [...rooms],
  lamps: [...lamps],
  ink: [...ink].map((v) => Math.round(v * 100) / 100),
};
const file = join(dirname(fileURLToPath(import.meta.url)), `sample-${players}-${seed}.json`);
writeFileSync(file, JSON.stringify(out));
console.log(`wrote ${file}: ${map.w}×${map.h}, ${map.rooms.length} rooms, ${loot.length} places, guard at ${gx},${gy} in ${corridor.kind}`);
