// @ts-check
/**
 * Drawing Drawbluff's drawings: the phone's canvas, the web screen and
 * the video screen (Node, @napi-rs/canvas) all use this module, so a
 * drawing looks the same everywhere. A drawing is `{ strokes }`, each
 * stroke `[colour, width, x0, y0, x1, y1, …]` on a 1000×1000 grid,
 * `colour` an index into the drawing's `palette` (the artist's pens, see
 * `palette` in game/rules.ts), else into {@link PALETTE}.
 */

export const PALETTE = ["#1d1d1f", "#ffffff", "#e5383b", "#f9a620", "#ffd60a", "#2a9d8f", "#3a86ff", "#8338ec"];
export const GRID = 1000;
export const PAPER = "#fffdf6";

/**
 * One stroke into a 2D context (scaled: `size` px for the 1000 grid).
 * @param {any} ctx
 * @param {any} s
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @param {readonly string[]} [palette] the drawing's pens
 */
export function drawStroke(ctx, s, x, y, size, palette = PALETTE) {
  const k = size / GRID;
  const c = palette[s[0]];
  ctx.strokeStyle = typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : "#1d1d1f";
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = Math.max(1, s[1] * k);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.length === 4) {
    ctx.beginPath();
    ctx.arc(x + s[2] * k, y + s[3] * k, Math.max(0.5, (s[1] * k) / 2), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + s[2] * k, y + s[3] * k);
  for (let i = 4; i + 1 < s.length; i += 2) ctx.lineTo(x + s[i] * k, y + s[i + 1] * k);
  ctx.stroke();
}

/**
 * A whole drawing on paper, `size` px square at (x, y); `upTo` limits the
 * strokes (animating the drawing in).
 * @param {any} ctx
 * @param {{ strokes: any[], palette?: string[] } | null | undefined} drawing
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @param {{ paper?: string | null, upTo?: number }} [opts]
 */
export function drawDrawing(ctx, drawing, x, y, size, opts = {}) {
  ctx.save();
  if (opts.paper !== null) {
    ctx.fillStyle = opts.paper ?? PAPER;
    ctx.fillRect(x, y, size, size);
  }
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  const strokes = drawing?.strokes ?? [];
  const n = Math.min(strokes.length, opts.upTo ?? Infinity);
  const palette = Array.isArray(drawing?.palette) ? drawing.palette : PALETTE;
  for (let i = 0; i < n; i++) drawStroke(ctx, strokes[i], x, y, size, palette);
  ctx.restore();
}
