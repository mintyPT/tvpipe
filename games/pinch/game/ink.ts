/**
 * The ink (docs/pinch-design.md §7): "where could the thief be", a wash
 * over the blueprint computed from public facts only (the blueprint, the
 * clock, camera sightings, holds, tag pings and Clear marks), so it leaks
 * nothing.
 *
 * The model: a set of inked tiles that grows at the thief's speed over
 * the tiles a thief can be on (floor, doors, windows), with the moves of
 * move.ts (8-way between floor tiles without cutting corners, doors and
 * windows straight across). Timing is exact, not quantised to steps: a
 * tile at path distance `d` from a restart at time `t` is inked at
 * `t + d / SPEED` (diagonals cost √2), whatever the step length.
 * Crossing a window (side → window → side) takes {@link CLIMB_TIME};
 * locked doors cost nothing extra by default (the thief may have picked
 * them before: the ink over-approximates).
 *
 * Events:
 * - {@link Ink.start}: from the parking spots (the heist's start);
 * - {@link Ink.restart} / {@link Ink.restartAt}: only there (a camera
 *   sighting, a hold, its end); {@link Ink.restartDisc}: every inkable
 *   tile whose centre is within {@link INK_DISC} of a point (a tag ping);
 * - {@link Ink.clear} / {@link Ink.clearRoom} / {@link Ink.clearArea}:
 *   erases the region at that moment; it flows back in from the inked
 *   tiles next to it as if restarted there at the moment of the Clear,
 *   and the rest of the ink goes on as before (minus what was spreading
 *   from inside the region).
 *
 * Event times never go back: an earlier time counts as the latest step's.
 *
 * Views: {@link encodeInk} / {@link decodeInk} over {@link inkMask}
 * (runs, a bitset or a delta: see there), sent with the public layer at
 * 10 Hz.
 */

import { fromBase64, toBase64, VarintReader, VarintWriter } from "./codec.ts";
import { TILE, type Blueprint } from "./map.ts";
import { CLIMB_TIME, Heap, SPEED } from "./move.ts";

/** A tag ping's disc radius, tiles (§6, §7). */
export const INK_DISC = 3;

export interface InkOptions {
  /** Tiles a second (default {@link SPEED}). */
  speed?: number;
  /** Seconds through a window (default {@link CLIMB_TIME}). */
  climb?: number;
  /** Extra seconds through a door locked on the blueprint (default 0). */
  locked?: number;
}

// tile classes
const NONE = 0;
const FLOOR = 1;
const DOOR = 2;
const LOCKED = 3;
/** Windows in a vertical wall (crossed east–west) and a horizontal one (north–south). */
const WIN_V = 4;
const WIN_H = 5;

export class Ink {
  readonly map: Blueprint;
  /** 1 per inked tile (row-major, `w * h`): read it, do not write it. */
  readonly inked: Uint8Array;
  /** When each inked tile was inked (Infinity: not inked). */
  readonly at: Float64Array;
  readonly #cls: Uint8Array;
  readonly #orth: number;
  readonly #diag: number;
  readonly #half: number;
  readonly #lock: number;
  readonly #heap = new Heap();
  #now = 0;
  #count = 0;

  constructor(map: Blueprint, opts: InkOptions = {}) {
    this.map = map;
    const n = map.w * map.h;
    this.inked = new Uint8Array(n);
    this.at = new Float64Array(n).fill(Infinity);
    const ok = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
    const speed = ok(opts.speed, SPEED) || SPEED;
    this.#orth = 1 / speed;
    this.#diag = Math.SQRT2 / speed;
    this.#half = ok(opts.climb, CLIMB_TIME) / 2;
    this.#lock = ok(opts.locked, 0);
    const cls = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const t = map.tiles[i];
      if (t === TILE.FLOOR) cls[i] = FLOOR;
      else if (t === TILE.DOOR) cls[i] = map.doors[map.doorAt[i]!]?.locked ? LOCKED : DOOR;
      else if (t === TILE.WINDOW) cls[i] = map.windows[map.windowAt[i]!]?.wall === "h" ? WIN_H : WIN_V;
    }
    this.#cls = cls;
  }

  /** The time of the latest step or event. */
  get now(): number {
    return this.#now;
  }

  /** How many tiles are inked. */
  get count(): number {
    return this.#count;
  }

  /** Whether the thief could be on tile `i` (doors and windows included). */
  inkable(i: number): boolean {
    return (this.#cls[i] ?? NONE) !== NONE;
  }

  /** The heist starts at `t`: ink on every parking spot's tiles, spreading from there. */
  start(t = 0): void {
    const tiles: number[] = [];
    for (const s of this.map.spots) {
      for (let y = s.rect.y; y < s.rect.y + s.rect.h; y++) for (let x = s.rect.x; x < s.rect.x + s.rect.w; x++) tiles.push(y * this.map.w + x);
    }
    this.#now = Number.isFinite(t) ? t : 0;
    this.restart(this.#now, tiles);
  }

  /** Only these tiles are inked at `t` (the thief is there); it spreads from them. */
  restart(t: number, tiles: readonly number[]): void {
    const now = this.#time(t);
    this.inked.fill(0);
    this.at.fill(Infinity);
    this.#count = 0;
    this.#heap.clear();
    for (const i of tiles) if (Number.isInteger(i) && this.inkable(i)) this.#heap.push(now, 0, i);
    this.#run(now);
  }

  /** {@link restart} at the inkable tile nearest to a point (within 3 tiles; else nothing changes). */
  restartAt(t: number, x: number, y: number): void {
    const i = this.#nearest(x, y);
    if (i >= 0) this.restart(t, [i]);
  }

  /**
   * {@link restart} on every inkable tile whose centre lies within
   * `radius` of the point (through walls: a ping is a place give or take
   * a distance); the nearest inkable tile if none.
   */
  restartDisc(t: number, x: number, y: number, radius = INK_DISC): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius)) return;
    const r = Math.max(0, Math.min(radius, 32));
    const tiles: number[] = [];
    const { w, h } = this.map;
    for (let ty = Math.max(0, Math.floor(y - r)); ty <= Math.min(h - 1, Math.floor(y + r)); ty++) {
      for (let tx = Math.max(0, Math.floor(x - r)); tx <= Math.min(w - 1, Math.floor(x + r)); tx++) {
        const dx = tx + 0.5 - x;
        const dy = ty + 0.5 - y;
        const i = ty * w + tx;
        if (dx * dx + dy * dy <= r * r && this.inkable(i)) tiles.push(i);
      }
    }
    if (tiles.length) this.restart(t, tiles);
    else this.restartAt(t, x, y);
  }

  /** A Clear mark on room `id` at `t`. */
  clearRoom(t: number, id: number): void {
    this.#clearWhere(t, this.map.roomAt, id);
  }

  /** A Clear mark on outside area `id` at `t`. */
  clearArea(t: number, id: number): void {
    this.#clearWhere(t, this.map.areaAt, id);
  }

  #clearWhere(t: number, layer: Int16Array, id: number): void {
    if (!Number.isInteger(id) || id < 0) return;
    const tiles: number[] = [];
    for (let i = 0; i < layer.length; i++) if (layer[i] === id) tiles.push(i);
    this.clear(t, tiles);
  }

  /**
   * Erases the ink on these tiles at `t`. It flows back from the inked
   * tiles next to them, starting at `t`; whatever was spreading from
   * inside them stops.
   */
  clear(t: number, tiles: readonly number[]): void {
    const now = this.#time(t);
    this.#run(now);
    const n = this.inked.length;
    const region = new Uint8Array(n);
    for (const i of tiles) {
      if (!Number.isInteger(i) || i < 0 || i >= n) continue;
      region[i] = 1;
      if (this.inked[i]) {
        this.inked[i] = 0;
        this.at[i] = Infinity;
        this.#count--;
      }
    }
    // the queue again, from the ink that is left
    this.#heap.clear();
    for (let i = 0; i < n; i++) {
      if (!this.inked[i]) continue;
      const ti = this.at[i]!;
      this.#each(i, (j, c) => {
        if (!this.inked[j]) this.#heap.push((region[j] ? now : ti) + c, 0, j);
      });
    }
  }

  /** Inks everything due by `now`, in order of time. Returns how many tiles it inked. */
  step(now: number): number {
    const before = this.#count;
    this.#run(this.#time(now));
    return this.#count - before;
  }

  #time(t: number): number {
    if (Number.isFinite(t) && t > this.#now) this.#now = t;
    return this.#now;
  }

  #run(now: number): void {
    const heap = this.#heap;
    while (heap.size > 0 && heap.top <= now) {
      const { v: i, k1: ti } = heap.pop()!;
      if (this.inked[i]) continue;
      this.inked[i] = 1;
      this.at[i] = ti;
      this.#count++;
      this.#each(i, (j, c) => {
        if (!this.inked[j]) heap.push(ti + c, 0, j);
      });
    }
  }

  /** The moves out of tile i and their times. */
  #each(i: number, fn: (j: number, cost: number) => void): void {
    const { w, h } = this.map;
    const cls = this.#cls;
    const ci = cls[i]!;
    const x = i % w;
    const y = (i - x) / w;
    const win = (c: number) => c === WIN_V || c === WIN_H;
    for (let d = 0; d < 4; d++) {
      const dx = d === 0 ? 1 : d === 1 ? -1 : 0;
      const dy = d === 2 ? 1 : d === 3 ? -1 : 0;
      const jx = x + dx;
      const jy = y + dy;
      if (jx < 0 || jy < 0 || jx >= w || jy >= h) continue;
      const j = jy * w + jx;
      const cj = cls[j]!;
      if (cj === NONE) continue;
      // windows only straight across their wall
      if ((ci === WIN_V || cj === WIN_V) && dx === 0) continue;
      if ((ci === WIN_H || cj === WIN_H) && dy === 0) continue;
      if (win(ci) && win(cj)) continue;
      let c = win(ci) || win(cj) ? this.#half : this.#orth;
      if (cj === LOCKED) c += this.#lock;
      fn(j, c);
    }
    if (ci !== FLOOR) return;
    for (let d = 0; d < 4; d++) {
      const dx = d & 1 ? -1 : 1;
      const dy = d & 2 ? -1 : 1;
      const jx = x + dx;
      const jy = y + dy;
      if (jx < 0 || jy < 0 || jx >= w || jy >= h) continue;
      const j = jy * w + jx;
      if (cls[j] === FLOOR && cls[y * w + jx] === FLOOR && cls[jy * w + x] === FLOOR) fn(j, this.#diag);
    }
  }

  #nearest(x: number, y: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    const { w, h } = this.map;
    let best = -1;
    let bestD = 9;
    for (let ty = Math.max(0, Math.floor(y - 3)); ty <= Math.min(h - 1, Math.floor(y + 3)); ty++) {
      for (let tx = Math.max(0, Math.floor(x - 3)); tx <= Math.min(w - 1, Math.floor(x + 3)); tx++) {
        const i = ty * w + tx;
        if (!this.inkable(i)) continue;
        const dx = tx + 0.5 - x;
        const dy = ty + 0.5 - y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------- views

/**
 * The tiles the ink can be on (floor, doors, windows), 1 each: the
 * frame of reference of the encoding. Both ends compute it from the
 * blueprint; the other tiles are never sent.
 */
export function inkMask(map: Blueprint): Uint8Array {
  const n = map.w * map.h;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = map.tiles[i];
    m[i] = t === TILE.FLOOR || t === TILE.DOOR || t === TILE.WINDOW ? 1 : 0;
  }
  return m;
}

/**
 * The ink for a view, as a string. Only the tiles of `mask`
 * ({@link inkMask}) count, in row-major order; one letter says how:
 *
 * - `K` + runs: a keyframe, the lengths of alternating runs of
 *   uninked and inked tiles, uninked first (that run may be empty), as
 *   unsigned varints, base64url ({@link toBase64});
 * - `B` + bits: a keyframe as a plain bitset, a bit a tile, low bit
 *   first, base64url (when the ink is too ragged for runs);
 * - `D` + runs: a delta, the runs of the tiles that changed since `prev`.
 *
 * The shortest wins (a delta only when `prev` is given). An 86×54
 * estate's keyframe is at most ~600 characters (the bitset), usually
 * far less; a 100 ms delta a few dozen. Deltas need every frame, in
 * order: over a lossy channel send keyframes only (no `prev`), or a
 * keyframe every so often with a sequence number.
 */
export function encodeInk(bits: ArrayLike<number>, mask: ArrayLike<number>, prev?: ArrayLike<number> | null): string {
  const idx: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
  const at = (k: number) => (bits[idx[k]!] ? 1 : 0);
  const key = "K" + runs(idx.length, at);
  const raw = new Uint8Array(Math.ceil(idx.length / 8));
  for (let k = 0; k < idx.length; k++) if (at(k)) raw[k >> 3]! |= 1 << (k & 7);
  const flat = "B" + toBase64(raw);
  let best = flat.length < key.length ? flat : key;
  if (prev && prev.length === mask.length) {
    const delta = "D" + runs(idx.length, (k) => at(k) ^ (prev[idx[k]!] ? 1 : 0));
    if (delta.length < best.length) best = delta;
  }
  return best;
}

function runs(n: number, bit: (k: number) => number): string {
  const w = new VarintWriter();
  let cur = 0;
  let len = 0;
  for (let k = 0; k < n; k++) {
    if (bit(k) === cur) len++;
    else {
      w.uint(len);
      cur ^= 1;
      len = 1;
    }
  }
  if (len > 0 || n === 0) w.uint(len);
  return toBase64(w.bytes);
}

/**
 * {@link encodeInk} back to a 0/1 value per tile (`mask.length`; 0
 * outside the mask; a delta applied to `prev`), or null for anything
 * malformed, a wrong length or a delta without a `prev`. Never throws.
 */
export function decodeInk(s: unknown, mask: ArrayLike<number>, prev?: ArrayLike<number> | null): Uint8Array | null {
  if (typeof s !== "string" || s.length < 1 || !mask || typeof mask.length !== "number") return null;
  const kind = s[0];
  if (kind !== "K" && kind !== "D" && kind !== "B") return null;
  if (kind === "D" && (!prev || prev.length !== mask.length)) return null;
  const bytes = fromBase64(s.slice(1));
  if (!bytes) return null;
  const idx: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
  const n = idx.length;
  const out = new Uint8Array(mask.length);
  if (kind === "B") {
    if (bytes.length !== Math.ceil(n / 8)) return null;
    for (let k = 0; k < n; k++) out[idx[k]!] = (bytes[k >> 3]! >> (k & 7)) & 1;
    return out;
  }
  const r = new VarintReader(bytes);
  let o = 0;
  let cur = 0;
  let first = true;
  while (!r.done) {
    const len = r.uint();
    if (len < 0 || (len === 0 && !first) || o + len > n) return null;
    if (cur) for (let k = o; k < o + len; k++) out[idx[k]!] = 1;
    o += len;
    cur ^= 1;
    first = false;
  }
  if (o !== n) return null;
  if (kind === "D") for (const i of idx) out[i] = out[i]! ^ (prev![i] ? 1 : 0);
  return out;
}
