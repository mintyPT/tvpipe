/**
 * Frame times of the phone's heist (and the TV's) from the pages' demo
 * modes in headless Chrome at 3× device pixels, with the CPU slowed like a
 * phone's, and the hottest functions from the CPU profiler. Not part of
 * `npm test`.
 *
 *   npm run build && node test/live/perf.ts [--slow 4] [--scene demo=guard&scene=hold] [--secs 4]
 */

import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../snug/test/live/browser.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "dist");
const lib = join(root, "..", "..", "crates", "tvpipe", "src", "playshare", "web", "lib");
const args = process.argv.slice(2);
const flag = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i < 0 ? def : (args[i + 1] ?? def);
};
const slow = Number(flag("--slow", "4"));
const secs = Number(flag("--secs", "4"));
const scenes = flag("--scene", "phone/index.html?demo=guard&scene=walk,phone/index.html?demo=thief&scene=walk,phone/index.html?demo=guard&scene=hold").split(",");

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!)).replace(/^(\.\.[/\\])+/, "");
  const base = path.startsWith("/_tvpipe/lib/") ? lib : dist;
  const file = join(base, path.startsWith("/_tvpipe/lib/") ? path.slice("/_tvpipe/lib/".length) : path);
  if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const browser = await Browser.launch();
try {
  for (const scene of scenes) {
    const tv = scene.startsWith("screen/");
    const tab = await browser.open(`http://127.0.0.1:${port}/${scene}`, tv ? { width: 1920, height: 1080 } : { width: 390, height: 844, mobile: true });
    await tab.send("Emulation.setDeviceMetricsOverride", tv ? { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false } : { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await new Promise((r) => setTimeout(r, 2500));
    await tab.send("Emulation.setCPUThrottlingRate", { rate: slow });
    await tab.send("Profiler.enable");
    await tab.send("Profiler.setSamplingInterval", { interval: 200 });
    await tab.eval(`(globalThis.__ft = [], (function f(t){ __ft.push(t); requestAnimationFrame(f); })(performance.now()), 1)`);
    await tab.send("Profiler.start");
    // Walk about: a tap every 1.2 s, round the screen.
    const spots: [number, number][] = [[0.25, 0.3], [0.75, 0.65], [0.3, 0.7], [0.7, 0.3]];
    for (let k = 0; k * 1200 < secs * 1000; k++) {
      const [fx, fy] = spots[k % spots.length]!;
      if (!tv) {
        const at = { x: 390 * fx, y: 844 * fy };
        await Promise.all([
          tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] }),
          tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
        ]);
      }
      await new Promise((r) => setTimeout(r, Math.min(1200, secs * 1000 - k * 1200)));
    }
    const { profile } = await tab.send("Profiler.stop");
    const ft = await tab.eval<number[]>(`__ft`);
    await tab.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const d = ft.slice(1).map((t, i) => t - ft[i]!).sort((a, b) => a - b);
    const q = (p: number) => d[Math.min(d.length - 1, Math.floor(d.length * p))]?.toFixed(1);
    console.log(`\n${scene}  (cpu ×${slow}): ${(d.length / secs).toFixed(1)} fps, frame ms p50 ${q(0.5)} p90 ${q(0.9)} max ${q(1)}`);
    // Self time per function.
    const self = new Map<string, number>();
    const dt = profile.timeDeltas as number[];
    const byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
    const count = new Map<number, number>();
    for (const s of profile.samples as number[]) count.set(s, (count.get(s) ?? 0) + 1);
    let total = 0;
    for (const [id, c] of count) {
      const n = byId.get(id);
      const cf = n.callFrame;
      const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").slice(-1)[0]}:${cf.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + c);
      total += c;
    }
    void dt;
    for (const [k, c] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${((100 * c) / total).toFixed(1).padStart(5)}%  ${k}`);
    writeFileSync(`/tmp/pinch-perf/${scene.replace(/[^a-z0-9]+/gi, "_")}.cpuprofile`, JSON.stringify(profile));
    await tab.screenshot(`/tmp/pinch-perf/${scene.replace(/[^a-z0-9]+/gi, "_")}.png`);
  }
} finally {
  browser.close();
  server.close();
}
