// @ts-check
/**
 * Drawbluff's TV page: tvpipe casts it with its own browser, or anyone
 * opens the watch link (the host page's preview). It shows the screen
 * view (`{ roster, screen, join }`) in the room's language
 * (`screen.lang`).
 *
 * The TV is a video stream, so its motion is made for one: flat colours
 * (no animated gradients, blur or shadows), continuous motion only in
 * small places (pens, dots, the timer), full-screen motion only in short
 * bursts (a stinger between phases, confetti once). Every player shows
 * in their colour (`screen.colors`). A phase is built once (when its key
 * changes); later views update it in place, keyed by player id, so only
 * what changed animates. `prefers-reduced-motion`: no stingers, no
 * confetti, no ambient motion, shorter drawing in.
 */

import { PartyClient, qrSvg } from "/_tvpipe/lib/client.js";
import { pickLang } from "../phone/i18n.js";
import { drawDrawing, FRAME_MS, framesOf, GRID, PALETTE, PAPER } from "../phone/strokes.js";
import { strings } from "./strings.js";

/**
 * What the TV shows people to type: the short link without its scheme
 * (`tvpipe.party/BCDF`) when tvpipe has one, else the room's code.
 * @param {any} join `view.join`
 * @returns {string}
 */
function joinText(join) {
  const s = join?.short;
  if (typeof s === "string" && /^https?:\/\/[^/?#\s]+\/[A-Za-z]{1,16}$/.test(s)) return s.replace(/^https?:\/\//, "");
  return typeof join?.code === "string" ? join.code : "";
}

const client = PartyClient.fromLocation({ role: /** @type {any} */ (new URLSearchParams(location.hash.slice(1)).get("role") ?? "screen") });
const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const corner = /** @type {HTMLElement} */ (document.getElementById("corner"));
const status = /** @type {HTMLElement} */ (document.getElementById("status"));
const joined = /** @type {HTMLElement} */ (document.getElementById("joined"));

/** The room's language (English until the first view says). */
let lang = pickLang(undefined);
let t = strings(lang);

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
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

/** The QR code: SVG made from the module rows (no text from players in it). */
function qr(/** @type {any} */ join) {
  const box = h("div", { class: "qr" });
  box.innerHTML = qrSvg(join?.qr, { quiet: 3 });
  return box;
}

/** Plays a CSS animation (class `cls`) again. @param {Element} el @param {string} cls */
function replay(el, cls) {
  el.classList.remove(cls);
  void (/** @type {HTMLElement} */ (el).offsetWidth);
  el.classList.add(cls);
}

/** Whether the viewer asked for less motion. */
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------
// Sound: short synthesized cues (tvpipe's browser allows autoplay).

/** The host window's preview has `#mute=1`: the TV plays the sound. */
const MUTED = new URLSearchParams(location.hash.slice(1)).get("mute") === "1";
/** @type {AudioContext | null} */
let audio = null;
/**
 * @param {number[]} notes frequencies, played one after the other
 * @param {number} [len] seconds per note
 * @param {number} [vol] loudness, 0–1
 */
function beep(notes, len = 0.12, vol = 0.25) {
  if (MUTED) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    let t = audio.currentTime + 0.02;
    for (const f of notes) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + len + 0.02);
      t += len * 0.9;
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// The phase's timers and frame loops (gone when the phase changes)

/** @type {Set<ReturnType<typeof setTimeout>>} */
const timers = new Set();
/** @type {Set<(now: number) => boolean | void>} */
const loops = new Set();
let raf = 0;

/** Runs `fn` in `ms` unless the phase changes first. @param {number} ms @param {() => void} fn */
function later(ms, fn) {
  const id = setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
}

/** Runs `fn` every frame until it returns false or the phase changes. @param {(now: number) => boolean | void} fn */
function loop(fn) {
  loops.add(fn);
  raf ||= requestAnimationFrame(frame);
}

/** @param {number} now */
function frame(now) {
  raf = 0;
  for (const f of [...loops]) if (f(now) === false) loops.delete(f);
  // A loop started by a loop has asked for the next frame already.
  if (loops.size > 0) raf ||= requestAnimationFrame(frame);
}

function clearFx() {
  for (const id of timers) clearTimeout(id);
  timers.clear();
  loops.clear();
}

/**
 * Counts a number up in `el` (`fmt` writes it).
 * @param {HTMLElement} el
 * @param {number} from
 * @param {number} to
 * @param {number} ms
 * @param {(n: number) => string} fmt
 */
function countUp(el, from, to, ms, fmt) {
  let t0 = -1;
  loop((now) => {
    if (t0 < 0) t0 = now;
    const f = ms > 0 ? Math.min(1, (now - t0) / ms) : 1;
    el.textContent = fmt(Math.round(from + (to - from) * (1 - (1 - f) ** 3)));
    return f < 1;
  });
}

/**
 * A burst of dots from the middle of `el` (on the stage, above everything).
 * @param {HTMLElement} el
 * @param {string[]} colors
 * @param {number} [n]
 * @param {number} [dist] vh
 * @param {number} [dy] where, down from the middle: a share of the height
 */
function burst(el, colors, n = 10, dist = 7, dy = 0) {
  if (calm() || !el.isConnected) return;
  const box = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const b = h("i", { class: "burst", style: `left:${r.left - box.left + r.width / 2}px;top:${r.top - box.top + r.height * (0.5 + dy)}px` });
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
    const d = dist * (0.7 + Math.random() * 0.5);
    b.append(h("i", { style: `--c:${colors[i % colors.length]};--dx:${(Math.cos(a) * d).toFixed(1)}vh;--dy:${(Math.sin(a) * d).toFixed(1)}vh` }));
  }
  stage.append(b);
  setTimeout(() => b.remove(), 900);
}

// ---------------------------------------------------------------------------
// Players' colours (`screen.colors`, by id)

/** The player colours (game/rules.ts PLAYER_COLORS): a stand-in for players the view has no colour for. */
const PLAYER_COLORS = ["#f13936", "#f68000", "#f4ce23", "#98d423", "#1eab53", "#08b6af", "#3fb1ea", "#3968e8", "#8b46df", "#f153aa"];
/** Player colours that take dark text. */
const LIGHT = new Set(["#f68000", "#f4ce23", "#98d423", "#1eab53", "#08b6af", "#3fb1ea"]);
const HEX = /^#[0-9a-f]{6}$/i;

/** @param {string} id */
function colorOf(id) {
  const c = client.view.screen?.colors?.[id];
  if (typeof c === "string" && HEX.test(c)) return c.toLowerCase();
  let x = 7;
  for (let i = 0; i < id.length; i++) x = (Math.imul(x, 31) + id.charCodeAt(i)) >>> 0;
  return PLAYER_COLORS[x % PLAYER_COLORS.length];
}

/** Text on a colour: dark or light. @param {string} hex */
function textOn(hex) {
  if (LIGHT.has(hex)) return "#1d1d1f";
  if (PLAYER_COLORS.includes(hex)) return "#fffdf6";
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.22 ? "#1d1d1f" : "#fffdf6";
}

/** Gives `el` a player's colour (`--pc`, and `--pt` for text on it). @param {HTMLElement} el @param {string} id */
function tint(el, id) {
  const c = colorOf(id);
  el.style.setProperty("--pc", c);
  el.style.setProperty("--pt", textOn(c));
  return el;
}

/** The room's colours, in join order (at least four). */
function roomColors() {
  /** @type {string[]} */
  const out = [];
  for (const r of client.view.roster ?? []) {
    const c = colorOf(r.id);
    if (!out.includes(c)) out.push(c);
  }
  for (const c of PLAYER_COLORS) if (out.length < 4 && !out.includes(c)) out.push(c);
  return out;
}

/** @param {string} id */
function nameOf(id) {
  return (client.view.roster ?? []).find((/** @type {any} */ r) => r.id === id)?.name ?? "?";
}

/** A name's first letter. @param {string} name */
function initial(name) {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

/** A player's round badge with their initial. @param {string} id @param {string} [name] */
function avatar(id, name = nameOf(id)) {
  return tint(h("span", { class: "av" }, initial(name)), id);
}

/** A player's name on their colour. @param {string} id @param {string} [name] */
function chip(id, name = nameOf(id)) {
  return tint(h("span", { class: "pchip" }, name), id);
}

// ---------------------------------------------------------------------------
// Drawings

/** Sizes a canvas to its box (sharp on HiDPI); its size in pixels. @param {HTMLCanvasElement} el */
function fit(el) {
  const r = el.getBoundingClientRect();
  const d = Math.min(2, window.devicePixelRatio || 1);
  el.width = el.height = Math.max(1, Math.round(r.width * d));
  return el.width;
}

/**
 * One piece of a stroke (`p`: from point p−1 to p; a dot: 0), as `drawStroke` draws it.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} s
 * @param {number} p
 * @param {number} k pixels per grid unit
 * @param {readonly string[]} palette
 */
function segment(ctx, s, p, k, palette) {
  const c = palette[s[0]];
  ctx.strokeStyle = ctx.fillStyle = typeof c === "string" && HEX.test(c) ? c : "#1d1d1f";
  ctx.lineWidth = Math.max(1, s[1] * k);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (s.length === 4) {
    ctx.arc(s[2] * k, s[3] * k, Math.max(0.5, (s[1] * k) / 2), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.moveTo(s[2 * p] * k, s[2 * p + 1] * k);
  ctx.lineTo(s[2 * p + 2] * k, s[2 * p + 3] * k);
  ctx.stroke();
}

/** A drawing's pieces in order, as [stroke, point] pairs. @param {any} drawing */
function pieces(drawing) {
  const strokes = Array.isArray(drawing?.strokes) ? drawing.strokes : [];
  /** @type {number[]} */
  const out = [];
  strokes.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    if (!Array.isArray(s) || s.length < 4) return;
    const n = (s.length - 2) >> 1;
    if (n === 1) out.push(i, 0);
    else for (let p = 1; p < n; p++) out.push(i, p);
  });
  return out;
}

/** How long a drawing takes to draw itself in: its length, 1.8–3.5 s. @param {any} drawing */
function drawTime(drawing) {
  return Math.max(1800, Math.min(3500, (pieces(drawing).length / 2) * 7));
}

/**
 * An animation's frames in turn, {@link FRAME_MS} each (twice that with
 * reduced motion), from the second, while the canvas is on the stage.
 * The page's motion is the drawing's own: whole frames, nothing between.
 * @param {HTMLCanvasElement} el
 * @param {CanvasRenderingContext2D} ctx
 * @param {any} drawing
 * @param {number} size
 */
function flip(el, ctx, drawing, size) {
  const n = framesOf(drawing).length;
  if (n < 2) return;
  const every = calm() ? 2 * FRAME_MS : FRAME_MS;
  let t0 = -1;
  let shown = 0;
  loop((now) => {
    if (!el.isConnected && t0 >= 0) return false;
    if (t0 < 0) t0 = now;
    const f = (1 + Math.floor((now - t0) / every)) % n;
    if (f !== shown) {
      shown = f;
      drawDrawing(ctx, drawing, 0, 0, size, { frame: f });
    }
  });
}

/**
 * Draws a drawing into a canvas stroke by stroke, like watching it being
 * drawn (each frame adds its pieces; `ms` 0: at once); an animation draws
 * its first frame in, then flips through its frames.
 * @param {HTMLCanvasElement} el
 * @param {any} drawing
 * @param {number} ms
 * @param {number} [delay]
 * @param {() => void} [done]
 */
function drawIn(el, drawing, ms, delay = 0, done) {
  if (calm()) ms = Math.min(ms, 700);
  later(delay, () => {
    const size = fit(el);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    if (ms <= 0) {
      drawDrawing(ctx, drawing, 0, 0, size);
      flip(el, ctx, drawing, size);
      done?.();
      return;
    }
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, size, size);
    const strokes = drawing?.strokes ?? [];
    const palette = Array.isArray(drawing?.palette) ? drawing.palette : PALETTE;
    const all = pieces(drawing);
    const k = size / GRID;
    let i = 0;
    let t0 = -1;
    loop((now) => {
      if (t0 < 0) t0 = now;
      const f = Math.min(1, (now - t0) / ms);
      const want = Math.floor((all.length / 2) * f);
      for (; i < want; i++) segment(ctx, strokes[all[2 * i]], all[2 * i + 1], k, palette);
      if (f < 1) return true;
      flip(el, ctx, drawing, size);
      done?.();
      return false;
    });
  });
}

/** Drawings drawn in already (`round:spot:artist`): the vote keeps the lie's. */
const drawnIn = new Set();

/**
 * The spotlight's drawing on paper, taped in its artist's colour.
 * @param {Record<string, any>} s the screen view
 * @param {boolean} [still] never draw it in
 */
function paper(s, still = false) {
  const cv = /** @type {HTMLCanvasElement} */ (h("canvas"));
  const key = `${s.round}:${s.spot}:${s.artist?.id}`;
  const fresh = !still && !drawnIn.has(key);
  drawnIn.add(key);
  const el = h("div", { class: `paper${fresh && !calm() ? " slide" : ""}` }, cv, h("i", { class: "tape a" }), h("i", { class: "tape b" }));
  tint(el, s.artist?.id ?? "");
  drawIn(cv, s.drawing, fresh ? drawTime(s.drawing) : 0, fresh ? 650 : 0);
  return el;
}

// ---------------------------------------------------------------------------
// Stingers: the phase's word on bands in the room's colours

/** @type {HTMLElement | null} */
let stinger = null;

/**
 * @param {string} label
 * @param {string} [sub]
 */
function sting(label, sub) {
  stinger?.remove();
  const cols = roomColors();
  const box = h("i", { class: "sting" });
  for (let i = 0; i < 8; i++) box.append(h("i", { style: `left:${i * 14 - 10}%;background:${cols[i % cols.length]};transition-delay:${i * 30}ms` }));
  const word = h("b", {}, label);
  box.append(h("i", { class: "st" }, sub ? h("small", {}, sub) : null, word));
  document.body.insertBefore(box, corner);
  stinger = box;
  // Long words in a smaller size.
  const max = window.innerWidth * 0.9;
  if (word.scrollWidth > max) word.style.fontSize = `${(13 * max) / word.scrollWidth}vh`;
  requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add("in")));
  setTimeout(() => {
    box.querySelectorAll(":scope > i:not(.st)").forEach((b, i) => /** @type {HTMLElement} */ (b).style.setProperty("transition-delay", `${i * 25}ms`));
    box.classList.add("out");
  }, 900);
  setTimeout(() => {
    box.remove();
    if (stinger === box) stinger = null;
  }, 1400);
}

/**
 * The stinger for a change of phase, if it gets one.
 * @param {string} prev the phase on the stage
 * @param {string} prevSpot its spotlight (`round:spot`)
 * @param {Record<string, any>} s the new screen view
 * @returns {[string, string?] | null}
 */
function stingFor(prev, prevSpot, s) {
  if (!prev || prev === "lobby" && s.phase !== "draw") return null;
  const spot = s.spots > 1 ? t.drawingOf(s.spot, s.spots) : typeof s.round === "number" ? t.roundN(s.round) : undefined;
  switch (s.phase) {
    case "draw":
      return [t.stDraw, t.roundOf(s.round, s.rounds)];
    case "gallery":
      return prev === "draw" ? [t.stPens] : null;
    case "lie":
      return prev === "draw" ? [t.stPens] : [t.stBluff, spot];
    case "vote":
      if (prev === "lie" && prevSpot === `${s.round}:${s.spot}`) return null;
      return prev === "draw" ? [t.stPens] : [t.stVote, spot];
    case "scores":
      return [t.stScores, typeof s.round === "number" ? t.roundOf(s.round, s.rounds) : undefined];
    case "final":
      return [t.stFinal];
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------

let shown = "";
let lastPhase = "";
let lastStep = 0;
/** The phase and spotlight on the stage. */
let onStage = { phase: "", spot: "" };
/** A build waiting for a stinger or a page turn. */
let pending = 0;
/** @type {(() => void) | null} */
let refresh = null;

client.on("view", (view) => render(view));
client.on("status", (s) => {
  status.hidden = s === "open";
  status.textContent = s === "reconnecting" || s === "connecting" ? t.reconnecting : s === "closed" ? t.over : "";
});

/** @param {Record<string, any>} view */
function render(view) {
  const s = view.screen ?? {};
  const l = pickLang(s.lang);
  if (l !== lang) {
    lang = l;
    t = strings(l);
    document.documentElement.lang = l;
  }
  const key = `${lang}:${s.phase}:${s.round ?? ""}:${s.deadline ?? ""}:${s.artist?.id ?? ""}:${s.page ?? ""}`;
  if (s.phase !== lastPhase) {
    if (s.phase === "draw" || s.phase === "lie" || s.phase === "vote" || s.phase === "gallery") beep([523, 659, 784]);
    if (s.phase === "final") beep([523, 659, 784, 1047], 0.18);
    if (s.phase === "draw") drawnIn.clear();
    lastPhase = s.phase;
    lastStep = 0;
  }
  if (key !== shown) {
    shown = key;
    refresh = null;
    clearTimeout(pending);
    pending = 0;
    const prev = onStage;
    onStage = { phase: s.phase, spot: `${s.round}:${s.spot}` };
    const st = calm() ? null : stingFor(prev.phase, prev.spot, s);
    // The gallery's next page: the last one falls away first.
    const turn = !st && prev.phase === "gallery" && s.phase === "gallery" && !calm();
    if (st) sting(st[0], st[1]);
    if (turn) for (const p of stage.querySelectorAll(".pol")) p.classList.add("away");
    if (st || turn) {
      pending = setTimeout(
        () => {
          pending = 0;
          build(client.view);
          refresh?.();
        },
        st ? 480 : 450,
      );
    } else build(view);
  }
  refresh?.();
  // Not in the lobby (the big code), nor where the options fill the
  // right side, nor when the game is closed to newcomers.
  const late = /** @type {"open" | "wait" | "closed"} */ (view.join?.lateJoin ?? "wait");
  corner.hidden = s.phase === "lobby" || s.phase === "vote" || s.phase === "reveal" || !s.phase || !view.join?.qr || late === "closed";
  if (!corner.hidden && corner.dataset.url !== view.join.url) {
    corner.dataset.url = view.join.url;
    /** @type {HTMLElement} */ (document.getElementById("corner-qr")).innerHTML = qrSvg(view.join.qr, { quiet: 2 });
  }
  if (!corner.hidden) /** @type {HTMLElement} */ (document.getElementById("corner-text")).textContent = t.corner[late] ?? "";
  // Elsewhere tvpipe's rejoin badge shows the code while a phone is away.
  client.joinVisible = !corner.hidden || s.phase === "lobby";
  // This round's newcomers, discreetly.
  const names = /** @type {string[]} */ (s.phase !== "lobby" && Array.isArray(s.joined) ? s.joined : []);
  const more = typeof s.joinedMore === "number" ? s.joinedMore : 0;
  joined.hidden = names.length === 0;
  joined.textContent = [...names.map((n) => `+ ${n}`), ...(more > 0 ? [t.joinedMore(more)] : [])].join(" · ");
  // The stage keeps the corners free for them.
  document.body.classList.toggle("corner-on", !corner.hidden);
  document.body.classList.toggle("joined-on", !joined.hidden);
}

/** @param {Record<string, any>} view */
function build(view) {
  const s = view.screen ?? {};
  ticker = null;
  clearFx();
  stage.className = `at-${s.phase ?? "none"}`;
  switch (s.phase) {
    case "lobby":
      return lobby(view);
    case "draw":
      return draw(view);
    case "gallery":
      return gallery(view);
    case "lie":
    case "vote":
      return guess(view);
    case "reveal":
      return reveal(view);
    case "scores":
      return scores(view);
    case "final":
      return final(view);
    default:
      stage.replaceChildren(h("div", { class: "col grow center" }, h("div", { class: "logo", style: "font-size:8vh" }, "Drawbluff")));
  }
}

// ---------------------------------------------------------------------------
// The lobby

/** @param {Record<string, any>} view */
function lobby(view) {
  const players = h("div", { class: "players" });
  const hint = h("p", { class: "hint" });
  const lateLine = h("div", { class: "late" });
  const badges = h("div", { class: "badges" });
  const count = h("span", { class: "count" });
  // The QR code (the direct link) and the short link to type
  // (tvpipe.party/CODE), which may come a moment after the tunnel.
  const qrBox = qr(view.join);
  qrBox.dataset.url = view.join?.url ?? "";
  const short = h("div", { class: "short" });
  const shortHost = h("span", { class: "host" });
  const shortCode = h("span", { class: "code" });
  short.append(shortHost, shortCode);
  const letters = Array.from("Drawbluff", (c, i) => h("span", { style: `--i:${i}` }, c));
  stage.replaceChildren(
    h(
      "div",
      { class: "col join" },
      h("div", { class: "logo" }, ...letters),
      h("h2", {}, t.scanToJoin),
      qrBox,
      short,
      lateLine,
    ),
    h("div", { class: "col grow" }, h("h1", { class: "with-count" }, t.players, count), badges, players, hint),
  );
  /** @type {Map<string, { el: HTMLElement, av: HTMLElement, name: HTMLElement, star: HTMLElement, color: string }>} */
  const cards = new Map();
  /** @type {Map<string, { el: HTMLElement, was: string }>} */
  const shownBadges = new Map();
  let first = true;
  refresh = () => {
    const v = client.view;
    const s = v.screen ?? {};
    const roster = v.roster ?? [];
    const late = /** @type {"open" | "wait" | "closed"} */ (v.join?.lateJoin ?? "wait");
    if (qrBox.dataset.url !== (v.join?.url ?? "")) {
      qrBox.dataset.url = v.join?.url ?? "";
      qrBox.innerHTML = qrSvg(v.join?.qr, { quiet: 3 });
    }
    const text = joinText(v.join);
    const cut = text.lastIndexOf("/") + 1;
    shortHost.textContent = text.slice(0, cut);
    shortCode.textContent = text.slice(cut);
    short.hidden = !text;
    lateLine.textContent = t.late[late] ?? "";
    lateLine.classList.toggle("open", late === "open");
    const max = s.maxPlayers ?? 8;
    const min = s.minPlayers ?? 3;
    const cols = roomColors();
    letters.forEach((el, i) => el.style.setProperty("--lc", cols[i % cols.length]));
    // A card per player, kept by id: only newcomers pop.
    const seen = new Set();
    roster.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
      seen.add(r.id);
      let c = cards.get(r.id);
      if (!c) {
        const av = h("span", { class: "av" });
        const name = h("span", { class: "n" });
        const star = h("span", { class: "star" }, "★ VIP");
        const el = h("div", { class: "player pop" }, av, name, star);
        if (first) el.style.animationDelay = `${Math.min(i, 15) * 35}ms`;
        c = { el, av, name, star, color: "" };
        cards.set(r.id, c);
      }
      const card = c;
      const color = colorOf(r.id);
      if (card.color !== color) {
        // A new colour: the badge flips, and turns at the middle.
        const paint = () => {
          tint(card.el, r.id);
          tint(card.av, r.id);
        };
        if (card.color && !calm()) {
          replay(card.av, "flip");
          later(250, paint);
        } else paint();
        card.color = color;
      }
      card.av.textContent = initial(r.name);
      card.name.textContent = r.name;
      card.star.hidden = !r.vip;
      card.el.classList.toggle("away", !r.connected);
      if (players.children[i] !== card.el) players.insertBefore(card.el, players.children[i] ?? null);
    });
    for (const [id, c] of cards) {
      if (seen.has(id)) continue;
      c.el.remove();
      cards.delete(id);
    }
    // Empty seats up to 8, after the cards; past 8 players a denser grid (up to 50 names).
    const seats = Math.max(0, Math.min(max, 8) - roster.length);
    const empty = [...players.querySelectorAll(".empty")];
    for (const e of empty.slice(seats)) e.remove();
    for (let i = empty.length; i < seats; i++) players.append(h("div", { class: "player empty" }));
    [...players.querySelectorAll(".empty")].forEach((e, i) => (e.textContent = roster.length + i < min ? t.seatWaiting : t.seatFree));
    players.className = `players${roster.length > 24 ? " many" : roster.length > 8 ? " more" : ""}`;
    if (count.textContent !== String(roster.length)) {
      count.textContent = String(roster.length);
      if (!first) replay(count, "bump");
    }
    const ready = roster.filter((/** @type {any} */ r) => r.connected).length;
    hint.textContent = ready < min ? t.needed(min - ready) : t.vipStarts(roster.find((/** @type {any} */ r) => r.vip)?.name);
    // The rules: rounds, animation, undo, colours, adult prompts; one that changes flips.
    /** @type {[string, string, string, string[] | null, boolean][]} */
    const spec = [
      ["rounds", typeof s.rounds === "number" ? t.roundsN(s.rounds) : "", "", null, typeof s.rounds !== "number"],
      ["animate", t.animated, "", null, !s.animate],
      ["undo", s.undo ? t.undoOn : t.undoOff, s.undo ? "" : "off", null, false],
      ["colors", s.colorMode ? t.colorMode : t.shades, "", s.colorMode ? ["#1d1d1f", "#e5383b", "#ffd60a", "#2a9d8f", "#3a86ff"] : ["#3b2a7a", "#b3a6f2"], false],
      ["adult", t.adult, "hot", null, !s.adult],
    ];
    for (const [k, text, cls, swatches, hide] of spec) {
      let b = shownBadges.get(k);
      if (!b) {
        b = { el: h("span", { class: "badge" }), was: "" };
        shownBadges.set(k, b);
        badges.append(b.el);
      }
      const now = `${text}:${hide}`;
      b.el.hidden = hide;
      if (b.was === now) continue;
      b.el.className = `badge ${cls}`;
      b.el.replaceChildren(...(swatches ? [h("span", { class: "sw" }, ...swatches.map((c) => h("i", { style: `background:${c}` })))] : []), text);
      if (b.was && !hide) replay(b.el, "flip");
      b.was = now;
    }
    if (roster.length > lobbyCount) beep([660, 880]);
    lobbyCount = roster.length;
    first = false;
  };
}
let lobbyCount = 0;

// ---------------------------------------------------------------------------
// Timers

/** The countdown ring (`screen.deadline`). */
function ring() {
  const el = h("div", { class: "ring" });
  el.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="trk" cx="50" cy="50" r="44"/><circle class="arc" cx="50" cy="50" r="44" pathLength="100"/></svg>';
  const num = h("span", {});
  el.append(num);
  const arc = /** @type {SVGElement} */ (el.querySelector(".arc"));
  let total = 0;
  let last = -1;
  /** Seconds left (or null). */
  const update = () => {
    const d = client.view.screen?.deadline;
    if (typeof d !== "number") return null;
    const left = Math.max(0, (d - client.now()) / 1000);
    total = Math.max(total, left, 1);
    arc.style.strokeDashoffset = String(100 * (1 - left / total));
    const sec = Math.ceil(left);
    if (sec !== last) {
      last = sec;
      num.textContent = String(sec);
      el.classList.toggle("low", sec <= 10);
      if (sec <= 10 && sec > 0) replay(el, "pulse");
    }
    return left;
  };
  update();
  return { el, update };
}
setInterval(() => ticker?.(), 250);
/** @type {(() => void) | null} */
let ticker = null;

// ---------------------------------------------------------------------------
// Drawing: a card per drawer, its ink line growing as they draw

/** `ink` that fills a line most of the way (1 − e^(−ink/INK)). */
const INK = 300;

/**
 * An abstract loop-the-loop line (300 wide, `height` high) and where along it a share of its length is.
 * @param {number} seed
 * @param {number} height
 */
function scribble(seed, height) {
  let x = (seed * 2654435761) >>> 0;
  const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
  const loops = 6 + Math.floor(rnd() * 3);
  const amp = height * (0.22 + rnd() * 0.08);
  const ph = rnd() * 6;
  /** @type {[number, number][]} */
  const pts = [];
  for (let k = 0; k <= 240; k++) {
    const f = k / 240;
    const w = f * loops * 2 * Math.PI;
    pts.push([12 + f * 258 - 9 * Math.sin(w), height / 2 + 2 - amp * Math.cos(w) * (0.75 + 0.25 * Math.sin(f * 5 + ph)) + height * 0.08 * Math.sin(f * 7 + ph)]);
  }
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  /** @param {number} f */
  const at = (f) => {
    const want = f * cum[cum.length - 1];
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cum[m] < want) lo = m + 1;
      else hi = m;
    }
    return pts[lo];
  };
  return { d: "M" + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L"), at };
}

const PENCIL =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 22 L4 15 L17 2 L22 7 L9 20 Z" style="fill:var(--pc)" stroke="#1d1d1f" stroke-width="1.4" stroke-linejoin="round"/><path d="M2 22 L4 15 L9 20 Z" fill="#fde9c8" stroke="#1d1d1f" stroke-width="1.4" stroke-linejoin="round"/><path d="M2 22 L3 18.6 L5.4 21 Z" fill="#1d1d1f"/><path d="M14.5 4.5 L19.5 9.5" stroke="#1d1d1f" stroke-width="1.2"/></svg>';

/** Faint doodles drifting behind the cards. */
function doodles() {
  const layer = h("i", { class: "doodles" });
  const shapes = [
    "M10 50 Q 30 0 50 50 T 90 50",
    "M50 10 L61 38 L92 40 L67 58 L76 88 L50 70 L24 88 L33 58 L8 40 L39 38 Z",
    "M50 50 m-5 0 a5 5 0 1 1 10 0 a10 10 0 1 1 -20 0 a15 15 0 1 1 30 0 a20 20 0 1 1 -40 0",
    "M20 80 L45 45 L35 45 L60 10",
    "M50 85 C 10 55 15 20 50 38 C 85 20 90 55 50 85 Z",
  ];
  const spots = [[2, 70], [58, 1], [44, 88], [27, 3], [90, 40]];
  layer.innerHTML = shapes
    .map((d, i) => {
      const z = 11 + (i % 3) * 3;
      return `<svg viewBox="0 0 100 100" aria-hidden="true" style="left:${spots[i][0]}vw;top:${spots[i][1]}vh;width:${z}vh;height:${z}vh;--d:${11 + i * 1.7}s;--fx:${i % 2 ? 2 : -2}vh;--fy:${i % 3 ? -2 : 2}vh;--fr:${i % 2 ? 8 : -8}deg"><path d="${d}"/></svg>`;
    })
    .join("");
  return layer;
}

/** @param {Record<string, any>} view */
function draw(view) {
  const s = view.screen;
  const ids = /** @type {string[]} */ (s.waiting ?? []);
  const n = ids.length;
  const mode = n <= 8 ? "big" : n <= 24 ? "mid" : "tiny";
  const cols = mode === "big" ? (n <= 3 ? Math.max(1, n) : n === 4 ? 2 : n <= 6 ? 3 : 4) : mode === "mid" ? (n <= 16 ? 4 : 6) : 10;
  const height = mode === "big" ? 84 : 64;
  const clock = ring();
  const count = h("div", { class: "dcount" });
  const title = h("div", { class: "big-title" }, s.animate ? t.drawAnimated : t.drawPrompt);
  const grid = h("div", { class: `dgrid ${mode}`, style: `--cols:${cols}` });
  const big = h("div", { class: "bigcount" });
  const root = h(
    "div",
    { class: "draw col grow" },
    h("div", { class: "dhead" }, h("div", { class: "col grow" }, h("h2", {}, t.roundOf(s.round, s.rounds)), title), h("div", { class: "dclock" }, count, clock.el)),
    grid,
  );
  stage.replaceChildren(...(calm() ? [] : [doodles()]), root, big);

  /**
   * @typedef {{ id: string, el: HTMLElement, stt: HTMLElement | null, paths: SVGPathElement[], pen: HTMLElement | null, fill: HTMLElement | null,
   *   at: ((f: number) => [number, number]) | null, ink: number, shown: number, grew: number, msg: string, msgUntil: number, done: boolean, status: string }} Card
   */
  /** @type {Card[]} */
  const cards = ids.map((id, i) => {
    /** @type {Card} */
    const c = { id, el: h("div"), stt: null, paths: [], pen: null, fill: null, at: null, ink: 0, shown: 0, grew: 0, msg: "", msgUntil: 0, done: false, status: "" };
    if (mode === "tiny") {
      c.fill = h("b", {});
      c.el = h("div", { class: "tt" }, h("span", { class: "nm" }, nameOf(id)), h("i", { class: "bar" }, c.fill), h("i", { class: "tp" }));
    } else {
      const g = scribble(i + 1, height);
      c.at = g.at;
      const line = h("i", { class: "scrib", style: `aspect-ratio:300/${height}` });
      line.innerHTML = `<svg viewBox="0 0 300 ${height}" aria-hidden="true"><path class="u nil" pathLength="1" d="${g.d}"/><path class="o nil" pathLength="1" d="${g.d}"/></svg>`;
      c.paths = [...line.querySelectorAll("path")];
      c.pen = h("i", { class: "pen" });
      c.pen.innerHTML = PENCIL;
      line.append(c.pen);
      c.stt = h("span", { class: "stt" });
      c.el = h("div", { class: "dc" }, h("div", { class: "dc-top" }, avatar(id), h("span", { class: "nm" }, nameOf(id)), c.stt), line, h("i", { class: "stamp" }, t.stampDone));
    }
    tint(c.el, id);
    if (!calm()) {
      c.el.classList.add("deal");
      c.el.style.animationDelay = `${i * (mode === "tiny" ? 12 : 50)}ms`;
    }
    grid.append(c.el);
    return c;
  });
  let hurry = false;
  let lastBig = -1;
  let moving = false;

  /** The lines ease to their ink, the pens ride their tips. */
  const animate = () => {
    if (moving) return;
    moving = true;
    let last = -1;
    loop((now) => {
      const dt = last < 0 ? 0.016 : Math.min(0.1, (now - last) / 1000);
      last = now;
      let busy = false;
      for (const c of cards) {
        const target = 1 - Math.exp(-c.ink / INK);
        if (Math.abs(target - c.shown) < 0.001) continue;
        busy = true;
        c.shown += (target - c.shown) * Math.min(1, dt * 4);
        if (Math.abs(target - c.shown) < 0.001) c.shown = target;
        if (c.fill) c.fill.style.width = `${(c.shown * 100).toFixed(1)}%`;
        for (const p of c.paths) {
          p.style.strokeDashoffset = String(1 - c.shown);
          p.classList.toggle("nil", c.shown < 0.004);
        }
        if (c.pen && c.at) {
          const [x, y] = c.at(Math.max(0.0001, c.shown));
          c.pen.style.left = `${(x / 3).toFixed(2)}%`;
          c.pen.style.top = `${((y / height) * 100).toFixed(2)}%`;
        }
      }
      moving = busy;
      return busy;
    });
  };

  /** Statuses, the pens, the last seconds. */
  const tick = () => {
    const left = clock.update();
    const now = performance.now();
    const hasInk = typeof client.view.screen?.ink === "object";
    for (const c of cards) {
      if (c.done) continue;
      const active = !hasInk || now - c.grew < 1600;
      c.el.classList.toggle("active", active);
      if (!c.stt) continue;
      const st = now < c.msgUntil ? c.msg : hurry ? t.hurry : active ? t.drawingNow : t.thinking;
      if (st === c.status) continue;
      c.status = st;
      c.stt.textContent = st;
      c.stt.classList.toggle("hot", hurry || now < c.msgUntil);
    }
    if (left == null) return;
    if (!hurry && left <= 10 && cards.some((c) => !c.done)) {
      hurry = true;
      root.classList.add("hurry");
      title.textContent = t.lastSeconds;
      replay(title, "swap");
      for (const c of cards) if (!c.done) c.el.classList.add("hurrying");
    }
    const sec = Math.ceil(left);
    if (hurry && left <= 5 && sec >= 1 && sec !== lastBig) {
      lastBig = sec;
      beep([1175], 0.05, 0.15);
      if (!calm()) {
        big.textContent = String(sec);
        replay(big, "go");
      }
    }
  };

  /** @param {Card} c */
  const finish = (c) => {
    c.done = true;
    c.el.classList.remove("active", "hurrying");
    c.el.classList.add("done");
    if (c.stt) {
      c.stt.textContent = t.doneShort;
      c.stt.classList.remove("hot");
      later(150, () => burst(c.el, [colorOf(c.id), "#ffd60a", "#fffdf6"], 12, 7, 0.1));
    } else if (!calm()) replay(c.el, "flash");
    if (n <= 12) beep([784, 1047], 0.07, 0.15);
  };

  let firstView = true;
  refresh = () => {
    const v = client.view.screen ?? {};
    const done = new Set(v.done ?? []);
    const ink = v.ink && typeof v.ink === "object" ? v.ink : {};
    const now = performance.now();
    for (const c of cards) {
      const x = Math.max(0, Number(ink[c.id]) || 0);
      if (x > c.ink + 0.5) c.grew = firstView ? 0 : now;
      else if (x < c.ink - 0.5 && x < 1 && c.ink >= 20 && !c.done) {
        // Cleared the pad: the line pulls back with a puff.
        c.msg = t.startedOver;
        c.msgUntil = now + 2500;
        if (c.stt) burst(c.el, ["#d9d4e8", "#fffdf6"], 9, 6, 0.12);
      }
      c.ink = x;
      if (done.has(c.id) && !c.done) {
        if (firstView) {
          c.done = true;
          c.el.classList.add("done");
          if (c.stt) c.stt.textContent = t.doneShort;
        } else finish(c);
      }
    }
    const d = cards.filter((c) => c.done).length;
    count.replaceChildren(t.nOf(d, n), h("small", {}, t.doneWord));
    firstView = false;
    animate();
    tick();
  };
  ticker = tick;
}

// ---------------------------------------------------------------------------
// The gallery: the round's drawings that do not get the stage

/** @param {Record<string, any>} view */
function gallery(view) {
  const s = view.screen;
  const line = h("span", {});
  const liarIds = /** @type {string[]} */ (s.liars ?? []);
  const rings = new Map(liarIds.map((id) => [id, tint(h("i", { class: "lr" }), id)]));
  const cells = (s.items ?? []).map((/** @type {any} */ it, /** @type {number} */ i) => {
    const cv = /** @type {HTMLCanvasElement} */ (h("canvas"));
    const cap = h("div", { class: "cap" }, h("b", {}, it.prompt), h("span", {}, avatar(it.id, it.name), t.by(it.name)));
    const pol = h("div", { class: `pol${calm() ? "" : " drop"}`, style: `--r:${(((i * 37) % 7) - 3).toFixed(1)}deg;animation-delay:${i * 110}ms` }, h("i", { class: "tape" }), cv, cap);
    tint(pol, it.id);
    drawIn(cv, it.drawing, 1500, calm() ? 0 : 450 + i * 110, () => cap.classList.add("on"));
    return pol;
  });
  stage.replaceChildren(
    h(
      "div",
      { class: "col grow" },
      h("h2", {}, t.gallery(s.round, s.page, s.pages)),
      h("div", { class: "pgrid" }, ...cells),
      liarIds.length > 0 ? h("div", { class: "meanwhile" }, line, h("span", { class: "rings" }, ...rings.values())) : null,
    ),
  );
  refresh = () => {
    const v = client.view.screen ?? {};
    const done = new Set(v.done ?? []);
    const typing = new Set(v.typing ?? []);
    line.textContent = t.meanwhile(liarIds.length, v.artist?.name, done.size);
    for (const [id, r] of rings) {
      if (done.has(id) && !r.classList.contains("on")) r.classList.add("on");
      r.classList.toggle("typ", typing.has(id) && !done.has(id));
    }
  };
}

// ---------------------------------------------------------------------------
// Lies and votes: the drawing, and who is writing or voting

/** @param {Record<string, any>} view */
function guess(view) {
  const s = view.screen;
  const clock = ring();
  const spot = s.spots > 1 ? t.spotOf(s.spot, s.spots) : "";
  const waiting = /** @type {string[]} */ (s.waiting ?? []);
  // The vote after the lie of the same drawing: the drawing stays, a ribbon sweeps the right side.
  const inPlace = s.phase === "vote" && drawnIn.has(`${s.round}:${s.spot}:${s.artist?.id}`) && !calm();
  const pic = paper(s);
  if (s.phase === "lie") {
    const count = h("span", { class: "vcount" });
    const chips = new Map(
      waiting.map((id) => [id, tint(h("span", { class: "lchip" }, avatar(id), nameOf(id), h("i", { class: "typing" }, h("b", {}), h("b", {}), h("b", {})), h("span", { class: "ck" }, "✓")), id)]),
    );
    const artist = s.artist?.id ?? "";
    const right = h(
      "div",
      { class: "col grow right" },
      h("h2", {}, `${t.roundN(s.round)}${spot}`),
      h("div", { class: `byline${calm() ? "" : " slidein"}` }, t.drewBefore, chip(artist, s.artist?.name ?? "?"), t.drewAfter),
      h("h1", {}, t.liarsWriting(waiting.length)),
      h("div", { class: "lrow" }, clock.el, count),
      waiting.length <= 12 ? h("div", { class: "lchips" }, ...chips.values()) : null,
    );
    stage.replaceChildren(pic, right);
    refresh = () => {
      const v = client.view.screen ?? {};
      const done = new Set(v.done ?? []);
      const typing = new Set(v.typing ?? []);
      for (const [id, c] of chips) {
        if (done.has(id) && !c.classList.contains("done")) c.classList.add("done");
        c.classList.toggle("typ", typing.has(id) && !done.has(id));
      }
      count.textContent = t.done(waiting.filter((id) => done.has(id)).length, waiting.length);
    };
  } else {
    const options = /** @type {any[]} */ (s.options ?? []);
    const dots = new Map(waiting.map((id) => [id, tint(h("i", { class: "vd" }), id)]));
    const count = h("span", { class: "vcount" });
    const opts = h(
      "div",
      { class: `opts${options.length >= 6 ? " many" : ""}` },
      ...options.map((o, i) => h("div", { class: `opt${calm() ? "" : " in"}`, style: `animation-delay:${(inPlace ? 350 : 150) + i * 80}ms` }, o.text)),
    );
    const right = h(
      "div",
      { class: "col grow right" },
      h("h2", {}, `${t.whichReal}${spot}`),
      opts,
      h("div", { class: "lrow vrow" }, clock.el, h("div", { class: `vdots${waiting.length > 16 ? " many" : ""}` }, ...dots.values())),
      h("div", { class: "lrow" }, count),
      s.writing > 0 ? h("p", { class: "hint small" }, t.writingNext(s.writing)) : null,
    );
    if (inPlace) {
      const rib = h("i", { class: "ribbon go", "data-t": t.stVote });
      right.append(h("i", { class: "ribwrap" }, rib));
      later(1100, () => rib.parentElement?.remove());
    }
    stage.replaceChildren(pic, right);
    refresh = () => {
      const v = client.view.screen ?? {};
      const done = new Set(v.done ?? []);
      for (const [id, d] of dots) if (done.has(id) && !d.classList.contains("on")) d.classList.add("on");
      count.textContent = t.voted(waiting.filter((id) => done.has(id)).length, waiting.length);
    };
  }
  ticker = clock.update;
}

// ---------------------------------------------------------------------------
// The reveal: votes fly onto the answers, a stamp, the points

/** @param {Record<string, any>} view */
function reveal(view) {
  const s = view.screen;
  const items = /** @type {any[]} */ (s.items ?? []);
  const many = items.length > 4;
  const stepMs = typeof s.stepMs === "number" && s.stepMs > 0 ? s.stepMs : 2600;
  const artist = s.artist?.id ?? "";
  // The ballots: every vote a dot (the first voters' in their colour), mixed.
  /** @type {{ el: HTMLElement, item: number }[]} */
  const ballots = [];
  items.forEach((it, k) => {
    const ids = /** @type {string[]} */ (Array.isArray(it.voterIds) ? it.voterIds : []);
    const total = Math.max(ids.length, typeof it.count === "number" ? it.count : (it.voters ?? []).length);
    for (let j = 0; j < total; j++) ballots.push({ el: j < ids.length ? tint(h("i", {}), ids[j]) : h("i", { class: "anon" }), item: k });
  });
  let seed = 0;
  for (const c of `${s.round}:${s.spot}`) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  for (let i = ballots.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [ballots[i], ballots[j]] = [ballots[j], ballots[i]];
  }
  const shownBallots = ballots.slice(0, 60);
  const artistChip = chip(artist, s.artist?.name ?? "?");
  const list = h("div", { class: `ropts${many ? " many" : ""}` });
  const ballot = h("div", { class: "ballot" }, h("span", { class: "lbl" }, t.votes), h("div", { class: `bdots${ballots.length > 16 ? " many" : ""}` }, ...shownBallots.map((b) => b.el)));
  stage.replaceChildren(
    paper(s, true),
    h(
      "div",
      { class: "col grow right" },
      h("div", { class: "rhead" }, h("h2", {}, t.answers), artistChip),
      list,
      ballot,
    ),
  );
  /** @type {HTMLElement[]} */
  const cards = [];
  const pts = (/** @type {number} */ n) => `+${t.n(n)}`;

  /**
   * One answer on the list (`animate`: the votes fly, the stamp slams).
   * @param {number} k
   * @param {boolean} animate
   */
  const show = (k, animate) => {
    const it = items[k];
    const count = typeof it.count === "number" ? it.count : (it.voters ?? []).length;
    const mine = ballots.filter((b) => b.item === k);
    const cap = many ? 6 : 10;
    const flying = mine.slice(0, cap);
    const holes = flying.map((b) => {
      const hole = h("i", {});
      if (b.el.classList.contains("anon")) hole.className = "anon";
      else hole.setAttribute("style", b.el.getAttribute("style") ?? "");
      return hole;
    });
    const more = h("span", { class: "more" });
    const who = h("span", { class: "who" });
    const gain = h("span", { class: "gain" });
    const stamp = h("i", { class: `stp${it.truth ? " truth" : it.decoy ? " ours" : ""}` }, it.truth ? t.stampTruth : it.decoy ? t.stampOurs : t.stampLie);
    const card = h(
      "div",
      { class: `ropt${animate && !calm() ? " flip" : ""}` },
      h("i", { class: "shine" }, h("i", {})),
      h("div", { class: "body" }, h("div", { class: "tx" }, it.text), h("div", { class: "meta" }, h("span", { class: "dots" }, ...holes), more, who, gain)),
      stamp,
    );
    if (it.truth) for (const c of cards) c.classList.add("dim");
    cards.push(card);
    list.append(card);
    // Who: names while they fit (two in a full list), else how many of those who could.
    const names = /** @type {string[]} */ (it.voters ?? []);
    const all = count <= names.length && (!many || names.length <= 2);
    const counter = h("span", { class: "pts" }, pts(0));
    if (it.truth) {
      if (count) {
        who.append(all ? t.foundBy(names) : many ? t.foundN(count, it.seen) : t.foundByN(count, it.seen));
        gain.append(counter, ` ${t.each}`);
      } else who.append(t.nobodyFound);
    } else {
      who.append(all ? t.fellForIt(names) : many ? t.fooledN(count) : t.fooledOf(count, it.seen));
      if (!it.decoy) {
        const authors = /** @type {string[]} */ (it.authors ?? []);
        const ids = /** @type {string[]} */ (Array.isArray(it.authorIds) ? it.authorIds : []);
        gain.append(...authors.map((a, i) => chip(ids[i] ?? a, a)), counter);
        if (it.same) gain.append(t.sameIdea.trim());
      }
    }
    const land = () => {
      stamp.classList.add("on");
      who.classList.add("on");
      gain.classList.add("on");
      if (ballots.every((b) => b.el.classList.contains("gone"))) ballot.classList.add("spent");
      if (count > flying.length) more.textContent = `+${t.n(count - flying.length)}`;
      if (it.truth) {
        card.classList.add("truth");
        if (animate) {
          burst(card, [colorOf(artist), "#ffd60a", "#2ec4b6", "#ff5d8f", "#fffdf6"], 22, 14);
          if (it.artistPoints > 0 && !calm()) {
            const f = h("span", { class: "float" }, pts(it.artistPoints));
            artistChip.append(f);
            setTimeout(() => f.remove(), 1700);
          }
        }
      }
      if (count && !it.decoy) countUp(counter, 0, it.points ?? 0, animate ? 650 : 0, pts);
    };
    if (!animate || calm()) {
      for (const b of mine) b.el.classList.add("gone");
      for (const hole of holes) hole.classList.add("on");
      land();
      return;
    }
    // Fits in a step (fast timings: 1.5 s).
    const T = Math.max(900, Math.min(1600, stepMs * 0.6));
    const stagger = Math.min(60, (T * 0.25) / Math.max(1, flying.length));
    const flight = T * 0.34;
    later(T * 0.22, () => {
      const box = stage.getBoundingClientRect();
      flying.forEach((b, j) => {
        later(j * stagger, () => {
          const a = b.el.getBoundingClientRect();
          const z = holes[j].getBoundingClientRect();
          const dot = h("i", { class: b.el.classList.contains("anon") ? "anon" : "", style: `${b.el.getAttribute("style") ?? ""};width:${a.width}px;height:${a.height}px` });
          const fly = h("i", { class: "fly", style: `left:${a.left - box.left}px;top:${a.top - box.top}px;transition-duration:${flight}ms` }, dot);
          dot.style.transitionDuration = `${flight}ms`;
          stage.append(fly);
          b.el.classList.add("gone");
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              fly.style.transform = `translateX(${z.left - a.left}px)`;
              dot.style.transform = `translateY(${z.top - a.top}px) scale(${a.width ? z.width / a.width : 1})`;
            }),
          );
          later(flight + 30, () => {
            fly.remove();
            holes[j].classList.add("on");
          });
        });
      });
      for (const b of mine.slice(cap)) b.el.classList.add("gone");
    });
    later(T * 0.22 + flying.length * stagger + flight + 80, () => {
      replay(card, "thud");
      land();
      beep(it.truth ? [784, 988, 1175] : it.decoy ? [330, 262] : [392, 330]);
    });
  };

  refresh = () => {
    const step = Math.min(items.length, client.view.screen?.step ?? 0);
    while (cards.length < step) {
      const k = cards.length;
      // A view that skipped steps (a reconnect): all but the newest at once.
      show(k, k === step - 1 && step > lastStep);
    }
    lastStep = Math.max(lastStep, step);
  };
  ticker = null;
}

// ---------------------------------------------------------------------------
// Scores: the old order, then the race to the new one

/** @param {Record<string, any>} view */
function scores(view) {
  const s = view.screen;
  // All players up to 8, else the top 5 (each phone shows its own rank).
  const total = s.total ?? (s.scores ?? []).length;
  const top = /** @type {any[]} */ (total > 8 ? (s.scores ?? []).slice(0, 5) : (s.scores ?? []));
  const before = [...top].sort((a, b) => b.score - (b.delta ?? 0) - (a.score - (a.delta ?? 0)) || top.indexOf(a) - top.indexOf(b));
  const max = Math.max(1, ...top.map((l) => l.score)) * 1.04;
  const LH = 8.3;
  const lines = h("div", { class: "lines", style: `height:${top.length * LH - 1.1}vh` });
  const highlights = (s.highlights ?? []).map((/** @type {any} */ x, /** @type {number} */ i) =>
    h(
      "div",
      { class: `highlight${calm() ? "" : " in"}`, style: `animation-delay:${3400 + i * 350}ms` },
      h("span", { class: "tag" }, x.kind === "liar" ? t.bestLiar : t.sharpestEye),
      chip(x.id ?? "", x.name),
      h("span", {}, x.kind === "liar" ? t.fooledN(x.count) : t.foundN(x.count, x.of)),
    ),
  );
  const title = s.last ? t.finalScores : t.scoresAfter(s.round);
  stage.replaceChildren(
    h(
      "div",
      { class: "col grow center sc" },
      h("div", { class: "big-title" }, title),
      h("div", { class: "board-row" }, lines, highlights.length ? h("div", { class: "highlights" }, ...highlights) : null),
      total > top.length ? h("p", { class: "hint" }, t.rankOnPhone(total)) : null,
    ),
  );
  const rows = before.map((l, i) => {
    const old = l.score - (l.delta ?? 0);
    const fill = h("i", { class: "fill", style: `width:${((100 * old) / max).toFixed(1)}%` });
    const rank = h("span", { class: "rank" }, t.rank(i + 1));
    const points = h("span", { class: "pts" }, t.n(old));
    const delta = l.delta ? h("span", { class: "delta" }, `+${t.n(l.delta)}`) : null;
    const move = h("span", { class: "mv" });
    const el = h(
      "div",
      { class: `line${calm() ? "" : " in"}`, style: `top:${i * LH}vh;animation-delay:${i * 70}ms` },
      fill,
      rank,
      avatar(l.id ?? "", l.name),
      h("span", { class: "n" }, l.name),
      move,
      delta,
      points,
    );
    tint(el, l.id ?? "");
    lines.append(el);
    return { l, el, fill, rank, points, delta, move, was: i, old };
  });
  const settle = () => {
    for (const r of rows) {
      const k = top.indexOf(r.l);
      r.el.style.top = `${k * LH}vh`;
      r.el.style.zIndex = String(10 - k);
      later(calm() ? 0 : 420, () => {
        r.rank.textContent = t.rank(k + 1);
        const m = r.was - k;
        if (m) {
          r.move.textContent = m > 0 ? `▲${m}` : `▼${-m}`;
          r.move.className = `mv on ${m > 0 ? "up" : "dn"}`;
        }
        if (k === 0) r.el.classList.add("first");
      });
    }
  };
  if (calm()) {
    for (const r of rows) {
      r.delta?.classList.add("on");
      r.fill.style.width = `${((100 * r.l.score) / max).toFixed(1)}%`;
      r.points.textContent = t.n(r.l.score);
    }
    settle();
    return;
  }
  later(900, () => rows.forEach((r, i) => later(i * 70, () => r.delta?.classList.add("on"))));
  later(1400, () => {
    for (const r of rows) {
      r.fill.style.width = `${((100 * r.l.score) / max).toFixed(1)}%`;
      countUp(r.points, r.old, r.l.score, 1200, t.n);
    }
    beep([523, 587, 659, 784], 0.09, 0.15);
  });
  later(2800, settle);
}

// ---------------------------------------------------------------------------
// The end: the podium

/** @param {Record<string, any>} view */
function final(view) {
  const s = view.screen;
  const table = /** @type {any[]} */ (s.scores ?? []);
  const winner = table[0];
  const title = h("div", { class: "big-title" });
  const words = t.wins(winner?.name).split(" ");
  const letters = () =>
    words.flatMap((w, wi) => [
      h("span", { class: "word" }, ...Array.from(w, (c, i) => h("span", { style: `--i:${wi * 6 + i}` }, c))),
      wi < words.length - 1 ? " " : "",
    ]);
  const podium = h("div", { class: "podium" });
  /** @type {{ who: HTMLElement, block: HTMLElement, height: number, line: any }[]} */
  const cols = [];
  // 2nd, 1st, 3rd.
  for (const [place, height] of /** @type {[number, number][]} */ ([
    [2, 30],
    [1, 40],
    [3, 22],
  ])) {
    const line = table[place - 1];
    if (!line) continue;
    const who = h(
      "div",
      { class: "pwho" },
      place === 1 ? h("div", { class: "crown" }, "♛") : null,
      avatar(line.id ?? "", line.name),
      h("span", { class: "n" }, line.name),
      h("span", { class: "s2" }, t.n(calm() ? line.score : 0)),
    );
    const block = h("div", { class: "pblock" }, String(place));
    const col = h("div", { class: "pcol" }, who, block);
    tint(col, line.id ?? "");
    podium.append(col);
    cols[place] = { who, block, height, line };
  }
  const rest = h(
    "div",
    { class: "rest" },
    ...table.slice(3, 8).map((l, i) => {
      const c = h("span", { class: `pchip${calm() ? "" : " in"}`, style: `animation-delay:${4700 + i * 90}ms` }, t.rank(i + 4), " ", avatar(l.id ?? "", l.name), ` ${l.name} ${t.n(l.score)}`);
      return c;
    }),
  );
  const hint = h("p", { class: "hint" }, t.anotherGame);
  const conf = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "conf" }));
  stage.replaceChildren(h("div", { class: "col grow fin" }, title, podium, h("div", { class: "fin-foot" }, rest, hint)), conf);
  if (calm()) {
    title.replaceChildren(...letters());
    for (const c of cols) {
      if (!c) continue;
      c.block.style.height = `${c.height}vh`;
      c.who.classList.add("on");
    }
    cols[1]?.who.querySelector(".crown")?.classList.add("on");
    hint.classList.add("on");
    return;
  }
  /** @param {number} place @param {number} at @param {number} ms */
  const rise = (place, at, ms) => {
    const c = cols[place];
    if (!c) return;
    later(at, () => {
      c.block.style.transitionDuration = `${ms}ms`;
      c.block.style.height = `${c.height}vh`;
    });
    later(at + ms * 0.7, () => {
      c.who.classList.add("on");
      countUp(/** @type {HTMLElement} */ (c.who.querySelector(".s2")), 0, c.line.score, 700, t.n);
      beep([place === 1 ? 784 : 523], 0.1, 0.15);
    });
  };
  rise(3, 400, 650);
  rise(2, 1400, 650);
  rise(1, 2600, 1000);
  later(3700, () => {
    cols[1]?.who.querySelector(".crown")?.classList.add("on");
    title.replaceChildren(...letters());
    confetti(conf, [...[1, 2, 3].flatMap((p) => (cols[p] ? [colorOf(cols[p].line.id ?? "")] : [])), "#ffd60a", "#fffdf6"]);
    beep([523, 659, 784, 1047], 0.14);
  });
  later(6000, () => hint.classList.add("on"));
}

/**
 * One burst of confetti (big flat pieces, 3 s, then gone: the stream's
 * encoder has the hardest time with many small moving things).
 * @param {HTMLCanvasElement} cv
 * @param {string[]} colors
 */
function confetti(cv, colors) {
  const r = cv.getBoundingClientRect();
  cv.width = Math.round(r.width);
  cv.height = Math.round(r.height);
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const W = cv.width;
  const H = cv.height;
  const u = H / 720;
  const ps = Array.from({ length: 140 }, (_, i) => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.25,
    y: H * 0.45,
    vx: (Math.random() - 0.5) * 900 * u,
    vy: (-350 - Math.random() * 650) * u,
    r: Math.random() * 6,
    vr: (Math.random() - 0.5) * 10,
    w: (9 + Math.random() * 8) * u,
    h: (14 + Math.random() * 10) * u,
    c: colors[i % colors.length],
    d: Math.random() * 300,
  }));
  let t0 = -1;
  let last = -1;
  loop((now) => {
    if (t0 < 0) t0 = last = now;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const age = now - t0;
    ctx.clearRect(0, 0, W, H);
    const fade = age > 3000 ? Math.max(0, 1 - (age - 3000) / 600) : 1;
    if (fade <= 0) return false;
    ctx.globalAlpha = fade;
    for (const p of ps) {
      if (age < p.d) continue;
      p.vy = Math.min(p.vy + 900 * u * dt, 260 * u);
      p.vx *= 1 - 1.6 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.r += p.vr * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.scale(1, Math.cos(p.r * 1.7));
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    return true;
  });
}

client.connect().catch((e) => {
  stage.replaceChildren(h("div", { class: "col grow center" }, h("h1", {}, t.cannotShow(e?.message ?? String(e)))));
});
