import assert from "node:assert/strict";
import { test } from "node:test";

import { applyDiff as clientApply } from "../src/client.ts";
import { applyDiff, diff, toJson, type Json, type JsonObject } from "../src/sync.ts";
import { cleanText, graphemes, nameKey } from "../src/names.ts";

test("diff: set, nested merge, delete, arrays and null replace", () => {
  const a = { x: 1, o: { a: 1, b: { c: 2 } }, arr: [1, 2], gone: true, n: 3 };
  const b = { x: 1, o: { a: 2, b: { c: 2 } }, arr: [1, 2, 3], n: null, added: { k: "v" } };
  const d = diff(a, b as JsonObject)!;
  assert.deepEqual(d, { set: { o: { a: 2 }, arr: [1, 2, 3], n: null, added: { k: "v" } }, del: [["gone"]] });
  assert.deepEqual(applyDiff(a, d), b);
  assert.equal(diff(a, toJson(a) as JsonObject), undefined);
  // An object replacing a scalar and the other way round.
  const c = { o: 5, x: { y: 1 } };
  assert.deepEqual(applyDiff(a, diff(a, c as JsonObject)!), c);
});

/** Deterministic pseudo-random JSON. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomValue(r: () => number, depth: number): Json {
  const k = Math.floor(r() * (depth > 2 ? 4 : 7));
  switch (k) {
    case 0:
      return null;
    case 1:
      return r() < 0.5;
    case 2:
      return Math.floor(r() * 5);
    case 3:
      return ["a", "b", ""][Math.floor(r() * 3)]!;
    case 4:
      return Array.from({ length: Math.floor(r() * 3) }, () => randomValue(r, depth + 1));
    default:
      return randomObject(r, depth + 1);
  }
}

function randomObject(r: () => number, depth: number): JsonObject {
  const o: JsonObject = {};
  const n = Math.floor(r() * 4);
  for (let i = 0; i < n; i++) o[["p", "q", "r", "s"][Math.floor(r() * 4)]!] = randomValue(r, depth);
  return o;
}

test("diff then apply gives the new view, on the server and in the client", () => {
  const r = rng(42);
  for (let i = 0; i < 3000; i++) {
    const a = randomObject(r, 0);
    const b = randomObject(r, 0);
    const d = diff(a, b);
    if (!d) {
      assert.deepEqual(a, b);
      continue;
    }
    assert.deepEqual(applyDiff(a, d), b, `server ${JSON.stringify([a, b, d])}`);
    // Over the wire.
    const wire = JSON.parse(JSON.stringify(d));
    assert.deepEqual(clientApply(structuredClone(a), wire), b, `client ${JSON.stringify([a, b, d])}`);
  }
});

test("text cleaning", () => {
  assert.equal(cleanText("  a\tb\n\nc  ", 16), "a b c");
  assert.equal(cleanText("x\u202ey\u200bz\u0007", 16), "xyz");
  assert.equal(cleanText("e\u0301", 16), "é");
  assert.equal(cleanText("éééabc", 3), "ééé");
  assert.equal(cleanText("👩‍👩‍👧‍👦👍🏽abc", 3), "abc");
  assert.equal(graphemes("👩‍👩‍👧‍👦"), 1);
  assert.equal(cleanText(42, 5), "");
  assert.equal(nameKey("Zoë M"), nameKey("zoe m"));
});
