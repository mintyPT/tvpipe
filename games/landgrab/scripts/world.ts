/**
 * Makes Landgrab's map, `data/world.txt` (the format: game/world.ts):
 *
 *   node scripts/world.ts           # writes data/world.txt, prints sizes and neighbours
 *   node scripts/world.ts --check   # fails if data/world.txt is not what it would write
 *
 * (`node scripts/preview.ts --png /tmp/world.png` draws it.)
 *
 * How: coastlines as coarse polygons in longitude/latitude, written by
 * hand; Miller's projection from 84°N to 62°S, stretched a little to
 * fill a 16:9 screen, with two lenses blowing up Europe and East Asia
 * (as Risk does) so their territories fit. A hex is land when most of
 * seven points in it lie on land (islands take fewer). Each land hex
 * then goes to a territory: an island's polygon names its territory, a
 * mainland's hexes go to the first territory of its group whose rough
 * region (more polygons, generous over the sea) holds the hex, or else
 * the nearest seed. Then seaways carve straits, fix-ups set single
 * hexes, and each territory gets its badge.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { connected, hexNeighbors, HEX_ROW, HEX_W, mapSize, parseWorld, type World } from "../game/world.ts";

type LonLat = [number, number];
type Ring = LonLat[];

// ---------------------------------------------------------------- the grid

/** Columns and rows: 16:9 by `mapSize` (132.5 by 74 hex radii). */
export const COLS = 76;
export const ROWS = 49;
/** The longitude at the left edge; the map spans 360°, the Bering Strait at the edges. */
const LON0 = -169;
/** The latitudes at the top and the bottom edge. */
const LAT_TOP = 84;
const LAT_BOTTOM = -62;

/** Miller's cylindrical projection: the y of a latitude, in degrees like x. */
function miller(lat: number): number {
  const p = (lat * Math.PI) / 180;
  return (1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * p)) * 180) / Math.PI;
}

function unmiller(y: number): number {
  const v = (y * Math.PI) / 180;
  return ((2.5 * Math.atan(Math.exp(0.8 * v)) - 0.625 * Math.PI) * 180) / Math.PI;
}

/**
 * Lenses blow up the crowded parts as Risk does: points within `inner`
 * of a lens's centre (projected degrees) move 1 + `k` times as far from
 * it; from there to `outer` the stretch eases off, squeezing the ring
 * of land around a little; beyond, nothing moves. Distances from the
 * centre keep their order, so bisection undoes a lens. They apply in
 * turn.
 */
interface Lens {
  at: [number, number];
  k: number;
  inner: number;
  outer: number;
}

const LENSES: Lens[] = [
  // Europe; the Sahara, the Middle East and Russia give way
  { at: [14, miller(54)], k: 0.5, inner: 24, outer: 90 },
  // East Asia: Japan, Korea, China, Indochina; Siberia and India give way
  { at: [115, miller(25)], k: 0.4, inner: 24, outer: 50 },
];

/** The distance from a lens's centre after it. */
function lensed(l: Lens, d: number): number {
  if (d <= l.inner) return d * (1 + l.k);
  if (d >= l.outer) return d;
  const a = l.inner * (1 + l.k);
  return a + ((d - l.inner) * (l.outer - a)) / (l.outer - l.inner);
}

function lens(l: Lens, [x, y]: [number, number]): [number, number] {
  const dx = x - l.at[0];
  const dy = y - l.at[1];
  const d = Math.hypot(dx, dy);
  const f = d > 0 ? lensed(l, d) / d : 1 + l.k;
  return [l.at[0] + dx * f, l.at[1] + dy * f];
}

function unlens(l: Lens, [x, y]: [number, number]): [number, number] {
  const dx = x - l.at[0];
  const dy = y - l.at[1];
  const d1 = Math.hypot(dx, dy);
  let lo = 0;
  let hi = d1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (lensed(l, mid) < d1) lo = mid;
    else hi = mid;
  }
  const s = d1 > 0 ? lo / d1 : 1;
  return [l.at[0] + dx * s, l.at[1] + dy * s];
}

/** Projected (lensed) point to longitude/latitude. */
function unproject(x: number, y: number): LonLat {
  let p: [number, number] = [x, y];
  for (let i = LENSES.length - 1; i >= 0; i--) p = unlens(LENSES[i]!, p);
  return [p[0], unmiller(p[1])];
}

/** Longitude/latitude to the map, in hex radii from its top left. */
export function project([lon, lat]: LonLat): [number, number] {
  let p: [number, number] = [lon, miller(lat)];
  for (const l of LENSES) p = lens(l, p);
  const [w, h] = mapSize({ cols: COLS, rows: ROWS });
  const top = miller(LAT_TOP);
  const bottom = miller(LAT_BOTTOM);
  return [((p[0] - LON0) / 360) * w, ((top - p[1]) / (top - bottom)) * h];
}

/** A point of the map (hex radii from its top left) to longitude/latitude. */
function mapLonLat(px: number, py: number): LonLat {
  const [w, h] = mapSize({ cols: COLS, rows: ROWS });
  const top = miller(LAT_TOP);
  const bottom = miller(LAT_BOTTOM);
  return unproject(LON0 + (px / w) * 360, top - (py / h) * (top - bottom));
}

/** A hex's centre (see hexCenter) in hex radii. */
function cellXY(c: number, r: number): [number, number] {
  return [HEX_W * (c + 0.5 + 0.5 * (r & 1)), 1 + HEX_ROW * r];
}

/** A hex's centre to longitude/latitude. */
export function cellLonLat(c: number, r: number): LonLat {
  return mapLonLat(...cellXY(c, r));
}

// ------------------------------------------------------------ continents

interface TerritoryDef {
  id: string;
  continent: string;
  en: string;
  de: string;
  /** Where the territory is, for the nearest-seed fallback. */
  seed: LonLat;
}

export const CONTINENTS: { id: string; bonus: number; en: string; de: string }[] = [
  { id: "na", bonus: 5, en: "North America", de: "Nordamerika" },
  { id: "sa", bonus: 2, en: "South America", de: "Südamerika" },
  { id: "eu", bonus: 5, en: "Europe", de: "Europa" },
  { id: "af", bonus: 3, en: "Africa", de: "Afrika" },
  { id: "as", bonus: 7, en: "Asia", de: "Asien" },
  { id: "oc", bonus: 2, en: "Oceania", de: "Ozeanien" },
];

const T = (id: string, continent: string, en: string, de: string, seed: LonLat): TerritoryDef => ({ id, continent, en, de, seed });

export const TERRITORIES: TerritoryDef[] = [
  T("ak", "na", "Alaska", "Alaska", [-152, 64]),
  T("yk", "na", "Yukon", "Yukon", [-122, 64]),
  T("gl", "na", "Greenland", "Grönland", [-42, 72]),
  T("hb", "na", "Hudson Bay", "Hudsonbucht", [-92, 60]),
  T("qc", "na", "Quebec", "Québec", [-70, 52]),
  T("rk", "na", "Rockies", "Rocky Mountains", [-112, 46]),
  T("ap", "na", "Appalachia", "Appalachen", [-85, 38]),
  T("mx", "na", "Mexico", "Mexiko", [-100, 22]),
  T("co", "sa", "Colombia", "Kolumbien", [-68, 6]),
  T("pe", "sa", "Peru", "Peru", [-72, -12]),
  T("br", "sa", "Brazil", "Brasilien", [-48, -10]),
  T("ar", "sa", "Patagonia", "Patagonien", [-65, -38]),
  T("bi", "eu", "Britain", "Britannien", [-3, 54]),
  T("sc", "eu", "Scandinavia", "Skandinavien", [15, 63]),
  T("we", "eu", "Western Europe", "Westeuropa", [0, 44]),
  T("ce", "eu", "Central Europe", "Mitteleuropa", [13, 51]),
  T("se", "eu", "Southern Europe", "Südeuropa", [20, 42]),
  T("ru", "eu", "Russia", "Russland", [38, 55]),
  T("wa", "af", "West Africa", "Westafrika", [-5, 12]),
  T("sh", "af", "Sahara", "Sahara", [8, 27]),
  T("eg", "af", "Egypt", "Ägypten", [30, 22]),
  T("cg", "af", "Congo", "Kongo", [20, -3]),
  T("ea", "af", "East Africa", "Ostafrika", [38, 3]),
  T("za", "af", "South Africa", "Südafrika", [25, -24]),
  T("me", "as", "Middle East", "Nahost", [42, 28]),
  T("ir", "as", "Persia", "Persien", [58, 32]),
  T("st", "as", "Steppe", "Steppe", [68, 47]),
  T("ur", "as", "Ural", "Ural", [62, 60]),
  T("si", "as", "Siberia", "Sibirien", [92, 65]),
  T("ya", "as", "Yakutia", "Jakutien", [128, 65]),
  T("ka", "as", "Kamchatka", "Kamtschatka", [158, 60]),
  T("mo", "as", "Mongolia", "Mongolei", [103, 46]),
  T("cn", "as", "China", "China", [108, 30]),
  T("in", "as", "India", "Indien", [78, 22]),
  T("sm", "as", "Indochina", "Indochina", [102, 15]),
  T("jp", "as", "Japan", "Japan", [138, 37]),
  T("id", "oc", "Indonesia", "Indonesien", [115, -2]),
  T("ng", "oc", "New Guinea", "Neuguinea", [142, -5]),
  T("wo", "oc", "Western Australia", "Westaustralien", [122, -25]),
  T("eo", "oc", "Eastern Australia", "Ostaustralien", [145, -27]),
];

/** Sea routes; `wrap` ones leave the map at one edge and come back at the other. */
export const LINKS: [string, string, "wrap"?][] = [
  ["ak", "ka", "wrap"],
  ["gl", "qc"],
  ["gl", "sc"],
  ["bi", "sc"],
  ["bi", "we"],
  ["bi", "ce"],
  ["we", "sh"],
  ["se", "sh"],
  ["se", "eg"],
  ["ea", "me"],
  ["wa", "br"],
  ["ka", "jp"],
  ["jp", "cn"],
  ["sm", "id"],
  ["id", "ng"],
  ["id", "wo"],
  ["ng", "eo"],
];

// ------------------------------------------------------------ coastlines

/**
 * A piece of land: an island names its territory (`to`), a mainland a
 * group of {@link GROUPS} whose regions share it out.
 */
interface Land {
  name: string;
  to: string;
  ring: Ring;
  /** How many of a hex's seven samples must lie on it (default 4: most of the hex); islands take less. */
  min?: number;
}

const LAND: Land[] = [
  {
    name: "North America",
    to: "AMERICA_N",
    ring: [
      [-168, 65.6], [-163, 67], [-166, 68.9], [-156.5, 71.3], [-150, 70.4], [-141, 69.7], [-135, 69], [-128, 70],
      [-120, 69.5], [-115, 68], [-108, 68], [-98, 68], [-94, 71.5], [-90, 68.5], [-84, 69.5], [-82, 66.5],
      // Hudson Bay
      [-86, 66], [-90, 64], [-94, 61], [-94, 59], [-92, 57], [-88, 56], [-82, 55], [-80, 51], [-79, 54.5],
      [-77, 56], [-78, 58.5], [-77, 60.5], [-78, 62.3], [-73, 62], [-70, 61], [-69, 58.5], [-65, 60.3],
      // Labrador, the Gulf of St. Lawrence, Nova Scotia
      [-64, 58], [-61.5, 56], [-60, 55], [-57, 53.5], [-56, 52], [-60, 50.2], [-66, 50.2], [-64.5, 48.9],
      [-64.5, 46.5], [-61, 45.6], [-63.5, 44.5], [-66, 43.8], [-67, 44.8],
      // the US east coast, Florida, the Gulf
      [-70, 43.5], [-70.5, 41.8], [-74, 40.6], [-75, 38.5], [-76, 37], [-75.5, 35.2], [-78, 33.8], [-81, 31.5],
      [-80.5, 28], [-80.1, 25.5], [-81.2, 25.1], [-82.7, 27.8], [-84, 30], [-86, 30.3], [-89, 30.2], [-89.5, 29],
      [-91, 29.2], [-94, 29.6], [-97.2, 27.6], [-97.5, 25], [-97.8, 22.5], [-96.5, 19.5], [-94.5, 18.2], [-92, 18.6],
      // Yucatán, Central America
      [-90.5, 19.8], [-90.4, 21], [-87, 21.5], [-87.5, 19], [-88.2, 16], [-84, 15.8], [-83.3, 15], [-83.7, 11],
      [-82, 9], [-79.5, 9.5], [-77.4, 8.6], [-77.9, 7.3], [-80, 7.3], [-81.5, 7.8], [-85.7, 10], [-87.5, 13],
      [-91, 14], [-94, 16], [-96.5, 15.7], [-100, 17], [-105.3, 20], [-105.7, 22.5], [-108, 25], [-110.5, 27.5],
      // the Gulf of California, Baja
      [-112.8, 31.3], [-113.5, 29.5], [-112, 26], [-109.9, 22.9], [-112, 24.7], [-114, 27.5], [-115.5, 29.6],
      // the west coast
      [-117.1, 32.5], [-118.5, 34], [-120.6, 34.6], [-122.5, 37.7], [-124.2, 40.4], [-124.5, 43], [-124, 46.3],
      [-124.7, 48.4], [-123, 49], [-125, 50], [-128, 51], [-130.5, 54.5], [-132, 56.5], [-134.5, 58], [-137, 59],
      [-140, 59.8], [-144, 60], [-147, 61], [-150, 59.5], [-151.8, 59.2], [-154, 58.6], [-158, 57], [-162.5, 55],
      [-164.8, 54.4], [-161, 56], [-157.5, 58.6], [-162, 58.6], [-164.5, 60.5], [-165.5, 62], [-164.5, 63.2],
      [-161, 64.5], [-166, 64.5],
    ],
  },
  { name: "Newfoundland", to: "qc", min: 3, ring: [[-59.4, 47.6], [-56, 51.5], [-55.5, 49.5], [-52.7, 47.5], [-53.5, 46.6], [-56, 47.6]] },
  { name: "Cuba", to: "mx", min: 3, ring: [[-85, 21.9], [-82, 23.1], [-77, 22], [-74.2, 20.2], [-77.5, 19.8], [-80, 21.6], [-82.5, 22]] },
  { name: "Hispaniola", to: "mx", min: 3, ring: [[-74.4, 18.4], [-72.5, 19.9], [-68.5, 18.6], [-71, 17.6]] },
  { name: "Baffin Island", to: "hb", ring: [[-65, 62], [-62, 66.5], [-68, 70.5], [-77, 72.7], [-89, 73.6], [-86, 70], [-80, 69.5], [-73, 67.5], [-74, 64.8], [-78, 64.2], [-71, 62.5]] },
  { name: "Southampton Island", to: "hb", ring: [[-86, 63.5], [-80, 63], [-83, 65.5], [-87, 65]] },
  { name: "Devon Island", to: "hb", ring: [[-80, 74.5], [-92, 74.5], [-92, 76.5], [-80, 76.3]] },
  { name: "Ellesmere Island", to: "hb", ring: [[-80, 76.3], [-90, 77], [-90, 80], [-80, 82.5], [-64, 82.6], [-70, 80], [-75, 78.5]] },
  { name: "Victoria Island", to: "yk", ring: [[-101, 69], [-117, 69.5], [-119, 71.5], [-113, 73], [-104, 72.8], [-101, 70]] },
  { name: "Banks Island", to: "yk", ring: [[-125, 71.8], [-120, 71.3], [-117, 73.5], [-120, 74.5], [-125, 74]] },
  { name: "Queen Elizabeth Islands", to: "yk", ring: [[-120, 75.5], [-105, 75], [-96, 74.3], [-96, 76], [-105, 77], [-118, 77]] },
  {
    name: "Greenland",
    to: "gl",
    ring: [
      [-73, 78], [-66, 81], [-50, 82.5], [-30, 83.5], [-20, 82.5], [-12, 81.5], [-18, 79], [-19, 76], [-21, 72],
      [-22, 70.5], [-26, 68.5], [-33, 68], [-38, 65.5], [-41, 63], [-43.5, 60], [-46, 60.8], [-50, 63], [-51, 66],
      [-53.5, 67.5], [-51, 70], [-55, 71.5], [-58, 75.5], [-67, 76.2],
    ],
  },
  { name: "Iceland", to: "sc", min: 3, ring: [[-24, 65.5], [-22, 66.4], [-16, 66.5], [-13.5, 65.2], [-15, 64.3], [-18.5, 63.4], [-22.5, 63.8]] },
  {
    name: "South America",
    to: "AMERICA_S",
    ring: [
      [-77.5, 8.5], [-76, 9.5], [-75.5, 10.5], [-72, 11.8], [-70, 12.2], [-68, 10.5], [-64, 10.6], [-61.5, 10.5],
      [-60, 8.5], [-57, 6], [-54, 5.8], [-51.5, 4.4], [-50, 1.8], [-49.5, -0.5], [-48, -1], [-44.5, -2.5],
      [-41, -3], [-38, -4], [-35.2, -5.5], [-35, -8.5], [-37, -11.5], [-39, -14.5], [-39.5, -18], [-40.5, -21.5],
      [-43, -23], [-48, -25.5], [-48.6, -28.5], [-51, -31.5], [-53, -34], [-54, -34.8], [-57.5, -36.2],
      [-56.8, -38], [-62, -39], [-62.5, -41], [-64.5, -42.5], [-65, -45], [-67.5, -46.5], [-66, -48],
      [-68.5, -50.5], [-68.4, -52.4], [-65.5, -55], [-67.5, -55.8], [-71, -54.5], [-74, -52.5], [-75.5, -48.5],
      [-74, -44], [-73.5, -40], [-73.5, -37], [-71.5, -33], [-71.5, -28.5], [-70.5, -23.5], [-70.3, -18.5],
      [-75, -15.5], [-76.5, -13], [-79, -8], [-81.2, -5.5], [-80.5, -3], [-80, -1], [-80, 1], [-78.8, 1.5],
      [-77.5, 4], [-77.3, 6.5], [-77.9, 7.3],
    ],
  },
  {
    name: "Africa",
    to: "AFRICA",
    ring: [
      [-5.9, 35.8], [-2, 35.1], [3, 36.8], [10, 37.3], [11, 35.2], [10.2, 33.8], [12, 32.9], [15, 32.3],
      [19.5, 30.4], [20.1, 32.2], [23, 32.6], [25, 31.6], [29, 30.9], [32.3, 31.3], [32.6, 29.5], [33.5, 27.2],
      [35.5, 23.9], [37.2, 21], [37.4, 18.5], [39, 15.8], [41.5, 13.5], [43.3, 12.5], [44.5, 10.4], [51.2, 11.9],
      [51, 10.4], [49.5, 6], [46, 1.5], [42, -1], [40.2, -3], [39.3, -6.5], [39.5, -10.5], [40.5, -15], [37, -17.8],
      [35, -20], [35.5, -24], [32.7, -25.9], [32.5, -28.5], [30.5, -31], [27.5, -33.5], [25, -34], [22, -34.2],
      [18.8, -34.4], [18.3, -32], [17, -29], [15.2, -27], [14.5, -23], [13.2, -20], [11.8, -17], [12.3, -13.5],
      [13.5, -11], [13.2, -9], [12.3, -6], [11.7, -3.5], [9.4, -0.5], [9.8, 2.5], [9.6, 4], [8.5, 4.5], [6, 4.3],
      [4.5, 6.3], [2, 6.3], [-1, 5.2], [-3.5, 5.1], [-7.5, 4.4], [-9.5, 5.5], [-12, 7.5], [-13.5, 9.5], [-15, 11],
      [-16.7, 12.5], [-17.4, 14.7], [-16.5, 16.5], [-16.2, 19.5], [-17, 21], [-15, 24], [-13, 27.6], [-9.8, 29.5],
      [-9.6, 32.5], [-6.8, 34],
    ],
  },
  { name: "Madagascar", to: "za", min: 3, ring: [[49.3, -12], [50.4, -15.5], [49.5, -17.5], [48, -22], [47, -25], [45, -25.5], [43.7, -23.5], [43.3, -21], [44.4, -17], [46.5, -15.7], [48, -13.5]] },
  {
    name: "Eurasia",
    to: "EURASIA",
    ring: [
      // Iberia, the Mediterranean's north shore
      [-5.6, 36], [-4.5, 36.7], [-2.1, 36.7], [-0.5, 38.3], [0.2, 38.8], [-0.3, 39.5], [0.9, 41], [3.2, 41.9],
      [3.1, 43.1], [4.5, 43.4], [6, 43.1], [7.5, 43.8], [8.8, 44.4], [10.2, 43.9], [11, 42.5], [12.5, 41.5],
      [14, 40.8], [15.7, 40], [15.6, 38], [16.6, 38.4], [17, 39], [16.6, 40], [18.5, 40.1], [17, 41], [16, 41.9],
      [14.2, 42.5], [13.6, 43.5], [12.3, 44.5], [12.4, 45.4], [13.7, 45.7], [14.5, 45.2], [15.5, 44], [17, 43],
      [19, 42], [19.4, 40.5], [20.2, 39.5], [21, 38.3], [21.7, 36.8], [23, 36.5], [23.1, 37.9], [24, 38.2],
      [22.9, 40.5], [24, 40.8], [26.2, 40.6], [27.5, 41], [28.9, 41.05],
      // the Black Sea
      [28.5, 41.5], [28, 42], [27.8, 43], [28.6, 44], [29.7, 45.2], [30.8, 46.5], [31.8, 46.6], [33.5, 46],
      [32.5, 45.4], [33.5, 44.5], [34.5, 44.8], [36.5, 45.2], [35, 45.8], [38, 47], [39.2, 47.2], [38, 44.5],
      [40, 43.4], [41.6, 41.6], [40, 41], [37, 41.2], [35, 42], [33, 42], [31, 41.1], [29.3, 41.15],
      // Anatolia, the Levant, Sinai
      [29.2, 40.85], [27.5, 40.3], [26.4, 40], [26.8, 38.5], [27.4, 37.2], [28.2, 36.7], [30.5, 36.3],
      [32.5, 36.1], [34.6, 36.8], [36.2, 36.6], [35.8, 35.5], [35.9, 34.5], [35.5, 33.8], [35, 33], [34.5, 31.5],
      [32.3, 31.2], [32.6, 30], [33.6, 28], [34.9, 29.5],
      // Arabia, the Gulf
      [35, 28], [37, 25], [39, 21.5], [40.5, 19], [42.5, 16], [43.4, 12.7], [45, 12.8], [48.5, 14], [52.2, 15.6],
      [55, 17.5], [57, 18.8], [58.8, 21], [59.8, 22.4], [58.5, 23.6], [56.4, 24.9], [56.3, 26.3], [55.5, 25.5],
      [54, 24.1], [51.6, 24.3], [51.5, 26], [50.2, 26.5], [48.5, 28.3], [48, 29.9], [48.6, 30], [50.2, 30],
      [50.8, 29], [51.5, 27.9], [54, 26.6], [56.3, 27.1], [57.3, 25.8], [61.5, 25.1], [66.6, 25.4],
      // India
      [67.5, 24], [68.8, 23.5], [70, 22.8], [69, 22.3], [70.4, 20.9], [72.6, 21.4], [72.8, 19], [73.4, 16],
      [74.6, 13], [76.2, 9.9], [77.5, 8.1], [78.2, 9], [79.3, 10.3], [80.2, 13.5], [80.2, 15.5], [82, 16.5],
      [84.5, 19], [86.8, 20.5], [87.5, 21.7], [89, 21.8], [90.5, 22.5], [91.8, 22.3], [92.3, 20.7], [94.2, 18.5],
      // Indochina, Malaya
      [94.5, 16], [95.5, 15.8], [97.5, 16.5], [97.7, 14.5], [98.6, 12], [98.3, 8], [100.3, 6], [100.4, 4],
      [101.5, 2.8], [103.4, 1.3], [104.2, 1.5], [103.4, 4], [103, 5.5], [102, 6.2], [100.3, 7.5], [99.2, 10.3],
      [99.9, 12.8], [100.5, 13.5], [101, 12.6], [103, 11.2], [104.8, 10.4], [104.8, 8.6], [106.8, 10.4],
      [109.2, 11.6], [109.3, 13.5], [108.8, 15.4], [107, 17], [105.7, 19], [106.7, 20.7], [108, 21.6],
      // China, Korea
      [109.7, 21.5], [110.4, 20.3], [111, 21.5], [113.5, 22.2], [116.5, 23], [119, 25.4], [120, 27], [121.8, 30],
      [122, 31], [120.8, 32.6], [119.5, 34.5], [120.3, 36], [122.5, 37], [121, 37.7], [119, 37.2], [118, 38.5],
      [117.7, 39], [119.5, 39.8], [121.5, 40.8], [121.2, 38.8], [124.3, 39.9], [125.2, 37.7], [126.6, 37.5],
      [126.4, 34.6], [127.5, 34.6], [129.3, 35.3], [129.5, 36.5], [128.4, 38.5], [127.5, 39.8], [129.7, 40.9],
      // the Russian Far East, Kamchatka, Chukotka
      [130.7, 42.3], [132, 43.2], [135.5, 43.8], [138, 46.5], [140.3, 48.5], [140.5, 51.5], [141.4, 52.3],
      [141, 53.5], [139, 54.2], [137, 54], [135.2, 54.7], [137.5, 56.5], [140.5, 58.3], [143.2, 59.4],
      [148.5, 59.3], [152, 59], [154.5, 59.4], [157.5, 61.6], [160.5, 61.8], [158, 59], [156.5, 57.5],
      [155.5, 55], [156.6, 51], [158.6, 52.9], [160, 54.5], [162.2, 56.2], [163.3, 57.8], [162, 58.5],
      [164.5, 59.9], [166.5, 60.3], [170.5, 60], [173, 61.5], [177, 62.5], [179, 62.5], [178, 64.5], [183, 65],
      [186, 64.3], [188.5, 65.5], [190.3, 66.1], [188, 67], [183, 68.6], [180, 69], [176, 69.8], [170, 70.1],
      // the Arctic coast
      [166, 69.5], [161, 69.6], [160, 70.9], [157, 71], [152, 70.8], [150, 71.6], [146, 72.3], [139, 71.5],
      [135, 71.6], [130, 70.9], [128, 72.8], [126, 73.4], [122, 73], [113.5, 73.5], [110, 74], [113.5, 75.8],
      [109, 76.7], [104.3, 77.7], [100, 76.3], [96, 76], [93, 75.8], [87, 75], [86, 74], [80.5, 73.5], [82, 72],
      [78.5, 72.4], [75.5, 72.5], [73, 73], [70.5, 73.4], [68.5, 71], [67, 69], [66, 68.8], [60.5, 69.8], [54, 68.5],
      [50, 68], [45, 68.5], [43.5, 66.3], [44, 66], [40.5, 64.6], [36, 64.2], [35, 66], [41, 66.5], [41.5, 67],
      [40, 68], [36, 69.1], [33, 69.4], [30, 69.8],
      // Scandinavia, the Baltic
      [26, 71], [20, 70], [16, 69], [14, 67.5], [12.5, 66], [11, 64.5], [9, 63.5], [5.2, 62.2], [5, 60.5],
      [5.5, 59], [7, 58], [8.3, 58.1], [10.6, 59.9], [11.4, 59], [12, 57.5], [12.8, 56], [14.3, 55.5], [16, 56.2],
      [16.5, 57.5], [18.5, 59.4], [17.2, 60.7], [17.5, 62.5], [20.5, 63.8], [22.5, 65.8], [25.3, 65.5], [25, 64.6],
      [22.3, 63.5], [21.5, 62.5], [21.4, 60.8], [22.9, 59.9], [26, 60.4], [30, 60.2], [28.5, 59.6], [24, 59.4],
      [23.5, 58.9], [24.3, 58.3], [24.1, 57], [21.1, 57.5], [21, 56.3], [21.2, 55.3], [20, 54.6], [18.5, 54.6],
      [16, 54.3], [14.2, 53.9], [12, 54.2], [10.8, 53.9],
      // Jutland, the North Sea, the Atlantic
      [10, 54.7], [10.6, 54.9], [10.3, 56.3], [10.6, 57.7], [9.6, 57.3], [8.2, 56.8], [8.1, 55.6], [8.6, 54.9],
      [8.8, 54], [8.3, 53.6], [7, 53.4], [5, 53.2], [4.7, 52.9], [4.2, 52], [3.5, 51.4], [2.5, 51.1], [1.6, 50.9],
      [1.5, 50.1], [0.2, 49.6], [-1.3, 49.6], [-1.9, 49.7], [-1.6, 48.7], [-3.5, 48.8], [-4.7, 48.4], [-4.3, 47.8],
      [-2.5, 47.3], [-1.2, 46.2], [-1.2, 44.6], [-1.6, 43.4], [-4, 43.4], [-8, 43.7], [-9.3, 43], [-8.9, 42],
      [-8.8, 40.5], [-9.5, 38.7], [-8.8, 37.8], [-9, 37], [-7.4, 37.2], [-6.3, 36.8],
    ],
  },
  {
    name: "Great Britain",
    to: "bi", min: 2,
    ring: [
      [-5.7, 50], [-3, 50.6], [1.4, 51.2], [1.7, 52.7], [0.3, 53.5], [-0.5, 54.5], [-1.6, 55.6], [-2.1, 57.1],
      [-1.8, 57.6], [-3.5, 57.7], [-3, 58.6], [-5, 58.6], [-6, 57.5], [-5.6, 56.3], [-4.9, 55.1], [-3.5, 54.9],
      [-3.3, 54.4], [-3, 53.3], [-4.6, 53.3], [-4, 52.3], [-5.3, 51.8], [-3, 51.4], [-4, 51.2],
    ],
  },
  { name: "Ireland", to: "bi", min: 2, ring: [[-6, 52.2], [-6.2, 53.9], [-5.5, 54.6], [-6.2, 55.2], [-7.3, 55.4], [-8.5, 54.6], [-10, 54.2], [-9.9, 53.4], [-9.2, 52.6], [-10.4, 51.9], [-9.5, 51.5], [-8, 51.8]] },
  { name: "Sicily", to: "se", min: 3, ring: [[12.4, 38.1], [15.6, 38.3], [15.1, 36.7], [12.5, 37.6]] },
  { name: "Sardinia", to: "se", min: 3, ring: [[8.2, 41], [9.8, 41], [9.6, 39.2], [8.4, 39]] },
  { name: "Svalbard", to: "sc", ring: [[11, 78.8], [16, 80], [25, 80.3], [27, 79], [21, 77.5], [16, 76.5], [14, 77.6]] },
  { name: "Novaya Zemlya", to: "ur", ring: [[52, 71.5], [55, 70.7], [57.6, 70.6], [56, 72.5], [60, 75], [68, 76.9], [65, 76.4], [58, 74.5], [53.5, 73]] },
  { name: "Severnaya Zemlya", to: "si", ring: [[95, 79], [100, 79.8], [105, 78.8], [100, 78]] },
  { name: "New Siberian Islands", to: "ya", ring: [[137, 75], [142, 76], [150, 75.5], [145, 74.5]] },
  { name: "Sri Lanka", to: "in", min: 2, ring: [[79.8, 9.8], [81.8, 7.5], [81.4, 6.2], [80.1, 6.1]] },
  { name: "Taiwan", to: "cn", min: 3, ring: [[121, 25.3], [122, 25], [121, 22], [120.1, 23]] },
  { name: "Hainan", to: "cn", min: 3, ring: [[108.6, 19.2], [110.5, 20.1], [111, 19.6], [109.5, 18.2]] },
  { name: "Sakhalin", to: "ka", min: 3, ring: [[142, 54.3], [143, 53], [143.3, 49], [144.5, 48.8], [143, 46], [142, 46], [142, 48.5], [141.7, 51.5]] },
  { name: "Hokkaido", to: "jp", min: 2, ring: [[140, 41.5], [141.2, 42.6], [143.3, 41.9], [145.8, 43.3], [145.3, 44.3], [141.9, 45.5], [141.5, 43.8], [140, 42.5]] },
  {
    name: "Honshu",
    to: "jp", min: 2,
    ring: [
      [141.5, 41.4], [142, 39.5], [141, 38.3], [140.9, 36.9], [140.8, 35.7], [139.8, 35], [138.8, 34.6], [137, 34.6],
      [135.8, 33.5], [135, 34.6], [132.5, 34.2], [130.9, 34.3], [132.5, 35.4], [135.5, 35.6], [136.8, 37.3],
      [138.5, 37.4], [139.5, 38.5], [140, 40], [140.3, 41.2],
    ],
  },
  { name: "Kyushu", to: "jp", min: 2, ring: [[130, 33.6], [131.5, 33.6], [131.7, 32], [131, 31], [130.2, 31.3], [129.6, 33]] },
  { name: "Shikoku", to: "jp", min: 3, ring: [[132, 33.8], [134.5, 34.2], [134.7, 33.8], [133, 32.8]] },
  {
    name: "Philippines",
    to: "id", min: 3,
    ring: [
      [120.5, 18.5], [122.3, 18.5], [122.5, 16.5], [124.2, 13.5], [125.5, 11], [126.3, 9], [126.6, 7], [125.5, 5.7],
      [123.8, 6.6], [122, 7], [123, 9.5], [122, 10.5], [121.5, 12.5], [120.6, 14], [120, 16.4],
    ],
  },
  {
    name: "Borneo",
    to: "id", min: 2,
    ring: [
      [109, 1.5], [111, 1.6], [113, 3.2], [115.4, 5.2], [117, 7], [119.2, 5.2], [118, 4.5], [117.8, 1], [119, 0.9],
      [116.5, -1.5], [116.2, -3.9], [114.5, -3.5], [111, -3], [110, -1.5], [109, 0.2],
    ],
  },
  { name: "Sumatra", to: "id", min: 2, ring: [[95.3, 5.6], [97.5, 5.2], [100.4, 2.2], [103.8, -1], [106, -3], [106, -5.8], [104.5, -5.9], [101, -2.5], [98.7, 1.7], [95.8, 3.5]] },
  { name: "Java", to: "id", min: 2, ring: [[105.2, -6.8], [106, -5.9], [108.3, -6.2], [110.5, -6.9], [112.6, -6.9], [114.5, -7.8], [114.4, -8.7], [110, -8.2], [106.5, -7.4]] },
  {
    name: "Sulawesi",
    to: "id", min: 2,
    ring: [[119, -5.5], [120.5, -5.5], [121.5, -4.5], [123.2, -5.4], [122.5, -3], [123.4, -1], [121.5, -1], [125, 1.5], [124.5, 0.4], [121, 0.6], [119.8, 0.6], [118.8, -2.6]],
  },
  { name: "Timor", to: "id", min: 3, ring: [[123.5, -10.3], [127.3, -8.4], [125, -9.3]] },
  {
    name: "New Guinea",
    to: "ng", min: 2,
    ring: [
      [131, -1.3], [134, -0.9], [135, -3.3], [138, -1.6], [141, -2.6], [145.8, -4.9], [147.5, -6.2], [147, -8],
      [150.5, -10.5], [148, -10.2], [146, -8.1], [144, -7.6], [143.5, -9], [141, -9.1], [139, -8.1], [138, -8.4],
      [137.8, -5.5], [135, -4.4], [132.5, -4], [132, -2.8],
    ],
  },
  {
    name: "Australia",
    to: "AUSTRALIA",
    ring: [
      [113.5, -22], [114, -26.5], [115, -29.5], [115, -33.5], [115.5, -34.5], [118, -35], [121.5, -33.8], [124, -33],
      [126, -32.3], [131, -31.5], [134, -32.8], [135.8, -34.8], [137.5, -33.2], [138, -35.5], [139.5, -35.8],
      [140.5, -38], [143.5, -38.8], [146.3, -39.1], [148, -37.8], [150, -37.5], [151.2, -33.9], [153.2, -30],
      [153.6, -28], [153, -25.2], [150.8, -22.6], [149, -20.5], [146.2, -18.8], [145.4, -15], [143.5, -14],
      [142.6, -10.7], [141.6, -12.6], [141.5, -16], [140.5, -17.5], [139.3, -17.3], [136.6, -15.8], [135.5, -14.8],
      [136.7, -12.2], [135.8, -11.9], [132.5, -11.5], [130.8, -12.4], [129.5, -14.9], [128, -15], [126, -14],
      [124.5, -16.4], [122.2, -17.9], [121, -19.5], [118.5, -20.3], [116.7, -20.6], [114.5, -21.8],
    ],
  },
  { name: "Tasmania", to: "eo", min: 2, ring: [[144.6, -40.7], [148.3, -40.9], [148, -43.2], [146.8, -43.6], [145.2, -42.2]] },
  {
    name: "New Zealand (North)",
    to: "eo", min: 2,
    ring: [[172.7, -34.4], [174.3, -35.8], [175.9, -37.3], [178.5, -37.7], [177.9, -39.2], [176.8, -40.2], [175.2, -41.6], [174.6, -39.6], [173.8, -39.2], [174.6, -37.3], [173, -35.4]],
  },
  {
    name: "New Zealand (South)",
    to: "eo", min: 2,
    ring: [[172.7, -40.5], [174.3, -41.7], [173.4, -42.9], [172.7, -43.8], [171.2, -44.4], [170.6, -45.9], [169, -46.6], [166.5, -46], [166.7, -45.2], [168.3, -44], [170.5, -43], [172.1, -41.4]],
  },
];

/** Lakes cut out of the land. */
const LAKES: Ring[] = [
  // the Caspian Sea
  [[46.7, 44.5], [47.5, 45.6], [49, 46.5], [51.5, 47], [53, 46.6], [53, 45.2], [51, 44.5], [51.3, 43.2], [52.6, 42], [53, 40.5], [54, 39], [53.9, 37.3], [51, 36.7], [49, 37.5], [49.3, 40.3], [48.5, 41.8], [47.5, 43]],
];

// ---------------------------------------------------------------- regions

/**
 * A mainland's territories in the order they claim hexes: the first
 * whose region holds the hex's centre (or, on the coast, its first
 * sample on land) gets it. A region is one or more rough polygons;
 * overlaps go to the earlier territory, gaps to the nearest seed.
 */
const GROUPS: Record<string, string[]> = {
  AMERICA_N: ["ak", "mx", "hb", "rk", "yk", "qc", "ap"],
  AMERICA_S: ["co", "pe", "ar", "br"],
  AFRICA: ["sh", "eg", "ea", "za", "wa", "cg"],
  EURASIA: ["sc", "we", "ce", "se", "ru", "me", "eg", "ir", "st", "ur", "mo", "si", "ya", "ka", "in", "sm", "cn"],
  AUSTRALIA: ["wo", "eo"],
};

const box = (w: number, s: number, e: number, n: number): Ring => [[w, s], [e, s], [e, n], [w, n]];

const REGIONS: Record<string, Ring[]> = {
  // North America
  ak: [box(-180, 50, -141, 80)],
  mx: [[[-125, 33], [-117.1, 32.6], [-111, 31.3], [-108.2, 31.3], [-106.5, 31.8], [-104.5, 29.7], [-102.5, 29.8], [-101, 29.5], [-99.5, 27.5], [-97.2, 25.9], [-90, 26], [-80, 23], [-70, 15], [-75, 5], [-125, 5]]],
  hb: [[[-110, 49], [-110, 60], [-102, 60], [-102, 80], [-75, 80], [-78, 62.5], [-79.5, 51], [-79.5, 47], [-84, 46.5], [-89, 48], [-95, 49]]],
  rk: [[[-141, 60], [-110, 60], [-110, 49], [-103, 49], [-103, 30], [-125, 30], [-141, 57]]],
  yk: [box(-141, 60, -102, 80)],
  qc: [[[-80, 43.3], [-79.5, 51], [-78, 62.5], [-75, 66], [-50, 66], [-50, 40], [-66.5, 44.5], [-67.8, 47.2], [-69.5, 47.2], [-71, 45], [-74.7, 45], [-76.5, 44]]],
  ap: [box(-103, 20, -50, 50)],
  // South America
  co: [[[-85, 15], [-45, 15], [-50, 2], [-58, 1.5], [-64, 1], [-67, 1], [-69.5, -1], [-70, -4], [-72.5, -2], [-75.5, 0], [-79, 1], [-85, 1]]],
  pe: [[[-85, 1], [-79, 1], [-75.5, 0], [-72.5, -2], [-70, -4], [-73, -7.5], [-72.5, -9.5], [-70.5, -11], [-65.3, -9.7], [-60, -13.5], [-58, -16.3], [-58, -19.8], [-62, -22.2], [-67, -22.8], [-68.5, -19], [-70.4, -18.3], [-85, -18.3]]],
  ar: [[[-85, -18.3], [-70.4, -18.3], [-68.5, -19], [-67, -22.8], [-62, -22.2], [-58, -22.5], [-54.5, -25.5], [-55.5, -28], [-57.6, -30.2], [-53.5, -33.7], [-45, -35], [-45, -60], [-85, -60]]],
  br: [box(-85, -60, -30, 15)],
  // Africa
  sh: [[[-20, 40], [25, 40], [25, 21.5], [24, 19.5], [15, 22.5], [11.9, 23.5], [4, 19], [-4.8, 24.5], [-8.7, 27.5], [-17, 21.3], [-20, 21.3]]],
  eg: [
    [[25, 21.5], [25, 40], [40, 40], [40, 17.5], [38.5, 17.8], [36.5, 14.3], [34, 10], [33.5, 9.5], [27, 9], [24, 9], [22, 12.5], [24, 19.5]],
    // Sinai, which the Eurasia polygon has
    [[32, 31.5], [34.2, 31.4], [34.95, 29.5], [34, 27], [32, 29]],
  ],
  ea: [[[33.5, 9.5], [34, 10], [36.5, 14.3], [38.5, 17.8], [40, 17.5], [55, 15], [55, -12], [35.5, -11.5], [30.5, -8.5], [29.5, -4.5], [29.6, -1.4], [30, 3.5], [33, 5]]],
  za: [[[0, -17.5], [24, -17.5], [30, -15.5], [35.5, -11.5], [55, -12], [55, -40], [0, -40]]],
  wa: [[[-20, 21.3], [-17, 21.3], [-8.7, 27.5], [-4.8, 24.5], [4, 19], [11.9, 23.5], [15, 22.5], [24, 19.5], [22, 12.5], [24, 9], [15.5, 9], [14.5, 12.5], [12, 8], [9.5, 6.5], [8.5, 4], [-20, 0]]],
  cg: [box(-20, -40, 60, 40)],
  // Europe
  sc: [[[3, 57.9], [11.2, 57.9], [12.3, 55], [14.5, 55], [20, 57.5], [22, 59.4], [28, 60.4], [31.5, 62.9], [29.8, 64.7], [30, 67.5], [28.7, 69], [31, 70], [31, 73], [3, 73]]],
  we: [[[-15, 35.9], [-15, 55], [5, 55], [7.2, 53.6], [6, 51.8], [6.1, 50.2], [6.5, 49.5], [8.2, 49], [7.6, 47.6], [6, 46.2], [7, 45.9], [7.6, 43.7], [8, 40], [3, 35.9]]],
  ce: [[[7.2, 53.6], [6, 51.8], [6.1, 50.2], [6.5, 49.5], [8.2, 49], [7.6, 47.6], [6, 46.2], [7, 45.9], [10.5, 46.5], [12.5, 47], [14.5, 46.5], [16.5, 46.5], [19, 45.9], [21, 46.2], [22.5, 48.3], [22.8, 49.2], [24.1, 50.8], [23.5, 52], [23.5, 54], [19.5, 54.4], [15, 55.5], [12.3, 55], [11.2, 57.9], [8, 58]]],
  se: [[[7, 45.9], [10.5, 46.5], [12.5, 47], [14.5, 46.5], [16.5, 46.5], [19, 45.9], [21, 46.2], [22.5, 48.3], [24.5, 47.9], [26.5, 48.3], [27, 48.4], [28.2, 46.5], [28.2, 45.5], [29.6, 45.4], [30, 44], [28, 42], [26.5, 41.9], [26.1, 40.7], [26, 36], [19, 35], [7.6, 38], [7.6, 43.7]]],
  ru: [[[19.5, 54.4], [15, 65], [40, 76], [46, 76], [46, 51.5], [50.5, 51.5], [50.5, 51.5], [49, 48], [47, 46], [48.6, 41.8], [46, 42], [44, 42.7], [42, 43.3], [40, 43.5], [37, 45], [30, 44], [29.6, 45.4], [28.2, 45.5], [28.2, 46.5], [27, 48.4], [26.5, 48.3], [24.5, 47.9], [22.5, 48.3], [22.8, 49.2], [24.1, 50.8], [23.5, 52], [23.5, 54]]],
  // Asia
  me: [[[26.1, 40.7], [26.5, 41.9], [28.5, 43], [38, 43], [40, 43.5], [42, 43.3], [44, 42.7], [46, 42], [48.6, 41.8], [50, 41.8], [50, 39], [48.9, 38.4], [46.5, 38.9], [44.8, 39.7], [44.3, 37.5], [45.4, 35.9], [46.2, 34.5], [47.6, 32.3], [48.5, 29.9], [50.5, 28.5], [53, 27], [56.3, 26.7], [58.5, 25], [65, 22], [65, 10], [42, 10], [34.9, 29.5], [34.2, 31.4], [30, 34], [26, 36]]],
  ir: [[[40, 30], [44, 39.5], [48, 38.4], [49.5, 37.5], [53.9, 37.3], [57, 38.2], [60.5, 36.6], [61.2, 35.6], [62.5, 35.3], [64.5, 37.1], [67.8, 37.2], [70, 37.5], [71.5, 37], [74.5, 37.4], [73, 34], [72, 30], [70, 27], [68.5, 23.5], [60, 20], [40, 20]]],
  st: [[[47, 46], [49, 48], [50.5, 51.5], [55, 51], [61, 51], [65, 54.6], [69, 55.4], [73.5, 54], [76.5, 54.2], [80, 51], [83, 51], [87.3, 49.2], [87.8, 49.2], [90.5, 47.5], [91, 45.5], [95, 44.3], [96.5, 42.7], [94, 39], [90.5, 36.5], [86, 36], [80, 35.8], [78, 35.6], [75, 37], [74.5, 37.4], [71.5, 37], [70, 37.5], [67.8, 37.2], [64.5, 37.1], [62.5, 35.3], [61.2, 35.6], [60.5, 36.6], [57, 38.2], [53.9, 37.3], [51, 40], [49, 44]]],
  ur: [box(45, 50, 85, 85)],
  mo: [[[87.3, 49.2], [90, 50.5], [92, 50.6], [97.5, 49.8], [98, 52], [102, 51.5], [106, 50.3], [108, 49.3], [111, 49.5], [114.5, 50.2], [116.7, 49.8], [120, 52.5], [121.5, 53.3], [125.5, 53], [127.5, 50], [130.5, 48.9], [133, 48.3], [135, 48.5], [133.2, 45], [131, 43.5], [126, 43.3], [121, 43.3], [116, 42.5], [111, 40], [105, 37.5], [100, 37.5], [96, 40], [94, 42], [91, 44], [88, 47]]],
  si: [[[80, 45], [80, 85], [112, 85], [112, 56.5], [120, 56.5], [120, 45]]],
  ya: [[[110, 56], [110, 85], [195, 85], [195, 65.5], [170, 66], [155, 65], [145, 63], [135, 59], [120, 56.5]]],
  ka: [[[131, 40], [131, 47], [127.5, 50], [120, 52], [120, 56.5], [135, 59], [145, 63], [155, 65], [170, 66], [195, 65.5], [195, 40]]],
  in: [[[66, 23.5], [70, 27], [72, 30], [73, 34], [74.5, 37.4], [78, 35.5], [79, 32.5], [81, 30.2], [84, 28.5], [88, 27.8], [92, 27.8], [97.3, 28.2], [95, 26], [94, 24], [93, 22], [92.4, 20.7], [88, 10], [75, 3], [66, 10]]],
  sm: [[[92.4, 20.7], [93, 22], [94, 24], [95, 26], [97.3, 28.2], [98.7, 25], [98, 24], [99.5, 22.1], [101.5, 21.2], [102, 22.4], [103.5, 22.7], [105.5, 23.2], [106.7, 22.8], [108, 21.5], [110, 19], [115, 10], [107, 0], [98, 0], [92, 10]]],
  cn: [box(60, 0, 150, 60)],
  // Australia
  wo: [box(100, -45, 136.5, -5)],
  eo: [box(136.5, -45, 160, -5)],
};

/**
 * Straits and gulfs narrower than a hex that should show: every hex the
 * line runs through (the nearest to each point along it) becomes sea.
 */
const SEAWAYS: Ring[] = [
  // the English Channel
  [[-6, 49.3], [0, 50.2], [2, 51], [3, 52]],
  // the Red Sea
  [[34.5, 27], [35.5, 25], [38.5, 20], [41.5, 15], [43.3, 12.6]],
  // the Persian Gulf
  [[48.5, 29.5], [51, 27.5], [54.5, 26], [56.5, 26.2], [58, 24.5]],
  // Hudson Bay, James Bay, Hudson Strait
  [[-87, 63], [-86, 58], [-82, 55], [-80, 52.5]],
  [[-80, 62.6], [-72, 61.5], [-64, 61]],
];

/**
 * Fix-ups after the rasterisation and the seaways, by place (the hex
 * whose centre is nearest to the point): a territory's id, or `..` for
 * sea. For land that should touch or not, and for specks.
 */
const FIXES: [number, number, string][] = [
  // New Guinea's north coast and the Bird's Head
  [131, -2, "ng"],
  [138, -1.5, "ng"],
  [144, -2.5, "ng"],
  // the Pacific left of the Americas is the scoreboard's: the Alaska Peninsula and the panhandle give way
  [-157, 59, ".."],
  [-134, 59, ".."],
  [-131, 56, ".."],
  // Panama reaches Colombia
  [-80, 9, "mx"],
  // Sinai joins Egypt to the Levant; the Red Sea's seaway took a hex of Arabia
  [35, 29, "eg"],
  [39, 28, "me"],
  // the Caspian's waist, so the Caucasus does not touch Turkmenistan
  [54, 41, ".."],
  // India, squeezed by the East Asian lens: Gujarat and the coast of Andhra
  [71, 20, "in"],
  [83, 17, "in"],
  // Korea hangs from China; Vladivostok goes with Manchuria
  [124, 39, "cn"],
  [129, 42, "mo"],
  // La Pérouse Strait: Sakhalin's tip off Hokkaido
  [143, 48.5, ".."],
];

/** Badge positions picked by hand (the hex nearest to the point), when the automatic one is poor. */
const BADGES: Record<string, LonLat> = {};

// --------------------------------------------------------------- geometry

/** How far from a hex's centre its outer samples lie, in hex radii. */
const SAMPLE = 0.6;

/** Rings' bounding boxes (west, south, east, north), made once. */
const boxes = new WeakMap<Ring, [number, number, number, number]>();

/** Whether a point lies in a ring (even-odd). */
function inside(ring: Ring, [x, y]: LonLat): boolean {
  let b = boxes.get(ring);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [a, c] of ring) b = [Math.min(b[0], a), Math.min(b[1], c), Math.max(b[2], a), Math.max(b[3], c)];
    boxes.set(ring, b);
  }
  if (x < b[0] || y < b[1] || x > b[2] || y > b[3]) return false;
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function centroid(ring: Ring): LonLat {
  let x = 0;
  let y = 0;
  for (const [a, b] of ring) (x += a), (y += b);
  return [x / ring.length, y / ring.length];
}

/** The cell whose centre is nearest to a place. */
function cellAt(p: LonLat): number {
  const [x, y] = project(p);
  return cellNear(x, y);
}

/** The cell whose centre is nearest to a point of the map (hex radii). */
function cellNear(x: number, y: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cx = HEX_W * (c + 0.5 + 0.5 * (r & 1));
      const cy = 1 + HEX_ROW * r;
      const d = (cx - x) ** 2 + (cy - y) ** 2;
      if (d < bestD) (bestD = d), (best = r * COLS + c);
    }
  }
  return best;
}

/** Longitude/latitude distance, longitude shrunk by the latitude. */
function far(a: LonLat, b: LonLat): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]);
}

// ------------------------------------------------------------- the build

/** Which territory each cell belongs to (`null`: sea). */
export function rasterise(): (string | null)[] {
  const cells: (string | null)[] = new Array(COLS * ROWS).fill(null);
  const byId = new Map(TERRITORIES.map((t) => [t.id, t]));
  const hits = new Map<Land, number>();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      // the centre and six points towards the corners
      const [x, y] = cellXY(c, r);
      const samples: LonLat[] = [mapLonLat(x, y)];
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k - Math.PI / 2;
        samples.push(mapLonLat(x + SAMPLE * Math.cos(a), y + SAMPLE * Math.sin(a)));
      }
      // longitudes past the right edge are written as such (Chukotka at 190°); lakes are no land
      const wet = samples
        .map(([lon, lat]): LonLat[] => [[lon, lat], [lon - 360, lat], [lon + 360, lat]])
        .filter((alts) => !LAKES.some((l) => alts.some((q) => inside(l, q))));
      // the land most of the samples lie on, if enough do; where (the centre if it can)
      let best: Land | undefined;
      let bestN = 0;
      let at: LonLat | undefined;
      for (const land of LAND) {
        let n = 0;
        let first: LonLat | undefined;
        for (const alts of wet) {
          const q = alts.find((a) => inside(land.ring, a));
          if (q) (n++), (first ??= q);
        }
        if (n >= (land.min ?? 4) && n > bestN) (best = land), (bestN = n), (at = first);
      }
      if (!best) continue;
      hits.set(best, (hits.get(best) ?? 0) + 1);
      cells[r * COLS + c] = classify(best.to, at!, byId);
    }
  }
  // islands smaller than a hex still get one
  for (const land of LAND) {
    if (hits.get(land)) continue;
    const i = cellAt(centroid(land.ring));
    if (cells[i] === null && !GROUPS[land.to]) cells[i] = land.to;
  }
  for (const way of SEAWAYS) {
    for (let k = 1; k < way.length; k++) {
      const [x0, y0] = project(way[k - 1]!);
      const [x1, y1] = project(way[k]!);
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 4);
      for (let s = 0; s <= steps; s++) cells[cellNear(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps)] = null;
    }
  }
  for (const [lon, lat, id] of FIXES) cells[cellAt([lon, lat])] = id === ".." ? null : id;
  return cells;
}

function classify(to: string, p: LonLat, byId: Map<string, TerritoryDef>): string {
  const group = GROUPS[to];
  if (!group) return to;
  for (const id of group) if (REGIONS[id]?.some((ring) => inside(ring, p))) return id;
  let best = group[0]!;
  for (const id of group) if (far(byId.get(id)!.seed, p) < far(byId.get(best)!.seed, p)) best = id;
  return best;
}

/**
 * A territory's badge: on its largest piece, the hex with the most of
 * its own around it (the ring of six counts most, then the twelve
 * beyond), near the piece's middle.
 */
function badge(cells: (string | null)[], id: string): number {
  const own = (c: number, r: number) => c >= 0 && r >= 0 && c < COLS && r < ROWS && cells[r * COLS + c] === id;
  // the largest piece of it
  let mine: number[] = [];
  const seen = new Set<number>();
  cells.forEach((x, i) => {
    if (x !== id || seen.has(i)) return;
    const part = [i];
    seen.add(i);
    for (let k = 0; k < part.length; k++) {
      const j = part[k]!;
      for (const [c, r] of hexNeighbors(j % COLS, Math.floor(j / COLS))) {
        const n = r * COLS + c;
        if (own(c, r) && !seen.has(n)) seen.add(n), part.push(n);
      }
    }
    if (part.length > mine.length) mine = part;
  });
  const pos = (i: number) => [HEX_W * ((i % COLS) + 0.5 + 0.5 * (Math.floor(i / COLS) & 1)), HEX_ROW * Math.floor(i / COLS)] as const;
  let mx = 0;
  let my = 0;
  for (const i of mine) (mx += pos(i)[0]), (my += pos(i)[1]);
  mx /= mine.length;
  my /= mine.length;
  let best = mine[0]!;
  let bestScore = -Infinity;
  for (const i of mine) {
    const c = i % COLS;
    const r = Math.floor(i / COLS);
    const ring1 = hexNeighbors(c, r);
    const n1 = ring1.filter(([a, b]) => own(a, b)).length;
    const ring2 = new Set<string>();
    for (const [a, b] of ring1) for (const [d, e] of hexNeighbors(a, b)) ring2.add(`${d},${e}`);
    let n2 = 0;
    for (const k of ring2) {
      const [d, e] = k.split(",").map(Number) as [number, number];
      if ((d !== c || e !== r) && !ring1.some(([a, b]) => a === d && b === e) && own(d, e)) n2++;
    }
    const [x, y] = pos(i);
    const score = 4 * n1 + n2 - 0.6 * Math.hypot(x - mx, y - my);
    if (score > bestScore) (bestScore = score), (best = i);
  }
  return best;
}

/** The text of data/world.txt. */
export function generate(): string {
  const cells = rasterise();
  const out: string[] = [
    "# Landgrab's world, generated by scripts/world.ts (node scripts/world.ts):",
    "# edit that, not this file. The format is in game/world.ts.",
    `grid ${COLS} ${ROWS}`,
  ];
  for (const c of CONTINENTS) out.push(`continent ${c.id} ${c.bonus} ${c.en} | ${c.de}`);
  for (const t of TERRITORIES) {
    const at = BADGES[t.id];
    let i = at ? cellAt(at) : badge(cells, t.id);
    if (cells[i] !== t.id) i = badge(cells, t.id);
    out.push(`territory ${t.id} ${t.continent} ${i % COLS} ${Math.floor(i / COLS)} ${t.en} | ${t.de}`);
  }
  for (const [a, b, wrap] of LINKS) out.push(`link ${a} ${b}${wrap ? " wrap" : ""}`);
  out.push("map");
  for (let r = 0; r < ROWS; r++) {
    let line = "";
    for (let c = 0; c < COLS; c++) line += cells[r * COLS + c] ?? "..";
    out.push(line);
  }
  return out.join("\n") + "\n";
}

/** What is odd about a world, a line each (for the console; the tests are stricter). */
export function report(w: World): string[] {
  const out: string[] = [];
  for (const t of w.territories) out.push(`${t.id} ${String(t.hexes.length).padStart(3)}  ${t.neighbors.join(" ")}`);
  const land = w.territories.reduce((n, t) => n + t.hexes.length, 0);
  out.push(`${land} land hexes of ${w.cols * w.rows}; connected: ${connected(w)}`);
  for (const l of w.links) {
    const a = w.byId.get(l.a)!;
    const b = w.byId.get(l.b)!;
    const touch = a.hexes.some((i) => hexNeighbors(i % w.cols, Math.floor(i / w.cols)).some(([c, r]) => c >= 0 && r >= 0 && c < w.cols && r < w.rows && w.cells[r * w.cols + c] === b.index));
    if (touch) out.push(`link ${l.a} ${l.b}: they touch already`);
  }
  for (const t of w.territories) {
    const parts = pieces(w, t.id);
    if (parts.length > 1) out.push(`${t.id} in ${parts.length} pieces: ${parts.map((p) => p.length).join(" ")}`);
  }
  for (const i of inHud(w)) out.push(`land in the HUD's corner: ${w.territories[w.cells[i]!]!.id} at ${i % w.cols} ${Math.floor(i / w.cols)}`);
  return out;
}

/** A territory's pieces of land (cells that touch), the largest first. */
export function pieces(w: World, id: string): number[][] {
  const t = w.byId.get(id)!;
  const left = new Set(t.hexes);
  const out: number[][] = [];
  while (left.size) {
    const first = left.values().next().value!;
    left.delete(first);
    const part = [first];
    for (let k = 0; k < part.length; k++) {
      const i = part[k]!;
      for (const [c, r] of hexNeighbors(i % w.cols, Math.floor(i / w.cols))) {
        const j = r * w.cols + c;
        if (c >= 0 && r >= 0 && c < w.cols && r < w.rows && left.has(j)) left.delete(j), part.push(j);
      }
    }
    out.push(part);
  }
  return out.sort((a, b) => b.length - a.length);
}

/**
 * The TV's HUD, in fractions of the screen (x, y, width, height), where
 * it wants sea: the scoreboard on the left and the join badge in the
 * bottom left corner.
 */
export const HUD: [number, number, number, number][] = [
  [0, 0.25, 130 / 1280, 0.45],
  [0, 510 / 720, 230 / 1280, 210 / 720],
];

/** Land hexes that reach into the HUD's places (their cells). */
export function inHud(w: World): number[] {
  const [mw, mh] = mapSize(w);
  const out: number[] = [];
  w.cells.forEach((t, i) => {
    if (t < 0) return;
    const c = i % w.cols;
    const r = Math.floor(i / w.cols);
    const x = HEX_W * (c + 0.5 + 0.5 * (r & 1));
    const y = 1 + HEX_ROW * r;
    // the hex's box, a little smaller than its corners
    const hit = HUD.some(([hx, hy, hw, hh]) => x + 0.8 > hx * mw && x - 0.8 < (hx + hw) * mw && y + 0.8 > hy * mh && y - 0.8 < (hy + hh) * mh);
    if (hit) out.push(i);
  });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = new URL("../data/world.txt", import.meta.url);
  const text = generate();
  if (process.argv.includes("--check")) {
    if (readFileSync(file, "utf8") !== text) {
      console.error("data/world.txt is not what scripts/world.ts makes: run node scripts/world.ts");
      process.exit(1);
    }
  } else {
    writeFileSync(file, text);
  }
  for (const line of report(parseWorld(text))) console.log(line);
}
