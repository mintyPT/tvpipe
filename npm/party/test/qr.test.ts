/** The page's QR encoder against tvpipe's (test/vectors/qr.txt) and qrcodegen's symbols and penalties (the crate's vectors). */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { encodeQr, encodeQrAt } from "../src/qr.ts";

const here = new URL(".", import.meta.url);

test("the same symbols as tvpipe's encoder", () => {
  const lines = readFileSync(new URL("vectors/qr.txt", here), "utf8").split("\n").filter((l) => l.startsWith("{"));
  assert.ok(lines.length >= 30);
  for (const line of lines) {
    const { text, rows } = JSON.parse(line) as { text: string; rows: string[] };
    const qr = encodeQr(text);
    assert.ok(qr, `encodes ${text.slice(0, 40)}`);
    assert.equal(qr.size, rows.length, text.slice(0, 40));
    assert.deepEqual(qr.rows, rows, text.slice(0, 40));
  }
});

test("masks and penalties as qrcodegen's (the crate's known answers)", () => {
  const text = readFileSync(new URL("../../../crates/tvpipe/tests/vectors/qr/symbols.txt", here), "utf8");
  let n = 0;
  for (const block of text.split(/\n(?=name = )/)) {
    const get = (k: string) => new RegExp(`^${k} = (.*)$`, "m").exec(block)?.[1];
    const hex = get("data");
    if (hex === undefined) continue;
    const data = Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
    const level = get("error") as "L" | "M";
    const version = Number(get("version"));
    const penalties = [...Array(8).keys()].map((m) => encodeQrAt(data, version, level, m).penalty).join(" ");
    assert.equal(penalties, get("penalties"), `${get("name")}: penalties`);
    const best = encodeQrAt(data, version, level);
    assert.equal(best.mask, Number(get("mask")), `${get("name")}: mask`);
    const matrix = block.split("matrix =\n")[1]!.split("\n").map((l) => l.trim()).filter((l) => /^[01]+$/.test(l));
    assert.deepEqual(best.rows, matrix, `${get("name")}: matrix`);
    n++;
  }
  assert.equal(n, 8);
});

test("too long", () => {
  assert.equal(encodeQr("w".repeat(2954)), null);
  assert.equal(encodeQr("x".repeat(426), 13), null);
  assert.equal(encodeQr("x".repeat(426))!.size, 4 * 16 + 17);
});
