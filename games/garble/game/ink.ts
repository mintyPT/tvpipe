/**
 * Garble's ink as geometry, without a canvas: the grid and the limits of
 * a drawing, a stroke's smoothed path and length, and the cut of a
 * drawing at a point of its replay (which strokes are whole, how far the
 * one being drawn got). The rules check drawings with the limits
 * (`game/rules.ts`), the pages draw with the rest (`phone/ink.js`), so
 * the pad, the phones and the TV show the same picture; known answers in
 * test/ink.test.ts.
 *
 * A drawing is `{ strokes }`, each stroke `[width, x0, y0, x1, y1, …]`
 * on a GRID × GRID square (one point: a dot).
 *
 * This module imports nothing: the phone and TV pages load it as it is.
 */

/** Drawings are on a GRID × GRID square. */
export const GRID = 1000;
/** The pad's pens (fine, medium, thick), in grid units. */
export const WIDTHS = [7, 16, 38] as const;
export const MAX_WIDTH = 80;
/** The most strokes and points of one layer (one message within the 256 KiB limit). */
export const MAX_STROKES = 400;
export const MAX_POINTS = 16_000;
/** What a dot counts for in a replay, in grid units of ink. */
export const DOT = 12;

type Stroke = readonly number[];

const sampled = new WeakMap<Stroke, number[]>();

/** How many points a stroke has. */
export function pointsOf(s: Stroke): number {
  return Math.max(0, (s.length - 1) >> 1);
}

/**
 * A stroke's path as a polyline `[x, y, …]` in grid units: a quadratic
 * curve through the midpoints of its points, sampled (what the pad draws
 * piece by piece while the finger moves). Sampled once per stroke.
 */
export function polyline(s: Stroke): number[] {
  let out = sampled.get(s);
  if (out) return out;
  out = [];
  const n = pointsOf(s);
  const x = (i: number) => s[1 + 2 * i]!;
  const y = (i: number) => s[2 + 2 * i]!;
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

/** What a stroke counts for in a replay: its length (a dot: {@link DOT}). */
export function inkOf(s: Stroke): number {
  return pointsOf(s) <= 1 ? DOT : lengthOf(polyline(s));
}

/** The ink of a whole drawing. */
export function totalInk(strokes: readonly Stroke[]): number {
  let sum = 0;
  for (const s of strokes) sum += inkOf(s);
  return sum;
}

/** A drawing at a point of its replay. */
export interface Cut {
  /** Strokes drawn whole (the first `whole` ones). */
  whole: number;
  /** The stroke being drawn: its path so far as a polyline `[x, y, …]`, or null (a dot shows only whole). */
  part: number[] | null;
}

/**
 * A drawing after `progress` (0–1) of its replay: the replay spends its
 * time by ink, stroke by stroke in the order they were drawn, so a long
 * line takes longer than a dot.
 */
export function cut(strokes: readonly Stroke[], progress: number): Cut {
  if (!(progress > 0) || strokes.length === 0) return { whole: 0, part: null };
  if (progress >= 1) return { whole: strokes.length, part: null };
  let left = totalInk(strokes) * progress;
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i]!;
    const c = inkOf(s);
    if (left >= c) {
      left -= c;
      continue;
    }
    if (pointsOf(s) <= 1 || left <= 0) return { whole: i, part: null };
    const p = polyline(s);
    const part = [p[0]!, p[1]!];
    for (let j = 2; j + 1 < p.length && left > 0; j += 2) {
      const d = Math.hypot(p[j]! - p[j - 2]!, p[j + 1]! - p[j - 1]!);
      const f = d > left ? left / d : 1;
      part.push(p[j - 2]! + (p[j]! - p[j - 2]!) * f, p[j - 1]! + (p[j + 1]! - p[j - 1]!) * f);
      left -= d;
    }
    return { whole: i, part };
  }
  return { whole: strokes.length, part: null };
}

/** How long a replay of a drawing takes, ms: by its ink and strokes, between `min` and `max`. */
export function replayTime(strokes: readonly Stroke[], min = 900, max = 2600): number {
  return Math.max(min, Math.min(max, totalInk(strokes) * 0.45 + strokes.length * 40));
}
