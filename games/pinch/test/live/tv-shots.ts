/**
 * Screenshots of the TV page in every phase at 1280×720 with headless
 * Chrome (snug's DevTools driver), from the page's demo mode
 * (`screen/index.html?demo=PHASE`, screen/demo.js): no game runs. Each
 * shot is checked for words cut off (`data-fit` boxes that still
 * overflow), text or pictures under the join badge (the demo puts a
 * stand-in where tvpipe's badge goes) and page errors. Not part of
 * `npm test`.
 *
 *   npm run build                          # dist/game/*.js (the rules the page imports)
 *   node test/live/tv-shots.ts [DIR=/tmp/pinch-tv] [only=heist,tape]
 *
 * Serves the page from the sources (screen/, phone/), the compiled rules
 * from dist/game/ and the library from tvpipe's copy
 * (crates/tvpipe/src/playshare/web/lib/).
 */

import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../snug/test/live/browser.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lib = join(root, "..", "..", "crates", "tvpipe", "src", "playshare", "web", "lib");
const out = process.argv[2] ?? "/tmp/pinch-tv";
const only = process.argv[3]?.split(",");
mkdirSync(out, { recursive: true });
if (!existsSync(join(root, "dist", "game", "protocol.js"))) {
  console.error("no dist/game: run npm run build first");
  process.exit(1);
}

const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2",
};
/** URL path → file: /game/ from dist, /_tvpipe/lib/ from tvpipe's copy, the rest from the sources. */
function resolve(path: string): string | null {
  const p = normalize(path).replace(/^(\.\.[/\\])+/, "");
  if (p.startsWith("/_tvpipe/lib/")) return join(lib, p.slice("/_tvpipe/lib/".length));
  if (p.startsWith("/game/")) return join(root, "dist", p);
  if (p.startsWith("/screen/") || p.startsWith("/phone/")) return join(root, p);
  return null;
}
const server = createServer((req, res) => {
  const file = resolve(decodeURIComponent((req.url ?? "/").split("?")[0]!));
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/screen/index.html`;

const shots: [string, string, number?][] = [
  ["lobby", "demo=lobby"],
  ["lobby-empty", "demo=lobby&empty=1"],
  ["lobby-8-de", "demo=lobby&players=8&lang=de"],
  ["card-round", "demo=briefing&card=1"],
  ["briefing", "demo=briefing"],
  ["heist", "demo=heist"],
  ["heist-held", "demo=held"],
  ["heist-alarm", "demo=alarm"],
  ["heist-8-de", "demo=heist&players=8&lang=de&seed=2"],
  ["heist-3", "demo=heist&players=3"],
  ["outcome-pinched", "demo=outcome-pinched"],
  ["outcome-gotAway", "demo=outcome-gotAway"],
  ["outcome-police-de", "demo=outcome-police&lang=de"],
  ["outcome-left", "demo=outcome-left"],
  ["tape", "demo=tape&t=4"],
  ["tape-moment", "demo=tape&t=30", 2600],
  ["tape-end", "demo=tape&t=400"],
  ["card-tape", "demo=tape&card=1"],
  ["scores", "demo=scores"],
  ["scores-8-de", "demo=scores&players=8&lang=de"],
  ["final", "demo=final"],
  ["final-8", "demo=final&players=8"],
  ["final-3-de", "demo=final&players=3&lang=de"],
];

const CHECK = `(() => {
  const problems = [];
  const badge = document.getElementById("demo-badge")?.getBoundingClientRect();
  for (const el of document.querySelectorAll("[data-fit]")) {
    if (el.closest(".leaving") || el.hidden || !el.offsetParent) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
    if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 3 + fs * 0.35) problems.push("cut: " + el.className + " «" + el.textContent.slice(0, 60) + "»");
  }
  if (badge) {
    const under = (r) => r.width > 0 && r.height > 0 && r.left < badge.right && r.right > badge.left && r.top < badge.bottom && r.bottom > badge.top;
    const walker = document.createTreeWalker(document.getElementById("stage"), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || n.parentElement.closest(".leaving")) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (under(r)) { problems.push("under the badge: «" + n.textContent.trim().slice(0, 40) + "»"); break; }
    }
    for (const c of document.querySelectorAll("#stage canvas")) if (!c.closest(".leaving") && under(c.getBoundingClientRect()) && !c.closest(".items")) problems.push("canvas under the badge: " + (c.className || c.parentElement.className));
  }
  return problems;
})()`;

const browser = await Browser.launch();
let bad = 0;
try {
  for (const [name, query, wait] of shots) {
    if (only && !only.includes(name)) continue;
    const tab = await browser.open(`${base}?${query}`, { width: 1280, height: 720 });
    try {
      await tab.until("document.documentElement.dataset.ready === '1'", 20000);
    } catch (e) {
      console.log(`✗ ${name}: never ready ${tab.errors.join("\n    ")}`);
      bad++;
      tab.close();
      continue;
    }
    await tab.eval("document.fonts.ready.then(() => true)");
    await new Promise((r) => setTimeout(r, wait ?? 1400));
    const file = join(out, `${name}.png`);
    await tab.screenshot(file);
    const problems = await tab.eval<string[]>(CHECK);
    const errors = tab.errors.filter((e) => !/favicon/.test(e));
    if (problems.length || errors.length) bad++;
    console.log(`${problems.length || errors.length ? "✗" : "✓"} ${file}${[...problems, ...errors].map((p) => `\n    ${p}`).join("")}`);
    tab.close();
  }
} finally {
  browser.close();
  server.close();
}
process.exit(bad ? 1 : 0);
