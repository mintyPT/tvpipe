/**
 * What Pinch's live checks share (`play.ts`, `lag.ts`; not part of
 * `npm test`): `tvpipe game play` on the bundle (tied to this process),
 * the launcher clicked through to the host page, a wire tap for the
 * pages, and the in-page helpers a scripted phone uses.
 *
 * The wire tap (`wireTap`) runs in a page before its own scripts and
 * wraps `WebSocket`: it counts the party's messages by type (`f`
 * frames, `pub` deltas) with their arrival times, keeps the page's own
 * copy of its view (full and diff states, as the client applies them)
 * and checks every message against Pinch's secrecy (§11: the car, the
 * tip and the briefing reach the thief only; no tape on a phone), and
 * records the page's phases (`data-phase` on `<html>` or `<body>`) as
 * they change. With `delay` it holds every message for that many ms in
 * each direction (an artificial network).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { Browser, Tab } from "./browser.ts";
import { tie } from "./tie.ts";

export const here = new URL("../../", import.meta.url);
const repo = new URL("../../", here);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
export const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);

export interface Tvpipe {
  proc: ChildProcess;
  exited: Promise<number | null>;
  /** The window's link (the launcher). */
  start: string;
  lines: string[];
}

/**
 * A copy of the built game (the manifest and `dist/`) in a temporary
 * folder, so a build running meanwhile (it empties `dist/`) does not
 * pull the pages from under a long check. Deleted when this process ends.
 */
function snapshot(): string {
  const dist = fileURLToPath(new URL("dist/", here));
  if (!existsSync(join(dist, "host", "host.js"))) throw new Error("build the game first (npm run build)");
  const dir = mkdtempSync(join(tmpdir(), "pinch-live-"));
  cpSync(fileURLToPath(new URL("tvpipe.json", here)), join(dir, "tvpipe.json"));
  cpSync(dist, join(dir, "dist"), { recursive: true });
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Starts `tvpipe game play` on this game (a snapshot of its build); `tunnel` for the public link (else `--no-tunnel`). */
export async function startTvpipe(o: { tunnel?: boolean } = {}): Promise<Tvpipe> {
  const exe = process.platform === "win32" ? "tvpipe.exe" : "tvpipe";
  const binary = process.env["TVPIPE_BINARY"] ?? ["release", "debug"].map((p) => fileURLToPath(new URL(`target/${p}/${exe}`, repo))).find((p) => existsSync(p));
  if (!binary) throw new Error("build tvpipe first (cargo build --release -p tvpipe-cli)");
  const game = snapshot();
  const args = ["game", "play", game, "--window", "none", ...(o.tunnel ? ["--no-short-link"] : ["--no-tunnel"])];
  const proc = tie(spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] }));
  const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
  const lines: string[] = [];
  createInterface({ input: proc.stderr! }).on("line", (l) => {
    lines.push(l);
    if (/ (WARN|ERROR) /.test(l)) log(`tvpipe: ${l}`);
  });
  const start = await new Promise<string>((resolve, reject) => {
    createInterface({ input: proc.stdout! }).once("line", resolve);
    exited.then(() => reject(new Error(`tvpipe exited:\n${lines.join("\n")}`)));
  });
  return { proc, exited, start, lines };
}

/** Opens the window, picks "A browser tab on this computer", starts: the host page with `pinch` on globalThis. */
export async function hostPage(browser: Browser, start: string): Promise<Tab> {
  const win = await browser.open(start, { width: 1200, height: 860, init: wireTap({ role: "host" }) });
  await win.until(`!!document.querySelector('#devices .device[data-name="browser"]')`, 20_000);
  await win.eval(`document.querySelector('#devices .device[data-name="browser"]').click(); true`);
  await win.until(`!document.getElementById("start").disabled`);
  await win.eval(`document.getElementById("start").click(); true`);
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.pinch`, 30_000);
  return win;
}

/** The wire tap's source for a page (see the top). */
export function wireTap(o: { role: "host" | "tv" | "phone"; delay?: number }): string {
  return `(() => {
  const cfg = ${JSON.stringify(o)};
  const w = (globalThis.__wire = { at: {}, bytes: {}, bad: [], phases: [], last: "", view: {}, sent: 0, got: 0 });
  const phaseOf = () => document.documentElement?.dataset.phase || document.body?.dataset.phase || "";
  setInterval(() => {
    const p = phaseOf();
    if (p && p !== w.last) {
      w.last = p;
      w.phases.push([Date.now(), p]);
    }
  }, 30);
  if (cfg.role === "host") return;
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const merge = (t, p) => {
    for (const k of Object.keys(p)) {
      if (isObj(p[k]) && isObj(t[k])) merge(t[k], p[k]);
      else t[k] = p[k];
    }
  };
  /** Paths of the keys that are secrets of the thief (the car, the tip, the briefing). */
  const secrets = (v, path, out) => {
    if (!v || typeof v !== "object") return out;
    for (const k of Object.keys(v)) {
      const p = path + "." + k;
      if (k === "car" || k === "tip" || (k === "briefing" && v[k] != null)) out.push(p);
      secrets(v[k], p, out);
    }
    return out;
  };
  const bad = (what) => {
    if (w.bad.length < 40 && !w.bad.includes(what)) w.bad.push(what);
  };
  const look = (data) => {
    if (typeof data !== "string") return;
    w.got++;
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.t === "msg") {
      (w.at[m.type] ??= []).push(Date.now());
      w.bytes[m.type] = (w.bytes[m.type] ?? 0) + data.length;
      if (cfg.role === "phone" && m.type === "tape") bad("a phone got the tape");
      if (cfg.role === "phone" && m.type === "f") {
        const role = m.data?.me?.role;
        if (role !== "thief") for (const p of secrets(m.data, "f", [])) bad("a guard's frame holds " + p);
      }
      if (cfg.role === "tv" && m.type === "pub") {
        for (const p of secrets(m.data, "pub", [])) bad("the public layer holds " + p);
        if (m.data && ("others" in m.data || "me" in m.data)) bad("the public layer holds players");
      }
      return;
    }
    if (m.t === "state") {
      if (m.full) w.view = m.full;
      else merge(w.view, m.set ?? {});
      for (const path of m.del ?? []) {
        let o = w.view;
        for (let i = 0; i < path.length - 1 && isObj(o); i++) o = o[path[i]];
        if (isObj(o)) delete o[path[path.length - 1]];
      }
      const v = w.view;
      const room = cfg.role === "tv" ? v.screen : v.room;
      const phase = room?.phase;
      // The car is public once the heist is over (the outcome, the scores, the tape).
      const open = phase === "outcome" || phase === "tape" || phase === "scores" || phase === "final";
      for (const p of secrets(room, "room", [])) if (!open || !/\\.(outcome|result|history)\\./.test(p + ".")) bad(phase + ": " + p);
      if (cfg.role === "phone" && v.me?.role !== "thief") for (const p of secrets(v.me, "me", [])) bad((phase ?? "?") + " (" + v.me?.role + "): " + p);
    }
  };
  const delay = cfg.delay ?? 0;
  const Native = globalThis.WebSocket;
  class Tapped extends Native {
    constructor(...a) {
      super(...a);
      const deliver = [];
      let ready = false;
      super.addEventListener("message", (ev) => {
        if (delay > 0) {
          const data = ev.data;
          setTimeout(() => {
            look(data);
            const e = new MessageEvent("message", { data });
            for (const fn of deliver) fn.call(this, e);
            if (this.__onmessage) this.__onmessage.call(this, e);
          }, delay);
        } else look(ev.data);
      });
      this.__deliver = deliver;
    }
    send(d) {
      w.sent++;
      if (delay > 0) setTimeout(() => {
        if (this.readyState === 1) super.send(d);
      }, delay);
      else super.send(d);
    }
    addEventListener(type, fn, opts) {
      if (type === "message" && delay > 0) this.__deliver.push(fn);
      else super.addEventListener(type, fn, opts);
    }
    set onmessage(fn) {
      if (delay > 0) this.__onmessage = fn;
      else super.onmessage = fn;
    }
    get onmessage() {
      return delay > 0 ? this.__onmessage : super.onmessage;
    }
  }
  globalThis.WebSocket = Tapped;
})();`;
}

/** What a tap recorded in a page. */
export interface Wire {
  at: Record<string, number[]>;
  bytes: Record<string, number>;
  bad: string[];
  phases: [number, string][];
  sent: number;
  got: number;
}

export const wire = (tab: Tab) => tab.eval<Wire>(`(() => { const w = globalThis.__wire; return w ? { at: w.at, bytes: w.bytes, bad: w.bad, phases: w.phases, sent: w.sent, got: w.got } : null; })()`);

/** Messages of a kind per second between two Date.now() times, and the gaps (ms: p95, max). */
export function rate(times: number[] | undefined, from: number, to: number): { hz: number; p95: number; max: number; n: number } {
  const ts = (times ?? []).filter((t) => t >= from && t <= to);
  const gaps = ts.slice(1).map((t, i) => t - ts[i]!).sort((a, b) => a - b);
  const span = (to - from) / 1000;
  return { hz: span > 0 ? ts.length / span : 0, p95: gaps[Math.floor(gaps.length * 0.95)] ?? 0, max: gaps.at(-1) ?? 0, n: ts.length };
}

/** p-quantile of numbers. */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))]! : NaN;
}
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/**
 * In a phone page: the heist screen's state for a script (`pinchHeist`,
 * world.js), with where things are on the screen. `px(x, y)`: tiles →
 * CSS px of the viewport; the free area between the bars.
 */
export const PHONE_STATE = `(() => {
  const m = globalThis.pinchHeist;
  if (document.body.dataset.phase !== "heist" || !m || !m.placed || !m.view || !m.frame) return null;
  const c = document.querySelector(".heist canvas.map");
  if (!c) return null;
  const r = c.getBoundingClientRect();
  const v = m.view;
  const top = document.querySelector(".heist .hud-top")?.getBoundingClientRect();
  const bottom = document.querySelector(".heist .hud-bottom")?.getBoundingClientRect();
  const now = performance.now();
  const me = m.frame.me;
  const vis = (el) => el && !el.hidden && el.offsetParent !== null;
  const at = (el) => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; };
  const acts = [...document.querySelectorAll(".heist .act")].filter((b) => vis(b) && !b.disabled).map((b) => ({ a: b.dataset.a ?? "", ...at(b) }));
  const big = document.querySelector(".heist .bigbtn");
  const tool = document.querySelector(".heist .tool");
  return {
    me, body: { x: m.body.x, y: m.body.y, angle: m.body.angle }, path: !!m.path,
    view: { left: v.left, top: v.top, scale: v.scale, ox: r.left, oy: r.top, w: r.width, h: r.height },
    free: { top: (top?.bottom ?? 0) + 8, bottom: (bottom?.top ?? innerHeight) - 8, left: 8, right: innerWidth - 8 },
    items: (m.frame.items ?? []).map((i) => ({ item: i.item, x: i.x, y: i.y })),
    others: m.others(now).map((o) => ({ id: o.id, role: o.role, x: o.x, y: o.y, held: o.held })),
    holds: m.pub?.holds ?? [], end: m.pub?.end ?? null, left: m.left(now), w: m.map.w,
    car: me.role === "thief" && m.map.spots[me.car] ? { x: m.map.spots[me.car].rect.x + m.map.spots[me.car].rect.w / 2, y: m.map.spots[me.car].rect.y + m.map.spots[me.car].rect.h / 2 } : null,
    acts, big: vis(big) ? at(big) : null, tool: vis(tool) ? at(tool) : null,
  };
})()`;

export type PhoneState = {
  me: any;
  body: { x: number; y: number; angle: number };
  path: boolean;
  view: { left: number; top: number; scale: number; ox: number; oy: number; w: number; h: number };
  free: { top: number; bottom: number; left: number; right: number };
  items: { item: number; x: number; y: number }[];
  others: { id: string; role: string; x: number; y: number; held: boolean }[];
  holds: any[];
  end: any;
  left: number;
  w: number;
  car: { x: number; y: number } | null;
  /** The action buttons shown: what each does (`data-a`) and where. */
  acts: { a: string; x: number; y: number }[];
  big: { x: number; y: number } | null;
  tool: { x: number; y: number } | null;
};

/** Tiles → CSS px of the phone's viewport. */
export const toPx = (s: PhoneState, x: number, y: number) => ({ x: s.view.ox + (x - s.view.left) * s.view.scale, y: s.view.oy + (y - s.view.top) * s.view.scale });
export const onScreen = (s: PhoneState, p: { x: number; y: number }, m = 24) => p.x > s.free.left + m && p.x < s.free.right - m && p.y > s.free.top + m && p.y < s.free.bottom - m;

/** A tap (a touch down and up) at CSS px. */
export async function tap(tab: Tab, p: { x: number; y: number }): Promise<void> {
  await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
  await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/**
 * Where to tap to walk towards a tile: the target when it is on the
 * screen, else the farthest point of the phone's own path there (move.ts
 * `goTo` in the page, through the doors as the phone knows them) that is.
 */
export async function tapToward(tab: Tab, s: PhoneState, tx: number, ty: number): Promise<{ x: number; y: number } | null> {
  const direct = toPx(s, tx, ty);
  if (onScreen(s, direct)) return direct;
  const pts = await tab.eval<{ x: number; y: number }[] | null>(`(async () => {
    const { goTo, PICK_TIME } = await import("/game/move.js");
    const m = globalThis.pinchHeist;
    const p = goTo(m.world, m.body, ${tx}, ${ty}, { locked: m.role === "thief" ? PICK_TIME : 0 });
    return p ? p.points.map((q) => ({ x: q.x, y: q.y })) : null;
  })()`);
  if (!pts || !pts.length) {
    // No way known: a step that way, at the edge of the free area.
    const d = Math.hypot(direct.x - toPx(s, s.body.x, s.body.y).x, direct.y - toPx(s, s.body.x, s.body.y).y) || 1;
    const me = toPx(s, s.body.x, s.body.y);
    const k = Math.min(1, 120 / d);
    return { x: me.x + (direct.x - me.x) * k, y: me.y + (direct.y - me.y) * k };
  }
  // Along the path in small steps; the last point still on the screen.
  let best: { x: number; y: number } | null = null;
  let prev = { x: s.body.x, y: s.body.y };
  for (const q of pts) {
    const d = Math.hypot(q.x - prev.x, q.y - prev.y);
    const n = Math.max(1, Math.ceil(d / 0.25));
    for (let k = 1; k <= n; k++) {
      const x = prev.x + ((q.x - prev.x) * k) / n;
      const y = prev.y + ((q.y - prev.y) * k) / n;
      const px = toPx(s, x, y);
      if (onScreen(s, px)) best = px;
      else if (best) return best;
    }
    prev = q;
  }
  return best;
}
