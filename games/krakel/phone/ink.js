// @ts-check
/**
 * Krakel's ink on a canvas. The phone's pad, the phones' small replay
 * and the TV all draw with this module (and the geometry of
 * `game/ink.ts`), so a drawing looks the same everywhere and a replay is
 * at the same stroke at the same moment. A drawing is `{ strokes }`,
 * each stroke `[colour, width, x0, y0, x1, y1, …]` on a 1000 × 1000
 * grid (one point: a dot), `colour` an index of the palette (0: the
 * eraser, which paints paper).
 *
 * Strokes are smoothed the same way everywhere: a quadratic curve
 * through the midpoints of the points (the pad draws it piece by piece
 * while the finger moves, see {@link Live}).
 */

import { cut, GRID, PALETTE, PAPER, pointsOf, polyline } from "../game/ink.js";

export { ERASER, GRID, MAX_POINTS, MAX_STROKES, PALETTE, PAPER, progressAt, WIDTHS } from "../game/ink.js";

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {readonly number[]} s the stroke (its colour and width)
 * @param {number} k px per grid unit
 */
function pen(ctx, s, k) {
  const color = PALETTE[s[0]] ?? PALETTE[1];
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, s[1] * k);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

/**
 * A polyline (`[x, y, …]` in grid units; one point: a dot) with a stroke's pen.
 * @param {CanvasRenderingContext2D} ctx
 * @param {readonly number[]} s
 * @param {readonly number[]} p
 * @param {number} x0
 * @param {number} y0
 * @param {number} k
 */
function path(ctx, s, p, x0, y0, k) {
  pen(ctx, s, k);
  if (p.length < 2) return;
  if (p.length === 2) {
    ctx.beginPath();
    ctx.arc(x0 + p[0] * k, y0 + p[1] * k, Math.max(0.5, (s[1] * k) / 2), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x0 + p[0] * k, y0 + p[1] * k);
  for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(x0 + p[i] * k, y0 + p[i + 1] * k);
  ctx.stroke();
}

/**
 * One whole stroke, smoothed.
 * @param {CanvasRenderingContext2D} ctx
 * @param {readonly number[]} s
 * @param {number} x0
 * @param {number} y0
 * @param {number} k px per grid unit
 */
export function strokePath(ctx, s, x0, y0, k) {
  path(ctx, s, polyline(s), x0, y0, k);
}

/**
 * A whole drawing on paper, `size` px square at (x, y).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ strokes?: number[][] } | null | undefined} drawing
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @param {{ progress?: number }} [opts] `progress` 0–1: a replay's point
 */
export function drawInk(ctx, drawing, x, y, size, opts = {}) {
  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.fillRect(x, y, size, size);
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  const k = size / GRID;
  const strokes = drawing?.strokes ?? [];
  const c = cut(strokes, opts.progress ?? 1);
  for (let i = 0; i < c.whole; i++) strokePath(ctx, strokes[i], x, y, k);
  if (c.part) path(ctx, strokes[c.whole], c.part, x, y, k);
  ctx.restore();
  return c;
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
 * A drawing's replay in a canvas: the strokes that are whole are kept
 * on a sheet of their own, so a frame only adds what is new and the
 * stroke being drawn.
 */
export class Replay {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ strokes?: number[][] } | null | undefined} drawing
   */
  constructor(canvas, drawing) {
    this.canvas = canvas;
    this.strokes = drawing?.strokes ?? [];
    this.sheet = document.createElement("canvas");
    /** @type {CanvasRenderingContext2D | null} */
    this.ctx = null;
    /** @type {CanvasRenderingContext2D | null} */
    this.sheetCtx = null;
    this.size = 0;
    /** Strokes on the sheet. */
    this.done = 0;
  }

  /** Sizes the canvas for its box (again after a resize). */
  resize() {
    const f = fit(this.canvas);
    this.ctx = f.ctx;
    this.size = f.size;
    this.sheet.width = this.canvas.width;
    this.sheet.height = this.canvas.height;
    this.sheetCtx = /** @type {CanvasRenderingContext2D} */ (this.sheet.getContext("2d"));
    this.sheetCtx.setTransform(this.canvas.width / f.size, 0, 0, this.canvas.height / f.size, 0, 0);
    this.done = -1;
  }

  /**
   * The drawing after `progress` (0–1) of its replay; returns the cut
   * (where the pen is).
   * @param {number} progress
   */
  draw(progress) {
    if (!this.ctx || !this.sheetCtx) this.resize();
    const ctx = /** @type {CanvasRenderingContext2D} */ (this.ctx);
    const sheet = /** @type {CanvasRenderingContext2D} */ (this.sheetCtx);
    const size = this.size;
    const k = size / GRID;
    const c = cut(this.strokes, progress);
    if (this.done < 0 || c.whole < this.done) {
      sheet.fillStyle = PAPER;
      sheet.fillRect(0, 0, size, size);
      this.done = 0;
    }
    while (this.done < c.whole) strokePath(sheet, this.strokes[this.done++], 0, 0, k);
    ctx.drawImage(this.sheet, 0, 0, size, size);
    if (c.part) path(ctx, this.strokes[c.whole], c.part, 0, 0, k);
    return c;
  }
}

/**
 * A stroke being drawn: each new point adds the next piece of the same
 * smooth curve {@link strokePath} draws for the whole stroke.
 */
export class Live {
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number[]} s the stroke (`[colour, width, x, y]` so far; points are pushed onto it)
   * @param {number} k px per grid unit
   */
  constructor(ctx, s, k) {
    this.ctx = ctx;
    this.s = s;
    this.k = k;
    // The first point: a dot until the finger moves.
    path(ctx, s, [s[2], s[3]], 0, 0, k);
  }

  /** After a point was pushed onto the stroke. */
  add() {
    const { ctx, s, k } = this;
    const n = pointsOf(s);
    const x = (/** @type {number} */ i) => s[2 + 2 * i] * k;
    const y = (/** @type {number} */ i) => s[3 + 2 * i] * k;
    pen(ctx, s, k);
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
    const n = pointsOf(s);
    if (n < 2) return;
    const x = (/** @type {number} */ i) => s[2 + 2 * i] * k;
    const y = (/** @type {number} */ i) => s[3 + 2 * i] * k;
    pen(ctx, s, k);
    ctx.beginPath();
    ctx.moveTo((x(n - 2) + x(n - 1)) / 2, (y(n - 2) + y(n - 1)) / 2);
    ctx.lineTo(x(n - 1), y(n - 1));
    ctx.stroke();
  }
}
