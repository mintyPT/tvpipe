// @ts-check
/**
 * The TV's world: the hex map as SVG (docs/landgrab-design.md §6). Every
 * hex is a raised tile, a little block with a bevelled top and a side in
 * the holder's colour (the wild lands' parchment tiles stand lower); the
 * sea has the old maps' water lines around every coast; territories
 * have grooves between them, continents deeper ones; the continents'
 * names and bonuses stand in the sea next to them, like the legend of a
 * painted map; dashed sea routes; a token with the armies on every
 * territory; and a camera that flies to where a battle is.
 *
 * The effects (arrows, marching armies, the colour flooding a conquered
 * territory, numbers floating up, sparks) live on layers above the land,
 * in map units (a hex's radius is 1). Everything static is drawn once;
 * what moves is a few small elements at a time (the page is captured at
 * 30 fps).
 */

import { placeNames } from "../game/names.js";
import { HEX_SIDES, HEX_W, hexCenter, hexCorners, hexNeighbors, mapSize } from "../game/world.js";

/** @typedef {import("../game/world.js").World} World */
/** @typedef {[number, number]} P */

const NS = "http://www.w3.org/2000/svg";
/** The wild lands' parchment. */
export const WILD = "#d8c59c";
/** A tile's radius (the rest of the hex is the groove around it). */
const TILE = 0.9;
/** How far a tile stands up: a held territory, a wild one. */
const RAISED = 0.46;
const LOW = 0.24;

/**
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 * @returns {SVGElement}
 */
export function s(tag, attrs = {}) {
  const el = /** @type {SVGElement} */ (document.createElementNS(NS, tag));
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A colour darker or lighter by `k` (-1 … 1). @param {string} hex @param {number} k */
export function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k));
  return `#${ch.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`;
}

/** An SVG path of hexes of radius `r` around the given centres. @param {P[]} centers @param {number} r */
function hexPath(centers, r) {
  return centers.map(([x, y]) => `M${hexCorners(x, y, r).map(([a, b]) => `${a.toFixed(2)} ${b.toFixed(2)}`).join("L")}Z`).join("");
}

export const ease = (/** @type {number} */ x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (/** @type {number} */ x) => 1 - (1 - x) ** 3;

/** Runs `fn(k)` with k from 0 to 1 over `ms` on animation frames; `done` after. @param {number} ms @param {(k: number) => void} fn @param {() => void} [done] */
export function tween(ms, fn, done) {
  const t0 = performance.now();
  let stopped = false;
  const step = () => {
    if (stopped) return;
    const k = ms <= 0 ? 1 : Math.min(1, (performance.now() - t0) / ms);
    fn(k);
    if (k < 1) requestAnimationFrame(step);
    else done?.();
  };
  step();
  return () => {
    stopped = true;
  };
}

/** The territories' names: the font (at 100 units, to measure) and its tracking (em). */
const NAME_FONT = `600 100px "Barlow Condensed", "Arial Narrow", sans-serif`;
const NAME_TRACK = 0.05;

/** A small number in a territory's tile colour, by its index: neighbours of one holder differ a little. @param {number} i */
const jitter = (i) => [0, 0.07, -0.06, 0.035, -0.03][(i * 3) % 5] ?? 0;

/** Where a token, label or arrow can go: the map, its hexes in rows. */
export class WorldMap {
  /** @param {World} world */
  constructor(world) {
    this.world = world;
    const [W, H] = mapSize(world);
    this.W = W;
    this.H = H;
    // Two layers: the board (drawn again only when the camera moves or a territory changes hands) and
    // what moves over it (tokens, arrows, effects), each its own composited layer.
    const svg = () => /** @type {SVGSVGElement} */ (/** @type {unknown} */ (s("svg", { viewBox: `0 0 ${W.toFixed(2)} ${H.toFixed(2)}`, preserveAspectRatio: "xMidYMid slice" })));
    this.el = document.createElement("div");
    this.el.className = "world";
    this.svg = svg();
    this.svg.classList.add("board");
    this.top = svg();
    this.top.classList.add("top");
    this.el.append(this.svg, this.top);
    const defs = s("defs");
    // One hex's bevel, as a pattern the size of two rows: lit from the top left.
    const pw = HEX_W;
    const bevel = (/** @type {number} */ x, /** @type {number} */ y) => {
      const c = hexCorners(x, y, TILE);
      const pts = (/** @type {number[]} */ ks) => ks.map((k) => (c[k] ?? [0, 0]).map((v) => v.toFixed(3)).join(" ")).join(" ");
      return `<polygon points="${pts([0, 1, 2, 3, 4, 5])}" fill="url(#face)"/><polyline points="${pts([3, 4, 5, 0])}" class="lit"/><polyline points="${pts([0, 1, 2, 3])}" class="dim"/>`;
    };
    defs.innerHTML = `
      <linearGradient id="face" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".26"/><stop offset=".45" stop-color="#fff" stop-opacity=".04"/><stop offset="1" stop-color="#000" stop-opacity=".16"/></linearGradient>
      <pattern id="bevel" patternUnits="userSpaceOnUse" x="0" y="0" width="${pw.toFixed(4)}" height="3">${bevel(pw / 2, 1)}${bevel(0, 2.5)}${bevel(pw, 2.5)}${bevel(pw / 2, 4)}${bevel(0, -0.5)}${bevel(pw, -0.5)}</pattern>
      <radialGradient id="flare"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".4" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`;
    this.svg.append(defs);
    this.defs = defs;
    this.cam = /** @type {SVGGElement} */ (s("g", { class: "cam" }));
    this.svg.append(this.cam);
    this.cam2 = /** @type {SVGGElement} */ (s("g", { class: "cam" }));
    this.top.append(this.cam2);

    const cols = world.cols;
    const at = (/** @type {number} */ c, /** @type {number} */ r) => (c < 0 || r < 0 || c >= cols || r >= world.rows ? -1 : (world.cells[r * cols + c] ?? -1));
    /** @type {P[]} */
    const sea = [];
    /** @type {P[][]} */
    const lands = world.territories.map(() => []);
    // The sea goes on past the map's edges (the camera may look past them).
    for (let r = -6; r < world.rows + 6; r++) {
      for (let c = -10; c < cols + 10; c++) {
        const t = at(c, r);
        const center = hexCenter(c, r, 1);
        if (t < 0) sea.push(center);
        else lands[t]?.push(center);
      }
    }
    this.centers = lands;

    // The sea: a faint grid, and water lines around the coasts (hexes 1, 2 and 3 away from land).
    const dist = this.#seaDistance();
    this.dist = dist;
    const sea2 = s("g", { class: "sea" });
    sea2.append(s("path", { class: "seagrid", d: hexPath(sea, 0.97) }));
    for (const k of [1, 2, 3]) {
      let d = "";
      for (let r = 0; r < world.rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = dist[r * cols + c] ?? 99;
          if (v > k) continue;
          const corners = hexCorners(...hexCenter(c, r, 1), 1);
          hexNeighbors(c, r).forEach(([nc, nr], j) => {
            if (nc < 0 || nr < 0 || nc >= cols || nr >= world.rows) return;
            if ((dist[nr * cols + nc] ?? 99) <= k) return;
            const [i0, i1] = /** @type {[number, number]} */ (HEX_SIDES[j]);
            const a = /** @type {P} */ (corners[i0]);
            const b = /** @type {P} */ (corners[i1]);
            d += `M${a[0].toFixed(2)} ${a[1].toFixed(2)}L${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
          });
        }
      }
      sea2.append(s("path", { class: `water w${k}`, d }));
    }
    this.cam.append(sea2);
    this.seaLayer = sea2;
    this.cam.append(s("path", { class: "shadow", d: hexPath(lands.flat(), 1.02), transform: "translate(.35 .75)" }));

    // Sea routes under the land.
    this.links = s("g", { class: "links" });
    this.cam.append(this.links);
    for (const l of world.links) this.links.append(this.#link(l.a, l.b, l.wrap));

    // Territories: the tiles' sides, their tops, the bevel over them.
    /** @type {{ g: SVGGElement, side: SVGElement, top: SVGElement }[]} */
    this.terr = [];
    const land = s("g", { class: "land" });
    this.cam.append(land);
    world.territories.forEach((terr, i) => {
      const centers = /** @type {P[]} */ (lands[i]);
      const g = /** @type {SVGGElement} */ (s("g", { class: "terr", "data-id": terr.id }));
      const d = hexPath(centers, TILE);
      const side = s("path", { class: "side", d, transform: `translate(0 ${LOW})` });
      const top = s("path", { class: "top", d });
      g.append(side, top, s("path", { class: "bevel", d, fill: "url(#bevel)" }));
      land.append(g);
      this.terr.push({ g, side, top });
      const clip = s("clipPath", { id: `clip-${terr.id}` });
      clip.append(s("path", { d: hexPath(centers, TILE) }));
      defs.append(clip);
    });

    // Grooves between territories, deeper between continents.
    let inner = "";
    let cont = "";
    for (let r = 0; r < world.rows; r++) {
      for (let c = 0; c < cols; c++) {
        const t = at(c, r);
        if (t < 0) continue;
        const corners = hexCorners(...hexCenter(c, r, 1), 1);
        hexNeighbors(c, r).forEach(([nc, nr], k) => {
          const o = at(nc, nr);
          if (o < 0 || o === t || o < t) return;
          const [i, j] = /** @type {[number, number]} */ (HEX_SIDES[k]);
          const a = /** @type {P} */ (corners[i]);
          const b = /** @type {P} */ (corners[j]);
          const seg = `M${a[0].toFixed(2)} ${a[1].toFixed(2)}L${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
          if (world.territories[o]?.continent !== world.territories[t]?.continent) cont += seg;
          else inner += seg;
        });
      }
    }
    this.cam.append(s("path", { class: "groove inner", d: inner }), s("path", { class: "groove cont", d: cont }));

    // Above the land: what dims the rest in a battle, the labels, the effects, the tokens, what flies over them.
    this.dim = s("path", { class: "dim", d: "" });
    this.labelLayer = s("g", { class: "labels" });
    this.nameLayer = s("g", { class: "tnames" });
    this.fx = s("g", { class: "fx" });
    this.cam.append(this.labelLayer, this.nameLayer);
    this.cam2.append(this.dim, this.fx);
    /** @type {{ g: SVGGElement, ring: SVGElement, text: SVGTextElement }[]} */
    this.badges = [];
    const badges = s("g", { class: "badges" });
    this.cam2.append(badges);
    for (let i = 0; i < world.territories.length; i++) {
      const [x, y] = this.point(i);
      const g = /** @type {SVGGElement} */ (s("g", { class: "badge", transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})` }));
      const inner = s("g", { class: "in" });
      const ring = s("circle", { class: "ring", r: 1.42 });
      const text = /** @type {SVGTextElement} */ (s("text", { class: "count", y: 0.66, "text-anchor": "middle" }));
      inner.append(s("circle", { class: "puck", r: 1.42, cy: 0.3 }), ring, s("path", { class: "gloss", d: "M-1.02 -.35A1.08 1.08 0 0 1 1.02 -.35" }), text);
      g.append(inner);
      badges.append(g);
      this.badges.push({ g, ring, text });
    }
    this.over = s("g", { class: "over" });
    this.cam2.append(this.over);
    /** What each territory shows: holder and armies. */
    this.own = world.territories.map(() => "\u0000");
    this.arm = world.territories.map(() => -1);
    this.view = { x: W / 2, y: H / 2, z: 1 };
    this.#applyCam();
  }

  /** Each sea cell's distance in hexes to the nearest land (0 on land). */
  #seaDistance() {
    const w = this.world;
    const dist = new Int16Array(w.cols * w.rows).fill(99);
    /** @type {number[]} */
    let todo = [];
    for (let i = 0; i < dist.length; i++) if ((w.cells[i] ?? -1) >= 0) (dist[i] = 0), todo.push(i);
    for (let k = 1; k <= 8 && todo.length; k++) {
      /** @type {number[]} */
      const next = [];
      for (const i of todo) {
        for (const [nc, nr] of hexNeighbors(i % w.cols, Math.floor(i / w.cols))) {
          if (nc < 0 || nr < 0 || nc >= w.cols || nr >= w.rows) continue;
          const j = nr * w.cols + nc;
          if ((dist[j] ?? 0) > k) (dist[j] = k), next.push(j);
        }
      }
      todo = next;
    }
    return dist;
  }

  /** The dashed sea route between two territories: between their closest hexes, or off both edges (wrap). @param {string} a @param {string} b @param {boolean} wrap */
  #link(a, b, wrap) {
    const w = this.world;
    const pts = (/** @type {string} */ id) => (w.byId.get(id)?.hexes ?? []).map((cell) => hexCenter(cell % w.cols, Math.floor(cell / w.cols), 1));
    const A = pts(a);
    const B = pts(b);
    if (wrap) {
      const left = (/** @type {P[]} */ xs) => xs.reduce((m, p) => (p[0] < m[0] ? p : m));
      const right = (/** @type {P[]} */ xs) => xs.reduce((m, p) => (p[0] > m[0] ? p : m));
      const [la, ra] = [left(A), right(A)];
      const [lb, rb] = [left(B), right(B)];
      const aLeft = la[0] < this.W - ra[0];
      const pa = aLeft ? la : ra;
      const pb = aLeft ? rb : lb;
      const g = s("g", { class: "link wrap" });
      g.append(s("path", { d: `M${pa[0]} ${pa[1]}Q${aLeft ? pa[0] - 2 : pa[0] + 2} ${pa[1] - 2} ${aLeft ? -2 : this.W + 2} ${pa[1] - 1.5}` }), s("path", { d: `M${pb[0]} ${pb[1]}Q${aLeft ? pb[0] + 2 : pb[0] - 2} ${pb[1] - 2} ${aLeft ? this.W + 2 : -2} ${pb[1] - 1.5}` }));
      return g;
    }
    let best = /** @type {[P, P, number] | null} */ (null);
    for (const p of A) for (const q of B) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      if (!best || d < best[2]) best = [p, q, d];
    }
    if (!best) return s("g");
    const [p, q] = best;
    const len = Math.sqrt(best[2]);
    const mx = (p[0] + q[0]) / 2 + ((q[1] - p[1]) / len) * len * 0.12;
    const my = (p[1] + q[1]) / 2 - ((q[0] - p[0]) / len) * len * 0.12;
    return s("path", { class: "link", d: `M${p[0]} ${p[1]}Q${mx.toFixed(2)} ${my.toFixed(2)} ${q[0]} ${q[1]}` });
  }

  /**
   * The continents' names and bonuses in the sea, each next to its
   * continent (as near its middle as there is open sea for it), clear of
   * the screen's `keep` rectangles (fractions of the screen, the whole
   * world in view) and of each other. Measures with the page's fonts:
   * call it when they are loaded.
   * @param {Record<string, string>} names by continent id
   * @param {[number, number, number, number][]} keep
   * @param {number} aspect the screen's width / height
   */
  labels(names, keep, aspect) {
    const w = this.world;
    this.labelLayer.replaceChildren();
    /** @type {Map<string, { g: SVGGElement }>} */
    this.contLabels = new Map();
    const ctx = document.createElement("canvas").getContext("2d");
    const FS = 1.55;
    // The visible part of the map (the slice cuts the longer side).
    const vw = Math.min(this.W, this.H * aspect);
    const vh = Math.min(this.H, this.W / aspect);
    const x0 = (this.W - vw) / 2;
    const y0 = (this.H - vh) / 2;
    /** @type {[number, number, number, number][]} boxes taken (map units: x, y, w, h) */
    const taken = keep.map(([fx, fy, fw, fh]) => [x0 + fx * vw, y0 + fy * vh, fw * vw, fh * vh]);
    this.contBoxes = [];
    const overlaps = (/** @type {number[]} */ a, /** @type {number[]} */ b) => (a[0] ?? 0) < (b[0] ?? 0) + (b[2] ?? 0) && (b[0] ?? 0) < (a[0] ?? 0) + (a[2] ?? 0) && (a[1] ?? 0) < (b[1] ?? 0) + (b[3] ?? 0) && (b[1] ?? 0) < (a[1] ?? 0) + (a[3] ?? 0);
    const land = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ bw, /** @type {number} */ bh) => {
      // Any hex nearer than half a hex to the box: land.
      const r0 = Math.max(0, Math.floor((y - 1.5) / 1.5));
      const r1 = Math.min(w.rows - 1, Math.ceil((y + bh + 0.5) / 1.5));
      for (let r = r0; r <= r1; r++) {
        for (let c = Math.max(0, Math.floor(x / HEX_W) - 1); c <= Math.min(w.cols - 1, Math.ceil((x + bw) / HEX_W) + 1); c++) {
          if ((this.dist[r * w.cols + c] ?? 99) > 1) continue;
          const [cx, cy] = hexCenter(c, r, 1);
          if (cx > x - 0.9 && cx < x + bw + 0.9 && cy > y - 0.9 && cy < y + bh + 0.9) return true;
        }
      }
      return false;
    };
    for (const c of w.continents) {
      const name = (names[c.id] ?? c.id).toUpperCase();
      if (ctx) ctx.font = `100px "IM Fell English SC", serif`;
      const tw = ctx ? (ctx.measureText(name).width / 100) * FS * 1.08 : name.length * FS * 0.75;
      const bw = tw + FS * 2.6;
      const bh = FS * 1.9;
      const hexes = c.territories.flatMap((id) => {
        const t = w.byId.get(id);
        return t ? (this.centers[t.index] ?? []) : [];
      });
      const mx = hexes.reduce((a, p) => a + p[0], 0) / Math.max(1, hexes.length);
      const my = hexes.reduce((a, p) => a + p[1], 0) / Math.max(1, hexes.length);
      let best = /** @type {[number, number, number] | null} */ (null);
      for (let y = y0 + 0.5; y + bh < y0 + vh - 0.5; y += 0.75) {
        for (let x = x0 + 0.5; x + bw < x0 + vw - 0.5; x += 0.75) {
          const cx = x + bw / 2;
          const cy = y + bh / 2;
          // Nearest to the continent's middle, but its own coast nearer than any other's.
          const score = Math.hypot(cx - mx, (cy - my) * 1.15);
          if (best && score >= best[2]) continue;
          if (taken.some((b) => overlaps([x - 0.6, y - 0.4, bw + 1.2, bh + 0.8], b))) continue;
          if (land(x, y, bw, bh)) continue;
          best = [x, y, score];
        }
      }
      if (!best) continue;
      const [bx, by] = best;
      taken.push([bx, by, bw, bh]);
      this.contBoxes.push([bx, by, bw, bh]);
      const g = /** @type {SVGGElement} */ (s("g", { class: "contlabel", transform: `translate(${bx.toFixed(2)} ${by.toFixed(2)})` }));
      const r = bh / 2;
      const text = s("text", { class: "name", x: (2.2 * FS).toFixed(2), y: (r + FS * 0.36).toFixed(2), "font-size": FS, textLength: tw.toFixed(2), lengthAdjust: "spacingAndGlyphs" });
      text.textContent = name;
      const roundel = s("g", { class: "roundel", transform: `translate(${r.toFixed(2)} ${r.toFixed(2)})` });
      const bonus = s("text", { class: "bonus", y: (FS * 0.36).toFixed(2), "text-anchor": "middle", "font-size": (FS * 0.95).toFixed(2) });
      bonus.textContent = `+${c.bonus}`;
      roundel.append(s("circle", { r: (r * 0.98).toFixed(2) }), bonus);
      g.append(s("path", { class: "rule", d: `M${(2.2 * FS).toFixed(2)} ${(bh - 0.12).toFixed(2)}h${tw.toFixed(2)}` }), roundel, text);
      this.labelLayer.append(g);
      this.contLabels.set(c.id, { g });
    }
  }

  /** @type {[number, number, number, number][]} where the continents' labels stand */
  contBoxes = [];

  /**
   * The territories' names on the land, each by its badge (game/names.ts),
   * clear of the continents' labels (call {@link labels} first) and, as
   * far as they can, of the screen's `keep` rectangles. In the old map's
   * lettering, capitals, with a dark rim to read on any colour.
   * @param {string[]} names by territory index
   * @param {[number, number, number, number][]} keep
   * @param {number} aspect the screen's width / height
   */
  names(names, keep, aspect) {
    this.nameLayer.replaceChildren();
    const vw = Math.min(this.W, this.H * aspect);
    const vh = Math.min(this.H, this.W / aspect);
    const x0 = (this.W - vw) / 2;
    const y0 = (this.H - vh) / 2;
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) ctx.font = NAME_FONT;
    const measure = (/** @type {string} */ text, /** @type {number} */ size) => ((ctx ? ctx.measureText(text).width / 100 : text.length * 0.6) + NAME_TRACK * text.length) * size;
    const labels = placeNames(this.world, new Map(names.map((n, i) => [i, n.toUpperCase()])), {
      size: 1.4,
      small: 1.15,
      measure,
      badge: 1.55,
      avoid: this.contBoxes,
      shun: keep.map(([fx, fy, fw, fh]) => [x0 + fx * vw, y0 + fy * vh, fw * vw, fh * vh]),
      bounds: [x0 + 0.3, y0 + 0.3, vw - 0.6, vh - 0.6],
      lead: 0.95,
    });
    for (const l of labels) {
      const text = s("text", { class: "tname", "font-size": l.size.toFixed(2), "text-anchor": "middle", "data-id": this.world.territories[l.t]?.id ?? "" });
      const top = l.y - l.h / 2;
      l.lines.forEach((line, k) => {
        const span = s("tspan", { x: l.x.toFixed(2), y: (top + l.size * 0.95 * k + l.size * 0.82).toFixed(2) });
        span.textContent = line;
        text.append(span);
      });
      this.nameLayer.append(text);
    }
  }

  /** A continent's label in its holder's colour (`""`: nobody holds it whole). @param {string} id @param {string} color */
  holder(id, color) {
    const l = this.contLabels?.get(id);
    if (!l) return;
    const was = l.g.style.getPropertyValue("--c");
    if (was === color) return;
    l.g.classList.toggle("held", !!color);
    if (color) l.g.style.setProperty("--c", color);
    else l.g.style.removeProperty("--c");
  }

  /** Whether two territories' route crosses the map's edge. @param {number} a @param {number} b */
  wraps(a, b) {
    return Math.abs(this.point(a)[0] - this.point(b)[0]) > this.W / 2;
  }

  /** A territory's badge point (map units). @param {number} i @returns {P} */
  point(i) {
    const terr = this.world.territories[i];
    return terr ? hexCenter(terr.anchor[0], terr.anchor[1], 1) : [0, 0];
  }

  /**
   * Shows a territory's holder and armies.
   * @param {number} i
   * @param {string} own the holder's id (`""` wild)
   * @param {number} arm
   * @param {(id: string) => string} colorOf
   */
  set(i, own, arm, colorOf) {
    const b = this.badges[i];
    const t = this.terr[i];
    if (!b || !t) return;
    if (this.own[i] !== own) {
      this.own[i] = own;
      const c = own ? colorOf(own) : WILD;
      const face = shade(c, jitter(i));
      t.top.setAttribute("fill", face);
      t.side.setAttribute("fill", shade(c, own ? -0.52 : -0.45));
      t.side.setAttribute("transform", `translate(0 ${own ? RAISED : LOW})`);
      t.g.classList.toggle("wild", !own);
      b.ring.setAttribute("stroke", c);
      b.g.classList.toggle("wild", !own);
      b.g.style.setProperty("--c", c);
    }
    if (this.arm[i] !== arm) {
      this.arm[i] = arm;
      const n = String(Math.max(0, arm));
      b.text.textContent = n;
      b.text.setAttribute("font-size", n.length >= 3 ? "1.5" : n.length === 2 ? "1.85" : "2.1");
      b.text.setAttribute("y", n.length >= 3 ? "0.52" : n.length === 2 ? "0.62" : "0.7");
    }
  }

  /**
   * The world as a painted map, before anyone holds anything (the
   * lobby): each continent in a colour of its own, no tokens.
   */
  paint() {
    const PAINT = ["#d9a648", "#cf6f4f", "#7896cf", "#a987c9", "#7fae63", "#d4839f", "#58b4b0", "#c9b458"];
    this.el.classList.add("bare");
    this.world.territories.forEach((terr, i) => {
      const t = this.terr[i];
      if (!t) return;
      const c = PAINT[this.world.continents.findIndex((x) => x.id === terr.continent) % PAINT.length] ?? WILD;
      this.own[i] = "\u0001";
      t.top.setAttribute("fill", shade(c, jitter(i) * 1.6));
      t.side.setAttribute("fill", shade(c, -0.5));
      t.side.setAttribute("transform", `translate(0 ${RAISED})`);
    });
  }

  /** Shows a whole board. @param {{ own: string[], arm: number[] }} board @param {(id: string) => string} colorOf */
  board(board, colorOf) {
    this.el.classList.remove("bare");
    board.own.forEach((o, i) => this.set(i, o, board.arm[i] ?? 0, colorOf));
  }

  /** Plays a short animation on a badge (a CSS class: bump, hit, conquer, rise). @param {number} i @param {string} [cls] */
  bump(i, cls = "bump") {
    const g = this.badges[i]?.g;
    if (!g) return;
    g.classList.remove("bump", "hit", "conquer", "rise");
    void g.getBoundingClientRect();
    g.classList.add(cls);
  }

  /** A territory's tiles thump (taken, risen). @param {number} i */
  thump(i) {
    const g = this.terr[i]?.g;
    if (!g) return;
    g.classList.remove("thump");
    void g.getBoundingClientRect();
    g.classList.add("thump");
    setTimeout(() => g.classList.remove("thump"), 900);
  }

  /**
   * Flies the camera to `(x, y)` at zoom `z` in `ms`; `free`: it may look
   * a little past the map's edges (a fight there, clear of the HUD).
   * @param {number} x @param {number} y @param {number} z @param {number} ms @param {boolean} [free]
   */
  fly(x, y, z, ms, free = false) {
    const from = { ...this.view };
    const to = free ? this.#loose(x, y, z) : this.#clamp(x, y, z);
    this.#flight?.();
    this.#flight = tween(ms, (k) => {
      const e = ease(k);
      // A little up and out on the way: the camera breathes.
      const lift = Math.sin(Math.PI * k) * 0.08 * Math.abs(to.z - from.z || 0.5);
      this.view = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: from.z + (to.z - from.z) * e - lift };
      this.#applyCam();
    });
  }
  /** @type {(() => void) | undefined} */
  #flight;

  /** @param {number} x @param {number} y @param {number} z */
  #clamp(x, y, z) {
    const hw = this.W / 2 / z;
    const hh = this.H / 2 / z;
    return { x: Math.max(hw, Math.min(this.W - hw, x)), y: Math.max(hh, Math.min(this.H - hh, y)), z };
  }

  /** Like {@link #clamp}, but up to a fifth of the view past the edges. @param {number} x @param {number} y @param {number} z */
  #loose(x, y, z) {
    const hw = this.W / 2 / z;
    const hh = this.H / 2 / z;
    const mx = hw * 0.4;
    const my = hh * 0.3;
    return { x: Math.max(hw - mx, Math.min(this.W - hw + mx, x)), y: Math.max(hh - my, Math.min(this.H - hh + my, y)), z };
  }

  /** Back to the whole world. @param {number} ms */
  home(ms) {
    this.fly(this.W / 2, this.H / 2, 1, ms);
  }

  /** Sets the camera at once (a slow drift). @param {number} x @param {number} y @param {number} z */
  look(x, y, z) {
    this.#flight?.();
    this.view = this.#clamp(x, y, z);
    this.#applyCam();
  }

  #applyCam() {
    const { x, y, z } = this.view;
    const tr = `translate(${(this.W / 2 - x * z).toFixed(3)} ${(this.H / 2 - y * z).toFixed(3)}) scale(${z.toFixed(4)})`;
    this.cam.setAttribute("transform", tr);
    this.cam2.setAttribute("transform", tr);
  }

  /** How many screen pixels a map unit is at zoom 1. */
  unit() {
    const r = this.el.getBoundingClientRect();
    return Math.max(r.width / this.W, r.height / this.H);
  }

  /**
   * An arrow from one territory to another in a colour, growing over
   * `ms`; `meet` stops it halfway (a clash). A war map's arrow: wide, a
   * dark rim, a big head, chevrons marching along it.
   * Across the map's edge (a sea route that wraps) the arrow stays on
   * the target's side (`anchor: "from"`: the source's), coming in from
   * the edge.
   * @param {number} a @param {number} b @param {string} color @param {number} ms @param {{ meet?: boolean, bend?: number, friendly?: boolean, anchor?: "to" | "from" }} [o]
   */
  arrow(a, b, color, ms, o = {}) {
    let [x1, y1] = this.point(a);
    let [x2, y2] = this.point(b);
    if (Math.abs(x2 - x1) > this.W / 2) {
      if (o.anchor === "from") x2 += x1 > x2 ? this.W : -this.W;
      else x1 += x2 > x1 ? this.W : -this.W;
    }
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const bend = (o.bend ?? 0.18) * len;
    const nx = -(y2 - y1) / len;
    const ny = (x2 - x1) / len;
    const cx = (x1 + x2) / 2 + nx * bend;
    const cy = (y1 + y2) / 2 + ny * bend;
    // From the edge of the source's token to short of the target's (or the middle).
    const t0 = Math.min(0.3, 1.5 / len);
    const end = o.meet ? Math.max(0.26, 0.5 - 1.75 / len) : 1 - Math.min(0.4, 2.2 / len);
    /** @param {number} t @returns {P} */
    const q = (t) => [(1 - t) ** 2 * x1 + 2 * (1 - t) * t * cx + t * t * x2, (1 - t) ** 2 * y1 + 2 * (1 - t) * t * cy + t * t * y2];
    const N = 28;
    const pts = Array.from({ length: N + 1 }, (_, i) => q(t0 + (i / N) * (end - t0)));
    const g = s("g", { class: `arrow${o.friendly ? " friendly" : ""}` });
    g.style.setProperty("--c", color);
    const shadow = s("path", { class: "ashadow", transform: "translate(.25 .45)" });
    const body = s("path", { class: "body", fill: color });
    const chev = s("path", { class: "chev" });
    g.append(shadow, body, chev);
    this.fx.append(g);
    const shape = (/** @type {number} */ upto) => {
      const n = Math.max(2, Math.round(upto * N));
      const p = pts.slice(0, n + 1);
      /** @type {P[]} */
      const L = [];
      /** @type {P[]} */
      const R = [];
      const head = Math.min(p.length - 1, Math.max(1, Math.round(p.length * 0.25)));
      const hs = p.length - 1 - Math.min(p.length - 2, Math.max(2, Math.round((2.9 / (len * (end - t0))) * N)));
      for (let i = 0; i <= hs; i++) {
        const [px, py] = /** @type {P} */ (p[i]);
        const [ax, ay] = /** @type {P} */ (p[Math.max(0, i - 1)]);
        const [bx, by] = /** @type {P} */ (p[Math.min(p.length - 1, i + 1)]);
        const dl = Math.hypot(bx - ax, by - ay) || 1;
        const w = 0.4 + 0.38 * (i / Math.max(1, hs));
        L.push([px - ((by - ay) / dl) * w, py + ((bx - ax) / dl) * w]);
        R.push([px + ((by - ay) / dl) * w, py - ((bx - ax) / dl) * w]);
      }
      void head;
      const [hx, hy] = /** @type {P} */ (p[hs]);
      const [ex, ey] = /** @type {P} */ (p[p.length - 1]);
      const dl = Math.hypot(ex - hx, ey - hy) || 1;
      const hw = 1.55;
      const wing1 = [hx - ((ey - hy) / dl) * hw, hy + ((ex - hx) / dl) * hw];
      const wing2 = [hx + ((ey - hy) / dl) * hw, hy - ((ex - hx) / dl) * hw];
      const f = (/** @type {number[]} */ v) => `${(v[0] ?? 0).toFixed(2)} ${(v[1] ?? 0).toFixed(2)}`;
      const d = `M${L.map(f).join("L")}L${f(wing1)}L${f([ex, ey])}L${f(wing2)}L${[...R].reverse().map(f).join("L")}Z`;
      body.setAttribute("d", d);
      shadow.setAttribute("d", d);
      chev.setAttribute("d", `M${p.slice(0, hs + 1).map(f).join("L")}`);
    };
    shape(0.05);
    const stop = tween(ms, (k) => shape(0.05 + 0.95 * easeOut(k)));
    return {
      el: g,
      tip: /** @type {P} */ (pts[N]),
      /** Where it starts: the source's token (off the edge when it wraps). */
      from: /** @type {P} */ ([x1, y1]),
      pts,
      /** Breaks the arrow off: it fades and falls back. */
      broken() {
        stop();
        g.classList.add("broken");
        setTimeout(() => g.remove(), 900);
      },
      remove() {
        stop();
        g.remove();
      },
    };
  }

  /**
   * A token of marching armies (their number on a pennant in their
   * colour), at `pts[0]`; `march` moves it along points.
   * @param {string} color @param {number} n @param {P} at
   */
  token(color, n, at) {
    const g = s("g", { class: "token" });
    g.style.setProperty("--c", color);
    const inner = s("g", { class: "tin" });
    const text = s("text", { "text-anchor": "middle", y: 0.55 });
    inner.append(s("rect", { class: "tshadow", x: -1.5, y: -0.95, width: 3, height: 2.1, rx: 0.9, transform: "translate(.15 .3)" }), s("rect", { class: "tbody", x: -1.5, y: -1.05, width: 3, height: 2.1, rx: 0.9, fill: color }), text);
    g.append(inner);
    this.over.append(g);
    let pos = at;
    const place = (/** @type {P} */ p) => {
      pos = p;
      g.setAttribute("transform", `translate(${p[0].toFixed(2)} ${p[1].toFixed(2)})`);
    };
    const set = (/** @type {number} */ v) => {
      const str = String(Math.max(0, v));
      text.textContent = str;
      text.setAttribute("font-size", str.length > 1 ? "1.55" : "1.75");
    };
    place(at);
    set(n);
    /** @type {() => void} */
    let stop = () => {};
    return {
      el: g,
      get pos() {
        return pos;
      },
      set,
      /** Along points in `ms` (it hops a little: marching). @param {P[]} pts @param {number} ms */
      march(pts, ms) {
        stop();
        const total = pts.length - 1;
        stop = tween(ms, (k) => {
          const e = ease(k) * total;
          const i = Math.min(total - 1, Math.floor(e));
          const f = e - i;
          const [ax, ay] = /** @type {P} */ (pts[i]);
          const [bx, by] = /** @type {P} */ (pts[i + 1] ?? pts[i]);
          const hop = Math.abs(Math.sin(k * Math.PI * Math.max(2, Math.round(ms / 160)))) * 0.35 * (1 - k);
          place([ax + (bx - ax) * f, ay + (by - ay) * f - hop]);
        });
      },
      /** Straight to a point in `ms`. @param {P} p @param {number} ms */
      go(p, ms) {
        const from = pos;
        this.march([from, [(from[0] + p[0]) / 2, (from[1] + p[1]) / 2], p], ms);
      },
      /** A jolt (it took a hit). */
      hit() {
        g.classList.remove("jolt");
        void g.getBoundingClientRect();
        g.classList.add("jolt");
      },
      /** Gone: shattered (beaten) or merged into a badge. @param {"shatter" | "merge"} how */
      end(how) {
        stop();
        g.classList.add(how);
        setTimeout(() => g.remove(), 700);
      },
      remove() {
        stop();
        g.remove();
      },
    };
  }

  /**
   * Floods territory `i` with a colour from point `(x, y)` over `ms`
   * (a circle that grows until it covers the territory, a bright edge
   * on it); `done` when it has.
   * @param {number} i @param {string} color @param {number} x @param {number} y @param {number} ms @param {() => void} [done]
   */
  flood(i, color, x, y, ms, done) {
    const cells = this.centers[i] ?? [];
    const terr = this.world.territories[i];
    if (!terr) return;
    const far = Math.max(...cells.map(([cx, cy]) => Math.hypot(cx - x, cy - y))) + 1.5;
    const g = s("g", { "clip-path": `url(#clip-${terr.id})`, class: "floodg" });
    const fill = s("circle", { cx: x, cy: y, r: 0, fill: color, class: "flood" });
    const edge = s("circle", { cx: x, cy: y, r: 0, class: "floodedge" });
    g.append(fill, edge);
    this.fx.prepend(g);
    tween(
      ms,
      (k) => {
        const r = (far * easeOut(k)).toFixed(2);
        fill.setAttribute("r", r);
        edge.setAttribute("r", r);
      },
      () => {
        done?.();
        g.classList.add("gone");
        setTimeout(() => g.remove(), 400);
      },
    );
  }

  /** A number (or word) floating up from a point. @param {P} p @param {string} text @param {string} color @param {string} [cls] */
  float(p, text, color, cls = "") {
    const [x, y] = p;
    const g = s("g", { transform: `translate(${x.toFixed(2)} ${(y - 1.9).toFixed(2)})` });
    const el = /** @type {SVGTextElement} */ (s("text", { class: `float ${cls}`, "text-anchor": "middle" }));
    el.textContent = text;
    el.style.setProperty("--c", color);
    g.append(el);
    this.over.append(g);
    setTimeout(() => g.remove(), 1700);
  }

  /** A burst of sparks at a point (`big`: more, further). @param {P} p @param {string} color @param {boolean} [big] */
  burst(p, color, big = false) {
    const g = s("g", { class: `sparks${big ? " big" : ""}`, transform: `translate(${p[0].toFixed(2)} ${p[1].toFixed(2)})` });
    g.style.setProperty("--c", color);
    g.append(s("circle", { class: "flash", r: big ? 3.2 : 2, fill: "url(#flare)" }));
    const n = big ? 14 : 9;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + Math.random() * 0.4;
      const l = (big ? 2.2 : 1.4) * (0.7 + Math.random() * 0.6);
      g.append(s("line", { x1: (Math.cos(a) * 0.5).toFixed(2), y1: (Math.sin(a) * 0.5).toFixed(2), x2: (Math.cos(a) * l).toFixed(2), y2: (Math.sin(a) * l).toFixed(2) }));
    }
    this.over.append(g);
    setTimeout(() => g.remove(), 800);
  }

  /** Reinforcements dropping onto a territory: a hex in the holder's colour falls into its token. @param {number} i @param {string} color */
  drop(i, color) {
    const [x, y] = this.point(i);
    const g = s("g", { transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})` });
    const bit = s("path", { class: "dropin", d: hexPath([[0, 0]], 1.1), fill: color });
    g.append(bit);
    this.over.append(g);
    setTimeout(() => g.remove(), 600);
  }

  /** Confetti of tiny hexes from a point, in a colour. @param {P} p @param {string} color */
  confetti(p, color) {
    const g = s("g", { class: "confetti", transform: `translate(${p[0].toFixed(2)} ${p[1].toFixed(2)})` });
    for (let k = 0; k < 12; k++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const d = 2 + Math.random() * 3;
      const bit = s("path", { d: hexPath([[0, 0]], 0.32 + Math.random() * 0.2), fill: k % 3 === 0 ? "#fff" : color });
      bit.style.setProperty("--dx", `${(Math.cos(a) * d).toFixed(2)}px`);
      bit.style.setProperty("--dy", `${(Math.sin(a) * d).toFixed(2)}px`);
      bit.style.setProperty("--r", `${Math.round((Math.random() - 0.5) * 540)}deg`);
      g.append(bit);
    }
    this.over.append(g);
    setTimeout(() => g.remove(), 1300);
  }

  /** The screen shakes (a hit). @param {"small" | "big"} [how] */
  shake(how = "small") {
    const el = this.el;
    el.classList.remove("shake", "shake-big");
    void el.getBoundingClientRect();
    el.classList.add(how === "big" ? "shake-big" : "shake");
  }

  /** Clears the effects. */
  clearFx() {
    this.fx.replaceChildren();
    this.over.replaceChildren();
  }

  /** Dims everything but these territories, or nothing. @param {number[]} ids */
  focus(ids) {
    if (ids.length === 0) {
      this.dim.classList.remove("on");
      this.badges.forEach((b) => b.g.classList.remove("hot", "cold"));
      return;
    }
    const rest = this.world.territories.flatMap((_, i) => (ids.includes(i) ? [] : (this.centers[i] ?? [])));
    this.dim.setAttribute("d", hexPath(rest, 1.04));
    this.dim.classList.add("on");
    this.badges.forEach((b, i) => {
      b.g.classList.toggle("hot", ids.includes(i));
      b.g.classList.toggle("cold", !ids.includes(i));
    });
  }

  /**
   * A light pulsing over territories (a winner's, the fronts), or none.
   * @param {number[]} ids @param {string} color
   */
  glow(ids, color) {
    this.glowEl?.remove();
    this.glowEl = undefined;
    if (!ids.length) return;
    const el = s("path", { class: "glow", d: hexPath(ids.flatMap((i) => this.centers[i] ?? []), TILE), fill: color });
    this.dim.after(el);
    this.glowEl = el;
  }
  /** @type {SVGElement | undefined} */
  glowEl;

  /** Territories light up once (a player is ready). @param {number[]} ids @param {string} color */
  flash(ids, color) {
    if (!ids.length) return;
    const el = s("path", { class: "flash1", d: hexPath(ids.flatMap((i) => this.centers[i] ?? []), TILE), fill: "#fff" });
    el.style.setProperty("--c", color);
    this.dim.after(el);
    setTimeout(() => el.remove(), 1000);
  }

  /**
   * The fronts: every border between territories of different holders
   * (not between two wild ones), as one path that pulses.
   */
  fronts() {
    const w = this.world;
    let d = "";
    for (let r = 0; r < w.rows; r++) {
      for (let c = 0; c < w.cols; c++) {
        const t = w.cells[r * w.cols + c] ?? -1;
        if (t < 0) continue;
        const corners = hexCorners(...hexCenter(c, r, 1), 1);
        hexNeighbors(c, r).forEach(([nc, nr], k) => {
          if (nc < 0 || nr < 0 || nc >= w.cols || nr >= w.rows) return;
          const o = w.cells[nr * w.cols + nc] ?? -1;
          if (o < 0 || o <= t) return;
          const a1 = this.own[t] ?? "";
          const a2 = this.own[o] ?? "";
          if (a1 === a2 || (!a1 && !a2) || !a1 || !a2) return;
          const [i, j] = /** @type {[number, number]} */ (HEX_SIDES[k]);
          const a = /** @type {P} */ (corners[i]);
          const b = /** @type {P} */ (corners[j]);
          d += `M${a[0].toFixed(2)} ${a[1].toFixed(2)}L${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
        });
      }
    }
    this.frontEl?.remove();
    const el = s("path", { class: "front", d });
    this.dim.after(el);
    this.frontEl = el;
  }
  /** @type {SVGElement | undefined} */
  frontEl;

  /** No fronts. */
  noFronts() {
    this.frontEl?.remove();
    this.frontEl = undefined;
  }
}
