// @ts-check
/**
 * Garble's ink: strokes on paper. The phone's pad, the guess screen and
 * the TV all draw with this module, so a drawing looks the same
 * everywhere. A drawing is `{ strokes }`, each stroke `[width, x0, y0,
 * x1, y1, …]` on a 1000 × 1000 grid (one point: a dot). During play the
 * ink is black (the pad shows the old ink a shade lighter); in the reveal
 * each layer is in its drawer's colour.
 *
 * Strokes are smoothed the same way everywhere: a quadratic curve
 * through the midpoints of the points (the pad draws it piece by piece
 * while the finger moves, see {@link Live}). A replay draws a drawing
 * the way it was drawn, stroke by stroke, along its length. The geometry
 * (the grid, the limits, the paths, a replay's cut) is `game/ink.ts`,
 * shared with the rules.
 */

import { cut, GRID, polyline, replayTime as timeOf } from "../game/ink.js";

export { GRID, MAX_POINTS, MAX_STROKES, WIDTHS } from "../game/ink.js";

export const INK = "#17161c";
/** The old ink on the pad: the layers before yours, a shade lighter than your own. */
export const OLD_INK = "#8d8a97";
export const PAPER = "#fbf8f1";

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w the stroke's width in grid units
 * @param {number} k px per grid unit
 * @param {string} [color]
 */
function pen(ctx, w, k, color = INK) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, w * k);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

/**
 * One whole stroke, smoothed.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} s
 * @param {number} x0
 * @param {number} y0
 * @param {number} k px per grid unit
 * @param {string} [color]
 */
export function strokePath(ctx, s, x0, y0, k, color = INK) {
  pen(ctx, s[0], k, color);
  const n = (s.length - 1) / 2;
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(x0 + s[1] * k, y0 + s[2] * k, Math.max(0.5, (s[0] * k) / 2), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const p = polyline(s);
  ctx.beginPath();
  ctx.moveTo(x0 + p[0] * k, y0 + p[1] * k);
  for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(x0 + p[i] * k, y0 + p[i + 1] * k);
  ctx.stroke();
}

/**
 * A polyline (`[x, y, …]` in grid units) with a stroke's pen: the part
 * of a stroke a replay has drawn so far.
 * @param {CanvasRenderingContext2D} ctx
 * @param {readonly number[]} s the stroke (its width)
 * @param {readonly number[]} p
 * @param {number} x0
 * @param {number} y0
 * @param {number} k px per grid unit
 * @param {string} color
 */
function path(ctx, s, p, x0, y0, k, color) {
  pen(ctx, s[0], k, color);
  ctx.beginPath();
  ctx.moveTo(x0 + p[0] * k, y0 + p[1] * k);
  for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(x0 + p[i] * k, y0 + p[i + 1] * k);
  ctx.stroke();
}

/**
 * A whole drawing on paper, `size` px square at (x, y).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ strokes?: number[][] } | null | undefined} drawing
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @param {{ paper?: string | null, progress?: number, color?: string }} [opts] `paper: null`: on what is there;
 *   `progress` 0–1: a replay's point (by length); `color`: the ink
 */
export function drawInk(ctx, drawing, x, y, size, opts = {}) {
  const color = opts.color ?? INK;
  ctx.save();
  if (opts.paper !== null) {
    ctx.fillStyle = opts.paper ?? PAPER;
    ctx.fillRect(x, y, size, size);
  }
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  const k = size / GRID;
  const strokes = drawing?.strokes ?? [];
  const c = cut(strokes, opts.progress ?? 1);
  for (let i = 0; i < c.whole; i++) strokePath(ctx, strokes[i], x, y, k, color);
  if (c.part) path(ctx, strokes[c.whole], c.part, x, y, k, color);
  ctx.restore();
}

/**
 * A picture of several layers on paper, each in its own ink (`color`,
 * default black), `size` px square at (x, y).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ drawing?: { strokes?: number[][] } | null, color?: string }[]} layers
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @param {{ paper?: string | null }} [opts]
 */
export function drawLayers(ctx, layers, x, y, size, opts = {}) {
  if (opts.paper !== null) {
    ctx.fillStyle = opts.paper ?? PAPER;
    ctx.fillRect(x, y, size, size);
  }
  for (const l of layers) drawInk(ctx, l.drawing, x, y, size, { paper: null, color: l.color ?? INK });
}

/**
 * How long a replay of a drawing takes, ms: by its ink, between `min` and `max`.
 * @param {{ strokes?: number[][] } | null | undefined} drawing
 */
export function replayTime(drawing, min = 900, max = 2600) {
  return timeOf(drawing?.strokes ?? [], min, max);
}

/**
 * Replays a drawing into a canvas (`size` px, its backing store already
 * scaled), over `ms`; resolves when done or cancelled (`signal`). With
 * `paper: null` the canvas is a transparent sheet over another (cleared
 * each frame). The strokes that are whole are kept on a sheet of their
 * own, so a frame only adds what is new and the stroke being drawn.
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} drawing
 * @param {number} size
 * @param {number} ms
 * @param {{ aborted: boolean }} [signal]
 * @param {(progress: number) => void} [each] after each frame
 * @param {{ paper?: string | null, color?: string }} [opts]
 */
export function replay(ctx, drawing, size, ms, signal, each, opts = {}) {
  const strokes = drawing?.strokes ?? [];
  const color = opts.color ?? INK;
  const k = size / GRID;
  const sheet = document.createElement("canvas");
  sheet.width = ctx.canvas.width;
  sheet.height = ctx.canvas.height;
  const sc = /** @type {CanvasRenderingContext2D} */ (sheet.getContext("2d"));
  sc.setTransform(ctx.getTransform());
  if (opts.paper !== null) {
    sc.fillStyle = opts.paper ?? PAPER;
    sc.fillRect(0, 0, size, size);
  }
  let done = 0;
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = () => {
      if (signal?.aborted) return resolve(undefined);
      const p = Math.min(1, (performance.now() - t0) / ms);
      // Ease out: quick strokes first, the last ones settle.
      const e = 1 - Math.pow(1 - p, 1.6);
      const c = cut(strokes, e);
      while (done < c.whole) strokePath(sc, strokes[done++], 0, 0, k, color);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (opts.paper === null) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.drawImage(sheet, 0, 0);
      ctx.restore();
      if (c.part) path(ctx, strokes[c.whole], c.part, 0, 0, k, color);
      each?.(e);
      if (p < 1) requestAnimationFrame(frame);
      else resolve(undefined);
    };
    frame();
  });
}

/**
 * A canvas sized for its box and the screen's pixels: returns its
 * context with the transform set, and the size in CSS px (square).
 * @param {HTMLCanvasElement} canvas
 */
export function fit(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const size = Math.max(1, r.width);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, size };
}

/**
 * A stroke being drawn: each new point adds the next piece of the same
 * smooth curve {@link strokePath} draws for the whole stroke.
 */
export class Live {
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number[]} s the stroke (`[width, x, y]` so far; points are pushed onto it)
   * @param {number} k px per grid unit
   * @param {string} [color]
   */
  constructor(ctx, s, k, color = INK) {
    this.ctx = ctx;
    this.s = s;
    this.k = k;
    this.color = color;
    // The first point: a dot until the finger moves.
    pen(ctx, s[0], k, color);
    ctx.beginPath();
    ctx.arc(s[1] * k, s[2] * k, Math.max(0.5, (s[0] * k) / 2), 0, Math.PI * 2);
    ctx.fill();
  }

  /** After a point was pushed onto the stroke. */
  add() {
    const { ctx, s, k } = this;
    const n = (s.length - 1) / 2;
    const x = (/** @type {number} */ i) => s[1 + 2 * i] * k;
    const y = (/** @type {number} */ i) => s[2 + 2 * i] * k;
    pen(ctx, s[0], k, this.color);
    ctx.beginPath();
    if (n === 2) {
      ctx.moveTo(x(0), y(0));
      ctx.lineTo((x(0) + x(1)) / 2, (y(0) + y(1)) / 2);
    } else {
      const i = n - 2;
      ctx.moveTo((x(i - 1) + x(i)) / 2, (y(i - 1) + y(i)) / 2);
      ctx.quadraticCurveTo(x(i), y(i), (x(i) + x(i + 1)) / 2, (y(i) + y(i + 1)) / 2);
    }
    ctx.stroke();
  }

  /** The stroke ends: the last half segment. */
  end() {
    const { ctx, s, k } = this;
    const n = (s.length - 1) / 2;
    if (n < 2) return;
    pen(ctx, s[0], k, this.color);
    ctx.beginPath();
    ctx.moveTo(((s[2 * n - 3] + s[2 * n - 1]) / 2) * k, ((s[2 * n - 2] + s[2 * n]) / 2) * k);
    ctx.lineTo(s[2 * n - 1] * k, s[2 * n] * k);
    ctx.stroke();
  }
}
