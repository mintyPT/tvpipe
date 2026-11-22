/**
 * Landgrab's world: a map of hexagons (docs/landgrab-design.md §3), read
 * from `data/world.txt` by the host page, the TV, the phones and the
 * tests alike. The file is text:
 *
 * ```
 * # a comment
 * grid 64 42                                   columns and rows of hexes
 * continent na 5 North America | Nordamerika   id, bonus, English | German name
 * territory ak na 4 6 Alaska | Alaska          id, continent, the badge's hex (column row), names
 * link ak ka wrap                              a sea route (wrap: across the map's edge)
 * map                                          then one line per row
 * ....akakak..
 * ```
 *
 * Ids are two letters `a-z`. The map has `rows` lines of `cols` cells,
 * two characters each: `..` is sea, anything else a territory's id. The
 * hexes are pointy-topped, in rows; odd rows are shifted right by half a
 * hex ("odd-r"). Territories are neighbours when two of their hexes touch
 * or a link joins them.
 */

export type Lang = "en" | "de";
export type Names = Record<Lang, string>;

export interface Continent {
  id: string;
  bonus: number;
  name: Names;
  /** Its territories' ids, in the file's order. */
  territories: string[];
}

export interface Territory {
  id: string;
  /** Its index in {@link World.territories}. */
  index: number;
  continent: string;
  name: Names;
  /** The hex its army badge sits on: `[col, row]`. */
  anchor: [number, number];
  /** Its hexes, as cell indices (`row * cols + col`). */
  hexes: number[];
  /** Neighbouring territories' ids (by land or by sea), sorted. */
  neighbors: string[];
}

export interface Link {
  a: string;
  b: string;
  /** The route leaves the map on one side and comes back on the other. */
  wrap: boolean;
}

export interface World {
  cols: number;
  rows: number;
  continents: Continent[];
  territories: Territory[];
  links: Link[];
  /** Per cell (`row * cols + col`): the territory's index, or -1 for sea. */
  cells: Int16Array;
  byId: Map<string, Territory>;
}

const ID = /^[a-z]{2}$/;

function names(text: string, where: string): Names {
  const [en, de] = text.split("|").map((x) => x.trim());
  if (!en) throw new Error(`${where}: no name`);
  return { en, de: de || en };
}

/** Reads `data/world.txt`; throws with the line on anything wrong. */
export function parseWorld(text: string): World {
  let cols = 0;
  let rows = 0;
  const continents: Continent[] = [];
  const territories: Territory[] = [];
  const links: Link[] = [];
  const mapLines: { line: string; no: number }[] = [];
  let inMap = false;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const no = i + 1;
    const where = `world.txt:${no}`;
    if (inMap) {
      if (raw.trim() === "" || raw.startsWith("#")) return;
      mapLines.push({ line: raw.replace(/\s+$/, ""), no });
      return;
    }
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const m = line.match(/^(\S+)\s*(.*)$/)!;
    const word = m[1]!;
    const rest = m[2] ?? "";
    if (word === "grid") {
      const g = rest.match(/^(\d+)\s+(\d+)$/);
      if (!g) throw new Error(`${where}: grid COLS ROWS`);
      cols = Number(g[1]);
      rows = Number(g[2]);
      if (cols < 1 || rows < 1 || cols > 400 || rows > 400) throw new Error(`${where}: a grid of 1–400 by 1–400`);
    } else if (word === "continent") {
      const c = rest.match(/^([a-z]{2})\s+(\d+)\s+(.+)$/);
      if (!c) throw new Error(`${where}: continent ID BONUS NAME | NAME`);
      if (continents.some((x) => x.id === c[1])) throw new Error(`${where}: continent ${c[1]} twice`);
      continents.push({ id: c[1]!, bonus: Number(c[2]), name: names(c[3]!, where), territories: [] });
    } else if (word === "territory") {
      const t = rest.match(/^([a-z]{2})\s+([a-z]{2})\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!t) throw new Error(`${where}: territory ID CONTINENT COL ROW NAME | NAME`);
      const id = t[1]!;
      if (territories.some((x) => x.id === id)) throw new Error(`${where}: territory ${id} twice`);
      const cont = continents.find((x) => x.id === t[2]);
      if (!cont) throw new Error(`${where}: no continent ${t[2]} (continents come first)`);
      cont.territories.push(id);
      territories.push({ id, index: territories.length, continent: cont.id, name: names(t[5]!, where), anchor: [Number(t[3]), Number(t[4])], hexes: [], neighbors: [] });
    } else if (word === "link") {
      const l = rest.match(/^([a-z]{2})\s+([a-z]{2})(\s+wrap)?$/);
      if (!l) throw new Error(`${where}: link ID ID [wrap]`);
      links.push({ a: l[1]!, b: l[2]!, wrap: !!l[3] });
    } else if (word === "map") {
      if (rest) throw new Error(`${where}: map takes nothing`);
      inMap = true;
    } else {
      throw new Error(`${where}: what is "${word}"?`);
    }
  });
  if (!cols) throw new Error("world.txt: no grid");
  if (!inMap) throw new Error("world.txt: no map");
  if (mapLines.length !== rows) throw new Error(`world.txt: the map has ${mapLines.length} rows, the grid ${rows}`);
  const byId = new Map(territories.map((t) => [t.id, t]));
  const cells = new Int16Array(cols * rows).fill(-1);
  mapLines.forEach(({ line, no }, r) => {
    if (line.length > cols * 2) throw new Error(`world.txt:${no}: ${line.length / 2} cells, the grid has ${cols}`);
    const padded = line.padEnd(cols * 2, ".");
    for (let c = 0; c < cols; c++) {
      const code = padded.slice(c * 2, c * 2 + 2);
      if (code === "..") continue;
      const t = byId.get(code);
      if (!t) throw new Error(`world.txt:${no}: no territory "${code}" (column ${c})`);
      cells[r * cols + c] = t.index;
      t.hexes.push(r * cols + c);
    }
  });
  for (const t of territories) {
    if (t.hexes.length === 0) throw new Error(`world.txt: ${t.id} has no hexes`);
    const [c, r] = t.anchor;
    if (c >= cols || r >= rows || cells[r * cols + c] !== t.index) throw new Error(`world.txt: ${t.id}'s badge (${c} ${r}) is not on one of its hexes`);
  }
  for (const c of continents) if (c.territories.length === 0) throw new Error(`world.txt: continent ${c.id} has no territories`);
  const near = territories.map(() => new Set<number>());
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = cells[r * cols + c]!;
      if (a < 0) continue;
      for (const [nc, nr] of hexNeighbors(c, r)) {
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const b = cells[nr * cols + nc]!;
        if (b >= 0 && b !== a) near[a]!.add(b);
      }
    }
  }
  for (const l of links) {
    const a = byId.get(l.a);
    const b = byId.get(l.b);
    if (!a || !b || a === b) throw new Error(`world.txt: link ${l.a} ${l.b}: no such territories`);
    near[a.index]!.add(b.index);
    near[b.index]!.add(a.index);
  }
  for (const t of territories) t.neighbors = [...near[t.index]!].map((i) => territories[i]!.id).sort();
  return { cols, rows, continents, territories, links, cells, byId };
}

/** The six hexes around `(col, row)` (odd-r): left, right, then the two above and the two below. May lie off the map. */
export function hexNeighbors(c: number, r: number): [number, number][] {
  const o = r & 1;
  return [
    [c - 1, r],
    [c + 1, r],
    [c - 1 + o, r - 1],
    [c + o, r - 1],
    [c - 1 + o, r + 1],
    [c + o, r + 1],
  ];
}

/**
 * The side a neighbour of {@link hexNeighbors} touches, by its place in
 * that list: the two corners of {@link hexCorners} the side runs between.
 */
export const HEX_SIDES: readonly [number, number][] = [
  [4, 5],
  [1, 2],
  [5, 0],
  [0, 1],
  [3, 4],
  [2, 3],
];

/** The width of a hex (flat side to flat side) per unit of its radius. */
export const HEX_W = Math.sqrt(3);
/** The distance between two rows' centres per unit of a hex's radius. */
export const HEX_ROW = 1.5;

/** The centre of hex `(col, row)` for hexes of radius `size`; the map's top left is (0, 0). */
export function hexCenter(c: number, r: number, size: number): [number, number] {
  return [size * HEX_W * (c + 0.5 + 0.5 * (r & 1)), size * (1 + HEX_ROW * r)];
}

/** The map's width and height in units of a hex's radius. */
export function mapSize(w: Pick<World, "cols" | "rows">): [number, number] {
  return [HEX_W * (w.cols + 0.5), HEX_ROW * (w.rows - 1) + 2];
}

/** The corners of a pointy-topped hex at `(x, y)` of radius `size`, clockwise from the top. */
export function hexCorners(x: number, y: number, size: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    out.push([x + size * Math.cos(a), y + size * Math.sin(a)]);
  }
  return out;
}

/** Whether every territory can reach every other (by land or by sea). */
export function connected(w: World): boolean {
  if (w.territories.length === 0) return true;
  const seen = new Set<string>([w.territories[0]!.id]);
  const todo = [w.territories[0]!.id];
  while (todo.length) {
    const t = w.byId.get(todo.pop()!)!;
    for (const n of t.neighbors) if (!seen.has(n)) seen.add(n), todo.push(n);
  }
  return seen.size === w.territories.length;
}
