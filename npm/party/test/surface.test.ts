import assert from "node:assert/strict";
import { test } from "node:test";

import { audioClock, codecs, pacer, slrwRecord, wallMicros } from "../src/surface.ts";

test("surface records are SLRW: kind, pts (µs, LE), length, payload", () => {
  const r = slrwRecord(3, 0x0102030405, new Uint8Array([9, 8]), 1);
  assert.deepEqual([...r], [3, 5, 4, 3, 2, 1, 0, 0, 0, 3, 0, 0, 0, 1, 9, 8]);
  const a = slrwRecord(2, 1.6, new Uint8Array([1, 2, 3, 4]));
  assert.equal(a.length, 17);
  assert.equal(a[1], 2, "pts rounded");
  assert.equal(new DataView(a.buffer).getUint32(9, true), 4);
  // The wall clock in µs (what tvpipe compares the lag against).
  assert.ok(Math.abs(wallMicros() / 1000 - Date.now()) < 50);
});

test("surface codecs ask for the H.264 level of their size and rate", () => {
  const level = (w: number, h: number, fps: number) => codecs(w, h, fps)[0]!.slice(-2);
  assert.deepEqual(codecs(1280, 720, 30), ["avc1.42E01F", "avc1.4D401F", "avc1.64001F"]);
  assert.equal(level(1920, 1080, 30), "28");
  assert.equal(level(1920, 1080, 60), "2A");
  assert.equal(level(3840, 2160, 30), "33");
  assert.equal(level(3840, 2160, 60), "34");
  // Larger than any level: the largest.
  assert.equal(level(7680, 4320, 30), "34");
});

test("surface frames keep an even cadence (the capture script's pacer)", () => {
  // The same known answers as tvpipe's check of capture.js
  // (crates/tvpipe/src/session/browser_tests.rs, check_timing).
  const p = pacer(40000);
  assert.deepEqual(
    [p(1000000), p(1041000), p(1070000), p(1100859), p(1200000), p(1210000, true)],
    [1000000, 1040000, 1080125, null, 1198859.375, 1239001.953125],
  );
  // A page drawing at 60 Hz into a 30 fps surface, its frames up to 2 ms
  // late: every other frame, the timestamps exactly 1/30 s apart.
  const q = pacer(1e6 / 30);
  const out: number[] = [];
  for (let k = 0; k < 120; k++) {
    const v = q(1e6 + (k * 1e6) / 60 + ((k * 7919) % 2000));
    if (v !== null) out.push(v);
  }
  assert.equal(out.length, 60);
  for (let i = 1; i < out.length; i++) assert.ok(Math.abs(out[i]! - out[i - 1]! - 1e6 / 30) < 300, `${i}`);
});

test("surface audio is timed by its sample count", () => {
  const a = audioClock(48000);
  assert.deepEqual(
    [a(480, 1010000), a(480, 1045000), a(480, 1028000), a(480, 3100000), a(480, 3135000)],
    [1000000, 1010000, 1018000, 3090000, 3100000],
  );
  const b = audioClock(48000);
  const out: number[] = [];
  for (let k = 0; k <= 398; k++) {
    const v = b(480, k ? 1e6 + (k + 1) * 10000 + 30000 : 1010000);
    if ([0, 1, 396, 397, 398].includes(k)) out.push(v);
  }
  assert.deepEqual(out, [1000000, 1010000, 4960000, 5000000, 5010000]);
});
