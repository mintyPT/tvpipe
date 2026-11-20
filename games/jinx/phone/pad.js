// @ts-check
/**
 * The face pad: one ink, one width, drawn inside the chip's circle on the
 * 1000 grid (as Drawbluff's pad, smaller limits: 40 strokes, 2000 points).
 */

import { DOODLE_WIDTH, GRID, INK, MAX_POINTS, MAX_STROKES } from "./faces.js";

/** Points closer than this (grid units) to the last are skipped. */
const STEP = 14;

export class Pad {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onStroke?: () => void, onFull?: () => void }} [hooks]
   */
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    this.hooks = hooks;
    /** @type {number[][]} */
    this.strokes = [];
    this.points = 0;
    /** @type {number[] | null} */
    this.current = null;
    this.size = 0;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", () => this.up());
    canvas.addEventListener("pointercancel", () => this.up());
    // iOS Safari: no selection, magnifier, scroll or zoom from a touch on the pad.
    for (const type of ["touchstart", "touchmove", "touchend"]) {
      canvas.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
  }

  get full() {
    return this.strokes.length >= MAX_STROKES || this.points >= MAX_POINTS;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.size = r.width;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.width * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  /** @param {number[][]} strokes */
  load(strokes) {
    this.strokes = strokes.slice(0, MAX_STROKES).map((s) => s.map((n) => Math.round(Math.min(GRID, Math.max(0, Number(n) || 0)))));
    this.points = this.strokes.reduce((n, s) => n + (s.length >> 1), 0);
    this.redraw();
  }

  redraw() {
    this.ctx.clearRect(0, 0, this.size, this.size);
    for (const s of this.strokes) this.stroke(s, 0);
  }

  /**
   * Draws `s` from point `from` on.
   * @param {number[]} s
   * @param {number} from
   */
  stroke(s, from) {
    const k = this.size / GRID;
    const c = this.ctx;
    c.strokeStyle = INK;
    c.fillStyle = INK;
    c.lineWidth = DOODLE_WIDTH * k;
    c.lineCap = "round";
    c.lineJoin = "round";
    if (s.length < 4) {
      c.beginPath();
      c.arc((s[0] ?? 0) * k, (s[1] ?? 0) * k, (DOODLE_WIDTH * k) / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    const i0 = Math.max(0, from - 1) * 2;
    c.beginPath();
    c.moveTo((s[i0] ?? 0) * k, (s[i0 + 1] ?? 0) * k);
    for (let i = i0 + 2; i + 1 < s.length; i += 2) c.lineTo((s[i] ?? 0) * k, (s[i + 1] ?? 0) * k);
    c.stroke();
  }

  /** @param {PointerEvent} e */
  at(e) {
    const r = this.canvas.getBoundingClientRect();
    const k = GRID / r.width;
    return [Math.round(Math.min(GRID, Math.max(0, (e.clientX - r.left) * k))), Math.round(Math.min(GRID, Math.max(0, (e.clientY - r.top) * k)))];
  }

  /** @param {PointerEvent} e */
  down(e) {
    e.preventDefault();
    if (this.full) {
      this.hooks.onFull?.();
      return;
    }
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {}
    const [x = 0, y = 0] = this.at(e);
    this.current = [x, y];
    this.strokes.push(this.current);
    this.points++;
    this.stroke(this.current, 0);
  }

  /** @param {PointerEvent} e */
  move(e) {
    const s = this.current;
    if (!s) return;
    e.preventDefault();
    const all = e.getCoalescedEvents?.() ?? [];
    for (const ev of all.length ? all : [e]) {
      if (this.points >= MAX_POINTS) return this.up();
      const [x = 0, y = 0] = this.at(ev);
      const lx = s[s.length - 2] ?? 0;
      const ly = s[s.length - 1] ?? 0;
      if (Math.hypot(x - lx, y - ly) < STEP) continue;
      s.push(x, y);
      this.points++;
      this.stroke(s, (s.length >> 1) - 1);
    }
  }

  up() {
    if (!this.current) return;
    this.current = null;
    this.hooks.onStroke?.();
  }

  undo() {
    const s = this.strokes.pop();
    if (s) this.points -= s.length >> 1;
    this.redraw();
  }

  clear() {
    this.strokes = [];
    this.points = 0;
    this.redraw();
  }
}
