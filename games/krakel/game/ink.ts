/**
 * Krakel's ink as geometry, without a canvas: a stroke's smoothed path,
 * what it costs in a replay, and the cut of a drawing at a point of its
 * replay (which strokes are whole, how far the one being drawn got, where
 * the pen is). The pages draw with it (`phone/ink.js`), so the phone's
 * pad, the phones' small replay and the TV's show the same picture at the
 * same moment; known answers in test/ink.test.ts.
 *
 * A drawing is `{ strokes }`, each stroke `[colour, width, x0, y0, x1,
 * y1, …]` on a GRID × GRID square (one point: a dot), `colour` an index
 * of the palette (game/rules.ts).
 *
 * This module imports nothing: the phone and TV pages load it as it is.
 */

/** Drawings are on a GRID × GRID square. */
export const GRID = 1000;
/** The paper. The first pen has its colour: the eraser. */
export const PAPER = "#fffdf5";
/** The pens (a stroke's colour is an index): the eraser, black, grey, then the colours. */
export const PALETTE = [
  PAPER,
  "#1b1b22",
  "#8e939c",
  "#e5383b",
  "#f6821f",
  "#ffd21f",
  "#74c044",
  "#198a54",
  "#3fc1ee",
  "#2456c8",
  "#8a47c2",
  "#f472b0",
  "#8a572c",
  "#f2c8a2",
] as const;
export const ERASER = 0;
/** The pens' widths on the grid (fine, medium, thick, a brush). */
export const WIDTHS = [6, 14, 30, 64] as const;
export const MAX_WIDTH = 120;
/** The most strokes and points of one drawing (one message within the 256 KiB limit). */
export const MAX_STROKES = 900;
export const MAX_POINTS = 20_000;
/** What lifting the pen and setting it down again costs in a replay, in grid units of ink. */
export const LIFT = 45;
/** What a dot costs. */
export const DOT = 14;
/** A replay's drawing is finished after this share of the guess time; the rest shows it whole. */
export const DRAWN = 0.85;

type Stroke = readonly number[];

const sampled = new WeakMap<Stroke, number[]>();

/** How many points a stroke has. */
export function pointsOf(s: Stroke): number {
  return Math.max(0, (s.length - 2) >> 1);
}

/**
 * A stroke's path as a polyline `[x, y, …]` in grid units: a quadratic
 * curve through the midpoints of its points, sampled (what the pad draws
 * piece by piece while the finger moves).
 */
export function polyline(s: Stroke): number[] {
  let out = sampled.get(s);
  if (out) return out;
  out = [];
  const n = pointsOf(s);
  const x = (i: number) => s[2 + 2 * i]!;
  const y = (i: number) => s[3 + 2 * i]!;
  if (n <= 2) {
    for (let i = 0; i < n; i++) out.push(x(i), y(i));
  } else {
    out.push(x(0), y(0));
    let px = (x(0) + x(1)) / 2;
    let py = (y(0) + y(1)) / 2;
    out.push(px, py);
    for (let i = 1; i < n - 1; i++) {
      const cx = x(i);
      const cy = y(i);
      const nx = (cx + x(i + 1)) / 2;
      const ny = (cy + y(i + 1)) / 2;
      for (let t = 1; t <= 4; t++) {
        const u = t / 4;
        const a = (1 - u) * (1 - u);
        const b = 2 * (1 - u) * u;
        const c = u * u;
        out.push(a * px + b * cx + c * nx, a * py + b * cy + c * ny);
      }
      px = nx;
      py = ny;
    }
    out.push(x(n - 1), y(n - 1));
  }
  sampled.set(s, out);
  return out;
}

/** The length of a polyline `[x, y, …]`. */
export function lengthOf(p: readonly number[]): number {
  let len = 0;
  for (let i = 2; i + 1 < p.length; i += 2) len += Math.hypot(p[i]! - p[i - 2]!, p[i + 1]! - p[i - 1]!);
  return len;
}

/** The ink of a stroke itself (a dot: {@link DOT}). */
export function inkOf(s: Stroke): number {
  return pointsOf(s) <= 1 ? DOT : Math.max(DOT, lengthOf(polyline(s)));
}

/** What a stroke costs in a replay: the pen's way to it ({@link LIFT}), then its ink. */
export function costOf(s: Stroke): number {
  return LIFT + inkOf(s);
}

/** What a whole drawing costs. */
export function totalCost(strokes: readonly Stroke[]): number {
  let sum = 0;
  for (const s of strokes) sum += costOf(s);
  return sum;
}

/** A drawing at a point of its replay. */
export interface Cut {
  /** Strokes drawn whole (the first `whole` ones). */
  whole: number;
  /** The stroke being drawn: its path so far as a polyline `[x, y, …]` (one point: its start), or null. */
  part: number[] | null;
  /** Where the pen is (grid units), or null before the first stroke and when the drawing is done. */
  tip: [number, number] | null;
  /** Whether the pen is on the paper (false: on its way to the next stroke). */
  down: boolean;
}

/**
 * A drawing after `progress` (0–1) of its replay. The replay spends its
 * time by ink: every stroke takes the pen's way to it, then its length,
 * so a drawing of any size fills the same time, and the order in which
 * it was drawn is the order in which it shows.
 */
export function cut(strokes: readonly Stroke[], progress: number): Cut {
  if (!(progress > 0) || strokes.length === 0) return { whole: 0, part: null, tip: null, down: false };
  if (progress >= 1) return { whole: strokes.length, part: null, tip: null, down: false };
  let left = totalCost(strokes) * progress;
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i]!;
    const c = costOf(s);
    if (left >= c) {
      left -= c;
      continue;
    }
    const p = polyline(s);
    const sx = p[0] ?? 0;
    const sy = p[1] ?? 0;
    if (left < LIFT) {
      // On the way: from where the last stroke ended to where this one starts.
      const prev = i > 0 ? polyline(strokes[i - 1]!) : p;
      const fx = prev.at(-2) ?? sx;
      const fy = prev.at(-1) ?? sy;
      const f = i > 0 ? left / LIFT : 1;
      return { whole: i, part: null, tip: [fx + (sx - fx) * f, fy + (sy - fy) * f], down: false };
    }
    let ink = left - LIFT;
    const part = [sx, sy];
    let tip: [number, number] = [sx, sy];
    // A dot (or a stroke shorter than one) fills its time on the spot.
    const scale = pointsOf(s) <= 1 ? 0 : lengthOf(p) / inkOf(s);
    ink *= scale;
    for (let j = 2; j + 1 < p.length && ink > 0; j += 2) {
      const d = Math.hypot(p[j]! - p[j - 2]!, p[j + 1]! - p[j - 1]!);
      const f = d > ink ? ink / d : 1;
      tip = [p[j - 2]! + (p[j]! - p[j - 2]!) * f, p[j - 1]! + (p[j + 1]! - p[j - 1]!) * f];
      part.push(tip[0], tip[1]);
      ink -= d;
    }
    return { whole: i, part, tip, down: true };
  }
  return { whole: strokes.length, part: null, tip: null, down: false };
}

/**
 * How far a replay is at `now`: it starts at `start`, the drawing is
 * whole at `start + (end - start) · DRAWN`, and stays until `end`.
 */
export function progressAt(now: number, start: number, end: number): number {
  const drawn = (end - start) * DRAWN;
  if (!(drawn > 0)) return now >= start ? 1 : 0;
  return Math.max(0, Math.min(1, (now - start) / drawn));
}
