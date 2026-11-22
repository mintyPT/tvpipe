import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeBlueprint } from "../game/map.ts";
import { bitsDecode, bitsEncode, fromBase64, rleDecode, rleEncode, toBase64, VarintReader, VarintWriter } from "../game/codec.ts";
import { hashSeed, Rng } from "../game/rng.ts";

// Known answers computed with an independent implementation (Python, big integers).
test("mulberry32 gives its known outputs", () => {
  const take = (seed: number, n: number) => {
    const r = new Rng(seed);
    return Array.from({ length: n }, () => r.next());
  };
  assert.deepEqual(take(0, 5), [1144304738, 1416247, 958946056, 627933444, 2007157716]);
  assert.deepEqual(take(42, 5), [2581720956, 1925393290, 3661312704, 2876485805, 750819978]);
  assert.deepEqual(take(0xdeadbeef, 3), [4043151706, 1147597007, 3315858022]);
});

test("the state round-trips and float/int stay in range", () => {
  const a = new Rng(7);
  a.next();
  const b = Rng.restore(a.state);
  assert.equal(a.next(), b.next());
  const r = new Rng(1);
  for (let k = 0; k < 2000; k++) {
    const f = r.float();
    assert.ok(f >= 0 && f < 1);
    const i = r.int(3, 9);
    assert.ok(Number.isInteger(i) && i >= 3 && i <= 9);
  }
  assert.equal(r.int(5, 2), 5);
  assert.equal(r.pick([]), undefined);
  assert.equal(r.weighted([1, 2], () => 0), undefined);
  assert.deepEqual(new Rng(3).shuffle([1, 2, 3, 4, 5]).sort(), [1, 2, 3, 4, 5]);
});

test("hashSeed is FNV-1a 32 (known answers)", () => {
  assert.equal(hashSeed(""), 0x811c9dc5);
  assert.equal(hashSeed("a"), 0xe40c292c);
  assert.equal(hashSeed("foobar"), 0xbf9cf968);
  // parts: a 0x1f separator, numbers as 4 bytes little-endian
  assert.equal(hashSeed("pinch", 3), 3906394619);
  assert.notEqual(hashSeed("ab"), hashSeed("a", "b"));
});

test("base64url, varints, run lengths and bit sets round-trip", () => {
  for (const bytes of [[], [0], [255, 1], [1, 2, 3], [0, 0, 0, 0, 250]]) {
    assert.deepEqual([...fromBase64(toBase64(bytes))!], bytes);
  }
  assert.equal(toBase64([0xfb, 0xff]), "-_8");
  assert.equal(toBase64([77, 97, 110]), "TWFu");
  assert.equal(fromBase64("a"), null);
  assert.equal(fromBase64("ab$c"), null);
  assert.equal(fromBase64(17), null);
  const w = new VarintWriter();
  for (const n of [0, 1, 127, 128, 300, 2 ** 31 - 1]) w.uint(n);
  assert.deepEqual(w.bytes.slice(0, 5), [0, 1, 127, 0x80, 1]);
  const r = new VarintReader(Uint8Array.from(w.bytes));
  assert.deepEqual([r.uint(), r.uint(), r.uint(), r.uint(), r.uint(), r.uint(), r.uint()], [0, 1, 127, 128, 300, 2 ** 31 - 1, -1]);
  const layer = [3, 3, 3, 0, 0, 7, 3, 3];
  assert.deepEqual([...rleDecode(rleEncode(layer), layer.length, 7)!], layer);
  assert.equal(rleDecode(rleEncode(layer), layer.length + 1, 7), null);
  assert.equal(rleDecode(rleEncode(layer), layer.length, 6), null);
  assert.equal(rleDecode("!!", 3, 9), null);
  const bits = [1, 0, 0, 1, 1, 1, 0, 0, 1, 0];
  assert.deepEqual([...bitsDecode(bitsEncode(bits), bits.length)!], bits);
  assert.equal(bitsDecode(bitsEncode(bits), 40), null);
});

test("decoders never throw on junk", () => {
  const junk: unknown[] = [null, 1, "x", [], {}, { v: 1, w: 10, h: 10 }, { v: 1, w: 1e9, h: 2 }, { v: 1, w: 10, h: 10, cells: "AAAA", areas: 5 }];
  for (const j of junk) assert.equal(decodeBlueprint(j), null);
});
