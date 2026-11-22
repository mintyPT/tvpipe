/**
 * Opens tvpipe.party's web pages in headless Chrome and reports what
 * they logged as errors, with a screenshot each (not part of `npm test`):
 *
 *   npm run dev                                  # in another terminal
 *   node scripts/check-pages.ts [BASE] [--out DIR]
 *
 * BASE defaults to http://localhost:8787 (the Worker takes that origin as
 * its own: `--local-upstream`), DIR to /tmp/tvpipe-pages.
 * Chrome is driven over the DevTools protocol by games/drawbluff's
 * helper (no dependencies); `CHROME` names another binary. Exits 1 when
 * a page logged an error or did not show what it should.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { Browser, type Tab } from "../../../games/drawbluff/test/live/browser.ts";

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const dir = outAt >= 0 ? args[outAt + 1]! : "/tmp/tvpipe-pages";
const base = (args.find((a, i) => !a.startsWith("--") && (outAt < 0 || i !== outAt + 1)) ?? "http://localhost:8787").replace(/\/$/, "");
mkdirSync(dir, { recursive: true });

const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

interface Check {
  name: string;
  path: string;
  view: { width: number; height: number; mobile?: boolean };
  ua?: string;
  /** Session storage to set on the origin first. */
  session?: unknown;
  /** Must become true in the page. */
  until: string;
  /** Answers for the API instead of the Worker's (`*` wildcards). */
  serve?: { pattern: string; body: unknown };
  /** Errors that are expected (regexes on the message). */
  expect?: RegExp[];
}

const game = { name: "drawbluff", release: "" };
const DESK = { width: 1280, height: 860 };
const PAD = { width: 1024, height: 1366, mobile: true };
const PHONE = { width: 390, height: 844, mobile: true };
const TV = { width: 1280, height: 720 };

const index = (await (await fetch(`${base}/g/index.json`)).json()) as { games: { name: string; release: string; pages: { tv: string } }[] };
const first = index.games.find((g) => g.name === game.name) ?? index.games[0];
if (!first) throw new Error("/g/index.json lists no games");
game.name = first.name;
game.release = first.release;

const checks: Check[] = [
  // Every game has Play now, to its launcher.
  {
    name: "games-desktop",
    path: "/games/",
    view: DESK,
    until: `document.querySelectorAll("article.gm").length === ${index.games.length} && [...document.querySelectorAll("article.gm")].every((g) => new URL(g.querySelector("a[data-play]").href).pathname === "/games/" + g.id + "/launcher/")`,
  },
  { name: "games-jinx", path: "/games/jinx/", view: DESK, until: `document.querySelector('a[data-play="jinx"]')?.textContent === "Play now"` },
  { name: "games-ipad", path: "/games/", view: PAD, ua: IPAD, until: `!!document.querySelector(".home-hint")` },
  {
    name: "games-switch",
    path: `/games/?switch&current=${game.name}`,
    view: { width: 1000, height: 760 },
    until: `document.querySelector("#${game.name} .now")?.textContent === "Playing" && !!document.querySelector(".gh.pick button") && getComputedStyle(document.querySelector("header.top")).display === "none"`,
  },
  {
    name: "launcher-desktop",
    path: `/games/${game.name}/launcher/`,
    view: DESK,
    until: `document.querySelectorAll("#devices .device").length > 1 && !document.getElementById("web-game").hidden && document.getElementById("web-title").textContent !== "" && !document.getElementById("web-cover").hidden && JSON.parse(sessionStorage.getItem("tvpipe-web")).game.name === ${JSON.stringify(game.name)}`,
  },
  {
    name: "launcher-desktop-app",
    path: `/games/${game.name}/launcher/`,
    view: DESK,
    until: `(document.querySelector('#devices .device[data-name="app"]')?.click(), !document.getElementById("app-way").hidden && document.getElementById("start").hidden && document.querySelector("#app-commands").innerText.includes("tvpipe game play ${game.name}") && document.querySelectorAll("#app-commands .cmd").length === 2)`,
  },
  { name: "launcher-ipad", path: `/games/${game.name}/launcher/`, view: PAD, ua: IPAD, until: `document.querySelector('#devices .device[data-name="mirror"]') !== null && document.querySelector("#devices .device.selected")?.dataset.name === "this"` },
  { name: "launcher-ipad-mirror", path: `/games/${game.name}/launcher/`, view: PAD, ua: IPAD, until: `(document.querySelector('#devices .device[data-name="mirror"]')?.click(), document.querySelector(".steps") !== null)` },
  {
    name: "launcher-ipad-app",
    path: `/games/${game.name}/launcher/`,
    view: PAD,
    ua: IPAD,
    until: `(document.querySelector('#devices .device[data-name="app"]')?.click(), !document.getElementById("app-way").hidden && document.getElementById("app-intro").textContent.startsWith("On a Mac, Windows or Linux") && document.querySelectorAll("#app-commands .cmd").length === 3)`,
  },
  { name: "join-unknown", path: "/r/?r=BCDF#k=AbCdEfGhIjKlMnOpQr", view: PHONE, ua: IPHONE, until: `document.body.dataset.state === "bad"`, expect: [/api\/rooms\/BCDF/] },
  {
    name: "join-waiting",
    path: "/r/?r=BCDF#k=AbCdEfGhIjKlMnOpQr",
    view: PHONE,
    ua: IPHONE,
    serve: { pattern: "*/api/rooms/BCDF", body: { code: "BCDF", host: false, game: null } },
    until: `document.body.dataset.state === "wait"`,
  },
  {
    name: "join-go",
    path: "/r/?r=bcdf#k=AbCdEfGhIjKlMnOpQr&p=tok_1",
    view: PHONE,
    ua: IPHONE,
    serve: { pattern: "*/api/rooms/BCDF", body: { code: "BCDF", host: true, game: { name: "x", title: "X", release: "1", phone: "/offline.html" } } },
    until: `location.pathname === "/offline" && location.search === "?r=BCDF" && location.hash === "#k=AbCdEfGhIjKlMnOpQr&p=tok_1"`,
  },
  { name: "join-broken", path: "/r/", view: PHONE, ua: IPHONE, until: `document.body.dataset.state === "bad"` },
  { name: "tv-code", path: "/tv/", view: TV, until: `document.body.dataset.state === "code"` },
  { name: "tv-unknown", path: "/tv/#r=BCDF", view: TV, until: `document.body.dataset.state === "code" && !document.getElementById("code-error").hidden`, expect: [/api\/rooms\/BCDF/] },
  {
    name: "tv-waiting",
    path: "/tv/#r=BCDF",
    view: TV,
    serve: { pattern: "*/api/rooms/BCDF", body: { code: "BCDF", host: false, game: null } },
    until: `document.body.dataset.state === "ask" && document.getElementById("ask-title").textContent === "Waiting for the game"`,
  },
  { name: "screen-window", path: `/_tvpipe/screen/?u=${encodeURIComponent(first.pages.tv)}`, view: TV, until: `!document.getElementById("bar").hidden && document.getElementById("tv").src !== "" && document.getElementById("bad").hidden`, expect: [/./] },
  { name: "screen-bad", path: "/_tvpipe/screen/?u=https%3A%2F%2Fexample.com%2F", view: TV, until: `!document.getElementById("bad").hidden` },
  { name: "offline", path: "/offline", view: PHONE, until: `document.querySelector("button") !== null` },
  { name: "manual", path: "/manual/in-the-browser/", view: DESK, until: `document.querySelector("h1") !== null` },
  { name: "home", path: "/", view: DESK, until: `!!document.querySelector('main a[href$="games/"]') && ![...document.querySelectorAll("a[href]")].some((a) => new URL(a.href).pathname === "/play/")` },
];

async function prepare(tab: Tab, c: Check): Promise<void> {
  if (c.ua) await tab.send("Emulation.setUserAgentOverride", { userAgent: c.ua, platform: c.ua.includes("iPhone") ? "iPhone" : "MacIntel" });
  if (c.serve) await tab.serve(c.serve.pattern, JSON.stringify(c.serve.body), "application/json");
  if (c.session !== undefined) {
    await tab.send("Page.navigate", { url: `${base}/offline` });
    await tab.until(`document.readyState === "complete"`);
    await tab.eval(`sessionStorage.setItem("tvpipe-web", ${JSON.stringify(JSON.stringify(c.session))}); true`);
  }
}

const browser = await Browser.launch();
let failed = 0;
try {
  for (const c of checks) {
    const tab = await browser.open("about:blank", c.view);
    await prepare(tab, c);
    tab.errors.length = 0;
    await tab.send("Page.navigate", { url: base + c.path });
    let shown = true;
    try {
      await tab.until(c.until, 10_000);
    } catch {
      shown = false;
    }
    // Late errors (a fetch after the first paint) still count.
    await new Promise((r) => setTimeout(r, 800));
    const shot = join(dir, `${c.name}.png`);
    await tab.screenshot(shot);
    const errors = tab.errors.filter((e) => !(c.expect ?? []).some((x) => x.test(e)));
    const ok = shown && errors.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${c.name.padEnd(22)} ${c.path}  ${shot}${shown ? "" : "\n     did not show: " + c.until}`);
    for (const e of errors) console.log(`     ${e}`);
    for (const e of tab.errors.filter((e) => !errors.includes(e))) console.log(`     (expected) ${e.slice(0, 160)}`);
    tab.close();
  }
  // The service worker: /games/ registers it and it takes the page.
  const tab = await browser.open(`${base}/games/`, DESK);
  let sw = "ok  ";
  try {
    await tab.until(`navigator.serviceWorker.getRegistration().then((r) => !!r?.active)`, 10_000);
    await tab.eval(`location.reload(); true`);
    await tab.until(`!!navigator.serviceWorker.controller && document.querySelectorAll("article.gm").length > 0`, 10_000);
  } catch (err) {
    sw = "FAIL";
    failed++;
    console.log(`     ${(err as Error).message}`);
  }
  console.log(`${sw} ${"service-worker".padEnd(22)} /sw.js`);
  tab.close();
} finally {
  browser.close();
}
process.exit(failed > 0 ? 1 : 0);
