/**
 * The lag check (docs/pinch-design.md §15, not part of `npm test`): two
 * real phone pages (Anna the thief, Ben a guard) and one bot guard on
 * `tvpipe game play`, a short heist with `?fast`'s timings. Anna and Ben
 * walk to each other by taps, Ben switches his flashlight on and aims
 * (a drag from his figure) so that the cone's edge lies on Anna; then
 * Anna walks back and forth across the edge by taps, pausing at each
 * end, and Ben taps her (a hold) when his phone shows her in the cone:
 * alternately the moment she comes in ("entry") and the moment before
 * she leaves ("exit", the worst fair shot). Measured:
 *
 * - tap → moved: from Anna's tap (standing) to the first frame on her
 *   phone whose position differs; and the tap's way to the host (`go`);
 * - prediction: her predicted figure (`pinchHeist.body`) against the
 *   host's position at the same moment (every 20 ms while she walks),
 *   and against each frame on arrival (the nearest point of her recent
 *   track: the correction the phone makes);
 * - holds: the host's answers by reason, and per try the window that
 *   would have made it fair (how long before the host got it the host
 *   last saw her in the cone, in range and in sight).
 *
 * Three ways: `local` (--no-tunnel), `delay` (the same game, each page's
 * WebSocket held 150 ms each way), `tunnel` (the public link; skipped
 * when it is not up within 30 s). The hold is shortened (1.5 s, 0.5 s
 * immunity) so tries come often; the cooldown stays.
 *
 *   npm run build && perl -e 'alarm 240; exec @ARGV' node test/live/lag.ts [--modes local,delay,tunnel] [--delay 150] [--secs 25] [--headed]
 */

import { parseArgs } from "node:util";

import { Browser, type Tab } from "./browser.ts";
import { hostPage, log, mean, PHONE_STATE, quantile, sleep, startTvpipe, tap, tapToward, toPx, wireTap, type PhoneState, type Tvpipe } from "./rig.ts";

const { values: args } = parseArgs({
  options: {
    modes: { type: "string", default: "local,delay,tunnel" },
    delay: { type: "string", default: "150" },
    secs: { type: "string", default: "25" },
    headed: { type: "boolean", default: false },
  },
});
const modes = new Set(args.modes!.split(","));
const DELAY = Number(args.delay) || 150;
const SECS = Math.max(8, Number(args.secs) || 25);
const LIMIT = 235_000;
const APPROACH = 20_000;
const NAMES = ["Anna", "Ben"];

// ---------------------------------------------------------------- never hang

let tvpipe: Tvpipe | null = null;
let browser: Browser | null = null;
let waiting = "Chrome to start";
const cleanup = () => {
  browser?.close();
  tvpipe?.proc.kill();
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGALRM"] as const) {
  process.on(sig, () => {
    log(`stopped (${sig}) while waiting for ${waiting}`);
    process.exit(130);
  });
}
const started = Date.now();
setTimeout(() => {
  log(`FAILED: over the time limit (${LIMIT / 1000} s) while waiting for ${waiting}`);
  process.exit(1);
}, LIMIT).unref();
const left = () => LIMIT - (Date.now() - started);
const until = async (tab: Tab, what: string, expr: string, ms: number) => {
  waiting = what;
  try {
    await tab.until(expr, ms);
  } catch {
    throw new Error(`timed out after ${(ms / 1000).toFixed(0)} s waiting for ${what}`);
  }
};

// ---------------------------------------------------------------- in the pages

/**
 * In a phone page, after the wire tap: a WebSocket that holds every
 * message `__lag.delay` ms in each direction (changeable at any time,
 * order kept), and a recorder: each frame on arrival (Date.now, heist
 * time, the host's position, the distance to the nearest point of the
 * phone's recent track), and the predicted figure every 20 ms.
 */
const LAG_INIT = `(() => {
  const L = (globalThis.__lag = { delay: 0, frames: [], track: [], sent: [], ups: [] });
  const queue = (q) => {
    let timer = 0;
    const pump = () => {
      timer = 0;
      const now = performance.now();
      while (q.length && q[0].at <= now) q.shift().fn();
      if (q.length) timer = setTimeout(pump, q[0].at - now);
    };
    return (fn) => {
      if (!q.length && L.delay <= 0) return fn();
      const at = Math.max(performance.now() + L.delay, q.length ? q[q.length - 1].at : 0);
      q.push({ at, fn });
      if (!timer) timer = setTimeout(pump, Math.max(0, q[0].at - performance.now()));
    };
  };
  const Base = globalThis.WebSocket;
  class Lagged extends Base {
    constructor(...a) {
      super(...a);
      this.__fns = [];
      this.__om = null;
      this.__in = queue([]);
      this.__out = queue([]);
      super.addEventListener("message", (ev) => {
        const data = ev.data;
        this.__in(() => {
          const e = new MessageEvent("message", { data });
          for (const fn of [...this.__fns]) {
            try {
              typeof fn === "function" ? fn.call(this, e) : fn.handleEvent(e);
            } catch (err) {
              setTimeout(() => { throw err; });
            }
          }
          if (this.__om) this.__om.call(this, e);
        });
      });
    }
    send(d) {
      if (typeof d === "string" && L.sent.length < 3000 && /"a":"(go|hold)"/.test(d)) L.sent.push([Date.now(), d.includes('"hold"') ? "hold" : "go"]);
      this.__out(() => {
        if (this.readyState === 1) super.send(d);
      });
    }
    addEventListener(type, fn, o) {
      if (type === "message") this.__fns.push(fn);
      else super.addEventListener(type, fn, o);
    }
    removeEventListener(type, fn, o) {
      if (type === "message") {
        const i = this.__fns.indexOf(fn);
        if (i >= 0) this.__fns.splice(i, 1);
      } else super.removeEventListener(type, fn, o);
    }
    set onmessage(fn) { this.__om = fn; }
    get onmessage() { return this.__om; }
  }
  globalThis.WebSocket = Lagged;
  addEventListener("pointerup", () => { if (L.ups.length < 3000) L.ups.push(Date.now()); }, true);
  setInterval(() => {
    const m = globalThis.pinchHeist;
    if (!m || !m.placed) return;
    if (!m.__lagHooked) {
      m.__lagHooked = true;
      const of = m.onFrame.bind(m);
      m.onFrame = (data, now) => {
        const hist = [...m.history, { x: m.body.x, y: m.body.y }];
        const before = m.frame;
        const r = of(data, now);
        const f = m.frame;
        if (f && f !== before) {
          let best = Infinity;
          for (const h of hist) best = Math.min(best, Math.hypot(f.me.x - h.x, f.me.y - h.y));
          L.frames.push([Date.now(), f.t, f.me.x, f.me.y, f.me.moving ? 1 : 0, +best.toFixed(3)]);
        }
        return r;
      };
    }
    L.track.push([Date.now(), +m.body.x.toFixed(3), +m.body.y.toFixed(3), m.path ? 1 : 0]);
  }, 20);
})();`;

/** In the guard's page: the phone's picture of the thief and the cone. */
const PICTURE = `(async () => {
  const S = (globalThis.__lagSight ??= await import("/game/sight.js"));
  const m = globalThis.pinchHeist;
  if (!m || !m.frame || !m.view || document.body.dataset.phase !== "heist") return null;
  const me = m.frame.me;
  const now = performance.now();
  const base = { light: me.light, cool: me.cooldown ?? 0, hold: !!me.hold || !!(m.pub && m.pub.holds && m.pub.holds.length), frozen: !!me.frozen, gx: m.body.x, gy: m.body.y, angle: m.body.angle };
  const th = m.others(now).find((o) => o.role === "thief");
  if (!th) {
    globalThis.__lagSeen = [];
    return { ...base, seen: false, in: false, soon: false };
  }
  const cone = (x, y) => S.inCone(m.body.x, m.body.y, m.body.angle, S.FLASHLIGHT_FOV, S.FLASHLIGHT_RANGE, x, y) && Math.hypot(x - m.body.x, y - m.body.y) <= 5;
  // Her velocity on this screen: over the last 150 ms of what it showed.
  const tr = (globalThis.__lagSeen ??= []);
  const t = Date.now();
  if (tr.length && tr[tr.length - 1][3] !== th.id) tr.length = 0;
  tr.push([t, th.x, th.y, th.id]);
  while (tr.length > 2 && tr[1][0] < t - 150) tr.shift();
  let vx = 0, vy = 0;
  const o = tr[0];
  if (t - o[0] > 40) {
    vx = ((th.x - o[1]) * 1000) / (t - o[0]);
    vy = ((th.y - o[2]) * 1000) / (t - o[0]);
  }
  const r = document.querySelector(".heist canvas.map").getBoundingClientRect();
  const v = m.view;
  return {
    ...base, seen: true, id: th.id, x: th.x, y: th.y, vx, vy,
    in: cone(th.x, th.y) && m.seesTile(th.x, th.y),
    soon: cone(th.x + vx * 0.15, th.y + vy * 0.15) && m.seesTile(th.x + vx * 0.15, th.y + vy * 0.15),
    sx: r.left + (th.x - v.left) * v.scale, sy: r.top + (th.y - v.top) * v.scale,
  };
})()`;

type Picture = { light: string; cool: number; hold: boolean; frozen: boolean; gx: number; gy: number; angle: number; seen: boolean; in: boolean; soon: boolean; x?: number; y?: number; sx?: number; sy?: number };

// ---------------------------------------------------------------- one game

interface Segment {
  name: string;
  delay: number;
  from: number;
  to: number;
}
interface Run {
  segments: Segment[];
  taps: number[];
  tries: { at: number; kind: "entry" | "exit" }[];
  frames: number[][];
  track: number[][];
  sent: [number, string][];
  ups: number[];
  steps: number[][];
  acts: [number, string, string, string | null][];
  ids: string[];
  notes: string[];
}

async function play(b: Browser, tunnel: boolean, plan: { name: string; delay: number }[]): Promise<Run | string> {
  waiting = `tvpipe to start${tunnel ? " (tunnel)" : ""}`;
  tvpipe = await startTvpipe({ tunnel });
  const tv = tvpipe;
  waiting = "the host page";
  const win = await hostPage(b, tv.start);
  const tabs: Tab[] = [win];
  try {
    const heistSecs = Math.ceil((APPROACH + plan.length * (SECS + 2) * 1000) / 1000) + 15;
    await win.eval(`(() => {
      pinch.game.configure({ timings: { ...pinch.FAST_TIMINGS, briefing: 3000, heist: ${heistSecs} } });
      pinch.game.maxRounds = 1;
      const L = (globalThis.__L = { steps: [], acts: [], ids: null, w: 0 });
      pinch.game.on("round", () => {
        const h = pinch.game.heist;
        h.holdTime = 1.5;
        h.times.holdImmunity = 0.5;
        L.w = h.map.w;
        const step = h.step.bind(h);
        h.step = () => {
          step();
          if (!L.ids) return;
          const th = h.peek(L.ids[0]), g = h.peek(L.ids[1]);
          if (!th || !g) return;
          const ti = Math.floor(th.y) * L.w + Math.floor(th.x);
          L.steps.push([Date.now(), +th.x.toFixed(3), +th.y.toFixed(3), +g.x.toFixed(3), +g.y.toFixed(3), Math.round(g.angle * 10) / 10, g.light, g.seen[ti] ? 1 : 0, th.frozen ? 1 : 0]);
        };
        const act = h.act.bind(h);
        h.act = (id, a) => {
          const at = Date.now();
          const r = act(id, a);
          if (a && a.a !== "aim") L.acts.push([at, id, a.a, r ?? null]);
          return r;
        };
      });
      return true;
    })()`);
    let join = await win.eval<string>(`pinch.party.links.join`);
    if (tunnel) {
      waiting = "the tunnel (30 s)";
      const end = Date.now() + 30_000;
      let up = false;
      while (Date.now() < end) {
        up = await win.eval<boolean>(`pinch.party.info.phone.mode === "tunnel"`);
        if (up) break;
        await sleep(300);
      }
      if (!up) return "the tunnel did not come up within 30 s";
      join = await win.eval<string>(`(() => { const u = pinch.party.info.phone.url; return (u.endsWith("/") ? u : u + "/") + "?r=" + pinch.party.code + "#k=" + pinch.party.joinKey; })()`);
      log(`tunnel up: ${join.replace(/#.*/, "#…")}`);
    }
    const phones: Tab[] = [];
    for (const name of NAMES) {
      const p = await b.open(join, { width: 390, height: 844, mobile: true, context: true, init: wireTap({ role: "phone" }) + "\n" + LAG_INIT });
      tabs.push(p);
      await until(p, `${name}'s join form`, `!!document.getElementById("name")`, 25_000);
      await p.eval(`document.getElementById("name").value = ${JSON.stringify(name)}; document.querySelector("form button").click(); true`);
      await until(p, `${name}'s lobby`, `document.body.dataset.phase === "lobby"`, 15_000);
      phones.push(p);
    }
    const ids = await win.eval<string[]>(`${JSON.stringify(NAMES)}.map((n) => pinch.party.players.find((p) => p.name === n).id)`);
    waiting = "the bot";
    await win.eval(`pinch.addBots(1, { names: ["Clara"], idle: "guard" }).then(() => true)`);
    await until(phones[0]!, "the bot in the lobby", `document.querySelectorAll(".chips .chip").length === 3`, 15_000);
    // A phone the thief: the bot (a guard away stands still) is away while the first thief is picked.
    await win.eval(`(() => { pinch.robots[0].close(); return true; })()`);
    await until(win, "the bot away", `pinch.party.players.some((p) => p.name === "Clara" && !p.connected)`, 10_000);
    await win.eval(`(() => { void pinch.game.play(); return true; })()`);
    await until(win, "the briefing", `pinch.game.thief !== null`, 10_000);
    const th = await win.eval<string>(`pinch.game.thief`);
    if (!ids.includes(th)) throw new Error(`the bot is the thief`);
    if (th !== ids[0]) {
      phones.reverse();
      ids.reverse();
    }
    const [anna, ben] = phones as [Tab, Tab];
    await win.eval(`__L.ids = ${JSON.stringify(ids)}; true`);
    log(`the thief: ${th === "p1" ? "Anna" : "Ben"} (the thief's phone is "anna" below)`);
    for (const [name, tab] of [["Anna", anna], ["Ben", ben]] as const) {
      await until(tab, `${name}'s heist screen`, `!!(${PHONE_STATE})`, 15_000);
    }
    log("heist");
    const st = (tab: Tab) => tab.eval<PhoneState | null>(PHONE_STATE);
    const truth = () =>
      win.eval<{ tx: number; ty: number; gx: number; gy: number; sees: boolean } | null>(`(() => {
        const h = pinch.game.heist; if (!h) return null;
        const a = h.peek(${JSON.stringify(ids[0])}), g = h.peek(${JSON.stringify(ids[1])});
        return { tx: a.x, ty: a.y, gx: g.x, gy: g.y, sees: !!g.seen[Math.floor(a.y) * h.map.w + Math.floor(a.x)] };
      })()`);
    const notes: string[] = [];
    const lightOn = async () => {
      for (let k = 0; k < 20; k++) {
        const s = await st(ben);
        if (s?.me.light === "on") return true;
        if (s?.me.light === "off" && s.tool) await tap(ben, s.tool);
        await sleep(300);
      }
      return false;
    };

    // ------------------------------------------------ to each other
    waiting = "Ben's flashlight";
    if (!(await lightOn())) notes.push("the flashlight did not come on");
    waiting = "the approach";
    const end = Date.now() + APPROACH;
    let lastTap = 0;
    let met = false;
    let thiefStopped = false;
    while (Date.now() < end) {
      const t = await truth();
      if (!t) break;
      const d = Math.hypot(t.tx - t.gx, t.ty - t.gy);
      if ((d <= 4.6 && t.sees) || d < 3) {
        met = true;
        break;
      }
      // Close by: she stops, he comes on alone (both walking, they overshoot).
      if (d < 7 && !thiefStopped) {
        thiefStopped = true;
        const s = await st(anna);
        if (s) await tap(anna, toPx(s, s.body.x, s.body.y));
      }
      if (Date.now() - lastTap > 1200) {
        lastTap = Date.now();
        for (const [tab, x, y] of [...(thiefStopped ? [] : [[anna, t.gx, t.gy] as const]), [ben, t.tx, t.ty] as const]) {
          const s = await st(tab);
          if (!s) continue;
          const p = await tapToward(tab, s, x, y);
          if (p) await tap(tab, p);
        }
      }
      await sleep(80);
    }
    for (const tab of [anna, ben]) {
      const s = await st(tab);
      if (s) await tap(tab, toPx(s, s.body.x, s.body.y));
    }
    await sleep(800);
    const t0 = await truth();
    if (!t0) throw new Error("no heist after the approach");
    log(`approach: ${met ? "met" : "not met"} at ${Math.hypot(t0.tx - t0.gx, t0.ty - t0.gy).toFixed(1)} tiles, Ben sees Anna: ${t0.sees}`);
    if (!met) notes.push("the approach did not end in sight within 20 s: holds may be few");

    // ------------------------------------------------ the beat across the cone's edge
    // A stand 3–4.5 tiles from Ben in his sight, then a short line through it she can walk straight (as long as there is room).
    const GEO = (mode: "stand" | "line", gx: number, gy: number) => `(async () => {
      const { goTo } = await import("/game/move.js");
      const S = await import("/game/sight.js");
      const m = globalThis.pinchHeist;
      const gx = ${gx}, gy = ${gy};
      const tx = m.body.x, ty = m.body.y;
      const op = m.sight && m.sight.opaque;
      const los = (x, y) => !op || S.lineOfSight(m.map, op, gx, gy, x, y);
      const walk = (x, y) => {
        const p = goTo(m.world, m.body, x, y, { locked: 0 });
        if (!p || !p.points.length) return Infinity;
        let len = 0, q = m.body;
        for (const r of p.points) { len += Math.hypot(r.x - q.x, r.y - q.y); q = r; }
        const last = p.points[p.points.length - 1];
        return Math.hypot(last.x - x, last.y - y) < 0.4 ? len : Infinity;
      };
      const base = Math.atan2(ty - gy, tx - gx);
      if (${JSON.stringify(mode)} === "stand") {
        let best = null;
        for (const r of [3.8, 3.3, 4.4, 2.9]) for (const off of [0, 20, -20, 40, -40, 60, -60, 90, -90, 120, -120, 180]) {
          const a = base + (off * Math.PI) / 180;
          const x = gx + Math.cos(a) * r, y = gy + Math.sin(a) * r;
          if (!los(x, y)) continue;
          const len = walk(x, y);
          if (len === Infinity || len > 8) continue;
          if (!best || len < best.len) best = { x, y, len };
        }
        return best;
      }
      const reach = (dx, dy) => {
        for (const k of [2.6, 2.2, 1.8, 1.4, 1, 0.6]) {
          const x = tx + dx * k, y = ty + dy * k;
          if (Math.hypot(x - gx, y - gy) > 4.8 || Math.hypot(x - gx, y - gy) < 2) continue;
          let ok = true;
          for (let j = 1; j <= 4 && ok; j++) ok = los(tx + (dx * k * j) / 4, ty + (dy * k * j) / 4);
          if (ok && walk(x, y) <= k * 1.2 + 0.2) return k;
        }
        return 0;
      };
      let best = null;
      for (const off of [90, 60, 120, 40, 140]) {
        const r = base + (off * Math.PI) / 180;
        const dx = Math.cos(r), dy = Math.sin(r);
        const ka = reach(-dx, -dy), kb = reach(dx, dy);
        if (!best || ka + kb > best.len + 0.3) best = { a: { x: tx - dx * ka, y: ty - dy * ka }, b: { x: tx + dx * kb, y: ty + dy * kb }, len: ka + kb };
      }
      return best;
    })()`;
    waiting = "the thief's stand";
    const stand = await anna.eval<{ x: number; y: number; len: number } | null>(GEO("stand", t0.gx, t0.gy));
    if (!stand) notes.push("no stand 3–4.5 tiles from the guard in his sight");
    else {
      const s = await st(anna);
      if (s) await tap(anna, toPx(s, stand.x, stand.y));
      await sleep(400);
      await until(anna, "the thief at her stand", `!globalThis.pinchHeist.path && !globalThis.pinchHeist.frame.me.moving`, 6000).catch(() => notes.push("the thief did not reach her stand"));
      await sleep(300);
    }
    const geo = (await anna.eval<{ a: { x: number; y: number }; b: { x: number; y: number }; len: number }>(GEO("line", t0.gx, t0.gy)))!;
    const t1 = (await truth())!;
    if (geo.len < 2) notes.push(`little room to walk: ${geo.len.toFixed(1)} tiles`);
    const A = geo.a;
    const B = geo.b;
    log(`beat: ${geo.len.toFixed(1)} tiles, ${Math.hypot(t1.tx - t1.gx, t1.ty - t1.gy).toFixed(1)} tiles from Ben`);
    // The cone's edge on the middle (A inside, B outside).
    const deg = (x: number, y: number) => (Math.atan2(y, x) * 180) / Math.PI;
    const diff = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;
    const M = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    const base = deg(M.x - t1.gx, M.y - t1.gy);
    const toA = diff(base, deg(A.x - t1.gx, A.y - t1.gy));
    const aimAngle = base + (toA >= 0 ? 30 : -30);
    const aim = async () => {
      const s = await st(ben);
      if (!s) return;
      const g = toPx(s, s.body.x, s.body.y);
      const r = (aimAngle * Math.PI) / 180;
      await ben.drag([0, 20, 40, 60, 80].map((k) => [g.x + Math.cos(r) * k, g.y + Math.sin(r) * k] as [number, number]));
    };
    waiting = "Ben's aim";
    let aimed = 0;
    for (let k = 0; k < 3; k++) {
      await aim();
      await sleep(400);
      aimed = await win.eval<number>(`pinch.game.heist.peek(${JSON.stringify(ids[1])}).angle`);
      if (Math.abs(diff(aimed, aimAngle)) < 4) break;
    }
    log(`aim: ${aimAngle.toFixed(0)}°, the host has ${aimed.toFixed(0)}°; the line from (${A.x.toFixed(1)},${A.y.toFixed(1)}) to (${B.x.toFixed(1)},${B.y.toFixed(1)}), Ben at (${t1.gx.toFixed(1)},${t1.gy.toFixed(1)})`);
    if (Math.abs(diff(aimed, aimAngle)) >= 4) notes.push(`the aim did not take: ${aimed.toFixed(0)}° for ${aimAngle.toFixed(0)}°`);

    const taps: number[] = [];
    const guardPolls: Record<string, number>[] = [];
    const tries: { at: number; kind: "entry" | "exit" }[] = [];
    const segments: Segment[] = [];
    for (const seg of plan) {
      waiting = `the ${seg.name} beat`;
      for (const tab of [anna, ben]) await tab.eval(`globalThis.__lag.delay = ${seg.delay}; true`);
      await sleep(seg.delay ? 1200 : 300);
      const from = Date.now();
      const to = from + SECS * 1000;
      segments.push({ name: seg.name, delay: seg.delay, from, to });
      let over = false;
      // Anna: from end to end, standing a little at each.
      const thief = (async () => {
        let next = B;
        let still = 0;
        let tapped = 0;
        while (!over && Date.now() < to) {
          const s = await st(anna).catch(() => null);
          await sleep(25);
          if (!s || s.me.frozen) {
            still = 0;
            continue;
          }
          const standing = !s.path && !s.me.moving;
          if (!standing) {
            still = 0;
            if (Date.now() - tapped < 5000) continue;
          }
          still ||= Date.now();
          if (Date.now() - still < 350 + Math.random() * 300) continue;
          const at = Math.hypot(s.body.x - next.x, s.body.y - next.y) < 0.4;
          if (at) next = next === A ? B : A;
          taps.push(Date.now());
          await tap(anna, toPx(s, next.x, next.y));
          tapped = Date.now();
          still = 0;
          await sleep(150);
        }
      })();
      // Ben: a hold when his phone shows her in the cone; entry and exit taps by turns.
      const guard = (async () => {
        let kind: "entry" | "exit" = "entry";
        let was = false;
        let wasHold = false;
        let dbg = 0;
        const polls = { n: 0, seen: 0, in: 0, ready: 0, dark: 0 };
        guardPolls.push(polls);
        while (!over && Date.now() < to) {
          const p = await ben.eval<Picture | null>(PICTURE).catch(() => null);
          if (!p) {
            await sleep(30);
            continue;
          }
          if (wasHold && !p.hold && !p.frozen) {
            await sleep(200);
            await aim();
          }
          wasHold = p.hold || p.frozen;
          if (p.light === "off") {
            await lightOn();
            continue;
          }
          const ready = p.light === "on" && !p.hold && !p.frozen && p.cool <= 0;
          polls.n++;
          if (p.seen) polls.seen++;
          if (p.in) polls.in++;
          if (ready) polls.ready++;
          if (p.light !== "on") polls.dark++;
          const go = ready && p.seen && p.in && (kind === "entry" ? !was : !p.soon);
          was = p.in;
          if (process.env["LAG_DEBUG"] && p.in && kind === "exit" && Date.now() - dbg > 400) {
            dbg = Date.now();
            log(`  exit? ${JSON.stringify(p)}`);
          }
          if (go) {
            tries.push({ at: Date.now(), kind });
            await tap(ben, { x: p.sx!, y: p.sy! });
            kind = kind === "entry" ? "exit" : "entry";
            await sleep(100);
          } else await sleep(12);
        }
      })();
      await Promise.race([Promise.all([thief, guard]), sleep(SECS * 1000 + 8000)]);
      over = true;
      log(`${seg.name}: Ben's phone polled ${JSON.stringify(guardPolls.at(-1))}`);
    }
    waiting = "the records";
    const rec = async (tab: Tab) => tab.eval<{ frames: number[][]; track: number[][]; sent: [number, string][]; ups: number[] }>(`({ frames: __lag.frames, track: __lag.track, sent: __lag.sent, ups: __lag.ups })`);
    const ra = await rec(anna);
    const host = await win.eval<{ steps: number[][]; acts: [number, string, string, string | null][] }>(`({ steps: __L.steps, acts: __L.acts })`);
    for (const [name, tab] of [["the window", win], ["Anna", anna], ["Ben", ben]] as const) {
      for (const e of tab.errors.splice(0)) notes.push(`${name}: ${e}`);
    }
    return { segments, taps, tries, frames: ra.frames, track: ra.track, sent: ra.sent, ups: ra.ups, steps: host.steps, acts: host.acts, ids, notes };
  } finally {
    waiting = "tvpipe to end";
    await win.eval(`document.getElementById("quit")?.click(); true`).catch(() => {});
    await Promise.race([tv.exited, sleep(2500)]);
    tv.proc.kill();
    tvpipe = null;
    for (const t of tabs) {
      await t.send("Page.close").catch(() => {});
      t.close();
    }
  }
}

// ---------------------------------------------------------------- the numbers

const inCone = (ox: number, oy: number, facing: number, px: number, py: number) => {
  const dx = px - ox;
  const dy = py - oy;
  const d2 = dx * dx + dy * dy;
  if (d2 > 49 + 1e-9) return false;
  if (d2 < 1e-9) return true;
  const a = (Math.atan2(dy, dx) * 180) / Math.PI;
  return Math.abs(((((facing - a) % 360) + 540) % 360) - 180) <= 30 + 1e-9;
};

interface Row {
  mode: string;
  taps: number;
  rt: number[];
  up: number[];
  snd: number[];
  input: number[];
  pred: number[];
  corr: number[];
  tries: number;
  kinds: Record<string, { n: number; ok: number }>;
  reasons: Map<string, number>;
  need: number[];
  note: string;
}

function analyse(run: Run): Row[] {
  const [thiefId, guardId] = run.ids as [string, string];
  const steps = run.steps;
  /** The host's thief position at a wall time (linear between steps). */
  const hostAt = (t: number): [number, number, boolean] | null => {
    let lo = 0;
    let hi = steps.length - 1;
    if (hi < 1 || t < steps[0]![0]! || t > steps[hi]![0]!) return null;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (steps[mid]![0]! <= t) lo = mid;
      else hi = mid;
    }
    const a = steps[lo]!;
    const b = steps[hi]!;
    const k = b[0]! > a[0]! ? (t - a[0]!) / (b[0]! - a[0]!) : 0;
    return [a[1]! + (b[1]! - a[1]!) * k, a[2]! + (b[2]! - a[2]!) * k, !!(a[8] || b[8])];
  };
  const rows: Row[] = [];
  for (const seg of run.segments) {
    const inSeg = (t: number) => t >= seg.from && t <= seg.to;
    const rt: number[] = [];
    const up: number[] = [];
    const snd: number[] = [];
    const input: number[] = [];
    for (const tapAt of run.taps.filter(inSeg)) {
      // The tap's moment: the page's pointerup (headless Chrome's own input delay apart).
      const upAt = run.ups.find((u) => u >= tapAt - 5 && u < tapAt + 1000);
      if (upAt !== undefined) input.push(upAt - tapAt);
      const at = upAt ?? tapAt;
      const before = run.frames.filter((f) => f[0]! <= at).at(-1);
      if (before) {
        const moved = run.frames.find((f) => f[0]! > at && f[0]! < at + 3000 && Math.hypot(f[2]! - before[2]!, f[3]! - before[3]!) > 0.02);
        if (moved) rt.push(moved[0]! - at);
      }
      const go = run.acts.find((a) => a[1] === thiefId && a[2] === "go" && a[0] >= at - 5 && a[0] < at + 3000);
      if (go) up.push(go[0] - at);
      const sent = run.sent.find((x) => x[1] === "go" && x[0] >= at - 5 && x[0] < at + 3000);
      if (sent) snd.push(sent[0] - at);
    }
    // Prediction while she walks (her phone has a path), not held.
    const pred: number[] = [];
    for (const s of run.track) {
      if (!inSeg(s[0]!) || !s[3]) continue;
      const h = hostAt(s[0]!);
      if (h && !h[2]) pred.push(Math.hypot(s[1]! - h[0], s[2]! - h[1]));
    }
    const corr = run.frames.filter((f) => inSeg(f[0]!) && f[4]).map((f) => f[5]!);
    // Holds: the host's answers; the window each try needed.
    const kinds: Record<string, { n: number; ok: number }> = { entry: { n: 0, ok: 0 }, exit: { n: 0, ok: 0 } };
    const reasons = new Map<string, number>();
    const need: number[] = [];
    const holds = run.acts.filter((a) => a[1] === guardId && a[2] === "hold" && inSeg(a[0]));
    const used = new Set<number>();
    let tries = 0;
    for (const t of run.tries.filter((x) => inSeg(x.at))) {
      const i = holds.findIndex((a, k) => !used.has(k) && a[0] >= t.at - 5 && a[0] < t.at + 2000);
      if (i < 0) continue;
      used.add(i);
      tries++;
      const a = holds[i]!;
      const r = a[3] ?? "ok";
      kinds[t.kind]!.n++;
      if (r === "ok") kinds[t.kind]!.ok++;
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
      if (r === "slippery" || r === "cooldown" || r === "alreadyHeld") continue;
      // How old the host's last fair moment was when the try came.
      let age = Infinity;
      for (let k = steps.length - 1; k >= 0; k--) {
        const s = steps[k]!;
        if (s[0]! > a[0]) continue;
        if (a[0] - s[0]! > 3000) break;
        const fair = s[6] === 2 && s[7] === 1 && inCone(s[3]!, s[4]!, s[5]!, s[1]!, s[2]!) && Math.hypot(s[1]! - s[3]!, s[2]! - s[4]!) <= 5;
        if (fair) {
          age = a[0] - s[0]!;
          break;
        }
      }
      need.push(age);
    }
    rows.push({ mode: seg.name, taps: run.taps.filter(inSeg).length, input, rt, up, snd, pred, corr, tries, kinds, reasons, need, note: "" });
  }
  return rows;
}

const ms = (xs: number[]) => (xs.length ? `${Math.round(quantile(xs, 0.5))}/${Math.round(quantile(xs, 0.95))}` : "–");
const tl = (xs: number[]) => (xs.length ? `${mean(xs).toFixed(2)}/${quantile(xs, 0.95).toFixed(2)}/${Math.max(...xs).toFixed(2)}` : "–");

function table(rows: Row[]): string {
  const head = ["mode", "taps", "tap→moved ms p50/p95", "tap→sent ms", "tap→host ms p50/p95", "CDP input ms", "pred. vs host, tiles mean/p95/max", "corr. at frame mean/p95/max", "holds ok (entry, exit)", "refused", "window needed ms p50/p95/max"];
  const lines = rows.map((r) => [
    r.mode,
    String(r.taps),
    ms(r.rt),
    ms(r.snd),
    ms(r.up),
    ms(r.input),
    tl(r.pred),
    tl(r.corr),
    `${r.kinds.entry!.ok}/${r.kinds.entry!.n}, ${r.kinds.exit!.ok}/${r.kinds.exit!.n}`,
    [...r.reasons].filter(([k]) => k !== "ok").map(([k, v]) => `${k} ${v}`).join(", ") || "none",
    r.need.length ? [0.5, 0.95, 1].map((q) => { const v = quantile(r.need, q); return Number.isFinite(v) ? String(Math.round(v)) : "∞"; }).join("/") : "–",
  ]);
  const all = [head, ...lines];
  const w = head.map((_, i) => Math.max(...all.map((l) => l[i]!.length)));
  return all.map((l, k) => `| ${l.map((c, i) => c.padEnd(w[i]!)).join(" | ")} |${k === 0 ? `\n|${w.map((n) => "-".repeat(n + 2)).join("|")}|` : ""}`).join("\n");
}

// ---------------------------------------------------------------- the runs

let failed = false;
const rows: Row[] = [];
const notes: string[] = [];
try {
  browser = await Browser.launch({ headed: args.headed });
  const local = [...(modes.has("local") ? [{ name: "local", delay: 0 }] : []), ...(modes.has("delay") ? [{ name: `local +${DELAY} ms`, delay: DELAY }] : [])];
  if (local.length) {
    const r = await play(browser, false, local);
    if (typeof r === "string") notes.push(r);
    else {
      rows.push(...analyse(r));
      notes.push(...r.notes.map((n) => `local: ${n}`));
    }
  }
  if (modes.has("tunnel")) {
    if (left() < 30_000 + APPROACH + SECS * 1000 + 30_000) notes.push(`tunnel: skipped, ${Math.round(left() / 1000)} s left`);
    else {
      const r = await play(browser, true, [{ name: "tunnel", delay: 0 }]);
      if (typeof r === "string") notes.push(`tunnel: skipped, ${r}`);
      else {
        rows.push(...analyse(r));
        notes.push(...r.notes.map((n) => `tunnel: ${n}`));
      }
    }
  }
} catch (err) {
  failed = true;
  log(`FAILED while waiting for ${waiting}: ${(err as Error).message}`);
} finally {
  cleanup();
}
if (rows.length) {
  console.log("\n" + table(rows));
  for (const r of rows) {
    const w = r.need.filter(Number.isFinite);
    const pass = (lim: number) => r.need.filter((x) => x <= lim).length;
    console.log(`${r.mode}: ${r.tries} tries; fair with a window of 0/100/250/400/600 ms: ${[0, 100, 250, 400, 600].map(pass).join("/")} of ${r.need.length}${w.length < r.need.length ? ` (${r.need.length - w.length} never fair within 3 s)` : ""}`);
  }
}
for (const n of notes) console.log(`note: ${n}`);
log(`${failed ? "failed" : "done"} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
process.exit(failed ? 1 : 0);
