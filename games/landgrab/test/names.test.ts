import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { placeNames, splits, territoryAt, type Label } from "../game/names.ts";
import { hexCenter, mapSize, parseWorld } from "../game/world.ts";

const world = parseWorld(readFileSync(new URL("../data/world.txt", import.meta.url), "utf8"));

/** A stand-in for a font: every letter 0.55 of the size wide. */
const measure = (text: string, size: number) => text.length * 0.55 * size;

const box = (l: Label): [number, number, number, number] => [l.x - l.w / 2, l.y - l.h / 2, l.w, l.h];
const overlap = (a: number[], b: number[]) => (a[0] ?? 0) < (b[0] ?? 0) + (b[2] ?? 0) && (b[0] ?? 0) < (a[0] ?? 0) + (a[2] ?? 0) && (a[1] ?? 0) < (b[1] ?? 0) + (b[3] ?? 0) && (b[1] ?? 0) < (a[1] ?? 0) + (a[3] ?? 0);

test("territoryAt: a hex's centre and corners' insides are its territory's, the sea and off the map none", () => {
  for (const t of world.territories) {
    for (const cell of t.hexes) {
      const [x, y] = hexCenter(cell % world.cols, Math.floor(cell / world.cols), 1);
      assert.equal(territoryAt(world, x, y), t.index);
      // Near the top corner and the left side, still inside.
      assert.equal(territoryAt(world, x, y - 0.85), t.index);
      assert.equal(territoryAt(world, x - 0.8, y), t.index);
    }
  }
  const sea = world.cells.findIndex((c) => c < 0);
  const [sx, sy] = hexCenter(sea % world.cols, Math.floor(sea / world.cols), 1);
  assert.equal(territoryAt(world, sx, sy), -1);
  assert.equal(territoryAt(world, -5, 10), -1);
  assert.equal(territoryAt(world, 10, -5), -1);
  const [W, H] = mapSize(world);
  assert.equal(territoryAt(world, W + 3, H / 2), -1);
});

test("splits: one line, and two at the space that balances them", () => {
  const len = (x: string) => x.length;
  assert.deepEqual(splits("Peru", len), [["Peru"]]);
  assert.deepEqual(splits("Southern Europe", len), [["Southern Europe"], ["Southern", "Europe"]]);
  assert.deepEqual(splits("Democratic Republic of Congo", len), [["Democratic Republic of Congo"], ["Democratic", "Republic of Congo"]]);
});

test("placeNames: a lone name sits under its badge, on its land", () => {
  const si = world.byId.get("si");
  assert.ok(si);
  const [l] = placeNames(world, new Map([[si.index, "Siberia"]]), { size: 1.2, measure, badge: 1.5 });
  assert.ok(l);
  const [ax, ay] = hexCenter(si.anchor[0], si.anchor[1], 1);
  assert.equal(l.x, ax);
  assert.ok(l.y > ay + 1.5 && l.y < ay + 1.5 + 1.2, `under the badge: ${l.y} vs ${ay}`);
  assert.deepEqual(l.lines, ["Siberia"]);
  assert.equal(territoryAt(world, l.x, l.y), si.index);
});

test("placeNames: without a badge a name may sit on the anchor", () => {
  const t = world.byId.get("si");
  assert.ok(t);
  const [l] = placeNames(world, new Map([[t.index, "Siberia"]]), { size: 1.2, measure, badge: 1.5, badges: [] });
  assert.deepEqual([l?.x, l?.y], hexCenter(t.anchor[0], t.anchor[1], 1));
});

test("placeNames: the whole world as the TV names it, every name clear of the others and of every badge", () => {
  const [W, H] = mapSize(world);
  const names = new Map(world.territories.map((t) => [t.index, t.name.en.toUpperCase()]));
  const labels = placeNames(world, names, { size: 1.4, small: 1.15, measure, badge: 1.55, bounds: [0.3, 0.3, W - 0.6, H - 0.6], lead: 0.95 });
  assert.equal(labels.length, world.territories.length);
  for (const [i, a] of labels.entries()) {
    const b = box(a);
    assert.ok(b[0] >= 0.3 && b[1] >= 0.3 && b[0] + b[2] <= W - 0.3 && b[1] + b[3] <= H - 0.3, `${a.lines.join(" ")} inside the map`);
    for (const c of labels.slice(i + 1)) assert.ok(!overlap(b, box(c)), `${a.lines.join(" ")} and ${c.lines.join(" ")} overlap`);
    for (const t of world.territories) {
      const [cx, cy] = hexCenter(t.anchor[0], t.anchor[1], 1);
      const dx = cx - Math.max(b[0], Math.min(cx, b[0] + b[2]));
      const dy = cy - Math.max(b[1], Math.min(cy, b[1] + b[3]));
      assert.ok(dx * dx + dy * dy >= 1.55 * 1.55, `${a.lines.join(" ")} on ${t.id}'s badge`);
    }
    // Next to its own badge.
    const own = world.territories[a.t];
    assert.ok(own);
    const [ox, oy] = hexCenter(own.anchor[0], own.anchor[1], 1);
    assert.ok(Math.hypot(a.x - ox, a.y - oy) < 7, `${a.lines.join(" ")} far from its badge`);
  }
});

test("placeNames: deterministic", () => {
  const names = new Map(world.territories.map((t) => [t.index, t.name.de]));
  const o = { size: 1.2, small: 1, measure, badge: 1.5 };
  assert.deepEqual(placeNames(world, names, o), placeNames(world, names, o));
});
