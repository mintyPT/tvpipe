// @ts-check
/**
 * Crosstalk's TV page: tvpipe casts it with its own browser, or anyone
 * opens the watch link (the host page's preview, muted). It draws the
 * screen view (`{ roster, screen, join }`, `screen` a RoomView of
 * game/views.ts) in the room's language, as an old telephone
 * switchboard: the lobby with both teams, the room's rules, the board
 * of 25 paper labels with each team's panel (thinking, ready, guessing,
 * locked, done), both teams' cards turning together, the round's
 * catch, and at the end what was secret, by itself: the key, every clue
 * patched to its cards, both pads, the result. Players' texts are always
 * text.
 */

import { joinText, PartyClient, qrSvg } from "/_tvpipe/lib/client.js";
import { watchFit } from "../phone/fit.js";
import { pickLang } from "../phone/i18n.js";
import { strings } from "./strings.js";

/** @typedef {import("../game/views.ts").RoomView} RoomView */
/** @typedef {import("../game/views.ts").BoardCard} BoardCard */
/** @typedef {import("../game/views.ts").ClueLine} ClueLine */
/** @typedef {import("../game/rules.ts").Team} Team */
/** @typedef {import("../game/rules.ts").Color} Color */
/** @typedef {{ id: string, name: string, vip?: boolean, connected?: boolean, waiting?: boolean }} RosterEntry */
/** @typedef {{ roster?: RosterEntry[], screen?: RoomView, join?: any }} View */

/** @type {readonly Team[]} */
const TEAMS = ["red", "blue"];
const other = (/** @type {Team} */ t) => (t === "red" ? "blue" : "red");
/** A team's cards on the board. */
const TEAM_CARDS = 8;

const params = new URLSearchParams(location.hash.slice(1));
// The join badge sits in the top right corner, low and wide: every scene keeps a band at the top and leaves its right end free.
const client = PartyClient.fromLocation({ role: /** @type {any} */ (params.get("role") ?? "screen"), rejoinBadge: { corner: "top-right", layout: "row" } });
const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const statusBar = /** @type {HTMLElement} */ (document.getElementById("status"));

let lang = pickLang(undefined);
let t = strings(lang);

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------
// Helpers

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} kids
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, String(x));
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/**
 * @param {string} viewBox
 * @param {string} html the SVG's own markup (ours, never a player's)
 * @param {string} [cls]
 */
function svg(viewBox, html, cls) {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("aria-hidden", "true");
  if (cls) el.setAttribute("class", cls);
  el.innerHTML = html;
  return el;
}

/** @param {string} tag @param {Record<string, string | number>} attrs */
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** The time left until a deadline (host clock; on the TV ahead by its delay), ms. */
function left(/** @type {number} */ deadline) {
  return deadline - client.now();
}

/** A name by id (also of players who left), "" for none. @param {RoomView | undefined} s @param {string | null | undefined} id */
function nameOf(s, id) {
  if (!id) return "";
  return s?.names?.[id] ?? client.view?.["roster"]?.find((/** @type {RosterEntry} */ r) => r.id === id)?.name ?? "?";
}

/** Whether a player's phone is there. @param {string | null | undefined} id */
function isHere(id) {
  const r = /** @type {RosterEntry[] | undefined} */ (client.view?.["roster"])?.find((x) => x.id === id);
  return r ? r.connected !== false : false;
}

/** The headset of a spymaster (ours). */
const HEADSET = `<path d="M4 13v-1a8 8 0 0 1 16 0v1" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><rect x="2.5" y="12" width="5" height="7.5" rx="2" fill="currentColor"/><rect x="16.5" y="12" width="5" height="7.5" rx="2" fill="currentColor"/><path d="M19 19.5c0 1.8-2 3-5 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
const headset = () => svg("0 0 24 24", HEADSET, "headset");

// ---------------------------------------------------------------------------
// Sound: a switchboard's clicks, a bell, a thud and a buzz, all
// synthesized and light (the preview is muted: the TV plays them),
// mixed through one master gain and a compressor so nothing clips when
// sounds overlap.

const MUTED = params.get("mute") === "1";
/** @type {AudioContext | null} */
let audio = null;
/** @type {GainNode | null} */
let master = null;
function ac() {
  if (MUTED) return null;
  try {
    if (!audio) {
      const a = new AudioContext();
      const comp = a.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      const out = a.createGain();
      out.gain.value = 0.85;
      out.connect(comp).connect(a.destination);
      audio = a;
      master = out;
    }
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}
/** @param {AudioContext} a @returns {AudioNode} */
const mix = (a) => master ?? a.destination;
/** A watch page opened by hand gets its sound with the first tap. */
addEventListener("pointerdown", () => void ac(), { once: true });

/** @type {AudioBuffer | null} */
let noiseBuf = null;
function noiseBuffer(/** @type {AudioContext} */ a) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** Filtered noise: a click (high, short), a swish, a thud (low). @param {number} freq @param {number} len @param {number} [vol] @param {number} [delay] @param {number} [q] */
function burst(freq, len, vol = 0.4, delay = 0, q = 1) {
  const a = ac();
  if (!a) return;
  const at = a.currentTime + 0.02 + delay;
  const src = a.createBufferSource();
  src.buffer = noiseBuffer(a);
  const f = a.createBiquadFilter();
  f.type = freq < 600 ? "lowpass" : "bandpass";
  f.frequency.value = freq;
  f.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  src.connect(f).connect(g).connect(mix(a));
  src.start(at, Math.random());
  src.stop(at + len + 0.02);
}

/**
 * A tone with an envelope. @param {number} freq @param {number} len s
 * @param {{ type?: OscillatorType, vol?: number, delay?: number, to?: number, lp?: number, attack?: number }} [o]
 */
function tone(freq, len, o = {}) {
  const a = ac();
  if (!a) return;
  const at = a.currentTime + 0.02 + (o.delay ?? 0);
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(freq, at);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, at + len);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(o.vol ?? 0.15, at + (o.attack ?? 0.008));
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  /** @type {AudioNode} */
  let out = g;
  if (o.lp) {
    const f = a.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = o.lp;
    g.connect(f);
    out = f;
  }
  osc.connect(g);
  out.connect(mix(a));
  osc.start(at);
  osc.stop(at + len + 0.02);
}

/** A small bell (a switchboard's call bell): a sine with inharmonic partials. @param {number} freq @param {number} [delay] @param {number} [vol] */
function bell(freq, delay = 0, vol = 0.16) {
  tone(freq, 0.9, { vol, delay });
  tone(freq * 2.76, 0.35, { vol: vol * 0.35, delay });
  tone(freq * 5.4, 0.15, { vol: vol * 0.12, delay });
}

const sfx = {
  /** A jack going in: a relay's click. */
  click: (delay = 0) => {
    burst(3200, 0.025, 0.45, delay, 6);
    burst(700, 0.05, 0.25, delay + 0.01, 3);
  },
  tick: () => burst(1900, 0.035, 0.5, 0, 10),
  tock: () => burst(1300, 0.045, 0.55, 0, 10),
  ring: () => {
    bell(1046.5, 0, 0.1);
    bell(1318.5, 0.12, 0.1);
  },
  ready: () => {
    sfx.click();
    bell(1568, 0.06, 0.08);
  },
  lock: () => sfx.click(),
  /** A paper label turning over. */
  flip: () => {
    burst(2600, 0.16, 0.16, 0, 0.8);
    burst(900, 0.06, 0.3, 0.12, 2);
  },
  right: (delay = 0) => {
    bell(1174.7, delay, 0.14);
    bell(1568, delay + 0.1, 0.12);
  },
  wrong: (delay = 0) => {
    burst(160, 0.3, 0.9, delay);
    tone(120, 0.32, { to: 55, vol: 0.22, delay });
  },
  assassin: (delay = 0) => {
    burst(90, 0.8, 1, delay);
    for (const f of [55, 58.3, 110.5]) tone(f, 1.1, { type: "sawtooth", vol: 0.12, delay, lp: 900, attack: 0.02 });
    tone(220, 0.9, { type: "square", vol: 0.05, delay: delay + 0.05, to: 140, lp: 1400 });
  },
  pass: () => tone(660, 0.25, { to: 440, vol: 0.07, type: "triangle" }),
  /** The key: soft clicks, one a card. @param {number} n @param {number} gap s */
  ripple: (n, gap) => {
    for (let i = 0; i < n; i++) burst(2400 + (i % 5) * 200, 0.03, 0.18, i * gap, 8);
  },
  /** A patch cord going in. */
  plug: () => {
    burst(1800, 0.03, 0.3, 0, 5);
    tone(330, 0.12, { vol: 0.06, type: "triangle" });
  },
  page: () => burst(3400, 0.22, 0.1, 0, 0.7),
  fanfare: () => {
    const notes = [
      [523.25, 0, 0.18],
      [659.25, 0.14, 0.18],
      [783.99, 0.28, 0.18],
      [1046.5, 0.44, 0.7],
    ];
    for (const [f, d, l] of notes) {
      tone(f, l + 0.1, { type: "sawtooth", vol: 0.07, delay: d, lp: 2400, attack: 0.02 });
      tone(f * 1.005, l + 0.1, { type: "sawtooth", vol: 0.05, delay: d, lp: 1800, attack: 0.02 });
    }
    bell(2093, 0.44, 0.06);
  },
  draw: () => {
    tone(392, 0.4, { type: "triangle", vol: 0.1 });
    tone(392, 0.6, { type: "triangle", vol: 0.1, delay: 0.3 });
  },
};

// ---------------------------------------------------------------------------
// Scenes: built when the phase changes, updated on every view.

/**
 * @typedef {{ el: HTMLElement, update?: (view: View) => void, frame?: () => void, dispose?: () => void }} Scene
 */
/** @type {Scene | null} */
let scene = null;
let sceneKey = "";
/** @type {ReturnType<typeof setTimeout>[]} timers of the scene on screen */
let timers = [];
function later(/** @type {number} */ ms, /** @type {() => void} */ fn) {
  timers.push(setTimeout(fn, ms));
}

client.on("view", (view) => render(view));
client.on("status", (s) => {
  statusBar.hidden = s === "open";
  statusBar.textContent = s === "reconnecting" || s === "connecting" ? t.reconnecting : s === "closed" ? t.over : "";
});

/** @param {View} view */
function keyOf(view) {
  const phase = view.screen?.phase;
  switch (phase) {
    case "clue":
    case "guess":
    case "round":
      // One scene for the whole game: the board stays, only what is around it changes.
      return "game";
    default:
      return phase ?? "";
  }
}

/** @param {View} view */
function render(view) {
  const s = view.screen;
  const l = pickLang(s?.lang);
  const relang = l !== lang;
  if (relang) {
    lang = l;
    t = strings(l);
    document.documentElement.lang = l;
  }
  const key = keyOf(view);
  if (key !== sceneKey || relang) {
    if (sceneKey && key !== sceneKey && key !== "lobby") sfx.ring();
    sceneKey = key;
    for (const x of timers) clearTimeout(x);
    timers = [];
    const old = scene;
    old?.dispose?.();
    if (old) {
      old.el.classList.add("leaving");
      setTimeout(() => old.el.remove(), 420);
    }
    scene = build(view);
    stage.append(scene.el);
  }
  scene?.update?.(view);
  // The lobby shows the join code big: tvpipe's badge steps aside.
  client.joinVisible = !s || s.phase === "lobby";
}

function frame() {
  scene?.frame?.();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** @param {View} view @returns {Scene} */
function build(view) {
  const s = view.screen;
  switch (s?.phase) {
    case "lobby":
      return lobby();
    case "intro":
      return intro(s);
    case "clue":
    case "guess":
    case "round":
      return game(s);
    case "end":
      return end(s);
    default:
      return { el: h("div", { class: "scene lobby" }, logo()) };
  }
}

/** The name, two cords crossing behind it. */
function logo(small = false) {
  const cords = svg(
    "0 0 400 80",
    `<path class="cord red" d="M6 70 C 110 72, 150 8, 200 40 S 300 6, 394 12"/><path class="cord blue" d="M6 12 C 110 8, 150 72, 200 40 S 300 74, 394 70"/>` +
      `<circle class="plug red" cx="6" cy="70" r="6"/><circle class="plug red" cx="394" cy="12" r="6"/><circle class="plug blue" cx="6" cy="12" r="6"/><circle class="plug blue" cx="394" cy="70" r="6"/>`,
    "cords",
  );
  return h("div", { class: `logo${small ? " small" : ""}` }, cords, h("span", { class: "w" }, h("b", {}, "CROSS"), h("i", {}, "TALK")));
}

// ---------------------------------------------------------------------------
// The clock: a brass gauge whose arc runs out.

function gauge() {
  // A 270° arc, open at the bottom, with ticks.
  const ARC = "M21.7 78.3 A40 40 0 1 1 78.3 78.3";
  let ticks = "";
  for (let i = 0; i <= 10; i++) {
    const a = ((135 + i * 27) * Math.PI) / 180;
    const r1 = 46;
    const r2 = i % 5 === 0 ? 50 : 48.5;
    ticks += `<line x1="${(50 + r1 * Math.cos(a)).toFixed(1)}" y1="${(50 + r1 * Math.sin(a)).toFixed(1)}" x2="${(50 + r2 * Math.cos(a)).toFixed(1)}" y2="${(50 + r2 * Math.sin(a)).toFixed(1)}"/>`;
  }
  const dial = svg("-2 -2 104 104", `<g class="ticks">${ticks}</g><path class="track" pathLength="100" d="${ARC}"/><path class="fill" pathLength="100" d="${ARC}"/>`, "dial");
  const fill = /** @type {SVGPathElement} */ (dial.querySelector(".fill"));
  const secs = h("b", { class: "secs" });
  const sub = h("small", { class: "sub" });
  const el = h("div", { class: "gauge idle" }, dial, secs, sub);
  let shown = "";
  let ticked = -1;
  return {
    el,
    /** No clock now: a word in the middle instead. @param {string} word @param {string} [small] */
    idle(word, small = "") {
      const key = `idle|${word}|${small}`;
      if (key === shown) return;
      shown = key;
      el.classList.add("idle");
      el.classList.remove("low");
      fill.style.strokeDasharray = "0 100";
      secs.textContent = word;
      sub.textContent = small;
    },
    /** @param {number} f the share left @param {number} ms @param {string} small @param {boolean} [sound] */
    set(f, ms, small, sound = true) {
      el.classList.remove("idle");
      fill.style.strokeDasharray = `${(Math.max(0, Math.min(1, f)) * 100).toFixed(2)} 100`;
      const n = Math.max(0, Math.ceil(ms / 1000));
      const key = `${n}|${small}`;
      if (key === shown) return;
      shown = key;
      secs.textContent = String(n);
      sub.textContent = small;
      el.classList.toggle("low", ms > 0 && n <= 10);
      if (sound && ms > 0 && n <= 5 && n !== ticked) {
        ticked = n;
        (n % 2 ? sfx.tick : sfx.tock)();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The board: 25 paper labels in brass holders; a turned one shows its colour.

/**
 * @param {readonly BoardCard[]} cards
 */
function makeBoard(cards) {
  const el = h("div", { class: "board" });
  const items = cards.map((c, i) => {
    const marks = h("div", { class: "marks" });
    const front = h("div", { class: "face front" }, h("i", { class: "jack" }), h("div", { class: "word", "data-fit": "2" }, c.word));
    const back = h("div", { class: "face back" }, h("i", { class: "x" }), marks, h("div", { class: "word", "data-fit": "2" }, c.word));
    const card = h("div", { class: "card", style: { "--i": String(i), "--col": String(i % 5), "--row": String(Math.floor(i / 5)) } }, h("div", { class: "inner" }, front, back));
    el.append(card);
    return { el: card, marks, color: /** @type {Color | null} */ (null), by: "" };
  });
  return {
    el,
    items,
    /**
     * Shows card `i` turned (or not): at once, or turning over.
     * @param {number} i @param {Color | null} color @param {readonly Team[]} by @param {boolean} [animate]
     */
    set(i, color, by, animate = false) {
      const it = items[i];
      if (!it) return;
      const byKey = by.join(",");
      if (it.color === color && it.by === byKey) return;
      if (it.by !== byKey) {
        it.marks.replaceChildren(...by.map((team) => h("span", { class: `plug ${team}` }, t.team[team].slice(0, 1))));
        it.by = byKey;
      }
      if (it.color === color) return;
      it.color = color;
      for (const c of ["red", "blue", "neutral", "assassin"]) it.el.classList.toggle(`c-${c}`, c === color);
      if (!animate || reduced()) {
        it.el.classList.add("instant");
        it.el.classList.toggle("turned", !!color);
        void it.el.offsetWidth;
        requestAnimationFrame(() => it.el.classList.remove("instant"));
      } else it.el.classList.toggle("turned", !!color);
    },
  };
}

// ---------------------------------------------------------------------------
// The lobby

/** @returns {Scene} */
function lobby() {
  const qr = h("div", { class: "qr" });
  const short = h("div", { class: "short" });
  /** @type {Record<Team, { list: HTMLElement, count: HTMLElement }>} */
  const cols = /** @type {any} */ ({});
  const teamsBox = h("div", { class: "teams" });
  for (const team of TEAMS) {
    const list = h("div", { class: "names" });
    const count = h("small");
    cols[team] = { list, count };
    teamsBox.append(h("div", { class: `teamcol ${team}` }, h("div", { class: "plate" }, h("b", {}, t.team[team]), count), list));
  }
  const hint = h("p", { class: "hint" });
  const sub = h("p", { class: "subhint" }, t.switchHint);
  const badges = h("div", { class: "badges" });
  const how = h("div", { class: "how" }, ...t.how.map(([b, x], i) => h("div", {}, h("i", { class: "num" }, String(i + 1)), h("div", {}, h("b", {}, b), h("span", {}, x)))));
  const el = h(
    "div",
    { class: "scene lobby" },
    h("div", { class: "left" }, logo(), h("p", { class: "tagline" }, t.tagline), h("div", { class: "joinbox" }, h("div", { class: "qrcard" }, qr), h("div", { class: "joininfo" }, h("div", { class: "big" }, t.scanToJoin), short))),
    h("div", { class: "right" }, teamsBox, how, h("div", { class: "bottom" }, hint, sub, badges)),
  );
  let qrUrl = "";
  /** @type {Set<string>} */
  const seen = new Set();
  return {
    el,
    update(v) {
      const s = v.screen;
      if (!s) return;
      if (v.join?.url && v.join.url !== qrUrl) {
        qrUrl = v.join.url;
        qr.innerHTML = qrSvg(v.join.qr, { quiet: 2, dark: "#14171a", light: "#f2ead8" });
      }
      const text = joinText(v.join) ?? "";
      const cut = text.lastIndexOf("/") + 1;
      short.replaceChildren(h("span", { class: "or" }, t.orType), h("span", {}, text.slice(0, cut)), h("b", {}, text.slice(cut)));
      short.hidden = !text;
      const roster = v.roster ?? [];
      const byId = new Map(roster.map((r) => [r.id, r]));
      let any = false;
      for (const team of TEAMS) {
        const tv = s.teams?.[team];
        const ids = (tv?.players ?? []).filter((id) => byId.has(id));
        const spy = tv?.spymaster ?? null;
        // The spymaster on top.
        ids.sort((a, b) => Number(b === spy) - Number(a === spy));
        const rows = ids.map((id) => {
          const r = byId.get(id);
          const fresh = !seen.has(id);
          if (fresh) {
            seen.add(id);
            any = true;
          }
          return h(
            "div",
            { class: `who${r?.connected === false ? " away" : ""}${id === spy ? " spy" : ""}${fresh ? " fresh" : ""}` },
            h("i", { class: "lamp" }),
            h("span", { class: "nm", "data-fit": "1" }, r?.name ?? nameOf(s, id)),
            id === spy ? h("span", { class: "tag spy" }, headset(), t.spymaster) : null,
            r?.vip ? h("span", { class: "tag vip" }, t.vip) : null,
          );
        });
        // Free lines up to a team of three, so both columns look alive.
        for (let i = rows.length; i < 3; i++) rows.push(h("div", { class: "who empty" }, h("i", { class: "lamp" }), h("span", { class: "nm" }, t.emptySeat)));
        const key = rows.map((r) => r.className + r.textContent).join("|");
        if (cols[team].list.dataset["k"] !== key) {
          cols[team].list.dataset["k"] = key;
          cols[team].list.replaceChildren(...rows);
        }
        cols[team].count.textContent = String(ids.length);
      }
      if (any && seen.size > 0) sfx.click();
      teamsBox.classList.toggle("many", Math.max(s.teams?.red?.players.length ?? 0, s.teams?.blue?.players.length ?? 0) > 4);
      const ready = roster.filter((r) => r.connected !== false && !r.waiting).length;
      const min = s.minPlayers ?? 4;
      hint.textContent = ready < min ? t.needed(min - ready) : t.vipStarts(roster.find((r) => r.vip)?.name);
      hint.classList.toggle("ready", ready >= min);
      const b = [t.clueTime(s.clueTime), t.stepTime(s.stepTime), t.deal[s.deal] ?? "", t.difficulty[s.difficulty] ?? ""].filter(Boolean);
      const key = b.join("|");
      if (badges.dataset["k"] !== key) {
        badges.dataset["k"] = key;
        badges.replaceChildren(...b.map((x) => h("span", { class: "badge" }, x)));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The intro: the room's rules, and who is spymaster.

/** @param {RoomView} s @returns {Scene} */
function intro(s) {
  const spies = TEAMS.map((team) => {
    const nm = h("b", { "data-fit": "1" });
    return { team, nm, el: h("div", { class: `spyplate ${team}` }, h("small", {}, headset(), t.spymasterOf(team)), nm) };
  });
  const secs = h("b");
  const bar = h("i", { class: "fill" });
  const rules = t.rules.map(([b, small], i) => h("div", { class: "rule", style: { "--d": `${(0.2 + i * 0.35).toFixed(2)}s` } }, h("i", { class: "num" }, String(i + 1)), h("div", {}, h("b", {}, b), h("span", {}, small))));
  const el = h(
    "div",
    { class: "scene intro" },
    h("div", { class: "band" }, logo(true), h("h1", {}, t.rulesTitle)),
    h("div", { class: "rules" }, ...rules),
    h("div", { class: "spies" }, ...spies.map((x) => x.el)),
    h("div", { class: "countdown" }, h("span", {}, t.startsIn), h("div", { class: "bar" }, bar), secs),
  );
  let deadline = s.deadline ?? 0;
  const duration = Math.max(1, s.duration ?? 1);
  let shown = -1;
  return {
    el,
    update(v) {
      const s = v.screen;
      if (!s) return;
      deadline = s.deadline ?? deadline;
      for (const x of spies) {
        const id = s.teams?.[x.team]?.spymaster;
        x.nm.textContent = id ? nameOf(s, id) : "—";
      }
    },
    frame() {
      const ms = Math.max(0, left(deadline));
      bar.style.setProperty("--f", String(Math.min(1, ms / duration)));
      const n = Math.ceil(ms / 1000);
      if (n !== shown) {
        shown = n;
        secs.textContent = String(n);
        if (n > 0 && n <= 3) sfx.tick();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The game: the band (both teams, the round and the clock) over the board.

/**
 * A team's panel: its name and spymaster, eight lamps for its cards, its status.
 * @param {Team} team
 */
function teamPanel(team) {
  const spy = h("span", { class: "spy" });
  const found = h("span", { class: "found" });
  const lamps = Array.from({ length: TEAM_CARDS }, () => h("i", { class: "lamp" }));
  const statusLamp = h("i", { class: "lamp" });
  const statusText = h("span", { class: "text", "data-fit": "1" });
  const status = h("div", { class: "status" }, statusLamp, statusText);
  const el = h("div", { class: `panel ${team}` }, h("div", { class: "top" }, h("b", { class: "tname" }, t.team[team]), spy, found), h("div", { class: "lamps" }, ...lamps), status);
  let lit = -1;
  /** @param {string} text @param {string} mood */
  const setStatus = (text, mood) => {
    if (statusText.textContent !== text) statusText.textContent = text;
    if (status.dataset["mood"] !== mood) status.dataset["mood"] = mood;
  };
  return {
    el,
    status: setStatus,
    /** @param {RoomView} s @param {string} text @param {string} mood */
    set(s, text, mood) {
      const tv = s.teams?.[team];
      const id = tv?.spymaster ?? null;
      const nm = id ? nameOf(s, id) : "";
      const spyKey = `${nm}|${isHere(id)}`;
      if (spy.dataset["k"] !== spyKey) {
        spy.dataset["k"] = spyKey;
        spy.replaceChildren(headset(), h("span", { "data-fit": "1" }, nm));
        spy.classList.toggle("away", !!id && !isHere(id));
      }
      const n = Math.min(TEAM_CARDS, tv?.found ?? 0);
      if (n !== lit) {
        lamps.forEach((l, i) => {
          l.classList.toggle("on", i < n);
          l.classList.toggle("new", lit >= 0 && i >= lit && i < n);
        });
        lit = n;
        found.textContent = `${t.n(n)}/${t.n(TEAM_CARDS)}`;
      }
      setStatus(text, mood);
    },
  };
}

/** What a team's panel says now, and its lamp's mood. @param {RoomView} s @param {Team} team @returns {[string, string]} */
function statusOf(s, team) {
  const tv = s.teams?.[team];
  switch (tv?.status) {
    case "thinking":
      return [t.thinking(nameOf(s, tv.spymaster)), "busy"];
    case "ready":
      return [t.ready, "ok"];
    case "guessing":
      return s.open ? [t.guessing, "busy"] : [t.turning, "wait"];
    case "locked":
      return [t.locked, "ok"];
    case "done":
      return [tv.stop ? t.stop[tv.stop] : "", tv.stop === "assassin" ? "dead" : "off"];
    default:
      return s.phase === "round" ? [t.roundDone, "off"] : ["", "off"];
  }
}

/** @param {RoomView} s @returns {Scene} */
function game(s) {
  const panels = { red: teamPanel("red"), blue: teamPanel("blue") };
  const clock = gauge();
  const roundLabel = h("div", { class: "round" });
  const board = makeBoard(s.board ?? []);
  const big = h("div", { class: "bigcall" });
  const summary = h("div", { class: "summary", hidden: true });
  const flash = h("div", { class: "flash" });
  const el = h("div", { class: "scene game" }, h("div", { class: "band" }, panels.red.el, h("div", { class: "center" }, roundLabel, clock.el), panels.blue.el), board.el, big, summary, flash);
  let deadline = 0;
  let duration = 1;
  /** @type {RoomView} */
  let cur = s;
  let lastFlip = s.flip?.step ?? -1;
  /** Statuses and stops as last shown (to hear a change). @type {Record<Team, string>} */
  const was = { red: "", blue: "" };
  let first = true;
  let summaryRound = -1;
  /** Until then the panels keep what they showed before the flip (its cards are still turning). */
  let holdUntil = 0;
  let openStep = s.open ? s.step : -1;

  /** A stamp over a team's panel (the assassin's also big over the board). @param {Team} team @param {string} text @param {string} kind */
  function callout(team, text, kind) {
    const c = h("div", { class: `callout ${team} ${kind}` }, h("span", { "data-fit": "1" }, text));
    panels[team].el.append(c);
    later(2600, () => c.classList.add("gone"));
    later(3200, () => c.remove());
    if (kind === "assassin") {
      const b = h("div", { class: `callout ${team} assassin` }, text);
      big.append(b);
      later(2600, () => b.classList.add("gone"));
      later(3200, () => b.remove());
    }
  }

  /** The panels as the view has them. @param {RoomView} s */
  function showPanels(s) {
    for (const team of TEAMS) {
      const [text, mood] = statusOf(s, team);
      panels[team].set(s, text, mood);
    }
  }

  /** A flip: both teams' cards turn at the same moment. @param {RoomView} s @param {Team[]} timedOut */
  function flip(s, timedOut) {
    const fl = s.flip;
    if (!fl) return;
    const cards = [...new Set(fl.cards.map((c) => c.card))];
    const calm = reduced();
    for (const i of cards) board.items[i]?.el.classList.add("chosen");
    const turnAt = calm ? 150 : 550;
    holdUntil = performance.now() + turnAt + 700;
    later(turnAt, () => {
      for (const i of cards) {
        const bc = s.board?.[i];
        if (bc) board.set(i, bc.color, bc.by, true);
      }
      if (cards.length) sfx.flip();
    });
    later(turnAt + 650, () => {
      for (const i of cards) board.items[i]?.el.classList.remove("chosen");
      const results = fl.cards.map((c) => c.result);
      if (results.includes("assassin")) {
        sfx.assassin();
        el.classList.add("dead");
        later(1400, () => el.classList.remove("dead"));
      } else {
        if (results.includes("right")) sfx.right();
        if (results.includes("neutral") || results.includes("theirs")) sfx.wrong(results.includes("right") ? 0.25 : 0);
      }
      for (const c of fl.cards) {
        const text = c.result === "theirs" ? t.callout.theirs(c.team, other(c.team)) : t.callout[c.result](c.team);
        callout(c.team, text, c.result);
      }
      for (const team of fl.passed) callout(team, t.callout.pass(team), "pass");
      for (const team of timedOut) callout(team, s.teams?.[team]?.stop === "nobody" ? t.callout.nobody(team) : t.callout.timeout(team), "pass");
      if ((fl.passed.length || timedOut.length) && !fl.cards.length) sfx.pass();
      showPanels(cur);
    });
  }

  /** The round's catch, over the board. @param {RoomView} s */
  function showSummary(s) {
    const from = (s.step ?? 0) - (s.roundStep ?? 0);
    const rows = TEAMS.map((team) => {
      const got = (s.board ?? []).map((c, i) => ({ ...c, i })).filter((c) => c.by.includes(team) && c.at > from);
      got.sort((a, b) => a.at - b.at);
      return h(
        "div",
        { class: `row ${team}` },
        h("b", { class: "tname" }, t.team[team]),
        h("div", { class: "chips" }, ...(got.length ? got.map((c, k) => h("span", { class: `chip c-${c.color}`, style: { "--d": `${(0.3 + k * 0.12).toFixed(2)}s` } }, c.word)) : [h("span", { class: "none" }, t.nothingThisRound)])),
      );
    });
    summary.replaceChildren(h("h2", {}, t.roundOver(s.round)), ...rows);
    summary.hidden = false;
    sfx.page();
  }

  return {
    el,
    update(v) {
      const s = v.screen;
      if (!s) return;
      cur = s;
      deadline = s.deadline ?? 0;
      duration = Math.max(1, s.duration ?? 1);
      // The board: a new flip turns its cards together; anything else (a TV that came in late) at once.
      const fresh = s.flip && s.flip.step !== lastFlip && !first;
      const flipping = new Set(fresh && s.flip ? s.flip.cards.map((c) => c.card) : []);
      (s.board ?? []).forEach((c, i) => {
        if (!flipping.has(i)) board.set(i, c.color, c.by, false);
      });
      // A sound when a team gets ready or locks; who ran out of time (shown with the flip).
      /** @type {Team[]} */
      const timedOut = [];
      for (const team of TEAMS) {
        const tv = s.teams?.[team];
        const now = `${tv?.status}|${tv?.stop ?? ""}`;
        if (!first && now !== was[team]) {
          if (tv?.status === "ready") sfx.ready();
          if (tv?.status === "locked") sfx.lock();
          if (tv?.status === "done" && (tv.stop === "timeout" || tv.stop === "nobody")) timedOut.push(team);
        }
        was[team] = now;
      }
      if (s.flip) {
        if (fresh) flip(structuredClone(s), timedOut);
        lastFlip = s.flip.step;
      }
      // The panels; while a flip's cards turn they keep their lamps, and the teams that guessed are "turning".
      if (performance.now() < holdUntil) {
        for (const team of TEAMS) if (s.teams?.[team]?.status !== "done" || s.flip?.cards.some((c) => c.team === team) || s.flip?.passed.includes(team)) panels[team].status(t.turning, "wait");
      } else {
        showPanels(s);
        if (!fresh) for (const team of timedOut) callout(team, s.teams?.[team]?.stop === "nobody" ? t.callout.nobody(team) : t.callout.timeout(team), "pass");
      }
      // The next step is open: the last flip's stamps make way for the panels soon.
      if (s.open && s.step !== openStep) {
        openStep = s.step;
        const stamps = [...el.querySelectorAll(".panel .callout")];
        later(900, () => stamps.forEach((c) => c.classList.add("gone")));
      }
      el.dataset["phase"] = s.phase;
      roundLabel.textContent = t.round(s.round || 1);
      if (s.phase === "round" && summaryRound !== s.round) {
        summaryRound = s.round;
        showSummary(structuredClone(s));
      } else if (s.phase !== "round") summary.hidden = true;
      first = false;
    },
    frame() {
      const s = cur;
      const counting = (s.phase === "clue" || (s.phase === "guess" && s.open)) && deadline > 0;
      if (counting) {
        const ms = Math.max(0, left(deadline));
        clock.set(ms / duration, ms, s.phase === "clue" ? t.cluesPhase : t.step(s.roundStep || 1));
      } else if (s.phase === "guess") clock.idle("…", t.step(s.roundStep || 1));
      else clock.idle("✓", "");
    },
  };
}

// ---------------------------------------------------------------------------
// The end: the key, the clues patched to their cards, the pads, the result.

/** A RegExp source for a word as written (case is the flag's). @param {string} w */
const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A pad line with the board's words in their real colours: matched
 * whole (case-insensitive, umlauts as written), with a plural or other
 * short ending.
 * @param {string} text
 * @param {readonly { word: string, color: Color }[]} words
 */
function highlighted(text, words) {
  const span = h("span", { class: "text" });
  const list = words.filter((w) => w.word.trim()).sort((a, b) => b.word.length - a.word.length);
  if (!list.length) {
    span.textContent = text;
    return span;
  }
  const byWord = new Map(list.map((w) => [w.word.toLocaleLowerCase(lang), w.color]));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${list.map((w) => escape(w.word)).join("|")})(?:s|es|e|n|en|er|ern)?(?![\\p{L}\\p{N}])`, "giu");
  let at = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > at) span.append(text.slice(at, i));
    const color = byWord.get((m[1] ?? "").toLocaleLowerCase(lang)) ?? "neutral";
    span.append(h("mark", { class: `c-${color}` }, m[0]));
    at = i + m[0].length;
  }
  if (at < text.length) span.append(text.slice(at));
  return span;
}

/**
 * A path through points with straight runs and rounded corners (radius `r`, smaller where a run is short).
 * @param {[number, number][]} pts @param {number} r
 */
function rounded(pts, r) {
  const f = (/** @type {number} */ x) => x.toFixed(1);
  const [x0, y0] = pts[0] ?? [0, 0];
  let d = `M${f(x0)} ${f(y0)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = /** @type {[number, number]} */ (pts[i - 1]);
    const [bx, by] = /** @type {[number, number]} */ (pts[i]);
    const [cx, cy] = /** @type {[number, number]} */ (pts[i + 1]);
    const l1 = Math.hypot(bx - ax, by - ay);
    const l2 = Math.hypot(cx - bx, cy - by);
    const k = Math.min(r, l1 / 2, l2 / 2);
    if (!l1 || !l2 || !k) {
      d += ` L${f(bx)} ${f(by)}`;
      continue;
    }
    d += ` L${f(bx - ((bx - ax) / l1) * k)} ${f(by - ((by - ay) / l1) * k)} Q${f(bx)} ${f(by)} ${f(bx + ((cx - bx) / l2) * k)} ${f(by + ((cy - by) / l2) * k)}`;
  }
  const [xn, yn] = pts[pts.length - 1] ?? [0, 0];
  return `${d} L${f(xn)} ${f(yn)}`;
}

/** @param {RoomView} s @returns {Scene} */
function end(s) {
  const cards = s.board ?? [];
  const reveal = s.reveal;
  const key = reveal?.key ?? [];
  const board = makeBoard(cards);
  const boardWrap = h("div", { class: "boardwrap" }, board.el);
  const title = h("h1", { class: "title" });
  const STAGES = [t.theKey, t.theClues, t.thePads, t.theResult];
  const steps = STAGES.map((x) => h("span", { class: "stepl" }, h("i", { class: "lamp" }), x));
  const cols = { red: h("div", { class: "cluecol red" }), blue: h("div", { class: "cluecol blue" }) };
  // The cords run in the gaps between the cards, never over one.
  const cords = svg("0 0 1280 720", "", "cords");
  const pads = h("div", { class: "pads" });
  const result = h("div", { class: "result" });
  const el = h("div", { class: "scene end" }, h("div", { class: "band" }, title, h("div", { class: "steps" }, ...steps)), boardWrap, cols.red, cols.blue, cords, pads, result);
  /** @type {RoomView} */
  let cur = s;
  for (let i = 0; i < cards.length; i++) board.set(i, cards[i]?.color ?? null, cards[i]?.by ?? []);

  /** @param {number} n */
  function stageTo(n) {
    el.dataset["stage"] = String(n);
    title.textContent = STAGES[n] ?? "";
    title.classList.remove("in");
    void title.offsetWidth;
    title.classList.add("in");
    steps.forEach((x, i) => {
      x.classList.toggle("on", i <= n);
      x.classList.toggle("now", i === n);
    });
  }

  // 1. The key: every face-down card turns, in a wave; the assassin last.
  const hidden = cards.map((c, i) => (c.color ? -1 : i)).filter((i) => i >= 0 && key[i]);
  const wave = hidden.filter((i) => key[i] !== "assassin").sort((a, b) => (a % 5) + Math.floor(a / 5) - ((b % 5) + Math.floor(b / 5)) || a - b);
  const killer = hidden.find((i) => key[i] === "assassin");
  const GAP = reduced() ? 0 : 70;
  later(200, () => stageTo(0));
  wave.forEach((i, k) => later(900 + k * GAP, () => {
    board.items[i]?.el.classList.add("keyed");
    board.set(i, key[i] ?? null, [], true);
  }));
  if (wave.length) later(900, () => sfx.ripple(Math.min(wave.length, 18), GAP / 1000));
  const keyDone = 900 + wave.length * GAP + 500;
  if (killer !== undefined) {
    later(keyDone, () => {
      board.items[killer]?.el.classList.add("keyed", "doom");
      board.set(killer, "assassin", [], true);
      sfx.assassin(0.3);
    });
  }
  const t2 = keyDone + (killer !== undefined ? 1800 : 600) + 800;

  // 2. The clues, round by round, each team's in its column, patched to its cards.
  const clues = reveal?.clues ?? { red: [], blue: [] };
  const rounds = [...new Set([...clues.red, ...clues.blue].map((c) => c.round))].sort((a, b) => a - b);
  const PER_ROUND = 2400;
  const many = Math.max(clues.red.length, clues.blue.length);
  for (const team of TEAMS) {
    cols[team].classList.toggle("many", many > 5);
    cols[team].classList.toggle("lots", many > 8);
    cols[team].classList.toggle("crowd", many > 11);
    cols[team].append(h("div", { class: "colhead" }, t.team[team]));
    if (!clues[team].length) cols[team].append(h("div", { class: "none" }, t.noClues));
  }
  /** @type {{ team: Team, label: HTMLElement, line: ClueLine }[]} */
  const placed = [];
  later(t2, () => {
    board.el.classList.add("flat");
    stageTo(1);
  });
  rounds.forEach((r, k) => {
    later(t2 + 900 + k * PER_ROUND, () => {
      for (const team of TEAMS) {
        for (const line of clues[team].filter((c) => c.round === r)) {
          const jack = h("i", { class: "jack" });
          const label = h("div", { class: "clue" }, h("small", {}, t.roundShort(line.round)), h("b", { class: "cw", "data-fit": "1" }, line.word), h("span", { class: "num" }, t.n(line.number)), jack);
          cols[team].append(label);
          placed.push({ team, label, line });
          // Its cards light up while the cords go in.
          for (const c of line.cards) {
            const it = board.items[c];
            it?.el.classList.add("hit", `hit-${team}`);
            later(1800, () => it?.el.classList.remove("hit"));
          }
        }
      }
      requestAnimationFrame(() => requestAnimationFrame(() => patch(r)));
    });
  });
  const t3 = t2 + 900 + rounds.length * PER_ROUND + 1600;

  /** Every cord drawn so far (its lane). */
  let cordNo = 0;

  /**
   * Draws the cords of round `r` (older ones fade back). A cord never
   * crosses a card: from its clue's jack into the channel beside the
   * board, along it to the gap above its card's row, along that gap to
   * the card's top corner on the column's side, where it plugs in.
   * @param {number} r
   */
  function patch(r) {
    const box = el.getBoundingClientRect();
    const first = board.items[0]?.el.getBoundingClientRect();
    const last = board.items[cards.length - 1]?.el.getBoundingClientRect();
    const below = board.items[5]?.el.getBoundingClientRect();
    if (!box.width || !first || !last) return;
    const sx = 1280 / box.width;
    const sy = 720 / box.height;
    const X = (/** @type {number} */ x) => (x - box.left) * sx;
    const Y = (/** @type {number} */ y) => (y - box.top) * sy;
    // The gap between two rows, and the channels between the clue columns and the board.
    const gap = below ? Y(below.top) - Y(first.bottom) : 12;
    const colRed = cols.red.getBoundingClientRect();
    const colBlue = cols.blue.getBoundingClientRect();
    const chan = { red: (X(colRed.right) + 14 + X(first.left)) / 2, blue: (X(colBlue.left) - 14 + X(last.right)) / 2 };
    for (const old of cords.querySelectorAll("g.now")) old.classList.remove("now");
    let any = false;
    for (const p of placed.filter((x) => x.line.round === r)) {
      const j = /** @type {HTMLElement} */ (p.label.querySelector(".jack")).getBoundingClientRect();
      const x1 = X(j.left + j.width / 2);
      const y1 = Y(j.top + j.height / 2);
      p.line.cards.forEach((c, k) => {
        const cardEl = board.items[c]?.el;
        if (!cardEl) return;
        const b = cardEl.getBoundingClientRect();
        // Three lanes, so cords in one gap lie side by side.
        const lane = ((cordNo++ % 3) - 1) * Math.min(4, gap / 5);
        const side = p.team === "red" ? -1 : 1;
        const cx = chan[p.team] + lane * side;
        const gy = Y(b.top) - gap / 2 + lane;
        const px = p.team === "red" ? X(b.left + b.width * 0.16) : X(b.right - b.width * 0.16);
        const py = Y(b.top) + 1;
        const d = rounded([[x1, y1], [cx, y1], [cx, gy], [px, gy], [px, py]], Math.max(3, gap / 2 - 1));
        const right = key[c] === p.team || cards[c]?.color === p.team;
        const g = svgEl("g", { class: `cord ${p.team} now${right ? "" : " loose"}`, style: `--d:${(k * 0.25).toFixed(2)}s` });
        g.append(svgEl("path", { class: "under", d, pathLength: 100 }), svgEl("path", { class: "over", d, pathLength: 100 }), svgEl("circle", { class: "plug", cx: px.toFixed(1), cy: py.toFixed(1), r: 5 }));
        cords.append(g);
        any = true;
      });
    }
    if (any) sfx.plug();
  }

  // 3. The pads, side by side, the board's words in their colours.
  const words = cards.map((c, i) => ({ word: c.word, color: /** @type {Color} */ (key[i] ?? c.color ?? "neutral") }));
  const padLines = reveal?.pads ?? { red: [], blue: [] };
  for (const team of TEAMS) {
    const lines = padLines[team] ?? [];
    // Who wrote a line, when it is not who wrote the one above.
    const list = h("ol", { class: "lines" }, ...lines.map((l, i) => h("li", { style: { "--d": `${(0.2 + i * 0.08).toFixed(2)}s` } }, highlighted(l.text, words), l.name !== lines[i - 1]?.name ? h("small", { class: "by" }, l.name) : null)));
    if (!lines.length) list.append(h("li", { class: "none" }, t.emptyPad));
    pads.append(h("div", { class: `pad ${team}` }, h("div", { class: "padhead" }, h("b", {}, t.padOf(team))), list));
  }
  later(t3, () => {
    stageTo(2);
    sfx.page();
    requestAnimationFrame(fitPads);
  });
  const longest = Math.max(padLines.red.length, padLines.blue.length);
  const t4 = t3 + 7000 + Math.min(24, longest) * 250;

  /** Shrinks each pad's lines until they fit their sheet. */
  function fitPads() {
    for (const list of pads.querySelectorAll(".lines")) {
      const ol = /** @type {HTMLElement} */ (list);
      let size = 2.5;
      ol.style.fontSize = `${size}rem`;
      while (size > 1.1 && ol.scrollHeight > ol.clientHeight + 1) {
        size -= 0.1;
        ol.style.fontSize = `${size.toFixed(2)}rem`;
      }
    }
  }

  // 4. The result, held until the next game.
  later(t4, () => {
    stageTo(3);
    drawResult(cur);
    if (cur.winner) sfx.fanfare();
    else sfx.draw();
  });

  /** @type {Partial<Record<Team, { next: HTMLElement, players: HTMLElement }>>} */
  const live = {};
  const again = h("p", { class: "again" });
  /** @param {RoomView} s */
  function drawResult(s) {
    const w = s.winner;
    const bothAssassin = cards.some((c) => c.color === "assassin" && c.by.length >= 2);
    const head = h("div", { class: `verdict ${w ?? "none"}` }, w ? t.wins(w) : s.reason === "too-few" ? t.gameOver : t.draw);
    const why = h("p", { class: "why" }, t.reason(w, s.reason, { bothAssassin }));
    const teams = TEAMS.map((team) => {
      const found = cards.filter((c, i) => (key[i] ?? c.color) === team && c.by.length > 0).length;
      const wrong = s.teams?.[team]?.wrong ?? 0;
      const spy = reveal?.spymasters?.[team] ?? null;
      const next = h("b", { "data-fit": "1" });
      const players = h("p", { class: "players" });
      live[team] = { next, players };
      return h(
        "div",
        { class: `tcard ${team}${w === team ? " won" : ""}` },
        h("div", { class: "top" }, h("b", { class: "tname" }, t.team[team]), h("span", { class: "score" }, `${t.n(found)}/${t.n(TEAM_CARDS)}`)),
        h("div", { class: "lamps" }, ...Array.from({ length: TEAM_CARDS }, (_, i) => h("i", { class: `lamp${i < found ? " on" : ""}`, style: { "--d": `${(0.6 + i * 0.08).toFixed(2)}s` } }))),
        h("p", { class: "facts" }, t.mistakes(wrong), spy ? h("span", {}, " · ", headset(), nameOf(s, spy)) : null),
        players,
        h("div", { class: "next" }, h("small", {}, headset(), t.nextSpymaster), next),
      );
    });
    result.replaceChildren(head, why, h("div", { class: "tcards" }, ...teams), again);
    result.classList.add("in");
    updateLive(s);
  }

  /** The parts of the result that follow the phones (teams change, the next spymasters). @param {RoomView} s */
  function updateLive(s) {
    const roster = /** @type {RosterEntry[]} */ (client.view?.["roster"] ?? []);
    for (const team of TEAMS) {
      const x = live[team];
      if (!x) continue;
      const ids = s.teams?.[team]?.players ?? [];
      const key = ids.map((id) => nameOf(s, id)).join("\n");
      if (x.players.dataset["k"] !== key) {
        x.players.dataset["k"] = key;
        // Each name whole: lines break only between names.
        x.players.replaceChildren(...ids.flatMap((id, i) => [i ? " · " : "", h("span", { class: "pn" }, nameOf(s, id))]));
      }
      x.next.textContent = nameOf(s, s.next?.[team]) || "—";
    }
    again.textContent = t.playAgain(roster.find((r) => r.vip)?.name);
  }

  return {
    el,
    update(v) {
      const s = v.screen;
      if (!s) return;
      cur = s;
      updateLive(s);
    },
  };
}

watchFit();

client.connect().catch((e) => {
  stage.replaceChildren(h("div", { class: "scene lobby" }, logo(), h("p", { class: "hint" }, e?.message ?? String(e))));
});
