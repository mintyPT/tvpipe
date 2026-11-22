// @ts-check
/**
 * The world small, on a phone's canvas, in the TV's look (raised hex
 * tiles in their holders' colours on a dark sea): the whole world as a
 * locator to tap, or a close-up framed on a few territories (a
 * territory and its neighbours while planning, a fight during the
 * battle) with army badges and the orders as arrows.
 */

import { HEX_ROW, HEX_SIDES, HEX_W, hexCenter, hexCorners, hexNeighbors } from "../game/world.js";

/** @typedef {import("../game/world.js").World} World */
/** @typedef {{ own: string[], arm: number[] }} Board */
/** @typedef {{ from: number, to: number, n?: number, kind: "atk" | "move" | "hot" }} Arrow */
/**
 * @typedef {object} MapOptions
 * @property {number} [sel] the selected territory: outlined, the rest dimmed but `hi`
 * @property {Set<number>} [hi] territories not dimmed
 * @property {Map<number, string>} [labels] badges: a territory's text (its armies, "+3")
 * @property {Arrow[]} [arrows]
 * @property {number[]} [frame] territories to frame (a close-up); the canvas keeps its CSS height
 * @property {number} [pad] around the frame, in hexes (1.5)
 * @property {number} [maxScale] the closest a close-up gets, px per hex (20)
 * @property {string} [me] the player
 */
/** @typedef {{ s: number, ox: number, oy: number }} View px per hex radius, and the map's origin on the canvas */

export const WILD = "#d9c7a0";

/** A colour darker (k < 0) or lighter (k > 0). @param {string} hex @param {number} k */
export function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k));
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Per world: land hexes' centres at radius 1 with their territory, the
 * sea's, the sides between territories (and the coast), and each
 * territory's bounding box.
 * @typedef {{ land: [number, number, number][], sea: [number, number][], sides: [number, number, number, number, number, number][], boxes: [number, number, number, number][], W: number, H: number }} Geometry
 */
/** @type {WeakMap<World, Geometry>} */
const cache = new WeakMap();

/** @param {World} w @returns {Geometry} */
function geometry(w) {
  let g = cache.get(w);
  if (g) return g;
  /** @type {Geometry} */
  const geo = { land: [], sea: [], sides: [], boxes: w.territories.map(() => [Infinity, Infinity, -Infinity, -Infinity]), W: HEX_W * (w.cols + 0.5), H: HEX_ROW * (w.rows - 1) + 2 };
  for (let r = 0; r < w.rows; r++) {
    for (let c = 0; c < w.cols; c++) {
      const t = w.cells[r * w.cols + c] ?? -1;
      const [x, y] = hexCenter(c, r, 1);
      if (t < 0) {
        geo.sea.push([x, y]);
        continue;
      }
      geo.land.push([x, y, t]);
      const b = /** @type {[number, number, number, number]} */ (geo.boxes[t]);
      b[0] = Math.min(b[0], x - 1);
      b[1] = Math.min(b[1], y - 1);
      b[2] = Math.max(b[2], x + 1);
      b[3] = Math.max(b[3], y + 1);
      const corners = hexCorners(x, y, 1);
      hexNeighbors(c, r).forEach(([nc, nr], k) => {
        const o = nc < 0 || nr < 0 || nc >= w.cols || nr >= w.rows ? -1 : (w.cells[nr * w.cols + nc] ?? -1);
        if (o === t || (o >= 0 && o < t)) return;
        const [i, j] = /** @type {[number, number]} */ (HEX_SIDES[k]);
        const a = /** @type {[number, number]} */ (corners[i]);
        const z = /** @type {[number, number]} */ (corners[j]);
        geo.sides.push([a[0], a[1], z[0], z[1], t, o]);
      });
    }
  }
  cache.set(w, geo);
  return geo;
}

/** A territory's badge point (its anchor hex) at radius 1. @param {World} w @param {number} t */
function anchor(w, t) {
  const terr = w.territories[t];
  return terr ? hexCenter(terr.anchor[0], terr.anchor[1], 1) : [0, 0];
}

/**
 * Draws `board` on `canvas`. The whole world: the canvas's height
 * follows its width. A close-up (`o.frame`): the canvas keeps its CSS
 * height and the framed territories fill it. Returns the view for
 * {@link pickAt}.
 * @param {HTMLCanvasElement} canvas
 * @param {World} w
 * @param {Board} board
 * @param {(id: string) => string} colorOf a holder's colour
 * @param {MapOptions} [o]
 * @returns {View}
 */
export function drawMap(canvas, w, board, colorOf, o = {}) {
  const g = geometry(w);
  const cssW = canvas.clientWidth || 320;
  /** @type {View} */
  let v;
  let cssH;
  if (o.frame && o.frame.length) {
    cssH = canvas.clientHeight || 160;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const t of o.frame) {
      const b = g.boxes[t];
      if (!b || b[0] === Infinity) continue;
      // A territory across the map's edge (a wrapping sea route) would stretch the frame: keep to the first's side.
      if (x0 !== Infinity && (b[0] > x1 + g.W / 2 || b[2] < x0 - g.W / 2)) continue;
      (x0 = Math.min(x0, b[0])), (y0 = Math.min(y0, b[1])), (x1 = Math.max(x1, b[2])), (y1 = Math.max(y1, b[3]));
    }
    const pad = o.pad ?? 1.5;
    (x0 -= pad), (y0 -= pad), (x1 += pad), (y1 += pad);
    const s = Math.min(cssW / (x1 - x0), cssH / (y1 - y0), o.maxScale ?? 20);
    v = { s, ox: cssW / 2 - ((x0 + x1) / 2) * s, oy: cssH / 2 - ((y0 + y1) / 2) * s };
  } else {
    const s = cssW / g.W;
    cssH = s * g.H;
    canvas.style.height = `${cssH}px`;
    v = { s, ox: 0, oy: 0 };
  }
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const pw = Math.round(cssW * dpr);
  const ph = Math.round(cssH * dpr);
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const ctx = canvas.getContext("2d");
  if (!ctx) return v;
  const { s, ox, oy } = v;
  const X = (/** @type {number} */ x) => ox + x * s;
  const Y = (/** @type {number} */ y) => oy + y * s;
  const hex = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ r) => {
    hexCorners(X(x), Y(y), r * s).forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
  };
  const visible = (/** @type {number} */ x, /** @type {number} */ y) => X(x) > -2 * s && X(x) < cssW + 2 * s && Y(y) > -2 * s && Y(y) < cssH + 2 * s;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // The sea: a lit middle, darker edges; its faint grid when close enough to see.
  const sea = ctx.createRadialGradient(cssW * 0.45, cssH * 0.4, 0, cssW * 0.45, cssH * 0.4, Math.max(cssW, cssH) * 0.8);
  sea.addColorStop(0, "#16586a");
  sea.addColorStop(0.6, "#0d3a4a");
  sea.addColorStop(1, "#06202b");
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, cssW, cssH);
  if (s >= 5) {
    ctx.strokeStyle = "rgba(120, 200, 220, .07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [x, y] of g.sea) if (visible(x, y)) hex(x, y, 0.92);
    ctx.stroke();
  }

  // The land's shadow, then the tiles.
  const close = s >= 5;
  ctx.fillStyle = "rgba(0, 8, 12, .55)";
  ctx.beginPath();
  for (const [x, y] of g.land) if (visible(x, y)) hex(x + 0.16, y + 0.3, 1.06);
  ctx.fill();
  const dim = o.sel !== undefined && o.sel >= 0;
  const faded = (/** @type {number} */ t) => dim && t !== o.sel && !o.hi?.has(t);
  /** @type {Map<string, [number, number, number][]>} by colour (and faded: a "~" in front) */
  const groups = new Map();
  for (const h of g.land) {
    if (!visible(h[0], h[1])) continue;
    const own = board.own[h[2]] ?? "";
    const c = `${faded(h[2]) ? "~" : ""}${own ? colorOf(own) : WILD}`;
    let list = groups.get(c);
    if (!list) groups.set(c, (list = []));
    list.push(h);
  }
  const r = close ? 0.94 : 1.05;
  for (const [c, list] of groups) {
    // Faded: the sea shows through.
    ctx.globalAlpha = c.startsWith("~") ? 0.32 : 1;
    ctx.fillStyle = c.replace("~", "");
    ctx.beginPath();
    for (const [x, y] of list) hex(x, y, r);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  if (close) {
    // Raised tiles: light from the top, a darker foot.
    const lit = ctx.createLinearGradient(0, -s, 0, s);
    lit.addColorStop(0, "rgba(255, 255, 255, .30)");
    lit.addColorStop(0.5, "rgba(255, 255, 255, 0)");
    lit.addColorStop(1, "rgba(0, 0, 0, .22)");
    ctx.fillStyle = lit;
    for (const [c, list] of groups) {
      if (c.startsWith("~")) continue;
      for (const [x, y] of list) {
        ctx.save();
        ctx.translate(X(x), Y(y));
        ctx.beginPath();
        hexCorners(0, 0, r * s).forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // Borders: between territories and on the coast.
  ctx.lineCap = "round";
  const line = (/** @type {string} */ color, /** @type {number} */ width, /** @type {(a: number, b: number) => boolean} */ which) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const [x1, y1, x2, y2, a, b] of g.sides) {
      if (!which(a, b) || !visible(x1, y1)) continue;
      ctx.moveTo(X(x1), Y(y1));
      ctx.lineTo(X(x2), Y(y2));
    }
    ctx.stroke();
  };
  line("rgba(3, 16, 22, .9)", Math.max(1, s * 0.22), (_a, b) => b < 0);
  line("rgba(12, 18, 24, .6)", Math.max(0.8, s * (close ? 0.2 : 0.16)), (a, b) => b >= 0 && board.own[a] !== board.own[b]);
  if (close) line("rgba(12, 18, 24, .28)", Math.max(0.6, s * 0.08), (a, b) => b >= 0 && board.own[a] === board.own[b]);
  // Sea routes: dashed.
  if (close) {
    ctx.save();
    ctx.setLineDash([s * 0.5, s * 0.5]);
    ctx.strokeStyle = "rgba(230, 240, 240, .35)";
    ctx.lineWidth = Math.max(1, s * 0.12);
    ctx.beginPath();
    for (const l of w.links) {
      if (l.wrap) continue;
      const a = w.byId.get(l.a);
      const b = w.byId.get(l.b);
      if (!a || !b) continue;
      const [ax, ay] = anchor(w, a.index);
      const [bx, by] = anchor(w, b.index);
      ctx.moveTo(X(ax), Y(ay));
      ctx.lineTo(X(bx), Y(by));
    }
    ctx.stroke();
    ctx.restore();
  }
  // The selection: neighbours faintly, itself bright.
  const outline = (/** @type {number} */ t, /** @type {string} */ color, /** @type {number} */ width) => line(color, width, (a, b) => (a === t) !== (b === t));
  if (o.hi && dim) for (const t of o.hi) outline(t, "rgba(255, 255, 255, .5)", Math.max(1, s * 0.22));
  if (dim && o.sel !== undefined) {
    outline(o.sel, "rgba(0, 0, 0, .5)", Math.max(3, s * 0.7));
    outline(o.sel, "#fff", Math.max(2, s * 0.4));
  }

  // Arrows: the orders (attacks red, marches parchment), the fight on the TV.
  for (const a of o.arrows ?? []) {
    let [ax, ay] = anchor(w, a.from);
    let [bx, by] = anchor(w, a.to);
    if (Math.abs(bx - ax) > g.W / 2) bx += bx > ax ? -g.W : g.W;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    // From the edge of the start badge to just before the target's.
    const r0 = close ? 1.1 : 0;
    (ax += ux * r0), (ay += uy * r0), (bx -= ux * (close ? 1.4 : 0.6)), (by -= uy * (close ? 1.4 : 0.6));
    const bend = Math.min(2.5, len * 0.18);
    const mx = (ax + bx) / 2 - uy * bend;
    const my = (ay + by) / 2 + ux * bend;
    const color = a.kind === "move" ? "#f4ead2" : a.kind === "hot" ? "#ffd166" : "#ff5a36";
    const width = close ? Math.max(3, s * 0.42) : Math.max(1.8, s * 0.7);
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0, 0, 0, .55)";
    ctx.lineWidth = width + (close ? 3 : 2);
    ctx.beginPath();
    ctx.moveTo(X(ax), Y(ay));
    ctx.quadraticCurveTo(X(mx), Y(my), X(bx), Y(by));
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
    // The head, along the curve's end.
    const hx = bx - mx;
    const hy = by - my;
    const hl = Math.hypot(hx, hy) || 1;
    const size = close ? Math.max(9, s * 1.3) : Math.max(6, s * 2.6);
    const px = X(bx) + (hx / hl) * size * 0.5;
    const py = Y(by) + (hy / hl) * size * 0.5;
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0, 0, 0, .6)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px - (hx / hl) * size - (hy / hl) * size * 0.6, py - (hy / hl) * size + (hx / hl) * size * 0.6);
    ctx.lineTo(px - (hx / hl) * size + (hy / hl) * size * 0.6, py - (hy / hl) * size - (hx / hl) * size * 0.6);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    if (a.n && close) badge(ctx, X(mx), Y(my), String(a.n), color, Math.max(11, Math.min(15, s * 1.2)), a.kind === "move" ? "#1b1405" : "#fff", color);
  }

  // Badges: armies (or placements) on the territories that matter.
  if (o.labels) {
    const font = close ? Math.max(11, Math.min(16, s * 1.15)) : Math.max(9, Math.min(12, s * 2.1));
    for (const [t, text] of o.labels) {
      const [x, y] = anchor(w, t);
      const own = board.own[t] ?? "";
      const plus = text.startsWith("+");
      badge(ctx, X(x), Y(y), text, plus ? "#3ccf91" : own ? colorOf(own) : WILD, font, plus ? "#062014" : "#fff", plus ? "#3ccf91" : "rgba(10, 14, 20, .88)");
    }
  }
  return v;
}

/**
 * A round badge (a pill for longer text) with a coloured ring.
 * @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {string} text
 * @param {string} ring @param {number} font @param {string} ink @param {string} fill
 */
function badge(ctx, x, y, text, ring, font, ink, fill) {
  ctx.font = `${font}px "Lilita One", "Arial Black", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const h = font * 1.5;
  const tw = Math.max(h, ctx.measureText(text).width + font * 0.75);
  ctx.fillStyle = "rgba(0, 0, 0, .35)";
  ctx.beginPath();
  ctx.roundRect(x - tw / 2 + 1, y - h / 2 + 2, tw, h, h / 2);
  ctx.fill();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x - tw / 2, y - h / 2, tw, h, h / 2);
  ctx.fill();
  ctx.strokeStyle = ring;
  ctx.lineWidth = Math.max(1.5, font * 0.16);
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.fillText(text, x, y + font * 0.04);
}

/**
 * The territory under a point of the canvas (CSS px), or -1: the
 * nearest land hex within a hex and a half (fingers are wide, hexes
 * small); in a close-up, a tap near a badge counts for its territory.
 * @param {World} w
 * @param {View} v what {@link drawMap} returned
 * @param {number} x
 * @param {number} y
 */
export function pickAt(w, v, x, y) {
  const g = geometry(w);
  const mx = (x - v.ox) / v.s;
  const my = (y - v.oy) / v.s;
  let best = -1;
  // Within a fingertip (about 14 px) or a hex and a half, whichever is more.
  const reach = Math.max(1.5, 14 / v.s);
  let dist = reach * reach;
  for (const [cx, cy, t] of g.land) {
    const d = (cx - mx) ** 2 + (cy - my) ** 2;
    if (d < dist) (dist = d), (best = t);
  }
  if (v.s >= 5) {
    // Badges are what people aim at.
    let near = (16 / v.s) ** 2;
    let hit = -1;
    for (const terr of w.territories) {
      const [ax, ay] = anchor(w, terr.index);
      const d = (ax - mx) ** 2 + (ay - my) ** 2;
      if (d < near) (near = d), (hit = terr.index);
    }
    if (hit >= 0) return hit;
  }
  return best;
}
