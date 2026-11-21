// @ts-check
/**
 * The TV harness (not shipped): the TV's renderer (../../screen/app.js)
 * with a fake clock and fake QR code, fed a scripted round (script.js).
 *
 *   (cd npm/party && npm run build)   # the library's build, for /_tvpipe/lib/
 *   python3 -m http.server -d . 8791 --bind 127.0.0.1
 *   http://127.0.0.1:8791/games/jinx/design/harness/?n=8&step=reveal&mode=warm&controls=1
 *
 * Query: n (3 or 8), step (a step name, see script.js; default: play the
 * whole script), mode (`cold`: the step's view as the first one; `warm`:
 * the step before cold, then this step and its updates), jinx, wrong,
 * pass, long, web (few, none), controls, sound, lang (`de`: German, with
 * German words), badge (`1`: tvpipe's join badge bottom left, as on the
 * real TV; `away`: grown into the rejoin card for an away player).
 */

import { createTv } from "../../screen/app.js";
import { script } from "./script.js";

const q = new URLSearchParams(location.search);
const errors = /** @type {HTMLElement} */ (document.getElementById("errors"));
/** @param {string} s */
function fail(s) {
  errors.hidden = false;
  errors.textContent += s + "\n";
}
addEventListener("error", (e) => fail(`${e.message} (${e.filename}:${e.lineno})`));
addEventListener("unhandledrejection", (e) => fail(`unhandled: ${e.reason?.stack ?? e.reason}`));
const origError = console.error;
console.error = (...a) => {
  fail(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(" "));
  origError(...a);
};

/** A fake QR code (the TV only draws what it gets). */
function fakeQr(n = 29) {
  let seed = 1234567;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows = [];
  for (let y = 0; y < n; y++) {
    let row = "";
    for (let x = 0; x < n; x++) {
      const f = (/** @type {number} */ fx, /** @type {number} */ fy) => {
        const dx = x - fx;
        const dy = y - fy;
        if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return null;
        return dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
      };
      const on = f(0, 0) ?? f(n - 7, 0) ?? f(0, n - 7) ?? r() < 0.48;
      row += on ? "1" : "0";
    }
    rows.push(row);
  }
  return { size: n, rows };
}

/** @param {any} qr @param {{ quiet?: number }} o */
function qrSvg(qr, o = {}) {
  if (!qr) return "";
  const quiet = o.quiet ?? 4;
  const n = qr.size + 2 * quiet;
  let d = "";
  qr.rows.forEach((/** @type {string} */ row, /** @type {number} */ y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "1") d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// `lang=de`: the room in German, with German words (long compounds: the fitting).
const LANG = q.get("lang") ?? "en";
/** @type {Record<string, string>} */
const GERMAN = { Volcano: "Geburtstagskuchen", VOLCANO: "GEBURTSTAGSKUCHEN", Eruption: "Feuerwehrauto", Mountain: "Weihnachtsbaum", Pompeii: "Kerzen", Magma: "Torte", Lava: "Kerze", lava: "kerze", LAVA: "KERZE", Crater: "Schneemann", Craters: "Schneemänner", Watermelonseeds: "Wassermelonenkerne", Congratulations: "Glückwunschkarte", Beacon: "Leuchtturmwärter", Refrigerator: "Kühlschranktür", Vegetable: "Gemüsesuppe" };
const join = { code: "KQZM", url: "https://tvp.link/?r=KQZM#k=3f9a2c71d0", qr: fakeQr(), lateJoin: "wait", inProgress: false };
const root = /** @type {HTMLElement} */ (document.getElementById("viewport"));
const tv = createTv({ root, now: () => Date.now(), qrSvg, muted: q.get("sound") !== "1" });
const steps = script({ n: Number(q.get("n") ?? 8), jinx: q.get("jinx") ?? "one", wrong: q.get("wrong") === "1", pass: q.get("pass") === "1", long: q.get("long") === "1", web: q.get("web") ?? "" });

// `badge`: tvpipe's own join badge (the library's build), bottom left as screen.js puts it.
const BADGE = q.get("badge");
/** @type {any} */
let badge = null;
if (BADGE) {
  const { RejoinBadge } = await import("../../../../npm/party/dist/rejoin.js");
  badge = new RejoinBadge(document, { qrSvg, joinText: () => "tvpipe.party/KQZM", now: () => Date.now() }, { corner: "bottom-left", delay: 0 });
}

/** @param {import("../../game/views.ts").ScreenView} screen */
const feed = (screen) => {
  let json = JSON.stringify(screen);
  if (LANG === "de") json = json.replace(/"([A-Za-z]+)"/g, (m, w) => (GERMAN[w] ? `"${GERMAN[w]}"` : m));
  const v = { ...JSON.parse(json), lang: LANG };
  // The badge first, as on the TV page (the client updates it before the page's view handler).
  if (badge) {
    badge.suppressed = v.phase === "lobby";
    const roster = (v.people ?? []).map((/** @type {any} */ p, /** @type {number} */ i) => ({ id: p.id, name: p.name, connected: BADGE === "away" && i === 1 ? false : true }));
    badge.update({ join: { ...join, inProgress: v.phase !== "lobby" }, roster });
  }
  tv.update({ screen: v, join });
};

/** @type {ReturnType<typeof setTimeout>[]} */
let timers = [];
/** @param {number} i @param {boolean} cold */
function show(i, cold) {
  timers.forEach(clearTimeout);
  timers = [];
  const step = steps[i];
  if (!step) return;
  if (cold) tv.cold();
  feed(step.make(Date.now()));
  for (const [ms, make] of step.then ?? []) timers.push(setTimeout(() => feed(make(Date.now())), ms));
  renderControls(i);
}

/** Plays from step i to the end, each step for its time. @param {number} i */
async function play(i) {
  for (let k = i; k < steps.length; k++) {
    show(k, false);
    const s = steps[k];
    const last = Math.max(0, ...(s?.then ?? []).map(([ms]) => ms));
    const name = s?.name ?? "";
    const hold = name.startsWith("jinx") ? 9000 : name === "verdict" ? 7000 : name.startsWith("end") ? 5500 : name === "scores" ? 5000 : 3500;
    await new Promise((r) => setTimeout(r, last + hold));
  }
}

/** @param {number} cur */
function renderControls(cur) {
  const c = /** @type {HTMLElement} */ (document.getElementById("controls"));
  c.hidden = q.get("controls") !== "1";
  if (c.hidden) return;
  c.replaceChildren(
    ...steps.map((s, i) => {
      const b = document.createElement("button");
      b.textContent = s.name;
      if (i === cur) b.className = "on";
      b.onclick = () => show(i, false);
      return b;
    }),
  );
  const cold = document.createElement("button");
  cold.textContent = "cold";
  cold.onclick = () => show(cur, true);
  c.append(cold);
}

document.fonts.ready.then(() => {
  const name = q.get("step");
  const i = name ? steps.findIndex((s) => s.name === name) : -1;
  if (i < 0) {
    if (name) fail(`no step ${name}: ${steps.map((s) => s.name).join(", ")}`);
    void play(0);
    return;
  }
  if (q.get("mode") === "warm" && i > 0) {
    // the previous step as it ended (its last update), cold, then this one
    const before = /** @type {import("./script.js").Step} */ (steps[i - 1]);
    const last = before.then?.[before.then.length - 1]?.[1] ?? before.make;
    tv.cold();
    feed(last(Date.now()));
    timers.push(setTimeout(() => show(i, false), 300));
  } else show(i, true);
});
