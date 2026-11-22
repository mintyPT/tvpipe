/**
 * A live check of the app's local screens (not part of `npm test`):
 * `tvpipe game play` with Jinx, a headless Chrome as the window. The
 * launcher lists "This screen" (`local:this`) beside the TVs; Start with
 * it puts the TV page over the host page (table mode: ⋯ shows the host
 * page, "Back to the game" the picture again), the TV page joins through
 * tvpipe's relay with its screen key, a phone joins and shows up on it;
 * then Change screen moves the picture to the `browser` receiver (the
 * overlay goes, tvpipe casts) and back to this screen (tvpipe's cast
 * stops). Screenshots in /tmp/jinx-local-screens.
 *
 *   npm run build && node test/live/local-screens.ts
 *
 * Needs Chrome and tvpipe built (target/release, else target/debug, or
 * TVPIPE_BINARY).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { Browser, type Tab } from "./browser.ts";
import { tie } from "./tie.ts";

const here = new URL("../../", import.meta.url);
const repo = new URL("../../", here);
const exe = process.platform === "win32" ? "tvpipe.exe" : "tvpipe";
const binary =
  process.env["TVPIPE_BINARY"] ??
  ["release", "debug"].map((p) => fileURLToPath(new URL(`target/${p}/${exe}`, repo))).find((p) => existsSync(p));
if (!binary) throw new Error("build tvpipe first (cargo build -p tvpipe-cli)");
const out = "/tmp/jinx-local-screens";
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const proc = tie(spawn(binary, ["-v", "game", "play", fileURLToPath(here), "--window", "none", "--no-tunnel"], { stdio: ["ignore", "pipe", "pipe"] }));
const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
const tvpipeLog: string[] = [];
createInterface({ input: proc.stderr! }).on("line", (l) => {
  tvpipeLog.push(l);
  if (/ (WARN|ERROR) /.test(l)) log(`tvpipe: ${l.replace(/^\s*\S+ /, "")}`);
});
const start = await new Promise<string>((resolve, reject) => {
  createInterface({ input: proc.stdout! }).once("line", resolve);
  exited.then(() => reject(new Error(`tvpipe exited:\n${tvpipeLog.join("\n")}`)));
});

const browser = await Browser.launch();
const tabs: [string, Tab][] = [];
let failed = false;
const check = (ok: boolean, what: string) => {
  if (ok) log(`ok: ${what}`);
  else {
    failed = true;
    log(`PROBLEM: ${what}`);
  }
};
/** The TV page in the overlay (same origin): its text. */
const TV_TEXT = `document.querySelector(".tvpipe-table iframe")?.contentDocument?.body?.innerText ?? ""`;
const OVERLAY_SHOWN = `(() => { const t = document.querySelector(".tvpipe-table"); return !!t && getComputedStyle(t).visibility !== "hidden"; })()`;

try {
  const win = await browser.open(start, { width: 1280, height: 800 });
  tabs.push(["window", win]);
  await win.until(`!!document.querySelector('#devices .device[data-name="local:this"]') && !!document.querySelector('#devices .device[data-name="browser"]')`);
  const listed = await win.eval<string[]>(`[...document.querySelectorAll("#devices .device")].map((d) => d.dataset.name)`);
  log(`launcher lists: ${listed.join(", ")}`);
  check(listed.includes("local:this") && listed.includes("browser"), "the launcher offers This screen beside the TVs");
  check(!listed.includes("local:cable"), "no cable without a second screen (headless Chrome has one screen)");
  const label = await win.eval<string>(`document.querySelector('#devices .device[data-name="local:this"] .name').textContent`);
  check(label === "This screen", `its name: ${label}`);
  await win.screenshot(`${out}/launcher.png`);
  await win.eval(`document.querySelector('#devices .device[data-name="local:this"]').click(); true`);
  await win.until(`!document.getElementById("start").disabled`);
  await win.eval(`document.getElementById("start").click(); true`);
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.jinx`, 20_000);
  log("the host page runs the game");

  // The TV page over the host page, connected through tvpipe's relay.
  await win.until(OVERLAY_SHOWN, 10_000);
  const src = await win.eval<string>(`document.querySelector(".tvpipe-table iframe").getAttribute("src")`);
  check(/role=screen/.test(src) && src.startsWith("/"), `the overlay shows the TV page with the screen key (${src.replace(/k=[^&]+/, "k=…")})`);
  const code = await win.eval<string>(`jinx.party.code`);
  // Two screens on tvpipe's relay: the host page's preview and the overlay's TV page.
  await win.until(`jinx.party.relay.size >= 2 && (${TV_TEXT}).trim().length > 0`, 15_000);
  log(`the TV page in the overlay is in the room ${code} (${await win.eval<number>(`jinx.party.relay.size`)} connections on tvpipe's relay)`);
  const tvs = await win.eval<string>(`document.getElementById("tvs").innerText`);
  check(/This screen/.test(tvs) && /showing/.test(tvs), `the host page's TV list: ${tvs.replace(/\s+/g, " ")}`);
  check((await win.eval<number>(`jinx.party.tvDelay`)) === 0, "no TV delay for this screen");
  await win.screenshot(`${out}/table.png`);

  // A phone joins: its name is on the TV page.
  const join = await win.eval<string>(`jinx.party.links.join`);
  const phone = await browser.open(join, { width: 390, height: 844, mobile: true });
  tabs.push(["phone", phone]);
  await phone.until(`!!document.getElementById("name")`, 20_000);
  await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form.join button").click(); true`);
  await win.until(`jinx.party.players.some((p) => p.name === "Phil")`);
  await win.until(`(${TV_TEXT}).includes("Phil")`, 10_000);
  log("the phone joined; the TV page in the overlay shows Phil");
  await win.screenshot(`${out}/table-phil.png`);

  // ⋯: the host page; Back to the game: the picture.
  await win.eval(`document.querySelector(".tvpipe-table button").click(); true`);
  await win.until(`!(${OVERLAY_SHOWN})`);
  const back = await win.eval<boolean>(`[...document.querySelectorAll("button")].some((b) => b.textContent === "Back to the game" && !b.hidden)`);
  check(back, "⋯ shows the host page with Back to the game");
  await win.screenshot(`${out}/host-behind.png`);
  await win.eval(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Back to the game").click(); true`);
  await win.until(OVERLAY_SHOWN);
  log("Back to the game: the picture again");

  // Change screen: the browser receiver instead (tvpipe casts), then this screen again.
  await win.eval(`document.querySelector(".tvpipe-table button").click(); document.getElementById("change-tv").click(); true`);
  const PICKER = `document.querySelector("dialog.tvpipe-cast-picker iframe")?.contentDocument`;
  await win.until(`!!${PICKER}?.querySelector('#devices .device[data-name="browser"]')`, 15_000);
  const ticked = await win.eval<string[]>(`[...${PICKER}.querySelectorAll("#devices .device.selected")].map((d) => d.dataset.name)`);
  check(ticked.join() === "local:this", `the cast picker has This screen ticked (${ticked.join(", ")})`);
  await win.eval(`(() => { const d = ${PICKER}; d.querySelector('#devices .device[data-name="local:this"]').click(); d.querySelector('#devices .device[data-name="browser"]').click(); d.getElementById("start").click(); return true; })()`);
  await win.until(`!document.querySelector(".tvpipe-table")`, 15_000);
  await win.until(`/A browser tab|browser/.test(document.getElementById("tvs").innerText) && /showing|connected/.test(document.getElementById("tvs").innerText)`, 60_000);
  check(true, `the browser receiver casts, the overlay went: ${(await win.eval<string>(`document.getElementById("tvs").innerText`)).replace(/\s+/g, " ")}`);
  await win.until(`jinx.party.tvDelay > 0`, 20_000);
  log(`tvDelay follows the cast: ${await win.eval<number>(`jinx.party.tvDelay`)} ms`);
  await win.eval(`document.getElementById("change-tv").click(); true`);
  await win.until(`!!${PICKER}?.querySelector('#devices .device[data-name="local:this"]')`, 15_000);
  await win.eval(`(() => { const d = ${PICKER}; d.querySelector('#devices .device[data-name="browser"]').click(); d.querySelector('#devices .device[data-name="local:this"]').click(); d.getElementById("start").click(); return true; })()`);
  await win.until(OVERLAY_SHOWN, 15_000);
  await win.until(`!/A browser tab/.test(document.getElementById("tvs").innerText)`, 15_000);
  await win.until(`jinx.party.tvDelay === 0`, 15_000);
  check(true, `back on this screen, tvpipe's cast stopped: ${(await win.eval<string>(`document.getElementById("tvs").innerText`)).replace(/\s+/g, " ")}`);
  await win.until(`(${TV_TEXT}).includes("Phil")`, 10_000);
  await win.screenshot(`${out}/table-again.png`);

  // The TV on the cable (asked for directly: headless Chrome has one screen, so the launcher does not offer it):
  // a window of /_tvpipe/screen/ with the TV page; the overlay goes.
  await win.send("Browser.grantPermissions", { permissions: ["windowManagement"] }).catch(() => {});
  const cable = await win.eval<string>(`jinx.party.cast(["local:cable"]).then((s) => s.state)`);
  check(cable === "streaming", `cast to local:cable: ${cable}`);
  await win.until(`!document.querySelector(".tvpipe-table")`, 5000);
  const W = `window.open("", "tvpipe-screen")`;
  await win.until(`(() => { const w = ${W}; return w.location.pathname === "/_tvpipe/screen/" && /role=screen/.test(w.document.getElementById("tv")?.getAttribute("src") ?? ""); })()`, 10_000);
  await win.until(`jinx.party.relay.size >= 3`, 10_000);
  check(true, `the cable's window shows the TV page through tvpipe's relay (${await win.eval<number>(`jinx.party.relay.size`)} connections)`);
  const tvsCable = await win.eval<string>(`document.getElementById("tvs").innerText`);
  check(/The TV on the cable/.test(tvsCable), `the host page's TV list: ${tvsCable.replace(/\s+/g, " ")}`);
  await win.eval(`(globalThis.__cable = ${W}, jinx.party.stopCast().then(() => true))`);
  await win.until(`globalThis.__cable.closed`, 5000);
  log("stopCast closes the cable's window");
  await sleep(500);
  for (const [name, tab] of tabs) for (const e of tab.errors.splice(0)) check(false, `${name} console: ${e}`);
} catch (err) {
  failed = true;
  log(`FAILED: ${(err as Error).stack ?? err}`);
} finally {
  browser.close();
  proc.kill();
  await exited;
}
log(failed ? "local screens: FAILED" : `local screens: ok (screenshots in ${out})`);
process.exit(failed ? 1 : 0);
