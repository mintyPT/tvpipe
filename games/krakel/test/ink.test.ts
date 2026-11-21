import assert from "node:assert/strict";
import { test } from "node:test";

import { costOf, cut, DOT, DRAWN, inkOf, lengthOf, LIFT, pointsOf, polyline, progressAt, totalCost } from "../game/ink.ts";

// Strokes are [colour, width, x0, y0, x1, y1, …].
const line = [1, 14, 100, 100, 300, 100]; // 200 long
const dot = [3, 30, 500, 500];
const corner = [1, 14, 0, 0, 100, 0, 100, 100]; // smoothed: shorter than 200

test("a stroke's path: two points are a line, more a curve through the midpoints, from the first to the last point", () => {
  assert.equal(pointsOf(line), 2);
  assert.equal(pointsOf(dot), 1);
  assert.deepEqual(polyline(line), [100, 100, 300, 100]);
  assert.deepEqual(polyline(dot), [500, 500]);
  const p = polyline(corner);
  assert.deepEqual(p.slice(0, 4), [0, 0, 50, 0]);
  assert.deepEqual(p.slice(-4), [100, 50, 100, 100]);
  // The corner is cut: the curve passes (87.5, 12.5), not (100, 0).
  assert.deepEqual(p.slice(6, 8), [87.5, 12.5]);
  assert.ok(lengthOf(p) < 200 && lengthOf(p) > 170, String(lengthOf(p)));
  assert.equal(polyline(corner), p, "sampled once");
});

test("what strokes cost in a replay: the pen's way, then their ink; a dot costs a little", () => {
  assert.equal(lengthOf([0, 0, 3, 4, 3, 10]), 11);
  assert.equal(inkOf(line), 200);
  assert.equal(inkOf(dot), DOT);
  assert.equal(inkOf([1, 6, 10, 10, 11, 10]), DOT, "a stroke shorter than a dot costs a dot");
  assert.equal(costOf(line), LIFT + 200);
  assert.equal(totalCost([line, dot]), 2 * LIFT + 200 + DOT);
});

test("the cut of a drawing: nothing, the pen on its way, a stroke half drawn, whole strokes, everything", () => {
  const strokes = [line, dot, [2, 6, 500, 600, 500, 800]];
  const total = totalCost(strokes);
  assert.deepEqual(cut(strokes, 0), { whole: 0, part: null, tip: null, down: false });
  assert.deepEqual(cut(strokes, 1), { whole: 3, part: null, tip: null, down: false });
  assert.deepEqual(cut([], 0.5), { whole: 0, part: null, tip: null, down: false });
  // The first stroke: the pen waits at its start, then draws.
  assert.deepEqual(cut(strokes, (LIFT / 2) / total), { whole: 0, part: null, tip: [100, 100], down: false });
  assert.deepEqual(cut(strokes, (LIFT + 50) / total), { whole: 0, part: [100, 100, 150, 100], tip: [150, 100], down: true });
  // Between strokes: half the way from (300, 100) to the dot at (500, 500).
  const second = LIFT + 200;
  assert.deepEqual(cut(strokes, (second + LIFT / 2) / total), { whole: 1, part: null, tip: [400, 300], down: false });
  // The dot is there for its time.
  assert.deepEqual(cut(strokes, (second + LIFT + DOT / 2) / total), { whole: 1, part: [500, 500], tip: [500, 500], down: true });
  // The last stroke, three quarters drawn.
  const third = second + LIFT + DOT;
  const c = cut(strokes, (third + LIFT + 150) / total);
  assert.equal(c.whole, 2);
  assert.deepEqual(c.part, [500, 600, 500, 750]);
  assert.ok(c.down);
});

test("a replay always takes the same time: twice the ink is drawn twice as fast", () => {
  const short = [[1, 14, 0, 0, 100, 0]];
  const long = [[1, 14, 0, 0, 1000, 0]];
  const half = (strokes: number[][]) => cut(strokes, (LIFT + inkOf(strokes[0]!) / 2) / totalCost(strokes)).tip;
  assert.deepEqual(half(short), [50, 0]);
  assert.deepEqual(half(long), [500, 0]);
});

test("a curve is drawn along its length", () => {
  const p = polyline(corner);
  const len = lengthOf(p);
  const c = cut([corner], (LIFT + len / 2) / (LIFT + len));
  assert.ok(c.part && c.tip);
  assert.ok(Math.abs(lengthOf(c.part!) - len / 2) < 1e-6);
  // Half way round a symmetric corner: on its diagonal.
  assert.ok(Math.abs(c.tip![0] + c.tip![1] - 100) < 1e-6 || Math.abs(c.tip![0] - (100 - c.tip![1])) < 1e-6);
});

test("the replay's clock: drawn after DRAWN of the guess time, whole until the end", () => {
  assert.equal(DRAWN, 0.85);
  assert.equal(progressAt(900, 1000, 2000), 0);
  assert.equal(progressAt(1000, 1000, 2000), 0);
  assert.equal(progressAt(1425, 1000, 2000), 0.5);
  assert.equal(progressAt(1850, 1000, 2000), 1);
  assert.equal(progressAt(2500, 1000, 2000), 1);
  assert.equal(progressAt(5, 10, 10), 0);
  assert.equal(progressAt(10, 10, 10), 1);
});
