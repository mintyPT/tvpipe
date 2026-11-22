import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { connected, hexNeighbors, parseWorld, type World } from "../game/world.ts";
import { generate, inHud, pieces } from "../scripts/world.ts";

const TEXT = readFileSync(new URL("../data/world.txt", import.meta.url), "utf8");
const world = parseWorld(TEXT);

/**
 * Who borders whom, by land or by sea: the game as designed. A change to
 * the map that changes this has to change it here too.
 */
const NEIGHBORS: Record<string, string> = {
  ak: "ka yk",
  yk: "ak hb rk",
  gl: "hb qc sc",
  hb: "ap gl qc rk yk",
  qc: "ap gl hb",
  rk: "ap hb mx yk",
  ap: "hb mx qc rk",
  mx: "ap co rk",
  co: "br mx pe",
  pe: "ar br co",
  br: "ar co pe wa",
  ar: "br pe",
  bi: "ce sc we",
  sc: "bi gl ru",
  we: "bi ce se sh",
  ce: "bi ru se we",
  se: "ce eg me ru sh we",
  ru: "ce me sc se st ur",
  wa: "br cg eg sh",
  sh: "eg se wa we",
  eg: "cg ea me se sh wa",
  cg: "ea eg wa za",
  ea: "cg eg me za",
  za: "cg ea",
  me: "ea eg ir ru se",
  ir: "cn in me st",
  st: "cn ir mo ru si ur",
  ur: "ru si st",
  si: "ka mo st ur ya",
  ya: "ka si",
  ka: "ak jp mo si ya",
  mo: "cn ka si st",
  cn: "in ir jp mo sm st",
  in: "cn ir sm",
  sm: "cn id in",
  jp: "cn ka",
  id: "ng sm wo",
  ng: "eo id",
  wo: "eo id",
  eo: "ng wo",
};

/** The territories in more than one piece (islands), and how many. */
const PIECES: Record<string, number> = {
  yk: 2, // Banks and Victoria Island
  hb: 3, // Ellesmere and Devon Island, Southampton Island
  qc: 2, // Newfoundland
  mx: 3, // Cuba, Hispaniola
  sc: 3, // Svalbard, Iceland
  se: 3, // Sardinia, Sicily
  za: 2, // Madagascar
  ur: 2, // Novaya Zemlya
  ya: 2, // the New Siberian Islands
  id: 2, // Sumatra, Java and Borneo; the Philippines
  eo: 2, // New Zealand
};

/** Where each continent can be entered from: its territories with neighbours abroad. */
const GATES: Record<string, string> = {
  na: "ak gl mx",
  sa: "br co",
  eu: "ru sc se we",
  af: "ea eg sh wa",
  as: "ka me sm st ur",
  oc: "id",
};

function touches(w: World, a: string, b: string): boolean {
  const tb = w.byId.get(b)!;
  return w.byId.get(a)!.hexes.some((i) => hexNeighbors(i % w.cols, Math.floor(i / w.cols)).some(([c, r]) => c >= 0 && r >= 0 && c < w.cols && r < w.rows && w.cells[r * w.cols + c] === tb.index));
}

test("data/world.txt is what scripts/world.ts makes", () => {
  assert.equal(generate(), TEXT);
});

test("the world: 40 territories on six continents with their bonuses", () => {
  assert.equal(world.territories.length, 40);
  assert.deepEqual(
    world.continents.map((c) => [c.id, c.bonus, c.territories.length]),
    [
      ["na", 5, 8],
      ["sa", 2, 4],
      ["eu", 5, 6],
      ["af", 3, 6],
      ["as", 7, 12],
      ["oc", 2, 4],
    ],
  );
  assert.deepEqual(
    world.continents.map((c) => `${c.name.en} | ${c.name.de}`),
    ["North America | Nordamerika", "South America | Südamerika", "Europe | Europa", "Africa | Afrika", "Asia | Asien", "Oceania | Ozeanien"],
  );
  for (const t of world.territories) assert.ok(t.name.en && t.name.de, t.id);
});

test("every territory is big enough for its badge and in one piece, but for the islands", () => {
  for (const t of world.territories) {
    assert.ok(t.hexes.length >= 5, `${t.id}: ${t.hexes.length} hexes`);
    assert.equal(pieces(world, t.id).length, PIECES[t.id] ?? 1, `${t.id}'s pieces`);
  }
});

test("a badge sits on its territory with room around it", () => {
  for (const t of world.territories) {
    const [c, r] = t.anchor;
    assert.equal(world.cells[r * world.cols + c], t.index, t.id);
    const own = hexNeighbors(c, r).filter(([a, b]) => a >= 0 && b >= 0 && a < world.cols && b < world.rows && world.cells[b * world.cols + a] === t.index);
    assert.ok(own.length >= 2, `${t.id}'s badge has ${own.length} hexes of its own around it`);
  }
});

test("the neighbours are the designed ones, both ways", () => {
  assert.deepEqual(Object.keys(NEIGHBORS).sort(), world.territories.map((t) => t.id).sort());
  for (const t of world.territories) {
    assert.deepEqual(t.neighbors, NEIGHBORS[t.id]!.split(" "), t.id);
    for (const n of t.neighbors) assert.ok(world.byId.get(n)!.neighbors.includes(t.id), `${t.id} ${n}`);
  }
});

test("the continents' gates", () => {
  for (const c of world.continents) {
    const gates = c.territories.filter((id) => world.byId.get(id)!.neighbors.some((n) => world.byId.get(n)!.continent !== c.id));
    assert.deepEqual(gates.sort().join(" "), GATES[c.id], c.id);
  }
});

test("the world and each continent are connected", () => {
  assert.ok(connected(world));
  for (const c of world.continents) {
    const seen = new Set([c.territories[0]!]);
    const todo = [c.territories[0]!];
    while (todo.length) {
      for (const n of world.byId.get(todo.pop()!)!.neighbors) {
        if (!seen.has(n) && world.byId.get(n)!.continent === c.id) seen.add(n), todo.push(n);
      }
    }
    assert.equal(seen.size, c.territories.length, c.id);
  }
});

test("links join territories that do not touch, once; only Alaska and Kamchatka wrap", () => {
  const seen = new Set<string>();
  for (const l of world.links) {
    const key = [l.a, l.b].sort().join(" ");
    assert.ok(!seen.has(key), `link ${key} twice`);
    seen.add(key);
    assert.ok(!touches(world, l.a, l.b), `link ${key}: they touch`);
    assert.equal(l.wrap, key === "ak ka", key);
  }
  // and the territories that touch are neighbours without one
  assert.ok(touches(world, "eg", "me"), "Sinai");
  assert.ok(touches(world, "mx", "co"), "Panama");
  assert.ok(touches(world, "se", "me"), "the Bosporus");
});

test("the TV's HUD corners are sea", () => {
  assert.deepEqual(inHud(world), []);
});

// parseWorld on small maps: what it reads and what it refuses

const TINY = `# a comment
grid 4 2
continent no 2 North | Nord
continent so 1 South
territory aa no 0 0 Aland | Aland
territory bb so 2 1 Bland | Bland
link aa bb wrap
map
aaaa....
# rows may have comments in between
..bbbb
`;

test("parseWorld reads a small map", () => {
  const w = parseWorld(TINY);
  assert.equal(w.cols, 4);
  assert.equal(w.rows, 2);
  assert.deepEqual(w.continents[1], { id: "so", bonus: 1, name: { en: "South", de: "South" }, territories: ["bb"] });
  assert.deepEqual([...w.cells], [0, 0, -1, -1, -1, 1, 1, -1]);
  const [a, b] = w.territories;
  assert.deepEqual(a!.hexes, [0, 1]);
  assert.deepEqual(b!.hexes, [5, 6]);
  assert.deepEqual(b!.anchor, [2, 1]);
  assert.deepEqual(a!.neighbors, ["bb"]);
  assert.deepEqual(w.links, [{ a: "aa", b: "bb", wrap: true }]);
});

test("parseWorld refuses broken maps, saying where", () => {
  const broken = (from: string, to: string) => TINY.replace(from, to);
  const cases: [string, RegExp][] = [
    [broken("grid 4 2", "grid 4"), /world\.txt:2: grid COLS ROWS/],
    [broken("grid 4 2", "grid 4 3"), /the map has 2 rows, the grid 3/],
    [broken("..bbbb", "..bbbbbb.."), /world\.txt:11: 5 cells, the grid has 4/],
    [broken("..bbbb", "..cc"), /world\.txt:11: no territory "cc" \(column 1\)/],
    [broken("territory bb so 2 1", "territory bb xx 3 1"), /world\.txt:6: no continent xx/],
    [broken("territory bb so 2 1", "territory bb so 0 1"), /bb's badge \(0 1\) is not on one of its hexes/],
    [broken("territory bb so 2 1 Bland | Bland", "territory aa so 3 1 Bland"), /world\.txt:6: territory aa twice/],
    [broken("link aa bb wrap", "link aa zz"), /link aa zz: no such territories/],
    [broken("link aa bb wrap", "link aa"), /world\.txt:7: link ID ID \[wrap\]/],
    [broken("link aa bb wrap", "lnk aa bb"), /world\.txt:7: what is "lnk"\?/],
    [broken("..bbbb", "......"), /bb has no hexes/],
    [TINY.slice(0, TINY.indexOf("map")), /no map/],
  ];
  for (const [text, err] of cases) assert.throws(() => parseWorld(text), err, String(err));
});
