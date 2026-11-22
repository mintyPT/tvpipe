// Screenshots of the TV harness in headless Chrome, in real time (not shipped).
//
//   python3 -m http.server -d . 8791 --bind 127.0.0.1   (the repository's root)
//   node games/jinx/design/harness/shoot.mjs OUTDIR name:query:ms[,ms…] …
//
// Each shot opens http://127.0.0.1:8791/games/jinx/design/harness/?QUERY in a fresh tab,
// waits ms (real time) and saves OUTDIR/name-ms.png (1280×720). Console
// errors and exceptions are printed. Node built-ins only (global WebSocket).

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.HARNESS ?? "http://127.0.0.1:8791/games/jinx/design/harness/";
const [outDir, ...specs] = process.argv.slice(2);
if (!outDir || specs.length === 0) {
  console.error("usage: shoot.mjs OUTDIR name:query:ms[,ms…] …");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "jinx-chrome-"));
// --remote-debugging-pipe (fds 3 and 4, otherwise unused): Chrome quits when this process ends, however it ends.
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--window-size=1280,720", "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
process.on("exit", () => {
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome still writing on its way out: a stray temp dir.
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let version;
for (let i = 0; i < 50 && !version; i++) {
  await sleep(200);
  try {
    version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  } catch {}
}
if (!version) throw new Error("chrome did not start");

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const waiting = new Map();
const listeners = new Set();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && waiting.has(m.id)) {
    const { resolve, reject } = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
  } else for (const l of listeners) l(m);
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const i = ++id;
    waiting.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });

let problems = 0;
for (const spec of specs) {
  const [name, query, times] = spec.split(":");
  const ms = (times ?? "2000").split(",").map(Number).sort((a, b) => a - b);
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const log = (m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.exceptionThrown") {
      problems++;
      console.log(`[${name}] exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    }
    if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) {
      problems++;
      console.log(`[${name}] console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    }
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      problems++;
      console.log(`[${name}] ${m.params.entry.source}: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
    }
  };
  listeners.add(log);
  await send("Runtime.enable", {}, sessionId);
  await send("Log.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId);
  const t0 = Date.now();
  await send("Page.navigate", { url: BASE + "?" + query }, sessionId);
  for (const t of ms) {
    await sleep(Math.max(0, t0 + t - Date.now()));
    const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    const file = join(outDir, `${name}-${t}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(file);
  }
  listeners.delete(log);
  await send("Target.closeTarget", { targetId });
}
ws.close();
chrome.kill();
if (problems) console.log(`${problems} problem(s)`);
