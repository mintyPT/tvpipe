/**
 * Screenshots of the look (test/preview/index.html) with headless Chrome
 * (snug's DevTools driver): the TV at 1280×720, a phone at 390×844, the
 * tape, the prop sheet, the intertitle. Not part of `npm test`.
 *
 *   node test/preview/fixture.ts 5 1      # the sample, once
 *   node test/preview/shots.ts [DIR=/tmp/pinch-look] [sample=5-1]
 */

import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../snug/test/live/browser.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.argv[2] ?? "/tmp/pinch-look";
const sample = process.argv[3] ?? "5-1";
mkdirSync(out, { recursive: true });

const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2",
};
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!)).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, path);
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/test/preview/index.html?sample=${sample}`;

const shots: [string, string, { width: number; height: number; mobile?: boolean }][] = [
  ["tv", "view=tv", { width: 1280, height: 720 }],
  ["phone", "view=phone", { width: 390, height: 844, mobile: true }],
  ["bench-phone", "view=phone&bench=1", { width: 390, height: 844, mobile: true }],
  ["bench-tv", "view=tv&bench=1", { width: 1280, height: 720 }],
  ["phone-lit", "view=phone&scene=lit", { width: 390, height: 844, mobile: true }],
  ["phone-held", "view=phone&held=1&public=1", { width: 390, height: 844, mobile: true }],
  ["phone-wide", "view=phone&across=24&public=0", { width: 390, height: 844, mobile: true }],
  ["phone-memory", "view=phone&at=sec&across=18&public=0", { width: 390, height: 844, mobile: true }],
  ["tape", "view=tape", { width: 1280, height: 720 }],
  ["tape-zoom", "view=tape&zoom=1", { width: 1280, height: 720 }],
  ["props", "view=props", { width: 1280, height: 900 }],
  ["card", "view=card", { width: 1280, height: 720 }],
  ["card-phone", "view=card", { width: 390, height: 844, mobile: true }],
];
const only = process.argv[4]?.split(",");
const browser = await Browser.launch();
try {
  for (const [name, query, size] of shots) {
    if (only && !only.includes(name)) continue;
    const tab = await browser.open(`${base}&${query}`, size);
    await tab.watch();
    try {
      await tab.until("document.documentElement.dataset.ready === '1'", 20000);
      await new Promise((r) => setTimeout(r, 300));
      const file = join(out, `${name}.png`);
      await tab.screenshot(file);
      const bench = await tab.eval<string | undefined>("document.documentElement.dataset.bench");
      console.log(`${file}${bench ? `  ${bench}` : ""}${tab.errors.length ? `  errors: ${tab.errors.join(" | ")}` : ""}`);
    } catch (e) {
      console.log(`${name}: ${(e as Error).message} ${tab.errors.join(" | ")}`);
    }
    tab.close();
  }
} finally {
  browser.close();
  server.close();
}
