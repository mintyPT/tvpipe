/**
 * Sight and light (docs/pinch-design.md §4, §5, §7): what blocks sight,
 * symmetric shadowcasting, the light on every tile, what a player sees,
 * cones (flashlights, the hold, cameras) and a compact wire form of a
 * seen mask for phone frames. Pure and deterministic; the host and the
 * phones (prediction of the fog) run the same code.
 *
 * Coordinates as in map.ts: positions are floats in tiles (tile `(x, y)`
 * covers `[x, x + 1) × [y, y + 1)`), angles degrees, 0 = east, 90 =
 * south. Sight is from tile to tile (the centre of the viewer's tile),
 * cones are from the exact position to tile centres.
 *
 * Per tick: {@link prepare}`(map, state)` once (the opacity grid and the
 * light), then {@link seenBy}`(world, viewer)` per player and
 * {@link cameraSees} / {@link lineOfSight} / {@link inCone} as needed.
 * {@link seenMask} does both for a one-off.
 *
 * Nothing here throws on bad input: positions that are not finite give
 * empty masks and `false`, finite ones are clamped onto the map, missing
 * state entries count as closed, dark and smashed.
 *
 * The shadowcasting is Albert Ford's symmetric shadowcasting (written
 * from its description): rows outward per quadrant, slopes as exact
 * integer fractions, a floor tile is visible when its centre lies inside
 * the visible sector, walls when any part does. Floor tiles are
 * symmetric: A sees B iff B sees A.
 */

import { VarintReader, VarintWriter, fromBase64, toBase64 } from "./codec.ts";
import { LAMP_RADIUS, OPAQUE, TILE, type Blueprint, type Camera } from "./map.ts";

// ---------------------------------------------------------------- constants

/** Flashlight cone (§4): full angle in degrees and reach in tiles. */
export const FLASHLIGHT_FOV = 60;
export const FLASHLIGHT_RANGE = 7;
/** Own radius in the dark (§4), in tiles from the viewer's tile centre. */
export const GUARD_RADIUS = 1.5;
export const THIEF_RADIUS = 2.5;

/** Light bits per tile ({@link lightMask}); lit = nonzero. */
export const LIGHT = {
  /** A lit room (its floor and its walls, doors and windows). */
  ROOM: 1,
  /** A lamp's pool. */
  LAMP: 2,
  /** A flashlight's cone (or its holder's tile). */
  TORCH: 4,
} as const;

// ---------------------------------------------------------------- state

/** A guard's flashlight. `x`, `y`: the guard's position; `facing`: degrees. */
export interface Flashlight {
  x: number;
  y: number;
  facing: number;
  on: boolean;
}

/**
 * The dynamic part of sight and light, owned by the simulation. Arrays
 * are indexed by the blueprint's ids; an entry is on when truthy, a
 * missing entry is off.
 */
export interface SightState {
  /**
   * Per door id: move.ts's door state; only `DOOR_OPEN` (1, or `true`)
   * lets sight through, `DOOR_CLOSED` (0) and `DOOR_LOCKED` (2) block it
   * (windows always do). move.ts's `doorStates(map)` / `World.doors` fit.
   */
  doors: ArrayLike<number | boolean>;
  /** Per room id: its light is on. */
  rooms: ArrayLike<number | boolean>;
  /** Per lamp id: on (false once smashed). */
  lamps: ArrayLike<number | boolean>;
  /** Every guard's flashlight (off ones are ignored). */
  flashlights: readonly Flashlight[];
}

/** The state at the start of a heist: doors closed (0; move.ts's `doorStates` adds LOCKED, also blocking), rooms lit as the map says, lamps on, no flashlights. */
export function initialSight(map: Blueprint): SightState {
  return {
    doors: new Uint8Array(map.doors.length),
    rooms: Uint8Array.from(map.rooms, (r) => (r.lit ? 1 : 0)),
    lamps: new Uint8Array(map.lamps.length).fill(1),
    flashlights: [],
  };
}

/** Who looks: a position and the own radius in the dark ({@link GUARD_RADIUS}, {@link THIEF_RADIUS}). */
export interface Viewer {
  x: number;
  y: number;
  radius: number;
}

/** One tick's sight: the opacity grid and the light, shared by every viewer. */
export interface SightWorld {
  map: Blueprint;
  /** 1 where sight stops: walls, lot wall, edge, windows, cover, closed doors. */
  opaque: Uint8Array;
  /** {@link LIGHT} bits per tile. */
  light: Uint8Array;
}

// ---------------------------------------------------------------- small helpers

const on = (a: ArrayLike<number | boolean> | undefined, i: number): boolean => {
  if (!a || i < 0 || i >= a.length) return false;
  return !!a[i];
};

/** The tile index under a position, clamped onto the map; -1 when not finite. */
export function tileAt(map: { w: number; h: number }, x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(map.w > 0) || !(map.h > 0)) return -1;
  const tx = Math.min(map.w - 1, Math.max(0, Math.floor(x)));
  const ty = Math.min(map.h - 1, Math.max(0, Math.floor(y)));
  return ty * map.w + tx;
}

/** The signed difference `a − b` of two angles, in (−180, 180]. */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

const EPS = 1e-9;

/**
 * Whether point `(px, py)` lies in the cone from `(ox, oy)` facing
 * `facing` degrees, `fov` degrees wide in all, `range` tiles long (edges
 * included). The apex itself is inside. Only geometry: no walls.
 */
export function inCone(ox: number, oy: number, facing: number, fov: number, range: number, px: number, py: number): boolean {
  if (![ox, oy, facing, fov, range, px, py].every(Number.isFinite) || range < 0) return false;
  const dx = px - ox;
  const dy = py - oy;
  const d2 = dx * dx + dy * dy;
  if (d2 > range * range + EPS) return false;
  if (d2 < EPS) return true;
  if (fov >= 360) return true;
  const a = (Math.atan2(dy, dx) * 180) / Math.PI;
  return Math.abs(angleDiff(a, facing)) <= fov / 2 + EPS;
}

// ---------------------------------------------------------------- opacity

const STATIC = new WeakMap<Blueprint, Uint8Array>();

function staticOpacity(map: Blueprint): Uint8Array {
  let s = STATIC.get(map);
  if (s && s.length === map.w * map.h) return s;
  const n = map.w * map.h;
  s = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = map.tiles[i] ?? TILE.EDGE;
    s[i] = (OPAQUE[t] ?? true) ? 1 : 0;
  }
  STATIC.set(map, s);
  return s;
}

/** Whether a door state lets sight through: move.ts's `DOOR_OPEN` (1) or `true` only. */
const isOpen = (doors: ArrayLike<number | boolean> | undefined, id: number): boolean => {
  if (!doors || id < 0 || id >= doors.length) return false;
  const v = doors[id];
  return v === 1 || v === true;
};

/** The opacity grid for these doors: the static blockers plus every door not open (closed or locked). */
export function opacity(map: Blueprint, doors: ArrayLike<number | boolean>): Uint8Array {
  const o = staticOpacity(map).slice();
  for (const d of map.doors) {
    if (d.i >= 0 && d.i < o.length && !isOpen(doors, d.id)) o[d.i] = 1;
  }
  return o;
}

// ---------------------------------------------------------------- shadowcasting

// The scan's parameters live here (no closures, no allocation per row).
let cW = 0;
let cH = 0;
const NONE = new Uint8Array(0);
let cOpaque: Uint8Array = NONE;
let cOx = 0;
let cOy = 0;
let cQ = 0;
let cMax = 0;
let cR2 = 0;
let cOut: Uint8Array | Uint32Array = NONE;
let cVal = 1;
let cTarget = -1;
let cFound = false;

/**
 * One row of a quadrant at `depth`, between slopes `sn/sd` and `en/ed`
 * (denominators positive). Quadrants: 0 north, 1 east, 2 south, 3 west;
 * `col` runs across the row.
 */
function scan(depth: number, sn: number, sd: number, en: number, ed: number): void {
  if (depth > cMax || cFound) return;
  // round half up of depth·start, round half down of depth·end
  const minCol = Math.floor((2 * depth * sn + sd) / (2 * sd));
  const maxCol = Math.ceil((2 * depth * en - ed) / (2 * ed));
  let prev = 0; // 0 none yet, 1 wall, 2 floor
  for (let col = minCol; col <= maxCol; col++) {
    let x: number;
    let y: number;
    if (cQ === 0) {
      x = cOx + col;
      y = cOy - depth;
    } else if (cQ === 1) {
      x = cOx + depth;
      y = cOy + col;
    } else if (cQ === 2) {
      x = cOx + col;
      y = cOy + depth;
    } else {
      x = cOx - depth;
      y = cOy + col;
    }
    const inside = x >= 0 && y >= 0 && x < cW && y < cH;
    const i = y * cW + x;
    const wall = !inside || cOpaque[i] !== 0;
    if (inside && (wall || (col * sd >= depth * sn && col * ed <= depth * en))) {
      const dx = x - cOx;
      const dy = y - cOy;
      if (dx * dx + dy * dy <= cR2) {
        if (cTarget >= 0) {
          if (i === cTarget) {
            cFound = true;
            return;
          }
        } else cOut[i] = cVal;
      }
    }
    if (prev === 1 && !wall) {
      sn = 2 * col - 1;
      sd = 2 * depth;
    } else if (prev === 2 && wall) {
      scan(depth + 1, sn, sd, 2 * col - 1, 2 * depth);
      if (cFound) return;
    }
    prev = wall ? 1 : 2;
  }
  if (prev === 2) scan(depth + 1, sn, sd, en, ed);
}

/** Marks `out[i] = val` for every tile in sight of tile `(ox, oy)` within `radius` (centre to centre). */
function cast(w: number, h: number, opaque: Uint8Array, ox: number, oy: number, radius: number, out: Uint8Array | Uint32Array, val: number): void {
  cW = w;
  cH = h;
  cOpaque = opaque;
  cOx = ox;
  cOy = oy;
  cR2 = radius * radius;
  cMax = Math.min(Math.max(w, h), Math.ceil(radius));
  cOut = out;
  cVal = val;
  cTarget = -1;
  cFound = false;
  out[oy * w + ox] = val;
  for (cQ = 0; cQ < 4; cQ++) scan(1, -1, 1, 1, 1);
  cOut = NONE;
  cOpaque = NONE;
}

/** Whether tile `b` is in sight of tile `a` (same answer as the masks). */
function tileSight(w: number, h: number, opaque: Uint8Array, a: number, b: number): boolean {
  if (a < 0 || b < 0 || a >= w * h || b >= w * h || opaque.length < w * h) return false;
  if (a === b) return true;
  const ax = a % w;
  const ay = (a - ax) / w;
  const bx = b % w;
  const by = (b - bx) / w;
  const dx = bx - ax;
  const dy = by - ay;
  cW = w;
  cH = h;
  cOpaque = opaque;
  cOx = ax;
  cOy = ay;
  cR2 = Infinity;
  cTarget = b;
  cFound = false;
  // A tile on a diagonal or an axis lies in two quadrants; either suffices.
  const quads: [number, number][] = [];
  if (dy < 0 && Math.abs(dx) <= -dy) quads.push([0, -dy]);
  if (dx > 0 && Math.abs(dy) <= dx) quads.push([1, dx]);
  if (dy > 0 && Math.abs(dx) <= dy) quads.push([2, dy]);
  if (dx < 0 && Math.abs(dy) <= -dx) quads.push([3, -dx]);
  for (const [q, depth] of quads) {
    cQ = q;
    cMax = depth;
    scan(1, -1, 1, 1, 1);
    if (cFound) break;
  }
  const found = cFound;
  cTarget = -1;
  cFound = false;
  cOpaque = NONE;
  return found;
}

/**
 * The tiles in sight from the tile under `(x, y)`, as a 0/1 mask (the
 * viewer's own tile included, walls that stop the sight too), within
 * `range` tiles centre to centre (default: unlimited).
 */
export function fieldOfView(map: Blueprint, opaque: Uint8Array, x: number, y: number, range = Infinity): Uint8Array {
  const n = map.w * map.h;
  const out = new Uint8Array(n);
  const o = tileAt(map, x, y);
  if (o < 0 || opaque.length < n || !(range >= 0)) return out;
  cast(map.w, map.h, opaque, o % map.w, Math.floor(o / map.w), range, out, 1);
  return out;
}

/** Whether the tiles under two positions see each other (the hold, cameras). Symmetric for floor tiles. */
export function lineOfSight(map: Blueprint, opaque: Uint8Array, ax: number, ay: number, bx: number, by: number): boolean {
  return tileSight(map.w, map.h, opaque, tileAt(map, ax, ay), tileAt(map, bx, by));
}

// ---------------------------------------------------------------- light

let scratch = new Uint32Array(0);
let stamp = 0;

/** Casts into the scratch layer with a new stamp (no clearing). */
function castScratch(map: Blueprint, opaque: Uint8Array, ox: number, oy: number, radius: number): number {
  const n = map.w * map.h;
  if (scratch.length !== n || stamp >= 0xfffffff0) {
    scratch = new Uint32Array(n);
    stamp = 0;
  }
  stamp++;
  cast(map.w, map.h, opaque, ox, oy, radius, scratch, stamp);
  return stamp;
}

const RING = new WeakMap<Blueprint, number[][]>();

/** Per room: its floor tiles and the walls, doors and windows around it. */
function roomTiles(map: Blueprint): number[][] {
  let r = RING.get(map);
  if (r && r.length === map.rooms.length) return r;
  r = map.rooms.map((room) => {
    const out: number[] = [];
    const { x, y, w, h } = room.rect;
    for (let ty = Math.max(0, y - 1); ty <= Math.min(map.h - 1, y + h); ty++) {
      for (let tx = Math.max(0, x - 1); tx <= Math.min(map.w - 1, x + w); tx++) {
        const i = ty * map.w + tx;
        const edge = tx < x || ty < y || tx >= x + w || ty >= y + h;
        if (!edge) {
          if (map.roomAt[i] === room.id) out.push(i);
        } else {
          const t = map.tiles[i];
          if (t === TILE.WALL || t === TILE.DOOR || t === TILE.WINDOW) out.push(i);
        }
      }
    }
    return out;
  });
  RING.set(map, r);
  return r;
}

/** Adds one flashlight's light to `light`. */
function addFlashlight(map: Blueprint, opaque: Uint8Array, light: Uint8Array, f: Flashlight): void {
  if (!f || !f.on) return;
  const o = tileAt(map, f.x, f.y);
  if (o < 0) return;
  light[o]! |= LIGHT.TORCH;
  if (!Number.isFinite(f.facing)) return;
  const w = map.w;
  const ox = o % w;
  const oy = (o - ox) / w;
  // tile centres within the reach of the exact position are within reach + 1 of the tile's centre
  const reach = FLASHLIGHT_RANGE + 1;
  const s = castScratch(map, opaque, ox, oy, reach);
  const x0 = Math.max(0, ox - reach);
  const x1 = Math.min(w - 1, ox + reach);
  const y0 = Math.max(0, oy - reach);
  const y1 = Math.min(map.h - 1, oy + reach);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (scratch[i] === s && inCone(f.x, f.y, f.facing, FLASHLIGHT_FOV, FLASHLIGHT_RANGE, x + 0.5, y + 0.5)) light[i]! |= LIGHT.TORCH;
    }
  }
}

/**
 * The light per tile ({@link LIGHT} bits): lit rooms (floor and the
 * walls, doors and windows around), the pools of lamps that are on
 * (tiles within {@link LAMP_RADIUS} of the lamp, centre to centre, in
 * the lamp's sight) and flashlights that are on (their cone in the
 * holder's sight, and the holder's tile).
 */
export function lightMask(map: Blueprint, state: SightState, opaque: Uint8Array = opacity(map, state?.doors ?? [])): Uint8Array {
  const n = map.w * map.h;
  const light = new Uint8Array(n);
  if (opaque.length < n) return light;
  const rooms = roomTiles(map);
  for (let r = 0; r < rooms.length; r++) {
    if (!on(state?.rooms, r)) continue;
    for (const i of rooms[r]!) light[i]! |= LIGHT.ROOM;
  }
  for (const l of map.lamps) {
    if (!on(state?.lamps, l.id) || l.i < 0 || l.i >= n) continue;
    const lx = l.i % map.w;
    const ly = (l.i - lx) / map.w;
    const s = castScratch(map, opaque, lx, ly, LAMP_RADIUS);
    for (let y = Math.max(0, ly - LAMP_RADIUS); y <= Math.min(map.h - 1, ly + LAMP_RADIUS); y++) {
      for (let x = Math.max(0, lx - LAMP_RADIUS); x <= Math.min(map.w - 1, lx + LAMP_RADIUS); x++) {
        const i = y * map.w + x;
        if (scratch[i] === s) light[i]! |= LIGHT.LAMP;
      }
    }
  }
  const fl = Array.isArray(state?.flashlights) ? state.flashlights : [];
  for (const f of fl) addFlashlight(map, opaque, light, f);
  return light;
}

/** The opacity grid and the light for this tick. */
export function prepare(map: Blueprint, state: SightState): SightWorld {
  const opaque = opacity(map, state?.doors ?? []);
  return { map, opaque, light: lightMask(map, state, opaque) };
}

// ---------------------------------------------------------------- seeing

/**
 * What a viewer sees (§4): a 0/1 mask of the tiles in sight from the
 * viewer's tile that are lit or within the viewer's own radius (from the
 * viewer's tile centre to the tile's). Empty for a position that is not
 * finite.
 */
export function seenBy(world: SightWorld, viewer: Viewer): Uint8Array {
  const { map, light } = world;
  const n = map.w * map.h;
  const o = tileAt(map, viewer?.x, viewer?.y);
  if (o < 0 || light.length < n) return new Uint8Array(n);
  const vis = fieldOfView(map, world.opaque, viewer.x, viewer.y);
  const r = Number.isFinite(viewer.radius) && viewer.radius > 0 ? viewer.radius : 0;
  const r2 = r * r + EPS;
  const w = map.w;
  const ox = o % w;
  const oy = (o - ox) / w;
  for (let i = 0; i < n; i++) {
    if (!vis[i] || light[i]) continue;
    const x = i % w;
    const dx = x - ox;
    const dy = (i - x) / w - oy;
    if (dx * dx + dy * dy > r2) vis[i] = 0;
  }
  return vis;
}

/** {@link prepare} and {@link seenBy} in one (for a single viewer). */
export function seenMask(map: Blueprint, state: SightState, viewer: Viewer): Uint8Array {
  return seenBy(prepare(map, state), viewer);
}

/** Whether the tile under a position is set in a mask (false off the map or when not finite). */
export function isSeen(map: { w: number; h: number }, mask: ArrayLike<number>, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
  return !!mask[Math.floor(y) * map.w + Math.floor(x)];
}

// ---------------------------------------------------------------- cameras

/** A camera's lens: the centre of its (wall) tile. */
const lens = (map: Blueprint, cam: Camera): [number, number] => {
  const i = cam.i >= 0 && cam.i < map.w * map.h ? cam.i : tileAt(map, cam.x, cam.y);
  const x = i % map.w;
  return [x + 0.5, (i - x) / map.w + 0.5];
};

/**
 * Whether a camera sees a position (§7): the tile's centre in its cone
 * (`fov`, `range`, `angle`), in sight of the camera's tile, and lit.
 */
export function cameraSees(world: SightWorld, cam: Camera, x: number, y: number): boolean {
  const { map } = world;
  const t = tileAt(map, x, y);
  if (t < 0 || !cam || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
  if (!world.light[t]) return false;
  const [lx, ly] = lens(map, cam);
  const tx = t % map.w;
  if (!inCone(lx, ly, cam.angle, cam.fov, cam.range, tx + 0.5, (t - tx) / map.w + 0.5)) return false;
  return tileSight(map.w, map.h, world.opaque, tileAt(map, lx, ly), t);
}

/**
 * A camera's view as a 0/1 mask: the tiles in its cone and its sight;
 * with `lit` only the lit ones (what it would report a thief on).
 */
export function cameraView(world: SightWorld, cam: Camera, lit = true): Uint8Array {
  const { map } = world;
  const n = map.w * map.h;
  const out = new Uint8Array(n);
  if (!cam || !Number.isFinite(cam.range) || cam.range < 0) return out;
  const [lx, ly] = lens(map, cam);
  const range = Math.min(cam.range, map.w + map.h);
  const vis = fieldOfView(map, world.opaque, lx, ly, range);
  for (let i = 0; i < n; i++) {
    if (!vis[i] || (lit && !world.light[i])) continue;
    const x = i % map.w;
    if (inCone(lx, ly, cam.angle, cam.fov, range, x + 0.5, (i - x) / map.w + 0.5)) out[i] = 1;
  }
  return out;
}

// ---------------------------------------------------------------- wire

/**
 * A mask as run lengths for a phone frame: alternating runs of unset
 * and set tiles (the first run unset, possibly 0 long), as varints in
 * base64url. A seen mask of an 86×54 map is typically 50–200 characters.
 */
export function encodeSeen(mask: ArrayLike<number>): string {
  const w = new VarintWriter();
  let i = 0;
  let want = 0;
  while (i < mask.length) {
    let j = i;
    while (j < mask.length && (mask[j] ? 1 : 0) === want) j++;
    w.uint(j - i);
    i = j;
    want ^= 1;
  }
  return toBase64(w.bytes);
}

/** {@link encodeSeen} back to a 0/1 mask of exactly `length` tiles, or null. */
export function decodeSeen(s: unknown, length: number): Uint8Array | null {
  if (!Number.isInteger(length) || length < 0 || length > 1 << 24) return null;
  const bytes = fromBase64(s);
  if (!bytes) return null;
  const out = new Uint8Array(length);
  const r = new VarintReader(bytes);
  let o = 0;
  let v = 0;
  while (!r.done) {
    const k = r.uint();
    if (k < 0 || o + k > length) return null;
    if (v) out.fill(1, o, o + k);
    o += k;
    v ^= 1;
  }
  return o === length ? out : null;
}
