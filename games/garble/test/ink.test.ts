import assert from "node:assert/strict";
import { test } from "node:test";

import { cut, DOT, GRID, inkOf, lengthOf, MAX_POINTS, MAX_STROKES, pointsOf, polyline, replayTime, totalInk, WIDTHS } from "../game/ink.ts";
import { validateDrawing } from "../game/rules.ts";

// Strokes are [width, x0, y0, x1, y1, …].
const line = [16, 100, 100, 300, 100]; // 200 long
const dot = [38, 500, 500];
const corner = [16, 0, 0, 100, 0, 100, 100]; // smoothed: shorter than 200

test("a stroke's path: two points are a line, more a curve through the midpoints, from the first to the last point", () => {
  assert.equal(pointsOf(line), 2);
  assert.equal(pointsOf(dot), 1);
  assert.deepEqual(polyline(line), [100, 100, 300, 100]);
  assert.deepEqual(polyline(dot), [500, 500]);
  const p = polyline(corner);
  assert.equal(p.length, 2 * 7, "the first point, the first midpoint, four samples of the curve, the last point");
  assert.deepEqual(p.slice(0, 4), [0, 0, 50, 0]);
  assert.deepEqual(p.slice(-4), [100, 50, 100, 100]);
  // The corner is cut: the curve passes (87.5, 12.5), not (100, 0).
  assert.deepEqual(p.slice(6, 8), [87.5, 12.5]);
  assert.ok(lengthOf(p) < 200 && lengthOf(p) > 170, String(lengthOf(p)));
  assert.equal(polyline(corner), p, "sampled once");
});

test("what strokes count for in a replay: their length; a dot a little", () => {
  assert.equal(lengthOf([0, 0, 3, 4, 3, 10]), 11);
  assert.equal(inkOf(line), 200);
  assert.equal(inkOf(dot), DOT);
  assert.equal(totalInk([line, dot]), 200 + DOT);
  assert.equal(totalInk([]), 0);
});

test("the cut of a drawing: nothing, a stroke half drawn, whole strokes, a dot only whole, everything", () => {
  const strokes = [line, dot, [7, 500, 600, 500, 800]];
  const total = totalInk(strokes);
  assert.equal(total, 200 + DOT + 200);
  assert.deepEqual(cut(strokes, 0), { whole: 0, part: null });
  assert.deepEqual(cut(strokes, -1), { whole: 0, part: null });
  assert.deepEqual(cut(strokes, 1), { whole: 3, part: null });
  assert.deepEqual(cut([], 0.5), { whole: 0, part: null });
  assert.deepEqual(cut(strokes, 50 / total), { whole: 0, part: [100, 100, 150, 100] });
  assert.deepEqual(cut(strokes, 200 / total), { whole: 1, part: null });
  // The dot appears whole, when its time is over.
  assert.deepEqual(cut(strokes, (200 + DOT / 2) / total), { whole: 1, part: null });
  assert.deepEqual(cut(strokes, (200 + DOT) / total), { whole: 2, part: null });
  // The last stroke, three quarters drawn.
  assert.deepEqual(cut(strokes, (200 + DOT + 150) / total), { whole: 2, part: [500, 600, 500, 750] });
  // Along a curve: the part ends on the path.
  const c = cut([corner], 0.5);
  assert.equal(c.whole, 0);
  assert.ok(Math.abs(lengthOf(c.part!) - lengthOf(polyline(corner)) / 2) < 1e-9);
});

test("a replay's time: by its ink and strokes, within its bounds", () => {
  assert.equal(replayTime([]), 900);
  assert.equal(replayTime([line], 0, 9999), 200 * 0.45 + 40);
  assert.equal(replayTime([[16, 0, 0, 1000, 0], [16, 0, 1000, 1000, 1000]], 900, 2600), 2000 * 0.45 + 80);
  assert.equal(replayTime(Array.from({ length: 20 }, () => [16, 0, 0, 1000, 1000])), 2600);
});

test("the limits the pad keeps are the ones the rules check", () => {
  assert.equal(GRID, 1000);
  assert.deepEqual(WIDTHS, [7, 16, 38]);
  for (const w of WIDTHS) assert.doesNotThrow(() => validateDrawing({ strokes: [[w, 0, 0, GRID, GRID]] }));
  assert.doesNotThrow(() => validateDrawing({ strokes: Array.from({ length: MAX_STROKES }, () => [7, 1, 1]) }));
  assert.throws(() => validateDrawing({ strokes: Array.from({ length: MAX_STROKES + 1 }, () => [7, 1, 1]) }), /strokes/);
  const long = [7, ...Array.from({ length: MAX_POINTS }, (_, i) => [i % GRID, 5]).flat()];
  assert.doesNotThrow(() => validateDrawing({ strokes: [long] }));
  assert.throws(() => validateDrawing({ strokes: [[...long, 1, 1]] }), /points/);
});
