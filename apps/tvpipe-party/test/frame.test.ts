// The frame page (/p, docs/short-links.md): the Worker's link to it
// (framePath) and the page's reading of it (site/static/frame.js),
// against known answers and against each other.

import assert from "node:assert/strict";
import { test } from "node:test";
import { framePath } from "../src/links.ts";

type Target = { origin: string; src: string; hash: string } | null;
// The page's script, as it is served (plain JavaScript, no types).
const page: string = "../../../site/static/frame.js";
const { frameTarget } = (await import(page)) as { frameTarget: (hash: unknown) => Target };

const KEY = "AbCdEfGhIjKlMnOp_-12";

test("framePath: known answers", () => {
  assert.equal(
    framePath(`https://some-random-words.trycloudflare.com/?r=BCDF#k=${KEY}`),
    `/p#c=some-random-words&r=BCDF&k=${KEY}`,
  );
  assert.equal(
    framePath(`https://65b3d1e2edd55529.baqlo7vg7agz.opentunnel.xyz/?r=QWERTY#k=${KEY}`),
    `/p#o=65b3d1e2edd55529.baqlo7vg7agz&r=QWERTY&k=${KEY}`,
  );
  for (const bad of [
    `https://evil.com/?r=BCDF#k=${KEY}`,
    `https://x.opentunnel.xyz/?r=BCDF#k=${KEY}`,
    `https://a.b.trycloudflare.com/?r=BCDF#k=${KEY}`,
    `https://x.trycloudflare.com/?r=BCDF#k=${KEY}&p=abc`,
    "",
  ]) {
    assert.equal(framePath(bad), null, bad);
  }
});

test("frameTarget: known answers", () => {
  assert.deepEqual(frameTarget(`#c=some-random-words&r=BCDF&k=${KEY}`), {
    origin: "https://some-random-words.trycloudflare.com",
    src: `https://some-random-words.trycloudflare.com/?r=BCDF#k=${KEY}`,
    hash: `c=some-random-words&r=BCDF&k=${KEY}`,
  });
  // Any order; without the `#`.
  assert.deepEqual(frameTarget(`k=${KEY}&r=BCDF&o=abc.def`), {
    origin: "https://abc.def.opentunnel.xyz",
    src: `https://abc.def.opentunnel.xyz/?r=BCDF#k=${KEY}`,
    hash: `o=abc.def&r=BCDF&k=${KEY}`,
  });
  // A rejoin link: the token goes to the page, not into the address bar.
  assert.deepEqual(frameTarget(`#c=x&r=BCDF&k=${KEY}&p=Tok_en-1`), {
    origin: "https://x.trycloudflare.com",
    src: `https://x.trycloudflare.com/?r=BCDF#k=${KEY}&p=Tok_en-1`,
    hash: `c=x&r=BCDF&k=${KEY}`,
  });
});

test("frameTarget: nothing else", () => {
  for (const bad of [
    "",
    "#",
    `#r=BCDF&k=${KEY}`,
    `#c=x&k=${KEY}`,
    `#c=x&r=BCDF`,
    `#c=x&o=a.b&r=BCDF&k=${KEY}`,
    `#c=x&c=y&r=BCDF&k=${KEY}`,
    `#c=x&r=BCDF&r=GHJK&k=${KEY}`,
    `#c=x&r=BCDF&k=${KEY}&p=a&p=b`,
    `#c=a.b&r=BCDF&k=${KEY}`,
    `#o=a&r=BCDF&k=${KEY}`,
    `#o=a.b.c&r=BCDF&k=${KEY}`,
    `#c=evil.com/x&r=BCDF&k=${KEY}`,
    `#c=X&r=BCDF&k=${KEY}`,
    `#c=-x&r=BCDF&k=${KEY}`,
    `#c=x-&r=BCDF&k=${KEY}`,
    `#c=${"a".repeat(64)}&r=BCDF&k=${KEY}`,
    `#c=x%2fevil&r=BCDF&k=${KEY}`,
    `#c=x&r=bcdf&k=${KEY}`,
    `#c=x&r=BCD&k=${KEY}`,
    `#c=x&r=BCDF&k=short`,
    `#c=x&r=BCDF&k=${"k".repeat(65)}`,
    `#c=x&r=BCDF&k=${KEY}&P=x`,
    `#c=x&r=BCDF&k=${KEY}&p=`,
    `#c=x&r=BCDF&k=${KEY}&p=a/b`,
    `#c=x&r=BCDF&k=${KEY}&p=a#b`,
    `#c=x&r=BCDF&k=${KEY}&&`,
    `#c=x&r=BCDF&k=${KEY}&p`,
    `#c=x&r=BCDF&k=${KEY}&=x`,
    `#c=x&r=BCDF&k=${KEY}&p=${"a".repeat(600)}`,
  ]) {
    assert.equal(frameTarget(bad), null, bad);
  }
  assert.equal(frameTarget(null), null);
  assert.equal(frameTarget(42), null);
});

test("the Worker's links lead the page to the join link", () => {
  for (const url of [
    `https://some-random-words.trycloudflare.com/?r=BCDF#k=${KEY}`,
    `https://65b3d1e2edd55529.baqlo7vg7agz.opentunnel.xyz/?r=BCDF#k=${KEY}`,
    `https://a.b.opentunnel.xyz/?r=ABCDEFGH#k=${"x".repeat(64)}`,
    `https://${"a".repeat(63)}.trycloudflare.com/?r=QWERTY#k=${"0".repeat(16)}`,
  ]) {
    const path = framePath(url) ?? "";
    assert.ok(path.startsWith("/p#"), url);
    const t = frameTarget(path.slice("/p".length));
    assert.equal(t?.src, url);
    assert.equal(`/p#${t?.hash}`, path);
  }
});
