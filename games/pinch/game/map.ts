/**
 * The estate (docs/pinch-design.md §3, §11): the tile map, its rooms,
 * outside areas, doors, windows, lamps, cameras, parking spots, the
 * workbench and the furniture; the seeded generator; the public
 * blueprint's wire format; ASCII renderings for tests and debugging.
 *
 * Coordinates: `x` to the right (east), `y` down (south). Tile `(x, y)`
 * covers `[x, x + 1) × [y, y + 1)`, its centre is `(x + 0.5, y + 0.5)`,
 * its index `y * w + x`. Angles are degrees, 0 = east, 90 = south.
 *
 * Two halves:
 * - {@link Blueprint}: what every phone may know (walls, doors, windows,
 *   rooms, areas, lamps, cameras, spots, the workbench, furniture).
 *   {@link encodeBlueprint} / {@link decodeBlueprint} move it in a view.
 * - {@link Estate}: the blueprint plus the secrets: which spot is the
 *   getaway car and the loot places (what lies where: items.ts
 *   `pickCatalogue(n, rng, `{@link lootPlaces}`(estate))`). Never send an
 *   Estate to a phone.
 *
 * Generating: {@link generate}`(players, seed)` loops
 * {@link tryEstate}`(players, seed, attempt)`, one try a call (each try
 * has its own random stream, so a host page may spread tries over
 * ticks); a try takes a few milliseconds.
 */

import { rleDecode, rleEncode } from "./codec.ts";
import { hashSeed, Rng } from "./rng.ts";

// ---------------------------------------------------------------- tiles

/** What stands on a tile. */
export const TILE = {
  /** Walkable ground or floor (its look: {@link FLOOR}). */
  FLOOR: 0,
  /** A building's wall. */
  WALL: 1,
  /** The wall around the lot. */
  LOT_WALL: 2,
  /** The map's edge (the houses across the street): never entered. */
  EDGE: 3,
  /** A door: blocks sight and bodies when closed (state: move.ts `DOOR_*`). */
  DOOR: 4,
  /** A curtained window in a building's outer wall: blocks sight, climbable. */
  WINDOW: 5,
  HEDGE: 6,
  TREE: 7,
  /** A parked car (outside; the garage's car is furniture). */
  CAR: 8,
  FOUNTAIN: 9,
  /** A shed's wall or a garden hut. */
  SHED: 10,
  /** Furniture: blocks bodies, not sight. */
  FURNITURE: 11,
} as const;
export type Tile = (typeof TILE)[keyof typeof TILE];
export const TILE_KINDS = 12;

/** What a tile's ground looks like (NONE under walls). */
export const FLOOR = {
  NONE: 0,
  GRASS: 1,
  GRAVEL: 2,
  PAVEMENT: 3,
  ASPHALT: 4,
  COBBLE: 5,
  PARQUET: 6,
  MARBLE: 7,
  CARPET: 8,
  TILES: 9,
  CONCRETE: 10,
  BOARDS: 11,
  STEEL: 12,
} as const;
export type Floor = (typeof FLOOR)[keyof typeof FLOOR];
export const FLOOR_KINDS = 13;

/** Static sight blockers by tile kind (doors: by their state, sight.ts). */
export const OPAQUE: readonly boolean[] = [false, true, true, true, false, true, true, true, true, true, true, false];
/** Tiles a body may stand on whatever happens (doors and windows: see move.ts). */
export const WALKABLE: readonly boolean[] = [true, false, false, false, false, false, false, false, false, false, false, false];
/** Cover outside: blocks bodies and sight. */
export const COVER: readonly boolean[] = [false, false, false, false, false, false, true, true, true, true, true, false];

// ---------------------------------------------------------------- types

export type Side = "n" | "e" | "s" | "w";
export const SIDES: readonly Side[] = ["n", "e", "s", "w"];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The kinds of rooms inside a building (and the shed, a room of its own outside). The one definition: items.ts re-exports it. */
export const ROOM_KINDS = [
  "foyer", "corridor", "ballroom", "library", "study", "gallery", "kitchen", "dining",
  "billiards", "conservatory", "bedroom", "bathroom", "vault", "security", "garage", "shed",
] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

/** The kinds of outside areas of a lot (items.ts: `OUTSIDE_KINDS`). */
export const AREA_KINDS = ["street", "garden", "carpark", "alley", "yard"] as const;
export type AreaKind = (typeof AREA_KINDS)[number];

/**
 * How an item is kept, which decides taking it (§6): `loose` on a table
 * or a shelf (0.6 s, quiet), in a display `case` (2 s, breaking glass),
 * in a `safe` (5 s, quiet), on the `pedestal` (1 s, quiet, the police
 * alarm). At most one pedestal a night, with the most valuable item.
 * (The one definition: items.ts and words.ts use these.)
 */
export const KEEPS = ["loose", "case", "safe", "pedestal"] as const;
export type Keep = (typeof KEEPS)[number];

export const PROP_KINDS = [
  // furniture (inside)
  "table", "desk", "bookshelf", "armchair", "chair", "piano", "plant", "plinth", "case", "safe",
  "counter", "stove", "icebox", "bed", "wardrobe", "dresser", "nightstand", "bathtub", "sink",
  "toilet", "billiards", "cuerack", "bar", "sideboard", "dining", "bench", "clock", "coatstand",
  "monitors", "lockers", "vintagecar", "workbench", "tools", "crates", "shelf",
  // cover (outside)
  "hedge", "tree", "car", "fountain", "hut",
] as const;
export type PropKind = (typeof PROP_KINDS)[number];

/** A building: its rectangle includes the outer walls. */
export interface Building {
  id: number;
  rect: Rect;
  /** The main house (the bigger one; the other is the annex). */
  main: boolean;
}

export interface Room {
  id: number;
  kind: RoomKind;
  /** The how-manieth room of its kind (0 first), for names ("the second bedroom"). */
  nth: number;
  /** The building it is in; -1 for the shed in the yard. */
  building: number;
  /** Its floor tiles (inside the walls). */
  rect: Rect;
  /** Lit at the start of the heist. */
  lit: boolean;
  /** Tiles one switches its light from: inside, next to each of its doors. */
  switches: number[];
  /** Its doors and windows (ids), derived. */
  doors: number[];
  windows: number[];
}

export interface Area {
  id: number;
  kind: AreaKind;
  nth: number;
  /** Its tiles' bounding box (the tiles themselves: `areaAt`). */
  rect: Rect;
  /** Gardens: the building they lie beside and on which side of it; else -1 / null. */
  building: number;
  side: Side | null;
}

export interface Door {
  id: number;
  x: number;
  y: number;
  i: number;
  /** The wall it sits in: "h" horizontal (one passes it north–south), "v" vertical (east–west). */
  wall: "h" | "v";
  /** The rooms on its two sides (west/north first); -1 = outside. */
  rooms: [number, number];
  /** Leads outside (one side is -1). */
  outside: boolean;
  /** Locked at the start: guards open it at once, the thief picks it (§3). */
  locked: boolean;
}

/** A window (`Pane`, to keep clear of the DOM's Window): in an outer wall. */
export interface Pane {
  id: number;
  x: number;
  y: number;
  i: number;
  wall: "h" | "v";
  room: number;
}

/** A lamp post outside: lights a pool of {@link LAMP_RADIUS} tiles. Not blocking. */
export interface Lamp {
  id: number;
  x: number;
  y: number;
  i: number;
}
export const LAMP_RADIUS = 4;

/** A fixed camera, mounted on a wall tile, looking `angle` degrees. */
export interface Camera {
  id: number;
  x: number;
  y: number;
  i: number;
  angle: number;
  /** The cone's full angle and reach. */
  fov: number;
  range: number;
  /** The room it watches (a corridor), or -1 outside. */
  room: number;
}
export const CAMERA_FOV = 50;
export const CAMERA_RANGE = 8;

/** A parking spot (P): walkable; one is the getaway car (secret: {@link Estate.car}). */
export interface Spot {
  id: number;
  rect: Rect;
  area: number;
}

/** An opening in the lot wall (walkable ground). */
export interface Gate {
  id: number;
  rect: Rect;
  /** The lot's side it is on. */
  side: Side;
  area: number;
}

/**
 * Furniture and cover, for drawing. `block`: 0 none, 1 bodies
 * (furniture: tiles are FURNITURE), 2 bodies and sight (cover).
 */
export interface Prop {
  id: number;
  kind: PropKind;
  rect: Rect;
  block: 0 | 1 | 2;
  /** The room it stands in, -1 outside. */
  room: number;
  /** The side its back is against a wall, if it stands at one. */
  side: Side | null;
}

/** The workbench (strips tags, §6): a prop, with the tile one works it from. */
export interface Workbench {
  prop: number;
  room: number;
  /** A walkable tile next to it. */
  access: number;
}

/** The public map. Tile layers are row-major, `w * h` long. */
export interface Blueprint {
  w: number;
  h: number;
  /** Tile kinds ({@link TILE}). */
  tiles: Uint8Array;
  /** Ground looks ({@link FLOOR}). */
  floors: Uint8Array;
  /** Room id per tile (floor and furniture inside a room), else -1. */
  roomAt: Int16Array;
  /** Outside area id per tile (cover included), else -1. */
  areaAt: Int16Array;
  /** Door id per tile, else -1. */
  doorAt: Int16Array;
  /** Window id per tile, else -1. */
  windowAt: Int16Array;
  /** The side the street is on. */
  front: Side;
  /** The lot wall's rectangle (the wall itself is its border). */
  lot: Rect;
  buildings: Building[];
  rooms: Room[];
  areas: Area[];
  doors: Door[];
  windows: Pane[];
  lamps: Lamp[];
  cameras: Camera[];
  spots: Spot[];
  gates: Gate[];
  props: Prop[];
  workbench: Workbench;
  /** The security office (a room id): guards start there. */
  security: number;
  /** Start tiles for guards (at least 7, or players − 1), in the security office. */
  spawn: number[];
}

/** Which half of a building a place is in: the thief's tip (§6). */
export interface Wing {
  building: number;
  /** East/west for a building wider than deep, else north/south. */
  half: Side;
}

/** A loot place: a holder prop (table, case, safe, pedestal) loot may lie on. */
export interface Place {
  id: number;
  prop: number;
  /** The tile of the prop the item lies on. */
  x: number;
  y: number;
  i: number;
  /** A walkable tile next to it, to take it from. */
  access: number;
  room: number;
  keep: Keep;
  /** Steps (8-way, through doors) from the nearest outside door; always > {@link MIN_LOOT_DEPTH}. */
  depth: number;
  wing: Wing;
}
export const MIN_LOOT_DEPTH = 6;

/** The generated estate: the public blueprint and the secrets. */
export interface Estate {
  players: number;
  seed: number;
  /** The try that succeeded. */
  attempt: number;
  map: Blueprint;
  /** The getaway car's spot (an index into `map.spots`). Secret: the thief only. */
  car: number;
  /** Where loot may lie (more than items: the rest are decoys). Secret. */
  places: Place[];
}

/** The map's size by players (§3). */
export function mapSize(players: number): { w: number; h: number } {
  const p = clampPlayers(players);
  if (p <= 3) return { w: 56, h: 36 };
  if (p === 4) return { w: 62, h: 40 };
  if (p <= 6) return { w: 74, h: 46 };
  return { w: 86, h: 54 };
}

/** How many items a night has (§3: 8–14), by players. */
export function lootCount(players: number): number {
  return [8, 9, 10, 11, 12, 14][clampPlayers(players) - 3]!;
}

function clampPlayers(p: number): number {
  return Number.isFinite(p) ? Math.max(3, Math.min(8, Math.round(p))) : 3;
}

// ---------------------------------------------------------------- small helpers

export const tileIndex = (map: { w: number }, x: number, y: number): number => y * map.w + x;
export const inBounds = (map: { w: number; h: number }, x: number, y: number): boolean =>
  Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < map.w && y < map.h;
export const inRect = (r: Rect, x: number, y: number): boolean => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/** The two tiles beside a door or window (west/north first). */
export function sidesOf(d: { x: number; y: number; wall: "h" | "v" }): [[number, number], [number, number]] {
  return d.wall === "v" ? [[d.x - 1, d.y], [d.x + 1, d.y]] : [[d.x, d.y - 1], [d.x, d.y + 1]];
}

/** The tile beside door `d` inside room `room` (-1: the outside one), as an index, or -1. */
export function doorSide(map: Blueprint, d: Door | Pane, room: number): number {
  for (const [x, y] of sidesOf(d)) {
    if (!inBounds(map, x, y)) continue;
    const i = y * map.w + x;
    if (map.roomAt[i] === room) return i;
  }
  return -1;
}

/**
 * Fills the derived parts of a blueprint from the rest: `roomAt` (from
 * the rooms' rectangles), `doorAt`, `windowAt`, the rooms' door and
 * window lists, the doors' `i` and `outside`.
 */
export function indexBlueprint(bp: Blueprint): Blueprint {
  const n = bp.w * bp.h;
  bp.roomAt = new Int16Array(n).fill(-1);
  bp.doorAt = new Int16Array(n).fill(-1);
  bp.windowAt = new Int16Array(n).fill(-1);
  for (const r of bp.rooms) {
    r.doors = [];
    r.windows = [];
    for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) {
      for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) bp.roomAt[y * bp.w + x] = r.id;
    }
  }
  for (const d of bp.doors) {
    d.i = d.y * bp.w + d.x;
    d.outside = d.rooms[0] < 0 || d.rooms[1] < 0;
    bp.doorAt[d.i] = d.id;
    for (const r of d.rooms) if (r >= 0) bp.rooms[r]!.doors.push(d.id);
  }
  for (const p of bp.windows) {
    p.i = p.y * bp.w + p.x;
    bp.windowAt[p.i] = p.id;
    bp.rooms[p.room]?.windows.push(p.id);
  }
  for (const l of bp.lamps) l.i = l.y * bp.w + l.x;
  for (const c of bp.cameras) c.i = c.y * bp.w + c.x;
  return bp;
}

// ---------------------------------------------------------------- generating

/** How many tries {@link generate} makes before it gives up (a bug: about three in four tries pass). */
export const MAX_ATTEMPTS = 400;

/** Generates an estate: tries until one passes the checks (§11). Throws only after {@link MAX_ATTEMPTS} failed tries (a bug). */
export function generate(players: number, seed: number): Estate {
  const reasons: string[] = [];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const r = tryEstate(players, seed, attempt);
    if (typeof r !== "string") return r;
    reasons.push(r);
  }
  throw new Error(`no estate for ${players} players, seed ${seed}: ${reasons.slice(0, 5).join("; ")}`);
}

/**
 * One try: the estate, or why it failed (a check of §11 or a step that
 * found no room). Deterministic in (players, seed, attempt).
 */
export function tryEstate(players: number, seed: number, attempt: number): Estate | string {
  const p = clampPlayers(players);
  const g = new Gen(p, new Rng(hashSeed("pinch-estate", p, seed >>> 0, attempt >>> 0)));
  const fail = g.run();
  if (fail) return fail;
  const e = g.finish(seed >>> 0, attempt);
  return checkEstate(e) ?? e;
}

/** The floor of each room kind. */
const ROOM_FLOOR: Record<RoomKind, Floor> = {
  foyer: FLOOR.MARBLE, corridor: FLOOR.CARPET, ballroom: FLOOR.PARQUET, library: FLOOR.CARPET,
  study: FLOOR.CARPET, gallery: FLOOR.MARBLE, kitchen: FLOOR.TILES, dining: FLOOR.PARQUET,
  billiards: FLOOR.CARPET, conservatory: FLOOR.TILES, bedroom: FLOOR.CARPET, bathroom: FLOOR.TILES,
  vault: FLOOR.STEEL, security: FLOOR.CONCRETE, garage: FLOOR.CONCRETE, shed: FLOOR.BOARDS,
};

type At = "wall" | "corner" | "centre" | "any";
interface Piece {
  kind: PropKind;
  /** Along the wall (or the room's long axis) × into the room. */
  len: number;
  depth: number;
  at: At;
  block: boolean;
  n: [number, number];
  keep?: Keep;
  /** Placed only in the room that holds the workbench. */
  workbench?: true;
  /** Must be placed, else the try fails. */
  must?: true;
}

const P = (kind: PropKind, len: number, depth: number, at: At, n: [number, number], more: Partial<Piece> = {}): Piece => ({
  kind, len, depth, at, n, block: true, ...more,
});

/** Furniture by room kind, in placing order (big pieces first). */
const RECIPES: Record<RoomKind, readonly Piece[]> = {
  foyer: [P("plinth", 1, 1, "centre", [0, 1]), P("table", 1, 1, "wall", [1, 2], { keep: "loose" }), P("coatstand", 1, 1, "corner", [0, 1]), P("plant", 1, 1, "corner", [1, 2])],
  corridor: [P("table", 1, 1, "wall", [1, 3], { keep: "loose" }), P("clock", 1, 1, "wall", [0, 1]), P("plant", 1, 1, "wall", [0, 2]), P("bench", 2, 1, "wall", [0, 1])],
  ballroom: [P("piano", 3, 2, "corner", [1, 1]), P("table", 1, 1, "wall", [1, 2], { keep: "loose" }), P("case", 1, 1, "wall", [0, 1], { keep: "case" }), P("plant", 1, 1, "corner", [1, 2]), P("chair", 1, 1, "wall", [2, 4], { block: false })],
  library: [P("bookshelf", 3, 1, "wall", [2, 4], { keep: "loose" }), P("table", 2, 1, "centre", [0, 1], { keep: "loose" }), P("case", 1, 1, "wall", [0, 1], { keep: "case" }), P("armchair", 1, 1, "any", [1, 2])],
  study: [P("desk", 2, 1, "wall", [1, 1], { keep: "loose" }), P("safe", 1, 1, "corner", [1, 1], { keep: "safe" }), P("bookshelf", 2, 1, "wall", [0, 2], { keep: "loose" }), P("armchair", 1, 1, "any", [0, 1]), P("chair", 1, 1, "any", [0, 1], { block: false })],
  gallery: [P("case", 1, 1, "any", [2, 4], { keep: "case" }), P("plinth", 1, 1, "centre", [1, 3]), P("bench", 2, 1, "centre", [0, 1])],
  kitchen: [P("counter", 3, 1, "wall", [1, 2], { keep: "loose" }), P("stove", 2, 1, "wall", [1, 1]), P("icebox", 1, 1, "corner", [0, 1], { keep: "loose" }), P("table", 2, 2, "centre", [0, 1], { keep: "loose" })],
  dining: [P("dining", 0, 0, "centre", [1, 1], { keep: "loose" }), P("sideboard", 2, 1, "wall", [1, 2], { keep: "case" }), P("plant", 1, 1, "corner", [0, 2])],
  billiards: [P("billiards", 3, 2, "centre", [1, 1]), P("bar", 2, 1, "wall", [1, 1], { keep: "loose" }), P("cuerack", 2, 1, "wall", [0, 1]), P("armchair", 1, 1, "corner", [0, 2])],
  conservatory: [P("plant", 1, 1, "any", [3, 6]), P("table", 1, 1, "any", [1, 1], { keep: "loose" }), P("armchair", 1, 1, "any", [1, 2])],
  bedroom: [P("bed", 2, 3, "wall", [1, 1]), P("wardrobe", 2, 1, "wall", [0, 1]), P("dresser", 2, 1, "wall", [1, 1], { keep: "loose" }), P("nightstand", 1, 1, "wall", [0, 2], { keep: "loose" })],
  bathroom: [P("bathtub", 2, 1, "wall", [1, 1]), P("sink", 1, 1, "wall", [1, 1], { keep: "loose" }), P("toilet", 1, 1, "corner", [0, 1])],
  vault: [P("plinth", 1, 1, "centre", [1, 1], { keep: "pedestal", must: true }), P("safe", 1, 1, "wall", [2, 3], { keep: "safe" }), P("case", 1, 1, "wall", [1, 2], { keep: "case" }), P("shelf", 2, 1, "wall", [0, 1], { keep: "loose" })],
  security: [P("monitors", 2, 1, "wall", [1, 1]), P("lockers", 2, 1, "wall", [1, 1]), P("table", 1, 1, "corner", [0, 1])],
  garage: [P("workbench", 2, 1, "wall", [1, 1], { workbench: true, must: true }), P("vintagecar", 2, 4, "centre", [1, 1]), P("tools", 1, 1, "wall", [0, 2]), P("crates", 1, 1, "corner", [0, 1], { keep: "loose" })],
  shed: [P("workbench", 2, 1, "wall", [1, 1], { workbench: true, must: true }), P("crates", 1, 1, "any", [1, 2]), P("tools", 1, 1, "wall", [0, 1])],
};

interface GRoom {
  rect: Rect;
  building: number;
  kind: RoomKind | null;
  lit: boolean;
  doors: number[];
  depth: number;
}
interface GDoor {
  x: number;
  y: number;
  wall: "h" | "v";
  rooms: [number, number];
  locked: boolean;
}
interface GArea {
  kind: AreaKind;
  building: number;
  side: Side | null;
}
interface GProp {
  kind: PropKind;
  rect: Rect;
  block: 0 | 1 | 2;
  room: number;
  side: Side | null;
  keep?: Keep;
}
interface Candidate {
  x: number;
  y: number;
  wall: "h" | "v";
}

const KEY = (a: number, b: number) => (a < b ? a * 4096 + b : b * 4096 + a);

/** The generator's working state, in canonical orientation (street south, car park west, alley east); `finish` flips it. */
class Gen {
  readonly w: number;
  readonly h: number;
  readonly tiles: Uint8Array;
  readonly floors: Uint8Array;
  readonly roomAt: Int16Array;
  readonly areaAt: Int16Array;
  /** Outside: no cover here. Inside: no furniture here. */
  readonly reserved: Uint8Array;
  readonly buildings: Rect[] = [];
  readonly rooms: GRoom[] = [];
  readonly doors: GDoor[] = [];
  readonly windows: { x: number; y: number; wall: "h" | "v"; room: number }[] = [];
  readonly lamps: [number, number][] = [];
  readonly cameras: { x: number; y: number; angle: number; room: number }[] = [];
  readonly spots: Rect[] = [];
  readonly gates: { rect: Rect; side: Side }[] = [];
  readonly props: GProp[] = [];
  readonly areas: GArea[] = [];
  /** Lot interior bounds. */
  readonly lx1: number;
  readonly ly1: number;
  carpark: Rect = { x: 0, y: 0, w: 0, h: 0 };
  yard: Rect = { x: 0, y: 0, w: 0, h: 0 };
  corridors: Rect[] = [];
  vault = -1;
  security = -1;
  garage = -1;
  shed = -1;
  workbench = -1;
  spawn: number[] = [];
  /** Building door candidates per room pair. */
  pairs = new Map<number, Candidate[]>();
  treeKeys = new Set<number>();

  readonly players: number;
  readonly rng: Rng;

  constructor(players: number, rng: Rng) {
    this.players = players;
    this.rng = rng;
    const { w, h } = mapSize(players);
    this.w = w;
    this.h = h;
    this.tiles = new Uint8Array(w * h).fill(TILE.EDGE);
    this.floors = new Uint8Array(w * h);
    this.roomAt = new Int16Array(w * h).fill(-1);
    this.areaAt = new Int16Array(w * h).fill(-1);
    this.reserved = new Uint8Array(w * h);
    this.lx1 = w - 6;
    this.ly1 = h - 8;
  }

  i(x: number, y: number): number {
    return y * this.w + x;
  }
  ok(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  tile(x: number, y: number): number {
    return this.ok(x, y) ? this.tiles[y * this.w + x]! : TILE.EDGE;
  }
  set(x: number, y: number, t: Tile, f: Floor = FLOOR.NONE): void {
    const i = y * this.w + x;
    this.tiles[i] = t;
    this.floors[i] = f;
  }
  fill(r: Rect, t: Tile, f: Floor): void {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) this.set(x, y, t, f);
  }
  reserve(x: number, y: number, rad = 0): void {
    for (let yy = y - rad; yy <= y + rad; yy++) {
      for (let xx = x - rad; xx <= x + rad; xx++) if (this.ok(xx, yy)) this.reserved[this.i(xx, yy)] = 1;
    }
  }
  inBuilding(x: number, y: number): number {
    for (let b = 0; b < this.buildings.length; b++) if (inRect(this.buildings[b]!, x, y)) return b;
    return -1;
  }

  run(): string | null {
    this.frame();
    if (!this.placeBuildings()) return "no room for the buildings";
    for (let b = 0; b < this.buildings.length; b++) this.splitBuilding(b);
    this.collectPairs();
    for (let b = 0; b < this.buildings.length; b++) this.tree(b);
    const out = this.outsideDoors();
    if (out) return out;
    this.loops();
    const vault = this.chooseVault();
    if (vault) return vault;
    const kinds = this.kinds();
    if (kinds) return kinds;
    this.windowsOut();
    this.shedRoom();
    this.gatesAndPaths();
    this.parking();
    this.areasOut();
    const furn = this.furnish();
    if (furn) return furn;
    this.cover();
    if (!this.connected()) return "not everything walkable is connected";
    const cov = this.coverChecks();
    if (cov) return cov;
    this.lampsOut();
    const cams = this.camerasOut();
    if (cams) return cams;
    return null;
  }

  // -- 1. the frame: edge, lot wall, alley, street

  frame(): void {
    const { w, h } = this;
    this.fill({ x: 0, y: 0, w: w - 4, h: h - 6 }, TILE.LOT_WALL, FLOOR.NONE);
    this.fill({ x: 1, y: 1, w: this.lx1, h: this.ly1 }, TILE.FLOOR, FLOOR.GRASS);
    this.fill({ x: w - 4, y: 1, w: 3, h: h - 7 }, TILE.FLOOR, FLOOR.COBBLE);
    this.fill({ x: 1, y: h - 6, w: w - 2, h: 1 }, TILE.FLOOR, FLOOR.PAVEMENT);
    this.fill({ x: 1, y: h - 5, w: w - 2, h: 4 }, TILE.FLOOR, FLOOR.ASPHALT);
    const cw = this.rng.int(9, 11);
    const cd = this.rng.int(7, 9);
    this.carpark = { x: 1, y: this.ly1 - cd + 1, w: cw, h: cd };
    this.fill(this.carpark, TILE.FLOOR, FLOOR.ASPHALT);
    this.yard = { x: 1, y: 1, w: cw, h: this.rng.int(6, 8) };
    this.fill(this.yard, TILE.FLOOR, FLOOR.COBBLE);
  }

  // -- 2. buildings

  placeBuildings(): boolean {
    const rng = this.rng;
    const p = this.players;
    const xa = this.carpark.w + 4;
    const xb = this.lx1 - 5;
    const aw = xb - xa + 1;
    type Size = [[number, number], [number, number]];
    const main: Size = p <= 3 ? [[24, 30], [14, 17]] : p === 4 ? [[27, 33], [16, 19]] : p <= 6 ? [[26, 32], [17, 22]] : [[30, 36], [20, 26]];
    const annex: Size | null = p <= 4 ? null : p <= 6 ? [[14, 18], [12, 16]] : [[18, 24], [14, 19]];
    const W1 = Math.min(aw, rng.int(...main[0]));
    const D1 = rng.int(...main[1]);
    let W2 = 0;
    let gap = 0;
    if (annex) {
      gap = rng.int(4, 7);
      W2 = Math.min(rng.int(...annex[0]), aw - W1 - gap);
      if (W2 < 13) return false;
    }
    const slack = aw - W1 - gap - W2;
    if (slack < 0) return false;
    const x0 = xa + rng.int(0, slack);
    const mainFirst = !annex || rng.chance(0.5);
    const place = (x: number, W: number, D: number, fMin: number, fMax: number): Rect | null => {
      const f = rng.int(fMin, fMax);
      const front = this.ly1 - f;
      const top = front - D + 1;
      if (top < 5) return null;
      return { x, y: top, w: W, h: D };
    };
    const b1 = place(mainFirst ? x0 : x0 + W2 + gap, W1, D1, 5, 8);
    if (!b1) return false;
    this.buildings.push(b1);
    if (annex) {
      const D2 = Math.min(rng.int(...annex[1]), D1);
      const b2 = place(mainFirst ? x0 + W1 + gap : x0, W2, D2, 5, 10);
      if (!b2) return false;
      this.buildings.push(b2);
    }
    for (const b of this.buildings) {
      this.fill(b, TILE.WALL, FLOOR.NONE);
      // keep a ring around it free of cover
      for (let y = b.y - 1; y <= b.y + b.h; y++) {
        for (let x = b.x - 1; x <= b.x + b.w; x++) if (!inRect(b, x, y)) this.reserve(x, y);
      }
    }
    return true;
  }

  splitBuilding(b: number): void {
    const B = this.buildings[b]!;
    const I: Rect = { x: B.x + 1, y: B.y + 1, w: B.w - 2, h: B.h - 2 };
    const parts: Rect[] = [];
    const long = Math.max(I.w, I.h);
    const short = Math.min(I.w, I.h);
    if (long >= 20 && short >= 12) {
      const fd = this.rng.int(4, Math.min(8, short - 8));
      if (I.w >= I.h) {
        // horizontal corridor, rooms of depth fd at the front (south)
        const front: Rect = { x: I.x, y: I.y + I.h - fd, w: I.w, h: fd };
        const cor: Rect = { x: I.x, y: front.y - 3, w: I.w, h: 2 };
        const back: Rect = { x: I.x, y: I.y, w: I.w, h: cor.y - 1 - I.y };
        this.corridors.push(cor);
        this.addRoom(cor, b, "corridor");
        parts.push(front, back);
      } else {
        const left = this.rng.chance(0.5);
        const side: Rect = left ? { x: I.x, y: I.y, w: fd, h: I.h } : { x: I.x + I.w - fd, y: I.y, w: fd, h: I.h };
        const cor: Rect = left ? { x: side.x + fd + 1, y: I.y, w: 2, h: I.h } : { x: side.x - 3, y: I.y, w: 2, h: I.h };
        const rest: Rect = left ? { x: cor.x + 3, y: I.y, w: I.x + I.w - cor.x - 3, h: I.h } : { x: I.x, y: I.y, w: cor.x - 1 - I.x, h: I.h };
        this.corridors.push(cor);
        this.addRoom(cor, b, "corridor");
        parts.push(side, rest);
      }
    } else {
      parts.push(I);
    }
    for (const r of parts) this.bsp(r, b);
  }

  addRoom(r: Rect, b: number, kind: RoomKind | null): number {
    const id = this.rooms.length;
    this.rooms.push({ rect: r, building: b, kind, lit: false, doors: [], depth: 0 });
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        this.set(x, y, TILE.FLOOR, FLOOR.PARQUET);
        this.roomAt[this.i(x, y)] = id;
      }
    }
    return id;
  }

  bsp(r: Rect, b: number): void {
    const rng = this.rng;
    const canX = r.w >= 7;
    const canY = r.h >= 7;
    const mustX = r.w > 9;
    const mustY = r.h > 9;
    const area = r.w * r.h;
    const leaf = !mustX && !mustY && (area <= 24 || (!canX && !canY) || rng.chance(area >= 49 ? 0.35 : 0.55));
    if (leaf) {
      this.addRoom(r, b, null);
      return;
    }
    let alongX: boolean;
    if (mustX !== mustY) alongX = mustX;
    else if (canX && canY) alongX = r.w > r.h || (r.w === r.h && rng.chance(0.5));
    else alongX = canX;
    if (alongX) {
      const s = r.x + rng.int(3, r.w - 4);
      this.bsp({ x: r.x, y: r.y, w: s - r.x, h: r.h }, b);
      this.bsp({ x: s + 1, y: r.y, w: r.x + r.w - s - 1, h: r.h }, b);
    } else {
      const s = r.y + rng.int(3, r.h - 4);
      this.bsp({ x: r.x, y: r.y, w: r.w, h: s - r.y }, b);
      this.bsp({ x: r.x, y: s + 1, w: r.w, h: r.y + r.h - s - 1 }, b);
    }
  }

  // -- doors

  collectPairs(): void {
    for (const B of this.buildings) {
      for (let y = B.y + 1; y < B.y + B.h - 1; y++) {
        for (let x = B.x + 1; x < B.x + B.w - 1; x++) {
          if (this.tile(x, y) !== TILE.WALL) continue;
          const l = this.roomAt[this.i(x - 1, y)]!;
          const r = this.roomAt[this.i(x + 1, y)]!;
          if (l >= 0 && r >= 0 && l !== r && this.tile(x, y - 1) === TILE.WALL && this.tile(x, y + 1) === TILE.WALL) {
            this.cand(KEY(l, r), { x, y, wall: "v" });
          }
          const u = this.roomAt[this.i(x, y - 1)]!;
          const d = this.roomAt[this.i(x, y + 1)]!;
          if (u >= 0 && d >= 0 && u !== d && this.tile(x - 1, y) === TILE.WALL && this.tile(x + 1, y) === TILE.WALL) {
            this.cand(KEY(u, d), { x, y, wall: "h" });
          }
        }
      }
    }
  }
  cand(k: number, c: Candidate): void {
    const list = this.pairs.get(k);
    if (list) list.push(c);
    else this.pairs.set(k, [c]);
  }

  /** A door tile next to which no door is (so walls keep their shape). */
  freeSpot(c: Candidate): boolean {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (this.tile(c.x + dx, c.y + dy) === TILE.DOOR) return false;
    return this.tile(c.x, c.y) === TILE.WALL;
  }

  addDoor(c: Candidate, a: number, b: number): number {
    const id = this.doors.length;
    const [s0, s1] = sidesOf(c);
    const r0 = this.roomAt[this.i(...s0)]!;
    const rooms: [number, number] = r0 === a || (r0 < 0 && a < 0) ? [a, b] : [b, a];
    this.doors.push({ x: c.x, y: c.y, wall: c.wall, rooms, locked: false });
    this.set(c.x, c.y, TILE.DOOR, FLOOR.PARQUET);
    for (const r of rooms) if (r >= 0) this.rooms[r]!.doors.push(id);
    for (const [x, y] of [s0, s1]) {
      this.reserve(x, y);
      if (this.roomAt[this.i(x, y)]! < 0) this.reserve(x, y, 1);
    }
    return id;
  }

  /** A random door between rooms a and b, if a candidate is free. */
  doorBetween(a: number, b: number): number {
    const list = this.rng.shuffle(this.pairs.get(KEY(a, b)) ?? []);
    for (const c of list) if (this.freeSpot(c)) return this.addDoor(c, a, b);
    return -1;
  }

  tree(b: number): void {
    const ids = this.rooms.map((r, i) => (r.building === b ? i : -1)).filter((i) => i >= 0);
    const parent = new Map<number, number>(ids.map((i) => [i, i]));
    const find = (x: number): number => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    const edges = [...this.pairs.keys()]
      .filter((k) => this.rooms[Math.floor(k / 4096)]!.building === b)
      .map((k) => {
        const a = Math.floor(k / 4096);
        const c = k % 4096;
        const cor = this.rooms[a]!.kind === "corridor" || this.rooms[c]!.kind === "corridor";
        return { k, a, c, w: this.rng.float() - (cor ? 0.6 : 0) };
      })
      .sort((x, y) => x.w - y.w);
    for (const e of edges) {
      if (find(e.a) === find(e.c)) continue;
      if (this.doorBetween(e.a, e.c) < 0) continue;
      parent.set(find(e.a), find(e.c));
      this.treeKeys.add(e.k);
    }
  }

  /** Candidates for a door from room tiles of building b through its outer wall on `side`. */
  outerCandidates(b: number, side: Side): (Candidate & { room: number })[] {
    const B = this.buildings[b]!;
    const out: (Candidate & { room: number })[] = [];
    const along = side === "n" || side === "s";
    const fixed = side === "n" ? B.y : side === "s" ? B.y + B.h - 1 : side === "w" ? B.x : B.x + B.w - 1;
    const n = along ? B.w : B.h;
    for (let k = 1; k < n - 1; k++) {
      const x = along ? B.x + k : fixed;
      const y = along ? fixed : B.y + k;
      const [ix, iy] = side === "n" ? [x, y + 1] : side === "s" ? [x, y - 1] : side === "w" ? [x + 1, y] : [x - 1, y];
      const [ox, oy] = side === "n" ? [x, y - 1] : side === "s" ? [x, y + 1] : side === "w" ? [x - 1, y] : [x + 1, y];
      const room = this.roomAt[this.i(ix, iy)]!;
      if (room < 0 || this.tile(ox, oy) !== TILE.FLOOR || this.roomAt[this.i(ox, oy)]! >= 0) continue;
      const wall = along ? "h" : "v";
      const s1 = along ? this.tile(x - 1, y) : this.tile(x, y - 1);
      const s2 = along ? this.tile(x + 1, y) : this.tile(x, y + 1);
      if (s1 !== TILE.WALL || s2 !== TILE.WALL) continue;
      out.push({ x, y, wall, room });
    }
    return out;
  }

  outsideDoors(): string | null {
    const rng = this.rng;
    for (let b = 0; b < this.buildings.length; b++) {
      const B = this.buildings[b]!;
      const cx = B.x + B.w / 2;
      // the front door, into a room (not the corridor), near the middle
      const front = this.outerCandidates(b, "s").filter((c) => this.rooms[c.room]!.kind !== "corridor" && area(this.rooms[c.room]!.rect) >= 12);
      const f = rng.weighted(front, (c) => 1 / (1 + Math.abs(c.x - cx)));
      if (!f) return "no front door";
      this.addDoor(f, f.room, -1);
      this.rooms[f.room]!.kind = "foyer";
      let count = 1;
      // a garage onto the side nearest the car park (west), in the westmost building
      const west = this.buildings.reduce((m, r, i) => (r.x < this.buildings[m]!.x ? i : m), 0);
      if (b === west && rng.chance(0.6)) {
        const gs = this.outerCandidates(b, "w").filter((c) => {
          const r = this.rooms[c.room]!;
          return r.kind === null && area(r.rect) >= 16 && area(r.rect) <= 81 && Math.min(r.rect.w, r.rect.h) >= 4;
        });
        const gc = rng.pick(gs);
        if (gc && this.freeSpot(gc)) {
          this.addDoor(gc, gc.room, -1);
          this.rooms[gc.room]!.kind = "garage";
          this.garage = gc.room;
          count++;
        }
      }
      const others = rng.shuffle(["n", "n", "e", "w"] as Side[]);
      const want = rng.int(2, 3);
      for (const side of others) {
        if (count >= want) break;
        const cs = rng.shuffle(this.outerCandidates(b, side).filter((c) => this.rooms[c.room]!.kind !== "garage" && this.rooms[c.room]!.kind !== "foyer"));
        const c = cs.find((c) => this.freeSpot(c));
        if (!c) continue;
        this.addDoor(c, c.room, -1);
        count++;
      }
      if (count < 2) return "fewer than two doors out";
    }
    return null;
  }

  /** Steps from the outside doors (8-way, through doors, no corner cutting), per tile, -1 unreached. */
  steps(sources: number[]): Int32Array {
    return stepsFrom(this.tiles, this.w, this.h, sources);
  }
  outsideDoorTiles(buildingsOnly: boolean): number[] {
    return this.doors
      .filter((d) => (d.rooms[0] < 0 || d.rooms[1] < 0) && (!buildingsOnly || this.rooms[Math.max(d.rooms[0], d.rooms[1])]!.building >= 0))
      .map((d) => this.i(d.x, d.y));
  }
  roomDepths(): void {
    const dist = this.steps(this.outsideDoorTiles(true));
    for (const r of this.rooms) {
      let m = Infinity;
      for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) {
        for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) {
          const d = dist[this.i(x, y)]!;
          if (d >= 0 && d < m) m = d;
        }
      }
      r.depth = m;
    }
  }

  chooseVault(): string | null {
    this.roomDepths();
    const cands = this.rooms
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.kind === null && r.doors.length === 1 && area(r.rect) >= 9 && area(r.rect) <= 42 && r.depth < Infinity)
      .filter(({ i }) => this.vaultRoutes(i));
    if (cands.length === 0) return "no room for the vault with two routes out";
    const best = Math.max(...cands.map((c) => c.r.depth));
    const pick = this.rng.pick(cands.filter((c) => c.r.depth === best))!;
    pick.r.kind = "vault";
    this.vault = pick.i;
    this.doors[pick.r.doors[0]!]!.locked = true;
    return null;
  }

  loops(): void {
    for (const k of this.rng.shuffle([...this.pairs.keys()].sort((a, b) => a - b))) {
      if (this.treeKeys.has(k)) continue;
      const a = Math.floor(k / 4096);
      const b = k % 4096;
      if (a === this.vault || b === this.vault) continue;
      if (this.rng.chance(0.3)) this.doorBetween(a, b);
    }
    this.roomDepths();
  }

  /** Two door-disjoint routes from the room before the vault's door to the outside (unit max-flow). */
  vaultRoutes(vault: number): boolean {
    const vd = this.rooms[vault]!.doors[0]!;
    const ante = Math.max(...this.doors[vd]!.rooms.filter((r) => r !== vault));
    if (ante < 0) return false;
    return doorRoutes(this.rooms.length, this.doors, ante, vd) >= 2;
  }

  // -- kinds, light, locks

  kinds(): string | null {
    const rng = this.rng;
    // the security office: in the main building, near the front
    const need = Math.max(this.players - 1, 4) + 1;
    const sec = this.rooms
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.building === 0 && r.kind === null && area(r.rect) >= need + 2 && r.rect.w >= 3 && r.rect.h >= 3)
      .sort((a, b) => a.r.depth - b.r.depth || a.i - b.i);
    const s = rng.pick(sec.slice(0, 2));
    if (!s) return "no room for the security office";
    s.r.kind = "security";
    this.security = s.i;
    // a kitchen by a back door, one per building
    for (let b = 0; b < this.buildings.length; b++) {
      const k = this.rooms.find((r) => r.building === b && r.kind === null && area(r.rect) >= 12 && r.doors.some((d) => this.isOut(d)));
      if (k) k.kind = "kitchen";
    }
    const count = new Map<string, number>();
    const perB = new Map<string, number>();
    for (const r of this.rooms) {
      if (!r.kind) continue;
      count.set(r.kind, (count.get(r.kind) ?? 0) + 1);
      perB.set(`${r.building}:${r.kind}`, (perB.get(`${r.building}:${r.kind}`) ?? 0) + 1);
    }
    const depths = this.rooms.map((r) => r.depth).filter((d) => d < Infinity);
    const maxD = Math.max(1, ...depths);
    const order = rng.shuffle(this.rooms.map((_, i) => i).filter((i) => this.rooms[i]!.kind === null));
    for (const i of order) {
      const r = this.rooms[i]!;
      const a = area(r.rect);
      const short = Math.min(r.rect.w, r.rect.h);
      const deep = r.depth / maxD;
      const big = a >= 42;
      const small = a < 16;
      const outer = this.touchesOuter(r);
      const once = (k: RoomKind, w: number) => (count.get(k) ? 0 : w);
      const oncePerB = (k: RoomKind, w: number) => (perB.get(`${r.building}:${k}`) ? 0 : w);
      const weights: [RoomKind, number][] = [
        ["ballroom", big ? once("ballroom", 8) : 0],
        ["gallery", a >= 20 ? 3 + 3 * deep : 0],
        ["library", a >= 16 ? 3 + 2 * deep : 0.5],
        ["study", a <= 36 ? 2 + 4 * deep : 0],
        ["dining", a >= 20 ? oncePerB("dining", 1 + 3 * (1 - deep)) : 0],
        ["billiards", a >= 20 && short >= 4 ? oncePerB("billiards", 3) : 0],
        ["conservatory", outer && a >= 16 ? once("conservatory", 3) : 0],
        ["bedroom", a >= 12 ? 3 : 1],
        ["bathroom", small ? 4 : a <= 20 ? 1 : 0],
        ["kitchen", a >= 16 ? oncePerB("kitchen", 2) : 0],
      ];
      const k = rng.weighted(weights, ([k, w]) => w / (1 + (count.get(k) ?? 0)) ** 2)?.[0] ?? "bedroom";
      r.kind = k;
      count.set(k, (count.get(k) ?? 0) + 1);
      perB.set(`${r.building}:${k}`, (perB.get(`${r.building}:${k}`) ?? 0) + 1);
    }
    for (const r of this.rooms) {
      const k = r.kind!;
      r.lit = k === "security" ? true : k === "vault" ? false : rng.chance(k === "corridor" ? 0.6 : k === "garage" ? 0.3 : 0.5);
      const f = ROOM_FLOOR[k];
      for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) this.floors[this.i(x, y)] = f;
      if (k === "study" && r.doors.length <= 2 && !r.doors.some((d) => this.isOut(d)) && rng.chance(0.4)) {
        for (const d of r.doors) this.doors[d]!.locked = true;
      }
    }
    for (const d of this.doors) {
      const r = d.rooms[0] >= 0 ? d.rooms[0] : d.rooms[1];
      this.floors[this.i(d.x, d.y)] = ROOM_FLOOR[this.rooms[r]!.kind!];
    }
    return null;
  }
  isOut(d: number): boolean {
    const r = this.doors[d]!.rooms;
    return r[0] < 0 || r[1] < 0;
  }
  touchesOuter(r: GRoom): boolean {
    const B = this.buildings[r.building];
    if (!B) return false;
    return r.rect.x === B.x + 1 || r.rect.y === B.y + 1 || r.rect.x + r.rect.w === B.x + B.w - 1 || r.rect.y + r.rect.h === B.y + B.h - 1;
  }

  windowsOut(): void {
    for (let b = 0; b < this.buildings.length; b++) {
      const all = this.rng.shuffle(SIDES.flatMap((s) => this.outerCandidates(b, s)));
      const want = this.rng.int(3, 6);
      let n = 0;
      for (const c of all) {
        if (n >= want) break;
        if (c.room === this.vault) continue;
        let near = false;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const t = this.tile(c.x + dx, c.y + dy);
            if (t === TILE.DOOR || t === TILE.WINDOW) near = true;
          }
        }
        if (near) continue;
        this.windows.push({ x: c.x, y: c.y, wall: c.wall, room: c.room });
        this.set(c.x, c.y, TILE.WINDOW, FLOOR.NONE);
        for (const [x, y] of sidesOf(c)) this.reserve(x, y);
        n++;
      }
    }
  }

  // -- the shed in the yard

  shedRoom(): void {
    const Y = this.yard;
    const sw = this.rng.int(5, 6);
    const sh = 5;
    const x = Y.x + this.rng.int(0, Math.max(0, Y.w - sw - 1));
    const r: Rect = { x, y: Y.y, w: sw, h: sh };
    this.fill(r, TILE.SHED, FLOOR.COBBLE);
    const inner: Rect = { x: r.x + 1, y: r.y + 1, w: sw - 2, h: sh - 2 };
    // its walls and a ring around it stay free of cover; inside is furnished
    for (let yy = r.y - 1; yy <= r.y + r.h; yy++) for (let xx = r.x - 1; xx <= r.x + r.w; xx++) if (!inRect(inner, xx, yy)) this.reserve(xx, yy);
    this.fill(inner, TILE.FLOOR, FLOOR.BOARDS);
    const id = this.addRoom(inner, -1, "shed");
    this.shed = id;
    const room = this.rooms[id]!;
    room.lit = this.rng.chance(0.3);
    const dx = inner.x + this.rng.int(0, inner.w - 1);
    const dy = r.y + r.h - 1;
    this.set(dx, dy, TILE.SHED, FLOOR.BOARDS);
    this.addDoor({ x: dx, y: dy, wall: "h" }, id, -1);
    this.floors[this.i(dx, dy)] = FLOOR.BOARDS;
    this.reserve(dx, dy + 1, 1);
    this.reserve(dx, dy + 2, 1);
  }

  // -- gates, paths, parking

  gatesAndPaths(): void {
    const rng = this.rng;
    const wallY = this.ly1 + 1;
    const gate = (r: Rect, side: Side, f: Floor) => {
      this.fill(r, TILE.FLOOR, f);
      this.gates.push({ rect: r, side });
      for (let y = r.y - 2; y < r.y + r.h + 2; y++) for (let x = r.x - 2; x < r.x + r.w + 2; x++) this.reserve(x, y);
    };
    const cpx = this.carpark.x + rng.int(1, this.carpark.w - 4);
    gate({ x: cpx, y: wallY, w: 3, h: 1 }, "s", FLOOR.ASPHALT);
    const fronts = this.doors.filter((d) => d.rooms.includes(-1) && this.rooms[Math.max(...d.rooms)]!.kind === "foyer");
    for (const d of fronts) {
      let gx = Math.max(2, Math.min(this.lx1 - 2, d.x + rng.int(-3, 2)));
      if (this.gates.some((g) => Math.abs(g.rect.x - gx) < 5)) gx = Math.min(this.lx1 - 2, gx + 5);
      if (this.gates.some((g) => Math.abs(g.rect.x - gx) < 4)) continue;
      gate({ x: gx, y: wallY, w: 2, h: 1 }, "s", FLOOR.GRAVEL);
      this.path(gx, this.ly1, d.x, d.y + 1, 2);
    }
    if (this.buildings.length > 1 || rng.chance(0.8)) {
      const gy = rng.int(Math.floor(this.ly1 / 3), this.ly1 - 3);
      const gx = this.lx1 + 1;
      gate({ x: gx, y: gy, w: 1, h: 2 }, "e", FLOOR.GRAVEL);
      // a short path in
      for (let x = gx - 4; x < gx; x++) for (let y = gy; y < gy + 2; y++) this.paint(x, y, FLOOR.GRAVEL);
    }
    // paths from the other outside doors a few tiles out
    for (const d of this.doors) {
      if (!d.rooms.includes(-1)) continue;
      const [s0, s1] = sidesOf(d);
      const o = this.roomAt[this.i(...s0)]! < 0 ? s0 : s1;
      const dx = Math.sign(o[0] - d.x);
      const dy = Math.sign(o[1] - d.y);
      for (let k = 0; k < 3; k++) this.paint(o[0] + dx * k, o[1] + dy * k, FLOOR.GRAVEL);
      this.reserve(o[0], o[1], 1);
    }
  }
  paint(x: number, y: number, f: Floor): void {
    if (!this.ok(x, y)) return;
    const i = this.i(x, y);
    if (this.tiles[i] === TILE.FLOOR && this.floors[i] === FLOOR.GRASS) {
      this.floors[i] = f;
      this.reserved[i] = 1;
    }
  }
  /** An L-shaped path `width` wide from (x0, y0) north to row y1, then to column x1. */
  path(x0: number, y0: number, x1: number, y1: number, width: number): void {
    const ya = Math.min(y0, y1);
    const yb = Math.max(y0, y1);
    for (let y = ya; y <= yb; y++) for (let k = 0; k < width; k++) this.paint(x0 + k, y, FLOOR.GRAVEL);
    const xa = Math.min(x0, x1);
    const xb = Math.max(x0 + width - 1, x1);
    for (let x = xa; x <= xb; x++) for (let k = 0; k < width; k++) this.paint(x, y1 + k, FLOOR.GRAVEL);
  }

  parking(): void {
    const rng = this.rng;
    const { w, h } = this;
    const C = this.carpark;
    // the car park: slots of 2×3 along its back row
    const slots: Rect[] = [];
    for (let x = C.x; x + 2 <= C.x + C.w; x += 3) slots.push({ x, y: C.y, w: 2, h: 3 });
    const si = rng.int(0, slots.length - 1);
    this.spots.push(slots[si]!);
    slots.forEach((s, k) => {
      if (k !== si && rng.chance(0.65)) this.car(s);
    });
    // the alley's far end
    this.spots.push({ x: w - 4, y: 1, w: 3, h: 2 });
    // the street, near lane
    const nStreet = this.players >= 5 || rng.chance(0.5) ? 2 : 1;
    for (let k = 0; k < nStreet * 30 && this.spots.length < 2 + nStreet; k++) {
      const s: Rect = { x: rng.int(2, w - 6), y: h - 5, w: 3, h: 2 };
      if (this.spots.every((o) => centreDist(o, s) >= 14)) this.spots.push(s);
    }
    for (const s of this.spots) for (let y = s.y - 1; y <= s.y + s.h; y++) for (let x = s.x - 1; x <= s.x + s.w; x++) this.reserve(x, y);
    // parked cars on the street
    const nCars = rng.int(2, 4);
    for (let k = 0, placed = 0; k < 40 && placed < nCars; k++) {
      const c: Rect = { x: rng.int(2, w - 6), y: h - 5, w: 3, h: 2 };
      let ok = true;
      for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) if (this.reserved[this.i(x, y)] || this.tile(x, y) !== TILE.FLOOR) ok = false;
      if (!ok) continue;
      this.car(c);
      for (let x = c.x - 1; x <= c.x + c.w; x++) for (let y = c.y; y < c.y + c.h; y++) this.reserve(x, y);
      placed++;
    }
  }
  car(r: Rect): void {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) this.tiles[this.i(x, y)] = TILE.CAR;
    this.props.push({ kind: "car", rect: r, block: 2, room: -1, side: null });
  }

  // -- outside areas

  areasOut(): void {
    const { w, h } = this;
    const add = (a: GArea, r: Rect | null): number => {
      const id = this.areas.length;
      this.areas.push(a);
      if (r) {
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            const i = this.i(x, y);
            const t = this.tiles[i];
            if (this.roomAt[i]! < 0 && t !== TILE.LOT_WALL && t !== TILE.EDGE && t !== TILE.WALL && t !== TILE.DOOR && t !== TILE.WINDOW) this.areaAt[i] = id;
          }
        }
      }
      return id;
    };
    const segs = w >= 70 ? 3 : 2;
    for (let k = 0; k < segs; k++) {
      const x0 = 1 + Math.floor(((w - 2) * k) / segs);
      const x1 = 1 + Math.floor(((w - 2) * (k + 1)) / segs);
      add({ kind: "street", building: -1, side: null }, { x: x0, y: h - 6, w: x1 - x0, h: 5 });
    }
    add({ kind: "alley", building: -1, side: null }, { x: w - 4, y: 1, w: 3, h: h - 7 });
    add({ kind: "carpark", building: -1, side: null }, this.carpark);
    add({ kind: "yard", building: -1, side: null }, this.yard);
    // gardens: the rest of the lot, by the nearest building side (a multi-source BFS)
    const seeds: { x: number; y: number; id: number }[] = [];
    this.buildings.forEach((B, b) => {
      const cx = B.x + Math.floor(B.w / 2);
      const cy = B.y + Math.floor(B.h / 2);
      const anchors: [Side, number, number][] = [["s", cx, B.y + B.h + 1], ["n", cx, B.y - 2], ["w", B.x - 2, cy], ["e", B.x + B.w + 1, cy]];
      for (const [side, x, y] of anchors) {
        if (x < 1 || y < 1 || x > this.lx1 || y > this.ly1) continue;
        const i = this.i(x, y);
        if (this.areaAt[i]! >= 0 || this.inBuilding(x, y) >= 0) continue;
        if (seeds.some((s) => Math.abs(s.x - x) + Math.abs(s.y - y) < 8)) continue;
        seeds.push({ x, y, id: add({ kind: "garden", building: b, side }, null) });
      }
    });
    const queue: number[] = [];
    for (const s of seeds) {
      const i = this.i(s.x, s.y);
      this.areaAt[i] = s.id;
      queue.push(i);
    }
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]!;
      const x = i % w;
      const y = (i - x) / w;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        if (nx < 1 || ny < 1 || nx > this.lx1 || ny > this.ly1) continue;
        const j = this.i(nx, ny);
        if (this.areaAt[j]! >= 0 || this.roomAt[j]! >= 0) continue;
        const t = this.tiles[j]!;
        if (t === TILE.WALL || t === TILE.DOOR || t === TILE.WINDOW || t === TILE.LOT_WALL) continue;
        this.areaAt[j] = this.areaAt[i]!;
        queue.push(j);
      }
    }
    // gates belong to the lot side's area; the shed's walls to the yard
    for (const g of this.gates) {
      for (let y = g.rect.y; y < g.rect.y + g.rect.h; y++) {
        for (let x = g.rect.x; x < g.rect.x + g.rect.w; x++) {
          const inner = g.side === "s" ? this.areaAt[this.i(x, y - 1)]! : this.areaAt[this.i(x - 1, y)]!;
          this.areaAt[this.i(x, y)] = inner;
        }
      }
    }
  }

  // -- furniture

  furnish(): string | null {
    // guards' start tiles: the free tiles nearest the security office's middle
    const S = this.rooms[this.security]!;
    const cx = S.rect.x + (S.rect.w - 1) / 2;
    const cy = S.rect.y + (S.rect.h - 1) / 2;
    const tiles: number[] = [];
    for (let y = S.rect.y; y < S.rect.y + S.rect.h; y++) for (let x = S.rect.x; x < S.rect.x + S.rect.w; x++) if (!this.reserved[this.i(x, y)]) tiles.push(this.i(x, y));
    tiles.sort((a, b) => dist2(a % this.w, Math.floor(a / this.w), cx, cy) - dist2(b % this.w, Math.floor(b / this.w), cx, cy) || a - b);
    this.spawn = tiles.slice(0, 7);
    if (this.spawn.length < Math.max(this.players - 1, 4)) return "the security office is too small";
    for (const i of this.spawn) this.reserved[i] = 1;
    const benchRoom = this.garage >= 0 ? this.garage : this.shed;
    for (let r = 0; r < this.rooms.length; r++) {
      const room = this.rooms[r]!;
      for (const piece of RECIPES[room.kind!]) {
        if (piece.workbench && r !== benchRoom) continue;
        const n = this.rng.int(piece.n[0], piece.n[1]);
        for (let k = 0; k < n; k++) {
          const prop = this.placePiece(r, piece);
          if (prop < 0) {
            if (piece.must) return `no place for the ${piece.kind} in the ${room.kind}`;
            break;
          }
          if (piece.workbench) this.workbench = prop;
        }
      }
    }
    return this.workbench >= 0 ? null : "no workbench";
  }

  placePiece(r: number, piece: Piece): number {
    const room = this.rooms[r]!;
    const R = room.rect;
    const rng = this.rng;
    let len = piece.len;
    let depth = piece.depth;
    if (piece.kind === "dining") {
      len = Math.max(2, Math.max(R.w, R.h) - 4);
      depth = Math.min(R.w, R.h) >= 5 ? 2 : 1;
    }
    for (let attempt = 0; attempt < 24; attempt++) {
      let rect: Rect;
      let side: Side | null = null;
      if (piece.at === "wall" || piece.at === "corner") {
        side = rng.pick(SIDES)!;
        const horiz = side === "n" || side === "s";
        const pw = horiz ? len : depth;
        const ph = horiz ? depth : len;
        if (pw > R.w || ph > R.h) continue;
        const span = horiz ? R.w - pw : R.h - ph;
        const off = piece.at === "corner" ? (rng.chance(0.5) ? 0 : span) : rng.int(0, span);
        rect =
          side === "n" ? { x: R.x + off, y: R.y, w: pw, h: ph }
          : side === "s" ? { x: R.x + off, y: R.y + R.h - ph, w: pw, h: ph }
          : side === "w" ? { x: R.x, y: R.y + off, w: pw, h: ph }
          : { x: R.x + R.w - pw, y: R.y + off, w: pw, h: ph };
      } else {
        const alongX = R.w >= R.h;
        const pw = alongX ? len : depth;
        const ph = alongX ? depth : len;
        const m = piece.at === "centre" ? 1 : 0;
        if (pw + 2 * m > R.w || ph + 2 * m > R.h) continue;
        if (piece.at === "centre" && attempt < 6) {
          rect = { x: R.x + Math.floor((R.w - pw) / 2) + rng.int(-1, 1), y: R.y + Math.floor((R.h - ph) / 2) + rng.int(-1, 1), w: pw, h: ph };
          rect.x = Math.max(R.x + m, Math.min(R.x + R.w - m - pw, rect.x));
          rect.y = Math.max(R.y + m, Math.min(R.y + R.h - m - ph, rect.y));
        } else {
          rect = { x: R.x + m + rng.int(0, R.w - 2 * m - pw), y: R.y + m + rng.int(0, R.h - 2 * m - ph), w: pw, h: ph };
        }
      }
      if (this.tryProp(r, piece, rect, side)) return this.props.length - 1;
    }
    return -1;
  }

  tryProp(r: number, piece: Piece, rect: Rect, side: Side | null): boolean {
    const cells: number[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const i = this.i(x, y);
        if (this.roomAt[i] !== r || this.reserved[i] || this.tiles[i] !== TILE.FLOOR) return false;
        cells.push(i);
      }
    }
    if (this.props.some((p) => p.room === r && overlaps(p.rect, rect))) return false;
    if (piece.block) {
      for (const i of cells) this.tiles[i] = TILE.FURNITURE;
      const holders = this.props.filter((p) => p.room === r && (p.keep || p.kind === "workbench"));
      const ok = this.roomConnected(r) && [...holders.map((p) => p.rect), ...(piece.keep || piece.workbench ? [rect] : [])].every((h) => this.access(h, r) >= 0);
      if (!ok) {
        for (const i of cells) this.tiles[i] = TILE.FLOOR;
        return false;
      }
    }
    const prop: GProp = { kind: piece.kind, rect, block: piece.block ? 1 : 0, room: r, side };
    if (piece.keep) prop.keep = piece.keep;
    this.props.push(prop);
    return true;
  }

  /** A walkable tile of room r next to rect (the first in reading order), or -1. */
  access(rect: Rect, r: number): number {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        for (const [nx, ny] of [[x, y - 1], [x - 1, y], [x + 1, y], [x, y + 1]] as const) {
          const j = this.i(nx, ny);
          if (this.roomAt[j] === r && this.tiles[j] === TILE.FLOOR) return j;
        }
      }
    }
    return -1;
  }

  roomConnected(r: number): boolean {
    const R = this.rooms[r]!.rect;
    let total = 0;
    let start = -1;
    for (let y = R.y; y < R.y + R.h; y++) {
      for (let x = R.x; x < R.x + R.w; x++) {
        if (this.tiles[this.i(x, y)] === TILE.FLOOR) {
          total++;
          if (start < 0) start = this.i(x, y);
        }
      }
    }
    if (start < 0) return false;
    const seen = new Set<number>([start]);
    const q = [start];
    for (let k = 0; k < q.length; k++) {
      const i = q[k]!;
      for (const j of [i - 1, i + 1, i - this.w, i + this.w]) {
        if (!seen.has(j) && this.roomAt[j] === r && this.tiles[j] === TILE.FLOOR) {
          seen.add(j);
          q.push(j);
        }
      }
    }
    return seen.size === total;
  }

  // -- cover outside

  /** Walkable tiles (floor and doors), and how many the first spot reaches. */
  reach(): { total: number; reached: number } {
    let total = 0;
    for (let i = 0; i < this.tiles.length; i++) if (this.tiles[i] === TILE.FLOOR || this.tiles[i] === TILE.DOOR) total++;
    const s = this.spots[0]!;
    const dist = this.steps([this.i(s.x, s.y)]);
    let reached = 0;
    for (let i = 0; i < dist.length; i++) if (dist[i]! >= 0) reached++;
    return { total, reached };
  }
  connected(): boolean {
    const { total, reached } = this.reach();
    return total === reached;
  }

  /** Puts a piece of cover if its tiles are free grass/cobble and it closes no path. */
  tryCover(kind: PropKind, rect: Rect, tile: Tile): boolean {
    const cells: number[] = [];
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (x < 1 || y < 1 || x > this.lx1 || y > this.ly1) return false;
        const i = this.i(x, y);
        if (this.reserved[i] || this.tiles[i] !== TILE.FLOOR || this.roomAt[i]! >= 0) return false;
        const f = this.floors[i];
        if (f !== FLOOR.GRASS && f !== FLOOR.COBBLE) return false;
        if (inRect(this.carpark, x, y)) return false;
        cells.push(i);
      }
    }
    // keep a tile of air to other cover, so no wall of cover forms by accident
    for (let y = rect.y - 1; y <= rect.y + rect.h; y++) {
      for (let x = rect.x - 1; x <= rect.x + rect.w; x++) {
        if (inRect(rect, x, y)) continue;
        if (COVER[this.tile(x, y)]) return false;
      }
    }
    for (const i of cells) this.tiles[i] = tile;
    if (!this.connected()) {
      for (const i of cells) this.tiles[i] = TILE.FLOOR;
      return false;
    }
    this.props.push({ kind, rect, block: 2, room: -1, side: null });
    return true;
  }

  cover(): void {
    const rng = this.rng;
    const B = this.buildings[0]!;
    // a fountain in the main building's front garden
    const fy0 = B.y + B.h + 2;
    if (this.ly1 - fy0 >= 4) {
      for (let k = 0; k < 12; k++) {
        const x = B.x + Math.floor(B.w / 2) - 1 + rng.int(-6, 6);
        const y = fy0 + rng.int(0, this.ly1 - fy0 - 4);
        if (this.tryCover("fountain", { x, y, w: 3, h: 3 }, TILE.FOUNTAIN)) break;
      }
    }
    const gardenTiles = this.areaAtCount("garden");
    // hedges
    const nh = Math.round(gardenTiles / 90);
    for (let k = 0, placed = 0; k < nh * 6 && placed < nh; k++) {
      const len = rng.int(3, 6);
      const horiz = rng.chance(0.6);
      const x = rng.int(1, this.lx1);
      const y = rng.int(1, this.ly1);
      if (this.tryCover("hedge", horiz ? { x, y, w: len, h: 1 } : { x, y, w: 1, h: len }, TILE.HEDGE)) placed++;
    }
    // trees
    const nt = Math.round(gardenTiles / 45);
    for (let k = 0, placed = 0; k < nt * 5 && placed < nt; k++) {
      const big = rng.chance(0.2);
      const x = rng.int(1, this.lx1);
      const y = rng.int(1, this.ly1);
      if (this.tryCover("tree", { x, y, w: big ? 2 : 1, h: big ? 2 : 1 }, TILE.TREE)) placed++;
    }
    // a hut or two behind the houses
    const nHut = rng.int(0, this.buildings.length);
    for (let k = 0, placed = 0; k < 20 && placed < nHut; k++) {
      const x = rng.int(1, this.lx1 - 1);
      const y = rng.int(1, Math.max(1, B.y - 3));
      if (this.tryCover("hut", { x, y, w: 2, h: 2 }, TILE.SHED)) placed++;
    }
  }
  areaAtCount(kind: AreaKind): number {
    let n = 0;
    for (let i = 0; i < this.areaAt.length; i++) {
      const a = this.areaAt[i]!;
      if (a >= 0 && this.areas[a]!.kind === kind) n++;
    }
    return n;
  }

  /** Cover between the buildings and every spot (§11): the route to the nearest door passes cover. */
  coverChecks(): string | null {
    const out = this.steps(this.outsideDoorTiles(true));
    for (let s = 0; s < this.spots.length; s++) {
      const S = this.spots[s]!;
      for (let k = 0; ; k++) {
        const r = bestCoveredRoute(this.tiles, this.w, this.h, out, { x: S.x, y: S.y, w: S.w, h: S.h });
        if (!r) return "a spot is unreachable";
        if (r.cover >= 2) break;
        if (k >= 6) return "no cover between a spot and the house";
        // a tree right beside the best covered route (only cover next to it counts), away from its ends
        const path = r.path;
        const onPath = new Set(path);
        const cands: number[] = [];
        for (const at of path.slice(Math.floor(path.length / 5), Math.ceil((4 * path.length) / 5))) {
          const x = at % this.w;
          const y = (at - x) / this.w;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if ((dx || dy) && this.ok(x + dx, y + dy) && !onPath.has(this.i(x + dx, y + dy))) cands.push(this.i(x + dx, y + dy));
            }
          }
        }
        for (const j of this.rng.shuffle([...new Set(cands)].sort((a, b) => a - b)).slice(0, 24)) {
          if (this.tryCover("tree", { x: j % this.w, y: Math.floor(j / this.w), w: 1, h: 1 }, TILE.TREE)) break;
        }
      }
    }
    return null;
  }
  routeFromSpot(s: number, doors: number[]): number[] | null {
    const S = this.spots[s]!;
    const dist = this.steps(doors);
    let best = -1;
    for (let y = S.y; y < S.y + S.h; y++) {
      for (let x = S.x; x < S.x + S.w; x++) {
        const i = this.i(x, y);
        if (dist[i]! >= 0 && (best < 0 || dist[i]! < dist[best]!)) best = i;
      }
    }
    if (best < 0) return null;
    const path = [best];
    let i = best;
    while (dist[i]! > 0) {
      let next = -1;
      for (const j of neighbours8(this.tiles, this.w, this.h, i)) if (dist[j] === dist[i]! - 1 && (next < 0 || j < next)) next = j;
      if (next < 0) break;
      path.push(next);
      i = next;
    }
    return path;
  }

  // -- lamps, cameras

  lampsOut(): void {
    const rng = this.rng;
    const { w, h } = this;
    const cand: [number, number][] = [];
    const spacing = rng.int(13, 16);
    for (let x = 3 + rng.int(0, 5); x < w - 2; x += spacing) cand.push([x, h - 6]);
    for (const d of this.doors) {
      if (!d.rooms.includes(-1) || this.rooms[Math.max(...d.rooms)]!.building < 0 || !rng.chance(0.6)) continue;
      const [s0, s1] = sidesOf(d);
      const o = this.roomAt[this.i(...s0)]! < 0 ? s0 : s1;
      cand.push(d.wall === "h" ? [o[0] + (rng.chance(0.5) ? 1 : -1), o[1]] : [o[0], o[1] + (rng.chance(0.5) ? 1 : -1)]);
    }
    cand.push([this.carpark.x + Math.floor(this.carpark.w / 2), this.ly1]);
    if (rng.chance(0.5)) cand.push([w - 3, rng.int(Math.floor(h / 3), h - 9)]);
    for (let k = 0; k < 4 + this.buildings.length * 2; k++) cand.push([rng.int(1, this.lx1), rng.int(1, this.ly1)]);
    for (const [x, y] of cand) {
      if (!this.ok(x, y)) continue;
      const i = this.i(x, y);
      if (this.tiles[i] !== TILE.FLOOR || this.roomAt[i]! >= 0) continue;
      if (this.spots.some((s) => inRect(s, x, y))) continue;
      if (this.lamps.some(([lx, ly]) => (lx - x) ** 2 + (ly - y) ** 2 < 64)) continue;
      this.lamps.push([x, y]);
    }
  }

  camerasOut(): string | null {
    const rng = this.rng;
    const inside: { x: number; y: number; angle: number; room: number }[] = [];
    for (const c of this.corridors) {
      const room = this.roomAt[this.i(c.x, c.y)]!;
      if (c.w > c.h) {
        const y = c.y + rng.int(0, 1);
        inside.push({ x: c.x - 1, y, angle: 0, room }, { x: c.x + c.w, y, angle: 180, room });
      } else {
        const x = c.x + rng.int(0, 1);
        inside.push({ x, y: c.y - 1, angle: 90, room }, { x, y: c.y + c.h, angle: 270, room });
      }
    }
    const outside: { x: number; y: number; angle: number; room: number }[] = [];
    for (const B of this.buildings) {
      outside.push(
        { x: B.x, y: B.y, angle: 225, room: -1 },
        { x: B.x + B.w - 1, y: B.y, angle: 315, room: -1 },
        { x: B.x, y: B.y + B.h - 1, angle: 135, room: -1 },
        { x: B.x + B.w - 1, y: B.y + B.h - 1, angle: 45, room: -1 },
      );
    }
    for (const g of this.gates) {
      if (g.side === "s") outside.push({ x: g.rect.x - 1, y: g.rect.y, angle: 285, room: -1 }, { x: g.rect.x + g.rect.w, y: g.rect.y, angle: 255, room: -1 });
      else outside.push({ x: g.rect.x, y: g.rect.y - 1, angle: 195, room: -1 });
    }
    const valid = (c: { x: number; y: number }) => {
      const t = this.tile(c.x, c.y);
      return t === TILE.WALL || t === TILE.LOT_WALL;
    };
    const want = Math.min(4, (this.players <= 4 ? 2 : this.players <= 6 ? 3 : 4) + (rng.chance(0.3) ? 1 : 0));
    const pool = [...rng.shuffle(inside.filter(valid)), ...rng.shuffle(outside.filter(valid))];
    const chosen: typeof pool = [];
    const firstIn = pool.find((c) => c.room >= 0);
    if (firstIn) chosen.push(firstIn);
    const firstOut = pool.find((c) => c.room < 0);
    if (firstOut) chosen.push(firstOut);
    while (chosen.length < want) {
      let best: (typeof pool)[number] | null = null;
      let bestD = -1;
      for (const c of pool) {
        if (chosen.includes(c)) continue;
        const d = Math.min(...chosen.map((o) => (o.x - c.x) ** 2 + (o.y - c.y) ** 2));
        if (d > bestD) {
          bestD = d;
          best = c;
        }
      }
      if (!best || bestD < 36) break;
      chosen.push(best);
    }
    if (chosen.length < 2) return "no places for cameras";
    this.cameras.push(...chosen);
    return null;
  }

  // -- the result

  finish(seed: number, attempt: number): Estate {
    const { w, h } = this;
    const fx = this.rng.chance(0.5);
    const fy = this.rng.chance(0.5);
    const X = (x: number) => (fx ? w - 1 - x : x);
    const Y = (y: number) => (fy ? h - 1 - y : y);
    const I = (i: number) => Y(Math.floor(i / w)) * w + X(i % w);
    const R = (r: Rect): Rect => ({ x: fx ? w - r.x - r.w : r.x, y: fy ? h - r.y - r.h : r.y, w: r.w, h: r.h });
    const S = (s: Side): Side => (fx && s === "e" ? "w" : fx && s === "w" ? "e" : fy && s === "n" ? "s" : fy && s === "s" ? "n" : s);
    const A = (a: number) => {
      let b = fx ? 180 - a : a;
      if (fy) b = -b;
      return ((b % 360) + 360) % 360;
    };
    const layer = <T extends Uint8Array | Int16Array>(src: T, make: (n: number) => T): T => {
      const out = make(src.length);
      for (let i = 0; i < src.length; i++) out[I(i)] = src[i]!;
      return out;
    };
    // area ids: drop empty ones
    const used = new Set<number>();
    for (const a of this.areaAt) if (a >= 0) used.add(a);
    const areaMap = new Map<number, number>();
    [...used].sort((a, b) => a - b).forEach((a, k) => areaMap.set(a, k));
    const areaAt = new Int16Array(this.areaAt.length).fill(-1);
    for (let i = 0; i < this.areaAt.length; i++) {
      const a = this.areaAt[i]!;
      if (a >= 0) areaAt[I(i)] = areaMap.get(a)!;
    }
    const nthOf = new Map<string, number>();
    const nth = (k: string) => {
      const n = nthOf.get(k) ?? 0;
      nthOf.set(k, n + 1);
      return n;
    };
    const areas: Area[] = [...areaMap.entries()].map(([src, id]) => {
      const a = this.areas[src]!;
      return { id, kind: a.kind, nth: nth(`a:${a.kind}`), rect: { x: 0, y: 0, w: 0, h: 0 }, building: a.building, side: a.side ? S(a.side) : null };
    });
    const boxes = areas.map(() => ({ x0: w, y0: h, x1: -1, y1: -1 }));
    for (let i = 0; i < areaAt.length; i++) {
      const a = areaAt[i]!;
      if (a < 0) continue;
      const b = boxes[a]!;
      const x = i % w;
      const y = Math.floor(i / w);
      b.x0 = Math.min(b.x0, x);
      b.y0 = Math.min(b.y0, y);
      b.x1 = Math.max(b.x1, x);
      b.y1 = Math.max(b.y1, y);
    }
    areas.forEach((a, k) => {
      const b = boxes[k]!;
      a.rect = { x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 };
    });
    const areaOf = (r: Rect) => areaAt[I(this.i(r.x, r.y))]!;
    const rooms: Room[] = this.rooms.map((r, id) => ({
      id,
      kind: r.kind!,
      nth: nth(`r:${r.kind}`),
      building: r.building,
      rect: R(r.rect),
      lit: r.lit,
      switches: [],
      doors: [],
      windows: [],
    }));
    const doors: Door[] = this.doors.map((d, id) => {
      const rooms2: [number, number] = (d.wall === "v" && fx) || (d.wall === "h" && fy) ? [d.rooms[1], d.rooms[0]] : [d.rooms[0], d.rooms[1]];
      return { id, x: X(d.x), y: Y(d.y), i: 0, wall: d.wall, rooms: rooms2, outside: false, locked: d.locked };
    });
    const bp: Blueprint = {
      w,
      h,
      tiles: layer(this.tiles, (n) => new Uint8Array(n)),
      floors: layer(this.floors, (n) => new Uint8Array(n)),
      roomAt: new Int16Array(0),
      areaAt,
      doorAt: new Int16Array(0),
      windowAt: new Int16Array(0),
      front: S("s"),
      lot: R({ x: 0, y: 0, w: w - 4, h: h - 6 }),
      buildings: this.buildings.map((r, id) => ({ id, rect: R(r), main: id === 0 })),
      rooms,
      areas,
      doors,
      windows: this.windows.map((p, id) => ({ id, x: X(p.x), y: Y(p.y), i: 0, wall: p.wall, room: p.room })),
      lamps: this.lamps.map(([x, y], id) => ({ id, x: X(x), y: Y(y), i: 0 })),
      cameras: this.cameras.map((c, id) => ({ id, x: X(c.x), y: Y(c.y), i: 0, angle: A(c.angle), fov: CAMERA_FOV, range: CAMERA_RANGE, room: c.room })),
      spots: this.spots.map((r, id) => ({ id, rect: R(r), area: areaOf(r) })),
      gates: this.gates.map((g, id) => ({ id, rect: R(g.rect), side: S(g.side), area: areaOf(g.rect) })),
      props: this.props.map((p, id) => ({ id, kind: p.kind, rect: R(p.rect), block: p.block, room: p.room, side: p.side ? S(p.side) : null })),
      workbench: { prop: this.workbench, room: this.props[this.workbench]!.room, access: 0 },
      security: this.security,
      spawn: this.spawn.map(I).sort((a, b) => a - b),
    };
    indexBlueprint(bp);
    for (const r of bp.rooms) r.switches = [...new Set(r.doors.map((d) => doorSide(bp, bp.doors[d]!, r.id)))].filter((i) => i >= 0).sort((a, b) => a - b);
    bp.workbench.access = propAccess(bp, bp.props[bp.workbench.prop]!).access;
    // loot places: the holders deep enough inside
    const dist = stepsFrom(bp.tiles, w, h, bp.doors.filter((d) => d.outside).map((d) => d.i));
    const places: Place[] = [];
    this.props.forEach((p, id) => {
      if (!p.keep || p.room < 0) return;
      const room = bp.rooms[p.room]!;
      if (room.building < 0) return;
      if (p.keep === "pedestal" && room.kind !== "vault") return;
      const prop = bp.props[id]!;
      const { tile, access } = propAccess(bp, prop);
      const depth = access >= 0 ? dist[access]! : -1;
      if (tile < 0 || depth <= MIN_LOOT_DEPTH) return;
      const x = tile % w;
      const y = Math.floor(tile / w);
      places.push({ id: places.length, prop: id, x, y, i: tile, access, room: p.room, keep: p.keep, depth, wing: wingOf(bp, room.building, x, y) });
    });
    const car = this.rng.int(0, bp.spots.length - 1);
    return { players: this.players, seed, attempt, map: bp, car, places };
  }
}

/** Checks the generator's work that needs the loot places (after `finish`); null when fine. */
export function checkPlaces(e: Estate): string | null {
  if (e.places.length < lootCount(e.players) + 2) return "too few loot places";
  if (!e.places.some((p) => p.keep === "pedestal")) return "no pedestal in the vault";
  return null;
}

function area(r: Rect): number {
  return r.w * r.h;
}
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function centreDist(a: Rect, b: Rect): number {
  return Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);
}
function dist2(x: number, y: number, cx: number, cy: number): number {
  return (x - cx) ** 2 + (y - cy) ** 2;
}

/** The tile of a prop an item lies on (one with a walkable neighbour in its room), and that neighbour. */
export function propAccess(map: Blueprint, p: Prop): { tile: number; access: number } {
  const { w } = map;
  for (let y = p.rect.y; y < p.rect.y + p.rect.h; y++) {
    for (let x = p.rect.x; x < p.rect.x + p.rect.w; x++) {
      for (const [nx, ny] of [[x, y - 1], [x - 1, y], [x + 1, y], [x, y + 1]] as const) {
        if (!inBounds(map, nx, ny)) continue;
        const j = ny * w + nx;
        if (map.tiles[j] === TILE.FLOOR && map.roomAt[j] === p.room) return { tile: y * w + x, access: j };
      }
    }
  }
  return { tile: -1, access: -1 };
}

/** The wing of a tile in building b. */
export function wingOf(map: Blueprint, b: number, x: number, y: number): Wing {
  const B = map.buildings[b]!.rect;
  if (B.w >= B.h) return { building: b, half: x + 0.5 < B.x + B.w / 2 ? "w" : "e" };
  return { building: b, half: y + 0.5 < B.y + B.h / 2 ? "n" : "s" };
}

/** Neighbours a body can step to from i (8-way, no corner cutting, diagonals only between floor tiles). */
function neighbours8(tiles: Uint8Array, w: number, h: number, i: number): number[] {
  const x = i % w;
  const y = (i - x) / w;
  const pass = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < w && yy < h && (tiles[yy * w + xx] === TILE.FLOOR || tiles[yy * w + xx] === TILE.DOOR);
  const floor = (xx: number, yy: number) => tiles[yy * w + xx] === TILE.FLOOR;
  const out: number[] = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (pass(x + dx, y + dy)) out.push((y + dy) * w + x + dx);
  if (tiles[i] !== TILE.FLOOR) return out;
  for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    if (pass(x + dx, y) && pass(x, y + dy) && pass(x + dx, y + dy) && floor(x + dx, y) && floor(x, y + dy) && floor(x + dx, y + dy)) out.push((y + dy) * w + x + dx);
  }
  return out;
}

/** Steps from the sources over floor and doors (8-way, no corner cutting, diagonals between floor tiles only); -1 unreached. */
export function stepsFrom(tiles: Uint8Array, w: number, h: number, sources: readonly number[]): Int32Array {
  const n = w * h;
  const dist = new Int32Array(n).fill(-1);
  const q = new Int32Array(n);
  let qn = 0;
  for (const s of sources) {
    if (s >= 0 && s < n && dist[s] === -1) {
      dist[s] = 0;
      q[qn++] = s;
    }
  }
  const pass = (t: number) => t === TILE.FLOOR || t === TILE.DOOR;
  for (let k = 0; k < qn; k++) {
    const i = q[k]!;
    const x = i % w;
    const y = (i - x) / w;
    const d = dist[i]! + 1;
    const e = x + 1 < w && pass(tiles[i + 1]!);
    const ww = x > 0 && pass(tiles[i - 1]!);
    const s = y + 1 < h && pass(tiles[i + w]!);
    const nn = y > 0 && pass(tiles[i - w]!);
    if (e && dist[i + 1] === -1) (dist[i + 1] = d), (q[qn++] = i + 1);
    if (ww && dist[i - 1] === -1) (dist[i - 1] = d), (q[qn++] = i - 1);
    if (s && dist[i + w] === -1) (dist[i + w] = d), (q[qn++] = i + w);
    if (nn && dist[i - w] === -1) (dist[i - w] = d), (q[qn++] = i - w);
    if (tiles[i] !== TILE.FLOOR) continue;
    const F = TILE.FLOOR;
    const diag = (j: number, a: number, b: number) => {
      if (tiles[j] === F && tiles[a] === F && tiles[b] === F && dist[j] === -1) {
        dist[j] = d;
        q[qn++] = j;
      }
    };
    if (e && s) diag(i + w + 1, i + 1, i + w);
    if (ww && s) diag(i + w - 1, i - 1, i + w);
    if (e && nn) diag(i - w + 1, i + 1, i - w);
    if (ww && nn) diag(i - w - 1, i - 1, i - w);
  }
  return dist;
}

/** How many tiles of a path touch (8-way) outside cover. */
function coverNear(tiles: Uint8Array, w: number, path: readonly number[]): number {
  let n = 0;
  for (const i of path) {
    const x = i % w;
    const y = (i - x) / w;
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) if (COVER[tiles[(y + dy) * w + x + dx] ?? 0]) near = true;
    if (near) n++;
  }
  return n;
}

/**
 * The shortest route from a spot to the nearest building door (`out`: steps from those doors) that passes the
 * most cover, and how many of its tiles are next to cover: a covered way in exists. The answer does not depend on
 * tie-breaks or on how the map was mirrored. Null when the spot is unreachable.
 */
function bestCoveredRoute(tiles: Uint8Array, w: number, h: number, out: Int32Array, spot: Rect): { cover: number; path: number[] } | null {
  let start = -1;
  for (let y = spot.y; y < spot.y + spot.h; y++) {
    for (let x = spot.x; x < spot.x + spot.w; x++) {
      const i = y * w + x;
      if (out[i]! >= 0 && (start < 0 || out[i]! < out[start]!)) start = i;
    }
  }
  if (start < 0) return null;
  const near = (i: number) => coverNear(tiles, w, [i]);
  // best[i]: the most cover from i down to a door along tiles with falling steps
  const best = new Map<number, number>();
  const next = new Map<number, number>();
  const solve = (i: number): number => {
    const known = best.get(i);
    if (known !== undefined) return known;
    let b = 0;
    let via = -1;
    if (out[i]! > 0) {
      b = -1;
      for (const j of neighbours8(tiles, w, h, i)) {
        if (out[j] !== out[i]! - 1) continue;
        const c = solve(j);
        if (c > b) {
          b = c;
          via = j;
        }
      }
      if (via < 0) b = 0;
    }
    b += near(i);
    best.set(i, b);
    next.set(i, via);
    return b;
  };
  // iterative order (no deep recursion): solve from the doors upwards
  const order: number[] = [];
  const seen = new Set<number>([start]);
  for (let k = 0, q = [start]; k < q.length; k++) {
    const i = q[k]!;
    order.push(i);
    for (const j of neighbours8(tiles, w, h, i)) if (out[j] === out[i]! - 1 && !seen.has(j)) seen.add(j), q.push(j);
  }
  for (let k = order.length - 1; k >= 0; k--) solve(order[k]!);
  const path = [start];
  for (let i = next.get(start) ?? -1; i >= 0; i = next.get(i) ?? -1) path.push(i);
  return { cover: best.get(start)!, path };
}

/**
 * Door-disjoint routes from room `from` to the outside, not through door
 * `skip` (unit-capacity max flow on the room graph; counts up to 3).
 */
function doorRoutes(nRooms: number, doors: readonly { rooms: readonly [number, number] }[], from: number, skip: number): number {
  const OUT = nRooms;
  // arcs: for door k, 2k: a→b, 2k+1: b→a; residual capacity per arc
  const cap = new Int8Array(doors.length * 2);
  const ends = doors.map((d) => d.rooms.map((r) => (r < 0 ? OUT : r)) as [number, number]);
  const adj: number[][] = Array.from({ length: nRooms + 1 }, () => []);
  doors.forEach((_, k) => {
    if (k === skip) return;
    const [a, b] = ends[k]!;
    if (a === b) return;
    cap[2 * k] = 1;
    cap[2 * k + 1] = 1;
    adj[a]!.push(2 * k);
    adj[b]!.push(2 * k + 1);
  });
  const head = (arc: number) => {
    const [a, b] = ends[arc >> 1]!;
    return arc & 1 ? a : b;
  };
  let flow = 0;
  while (flow < 3) {
    const prev = new Int32Array(nRooms + 1).fill(-1);
    const seen = new Uint8Array(nRooms + 1);
    seen[from] = 1;
    const q = [from];
    for (let k = 0; k < q.length && !seen[OUT]; k++) {
      const u = q[k]!;
      for (const arc of adj[u]!) {
        const v = head(arc);
        if (cap[arc]! > 0 && !seen[v]) {
          seen[v] = 1;
          prev[v] = arc;
          q.push(v);
        }
      }
    }
    if (!seen[OUT]) break;
    for (let v = OUT; v !== from; ) {
      const arc = prev[v]!;
      cap[arc] = cap[arc]! - 1;
      cap[arc ^ 1] = cap[arc ^ 1]! + 1;
      v = arc & 1 ? ends[arc >> 1]![1] : ends[arc >> 1]![0];
    }
    flow++;
  }
  return flow;
}

/** §11's checks on a finished estate (the generator runs them; tests too). Null when all pass. */
export function checkEstate(e: Estate): string | null {
  const m = e.map;
  const { w, h, tiles } = m;
  // everything walkable connected
  const all: number[] = [];
  for (let i = 0; i < tiles.length; i++) if (tiles[i] === TILE.FLOOR || tiles[i] === TILE.DOOR) all.push(i);
  const dist = stepsFrom(tiles, w, h, [all[0]!]);
  if (all.some((i) => dist[i]! < 0)) return "not everything walkable is connected";
  // every spot reachable from every room
  for (const r of m.rooms) {
    const t = r.rect.y * w + r.rect.x;
    let ok = false;
    for (let y = r.rect.y; y < r.rect.y + r.rect.h && !ok; y++) for (let x = r.rect.x; x < r.rect.x + r.rect.w && !ok; x++) if (dist[y * w + x]! >= 0) ok = true;
    if (!ok) return `room ${r.id} (${r.kind}) unreachable from ${t}`;
  }
  for (const s of m.spots) if (dist[s.rect.y * w + s.rect.x]! < 0) return `spot ${s.id} unreachable`;
  // no loot place within MIN_LOOT_DEPTH of an outside door
  const fromOut = stepsFrom(tiles, w, h, m.doors.filter((d) => d.outside).map((d) => d.i));
  for (const p of e.places) if (fromOut[p.access]! <= MIN_LOOT_DEPTH || fromOut[p.access] !== p.depth) return `loot place ${p.id} too near a door`;
  // two door-disjoint routes from the vault
  const vault = m.rooms.find((r) => r.kind === "vault");
  if (!vault || vault.doors.length !== 1) return "the vault needs exactly one door";
  const vd = vault.doors[0]!;
  const ante = Math.max(...m.doors[vd]!.rooms.filter((r) => r !== vault.id));
  if (ante < 0 || doorRoutes(m.rooms.length, m.doors, ante, vd) < 2) return "the vault has fewer than two routes out";
  if (!m.doors[vd]!.locked) return "the vault's door is not locked";
  // cover between the buildings and every spot
  const out = stepsFrom(tiles, w, h, m.doors.filter((d) => d.outside && m.rooms[Math.max(...d.rooms)]!.building >= 0).map((d) => d.i));
  for (const s of m.spots) {
    const r = bestCoveredRoute(tiles, w, h, out, s.rect);
    if (!r) return `spot ${s.id} unreachable from the doors`;
    if (r.cover < 2) return `no cover between spot ${s.id} and the house`;
  }
  if (m.spots.length < 3 || m.spots.length > 4) return "3–4 spots";
  if (m.cameras.length < 2 || m.cameras.length > 4) return "2–4 cameras";
  if (m.spawn.length < Math.max(e.players - 1, 4)) return "too few start tiles";
  if (e.car < 0 || e.car >= m.spots.length) return "no car";
  return checkPlaces(e);
}

// ---------------------------------------------------------------- loot

/**
 * The loot places as items.ts `pickCatalogue` takes them (`LootPlace`:
 * how it is kept, the room's kind, the depth), in the order of
 * `e.places`: `pickCatalogue(lootCount(players), rng, lootPlaces(e))`
 * gives each night item a `place` that indexes `e.places`.
 */
export function lootPlaces(e: Estate): { keep: Keep; room: RoomKind; depth: number }[] {
  return e.places.map((p) => ({ keep: p.keep, room: e.map.rooms[p.room]!.kind, depth: p.depth }));
}

// ---------------------------------------------------------------- the wire

/** The blueprint as JSON for a view (`encodeBlueprint`): tuples and run-length strings. */
export interface BlueprintWire {
  v: 1;
  w: number;
  h: number;
  /** tile * 16 + floor, run-length encoded. */
  cells: string;
  /** areaAt + 1, run-length encoded. */
  areas: string;
  front: Side;
  lot: number[];
  buildings: number[][];
  /** [kind, nth, building, x, y, w, h, lit, ...switches] */
  rooms: number[][];
  /** [kind, nth, building, side (-1 none), x, y, w, h] */
  area: number[][];
  /** [x, y, wall (0 h, 1 v), roomA, roomB, locked] */
  doors: number[][];
  /** [x, y, wall, room] */
  windows: number[][];
  lamps: number[][];
  /** [x, y, angle, fov, range, room] */
  cameras: number[][];
  /** [x, y, w, h, area] */
  spots: number[][];
  /** [x, y, w, h, side, area] */
  gates: number[][];
  /** [kind, x, y, w, h, block, side (-1), room] */
  props: number[][];
  /** [prop, room, access] */
  workbench: number[];
  security: number;
  spawn: number[];
}

const sideIx = (s: Side | null) => (s ? SIDES.indexOf(s) : -1);
const rectT = (r: Rect) => [r.x, r.y, r.w, r.h];

/** The public blueprint as a compact JSON value (about 4–8 KB). */
export function encodeBlueprint(m: Blueprint): BlueprintWire {
  const cells = new Uint8Array(m.w * m.h);
  for (let i = 0; i < cells.length; i++) cells[i] = m.tiles[i]! * 16 + m.floors[i]!;
  const areas = new Int32Array(m.w * m.h);
  for (let i = 0; i < areas.length; i++) areas[i] = m.areaAt[i]! + 1;
  return {
    v: 1,
    w: m.w,
    h: m.h,
    cells: rleEncode(cells),
    areas: rleEncode(areas),
    front: m.front,
    lot: rectT(m.lot),
    buildings: m.buildings.map((b) => [...rectT(b.rect), b.main ? 1 : 0]),
    rooms: m.rooms.map((r) => [ROOM_KINDS.indexOf(r.kind), r.nth, r.building, ...rectT(r.rect), r.lit ? 1 : 0, ...r.switches]),
    area: m.areas.map((a) => [AREA_KINDS.indexOf(a.kind), a.nth, a.building, sideIx(a.side), ...rectT(a.rect)]),
    doors: m.doors.map((d) => [d.x, d.y, d.wall === "h" ? 0 : 1, d.rooms[0], d.rooms[1], d.locked ? 1 : 0]),
    windows: m.windows.map((p) => [p.x, p.y, p.wall === "h" ? 0 : 1, p.room]),
    lamps: m.lamps.map((l) => [l.x, l.y]),
    cameras: m.cameras.map((c) => [c.x, c.y, c.angle, c.fov, c.range, c.room]),
    spots: m.spots.map((s) => [...rectT(s.rect), s.area]),
    gates: m.gates.map((g) => [...rectT(g.rect), sideIx(g.side), g.area]),
    props: m.props.map((p) => [PROP_KINDS.indexOf(p.kind), ...rectT(p.rect), p.block, sideIx(p.side), p.room]),
    workbench: [m.workbench.prop, m.workbench.room, m.workbench.access],
    security: m.security,
    spawn: [...m.spawn],
  };
}

/** {@link encodeBlueprint} back, checked; null for anything malformed (never throws). */
export function decodeBlueprint(v: unknown): Blueprint | null {
  try {
    return decode(v);
  } catch {
    return null;
  }
}

function decode(v: unknown): Blueprint | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const int = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
  if (o["v"] !== 1 || !int(o["w"], 8, 512) || !int(o["h"], 8, 512)) return null;
  const w = o["w"];
  const h = o["h"];
  const n = w * h;
  const cells = rleDecode(o["cells"], n, 255);
  const areaRaw = rleDecode(o["areas"], n, 4096);
  if (!cells || !areaRaw) return null;
  const tiles = new Uint8Array(n);
  const floors = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    tiles[i] = cells[i]! >> 4;
    floors[i] = cells[i]! & 15;
    if (tiles[i]! >= TILE_KINDS || floors[i]! >= FLOOR_KINDS) return null;
  }
  const rows = (k: string, min: number, max = min): number[][] | null => {
    const a = o[k];
    if (!Array.isArray(a) || a.length > 4096) return null;
    for (const r of a) if (!Array.isArray(r) || r.length < min || r.length > max || !r.every((x) => int(x, -1, 1 << 20))) return null;
    return a as number[][];
  };
  const rect = (r: readonly number[], k: number): Rect | null => {
    const [x, y, rw, rh] = [r[k]!, r[k + 1]!, r[k + 2]!, r[k + 3]!];
    return x >= 0 && y >= 0 && rw >= 1 && rh >= 1 && x + rw <= w && y + rh <= h ? { x, y, w: rw, h: rh } : null;
  };
  const side = (s: number): Side | null | undefined => (s === -1 ? null : SIDES[s]);
  const front = o["front"];
  if (typeof front !== "string" || !SIDES.includes(front as Side)) return null;
  const lotA = o["lot"];
  if (!Array.isArray(lotA) || lotA.length !== 4 || !lotA.every((x) => int(x, 0, 512))) return null;
  const lot = rect(lotA as number[], 0);
  const bRows = rows("buildings", 5);
  const rRows = rows("rooms", 8, 64);
  const aRows = rows("area", 8);
  const dRows = rows("doors", 6);
  const wRows = rows("windows", 4);
  const lRows = rows("lamps", 2);
  const cRows = rows("cameras", 6);
  const sRows = rows("spots", 5);
  const gRows = rows("gates", 6);
  const pRows = rows("props", 8);
  if (!lot || !bRows || !rRows || !aRows || !dRows || !wRows || !lRows || !cRows || !sRows || !gRows || !pRows) return null;
  const nR = rRows.length;
  const nA = aRows.length;
  const okRoom = (r: number, outside: boolean) => (outside && r === -1) || (r >= 0 && r < nR);
  const okArea = (a: number) => a >= -1 && a < nA;
  const tile = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? y * w + x : -1);
  const areaAt = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    areaAt[i] = areaRaw[i]! - 1;
    if (areaAt[i]! >= nA) return null;
  }
  const buildings: Building[] = [];
  for (const [k, r] of bRows.entries()) {
    const rc = rect(r, 0);
    if (!rc || (r[4] !== 0 && r[4] !== 1)) return null;
    buildings.push({ id: k, rect: rc, main: r[4] === 1 });
  }
  const rooms: Room[] = [];
  for (const [k, r] of rRows.entries()) {
    const kind = ROOM_KINDS[r[0]!];
    const rc = rect(r, 3);
    if (!kind || !rc || r[1]! < 0 || !(r[2] === -1 || (r[2]! >= 0 && r[2]! < buildings.length)) || (r[7] !== 0 && r[7] !== 1)) return null;
    const switches = r.slice(8);
    if (!switches.every((i) => i >= 0 && i < n)) return null;
    rooms.push({ id: k, kind, nth: r[1]!, building: r[2]!, rect: rc, lit: r[7] === 1, switches, doors: [], windows: [] });
  }
  const areas: Area[] = [];
  for (const [k, r] of aRows.entries()) {
    const kind = AREA_KINDS[r[0]!];
    const s = side(r[3]!);
    const rc = rect(r, 4);
    if (!kind || s === undefined || !rc || r[1]! < 0 || !(r[2] === -1 || (r[2]! >= 0 && r[2]! < buildings.length))) return null;
    areas.push({ id: k, kind, nth: r[1]!, rect: rc, building: r[2]!, side: s });
  }
  const doors: Door[] = [];
  for (const [k, r] of dRows.entries()) {
    const i = tile(r[0]!, r[1]!);
    if (i < 0 || tiles[i] !== TILE.DOOR || r[2]! > 1 || r[2]! < 0 || !okRoom(r[3]!, true) || !okRoom(r[4]!, true) || r[5]! < 0 || r[5]! > 1) return null;
    doors.push({ id: k, x: r[0]!, y: r[1]!, i, wall: r[2] === 0 ? "h" : "v", rooms: [r[3]!, r[4]!], outside: false, locked: r[5] === 1 });
  }
  const windows: Pane[] = [];
  for (const [k, r] of wRows.entries()) {
    const i = tile(r[0]!, r[1]!);
    if (i < 0 || tiles[i] !== TILE.WINDOW || r[2]! > 1 || r[2]! < 0 || !okRoom(r[3]!, false)) return null;
    windows.push({ id: k, x: r[0]!, y: r[1]!, i, wall: r[2] === 0 ? "h" : "v", room: r[3]! });
  }
  const lamps: Lamp[] = [];
  for (const [k, r] of lRows.entries()) {
    const i = tile(r[0]!, r[1]!);
    if (i < 0) return null;
    lamps.push({ id: k, x: r[0]!, y: r[1]!, i });
  }
  const cameras: Camera[] = [];
  for (const [k, r] of cRows.entries()) {
    const i = tile(r[0]!, r[1]!);
    if (i < 0 || r[2]! < 0 || r[2]! >= 360 || r[3]! < 1 || r[3]! > 180 || r[4]! < 1 || r[4]! > 64 || !okRoom(r[5]!, true)) return null;
    cameras.push({ id: k, x: r[0]!, y: r[1]!, i, angle: r[2]!, fov: r[3]!, range: r[4]!, room: r[5]! });
  }
  const spots: Spot[] = [];
  for (const [k, r] of sRows.entries()) {
    const rc = rect(r, 0);
    if (!rc || !okArea(r[4]!)) return null;
    spots.push({ id: k, rect: rc, area: r[4]! });
  }
  const gates: Gate[] = [];
  for (const [k, r] of gRows.entries()) {
    const rc = rect(r, 0);
    const s = side(r[4]!);
    if (!rc || !s || !okArea(r[5]!)) return null;
    gates.push({ id: k, rect: rc, side: s, area: r[5]! });
  }
  const props: Prop[] = [];
  for (const [k, r] of pRows.entries()) {
    const kind = PROP_KINDS[r[0]!];
    const rc = rect(r, 1);
    const s = side(r[6]!);
    if (!kind || !rc || (r[5] !== 0 && r[5] !== 1 && r[5] !== 2) || s === undefined || !okRoom(r[7]!, true)) return null;
    props.push({ id: k, kind, rect: rc, block: r[5] as 0 | 1 | 2, side: s, room: r[7]! });
  }
  const wb = o["workbench"];
  if (!Array.isArray(wb) || wb.length !== 3 || !int(wb[0], 0, props.length - 1) || !int(wb[1], -1, nR - 1) || !int(wb[2], 0, n - 1)) return null;
  const security = o["security"];
  if (!int(security, 0, nR - 1)) return null;
  const spawn = o["spawn"];
  if (!Array.isArray(spawn) || spawn.length > 64 || !spawn.every((i) => int(i, 0, n - 1))) return null;
  const bp: Blueprint = {
    w, h, tiles, floors, roomAt: new Int16Array(0), areaAt, doorAt: new Int16Array(0), windowAt: new Int16Array(0),
    front: front as Side, lot, buildings, rooms, areas, doors, windows, lamps, cameras, spots, gates, props,
    workbench: { prop: wb[0] as number, room: wb[1] as number, access: wb[2] as number },
    security, spawn: spawn as number[],
  };
  for (const r of rooms) {
    for (let y = r.rect.y; y < r.rect.y + r.rect.h; y++) for (let x = r.rect.x; x < r.rect.x + r.rect.w; x++) {
      const t = tiles[y * w + x];
      if (t !== TILE.FLOOR && t !== TILE.FURNITURE) return null;
    }
  }
  return indexBlueprint(bp);
}

// ---------------------------------------------------------------- ASCII

const FLOOR_CHAR = ["?", ",", ":", "-", "_", ";", ".", ".", ".", ".", ".", ".", "."];
const TILE_CHAR = [" ", "#", "=", "%", "+", "'", "h", "T", "c", "F", "s", "o"];
const ROOM_ABBR: Record<RoomKind, string> = {
  foyer: "FOY", corridor: "COR", ballroom: "BAL", library: "LIB", study: "STU", gallery: "GAL", kitchen: "KIT", dining: "DIN",
  billiards: "BIL", conservatory: "CON", bedroom: "BED", bathroom: "BAT", vault: "VLT", security: "SEC", garage: "GAR", shed: "SHD",
};

/**
 * The map as text, one line a row: `#` wall, `=` lot wall, `%` edge, `+`
 * door (`X` locked), `'` window, `h` hedge, `T` tree, `c` car, `F`
 * fountain, `s` shed wall, `o` furniture, `W` the workbench; grounds `,`
 * grass, `:` gravel, `-` pavement, `_` asphalt, `;` cobble, `.` floors;
 * `P` spots, `*` lamps, `C` cameras, `g` guards' start; room kinds
 * lettered in their corner. With secrets: `G` the getaway car's spot,
 * `$` loot places.
 */
export function ascii(m: Blueprint, secrets?: { car?: number; places?: readonly Place[] }): string {
  const g: string[][] = [];
  for (let y = 0; y < m.h; y++) {
    const row: string[] = [];
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      const t = m.tiles[i]!;
      row.push(t === TILE.FLOOR ? FLOOR_CHAR[m.floors[i]!]! : t === TILE.DOOR && m.doors[m.doorAt[i]!]?.locked ? "X" : TILE_CHAR[t]!);
    }
    g.push(row);
  }
  const put = (i: number, c: string) => {
    const x = i % m.w;
    const y = Math.floor(i / m.w);
    if (g[y]) g[y]![x] = c;
  };
  for (const r of m.rooms) {
    const label = ROOM_ABBR[r.kind];
    if (r.rect.w < label.length) continue;
    const i = r.rect.y * m.w + r.rect.x;
    if ([0, 1, 2].every((k) => m.tiles[i + k] === TILE.FLOOR)) for (let k = 0; k < 3; k++) put(i + k, label[k]!);
  }
  for (const s of m.spots) {
    for (let y = s.rect.y; y < s.rect.y + s.rect.h; y++) for (let x = s.rect.x; x < s.rect.x + s.rect.w; x++) put(y * m.w + x, secrets?.car === s.id ? "G" : "P");
  }
  for (const i of m.spawn) put(i, "g");
  for (const l of m.lamps) put(l.i, "*");
  for (const c of m.cameras) put(c.i, "C");
  const wb = m.props[m.workbench.prop];
  if (wb) for (let y = wb.rect.y; y < wb.rect.y + wb.rect.h; y++) for (let x = wb.rect.x; x < wb.rect.x + wb.rect.w; x++) put(y * m.w + x, "W");
  for (const p of secrets?.places ?? []) put(p.i, "$");
  return g.map((r) => r.join("")).join("\n");
}

/**
 * A blueprint from text, for tests (sight, movement, the ink, the
 * simulation). Legend: `#` wall, `=` lot wall, `%` edge, `.` floor of a
 * dark room, `:` floor of a lit room, `o` furniture, `+` door, `X`
 * locked door, `'` window, `,` grass outside, `_` asphalt outside, `*` a
 * lamp on grass, `P` a parking spot (asphalt; connected `P`s are one
 * spot), `h` `T` `c` `F` `s` cover. Rooms are the 4-connected groups of
 * `.`, `:` and `o` (their bounding boxes must hold only those), areas
 * those of outside ground. One building around all rooms; the first
 * room is the security office, the workbench is the first furniture.
 */
export function parseAscii(rows: readonly string[]): Blueprint {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const n = w * h;
  const tiles = new Uint8Array(n).fill(TILE.EDGE);
  const floors = new Uint8Array(n);
  const kind = new Uint8Array(n); // 1 indoor, 2 outdoor
  const lampTiles: number[] = [];
  const spotTiles = new Set<number>();
  const set = (i: number, t: Tile, f: Floor, k: number) => {
    tiles[i] = t;
    floors[i] = f;
    kind[i] = k;
  };
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const c = row[x] ?? "%";
      const i = y * w + x;
      switch (c) {
        case "#": set(i, TILE.WALL, FLOOR.NONE, 0); break;
        case "=": set(i, TILE.LOT_WALL, FLOOR.NONE, 0); break;
        case "%": set(i, TILE.EDGE, FLOOR.NONE, 0); break;
        case ".": set(i, TILE.FLOOR, FLOOR.PARQUET, 1); break;
        case ":": set(i, TILE.FLOOR, FLOOR.MARBLE, 1); break;
        case "o": set(i, TILE.FURNITURE, FLOOR.PARQUET, 1); break;
        case "+": case "X": set(i, TILE.DOOR, FLOOR.PARQUET, 0); break;
        case "'": set(i, TILE.WINDOW, FLOOR.NONE, 0); break;
        case ",": set(i, TILE.FLOOR, FLOOR.GRASS, 2); break;
        case "_": set(i, TILE.FLOOR, FLOOR.ASPHALT, 2); break;
        case "*": set(i, TILE.FLOOR, FLOOR.GRASS, 2); lampTiles.push(i); break;
        case "P": set(i, TILE.FLOOR, FLOOR.ASPHALT, 2); spotTiles.add(i); break;
        case "h": set(i, TILE.HEDGE, FLOOR.GRASS, 2); break;
        case "T": set(i, TILE.TREE, FLOOR.GRASS, 2); break;
        case "c": set(i, TILE.CAR, FLOOR.ASPHALT, 2); break;
        case "F": set(i, TILE.FOUNTAIN, FLOOR.GRASS, 2); break;
        case "s": set(i, TILE.SHED, FLOOR.GRASS, 2); break;
        default: set(i, TILE.EDGE, FLOOR.NONE, 0);
      }
    }
  });
  const groups = (want: number, filter: (i: number) => boolean = () => true): number[][] => {
    const seen = new Uint8Array(n);
    const out: number[][] = [];
    for (let s = 0; s < n; s++) {
      if (seen[s] || kind[s] !== want || !filter(s)) continue;
      const g = [s];
      seen[s] = 1;
      for (let k = 0; k < g.length; k++) {
        const i = g[k]!;
        const x = i % w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (j >= 0 && j < n && !seen[j] && kind[j] === want && filter(j)) {
            seen[j] = 1;
            g.push(j);
          }
        }
      }
      out.push(g);
    }
    return out;
  };
  const box = (g: number[]): Rect => {
    const xs = g.map((i) => i % w);
    const ys = g.map((i) => Math.floor(i / w));
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 };
  };
  const roomGroups = groups(1);
  const rooms: Room[] = roomGroups.map((g, id) => ({
    id, kind: id === 0 ? "security" : "study", nth: id === 0 ? 0 : id - 1, building: 0, rect: box(g),
    lit: g.some((i) => floors[i] === FLOOR.MARBLE), switches: [], doors: [], windows: [],
  }));
  const areaAt = new Int16Array(n).fill(-1);
  const areaGroups = groups(2, (i) => tiles[i] === TILE.FLOOR);
  const areas: Area[] = areaGroups.map((g, id) => {
    for (const i of g) areaAt[i] = id;
    return { id, kind: "garden", nth: id, rect: box(g), building: -1, side: null };
  });
  const roomOf = new Int16Array(n).fill(-1);
  roomGroups.forEach((g, id) => g.forEach((i) => (roomOf[i] = id)));
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? roomOf[y * w + x]! : -1);
  const blocks = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || OPAQUE[tiles[y * w + x]!] || tiles[y * w + x] === TILE.DOOR;
  const doors: Door[] = [];
  const windows: Pane[] = [];
  for (let i = 0; i < n; i++) {
    const x = i % w;
    const y = Math.floor(i / w);
    if (tiles[i] !== TILE.DOOR && tiles[i] !== TILE.WINDOW) continue;
    const wall: "h" | "v" = blocks(x - 1, y) && blocks(x + 1, y) ? "h" : "v";
    const [a, b] = wall === "h" ? [at(x, y - 1), at(x, y + 1)] : [at(x - 1, y), at(x + 1, y)];
    if (tiles[i] === TILE.DOOR) {
      doors.push({ id: doors.length, x, y, i, wall, rooms: [a, b], outside: false, locked: rows[y]![x] === "X" });
    } else {
      windows.push({ id: windows.length, x, y, i, wall, room: Math.max(a, b) });
    }
  }
  const spots: Spot[] = groups(2, (i) => spotTiles.has(i)).map((g, id) => ({ id, rect: box(g), area: areaAt[g[0]!]! }));
  const props: Prop[] = [];
  const furn = groups(1, (i) => tiles[i] === TILE.FURNITURE);
  for (const g of furn) props.push({ id: props.length, kind: "table", rect: box(g), block: 1, room: roomOf[g[0]!]!, side: null });
  const all = roomGroups.flat();
  const bbox = all.length ? box(all) : { x: 0, y: 0, w: 1, h: 1 };
  const bp: Blueprint = {
    w, h, tiles, floors, roomAt: new Int16Array(0), areaAt, doorAt: new Int16Array(0), windowAt: new Int16Array(0),
    front: "s", lot: { x: 0, y: 0, w, h },
    buildings: [{ id: 0, rect: { x: bbox.x - 1, y: bbox.y - 1, w: bbox.w + 2, h: bbox.h + 2 }, main: true }],
    rooms, areas, doors, windows,
    lamps: lampTiles.map((i, id) => ({ id, x: i % w, y: Math.floor(i / w), i })),
    cameras: [], spots, gates: [], props,
    workbench: { prop: 0, room: props[0]?.room ?? -1, access: 0 },
    security: 0,
    spawn: roomGroups[0]?.filter((i) => tiles[i] === TILE.FLOOR) ?? [],
  };
  indexBlueprint(bp);
  for (const r of bp.rooms) r.switches = [...new Set(r.doors.map((d) => doorSide(bp, bp.doors[d]!, r.id)))].filter((i) => i >= 0).sort((a, b) => a - b);
  return bp;
}
