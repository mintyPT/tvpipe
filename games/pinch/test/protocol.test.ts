import assert from "node:assert/strict";
import { test } from "node:test";

import { generate } from "../game/map.ts";
import {
  applyPublic,
  decodeTrack,
  encodeTrack,
  parseAction,
  publicState,
  whereAt,
  wordsArea,
  type Sample,
} from "../game/protocol.ts";
import { Heist } from "../game/sim.ts";
import { noun } from "../game/words.ts";

test("parseAction: every kind, junk to null", () => {
  assert.deepEqual(parseAction({ a: "go", x: 1.5, y: 2 }), { a: "go", x: 1.5, y: 2 });
  assert.deepEqual(parseAction({ a: "go", x: 1.5, y: 2, extra: 1 }), { a: "go", x: 1.5, y: 2 });
  assert.equal(parseAction({ a: "go", x: NaN, y: 2 }), null);
  assert.equal(parseAction({ a: "go", x: "1", y: 2 }), null);
  assert.deepEqual(parseAction({ a: "stop" }), { a: "stop" });
  assert.deepEqual(parseAction({ a: "door", door: 3 }), { a: "door", door: 3 });
  assert.equal(parseAction({ a: "door", door: -1 }), null);
  assert.equal(parseAction({ a: "door", door: 1.5 }), null);
  assert.deepEqual(parseAction({ a: "pick", door: 0 }), { a: "pick", door: 0 });
  assert.deepEqual(parseAction({ a: "climb", window: 2 }), { a: "climb", window: 2 });
  assert.deepEqual(parseAction({ a: "switch", room: 2 }), { a: "switch", room: 2 });
  assert.deepEqual(parseAction({ a: "take", item: 0 }), { a: "take", item: 0 });
  assert.deepEqual(parseAction({ a: "smash", lamp: 1 }), { a: "smash", lamp: 1 });
  assert.deepEqual(parseAction({ a: "tamper", camera: 1 }), { a: "tamper", camera: 1 });
  assert.deepEqual(parseAction({ a: "strip" }), { a: "strip" });
  assert.deepEqual(parseAction({ a: "firecracker", x: 3, y: 4 }), { a: "firecracker", x: 3, y: 4 });
  assert.deepEqual(parseAction({ a: "flashlight", on: true }), { a: "flashlight", on: true });
  assert.equal(parseAction({ a: "flashlight", on: 1 }), null);
  assert.deepEqual(parseAction({ a: "aim", angle: -30 }), { a: "aim", angle: -30 });
  assert.deepEqual(parseAction({ a: "hold" }), { a: "hold" });
  assert.deepEqual(parseAction({ a: "hold", target: "p1" }), { a: "hold", target: "p1" });
  assert.equal(parseAction({ a: "hold", target: 5 }), null);
  assert.deepEqual(parseAction({ a: "wriggle" }), { a: "wriggle" });
  assert.deepEqual(parseAction({ a: "mark", kind: "seen", x: 1, y: 2, angle: 90 }), { a: "mark", kind: "seen", x: 1, y: 2, angle: 90 });
  assert.deepEqual(parseAction({ a: "mark", kind: "clear", x: 1, y: 2 }), { a: "mark", kind: "clear", x: 1, y: 2 });
  assert.equal(parseAction({ a: "mark", kind: "lie", x: 1, y: 2 }), null);
  assert.deepEqual(parseAction({ a: "unmark", mark: 4 }), { a: "unmark", mark: 4 });
  for (const junk of [null, undefined, 1, "go", [], [{ a: "go" }], { a: "__proto__" }, { a: "toString" }, {}]) assert.equal(parseAction(junk), null);
});

test("tracks round-trip at 1/20 tile and 2°, standing costs a byte", () => {
  const s: Sample[] = [];
  for (let k = 0; k < 300; k++) s.push({ x: 10 + (k < 100 ? k * 0.175 : 17.5), y: 5.25, facing: k < 100 ? 0 : 271, flags: k > 200 ? 3 : 0 });
  const enc = encodeTrack(s);
  const dec = decodeTrack(enc)!;
  assert.equal(dec.length, 300);
  dec.forEach((d, k) => {
    assert.ok(Math.abs(d.x - s[k]!.x) <= 0.025 + 1e-9);
    assert.ok(Math.abs(d.y - s[k]!.y) <= 0.025 + 1e-9);
    assert.ok(Math.abs(((d.facing - s[k]!.facing + 540) % 360) - 180) <= 1);
    assert.equal(d.flags, s[k]!.flags);
  });
  assert.ok(enc.length < 700, `${enc.length}`);
  assert.deepEqual(decodeTrack(encodeTrack([])), []);
  assert.equal(decodeTrack("!!"), null);
  assert.equal(decodeTrack("Aw"), null, "a repeat before any sample");
  assert.equal(decodeTrack(5), null);
});

test("whereAt and wordsArea name places the words can say", () => {
  const e = generate(5, 3);
  const m = e.map;
  for (const r of m.rooms) {
    const w = whereAt(m, r.rect.x + 0.5, r.rect.y + 0.5)!;
    assert.deepEqual(w, { room: r.id });
    const a = wordsArea(m, w)!;
    assert.ok(noun("en", a).the.length > 0 && noun("de", a).the.length > 0);
  }
  for (const d of m.doors) assert.ok(noun("en", wordsArea(m, { door: d.id })!).label);
  for (const g of m.gates) assert.ok(noun("en", wordsArea(m, { gate: g.id })!).label);
  for (const s of m.spots) assert.equal(noun("en", wordsArea(m, { spot: s.id })!).label, String(s.id + 1));
  for (const a of m.areas) assert.ok(noun("de", wordsArea(m, { area: a.id })!).in);
  assert.equal(wordsArea(m, { room: 999 }), null);
  assert.equal(whereAt(m, -1, 3), null);
  assert.equal(whereAt(m, NaN, 3), null);
});

test("applyPublic: deltas in order rebuild the layer; a gap waits for a keyframe", () => {
  const e = generate(3, 2);
  const h = new Heist(e, { thief: "T", guards: ["A", "B"] });
  let st = publicState(h.publicLayer(), e.map)!;
  const d1 = h.publicDelta();
  h.step();
  st = applyPublic(st, d1, e.map)!;
  for (let k = 0; k < 40; k++) h.step();
  const d2 = h.publicDelta();
  for (let k = 0; k < 40; k++) h.step();
  const d3 = h.publicDelta();
  assert.equal(applyPublic(st, d3, e.map), null, "d2 missing");
  st = applyPublic(applyPublic(st, d2, e.map)!, d3, e.map)!;
  assert.equal(st.seq, d3.seq);
  const key = publicState(h.publicLayer(), e.map)!;
  assert.deepEqual(st, key);
  const k = applyPublic(null, h.publicKey(), e.map)!;
  assert.deepEqual(k, key);
  assert.equal(applyPublic(st, { seq: 1 } as never, e.map), null);
});
