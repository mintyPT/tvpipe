// @ts-check
/**
 * Pinch's look (docs/pinch-design.md §12), drawn the same on the TV and
 * the phone: Canvas 2D, flat shapes with bold dark outlines, a 1920s
 * estate drawn like a 1960s cartoon. The seen world in colour, the
 * unseen as an architect's blueprint, what one remembers greyed, the
 * public layer (the ink, claims in crayon, facts in print) over both,
 * the characters, the loot, a little Deco chrome.
 *
 * Coordinates are map.ts's: tiles, x east, y south, tile (x, y) covers
 * [x, x + 1) × [y, y + 1); angles in degrees, 0 = east, 90 = south (as
 * map.ts, sight.ts and protocol.ts). Nothing here throws on odd data:
 * what does not make sense is not drawn.
 *
 * ## Use
 *
 *   const map = decodeBlueprint(room.blueprint);          // dist/game/map.js
 *   const art = createArt(map, { names });                 // once per map: the caches
 *   const mem = createMemory(map);                         // the phone, once per heist
 *   // every frame (protocol.ts Frame `f`):
 *   const masks = decodeFrameMasks(f, map);                // { seen, light }
 *   remember(mem, f, masks.seen);
 *   pub = applyPublic(pub, f.pub, map) ?? pub;             // PublicState
 *   // every animation frame:
 *   const ctx = fitCanvas(canvas, cssW, cssH, dpr);
 *   const view = followView(me.x, me.y, 14, cssW, cssH, dpr);
 *   drawWorld(ctx, art, view, { ...masks, memory: mem, now: f.t, items: f.items, empty: f.empty,
 *     lamps: pub.lamps, catalogue, colors: room.colors, figures: [...f.others, meFigure] });
 *   drawPublic(ctx, art, view, pub, { colors: room.colors, names, lights: false });
 *
 *   // the TV: drawBlueprint(ctx, art, fitView(map, w, h, dpr, { pad: 8 })); drawPublic(ctx, art, view, pub, { colors, names });
 *   // the tape: drawWorld(ctx, art, view, { seen: null, light: lightMask(map, state), doors, figures, items });
 *
 * `toTile(view, cssX, cssY)` maps a tap to tiles. The static layers
 * (the blueprint paper, the coloured floors, walls and furniture, their
 * greyed copy for memory) are drawn once into chunks of {@link CHUNK}
 * tiles per zoom step and reused; per frame only masks, doors, loot,
 * lights and figures are drawn (a phone keeps 60 fps; pass dpr ≤ 2).
 * createArt redraws the caches when the fonts arrive.
 *
 * ## The data drawn from
 *
 * The pages pass protocol.ts' and views.ts' shapes through:
 * {@link Scene} for {@link drawWorld} (a Frame's masks, items, empty
 * places and other players, a {@link Memory}), {@link PublicLike} (a
 * protocol.ts `PublicState`) for {@link drawPublic}, {@link Figure} (a
 * protocol.ts `SeenPlayer`, or one's own state, or a tape sample).
 */

/** @typedef {import("../game/map.ts").Blueprint} Blueprint */
/** @typedef {import("../game/map.ts").Prop} Prop */
/** @typedef {import("../game/map.ts").Door} Door */
/** @typedef {import("../game/map.ts").Rect} Rect */
/** @typedef {import("../game/protocol.ts").SeenItem} SeenItem */
/** @typedef {import("../game/protocol.ts").SeenEmpty} SeenEmpty */
/** @typedef {import("../game/protocol.ts").MarkPub} MarkPub */
/** @typedef {import("../game/protocol.ts").Where} Where */

/**
 * Where on the map a canvas looks. `left`, `top`: the tile coordinate at
 * the canvas's top left corner; `scale`: CSS px per tile; `width`,
 * `height`: the canvas in CSS px; `dpr`: device px per CSS px.
 * @typedef {{ left: number, top: number, scale: number, width: number, height: number, dpr: number }} View
 */

/**
 * A character from above: a protocol.ts `SeenPlayer` as it comes, or
 * one's own state (`light: me.light === "on"`, `held: me.frozen`), or a
 * tape sample. `facing`: degrees; `light`: a guard's flashlight is on;
 * `warming`: one's own flashlight warming up (GuardMe `light === "warming"`: the cone flickers);
 * `held`: frozen in a hold (held or holding); `holding`: the guard
 * holding (a brighter, steady beam; the held thief is `held && !holding` and gets the net); `sack`: the thief's
 * filled slots (0–4, the sack grows). Drawing extras: `colour` (else
 * `Scene.colors[id]`), `name` (a label under it), `self` (a ring under
 * one's own figure), `cuffed` (arrested), `alpha`, `walk` (tiles walked,
 * for the steps; else from the clock).
 * @typedef {{ role: "guard" | "thief", x: number, y: number, id?: string, facing?: number, moving?: boolean,
 *   light?: boolean, warming?: boolean, held?: boolean, holding?: boolean, sack?: number, colour?: string, name?: string, self?: boolean,
 *   cuffed?: boolean, alpha?: number, walk?: number }} Figure
 */

/**
 * A night's catalogue as views.ts `CatalogueEntry[]` (by catalogue
 * index, as `SeenItem.item`): the icon comes from `id`, the size from `size`.
 * @typedef {readonly { id: string, size?: "small" | "large", tagged?: boolean }[]} Catalogue
 */

/**
 * What one viewer sees, for {@link drawWorld}.
 * - `seen`, `light`: protocol.ts `decodeFrameMasks` (per tile: 0/1, and
 *   sight.ts `LIGHT` bits); `seen` null = everything (the tape);
 *   `light` missing = all lit.
 * - `memory`: a {@link Memory} ({@link createMemory}, {@link remember}):
 *   what one saw before, drawn greyed by age, with its doors and loot.
 * - `now`: heist time (s): memory ages, animation.
 * - `doors`: per door id, move.ts states (0 closed, 1 open, 2 locked);
 *   default: the memory's.
 * - `lamps`: per lamp id, truthy = on (PublicLayer `lamps`).
 * - `items`, `empty`: a Frame's `items` and `empty` (on seen tiles).
 * - `catalogue`: for the items' icons and sizes.
 * - `figures`: a Frame's `others` plus one's own figure.
 * - `colors`: views.ts `RoomView.colors` (guards wear them); `names`:
 *   player names by id (labels under figures, when given).
 * @typedef {{ seen?: ArrayLike<number> | null, light?: ArrayLike<number> | null, memory?: Memory | null,
 *   now?: number, doors?: ArrayLike<number> | null, lamps?: ArrayLike<number | boolean> | null,
 *   items?: readonly SeenItem[], empty?: readonly SeenEmpty[], catalogue?: Catalogue,
 *   figures?: readonly Figure[], colors?: Readonly<Record<string, string>>, names?: Readonly<Record<string, string>> }} Scene
 */

/**
 * The public layer as {@link drawPublic} reads it: a protocol.ts
 * `PublicState` (or a `PublicLayer` with `ink` decoded), every field optional.
 * @typedef {{ t?: number, rooms?: ArrayLike<number | boolean> | null, lamps?: ArrayLike<number | boolean> | null,
 *   ink?: ArrayLike<number> | null,
 *   cameras?: readonly { id: number, tampered: boolean, sees: { x: number, y: number, facing: number } | null }[],
 *   noises?: readonly { id?: number, kind: string, x: number, y: number, t: number }[],
 *   alarm?: { t: number, room: number, x: number, y: number } | null,
 *   missing?: readonly { item?: number, room?: number, x: number, y: number, t: number }[],
 *   pings?: readonly { x: number, y: number, r: number, t: number }[],
 *   holds?: readonly { x: number, y: number, t: number, until: number, total: number, guard?: string, thief?: string }[],
 *   marks?: readonly { id?: number, guard: string, kind: string, x: number, y: number, where?: Where, angle?: number, t: number, until?: number }[],
 *   arrest?: { x: number, y: number, t: number, guard?: string } | null }} PublicLike
 */

/**
 * The printed and crayon words on the map ({@link drawPublic}'s
 * `words`), uppercase; English by default.
 * @typedef {{ glass?: string, lamp?: string, firecracker?: string, alarm?: string, held?: string, ping?: string,
 *   missing?: string, pinched?: string, gotAway?: string, static?: string, camera?: string,
 *   clear?: string, seen?: string, post?: string, look?: string }} MapWords
 */

// ---------------------------------------------------------------- palette

export const PALETTE = {
  ink: "#16110d",
  gold: "#d6a842",
  goldLight: "#f3d27a",
  goldDark: "#8e6a22",
  cream: "#f1e4c4",
  black: "#121012",
  emerald: "#1f6b52",
  oxblood: "#7c2230",
  night: "#0a0f1f",
  paper: "#17406f",
  paperDark: "#103259",
  line: "#e9f1ff",
  pencil: "#e5483c",
  amber: "#ffb347",
  torch: "#fff3b8",
};

/** Guard colours that read on the blueprint, on floors and in the dark (red is the ink's). */
export const GUARD_COLOURS = ["#ffd447", "#5fd3a6", "#ff8fc6", "#7cc8ff", "#ffa13d", "#b9a2ff", "#c4ec5c", "#ff7a6b"];

export const FONTS = {
  display: '"Limelight", "Georgia", serif',
  sans: '"Josefin Sans", "Futura", "Century Gothic", "Trebuchet MS", sans-serif',
  type: '"Courier Prime", "Courier New", monospace',
};

const P = PALETTE;
const WOOD = "#8c5a2e";
const WOOD_DARK = "#5c391c";
const WOOD_LIGHT = "#b57d45";
const PORCELAIN = "#f3f1ea";
const STEEL = "#77828a";
const FELT = "#2e7b49";
const GLASS = "rgba(196,232,240,0.55)";
const SHADOW = "rgba(10,8,14,0.28)";
const BP_FILL = "#1d4a7d";
const BP_LINE = "rgba(236,244,255,0.88)";
const BP_FAINT = "rgba(236,244,255,0.42)";

/** Tile size of a cached chunk. */
export const CHUNK = 16;

// Map constants (copies of map.ts / sight.ts: the pages import no TypeScript).
const T = { FLOOR: 0, WALL: 1, LOT_WALL: 2, EDGE: 3, DOOR: 4, WINDOW: 5, HEDGE: 6, TREE: 7, CAR: 8, FOUNTAIN: 9, SHED: 10, FURNITURE: 11 };
const F = { NONE: 0, GRASS: 1, GRAVEL: 2, PAVEMENT: 3, ASPHALT: 4, COBBLE: 5, PARQUET: 6, MARBLE: 7, CARPET: 8, TILES: 9, CONCRETE: 10, BOARDS: 11, STEEL: 12 };
const LIGHT_ROOM = 1;
const LIGHT_LAMP = 2;
const LIGHT_TORCH = 4;
const LAMP_RADIUS = 4;

const ROOM_NAMES = /** @type {Record<string, string>} */ ({
  foyer: "FOYER", corridor: "HALL", ballroom: "BALLROOM", library: "LIBRARY", study: "STUDY", gallery: "GALLERY",
  kitchen: "KITCHEN", dining: "DINING ROOM", billiards: "BILLIARD ROOM", conservatory: "CONSERVATORY", bedroom: "BEDROOM",
  bathroom: "BATHROOM", vault: "VAULT", security: "SECURITY", garage: "GARAGE", shed: "SHED",
});
const AREA_NAMES = /** @type {Record<string, string>} */ ({ street: "STREET", garden: "GARDEN", carpark: "CAR PARK", alley: "ALLEY", yard: "YARD" });

// ---------------------------------------------------------------- small helpers

/** Device px per tile of what is being drawn now (line widths in px). */
let S = 32;
const px = (/** @type {number} */ n) => n / S;
const OUT = () => Math.max(0.065, px(1.4));
const fin = (/** @type {unknown} */ v) => typeof v === "number" && Number.isFinite(v);
const clamp = (/** @type {number} */ v, /** @type {number} */ a, /** @type {number} */ b) => (v < a ? a : v > b ? b : v);
const RAD = Math.PI / 180;
const isColour = (/** @type {unknown} */ c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);

/** A deterministic number in [0, 1) from integers. @param {number} a @param {number} [b] @param {number} [c] */
function hash(a, b = 0, c = 0) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (b | 0) ^ (h >>> 13), 0xc2b2ae35);
  h = Math.imul(h ^ (c | 0) ^ (h >>> 16), 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** A colour mixed towards white (`f` > 0) or black (`f` < 0). @param {string} hex @param {number} f */
export function shade(hex, f) {
  if (!isColour(hex)) hex = "#999999";
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(f >= 0 ? c + (255 - c) * f : c * (1 + f)));
  return `#${ch.map((c) => clamp(c, 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

/** @param {string} hex @param {number} a */
function rgba(hex, a) {
  if (!isColour(hex)) hex = "#999999";
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1)})`;
}

/** @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
function rr(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
/** @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} rx @param {number} [ry] */
function el(c, x, y, rx, ry = rx) {
  c.beginPath();
  c.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2);
}

/** @returns {HTMLCanvasElement} */
function canvas(/** @type {number} */ w, /** @type {number} */ h) {
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.ceil(w));
  cv.height = Math.max(1, Math.ceil(h));
  return cv;
}
/** @param {HTMLCanvasElement} cv */
function ctx2d(cv) {
  const c = /** @type {CanvasRenderingContext2D} */ (cv.getContext("2d"));
  return c;
}

// ---------------------------------------------------------------- modes

/**
 * How shapes are filled: in colour, as a blueprint (white lines on blue),
 * or as a drop shadow (one dark fill).
 * @typedef {{ bp: boolean, shadow: boolean, lod: number }} Mode
 */

/** Fills and outlines the current path. @param {CanvasRenderingContext2D} c @param {Mode} m @param {string} fill @param {number} [lw] */
function fo(c, m, fill, lw) {
  if (m.shadow) {
    c.fillStyle = SHADOW;
    c.fill();
    return;
  }
  if (m.bp) {
    c.fillStyle = BP_FILL;
    c.fill();
    c.strokeStyle = BP_LINE;
    c.lineWidth = Math.max(0.035, px(1));
    c.stroke();
    return;
  }
  c.fillStyle = fill;
  c.fill();
  c.strokeStyle = P.ink;
  c.lineWidth = lw ?? OUT();
  c.stroke();
}
/** A detail fill (no outline): faint lines on the blueprint, nothing in a shadow. @param {CanvasRenderingContext2D} c @param {Mode} m @param {string} fill */
function fl(c, m, fill) {
  if (m.shadow || m.lod < 1) return;
  if (m.bp) {
    c.strokeStyle = BP_FAINT;
    c.lineWidth = Math.max(0.025, px(0.8));
    c.stroke();
    return;
  }
  c.fillStyle = fill;
  c.fill();
}
/** A detail fill with a thin outline. @param {CanvasRenderingContext2D} c @param {Mode} m @param {string} fill */
function fd(c, m, fill) {
  if (m.shadow || m.lod < 1) return;
  if (m.bp) {
    fl(c, m, fill);
    return;
  }
  c.fillStyle = fill;
  c.fill();
  c.strokeStyle = P.ink;
  c.lineWidth = Math.max(0.035, px(1));
  c.stroke();
}
/** A detail line. @param {CanvasRenderingContext2D} c @param {Mode} m @param {string} colour @param {number} w */
function ln(c, m, colour, w) {
  if (m.shadow || m.lod < 1) return;
  c.strokeStyle = m.bp ? BP_FAINT : colour;
  c.lineWidth = m.bp ? Math.max(0.025, px(0.8)) : Math.max(w, px(0.8));
  c.stroke();
}
/**
 * A union of circles with one outline (outlines first, fills over them).
 * @param {CanvasRenderingContext2D} c @param {Mode} m @param {[number, number, number][]} circles @param {string} fill @param {string} [top]
 */
function blob(c, m, circles, fill, top) {
  if (m.shadow) {
    c.fillStyle = SHADOW;
    c.beginPath();
    for (const [x, y, r] of circles) {
      c.moveTo(x + r, y);
      c.arc(x, y, r, 0, Math.PI * 2);
    }
    c.fill();
    return;
  }
  const lw = m.bp ? Math.max(0.035, px(1)) : OUT();
  c.strokeStyle = m.bp ? BP_LINE : P.ink;
  c.lineWidth = lw * 2;
  for (const [x, y, r] of circles) {
    el(c, x, y, r);
    c.stroke();
  }
  c.fillStyle = m.bp ? BP_FILL : fill;
  c.beginPath();
  for (const [x, y, r] of circles) {
    c.moveTo(x + r, y);
    c.arc(x, y, r, 0, Math.PI * 2);
  }
  c.fill();
  if (top && !m.bp && m.lod >= 1) {
    c.fillStyle = top;
    c.beginPath();
    for (const [x, y, r] of circles) {
      c.moveTo(x - r * 0.15 + r * 0.55, y - r * 0.2);
      c.arc(x - r * 0.15, y - r * 0.2, r * 0.55, 0, Math.PI * 2);
    }
    c.fill();
  }
}

// ---------------------------------------------------------------- the view

/**
 * The view that shows the whole map (or `rect` of it) in a canvas, with
 * `pad` CSS px around.
 * @param {{ w: number, h: number }} map @param {number} width @param {number} height @param {number} [dpr]
 * @param {{ pad?: number, rect?: Rect }} [o]
 * @returns {View}
 */
export function fitView(map, width, height, dpr = 1, o = {}) {
  const r = o.rect ?? { x: 0, y: 0, w: map?.w || 1, h: map?.h || 1 };
  const pad = o.pad ?? 0;
  const scale = Math.max(0.01, Math.min((width - 2 * pad) / Math.max(1, r.w), (height - 2 * pad) / Math.max(1, r.h)));
  return {
    scale,
    left: r.x + r.w / 2 - width / 2 / scale,
    top: r.y + r.h / 2 - height / 2 / scale,
    width,
    height,
    dpr: fin(dpr) && dpr > 0 ? dpr : 1,
  };
}

/**
 * A view centred on (x, y) showing `across` tiles across the width.
 * @param {number} x @param {number} y @param {number} across @param {number} width @param {number} height @param {number} [dpr]
 * @returns {View}
 */
export function followView(x, y, across, width, height, dpr = 1) {
  const scale = width / Math.max(1, fin(across) ? across : 14);
  const cx = fin(x) ? x : 0;
  const cy = fin(y) ? y : 0;
  return { scale, left: cx - width / 2 / scale, top: cy - height / 2 / scale, width, height, dpr: fin(dpr) && dpr > 0 ? dpr : 1 };
}

/** A CSS px point of the canvas → tiles. @param {View} v @param {number} sx @param {number} sy */
export function toTile(v, sx, sy) {
  return { x: v.left + sx / v.scale, y: v.top + sy / v.scale };
}
/** Tiles → CSS px of the canvas. @param {View} v @param {number} x @param {number} y */
export function toScreen(v, x, y) {
  return { x: (x - v.left) * v.scale, y: (y - v.top) * v.scale };
}

/**
 * Sizes a canvas for CSS size × dpr and returns its context (cleared).
 * @param {HTMLCanvasElement} cv @param {number} width @param {number} height @param {number} [dpr]
 */
export function fitCanvas(cv, width, height, dpr = 1) {
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  if (cv.style) {
    const sw = `${width}px`;
    const sh = `${height}px`;
    if (cv.style.width !== sw) cv.style.width = sw;
    if (cv.style.height !== sh) cv.style.height = sh;
  }
  const c = ctx2d(cv);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  return c;
}

/** Puts the context in tile units for the view. @param {CanvasRenderingContext2D} c @param {View} v */
export function useTiles(c, v) {
  const k = v.scale * v.dpr;
  c.setTransform(k, 0, 0, k, -v.left * k, -v.top * k);
  c.lineJoin = "round";
  c.lineCap = "round";
  S = k;
}

// ---------------------------------------------------------------- the art (caches per map)

/**
 * A map's caches. Make one per map with {@link createArt}.
 * @typedef {{
 *   map: Blueprint, names: string[], areaNames: string[],
 *   chunks: Map<string, { cv: HTMLCanvasElement, used: number, q: number }>, pixels: number, frame: number,
 *   scratch: HTMLCanvasElement[], masks: Map<string, { cv: HTMLCanvasElement, img: ImageData, stamp: string }>,
 *   lampGlow: Float32Array, propAt: Int16Array, insideDoor: Uint8Array,
 *   hatch: HTMLCanvasElement | null, noise: HTMLCanvasElement | null,
 *   sightings: Map<number, { x: number, y: number, facing: number, t: number, since: number }>, spotAt: Uint8Array | null,
 *   nameBoxes: { x: number, y: number, w: number, h: number, size: number }[] | null,
 *   invalidate: () => void, setNames: (names?: readonly string[] | null, areaNames?: readonly string[] | null) => void
 * }} Art
 */

/**
 * The caches for a map. `names`: per room id, its name to letter on the
 * blueprint (default: the kind in English); `areaNames` likewise.
 * @param {Blueprint} map @param {{ names?: readonly string[], areaNames?: readonly string[] }} [o]
 * @returns {Art | null}
 */
export function createArt(map, o = {}) {
  if (!validMap(map)) return null;
  const n = map.w * map.h;
  const lampGlow = new Float32Array(n);
  for (const l of map.lamps) {
    if (!fin(l?.x) || !fin(l?.y)) continue;
    for (let y = Math.max(0, l.y - LAMP_RADIUS - 1); y <= Math.min(map.h - 1, l.y + LAMP_RADIUS + 1); y++) {
      for (let x = Math.max(0, l.x - LAMP_RADIUS - 1); x <= Math.min(map.w - 1, l.x + LAMP_RADIUS + 1); x++) {
        const d = Math.hypot(x - l.x, y - l.y);
        const g = clamp(1 - d / (LAMP_RADIUS + 0.8), 0, 1);
        const i = y * map.w + x;
        lampGlow[i] = Math.max(lampGlow[i] ?? 0, g);
      }
    }
  }
  const propAt = new Int16Array(n).fill(-1);
  for (const p of map.props) {
    const r = p?.rect;
    if (!r) continue;
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (x >= 0 && y >= 0 && x < map.w && y < map.h) propAt[y * map.w + x] = p.id;
  }
  // Tiles inside a building (floors, walls) vs outside, for the doors' look.
  const insideDoor = new Uint8Array(map.doors.length);
  map.doors.forEach((d, k) => (insideDoor[k] = d && !d.outside ? 1 : 0));
  /** @type {Art} */
  const art = {
    map,
    names: [],
    areaNames: [],
    chunks: new Map(),
    pixels: 0,
    frame: 0,
    scratch: [],
    masks: new Map(),
    lampGlow,
    propAt,
    insideDoor,
    hatch: null,
    noise: null,
    sightings: new Map(),
    spotAt: null,
    nameBoxes: null,
    invalidate() {
      art.nameBoxes = null;
      art.chunks.clear();
      art.pixels = 0;
    },
    setNames(names, areaNames) {
      art.names = map.rooms.map((r, i) => (typeof names?.[i] === "string" ? String(names[i]).toUpperCase() : defaultRoomName(map, i)));
      art.areaNames = map.areas.map((a, i) => (typeof areaNames?.[i] === "string" ? String(areaNames[i]).toUpperCase() : (AREA_NAMES[a.kind] ?? "")));
      art.invalidate();
    },
  };
  art.setNames(o.names, o.areaNames);
  try {
    document.fonts?.ready.then(() => art.invalidate());
    document.fonts?.addEventListener?.("loadingdone", () => art.invalidate());
  } catch {
    // no font API: the fallback fonts stay
  }
  return art;
}

/** @param {Blueprint} map @param {number} i */
function defaultRoomName(map, i) {
  const r = map.rooms[i];
  if (!r) return "";
  const base = ROOM_NAMES[r.kind] ?? String(r.kind).toUpperCase();
  const same = map.rooms.filter((q) => q.kind === r.kind).length;
  return same > 1 && r.kind !== "corridor" ? `${base} ${["I", "II", "III", "IV", "V", "VI", "VII", "VIII"][r.nth] ?? r.nth + 1}` : base;
}

/** @param {unknown} m @returns {m is Blueprint} */
function validMap(m) {
  const b = /** @type {Blueprint} */ (m);
  if (!b || !Number.isInteger(b.w) || !Number.isInteger(b.h) || b.w < 1 || b.h < 1 || b.w > 400 || b.h > 400) return false;
  const n = b.w * b.h;
  if (!b.tiles || b.tiles.length < n || !b.floors || b.floors.length < n) return false;
  for (const k of /** @type {const} */ (["rooms", "areas", "doors", "windows", "lamps", "cameras", "spots", "props"])) if (!Array.isArray(b[k])) return false;
  return true;
}

/** The zoom step of chunks for a device px per tile. @param {number} k */
function quant(k) {
  const q = Math.pow(2, Math.round(Math.log2(clamp(k, 3, 128)) * 3) / 3);
  return Math.round(q * 100) / 100;
}

const MAX_PIXELS = 40e6;

/**
 * A chunk of a static layer, drawn now or taken from the cache.
 * @param {Art} art @param {"paper" | "colour" | "grey"} layer @param {number} q @param {number} cx @param {number} cy @param {{ budget: number }} b
 */
function chunk(art, layer, q, cx, cy, b) {
  const key = `${layer}:${q}:${cx}:${cy}`;
  let ch = art.chunks.get(key);
  if (ch) {
    ch.used = art.frame;
    return ch;
  }
  if (b.budget <= 0) {
    // Zooming: a chunk of another step, scaled, until this one is drawn.
    for (const [k, v] of art.chunks) if (k.startsWith(`${layer}:`) && k.endsWith(`:${cx}:${cy}`)) return v;
  }
  b.budget--;
  const size = Math.ceil(CHUNK * q);
  const cv = canvas(size, size);
  const c = ctx2d(cv);
  c.setTransform(q, 0, 0, q, -cx * CHUNK * q, -cy * CHUNK * q);
  c.lineJoin = "round";
  c.lineCap = "round";
  const saved = S;
  S = q;
  const rect = { x: cx * CHUNK, y: cy * CHUNK, w: CHUNK, h: CHUNK };
  try {
    if (layer === "paper") drawPaper(c, art, rect);
    else {
      drawColour(c, art, rect);
      if (layer === "grey") {
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalCompositeOperation = "saturation";
        c.fillStyle = "#808080";
        c.fillRect(0, 0, size, size);
        c.globalCompositeOperation = "multiply";
        c.fillStyle = "#7d93bd";
        c.fillRect(0, 0, size, size);
        c.globalCompositeOperation = "source-over";
      }
    }
  } catch {
    // odd data: whatever was drawn stays
  }
  S = saved;
  ch = { cv, used: art.frame, q };
  art.chunks.set(key, ch);
  art.pixels += size * size;
  if (art.pixels > MAX_PIXELS) {
    const old = [...art.chunks].filter(([, v]) => v.used < art.frame).sort((a, b) => a[1].used - b[1].used);
    for (const [k, v] of old) {
      if (art.pixels <= MAX_PIXELS * 0.7) break;
      art.chunks.delete(k);
      art.pixels -= v.cv.width * v.cv.height;
    }
  }
  return ch;
}

/**
 * Draws a static layer's chunks for the view, at device px (identity transform).
 * @param {CanvasRenderingContext2D} c @param {Art} art @param {View} v @param {"paper" | "colour" | "grey"} layer @param {{ budget: number }} b
 */
function blitLayer(c, art, v, layer, b) {
  const k = v.scale * v.dpr;
  const q = quant(k);
  const x0 = Math.max(0, Math.floor(v.left / CHUNK));
  const y0 = Math.max(0, Math.floor(v.top / CHUNK));
  const x1 = Math.min(Math.ceil(art.map.w / CHUNK) - 1, Math.floor((v.left + v.width / v.scale) / CHUNK));
  const y1 = Math.min(Math.ceil(art.map.h / CHUNK) - 1, Math.floor((v.top + v.height / v.scale) / CHUNK));
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.imageSmoothingEnabled = true;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const ch = chunk(art, layer, q, cx, cy, b);
      const sx0 = Math.round((cx * CHUNK - v.left) * k);
      const sy0 = Math.round((cy * CHUNK - v.top) * k);
      const sx1 = Math.round(((cx + 1) * CHUNK - v.left) * k);
      const sy1 = Math.round(((cy + 1) * CHUNK - v.top) * k);
      c.drawImage(ch.cv, 0, 0, ch.cv.width, ch.cv.height, sx0, sy0, sx1 - sx0, sy1 - sy0);
    }
  }
}

/** A view-sized scratch canvas. @param {Art} art @param {number} k @param {View} v */
function scratch(art, k, v) {
  const w = Math.max(1, Math.round(v.width * v.dpr));
  const h = Math.max(1, Math.round(v.height * v.dpr));
  let cv = art.scratch[k];
  if (!cv) art.scratch[k] = cv = canvas(w, h);
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  const c = ctx2d(cv);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = "source-over";
  c.globalAlpha = 1;
  c.clearRect(0, 0, w, h);
  return c;
}

/** @typedef {{ cv: HTMLCanvasElement, x: number, y: number, w: number, h: number }} Mask */

/** The tiles a view shows (and one around), clipped to the map. @param {Art} art @param {View} v @returns {Rect} */
function region(art, v) {
  const x0 = clamp(Math.floor(v.left) - 1, 0, art.map.w);
  const y0 = clamp(Math.floor(v.top) - 1, 0, art.map.h);
  const x1 = clamp(Math.ceil(v.left + v.width / v.scale) + 1, 0, art.map.w);
  const y1 = clamp(Math.ceil(v.top + v.height / v.scale) + 1, 0, art.map.h);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * A mask over the tiles of `r` at `M` pixels a tile: `tile(i)` gives a
 * tile's colour packed as 0xRRGGBBAA, or -1 to ask `sub(i, x, y)` for
 * each of its pixels (x, y: the pixel's centre in tiles). With a
 * `stamp`, an unchanged mask is reused.
 * @param {Art} art @param {string} key @param {number} M @param {Rect} r @param {(i: number) => number} tile
 * @param {((i: number, x: number, y: number) => number) | null} [sub] @param {string} [stamp] @param {number} [blur] a box blur's radius in pixels
 * @returns {Mask}
 */
function mask(art, key, M, r, tile, sub, stamp, blur = 0) {
  const w = art.map.w;
  const W = r.w * M;
  const H = r.h * M;
  let m = art.masks.get(key);
  if (m && stamp !== undefined && m.stamp === `${stamp}|${r.x},${r.y},${r.w},${r.h}`) return { cv: m.cv, ...r };
  if (!m || m.cv.width !== W || m.cv.height !== H) {
    const cv = m?.cv ?? canvas(W, H);
    cv.width = W;
    cv.height = H;
    m = { cv, img: ctx2d(cv).createImageData(W, H), stamp: "" };
    art.masks.set(key, m);
  }
  m.stamp = stamp === undefined ? "" : `${stamp}|${r.x},${r.y},${r.w},${r.h}`;
  const d = new Uint32Array(m.img.data.buffer);
  const little = LITTLE;
  const pack = (/** @type {number} */ v) => (little ? (((v & 255) << 24) | (((v >>> 8) & 255) << 16) | (((v >>> 16) & 255) << 8) | (v >>> 24)) >>> 0 : v >>> 0);
  for (let ty = r.y; ty < r.y + r.h; ty++) {
    for (let tx = r.x; tx < r.x + r.w; tx++) {
      const i = ty * w + tx;
      const v = tile(i);
      const base = (ty - r.y) * M * W + (tx - r.x) * M;
      if (v !== -1 || !sub) {
        const p = pack(v === -1 ? 0 : v);
        for (let yy = 0; yy < M; yy++) d.fill(p, base + yy * W, base + yy * W + M);
      } else {
        for (let yy = 0; yy < M; yy++) for (let xx = 0; xx < M; xx++) d[base + yy * W + xx] = pack(sub(i, tx + (xx + 0.5) / M, ty + (yy + 0.5) / M));
      }
    }
  }
  if (blur > 0) boxBlur(m.img.data, W, H, blur);
  ctx2d(m.cv).putImageData(m.img, 0, 0);
  return { cv: m.cv, ...r };
}

/** @type {Float32Array} */
let blurLine = new Float32Array(0);
/**
 * A box blur of every channel, horizontal then vertical, edges clamped.
 * @param {Uint8ClampedArray} d @param {number} W @param {number} H @param {number} r
 */
function boxBlur(d, W, H, r) {
  const n = Math.max(W, H);
  if (blurLine.length < n * 4) blurLine = new Float32Array(n * 4);
  const line = blurLine;
  const k = 1 / (2 * r + 1);
  for (const [len, count, step, stride] of [[W, H, 4, W * 4], [H, W, W * 4, 4]]) {
    for (let a = 0; a < /** @type {number} */ (count); a++) {
      const base = a * /** @type {number} */ (stride);
      for (let ch = 0; ch < 4; ch++) {
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += d[base + clamp(i, 0, len - 1) * step + ch] ?? 0;
        for (let i = 0; i < len; i++) {
          line[i * 4 + ch] = sum * k;
          sum += (d[base + Math.min(i + r + 1, len - 1) * step + ch] ?? 0) - (d[base + Math.max(i - r, 0) * step + ch] ?? 0);
        }
      }
      for (let i = 0; i < len * 4; i++) d[base + (i >> 2) * step + (i & 3)] = line[i] ?? 0;
    }
  }
}
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Draws a mask at its tiles in the view (smoothed: soft edges). @param {CanvasRenderingContext2D} c @param {Mask} m @param {View} v */
function blitMask(c, m, v) {
  const k = v.scale * v.dpr;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = "high";
  // Pixel centres are tile centres: the mask fades across the tile edges.
  c.drawImage(m.cv, (m.x - v.left) * k, (m.y - v.top) * k, m.w * k, m.h * k);
}

// ---------------------------------------------------------------- the blueprint paper

/** @param {CanvasRenderingContext2D} c @param {Art} art @param {Rect} r */
function drawPaper(c, art, r) {
  const map = art.map;
  const m = { bp: true, shadow: false, lod: S >= 14 ? 1 : 0 };
  c.fillStyle = P.paper;
  c.fillRect(r.x, r.y, Math.min(r.w, map.w - r.x), Math.min(r.h, map.h - r.y));
  c.save();
  c.beginPath();
  c.rect(0, 0, map.w, map.h);
  c.clip();
  // Mottled paper.
  for (let k = 0; k < 6; k++) {
    const x = r.x + hash(r.x, r.y, k) * r.w;
    const y = r.y + hash(r.y, r.x, k + 9) * r.h;
    const g = c.createRadialGradient(x, y, 0, x, y, 3 + hash(k, r.x) * 5);
    g.addColorStop(0, "rgba(255,255,255,0.035)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(r.x, r.y, r.w, r.h);
  }
  // The grid: a faint line a tile, a stronger one every five.
  c.beginPath();
  for (let x = r.x; x <= r.x + r.w; x++) {
    if (x % 5 === 0) continue;
    c.moveTo(x, r.y);
    c.lineTo(x, r.y + r.h);
  }
  for (let y = r.y; y <= r.y + r.h; y++) {
    if (y % 5 === 0) continue;
    c.moveTo(r.x, y);
    c.lineTo(r.x + r.w, y);
  }
  c.strokeStyle = "rgba(200,225,255,0.07)";
  c.lineWidth = px(1);
  c.stroke();
  c.beginPath();
  for (let x = Math.ceil(r.x / 5) * 5; x <= r.x + r.w; x += 5) {
    c.moveTo(x, r.y);
    c.lineTo(x, r.y + r.h);
  }
  for (let y = Math.ceil(r.y / 5) * 5; y <= r.y + r.h; y += 5) {
    c.moveTo(r.x, y);
    c.lineTo(r.x + r.w, y);
  }
  c.strokeStyle = "rgba(200,225,255,0.13)";
  c.stroke();
  c.restore();

  const x0 = Math.max(0, r.x - 2);
  const y0 = Math.max(0, r.y - 2);
  const x1 = Math.min(map.w, r.x + r.w + 2);
  const y1 = Math.min(map.h, r.y + r.h + 2);
  const tile = (/** @type {number} */ x, /** @type {number} */ y) => (x < 0 || y < 0 || x >= map.w || y >= map.h ? T.EDGE : (map.tiles[y * map.w + x] ?? T.EDGE));
  // The street: asphalt a shade darker, the kerb a line.
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * map.w + x;
      const f = map.floors[i];
      const t = map.tiles[i];
      if (t === T.EDGE) {
        c.fillStyle = P.paperDark;
        c.fillRect(x, y, 1, 1);
      } else if (f === F.ASPHALT || f === F.PAVEMENT || f === F.COBBLE) {
        c.fillStyle = f === F.ASPHALT ? "rgba(5,20,45,0.28)" : "rgba(5,20,45,0.12)";
        c.fillRect(x, y, 1, 1);
      }
    }
  }
  // Walls: hatched poché and white outlines.
  c.save();
  c.beginPath();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = tile(x, y);
      if (t === T.WALL || t === T.WINDOW || t === T.SHED) c.rect(x, y, 1, 1);
    }
  }
  c.fillStyle = "rgba(220,235,255,0.16)";
  c.fill();
  c.clip();
  c.beginPath();
  for (let d = r.x + r.y - 4; d < r.x + r.y + r.w + r.h + 4; d += 0.33) {
    c.moveTo(d - r.y + 4, r.y - 4);
    c.lineTo(d - r.y - r.h - 4, r.y + r.h + 4);
  }
  c.strokeStyle = "rgba(230,240,255,0.32)";
  c.lineWidth = px(1);
  c.stroke();
  c.restore();
  outlineTiles(c, map, x0, y0, x1, y1, (t) => t === T.WALL || t === T.WINDOW || t === T.SHED, BP_LINE, Math.max(0.06, px(1.5)));
  // The lot wall: a double line.
  outlineTiles(c, map, x0, y0, x1, y1, (t) => t === T.LOT_WALL, BP_LINE, Math.max(0.05, px(1.2)));
  c.beginPath();
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (tile(x, y) === T.LOT_WALL) c.rect(x + 0.2, y + 0.2, 0.6, 0.6);
  c.fillStyle = "rgba(230,240,255,0.18)";
  c.fill();
  // Windows: three thin lines along the wall.
  for (const w of map.windows) {
    if (!w || w.x < x0 || w.y < y0 || w.x >= x1 || w.y >= y1) continue;
    c.fillStyle = P.paper;
    c.fillRect(w.x, w.y, 1, 1);
    c.beginPath();
    for (const o of [0.25, 0.5, 0.75]) {
      if (w.wall === "h") {
        c.moveTo(w.x, w.y + o);
        c.lineTo(w.x + 1, w.y + o);
      } else {
        c.moveTo(w.x + o, w.y);
        c.lineTo(w.x + o, w.y + 1);
      }
    }
    c.strokeStyle = BP_LINE;
    c.lineWidth = Math.max(0.03, px(1));
    c.stroke();
  }
  // Doors: the gap, the leaf and its swing (not whether it is open).
  for (const d of map.doors) {
    if (!d || d.x < x0 || d.y < y0 || d.x >= x1 || d.y >= y1) continue;
    c.fillStyle = P.paper;
    c.fillRect(d.x, d.y, 1, 1);
    const hinge = doorHinge(d);
    c.beginPath();
    c.moveTo(hinge.hx, hinge.hy);
    c.lineTo(hinge.ox, hinge.oy);
    c.strokeStyle = BP_LINE;
    c.lineWidth = Math.max(0.05, px(1.3));
    c.stroke();
    c.beginPath();
    c.arc(hinge.hx, hinge.hy, 1, hinge.a0, hinge.a1, hinge.ccw);
    c.setLineDash([0.12, 0.1]);
    c.lineWidth = Math.max(0.025, px(0.8));
    c.stroke();
    c.setLineDash([]);
    if (d.locked) padlock(c, d.x + 0.5, d.y + 0.5, 0.42, true);
  }
  // Furniture and cover in outline.
  const seenProps = new Set();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const id = art.propAt[y * map.w + x] ?? -1;
      if (id < 0 || seenProps.has(id)) continue;
      seenProps.add(id);
      const p = map.props[id];
      if (p) drawProp(c, p, m, id === map.workbench?.prop);
    }
  }
  // Cover tiles without a prop.
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * map.w + x;
      if ((art.propAt[i] ?? -1) >= 0) continue;
      coverTile(c, map.tiles[i] ?? 0, x, y, m);
    }
  }
  // Parking spots.
  for (const s of map.spots) {
    const q = s?.rect;
    if (!q || q.x > x1 || q.y > y1 || q.x + q.w < x0 || q.y + q.h < y0) continue;
    rr(c, q.x + 0.12, q.y + 0.12, q.w - 0.24, q.h - 0.24, 0.15);
    c.setLineDash([0.3, 0.18]);
    c.strokeStyle = BP_LINE;
    c.lineWidth = Math.max(0.05, px(1.4));
    c.stroke();
    c.setLineDash([]);
    label(c, "P", q.x + q.w / 2, q.y + q.h / 2, Math.min(q.w, q.h) * 0.8, { font: FONTS.sans, weight: 700, colour: P.line });
  }
  // Lamps: a lamp symbol and its reach.
  for (const l of map.lamps) {
    if (!l || l.x < x0 - 5 || l.y < y0 - 5 || l.x > x1 + 5 || l.y > y1 + 5) continue;
    const cx = l.x + 0.5;
    const cy = l.y + 0.5;
    el(c, cx, cy, LAMP_RADIUS);
    c.setLineDash([0.08, 0.22]);
    c.strokeStyle = "rgba(255,214,140,0.45)";
    c.lineWidth = Math.max(0.04, px(1));
    c.stroke();
    c.setLineDash([]);
    lampSymbol(c, cx, cy, true);
  }
  // Cameras: the body on its wall and the cone, dashed.
  for (const cam of map.cameras) {
    if (!cam || cam.x < x0 - 9 || cam.y < y0 - 9 || cam.x > x1 + 9 || cam.y > y1 + 9) continue;
    cameraCone(c, cam, "rgba(236,244,255,0.07)", BP_FAINT, true);
    cameraBody(c, cam, true);
  }
  // Light switches.
  for (const room of map.rooms) {
    for (const s of room?.switches ?? []) {
      const x = s % map.w;
      const y = Math.floor(s / map.w);
      if (x < x0 || y < y0 || x >= x1 || y >= y1) continue;
      const at = switchSpot(map, x, y);
      el(c, at.x, at.y, 0.11);
      c.fillStyle = P.paper;
      c.fill();
      c.strokeStyle = BP_LINE;
      c.lineWidth = Math.max(0.03, px(1));
      c.stroke();
      c.beginPath();
      c.moveTo(at.x, at.y);
      c.lineTo(at.x + 0.16, at.y - 0.16);
      c.stroke();
    }
  }
  // Names: rooms in capitals, areas fainter.
  map.areas.forEach((a, k) => {
    const q = a?.rect;
    const name = art.areaNames[k];
    if (!q || !name || q.w * q.h < 30 || a.kind === "street") return;
    if (q.x > x1 || q.y > y1 || q.x + q.w < x0 || q.y + q.h < y0) return;
    fitLabel(c, name, q, { colour: "rgba(236,244,255,0.38)", max: 0.75, weight: 400 });
  });
  // Room names: per frame (drawNames), so seen rooms can hide theirs.
}

/**
 * The rooms' names in capitals over the blueprint, each faded by how
 * much of its room one sees now (gone once a third is seen).
 * @param {CanvasRenderingContext2D} c @param {Art} art @param {View} v @param {ArrayLike<number> | null} seen
 */
function drawNames(c, art, v, seen) {
  const map = art.map;
  useTiles(c, v);
  const x0 = v.left;
  const y0 = v.top;
  const x1 = v.left + v.width / v.scale;
  const y1 = v.top + v.height / v.scale;
  map.rooms.forEach((room, k) => {
    const q = room?.rect;
    const name = art.names[k];
    if (!q || !name || q.x > x1 || q.y > y1 || q.x + q.w < x0 || q.y + q.h < y0) return;
    let alpha = 1;
    if (seen) {
      let n = 0;
      for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) if (seen[y * map.w + x]) n++;
      alpha = clamp(1 - (3 * n) / Math.max(1, q.w * q.h), 0, 1);
    }
    if (alpha <= 0.02) return;
    c.save();
    c.globalAlpha = alpha;
    fitLabel(c, name, q, { colour: P.line, max: room.kind === "corridor" ? 0.55 : 0.8, weight: 600, halo: true });
    c.restore();
  });
}

/**
 * Strokes the outline of a set of tiles (edges to tiles outside it).
 * @param {CanvasRenderingContext2D} c @param {Blueprint} map @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @param {(t: number) => boolean} isIn @param {string} colour @param {number} w
 */
function outlineTiles(c, map, x0, y0, x1, y1, isIn, colour, w) {
  const at = (/** @type {number} */ x, /** @type {number} */ y) => x >= 0 && y >= 0 && x < map.w && y < map.h && isIn(map.tiles[y * map.w + x] ?? 0);
  c.beginPath();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1) && y > 0) {
        c.moveTo(x, y);
        c.lineTo(x + 1, y);
      }
      if (!at(x, y + 1) && y < map.h - 1) {
        c.moveTo(x, y + 1);
        c.lineTo(x + 1, y + 1);
      }
      if (!at(x - 1, y) && x > 0) {
        c.moveTo(x, y);
        c.lineTo(x, y + 1);
      }
      if (!at(x + 1, y) && x < map.w - 1) {
        c.moveTo(x + 1, y);
        c.lineTo(x + 1, y + 1);
      }
    }
  }
  c.strokeStyle = colour;
  c.lineWidth = w;
  c.lineCap = "square";
  c.stroke();
  c.lineCap = "round";
}

/**
 * A door's hinge and its leaf: closed along the wall, open swung 90°
 * into the room side (the side away from the outside).
 * @param {Door} d
 */
function doorHinge(d) {
  const into = d.rooms?.[1] === -1 ? -1 : 1; // swing south/east, or north/west for doors whose far side is outside
  if (d.wall === "h") {
    const hx = d.x + 0.06;
    const hy = d.y + 0.5;
    return { hx, hy, ox: hx, oy: hy + into * 0.94, cx: d.x + 0.94, cy: hy, a0: 0, a1: (into * Math.PI) / 2, ccw: into < 0 };
  }
  const hx = d.x + 0.5;
  const hy = d.y + 0.06;
  return { hx, hy, ox: hx + into * 0.94, oy: hy, cx: hx, cy: d.y + 0.94, a0: Math.PI / 2, a1: into > 0 ? 0 : Math.PI, ccw: into > 0 };
}

/** Where a switch's plate sits: its tile pushed to a wall. @param {Blueprint} map @param {number} x @param {number} y */
function switchSpot(map, x, y) {
  for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
    const t = map.tiles[(y + dy) * map.w + x + dx];
    if (t === T.WALL) return { x: x + 0.5 + dx * 0.32, y: y + 0.5 + dy * 0.32 };
  }
  return { x: x + 0.5, y: y + 0.5 };
}

/**
 * Text in device px at a tile point (the transform's scale sets the size).
 * @param {CanvasRenderingContext2D} c @param {string} s @param {number} x @param {number} y @param {number} size tiles
 * @param {{ font?: string, weight?: number, colour?: string, halo?: string | null, align?: CanvasTextAlign, base?: CanvasTextBaseline, spacing?: number, minPx?: number, alpha?: number }} [o]
 */
function label(c, s, x, y, size, o = {}) {
  if (!s || !fin(x) || !fin(y)) return;
  const t = c.getTransform();
  const k = t.a;
  const sp = { x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f };
  let fs = size * k;
  if (o.minPx) fs = Math.max(fs, o.minPx);
  if (fs < 5) return;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha *= o.alpha ?? 1;
  c.font = `${o.weight ?? 400} ${fs.toFixed(1)}px ${o.font ?? FONTS.sans}`;
  c.textAlign = o.align ?? "center";
  c.textBaseline = o.base ?? "middle";
  if (o.spacing && "letterSpacing" in c) /** @type {any} */ (c).letterSpacing = `${(o.spacing * fs).toFixed(1)}px`;
  if (o.halo) {
    c.strokeStyle = o.halo;
    c.lineWidth = Math.max(2, fs * 0.22);
    c.lineJoin = "round";
    c.strokeText(s, sp.x, sp.y);
  }
  c.fillStyle = o.colour ?? P.line;
  c.fillText(s, sp.x, sp.y);
  c.restore();
}

/**
 * A name fitted into a rectangle (one or two lines, never bigger than `max` tiles).
 * @param {CanvasRenderingContext2D} c @param {string} s @param {Rect} q @param {{ colour: string, max: number, weight: number, halo?: boolean }} o
 */
function fitLabel(c, s, q, o) {
  const k = c.getTransform().a;
  const lay = nameLayout(c, s, q, o);
  if (!lay || lay.size * k < 6.5) return;
  const cy = q.y + q.h / 2;
  lay.lines.forEach((t, i) => {
    label(c, t, q.x + q.w / 2, cy + (i - (lay.lines.length - 1) / 2) * lay.size * 1.15, lay.size, {
      colour: o.colour,
      weight: o.weight,
      spacing: NAME_SPACING,
      halo: o.halo ? "rgba(23,64,111,0.85)" : null,
    });
  });
}

const NAME_SPACING = 0.12;

/**
 * How a name fits a rectangle: one or two lines, the size (tiles) and
 * the widest line's width (tiles).
 * @param {CanvasRenderingContext2D} c @param {string} s @param {Rect} q @param {{ max: number, weight: number }} o
 * @returns {{ lines: string[], size: number, width: number } | null}
 */
function nameLayout(c, s, q, o) {
  if (!s) return null;
  const sp = NAME_SPACING;
  const wide = (/** @type {string} */ t) => {
    c.save();
    c.font = `${o.weight} 100px ${FONTS.sans}`;
    const w = c.measureText(t).width / 100 + sp * t.length;
    c.restore();
    return w;
  };
  const room = q.w - 0.6;
  let lines = [s];
  let width = wide(s);
  let size = Math.min(o.max, room / width, (q.h - 0.4) * 0.7);
  const parts = s.split(" ");
  if (parts.length > 1 && size < o.max * 0.75) {
    const a = parts.slice(0, Math.ceil(parts.length / 2)).join(" ");
    const b = parts.slice(Math.ceil(parts.length / 2)).join(" ");
    const w2 = Math.max(wide(a), wide(b));
    const two = Math.min(o.max, room / w2, (q.h - 0.4) * 0.36);
    if (two > size * 1.15) {
      size = two;
      lines = [a, b];
      width = w2;
    }
  }
  return size > 0 ? { lines, size, width: width * size } : null;
}

/**
 * The boxes (tiles) of the room names the blueprint letters, cached per art.
 * @param {Art} art @param {CanvasRenderingContext2D} c @returns {{ x: number, y: number, w: number, h: number, size: number }[]}
 */
function nameBoxes(art, c) {
  if (art.nameBoxes) return art.nameBoxes;
  /** @type {{ x: number, y: number, w: number, h: number, size: number }[]} */
  const out = [];
  art.map.rooms.forEach((room, k) => {
    const q = room?.rect;
    const lay = q && nameLayout(c, art.names[k] ?? "", q, { max: room.kind === "corridor" ? 0.55 : 0.8, weight: 600 });
    if (!q || !lay) return;
    const h = lay.lines.length * lay.size * 1.15;
    out.push({ x: q.x + q.w / 2 - lay.width / 2, y: q.y + q.h / 2 - h / 2, w: lay.width, h, size: lay.size });
  });
  art.nameBoxes = out;
  return out;
}

/** A padlock. @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} s @param {boolean} bp */
function padlock(c, x, y, s, bp) {
  c.beginPath();
  c.arc(x, y - s * 0.1, s * 0.22, Math.PI, 0);
  c.strokeStyle = bp ? BP_LINE : P.ink;
  c.lineWidth = Math.max(s * 0.1, px(1));
  c.stroke();
  rr(c, x - s * 0.32, y - s * 0.1, s * 0.64, s * 0.5, s * 0.08);
  c.fillStyle = bp ? P.paper : P.gold;
  c.fill();
  c.lineWidth = Math.max(s * 0.07, px(1));
  c.stroke();
  el(c, x, y + s * 0.12, s * 0.06);
  c.fillStyle = bp ? BP_LINE : P.ink;
  c.fill();
}

/** @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {boolean} bp @param {boolean} [on] */
function lampSymbol(c, x, y, bp, on = true) {
  if (bp) {
    el(c, x, y, 0.28);
    c.fillStyle = P.paper;
    c.fill();
    c.strokeStyle = BP_LINE;
    c.lineWidth = Math.max(0.04, px(1.1));
    c.stroke();
    c.beginPath();
    c.moveTo(x - 0.2, y - 0.2);
    c.lineTo(x + 0.2, y + 0.2);
    c.moveTo(x + 0.2, y - 0.2);
    c.lineTo(x - 0.2, y + 0.2);
    c.stroke();
    return;
  }
  el(c, x + 0.05, y + 0.07, 0.3);
  c.fillStyle = SHADOW;
  c.fill();
  el(c, x, y, 0.3);
  c.fillStyle = "#2b2a2e";
  c.fill();
  c.strokeStyle = P.ink;
  c.lineWidth = OUT();
  c.stroke();
  el(c, x, y, 0.19);
  c.fillStyle = on ? "#fff1b8" : "#59606b";
  c.fill();
  c.lineWidth = Math.max(0.03, px(1));
  c.stroke();
  if (!on) {
    c.beginPath();
    c.moveTo(x - 0.12, y - 0.05);
    c.lineTo(x, y + 0.02);
    c.lineTo(x + 0.08, y - 0.1);
    c.moveTo(x, y + 0.02);
    c.lineTo(x + 0.03, y + 0.14);
    c.strokeStyle = "#1a1a1a";
    c.stroke();
  }
}

/**
 * A camera's cone.
 * @param {CanvasRenderingContext2D} c @param {import("../game/map.ts").Camera} cam @param {string | CanvasGradient | CanvasPattern} fill @param {string} line @param {boolean} dashed
 */
function cameraCone(c, cam, fill, line, dashed) {
  if (!fin(cam.angle) || !fin(cam.range)) return;
  const x = cam.x + 0.5;
  const y = cam.y + 0.5;
  const a = cam.angle * RAD;
  const half = ((fin(cam.fov) ? cam.fov : 50) / 2) * RAD;
  const r = clamp(cam.range, 0, 30);
  c.beginPath();
  c.moveTo(x, y);
  c.arc(x, y, r, a - half, a + half);
  c.closePath();
  c.fillStyle = fill;
  c.fill();
  if (dashed) c.setLineDash([0.25, 0.18]);
  c.strokeStyle = line;
  c.lineWidth = Math.max(0.03, px(1));
  c.stroke();
  c.setLineDash([]);
}

/** @param {CanvasRenderingContext2D} c @param {import("../game/map.ts").Camera} cam @param {boolean} bp @param {string} [led] */
function cameraBody(c, cam, bp, led) {
  if (!fin(cam.angle)) return;
  c.save();
  c.translate(cam.x + 0.5, cam.y + 0.5);
  c.rotate(cam.angle * RAD);
  rr(c, -0.32, -0.2, 0.52, 0.4, 0.07);
  c.fillStyle = bp ? P.paper : "#cfd3d6";
  c.fill();
  c.strokeStyle = bp ? BP_LINE : P.ink;
  c.lineWidth = bp ? Math.max(0.035, px(1)) : OUT();
  c.stroke();
  c.beginPath();
  c.moveTo(0.2, -0.13);
  c.lineTo(0.38, -0.2);
  c.lineTo(0.38, 0.2);
  c.lineTo(0.2, 0.13);
  c.closePath();
  c.fillStyle = bp ? P.paper : "#3a3f45";
  c.fill();
  c.stroke();
  if (!bp) {
    el(c, -0.12, 0, 0.07);
    c.fillStyle = led ?? "#e0322a";
    c.fill();
  }
  c.restore();
}

// ---------------------------------------------------------------- the colour layer

/** @param {CanvasRenderingContext2D} c @param {Art} art @param {Rect} r */
function drawColour(c, art, r) {
  const map = art.map;
  const m = { bp: false, shadow: false, lod: S >= 14 ? 1 : 0 };
  const x0 = Math.max(0, r.x - 1);
  const y0 = Math.max(0, r.y - 1);
  const x1 = Math.min(map.w, r.x + r.w + 1);
  const y1 = Math.min(map.h, r.y + r.h + 1);
  c.fillStyle = "#1b1a1f";
  c.fillRect(r.x, r.y, Math.min(r.w, map.w - r.x), Math.min(r.h, map.h - r.y));
  const tile = (/** @type {number} */ x, /** @type {number} */ y) => (x < 0 || y < 0 || x >= map.w || y >= map.h ? T.EDGE : (map.tiles[y * map.w + x] ?? T.EDGE));
  const floorAt = (/** @type {number} */ x, /** @type {number} */ y) => (x < 0 || y < 0 || x >= map.w || y >= map.h ? 0 : (map.floors[y * map.w + x] ?? 0));
  // Floors (under doors and cover too).
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = tile(x, y);
      let f = floorAt(x, y);
      if (t === T.DOOR && !f) f = floorAt(x - 1, y) || floorAt(x + 1, y) || floorAt(x, y - 1) || floorAt(x, y + 1) || F.PARQUET;
      if (f) floor(c, f, x, y);
    }
  }
  // Rugs, carpets' borders, medallions.
  for (const room of map.rooms) {
    const q = room?.rect;
    if (!q || q.x > x1 || q.y > y1 || q.x + q.w < x0 || q.y + q.h < y0) continue;
    roomDecor(c, map, room, m);
  }
  // Kerbs, the street's centre line, parking bays.
  streetPaint(c, map, x0, y0, x1, y1);
  // Walls.
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = tile(x, y);
      if (t === T.WALL || t === T.WINDOW) {
        c.fillStyle = "#e7d8b6";
        c.fillRect(x, y, 1, 1);
      } else if (t === T.LOT_WALL) brick(c, x, y);
      else if (t === T.EDGE) roof(c, map, x, y);
      else if (t === T.SHED) {
        c.fillStyle = "#7a4c28";
        c.fillRect(x, y, 1, 1);
        c.beginPath();
        for (const o of [0.33, 0.66]) {
          c.moveTo(x, y + o);
          c.lineTo(x + 1, y + o);
        }
        c.strokeStyle = "rgba(0,0,0,0.3)";
        c.lineWidth = px(1);
        c.stroke();
      }
    }
  }
  // A gold picture rail along the inner face of the walls of grand rooms.
  for (const room of map.rooms) {
    const q = room?.rect;
    if (!q || !["ballroom", "foyer", "gallery", "dining", "library"].includes(room.kind)) continue;
    if (q.x > x1 || q.y > y1 || q.x + q.w < x0 || q.y + q.h < y0) continue;
    c.strokeStyle = rgba(P.gold, 0.85);
    c.lineWidth = Math.max(0.05, px(1));
    c.strokeRect(q.x - 0.16, q.y - 0.16, q.w + 0.32, q.h + 0.32);
  }
  // Windows: glass in the wall, the curtain drawn on the room side.
  for (const w of map.windows) {
    if (!w || w.x < x0 || w.y < y0 || w.x >= x1 || w.y >= y1) continue;
    windowPane(c, map, w);
  }
  outlineTiles(c, map, x0, y0, x1, y1, (t) => t === T.WALL || t === T.WINDOW || t === T.LOT_WALL || t === T.SHED, P.ink, Math.max(0.1, px(2)));
  // Door frames (the leaf is dynamic).
  for (const d of map.doors) {
    if (!d || d.x < x0 || d.y < y0 || d.x >= x1 || d.y >= y1) continue;
    c.fillStyle = "rgba(60,40,20,0.35)";
    if (d.wall === "h") c.fillRect(d.x, d.y + 0.38, 1, 0.24);
    else c.fillRect(d.x + 0.38, d.y, 0.24, 1);
  }
  // Props: shadows first, then the props.
  const ids = new Set();
  for (let y = y0 - 2; y < y1 + 2; y++) {
    for (let x = x0 - 2; x < x1 + 2; x++) {
      if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
      const id = art.propAt[y * map.w + x] ?? -1;
      if (id >= 0) ids.add(id);
    }
  }
  const props = [...ids].map((id) => map.props[id]).filter((p) => !!p).sort((a, b) => propLayer(a) - propLayer(b) || a.rect.y - b.rect.y);
  const shadowMode = { bp: false, shadow: true, lod: 0 };
  for (const p of props) {
    c.save();
    c.translate(0.09, 0.12);
    drawProp(c, p, shadowMode, false);
    c.restore();
  }
  for (const p of props) drawProp(c, p, m, p.id === map.workbench?.prop);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * map.w + x;
      if ((art.propAt[i] ?? -1) >= 0) continue;
      coverTile(c, map.tiles[i] ?? 0, x, y, m);
    }
  }
  // Lamp posts, cameras, switches.
  for (const cam of map.cameras) if (cam && cam.x >= x0 - 1 && cam.y >= y0 - 1 && cam.x < x1 + 1 && cam.y < y1 + 1) cameraBody(c, cam, false, "#6b1b16");
  for (const room of map.rooms) {
    for (const s of room?.switches ?? []) {
      const x = s % map.w;
      const y = Math.floor(s / map.w);
      if (x < x0 || y < y0 || x >= x1 || y >= y1) continue;
      const at = switchSpot(map, x, y);
      rr(c, at.x - 0.09, at.y - 0.12, 0.18, 0.24, 0.04);
      c.fillStyle = P.gold;
      c.fill();
      c.strokeStyle = P.ink;
      c.lineWidth = Math.max(0.025, px(1));
      c.stroke();
    }
  }
}

/** Big things last (cover over the floor's little things). @param {Prop} p */
function propLayer(p) {
  return p.kind === "tree" ? 3 : p.block === 2 ? 2 : 1;
}

/** @param {CanvasRenderingContext2D} c @param {number} f @param {number} x @param {number} y */
function floor(c, f, x, y) {
  const h = hash(x, y, f);
  switch (f) {
    case F.GRASS: {
      c.fillStyle = Math.floor((x + y * 0.0) / 2) % 2 ? "#3f7b3c" : "#447f40";
      c.fillRect(x, y, 1, 1);
      if (S < 12) return;
      c.beginPath();
      for (let k = 0; k < 3; k++) {
        const gx = x + 0.15 + hash(x, y, k) * 0.7;
        const gy = y + 0.2 + hash(y, x, k + 3) * 0.6;
        c.moveTo(gx - 0.06, gy - 0.07);
        c.lineTo(gx, gy + 0.03);
        c.lineTo(gx + 0.06, gy - 0.08);
      }
      c.strokeStyle = "#2f6330";
      c.lineWidth = Math.max(0.025, px(1));
      c.stroke();
      return;
    }
    case F.GRAVEL: {
      c.fillStyle = "#c8b48c";
      c.fillRect(x, y, 1, 1);
      if (S < 12) return;
      for (let k = 0; k < 7; k++) {
        el(c, x + hash(x, y, k) * 0.9 + 0.05, y + hash(y, x, k) * 0.9 + 0.05, 0.035 + hash(k, x, y) * 0.03);
        c.fillStyle = k % 2 ? "#a8936a" : "#e2d3b0";
        c.fill();
      }
      return;
    }
    case F.PAVEMENT: {
      c.fillStyle = h < 0.5 ? "#a6a39a" : "#a09d94";
      c.fillRect(x, y, 1, 1);
      c.strokeStyle = "#7f7c74";
      c.lineWidth = Math.max(0.025, px(1));
      c.strokeRect(x + 0.02, y + 0.02, 0.96, 0.96);
      return;
    }
    case F.ASPHALT: {
      c.fillStyle = "#3d4047";
      c.fillRect(x, y, 1, 1);
      if (S < 12) return;
      for (let k = 0; k < 4; k++) {
        c.fillStyle = k % 2 ? "#4a4d55" : "#34363c";
        c.fillRect(x + hash(x, y, k) * 0.9, y + hash(y, x, k) * 0.9, 0.06, 0.06);
      }
      return;
    }
    case F.COBBLE: {
      c.fillStyle = "#6f655a";
      c.fillRect(x, y, 1, 1);
      for (let k = 0; k < 4; k++) {
        const sx = x + (k % 2) * 0.5;
        const sy = y + Math.floor(k / 2) * 0.5;
        rr(c, sx + 0.04, sy + 0.04, 0.42, 0.42, 0.14);
        c.fillStyle = hash(x, y, k) < 0.5 ? "#91857a" : "#9c8f83";
        c.fill();
      }
      return;
    }
    case F.PARQUET: {
      // Basket weave: four squares of three planks, alternating.
      for (let k = 0; k < 4; k++) {
        const sx = x + (k % 2) * 0.5;
        const sy = y + Math.floor(k / 2) * 0.5;
        const across = (k + (x + y) * 1) % 2 === 0;
        for (let p = 0; p < 3; p++) {
          const v = hash(x * 4 + k, y * 3 + p, 7);
          c.fillStyle = v < 0.33 ? "#b37f47" : v < 0.66 ? "#a8743f" : "#bd8a50";
          if (across) c.fillRect(sx, sy + p / 6, 0.5, 1 / 6);
          else c.fillRect(sx + p / 6, sy, 1 / 6, 0.5);
        }
      }
      if (S >= 16) {
        c.beginPath();
        for (let k = 0; k < 4; k++) {
          const sx = x + (k % 2) * 0.5;
          const sy = y + Math.floor(k / 2) * 0.5;
          const across = (k + (x + y)) % 2 === 0;
          for (let p = 1; p < 3; p++) {
            if (across) {
              c.moveTo(sx, sy + p / 6);
              c.lineTo(sx + 0.5, sy + p / 6);
            } else {
              c.moveTo(sx + p / 6, sy);
              c.lineTo(sx + p / 6, sy + 0.5);
            }
          }
          c.rect(sx, sy, 0.5, 0.5);
        }
        c.strokeStyle = "rgba(90,52,22,0.45)";
        c.lineWidth = px(1);
        c.stroke();
      }
      return;
    }
    case F.MARBLE: {
      const dark = (x + y) % 2 === 1;
      c.fillStyle = dark ? "#2e2a2c" : "#ece3cd";
      c.fillRect(x, y, 1, 1);
      if (S >= 16) {
        c.beginPath();
        c.moveTo(x + h * 0.6, y);
        c.quadraticCurveTo(x + 0.5, y + 0.5 + h * 0.3, x + 1, y + 0.3 + h * 0.6);
        c.strokeStyle = dark ? "rgba(255,255,255,0.08)" : "rgba(120,100,80,0.18)";
        c.lineWidth = px(1);
        c.stroke();
      }
      return;
    }
    case F.CARPET: {
      c.fillStyle = "#6c1f2b";
      c.fillRect(x, y, 1, 1);
      if (S >= 12) {
        c.beginPath();
        c.moveTo(x + 0.5, y + 0.2);
        c.lineTo(x + 0.8, y + 0.5);
        c.lineTo(x + 0.5, y + 0.8);
        c.lineTo(x + 0.2, y + 0.5);
        c.closePath();
        c.strokeStyle = "rgba(214,168,66,0.35)";
        c.lineWidth = Math.max(0.03, px(1));
        c.stroke();
      }
      return;
    }
    case F.TILES: {
      for (let k = 0; k < 4; k++) {
        c.fillStyle = (k + (k >> 1)) % 2 ? "#e8e4d8" : "#8fb5ae";
        c.fillRect(x + (k % 2) * 0.5, y + (k >> 1) * 0.5, 0.5, 0.5);
      }
      return;
    }
    case F.CONCRETE: {
      c.fillStyle = h < 0.5 ? "#a8a59c" : "#a39f96";
      c.fillRect(x, y, 1, 1);
      if (h > 0.85) {
        el(c, x + 0.5, y + 0.5, 0.3, 0.2);
        c.fillStyle = "rgba(60,50,40,0.12)";
        c.fill();
      }
      if (x % 4 === 0 || y % 4 === 0) {
        c.beginPath();
        if (x % 4 === 0) {
          c.moveTo(x, y);
          c.lineTo(x, y + 1);
        }
        if (y % 4 === 0) {
          c.moveTo(x, y);
          c.lineTo(x + 1, y);
        }
        c.strokeStyle = "rgba(70,65,60,0.4)";
        c.lineWidth = px(1);
        c.stroke();
      }
      return;
    }
    case F.BOARDS: {
      for (let p = 0; p < 4; p++) {
        c.fillStyle = hash(x, y, p) < 0.5 ? "#9b6a3b" : "#a77543";
        c.fillRect(x, y + p * 0.25, 1, 0.25);
      }
      c.beginPath();
      for (let p = 1; p < 4; p++) {
        c.moveTo(x, y + p * 0.25);
        c.lineTo(x + 1, y + p * 0.25);
      }
      c.strokeStyle = "rgba(70,40,15,0.45)";
      c.lineWidth = px(1);
      c.stroke();
      return;
    }
    case F.STEEL: {
      c.fillStyle = "#7b858c";
      c.fillRect(x, y, 1, 1);
      c.strokeStyle = "#5b646b";
      c.lineWidth = Math.max(0.03, px(1));
      c.strokeRect(x + 0.03, y + 0.03, 0.94, 0.94);
      if (S >= 16) {
        c.fillStyle = "#a9b2b8";
        for (const [a, b] of [[0.12, 0.12], [0.88, 0.12], [0.12, 0.88], [0.88, 0.88]]) {
          el(c, x + a, y + b, 0.035);
          c.fill();
        }
      }
      return;
    }
    default:
      c.fillStyle = "#555";
      c.fillRect(x, y, 1, 1);
  }
}

/** @param {CanvasRenderingContext2D} c @param {number} x @param {number} y */
function brick(c, x, y) {
  c.fillStyle = "#7d3328";
  c.fillRect(x, y, 1, 1);
  if (S < 12) return;
  c.beginPath();
  c.moveTo(x, y + 0.5);
  c.lineTo(x + 1, y + 0.5);
  const o = y % 2 ? 0.5 : 0;
  c.moveTo(x + o + 0.25, y);
  c.lineTo(x + o + 0.25, y + 0.5);
  c.moveTo(x + ((o + 0.75) % 1), y + 0.5);
  c.lineTo(x + ((o + 0.75) % 1), y + 1);
  c.strokeStyle = "rgba(240,200,170,0.28)";
  c.lineWidth = Math.max(0.03, px(1));
  c.stroke();
  c.fillStyle = "rgba(255,230,200,0.12)";
  c.fillRect(x + 0.1, y + 0.1, 0.8, 0.12);
}

/** The houses across the street: dark roofs. @param {CanvasRenderingContext2D} c @param {Blueprint} map @param {number} x @param {number} y */
function roof(c, map, x, y) {
  const block = Math.floor((map.front === "n" || map.front === "s" ? x : y) / 7);
  c.fillStyle = block % 2 ? "#2a2d38" : "#30323c";
  c.fillRect(x, y, 1, 1);
  if (S < 12) return;
  c.beginPath();
  for (const o of [0.33, 0.66]) {
    if (map.front === "n" || map.front === "s") {
      c.moveTo(x, y + o);
      c.lineTo(x + 1, y + o);
    } else {
      c.moveTo(x + o, y);
      c.lineTo(x + o, y + 1);
    }
  }
  c.strokeStyle = "rgba(0,0,0,0.3)";
  c.lineWidth = px(1);
  c.stroke();
  if (hash(x, y, 77) > 0.96) {
    c.fillStyle = "#e8c66a";
    c.fillRect(x + 0.3, y + 0.3, 0.4, 0.4);
  }
}

/** @param {CanvasRenderingContext2D} c @param {Blueprint} map @param {import("../game/map.ts").Room} room @param {Mode} m */
function roomDecor(c, map, room, m) {
  const q = room.rect;
  const f = map.floors[(q.y + Math.floor(q.h / 2)) * map.w + q.x + Math.floor(q.w / 2)];
  if (f === F.CARPET) {
    c.strokeStyle = P.gold;
    c.lineWidth = Math.max(0.06, px(1.2));
    c.strokeRect(q.x + 0.3, q.y + 0.3, q.w - 0.6, q.h - 0.6);
    c.lineWidth = Math.max(0.03, px(1));
    c.strokeRect(q.x + 0.45, q.y + 0.45, q.w - 0.9, q.h - 0.9);
  }
  if ((room.kind === "foyer" || room.kind === "ballroom") && q.w >= 4 && q.h >= 4) {
    const r = Math.min(q.w, q.h) / 2 - 0.6;
    sunburst(c, q.x + q.w / 2, q.y + q.h / 2, r, 16, room.kind === "foyer" ? P.gold : "#6c1f2b", room.kind === "foyer" ? "#2e2a2c" : P.gold, m);
  }
  if ((room.kind === "study" || room.kind === "library" || room.kind === "bedroom") && f !== F.CARPET && q.w >= 4 && q.h >= 4) {
    // A rug.
    const w = Math.min(q.w - 2, 5);
    const h = Math.min(q.h - 2, 3.5);
    rr(c, q.x + (q.w - w) / 2, q.y + (q.h - h) / 2, w, h, 0.1);
    c.fillStyle = room.kind === "bedroom" ? "#1f5a49" : "#7a2633";
    c.fill();
    c.strokeStyle = P.gold;
    c.lineWidth = Math.max(0.06, px(1.2));
    c.stroke();
    rr(c, q.x + (q.w - w) / 2 + 0.25, q.y + (q.h - h) / 2 + 0.25, w - 0.5, h - 0.5, 0.05);
    c.lineWidth = Math.max(0.03, px(1));
    c.stroke();
  }
}

/**
 * A Deco sunburst: alternating wedges in two colours, in tile units (or any units).
 * @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} r @param {number} rays
 * @param {string} a @param {string} b @param {Mode} [m]
 */
export function sunburst(c, x, y, r, rays, a, b, m) {
  if (!(r > 0) || !fin(x) || !fin(y)) return;
  const n = Math.max(4, Math.round(rays)) * 2;
  el(c, x, y, r);
  c.fillStyle = b;
  c.fill();
  c.beginPath();
  for (let k = 0; k < n; k += 2) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    c.moveTo(x, y);
    c.arc(x, y, r, a0, a1);
    c.closePath();
  }
  c.fillStyle = a;
  c.fill();
  el(c, x, y, r);
  c.strokeStyle = m?.bp ? BP_LINE : P.ink;
  c.lineWidth = Math.max(r * 0.04, px(1.2));
  c.stroke();
  el(c, x, y, r * 0.22);
  c.fillStyle = a;
  c.fill();
  c.stroke();
}

/** @param {CanvasRenderingContext2D} c @param {Blueprint} map @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
function streetPaint(c, map, x0, y0, x1, y1) {
  const fl = (/** @type {number} */ x, /** @type {number} */ y) => (x < 0 || y < 0 || x >= map.w || y >= map.h ? -1 : map.tiles[y * map.w + x] === T.FLOOR || map.tiles[y * map.w + x] === T.CAR ? (map.floors[y * map.w + x] ?? -1) : -1);
  // Kerbs: asphalt next to pavement.
  c.beginPath();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (fl(x, y) !== F.PAVEMENT) continue;
      if (fl(x, y - 1) === F.ASPHALT) c.rect(x, y, 1, 0.16);
      if (fl(x, y + 1) === F.ASPHALT) c.rect(x, y + 0.84, 1, 0.16);
      if (fl(x - 1, y) === F.ASPHALT) c.rect(x, y, 0.16, 1);
      if (fl(x + 1, y) === F.ASPHALT) c.rect(x + 0.84, y, 0.16, 1);
    }
  }
  c.fillStyle = "#cfccc2";
  c.fill();
  c.strokeStyle = "rgba(40,40,40,0.5)";
  c.lineWidth = px(1);
  c.stroke();
  // The street's centre line.
  for (const a of map.areas) {
    if (a?.kind !== "street") continue;
    const q = a.rect;
    const along = q.w >= q.h;
    // The asphalt band's middle.
    let lo = Infinity;
    let hi = -Infinity;
    const mid = along ? q.x + Math.floor(q.w / 2) : q.y + Math.floor(q.h / 2);
    for (let k = along ? q.y : q.x; k < (along ? q.y + q.h : q.x + q.w); k++) {
      if ((along ? fl(mid, k) : fl(k, mid)) === F.ASPHALT) {
        lo = Math.min(lo, k);
        hi = Math.max(hi, k + 1);
      }
    }
    if (!(hi - lo >= 3)) continue;
    const m = (lo + hi) / 2;
    c.beginPath();
    for (let t = along ? q.x : q.y; t < (along ? q.x + q.w : q.y + q.h); t += 2) {
      if (along) {
        c.moveTo(t + 0.3, m);
        c.lineTo(t + 1.3, m);
      } else {
        c.moveTo(m, t + 0.3);
        c.lineTo(m, t + 1.3);
      }
    }
    c.strokeStyle = "#e9d27a";
    c.lineWidth = Math.max(0.1, px(1.5));
    c.lineCap = "butt";
    c.stroke();
    c.lineCap = "round";
  }
  // Parking spots: painted bays and a P.
  for (const s of map.spots) {
    const q = s?.rect;
    if (!q || q.x > x1 || q.y > y1 || q.x + q.w < x0 || q.y + q.h < y0) continue;
    c.strokeStyle = "#f2efe4";
    c.lineWidth = Math.max(0.08, px(1.5));
    c.strokeRect(q.x + 0.1, q.y + 0.1, q.w - 0.2, q.h - 0.2);
    label(c, "P", q.x + q.w / 2, q.y + q.h / 2, Math.min(q.w, q.h) * 0.75, { font: FONTS.sans, weight: 700, colour: "rgba(242,239,228,0.55)" });
  }
}

/** @param {CanvasRenderingContext2D} c @param {Blueprint} map @param {import("../game/map.ts").Pane} w */
function windowPane(c, map, w) {
  const h = w.wall === "h";
  // The room side: towards the tile in the window's room.
  let into = 1;
  const [a] = [[w.x + (h ? 0 : -1), w.y + (h ? -1 : 0)]];
  if (a && map.roomAt?.[a[1] * map.w + a[0]] === w.room) into = -1;
  c.fillStyle = "#e7d8b6";
  c.fillRect(w.x, w.y, 1, 1);
  // Glass.
  if (h) c.fillRect(w.x, w.y, 1, 1);
  c.fillStyle = "#9fd0e0";
  if (h) c.fillRect(w.x + 0.04, w.y + 0.38, 0.92, 0.24);
  else c.fillRect(w.x + 0.38, w.y + 0.04, 0.24, 0.92);
  c.strokeStyle = P.ink;
  c.lineWidth = Math.max(0.04, px(1));
  if (h) c.strokeRect(w.x + 0.04, w.y + 0.38, 0.92, 0.24);
  else c.strokeRect(w.x + 0.38, w.y + 0.04, 0.24, 0.92);
  // The curtain, folds on the room side.
  c.beginPath();
  const n = 5;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const wob = k % 2 ? 0.1 : 0;
    if (h) {
      const yy = w.y + 0.5 + into * (0.18 + wob);
      if (k === 0) c.moveTo(w.x, w.y + 0.5 + into * 0.12);
      c.lineTo(w.x + t, yy);
    } else {
      const xx = w.x + 0.5 + into * (0.18 + wob);
      if (k === 0) c.moveTo(w.x + 0.5 + into * 0.12, w.y);
      c.lineTo(xx, w.y + t);
    }
  }
  if (h) {
    c.lineTo(w.x + 1, w.y + 0.5 + into * 0.12);
  } else {
    c.lineTo(w.x + 0.5 + into * 0.12, w.y + 1);
  }
  c.closePath();
  c.fillStyle = P.oxblood;
  c.fill();
  c.strokeStyle = P.ink;
  c.lineWidth = Math.max(0.04, px(1));
  c.stroke();
}

/** A cover or furniture tile without a prop. @param {CanvasRenderingContext2D} c @param {number} t @param {number} x @param {number} y @param {Mode} m */
function coverTile(c, t, x, y, m) {
  if (t === T.HEDGE) blob(c, m, [[x + 0.3, y + 0.5, 0.36], [x + 0.7, y + 0.5, 0.36]], "#2c5e2b", "#3a7536");
  else if (t === T.TREE) blob(c, m, [[x + 0.5, y + 0.5, 0.5]], "#2f6a35", "#3f8243");
  else if (t === T.FOUNTAIN) {
    el(c, x + 0.5, y + 0.5, 0.45);
    fo(c, m, "#b9b3a6");
  } else if (t === T.CAR) {
    rr(c, x + 0.1, y + 0.1, 0.8, 0.8, 0.2);
    fo(c, m, "#444");
  } else if (t === T.FURNITURE) {
    rr(c, x + 0.12, y + 0.12, 0.76, 0.76, 0.06);
    fo(c, m, WOOD);
  }
}

// ---------------------------------------------------------------- props

/**
 * A prop (furniture or cover) on its own, in tile units: in colour, or
 * as the blueprint draws it (for previews and the briefing).
 * @param {CanvasRenderingContext2D} c @param {Prop} p @param {{ blueprint?: boolean, shadow?: boolean }} [o]
 */
export function drawPropAlone(c, p, o = {}) {
  if (!p) return;
  S = c.getTransform().a || S;
  c.lineJoin = "round";
  c.lineCap = "round";
  if (o.shadow !== false && !o.blueprint) {
    c.save();
    c.translate(0.09, 0.12);
    drawProp(c, p, { bp: false, shadow: true, lod: 0 }, false);
    c.restore();
  }
  drawProp(c, p, { bp: !!o.blueprint, shadow: false, lod: 1 }, p.kind === "workbench");
}

/**
 * Draws a prop in its local frame: x along its back wall (L), y away
 * from the wall (D), the back at y = 0.
 * @param {CanvasRenderingContext2D} c @param {Prop} p @param {Mode} m @param {boolean} bench
 */
function drawProp(c, p, m, bench) {
  const r = p.rect;
  if (!r || !fin(r.x) || !fin(r.y) || !(r.w > 0) || !(r.h > 0)) return;
  let side = p.side;
  if (!side && r.h > r.w) side = "e";
  c.save();
  let L = r.w;
  let D = r.h;
  if (side === "s") {
    c.translate(r.x + r.w, r.y + r.h);
    c.rotate(Math.PI);
  } else if (side === "e") {
    c.translate(r.x + r.w, r.y);
    c.rotate(Math.PI / 2);
    L = r.h;
    D = r.w;
  } else if (side === "w") {
    c.translate(r.x, r.y + r.h);
    c.rotate(-Math.PI / 2);
    L = r.h;
    D = r.w;
  } else c.translate(r.x, r.y);
  const fn = PROPS[bench ? "workbench" : p.kind] ?? PROPS.crates;
  try {
    fn?.(c, L, D, m, hash(p.id, r.x, r.y));
  } catch {
    // never mind
  }
  c.restore();
}

/** @typedef {(c: CanvasRenderingContext2D, L: number, D: number, m: Mode, r: number) => void} PropFn */

/** @param {CanvasRenderingContext2D} c @param {Mode} m @param {number} x @param {number} y @param {number} s @param {number} r */
function chair(c, m, x, y, s, r, colour = P.oxblood) {
  rr(c, x - s / 2, y - s / 2, s, s, s * 0.25);
  fo(c, m, colour);
  rr(c, x - s / 2, y - s / 2, s, s * 0.28, s * 0.12);
  fd(c, m, shade(colour, -0.3));
  void r;
}

/** @param {CanvasRenderingContext2D} c @param {Mode} m @param {number} L @param {number} D @param {number} r */
function car(c, m, L, D, r) {
  const colour = [P.oxblood, P.emerald, "#20305a", "#e8dcb8", "#c79b3c", "#2b2b2e"][Math.floor(r * 6)] ?? P.oxblood;
  const w = Math.min(D - 0.2, 1.7);
  const y = (D - w) / 2;
  const len = L - 0.2;
  // Wheels.
  for (const [wx, wy] of [[0.25 * len, y - 0.05], [0.25 * len, y + w - 0.15], [0.78 * len, y - 0.05], [0.78 * len, y + w - 0.15]]) {
    rr(c, 0.1 + wx - 0.22, wy, 0.44, 0.2, 0.06);
    fo(c, m, "#111");
  }
  // Fenders and body.
  rr(c, 0.1, y + 0.05, len, w - 0.1, 0.35);
  fo(c, m, colour);
  // The hood (front at +x).
  rr(c, 0.1 + len * 0.58, y + 0.22, len * 0.4, w - 0.44, 0.15);
  fd(c, m, shade(colour, 0.15));
  c.beginPath();
  c.moveTo(0.1 + len * 0.6, y + w / 2);
  c.lineTo(0.1 + len * 0.97, y + w / 2);
  ln(c, m, shade(colour, -0.4), 0.03);
  // Soft top / cabin.
  rr(c, 0.1 + len * 0.14, y + 0.18, len * 0.4, w - 0.36, 0.2);
  fd(c, m, "#1d1b1c");
  // Windscreen.
  rr(c, 0.1 + len * 0.52, y + 0.22, 0.12, w - 0.44, 0.04);
  fd(c, m, "#a9d6e3");
  // Headlamps and the spare wheel.
  for (const yy of [y + 0.25, y + w - 0.25]) {
    el(c, 0.1 + len - 0.02, yy, 0.12);
    fd(c, m, P.goldLight);
  }
  el(c, 0.08, y + w / 2, 0.22, 0.28);
  fd(c, m, "#151515");
}

/** @type {Record<string, PropFn>} */
const PROPS = {
  table(c, L, D, m, r) {
    if (L <= 1.6 && D <= 1.6) {
      el(c, L / 2, D / 2, L / 2 - 0.08, D / 2 - 0.08);
      fo(c, m, r < 0.5 ? P.cream : "#e8d9b0");
      el(c, L / 2, D / 2, L / 2 - 0.25, D / 2 - 0.25);
      ln(c, m, P.gold, 0.03);
      return;
    }
    rr(c, 0.08, 0.08, L - 0.16, D - 0.16, 0.12);
    fo(c, m, WOOD_LIGHT);
    rr(c, 0.25, D / 2 - 0.18, L - 0.5, 0.36, 0.04);
    fd(c, m, r < 0.5 ? P.oxblood : P.emerald);
  },
  desk(c, L, D, m, r) {
    rr(c, 0.06, 0.08, L - 0.12, D - 0.2, 0.06);
    fo(c, m, WOOD_DARK);
    rr(c, 0.25, 0.22, L - 0.5, D - 0.5, 0.03);
    fd(c, m, P.emerald);
    // Papers, a lamp with a green shade.
    rr(c, L * 0.5, 0.3, 0.32, 0.4, 0.01);
    fd(c, m, PORCELAIN);
    el(c, 0.42, 0.38, 0.17);
    fd(c, m, "#2f8a5e");
    chair(c, m, L / 2, D + 0.02, 0.42, r, P.oxblood);
  },
  bookshelf(c, L, D, m, r) {
    rr(c, 0.03, 0.03, L - 0.06, Math.min(D, 0.9) - 0.06, 0.03);
    fo(c, m, WOOD_DARK);
    if (m.shadow || m.lod < 1) return;
    const d = Math.min(D, 0.9);
    const cols = ["#7c2230", "#1f6b52", "#20305a", "#c79b3c", "#e8dcb8", "#4a2a1a", "#8e3b2a"];
    let x = 0.12;
    let k = 0;
    while (x < L - 0.14) {
      const w = 0.07 + hash(k, Math.floor(r * 999)) * 0.08;
      c.beginPath();
      c.rect(x, 0.12, Math.min(w, L - 0.12 - x), d - 0.26 - hash(k, 5) * 0.12);
      fl(c, m, cols[Math.floor(hash(k, Math.floor(r * 999), 3) * cols.length)] ?? P.oxblood);
      x += w + 0.015;
      k++;
    }
  },
  armchair(c, L, D, m, r) {
    const s = Math.min(L, D) - 0.16;
    const x = (L - s) / 2;
    const colour = r < 0.5 ? P.oxblood : P.emerald;
    rr(c, x, 0.08, s, s, s * 0.3);
    fo(c, m, colour);
    rr(c, x + s * 0.18, 0.08 + s * 0.3, s * 0.64, s * 0.6, s * 0.15);
    fd(c, m, shade(colour, 0.2));
  },
  chair(c, L, D, m, r) {
    chair(c, m, L / 2, D / 2, Math.min(L, D) * 0.6, r, WOOD);
  },
  piano(c, L, D, m) {
    // A grand from above: the lid's curve towards the wall, the keyboard facing the room.
    const k = D - 0.38;
    c.beginPath();
    c.moveTo(0.12, k);
    c.lineTo(0.12, 0.35);
    c.bezierCurveTo(0.12, 0.08, L * 0.45, 0.06, L * 0.55, 0.3);
    c.bezierCurveTo(L * 0.62, D * 0.45, L - 0.12, D * 0.38, L - 0.12, D * 0.6);
    c.lineTo(L - 0.12, k);
    c.closePath();
    fo(c, m, "#151416");
    c.beginPath();
    c.moveTo(0.35, k - 0.15);
    c.lineTo(0.35, 0.45);
    c.bezierCurveTo(0.35, 0.3, L * 0.4, 0.3, L * 0.47, 0.45);
    ln(c, m, "rgba(255,255,255,0.28)", 0.04);
    c.beginPath();
    c.moveTo(L * 0.25, k - 0.1);
    c.lineTo(L * 0.62, D * 0.3);
    ln(c, m, P.gold, 0.03);
    rr(c, 0.12, k, L - 0.24, 0.3, 0.03);
    fo(c, m, PORCELAIN);
    if (!m.shadow && !m.bp && m.lod >= 1) {
      c.fillStyle = "#111";
      for (let x = 0.2, n = 0; x < L - 0.2; x += 0.11, n++) if (n % 7 !== 2 && n % 7 !== 6) c.fillRect(x, k, 0.05, 0.17);
    }
  },
  plant(c, L, D, m, r) {
    const x = L / 2;
    const y = D / 2;
    const s = Math.min(L, D) / 2;
    el(c, x, y, s * 0.55);
    fo(c, m, "#b5643b");
    if (m.shadow) return;
    const leaves = 7;
    for (let k = 0; k < leaves; k++) {
      const a = (k / leaves) * Math.PI * 2 + r * 6;
      c.save();
      c.translate(x, y);
      c.rotate(a);
      c.beginPath();
      c.moveTo(0, 0);
      c.quadraticCurveTo(s * 0.4, -s * 0.28, s * 0.92, 0);
      c.quadraticCurveTo(s * 0.4, s * 0.28, 0, 0);
      fo(c, m, k % 2 ? "#2f7d3e" : "#3f9a4c", Math.max(0.04, px(1)));
      c.restore();
    }
  },
  plinth(c, L, D, m) {
    const s = Math.min(L, D);
    const x = (L - s) / 2;
    const y = (D - s) / 2;
    rr(c, x + 0.06, y + 0.06, s - 0.12, s - 0.12, 0.04);
    fo(c, m, "#d9d0bd");
    rr(c, x + 0.18, y + 0.18, s - 0.36, s - 0.36, 0.03);
    fd(c, m, "#ece5d4");
    rr(c, x + 0.28, y + 0.28, s - 0.56, s - 0.56, 0.02);
    fd(c, m, P.gold);
  },
  case(c, L, D, m) {
    rr(c, 0.08, 0.08, L - 0.16, D - 0.16, 0.05);
    fo(c, m, P.gold);
    rr(c, 0.18, 0.18, L - 0.36, D - 0.36, 0.03);
    fd(c, m, "#5b1622");
    rr(c, 0.18, 0.18, L - 0.36, D - 0.36, 0.03);
    fl(c, m, GLASS);
    c.beginPath();
    c.moveTo(0.28, D - 0.35);
    c.lineTo(0.5, 0.3);
    c.moveTo(0.42, D - 0.3);
    c.lineTo(0.6, 0.45);
    ln(c, m, "rgba(255,255,255,0.7)", 0.03);
  },
  safe(c, L, D, m) {
    const s = Math.min(L, D);
    const x = (L - s) / 2;
    rr(c, x + 0.08, 0.06, s - 0.16, s - 0.14, 0.08);
    fo(c, m, "#2c4a3c");
    rr(c, x + 0.16, 0.14, s - 0.32, s - 0.32, 0.05);
    ln(c, m, "#1a2d24", 0.03);
    el(c, x + s / 2, s / 2 - 0.02, s * 0.16);
    fd(c, m, P.gold);
    c.beginPath();
    c.moveTo(x + s / 2, s / 2 - 0.02);
    c.lineTo(x + s / 2 + s * 0.1, s / 2 - 0.1);
    ln(c, m, P.ink, 0.03);
  },
  counter(c, L, D, m) {
    rr(c, 0.02, 0.02, L - 0.04, D - 0.1, 0.04);
    fo(c, m, "#ded7c6");
    c.beginPath();
    for (let x = 1; x < L; x++) {
      c.moveTo(x, 0.05);
      c.lineTo(x, D - 0.12);
    }
    ln(c, m, "rgba(0,0,0,0.15)", 0.02);
    rr(c, L * 0.3, 0.2, 0.45, 0.32, 0.03);
    fd(c, m, WOOD_LIGHT);
  },
  stove(c, L, D, m) {
    rr(c, 0.05, 0.04, L - 0.1, D - 0.12, 0.08);
    fo(c, m, "#1d1d20");
    const n = Math.max(2, Math.round(L * 2));
    for (let k = 0; k < n; k++) {
      el(c, ((k + 0.5) / n) * L, D * 0.45, Math.min(0.17, L / n / 2 - 0.05));
      ln(c, m, "#8a8f96", 0.04);
    }
    c.beginPath();
    c.moveTo(0.15, D - 0.1);
    c.lineTo(L - 0.15, D - 0.1);
    ln(c, m, "#c9cdd2", 0.05);
  },
  icebox(c, L, D, m) {
    rr(c, 0.08, 0.05, L - 0.16, D - 0.15, 0.18);
    fo(c, m, "#efe9da");
    c.beginPath();
    c.moveTo(L * 0.3, D - 0.2);
    c.lineTo(L * 0.7, D - 0.2);
    ln(c, m, "#8a8f96", 0.06);
  },
  bed(c, L, D, m, r) {
    const blanket = [P.oxblood, P.emerald, "#20305a", "#b8860b"][Math.floor(r * 4)] ?? P.oxblood;
    rr(c, 0.06, 0.02, L - 0.12, D - 0.08, 0.1);
    fo(c, m, PORCELAIN);
    rr(c, 0.02, 0.0, L - 0.04, 0.24, 0.08);
    fo(c, m, WOOD_DARK);
    const pillows = L >= 1.8 ? 2 : 1;
    for (let k = 0; k < pillows; k++) {
      const pw = (L - 0.4) / pillows - 0.08;
      rr(c, 0.22 + k * (pw + 0.12), 0.32, pw, 0.36, 0.12);
      fd(c, m, "#fffaf0");
    }
    rr(c, 0.06, D * 0.42, L - 0.12, D * 0.58 - 0.08, 0.08);
    fo(c, m, blanket, Math.max(0.04, px(1)));
    rr(c, 0.06, D * 0.42, L - 0.12, 0.18, 0.05);
    fd(c, m, shade(blanket, 0.3));
  },
  wardrobe(c, L, D, m) {
    rr(c, 0.04, 0.03, L - 0.08, D - 0.1, 0.04);
    fo(c, m, WOOD);
    c.beginPath();
    c.moveTo(L / 2, 0.1);
    c.lineTo(L / 2, D - 0.15);
    ln(c, m, WOOD_DARK, 0.04);
    for (const x of [L / 2 - 0.12, L / 2 + 0.12]) {
      el(c, x, D - 0.25, 0.05);
      fd(c, m, P.gold);
    }
  },
  dresser(c, L, D, m) {
    rr(c, 0.05, 0.04, L - 0.1, D - 0.12, 0.05);
    fo(c, m, WOOD_LIGHT);
    el(c, L / 2, 0.18, L * 0.3, 0.12);
    fd(c, m, "#c9dbe2");
    el(c, L * 0.25, D * 0.6, 0.08);
    fd(c, m, "#f4c1d0");
  },
  nightstand(c, L, D, m) {
    const s = Math.min(L, D) - 0.2;
    rr(c, (L - s) / 2, 0.08, s, s, 0.06);
    fo(c, m, WOOD);
    el(c, L / 2, 0.08 + s / 2, s * 0.25);
    fd(c, m, P.goldLight);
  },
  bathtub(c, L, D, m) {
    rr(c, 0.06, 0.06, L - 0.12, D - 0.12, Math.min(L, D) * 0.4);
    fo(c, m, PORCELAIN);
    rr(c, 0.2, 0.2, L - 0.4, D - 0.4, Math.min(L, D) * 0.3);
    fd(c, m, "#8fcbe0");
    for (const y of [D / 2 - 0.15, D / 2 + 0.15]) {
      el(c, 0.15, y, 0.06);
      fd(c, m, P.gold);
    }
    if (!m.shadow && !m.bp && m.lod >= 1) {
      for (const [x, y] of [[L * 0.6, D * 0.45], [L * 0.7, D * 0.55], [L * 0.55, D * 0.6]]) {
        el(c, x, y, 0.08);
        c.fillStyle = "rgba(255,255,255,0.8)";
        c.fill();
      }
    }
  },
  sink(c, L, D, m) {
    rr(c, 0.1, 0.04, L - 0.2, D * 0.7, 0.1);
    fo(c, m, PORCELAIN);
    el(c, L / 2, D * 0.38, L * 0.25, D * 0.2);
    fd(c, m, "#bfe0ea");
    el(c, L / 2, 0.14, 0.05);
    fd(c, m, P.gold);
  },
  toilet(c, L, D, m) {
    rr(c, L / 2 - 0.3, 0.04, 0.6, 0.25, 0.05);
    fo(c, m, PORCELAIN);
    el(c, L / 2, 0.55, 0.24, 0.3);
    fo(c, m, PORCELAIN);
    el(c, L / 2, 0.58, 0.13, 0.17);
    fd(c, m, "#bfe0ea");
  },
  billiards(c, L, D, m) {
    rr(c, 0.08, 0.08, L - 0.16, D - 0.16, 0.18);
    fo(c, m, WOOD_DARK);
    rr(c, 0.26, 0.26, L - 0.52, D - 0.52, 0.06);
    fd(c, m, FELT);
    for (const [x, y] of [[0.26, 0.26], [L / 2, 0.22], [L - 0.26, 0.26], [0.26, D - 0.26], [L / 2, D - 0.22], [L - 0.26, D - 0.26]]) {
      el(c, x, y, 0.09);
      fl(c, m, "#0b0b0b");
    }
    if (m.shadow || m.lod < 1) return;
    const balls = ["#f4f0e6", "#e0b52c", "#b8262d", "#20305a", "#111", "#e07a2c"];
    balls.forEach((col, k) => {
      el(c, L * (0.55 + (k % 3) * 0.06), D * (0.4 + Math.floor(k / 3) * 0.14 + (k % 3) * 0.03), 0.065);
      fd(c, m, col);
    });
    c.beginPath();
    c.moveTo(L * 0.18, D * 0.65);
    c.lineTo(L * 0.48, D * 0.48);
    ln(c, m, "#d8b47a", 0.04);
  },
  cuerack(c, L, D, m) {
    rr(c, 0.05, 0.03, L - 0.1, Math.min(D, 0.4), 0.04);
    fo(c, m, WOOD);
    c.beginPath();
    for (let x = 0.2; x < L - 0.1; x += 0.2) {
      c.moveTo(x, 0.06);
      c.lineTo(x, Math.min(D, 0.4) - 0.04);
    }
    ln(c, m, "#e6c992", 0.04);
  },
  bar(c, L, D, m) {
    rr(c, 0.04, 0.04, L - 0.08, D * 0.6, 0.12);
    fo(c, m, WOOD_DARK);
    c.beginPath();
    c.moveTo(0.15, D * 0.6 - 0.06);
    c.lineTo(L - 0.15, D * 0.6 - 0.06);
    ln(c, m, P.gold, 0.05);
    const cols = ["#3a7a3f", "#7c2230", "#d9b45a", "#e8dcb8"];
    for (let x = 0.3, k = 0; x < L - 0.2; x += 0.35, k++) {
      el(c, x, D * 0.28, 0.1);
      fd(c, m, cols[k % cols.length] ?? P.gold);
    }
    for (let x = 0.5; x < L - 0.2; x += 0.9) {
      el(c, x, D * 0.82, 0.16);
      fo(c, m, P.oxblood);
    }
  },
  sideboard(c, L, D, m) {
    rr(c, 0.04, 0.04, L - 0.08, D - 0.14, 0.05);
    fo(c, m, WOOD);
    c.beginPath();
    for (let x = 1; x < L; x++) {
      c.moveTo(x, 0.1);
      c.lineTo(x, D - 0.18);
    }
    ln(c, m, WOOD_DARK, 0.03);
    el(c, L * 0.7, D * 0.42, 0.14);
    fd(c, m, "#3f6fb0");
  },
  dining(c, L, D, m, r) {
    const inset = 0.45;
    for (let x = inset + 0.35; x < L - inset; x += 0.8) {
      chair(c, m, x, 0.25, 0.38, r);
      chair(c, m, x, D - 0.25, 0.38, r);
    }
    rr(c, inset, inset, L - 2 * inset, D - 2 * inset, 0.12);
    fo(c, m, P.cream);
    rr(c, inset + 0.12, D / 2 - 0.12, L - 2 * inset - 0.24, 0.24, 0.03);
    fd(c, m, P.gold);
    for (let x = inset + 0.5; x < L - inset - 0.3; x += 1.1) {
      el(c, x, D / 2, 0.1);
      fd(c, m, PORCELAIN);
    }
  },
  bench(c, L, D, m) {
    rr(c, 0.05, D / 2 - 0.25, L - 0.1, 0.5, 0.06);
    fo(c, m, WOOD_LIGHT);
    c.beginPath();
    c.moveTo(0.1, D / 2);
    c.lineTo(L - 0.1, D / 2);
    ln(c, m, WOOD_DARK, 0.03);
  },
  clock(c, L, D, m) {
    const s = Math.min(L, D);
    rr(c, (L - s * 0.7) / 2, 0.05, s * 0.7, s * 0.6, 0.06);
    fo(c, m, WOOD_DARK);
    el(c, L / 2, s * 0.32, s * 0.2);
    fd(c, m, P.cream);
    c.beginPath();
    c.moveTo(L / 2, s * 0.32);
    c.lineTo(L / 2, s * 0.2);
    c.moveTo(L / 2, s * 0.32);
    c.lineTo(L / 2 + s * 0.08, s * 0.34);
    ln(c, m, P.ink, 0.025);
  },
  coatstand(c, L, D, m) {
    el(c, L / 2, D / 2, 0.26);
    fo(c, m, WOOD_DARK);
    el(c, L / 2 + 0.05, D / 2 - 0.04, 0.2, 0.17);
    fo(c, m, "#2a2522");
    el(c, L / 2 + 0.05, D / 2 - 0.04, 0.1);
    fd(c, m, "#3a3532");
  },
  monitors(c, L, D, m, r) {
    rr(c, 0.04, 0.05, L - 0.08, D * 0.75, 0.05);
    fo(c, m, "#55595f");
    const n = Math.max(2, Math.floor(L / 0.55));
    for (let k = 0; k < n; k++) {
      const w = L / n - 0.12;
      rr(c, 0.1 + k * (w + 0.12) - 0.02, 0.12, w, 0.38, 0.05);
      fd(c, m, k % 2 ? "#79e0b0" : "#9fd8ff");
    }
    rr(c, L / 2 - 0.35, D * 0.6, 0.7, 0.16, 0.03);
    fd(c, m, "#2a2c30");
    chair(c, m, L * (0.3 + r * 0.4), D + 0.05, 0.42, r, "#3b3f45");
  },
  lockers(c, L, D, m) {
    rr(c, 0.02, 0.03, L - 0.04, Math.min(D, 0.7), 0.03);
    fo(c, m, "#5f7a6c");
    c.beginPath();
    for (let x = 0.5; x < L - 0.1; x += 0.5) {
      c.moveTo(x, 0.06);
      c.lineTo(x, Math.min(D, 0.7) - 0.03);
    }
    ln(c, m, "#2f3d36", 0.03);
  },
  vintagecar(c, L, D, m, r) {
    car(c, m, L, D, r);
  },
  car(c, L, D, m, r) {
    car(c, m, L, D, r);
  },
  workbench(c, L, D, m) {
    rr(c, 0.04, 0.05, L - 0.08, D - 0.12, 0.05);
    fo(c, m, WOOD_LIGHT);
    c.beginPath();
    for (let x = 0.33; x < L; x += 0.33) {
      c.moveTo(x, 0.08);
      c.lineTo(x, D - 0.12);
    }
    ln(c, m, "rgba(80,45,15,0.35)", 0.02);
    // A vice, a hammer, a wrench.
    rr(c, 0.15, 0.15, 0.35, 0.3, 0.04);
    fo(c, m, "#5e6870", Math.max(0.04, px(1)));
    c.beginPath();
    c.moveTo(L * 0.5, D * 0.3);
    c.lineTo(L * 0.75, D * 0.55);
    ln(c, m, "#6b4a2a", 0.06);
    rr(c, L * 0.46, D * 0.2, 0.16, 0.1, 0.02);
    fd(c, m, "#444");
    c.beginPath();
    c.moveTo(L * 0.8, D * 0.25);
    c.lineTo(L * 0.92, D * 0.6);
    ln(c, m, "#9aa3aa", 0.05);
  },
  tools(c, L, D, m) {
    rr(c, 0.03, 0.03, L - 0.06, Math.min(D, 0.35), 0.03);
    fo(c, m, "#b59a6a");
    c.beginPath();
    for (let x = 0.2; x < L - 0.1; x += 0.3) {
      c.moveTo(x, 0.08);
      c.lineTo(x + 0.04, Math.min(D, 0.35) - 0.04);
    }
    ln(c, m, "#444", 0.04);
  },
  crates(c, L, D, m, r) {
    const n = Math.max(1, Math.round(L * D));
    for (let k = 0; k < Math.min(n, 6); k++) {
      const x = (k % Math.max(1, Math.round(L))) + 0.1 + hash(k, r * 99) * 0.08;
      const y = Math.floor(k / Math.max(1, Math.round(L))) + 0.1;
      if (x + 0.8 > L + 0.05 || y + 0.8 > D + 0.05) continue;
      rr(c, x, y, 0.78, 0.78, 0.03);
      fo(c, m, "#b8874c");
      c.beginPath();
      c.moveTo(x + 0.08, y + 0.08);
      c.lineTo(x + 0.7, y + 0.7);
      c.moveTo(x + 0.7, y + 0.08);
      c.lineTo(x + 0.08, y + 0.7);
      ln(c, m, "#7a5428", 0.04);
    }
  },
  shelf(c, L, D, m) {
    rr(c, 0.03, 0.03, L - 0.06, Math.min(D, 0.6), 0.03);
    fo(c, m, "#8a9096");
    for (let x = 0.12; x < L - 0.3; x += 0.42) {
      rr(c, x, 0.1, 0.32, Math.min(D, 0.6) - 0.2, 0.02);
      fd(c, m, "#c4a676");
    }
  },
  hedge(c, L, D, m, r) {
    /** @type {[number, number, number][]} */
    const circles = [];
    const rad = Math.min(D, L, 1.2) / 2 + 0.02;
    for (let x = rad; x <= L - rad + 0.01; x += rad * 0.9) {
      for (let y = rad; y <= D - rad + 0.01; y += rad * 0.9) circles.push([x + (hash(x * 10, y * 10, r * 99) - 0.5) * 0.08, y, rad * (0.92 + hash(y * 10, x * 10) * 0.12)]);
    }
    blob(c, m, circles, "#28572a", "#346b33");
  },
  tree(c, L, D, m, r) {
    const R = Math.min(L, D) / 2 + 0.25;
    const x = L / 2;
    const y = D / 2;
    /** @type {[number, number, number][]} */
    const circles = [[x, y, R * 0.7]];
    const n = 7;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + r * 3;
      circles.push([x + Math.cos(a) * R * 0.5, y + Math.sin(a) * R * 0.5, R * 0.45]);
    }
    blob(c, m, circles, r < 0.5 ? "#2b6533" : "#336f2d", r < 0.5 ? "#3c8043" : "#468a3a");
  },
  fountain(c, L, D, m) {
    const rx = L / 2 - 0.08;
    const ry = D / 2 - 0.08;
    el(c, L / 2, D / 2, rx, ry);
    fo(c, m, "#cfc7b4");
    el(c, L / 2, D / 2, rx - 0.25, ry - 0.25);
    fd(c, m, "#4f9ec0");
    if (!m.shadow && !m.bp && m.lod >= 1) {
      for (const f of [0.45, 0.7]) {
        el(c, L / 2, D / 2, (rx - 0.25) * f, (ry - 0.25) * f);
        c.strokeStyle = "rgba(255,255,255,0.45)";
        c.lineWidth = px(1.2);
        c.stroke();
      }
    }
    el(c, L / 2, D / 2, Math.min(rx, ry) * 0.25);
    fo(c, m, "#e2dccb");
    el(c, L / 2, D / 2, Math.min(rx, ry) * 0.1);
    fd(c, m, P.gold);
  },
  hut(c, L, D, m) {
    rr(c, 0.05, 0.05, L - 0.1, D - 0.1, 0.04);
    fo(c, m, "#6e3b2a");
    c.beginPath();
    c.moveTo(0.05, D / 2);
    c.lineTo(L - 0.05, D / 2);
    ln(c, m, P.ink, 0.06);
    c.beginPath();
    for (let x = 0.3; x < L; x += 0.3) {
      c.moveTo(x, 0.08);
      c.lineTo(x, D - 0.08);
    }
    ln(c, m, "rgba(0,0,0,0.25)", 0.02);
  },
};

// ---------------------------------------------------------------- the world, per frame

/**
 * The blueprint alone (the TV during a heist): nothing seen, nothing remembered.
 * @param {CanvasRenderingContext2D} c @param {Art | null} art @param {View} v @param {{ budget?: number }} [o]
 */
export function drawBlueprint(c, art, v, o = {}) {
  if (!art) return;
  if (!art || !v || !(v.scale > 0)) return;
  art.frame++;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = P.paperDark;
  c.fillRect(0, 0, c.canvas.width, c.canvas.height);
  blitLayer(c, art, v, "paper", { budget: o.budget ?? 64 });
  drawNames(c, art, v, null);
  c.restore();
}

/**
 * Draws what a viewer sees: the blueprint, what one remembers (greyed),
 * what one sees now (colour, light and dark), doors, loot and figures.
 * `o.budget`: how many cached chunks may be drawn this frame (default 6;
 * missing ones are borrowed from another zoom until then).
 * @param {CanvasRenderingContext2D} c @param {Art | null} art @param {View} v @param {Scene} [scene]
 * @param {{ budget?: number, figures?: boolean }} [o]
 */
export function drawWorld(c, art, v, scene = {}, o = {}) {
  if (!art || !v || !(v.scale > 0)) return;
  art.frame++;
  const map = art.map;
  const n = map.w * map.h;
  const b = { budget: o.budget ?? 6 };
  const now = fin(scene.now) ? /** @type {number} */ (scene.now) : 0;
  const seen = scene.seen && scene.seen.length >= n ? scene.seen : null;
  const all = !scene.seen;
  const reg = region(art, v);
  const mem = scene.memory && scene.memory.seenAt?.length === n ? scene.memory : null;
  const memory = mem ? mem.seenAt : null;
  const light = scene.light && scene.light.length >= n ? scene.light : null;
  const doors = scene.doors && scene.doors.length >= map.doors.length ? scene.doors : (mem?.doors ?? null);
  const cat = scene.catalogue ?? [];
  const colors = scene.colors ?? {};
  // Loot: what one sees now, and what one remembers on tiles not seen now.
  /** @type {LootDraw[]} */
  const lootNow = [];
  /** @type {LootDraw[]} */
  const lootOld = [];
  for (const it of scene.items ?? []) lootNow.push(lootOf(it, cat, false));
  for (const e of scene.empty ?? []) lootNow.push(lootOf(e, cat, true));
  if (mem) {
    const isSeen = (/** @type {number} */ x, /** @type {number} */ y) => !!seen?.[y * map.w + x];
    for (const it of mem.items.values()) if (!isSeen(it.x, it.y)) lootOld.push(lootOf(it, cat, false));
    for (const e of mem.empty.values()) if (!isSeen(e.x, e.y)) lootOld.push(lootOf(e, cat, true));
  }
  c.save();
  try {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = all ? "#0d0c0e" : P.paperDark;
    c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    if (!all) {
      blitLayer(c, art, v, "paper", b);
      drawNames(c, art, v, seen);
    }

    // Memory: the greyed copy where one has been, fading with age.
    if (memory && !all) {
      const s = scratch(art, 0, v);
      blitLayer(s, art, v, "grey", b);
      useTiles(s, v);
      drawDoors(s, art, doors, (i) => memory[i] >= 0 && !(seen && seen[i]));
      drawLoot(s, art, lootOld, true, now);
      const mk = mask(art, "memory", 4, reg, (i) => {
        const t = memory[i] ?? -1;
        if (t < 0 || (seen && seen[i])) return 0;
        const a = clamp(0.62 - ((now - t) / 90) * 0.32, 0.3, 0.62);
        return 0xffffff00 | Math.round(a * 255);
      }, null, undefined, 1);
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.globalCompositeOperation = "destination-in";
      blitMask(s, mk, v);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(s.canvas, 0, 0);
    }

    // What one sees now.
    if (all || seen) {
      const s = scratch(art, 1, v);
      blitLayer(s, art, v, "colour", b);
      useTiles(s, v);
      drawDoors(s, art, doors, (i) => all || !!seen?.[i]);
      drawLamps(s, art, scene.lamps);
      drawLoot(s, art, lootNow, false, now);
      // Light and dark.
      const tint = light ? lightTint(art, reg, light, scene.lamps, scene.figures ?? []) : null;
      if (tint) {
        s.setTransform(1, 0, 0, 1, 0, 0);
        s.globalCompositeOperation = "source-over";
        blitMask(s, tint.dark, v);
        s.globalCompositeOperation = "screen";
        blitMask(s, tint.glow, v);
        s.globalCompositeOperation = "source-over";
      }
      drawBeams(s, art, v, reg, scene.figures ?? [], light, now);
      if (!all && seen) {
        // A feathered edge, and a soft shadow round the seen area lifting it off the paper.
        const mk = mask(art, "seen", 4, reg, (i) => (seen[i] ? 0xffffffff : 0), null, undefined, 1);
        s.setTransform(1, 0, 0, 1, 0, 0);
        s.globalCompositeOperation = "destination-in";
        blitMask(s, mk, v);
        const sh = mask(art, "seenShadow", 4, reg, (i) => (seen[i] ? 0x03060fa0 : 0), null, undefined, 3);
        c.setTransform(1, 0, 0, 1, 0, 0);
        blitMask(c, sh, v);
      }
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(s.canvas, 0, 0);
    }

    // The flashlights' aim, a thin outline over everything (the cone may be cut by walls).
    beamOutlines(c, v, scene.figures ?? [], now);

    // Figures.
    if (o.figures !== false) {
      useTiles(c, v);
      const figs = [...(scene.figures ?? [])].filter((f) => f && fin(f.x) && fin(f.y)).sort((a, b) => a.y - b.y);
      for (const f of figs) {
        const colour = f.colour ?? (f.id !== undefined ? colors[f.id] : undefined);
        const name = f.name ?? (f.id !== undefined ? scene.names?.[f.id] : undefined);
        drawFigure(c, colour === f.colour && name === f.name ? f : { ...f, colour, name }, now);
      }
    }
  } catch {
    // odd data: draw what we could
  }
  c.restore();
}

const DARK = 0x0c1532a0;

/**
 * The light over the seen world, at 4 pixels a tile: `dark`, a deep
 * blue-black laid over unlit tiles (thinning towards lamps and along
 * flashlight cones), and `glow`, screened on: amber pools round lamps,
 * pale yellow cones, a faint warmth in lit rooms.
 * @param {Art} art @param {Rect} reg @param {ArrayLike<number>} light @param {ArrayLike<number | boolean> | null | undefined} lamps @param {readonly Figure[]} figures
 */
function lightTint(art, reg, light, lamps, figures) {
  const map = art.map;
  const torches = figures.filter((f) => f && f.role === "guard" && f.light && fin(f.x) && fin(f.y));
  const on = map.lamps.map((l) => (l ? (lamps ? !!lamps[l.id] : true) : false));
  /** Torch light at a point, 0–1. @param {number} x @param {number} y */
  const beam = (x, y) => {
    let a = 0;
    for (const f of torches) {
      const dx = x - f.x;
      const dy = y - f.y;
      const d = Math.hypot(dx, dy);
      if (d > 7.6) continue;
      const diff = Math.abs((((Math.atan2(dy, dx) / RAD - (f.facing ?? 0)) % 360) + 540) % 360 - 180);
      const cone = d < 0.8 ? 1 : clamp((31 - diff) / 3, 0, 1);
      a = Math.max(a, cone * clamp((7.5 - d) / (f.holding ? 1.6 : 3.2), 0, 1));
    }
    return clamp(a, 0, 1);
  };
  /** A known flashlight could reach here (else the light is an unseen guard's: lit evenly). @param {number} x @param {number} y */
  const near = (x, y) => torches.some((f) => Math.hypot(x - f.x, y - f.y) < 8.2);
  /** Lamp light at a point, 0–1. @param {number} x @param {number} y */
  const pool = (x, y) => {
    let g = 0;
    for (let k = 0; k < map.lamps.length; k++) {
      const lp = map.lamps[k];
      if (!lp || !on[k]) continue;
      const d = Math.hypot(x - lp.x - 0.5, y - lp.y - 0.5);
      if (d < LAMP_RADIUS + 0.2) g = Math.max(g, Math.pow(clamp((LAMP_RADIUS + 0.2 - d) / 2.6, 0, 1), 0.8));
    }
    return g;
  };
  const special = (/** @type {number} */ i) => ((light[i] ?? 0) & LIGHT_ROOM ? -2 : (light[i] ?? 0) & (LIGHT_TORCH | LIGHT_LAMP) ? -1 : 0);
  const dark = mask(
    art,
    "dark",
    4,
    reg,
    (i) => (special(i) === -2 ? 0 : special(i) === -1 ? -1 : DARK),
    (i, x, y) => {
      const l = light[i] ?? 0;
      const a = l & LIGHT_TORCH ? (near(x, y) ? beam(x, y) : 0.6) : 0;
      const g = l & LIGHT_LAMP ? pool(x, y) : 0;
      const lit = Math.max(a, g);
      return (DARK & 0xffffff00) | Math.round((DARK & 255) * (1 - lit) * (1 - lit));
    },
    undefined,
    1,
  );
  const glow = mask(
    art,
    "glow",
    4,
    reg,
    (i) => (special(i) === -2 ? 0xffc8701c : special(i) === -1 ? -1 : 0),
    (i, x, y) => {
      const l = light[i] ?? 0;
      const a = l & LIGHT_TORCH ? (near(x, y) ? beam(x, y) : 0.6) : 0;
      const g = l & LIGHT_LAMP ? pool(x, y) : 0;
      if (a >= g) return (0xfff2b000 | Math.round(a * 0.3 * 255)) >>> 0;
      return (0xffa03000 | Math.round(g * 0.6 * 255)) >>> 0;
    },
    undefined,
    1,
  );
  return { dark, glow };
}

/**
 * Flashlight cones: a warm wedge, brightest at the guard, feathered at
 * its sides, with a thin bright rim; a warming flashlight flickers. Cut
 * at walls by the light mask's torch bits; screened onto the seen layer.
 * @param {CanvasRenderingContext2D} s @param {Art} art @param {View} v @param {Rect} reg @param {readonly Figure[]} figures
 * @param {ArrayLike<number> | null} light @param {number} now
 */
function drawBeams(s, art, v, reg, figures, light, now) {
  const beams = figures.filter((f) => f && f.role === "guard" && (f.light || f.warming) && fin(f.x) && fin(f.y));
  if (beams.length === 0) return;
  const sc = scratch(art, 3, v);
  useTiles(sc, v);
  const R = 7.5;
  const half = 30 * RAD;
  for (const f of beams) {
    const a = (fin(f.facing) ? /** @type {number} */ (f.facing) : 0) * RAD;
    const flick = f.light ? 1 : hash(Math.floor(now * 14), f.x | 0) > 0.45 ? 0.55 : 0.12;
    const k = (f.holding ? 1.25 : 1) * flick;
    // Feathered sides: a few wedges, each a little wider and fainter.
    for (const [spread, alpha] of [[1.12, 0.22], [1.05, 0.3], [1, 0.55]]) {
      const g = sc.createRadialGradient(f.x, f.y, 0.15, f.x, f.y, R);
      g.addColorStop(0, `rgba(255,238,170,${(alpha * k).toFixed(3)})`);
      g.addColorStop(0.45, `rgba(255,226,140,${(alpha * 0.55 * k).toFixed(3)})`);
      g.addColorStop(1, "rgba(255,214,120,0)");
      sc.beginPath();
      sc.moveTo(f.x, f.y);
      sc.arc(f.x, f.y, R, a - half * /** @type {number} */ (spread), a + half * /** @type {number} */ (spread));
      sc.closePath();
      sc.fillStyle = g;
      sc.fill();
    }
    // The rim.
    for (const side of [-1, 1]) {
      const ex = f.x + Math.cos(a + side * half) * R * 0.95;
      const ey = f.y + Math.sin(a + side * half) * R * 0.95;
      const lg = sc.createLinearGradient(f.x, f.y, ex, ey);
      lg.addColorStop(0, `rgba(255,246,200,${(0.9 * k).toFixed(3)})`);
      lg.addColorStop(1, "rgba(255,240,180,0)");
      sc.beginPath();
      sc.moveTo(f.x + Math.cos(a + side * half) * 0.35, f.y + Math.sin(a + side * half) * 0.35);
      sc.lineTo(ex, ey);
      sc.strokeStyle = lg;
      sc.lineWidth = Math.max(0.04, px(1.6));
      sc.stroke();
    }
  }
  if (light) {
    const tm = mask(art, "torch", 4, reg, (i) => ((light[i] ?? 0) & LIGHT_TORCH ? 0xffffffff : 0), null, undefined, 1);
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.globalCompositeOperation = "destination-in";
    blitMask(sc, tm, v);
  }
  s.save();
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.globalCompositeOperation = "screen";
  s.drawImage(sc.canvas, 0, 0);
  s.restore();
}

/**
 * A flashlight's outline: its sides and its far arc, thin and dashed,
 * fading outwards; flickering while warming.
 * @param {CanvasRenderingContext2D} c @param {View} v @param {readonly Figure[]} figures @param {number} now
 */
function beamOutlines(c, v, figures, now) {
  useTiles(c, v);
  const R = 7;
  const half = 30 * RAD;
  for (const f of figures) {
    if (!f || f.role !== "guard" || !(f.light || f.warming) || !fin(f.x) || !fin(f.y)) continue;
    if (!f.light && hash(Math.floor(now * 14), 7) < 0.5) continue;
    const a = (fin(f.facing) ? /** @type {number} */ (f.facing) : 0) * RAD;
    const g = c.createRadialGradient(f.x, f.y, 0.4, f.x, f.y, R);
    g.addColorStop(0, "rgba(255,236,160,0.95)");
    g.addColorStop(1, "rgba(255,226,140,0.25)");
    c.save();
    c.beginPath();
    c.moveTo(f.x + Math.cos(a - half) * 0.45, f.y + Math.sin(a - half) * 0.45);
    c.lineTo(f.x + Math.cos(a - half) * R, f.y + Math.sin(a - half) * R);
    c.arc(f.x, f.y, R, a - half, a + half);
    c.lineTo(f.x + Math.cos(a + half) * 0.45, f.y + Math.sin(a + half) * 0.45);
    c.strokeStyle = g;
    c.lineWidth = Math.max(0.035, px(1.4));
    c.setLineDash([0.22, 0.12]);
    c.stroke();
    c.restore();
  }
}

/**
 * Door leaves on the tiles `show` lets through: move.ts states (1 open, 2 locked, else closed).
 * @param {CanvasRenderingContext2D} c @param {Art} art @param {ArrayLike<number> | null} states @param {(i: number) => boolean} show
 */
function drawDoors(c, art, states, show) {
  const map = art.map;
  for (const d of map.doors) {
    if (!d || !show(d.i ?? d.y * map.w + d.x)) continue;
    const st = states ? (states[d.id] ?? 0) : d.locked ? 2 : 0;
    const open = st === 1;
    const locked = st === 2;
    const h = doorHinge(d);
    c.beginPath();
    if (open) {
      // Leaf swung into the room: a plank from the hinge.
      const w = 0.16;
      if (d.wall === "h") rr(c, h.hx - 0.02, Math.min(h.hy, h.oy), w, Math.abs(h.oy - h.hy), 0.04);
      else rr(c, Math.min(h.hx, h.ox), h.hy - 0.02, Math.abs(h.ox - h.hx), w, 0.04);
    } else if (d.wall === "h") rr(c, d.x + 0.02, d.y + 0.38, 0.96, 0.24, 0.04);
    else rr(c, d.x + 0.38, d.y + 0.02, 0.24, 0.96, 0.04);
    c.fillStyle = locked ? "#5a2f17" : "#8a5126";
    c.fill();
    c.strokeStyle = P.ink;
    c.lineWidth = OUT();
    c.stroke();
    if (!open) {
      const kx = d.wall === "h" ? d.x + 0.82 : d.x + 0.5;
      const ky = d.wall === "h" ? d.y + 0.5 : d.y + 0.82;
      el(c, kx, ky, 0.06);
      c.fillStyle = P.gold;
      c.fill();
      if (locked) padlock(c, d.x + 0.5, d.y + 0.5, 0.5, false);
    }
  }
}

/** Lamp globes (lit or smashed) on the colour layer. @param {CanvasRenderingContext2D} c @param {Art} art @param {ArrayLike<number | boolean> | null | undefined} lamps */
function drawLamps(c, art, lamps) {
  for (const l of art.map.lamps) {
    if (!l) continue;
    const on = lamps ? !!lamps[l.id] : true;
    const x = l.x + 0.5;
    const y = l.y + 0.5;
    if (on) {
      const g = c.createRadialGradient(x, y, 0.1, x, y, 1.4);
      g.addColorStop(0, "rgba(255,226,150,0.75)");
      g.addColorStop(1, "rgba(255,190,90,0)");
      c.fillStyle = g;
      c.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
    lampSymbol(c, x, y, false, on);
  }
}

// ---------------------------------------------------------------- memory

/**
 * What a phone remembers (§4): per tile the heist time it was last seen
 * (-1 never), the doors' last seen states (move.ts), the items and empty
 * places last seen (by tile), with when.
 * @typedef {{ w: number, h: number, seenAt: Float32Array, doors: Uint8Array,
 *   items: Map<number, SeenItem & { t: number }>, empty: Map<number, SeenEmpty & { t: number }> }} Memory
 */

/** An empty memory for a map (once per heist). @param {Blueprint} map @returns {Memory} */
export function createMemory(map) {
  const w = map?.w | 0;
  const h = map?.h | 0;
  const doors = new Uint8Array(Array.isArray(map?.doors) ? map.doors.length : 0);
  map?.doors?.forEach((d, k) => (doors[k] = d?.locked ? 2 : 0));
  return { w, h, seenAt: new Float32Array(w * h).fill(-1), doors, items: new Map(), empty: new Map() };
}

/**
 * Adds a frame to the memory: its seen tiles (protocol.ts
 * `decodeFrameMasks(f, map).seen`) at `f.t`, the door states, items and
 * empty places on them; items no longer on a seen tile are forgotten.
 * @param {Memory} mem @param {{ t: number, items?: readonly SeenItem[], empty?: readonly SeenEmpty[], doors?: readonly number[] }} f
 * @param {ArrayLike<number> | null | undefined} seen
 */
export function remember(mem, f, seen) {
  if (!mem || !f || !seen || seen.length < mem.seenAt.length) return;
  const t = fin(f.t) ? f.t : 0;
  const n = mem.seenAt.length;
  for (let i = 0; i < n; i++) if (seen[i]) mem.seenAt[i] = t;
  for (const [k] of mem.items) if (seen[k]) mem.items.delete(k);
  for (const [k] of mem.empty) if (seen[k]) mem.empty.delete(k);
  const at = (/** @type {number} */ x, /** @type {number} */ y) => (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < mem.w && y < mem.h ? y * mem.w + x : -1);
  for (const it of f.items ?? []) {
    const k = at(it?.x, it?.y);
    if (k >= 0) mem.items.set(k, { ...it, t });
  }
  for (const e of f.empty ?? []) {
    const k = at(e?.x, e?.y);
    if (k >= 0) mem.empty.set(k, { ...e, t });
  }
  const d = f.doors ?? [];
  for (let k = 0; k + 1 < d.length; k += 2) {
    const id = d[k];
    const st = d[k + 1];
    if (Number.isInteger(id) && /** @type {number} */ (id) >= 0 && /** @type {number} */ (id) < mem.doors.length && (st === 0 || st === 1 || st === 2)) mem.doors[/** @type {number} */ (id)] = st;
  }
}

// ---------------------------------------------------------------- loot

/** The icon shapes: a handful, coloured by item. */
export const LOOT_ICONS = ["gem", "ring", "pearls", "egg", "crown", "papers", "bottle", "crate", "painting", "vase", "bust", "violin", "record", "watch", "gadget", "bars", "box", "plant", "lamp", "bag"];

/** @type {Record<string, [string, string?]>} item id → [icon, colour] */
const ICON_OF = {
  "night-lunch": ["box", "#c79b3c"], "vhs-tape": ["gadget", "#222"], wheelbarrow: ["bag", "#9b7b4a"], gnome: ["bust", "#c0392b"],
  "dressing-gown": ["bag", "#7c2230"], "hip-flask": ["bottle", "#c9cdd2"], "piano-key": ["box", "#f3f1ea"], "puzzle-cube": ["box", "#e0b52c"],
  bowler: ["box", "#2a2522"], "prize-marrow": ["egg", "#4f8a3a"], "lava-lamp": ["lamp", "#e0442c"], "fountain-pen": ["papers", "#20305a"],
  walkman: ["gadget", "#3f6fb0"], pheasant: ["bust", "#8a5a2e"], cigars: ["box", "#8c5a2e"], spoons: ["watch", "#d0d4d8"],
  caviar: ["box", "#3a3f45"], "cuckoo-clock": ["watch", "#8c5a2e"], gin: ["crate", "#b8874c"], typewriter: ["gadget", "#2a2c30"],
  bust: ["bust", "#e2dccb"], orchid: ["plant", "#d27ac9"], candelabra: ["lamp", "#d0d4d8"], "billiard-cue": ["violin", "#d8b47a"],
  "toilet-brush": ["lamp", "#d6a842"], gramophone: ["record", "#d6a842"], "robot-vacuum": ["record", "#3a3f45"], microwave: ["gadget", "#e8e4d8"],
  "hood-ornament": ["bust", "#d0d4d8"], will: ["papers", "#f1e4c4"], cognac: ["bottle", "#b0662a"], "pocket-watch": ["watch", "#d6a842"],
  recipe: ["papers", "#f1e4c4"], zeppelin: ["egg", "#c9cdd2"], "car-phone": ["gadget", "#222"], "swamp-deed": ["papers", "#cfe0b0"],
  globe: ["egg", "#3f6fb0"], "jazz-record": ["record", "#111"], "racing-trophy": ["vase", "#d6a842"], "persian-rug": ["papers", "#7c2230"],
  "jade-chess": ["box", "#3aa57a"], stocks: ["papers", "#e8dcb8"], guitar: ["violin", "#c0392b"], pearls: ["pearls", "#f6f1e6"],
  bonds: ["papers", "#d8e6c8"], "diamond-ring": ["ring", "#bfe8ff"], "gold-bars": ["bars", "#e0b52c"], opal: ["gem", "#7fd6d0"],
  "ming-vase": ["vase", "#3f6fb0"], "duke-portrait": ["painting", "#7c2230"], tiara: ["crown", "#cfe9ff"], "dinosaur-egg": ["egg", "#b9a37a"],
  violin: ["violin", "#9a4f1c"], rembrandt: ["painting", "#5a3a1a"], "moon-rock": ["gem", "#9a9aa0"], sandal: ["bag", "#d6a842"],
  bible: ["papers", "#5a1d1d"], "faberge-egg": ["egg", "#c03a5a"], crown: ["crown", "#e0b52c"], ruby: ["gem", "#d0213a"],
};

/**
 * Draws a loot icon centred at (x, y), `s` across (any units: tiles on
 * the map, CSS px in the catalogue with an identity transform).
 * @param {CanvasRenderingContext2D} c @param {string} icon an item id or a {@link LOOT_ICONS} name @param {number} x @param {number} y @param {number} s
 * @param {{ grey?: boolean, tagged?: boolean, now?: number }} [o]
 */
export function drawLootIcon(c, icon, x, y, s, o = {}) {
  if (!fin(x) || !fin(y) || !(s > 0)) return;
  const known = ICON_OF[icon];
  const shape = known ? known[0] : LOOT_ICONS.includes(icon) ? icon : (LOOT_ICONS[Math.floor(hash(icon.length, icon.charCodeAt(0) || 0) * LOOT_ICONS.length)] ?? "bag");
  let colour = known?.[1] ?? P.gold;
  if (o.grey) colour = "#9aa6b8";
  const lw = Math.max(s * 0.07, px(1));
  c.save();
  c.translate(x, y);
  c.scale(s, s);
  c.lineJoin = "round";
  c.lineCap = "round";
  const line = o.grey ? "#3c4658" : P.ink;
  const fo2 = (/** @type {string} */ fill) => {
    c.fillStyle = fill;
    c.fill();
    c.strokeStyle = line;
    c.lineWidth = lw / s;
    c.stroke();
  };
  const hi = o.grey ? "#c9d1dd" : shade(colour, 0.45);
  try {
    switch (shape) {
      case "gem":
        c.beginPath();
        c.moveTo(-0.38, -0.12);
        c.lineTo(-0.2, -0.34);
        c.lineTo(0.2, -0.34);
        c.lineTo(0.38, -0.12);
        c.lineTo(0, 0.4);
        c.closePath();
        fo2(colour);
        c.beginPath();
        c.moveTo(-0.38, -0.12);
        c.lineTo(0.38, -0.12);
        c.moveTo(-0.12, -0.12);
        c.lineTo(0, 0.38);
        c.lineTo(0.12, -0.12);
        c.strokeStyle = line;
        c.lineWidth = (lw / s) * 0.6;
        c.stroke();
        c.beginPath();
        c.moveTo(-0.16, -0.28);
        c.lineTo(-0.05, -0.28);
        c.strokeStyle = hi;
        c.stroke();
        break;
      case "ring":
        el(c, 0, 0.08, 0.3);
        c.strokeStyle = line;
        c.lineWidth = 0.2;
        c.stroke();
        c.strokeStyle = o.grey ? colour : P.gold;
        c.lineWidth = 0.12;
        c.stroke();
        c.beginPath();
        c.moveTo(-0.15, -0.22);
        c.lineTo(0, -0.42);
        c.lineTo(0.15, -0.22);
        c.lineTo(0, -0.12);
        c.closePath();
        fo2(colour);
        break;
      case "pearls":
        for (let k = 0; k < 11; k++) {
          const a = Math.PI * 0.1 + (k / 10) * Math.PI * 0.8;
          el(c, Math.cos(a) * 0.36, Math.sin(a) * 0.36 - 0.12, 0.085);
          fo2(colour);
        }
        el(c, 0, 0.32, 0.1);
        fo2(o.grey ? colour : "#d0213a");
        break;
      case "egg":
        el(c, 0, 0.02, 0.3, 0.4);
        fo2(colour);
        c.beginPath();
        c.moveTo(-0.3, 0.02);
        c.lineTo(0.3, 0.02);
        c.moveTo(-0.26, -0.18);
        c.lineTo(0.26, -0.18);
        c.strokeStyle = o.grey ? hi : P.gold;
        c.lineWidth = 0.06;
        c.stroke();
        el(c, -0.1, -0.2, 0.06, 0.1);
        c.fillStyle = "rgba(255,255,255,0.5)";
        c.fill();
        break;
      case "crown":
        c.beginPath();
        c.moveTo(-0.38, 0.28);
        c.lineTo(-0.38, -0.2);
        c.lineTo(-0.18, 0.02);
        c.lineTo(0, -0.34);
        c.lineTo(0.18, 0.02);
        c.lineTo(0.38, -0.2);
        c.lineTo(0.38, 0.28);
        c.closePath();
        fo2(colour);
        for (const gx of [-0.2, 0, 0.2]) {
          el(c, gx, 0.16, 0.06);
          c.fillStyle = o.grey ? hi : "#d0213a";
          c.fill();
        }
        break;
      case "papers":
        c.save();
        c.rotate(-0.15);
        rr(c, -0.3, -0.38, 0.6, 0.72, 0.03);
        fo2(shade(colour, -0.1));
        c.restore();
        rr(c, -0.28, -0.36, 0.56, 0.72, 0.03);
        fo2(colour);
        c.beginPath();
        for (const yy of [-0.2, -0.08, 0.04]) {
          c.moveTo(-0.16, yy);
          c.lineTo(0.16, yy);
        }
        c.strokeStyle = o.grey ? "#6a7488" : "rgba(0,0,0,0.4)";
        c.lineWidth = 0.04;
        c.stroke();
        el(c, 0.1, 0.2, 0.1);
        fo2(o.grey ? hi : P.oxblood);
        break;
      case "bottle":
        rr(c, -0.2, -0.1, 0.4, 0.5, 0.1);
        fo2(colour);
        rr(c, -0.08, -0.42, 0.16, 0.36, 0.04);
        fo2(colour);
        rr(c, -0.18, 0.05, 0.36, 0.18, 0.02);
        fo2(o.grey ? hi : P.cream);
        break;
      case "crate":
        rr(c, -0.4, -0.32, 0.8, 0.64, 0.04);
        fo2(colour);
        c.beginPath();
        c.moveTo(-0.4, -0.05);
        c.lineTo(0.4, -0.05);
        c.moveTo(-0.15, -0.32);
        c.lineTo(-0.15, 0.32);
        c.moveTo(0.15, -0.32);
        c.lineTo(0.15, 0.32);
        c.strokeStyle = line;
        c.lineWidth = 0.05;
        c.stroke();
        for (const bx of [-0.27, 0, 0.27]) {
          el(c, bx, -0.18, 0.07);
          fo2(o.grey ? hi : "#3a7a3f");
        }
        break;
      case "painting":
        rr(c, -0.42, -0.32, 0.84, 0.64, 0.02);
        fo2(o.grey ? colour : P.gold);
        rr(c, -0.32, -0.22, 0.64, 0.44, 0.01);
        fo2(o.grey ? hi : colour);
        el(c, 0, -0.04, 0.1, 0.12);
        c.fillStyle = o.grey ? colour : "#e6c9a0";
        c.fill();
        break;
      case "vase":
        c.beginPath();
        c.moveTo(-0.14, -0.4);
        c.lineTo(0.14, -0.4);
        c.bezierCurveTo(0.1, -0.2, 0.4, -0.1, 0.3, 0.2);
        c.bezierCurveTo(0.24, 0.4, -0.24, 0.4, -0.3, 0.2);
        c.bezierCurveTo(-0.4, -0.1, -0.1, -0.2, -0.14, -0.4);
        c.closePath();
        fo2(o.grey ? colour : P.cream);
        c.beginPath();
        c.moveTo(-0.3, 0.05);
        c.bezierCurveTo(-0.1, 0.15, 0.1, -0.05, 0.3, 0.05);
        c.strokeStyle = colour;
        c.lineWidth = 0.08;
        c.stroke();
        break;
      case "bust":
        el(c, 0, 0.22, 0.34, 0.18);
        fo2(colour);
        el(c, 0, -0.12, 0.2, 0.24);
        fo2(colour);
        break;
      case "violin":
        c.save();
        c.rotate(-0.6);
        c.beginPath();
        c.ellipse(0, 0.16, 0.2, 0.2, 0, 0, Math.PI * 2);
        c.moveTo(0.15, -0.08);
        c.ellipse(0, -0.08, 0.15, 0.15, 0, 0, Math.PI * 2);
        fo2(colour);
        rr(c, -0.04, -0.46, 0.08, 0.36, 0.03);
        fo2(o.grey ? colour : "#222");
        c.restore();
        break;
      case "record":
        el(c, 0, 0, 0.4);
        fo2(o.grey ? colour : "#151515");
        el(c, 0, 0, 0.26);
        c.strokeStyle = "rgba(255,255,255,0.2)";
        c.lineWidth = 0.03;
        c.stroke();
        el(c, 0, 0, 0.13);
        fo2(o.grey ? hi : colour === "#111" ? P.oxblood : colour);
        break;
      case "watch":
        el(c, 0, 0.06, 0.32);
        fo2(colour);
        el(c, 0, 0.06, 0.23);
        fo2(o.grey ? hi : P.cream);
        c.beginPath();
        c.moveTo(0, 0.06);
        c.lineTo(0, -0.1);
        c.moveTo(0, 0.06);
        c.lineTo(0.12, 0.1);
        c.strokeStyle = line;
        c.lineWidth = 0.04;
        c.stroke();
        el(c, 0, -0.32, 0.07);
        fo2(colour);
        break;
      case "gadget":
        rr(c, -0.38, -0.26, 0.76, 0.52, 0.08);
        fo2(colour);
        rr(c, -0.26, -0.15, 0.3, 0.22, 0.03);
        fo2(o.grey ? hi : "#7fe0c0");
        for (const gx of [0.16, 0.28]) {
          el(c, gx, 0.08, 0.05);
          c.fillStyle = o.grey ? hi : "#e0442c";
          c.fill();
        }
        break;
      case "bars":
        for (const [bx, by] of [[-0.2, 0.1], [0.2, 0.1], [0, -0.16]]) {
          c.beginPath();
          c.moveTo(bx - 0.22, by + 0.13);
          c.lineTo(bx - 0.15, by - 0.13);
          c.lineTo(bx + 0.15, by - 0.13);
          c.lineTo(bx + 0.22, by + 0.13);
          c.closePath();
          fo2(colour);
        }
        break;
      case "box":
        rr(c, -0.36, -0.26, 0.72, 0.52, 0.06);
        fo2(colour);
        c.beginPath();
        c.moveTo(-0.36, -0.08);
        c.lineTo(0.36, -0.08);
        c.strokeStyle = line;
        c.lineWidth = 0.05;
        c.stroke();
        rr(c, -0.1, -0.14, 0.2, 0.14, 0.02);
        fo2(o.grey ? hi : P.gold);
        break;
      case "plant":
        rr(c, -0.18, 0.08, 0.36, 0.3, 0.06);
        fo2(o.grey ? hi : "#b5643b");
        for (const a of [-0.9, 0, 0.9]) {
          c.save();
          c.rotate(a);
          el(c, 0, -0.18, 0.12, 0.2);
          fo2(colour);
          c.restore();
        }
        break;
      case "lamp":
        rr(c, -0.12, -0.42, 0.24, 0.6, 0.12);
        fo2(colour);
        rr(c, -0.22, 0.18, 0.44, 0.2, 0.06);
        fo2(o.grey ? hi : "#3a3f45");
        el(c, 0, -0.18, 0.06, 0.1);
        c.fillStyle = "rgba(255,255,255,0.5)";
        c.fill();
        break;
      default: {
        // A sack with a dollar sign.
        c.beginPath();
        c.moveTo(-0.12, -0.3);
        c.bezierCurveTo(-0.45, -0.1, -0.45, 0.4, 0, 0.4);
        c.bezierCurveTo(0.45, 0.4, 0.45, -0.1, 0.12, -0.3);
        c.closePath();
        fo2(o.grey ? colour : "#c9a66b");
        label2(c, "$", 0, 0.1, 0.36, line);
      }
    }
    if (o.tagged) {
      // The GPS tag: a little box with a blinking light.
      const on = !fin(o.now) || Math.floor((o.now ?? 0) * 2) % 2 === 0;
      rr(c, 0.18, 0.2, 0.3, 0.22, 0.05);
      fo2(o.grey ? hi : "#2a2c30");
      el(c, 0.33, 0.31, 0.06);
      c.fillStyle = on && !o.grey ? "#ff3b30" : "#5a2020";
      c.fill();
    }
  } catch {
    // never mind
  }
  c.restore();
}

/** Text in the current units (for icons). @param {CanvasRenderingContext2D} c @param {string} s @param {number} x @param {number} y @param {number} size @param {string} colour */
function label2(c, s, x, y, size, colour) {
  const t = c.getTransform();
  label(c, s, x, y, size, { font: FONTS.sans, weight: 700, colour, minPx: 0 });
  void t;
}

/** @typedef {{ x: number, y: number, icon: string, large: boolean, tagged: boolean, keep: string, empty: boolean, t: number }} LootDraw */

/** @param {SeenItem | SeenEmpty | (SeenItem & { t: number })} it @param {Catalogue} cat @param {boolean} empty @returns {LootDraw} */
function lootOf(it, cat, empty) {
  const e = cat[/** @type {any} */ (it)?.item];
  const r = /** @type {any} */ (it) ?? {};
  return { x: r.x, y: r.y, icon: e?.id ?? "bag", large: e?.size === "large", tagged: !!r.tagged, keep: r.keep ?? "loose", empty, t: fin(r.t) ? r.t : 0 };
}

/** @param {CanvasRenderingContext2D} c @param {Art} art @param {readonly LootDraw[]} loot @param {boolean} grey @param {number} now */
function drawLoot(c, art, loot, grey, now) {
  const map = art.map;
  for (const it of loot) {
    if (!it || !fin(it.x) || !fin(it.y) || it.x < 0 || it.y < 0 || it.x >= map.w || it.y >= map.h) continue;
    const x = Math.floor(it.x) + 0.5;
    const y = Math.floor(it.y) + 0.5;
    if (it.empty) {
      emptyPlace(c, it.keep, x, y);
      continue;
    }
    drawLootIcon(c, it.icon, x, y, it.large ? 0.82 : 0.62, { grey, tagged: it.tagged, now });
  }
}

/** An empty place: a dust outline, smashed glass, an open safe door. @param {CanvasRenderingContext2D} c @param {string} keep @param {number} x @param {number} y */
function emptyPlace(c, keep, x, y) {
  if (keep === "case") {
    c.beginPath();
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      c.moveTo(x + Math.cos(a) * 0.1, y + Math.sin(a) * 0.1);
      c.lineTo(x + Math.cos(a + 0.2) * 0.38, y + Math.sin(a + 0.2) * 0.38);
    }
    c.strokeStyle = "rgba(255,255,255,0.9)";
    c.lineWidth = Math.max(0.03, px(1));
    c.stroke();
    return;
  }
  if (keep === "safe") {
    c.beginPath();
    c.moveTo(x - 0.3, y + 0.32);
    c.lineTo(x - 0.3, y - 0.3);
    c.lineTo(x - 0.62, y - 0.45);
    c.lineTo(x - 0.62, y + 0.2);
    c.closePath();
    c.fillStyle = "#2c4a3c";
    c.fill();
    c.strokeStyle = P.ink;
    c.lineWidth = OUT();
    c.stroke();
    rr(c, x - 0.24, y - 0.26, 0.5, 0.52, 0.04);
    c.fillStyle = "#101512";
    c.fill();
    return;
  }
  el(c, x, y, 0.22, 0.16);
  c.setLineDash([0.06, 0.06]);
  c.strokeStyle = keep === "pedestal" ? P.ink : "rgba(30,20,10,0.6)";
  c.lineWidth = Math.max(0.035, px(1));
  c.stroke();
  c.setLineDash([]);
}

// ---------------------------------------------------------------- figures

/** How big figures are drawn (their body is 0.3 tiles; drawn bigger to read). */
const FIGURE = 1.85;

/**
 * A character from above, in tile units (call {@link useTiles} first).
 * @param {CanvasRenderingContext2D} c @param {Figure} f @param {number} [now]
 */
export function drawFigure(c, f, now = 0) {
  if (!f || !fin(f.x) || !fin(f.y)) return;
  const facing = (fin(f.facing) ? /** @type {number} */ (f.facing) : 90) * RAD;
  const frozen = f.held || f.cuffed;
  const walk = fin(f.walk) ? /** @type {number} */ (f.walk) : now * 3.5 + hash(String(f.id ?? "").length, (f.id ?? "").charCodeAt(0) || 0) * 3;
  const step = f.moving && !frozen ? Math.sin(walk * Math.PI * 1.6) : 0;
  const bob = f.moving && !frozen ? Math.abs(Math.cos(walk * Math.PI * 1.6)) * 0.02 : 0;
  const guard = f.role === "guard";
  const colour = isColour(f.colour) ? /** @type {string} */ (f.colour) : guard ? GUARD_COLOURS[0] ?? "#ffd447" : P.black;
  const lw = Math.max(0.05, px(1.5));
  c.save();
  c.globalAlpha *= clamp(fin(f.alpha) ? /** @type {number} */ (f.alpha) : 1, 0, 1);
  c.translate(f.x, f.y);
  c.scale(FIGURE, FIGURE);
  if (f.self) {
    el(c, 0, 0, 0.58);
    c.strokeStyle = rgba(guard ? colour : P.gold, 0.9);
    c.lineWidth = Math.max(0.05, px(2));
    c.setLineDash([0.16, 0.1]);
    c.lineDashOffset = -now * 0.3;
    c.stroke();
    c.setLineDash([]);
  }
  // A drop shadow.
  el(c, 0.07, 0.1, 0.37, 0.34);
  c.fillStyle = "rgba(4,4,10,0.38)";
  c.fill();
  c.rotate(facing);
  c.translate(bob, 0);
  // Feet.
  for (const s of [-1, 1]) {
    el(c, 0.04 + step * s * 0.14, s * 0.13, 0.11, 0.07);
    c.fillStyle = "#141212";
    c.fill();
  }
  const outline = () => {
    c.strokeStyle = P.ink;
    c.lineWidth = lw;
    c.stroke();
  };
  if (guard) {
    const suit = shade(colour, -0.62);
    // Arms: the right one forward with the flashlight.
    el(c, 0.05 - step * 0.08, -0.27, 0.09, 0.08);
    c.fillStyle = suit;
    c.fill();
    outline();
    rr(c, 0.18, 0.18, 0.28, 0.1, 0.03);
    c.fillStyle = "#c9cdd2";
    c.fill();
    outline();
    if (f.light) {
      el(c, 0.47, 0.23, 0.07);
      c.fillStyle = "#fff6c8";
      c.fill();
    }
    // Shoulders.
    el(c, -0.02, 0, 0.2, 0.32);
    c.fillStyle = suit;
    c.fill();
    outline();
    el(c, 0.1, 0.24, 0.09, 0.08);
    c.fillStyle = suit;
    c.fill();
    outline();
    // The bowler: brim, crown, band.
    el(c, 0, 0, 0.23);
    c.fillStyle = colour;
    c.fill();
    outline();
    el(c, -0.01, 0, 0.155);
    c.strokeStyle = "#141212";
    c.lineWidth = Math.max(0.04, px(1.2));
    c.stroke();
    el(c, -0.01, 0, 0.13);
    c.fillStyle = shade(colour, 0.18);
    c.fill();
    el(c, -0.05, -0.05, 0.05);
    c.fillStyle = "rgba(255,255,255,0.45)";
    c.fill();
  } else {
    // The sack over the shoulder, growing with the haul.
    const haul = clamp(fin(f.sack) ? /** @type {number} */ (f.sack) : 0, 0, 4);
    {
      const r = 0.1 + haul * 0.055;
      el(c, -0.22 - r * 0.6, -0.18, r, r * 0.92);
      c.fillStyle = "#c9a66b";
      c.fill();
      outline();
      if (haul > 0 && r * S > 10) label(c, "$", -0.22 - r * 0.6, -0.18, r * 1.1, { colour: "#5a3a1a", weight: 700 });
      c.beginPath();
      c.moveTo(-0.22 - r * 0.6 + r * 0.7, -0.18 + r * 0.4);
      c.lineTo(0.02, -0.18);
      c.strokeStyle = "#6b4a2a";
      c.lineWidth = Math.max(0.035, px(1));
      c.stroke();
    }
    // Arms.
    for (const s of [-1, 1]) {
      el(c, 0.04 - step * s * 0.08, s * 0.27, 0.085, 0.075);
      c.fillStyle = "#111";
      c.fill();
      outline();
    }
    // The striped jersey.
    c.save();
    el(c, -0.02, 0, 0.2, 0.3);
    c.fillStyle = "#f2ede2";
    c.fill();
    c.clip();
    c.beginPath();
    for (let y = -0.3; y < 0.32; y += 0.12) c.rect(-0.25, y, 0.5, 0.06);
    c.fillStyle = "#141212";
    c.fill();
    c.restore();
    el(c, -0.02, 0, 0.2, 0.3);
    outline();
    // The flat cap, its peak forward.
    c.beginPath();
    c.ellipse(0.1, 0, 0.13, 0.15, 0, -Math.PI / 2, Math.PI / 2);
    c.closePath();
    c.fillStyle = "#1b1a1c";
    c.fill();
    outline();
    el(c, -0.02, 0, 0.17, 0.165);
    c.fillStyle = "#2b2a2d";
    c.fill();
    outline();
    c.beginPath();
    c.moveTo(-0.14, 0);
    c.lineTo(0.08, 0);
    c.strokeStyle = "rgba(255,255,255,0.18)";
    c.lineWidth = Math.max(0.03, px(1));
    c.stroke();
  }
  c.restore();
  if (f.held && !f.holding && !guard) net(c, f.x, f.y, now);
  if (f.cuffed) cuffs(c, f.x, f.y + 0.85);
  if (f.name) label(c, f.name, f.x, f.y + 0.78, 0.24, { weight: 700, colour: guard ? colour : P.cream, halo: "rgba(6,8,16,0.92)", base: "top", minPx: 10 });
}

/** A net over a held figure. @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} now */
function net(c, x, y, now) {
  c.save();
  c.translate(x, y);
  c.scale(FIGURE, FIGURE);
  el(c, 0, 0, 0.5);
  c.save();
  c.clip();
  c.beginPath();
  for (let k = -0.6; k <= 0.6; k += 0.16) {
    c.moveTo(k - 0.6, -0.6);
    c.lineTo(k + 0.6, 0.6);
    c.moveTo(k + 0.6, -0.6);
    c.lineTo(k - 0.6, 0.6);
  }
  c.strokeStyle = "rgba(232,210,160,0.85)";
  c.lineWidth = Math.max(0.025, px(1));
  c.stroke();
  c.restore();
  el(c, 0, 0, 0.5 + Math.sin(now * 8) * 0.02);
  c.strokeStyle = P.gold;
  c.lineWidth = Math.max(0.06, px(2));
  c.stroke();
  c.restore();
}

/** Handcuffs. @param {CanvasRenderingContext2D} c @param {number} x @param {number} y */
function cuffs(c, x, y) {
  for (const dx of [-0.14, 0.14]) {
    el(c, x + dx, y, 0.12);
    c.strokeStyle = P.ink;
    c.lineWidth = Math.max(0.09, px(2.5));
    c.stroke();
    c.strokeStyle = "#d0d4d8";
    c.lineWidth = Math.max(0.05, px(1.5));
    c.stroke();
  }
}

// ---------------------------------------------------------------- the public layer

/**
 * The public layer over the blueprint (TV) or over the seen view (the
 * phone's toggle): lit rooms and lamps (`o.lights`, default true), the
 * ink as a red pencil hatch, facts in print, claims in crayon.
 * `pub`: a protocol.ts `PublicState`; `o.colors` (views.ts
 * `RoomView.colors`) and `o.names` by player id for the marks; `o.words`
 * the printed words in the page's language; `o.car`: a spot id to show
 * the getaway car on (the outcome); `o.now`: the clock (default `pub.t`).
 * Phones pass `quiet: true` (thinner, fainter, smaller) and `seen` (the
 * frame's seen mask: no ink and no labels over what one sees, but HELD).
 * @param {CanvasRenderingContext2D} c @param {Art | null} art @param {View} v @param {PublicLike | null} [pub]
 * @param {{ lights?: boolean, colors?: Readonly<Record<string, string>>, names?: Readonly<Record<string, string>>, words?: MapWords,
 *   car?: number | null, now?: number, quiet?: boolean, seen?: ArrayLike<number> | null }} [o]
 */
export function drawPublic(c, art, v, pub = {}, o = {}) {
  if (!art || !v || !(v.scale > 0) || !pub) return;
  const map = art.map;
  const n = map.w * map.h;
  const now = fin(o.now) ? /** @type {number} */ (o.now) : fin(pub.t) ? /** @type {number} */ (pub.t) : 0;
  const { facts, marks } = publicItems(art, pub, o, now);
  const seenMask = o.seen && o.seen.length >= n ? o.seen : null;
  quiet = !!o.quiet;
  hush = quiet && seenMask ? { seen: seenMask, w: map.w, h: map.h } : null;
  labelQueue = [];
  c.save();
  try {
    useTiles(c, v);
    if (o.lights !== false) {
      // Lit rooms: a warm wash on the paper.
      map.rooms.forEach((room, k) => {
        if (!room?.rect || !pub.rooms?.[k]) return;
        const q = room.rect;
        c.fillStyle = "rgba(255,214,120,0.2)";
        c.fillRect(q.x, q.y, q.w, q.h);
        c.strokeStyle = "rgba(255,214,120,0.55)";
        c.lineWidth = Math.max(0.05, px(1.2));
        c.strokeRect(q.x + 0.12, q.y + 0.12, q.w - 0.24, q.h - 0.24);
      });
      for (const l of map.lamps) {
        if (!l) continue;
        const on = pub.lamps ? !!pub.lamps[l.id] : true;
        const x = l.x + 0.5;
        const y = l.y + 0.5;
        if (on) {
          const g = c.createRadialGradient(x, y, 0, x, y, LAMP_RADIUS);
          g.addColorStop(0, "rgba(255,200,110,0.4)");
          g.addColorStop(1, "rgba(255,200,110,0)");
          c.fillStyle = g;
          el(c, x, y, LAMP_RADIUS);
          c.fill();
          el(c, x, y, 0.22);
          c.fillStyle = "#ffe7a8";
          c.fill();
        } else {
          c.beginPath();
          c.moveTo(x - 0.3, y - 0.3);
          c.lineTo(x + 0.3, y + 0.3);
          c.moveTo(x + 0.3, y - 0.3);
          c.lineTo(x - 0.3, y + 0.3);
          c.strokeStyle = "#ff8a7a";
          c.lineWidth = Math.max(0.08, px(2));
          c.stroke();
        }
      }
    }
    // The ink.
    const ink = pub.ink && pub.ink.length >= n ? pub.ink : null;
    if (ink) {
      const s = scratch(art, 2, v);
      s.fillStyle = hatch(art, s);
      s.fillRect(0, 0, s.canvas.width, s.canvas.height);
      const inside = map.roomAt;
      const spotAt = spotTiles(art);
      const mk = mask(art, "ink", 2, region(art, v), (i) => {
        const val = ink[i] ?? 0;
        if (!(val > 0) || (seenMask && seenMask[i])) return 0;
        const k = spotAt[i] ? 0.35 : inside && (inside[i] ?? -1) >= 0 ? 1 : 0.62;
        return 0xffffff00 | Math.round(clamp(val, 0.25, 1) * k * (quiet ? 0.6 : 1) * 255);
      }, null, undefined, 1);
      s.globalCompositeOperation = "destination-in";
      blitMask(s, mk, v);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 0.9;
      c.drawImage(s.canvas, 0, 0);
      c.globalAlpha = 1;
      useTiles(c, v);
    }
    // Facts under the claims; HELD last of all.
    for (const f of facts) if (f && f.kind !== "held") drawFact(c, art, v, f, now);
    for (const mk of marks) if (mk) drawMark(c, art, v, mk, now);
    for (const f of facts) if (f && f.kind === "held") drawFact(c, art, v, f, now);
    useTiles(c, v);
    paperObstacles(c, art);
    const labels = labelQueue;
    labelQueue = null;
    // The map on screen, within the canvas.
    const k = v.scale * v.dpr;
    const bounds = {
      x0: Math.max(0, -v.left * k),
      y0: Math.max(0, -v.top * k),
      x1: Math.min(c.canvas.width, (map.w - v.left) * k),
      y1: Math.min(c.canvas.height, (map.h - v.top) * k),
    };
    const avoid = hush
      ? (/** @type {number} */ px, /** @type {number} */ py) => hushed(v.left + px / k, v.top + py / k)
      : null;
    placeLabels(c, labels, bounds, avoid);
  } catch {
    // odd data
  }
  labelQueue = null;
  quiet = false;
  hush = null;
  c.restore();
}

/**
 * A fact as drawn: `age` seconds since it happened; `label` the printed word.
 * @typedef {{ kind: "noise" | "sighting" | "static" | "held" | "ping" | "alarm" | "missing" | "arrest" | "car",
 *   age?: number, x?: number, y?: number, facing?: number, camera?: number, room?: number, spot?: number,
 *   left?: number, total?: number, r?: number, label?: string }} Fact
 */
/**
 * A claim as drawn.
 * @typedef {{ kind: string, x: number, y: number, angle?: number, room?: number, area?: number,
 *   colour?: string, name?: string, age?: number, label?: string }} Mark
 */

const WORDS = /** @type {Required<MapWords>} */ ({
  glass: "CRASH", lamp: "SMASH", firecracker: "BANG", alarm: "ALARM", held: "HELD", ping: "GPS PING", missing: "MISSING",
  pinched: "PINCHED", gotAway: "GOT AWAY", static: "STATIC", camera: "CAMERA", clear: "CLEAR", seen: "SEEN", post: "POST", look: "LOOK",
});
/** How long a camera's sighting lingers after it stopped seeing (s). */
const SIGHTING_SHOW = 6;

/**
 * The public layer's facts and marks as drawn. Remembers the cameras'
 * last sightings (the figure lingers a few seconds after).
 * @param {Art} art @param {PublicLike} pub @param {{ colors?: Readonly<Record<string, string>>, names?: Readonly<Record<string, string>>, words?: MapWords, car?: number | null }} o @param {number} now
 */
function publicItems(art, pub, o, now) {
  const W = { ...WORDS, ...(o.words ?? {}) };
  /** @type {Fact[]} */
  const facts = [];
  const list = (/** @type {unknown} */ a) => (Array.isArray(a) ? a : []);
  for (const nz of list(pub.noises)) {
    if (!nz || !fin(nz.x) || !fin(nz.y)) continue;
    facts.push({ kind: "noise", x: nz.x, y: nz.y, age: now - (nz.t ?? now), label: W[/** @type {keyof MapWords} */ (nz.kind)] ?? "NOISE" });
  }
  for (const cam of list(pub.cameras)) {
    if (!cam || !art.map.cameras[cam.id]) continue;
    if (cam.tampered) facts.push({ kind: "static", camera: cam.id, label: W.static });
    const seen = cam.sees;
    if (seen && fin(seen.x) && fin(seen.y)) {
      const last = art.sightings.get(cam.id);
      art.sightings.set(cam.id, { x: seen.x, y: seen.y, facing: seen.facing, t: now, since: last && now - last.t < 1 ? last.since : now });
    }
  }
  for (const [id, sg] of art.sightings) {
    const age = now - sg.t;
    if (age > SIGHTING_SHOW || age < -1) {
      art.sightings.delete(id);
      continue;
    }
    facts.push({ kind: "sighting", camera: id, x: sg.x, y: sg.y, facing: sg.facing, age: Math.max(0, now - sg.since), r: age, label: `${W.camera} ${id + 1}` });
  }
  if (pub.alarm && fin(pub.alarm.room)) facts.push({ kind: "alarm", room: pub.alarm.room, age: now - pub.alarm.t, label: W.alarm });
  for (const m of list(pub.missing)) if (m && fin(m.x)) facts.push({ kind: "missing", x: Math.floor(m.x) + 0.5, y: Math.floor(m.y) + 0.5, age: now - m.t, label: W.missing });
  for (const p of list(pub.pings)) if (p && fin(p.x)) facts.push({ kind: "ping", x: p.x, y: p.y, r: p.r, age: now - p.t, label: W.ping });
  for (const h of list(pub.holds)) if (h && fin(h.x)) facts.push({ kind: "held", x: h.x, y: h.y, left: h.until - now, total: h.total, label: W.held });
  if (pub.arrest && fin(pub.arrest.x)) facts.push({ kind: "arrest", x: pub.arrest.x, y: pub.arrest.y, age: now - pub.arrest.t, label: W.pinched });
  if (fin(o.car)) facts.push({ kind: "car", spot: /** @type {number} */ (o.car), label: W.gotAway });
  /** @type {Mark[]} */
  const marks = [];
  for (const mk of list(pub.marks)) {
    if (!mk || !fin(mk.x) || !fin(mk.y)) continue;
    const w = /** @type {any} */ (mk.where) ?? {};
    marks.push({
      kind: mk.kind,
      x: mk.x,
      y: mk.y,
      angle: mk.angle,
      room: fin(w.room) ? w.room : -1,
      area: fin(w.area) ? w.area : -1,
      colour: o.colors?.[mk.guard],
      name: o.names?.[mk.guard],
      age: now - mk.t,
      label: W[/** @type {keyof MapWords} */ (mk.kind)],
    });
  }
  return { facts, marks };
}

/** 1 on parking spot tiles (the ink thins there so the P reads). @param {Art} art */
function spotTiles(art) {
  if (!art.spotAt) {
    const m = new Uint8Array(art.map.w * art.map.h);
    for (const sp of art.map.spots) {
      const r = sp?.rect;
      if (!r) continue;
      for (let y = Math.max(0, r.y); y < Math.min(art.map.h, r.y + r.h); y++) for (let x = Math.max(0, r.x); x < Math.min(art.map.w, r.x + r.w); x++) m[y * art.map.w + x] = 1;
    }
    art.spotAt = m;
  }
  return art.spotAt;
}

/** The red pencil hatch, a pattern in device px. @param {Art} art @param {CanvasRenderingContext2D} c */
function hatch(art, c) {
  if (!art.hatch) {
    const size = 48;
    const cv = canvas(size, size);
    const h = ctx2d(cv);
    h.lineCap = "round";
    for (let k = -2; k < 6; k++) {
      for (let pass = 0; pass < 2; pass++) {
        h.beginPath();
        const o = k * 12 + pass * 1.2;
        h.moveTo(o - 2, size + 2);
        h.lineTo(o + size + 2, -2);
        h.strokeStyle = pass ? "rgba(229,72,60,0.55)" : "rgba(255,110,90,0.75)";
        h.lineWidth = pass ? 1.2 : 2.2;
        h.stroke();
      }
    }
    art.hatch = cv;
  }
  return /** @type {CanvasPattern} */ (c.createPattern(art.hatch, "repeat"));
}

/** Static noise for a tampered camera. @param {Art} art */
function noise(art) {
  if (!art.noise) {
    const size = 64;
    const cv = canvas(size, size);
    const h = ctx2d(cv);
    const img = h.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const v = hash(i, 3) < 0.5 ? 30 : 230;
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = Math.round(hash(i, 7) * 200);
    }
    h.putImageData(img, 0, 0);
    art.noise = cv;
  }
  return art.noise;
}

/** The label size for map text in CSS px. @param {View} v */
const tagPx = (v) => clamp(v.scale * 0.55, 13, 20) * v.dpr;

/**
 * A label waiting for its place: its anchor and preferred centre (device
 * px), its size, how it draws itself at a centre, and its priority (0 first).
 * `weight`: how much overlapping it costs (obstacles less than labels).
 * @typedef {{ ax: number, ay: number, px: number, py: number, w: number, h: number, prio: number, alpha: number,
 *   skip: boolean, weight?: number, draw: (c: CanvasRenderingContext2D, x: number, y: number) => void }} Label
 */

/** Labels gathered by {@link drawPublic} for placement; null: draw at once. @type {Label[] | null} */
let labelQueue = null;
/** The public layer's quiet mode (phones): labels smaller and fainter. */
let quiet = false;
/** Tiles whose labels are left out (the phone's seen area), or null. @type {{ seen: ArrayLike<number>, w: number, h: number } | null} */
let hush = null;

/** @param {Label} l */
function emit(l) {
  if (labelQueue) labelQueue.push(l);
  else if (!l.skip) l.draw(ctxNow, l.px, l.py);
}
/** The context labels draw into (set by printTag / crayonText). @type {CanvasRenderingContext2D} */
let ctxNow = /** @type {any} */ (null);

/** Is the tile under (x, y) hushed (seen by this phone)? @param {number} x @param {number} y */
function hushed(x, y) {
  if (!hush || !fin(x) || !fin(y)) return false;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  return tx >= 0 && ty >= 0 && tx < hush.w && ty < hush.h && !!hush.seen[ty * hush.w + tx];
}

/**
 * Places the gathered labels: by priority, each at the cheapest of a few
 * spots round its preferred one: overlapping placed labels costs most,
 * obstacles (room names, P spots, the HELD ring) less, leaving `bounds`
 * (the map on screen) a lot; candidates lean inward. A thin leader
 * joins a label that moved far to its place.
 * `avoid(x, y)`: whether a device px point should stay clear (the phone's seen area).
 * @param {CanvasRenderingContext2D} c @param {Label[]} labels @param {{ x0: number, y0: number, x1: number, y1: number }} bounds
 * @param {((x: number, y: number) => boolean) | null} [avoid]
 */
function placeLabels(c, labels, bounds, avoid) {
  /** @type {{ x: number, y: number, w: number, h: number, k: number }[]} */
  const placed = [];
  const cost = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w, /** @type {number} */ h) => {
    let o = 0;
    for (const r of placed) {
      const ox = Math.min(x + w / 2, r.x + r.w / 2) - Math.max(x - w / 2, r.x - r.w / 2);
      const oy = Math.min(y + h / 2, r.y + r.h / 2) - Math.max(y - h / 2, r.y - r.h / 2);
      if (ox > 0 && oy > 0) o += ox * oy * r.k;
    }
    const inX = Math.max(0, Math.min(x + w / 2, bounds.x1) - Math.max(x - w / 2, bounds.x0));
    const inY = Math.max(0, Math.min(y + h / 2, bounds.y1) - Math.max(y - h / 2, bounds.y0));
    let a = 0;
    if (avoid) {
      for (const fx of [-0.5, 0, 0.5]) for (const fy of [-0.5, 0.5]) if (avoid(x + fx * w, y + fy * h)) a++;
    }
    return o + (w * h - inX * inY) * 3 + (a / 6) * w * h * 1.5;
  };
  const cx = (bounds.x0 + bounds.x1) / 2;
  const cy = (bounds.y0 + bounds.y1) / 2;
  for (const l of [...labels].sort((a, b) => a.prio - b.prio)) {
    if (l.skip) continue;
    // Phones: a label whose place is off screen is left out.
    if (avoid && l.prio >= 0 && (l.ax < 0 || l.ay < 0 || l.ax > c.canvas.width || l.ay > c.canvas.height)) continue;
    if (l.prio < 0) {
      placed.push({ x: l.px, y: l.py, w: l.w, h: l.h, k: l.weight ?? 1 });
      continue;
    }
    const g = l.h * 1.15;
    const sx = l.w * 0.6 + 6;
    // Inward: towards the middle of the map on screen.
    const dx = cx - l.px;
    const dy = cy - l.py;
    const d = Math.hypot(dx, dy) || 1;
    const ix = dx / d;
    const iy = dy / d;
    /** @type {[number, number][]} */
    const cands = [[l.px, l.py]];
    for (let k = 1; k <= 5; k++) cands.push([l.px + ix * k * g, l.py + iy * k * g]);
    for (const fy of [0, -1, 1, -2, 2, -3, 3, 4, -4]) {
      for (const fx of [0, 1, -1, 2, -2]) if (fx || fy) cands.push([l.px + fx * sx, l.py + fy * g]);
    }
    let best = cands[0] ?? [l.px, l.py];
    let bestC = Infinity;
    for (const [x, y] of cands) {
      // A little for moving away, so ties stay close.
      const cst = cost(x, y, l.w, l.h) + (Math.hypot(x - l.px, y - l.py) / l.h) * l.w * l.h * 0.04;
      if (cst < bestC - 1e-6) {
        bestC = cst;
        best = [x, y];
      }
      if (cst === 0) break;
    }
    const [x, y] = best;
    if (Math.hypot(x - l.px, y - l.py) > l.h * 0.9) {
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = l.alpha * 0.8;
      c.beginPath();
      c.moveTo(l.ax, l.ay);
      c.lineTo(x, y);
      c.strokeStyle = "rgba(244,236,214,0.85)";
      c.lineWidth = Math.max(1, l.h * 0.06);
      c.setLineDash([l.h * 0.15, l.h * 0.12]);
      c.stroke();
      c.restore();
    }
    l.draw(c, x, y);
    placed.push({ x, y, w: l.w, h: l.h, k: 1 });
  }
}

/** Keeps labels off a disc (tiles). @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} r @param {number} [weight] */
function obstacle(c, x, y, r, weight = 1) {
  const t = c.getTransform();
  const d = 2 * r * t.a;
  emit({ ax: 0, ay: 0, px: t.a * x + t.e, py: t.d * y + t.f, w: d * 0.8, h: d * 0.8, prio: -1, alpha: 0, skip: false, weight, draw() {} });
}

/**
 * Keeps labels off the blueprint's own lettering: the room names and the P spots.
 * @param {CanvasRenderingContext2D} c @param {Art} art
 */
function paperObstacles(c, art) {
  const t = c.getTransform();
  const k = t.a;
  /** @param {number} x @param {number} y @param {number} w @param {number} h @param {number} weight */
  const box = (x, y, w, h, weight) =>
    emit({ ax: 0, ay: 0, px: k * (x + w / 2) + t.e, py: t.d * (y + h / 2) + t.f, w: w * k, h: h * t.d, prio: -1, alpha: 0, skip: false, weight, draw() {} });
  for (const b of nameBoxes(art, c)) if (b.size * k >= 5.5) box(b.x, b.y, b.w, b.h, 0.6);
  for (const sp of art.map.spots) if (sp?.rect) box(sp.rect.x, sp.rect.y, sp.rect.w, sp.rect.h, 0.8);
}

/**
 * A printed tag: cream paper, black typewriter text, at a tile point.
 * @param {CanvasRenderingContext2D} c @param {View} v @param {string} s @param {number} x @param {number} y
 * @param {{ dy?: number, invert?: boolean, colour?: string, alpha?: number, font?: string, size?: number, prio?: number, keep?: boolean }} [o]
 */
function printTag(c, v, s, x, y, o = {}) {
  if (!s) return;
  ctxNow = c;
  const t = c.getTransform();
  const ax = t.a * x + t.e;
  const ay = t.d * y + t.f;
  const fs = (o.size ?? 1) * tagPx(v) * (quiet ? 0.82 : 1);
  const alpha = (o.alpha ?? 1) * (quiet ? 0.8 : 1);
  c.save();
  c.font = `700 ${fs.toFixed(1)}px ${o.font ?? FONTS.type}`;
  const w = c.measureText(s).width + fs * 0.8;
  c.restore();
  const h = fs * 1.35;
  emit({
    ax,
    ay,
    px: ax,
    py: ay + (o.dy ?? 0) * v.dpr,
    w,
    h,
    prio: o.prio ?? 5,
    alpha,
    skip: !o.keep && hushed(x, y),
    draw(cc, sx, sy) {
      cc.save();
      cc.setTransform(1, 0, 0, 1, 0, 0);
      cc.globalAlpha = alpha;
      cc.font = `700 ${fs.toFixed(1)}px ${o.font ?? FONTS.type}`;
      cc.fillStyle = o.invert ? "#111" : "#f4ecd6";
      cc.fillRect(sx - w / 2, sy - h / 2, w, h);
      cc.strokeStyle = o.colour ?? "#111";
      cc.lineWidth = Math.max(1, fs * 0.09);
      cc.strokeRect(sx - w / 2, sy - h / 2, w, h);
      cc.fillStyle = o.colour ?? (o.invert ? P.gold : "#111");
      cc.textAlign = "center";
      cc.textBaseline = "middle";
      cc.fillText(s, sx, sy + fs * 0.05);
      cc.restore();
    },
  });
}

/** @param {number} s */
function clock(s) {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** @param {CanvasRenderingContext2D} c @param {Art} art @param {View} v @param {Fact} f @param {number} now */
function drawFact(c, art, v, f, now) {
  const map = art.map;
  const age = fin(f.age) ? Math.max(0, /** @type {number} */ (f.age)) : 0;
  const x = fin(f.x) ? /** @type {number} */ (f.x) : NaN;
  const y = fin(f.y) ? /** @type {number} */ (f.y) : NaN;
  switch (f.kind) {
    case "noise": {
      if (!fin(x) || age > 4) return;
      const fade = clamp(1 - age / 4, 0, 1);
      for (let k = 0; k < 3; k++) {
        const r = ((age * 2.2 + k * 1.1) % 3.3) + 0.4;
        el(c, x, y, r);
        c.strokeStyle = `rgba(250,240,215,${(fade * (1 - r / 3.7)).toFixed(3)})`;
        c.lineWidth = Math.max(0.12, px(2.5));
        c.setLineDash([0.3, 0.2]);
        c.stroke();
      }
      c.setLineDash([]);
      printTag(c, v, f.label ?? "NOISE", x, y, { alpha: 0.55 + 0.45 * fade, prio: 4 });
      return;
    }
    case "sighting": {
      // `age`: since the camera started seeing; `r`: since it last saw.
      const cam = map.cameras[f.camera ?? -1];
      const gone = fin(f.r) ? Math.max(0, /** @type {number} */ (f.r)) : 0;
      const fade = gone < 0.3 ? 1 : clamp(1 - gone / SIGHTING_SHOW, 0, 1);
      if (cam) {
        const flash = gone < 0.3 ? (age < 1.5 ? 0.55 * (1 - age / 1.5) : 0) + 0.18 + 0.12 * (Math.floor(now * 6) % 2) : 0.1 * fade;
        const tone = quiet ? "255,236,160" : "255,255,240";
        cameraCone(c, cam, `rgba(${tone},${(flash * (quiet ? 0.45 : 1)).toFixed(3)})`, `rgba(${tone},${(0.9 * fade * (quiet ? 0.5 : 1)).toFixed(3)})`, false);
        cameraBody(c, cam, false, gone < 0.3 && Math.floor(now * 4) % 2 ? "#ff3b30" : "#ffe08a");
      }
      if (fin(x) && fade > 0) {
        drawFigure(c, { role: "thief", x, y, facing: f.facing ?? 90, alpha: Math.max(0.2, fade * 0.92) }, now);
        printTag(c, v, f.label ?? (cam ? `CAMERA ${cam.id + 1}` : "CAMERA"), x, y, { dy: (-tagPx(v) / v.dpr) * 1.7, alpha: Math.max(0.3, fade), prio: 2 });
      }
      return;
    }
    case "static": {
      const cam = map.cameras[f.camera ?? -1];
      if (!cam) return;
      c.save();
      const pat = c.createPattern(noise(art), "repeat");
      if (pat) {
        pat.setTransform(new DOMMatrix([1 / S, 0, 0, 1 / S, hash(Math.floor(now * 12)) * 3, hash(Math.floor(now * 12), 1) * 3]));
        cameraCone(c, cam, pat, "rgba(255,255,255,0.6)", true);
      }
      c.restore();
      cameraBody(c, cam, false, "#333");
      printTag(c, v, f.label ?? "STATIC", cam.x + 0.5, cam.y + 0.5, { dy: (tagPx(v) / v.dpr) * 1.4, invert: true, prio: 6 });
      return;
    }
    case "held": {
      if (!fin(x)) return;
      const total = fin(f.total) && /** @type {number} */ (f.total) > 0 ? /** @type {number} */ (f.total) : 10;
      const left = clamp(fin(f.left) ? /** @type {number} */ (f.left) : 0, 0, total);
      const r = 1.3;
      const pulse = 1 + Math.sin(now * 6) * 0.04;
      el(c, x, y, r * pulse);
      c.fillStyle = "rgba(10,10,10,0.18)";
      c.fill();
      c.strokeStyle = "#111";
      c.lineWidth = Math.max(0.3, px(7));
      c.stroke();
      c.beginPath();
      c.arc(x, y, r * pulse, -Math.PI / 2, -Math.PI / 2 + (left / total) * Math.PI * 2);
      c.strokeStyle = P.gold;
      c.lineWidth = Math.max(0.2, px(4.5));
      c.lineCap = "butt";
      c.stroke();
      c.lineCap = "round";
      // Ticks: a stepped Deco ring.
      c.beginPath();
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        c.moveTo(x + Math.cos(a) * (r + 0.28), y + Math.sin(a) * (r + 0.28));
        c.lineTo(x + Math.cos(a) * (r + 0.45), y + Math.sin(a) * (r + 0.45));
      }
      c.strokeStyle = P.goldLight;
      c.lineWidth = Math.max(0.06, px(1.5));
      c.stroke();
      obstacle(c, x, y, r + 0.5);
      printTag(c, v, `${f.label ?? "HELD"} ${clock(left)}`, x, y - r - 0.5, {
        dy: (-tagPx(v) / v.dpr) * 0.6,
        invert: true,
        font: FONTS.display,
        size: 1.35,
        colour: P.gold,
        prio: 0,
        keep: true,
      });
      return;
    }
    case "ping": {
      if (!fin(x)) return;
      const rad = fin(f.r) ? clamp(/** @type {number} */ (f.r), 0.5, 12) : 3;
      const fade = clamp(1 - age / 8, 0.2, 1);
      el(c, x, y, rad);
      c.fillStyle = `rgba(120,255,190,${(0.12 * fade).toFixed(3)})`;
      c.fill();
      c.strokeStyle = `rgba(120,255,190,${(0.9 * fade).toFixed(3)})`;
      c.lineWidth = Math.max(0.06, px(1.5));
      c.setLineDash([0.25, 0.15]);
      c.stroke();
      c.setLineDash([]);
      if (age < 3) {
        el(c, x, y, rad * (age / 3) * 1.3);
        c.strokeStyle = `rgba(120,255,190,${(1 - age / 3).toFixed(3)})`;
        c.lineWidth = Math.max(0.1, px(2.5));
        c.stroke();
      }
      c.beginPath();
      c.moveTo(x - 0.4, y);
      c.lineTo(x + 0.4, y);
      c.moveTo(x, y - 0.4);
      c.lineTo(x, y + 0.4);
      c.strokeStyle = `rgba(120,255,190,${fade.toFixed(3)})`;
      c.stroke();
      printTag(c, v, f.label ?? "GPS PING", x, y + rad, { alpha: fade, colour: "#0b5d3a", prio: 3 });
      return;
    }
    case "alarm": {
      const room = map.rooms[f.room ?? -1];
      if (!room) return;
      const q = room.rect;
      const blink = Math.floor(now * 3) % 2 === 0;
      c.fillStyle = blink ? "rgba(255,50,40,0.28)" : "rgba(255,50,40,0.1)";
      c.fillRect(q.x, q.y, q.w, q.h);
      c.strokeStyle = "#ff4a3a";
      c.lineWidth = Math.max(0.12, px(3));
      c.strokeRect(q.x - 0.1, q.y - 0.1, q.w + 0.2, q.h + 0.2);
      bell(c, q.x + q.w / 2, q.y + q.h / 2, Math.min(1.4, Math.min(q.w, q.h) * 0.35), now);
      printTag(c, v, f.label ?? "ALARM", q.x + q.w / 2, q.y + q.h / 2 + 1.1, { invert: true, colour: "#ff4a3a", prio: 1, keep: true });
      return;
    }
    case "missing": {
      if (!fin(x)) return;
      c.beginPath();
      c.moveTo(x - 0.35, y - 0.35);
      c.lineTo(x + 0.35, y + 0.35);
      c.moveTo(x + 0.35, y - 0.35);
      c.lineTo(x - 0.35, y + 0.35);
      c.strokeStyle = "#111";
      c.lineWidth = Math.max(0.2, px(5));
      c.stroke();
      c.strokeStyle = "#f4ecd6";
      c.lineWidth = Math.max(0.1, px(2.5));
      c.stroke();
      printTag(c, v, f.label ?? "MISSING", x, y, { dy: (tagPx(v) / v.dpr) * 1.3, prio: 5 });
      return;
    }
    case "arrest": {
      if (!fin(x)) return;
      cuffs(c, x, y);
      printTag(c, v, f.label ?? "PINCHED", x, y, { dy: (-tagPx(v) / v.dpr) * 1.5, invert: true, font: FONTS.display, size: 1.4, colour: P.gold, prio: 0, keep: true });
      return;
    }
    case "car": {
      const s = map.spots[f.spot ?? -1];
      if (!s) return;
      const q = s.rect;
      c.save();
      if (q.h > q.w) {
        c.translate(q.x + q.w, q.y);
        c.rotate(Math.PI / 2);
        car(c, { bp: false, shadow: false, lod: 1 }, q.h, q.w, 0.05);
      } else {
        c.translate(q.x, q.y);
        car(c, { bp: false, shadow: false, lod: 1 }, q.w, q.h, 0.05);
      }
      c.restore();
      printTag(c, v, f.label ?? "GOT AWAY", q.x + q.w / 2, q.y + q.h / 2, { dy: (-tagPx(v) / v.dpr) * 1.6, invert: true, font: FONTS.display, size: 1.4, colour: P.gold, prio: 0, keep: true });
      return;
    }
    default:
  }
}

/** A ringing bell. @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} s @param {number} now */
function bell(c, x, y, s, now) {
  c.save();
  c.translate(x, y);
  c.rotate(Math.sin(now * 18) * 0.25);
  c.scale(s, s);
  c.beginPath();
  c.moveTo(-0.45, 0.3);
  c.bezierCurveTo(-0.35, 0.2, -0.4, -0.45, 0, -0.45);
  c.bezierCurveTo(0.4, -0.45, 0.35, 0.2, 0.45, 0.3);
  c.closePath();
  c.fillStyle = P.gold;
  c.fill();
  c.strokeStyle = P.ink;
  c.lineWidth = 0.08;
  c.stroke();
  el(c, 0, 0.36, 0.1);
  c.fillStyle = P.ink;
  c.fill();
  c.restore();
}

// ---------------------------------------------------------------- claims in crayon

/**
 * A crayon stroke: the path drawn a few times with wobble and grain.
 * @param {CanvasRenderingContext2D} c @param {[number, number][]} pts @param {string} colour @param {number} w @param {number} seed @param {boolean} [closed]
 */
function crayon(c, pts, colour, w, seed, closed = false) {
  if (pts.length < 2) return;
  for (let pass = 0; pass < 3; pass++) {
    c.beginPath();
    pts.forEach(([x, y], k) => {
      const jx = (hash(seed, k, pass) - 0.5) * w * 0.7;
      const jy = (hash(k, seed, pass + 5) - 0.5) * w * 0.7;
      if (k === 0) c.moveTo(x + jx, y + jy);
      else c.lineTo(x + jx, y + jy);
    });
    if (closed) c.closePath();
    c.strokeStyle = pass === 0 ? rgba(shade(colour, -0.35), 0.55) : rgba(colour, pass === 1 ? 0.9 : 0.55);
    c.lineWidth = pass === 0 ? w * 1.25 : w * (pass === 1 ? 0.9 : 0.5);
    if (pass === 2) c.setLineDash([w * 0.9, w * 0.5]);
    c.stroke();
    c.setLineDash([]);
  }
}

/**
 * A crayon label in screen px: the word and the name (and the age).
 * @param {CanvasRenderingContext2D} c @param {View} v @param {string} s @param {number} x @param {number} y @param {string} colour @param {number} dy
 */
function crayonText(c, v, s, x, y, colour, dy) {
  ctxNow = c;
  const t = c.getTransform();
  const ax = t.a * x + t.e;
  const ay = t.d * y + t.f;
  const fs = tagPx(v) * (quiet ? 0.85 : 1.05);
  c.save();
  c.font = `700 ${fs.toFixed(1)}px ${FONTS.sans}`;
  const w = c.measureText(s).width + fs * 0.3;
  c.restore();
  const alpha = c.globalAlpha * (quiet ? 0.75 : 1);
  emit({
    ax,
    ay,
    px: ax,
    py: ay + dy * v.dpr,
    w,
    h: fs * 1.2,
    prio: 8,
    alpha,
    skip: hushed(x, y),
    draw(cc, sx, sy) {
      cc.save();
      cc.setTransform(1, 0, 0, 1, 0, 0);
      cc.globalAlpha = alpha;
      cc.font = `700 ${fs.toFixed(1)}px ${FONTS.sans}`;
      cc.textAlign = "center";
      cc.textBaseline = "middle";
      cc.strokeStyle = "rgba(8,16,32,0.85)";
      cc.lineWidth = fs * 0.28;
      cc.lineJoin = "round";
      cc.strokeText(s, sx, sy);
      cc.fillStyle = colour;
      cc.fillText(s, sx, sy);
      cc.restore();
    },
  });
}

const MARK_WORDS = /** @type {Record<string, string>} */ ({ clear: "CLEAR", seen: "SEEN", post: "POST", look: "LOOK" });

/** @param {CanvasRenderingContext2D} c @param {Art} art @param {View} v @param {Mark} mk @param {number} now */
function drawMark(c, art, v, mk, now) {
  const map = art.map;
  if (!fin(mk.x) || !fin(mk.y)) return;
  const colour = isColour(mk.colour) ? /** @type {string} */ (mk.colour) : GUARD_COLOURS[0] ?? "#ffd447";
  const age = fin(mk.age) ? Math.max(0, /** @type {number} */ (mk.age)) : 0;
  const seed = Math.floor(mk.x * 31 + mk.y * 17) + mk.kind.length;
  const w = quiet ? Math.max(0.1, px(2.5)) : Math.max(0.16, px(4));
  c.save();
  c.globalAlpha *= clamp(1 - (age / 90) * 0.65, 0.3, 1) * (quiet ? 0.7 : 1);
  const x = mk.x;
  const y = mk.y;
  let text = `${mk.label ?? MARK_WORDS[mk.kind] ?? ""}${mk.name ? ` · ${mk.name}` : ""}`;
  if (age >= 1) text += ` ${clock(age)}`;
  let ty = y;
  switch (mk.kind) {
    case "clear": {
      const q = map.rooms[mk.room ?? -1]?.rect ?? map.areas[mk.area ?? -1]?.rect;
      if (q) {
        const pts = /** @type {[number, number][]} */ ([
          [q.x + 0.3, q.y + 0.35], [q.x + q.w - 0.3, q.y + 0.25], [q.x + q.w - 0.25, q.y + q.h - 0.3], [q.x + 0.35, q.y + q.h - 0.25], [q.x + 0.25, q.y + 0.5],
        ]);
        crayon(c, pts, colour, w * 0.8, seed, false);
        // A wash of light hatching.
        c.save();
        c.beginPath();
        c.rect(q.x, q.y, q.w, q.h);
        c.clip();
        c.beginPath();
        for (let d = -q.h; d < q.w; d += 0.9) {
          c.moveTo(q.x + d, q.y + q.h);
          c.lineTo(q.x + d + q.h, q.y);
        }
        c.strokeStyle = rgba(colour, 0.16);
        c.lineWidth = w * 0.6;
        c.stroke();
        c.restore();
      }
      crayon(c, [[x - 0.6, y], [x - 0.15, y + 0.5], [x + 0.75, y - 0.65]], colour, w * 1.3, seed + 1);
      ty = y + 0.6;
      break;
    }
    case "seen": {
      const a = (fin(mk.angle) ? /** @type {number} */ (mk.angle) : 0) * RAD;
      crayon(c, [[x - 0.35, y - 0.35], [x + 0.35, y + 0.35]], colour, w, seed);
      crayon(c, [[x + 0.35, y - 0.35], [x - 0.35, y + 0.35]], colour, w, seed + 1);
      const ex = x + Math.cos(a) * 2.6;
      const ey = y + Math.sin(a) * 2.6;
      crayon(c, [[x + Math.cos(a) * 0.6, y + Math.sin(a) * 0.6], [x + Math.cos(a) * 1.6 + Math.sin(a) * 0.15, y + Math.sin(a) * 1.6 - Math.cos(a) * 0.15], [ex, ey]], colour, w, seed + 2);
      crayon(c, [[ex - Math.cos(a - 0.5) * 0.7, ey - Math.sin(a - 0.5) * 0.7], [ex, ey], [ex - Math.cos(a + 0.5) * 0.7, ey - Math.sin(a + 0.5) * 0.7]], colour, w, seed + 3);
      ty = y + 0.5;
      break;
    }
    case "post": {
      crayon(c, [[x, y + 0.5], [x, y - 1.1]], colour, w, seed);
      crayon(c, [[x, y - 1.1], [x + 0.85, y - 0.8], [x, y - 0.5]], colour, w, seed + 1, true);
      c.beginPath();
      c.moveTo(x, y - 1.1);
      c.lineTo(x + 0.85, y - 0.8);
      c.lineTo(x, y - 0.5);
      c.closePath();
      c.fillStyle = rgba(colour, 0.45);
      c.fill();
      crayon(c, [[x - 0.5, y + 0.5], [x + 0.5, y + 0.5]], colour, w, seed + 2);
      ty = y + 0.65;
      break;
    }
    case "look": {
      const pulse = 1 + 0.06 * Math.sin(now * 5);
      /** @type {[number, number][]} */
      const ring = [];
      for (let k = 0; k <= 14; k++) {
        const a = (k / 13) * Math.PI * 2 - 0.4;
        ring.push([x + Math.cos(a) * 0.9 * pulse, y + Math.sin(a) * 0.9 * pulse]);
      }
      crayon(c, ring, colour, w, seed);
      crayon(c, [[x, y - 0.5], [x, y + 0.1]], colour, w * 1.2, seed + 1);
      crayon(c, [[x, y + 0.36], [x, y + 0.4]], colour, w * 1.4, seed + 2);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        crayon(c, [[x + Math.cos(a) * 1.15, y + Math.sin(a) * 1.15], [x + Math.cos(a) * 1.45, y + Math.sin(a) * 1.45]], colour, w * 0.7, seed + 3 + k);
      }
      ty = y + 1.3;
      break;
    }
    default:
  }
  obstacle(c, x, y, mk.kind === "seen" ? 0.9 : 1.1, 0.5);
  crayonText(c, v, text, x, ty, colour, (tagPx(v) / v.dpr) * 0.8);
  c.restore();
}

// ---------------------------------------------------------------- the tape

/**
 * A path on the tape: a line through points (tiles), fading towards its
 * start; `dashed` for guards.
 * @param {CanvasRenderingContext2D} c @param {readonly (readonly [number, number])[]} pts @param {string} colour @param {{ dashed?: boolean, width?: number }} [o]
 */
export function drawTrail(c, pts, colour, o = {}) {
  if (!Array.isArray(pts) || pts.length < 2) return;
  const w = o.width ?? Math.max(0.12, px(3));
  const n = pts.length;
  const seg = Math.max(1, Math.floor(n / 12));
  for (let k = 0; k < n - 1; k += seg) {
    c.beginPath();
    for (let j = k; j <= Math.min(n - 1, k + seg); j++) {
      const p = pts[j];
      if (!p || !fin(p[0]) || !fin(p[1])) continue;
      if (j === k) c.moveTo(p[0], p[1]);
      else c.lineTo(p[0], p[1]);
    }
    c.strokeStyle = rgba(colour, 0.25 + 0.75 * (k / n));
    c.lineWidth = w;
    c.setLineDash(o.dashed ? [w * 2, w * 1.5] : []);
    c.stroke();
  }
  c.setLineDash([]);
}

// ---------------------------------------------------------------- Deco chrome on a canvas

/**
 * A black card with a gold stepped frame (the intertitle's look), in the
 * current units; text is the caller's.
 * @param {CanvasRenderingContext2D} c @param {number} x @param {number} y @param {number} w @param {number} h @param {number} [u] the step size
 */
export function decoCard(c, x, y, w, h, u = Math.min(w, h) * 0.03) {
  if (![x, y, w, h, u].every(fin) || w <= 0 || h <= 0) return;
  c.save();
  c.fillStyle = "#0d0c0e";
  c.fillRect(x, y, w, h);
  const step = (/** @type {number} */ i, /** @type {number} */ s) => {
    const a = x + i;
    const b = y + i;
    const W = w - 2 * i;
    const H = h - 2 * i;
    c.beginPath();
    c.moveTo(a + s * 2, b);
    c.lineTo(a + W - s * 2, b);
    c.lineTo(a + W - s * 2, b + s);
    c.lineTo(a + W - s, b + s);
    c.lineTo(a + W - s, b + s * 2);
    c.lineTo(a + W, b + s * 2);
    c.lineTo(a + W, b + H - s * 2);
    c.lineTo(a + W - s, b + H - s * 2);
    c.lineTo(a + W - s, b + H - s);
    c.lineTo(a + W - s * 2, b + H - s);
    c.lineTo(a + W - s * 2, b + H);
    c.lineTo(a + s * 2, b + H);
    c.lineTo(a + s * 2, b + H - s);
    c.lineTo(a + s, b + H - s);
    c.lineTo(a + s, b + H - s * 2);
    c.lineTo(a, b + H - s * 2);
    c.lineTo(a, b + s * 2);
    c.lineTo(a + s, b + s * 2);
    c.lineTo(a + s, b + s);
    c.lineTo(a + s * 2, b + s);
    c.closePath();
  };
  c.strokeStyle = P.gold;
  c.lineWidth = u * 0.35;
  step(u, u * 1.2);
  c.stroke();
  c.lineWidth = u * 0.15;
  step(u * 1.9, u * 1.2);
  c.stroke();
  // Fans in the corners.
  for (const [cx, cy, a] of [[x + u * 1.9, y + u * 1.9, 0], [x + w - u * 1.9, y + u * 1.9, Math.PI / 2], [x + w - u * 1.9, y + h - u * 1.9, Math.PI], [x + u * 1.9, y + h - u * 1.9, -Math.PI / 2]]) {
    c.beginPath();
    for (let k = 0; k <= 4; k++) {
      const t = a + (k / 4) * (Math.PI / 2);
      c.moveTo(/** @type {number} */ (cx), /** @type {number} */ (cy));
      c.lineTo(/** @type {number} */ (cx) + Math.cos(t) * u * 3.2, /** @type {number} */ (cy) + Math.sin(t) * u * 3.2);
    }
    c.strokeStyle = P.gold;
    c.lineWidth = u * 0.12;
    c.stroke();
  }
  c.restore();
}
