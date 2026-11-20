// @ts-check
/**
 * Garble's TV page: tvpipe casts it with its own browser, or anyone opens
 * the watch link (the host page's preview, muted). It shows the screen
 * view (`{ roster, screen, join }`) in the room's language and animates
 * it: the lobby, the round's secrets, the ring of players passing their
 * slips, each chain unrolled on a red thread and judged, the hunt for
 * the Wrecker, the ledger, the podium. Players' texts are always text.
 */

import { joinText, PartyClient, qrSvg } from "/_tvpipe/lib/client.js";
import { num, pickLang } from "../phone/i18n.js";
import { drawInk, fit, replay, replayTime } from "../phone/ink.js";
import { strings } from "./strings.js";

const params = new URLSearchParams(location.hash.slice(1));
const client = PartyClient.fromLocation({ role: /** @type {any} */ (params.get("role") ?? "screen") });
const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const corner = /** @type {HTMLElement} */ (document.getElementById("corner"));
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
 * @param {{ id: string, name: string } | null | undefined} who
 * @param {string} [size] CSS length
 */
function avatar(who, size) {
  return h("span", { class: "avatar", style: { "--c": colorOf(who?.id), ...(size ? { "--s": size } : {}) } }, initial(who?.name ?? "?"));
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** @param {string} d paths, `|`-separated (24×24, stroked) */
function icon(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  for (const part of d.split("|")) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", part);
    svg.append(p);
  }
  return svg;
}
const PENCIL = "M4 20l1-5L16 4l4 4L9 19z|M14 6l4 4|M4 20l5-1";

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
  snip: () => (noise(4000, 0.06, 0.5), setTimeout(() => noise(3000, 0.07, 0.4), 90)),
  swish: () => noise(1800, 0.35, 0.18),
  win: () => chime([523, 659, 784, 1047], 0.16),
  drum: () => {
    for (let i = 0; i < 10; i++) setTimeout(() => noise(220, 0.05, 0.25 + i * 0.04), i * 70);
  },
  pop: () => chime([880], 0.05, "sine", 0.12),
};

// ---------------------------------------------------------------------------
// Scenes: built when the phase (or the chain) changes, updated on every view.

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
  // The join code in a corner: between rounds, for latecomers.
  const late = view.join?.lateJoin ?? "wait";
  corner.hidden = !["intro", "scores", "final"].includes(s.phase) || !view.join?.qr || late === "closed";
  if (!corner.hidden && corner.dataset["url"] !== view.join.url) {
    corner.dataset["url"] = view.join.url;
    /** @type {HTMLElement} */ (document.getElementById("corner-qr")).innerHTML = qrSvg(view.join.qr, { quiet: 2 });
  }
  const text = joinText(view.join);
  // The short link on a line of its own, never wrapped.
  /** @type {HTMLElement} */ (document.getElementById("corner-text")).replaceChildren(t.joinCorner, ...(text ? [h("b", {}, text)] : []));
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
      return lobby(view);
    case "intro":
      return intro(s);
    case "play":
      return play(s);
    case "reveal":
      return reveal(s);
    case "accuse":
      return accuse(s);
    case "unmask":
      return unmask(s);
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

// ---------------------------------------------------------------------------
// The lobby

/** @param {any} view @returns {Scene} */
function lobby(view) {
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
    h("div", { class: "right" }, h("h2", {}, t.players, count), tags, hint, h("div", { style: { "margin-top": "auto" } }, how, h("p", { class: "secretline" }, t.howSecret), badges)),
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
      const min = s.minPlayers ?? 4;
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
      const b = [t.rounds(s.rounds ?? 2), t.steps(s.length ?? 6), s.undo ? t.undoOn : t.undoOff];
      if (s.twists) b.push(t.twistsOn);
      badges.replaceChildren(...b.map((x) => h("span", { class: "badge" }, x)));
    },
  };
}

// ---------------------------------------------------------------------------
// The round's secrets

/** @param {any} s @returns {Scene} */
function intro(s) {
  const twist = s.twist && s.twist !== "clear" ? t.twists[/** @type {"glimpse" | "peephole"} */ (s.twist)] : null;
  const el = h(
    "div",
    { class: "scene intro" },
    h("div", { class: "roundtitle" }, t.round(s.round ?? 1, s.rounds ?? 1)),
    h(
      "div",
      { class: "cards" },
      h("div", { class: "paper card tape", style: { "--r": "-2.5deg", "--d": ".35s" } }, h("h3", {}, t.secretTitle), h("div", { class: "secret" }, "pirate"), h("p", {}, t.secretText)),
      h("div", { class: "paper card wreck tape", style: { "--r": "2deg", "--d": ".65s" } }, h("h3", {}, t.wreckerTitle), h("p", {}, t.wreckerText), h("span", { class: "stamp" }, t.wrecker)),
    ),
    twist ? h("div", { class: "paper twist" }, h("b", {}, `${t.twistTitle}: ${twist[0]}`), h("span", {}, twist[1])) : null,
    h("div", { class: "phonehint" }, t.checkPhone),
    s.deadline ? deadlineBar(s.deadline, s.duration) : null,
  );
  later(1350, sfx.stamp);
  return { el };
}

// ---------------------------------------------------------------------------
// Playing: the ring of players, their slips passing on

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
  const twistChip = h("span", { class: "chip red" });
  const waitline = h("div", { class: "waitline" });
  const el = h(
    "div",
    { class: "scene play" },
    ring,
    h("div", { class: "center" }, clock, h("div", { class: "what" }, verb, sub, secs)),
    h("div", { class: "topline" }, roundChip, twistChip),
    waitline,
  );
  const W = () => window.innerWidth;
  const H = () => window.innerHeight;
  /** A seat's place on the ellipse (`f`: towards the centre). */
  const at = (/** @type {number} */ angle, f = 1) => ({ x: W() / 2 + Math.cos(angle) * W() * 0.39 * f, y: H() * 0.53 + Math.sin(angle) * H() * 0.355 * f });
  const angleOf = (/** @type {number} */ seat) => -Math.PI / 2 + (seat / n) * Math.PI * 2;
  const seatEls = seats.map((p, i) => {
    const pos = at(angleOf(i));
    // Upper seats wear their name above (the slips sit below them).
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
  // One slip per chain; at step k (1-based) chain c is at seat c + k - 1.
  const slips = seats.map((_, c) => {
    const e = h("div", { class: "paper slip", style: { "--r": `${(jitter(`slip${c}`) * 8).toFixed(1)}deg` } });
    ring.append(e);
    return e;
  });
  /** Where each slip is, as an angle (animated between steps). */
  const angles = slips.map(() => 0);
  /** @type {{ from: number[], to: number[], t0: number } | null} */
  let move = null;
  let step = 0;
  let deadline = 0;
  let duration = 1;
  const place = () => {
    slips.forEach((e, c) => {
      const p = at(angles[c] ?? 0, 0.7);
      e.style.left = `${p.x}px`;
      e.style.top = `${p.y}px`;
    });
  };
  return {
    el,
    update(v) {
      const s = v.screen ?? {};
      deadline = s.deadline ?? 0;
      duration = s.duration ?? 1;
      if (s.step !== step) {
        const first = step === 0;
        step = s.step;
        const to = slips.map((_, c) => angleOf((c + step - 1) % n));
        if (first) {
          to.forEach((a, c) => (angles[c] = a));
          place();
        } else {
          // Forward round the ring (the last seat's slip goes on to the first).
          const from = [...angles];
          for (let c = 0; c < to.length; c++) while (to[c] < from[c]) to[c] += Math.PI * 2;
          move = { from, to, t0: performance.now() };
          sfx.swish();
        }
        const kind = s.kind === "guess" ? "guess" : "draw";
        verb.textContent = kind === "guess" ? t.guess : t.draw;
        verb.style.animation = "none";
        void verb.offsetWidth;
        verb.style.animation = "";
        sub.textContent = `${t.stepOf(step, s.steps ?? 0)} · ${step === 1 ? t.firstStep : step === s.steps ? t.lastStep : t.passOn}`;
        for (const e of slips) e.replaceChildren(kind === "draw" ? icon(PENCIL) : h("span", { class: "q" }, "?"));
        roundChip.textContent = t.round(s.round ?? 1, s.rounds ?? 1);
        const tw = s.twist && s.twist !== "clear" ? t.twists[/** @type {"glimpse" | "peephole"} */ (s.twist)] : null;
        twistChip.hidden = !tw;
        if (tw) twistChip.textContent = `${t.twistTitle}: ${tw[0]}`;
      }
      const done = new Set(/** @type {string[]} */ (s.done ?? []));
      seats.forEach((p, i) => {
        const d = done.has(p.id);
        seatEls[i]?.classList.toggle("done", d);
        // The chain this seat works on: seat - (step - 1).
        const c = (((i - (step - 1)) % n) + n) % n;
        slips[c]?.classList.toggle("done", d);
        slips[c]?.classList.toggle("busy", !d);
      });
      const missing = seats.filter((p) => !done.has(p.id)).map((p) => p.name);
      waitline.textContent = missing.length > 0 && missing.length <= Math.max(2, Math.floor(n / 3)) ? t.waitingFor(missing) : "";
    },
    frame() {
      const ms = Math.max(0, left(deadline));
      const f = Math.max(0, Math.min(1, ms / Math.max(1, duration)));
      arc.setAttribute("stroke-dasharray", `${(f * 100).toFixed(2)} 100`);
      clock.classList.toggle("low", ms < 10_000);
      secs.textContent = String(Math.ceil(ms / 1000));
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
// The reveal: one chain on its thread, then the verdict

/**
 * A guess's text with the smuggled words marked.
 * @param {string} text
 * @param {[number, number][]} ranges
 */
function marked(text, ranges) {
  const out = [];
  let at = 0;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a < at) continue;
    out.push(text.slice(at, a), h("mark", {}, text.slice(a, b)));
    at = b;
  }
  out.push(text.slice(at));
  return out;
}

/** @param {any} s @returns {Scene} */
function reveal(s) {
  const chain = s.chain ?? { links: [], prompt: "" };
  const links = /** @type {any[]} */ (chain.links ?? []);
  const view = h("div", { class: "view" });
  const strip = h("div", { class: "strip" });
  view.append(strip);
  const caption = h("div", { class: "paper caption", hidden: true });
  const el = h(
    "div",
    { class: "scene reveal" },
    h(
      "div",
      { class: "revealhead" },
      h("span", { class: "chip" }, t.chainCount(s.index ?? 1, s.of ?? 1)),
      h("div", { class: "who" }, avatar(chain.author, "6vh"), t.chainOf(chain.author?.name ?? "")),
      h("div", { class: "grow" }),
      h("span", { class: "chip" }, t.round(s.round ?? 1, s.rounds ?? 1)),
    ),
    view,
    caption,
  );

  // The cards: the prompt (a tag), then drawings (sheets) and guesses (index cards).
  /** @type {{ el: HTMLElement, card: HTMLElement, kind: string, link?: any, canvas?: HTMLCanvasElement, text?: HTMLElement, shown: boolean }[]} */
  const items = [];
  const promptCard = h("div", { class: "paper manila prompt" }, h("div", { class: "what" }, t.thePrompt), h("div", { class: "text" }, chain.prompt ?? ""));
  items.push({ el: h("div", { class: "item" }, promptCard, h("div", { class: "label" }, avatar(chain.author), t.picked(chain.author?.name ?? ""))), card: promptCard, kind: "prompt", shown: false });
  links.forEach((l, i) => {
    const r = `${(jitter(`${chain.id}:${i}`) * 2.2).toFixed(1)}deg`;
    if (l.kind === "draw") {
      const canvas = /** @type {HTMLCanvasElement} */ (h("canvas"));
      const empty = !(l.drawing?.strokes?.length > 0);
      const card = h("div", { class: "paper sheet tape", style: { "--r": r, "--tape-tilt": `${(jitter(`t${i}`) * 5).toFixed(1)}deg` } }, canvas, empty ? h("div", { class: "blank" }, t.blank) : null);
      items.push({ el: h("div", { class: "item" }, card, h("div", { class: "label" }, avatar(l.by), t.drewIt(l.by?.name ?? ""))), card, kind: "draw", link: l, canvas, shown: false });
    } else {
      const text = h("div", { class: `text${l.text ? ([...l.text].length > 22 ? " long" : "") : " none"}` }, l.text || t.noGuess);
      const card = h("div", { class: "paper note", style: { "--r": r } }, text);
      items.push({ el: h("div", { class: "item" }, card, h("div", { class: "label" }, avatar(l.by), t.guessedIt(l.by?.name ?? ""))), card, kind: "guess", link: l, text, shown: false });
    }
  });
  /** @type {HTMLElement[]} the thread between item i and i + 1 */
  const threads = [];
  for (let i = 0; i + 1 < items.length; i++) {
    const th = h("div", { class: "thread off" }, h("i"), h("i"));
    threads.push(th);
    strip.append(th);
  }
  for (const it of items) strip.append(it.el);

  /** A card's centre in the strip's own coordinates. */
  const centre = (/** @type {typeof items[number]} */ it) => ({
    x: it.el.offsetLeft + it.card.offsetLeft + it.card.offsetWidth / 2,
    y: it.el.offsetTop + it.card.offsetTop + it.card.offsetHeight / 2,
  });
  /** The thread between each two cards: from centre to centre (also down a row). */
  const layoutThreads = () => {
    for (let i = 0; i < threads.length; i++) {
      const a = centre(items[i]);
      const b = centre(items[i + 1]);
      const th = threads[i];
      th.style.left = `${a.x}px`;
      th.style.top = `${a.y}px`;
      th.style.width = `${Math.hypot(b.x - a.x, b.y - a.y)}px`;
      th.style.rotate = `${Math.atan2(b.y - a.y, b.x - a.x)}rad`;
    }
  };
  /** The camera: centre item `i` at `scale`, or everything (`i` < 0). */
  const camera = (/** @type {number} */ i, z = 1) => {
    const vw = view.clientWidth;
    // The cards' extent (not the threads': they may still have the old layout).
    const sw = Math.max(...items.map((it) => it.el.offsetLeft + it.el.offsetWidth)) + items[0].el.offsetLeft;
    let tx;
    if (i < 0) {
      z = Math.min(1, (vw * 0.95) / sw, (view.clientHeight * (strip.classList.contains("snake") ? 0.94 : 1.05)) / strip.offsetHeight);
      tx = (vw - sw * z) / 2;
    } else {
      const it = items[i].el;
      tx = vw / 2 - (it.offsetLeft + it.offsetWidth / 2) * z;
    }
    strip.style.transform = `translate(${tx}px, -50%) scale(${z})`;
    strip.style.setProperty("--inv", String(Math.min(1.5, 1 / z)));
    strip.style.setProperty("--sinv", String(Math.min(2.4, 1 / z)));
  };

  /** Draws a drawing card: replayed, or at once. */
  const paint = (/** @type {typeof items[number]} */ it, animate = false) => {
    if (!it.canvas) return;
    const { ctx, size } = fit(it.canvas);
    if (!animate) return drawInk(ctx, it.link.drawing, 0, 0, size);
    const ms = Math.min(replayTime(it.link.drawing, 900, 2600), 2600);
    const signal = { aborted: false };
    disposers.push(() => (signal.aborted = true));
    return replay(ctx, it.link.drawing, size, ms, signal);
  };
  /** @type {(() => void)[]} */
  const disposers = [];

  let cursor = -1;
  let stageNow = "";
  /** Shows the cards up to `c`, the camera on `c`. */
  const show = (/** @type {number} */ c, /** @type {boolean} */ animate) => {
    threads.forEach((th, i) => th.classList.toggle("off", i + 1 > c));
    items.forEach((it, i) => {
      it.el.classList.toggle("future", i > c);
      it.el.classList.toggle("dim", i < c);
      if (i <= c && !it.shown) {
        it.shown = true;
        const now = animate && i === c;
        if (it.kind === "draw") {
          if (now) later(500, () => void paint(it, true));
          else paint(it);
        } else if (it.kind === "guess" && now) {
          later(380, () => {
            it.text?.classList.add("writing");
            sfx.light();
          });
        }
      }
    });
    camera(c, 1);
  };
  /**
   * Everything at once, for the judging and the verdict. Long chains
   * (more than five cards) snake over two rows, the second running back
   * right to left, so the thread just drops down a row; the cards fly
   * from the row to their places (FLIP).
   */
  let overviewed = false;
  const overview = () => {
    if (overviewed) return;
    overviewed = true;
    const before = items.map((it) => it.el.getBoundingClientRect());
    for (const it of items) {
      it.el.classList.remove("future", "dim");
      if (!it.shown) {
        it.shown = true;
        if (it.kind === "draw") paint(it);
      }
    }
    if (items.length > 5) {
      const top = Math.ceil(items.length / 2);
      strip.classList.add("snake");
      items.forEach((it, i) => {
        const row = i < top ? 1 : 2;
        const col = i < top ? i + 1 : top - (i - top);
        it.el.style.gridRow = String(row);
        it.el.style.gridColumn = String(col);
      });
    }
    strip.style.transition = "none";
    camera(-1);
    layoutThreads();
    void strip.offsetWidth;
    const z = strip.getBoundingClientRect().width / Math.max(1, strip.offsetWidth);
    items.forEach((it, i) => {
      const now = it.el.getBoundingClientRect();
      const b = before[i];
      if (!b || b.width === 0) return;
      it.el.style.transition = "none";
      it.el.style.translate = `${(b.left + b.width / 2 - (now.left + now.width / 2)) / z}px ${(b.top + b.height / 2 - (now.top + now.height / 2)) / z}px`;
      it.el.style.scale = String(b.width / Math.max(1, now.width));
    });
    for (const th of threads) th.classList.add("off");
    void strip.offsetWidth;
    items.forEach((it, i) => {
      it.el.style.transition = `translate .9s cubic-bezier(.5, 0, .2, 1) ${i * 40}ms, scale .9s cubic-bezier(.5, 0, .2, 1) ${i * 40}ms, opacity .6s, transform .8s, filter .6s`;
      it.el.style.translate = "";
      it.el.style.scale = "";
    });
    strip.style.transition = "";
    later(700, () => threads.forEach((th, i) => later(i * 70, () => th.classList.remove("off"))));
  };

  /** The verdict, step by step: stamps, the cut, smuggled words, the caption. */
  const verdict = (/** @type {any} */ v) => {
    overview();
    const gi = items.map((it, i) => (it.kind === "guess" ? i : -1)).filter((i) => i >= 0);
    const died = v.died;
    const alive = died === null || died === undefined ? gi.length : died;
    const stamp = (/** @type {number} */ i, /** @type {string} */ text, /** @type {boolean} */ good) => {
      const it = items[i];
      const st = h("span", { class: `stamp${good ? " blue" : ""}`, style: { "--rot": `${(-6 + jitter(`st${i}`) * 7).toFixed(1)}deg`, "--fs": `calc(${good ? 3.4 : 5}vh * var(--sinv, 1))` } }, text);
      it.card.append(st);
      it.card.classList.remove("thump");
      void it.card.offsetWidth;
      it.card.classList.add("thump");
    };
    for (let g = 0; g < alive; g++) {
      later(350 + g * 650, () => {
        stamp(gi[g], t.alive, true);
        sfx.light();
      });
    }
    const tEnd = 350 + alive * 650 + 150;
    later(tEnd, () => {
      if (died === null || died === undefined) {
        el.append(h("span", { class: "stamp blue bigstamp", style: { "--rot": "-8deg" } }, t.survived), confetti());
        sfx.win();
        return;
      }
      const g = gi[died];
      if (g === undefined) return;
      stamp(g, t.dead, false);
      sfx.stamp();
      later(250, () => {
        const th = threads[g - 1];
        if (th) {
          th.classList.add("cut");
          const a = centre(items[g - 1]);
          const b = centre(items[g]);
          strip.append(h("span", { class: "snip", style: { left: `${(a.x + b.x) / 2}px`, top: `${(a.y + b.y) / 2}px` } }, "✂"));
        }
        sfx.snip();
        for (let i = g; i < items.length; i++) {
          items[i].el.classList.add(i === g ? "killed" : "dead");
          items[i].el.style.setProperty("--fall", `${(jitter(`f${i}`) * 5).toFixed(1)}deg`);
        }
        for (let i = g; i < threads.length; i++) threads[i]?.classList.add("gone");
      });
    });
    // The caption: where it died (or that it lived).
    later(tEnd + 900, () => {
      caption.hidden = false;
      caption.classList.toggle("good", died === null || died === undefined);
      const br = v.break;
      const kids = [];
      if (br) {
        const [a, x, b, y, c] = died === 0 ? t.diedAtOnce(br.drawer.name, br.guesser.name) : t.diedBetween(br.drawer.name, br.guesser.name);
        kids.push(avatar(br.drawer), avatar(br.guesser), h("span", {}, a, h("b", {}, x), b, h("b", {}, y), c, v.judged ? "" : h("small", {}, t.byMachine)));
      } else kids.push(h("span", {}, h("b", {}, t.survivedLine), v.judged ? "" : h("small", {}, t.byMachine)));
      caption.replaceChildren(...kids);
    });
    // Smuggled words: the highlighter, whose word it was.
    /** @type {any[]} */ (v.smuggles ?? []).forEach((sm, j) => {
      later(tEnd + 1700 + j * 2000, () => {
        const it = items[sm.at + 1];
        if (!it?.text) return;
        it.text.classList.remove("writing");
        it.text.replaceChildren(...marked(it.link.text, sm.marks ?? []));
        it.el.append(h("div", { class: "smugtag" }, h("b", {}, sm.word), " · ", t.smuggled(sm.by?.name ?? "")));
        requestAnimationFrame(() => requestAnimationFrame(() => it.text?.querySelectorAll("mark").forEach((m) => m.classList.add("on"))));
        sfx.pop();
      });
    });
  };

  return {
    el,
    update(v) {
      const s = v.screen ?? {};
      if (cursor < 0) requestAnimationFrame(layoutThreads);
      if (s.stage === "show" && s.cursor !== cursor) {
        const first = cursor < 0;
        cursor = s.cursor ?? 0;
        // A TV that joins late shows what was shown already at once.
        if (first) {
          requestAnimationFrame(() => {
            layoutThreads();
            strip.style.transition = "none";
            show(cursor, true);
            void strip.offsetWidth;
            strip.style.transition = "";
          });
        } else show(cursor, true);
      }
      if (s.stage !== stageNow) {
        const was = stageNow;
        stageNow = s.stage;
        if (s.stage === "judge") {
          if (cursor < 0) requestAnimationFrame(layoutThreads);
          cursor = items.length - 1;
          requestAnimationFrame(overview);
          const who = s.chain?.author;
          caption.hidden = false;
          caption.classList.remove("good");
          const bar = deadlineBar(s.deadline ?? 0, s.duration ?? 0, "tick");
          caption.replaceChildren(avatar(who), h("span", {}, who && v.roster?.some((/** @type {any} */ r) => r.id === who.id) ? t.judging(who.name) : t.judgingMachine), h("span", { class: "dots" }, h("i"), h("i"), h("i")), bar);
        }
        if (s.stage === "verdict") {
          caption.hidden = true;
          requestAnimationFrame(() => {
            if (!was) layoutThreads();
            verdict(s.verdict ?? {});
          });
        }
      }
    },
    dispose() {
      for (const d of disposers) d();
    },
  };
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
// The hunt

/**
 * The suspects as polaroids.
 * @param {any[]} suspects
 * @param {boolean} enter animate them in
 */
function polaroids(suspects, enter) {
  return suspects.map((p, i) => {
    const r = `${(jitter(`p${p.id}`) * 3.5).toFixed(1)}deg`;
    const front = h(
      "div",
      { class: "paper polaroid", style: { "--r": r } },
      h("div", { class: "photo", style: { "--c": colorOf(p.id) } }, avatar(p)),
      h("div", { class: "nm" }, p.name),
      p.breaks > 0 ? h("span", { class: "deaths" }, t.atDeaths(p.breaks)) : null,
    );
    const back = h("div", { class: "paper polaroid back", style: { "--r": r } }, h("span", { class: "stamp" }, t.wrecker), h("div", { class: "nm" }, p.name));
    const votes = h("div", { class: "votes" });
    const el = h("div", { class: "suspect", style: { "--d": `${enter ? i * 0.07 : 0}s`, ...(enter ? {} : { animation: "none" }) } }, h("div", { class: "flip" }, front, back), votes);
    return { id: p.id, p, el, votes, front };
  });
}

/** @param {any} s @returns {Scene} */
function accuse(s) {
  const cards = polaroids(s.suspects ?? [], true);
  const count = h("div", { class: "sub" });
  const el = h("div", { class: `scene hunt${cards.length > 6 ? " many" : ""}` }, h("h1", {}, t.whoWrecker), count, h("div", { class: "suspects" }, ...cards.map((c) => c.el)), deadlineBar(s.deadline ?? 0, s.duration ?? 0));
  return {
    el,
    update(v) {
      const done = new Set(/** @type {string[]} */ (v.screen?.done ?? []));
      for (const c of cards) c.el.classList.toggle("voted", done.has(c.id));
      count.textContent = t.voted(done.size, cards.length);
    },
  };
}

/** @param {any} s @returns {Scene} */
function unmask(s) {
  const suspects = /** @type {any[]} */ (s.suspects ?? []);
  const cards = polaroids(suspects, false);
  const title = h("h1", {}, t.theVotes);
  const el = h("div", { class: `scene hunt${cards.length > 6 ? " many" : ""}` }, title, h("div", { class: "sub" }, "\u00a0"), h("div", { class: "suspects" }, ...cards.map((c) => c.el)));
  let at = 300;
  for (const c of cards) {
    const n = c.p.votes ?? 0;
    for (let k = 0; k < n; k++) {
      later(at, () => {
        c.votes.append(h("span", { class: "pin", style: { left: `${18 + ((k * 23) % 64)}%`, top: `${(k % 2) * 1.2}vh`, "--c": "var(--red)" } }));
        sfx.pop();
      });
      at += 200;
    }
    if (n > 0) later(at, () => c.front.append(h("span", { class: "count" }, String(n))));
  }
  const top = Math.max(0, ...suspects.map((p) => p.votes ?? 0));
  const tops = cards.filter((c) => top > 0 && c.p.votes === top);
  at += 500;
  later(at, () => {
    for (const c of tops) c.el.classList.add("top");
    title.textContent = s.wrecker ? t.wreckerWas : t.noWrecker;
    title.style.animation = "none";
    void title.offsetWidth;
    title.style.animation = "";
    if (s.wrecker) sfx.drum();
  });
  at += 1500;
  if (s.wrecker) {
    later(at, () => {
      for (const c of cards) {
        if (c.id === s.wrecker.id) c.el.classList.add("flipped");
        else c.el.classList.add("out");
      }
      sfx.stamp();
    });
    later(at + 1000, () => {
      el.append(
        h(
          "div",
          { class: "outcome" },
          h("span", { class: `stamp${s.caught ? " blue" : ""}`, style: { "--rot": "-6deg" } }, s.caught ? t.caught : t.gotAway),
          h("div", { class: "line" }, t.broke(s.wrecker.name, s.wrecks ?? 0)),
        ),
      );
      if (s.caught) {
        el.append(confetti(50));
        sfx.win();
      } else sfx.stamp();
    });
  }
  return { el };
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
    const gains = [];
    const e = l.earned ?? {};
    for (const k of /** @type {const} */ (["links", "smuggles", "wrecks", "spot", "escape"])) {
      if (e[k] > 0) gains.push(h("span", { class: `gain${k === "wrecks" || k === "escape" ? " red" : ""}` }, `+${num(lang, e[k])} ${t.kinds[k]}`));
    }
    ledger.append(
      h(
        "div",
        { class: "row", style: { "--d": `${0.1 + i * 0.08}s` } },
        h("span", { class: "rk" }, String(rank)),
        avatar(l),
        h("span", { class: "nm" }, l.name),
        h(
          "span",
          { class: "mid" },
          l.word ? h("span", { class: `word${l.smuggled > 0 ? " hit" : ""}` }, `${t.wordWas}: ${l.word}${l.smuggled > 0 ? ` ✓${l.smuggled > 1 ? `×${l.smuggled}` : ""}` : ""}`) : null,
          l.wrecker ? h("span", { class: "w" }, t.wrecker) : null,
          ...gains,
        ),
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
