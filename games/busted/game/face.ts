/**
 * Press photos: the portraits players draw of themselves on their phone
 * (black marker on a FACE × FACE square), checked by the host, and the
 * doodles the game draws for those who did not (and for honorary
 * candidates), from their name, the same every time. Both are a list of
 * strokes `[x0, y0, x1, y1, …]` in whole grid units; the TV and the
 * phones draw them as SVG paths ({@link pathOf}).
 *
 * This module imports nothing: the phone and TV pages load it as it is.
 */

/** Portraits are on a FACE × FACE square. */
export const FACE = 100;
/** The most strokes and points of a portrait (every phone gets every face: keep them small). */
export const MAX_STROKES = 160;
export const MAX_POINTS = 1600;

export type Strokes = number[][];

/**
 * A portrait as a phone sent it (`{ strokes }` or the list): whole
 * numbers on the grid, pairs, within the limits. `null`: not a portrait.
 * An empty list is "no portrait" (the doodle again).
 */
export function readPortrait(data: unknown): Strokes | null {
  const list = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as { strokes?: unknown }).strokes : data;
  if (!Array.isArray(list) || list.length > MAX_STROKES) return null;
  let points = 0;
  const out: Strokes = [];
  for (const s of list) {
    if (!Array.isArray(s) || s.length < 2 || s.length % 2 !== 0) return null;
    const stroke: number[] = [];
    for (const v of s) {
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      stroke.push(Math.max(0, Math.min(FACE, Math.round(v))));
    }
    points += stroke.length / 2;
    if (points > MAX_POINTS) return null;
    out.push(stroke);
  }
  return out;
}

/**
 * A stroke as an SVG path: a smooth curve through the midpoints of its
 * points (one point: a dot, a tiny line the round cap makes round).
 */
export function pathOf(s: readonly number[]): string {
  const n = s.length >> 1;
  if (n === 0) return "";
  const x = (i: number) => s[2 * i]!;
  const y = (i: number) => s[2 * i + 1]!;
  if (n === 1) return `M${x(0)} ${y(0)}l0.01 0`;
  if (n === 2) return `M${x(0)} ${y(0)}L${x(1)} ${y(1)}`;
  let d = `M${x(0)} ${y(0)}`;
  for (let i = 1; i < n - 1; i++) {
    const mx = (x(i) + x(i + 1)) / 2;
    const my = (y(i) + y(i + 1)) / 2;
    d += `Q${x(i)} ${y(i)} ${+mx.toFixed(1)} ${+my.toFixed(1)}`;
  }
  return `${d}L${x(n - 1)} ${y(n - 1)}`;
}

/**
 * Drops points closer than `min` grid units to the last one kept (a
 * finger sends many): what the phone does before it sends a stroke.
 */
export function thin(s: readonly number[], min = 1.2): number[] {
  const n = s.length >> 1;
  if (n <= 2) return [...s];
  const out = [s[0]!, s[1]!];
  for (let i = 1; i < n - 1; i++) {
    const dx = s[2 * i]! - out[out.length - 2]!;
    const dy = s[2 * i + 1]! - out[out.length - 1]!;
    if (dx * dx + dy * dy >= min * min) out.push(s[2 * i]!, s[2 * i + 1]!);
  }
  out.push(s[2 * n - 2]!, s[2 * n - 1]!);
  return out;
}

// ---------------------------------------------------------------------------
// Doodles

/** A number from a text (FNV-1a), the seed of its doodle. */
export function hash(text: string): number {
  let x = 2166136261;
  for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 16777619);
  return x >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r = (v: number) => Math.round(v);

/** An ellipse as one stroke, a little wobbly (drawn by hand). */
function ellipse(cx: number, cy: number, rx: number, ry: number, rand: () => number, steps = 22, from = 0, to = Math.PI * 2): number[] {
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    const w = 1 + (rand() - 0.5) * 0.06;
    out.push(r(cx + Math.cos(a) * rx * w), r(cy + Math.sin(a) * ry * w));
  }
  return out;
}

/**
 * A face drawn from a name: a head, eyes, brows or not, a nose, a mouth
 * and hair (spikes, curls, a fringe, a bun, a cap, or none), in a few
 * strokes the size of a drawn portrait. The same name always gets the
 * same face.
 */
export function doodle(name: string): Strokes {
  const rand = rng(hash(name.toLowerCase()));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const out: Strokes = [];
  const cx = 50;
  const cy = 54 + r(rand() * 4);
  const rx = 25 + r(rand() * 7);
  const ry = 29 + r(rand() * 6);
  out.push(ellipse(cx, cy, rx, ry, rand, 26));
  const top = cy - ry;
  // Hair.
  const hair = pick(["spikes", "curls", "fringe", "bun", "cap", "none", "spikes", "fringe", "cap", "none"] as const);
  if (hair === "spikes") {
    const s: number[] = [];
    const n = 6 + Math.floor(rand() * 4);
    for (let i = 0; i <= n; i++) {
      const a = Math.PI + (Math.PI * i) / n;
      const lift = i % 2 === 0 ? 0 : 8 + rand() * 6;
      s.push(r(cx + Math.cos(a) * (rx + lift * 0.4)), r(cy + Math.sin(a) * (ry + lift) - 2));
    }
    out.push(s);
  } else if (hair === "curls") {
    const n = 5 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i++) {
      const a = Math.PI * 1.08 + (Math.PI * 0.84 * i) / (n - 1);
      out.push(ellipse(r(cx + Math.cos(a) * rx * 0.95), r(cy + Math.sin(a) * ry * 0.95), 7, 6, rand, 12));
    }
  } else if (hair === "fringe") {
    const s: number[] = [];
    for (let i = 0; i <= 8; i++) {
      const x = cx - rx + (2 * rx * i) / 8;
      s.push(r(x), r(top + 12 + (i % 2) * 5 + rand() * 3));
    }
    out.push(ellipse(cx, cy, rx + 2, ry + 2, rand, 16, Math.PI * 1.02, Math.PI * 1.98), s);
  } else if (hair === "bun") {
    out.push(ellipse(cx, top - 6, 10, 8, rand, 14), ellipse(cx, cy, rx + 1, ry + 1, rand, 14, Math.PI * 1.15, Math.PI * 1.85));
  } else if (hair === "cap") {
    out.push(ellipse(cx, top + 10, rx + 1, 12, rand, 14, Math.PI, Math.PI * 2), [r(cx - rx - 1), r(top + 10), r(cx + rx + 16), r(top + 12)]);
  }
  // Eyes.
  const ey = cy - 6 + r(rand() * 4);
  const ex = 9 + r(rand() * 4);
  const eyes = pick(["dots", "rings", "sleepy", "dots", "rings"] as const);
  for (const side of [-1, 1]) {
    const x = cx + side * ex;
    if (eyes === "dots") out.push([x, ey, x, ey + 1]);
    else if (eyes === "rings") out.push(ellipse(x, ey, 4, 4, rand, 10), [x, ey, x, ey]);
    else out.push([x - 4, ey, x, ey + 2, x + 4, ey]);
  }
  if (rand() < 0.6) {
    const tilt = rand() < 0.5 ? 2 : -2;
    for (const side of [-1, 1]) {
      const x = cx + side * ex;
      out.push([x - 5, ey - 8 + (side === 1 ? tilt : -tilt), x + 5, ey - 8 - (side === 1 ? tilt : -tilt)]);
    }
  }
  if (rand() < 0.25) out.push(ellipse(cx - ex, ey, 7, 6, rand, 12), ellipse(cx + ex, ey, 7, 6, rand, 12), [cx - ex + 7, ey, cx + ex - 7, ey]);
  // Nose.
  const ny = ey + 10;
  out.push(pick([[cx, ny - 5, cx - 3, ny + 3, cx + 1, ny + 3], [cx - 1, ny, cx + 1, ny + 1], [cx + 2, ny - 6, cx - 2, ny + 2, cx + 3, ny + 3]]));
  // Mouth.
  const my = ny + 11 + r(rand() * 3);
  const mw = 9 + r(rand() * 6);
  const mouth = pick(["smile", "grin", "o", "flat", "smile", "smirk"] as const);
  if (mouth === "smile") out.push([cx - mw, my - 2, cx - mw / 2, my + 3, cx, my + 4, cx + mw / 2, my + 3, cx + mw, my - 2].map(r));
  else if (mouth === "grin") out.push([cx - mw, my - 2, cx, my + 6, cx + mw, my - 2, cx - mw, my - 2].map(r));
  else if (mouth === "o") out.push(ellipse(cx, my + 1, 4, 5, rand, 12));
  else if (mouth === "flat") out.push([cx - mw * 0.7, my, cx + mw * 0.7, my + 1].map(r));
  else out.push([cx - mw * 0.8, my + 1, cx + mw * 0.3, my + 2, cx + mw, my - 3].map(r));
  // Ears, sometimes.
  if (rand() < 0.5) for (const side of [-1, 1]) out.push(ellipse(cx + side * (rx + 2), ey + 4, 4, 7, rand, 10, side === 1 ? -Math.PI / 2 : Math.PI / 2, side === 1 ? Math.PI / 2 : Math.PI * 1.5));
  return out.map((s) => s.map((v) => Math.max(0, Math.min(FACE, r(v)))));
}
