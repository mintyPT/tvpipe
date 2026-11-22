/**
 * tvpipe.party's pages (docs/browser-party-design.md, "Pages on
 * tvpipe.party"): the launcher's answers per device, the join link's
 * parts, the window's framed page.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseJoin, phoneUrl } from "../src/join/join.ts";
import { detectDevice, screenOptions } from "../src/launcher-options.ts";
import { framedPath } from "../src/screen/screen.ts";
import type { Device } from "../src/tvpipe.ts";

const UA = {
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  winFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  android: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

const screens = (...names: string[]): Device[] => names.map((name) => ({ name, kind: "browser" }));

test("the device: iPadOS's desktop Safari by its touch points", () => {
  assert.deepEqual(detectDevice({ userAgent: UA.ipad, maxTouchPoints: 5 }, true), { touch: true, apple: "ipad", chromium: false });
  assert.deepEqual(detectDevice({ userAgent: UA.macSafari, maxTouchPoints: 0 }, false), { touch: false, apple: "mac", chromium: false });
  assert.deepEqual(detectDevice({ userAgent: UA.macChrome, maxTouchPoints: 0 }, false), { touch: false, apple: "mac", chromium: true });
  assert.deepEqual(detectDevice({ userAgent: UA.iphone, maxTouchPoints: 5 }, true), { touch: true, apple: "iphone", chromium: false });
  assert.deepEqual(detectDevice({ userAgent: UA.winFirefox, maxTouchPoints: 0 }, false), { touch: false, apple: null, chromium: false });
  assert.deepEqual(detectDevice({ userAgent: UA.android, maxTouchPoints: 5 }, true), { touch: true, apple: null, chromium: false });
});

test("the answers: an iPad's own screen first, mirroring next, another screen last", () => {
  const d = detectDevice({ userAgent: UA.ipad, maxTouchPoints: 5 }, true);
  const o = screenOptions(screens("this", "none"), d);
  assert.deepEqual(
    o.map((x) => [x.id, x.device, x.label]),
    [
      ["this", "this", "This iPad"],
      ["mirror", "this", "Apple TV, by mirroring"],
      ["none", "none", "Another screen"],
    ],
  );
  assert.match(o[1]!.steps!.join(" "), /Control Center.*Screen Mirroring/);
});

test("the answers: the TV on the cable first in Chrome with a second screen", () => {
  const d = detectDevice({ userAgent: UA.macChrome, maxTouchPoints: 0 }, false);
  const o = screenOptions(screens("this", "cable", "none"), d);
  assert.deepEqual(
    o.map((x) => x.id),
    ["cable", "this", "mirror", "none"],
  );
  assert.equal(o[1]!.label, "This screen");
  assert.match(o[2]!.steps!.join(" "), /menu bar/);
});

test("the answers: this screen, then a second window, on a computer without the API", () => {
  const d = detectDevice({ userAgent: UA.winFirefox, maxTouchPoints: 0 }, false);
  const o = screenOptions(screens("this", "window", "none"), d);
  assert.deepEqual(
    o.map((x) => [x.id, x.label]),
    [
      ["this", "This screen"],
      ["window", "A second window"],
      ["none", "Another screen"],
    ],
  );
  // Only what the hub offers; TVs of the app are no answers here.
  assert.deepEqual(screenOptions([{ name: "Living Room", kind: "airplay" }], d), []);
});

test("the join link: code, key and the extra pairs; nothing else", () => {
  assert.deepEqual(parseJoin("?r=bcdf", "#k=AbCdEfGhIjKlMnOp&p=tok_123"), { code: "BCDF", key: "AbCdEfGhIjKlMnOp", extra: "&p=tok_123" });
  assert.deepEqual(parseJoin("?r=BCDF", "#k=AbCdEfGhIjKlMnOp&X=1&p=a%20b"), { code: "BCDF", key: "AbCdEfGhIjKlMnOp", extra: "" });
  assert.equal(parseJoin("?r=BCDF", ""), null);
  assert.equal(parseJoin("", "#k=AbCdEfGhIjKlMnOp"), null);
  assert.equal(parseJoin("?r=B1", "#k=AbCdEfGhIjKlMnOp"), null);
  assert.equal(parseJoin("?r=BCDF", "#k=short"), null);
});

test("the join link: the phone page of this site only", () => {
  assert.equal(phoneUrl("/g/drawbluff/0.4.0/phone/index.html", "BCDF", "AbCdEfGhIjKlMnOp", "&p=t"), "/g/drawbluff/0.4.0/phone/index.html?r=BCDF#k=AbCdEfGhIjKlMnOp&p=t");
  assert.equal(phoneUrl("/g/x/1/phone/?old=1#y", "BCDF", "AbCdEfGhIjKlMnOp", ""), "/g/x/1/phone/?r=BCDF#k=AbCdEfGhIjKlMnOp");
  assert.equal(phoneUrl("https://evil.example/", "BCDF", "AbCdEfGhIjKlMnOp", ""), null);
  assert.equal(phoneUrl("//evil.example/", "BCDF", "AbCdEfGhIjKlMnOp", ""), null);
  assert.equal(phoneUrl("/\\evil.example/", "BCDF", "AbCdEfGhIjKlMnOp", ""), null);
});

test("the window: a path of this site, with its fragment", () => {
  const o = "https://tvpipe.party";
  assert.equal(framedPath("/g/jinx/0.3.1/screen/index.html#r=BCDF&k=x&role=screen", o), "/g/jinx/0.3.1/screen/index.html#r=BCDF&k=x&role=screen");
  assert.equal(framedPath("https://tvpipe.party/x", o), null);
  assert.equal(framedPath("//evil.example/x", o), null);
  assert.equal(framedPath("/\\evil.example", o), null);
  assert.equal(framedPath("javascript:alert(1)", o), null);
  assert.equal(framedPath(null, o), null);
});
