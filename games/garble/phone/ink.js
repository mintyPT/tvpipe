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
 * the way it was drawn, stroke by stroke, along its length.
 */

export const GRID = 1000;
export const INK = "#17161c";
/** The old ink on the pad: the layers before yours, a shade lighter than your own. */
export const OLD_INK = "#8d8a97";
export const PAPER = "#fbf8f1";

/**
 * A stroke's path as a polyline (curves sampled), in grid units: the
 * same shape {@link strokePath} draws, for replays.
 * @type {WeakMap<number[], number[]>}
 */
const sampled = new WeakMap();

/** @param {number[]} s */
function polyline(s) {
  let out = sampled.get(s);
  if (out) return out;
  out = [];
  const n = (s.length - 1) / 2;
  const x = (/** @type {number} */ i) => s[1 + 2 * i];
  const y = (/** @type {number} */ i) => s[2 + 2 * i];
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
      const nx = (x(i) + x(i + 1)) / 2;
      const ny = (y(i) + y(i + 1)) / 2;
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

/** @param {number[]} p a polyline */
function lengthOf(p) {
  let len = 0;
  for (let i = 2; i + 1 < p.length; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return len;
}

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
  const progress = opts.progress ?? 1;
  if (progress >= 1) {
    for (const s of strokes) strokePath(ctx, s, x, y, k, color);
  } else if (progress > 0) {
    // Dots count as a short stroke, so they appear in turn.
    const lens = strokes.map((s) => (s.length <= 3 ? 12 : lengthOf(polyline(s))));
    const total = lens.reduce((a, b) => a + b, 0);
    let left = total * progress;
    for (let i = 0; i < strokes.length && left > 0; i++) {
      const s = strokes[i];
      if (left >= lens[i]) {
        strokePath(ctx, s, x, y, k, color);
        left -= lens[i];
        continue;
      }
      if (s.length <= 3) break;
      // The stroke drawn so far.
      const p = polyline(s);
      pen(ctx, s[0], k, color);
      ctx.beginPath();
      ctx.moveTo(x + p[0] * k, y + p[1] * k);
      for (let j = 2; j + 1 < p.length && left > 0; j += 2) {
        const d = Math.hypot(p[j] - p[j - 2], p[j + 1] - p[j - 1]);
        const f = d > left ? left / d : 1;
        ctx.lineTo(x + (p[j - 2] + (p[j] - p[j - 2]) * f) * k, y + (p[j - 1] + (p[j + 1] - p[j - 1]) * f) * k);
        left -= d;
      }
      ctx.stroke();
      break;
    }
  }
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
  const strokes = drawing?.strokes ?? [];
  let len = 0;
  for (const s of strokes) len += s.length <= 3 ? 12 : lengthOf(polyline(s));
  return Math.max(min, Math.min(max, len * 0.45 + strokes.length * 40));
}

/**
 * Replays a drawing into a canvas (`size` px, its backing store already
 * scaled), over `ms`; resolves when done or cancelled (`signal`). With
 * `paper: null` the canvas is a transparent sheet over another (cleared
 * each frame).
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} drawing
 * @param {number} size
 * @param {number} ms
 * @param {{ aborted: boolean }} [signal]
 * @param {(progress: number) => void} [each] after each frame
 * @param {{ paper?: string | null, color?: string }} [opts]
 */
export function replay(ctx, drawing, size, ms, signal, each, opts = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = () => {
      if (signal?.aborted) return resolve(undefined);
      const p = Math.min(1, (performance.now() - t0) / ms);
      // Ease out: quick strokes first, the last ones settle.
      const e = 1 - Math.pow(1 - p, 1.6);
      if (opts.paper === null) ctx.clearRect(0, 0, size, size);
      drawInk(ctx, drawing, 0, 0, size, { ...opts, progress: e });
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
