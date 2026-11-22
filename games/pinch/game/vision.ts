/**
 * Sight as shapes, for drawing (docs/pinch-design.md §4, §12): the
 * outlines of what blocks sight as line segments, and the polygon one
 * sees from an exact position: the whole view, a lamp's pool, a
 * flashlight's cone. The phone and the TV's tape draw these with Canvas
 * paths, so the fog and the light have sharp, true edges along walls
 * and doorways (as in Monaco) instead of tile steps.
 *
 * The rules do not change: who sees what is still sight.ts's tiles (the
 * host decides on those and sends nothing else); this is only the
 * picture of it, from the phone's predicted position, and may differ
 * from the tiles by a little at the edges. The shapes only ever show
 * the static map more or less; items, doors and figures are drawn by
 * the tiles.
 *
 * **The blockers.** Every edge between an opaque tile (sight.ts
 * `opacity`) and a clear one is a segment, merged into runs, pushed
 * half a tile into the opaque tiles: one sees the near half of a wall,
 * a wall one tile thick is a line along its middle, a lone tree a cross
 * through its centre. That is how sight.ts's shadowcasting blocks too
 * (a blocker stops sight at its centre line across the way one looks),
 * so the shapes and the tiles mostly agree; where it matters, both
 * middle lines block (cover, the ends and corners of walls: a doorway is
 * a tile deep too), as shadowcasting's rows and columns do. Runs are lengthened at inner corners so the
 * outline stays closed and shortened at outer ones (a block's corner is
 * a corner), except where a blocker one tile thick ends: there its
 * middle line runs to the tile's edge, so a doorway or a gate stays one
 * tile wide. Each segment knows its clear side, so only those facing the
 * eye are tried.
 *
 * **The polygon.** Rays from the eye to every segment end in the box
 * (a little either side), plus, with a radius, every few degrees round
 * the circle; each ray stops at the nearest segment, the box or the
 * radius. The points in angle order are the polygon, clockwise on
 * screen (y down), as Canvas's `arc` and `rect` go: a path of several
 * such shapes fills their union with the nonzero rule.
 *
 * Pure, no DOM; nothing throws on odd input (an empty polygon).
 */

import { TILE, type Blueprint } from "./map.ts";

/** How far a blocker's outline lies inside it (tiles). */
export const INSET = 0.5;
/** Degrees between the rays round a circle. */
const ARC_STEP = 4;
const EPS = 1e-9;
/** The angle either side of a segment end (radians). */
const NUDGE = 1e-4;

/**
 * The blockers' outline: `n` segments, 6 numbers each in `s`: the ends
 * `ax, ay, bx, by` and the normal `nx, ny` towards the clear side.
 */
export interface Walls {
  s: Float64Array;
  n: number;
}

/** A box in tiles, `x0 < x1`, `y0 < y1`. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The outline of what blocks sight: `opaque` is sight.ts's grid (1
 * where sight stops, with the doors' states in it). Off the map counts
 * as wall.
 */
export function walls(map: Blueprint, opaque: ArrayLike<number>): Walls {
  const w = map?.w | 0;
  const h = map?.h | 0;
  const out: number[] = [];
  if (!(w > 0 && h > 0) || opaque.length < w * h) return { s: new Float64Array(0), n: 0 };
  /** 0 clear, else the outline's inset (one for all blockers; the runs would take several). */
  const depth = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= w || y >= h) return INSET;
    return opaque[y * w + x] ? INSET : 0;
  };
  // Both directions alike: `along` runs over the boundary line, `across`
  // picks the line; (u, v) → (x, y) by `xy`.
  for (const horizontal of [true, false]) {
    const L = horizontal ? w : h; // along
    const K = horizontal ? h : w; // lines 0..K
    const at = (u: number, v: number) => (horizontal ? depth(u, v) : depth(v, u));
    for (let k = 0; k <= K; k++) {
      // The line between row k − 1 (side −1) and row k (side +1).
      for (const side of [-1, 1]) {
        // `side`: where the opaque tile is; the clear one is on the other side.
        const oRow = side < 0 ? k - 1 : k;
        const cRow = side < 0 ? k : k - 1;
        let u = 0;
        while (u < L) {
          const d = at(u, oRow);
          if (!(d > 0) || at(u, cRow) > 0) {
            u++;
            continue;
          }
          let e = u + 1;
          while (e < L && at(e, oRow) === d && !(at(e, cRow) > 0)) e++;
          // The ends: an inner corner (the clear side's next tile blocks) lengthens the run;
          // an outer one (the blocking side ends) keeps a wall's end and shortens cover's.
          const end = (pos: number, dir: number): number => {
            const next = dir < 0 ? pos - 1 : pos;
            const c = at(next, cRow);
            const o = at(next, oRow);
            if (c > 0) return pos + dir * c; // meets the other run, pushed in by its own inset
            if (o > 0) return pos; // the inset changes here: a step joins them
            // An outer corner: a blocker one tile thick keeps its end (a doorway stays a
            // tile wide), a thicker one ends where its faces meet.
            const last = dir < 0 ? pos : pos - 1;
            if (d >= INSET && !(at(last, oRow + side) > 0)) return pos;
            return pos - dir * d;
          };
          const a = end(u, -1);
          const b = end(e, 1);
          const line = k + side * d; // pushed into the opaque row
          // Normal towards the clear side.
          const n = -side;
          if (horizontal) out.push(a, line, b, line, 0, n);
          else out.push(line, a, line, b, n, 0);
          // A step where the next run along has another inset.
          const o2 = at(e, oRow);
          if (e < L && o2 > 0 && o2 !== d && !(at(e, cRow) > 0)) {
            const l2 = k + side * o2;
            // Clear beyond the step on the deeper run's side.
            const nu = o2 > d ? 1 : -1;
            if (horizontal) out.push(e, Math.min(line, l2), e, Math.max(line, l2), nu, 0);
            else out.push(Math.min(line, l2), e, Math.max(line, l2), e, 0, nu);
          }
          u = e;
        }
      }
    }
  }
  // Shadowcasting stops sight at a blocker's middle line across the way one looks, so a
  // blocker is a cross: cover always blocks along both its middle lines where they reach a
  // clear tile (a row of trees is a comb), walls at their ends and corners (a doorway is a
  // tile wide and a tile deep: one sees through it at most diagonally).
  for (let i = 0; i < w * h; i++) {
    if (!opaque[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    const ew = !(depth(x - 1, y) > 0) || !(depth(x + 1, y) > 0);
    const ns = !(depth(x, y - 1) > 0) || !(depth(x, y + 1) > 0);
    const t = map.tiles[i];
    const cover = t === TILE.HEDGE || t === TILE.TREE || t === TILE.CAR || t === TILE.FOUNTAIN || t === TILE.SHED;
    if (!cover && !(ew && ns)) continue;
    if (ew) out.push(x, y + 0.5, x + 1, y + 0.5, 0, -1, x + 1, y + 0.5, x, y + 0.5, 0, 1);
    if (ns) out.push(x + 0.5, y, x + 0.5, y + 1, 1, 0, x + 0.5, y + 1, x + 0.5, y, -1, 0);
  }
  return { s: Float64Array.from(out), n: out.length / 6 };
}

/** A polygon as flat `[x0, y0, x1, y1, …]`. */
export type Polygon = number[];

/**
 * What one sees from `(ox, oy)` within `box`: the polygon of the clear
 * space round the eye, clockwise on screen. With `radius`, only that
 * far (round the circle); with `facing` and `fov` (degrees), only that
 * cone, the eye its first point. An eye on a blocker's outline or
 * outside the box sees nothing (an empty polygon); one deeper inside a
 * blocker sees nonsense, so callers check the eye's tile first.
 */
export function sight(
  wl: Walls,
  ox: number,
  oy: number,
  box: Box,
  o: { radius?: number; facing?: number; fov?: number } = {},
): Polygon {
  if (![ox, oy, box?.x0, box?.y0, box?.x1, box?.y1].every(Number.isFinite)) return [];
  const R = Number.isFinite(o.radius) && (o.radius as number) > 0 ? (o.radius as number) : Infinity;
  let x0 = box.x0;
  let y0 = box.y0;
  let x1 = box.x1;
  let y1 = box.y1;
  if (R < Infinity) {
    x0 = Math.max(x0, ox - R - 1);
    y0 = Math.max(y0, oy - R - 1);
    x1 = Math.min(x1, ox + R + 1);
    y1 = Math.min(y1, oy + R + 1);
  }
  if (!(ox > x0 && ox < x1 && oy > y0 && oy < y1)) return [];
  const cone = R < Infinity && Number.isFinite(o.facing) && Number.isFinite(o.fov) && (o.fov as number) < 360;
  const half = cone ? ((o.fov as number) / 2) * (Math.PI / 180) : Math.PI;
  const mid = cone ? (o.facing as number) * (Math.PI / 180) : 0;

  // The segments facing the eye that touch the box, and the box.
  const s = wl.s;
  const sel: number[] = [x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0];
  for (let k = 0; k < wl.n; k++) {
    const j = k * 6;
    const ax = s[j]!;
    const ay = s[j + 1]!;
    const bx = s[j + 2]!;
    const by = s[j + 3]!;
    if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(ay, by) < y0 || Math.min(ay, by) > y1) continue;
    if ((ox - ax) * s[j + 4]! + (oy - ay) * s[j + 5]! <= EPS) {
      // An eye on a blocker's outline (in a wall) sees nothing.
      if (distToSeg(ox, oy, ax, ay, bx, by) < 1e-6) return [];
      continue;
    }
    sel.push(ax, ay, bx, by);
  }

  // The angles to try, relative to the cone's start (or −π), in [0, 2·half].
  const start = mid - half;
  const span = 2 * half;
  const rel = (a: number) => {
    let r = (a - start) % (2 * Math.PI);
    if (r < 0) r += 2 * Math.PI;
    return r;
  };
  const angles: number[] = [];
  const add = (a: number) => {
    const r = rel(a);
    if (r <= span) angles.push(r);
  };
  for (let j = 0; j < sel.length; j += 2) {
    const a = Math.atan2(sel[j + 1]! - oy, sel[j]! - ox);
    add(a - NUDGE);
    add(a);
    add(a + NUDGE);
  }
  if (R < Infinity) {
    const steps = Math.max(2, Math.ceil(((span * 180) / Math.PI) / ARC_STEP));
    for (let i = 0; i <= steps; i++) angles.push((span * i) / steps);
  }
  angles.sort((a, b) => a - b);

  const out: Polygon = cone ? [ox, oy] : [];
  let last = -1;
  for (const r of angles) {
    if (r - last < 1e-7) continue;
    last = r;
    const a = start + r;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let t = R;
    for (let j = 0; j < sel.length; j += 4) {
      const ax = sel[j]!;
      const ay = sel[j + 1]!;
      const ex = sel[j + 2]! - ax;
      const ey = sel[j + 3]! - ay;
      const den = dx * ey - dy * ex;
      if (den > -EPS && den < EPS) continue;
      const qx = ax - ox;
      const qy = ay - oy;
      const tt = (qx * ey - qy * ex) / den;
      if (tt <= EPS || tt >= t) continue;
      const u = (qx * dy - qy * dx) / den;
      if (u < -1e-7 || u > 1 + 1e-7) continue;
      t = tt;
    }
    if (!(t < Infinity)) continue; // cannot happen inside the box
    out.push(ox + dx * t, oy + dy * t);
  }
  return out;
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const l2 = ex * ex + ey * ey;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / l2)) : 0;
  return Math.hypot(px - ax - ex * u, py - ay - ey * u);
}

/** A polygon's area (positive when clockwise on screen). */
export function area(p: Polygon): number {
  let a = 0;
  const n = p.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[2 * i]! * p[2 * j + 1]! - p[2 * j]! * p[2 * i + 1]!;
  }
  return a / 2;
}

/** Whether a point lies inside a polygon (even-odd; points on the edge either way). */
export function inside(p: Polygon, x: number, y: number): boolean {
  let c = false;
  const n = p.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[2 * i]!;
    const yi = p[2 * i + 1]!;
    const xj = p[2 * j]!;
    const yj = p[2 * j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
