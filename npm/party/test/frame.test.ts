import assert from "node:assert/strict";
import { test } from "node:test";

import { announceToFrame, FRAME_MESSAGE } from "../src/frame.ts";

test("a page in another site's frame tells it its title and colour", async () => {
  const g = globalThis as any;
  const saved = { window: g.window, document: g.document, MutationObserver: g.MutationObserver };
  const posted: { msg: any; target: string }[] = [];
  const parent = {
    get location(): never {
      throw new Error("cross-origin");
    },
    postMessage: (msg: unknown, target: string) => posted.push({ msg, target }),
  };
  let observed: (() => void) | null = null;
  const meta = { getAttribute: (n: string) => (n === "content" ? "#1b2430" : null) };
  g.window = { parent, addEventListener: () => {} };
  g.document = {
    title: "Garble",
    head: {},
    documentElement: {},
    body: {},
    querySelector: (s: string) => (s === 'meta[name="theme-color"]' ? meta : null),
  };
  g.MutationObserver = class {
    constructor(cb: () => void) {
      observed = cb;
    }
    observe(): void {}
  };
  try {
    announceToFrame();
    assert.deepEqual(posted, [{ msg: { type: FRAME_MESSAGE, title: "Garble", theme: "#1b2430" }, target: "*" }]);
    // Only once per page.
    announceToFrame();
    assert.equal(posted.length, 1);
    // A new title goes out; the same one does not again.
    g.document.title = "Garble · Round 2";
    observed!();
    observed!();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(posted.length, 2);
    assert.equal(posted[1]!.msg.title, "Garble · Round 2");
    observed!();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(posted.length, 2);
  } finally {
    Object.assign(g, saved);
  }
});
