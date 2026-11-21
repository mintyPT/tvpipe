// @ts-check
/**
 * Krakel's TV page: tvpipe casts it with its own browser, or anyone opens
 * the watch link (the host page's preview, muted). It shows the screen
 * view (`{ roster, screen, join }`) in the room's language and animates
 * it: the lobby, everyone drawing (how much, never what), each drawing
 * redrawn stroke by stroke under a pencil while the guesses come in, its
 * word, the round's gallery with the hearts and the ranking, the scores,
 * the podium. Players' texts are always text.
 */

import { joinText, PartyClient, qrSvg } from "/_tvpipe/lib/client.js";
import { watchFit } from "../phone/fit.js";
import { num, pickLang } from "../phone/i18n.js";
import { drawInk, fit, GRID, progressAt, Replay } from "../phone/ink.js";
import { strings } from "./strings.js";

const params = new URLSearchParams(location.hash.slice(1));
// The top right corner is kept free in every scene: tvpipe's join badge goes there (the join code the whole game, and who is away).
const client = PartyClient.fromLocation({ role: /** @type {any} */ (params.get("role") ?? "screen"), rejoinBadge: { corner: "top-right" } });
const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const statusBar = /** @type {HTMLElement} */ (document.getElementById("status"));

let lang = pickLang(undefined);
let t = strings(lang);

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

/** A stable pseudo-random number in [-1, 1) for a key (tilts that do not jump between views). */
function jitter(/** @type {string} */ key) {
  let x = 2166136261;
  for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 16777619);
  return ((x >>> 0) / 4294967296) * 2 - 1;
}

const isColor = (/** @type {unknown} */ c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);

/** A player's colour: their own (`who.color`), else from the screen view (`colors`, by id), else a grey. */
function colorOf(/** @type {{ id?: string, color?: string } | null | undefined} */ who) {
  if (isColor(who?.color)) return /** @type {string} */ (who?.color);
  const c = who?.id ? client.view?.screen?.colors?.[who.id] : undefined;
  return isColor(c) ? c : "#7c8696";
}

/**
 * @param {{ id?: string, name?: string, color?: string } | null | undefined} who
 * @param {string} [size] CSS length
 */
function avatar(who, size) {
  return h("span", { class: "avatar", style: { "--c": colorOf(who), ...(size ? { "--s": size } : {}) } }, [...(who?.name ?? "?").trim()][0]?.toUpperCase() ?? "?");
}

/** The time left until a deadline (host clock), ms. */
function left(/** @type {number} */ deadline) {
  return deadline - client.now();
}

const HEART = `<path d="M12 20.5s-7.5-4.9-7.5-10.6A4.2 4.2 0 0 1 12 7.4a4.2 4.2 0 0 1 7.5 2.5c0 5.7-7.5 10.6-7.5 10.6z"/>`;
/** A pencil pointing down-left: its tip is at (0, 100) of a 100 × 100 box. */
const PENCIL = `<g transform="rotate(45 0 100)"><path class="lead" d="M0 100l-7-17h14z"/><path class="wood" d="M-7 83l-4-10h22l-4 10z"/><path class="body" d="M-11 73V10h22v63z"/><path class="band" d="M-11 10V2h22v8z"/><path class="rubber" d="M-11 2v-8a6 6 0 0 1 6-6h10a6 6 0 0 1 6 6v8z"/><path class="shine" d="M-3 68V14"/></g>`;

// ---------------------------------------------------------------------------
// Sound: a toy xylophone, a wood block and a pencil on paper, all
// synthesized (the preview is muted: the TV plays them).

const MUTED = params.get("mute") === "1";
/** @type {AudioContext | null} */
let audio = null;
function ac() {
  if (MUTED) return null;
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}

/** A mallet on a wooden bar: a sine with its fourth harmonic, a quick decay. @param {number} freq @param {number} [delay] s @param {number} [vol] */
function mallet(freq, delay = 0, vol = 0.22) {
  const a = ac();
  if (!a) return;
  const at = a.currentTime + 0.02 + delay;
  for (const [mult, v, len] of [[1, vol, 0.42], [4, vol * 0.3, 0.12], [9.2, vol * 0.08, 0.05]]) {
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = "sine";
    o.frequency.value = freq * mult;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(v, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.connect(g).connect(a.destination);
    o.start(at);
    o.stop(at + len + 0.02);
  }
}

/** A tone that slides (a boing, a whistle). @param {number} from @param {number} to @param {number} len @param {OscillatorType} [type] @param {number} [vol] @param {number} [delay] */
function slide(from, to, len, type = "triangle", vol = 0.12, delay = 0) {
  const a = ac();
  if (!a) return;
  const at = a.currentTime + 0.02 + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, at);
  o.frequency.exponentialRampToValueAtTime(to, at + len);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g).connect(a.destination);
  o.start(at);
  o.stop(at + len + 0.02);
}

/** @type {AudioBuffer | null} */
let noiseBuf = null;
function noiseBuffer(/** @type {AudioContext} */ a) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** A burst of noise through a filter: a drum (low), a wood block (mid), a swish (high). @param {number} freq @param {number} len @param {number} [vol] @param {number} [delay] @param {number} [q] */
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
  src.connect(f).connect(g).connect(a.destination);
  src.start(at, Math.random());
  src.stop(at + len + 0.02);
}

/** The pencil on paper: noise that is there while the pen is down. */
const scratch = (() => {
  /** @type {GainNode | null} */
  let gain = null;
  /** @type {BiquadFilterNode | null} */
  let filter = null;
  let on = false;
  return {
    /** @param {boolean} down @param {number} [speed] 0–1 */
    set(down, speed = 0.5) {
      if (down === on && !down) return;
      const a = ac();
      if (!a) return;
      if (!gain) {
        const src = a.createBufferSource();
        src.buffer = noiseBuffer(a);
        src.loop = true;
        filter = a.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.value = 2400;
        filter.Q.value = 0.8;
        gain = a.createGain();
        gain.gain.value = 0;
        src.connect(filter).connect(gain).connect(a.destination);
        src.start();
      }
      on = down;
      gain.gain.setTargetAtTime(down ? 0.035 + 0.05 * speed : 0, a.currentTime, 0.03);
      filter?.frequency.setTargetAtTime(1800 + 2200 * speed, a.currentTime, 0.05);
    },
  };
})();

/** A scale to climb: C major pentatonic from C5. */
const SCALE = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98, 1760];
const sfx = {
  pop: () => mallet(SCALE[2 + Math.floor(Math.random() * 4)], 0, 0.16),
  phase: () => {
    burst(2600, 0.3, 0.12);
    mallet(SCALE[0], 0.05);
    mallet(SCALE[3], 0.16);
  },
  tick: () => burst(1700, 0.04, 0.5, 0, 9),
  tock: () => burst(1200, 0.05, 0.6, 0, 9),
  /** The `n`-th right guess of a drawing (from 0): two notes, higher each time. */
  right: (/** @type {number} */ n) => {
    const i = Math.min(SCALE.length - 3, n);
    mallet(SCALE[i], 0, 0.24);
    mallet(SCALE[i + 2], 0.09, 0.24);
  },
  wrong: () => slide(330, 150, 0.22, "triangle", 0.1),
  close: () => {
    mallet(SCALE[4], 0, 0.14);
    mallet(SCALE[4], 0.1, 0.14);
  },
  go: () => {
    mallet(SCALE[0], 0);
    mallet(SCALE[2], 0.1);
    mallet(SCALE[3], 0.2);
    mallet(SCALE[5], 0.3, 0.28);
  },
  count: () => mallet(SCALE[0] / 2, 0, 0.2),
  tada: () => {
    burst(300, 0.25, 0.5);
    for (const [i, d] of [[0, 0], [2, 0.02], [3, 0.04], [5, 0.06]]) mallet(SCALE[i], 0.05 + d, 0.2);
  },
  aww: () => slide(392, 262, 0.5, "sine", 0.12),
  drum: () => {
    burst(200, 0.16, 0.8);
    burst(900, 0.05, 0.2);
  },
  roll: (/** @type {number} */ ms) => {
    for (let x = 0; x < ms; x += 55) burst(240, 0.05, 0.18 + 0.35 * (x / ms), x / 1000);
  },
  medal: (/** @type {number} */ place) => {
    const i = Math.max(0, 5 - place);
    mallet(SCALE[i], 0, 0.22);
    mallet(SCALE[i + 2], 0.1, 0.22);
    if (place === 1) mallet(SCALE[i + 4], 0.2, 0.26);
  },
  heart: () => slide(700, 1200, 0.18, "sine", 0.1),
  win: () => {
    for (const [i, d] of [[0, 0], [2, 0.14], [3, 0.28], [5, 0.42], [3, 0.6], [5, 0.72], [7, 0.84]]) mallet(SCALE[i], d, 0.24);
    burst(5000, 0.6, 0.1, 0.84);
  },
  swish: () => burst(2200, 0.3, 0.14),
};

// ---------------------------------------------------------------------------
// Scenes: built when the phase (or the drawing on stage) changes, updated on every view.

/**
 * @typedef {{ el: HTMLElement, update?: (view: any) => void, frame?: () => void, dispose?: () => void, guess?: (data: any) => void }} Scene
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
client.on("msg", (type, data) => {
  if (type === "guess") scene?.guess?.(data);
});

/** @param {any} view */
function keyOf(view) {
  const s = view.screen ?? {};
  switch (s.phase) {
    case "guess":
      return `guess:${s.round}:${s.index}`;
    case "lobby":
    case "final":
      return s.phase;
    default:
      return `${s.phase}:${s.round ?? ""}`;
  }
}

/** @param {any} view */
function render(view) {
  const s = view.screen ?? {};
  const l = pickLang(s.lang);
  const relang = l !== lang;
  if (relang) {
    lang = l;
    t = strings(l);
    document.documentElement.lang = l;
  }
  const key = keyOf(view);
  if (key !== sceneKey || relang) {
    if (sceneKey.split(":")[0] !== key.split(":")[0] && s.phase !== "lobby") sfx.phase();
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
  // tvpipe's join badge has the join code in the top right corner, but in
  // the lobby, which shows it big.
  client.joinVisible = s.phase === "lobby" || !s.phase;
}

function frame() {
  scene?.frame?.();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** @param {any} view @returns {Scene} */
function build(view) {
  const s = view.screen ?? {};
  switch (s.phase) {
    case "lobby":
      return lobby();
    case "draw":
      return draw(s);
    case "guess":
      return guess(s);
    case "gallery":
      return gallery(s);
    case "scores":
      return scores(s);
    case "final":
      return final(s);
    default:
      return { el: h("div", { class: "scene lobby" }, logo()) };
  }
}

function logo(small = false) {
  return h("div", { class: `logo${small ? " small" : ""}` }, ...[..."Krakel"].map((c, i) => h("span", { style: { "--i": String(i) } }, c)));
}

/** The round and the category, top left of a scene. @param {any} s */
function topline(s) {
  return h("div", { class: "topline" }, logo(true), h("span", { class: "chip" }, t.round(s.round ?? 1, s.rounds ?? 1)), s.category ? h("span", { class: "chip cat" }, h("small", {}, t.category), s.category) : null);
}

/**
 * The clock: a pencil that gets shorter, with the seconds beside it.
 * `set(f, ms)`: the share that is left, and the time.
 */
function pencilClock() {
  const secs = h("span", { class: "secs" });
  const pencil = h("div", { class: "pencil" }, h("i", { class: "rubber" }), h("i", { class: "band" }), h("i", { class: "body" }), h("i", { class: "wood" }), h("i", { class: "lead" }));
  const el = h("div", { class: "clock" }, pencil, secs);
  let shown = -1;
  let ticked = -1;
  return {
    el,
    /** @param {number} f @param {number} ms @param {boolean} [sound] */
    set(f, ms, sound = true) {
      pencil.style.setProperty("--f", String(Math.max(0, Math.min(1, f))));
      const n = Math.max(0, Math.ceil(ms / 1000));
      if (n === shown) return;
      shown = n;
      secs.textContent = String(n);
      const low = ms > 0 && ms <= 10_000;
      el.classList.toggle("low", low);
      // The last five seconds tick.
      if (sound && ms > 0 && n <= 5 && n !== ticked) {
        ticked = n;
        (n % 2 ? sfx.tick : sfx.tock)();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The lobby

/** @returns {Scene} */
function lobby() {
  const tags = h("div", { class: "tags" });
  const count = h("small");
  const hint = h("p", { class: "hint" });
  const badges = h("div", { class: "badges" });
  const qr = h("div", { class: "qr" });
  // The short link to type (tvpipe.party/BCDF), when there is one; else only the QR code.
  const short = h("div", { class: "short" });
  const how = h("div", { class: "how" }, ...t.how.map(([b, s], i) => h("div", { class: "card", style: { "--r": `${(jitter(`how${i}`) * 2).toFixed(1)}deg` } }, h("b", {}, h("i", {}, `${i + 1}`), b), h("span", {}, s))));
  const el = h(
    "div",
    { class: "scene lobby" },
    h("div", { class: "left" }, logo(), h("p", { class: "tagline" }, t.tagline), h("div", { class: "joinbox" }, h("div", { class: "card qrcard" }, qr), h("div", { class: "joininfo" }, h("div", { class: "big" }, t.scanToJoin), short))),
    h("div", { class: "right" }, h("h2", {}, t.players, count), tags, hint, h("div", { class: "bottom" }, how, badges)),
    h("div", { class: "doodle" }, svg("0 -20 140 140", PENCIL)),
  );
  /** @type {Map<string, HTMLElement>} */
  const shown = new Map();
  let qrUrl = "";
  return {
    el,
    update(v) {
      const s = v.screen ?? {};
      if (v.join?.url && v.join.url !== qrUrl) {
        qrUrl = v.join.url;
        qr.innerHTML = qrSvg(v.join.qr, { quiet: 2 });
      }
      const text = joinText(v.join);
      const cut = (text ?? "").lastIndexOf("/") + 1;
      short.replaceChildren(h("span", {}, (text ?? "").slice(0, cut)), h("b", {}, (text ?? "").slice(cut)));
      short.hidden = !text;
      const roster = /** @type {any[]} */ (v.roster ?? []);
      const max = s.maxPlayers ?? 10;
      const min = s.minPlayers ?? 3;
      count.textContent = `${roster.length} / ${max}`;
      /** @type {HTMLElement[]} */
      const kids = [];
      for (const r of roster) {
        let tag = shown.get(r.id);
        if (!tag) {
          tag = h("div", { class: "tag", style: { "--r": `${(jitter(r.id) * 3).toFixed(1)}deg` } });
          shown.set(r.id, tag);
          sfx.pop();
        }
        tag.replaceChildren(avatar(r, "4.4rem"), h("span", { class: "nm" }, r.name), r.vip ? h("span", { class: "vip" }, "VIP") : "");
        tag.classList.toggle("away", !r.connected);
        kids.push(tag);
      }
      for (const id of [...shown.keys()]) if (!roster.some((r) => r.id === id)) shown.delete(id);
      for (let i = roster.length; i < Math.max(min, Math.min(6, max)); i++) {
        const label = i < min ? t.waitingSeat : t.freeSeat;
        const old = /** @type {HTMLElement | undefined} */ ([...tags.children].find((e) => e.classList.contains("empty") && !kids.includes(/** @type {HTMLElement} */ (e)) && e.textContent === label));
        kids.push(old ?? h("div", { class: "tag empty" }, label));
      }
      // Only what changed moves: a tag taken out and put back would pop in again.
      kids.forEach((k, i) => {
        if (tags.children[i] !== k) tags.insertBefore(k, tags.children[i] ?? null);
      });
      while (tags.children.length > kids.length) tags.lastElementChild?.remove();
      tags.classList.toggle("many", kids.length > 6);
      const ready = roster.filter((r) => r.connected).length;
      hint.textContent = ready < min ? t.needed(min - ready) : t.vipStarts(roster.find((r) => r.vip)?.name);
      hint.classList.toggle("ready", ready >= min);
      const b = [t.rounds(s.rounds ?? 2), s.mixed ? t.modeMixed : t.modeCategory, t.drawTime(s.drawTime ?? 120), t.guessTime(s.guessTime ?? 45), s.hints === false ? t.hintsOff : t.hintsOn, t.lockout(s.lockout ?? 0)];
      const key = b.join("|");
      if (badges.dataset["k"] !== key) {
        badges.dataset["k"] = key;
        badges.replaceChildren(...b.map((x) => h("span", { class: "badge" }, x)));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Drawing: the category, and how much everyone drew (never what)

/** A scribble that grows with the ink (pathLength 100). */
const SCRIBBLE = "M12 62c6-22 20-38 30-30s-14 34-4 38 22-40 34-34-12 30-2 34 20-24 26-18-6 20 2 22";

/** How many points fill a player's scribble. */
const INK_FULL = 900;

/** @param {any} s @returns {Scene} */
function draw(s) {
  const players = /** @type {{ id: string, name: string }[]} */ (s.players ?? []);
  const clock = pencilClock();
  const tip = h("p", { class: "tip" });
  const count = h("span", { class: "count" });
  const cards = players.map((p, i) => {
    const sc = svg("0 0 110 100", `<path pathLength="100" d="${SCRIBBLE}"/>`, "scribble");
    const el = h("div", { class: "easel", style: { "--c": colorOf(p), "--r": `${(jitter(`e${p.id}`) * 3).toFixed(1)}deg`, "--d": `${(0.15 + i * 0.07).toFixed(2)}s` } }, h("div", { class: "pad" }, sc, h("span", { class: "check" }, "✓")), h("div", { class: "who" }, avatar(p, "3.4rem"), h("span", {}, p.name)));
    return { id: p.id, el, path: /** @type {SVGPathElement} */ (sc.firstChild) };
  });
  const el = h(
    "div",
    { class: `scene draw${players.length > 5 ? " crowd" : ""}` },
    topline({ ...s, category: null }),
    // A mixed round has no category of its own: everyone's word is from another one.
    ((/** @type {string} */ title, /** @type {boolean} */ mixed) =>
      h("div", { class: "catbox" }, h("div", { class: "kicker" }, mixed ? t.mixedKicker : t.category), h("div", { class: `cat${mixed ? " mixed" : ""}${[...title].length > 16 ? " long" : ""}`, "data-fit": "1" }, title), h("div", { class: "sub" }, mixed ? t.everyoneDrawsMixed : t.everyoneDraws)))(
      typeof s.category === "string" && s.category ? s.category : t.mixed,
      !s.category,
    ),
    h("div", { class: `easels${players.length > 5 ? " two" : ""}`, style: { "--cols": String(Math.ceil(players.length / 2)) } }, ...cards.map((c) => c.el)),
    tip,
    h("div", { class: "clockrow" }, clock.el, count),
  );
  let deadline = s.deadline ?? 0;
  const duration = Math.max(1, s.duration ?? 1);
  let tipNo = -1;
  /** @type {Set<string>} */
  let done = new Set();
  return {
    el,
    update(v) {
      const s = v.screen ?? {};
      deadline = s.deadline ?? deadline;
      const now = new Set(/** @type {string[]} */ (s.done ?? []));
      const ink = s.ink ?? {};
      for (const c of cards) {
        const d = now.has(c.id);
        if (d && !done.has(c.id)) sfx.pop();
        c.el.classList.toggle("done", d);
        const f = d ? 1 : Math.min(1, (ink[c.id] ?? 0) / INK_FULL);
        c.path.style.strokeDashoffset = String(100 - f * 100);
        c.el.classList.toggle("busy", !d && f > 0);
      }
      done = now;
      count.textContent = t.doneCount(done.size, players.length);
    },
    frame() {
      const ms = Math.max(0, left(deadline));
      clock.set(ms / duration, ms);
      // Another tip every ten seconds.
      const n = Math.floor((duration - ms) / 10_000) % t.tips.length;
      if (n !== tipNo) {
        tipNo = n;
        tip.textContent = t.tips[n];
        tip.style.animation = "none";
        void tip.offsetWidth;
        tip.style.animation = "";
      }
    },
  };
}

// ---------------------------------------------------------------------------
// A drawing on stage: its replay under the pencil, the guesses beside it, its word

/**
 * The word's letters as blanks; with the word (the reveal), the letters on them.
 * @param {string} shape @param {string} [word]
 */
function blanks(shape, word) {
  const box = h("div", { class: "blanks", "data-fit": "w" });
  const letters = word && [...word.normalize("NFC")].length === [...shape].length ? [...word.normalize("NFC")] : null;
  let n = 0;
  for (const part of shape.split(" ")) {
    const w = h("span", { class: "w" });
    for (const c of part) {
      w.append(c !== "_" ? h("b", {}, c) : letters ? h("i", { class: "l", style: { "--d": `${(0.25 + n * 0.05).toFixed(2)}s` } }, letters[n] ?? "") : h("i"));
      n++;
    }
    n++;
    box.append(w);
  }
  return box;
}

/** @param {any} s @returns {Scene} */
function guess(s) {
  // A copy: the client patches its view in place, and the next drawing would overwrite this one.
  const drawing = structuredClone(s.drawing ?? { strokes: [] });
  const start = s.start ?? 0;
  const end = s.end ?? 0;
  const guessers = /** @type {{ id: string, name: string }[]} */ (s.guessers ?? []);
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas"));
  const pencil = h("div", { class: "pen", hidden: "" }, svg("0 -20 140 140", PENCIL));
  const cover = h("div", { class: "cover" }, h("small", {}, t.next), h("div", { class: "nm" }, avatar(s.artist, "7rem"), h("span", {}, t.krakelOf(s.artist?.name ?? ""))), h("b", { class: "n" }));
  const banner = h("div", { class: "word", hidden: "" });
  const sheet = h("div", { class: "sheet", style: { "--r": `${(jitter(`s${s.round}:${s.index}`) * 1.2).toFixed(1)}deg` } }, canvas, pencil, cover, banner);
  const clock = pencilClock();
  const title = h("div", { class: "title" }, avatar(s.artist, "5.6rem"), h("div", {}, h("b", {}, t.krakelOf(s.artist?.name ?? "")), h("span", {}, t.whatIsIt)));
  const verdict = h("div", { class: "verdict", hidden: "" });
  const rows = new Map(
    guessers.map((p, i) => {
      const bubble = h("span", { class: "bubble", hidden: "" });
      const pts = h("span", { class: "pts" });
      const el = h("div", { class: "row", style: { "--d": `${(0.2 + i * 0.05).toFixed(2)}s`, order: String(100 + i) } }, avatar(p, "4.2rem"), h("span", { class: "nm" }, p.name), bubble, pts);
      return [p.id, { el, bubble, pts, timer: /** @type {ReturnType<typeof setTimeout> | 0} */ (0) }];
    }),
  );
  const list = h("div", { class: `guessers${guessers.length > 5 ? " many" : ""}` }, ...[...rows.values()].map((r) => r.el));
  const el = h(
    "div",
    { class: "scene guess" },
    h("div", { class: "topline" }, logo(true), h("span", { class: "chip" }, t.round(s.round ?? 1, s.rounds ?? 1)), h("span", { class: "chip cat" }, h("small", {}, t.category), s.category ?? ""), h("span", { class: "chip dark" }, t.drawing(s.index ?? 1, s.of ?? 1))),
    h("div", { class: "sheetwrap" }, sheet),
    h("div", { class: "panel" }, title, s.shape ? h("div", { class: "blankbox" }, blanks(s.shape)) : null, clock.el, list, verdict),
  );
  const replay = new Replay(canvas, drawing);
  let got = 0;
  let stageNow = "guess";
  let lastP = -1;
  let countdown = -1;
  /** @type {[number, number] | null} */
  let lastTip = null;
  let lastAt = 0;

  /** The reveal: the word on the sheet, what the drawing paid. @param {any} s @param {boolean} animate */
  const reveal = (s, animate) => {
    stageNow = "reveal";
    scratch.set(false);
    pencil.hidden = true;
    cover.hidden = true;
    replay.draw(1);
    banner.replaceChildren(h("small", {}, t.itIs), h("b", { "data-fit": "1" }, s.word ?? ""));
    banner.hidden = false;
    if (s.shape && typeof s.word === "string") el.querySelector(".blankbox")?.replaceChildren(blanks(s.shape, s.word));
    const n = (s.got ?? []).length;
    verdict.replaceChildren(h("span", {}, n === 0 ? t.nobody : n === guessers.length ? t.everybody : t.some(n, guessers.length)), ...(n > 0 ? [h("b", {}, `+${num(lang, s.points ?? 0)}`, h("small", {}, t.forArtist(s.artist?.name ?? "")))] : []));
    verdict.hidden = false;
    el.classList.add("revealed");
    for (const r of rows.values()) if (!r.el.classList.contains("got")) r.el.classList.add("missed");
    if (animate) (n > 0 ? sfx.tada : sfx.aww)();
  };

  return {
    el,
    update(v) {
      const s = v.screen ?? {};
      const list = /** @type {{ id: string, points: number, first: boolean }[]} */ (s.got ?? []);
      list.forEach((g, i) => {
        const r = rows.get(g.id);
        if (!r) return;
        r.pts.replaceChildren(g.first ? h("em", {}, t.first) : "", `+${num(lang, g.points)}`);
        r.el.style.order = String(i);
        if (r.el.classList.contains("got")) return;
        r.el.classList.add("got");
        r.bubble.hidden = true;
        // A TV that joins late shows what was there at once.
        if (lastP >= 0 && stageNow === "guess") sfx.right(i);
      });
      got = list.length;
      if (s.stage === "reveal" && stageNow !== "reveal") reveal(s, lastP >= 0);
    },
    guess(data) {
      const r = rows.get(data?.id);
      if (!r || r.el.classList.contains("got") || stageNow !== "guess") return;
      const close = data.close === true;
      r.bubble.textContent = close ? t.close : typeof data.text === "string" ? data.text : "…";
      r.bubble.className = `bubble${close ? " close" : ""}`;
      r.bubble.hidden = false;
      r.bubble.style.animation = "none";
      void r.bubble.offsetWidth;
      r.bubble.style.animation = "";
      if (r.timer) clearTimeout(r.timer);
      r.timer = setTimeout(() => r.bubble.classList.add("old"), 3500);
      (close ? sfx.close : sfx.wrong)();
    },
    frame() {
      if (stageNow !== "guess") return;
      const now = client.now();
      // The count-in.
      if (now < start) {
        const n = Math.ceil((start - now) / 1000);
        if (n !== countdown) {
          countdown = n;
          const b = /** @type {HTMLElement} */ (cover.querySelector(".n"));
          b.textContent = n <= 3 ? String(n) : "";
          b.style.animation = "none";
          void b.offsetWidth;
          b.style.animation = "";
          if (n <= 3) sfx.count();
        }
      } else if (!cover.hidden) {
        cover.hidden = true;
        sfx.go();
      }
      const p = progressAt(now, start, end);
      if (p !== lastP || replay.done < 0) {
        const first = lastP < 0;
        lastP = p;
        const c = replay.draw(p);
        if (c.tip) {
          const k = replay.size / GRID;
          pencil.hidden = false;
          pencil.style.transform = `translate(${(c.tip[0] * k).toFixed(1)}px, ${(c.tip[1] * k).toFixed(1)}px)`;
          pencil.classList.toggle("up", !c.down);
          // Faster strokes sound brighter.
          const t1 = performance.now();
          const speed = lastTip && t1 > lastAt ? Math.hypot(c.tip[0] - lastTip[0], c.tip[1] - lastTip[1]) / (t1 - lastAt) : 0;
          scratch.set(c.down && !first, Math.min(1, speed / 1.2));
          lastTip = c.tip;
          lastAt = t1;
        } else {
          pencil.hidden = true;
          scratch.set(false);
        }
      }
      const ms = Math.max(0, end - now);
      clock.set(now < start ? 1 : ms / Math.max(1, end - start), now < start ? end - start : ms, got < guessers.length);
    },
    dispose() {
      scratch.set(false);
      for (const r of rows.values()) if (r.timer) clearTimeout(r.timer);
    },
  };
}

// ---------------------------------------------------------------------------
// The gallery: the round's drawings, the hearts, the ranking

/**
 * Tiles for `n` pictures in a box (px): the largest square that fits.
 * @param {number} n @param {number} w @param {number} hgt @param {number} gap @param {number} extra the label under each
 */
function tiles(n, w, hgt, gap, extra) {
  let best = { cols: 1, size: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const size = Math.min((w - gap * (cols - 1)) / cols, (hgt - gap * (rows - 1) - extra * rows) / rows);
    if (size > best.size) best = { cols, size };
  }
  return best;
}

/** Counts a number up in an element. @param {HTMLElement} el @param {number} from @param {number} to @param {number} delay @param {string} [prefix] */
function countUp(el, from, to, delay, prefix = "") {
  el.textContent = prefix + num(lang, from);
  later(delay, () => {
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / 1000);
      el.textContent = prefix + num(lang, Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** @param {any} s @returns {Scene} */
function gallery(s) {
  const entries = /** @type {any[]} */ (structuredClone(s.gallery ?? []));
  const rem = window.innerHeight / 72;
  const { cols, size } = tiles(entries.length, 118 * rem, 46 * rem, 2.6 * rem, 6.6 * rem);
  const made = entries.map((e, i) => {
    const c = /** @type {HTMLCanvasElement} */ (h("canvas"));
    const medal = h("span", { class: "medal" });
    const pts = h("span", { class: "pts" });
    const hearts = h("span", { class: "hearts" });
    const had = h("span", { class: "had" });
    const fav = h("span", { class: "fav" }, t.favourite);
    const el = h(
      "div",
      { class: "tile", style: { "--d": `${(i * 0.07).toFixed(2)}s`, "--r": `${(jitter(`t${e.id}`) * 1.8).toFixed(1)}deg`, width: `${Math.floor(size)}px` } },
      h("div", { class: "art" }, c, medal, hearts, h("span", { class: "price" }, pts, had)),
      h("div", { class: "cap" }, h("b", { "data-fit": "1" }, e.word ?? ""), h("span", { class: "by" }, avatar(e.artist, "2.6rem"), h("span", {}, e.artist?.name ?? ""))),
    );
    requestAnimationFrame(() => {
      const f = fit(c);
      drawInk(f.ctx, e.drawing, 0, 0, f.size);
    });
    return { id: e.id, el, medal, pts, hearts, had, fav };
  });
  const grid = h("div", { class: `tiles${size < 19 * rem ? " dense" : ""}`, style: { "grid-template-columns": `repeat(${cols}, ${Math.floor(size)}px)` } }, ...made.map((m) => m.el));
  const title = h("h1");
  const help = h("p", { class: "help" });
  const voters = /** @type {any[]} */ (s.voters ?? []);
  const dots = h("div", { class: "voters" }, ...voters.map((p) => h("span", { class: "voter", "data-id": p.id }, avatar(p, "4.4rem"), h("span", { class: "hrt" }, svg("0 0 24 24", HEART)))));
  const count = h("div", { class: "sub" });
  const clock = pencilClock();
  const foot = h("div", { class: "foot" }, dots, count, clock.el);
  const el = h("div", { class: "scene gallery" }, topline(s), h("div", { class: "head" }, title, help), grid, foot);
  let stageNow = "";
  let done = 0;
  const deadline = s.deadline ?? 0;
  const duration = Math.max(1, s.duration ?? 1);

  /** The ranking: the tiles move into their places, the medals come from the last to the first. @param {any} s @param {boolean} animate */
  const rank = (s, animate) => {
    const ranking = /** @type {any[]} */ (s.ranking ?? []);
    title.textContent = t.rankedTitle;
    help.textContent = t.rankedHelp;
    foot.hidden = true;
    el.classList.add("ranked");
    // FLIP: where the tiles are, the new order, then glide.
    const before = new Map(made.map((m) => [m.id, m.el.getBoundingClientRect()]));
    const order = ranking.map((r) => made.find((m) => m.id === r.id)).filter((m) => !!m);
    for (const m of order) grid.append(/** @type {any} */ (m).el);
    for (const m of made) {
      const a = before.get(m.id);
      const b = m.el.getBoundingClientRect();
      if (!a || !animate) continue;
      m.el.style.animation = "none";
      m.el.style.transition = "none";
      m.el.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px) rotate(var(--r))`;
    }
    if (animate) {
      void grid.offsetWidth;
      for (const m of made) {
        m.el.style.transition = "transform .9s cubic-bezier(.5, 0, .2, 1)";
        m.el.style.transform = "";
      }
      sfx.swish();
    }
    // The medals: from the last place to the first, a beat each.
    const step = animate ? Math.min(900, 5200 / Math.max(1, ranking.length)) : 0;
    [...ranking].reverse().forEach((r, i) => {
      const m = made.find((x) => x.id === r.id);
      if (!m) return;
      const show = () => {
        m.medal.textContent = String(r.place);
        m.el.classList.add("placed", `p${Math.min(4, r.place)}`);
        m.had.textContent = t.had(r.got ?? 0, r.of ?? 0);
        if (animate) countUp(m.pts, 0, r.points ?? 0, 0, "+");
        else m.pts.textContent = `+${num(lang, r.points ?? 0)}`;
        if (r.hearts > 0) m.hearts.replaceChildren(svg("0 0 24 24", HEART), String(r.hearts), ...(r.fav > 0 ? [m.fav] : []));
        if (r.fav > 0) m.el.classList.add("favourite");
        if (animate) {
          sfx.medal(r.place);
          if (r.place === 1 && i === ranking.length - 1) later(300, () => el.append(confetti(50)));
        }
      };
      if (animate) later(1100 + i * step, show);
      else show();
    });
  };

  return {
    el,
    update(v) {
      const s = v.screen ?? {};
      if (s.stage === "vote" && stageNow !== "vote") {
        title.textContent = t.heartTitle;
        help.textContent = t.heartHelp;
      }
      if (s.stage === "vote") {
        const set = new Set(/** @type {string[]} */ (s.done ?? []));
        for (const d of dots.querySelectorAll(".voter")) d.classList.toggle("done", set.has(/** @type {HTMLElement} */ (d).dataset["id"] ?? ""));
        if (set.size > done) sfx.heart();
        done = set.size;
        count.textContent = t.voted(set.size, voters.length);
      }
      if (s.stage === "ranked" && stageNow !== "ranked") {
        const late = stageNow === "";
        requestAnimationFrame(() => rank(s, !late));
      }
      stageNow = s.stage ?? stageNow;
    },
    frame() {
      if (stageNow !== "vote") return;
      const ms = Math.max(0, left(deadline));
      clock.set(ms / duration, ms, done < voters.length);
    },
  };
}

/** Paper confetti. */
function confetti(n = 70) {
  const box = h("div", { class: "confetti" });
  const colors = ["#ff5d8f", "#2f6fed", "#12b892", "#fffdf5", "#8a47c2", "#ff7b25"];
  for (let i = 0; i < n; i++) {
    box.append(
      h("i", {
        style: {
          left: `${Math.random() * 100}%`,
          "--c": colors[i % colors.length],
          "--t": `${2.4 + Math.random() * 2}s`,
          "--d": `${Math.random() * 0.8}s`,
          "--x": `${(Math.random() - 0.5) * 30}vw`,
          "--spin": `${(Math.random() - 0.5) * 1440}deg`,
        },
      }),
    );
  }
  return box;
}

// ---------------------------------------------------------------------------
// Scores and the end

/** @param {any} s @returns {Scene} */
function scores(s) {
  const lines = /** @type {any[]} */ (s.lines ?? []);
  const board = h("div", { class: `board${lines.length > 6 ? " many" : ""}` });
  const top = Math.max(1, ...lines.map((l) => l.score ?? 0));
  let rank = 0;
  let last = Number.NaN;
  lines.forEach((l, i) => {
    if (l.score !== last) rank = i + 1;
    last = l.score;
    const pts = h("b");
    const e = l.earned ?? {};
    const gains = /** @type {const} */ (["drawn", "guessed", "first", "favourite"]).filter((k) => e[k] > 0).map((k) => h("span", { class: `gain ${k}` }, `${t.kinds[k]} +${num(lang, e[k])}`));
    const bar = h("i", { class: "bar", style: { "--c": colorOf(l), "--w": `${((l.score - (l.delta ?? 0)) / top) * 100}%` } });
    board.append(h("div", { class: "row", style: { "--d": `${(0.1 + i * 0.08).toFixed(2)}s` } }, h("span", { class: "rk" }, String(rank)), avatar(l, "5rem"), h("span", { class: "nm" }, l.name), h("span", { class: "mid" }, bar, h("span", { class: "gains" }, ...gains)), h("span", { class: "pts" }, pts)));
    countUp(pts, l.score - (l.delta ?? 0), l.score, 700 + i * 80);
    later(700 + i * 80, () => bar.style.setProperty("--w", `${(l.score / top) * 100}%`));
  });
  later(700, sfx.swish);
  const el = h("div", { class: "scene scores" }, topline({ ...s, category: null }), h("h1", {}, t.scoresTitle, h("small", {}, t.scoresAfter(s.round ?? 1, s.rounds ?? 1))), board);
  return { el };
}

/** @param {any} s @returns {Scene} */
function final(s) {
  const lines = /** @type {any[]} */ (s.lines ?? []);
  const order = [1, 0, 2].filter((i) => lines[i]);
  const podium = h(
    "div",
    { class: "podium" },
    ...order.map((i) => {
      const l = lines[i];
      return h("div", { class: `step p${i + 1}`, style: { "--d": `${[1.5, 0.9, 0.3][i]}s` } }, avatar(l, "8.4rem"), h("div", { class: "nm" }, l.name), h("div", { class: "block" }, h("b", {}, String(i + 1)), h("span", {}, num(lang, l.score))));
    }),
  );
  const rest = h("div", { class: "rest" }, ...lines.slice(3).map((l, i) => h("span", {}, `${i + 4}. ${l.name} · ${num(lang, l.score)}`)));
  const best = s.best;
  const c = /** @type {HTMLCanvasElement} */ (h("canvas"));
  const side = h(
    "div",
    { class: "awards" },
    best ? h("div", { class: "award" }, h("h2", {}, t.bestTitle), h("div", { class: "sheet", style: { "--r": "2deg" } }, c), h("div", { class: "cap" }, h("b", { "data-fit": "1" }, best.word ?? ""), h("span", {}, avatar(best.artist, "3rem"), t.bestBy(best.artist?.name ?? "")))) : null,
    s.eye ? h("div", { class: "eye" }, h("small", {}, t.eyeTitle), avatar(s.eye.who, "3.6rem"), h("b", {}, s.eye.who?.name ?? ""), h("span", {}, `${num(lang, s.eye.points ?? 0)} ${t.points}`)) : null,
  );
  const el = h("div", { class: "scene final" }, h("div", { class: "main" }, h("h1", {}, t.gameOver), podium, rest, h("div", { class: "again" }, t.playAgain)), side, confetti(90));
  if (best) {
    const drawing = structuredClone(best.drawing);
    const replay = new Replay(c, drawing);
    // The game's clearest drawing draws itself once more.
    requestAnimationFrame(() => {
      const t0 = performance.now();
      const step = () => {
        if (!el.isConnected) return;
        const p = Math.min(1, (performance.now() - t0 - 1200) / 6000);
        replay.draw(Math.max(0, p));
        if (p < 1) requestAnimationFrame(step);
      };
      step();
    });
  }
  later(300, () => sfx.roll(1500));
  later(1900, sfx.win);
  return { el };
}

watchFit();

client.connect().catch((e) => {
  stage.replaceChildren(h("div", { class: "scene lobby" }, logo(), h("p", { class: "hint" }, e?.message ?? String(e))));
});
