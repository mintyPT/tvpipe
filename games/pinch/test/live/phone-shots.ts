/**
 * Screenshots of the phone page in its demo mode (phone/demo.js: a
 * generated estate, canned views and frames, no party) with headless
 * Chrome (snug's DevTools driver), every phase and the heist for the
 * thief and a guard, at five phone sizes, with layout checks: nothing
 * wider than the screen, the bars and buttons clear of each other, no
 * fitted word overflowing. Not part of `npm test`.
 *
 *   npm run build && node test/live/phone-shots.ts [DIR=/tmp/pinch-phone] [--only a,b] [--sizes 390x844,320x568] [--lang de]
 */

import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser, type Tab } from "../../../snug/test/live/browser.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "dist");
const lib = join(root, "..", "..", "crates", "tvpipe", "src", "playshare", "web", "lib");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const only = flag("--only")?.split(",");
const sizesArg = flag("--sizes");
const lang = flag("--lang") ?? "en";
const out = args[0] ?? "/tmp/pinch-phone";
mkdirSync(out, { recursive: true });
if (!existsSync(join(dist, "phone", "index.html"))) throw new Error("no dist/: npm run build first");

const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml",
};
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!)).replace(/^(\.\.[/\\])+/, "");
  const base = path.startsWith("/_tvpipe/lib/") ? lib : dist;
  const file = join(base, path.startsWith("/_tvpipe/lib/") ? path.slice("/_tvpipe/lib/".length) : path);
  if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/phone/index.html`;

const SIZES = (sizesArg ?? "320x568,375x667,390x844,412x915,430x932").split(",").map((s) => {
  const [w, h] = s.split("x").map(Number);
  return { width: w!, height: h! };
});

type Step = (tab: Tab, size: { width: number; height: number }) => Promise<void>;
const touch = (tab: Tab, type: string, x: number, y: number) =>
  tab.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A tap at a share of the screen. */
const tapAt = (fx: number, fy: number): Step => async (tab, s) => {
  await touch(tab, "touchStart", s.width * fx, s.height * fy);
  await touch(tab, "touchEnd", s.width * fx, s.height * fy);
};
/** A long press (the marks menu), the finger kept down. */
const pressAt = (fx: number, fy: number): Step => async (tab, s) => {
  await touch(tab, "touchStart", s.width * fx, s.height * fy);
  await sleep(700);
};

const shots: { name: string; query: string; steps?: Step[]; wait?: number; after?: number }[] = [
  { name: "join", query: "demo=thief&phase=join" },
  { name: "lobby", query: "demo=thief&phase=lobby" },
  { name: "lobby-guest", query: "demo=guard&phase=lobby&guest=1" },
  { name: "briefing-thief", query: "demo=thief&phase=briefing" },
  { name: "briefing-guard", query: "demo=guard&phase=briefing" },
  { name: "heist-thief", query: "demo=thief&scene=walk", wait: 1500 },
  { name: "heist-thief-loot", query: "demo=thief&scene=loot", wait: 1500 },
  { name: "heist-thief-busy", query: "demo=thief&scene=busy", wait: 1500 },
  { name: "heist-thief-held", query: "demo=thief&scene=held", wait: 1500 },
  { name: "heist-thief-walking", query: "demo=thief&scene=loot", steps: [tapAt(0.5, 0.25)], wait: 900, after: 1200 },
  { name: "heist-guard", query: "demo=guard&scene=walk", wait: 1500 },
  { name: "heist-guard-hold", query: "demo=guard&scene=hold", wait: 1500 },
  { name: "heist-guard-marks", query: "demo=guard&scene=hold", steps: [pressAt(0.3, 0.45)], wait: 300 },
  { name: "outcome-thief", query: "demo=thief&phase=outcome" },
  { name: "outcome-guard", query: "demo=guard&phase=outcome" },
  { name: "tape", query: "demo=thief&phase=tape" },
  { name: "scores", query: "demo=thief&phase=scores" },
  { name: "final", query: "demo=thief&phase=final" },
];

/** Layout checks in the page: what overflows or overlaps. */
const CHECK = `(() => {
  const bad = [];
  const W = innerWidth, H = innerHeight;
  const vis = (el) => el && !el.hidden && el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden";
  const r = (el) => el.getBoundingClientRect();
  if (document.documentElement.scrollWidth > W + 1) bad.push("page wider than the screen: " + document.documentElement.scrollWidth);
  for (const el of document.querySelectorAll("[data-fit]")) {
    if (!vis(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1) bad.push("overflowing text: " + el.textContent);
  }
  for (const el of document.querySelectorAll("button, .slot, .clock, .rolebox, .holdbanner, .ticker, .hint")) {
    if (!vis(el)) continue;
    const b = r(el);
    if (b.width && (b.left < -1 || b.right > W + 1)) bad.push("off screen: " + el.className + " " + Math.round(b.left) + ".." + Math.round(b.right));
  }
  const heist = document.querySelector(".heist");
  if (heist) {
    const top = r(heist.querySelector(".hud-top")), bottom = r(heist.querySelector(".hud-bottom"));
    const parts = [...heist.querySelectorAll(".hud-top > *")].filter(vis).map(r);
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j];
      if (a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top && b.bottom > a.top) bad.push("top bar parts overlap " + i + "/" + j);
    }
    const big = heist.querySelector(".bigbtn");
    if (vis(big) && r(big).bottom > bottom.top) bad.push("big button over the bottom bar");
    const under = heist.querySelector(".under");
    for (const el of under.children) if (vis(el) && r(el).top < top.bottom) bad.push("under the top bar: " + el.className);
    for (const el of heist.querySelectorAll(".act, .tool")) if (vis(el) && r(el).height < 44) bad.push("small button: " + el.className);
  } else {
    for (const el of document.querySelectorAll("button")) if (vis(el) && r(el).height < 40) bad.push("small button: " + el.textContent);
  }
  return bad;
})()`;

/** Gestures against the demo's host, at one size: what the phone sent shows up in its next frames. */
async function gestures(browser: Browser): Promise<string[]> {
  const fails: string[] = [];
  const size = { width: 390, height: 844 };
  const open = async (query: string) => {
    const tab = await browser.open(`${base}?${query}&lang=${lang}`, { ...size, mobile: true });
    await tab.until("!!globalThis.pinchHeist && globalThis.pinchHeist.placed", 20000);
    await sleep(500);
    return tab;
  };
  const model = <T>(tab: Tab, expr: string) => tab.eval<T>(`(() => { const m = globalThis.pinchHeist; return ${expr}; })()`);
  const me = (tab: Tab) => model<{ x: number; y: number }>(tab, "(() => { const p = m.body; return { x: p.x, y: p.y }; })()");
  /** Where a tile is on the screen. */
  const screenOf = (tab: Tab, x: string, y: string) =>
    tab.eval<{ x: number; y: number }>(`(() => { const m = globalThis.pinchHeist; const c = document.querySelector("canvas.map"); const r = c.getBoundingClientRect(); const v = m.view; return { x: (${x} - v.left) * v.scale + r.left, y: (${y} - v.top) * v.scale + r.top }; })()`);
  const check = (ok: boolean, what: string) => {
    if (!ok) fails.push(what);
    console.log(`${ok ? "✓" : "✗"} gesture: ${what}`);
  };

  // A guard: tap the thief in the cone to hold.
  let tab = await open("demo=guard&scene=hold");
  try {
    const th = await screenOf(tab, "m.frame.others.find(o => o.role === 'thief').x", "m.frame.others.find(o => o.role === 'thief').y");
    await touch(tab, "touchStart", th.x, th.y);
    await touch(tab, "touchEnd", th.x, th.y);
    await sleep(600);
    check(await model<boolean>(tab, "(m.pub?.holds?.length ?? 0) === 1"), "tap the thief holds");
    // Holding, a guard still marks: long press, release, tap Look.
    const g = await me(tab);
    const gs = await screenOf(tab, String(g.x), String(g.y + 2));
    await touch(tab, "touchStart", gs.x, gs.y);
    await sleep(700);
    await touch(tab, "touchEnd", gs.x, gs.y);
    const look = await tab.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(".radial .look").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await touch(tab, "touchStart", look.x, look.y);
    await touch(tab, "touchEnd", look.x, look.y);
    await sleep(500);
    check(await model<boolean>(tab, "(m.pub?.marks ?? []).some(k => k.kind === 'look')"), "holding, a guard still marks");
  } finally {
    tab.close();
  }

  // A guard: aim by dragging from oneself; a refusal with the light off.
  tab = await open("demo=guard&scene=walk");
  try {
    // Marks: long press, slide left past Seen and on: the arrow; release sends it.
    await touch(tab, "touchStart", 120, 330);
    await sleep(700);
    for (const dx of [20, 50, 80, 110, 140]) {
      await touch(tab, "touchMove", 120 - Math.min(dx, 100), 330 + Math.max(0, dx - 100) * 2);
      await sleep(40);
    }
    await touch(tab, "touchMove", 20, 420);
    await touch(tab, "touchEnd", 20, 420);
    await sleep(500);
    check(await model<boolean>(tab, "(m.pub?.marks ?? []).some(k => k.kind === 'seen' && typeof k.angle === 'number')"), "long press, Seen with a drag for the arrow");
    // Long press, release at the centre, then tap Post.
    const here = await me(tab);
    const hs = await screenOf(tab, String(here.x), String(here.y));
    await touch(tab, "touchStart", hs.x, hs.y);
    await sleep(700);
    await touch(tab, "touchEnd", hs.x, hs.y);
    const post = await tab.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(".radial .post").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await touch(tab, "touchStart", post.x, post.y);
    await touch(tab, "touchEnd", post.x, post.y);
    await sleep(500);
    check(await model<boolean>(tab, "(m.pub?.marks ?? []).some(k => k.kind === 'post')"), `long press, then tap Post (${await tab.eval("document.querySelector('.heist .toast').textContent")})`);
    // Removing it: a tap on one's own mark opens the pop (and does not walk); a tap elsewhere closes it, Remove removes it.
    const markAt = () => screenOf(tab, "m.pub.marks.find(k => k.kind === 'post').x", "m.pub.marks.find(k => k.kind === 'post').y");
    const popShown = () => tab.eval<boolean>(`!document.querySelector(".heist .markpop").hidden`);
    let ms = await markAt();
    await touch(tab, "touchStart", ms.x, ms.y);
    await touch(tab, "touchEnd", ms.x, ms.y);
    await sleep(200);
    const walked = await model<boolean>(tab, "!!m.path");
    const shown = await popShown();
    await touch(tab, "touchStart", 60, 500);
    await touch(tab, "touchEnd", 60, 500);
    await sleep(300);
    const closed = !(await popShown()) && (await model<boolean>(tab, "(m.pub?.marks ?? []).some(k => k.kind === 'post')"));
    check(shown && !walked && closed, `a tap on one's own mark offers Remove without walking; a tap elsewhere keeps the mark (shown ${shown}, walked ${walked}, closed ${closed})`);
    await sleep(1500);
    ms = await markAt();
    await touch(tab, "touchStart", ms.x, ms.y);
    await touch(tab, "touchEnd", ms.x, ms.y);
    await sleep(200);
    await tab.screenshot(join(out, "gesture-remove-mark-390x844.png"));
    const rm = await tab.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector(".markpop .remove").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await touch(tab, "touchStart", rm.x, rm.y);
    await touch(tab, "touchEnd", rm.x, rm.y);
    await sleep(500);
    check(!(await model<boolean>(tab, "(m.pub?.marks ?? []).some(k => k.kind === 'post')")), "Remove removes one's own mark");
    // The tap that closed the pop walked: aim once standing.
    await tab.until("!globalThis.pinchHeist.path && !globalThis.pinchHeist.frame.me.moving", 20000);
    await sleep(300);
    const p = await me(tab);
    const s = await screenOf(tab, String(p.x), String(p.y));
    await touch(tab, "touchStart", s.x, s.y);
    for (let k = 1; k <= 6; k++) {
      await touch(tab, "touchMove", s.x, s.y - k * 20);
      await sleep(30);
    }
    await sleep(400);
    await touch(tab, "touchEnd", s.x, s.y - 120);
    const f = await model<number>(tab, "m.frame.me.facing");
    check(Math.abs(f - 270) < 15, `drag from oneself aims (host facing ${f})`);
    await tab.eval(`document.querySelector(".heist .bigbtn").hidden = false`);
    await tab.eval(`globalThis.pinchHeist && document.querySelector(".heist .bigbtn").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
    await sleep(400);
    const toast = await tab.eval<string>(`document.querySelector(".heist .toast").textContent`);
    check(/light|Funzel/i.test(toast), `a refusal toasts ("${toast}")`);
  } finally {
    tab.close();
  }

  // The thief: take with the button; a firecracker armed, then thrown with a tap.
  tab = await open("demo=thief&scene=loot");
  try {
    const before = await model<number>(tab, "m.frame.me.slots.length");
    await tab.eval(`document.querySelector(".heist .act:not([hidden])").click()`);
    await sleep(2600);
    const after = await model<number>(tab, "m.frame.me.slots.length");
    check(after === before + 1 || (await model<boolean>(tab, "!!m.frame.me.busy")), `Take fills a slot (${before} → ${after})`);
    await tab.eval(`document.querySelector(".heist .tool").click()`);
    await sleep(100);
    const armed = await tab.eval<boolean>(`!document.querySelector(".heist .hint").hidden`);
    await touch(tab, "touchStart", 195, 300);
    await touch(tab, "touchEnd", 195, 300);
    await sleep(1600);
    check(armed && (await model<number>(tab, "m.frame.me.firecrackers")) === 1, "the firecracker button arms, a tap throws");
  } finally {
    tab.close();
  }
  for (const net of ["lag=0", "lag=150&jitter=80&pace=uneven", "lag=300&jitter=150&pace=uneven"]) {
    for (const role of ["guard", "thief"]) fails.push(...(await prediction(browser, role, net)));
  }
  return fails;
}

/**
 * The prediction against the real rules (demo host=sim) over a slow,
 * uneven link: walk through a closed door, change one's mind halfway
 * (the host finds its own way from where it is), walk on. The drawn
 * figure must never park while the host walks, never jump, and end
 * where the host ends.
 */
async function prediction(browser: Browser, role: string, net: string): Promise<string[]> {
  const fails: string[] = [];
  const tab = await browser.open(`${base}?demo=${role}&host=sim&scene=door&bots=still&seed=3&${net}`, { width: 390, height: 844, mobile: true });
  try {
    await tab.until("!!globalThis.pinchHeist && globalThis.pinchHeist.placed && !!globalThis.pinchHeist.view", 20000);
    await sleep(800);
    // Two targets: past the nearest closed door, and then back past where one started.
    const plan = await tab.eval<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(`(() => {
      const m = globalThis.pinchHeist, map = m.map, at = m.at;
      let best = null, bd = 1e9;
      for (const d of map.doors) {
        if (m.mem.doors[d.id] !== 0) continue;
        const dd = Math.hypot(d.x + 0.5 - at.x, d.y + 0.5 - at.y);
        if (dd < bd && dd > 1.5) { bd = dd; best = d; }
      }
      if (!best) return null;
      const h = best.wall === "h";
      const s = h ? Math.sign(best.y + 0.5 - at.y) || 1 : Math.sign(best.x + 0.5 - at.x) || 1;
      const a = h ? { x: best.x + 0.5, y: best.y + 0.5 + s * 3 } : { x: best.x + 0.5 + s * 3, y: best.y + 0.5 };
      return { a, b: { x: at.x - (a.x - at.x) * 0.3, y: at.y - (a.y - at.y) * 0.3 } };
    })()`);
    if (!plan) return [`prediction ${role} ${net}: no closed door near`];
    const tapTile = async (p: { x: number; y: number }) => {
      const s = await tab.eval<{ x: number; y: number }>(`(() => { const m = globalThis.pinchHeist, v = m.view; return { x: (${p.x} - v.left) * v.scale, y: (${p.y} - v.top) * v.scale }; })()`);
      await touch(tab, "touchStart", s.x, s.y);
      await touch(tab, "touchEnd", s.x, s.y);
    };
    // Record every animation frame: the drawn figure, the host's last position and whether it walks.
    await tab.eval(`(() => {
      const m = globalThis.pinchHeist; const rec = globalThis.pinchRec = [];
      const f = (now) => { if (rec.length > 4000) return; const a = m.at, me = m.frame.me;
        rec.push({ t: now, x: a.x, y: a.y, hx: me.x, hy: me.y, hm: me.moving, ft: m.frame.t, busy: !!me.busy }); requestAnimationFrame(f); };
      requestAnimationFrame(f); })()`);
    await tapTile(plan.a);
    await sleep(1700);
    await tapTile(plan.b);
    await sleep(4500);
    type Rec = { t: number; x: number; y: number; hx: number; hy: number; hm: boolean; ft: number; busy: boolean };
    const rec = await tab.eval<Rec[]>("globalThis.pinchRec");
    const fixes = await tab.eval<Record<string, number>>("globalThis.pinchHeist.fixes");
    // Where the host stops next, per sample (the prediction gets there first: no parking).
    const stop: { x: number; y: number }[] = new Array(rec.length);
    let ahead = rec.at(-1)!;
    for (let k = rec.length - 1; k >= 0; k--) {
      if (!rec[k]!.hm) ahead = rec[k]!;
      stop[k] = { x: ahead.hx, y: ahead.hy };
    }
    // Parked: the host walking (frames say so) while the drawn figure, not yet where the host stops, stays within 0.1 tiles.
    let parked = 0;
    let since = -1;
    let jump = 0;
    let apart = 0;
    for (let k = 1; k < rec.length; k++) {
      const a = rec[k - 1]!;
      const b = rec[k]!;
      jump = Math.max(jump, Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, (b.t - a.t) / 16.7));
      if (b.hm) apart = Math.max(apart, Math.hypot(b.x - b.hx, b.y - b.hy));
      if (b.hm && !b.busy && Math.hypot(b.x - stop[k]!.x, b.y - stop[k]!.y) > 0.3) {
        if (since < 0) since = k;
        const s = rec[since]!;
        if (Math.hypot(b.x - s.x, b.y - s.y) > 0.1) since = k;
        else parked = Math.max(parked, b.t - s.t);
      } else since = -1;
    }
    const end = rec.at(-1)!;
    const off = Math.hypot(end.x - end.hx, end.y - end.hy);
    const gaps = rec.map((r) => r.ft).filter((t, k, a) => k > 0 && t !== a[k - 1]).map((t, k, a) => (k ? t - a[k - 1]! : 0)).slice(1);
    const ok = parked < 450 && jump < 0.35 && apart < 3 && off < 0.3 && !fixes["snap"];
    const what = `prediction ${role} ${net}: parked ${Math.round(parked)} ms, step ≤ ${jump.toFixed(2)} tiles/frame, apart ≤ ${apart.toFixed(2)}, end off ${off.toFixed(2)}, fixes ${JSON.stringify(fixes)}, frame gaps ${Math.min(...gaps).toFixed(2)}–${Math.max(...gaps).toFixed(2)} s`;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
    if (!ok) fails.push(what);
    if (tab.errors.length) fails.push(...tab.errors);
  } finally {
    tab.close();
  }
  return fails;
}

const browser = await Browser.launch();
let problems = 0;
try {
  if (!only || only.includes("gestures")) problems += (await gestures(browser)).length;
  for (const size of SIZES) {
    for (const shot of shots) {
      if (only && !only.includes(shot.name)) continue;
      const tab = await browser.open(`${base}?${shot.query}&lang=${lang}`, { ...size, mobile: true, locale: lang === "de" ? "de-DE" : "en-US" });
      try {
        await tab.until("document.fonts && document.fonts.status === 'loaded' && !!document.querySelector('#app > *:not(.card) , #app .card:not(:only-child), .heist, form, .intertitle, .card h1')", 20000);
        await sleep(shot.wait ?? 600);
        for (const s of shot.steps ?? []) await s(tab, size);
        if (shot.after) await sleep(shot.after);
        const file = join(out, `${shot.name}-${size.width}x${size.height}.png`);
        await tab.screenshot(file);
        const bad = await tab.eval<string[]>(CHECK);
        const errs = tab.errors.filter((e) => !/favicon/.test(e));
        if (bad.length || errs.length) {
          problems++;
          console.log(`✗ ${file}\n  ${[...bad, ...errs].join("\n  ")}`);
        } else console.log(`✓ ${file}`);
      } catch (e) {
        problems++;
        console.log(`✗ ${shot.name} ${size.width}x${size.height}: ${(e as Error).message}\n  ${tab.errors.join("\n  ")}`);
      } finally {
        tab.close();
      }
    }
  }
} finally {
  browser.close();
  server.close();
}
console.log(problems ? `${problems} with problems` : "all clear");
process.exit(problems ? 1 : 0);
