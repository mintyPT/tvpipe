/**
 * The TV page on a stage (not part of `npm test`): plays a recorded game
 * (`test/live/record.ts`) on the TV page in headless Chrome at the real
 * pace, without tvpipe: a small server gives the bundle (`dist/`) and a
 * stand-in for tvpipe's client library that takes the views from here
 * (the real join badge included). Screenshots of the moments asked for,
 * and the TV's layout check, for working on the look.
 *
 *   npm run build && node test/live/record.ts && node test/live/stage.ts [--views FILE] [--out DIR]
 *     [--every MS] [--types attack,clash,place,move] [--events N] [--plan MS] [--size 1280x720]
 *
 * `--every` takes a screenshot every MS during the events of `--types`
 * (default: the attacks and clashes); `--events` stops after N such events
 * of each battle (the rest pass quickly).
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { eventMs, PACE, paceScale } from "../../game/timeline.ts";
import { fight, seeded, type Attack, type Event } from "../../game/rules.ts";
import { Browser } from "./browser.ts";

const { values: args } = parseArgs({
  options: {
    views: { type: "string", default: "/tmp/landgrab-views.json" },
    out: { type: "string", default: "/tmp/landgrab-stage" },
    every: { type: "string", default: "500" },
    types: { type: "string", default: "attack,clash" },
    events: { type: "string", default: "3" },
    plan: { type: "string", default: "7000" },
    rounds: { type: "string", default: "99" },
    from: { type: "string", default: "0" },
    clash: { type: "boolean", default: false },
    steps: { type: "string", default: "" },
    sound: { type: "boolean", default: false },
    planshots: { type: "string", default: "400,3000" },
    fps: { type: "boolean", default: false },
    size: { type: "string", default: "1280x720" },
    final: { type: "string", default: "6000" },
  },
});

const here = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(here, "dist");
// tvpipe's copy of the library, next to the party package (in a sandbox copy too: node_modules is a link).
const lib = join(realpathSync(join(here, "node_modules", "@tvpipe", "party")), "..", "..", "crates", "tvpipe", "src", "playshare", "web", "lib");
if (!existsSync(join(dist, "screen", "index.html"))) throw new Error("build first: npm run build");

const STUB = `
import { qrSvg, joinText } from "./real-client.js";
import { RejoinBadge } from "./rejoin.js";
export { qrSvg, joinText };
export class PartyClient {
  static fromLocation(o) { return new PartyClient(o); }
  constructor(o) {
    this.view = null;
    this.ls = { view: [], status: [] };
    this.rejoinBadge = new RejoinBadge(document, { qrSvg, joinText }, o.rejoinBadge || {});
    this.on("view", (v) => this.rejoinBadge.update(v));
    globalThis.__stage = this;
  }
  on(e, f) { (this.ls[e] ??= []).push(f); }
  now() { return Date.now(); }
  connect() { for (const f of this.ls.status) f("open"); return Promise.resolve(); }
  get joinVisible() { return this.rejoinBadge.suppressed; }
  set joinVisible(on) { this.rejoinBadge.suppressed = on; }
  set(view) { this.view = view; for (const f of this.ls.view) f(view); }
}`;

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".txt": "text/plain", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  let file: string | null = null;
  if (path === "/_tvpipe/lib/client.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    res.end(STUB);
    return;
  }
  if (path === "/_tvpipe/lib/real-client.js") file = join(lib, "client.js");
  else if (path.startsWith("/_tvpipe/lib/")) file = join(lib, normalize(path.slice("/_tvpipe/lib/".length)));
  else file = join(dist, normalize(path));
  if (!file || !existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

/** A QR code's look (not a real code). */
function fakeQr(): { size: number; rows: string[] } {
  const n = 29;
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rows = Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => {
      for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
        const dx = x - fx;
        const dy = y - fy;
        if (dx >= 0 && dx < 7 && dy >= 0 && dy < 7) return dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4) ? "1" : "0";
        if (dx >= -1 && dx <= 7 && dy >= -1 && dy <= 7) return "0";
      }
      return rnd() < 0.5 ? "1" : "0";
    }).join(""),
  );
  return { size: n, rows };
}

const [W, H] = args.size.split("x").map(Number) as [number, number];
const views = JSON.parse(readFileSync(args.views, "utf8")) as any[];
const out = args.out;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const every = Number(args.every);
const types = new Set(args.types.split(","));
const maxEvents = Number(args.events);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);

const tvLayout = `(() => {
  const out = [];
  const moving = document.getAnimations().filter((a) => a.playState === "running" && !(a.effect?.getTiming?.().iterations === Infinity)).map((a) => a.effect?.target).filter((x) => x instanceof Element);
  const still = (el) => !moving.some((m) => m.contains(el));
  for (const el of document.querySelectorAll("#hud .scene:not(.leaving) [data-fit]")) {
    if (el.checkVisibility && !el.checkVisibility()) continue;
    if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
  }
  const badge = document.querySelector("tvpipe-rejoin")?.shadowRoot?.querySelector(".mini.shown")?.getBoundingClientRect();
  for (const el of document.querySelectorAll("#hud .scene:not(.leaving) *")) {
    if (!el.checkVisibility || !el.checkVisibility()) continue;
    if (["svg", "path", "g", "circle", "rect", "text", "canvas", "i"].includes(el.localName) || el.closest(".logo")) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width > 0 && still(el) && (r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 || r.top < -2)) out.push("off the screen: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
    if (cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.display !== "inline") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
    if (badge && r.width > 0 && still(el) && el.children.length === 0 && (el.innerText || "").trim() && r.left < badge.right && r.right > badge.left && r.top < badge.bottom && r.bottom > badge.top) out.push("under the join badge: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
  }
  return out;
})()`;

const browser = await Browser.launch();
const problems = new Set<string>();
try {
  const tv = await browser.open(`http://127.0.0.1:${port}/screen/index.html#role=screen${args.sound ? "" : "&mute=1"}`, { width: W, height: H });
  await tv.until(`!!globalThis.__stage`, 10_000);
  // Frame times: the gaps between animation frames since the last look (the page's work per frame).
  await tv.eval(`(() => { globalThis.__gaps = []; let last = performance.now(); const f = (t) => { __gaps.push(t - last); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); return true; })()`);
  // The frames the compositor makes (what a capture gets): a screencast's frames per second over `ms`.
  let casting = 0;
  tv.on("Page.screencastFrame", (p: { sessionId: number }) => {
    casting++;
    void tv.send("Page.screencastFrameAck", { sessionId: p.sessionId });
  });
  const fps = async (what: string, ms = 2000) => {
    casting = 0;
    await tv.send("Page.startScreencast", { format: "jpeg", quality: 30, everyNthFrame: 1 });
    await sleep(ms);
    await tv.send("Page.stopScreencast");
    log(`screencast ${what}: ${((casting * 1000) / ms).toFixed(1)} fps`);
  };
  const perf = async (what: string) => {
    const g = await tv.eval<number[]>(`(() => { const g = __gaps; globalThis.__gaps = []; return g; })()`);
    if (!g.length) return;
    const s = [...g].sort((a, b) => a - b);
    const q = (f: number) => s[Math.min(s.length - 1, Math.floor(s.length * f))]!.toFixed(0);
    const slow = g.filter((x) => x > 40).length;
    log(`frames ${what}: ${g.length}, median ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${q(1)} ms, ${slow} over 40 ms`);
  };
  const join = { code: "NFVL", url: "https://landgrab.example/j/NFVL", short: "https://tvp.ac/NFVL", qr: fakeQr(), lateJoin: "wait", inProgress: false };
  let n = 0;
  const shot = async (name: string) => {
    const file = `${String(++n).padStart(3, "0")}-${name}.png`;
    await tv.screenshot(join2(out, file));
    for (const p of await tv.eval<string[]>(tvLayout).catch(() => [] as string[])) {
      if (!problems.has(p)) log(`PROBLEM ${name}: ${p}`);
      problems.add(p);
    }
  };
  const set = (v: unknown) => tv.eval(`(__stage.set(${JSON.stringify(v)}), true)`);
  // The scale of each round's battle, as the host has it.
  const byRound = new Map<number, Event[]>();
  for (const v of views) {
    const s = v.screen ?? {};
    const ev = s.step?.ev as Event | undefined;
    if (s.phase === "battle" && ev && !byRound.get(s.round)?.includes(ev)) {
      const list = byRound.get(s.round) ?? [];
      if (!list.some((e: any) => JSON.stringify(e) === JSON.stringify(ev))) list.push(ev);
      byRound.set(s.round, list);
    }
  }
  // --clash: the first attack between two players of each shown battle becomes a head-on clash (to see one).
  if (args.clash) {
    const rng = seeded(5);
    const done = new Set<number>();
    for (const v of views) {
      const s = v.screen ?? {};
      const ev = s.step?.ev;
      if (s.phase !== "battle" || !ev || ev.type !== "attack" || !ev.foe || done.has(s.round) || s.round < Number(args.from)) continue;
      done.add(s.round);
      const nb = Math.max(1, Math.round(ev.def * 0.7));
      const home = Math.max(1, ev.def - nb);
      const f = fight(ev.n, nb, rng, true);
      let then: Attack | null = null;
      if (f.att > 0) {
        const g = fight(f.att, home, rng);
        then = { p: ev.p, from: ev.from, to: ev.to, n: f.att, foe: ev.foe, def: home, rolls: g.rolls, left: g.att, won: g.def === 0 && g.att > 0 };
      } else if (f.def > 0) {
        const g = fight(f.def, 1, rng);
        then = { p: ev.foe, from: ev.to, to: ev.from, n: f.def, foe: ev.p, def: 1, rolls: g.rolls, left: g.att, won: g.def === 0 && g.att > 0 };
      }
      const was = ev.was as [number, string, number][];
      if (was[1]) was[1][2] = nb + home;
      s.step.ev = { type: "clash", p: ev.p, q: ev.foe, a: ev.from, b: ev.to, na: ev.n, nb, rolls: f.rolls, leftA: f.att, leftB: f.def, then, was, set: ev.set };
    }
  }
  let lastKey = "";
  let shown = 0;
  for (let i = 0; i < views.length; i++) {
    const v = structuredClone(views[i]);
    const s = v.screen ?? {};
    if ((s.round ?? 0) > Number(args.rounds) && s.phase !== "final") continue;
    if ((s.round ?? 0) < Number(args.from)) continue;
    v.join = { ...join, inProgress: s.phase !== "lobby" };
    const key = `${s.phase}:${s.round}`;
    const fresh = key !== lastKey;
    lastKey = key;
    if (fresh) shown = 0;
    if (s.phase === "lobby") {
      await set(v);
      await sleep(250);
      if (views[i + 1]?.screen?.phase === "lobby") continue;
      await perf("lobby (joining)");
      await sleep(3000);
      await perf("lobby");
      if (args.fps) await fps("lobby");
      await shot("lobby");
      continue;
    }
    if (s.phase === "plan") {
      if (views[i + 1]?.screen?.phase === "plan" && fresh) {
        // The plan's first view: play it with the real lengths, readiness coming in.
        const banner = 2500;
        const duration = 60_000;
        s.banner = banner;
        s.duration = duration;
        s.deadline = Date.now() + banner + duration;
        const players = (s.players ?? []) as any[];
        for (const p of players) p.ready = false;
        await set(v);
        const plan = Number(args.plan);
        const t0 = Date.now();
        for (const at of args.planshots.split(",").map(Number)) {
          await sleep(t0 + at - Date.now());
          await shot(`r${s.round}-plan-${String(at).padStart(5, "0")}`);
        }
        if (args.fps) await fps("plan");
        for (let k = 0; k < players.length; k++) {
          await sleep(plan / players.length / 2);
          players[k].ready = true;
          await set(v);
        }
        await sleep(250);
        await shot(`r${s.round}-plan-ready`);
        await sleep(plan / 2);
      }
      continue;
    }
    if (s.phase === "battle") {
      const step = s.step;
      if (!step) {
        await set(v);
        await sleep(1500);
        continue;
      }
      if (!step.ev) {
        await set(v);
        await sleep(400);
        await shot(`r${s.round}-battle-end`);
        await sleep(2600);
        continue;
      }
      const ev = step.ev as Event;
      const scale = paceScale(byRound.get(s.round) ?? [], PACE);
      const want = args.steps ? args.steps.split(",").includes(`${s.round}:${step.i}`) : types.has(ev.type) && shown < maxEvents;
      const ms = want || ev.type === "place" ? eventMs(ev, PACE, scale) : Math.min(600, eventMs(ev, PACE, scale));
      step.ms = ms;
      step.scale = scale;
      if (want) shown++;
      log(`r${s.round} ${step.i + 1}/${step.of} ${ev.type} ${ms} ms${want ? " (shots)" : ""}`);
      const start = Date.now();
      await set(v);
      if (want && args.fps) await fps(`${ev.type} ${step.i}`, ms - 100);
      else if (want) {
        for (let at = every; at < ms; at += every) {
          await sleep(start + at - Date.now());
          await shot(`r${s.round}-s${step.i}-${ev.type}-${String(at).padStart(5, "0")}`);
        }
      }
      await sleep(start + ms - Date.now());
      if (!want) await perf(`${ev.type} ${step.i}`);
      continue;
    }
    if (s.phase === "final") {
      await set(v);
      if (args.fps) await fps("final", 4000);
      for (const at of [800, 2500, Number(args.final)]) {
        await sleep(at - (at === 800 ? 0 : at === 2500 ? 800 : 2500));
        await shot(`final-${at}`);
      }
    }
  }
  for (const e of tv.errors) problems.add(`page: ${e}`);
  log(`done; ${problems.size} problems; screenshots in ${out}`);
  for (const p of problems) log(`PROBLEM ${p}`);
} finally {
  browser.close();
  server.close();
}
process.exit(problems.size ? 1 : 0);

function join2(a: string, b: string): string {
  return join(a, b);
}
