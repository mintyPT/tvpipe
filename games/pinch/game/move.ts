/**
 * Moving (docs/pinch-design.md §4, §10, §11): A* on the tile grid, path
 * smoothing, bodies that slide along walls, and the helpers the
 * simulation and the phone's prediction share (snapping a tap to a
 * tile, what is within reach, climbing a window, the facing angle).
 *
 * Coordinates as in map.ts: tile `(x, y)` covers `[x, x + 1) × [y, y + 1)`;
 * a body's `x`, `y` are its centre in tiles.
 *
 * **Determinism.** The host and the phones must get the same paths and
 * positions for the same inputs, on any engine. Everything that decides a
 * position uses only `+ - * /`, comparisons and `Math.sqrt` (IEEE exact)
 * in a fixed order: no `Math.hypot`, no trigonometry. The facing angle
 * ({@link facing}) uses `Math.atan2`, which engines may round
 * differently in the last bit; it is for drawing and aiming only and
 * never feeds back into a position.
 *
 * **Untrusted input.** Everything that takes a target from a phone
 * ({@link validPoint}, {@link nearestWalkable}, {@link goTo},
 * {@link findPath}) returns null for junk instead of throwing.
 *
 * The graph: floor tiles and door tiles. 8-way between floor tiles
 * without cutting corners (a diagonal needs both orthogonal neighbours
 * to be floor); doors only orthogonally. Closed doors cost the
 * {@link DOOR_PAUSE} (walking through opens them), locked doors are
 * passable only with {@link PathOptions.locked}. Windows are never part
 * of a path: climbing is an action ({@link climbTarget}).
 */

import { TILE, sidesOf, type Blueprint, type Rect } from "./map.ts";

// ---------------------------------------------------------------- constants

/** Everyone's walking speed, tiles a second (§4). */
export const SPEED = 3.5;
/** A body's radius in tiles. */
export const RADIUS = 0.3;
/** The simulation's fixed step, seconds. */
export const DT = 0.05;
/** The pause when walking opens a closed door, seconds (§3). */
export const DOOR_PAUSE = 0.3;
/** The thief picking a lock, seconds (§3). */
export const PICK_TIME = 3;
/** Climbing a window, seconds (§3). */
export const CLIMB_TIME = 1.2;
/** How far (body centre to the thing's square, tiles) an action reaches: a tile next to it, diagonals included. */
export const REACH = 0.8;
/** The default A* budget: expanded tiles. An 86×54 estate has fewer walkable tiles. */
export const PATH_BUDGET = 6000;

/** Door states, per door id (`World.doors`). Only {@link DOOR_OPEN} lets bodies (and sight) through. */
export const DOOR_CLOSED = 0;
export const DOOR_OPEN = 1;
/** Closed and locked. */
export const DOOR_LOCKED = 2;

/** Longest move per collision sub-step (well under the body's radius: no tunnelling). */
const SUBSTEP = 0.1;
/** Extra clearance smoothed segments keep from walls. */
const MARGIN = 0.05;
/** How close counts as touching a door (for the door event). */
const TOUCH = 0.01;
/** Pushing out of a wall leaves this much air, so "touching" is never "overlapping". */
const AIR = 1e-7;

// ---------------------------------------------------------------- types

/** What moving needs: the blueprint and the doors' states. */
export interface World {
  map: Blueprint;
  /** {@link DOOR_CLOSED}, {@link DOOR_OPEN} or {@link DOOR_LOCKED} per door id. */
  doors: ArrayLike<number>;
}

export interface Point {
  x: number;
  y: number;
}

/** A moving body: its centre and the way it faces (degrees, 0 = east, 90 = south). */
export interface Body {
  x: number;
  y: number;
  angle: number;
}

/** A path to walk ({@link findPath}); {@link step} advances `next`. */
export interface Path {
  /** The waypoints after the start; the last one is the goal. */
  points: Point[];
  /** Per point: the door whose centre it is, or -1. Doors are always waypoints. */
  doors: number[];
  /** The tile path the points were smoothed from, the start tile first. */
  tiles: number[];
  /** Its cost in tiles, door pauses included (seconds: `cost / SPEED`). */
  cost: number;
  /** False when the goal was out of reach (or of the budget): the path ends as near to it as found. */
  complete: boolean;
  /** The point being walked to. */
  next: number;
}

export interface PathOptions {
  /**
   * Extra seconds for a locked door on top of the {@link DOOR_PAUSE}
   * (guards: 0, they have the keys; the thief: {@link PICK_TIME}); null
   * or absent: locked doors are walls.
   */
  locked?: number | null;
  /** Most tiles to expand (default {@link PATH_BUDGET}). */
  budget?: number;
}

/**
 * What {@link step} reports:
 * - `door`: the body touches a closed door on its path and waits there
 *   (the sim opens it after the {@link DOOR_PAUSE}, or starts picking a
 *   locked one); reported every step until the door is open.
 * - `arrived`: the path is done.
 * - `stuck`: the body could not move at all (re-path from where it is).
 */
export type StepEvent = { kind: "door"; door: number; locked: boolean } | { kind: "arrived" } | { kind: "stuck" };

// ---------------------------------------------------------------- tiles

/** The doors' states at the start of a heist: locked ones {@link DOOR_LOCKED}, the rest closed. */
export function doorStates(map: Blueprint): Uint8Array {
  const s = new Uint8Array(map.doors.length);
  for (const d of map.doors) s[d.id] = d.locked ? DOOR_LOCKED : DOOR_CLOSED;
  return s;
}

/** Whether tile index `i` stops a body now (out of the map: yes). */
export function blocksBody(world: World, i: number): boolean {
  const m = world.map;
  if (!(i >= 0 && i < m.w * m.h)) return true;
  const t = m.tiles[i];
  if (t === TILE.FLOOR) return false;
  if (t === TILE.DOOR) return world.doors[m.doorAt[i]!] !== DOOR_OPEN;
  return true;
}

/** Whether a tile is somewhere to walk to: floor or a door (in any state). */
export function standable(map: Blueprint, i: number): boolean {
  if (!(i >= 0 && i < map.w * map.h)) return false;
  const t = map.tiles[i];
  return t === TILE.FLOOR || t === TILE.DOOR;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A point from untrusted input: finite numbers inside the map, else null. */
export function validPoint(map: { w: number; h: number }, x: unknown, y: unknown): Point | null {
  if (!finite(x) || !finite(y) || x < 0 || y < 0 || x >= map.w || y >= map.h) return null;
  return { x, y };
}

/**
 * The standable tile ({@link standable}) nearest to a tapped point (by
 * the distance to tile centres; ties: the lower index), within
 * `maxDist` tiles; null for junk input or nothing near.
 */
export function nearestWalkable(map: Blueprint, x: unknown, y: unknown, maxDist = 3): number | null {
  if (!finite(x) || !finite(y) || !finite(maxDist) || maxDist < 0) return null;
  if (x < -maxDist || y < -maxDist || x > map.w + maxDist || y > map.h + maxDist) return null;
  const r = Math.min(maxDist, 64);
  let best = -1;
  let bestD = r * r;
  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(map.w - 1, Math.floor(x + r));
  const y0 = Math.max(0, Math.floor(y - r));
  const y1 = Math.min(map.h - 1, Math.floor(y + r));
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const i = ty * map.w + tx;
      if (!standable(map, i)) continue;
      const dx = tx + 0.5 - x;
      const dy = ty + 0.5 - y;
      const d = dx * dx + dy * dy;
      if (d < bestD || (d === bestD && best < 0)) {
        best = i;
        bestD = d;
      }
    }
  }
  return best < 0 ? null : best;
}

// ---------------------------------------------------------------- geometry

/** Squared distance from a point to the square of tile `(tx, ty)`. */
function tileDist2(px: number, py: number, tx: number, ty: number): number {
  const cx = px < tx ? tx : px > tx + 1 ? tx + 1 : px;
  const cy = py < ty ? ty : py > ty + 1 ? ty + 1 : py;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

/** Squared distance from a point to a segment. */
function pointSeg2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px;
  const ey = ay + dy * t - py;
  return ex * ex + ey * ey;
}

/** Whether a segment meets the square `[x0, x0+1] × [y0, y0+1]` (Liang–Barsky). */
function segHitsBox(ax: number, ay: number, bx: number, by: number, x0: number, y0: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, ax - x0) && clip(dx, x0 + 1 - ax) && clip(-dy, ay - y0) && clip(dy, y0 + 1 - ay) && t0 <= t1;
}

/** Squared distance between a segment and tile `(tx, ty)`'s square. */
function segTileDist2(ax: number, ay: number, bx: number, by: number, tx: number, ty: number): number {
  if (segHitsBox(ax, ay, bx, by, tx, ty)) return 0;
  let d = Math.min(tileDist2(ax, ay, tx, ty), tileDist2(bx, by, tx, ty));
  for (const [cx, cy] of [[tx, ty], [tx + 1, ty], [tx, ty + 1], [tx + 1, ty + 1]] as const) {
    const e = pointSeg2(cx, cy, ax, ay, bx, by);
    if (e < d) d = e;
  }
  return d;
}

/**
 * Whether a disc of radius `r` moves from `a` to `b` touching no tile
 * that `solid` calls solid (closer than `r`; out of the map is solid).
 * Visits only the band of tiles along the segment.
 */
export function sweepClear(map: { w: number; h: number }, solid: (i: number) => boolean, a: Point, b: Point, r: number): boolean {
  const r2 = r * r;
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const dx = b.x - a.x;
  for (let cx = Math.floor(minX - r); cx <= Math.floor(maxX + r); cx++) {
    // the part of the segment whose x lies within r of this column
    let lo = 0;
    let hi = 1;
    if (dx !== 0) {
      const t0 = (cx - r - a.x) / dx;
      const t1 = (cx + 1 + r - a.x) / dx;
      lo = Math.max(0, Math.min(t0, t1));
      hi = Math.min(1, Math.max(t0, t1));
      if (lo > hi) continue;
    }
    const ya = a.y + (b.y - a.y) * lo;
    const yb = a.y + (b.y - a.y) * hi;
    for (let cy = Math.floor(Math.min(ya, yb) - r); cy <= Math.floor(Math.max(ya, yb) + r); cy++) {
      const out = cx < 0 || cy < 0 || cx >= map.w || cy >= map.h;
      if (!out && !solid(cy * map.w + cx)) continue;
      if (segTileDist2(a.x, a.y, b.x, b.y, cx, cy) < r2) return false;
    }
  }
  return true;
}

/** Whether a body centred at `(x, y)` overlaps nothing solid now. */
export function fits(world: World, x: number, y: number, r = RADIUS): boolean {
  if (!finite(x) || !finite(y)) return false;
  const r2 = r * r;
  for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
    for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
      const solid = tx < 0 || ty < 0 || tx >= world.map.w || ty >= world.map.h || blocksBody(world, ty * world.map.w + tx);
      if (solid && tileDist2(x, y, tx, ty) < r2) return false;
    }
  }
  return true;
}

/**
 * Puts a body that overlaps something (a door closed on it, a bad
 * correction) on the nearest free spot: inside the nearest free tile
 * (within 3), as near to where it was as fits. False when there is none.
 */
export function settle(world: World, body: Body): boolean {
  if (fits(world, body.x, body.y)) return true;
  const m = world.map;
  let best = -1;
  let bestD = Infinity;
  const fx = Math.floor(body.x);
  const fy = Math.floor(body.y);
  for (let ty = fy - 3; ty <= fy + 3; ty++) {
    for (let tx = fx - 3; tx <= fx + 3; tx++) {
      if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h || blocksBody(world, ty * m.w + tx)) continue;
      const d = tileDist2(body.x, body.y, tx, ty);
      if (d < bestD) {
        bestD = d;
        best = ty * m.w + tx;
      }
    }
  }
  if (best < 0) return false;
  const tx = best % m.w;
  const ty = (best - tx) / m.w;
  const lo = RADIUS + 1e-6;
  const hi = 1 - RADIUS - 1e-6;
  body.x = tx + Math.min(hi, Math.max(lo, body.x - tx));
  body.y = ty + Math.min(hi, Math.max(lo, body.y - ty));
  return true;
}

// ---------------------------------------------------------------- a heap

/** A binary min-heap of values with two keys (then the value) as the order: deterministic ties. */
export class Heap {
  #k1: number[] = [];
  #k2: number[] = [];
  #v: number[] = [];

  get size(): number {
    return this.#v.length;
  }

  /** The smallest entry's first key (Infinity when empty). */
  get top(): number {
    return this.#v.length ? this.#k1[0]! : Infinity;
  }

  clear(): void {
    this.#k1.length = 0;
    this.#k2.length = 0;
    this.#v.length = 0;
  }

  #less(a: number, b: number): boolean {
    const k1 = this.#k1;
    if (k1[a] !== k1[b]) return k1[a]! < k1[b]!;
    const k2 = this.#k2;
    if (k2[a] !== k2[b]) return k2[a]! < k2[b]!;
    return this.#v[a]! < this.#v[b]!;
  }

  #swap(a: number, b: number): void {
    for (const xs of [this.#k1, this.#k2, this.#v]) {
      const t = xs[a]!;
      xs[a] = xs[b]!;
      xs[b] = t;
    }
  }

  push(k1: number, k2: number, v: number): void {
    let i = this.#v.length;
    this.#k1.push(k1);
    this.#k2.push(k2);
    this.#v.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.#less(i, p)) break;
      this.#swap(i, p);
      i = p;
    }
  }

  /** Removes the smallest entry: its value and first key, or null when empty. */
  pop(): { v: number; k1: number } | null {
    const n = this.#v.length;
    if (n === 0) return null;
    const out = { v: this.#v[0]!, k1: this.#k1[0]! };
    this.#swap(0, n - 1);
    this.#k1.pop();
    this.#k2.pop();
    this.#v.pop();
    const m = n - 1;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let s = i;
      if (l < m && this.#less(l, s)) s = l;
      if (r < m && this.#less(r, s)) s = r;
      if (s === i) break;
      this.#swap(i, s);
      i = s;
    }
    return out;
  }
}

// ---------------------------------------------------------------- A*

const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const DIAG = [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const;

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? dx - dy + Math.SQRT2 * dy : dy - dx + Math.SQRT2 * dx;
}

/**
 * The tile path from `from`'s tile to `to`'s tile (A*, octile
 * heuristic), smoothed into waypoints from `from` itself to `to` (kept
 * where it was tapped, pulled in so the body fits inside its tile).
 * `to` must be on a standable tile (snap taps with
 * {@link nearestWalkable} first: {@link goTo} does both). When the goal
 * cannot be reached (or the budget runs out) the path leads to the
 * expanded tile nearest to it, `complete: false`. Null for junk input,
 * a start or goal off the graph.
 */
export function findPath(world: World, from: Point, to: Point, opts: PathOptions = {}): Path | null {
  const m = world.map;
  if (!from || !to || !finite(from.x) || !finite(from.y) || !finite(to.x) || !finite(to.y)) return null;
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  const gx = Math.floor(to.x);
  const gy = Math.floor(to.y);
  if (sx < 0 || sy < 0 || sx >= m.w || sy >= m.h || gx < 0 || gy < 0 || gx >= m.w || gy >= m.h) return null;
  const start = sy * m.w + sx;
  const goal = gy * m.w + gx;
  if (!standable(m, start) || !standable(m, goal)) return null;
  const locked = opts.locked;
  const lockedCost = finite(locked) && locked >= 0 ? (DOOR_PAUSE + locked) * SPEED : -1;
  const budget = finite(opts.budget) && opts.budget > 0 ? opts.budget : PATH_BUDGET;
  const doorCost = DOOR_PAUSE * SPEED;
  const { w, h, tiles } = m;

  /** The extra cost of entering tile j, or -1 when it cannot be entered. */
  const enter = (j: number): number => {
    const t = tiles[j];
    if (t === TILE.FLOOR) return 0;
    if (t !== TILE.DOOR) return -1;
    if (j === start) return 0;
    const s = world.doors[m.doorAt[j]!];
    if (s === DOOR_OPEN) return 0;
    if (s === DOOR_LOCKED) return lockedCost;
    return doorCost;
  };

  const n = w * h;
  const g = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new Heap();
  g[start] = 0;
  heap.push(octile(sx, sy, gx, gy), octile(sx, sy, gx, gy), start);
  let best = start;
  let bestH = octile(sx, sy, gx, gy);
  let expanded = 0;
  let found = false;
  while (heap.size > 0) {
    const e = heap.pop()!;
    const i = e.v;
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === goal) {
      found = true;
      break;
    }
    const x = i % w;
    const y = (i - x) / w;
    const hi = octile(x, y, gx, gy);
    if (hi < bestH || (hi === bestH && g[i]! < g[best]!)) {
      best = i;
      bestH = hi;
    }
    if (++expanded >= budget) break;
    const gi = g[i]!;
    const relax = (j: number, jx: number, jy: number, c: number) => {
      if (closed[j]) return;
      const gj = gi + c;
      if (gj < g[j]!) {
        g[j] = gj;
        parent[j] = i;
        const hj = octile(jx, jy, gx, gy);
        heap.push(gj + hj, hj, j);
      }
    };
    for (const [dx, dy] of ORTH) {
      const jx = x + dx;
      const jy = y + dy;
      if (jx < 0 || jy < 0 || jx >= w || jy >= h) continue;
      const j = jy * w + jx;
      const c = enter(j);
      if (c >= 0) relax(j, jx, jy, 1 + c);
    }
    if (tiles[i] !== TILE.FLOOR) continue;
    for (const [dx, dy] of DIAG) {
      const jx = x + dx;
      const jy = y + dy;
      if (jx < 0 || jy < 0 || jx >= w || jy >= h) continue;
      const j = jy * w + jx;
      if (tiles[j] === TILE.FLOOR && tiles[y * w + jx] === TILE.FLOOR && tiles[jy * w + x] === TILE.FLOOR) relax(j, jx, jy, Math.SQRT2);
    }
  }
  const end = found ? goal : best;
  const tilePath: number[] = [];
  for (let i = end; i >= 0; i = parent[i]!) tilePath.push(i);
  tilePath.reverse();
  const ex = end % w;
  const ey = (end - ex) / w;
  const lo = RADIUS + MARGIN;
  const roomy = (p: Point) => sweepClear(m, (i) => i !== goal && tiles[i] !== TILE.FLOOR, p, p, lo);
  const goalPt = !found
    ? { x: ex + 0.5, y: ey + 0.5 }
    : roomy(to)
      ? { x: to.x, y: to.y }
      : { x: gx + Math.min(1 - lo, Math.max(lo, to.x - gx)), y: gy + Math.min(1 - lo, Math.max(lo, to.y - gy)) };
  const { points, doors } = smooth(m, tilePath, { x: from.x, y: from.y }, goalPt);
  return { points, doors, tiles: tilePath, cost: g[end]!, complete: found, next: 0 };
}

/**
 * String pulling: from the start, the farthest tile centre along the
 * path a body (with a little margin) reaches in a straight line, and so
 * on; door tiles are always waypoints (and the only doors the lines may
 * cross), windows and everything else not floor are walls.
 */
function smooth(m: Blueprint, path: readonly number[], start: Point, goal: Point): { points: Point[]; doors: number[] } {
  const points: Point[] = [];
  const doors: number[] = [];
  const n = path.length;
  if (n === 0) return { points, doors };
  const onPath = new Set<number>();
  for (const i of path) if (m.tiles[i] === TILE.DOOR) onPath.add(i);
  const solid = (i: number) => {
    const t = m.tiles[i];
    return !(t === TILE.FLOOR || (t === TILE.DOOR && onPath.has(i)));
  };
  const at = (k: number): Point => {
    if (k === n - 1) return goal;
    const i = path[k]!;
    return { x: (i % m.w) + 0.5, y: Math.floor(i / m.w) + 0.5 };
  };
  const isDoor = (k: number) => m.tiles[path[k]!] === TILE.DOOR;
  const push = (k: number, p: Point) => {
    points.push(p);
    doors.push(isDoor(k) ? m.doorAt[path[k]!]! : -1);
  };
  let anchor = start;
  let k = 0;
  if (n === 1) {
    if (goal.x !== start.x || goal.y !== start.y) push(0, goal);
    return { points, doors };
  }
  // from where the body stands it may hug a wall: test with the bare radius,
  // and walk to its tile's centre first if even the next tile is out of line
  if (!sweepClear(m, solid, start, at(1), RADIUS)) {
    const c = { x: (path[0]! % m.w) + 0.5, y: Math.floor(path[0]! / m.w) + 0.5 };
    if (c.x !== start.x || c.y !== start.y) push(0, c);
    anchor = c;
  }
  let fromStart = anchor === start;
  while (k < n - 1) {
    let j = k + 1;
    const r = fromStart ? RADIUS : RADIUS + MARGIN;
    while (j + 1 < n && !isDoor(j) && sweepClear(m, solid, anchor, at(j + 1), r)) j++;
    const p = at(j);
    push(j, p);
    anchor = p;
    fromStart = false;
    k = j;
  }
  return { points, doors };
}

/**
 * A phone's `go`: validates the target (finite, on the map), snaps it to
 * the nearest standable tile (the point stays where tapped when it is on
 * one) and finds the path from the body. Null for junk or no tile near.
 */
export function goTo(world: World, body: Point, x: unknown, y: unknown, opts: PathOptions = {}): Path | null {
  const p = validPoint(world.map, x, y);
  if (!p) return null;
  const i = nearestWalkable(world.map, p.x, p.y);
  if (i === null) return null;
  const tx = i % world.map.w;
  const ty = (i - tx) / world.map.w;
  const target = Math.floor(p.x) === tx && Math.floor(p.y) === ty ? p : { x: tx + 0.5, y: ty + 0.5 };
  return findPath(world, body, target, opts);
}

// ---------------------------------------------------------------- moving

/**
 * Moves a body by `(dx, dy)` with sliding: in sub-steps of at most
 * {@link SUBSTEP}, each pushed out of the solid tiles it overlaps
 * (circle against squares, along the shortest way out: walls flatten
 * the move, corners round it). A sub-step that cannot be resolved is
 * undone, so a body never overlaps a solid tile and never crosses one.
 * Returns the distance actually moved.
 */
export function slide(world: World, body: Body, dx: number, dy: number): number {
  if (!finite(dx) || !finite(dy)) return 0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return 0;
  const steps = Math.ceil(len / SUBSTEP);
  const sx = dx / steps;
  const sy = dy / steps;
  const x0 = body.x;
  const y0 = body.y;
  const m = world.map;
  const r = RADIUS;
  for (let k = 0; k < steps; k++) {
    const px = body.x;
    const py = body.y;
    let x = px + sx;
    let y = py + sy;
    for (let it = 0; it < 4; it++) {
      let pushed = false;
      for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
        for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
          const solid = tx < 0 || ty < 0 || tx >= m.w || ty >= m.h || blocksBody(world, ty * m.w + tx);
          if (!solid) continue;
          const cx = x < tx ? tx : x > tx + 1 ? tx + 1 : x;
          const cy = y < ty ? ty : y > ty + 1 ? ty + 1 : y;
          const ex = x - cx;
          const ey = y - cy;
          const d2 = ex * ex + ey * ey;
          if (d2 >= r * r || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const f = (r + AIR - d) / d;
          x += ex * f;
          y += ey * f;
          pushed = true;
        }
      }
      if (!pushed) break;
    }
    if (!fits(world, x, y)) break;
    body.x = x;
    body.y = y;
  }
  const mx = body.x - x0;
  const my = body.y - y0;
  return Math.sqrt(mx * mx + my * my);
}

/** The angle of a direction in degrees, [0, 360), 0 = east, 90 = south (drawing and aiming only). */
export function facing(dx: number, dy: number): number {
  const a = (Math.atan2(dy, dx) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
}

/**
 * Advances a body along its path for `dt` seconds (the sim's {@link DT})
 * at {@link SPEED}, sliding along whatever is in the way; updates `body`
 * (position, facing while it moves) and `path.next` in place, nothing
 * else. Returns what the sim needs to know, or null while walking.
 */
export function step(body: Body, path: Path, dt: number, world: World): StepEvent | null {
  const t = finite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0;
  if (!fits(world, body.x, body.y)) settle(world, body);
  const x0 = body.x;
  const y0 = body.y;
  let left = SPEED * t;
  let event: StepEvent | null = null;
  for (let guard = 0; guard < 16 && path.next < path.points.length; guard++) {
    const p = path.points[path.next]!;
    const dx = p.x - body.x;
    const dy = p.y - body.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 1e-6) {
      if (fits(world, p.x, p.y)) {
        body.x = p.x;
        body.y = p.y;
      }
      path.next++;
      continue;
    }
    const door = doorAhead(world, body, path);
    if (door) {
      event = door;
      break;
    }
    if (left <= 0) break;
    const mv = Math.min(left, dist);
    slide(world, body, (dx / dist) * mv, (dy / dist) * mv);
    left -= mv;
    // close enough after sliding: on to the next point (snapping onto it
    // only with the distance left this step, so never faster than walking)
    const rx = p.x - body.x;
    const ry = p.y - body.y;
    const rest = Math.sqrt(rx * rx + ry * ry);
    if (rest <= 0.02) {
      if (rest <= left && fits(world, p.x, p.y)) {
        body.x = p.x;
        body.y = p.y;
        left -= rest;
        path.next++;
      } else if (path.next < path.points.length - 1) path.next++;
    }
    const after = doorAhead(world, body, path);
    if (after) {
      event = after;
      break;
    }
  }
  const mx = body.x - x0;
  const my = body.y - y0;
  const moved = Math.sqrt(mx * mx + my * my);
  if (moved > 1e-6) body.angle = facing(mx, my);
  if (event) return event;
  if (path.next >= path.points.length) return { kind: "arrived" };
  if (t > 0 && moved < 0.01 * SPEED * t) return { kind: "stuck" };
  return null;
}

/** A closed door among the next waypoints that the body touches. */
function doorAhead(world: World, body: Body, path: Path): StepEvent | null {
  const m = world.map;
  const lim = (RADIUS + TOUCH) * (RADIUS + TOUCH);
  for (let k = path.next; k < Math.min(path.points.length, path.next + 3); k++) {
    const id = path.doors[k]!;
    if (id < 0) continue;
    const d = m.doors[id];
    if (!d) continue;
    const s = world.doors[id];
    if (s === DOOR_OPEN) continue;
    if (tileDist2(body.x, body.y, d.x, d.y) <= lim) return { kind: "door", door: id, locked: s === DOOR_LOCKED };
  }
  return null;
}

// ---------------------------------------------------------------- reach

/** Distance from a body's centre to tile index `i`'s square. */
export function distToTile(map: { w: number }, body: Point, i: number): number {
  const tx = i % map.w;
  return Math.sqrt(tileDist2(body.x, body.y, tx, (i - tx) / map.w));
}

/** Distance from a body's centre to a rectangle of tiles. */
export function distToRect(body: Point, r: Rect): number {
  const cx = Math.min(r.x + r.w, Math.max(r.x, body.x));
  const cy = Math.min(r.y + r.h, Math.max(r.y, body.y));
  const dx = body.x - cx;
  const dy = body.y - cy;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Whether tile `i` is within reach of a body (standing next to it, diagonals included). */
export function inReach(map: { w: number }, body: Point, i: number, reach = REACH): boolean {
  return distToTile(map, body, i) <= reach;
}

function tilesInReach(map: Blueprint, body: Point, reach: number, idAt: Int16Array): number[] {
  if (!finite(body.x) || !finite(body.y)) return [];
  const hits: [number, number][] = [];
  for (let ty = Math.max(0, Math.floor(body.y - reach)); ty <= Math.min(map.h - 1, Math.floor(body.y + reach)); ty++) {
    for (let tx = Math.max(0, Math.floor(body.x - reach)); tx <= Math.min(map.w - 1, Math.floor(body.x + reach)); tx++) {
      const id = idAt[ty * map.w + tx]!;
      if (id < 0) continue;
      const d = tileDist2(body.x, body.y, tx, ty);
      if (d <= reach * reach) hits.push([d, id]);
    }
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return hits.map((h) => h[1]);
}

/** The doors within reach of a body, nearest first (standing in a doorway: that door). */
export function doorsInReach(map: Blueprint, body: Point, reach = REACH): number[] {
  return tilesInReach(map, body, reach, map.doorAt);
}

/** The windows within reach, nearest first. */
export function windowsInReach(map: Blueprint, body: Point, reach = REACH): number[] {
  return tilesInReach(map, body, reach, map.windowAt);
}

/** The props (furniture, cover) within reach, nearest first. */
export function propsInReach(map: Blueprint, body: Point, reach = REACH): number[] {
  if (!finite(body.x) || !finite(body.y)) return [];
  return map.props
    .map((p) => [distToRect(body, p.rect), p.id] as const)
    .filter(([d]) => d <= reach)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([, id]) => id);
}

/**
 * Where climbing window `pane` takes a body: the centre of the tile on
 * the other side from it. Null when the window does not exist, the body
 * is not within reach or the far side is not free floor.
 */
export function climbTarget(world: World, pane: number, body: Point): Point | null {
  const m = world.map;
  const p = Number.isInteger(pane) ? m.windows[pane] : undefined;
  if (!p || !finite(body.x) || !finite(body.y) || !inReach(m, body, p.i)) return null;
  const [a, b] = sidesOf(p);
  const before = p.wall === "v" ? body.x < p.x + 0.5 : body.y < p.y + 0.5;
  const [tx, ty] = before ? b : a;
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return null;
  const i = ty * m.w + tx;
  if (m.tiles[i] !== TILE.FLOOR || !fits(world, tx + 0.5, ty + 0.5)) return null;
  return { x: tx + 0.5, y: ty + 0.5 };
}
