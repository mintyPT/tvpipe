// @ts-check
/**
 * Garble's TV page: tvpipe casts it with its own browser, or anyone opens
 * the watch link (the host page's preview, muted). It shows the screen
 * view (`{ roster, screen, join }`) in the room's language and animates
 * it: the lobby, the ring of players passing their pages, the reveal
 * (each picture rebuilt layer by layer, every layer in its drawer's
 * colour, with its word and the next player's guess), the gallery for
 * the best move and its winner, the ledger, the podium. Players' texts
 * are always text.
 */

import { joinText, PartyClient, qrSvg } from "/_tvpipe/lib/client.js";
import { num, pickLang } from "../phone/i18n.js";
import { drawLayers, fit, replay, replayTime } from "../phone/ink.js";
import { strings } from "./strings.js";

const params = new URLSearchParams(location.hash.slice(1));
// tvpipe's join badge bottom right, low (the reveal's story ends above it: screen.css).
const client = PartyClient.fromLocation({ role: /** @type {any} */ (params.get("role") ?? "screen"), rejoinBadge: { layout: "row" } });
const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const statusBar = /** @type {HTMLElement} */ (document.getElementById("status"));
const reactions = /** @type {HTMLElement} */ (document.getElementById("reactions"));

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

/** A stable pseudo-random number in [-1, 1) for a key (tilts that do not jump between views). */
function jitter(/** @type {string} */ key) {
  let x = 2166136261;
  for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 16777619);
  return ((x >>> 0) / 4294967296) * 2 - 1;
}

/** A player's colour from the screen view (`colors`, by id), else a grey. */
function colorOf(/** @type {string | undefined} */ id) {
  const c = id ? client.view?.screen?.colors?.[id] : undefined;
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : "#7c8696";
}

/** The first letter of a name, for avatars. */
function initial(/** @type {string} */ name) {
  return [...(name ?? "?").trim()][0]?.toUpperCase() ?? "?";
}

/**
 * @param {{ id: string, name: string, color?: string } | null | undefined} who
 * @param {string} [size] CSS length
 */
function avatar(who, size) {
  return h("span", { class: "avatar", style: { "--c": inkOf(who), ...(size ? { "--s": size } : {}) } }, initial(who?.name ?? "?"));
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The time left until a deadline (host clock), ms. */
function left(/** @type {number} */ deadline) {
  return deadline - client.now();
}

/**
 * A bar that empties until the deadline (`duration`: its whole length).
 * @param {number} deadline
 * @param {number} duration
 * @param {string} [cls]
 */
function deadlineBar(deadline, duration, cls = "bar") {
  const bar = h("div", { class: cls });
  const l = Math.max(0, left(deadline));
  const total = Math.max(l, duration || l || 1);
  bar.style.width = "100%";
  bar.style.transform = `scaleX(${l / total})`;
  requestAnimationFrame(() => {
    bar.style.transition = `transform ${l}ms linear`;
    bar.style.transform = "scaleX(0)";
  });
  return bar;
}

// ---------------------------------------------------------------------------
// Textures: paper grain and worn rubber stamps (made once, here).

function textures() {
  const grain = document.createElement("canvas");
  grain.width = grain.height = 256;
  const g = /** @type {CanvasRenderingContext2D} */ (grain.getContext("2d"));
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 70;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 40;
  }
  g.putImageData(img, 0, 0);
  document.documentElement.style.setProperty("--grain", `url(${grain.toDataURL()})`);
  const mask = document.createElement("canvas");
  mask.width = mask.height = 256;
  const m = /** @type {CanvasRenderingContext2D} */ (mask.getContext("2d"));
  m.fillStyle = "#000";
  m.fillRect(0, 0, 256, 256);
  m.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 900; i++) {
    m.globalAlpha = 0.25 + Math.random() * 0.75;
    m.beginPath();
    m.arc(Math.random() * 256, Math.random() * 256, Math.random() < 0.97 ? Math.random() * 1.4 : 1.5 + Math.random() * 1.5, 0, Math.PI * 2);
    m.fill();
  }
  document.documentElement.style.setProperty("--stamp-mask", `url(${mask.toDataURL()})`);
}
textures();

// ---------------------------------------------------------------------------
// Sound: short synthesized cues (the preview is muted: the TV plays them).

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
/** @param {number[]} notes @param {number} [len] @param {OscillatorType} [type] @param {number} [vol] */
function chime(notes, len = 0.12, type = "triangle", vol = 0.2) {
  const a = ac();
  if (!a) return;
  let at = a.currentTime + 0.02;
  for (const f of notes) {
    const o = a.createOscillator();
    const gn = a.createGain();
    o.type = type;
    o.frequency.value = f;
    gn.gain.setValueAtTime(0.0001, at);
    gn.gain.exponentialRampToValueAtTime(vol, at + 0.01);
    gn.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.connect(gn).connect(a.destination);
    o.start(at);
    o.stop(at + len + 0.02);
    at += len * 0.85;
  }
}
/** A noise burst through a filter: stamps (low), snips and swishes (high). @param {number} freq @param {number} len @param {number} [vol] */
function noise(freq, len, vol = 0.5) {
  const a = ac();
  if (!a) return;
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * len), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = freq < 1000 ? "lowpass" : "bandpass";
  f.frequency.value = freq;
  const gn = a.createGain();
  gn.gain.value = vol;
  src.connect(f).connect(gn).connect(a.destination);
  src.start();
}
const sfx = {
  phase: () => chime([523, 659, 784]),
  stamp: () => noise(180, 0.18, 0.9),
  light: () => noise(420, 0.08, 0.35),
  scratch: () => noise(2600, 0.5, 0.08),
  right: () => chime([660, 990], 0.1, "triangle", 0.16),
  wrong: () => chime([300, 220], 0.12, "sawtooth", 0.06),
  swish: () => noise(1800, 0.35, 0.18),
  win: () => chime([523, 659, 784, 1047], 0.16),
  drum: () => {
    for (let i = 0; i < 10; i++) setTimeout(() => noise(220, 0.05, 0.25 + i * 0.04), i * 70);
  },
  pop: () => chime([880], 0.05, "sine", 0.12),
};

// ---------------------------------------------------------------------------
// Scenes: built when the phase (or the picture) changes, updated on every view.

/**
 * @typedef {{ el: HTMLElement, update?: (view: any) => void, frame?: () => void, dispose?: () => void }} Scene
 */
/** @type {Scene | null} */
let scene = null;
let sceneKey = "";
/** @type {ReturnType<typeof setTimeout>[]} timers of the scene on screen */
let timers = [];
function later(/** @type {number} */ ms, /** @type {() => void} */ fn) {
  timers.push(setTimeout(fn, ms));
}

/** The pictures of a round this TV has shown, by `round:id` (the reveal's thumbnails). */
const seen = new Map();

client.on("view", (view) => render(view));
client.on("status", (s) => {
  statusBar.hidden = s === "open";
  statusBar.textContent = s === "reconnecting" || s === "connecting" ? t.reconnecting : s === "closed" ? t.over : "";
});
client.on("msg", (type, data) => {
  if (type === "react") react(data);
});

/** @param {any} view */
function keyOf(view) {
  const s = view.screen ?? {};
  switch (s.phase) {
    case "reveal":
      return `reveal:${s.round}:${s.index}`;
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
      setTimeout(() => old.el.remove(), 380);
    }
    scene = build(view);
    stage.append(scene.el);
  }
  scene?.update?.(view);
  // tvpipe's join badge has the join code in the bottom right corner
  // (the scenes keep clear of it: \`data-tvpipe-join\` and its size on
  // <html>, screen.css), but in the lobby, which shows it big.
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
    case "play":
      return play(s);
    case "reveal":
      return reveal(s);
    case "vote":
      return vote(s);
    case "best":
      return best(s);
    case "scores":
      return scores(s);
    case "final":
      return final(s);
    default:
      return { el: h("div", { class: "scene lobby" }, logo()) };
  }
}

function logo(small = false) {
  return h(
    "div",
    { class: `logo${small ? " small" : ""}` },
    ...[..."Garble"].map((c, i) =>
      h("span", { class: i === 3 ? "red" : "", style: { "--r": `${(jitter(`l${i}`) * 5).toFixed(1)}deg`, "--d": `${-i * 0.45}s`, "--y": `${(jitter(`y${i}`) * 0.8).toFixed(2)}vh` } }, c),
    ),
  );
}

/** The ink of a player (their colour; grey for someone unknown). @param {{ id?: string, color?: string } | null | undefined} who */
function inkOf(who) {
  return typeof who?.color === "string" && /^#[0-9a-f]{6}$/i.test(who.color) ? who.color : colorOf(who?.id);
}

/** A picture's layers in their drawers' colours, up to layer `upTo` (exclusive). @param {any} picture @param {number} [upTo] */
function inked(picture, upTo) {
  const layers = /** @type {any[]} */ (picture?.layers ?? []);
  return layers.slice(0, upTo ?? layers.length).map((l) => ({ drawing: l.drawing, color: inkOf(l.by) }));
}

/** The earlier layers faded under one in colour (the best move). */
const FADED = "#cfc8b8";

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
  const short = h("div", { class: "short typed" });
  const how = h(
    "div",
    { class: "how" },
    ...t.how.map(([b, s], i) => h("div", { class: "paper tape", style: { "--r": `${(jitter(`how${i}`) * 2.5).toFixed(1)}deg`, "--tape-tilt": `${(jitter(`ht${i}`) * 6).toFixed(1)}deg` } }, h("b", {}, h("i", {}, `${i + 1}`), b), h("span", {}, s))),
  );
  const el = h(
    "div",
    { class: "scene lobby" },
    h(
      "div",
      { class: "left" },
      logo(),
      h("p", { class: "tagline typed" }, t.tagline),
      h("div", { class: "joinbox" }, h("div", { class: "paper qrcard tape" }, qr), h("div", { class: "joininfo" }, h("div", { class: "big" }, t.scanToJoin), short)),
    ),
    h("div", { class: "right" }, h("h2", {}, t.players, count), tags, hint, h("div", { style: { "margin-top": "auto" } }, how, h("p", { class: "howline" }, t.howLine), badges)),
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
      const max = s.maxPlayers ?? 12;
      const min = s.minPlayers ?? 3;
      count.textContent = `${roster.length} / ${max}`;
      /** @type {HTMLElement[]} */
      const kids = [];
      for (const r of roster) {
        let tag = shown.get(r.id);
        if (!tag) {
          tag = h("div", { class: "paper tag", style: { "--r": `${(jitter(r.id) * 3).toFixed(1)}deg` } });
          shown.set(r.id, tag);
          sfx.pop();
        }
        tag.replaceChildren(h("span", { class: "pin", style: { "--c": colorOf(r.id) } }), r.name, r.vip ? h("span", { class: "vip" }, "VIP") : "");
        tag.classList.toggle("away", !r.connected);
        kids.push(tag);
      }
      for (const id of [...shown.keys()]) if (!roster.some((r) => r.id === id)) shown.delete(id);
      for (let i = roster.length; i < Math.max(min, Math.min(6, max)); i++) {
        const label = i < min ? t.waitingSeat : t.freeSeat;
        const old = /** @type {HTMLElement | undefined} */ ([...tags.children].find((e) => e.classList.contains("empty") && !kids.includes(/** @type {HTMLElement} */ (e)) && e.textContent === label));
        kids.push(old ?? h("div", { class: "tag empty" }, label));
      }
      // Only what changed moves: a tag taken out and put back would drop in again.
      kids.forEach((k, i) => {
        if (tags.children[i] !== k) tags.insertBefore(k, tags.children[i] ?? null);
      });
      while (tags.children.length > kids.length) tags.lastElementChild?.remove();
      const ready = roster.filter((r) => r.connected).length;
      hint.textContent = ready < min ? t.needed(min - ready) : t.vipStarts(roster.find((r) => r.vip)?.name);
      hint.classList.toggle("ready", ready >= min);
      const b = [t.rounds(s.rounds ?? 2), t.layers(s.length ?? 5), s.undo ? t.undoOn : t.undoOff];
      badges.replaceChildren(...b.map((x) => h("span", { class: "badge" }, x)));
    },
  };
}

// ---------------------------------------------------------------------------
// Playing: the ring of players, their pages passing on

/** Doodles on the pages going round (40 × 40): one more shows each step, nothing readable. */
const SCRIBBLES = [
  "M9 23c3-8 12-10 15-4s-2 11-8 9",
  "M26 7l6 7m-4-8l2 4",
  "M8 32c6-2 13-2 22 1",
  "M31 21a4 4 0 1 1-.1 0",
  "M6 9c2 0 4 2 5 4",
  "M17 11c2 2 5 2 7 0",
  "M13 27l3 5m4-6l1 6",
  "M22 30c3-3 6-3 9 0",
];

/** @param {any} s @returns {Scene} */
function play(s) {
  const seats = /** @type {{ id: string, name: string }[]} */ (s.seats ?? []);
  const n = Math.max(1, seats.length);
  const ring = h("div", { class: "ring" });
  const verb = h("div", { class: "verb" });
  const sub = h("div", { class: "sub" });
  const secs = h("div", { class: "secs" });
  const clock = document.createElementNS(SVG_NS, "svg");
  clock.setAttribute("viewBox", "0 0 36 36");
  clock.classList.add("clock");
  clock.innerHTML = `<circle class="track" cx="18" cy="18" r="15.9155"/><circle class="left" cx="18" cy="18" r="15.9155" stroke-dasharray="100 100"/>`;
  const arc = /** @type {SVGCircleElement} */ (clock.querySelector(".left"));
  const roundChip = h("span", { class: "chip" });
  const stepChip = h("span", { class: "chip dark" });
  const waitline = h("div", { class: "waitline" });
  const el = h("div", { class: "scene play" }, ring, h("div", { class: "center" }, clock, h("div", { class: "what" }, verb, sub, secs)), h("div", { class: "topline" }, roundChip, stepChip), waitline);
  const W = () => window.innerWidth;
  const H = () => window.innerHeight;
  /** A seat's place on the ellipse (`f`: towards the centre). */
  const at = (/** @type {number} */ angle, f = 1) => ({ x: W() / 2 + Math.cos(angle) * W() * 0.39 * f, y: H() * 0.53 + Math.sin(angle) * H() * 0.355 * f });
  const angleOf = (/** @type {number} */ seat) => -Math.PI / 2 + (seat / n) * Math.PI * 2;
  const seatEls = seats.map((p, i) => {
    const pos = at(angleOf(i));
    // Upper seats wear their name above (the pages sit below them).
    const e = h(
      "div",
      { class: `seat${Math.sin(angleOf(i)) < -0.3 ? " up" : ""}`, style: { left: `${pos.x}px`, top: `${pos.y}px` } },
      avatar(p),
      h("span", { class: "check" }, "✓"),
      h("span", { class: "name", style: { "--r": `${(jitter(p.id) * 3).toFixed(1)}deg` } }, p.name),
    );
    ring.append(e);
    return e;
  });
  // One page per picture, a scribble fuller each step; at step k (1-based) picture c is at seat c + k - 1.
  const pages = seats.map((_, c) => {
    const ink = document.createElementNS(SVG_NS, "svg");
    ink.setAttribute("viewBox", "0 0 40 40");
    ink.classList.add("ink");
    // The same scribbles in another order on each page.
    const order = SCRIBBLES.map((d, i) => ({ d, k: jitter(`scr${c}:${i}`) })).sort((a, b) => a.k - b.k);
    for (const { d } of order) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      ink.append(p);
    }
    const e = h("div", { class: "paper page", style: { "--r": `${(jitter(`page${c}`) * 8).toFixed(1)}deg` } }, ink, h("span", { class: "q" }, "?"));
    ring.append(e);
    return e;
  });
  /** Where each page is, as an angle (animated between steps). */
  const angles = pages.map(() => 0);
  /** @type {{ from: number[], to: number[], t0: number } | null} */
  let move = null;
  let step = 0;
  let kind = "first";
  let deadline = 0;
  let guessUntil = 0;
  let duration = 1;
  let guessing = false;
  let guessed = new Set();
  const place = () => {
    pages.forEach((e, c) => {
      const p = at(angles[c] ?? 0, 0.7);
      e.style.left = `${p.x}px`;
      e.style.top = `${p.y}px`;
    });
  };
  /** The big word: guess (until all guessed or time is up), then draw on top. */
  const label = () => {
    const g = kind !== "first" && guessing;
    const text = kind === "first" ? t.draw : kind === "last" ? t.lastGuess : g ? t.guess : t.onTop;
    if (verb.textContent !== text) {
      verb.textContent = text;
      verb.style.animation = "none";
      void verb.offsetWidth;
      verb.style.animation = "";
    }
    sub.textContent = kind === "first" ? t.firstStep : kind === "last" ? t.lastStep : g ? t.turnGuess : t.turnDraw;
    el.classList.toggle("guessing", g || kind === "last");
  };
  return {
    el,
    update(v) {
      const s = v.screen ?? {};
      deadline = s.deadline ?? 0;
      guessUntil = s.guessUntil ?? 0;
      duration = s.duration ?? 1;
      kind = s.kind ?? "first";
      guessed = new Set(/** @type {string[]} */ (s.guessed ?? []));
      if (s.step !== step) {
        const first = step === 0;
        step = s.step;
        const to = pages.map((_, c) => angleOf((c + step - 1) % n));
        if (first) {
          to.forEach((a, c) => (angles[c] = a));
          place();
        } else {
          // Forward round the ring (the last seat's page goes on to the first).
          const from = [...angles];
          for (let c = 0; c < to.length; c++) while (to[c] < from[c]) to[c] += Math.PI * 2;
          move = { from, to, t0: performance.now() };
          sfx.swish();
        }
        for (const e of pages) e.querySelectorAll("path").forEach((p, i) => p.classList.toggle("on", i < step));
        roundChip.textContent = t.round(s.round ?? 1, s.rounds ?? 1);
        stepChip.textContent = t.stepOf(step, s.steps ?? 0);
      }
      guessing = kind !== "first" && guessed.size < seats.length && left(guessUntil) > 0;
      label();
      const done = new Set(/** @type {string[]} */ (s.done ?? []));
      seats.forEach((p, i) => {
        const d = kind === "last" ? guessed.has(p.id) : done.has(p.id);
        seatEls[i]?.classList.toggle("done", d);
        // The picture this seat works on: seat - (step - 1).
        const c = (((i - (step - 1)) % n) + n) % n;
        pages[c]?.classList.toggle("done", d);
        pages[c]?.classList.toggle("busy", !d);
        pages[c]?.classList.toggle("asking", !d && (kind === "last" || (kind !== "first" && !guessed.has(p.id))));
      });
      const missing = seats.filter((p) => !(kind === "last" ? guessed.has(p.id) : done.has(p.id))).map((p) => p.name);
      waitline.textContent = missing.length > 0 && missing.length <= Math.max(2, Math.floor(n / 3)) ? t.waitingFor(missing) : "";
    },
    frame() {
      const ms = Math.max(0, left(deadline));
      const f = Math.max(0, Math.min(1, ms / Math.max(1, duration)));
      arc.setAttribute("stroke-dasharray", `${(f * 100).toFixed(2)} 100`);
      clock.classList.toggle("low", ms < 10_000);
      secs.textContent = String(Math.ceil(ms / 1000));
      if (guessing && left(guessUntil) <= 0) {
        guessing = false;
        label();
      }
      if (move) {
        const p = Math.min(1, (performance.now() - move.t0) / 1100);
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        for (let c = 0; c < angles.length; c++) angles[c] = move.from[c] + (move.to[c] - move.from[c]) * e;
        place();
        if (p >= 1) {
          for (let c = 0; c < angles.length; c++) angles[c] = move.to[c] % (Math.PI * 2);
          move = null;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The reveal: one picture rebuilt layer by layer, its story beside it

/** A small paper with a finished picture (the reveal's gallery, the vote). @param {any} picture @param {string} cls */
function thumb(picture, cls = "thumb") {
  const c = /** @type {HTMLCanvasElement} */ (h("canvas"));
  const el = h("div", { class: `paper ${cls}` }, c);
  requestAnimationFrame(() => {
    const f = fit(c);
    drawLayers(f.ctx, inked(picture), 0, 0, f.size);
  });
  return el;
}

/** @param {any} s @returns {Scene} */
function reveal(s) {
  // A copy: the client patches its view in place, and the next picture would overwrite this one.
  const picture = structuredClone(s.picture ?? { layers: [] });
  const layers = /** @type {any[]} */ (picture.layers ?? []);
  const times = { layer: 3000, read: 2200, legend: 3600, ...(s.times ?? {}) };
  seen.set(`${s.round}:${picture.id}`, picture);
  const base = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "base" }));
  const top = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "top" }));
  const sheet = h("div", { class: "paper sheet tape", style: { "--r": `${(jitter(`sheet${s.round}:${picture.id}`) * 1.6).toFixed(1)}deg` } }, base, top);
  const story = h("div", { class: "story", style: { "--rows": String(Math.max(3, layers.length)) } });
  // The round's pictures as slots: those shown already, this one, those to come.
  const shown = /** @type {number[]} */ (s.shown ?? []);
  const slots = Array.from({ length: s.of ?? 1 }, (_, i) => {
    const p = i < shown.length ? seen.get(`${s.round}:${shown[i]}`) : undefined;
    return p ? thumb(p) : h("div", { class: `paper thumb empty${i === shown.length ? " now" : ""}` });
  });
  const el = h(
    "div",
    { class: "scene reveal" },
    h(
      "div",
      { class: "revealhead" },
      h("span", { class: "chip" }, t.pictureCount(s.index ?? 1, s.of ?? 1)),
      h("div", { class: "who" }, avatar(picture.starter, "6vh"), t.pictureOf(picture.starter?.name ?? "")),
      h("div", { class: "grow" }),
      h("div", { class: `thumbs${slots.length > 8 ? " many" : ""}` }, ...slots),
    ),
    h("div", { class: "sheetwrap" }, sheet),
    story,
  );
  /** @type {{ abort: boolean }[]} */
  const signals = [];
  /** @type {HTMLElement[]} */
  const rows = [];
  let size = 0;
  /** @type {CanvasRenderingContext2D | null} */
  let baseCtx = null;
  /** @type {CanvasRenderingContext2D | null} */
  let topCtx = null;
  /** Layers drawn on the base so far. */
  let committed = 0;
  const sizeUp = () => {
    const a = fit(base);
    const b = fit(top);
    baseCtx = a.ctx;
    topCtx = b.ctx;
    size = a.size;
  };
  const commit = (/** @type {number} */ upTo) => {
    if (!baseCtx) sizeUp();
    committed = upTo;
    drawLayers(/** @type {CanvasRenderingContext2D} */ (baseCtx), inked(picture, upTo), 0, 0, size);
    topCtx?.clearRect(0, 0, size, size);
  };

  /** Row `k`: the layer's tag (number, word, drawer); its guess card comes later. */
  const row = (/** @type {number} */ k, /** @type {boolean} */ animate) => {
    const l = layers[k];
    const c = inkOf(l.by);
    const tag = h(
      "div",
      { class: "paper manila ltag", style: { "--c": c, "--r": `${(jitter(`tag${k}`) * 1.4).toFixed(1)}deg` } },
      h("span", { class: "n" }, String(k + 1)),
      h("span", { class: "word" }, l.word ?? ""),
      h("span", { class: "by" }, h("i", { style: { "--c": c } }), t.drewIt(l.by?.name ?? "")),
      l.drawing?.strokes?.length > 0 ? null : h("span", { class: "blank" }, t.blank),
    );
    const card = h("div", { class: "slot" });
    const r = h("div", { class: `row${animate ? " enter" : ""}` }, tag, h("span", { class: "arrow" }, "→"), card);
    rows[k] = r;
    story.append(r);
    return r;
  };
  /** The guess card of row `k`, with its verdict. */
  const guessCard = (/** @type {number} */ k, /** @type {boolean} */ animate) => {
    const l = layers[k];
    const r = rows[k];
    if (!r || r.querySelector(".gcard")) return;
    const g = l.guess;
    const text = h("span", { class: `text${g?.text ? "" : " none"}` }, g?.text || t.noGuess);
    const card = h(
      "div",
      { class: `paper gcard${animate ? " fly" : ""}`, style: { "--r": `${(jitter(`g${k}`) * 2.4).toFixed(1)}deg` } },
      text,
      g ? h("span", { class: "by" }, avatar(g.by, "2.6vh"), t.read(g.by?.name ?? "")) : null,
    );
    /** @type {HTMLElement} */ (r.querySelector(".slot")).replaceChildren(card);
    const verdict = () => {
      if (!g) return;
      card.append(h("span", { class: `mark ${g.right ? "ok" : "no"}` }, g.right ? "✓" : "✗"));
      if (g.right) card.append(h("span", { class: "pts" }, t.each(l.points ?? 0)));
      r.classList.add(g.right ? "right" : "wrong");
      if (animate) (g.right ? sfx.right : sfx.wrong)();
    };
    if (animate) {
      text.classList.add("writing");
      later(900, verdict);
    } else verdict();
  };
  /** Shows layers before `k` at once, then layer `k` drawing itself. */
  const showLayer = (/** @type {number} */ k, /** @type {boolean} */ animate) => {
    for (let i = 0; i < k; i++) {
      if (!rows[i]) row(i, false);
      guessCard(i, false);
      rows[i]?.classList.remove("now");
    }
    if (committed < k) commit(k);
    const l = layers[k];
    if (!l) return;
    if (!rows[k]) row(k, animate);
    rows[k]?.classList.add("now");
    if (!animate) {
      commit(k + 1);
      guessCard(k, false);
      return;
    }
    sfx.scratch();
    const ms = Math.min(replayTime(l.drawing, 900, 2400), Math.max(600, times.layer - 500));
    const signal = { aborted: false };
    signals.push(/** @type {any} */ (signal));
    later(250, () => {
      if (!topCtx) sizeUp();
      void replay(/** @type {CanvasRenderingContext2D} */ (topCtx), l.drawing, size, ms, signal, undefined, { paper: null, color: inkOf(l.by) }).then(() => {
        if (!signal.aborted) commit(k + 1);
      });
    });
    later(times.layer, () => guessCard(k, true));
  };
  /** The end: every row, then the picture shrinks into its slot. */
  const legend = (/** @type {boolean} */ animate) => {
    for (let i = 0; i < layers.length; i++) {
      if (!rows[i]) row(i, false);
      guessCard(i, false);
      rows[i]?.classList.remove("now");
    }
    commit(layers.length);
    el.classList.add("legend");
    if (!animate) return;
    later(Math.max(400, times.legend - 1100), () => {
      const slot = slots[shown.length];
      if (!slot) return;
      const a = sheet.getBoundingClientRect();
      const b = slot.getBoundingClientRect();
      sheet.style.transition = "transform .8s cubic-bezier(.6, 0, .3, 1), opacity .8s";
      sheet.style.transformOrigin = "0 0";
      sheet.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${b.width / a.width})`;
      sfx.swish();
      later(800, () => {
        const filled = thumb(picture);
        slot.replaceWith(filled);
        slots[shown.length] = filled;
        sheet.style.opacity = "0";
      });
    });
  };

  let cursor = -1;
  let stageNow = "";
  return {
    el,
    update(v) {
      const s = v.screen ?? {};
      const first = cursor < 0;
      if (s.stage === "layers" && s.cursor !== cursor) {
        cursor = s.cursor ?? 0;
        // A TV that joins late shows what was shown already at once.
        if (first) requestAnimationFrame(() => showLayer(cursor, true));
        else showLayer(cursor, true);
      }
      if (s.stage === "legend" && stageNow !== "legend") {
        const late = first;
        cursor = layers.length;
        requestAnimationFrame(() => legend(!late));
      }
      stageNow = s.stage;
    },
    dispose() {
      for (const x of signals) /** @type {any} */ (x).aborted = true;
    },
  };
}

// ---------------------------------------------------------------------------
// The best move: the gallery, the vote, the winner

/**
 * Tiles for `n` pictures in a box (px): the largest square that fits.
 * @param {number} n @param {number} w @param {number} hgt @param {number} gap @param {number} extra the label under each
 */
function tiles(n, w, hgt, gap, extra) {
  let best = { cols: 1, size: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const size = Math.min((w - gap * (cols - 1)) / cols, (hgt - (gap + extra) * rows) / rows);
    if (size > best.size) best = { cols, size };
  }
  return best;
}

/** @param {any} s @returns {Scene} */
function vote(s) {
  const gallery = /** @type {any[]} */ (s.gallery ?? []);
  const voters = /** @type {any[]} */ (s.voters ?? []);
  const W = window.innerWidth;
  const H = window.innerHeight;
  const { cols, size } = tiles(gallery.length, W * 0.92, H * 0.66, H * 0.03, H * 0.065);
  const grid = h(
    "div",
    { class: "gallery", style: { "grid-template-columns": `repeat(${cols}, ${Math.floor(size)}px)` } },
    ...gallery.map((p, i) =>
      h(
        "div",
        { class: "tile", style: { "--d": `${i * 0.06}s` } },
        thumb(p, "art"),
        // What it began as and what it ended as.
        h(
          "div",
          { class: "chain typed" },
          ...((/** @type {any[]} */ ls) => {
            const word = (/** @type {any} */ l) => h("span", { style: { color: inkOf(l.by) } }, l.word ?? "");
            if (ls.length <= 2) return ls.flatMap((l, k) => [k > 0 ? " → " : "", word(l)]);
            return [word(ls[0]), " → … → ", word(ls.at(-1))];
          })(p.layers ?? []),
        ),
      ),
    ),
  );
  const dots = h("div", { class: "voters" }, ...voters.map((p) => h("span", { class: "voter", "data-id": p.id }, avatar(p, "4.4vh"), h("span", { class: "check" }, "✓"))));
  const count = h("div", { class: "sub" });
  const el = h("div", { class: "scene vote" }, h("h1", {}, t.bestTitle), h("p", { class: "help typed" }, t.bestHelp), grid, h("div", { class: "foot" }, dots, count), deadlineBar(s.deadline ?? 0, s.duration ?? 0));
  return {
    el,
    update(v) {
      const done = new Set(/** @type {string[]} */ (v.screen?.done ?? []));
      for (const d of dots.querySelectorAll(".voter")) d.classList.toggle("done", done.has(/** @type {HTMLElement} */ (d).dataset["id"] ?? ""));
      count.textContent = t.voted(done.size, voters.length);
    },
  };
}

/** @param {any} s @returns {Scene} */
function best(s) {
  const gallery = /** @type {any[]} */ (s.gallery ?? []);
  const all = /** @type {any[]} */ (s.best ?? []);
  const winners = all.slice(0, 3);
  const el = h("div", { class: "scene best" }, h("h1", {}, t.bestTitle));
  if (winners.length === 0) {
    el.append(h("p", { class: "help typed" }, t.noVotes));
    return { el };
  }
  const row = h("div", { class: `winners n${winners.length}` });
  winners.forEach((w, i) => {
    const p = gallery.find((x) => x.id === w.picture);
    const l = p?.layers?.[w.layer];
    if (!p || !l) return;
    const c = /** @type {HTMLCanvasElement} */ (h("canvas"));
    const prev = p.layers[w.layer - 1];
    const card = h(
      "div",
      { class: "winner", style: { "--d": `${0.3 + i * 0.25}s` } },
      h("div", { class: "paper sheet tape" }, c, h("span", { class: "stamp blue", style: { "--rot": "-8deg", "--fs": "4.4vh" } }, t.votes(w.votes ?? 0))),
      h("div", { class: "paper manila ltag", style: { "--c": inkOf(l.by) } }, prev ? h("span", { class: "was" }, `${prev.word ?? ""} →`) : null, h("span", { class: "word" }, l.word ?? "")),
      h("div", { class: "by" }, avatar(l.by, "5vh"), h("span", {}, t.bestBy(l.by?.name ?? "")), h("b", {}, `+${num(lang, w.points ?? 0)}`)),
    );
    row.append(card);
    // The earlier layers faded, this one drawing itself in its colour.
    requestAnimationFrame(() => {
      const f = fit(c);
      const under = { strokes: p.layers.slice(0, w.layer).flatMap((/** @type {any} */ x) => x.drawing?.strokes ?? []) };
      drawLayers(f.ctx, [{ drawing: under, color: FADED }], 0, 0, f.size);
      const top = document.createElement("canvas");
      top.className = "top";
      c.parentElement?.insertBefore(top, c.nextSibling);
      const g = fit(top);
      later(700 + i * 300, () => void replay(g.ctx, l.drawing, g.size, Math.min(2400, replayTime(l.drawing)), undefined, undefined, { paper: null, color: inkOf(l.by) }));
    });
  });
  el.append(row);
  if (all.length > 1) el.append(h("p", { class: "help typed" }, all.length > winners.length ? t.sharedMore(all.length - winners.length) : t.shared));
  el.append(confetti(60));
  later(400, sfx.win);
  return { el };
}

/** Paper confetti. */
function confetti(n = 70) {
  const box = h("div", { class: "confetti" });
  const colors = ["#e0383e", "#2556d8", "#ffe14a", "#fbf8f1", "#e9cf98"];
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

/** Counts a number up in an element. @param {HTMLElement} el @param {number} from @param {number} to @param {number} delay */
function countUp(el, from, to, delay) {
  el.textContent = num(lang, from);
  later(delay, () => {
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / 1200);
      el.textContent = num(lang, Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** @param {any} s @returns {Scene} */
function scores(s) {
  const lines = /** @type {any[]} */ (s.lines ?? []);
  const ledger = h("div", { class: `paper ledger${lines.length > 8 ? " many" : ""}` });
  let rank = 0;
  let last = Number.NaN;
  lines.forEach((l, i) => {
    if (l.score !== last) rank = i + 1;
    last = l.score;
    const pts = h("span");
    const e = l.earned ?? {};
    const gains = /** @type {const} */ (["drawn", "read", "best"]).filter((k) => e[k] > 0).map((k) => h("span", { class: `gain ${k}` }, `+${num(lang, e[k])} ${t.kinds[k]}`));
    ledger.append(
      h(
        "div",
        { class: "row", style: { "--d": `${0.1 + i * 0.08}s` } },
        h("span", { class: "rk" }, String(rank)),
        avatar(l),
        h("span", { class: "nm" }, l.name),
        h("span", { class: "mid" }, ...gains),
        h("span", { class: "pts" }, pts, l.delta ? h("small", {}, `+${num(lang, l.delta)}`) : null),
      ),
    );
    countUp(pts, l.score - (l.delta ?? 0), l.score, 600 + i * 80);
  });
  const el = h("div", { class: "scene scores" }, h("h1", {}, t.scoresTitle, h("small", {}, t.scoresAfter(s.round ?? 1, s.rounds ?? 1))), ledger);
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
      return h(
        "div",
        { class: `step p${i + 1}`, style: { "--d": `${[0.5, 0.2, 0.8][i]}s` } },
        avatar(l),
        h("div", { class: "nm" }, l.name),
        h("div", { class: "paper block" }, h("b", {}, String(i + 1)), h("span", {}, num(lang, l.score))),
      );
    }),
  );
  const rest = h("div", { class: "rest" }, ...lines.slice(3).map((l, i) => h("span", {}, `${i + 4}. ${l.name} · ${num(lang, l.score)}`)));
  const el = h("div", { class: "scene final" }, h("h1", {}, t.gameOver), podium, rest, h("div", { class: "again" }, t.playAgain), confetti(90));
  later(500, sfx.win);
  return { el };
}

// ---------------------------------------------------------------------------
// Reactions from phones: bubbles rising from the bottom.

let reactCount = 0;
/** @param {any} data */
function react(data) {
  if (typeof data !== "object" || data === null) return;
  const text = t.reactions[data.r];
  if (!text) return;
  if (reactions.childElementCount > 24) reactions.firstElementChild?.remove();
  const c = typeof data.color === "string" && /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : "#7c8696";
  const el = h(
    "div",
    { class: "react", style: { left: `${6 + Math.random() * 82}%`, "--c": c, "--r": `${(Math.random() - 0.5) * 14}deg`, "--x": `${(Math.random() - 0.5) * 12}vw` } },
    text,
    h("small", {}, typeof data.name === "string" ? data.name : ""),
  );
  reactions.append(el);
  if (++reactCount % 2 === 0) sfx.pop();
  setTimeout(() => el.remove(), 3500);
}

client.connect().catch((e) => {
  stage.replaceChildren(h("div", { class: "scene lobby" }, logo(), h("p", { class: "hint" }, e?.message ?? String(e))));
});
