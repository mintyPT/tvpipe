// @ts-check
/**
 * Snug's candy, drawn the same on the TV and the phone (SVG, in cell
 * units: one cell is 1): a polyomino's outline with soft corners
 * (`outline`, `roundedPath`), a piece as a jelly candy in a player's
 * colour with a little face (`piece`), the board as a quilted cushion
 * (`cushion`), and colour helpers. docs/snug-design.md §11.
 */

export const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 * @returns {SVGElement}
 */
export function s(tag, attrs = {}) {
  const el = /** @type {SVGElement} */ (document.createElementNS(SVG_NS, tag));
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** @typedef {readonly [number, number]} Cell */

const isColor = (/** @type {unknown} */ c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);

/** A colour mixed towards white (`f` > 0) or black (`f` < 0). @param {string} hex @param {number} f */
export function shade(hex, f) {
  if (!isColor(hex)) hex = "#999999";
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f)));
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The outlines of a set of cells: closed loops of corner points, clockwise
 * (on screen, y down), collinear points merged. Cells touching only at a
 * corner make separate loops.
 * @param {readonly Cell[]} cells
 * @returns {[number, number][][]}
 */
export function outline(cells) {
  const has = new Set(cells.map(([x, y]) => `${x},${y}`));
  const at = (/** @type {number} */ x, /** @type {number} */ y) => has.has(`${x},${y}`);
  /** @type {Map<string, [number, number, number, number][]>} start point → edges (x1, y1, x2, y2) */
  const from = new Map();
  const add = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c, /** @type {number} */ d) => {
    const k = `${a},${b}`;
    const list = from.get(k) ?? [];
    list.push([a, b, c, d]);
    from.set(k, list);
  };
  for (const [x, y] of cells) {
    if (!at(x, y - 1)) add(x, y, x + 1, y);
    if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!at(x - 1, y)) add(x, y + 1, x, y);
  }
  /** @type {[number, number][][]} */
  const loops = [];
  for (;;) {
    const start = [...from.values()].find((l) => l.length > 0)?.[0];
    if (!start) break;
    /** @type {[number, number][]} */
    const pts = [];
    let e = start;
    for (let guard = 0; guard < 4096; guard++) {
      const list = /** @type {[number, number, number, number][]} */ (from.get(`${e[0]},${e[1]}`));
      list.splice(list.indexOf(e), 1);
      pts.push([e[0], e[1]]);
      const next = from.get(`${e[2]},${e[3]}`) ?? [];
      if (next.length === 0) break;
      // At a pinch (two edges leave one point) turn right: keep to this loop's cells.
      const dx = e[2] - e[0];
      const dy = e[3] - e[1];
      const right = next.find((n) => n[2] - n[0] === -dy && n[3] - n[1] === dx);
      e = right ?? next[0];
    }
    // Merge collinear points.
    const out = pts.filter((p, i) => {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[(i + 1) % pts.length];
      return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
    });
    if (out.length >= 4) loops.push(out);
  }
  return loops;
}

/**
 * A loop as a path with rounded corners, moved inwards by `inset`
 * (negative: outwards), corners rounded by `r`, scaled by `unit`.
 * @param {[number, number][]} loop
 * @param {number} r
 * @param {number} [inset]
 * @param {number} [unit]
 */
export function roundedPath(loop, r, inset = 0, unit = 1) {
  const n = loop.length;
  // Each corner moves along both edges' inward normals (right of the direction, y down).
  const pts = loop.map((p, i) => {
    const a = loop[(i - 1 + n) % n];
    const b = loop[(i + 1) % n];
    const d1 = [Math.sign(p[0] - a[0]), Math.sign(p[1] - a[1])];
    const d2 = [Math.sign(b[0] - p[0]), Math.sign(b[1] - p[1])];
    const n1 = [-d1[1], d1[0]];
    const n2 = [-d2[1], d2[0]];
    return [(p[0] + (n1[0] + n2[0]) * inset) * unit, (p[1] + (n1[1] + n2[1]) * inset) * unit];
  });
  let d = "";
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[(i - 1 + n) % n];
    const b = pts[(i + 1) % n];
    const la = Math.hypot(p[0] - a[0], p[1] - a[1]);
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const rr = Math.min(r * unit, la / 2, lb / 2);
    const s1 = [p[0] + ((a[0] - p[0]) / la) * rr, p[1] + ((a[1] - p[1]) / la) * rr];
    const s2 = [p[0] + ((b[0] - p[0]) / lb) * rr, p[1] + ((b[1] - p[1]) / lb) * rr];
    d += `${i === 0 ? "M" : "L"}${f(s1[0])} ${f(s1[1])}Q${f(p[0])} ${f(p[1])} ${f(s2[0])} ${f(s2[1])}`;
  }
  return `${d}Z`;
}

const f = (/** @type {number} */ x) => (Math.round(x * 1000) / 1000).toString();

/** The path of cells' outlines (all loops). @param {readonly Cell[]} cells @param {number} r @param {number} [inset] */
export function cellsPath(cells, r, inset = 0) {
  return outline(cells)
    .map((l) => roundedPath(l, r, inset))
    .join("");
}

/**
 * The cell a piece's face goes on: the one nearest its middle (on the
 * piece, the top-most of equals).
 * @param {readonly Cell[]} cells
 * @returns {Cell}
 */
export function faceCell(cells) {
  const cx = cells.reduce((a, c) => a + c[0] + 0.5, 0) / cells.length;
  const cy = cells.reduce((a, c) => a + c[1] + 0.5, 0) / cells.length;
  let best = cells[0];
  let bd = Infinity;
  for (const c of cells) {
    const d = (c[0] + 0.5 - cx) ** 2 + (c[1] + 0.5 - cy) ** 2 - c[1] * 1e-3;
    if (d < bd - 1e-9) {
      bd = d;
      best = c;
    }
  }
  return best;
}

let gradId = 0;

/** A stable small number for a key (blink timings that do not jump between draws). @param {string} k */
export function hash(k) {
  let x = 2166136261;
  for (let i = 0; i < k.length; i++) x = Math.imul(x ^ k.charCodeAt(i), 16777619);
  return (x >>> 0) / 4294967296;
}

/**
 * A piece as a jelly candy: the body in the colour with a light top and a
 * darker rim, a gloss, and a face on its middle cell (eyes that blink,
 * rosy cheeks, a smile; `mood` "happy" smiles wide, "oops" frowns). In
 * cell units; `key` keeps its blinking steady.
 * @param {readonly Cell[]} cells
 * @param {string} color
 * @param {{ key?: string, mood?: "calm" | "happy" | "oops" | "sleepy", face?: boolean, inset?: number }} [o]
 * @returns {SVGGElement}
 */
export function piece(cells, color, o = {}) {
  const g = /** @type {SVGGElement} */ (s("g", { class: "candy" }));
  const inset = o.inset ?? 0.06;
  const id = `cg${++gradId}`;
  const defs = s("defs");
  const grad = s("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(s("stop", { offset: 0, "stop-color": shade(color, 0.42) }), s("stop", { offset: 0.45, "stop-color": shade(color, 0.12) }), s("stop", { offset: 1, "stop-color": color }));
  defs.append(grad);
  g.append(defs);
  const body = cellsPath(cells, 0.3, inset);
  // A soft shadow under the candy.
  g.append(s("path", { d: body, class: "shadow", fill: shade(color, -0.55), "fill-opacity": 0.22, transform: "translate(0.04 0.09)" }));
  g.append(s("path", { d: body, class: "body", fill: `url(#${id})`, stroke: shade(color, -0.22), "stroke-width": 0.07, "stroke-linejoin": "round" }));
  // The gloss: a highlight on the top edge of the top-left cell.
  const top = [...cells].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
  g.append(s("rect", { class: "gloss", x: top[0] + 0.2, y: top[1] + 0.15, width: 0.34, height: 0.12, rx: 0.06, fill: "#fff", "fill-opacity": 0.7 }));
  g.append(s("circle", { class: "gloss", cx: top[0] + 0.62, cy: top[1] + 0.21, r: 0.05, fill: "#fff", "fill-opacity": 0.7 }));
  if (o.face !== false) g.append(face(faceCell(cells), color, o.mood ?? "calm", o.key ?? ""));
  return g;
}

/**
 * A face on a cell: dot eyes with a sparkle, rosy cheeks, a mouth.
 * @param {Cell} c @param {string} color @param {string} mood @param {string} k
 */
function face([x, y], color, mood, k) {
  const g = s("g", { class: `face ${mood}` });
  const ink = shade(color, -0.78);
  const eyes = s("g", { class: "eyes" });
  eyes.style.setProperty("--blink", `${(3.2 + hash(k) * 3).toFixed(2)}s`);
  eyes.style.setProperty("--blink-d", `${(-hash(`${k}!`) * 5).toFixed(2)}s`);
  if (mood === "happy") {
    // Closed happy eyes: little arches.
    for (const ex of [0.33, 0.67]) eyes.append(s("path", { d: `M${x + ex - 0.08} ${y + 0.5}Q${x + ex} ${y + 0.38} ${x + ex + 0.08} ${y + 0.5}`, fill: "none", stroke: ink, "stroke-width": 0.055, "stroke-linecap": "round" }));
  } else if (mood === "sleepy") {
    for (const ex of [0.33, 0.67]) eyes.append(s("path", { d: `M${x + ex - 0.07} ${y + 0.47}H${x + ex + 0.07}`, stroke: ink, "stroke-width": 0.05, "stroke-linecap": "round" }));
  } else {
    for (const ex of [0.33, 0.67]) {
      eyes.append(s("ellipse", { cx: x + ex, cy: y + 0.47, rx: 0.068, ry: 0.088, fill: ink }));
      eyes.append(s("circle", { cx: x + ex + 0.022, cy: y + 0.44, r: 0.024, fill: "#fff" }));
    }
  }
  g.append(eyes);
  for (const ex of [0.2, 0.8]) g.append(s("ellipse", { cx: x + ex, cy: y + 0.62, rx: 0.085, ry: 0.05, fill: "#ff6f91", "fill-opacity": 0.45 }));
  const mouth =
    mood === "happy"
      ? `M${x + 0.4} ${y + 0.6}Q${x + 0.5} ${y + 0.76} ${x + 0.6} ${y + 0.6}Z`
      : mood === "oops"
        ? `M${x + 0.43} ${y + 0.7}Q${x + 0.5} ${y + 0.62} ${x + 0.57} ${y + 0.7}`
        : `M${x + 0.43} ${y + 0.62}Q${x + 0.5} ${y + 0.7} ${x + 0.57} ${y + 0.62}`;
  g.append(s("path", { d: mouth, fill: mood === "happy" ? shade(color, -0.6) : "none", stroke: ink, "stroke-width": 0.045, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  return g;
}

/**
 * The board as a quilted cushion: a puffy cream body with a stitched
 * seam inside its edge, and a soft square per cell.
 * @param {{ rows: string[] }} shape
 * @returns {SVGGElement}
 */
export function cushion(shape) {
  /** @type {Cell[]} */
  const cells = [];
  shape.rows.forEach((r, y) => [...r].forEach((ch, x) => ch === "#" && cells.push([x, y])));
  const g = /** @type {SVGGElement} */ (s("g", { class: "cushion" }));
  const body = cellsPath(cells, 0.45, -0.22);
  g.append(s("path", { d: body, class: "c-shadow", transform: "translate(0 0.14)" }));
  g.append(s("path", { d: body, class: "c-body" }));
  g.append(s("path", { d: cellsPath(cells, 0.35, -0.1), class: "c-seam" }));
  for (const [x, y] of cells) g.append(s("rect", { x: x + 0.07, y: y + 0.07, width: 0.86, height: 0.86, rx: 0.2, class: "c-cell" }));
  return g;
}

/**
 * A cursor: a rounded arrow in a player's colour with their initial.
 * @param {string} color @param {string} initial
 * @returns {SVGGElement}
 */
export function pointer(color, initial) {
  const g = /** @type {SVGGElement} */ (s("g", { class: "pointer" }));
  g.append(s("path", { d: "M0 0L0.05 0.62L0.2 0.47L0.34 0.74L0.44 0.69L0.31 0.43L0.52 0.41Z", fill: color, stroke: "#fff", "stroke-width": 0.06, "stroke-linejoin": "round" }));
  const tag = s("g", { transform: "translate(0.42 0.62)" });
  tag.append(s("circle", { r: 0.22, fill: color, stroke: "#fff", "stroke-width": 0.05 }));
  const t = s("text", { y: 0.085, "text-anchor": "middle", class: "p-initial" });
  t.textContent = initial;
  tag.append(t);
  g.append(tag);
  return g;
}

/** A player's initial. @param {string | undefined} name */
export const initial = (name) => [...(name ?? "?").trim()][0]?.toUpperCase() ?? "?";
