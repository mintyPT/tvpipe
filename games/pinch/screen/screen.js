// @ts-check
/**
 * Pinch's TV page (docs/pinch-design.md §7–§9, §12): tvpipe casts it,
 * or anyone opens the watch link (the host page's preview, muted). It
 * draws the screen view (`{ roster, screen, join }`, views.ts
 * `ScreenView`) and the transient messages (`pub`: the public layer's
 * deltas at 10 Hz; `tape`: the recording at the outcome) in the room's
 * language:
 *
 * - the lobby: the logo, the tagline, how to play, the join code, the
 *   guests arriving, the settings;
 * - silent-film intertitles between the phases;
 * - the briefing and the heist: the top bar, the catalogue, the
 *   blueprint with the public layer (phone/draw.js), the ticker (facts
 *   in teletype, claims in the guard's colour);
 * - the outcome card over the map; the tape (a VHS replay of the whole
 *   heist in colour, slowing down for the moments, with captions); the
 *   scores; the end (podium, every round, awards).
 *
 * The join badge sits bottom left the whole game (the catalogue and the
 * tape keep out of it); the lobby shows the code itself. Players' names
 * are always text. `?demo=PHASE` renders canned data (screen/demo.js),
 * for screenshots without a running game (test/live/tv-shots.ts).
 */

import { joinText, PartyClient, qrSvg } from "/_tvpipe/lib/client.js";
import {
  createArt, drawBlueprint, drawFigure, drawLootIcon, drawPublic, drawTrail, drawWorld, fitCanvas, fitView, useTiles,
} from "../phone/draw.js";
import { itemById } from "../game/items.js";
import { decodeBlueprint } from "../game/map.js";
import { applyPublic, CLAIM_KINDS, decodeTrack, publicState, TRACK, wordsArea } from "../game/protocol.js";
import { hashSeed, Rng } from "../game/rng.js";
import { lightMask } from "../game/sight.js";
import { award, caption, claim, estate, fact, intertitle, itemName, money, noun, outcome, words } from "../game/words.js";
import { sfx } from "./sound.js";
import { pickLang, strings } from "./strings.js";

/** @typedef {import("../game/map.ts").Blueprint} Blueprint */
/** @typedef {import("../game/protocol.ts").PublicState} PublicState */
/** @typedef {import("../game/protocol.ts").PublicDelta} PublicDelta */
/** @typedef {import("../game/protocol.ts").PublicLayer} PublicLayer */
/** @typedef {import("../game/protocol.ts").TickerEvent} TickerEvent */
/** @typedef {import("../game/protocol.ts").Tape} Tape */
/** @typedef {import("../game/protocol.ts").HeistResult} HeistResult */
/** @typedef {import("../game/protocol.ts").Sample} Sample */
/** @typedef {import("../game/protocol.ts").Where} Where */
/** @typedef {import("../game/views.ts").ScreenView} ScreenView */
/** @typedef {import("../game/views.ts").CatalogueEntry} CatalogueEntry */
/** @typedef {import("../game/views.ts").RoundView} RoundView */
/** @typedef {import("../game/words.ts").Lang} Lang */
/** @typedef {import("../game/words.ts").Area} Area */
/** @typedef {import("../phone/draw.js").View} View */
/** @typedef {NonNullable<ReturnType<typeof createArt>>} Art */

/**
 * What the page needs of a client: tvpipe's `PartyClient`, or the demo's.
 * @typedef {{ view: any, on: (event: string, fn: (...args: any[]) => void) => unknown, now: () => number, joinVisible: boolean }} ClientLike
 */

const search = new URLSearchParams(location.search);
const DEMO = search.has("demo");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

/** @type {ClientLike} */
const client = DEMO
  ? (await import("./demo.js")).demoClient(search)
  : PartyClient.fromLocation({ rejoinBadge: { corner: "bottom-left" } });

const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const statusBar = /** @type {HTMLElement} */ (document.getElementById("status"));

let lang = pickLang(undefined);
let t = strings(lang);

// The stage is 1280×720 (the manifest's TV size), scaled to the window (the host page's preview).
const STAGE_W = 1280;
const STAGE_H = 720;
let K = 1;
function fitStage() {
  K = Math.max(0.1, Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H)) || 1;
  document.documentElement.style.setProperty("--k", String(K));
}
fitStage();
addEventListener("resize", fitStage);

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
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const fin = (/** @type {unknown} */ v) => typeof v === "number" && Number.isFinite(v);
const num = (/** @type {unknown} */ v, d = 0) => (fin(v) ? /** @type {number} */ (v) : d);
const isColour = (/** @type {unknown} */ c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
const list = (/** @type {unknown} */ a) => (Array.isArray(a) ? a : []);

/** The screen view's screen part (never null). @returns {Partial<ScreenView> & Record<string, any>} */
const screenOf = (/** @type {any} */ v) => (v && typeof v.screen === "object" && v.screen) || {};

/** Text set only when it changed: the frame loops write every frame, the DOM need not relayout. @param {HTMLElement} el @param {string} text */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
/** @param {Element} el @param {string} cls @param {boolean} on */
function setClass(el, cls, on) {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}
/** @param {HTMLElement} el @param {boolean} hidden */
function setHidden(el, hidden) {
  if (el.hidden !== hidden) el.hidden = hidden;
}

/** A seeded rng for the words: the same line for the same thing, whoever draws it. @param {...(string | number)} parts */
function rngOf(...parts) {
  const r = new Rng(hashSeed(...parts));
  return () => r.float();
}

/** "2:41". @param {number} s */
function mmss(s) {
  const n = Math.max(0, Math.ceil(num(s)));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

/** A player's name by id. @param {unknown} id */
function nameOf(id) {
  const r = list(client.view?.roster).find((x) => x?.id === id);
  return typeof r?.name === "string" ? r.name : "?";
}
/** A player's colour by id. @param {unknown} id */
function colourOf(id) {
  const c = typeof id === "string" ? screenOf(client.view).colors?.[id] : undefined;
  return isColour(c) ? /** @type {string} */ (c) : "#c9b88f";
}
/** Names by id, for draw.js. @returns {Record<string, string>} */
function namesById() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const r of list(client.view?.roster)) if (r && typeof r.id === "string" && typeof r.name === "string") out[r.id] = r.name;
  return out;
}
/** @param {number} dollars */
const cash = (dollars) => money(lang, num(dollars));

/** An item of the night by catalogue index. @param {unknown} index */
function nightItem(index) {
  const cat = list(screenOf(client.view).catalogue);
  const e = fin(index) ? cat[/** @type {number} */ (index)] : undefined;
  return e && typeof e.id === "string" ? itemById(e.id) : undefined;
}

/**
 * Shrinks the font of elements marked `data-fit` until their text fits
 * their box (words are never cut).
 * @param {ParentNode} root
 */
function fitAll(root) {
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll("[data-fit]"))) fit(el);
}
/** @param {HTMLElement} el */
function fit(el) {
  el.style.fontSize = "";
  let fs = parseFloat(getComputedStyle(el).fontSize) || 16;
  const min = Number(el.dataset["fit"]) || 11;
  // Display faces overhang their line boxes a little: height counts only beyond that.
  const over = () => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2 + fs * 0.35;
  for (let k = 0; k < 40 && fs > min && over(); k++) {
    fs = Math.max(min, fs * 0.94);
    el.style.fontSize = `${fs.toFixed(1)}px`;
  }
}

let iconIds = 0;
/** A guard's bowler hat in their colour (side on), for names in lists. @param {string} colour @param {number} [size] */
function hatIcon(colour, size = 40) {
  const c = isColour(colour) ? colour : "#c9b88f";
  const el = h("span", { class: "icon hat", style: { width: `${size}px`, height: `${size}px` } });
  el.innerHTML = `<svg viewBox="0 0 48 44" width="100%" height="100%"><ellipse cx="24" cy="33" rx="21" ry="6.5" fill="${c}" stroke="#0d0c0e" stroke-width="3"/><path d="M10.5 32 C10 13 16 6 24 6 C32 6 38 13 37.5 32 Z" fill="${c}" stroke="#0d0c0e" stroke-width="3"/><path d="M10.8 25.5 H37.2 V31.5 H10.8 Z" fill="#0d0c0e"/><path d="M15.5 16 C17 11.5 20 9.6 23.5 9.4" stroke="#fff" stroke-opacity=".55" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;
  return el;
}
/** The thief: flat cap, domino mask, striped jersey, in a cream disc. @param {number} [size] */
function thiefIcon(size = 40) {
  const id = `ti${++iconIds}`;
  const el = h("span", { class: "icon thief", style: { width: `${size}px`, height: `${size}px` } });
  el.innerHTML = `<svg viewBox="0 0 48 48" width="100%" height="100%"><defs><clipPath id="${id}"><circle cx="24" cy="24" r="21.5"/></clipPath></defs><circle cx="24" cy="24" r="22" fill="#f1e4c4"/><g clip-path="url(#${id})"><path d="M4 50 C6 35 15 31 24 31 C33 31 42 35 44 50 Z" fill="#f1e4c4" stroke="#0d0c0e" stroke-width="2.5"/><path d="M4 37 H44 M4 43.5 H44" stroke="#0d0c0e" stroke-width="3.6"/><path d="M4 50 C6 35 15 31 24 31 C33 31 42 35 44 50" fill="none" stroke="#0d0c0e" stroke-width="2.5"/></g><circle cx="24" cy="22" r="9.5" fill="#e9b98c" stroke="#0d0c0e" stroke-width="2.5"/><rect x="13.5" y="18.5" width="21" height="6.5" rx="3.2" fill="#0d0c0e"/><circle cx="20" cy="21.7" r="1.7" fill="#f1e4c4"/><circle cx="28" cy="21.7" r="1.7" fill="#f1e4c4"/><path d="M12.5 18.5 C12 9.5 18 7 24.5 7 C31 7 35.5 9.5 35.5 15 L40.5 16.2 C40.5 18.6 38 19.6 35 18.8 Z" fill="#0d0c0e"/><circle cx="24" cy="24" r="22" fill="none" stroke="#d6a842" stroke-width="2.5"/></svg>`;
  return el;
}

/** A catalogue icon. @param {string} id @param {number} size @param {{ tagged?: boolean, grey?: boolean }} [o] */
function lootIcon(id, size, o = {}) {
  const cv = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "loot" }));
  const dpr = Math.min(2, (devicePixelRatio || 1) * K);
  const c = fitCanvas(cv, size, size, dpr);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  try {
    drawLootIcon(c, id, size / 2, size / 2, size * 0.86, o);
  } catch {
    // odd data
  }
  return cv;
}

// ---------------------------------------------------------------------------
// The map of the round: decoded once, with its art (caches) and its words.

/** @type {{ key: string, map: Blueprint, art: Art | null, lang: string } | null} */
let M = null;

/** The round's map, decoded when the blueprint comes; null before. @param {any} sc */
function mapOf(sc) {
  const bp = sc?.blueprint;
  if (!bp || typeof bp !== "object") return M;
  const key = `${sc.round}:${bp.w}x${bp.h}:${String(bp.cells ?? "").slice(0, 80)}:${String(bp.cells ?? "").length}`;
  if (!M || M.key !== key) {
    const map = decodeBlueprint(bp);
    if (!map) return M;
    M = { key, map, art: createArt(map, labels(map)), lang };
  } else if (M.lang !== lang && M.art) {
    const l = labels(M.map);
    M.art.setNames(l.names, l.areaNames);
    M.lang = lang;
  }
  return M;
}

/** Room and area labels in the page's language, numbered as the ticker says them. @param {Blueprint} map */
function labels(map) {
  const label = (/** @type {Where} */ w) => {
    try {
      const a = wordsArea(map, w);
      return a ? noun(lang, a).label : "";
    } catch {
      return "";
    }
  };
  return { names: map.rooms.map((r) => label({ room: r.id })), areaNames: map.areas.map((a) => label({ area: a.id })) };
}

/** A Where in words (an Area), or null. @param {unknown} w @returns {Area | null} */
function areaOf(w) {
  if (!M || !w || typeof w !== "object") return null;
  try {
    return wordsArea(M.map, /** @type {Where} */ (w));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The public layer: snapshots from the view, deltas from `pub` messages.

/** @type {PublicState | null} */
let pub = null;
/** When the current `pub` arrived (performance.now). */
let pubAt = 0;
/** The round the public layer belongs to. */
let pubRound = -1;
/** Ticker lines by event seq: rendered once (the rng picks the variant). @type {Map<number, { text: string, claim: boolean, colour: string, clock: string } | null>} */
const lines = new Map();
/** The highest event seq that made (or would have made) a sound. */
let heard = -1;

/** @param {PublicState} next */
function setPub(next) {
  const first = !pub;
  pub = next;
  pubAt = performance.now();
  for (const ev of list(next.events)) {
    if (!ev || !fin(ev.seq) || lines.has(ev.seq)) continue;
    // The clock as it read then: the clock now plus the time since (the alarm's jump aside).
    lines.set(ev.seq, tickerLine(ev, num(next.left) + Math.max(0, num(next.t) - num(ev.t))));
    if (lines.size > 200) lines.delete(/** @type {number} */ (lines.keys().next().value));
  }
  const last = list(next.events).reduce((m, ev) => Math.max(m, num(ev?.seq, -1)), -1);
  if (first) heard = Math.max(heard, last);
  for (const ev of list(next.events)) {
    if (!ev || num(ev.seq, -1) <= heard) continue;
    if (num(next.t) - num(ev.t) < 3) eventSound(ev);
  }
  heard = Math.max(heard, last);
  scene?.pub?.();
}

/** A snapshot from the screen view (late or reloaded TVs, and a fallback after a gap). @param {any} sc */
function snapshot(sc) {
  const map = mapOf(sc)?.map;
  if (!map) return;
  if (num(sc.round, -1) !== pubRound) {
    pubRound = num(sc.round, -1);
    pub = null;
    lines.clear();
    heard = -1;
  }
  const layer = sc.pub;
  if (!layer || typeof layer !== "object") return;
  if (pub && num(layer.seq, -1) <= pub.seq) return;
  try {
    const st = publicState(/** @type {PublicLayer} */ (layer), map);
    if (st) setPub(st);
  } catch {
    // malformed: wait for the next
  }
}

/** A delta (`pub` message). @param {unknown} d */
function delta(d) {
  const map = M?.map;
  if (!map || !d || typeof d !== "object") return;
  try {
    const next = applyPublic(pub, /** @type {PublicDelta} */ (d), map);
    if (next) setPub(next);
    // else: a gap; the next keyframe or snapshot brings us back.
  } catch {
    // malformed: ignore
  }
}

/** The heist clock now (seconds since the start), running on between the 10 Hz deltas. */
function heistNow() {
  if (!pub) return 0;
  if (pub.end) return pub.t;
  return pub.t + Math.min(0.4, (performance.now() - pubAt) / 1000);
}
/** Seconds left on the heist clock now. */
function heistLeft() {
  if (!pub) return 0;
  if (pub.end) return Math.max(0, pub.left);
  return Math.max(0, pub.left - Math.min(0.4, (performance.now() - pubAt) / 1000));
}

/**
 * A ticker event as a line: facts via words.ts `fact`, claims via
 * `claim`, the thief leaving as the outcome's line. Null for what cannot
 * be said (an unknown place).
 * @param {TickerEvent} ev @param {number} clockAt
 */
function tickerLine(ev, clockAt) {
  try {
    const rng = rngOf("tick", pubRound, ev.seq, ev.k);
    const e = /** @type {Record<string, any>} */ (ev);
    /** @type {Record<string, any>} */
    const p = {};
    if ("where" in e) {
      const a = areaOf(e["where"]);
      if (!a) return null;
      p["where"] = a;
    }
    if ("guard" in e) p["guard"] = nameOf(e["guard"]);
    if ("thief" in e) p["thief"] = nameOf(e["thief"]);
    if ("camera" in e) p["camera"] = num(e["camera"]) + 1;
    if ("seconds" in e) p["seconds"] = Math.round(num(e["seconds"]));
    if ("dir" in e) p["dir"] = e["dir"];
    if ("item" in e) {
      const it = nightItem(e["item"]);
      if (!it) return null;
      p["item"] = it;
    }
    const clock = mmss(clockAt);
    if (CLAIM_KINDS.includes(ev.k)) {
      const text = claim(lang, /** @type {any} */ (ev.k), /** @type {any} */ (p), rng);
      return { text, claim: true, colour: colourOf(e["guard"]), clock };
    }
    if (ev.k === "left") return { text: outcome(lang, "left", { thief: nameOf(e["thief"]) }, rng).sub, claim: false, colour: "", clock };
    return { text: fact(lang, /** @type {any} */ (ev.k), /** @type {any} */ (p), rng), claim: false, colour: "", clock };
  } catch {
    return null;
  }
}

/** Sounds for new public facts. The arrest and the car are the outcome card's. @param {TickerEvent} ev */
function eventSound(ev) {
  switch (ev.k) {
    case "sighting":
      return sfx.shutter();
    case "glass":
    case "lamp":
      return sfx.glass();
    case "firecracker":
      return sfx.firecracker();
    case "alarm":
      return sfx.bell();
    case "held":
      return sfx.whistle();
    default:
  }
}

// ---------------------------------------------------------------------------
// Scenes and intertitles

/** @typedef {{ el: HTMLElement, update?: (view: any) => void, frame?: (now: number) => void, pub?: () => void, tape?: () => void, dispose?: () => void }} Scene */

/** @type {Scene | null} */
let scene = null;
let sceneKey = "";
let phaseKey = "";
let firstView = true;
/** The tape of the round, as it came at the outcome. @type {{ tape: Tape, result: HeistResult, round: number } | null} */
let tapeMsg = null;

client.on("view", (/** @type {any} */ view) => render(view));
client.on("msg", (/** @type {string} */ type, /** @type {any} */ data) => {
  if (type === "pub") delta(data);
  else if (type === "tape" && data && typeof data === "object" && data.tape) {
    tapeMsg = { tape: data.tape, result: data.result ?? data.tape.result, round: num(screenOf(client.view).round) };
    scene?.tape?.();
  }
});
client.on("status", (/** @type {string} */ st) => {
  statusBar.hidden = st === "open";
  statusBar.textContent = st === "closed" ? t.over : t.reconnecting;
});
// The party's client connects only when asked (the demo's needs nothing).
if (!DEMO) {
  /** @type {any} */ (client).connect().catch((/** @type {any} */ e) => {
    statusBar.hidden = false;
    statusBar.textContent = e?.message ?? String(e);
  });
}

/** @param {any} sc */
function keyOf(sc) {
  const r = num(sc.round);
  switch (sc.phase) {
    case "briefing":
    case "heist":
    case "outcome":
      return `board:${r}`;
    case "tape":
    case "scores":
      return `${sc.phase}:${r}`;
    default:
      return String(sc.phase ?? "lobby");
  }
}

/** @param {any} view */
function render(view) {
  const sc = screenOf(view);
  const l = pickLang(sc.lang);
  const relang = l !== lang;
  if (relang) {
    lang = l;
    t = strings(l);
    document.documentElement.lang = l;
    lines.clear();
  }
  mapOf(sc);
  snapshot(sc);
  const pk = `${num(sc.round)}:${sc.phase ?? "lobby"}`;
  if (pk !== phaseKey) {
    phaseKey = pk;
    cards(sc, firstView && !(DEMO && search.get("card") === "1"));
    phaseSound(sc, firstView);
  }
  firstView = false;
  const k = keyOf(sc);
  if (k !== sceneKey || relang) {
    sceneKey = k;
    const old = scene;
    old?.dispose?.();
    if (old) {
      old.el.classList.add("leaving");
      setTimeout(() => old.el.remove(), 500);
    }
    scene = build(sc);
    stage.append(scene.el);
  }
  scene?.update?.(view);
  client.joinVisible = !sc.phase || sc.phase === "lobby";
  document.documentElement.dataset["phase"] = String(sc.phase ?? "lobby");
}

/** @param {any} sc @returns {Scene} */
function build(sc) {
  switch (sc.phase) {
    case "briefing":
    case "heist":
    case "outcome":
      return boardScene();
    case "tape":
      return tapeScene();
    case "scores":
      return scoresScene();
    case "final":
      return finalScene();
    default:
      return lobbyScene();
  }
}

/** @param {any} sc @param {boolean} first */
function phaseSound(sc, first) {
  if (first) return;
  if (sc.phase === "outcome") {
    const k = sc.outcome?.kind;
    if (k === "pinched") sfx.scratch();
    else if (k === "gotAway") sfx.chirp();
    else if (k === "police") {
      sfx.whistle();
      setTimeout(() => sfx.bell(), 400);
    }
  } else if (sc.phase === "tape") {
    setTimeout(() => sfx.whirr(), CARD_MS.tape - 300);
  }
}

function frame(/** @type {number} */ now) {
  try {
    scene?.frame?.(now);
  } catch (e) {
    console.warn(e);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// Text fitted before the fonts came is fitted again.
const refit = () => {
  if (scene) fitAll(scene.el);
  if (cardEl) fitAll(cardEl);
  scene?.update?.(client.view);
};
void document.fonts?.ready.then(refit);
document.fonts?.addEventListener?.("loadingdone", refit);

// The intertitles: silent-film cards between the phases.

const CARD_MS = { round: 2300, briefing: 2600, heist: 1900, tape: 2200, scores: 1700, final: 2500 };
/** @type {ReturnType<typeof setTimeout>[]} */
let cardTimers = [];
/** @type {HTMLElement | null} */
let cardEl = null;
/** When the cards of this phase are over (performance.now). */
let cardsUntil = 0;

/** The cards for a phase change. @param {any} sc @param {boolean} first */
function cards(sc, first) {
  for (const x of cardTimers) clearTimeout(x);
  cardTimers = [];
  cardEl?.remove();
  cardEl = null;
  cardsUntil = 0;
  const demoCard = DEMO ? search.get("card") : null;
  if (DEMO && demoCard !== "1") return;
  const round = num(sc.round);
  const rng = rngOf("card", round, String(sc.phase));
  const thief = nameOf(sc.thief);
  /** @type {{ text: string, small?: string, ms: number }[]} */
  const list = [];
  try {
    switch (sc.phase) {
      case "briefing":
        if (first) break;
        list.push({ text: intertitle(lang, "round", { thief, round }, rng), small: t.round(round, num(sc.rounds)), ms: CARD_MS.round });
        list.push({ text: intertitle(lang, "briefing", { estate: estate(lang, num(sc.estate)) }, rng), ms: CARD_MS.briefing });
        break;
      case "heist":
        if (!first) list.push({ text: intertitle(lang, "heist", {}, rng), ms: CARD_MS.heist });
        break;
      case "tape":
        if (!first) list.push({ text: intertitle(lang, "tape", {}, rng), small: words(lang).ui.tape, ms: CARD_MS.tape });
        break;
      case "scores":
        if (!first) list.push({ text: intertitle(lang, "scores", {}, rng), ms: CARD_MS.scores });
        break;
      case "final":
        list.push({ text: intertitle(lang, "final", {}, rng), ms: CARD_MS.final });
        break;
      default:
    }
  } catch {
    // no words: no card
  }
  if (DEMO && demoCard === "1") for (const c of list) c.ms = 1e9;
  let at = 0;
  for (const c of list) {
    cardTimers.push(setTimeout(() => showCard(c.text, c.small), at));
    at += c.ms;
  }
  if (list.length) {
    cardTimers.push(setTimeout(() => {
      const el = cardEl;
      cardEl = null;
      el?.classList.add("leaving");
      setTimeout(() => el?.remove(), 400);
    }, at));
    cardsUntil = performance.now() + at;
  }
}

/** @param {string} text @param {string} [small] */
function showCard(text, small) {
  const el = h(
    "div",
    { class: "intertitle tv-card" },
    h("div", { class: "intertitle-card" }, h("div", { class: "intertitle-text", "data-fit": "18" }, text, h("span", { class: "intertitle-rule" }), small ? h("small", {}, small) : null)),
  );
  cardEl?.remove();
  cardEl = el;
  document.body.append(el);
  fitAll(el);
}

// ---------------------------------------------------------------------------
// The lobby

/** The logo: PINCH in Deco gold on a sunburst. */
function logo(cls = "") {
  return h("div", { class: `logo ${cls}` }, h("div", { class: "logo-rays" }), h("div", { class: "logo-word" }, "PINCH"), h("div", { class: "logo-band" }));
}

/** @returns {Scene} */
function lobbyScene() {
  const W = words(lang);
  const qr = h("div", { class: "qr" });
  const short = h("div", { class: "short", "data-fit": "14" });
  const guests = h("div", { class: "guests" });
  const count = h("span", { class: "count" });
  const hint = h("p", { class: "hint", "data-fit": "12" });
  const opts = h("p", { class: "opts", "data-fit": "12" });
  const roman = ["I", "II", "III"];
  const el = h(
    "div",
    { class: "scene lobby sunburst" },
    h(
      "div",
      { class: "left" },
      logo("big"),
      h("p", { class: "tagline", "data-fit": "16" }, W.tagline),
      h("ol", { class: "how" }, ...W.howTo.map((s, i) => h("li", {}, h("b", {}, roman[i] ?? String(i + 1)), h("span", { "data-fit": "13" }, s)))),
      opts,
    ),
    h(
      "div",
      { class: "right" },
      h("div", { class: "joincard deco-frame" }, h("div", { class: "qrbox" }, qr), h("div", { class: "jointext" }, h("b", { class: "deco-caps" }, t.scan), h("span", { class: "or" }, t.orOpen), short)),
      h("div", { class: "guestbox deco-frame" }, h("h2", { class: "deco-caps" }, t.players, count), guests, hint),
    ),
  );
  /** @type {Map<string, HTMLElement>} */
  const shown = new Map();
  let qrKey = "";
  return {
    el,
    update(v) {
      const sc = screenOf(v);
      const qrRows = v.join?.qr;
      const qk = JSON.stringify(qrRows ?? null).slice(0, 200) + (v.join?.url ?? "");
      if (qk !== qrKey) {
        qrKey = qk;
        try {
          qr.innerHTML = qrRows ? qrSvg(qrRows, { quiet: 2 }) : "";
        } catch {
          qr.textContent = "";
        }
      }
      let text = "";
      try {
        text = v.join ? (joinText(v.join) ?? "") : "";
      } catch {
        text = "";
      }
      short.textContent = text;
      short.hidden = !text;
      /** @type {any[]} */
      const roster = list(v.roster);
      count.textContent = roster.length ? ` · ${roster.length}` : "";
      const kids = roster.map((r) => {
        const id = String(r?.id ?? "");
        let c = shown.get(id);
        const colour = colourOf(id);
        if (!c || c.dataset["c"] !== colour) {
          const fresh = h("div", { class: "guest arrive", "data-c": colour }, hatIcon(colour, 54), h("span", { class: "nm", "data-fit": "12" }, String(r?.name ?? "?")));
          if (!c && shown.size > 0 && !reduced.matches) setTimeout(() => fresh.classList.remove("arrive"), 900);
          else fresh.classList.remove("arrive");
          c = fresh;
          shown.set(id, c);
        }
        c.classList.toggle("away", r?.connected === false);
        c.classList.toggle("vip", !!r?.vip);
        return c;
      });
      for (const [id] of shown) if (!roster.some((r) => String(r?.id) === id)) shown.delete(id);
      guests.replaceChildren(...kids);
      if (!roster.length) guests.append(h("p", { class: "nobody" }, t.nobody));
      const min = num(sc.minPlayers, 3);
      const vip = roster.find((r) => r?.vip);
      hint.textContent = roster.length < min ? t.need(min - roster.length) : vip ? t.vipStarts(String(vip.name)) : "";
      const st = /** @type {any} */ (sc.settings ?? {});
      opts.textContent = `${t.heist} ${mmss(num(st.length, 210))} · ${t.rounds(num(st.rounds, 1))}`;
      fitAll(el);
    },
  };
}

// ---------------------------------------------------------------------------
// The board: the briefing, the heist and the outcome over it

/** @returns {Scene} */
function boardScene() {
  const W = words(lang);
  const thiefIco = h("span", { class: "ico" });
  const thiefName = h("b");
  const who = h("div", { class: "who", "data-fit": "13" }, thiefIco, thiefName, " ", h("span", {}, t.isThief));
  const estateEl = h("div", { class: "estate", "data-fit": "13" });
  const chip = h("div", { class: "chip", hidden: true });
  const clockEl = h("div", { class: "clock" });
  const top = h("header", { class: "top" }, h("div", { class: "brand" }, "PINCH"), h("span", { class: "dot" }, "·"), who, h("span", { class: "dot" }, "·"), estateEl, chip, clockEl);
  const catList = h("ol", { class: "items" });
  const cat = h("aside", { class: "cat" }, h("h2", { class: "deco-title" }, W.ui.catalogue), catList);
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas"));
  const mapBox = h("main", { class: "map" }, canvas);
  const ticker = h("footer", { class: "ticker" });
  const el = h("div", { class: "scene board" }, top, cat, mapBox, ticker);
  /** @type {{ el: HTMLElement, paint: () => void } | null} */
  let outcomeEl = null;
  let catKey = "";
  let tickKey = "";
  let phase = "";
  let lastSec = -1;
  let drawn = 0;
  let thiefKey = "";

  const syncCatalogue = () => {
    const sc = screenOf(client.view);
    const cat = /** @type {CatalogueEntry[]} */ (list(sc.catalogue));
    const missing = new Map(list(pub?.missing).map((m) => [num(m?.item, -1), m]));
    const key = `${lang}:${cat.map((e) => e?.id).join()}:${[...missing.keys()].join()}`;
    if (key === catKey) return;
    catKey = key;
    catList.replaceChildren(
      ...cat.map((e, i) => {
        const it = typeof e?.id === "string" ? itemById(e.id) : undefined;
        const gone = missing.get(i);
        const name = it ? itemName(lang, it) : String(e?.id ?? "?");
        const room = gone && M ? areaOf({ room: num(gone.room) }) : null;
        return h(
          "li",
          { class: gone ? "gone" : "" },
          lootIcon(String(e?.id ?? ""), 30, { tagged: !!e?.tagged, grey: !!gone }),
          h(
            "span",
            { class: "nm" },
            h("span", { class: "name" }, name),
            e?.size === "large" ? h("span", { class: "big", title: "2" }, "▮▮") : null,
            e?.tagged ? h("span", { class: "gps" }, W.ui.tag) : null,
            gone ? h("span", { class: "where" }, `✗ ${room ? noun(lang, room).label : W.ui.missing}`) : null,
          ),
          h("span", { class: "val" }, cash(num(e?.value))),
        );
      }),
    );
    fitCatalogue();
  };
  // The list fits its column (the badge's room changes it too): smaller type for a long night.
  let catH = -1;
  const fitCatalogue = () => {
    catH = catList.clientHeight;
    let fs = 19;
    catList.style.fontSize = `${fs}px`;
    for (let k = 0; k < 12 && catList.scrollHeight > catList.clientHeight + 1 && fs > 12; k++) {
      fs -= 1;
      catList.style.fontSize = `${fs}px`;
    }
  };

  const syncTicker = () => {
    const sc = screenOf(client.view);
    if (sc.phase === "briefing" || !pub) {
      const key = `brief:${lang}:${sc.thief}`;
      if (key === tickKey) return;
      tickKey = key;
      ticker.replaceChildren(
        h("div", { class: "line brief", "data-fit": "13" }, h("b", { style: { color: "var(--cream)" } }, nameOf(sc.thief)), ` ${t.isThief}. ${t.security}`),
        h("div", { class: "line brief dim", "data-fit": "12" }, t.briefing),
      );
      fitAll(ticker);
      return;
    }
    const evs = list(pub.events)
      .filter((ev) => ev && lines.get(ev.seq))
      .slice(-3);
    const key = `${lang}:${evs.map((e) => e.seq).join()}`;
    if (key === tickKey) return;
    const newest = evs.at(-1)?.seq;
    const wasNew = !tickKey.endsWith(`,${newest}`) && !tickKey.endsWith(`:${newest}`);
    tickKey = key;
    ticker.replaceChildren(
      ...evs.map((ev) => {
        const ln = /** @type {{ text: string, claim: boolean, colour: string, clock: string }} */ (lines.get(ev.seq));
        const cls = `line ${ln.claim ? "claim" : "fact"}${ev.seq === newest && wasNew && !reduced.matches ? " new" : ""}`;
        return h(
          "div",
          { class: cls, "data-fit": "12", style: ln.claim ? { "--c": ln.colour } : {} },
          h("span", { class: "when" }, ln.clock),
          h("span", { class: "text" }, ln.text),
        );
      }),
    );
    fitAll(ticker);
  };

  const syncOutcome = () => {
    const sc = screenOf(client.view);
    if (sc.phase !== "outcome") {
      outcomeEl?.el.remove();
      outcomeEl = null;
      return;
    }
    if (outcomeEl) return;
    outcomeEl = outcomeCard(sc);
    el.append(outcomeEl.el);
    fitAll(outcomeEl.el);
  };

  return {
    el,
    update(v) {
      const sc = screenOf(v);
      phase = String(sc.phase ?? "");
      el.dataset["phase"] = phase;
      const tk = `${sc.thief}:${colourOf(sc.thief)}`;
      if (tk !== thiefKey) {
        thiefKey = tk;
        thiefIco.replaceChildren(thiefIcon(42));
      }
      thiefName.textContent = nameOf(sc.thief);
      try {
        estateEl.textContent = estate(lang, num(sc.estate)).name;
      } catch {
        estateEl.textContent = "";
      }
      // The catalogue takes what the map leaves of the width (the map keeps its shape).
      if (M) {
        const need = (720 - 62 - 104 - 12) * (M.map.w / Math.max(1, M.map.h)) + 12;
        el.style.gridTemplateColumns = `${Math.round(Math.min(340, Math.max(290, 1280 - need)))}px 1fr`;
      }
      syncCatalogue();
      syncTicker();
      syncOutcome();
      fitAll(top);
    },
    pub() {
      syncCatalogue();
      syncTicker();
    },
    tape() {
      outcomeEl?.paint();
    },
    frame(now) {
      const sc = screenOf(client.view);
      // The clock: the briefing's countdown, the heist's time left.
      let secs = 0;
      if (phase === "briefing") secs = Math.max(0, (num(sc.deadline) - client.now()) / 1000);
      else secs = heistLeft();
      setText(clockEl, mmss(secs));
      const live = phase === "heist" && !!pub && !pub.end;
      const whole = Math.ceil(secs);
      setClass(clockEl, "low", live && secs <= 60);
      if (live && whole !== lastSec && whole <= 10 && whole > 0) sfx.tick(whole % 2 === 0);
      lastSec = whole;
      // The chip: a hold (with its time), else the alarm.
      const hold = list(pub?.holds)[0];
      const tnow = heistNow();
      if (hold && live) {
        setHidden(chip, false);
        if (chip.className !== "chip held") chip.className = "chip held";
        setText(chip, `${W.ui.held} ${mmss(num(hold.until) - tnow)}`);
      } else if (pub?.alarm) {
        setHidden(chip, false);
        if (chip.className !== "chip alarm") chip.className = "chip alarm";
        setText(chip, `${t.map.alarm} · ${t.police}`);
      } else setHidden(chip, true);
      setClass(clockEl, "alarm", !!pub?.alarm);
      if (catList.clientHeight !== catH) fitCatalogue();
      if (now - drawn < 1000 / 30) return;
      drawn = now;
      drawMap(canvas, mapBox, phase, sc);
    },
  };
}

/**
 * The blueprint and the public layer (briefing: the lights as they start).
 * @param {HTMLCanvasElement} canvas @param {HTMLElement} box @param {string} phase @param {any} sc
 */
function drawMap(canvas, box, phase, sc) {
  const m = mapOf(sc);
  if (!m?.art) return;
  const w = box.clientWidth;
  const hh = box.clientHeight;
  if (w < 10 || hh < 10) return;
  const dpr = Math.min(2, (devicePixelRatio || 1) * K);
  const c = fitCanvas(canvas, w, hh, dpr);
  const v = fitView(m.map, w, hh, dpr, { pad: 6 });
  drawBlueprint(c, m.art, v, { budget: 99 });
  const colors = sc.colors ?? {};
  const names = namesById();
  const car = phase === "outcome" && tapeMsg && tapeMsg.result?.outcome === "gotAway" ? num(tapeMsg.result.car, -1) : null;
  if (pub) drawPublic(c, m.art, v, pub, { colors, names, words: t.map, now: heistNow(), car: car !== null && car >= 0 ? car : null });
  else drawPublic(c, m.art, v, { rooms: m.map.rooms.map((r) => (r.lit ? 1 : 0)), lamps: m.map.lamps.map(() => 1) }, { words: t.map });
}

/** The outcome card (§2): full screen, over the map. @param {any} sc */
function outcomeCard(sc) {
  const kind = ["pinched", "gotAway", "police", "left"].includes(sc.outcome?.kind) ? sc.outcome.kind : "police";
  const thief = nameOf(sc.thief);
  const guard = sc.outcome?.by ? nameOf(sc.outcome.by) : nameOf(tapeMsg?.result?.arrester);
  let o = { title: "", sub: "" };
  try {
    o = outcome(lang, kind, /** @type {any} */ ({ thief, guard }), rngOf("outcome", num(sc.round), kind));
  } catch {
    // no words
  }
  const art = h("div", { class: "art" });
  const el = h(
    "div",
    { class: `outcome ${kind}` },
    h("div", { class: "rays" }),
    h("div", { class: "card deco-frame" }, art, h("div", { class: "title", "data-fit": "28" }, o.title), h("div", { class: "sub", "data-fit": "16" }, o.sub)),
  );
  /** Draws the art: an iris shot of the end (the tape's last frame), else the thief. */
  const paint = () => {
    const iris = irisShot(sc, kind, 200);
    if (iris) art.replaceChildren(h("div", { class: "iris" }, iris));
    else if (kind === "left") art.replaceChildren(h("div", { class: "empty-cap" }, "?"));
    else art.replaceChildren(thiefIcon(120));
  };
  paint();
  return { el, paint };
}

/**
 * A silent film's iris on the end of the heist, from the tape's last
 * samples: the cuffed thief and the guards around (pinched, police), the
 * getaway car (got away), the empty spot where the thief was (left).
 * Null without a tape.
 * @param {any} sc @param {string} kind @param {number} size
 */
function irisShot(sc, kind, size) {
  if (!M?.art || !tapeMsg) return null;
  try {
    const R = reel(tapeMsg, M.map);
    if (!R) return null;
    const last = (/** @type {Sample[]} */ tr) => tr[tr.length - 1];
    const k = R.players.findIndex((p) => p.role === "thief");
    const ts = k >= 0 ? last(/** @type {Sample[]} */ (R.tracks[k])) : undefined;
    let focus = ts ? { x: ts.x, y: ts.y } : null;
    const car = num(R.result?.car, num(R.tape.truth?.car, -1));
    const spot = M.map.spots[car];
    if (kind === "gotAway" && spot) focus = { x: spot.rect.x + spot.rect.w / 2, y: spot.rect.y + spot.rect.h / 2 };
    if (!focus && pub?.arrest) focus = { x: pub.arrest.x, y: pub.arrest.y };
    if (!focus) return null;
    const sack = list(R.tape.truth?.items).filter((it) => fin(it?.taken)).length;
    /** @type {any[]} */
    const figures = [];
    /** @type {{ x: number, y: number, facing: number, on: boolean }[]} */
    const flashlights = [];
    R.players.forEach((p, j) => {
      const s = last(/** @type {Sample[]} */ (R.tracks[j]));
      if (!s) return;
      const thief = p.role === "thief";
      if (thief && kind !== "pinched" && kind !== "police") return;
      const lit = !thief && !!(s.flags & TRACK.LIGHT);
      if (lit) flashlights.push({ x: s.x, y: s.y, facing: s.facing, on: true });
      figures.push({ id: p.id, role: p.role, x: s.x, y: s.y, facing: s.facing, light: lit, sack: thief ? sack : undefined, cuffed: thief, colour: thief ? undefined : colourOf(p.id) });
    });
    const map = M.map;
    const rooms = pub?.rooms ?? map.rooms.map((r) => (r.lit ? 1 : 0));
    const lamps = pub?.lamps ?? map.lamps.map(() => 1);
    const doors = Uint8Array.from(map.doors, (d) => (d.locked ? 2 : 1));
    const light = lightMask(map, { doors, rooms, lamps, flashlights });
    const cv = /** @type {HTMLCanvasElement} */ (h("canvas"));
    const dpr = Math.min(2, (devicePixelRatio || 1) * K);
    const c = fitCanvas(cv, size, size, dpr);
    const v = { ...fitView(map, size, size, dpr), scale: size / 9 };
    v.left = focus.x - size / 2 / v.scale;
    v.top = focus.y - size / 2 / v.scale;
    drawWorld(c, M.art, v, { seen: null, light, now: num(R.result?.t), doors, lamps, figures, colors: screenOf(client.view).colors ?? {} }, { budget: 999 });
    if (kind === "gotAway" && spot) drawPublic(c, M.art, v, { t: 0 }, { lights: false, car, words: { gotAway: "" } });
    return cv;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The tape (§8)

/**
 * The tape, ready to play: tracks decoded, the light's events in order,
 * the moments' captions, the playback schedule.
 * @typedef {{
 *   tape: Tape, result: HeistResult, map: Blueprint, hz: number, n: number, players: { id: string, role: "thief" | "guard" }[],
 *   tracks: Sample[][], events: any[], captions: { t: number, weight: number, text: string }[],
 *   play: Float64Array, total: number, base: number,
 * }} Reel
 */

/** @param {{ tape: Tape, result: HeistResult }} msg @param {Blueprint} map @returns {Reel | null} */
function reel(msg, map) {
  try {
    const tape = msg.tape;
    if (!tape || tape.v !== 1) return null;
    const hz = Math.min(50, Math.max(1, num(tape.hz, 10)));
    const players = list(tape.players).filter((p) => p && typeof p.id === "string");
    const tracks = players.map((_, k) => decodeTrack(tape.tracks?.[k], 1 << 15) ?? []);
    const n = Math.max(1, ...tracks.map((tr) => tr.length));
    const result = msg.result ?? tape.result;
    const events = list(tape.events).filter((e) => e && fin(e.t)).sort((a, b) => a.t - b.t);
    const captions = list(tape.moments)
      .filter((m) => m && fin(m.t))
      .map((m, k) => ({ t: m.t, weight: m.weight === 2 ? 2 : 1, text: captionText(m, k, map) }))
      .filter((c) => c.text);
    // The schedule: ×6, ×2 around a small moment, ×1 around a big one.
    const play = new Float64Array(n + 1);
    const speed = (/** @type {number} */ s) => {
      let v = 6;
      for (const c of captions) {
        if (c.weight === 2 && s >= c.t - 1.5 && s <= c.t + 3) v = Math.min(v, 1);
        else if (s >= c.t - 1 && s <= c.t + 2) v = Math.min(v, 2);
      }
      return v;
    };
    for (let i = 0; i < n; i++) play[i + 1] = /** @type {number} */ (play[i]) + 1 / hz / speed(i / hz);
    const total = /** @type {number} */ (play[n]);
    return { tape, result, map, hz, n, players, tracks, events, captions, play, total, base: 1 };
  } catch {
    return null;
  }
}

/** A moment's caption in words (words.ts `caption`), or "". @param {any} m @param {number} k @param {Blueprint} map */
function captionText(m, k, map) {
  try {
    /** @type {Record<string, any>} */
    const p = {};
    for (const [key, val] of Object.entries(m.p ?? {})) {
      if (key === "where") {
        const a = wordsArea(map, /** @type {Where} */ (val));
        if (!a) return "";
        p[key] = a;
      } else if (key === "guard" || key === "thief") p[key] = nameOf(val);
      else if (key === "camera") p[key] = num(val) + 1;
      else if (key === "item") p[key] = nightItem(val);
      else p[key] = val;
    }
    return caption(lang, m.k, /** @type {any} */ (p), rngOf("caption", num(screenOf(client.view).round), k, String(m.k)));
  } catch {
    return "";
  }
}

/** @returns {Scene} */
function tapeScene() {
  const W = words(lang);
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "reel" }));
  const play = h("div", { class: "osd play" });
  const code = h("div", { class: "osd code" });
  const title = h("div", { class: "osd title" }, W.ui.tape);
  const cap = h("div", { class: "caption", hidden: true });
  const vhs = h("div", { class: "vhs" }, h("div", { class: "band" }), h("div", { class: "band b2" }), h("div", { class: "head" }));
  const blue = h("div", { class: "blue", hidden: true }, h("div", {}, t.noSignal));
  const frameBox = h("div", { class: "frame" }, canvas, cap);
  const el = h("div", { class: "scene tape" }, frameBox, vhs, blue, play, title, code);
  /** @type {Reel | null} */
  let R = null;
  let start = 0;
  let scale = 1;
  let capText = "";
  let zoom = 0;
  let li = -1;
  /** @type {Uint8Array | null} */
  let light = null;
  /** The light's state, moved forward with the events. */
  let ei = 0;
  /** @type {{ doors: Uint8Array, rooms: Uint8Array, lamps: Uint8Array }} */
  let st = { doors: new Uint8Array(0), rooms: new Uint8Array(0), lamps: new Uint8Array(0) };
  let joinKey = "";
  let joinAt = -1e9;
  let lastShown = 0;
  /** The rect the picture takes (clear of the join badge). */
  let rect = { x: 0, y: 0, w: 1280, h: 720 };

  const load = () => {
    if (R || !M || !tapeMsg) return;
    R = reel(tapeMsg, M.map);
    if (!R) return;
    const map = M.map;
    st = {
      doors: Uint8Array.from(map.doors, (d) => (d.locked ? 2 : 0)),
      rooms: Uint8Array.from(map.rooms, (r) => (r.lit ? 1 : 0)),
      lamps: new Uint8Array(map.lamps.length).fill(1),
    };
    ei = 0;
    li = -1;
    // Fit the tape into the time the phase has (deadline), the cards and a still at the end aside.
    const sc = screenOf(client.view);
    const cardLeft = Math.max(0, cardsUntil - performance.now());
    const seek = DEMO ? num(Number(search.get("t")), 0) : 0;
    start = performance.now() + cardLeft;
    const have = fin(sc.deadline) ? (num(sc.deadline) - client.now() - cardLeft) / 1000 - 2.5 : R.total;
    scale = have > 4 && R.total > have ? R.total / have : 1;
    if (seek > 0) {
      const i = Math.min(R.n, Math.floor(seek * R.hz));
      start = performance.now() - (/** @type {number} */ (R.play[i]) / scale) * 1000;
    }
  };

  /** Applies the tape's events up to tape time `s` to the light's state. @param {number} s */
  const advance = (s) => {
    if (!R) return false;
    let changed = false;
    while (ei < R.events.length && R.events[ei].t <= s) {
      const e = R.events[ei++];
      const room = e.where && fin(e.where.room) ? e.where.room : -1;
      if (e.k === "doorOpen" && fin(e.door) && e.door < st.doors.length) st.doors[e.door] = 1;
      else if (e.k === "doorClose" && fin(e.door) && e.door < st.doors.length) st.doors[e.door] = 0;
      else if (e.k === "pick" && fin(e.door) && e.door < st.doors.length) st.doors[e.door] = 1;
      else if (e.k === "lightsOn" && room >= 0 && room < st.rooms.length) st.rooms[room] = 1;
      else if (e.k === "lightsOff" && room >= 0 && room < st.rooms.length) st.rooms[room] = 0;
      else if (e.k === "lamp" && fin(e.lamp) && e.lamp < st.lamps.length) st.lamps[e.lamp] = 0;
      else continue;
      changed = true;
    }
    return changed;
  };

  const layout = () => {
    // The join badge's corner (bottom left) stays clear: the picture goes right of it or above it, whichever is bigger.
    const cs = getComputedStyle(document.documentElement);
    const jw = (parseFloat(cs.getPropertyValue("--tvpipe-join-w")) || 0) / K;
    const jh = (parseFloat(cs.getPropertyValue("--tvpipe-join-h")) || 0) / K;
    const W0 = STAGE_W;
    const H0 = STAGE_H;
    const top = 58;
    const map = M?.map;
    const aspect = map ? map.w / map.h : 1.6;
    const fitIn = (/** @type {number} */ w, /** @type {number} */ hh) => Math.min(w, hh * aspect) * Math.min(hh, w / aspect);
    const a = { x: jw ? jw + 6 : 8, y: top, w: W0 - (jw ? jw + 6 : 8) - 8, h: H0 - top - 8 };
    const b = { x: 8, y: top, w: W0 - 16, h: H0 - top - (jh ? jh + 6 : 8) };
    const r = fitIn(a.w, a.h) >= fitIn(b.w, b.h) ? a : b;
    // The frame takes the map's shape inside it.
    const sw = Math.min(r.w, r.h * aspect);
    const sh = Math.min(r.h, r.w / aspect);
    rect = { x: Math.round(r.x + (r.w - sw) / 2), y: Math.round(r.y + (r.h - sh) / 2), w: Math.round(sw), h: Math.round(sh) };
    if (r === b) rect.y = r.y;
    Object.assign(frameBox.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
  };

  return {
    el,
    update() {
      load();
      layout();
    },
    tape() {
      load();
    },
    frame(now) {
      // The join badge's size (a style read: twice a second is enough).
      if (now - joinAt > 500) {
        joinAt = now;
        const cs = getComputedStyle(document.documentElement);
        const jk = cs.getPropertyValue("--tvpipe-join-w") + cs.getPropertyValue("--tvpipe-join-h");
        if (jk !== joinKey) {
          joinKey = jk;
          layout();
        }
      }
      if (!R) load();
      if (!R || !M?.art) {
        setHidden(blue, !(performance.now() > cardsUntil + 1500));
        setText(play, `${t.tracking}…`);
        setText(code, "");
        return;
      }
      setHidden(blue, true);
      const map = M.map;
      // Playback time → tape time.
      const p = Math.max(0, ((now - start) / 1000) * scale);
      let lo = 0;
      let hi = R.n;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (/** @type {number} */ (R.play[mid]) <= p) lo = mid;
        else hi = mid - 1;
      }
      const i = Math.min(R.n - 1, lo);
      const seg = /** @type {number} */ (R.play[i + 1]) - /** @type {number} */ (R.play[i]);
      const frac = i >= R.n - 1 ? 0 : Math.min(1, Math.max(0, seg > 0 ? (p - /** @type {number} */ (R.play[i])) / seg : 0));
      const s = (i + frac) / R.hz;
      const ended = p >= R.total;
      const sp = seg > 0 ? 1 / R.hz / seg : 6;
      const shown = Math.round(sp * scale);
      if (now < start) setText(play, `${W.ui.play} ▶`);
      else setText(play, ended ? `${t.stop} ■` : shown <= 1 ? `${W.ui.play} ▶` : `${W.ui.play} ▶ ×${shown}`);
      setClass(play, "slow", !ended && shown <= 2 && now >= start);
      if (shown !== lastShown && now >= start && !reduced.matches) {
        // A tracking glitch when the speed changes.
        el.classList.remove("glitch");
        void el.offsetWidth;
        el.classList.add("glitch");
      }
      lastShown = shown;
      const secs = Math.floor(s);
      setText(code, `SP 0:${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`);
      // The light: rooms, lamps, doors from the events; flashlights from the samples.
      const changed = advance(s);
      const at = (/** @type {Sample[]} */ tr, /** @type {number} */ k) => tr[Math.min(tr.length - 1, Math.max(0, k))];
      if (changed || i !== li || !light) {
        li = i;
        const flashlights = [];
        for (let k = 0; k < R.players.length; k++) {
          const smp = at(/** @type {Sample[]} */ (R.tracks[k]), i);
          if (smp && R.players[k]?.role === "guard" && smp.flags & TRACK.LIGHT) flashlights.push({ x: smp.x, y: smp.y, facing: smp.facing, on: true });
        }
        try {
          light = lightMask(map, { doors: st.doors, rooms: st.rooms, lamps: st.lamps, flashlights });
        } catch {
          light = null;
        }
      }
      // Figures and trails.
      const taken = list(R.tape.truth?.items);
      const sack = taken.filter((it) => fin(it?.taken) && it.taken <= s).length;
      const out = R.result?.outcome;
      const endT = num(R.result?.t, Infinity);
      /** @type {any[]} */
      const figures = [];
      /** @type {{ x: number, y: number } | null} */
      let thiefAt = null;
      for (let k = 0; k < R.players.length; k++) {
        const pl = /** @type {{ id: string, role: "thief" | "guard" }} */ (R.players[k]);
        const tr = /** @type {Sample[]} */ (R.tracks[k]);
        const a = at(tr, i);
        const b = at(tr, i + 1) ?? a;
        if (!a || !b) continue;
        const x = a.x + (b.x - a.x) * frac;
        const y = a.y + (b.y - a.y) * frac;
        const prev = at(tr, i - 1) ?? a;
        const moving = Math.hypot(b.x - prev.x, b.y - prev.y) > 0.02;
        const thief = pl.role === "thief";
        if (thief) thiefAt = { x, y };
        if (thief && out === "gotAway" && s >= endT) continue;
        figures.push({
          id: pl.id,
          role: pl.role,
          x,
          y,
          facing: a.facing,
          moving,
          walk: s * 3.5 + k * 0.37,
          light: !thief && !!(a.flags & TRACK.LIGHT),
          held: thief && !!(a.flags & TRACK.FROZEN),
          sack: thief ? sack : undefined,
          cuffed: thief && (out === "pinched" || out === "police") && s >= endT - 0.05,
          colour: thief ? undefined : colourOf(pl.id),
          name: nameOf(pl.id),
          alpha: a.flags & TRACK.AWAY ? 0.45 : 1,
        });
      }
      // Captions; a gentle zoom on the thief around the big moments.
      const live = R.captions.filter((c) => s >= c.t - 1 && s <= c.t + (c.weight === 2 ? 4 : 2.6));
      const cur = live.at(-1);
      const text = cur?.text ?? "";
      if (text !== capText) {
        capText = text;
        cap.hidden = !text;
        cap.textContent = text;
        if (text) fit(cap);
      }
      const wantZoom = !reduced.matches && R.captions.some((c) => c.weight === 2 && s >= c.t - 1.5 && s <= c.t + 3) ? 1 : 0;
      zoom += (wantZoom - zoom) * (reduced.matches ? 1 : 0.06);
      const dpr = Math.min(2, (devicePixelRatio || 1) * K);
      const c = fitCanvas(canvas, rect.w, rect.h, dpr);
      let v = fitView(map, rect.w, rect.h, dpr, { pad: 0 });
      if (zoom > 0.01 && thiefAt) {
        const k = 1 + zoom * 0.9;
        const scale2 = v.scale * k;
        const vw = rect.w / scale2;
        const vh = rect.h / scale2;
        const cx = Math.min(map.w - vw / 2, Math.max(vw / 2, thiefAt.x));
        const cy = Math.min(map.h - vh / 2, Math.max(vh / 2, thiefAt.y));
        const full = { x: v.left + rect.w / v.scale / 2, y: v.top + rect.h / v.scale / 2 };
        const mx = full.x + (cx - full.x) * zoom;
        const my = full.y + (cy - full.y) * zoom;
        v = { ...v, scale: scale2, left: mx - vw / 2, top: my - vh / 2 };
      }
      const cat = list(screenOf(client.view).catalogue);
      const items = [];
      const empty = [];
      for (const it of taken) {
        if (!it || !fin(it.x) || !fin(it.y)) continue;
        const gone = fin(it.taken) && it.taken <= s;
        if (gone) empty.push({ item: it.item, x: it.x, y: it.y, keep: it.keep });
        else items.push({ item: it.item, x: it.x, y: it.y, keep: it.keep, tagged: !!cat[it.item]?.tagged });
      }
      drawWorld(c, M.art, v, { seen: null, light, now: s, doors: st.doors, lamps: st.lamps, items, empty, catalogue: cat, figures: [], colors: screenOf(client.view).colors ?? {} }, { budget: 999 });
      useTiles(c, v);
      // Trails under the figures: guards dashed in their colour, the thief's line in cream on black.
      for (let k = 0; k < R.players.length; k++) {
        const pl = /** @type {{ id: string, role: string }} */ (R.players[k]);
        const tr = /** @type {Sample[]} */ (R.tracks[k]);
        /** @type {[number, number][]} */
        const pts = [];
        const from = pl.role === "thief" ? 0 : Math.max(0, i - 40 * R.hz);
        for (let j = from; j <= i && j < tr.length; j += 2) {
          const q = /** @type {Sample} */ (tr[j]);
          pts.push([q.x, q.y]);
        }
        const last = figures.find((f) => f.id === pl.id);
        if (last) pts.push([last.x, last.y]);
        if (pl.role === "thief") {
          drawTrail(c, pts, "#0d0c0e", { width: 0.42 });
          drawTrail(c, pts, "#f6ecd2", { width: 0.22 });
        } else drawTrail(c, pts, colourOf(pl.id), { dashed: true, width: 0.14 });
      }
      for (const f of figures) drawFigure(c, f, s);
      // Marks (with the truth), the car on its spot, bangs.
      const marks = list(R.tape.truth?.marks).filter((m) => m && num(m.t) <= s && s < num(m.ended, num(m.until, Infinity)));
      const noises = R.events.filter((e) => e.k === "bang" && s >= e.t && s - e.t < 3).map((e, k) => ({ id: k, kind: "firecracker", x: e.x, y: e.y, t: e.t }));
      const car = num(R.tape.truth?.car, num(R.result?.car, -1));
      drawPublic(c, M.art, v, { t: s, marks, noises }, { lights: false, colors: screenOf(client.view).colors ?? {}, names: namesById(), words: { ...t.map, gotAway: t.getaway }, now: s, car: car >= 0 ? car : null });
    },
  };
}

// ---------------------------------------------------------------------------
// The scores (§9)

/** The round in the history (the latest, else the one asked). @param {any} sc @returns {RoundView | null} */
function roundOf(sc) {
  const hist = /** @type {RoundView[]} */ (list(sc.history));
  return hist.find((r) => r?.round === sc.round) ?? hist.at(-1) ?? null;
}

/** Players ranked by total (ties: the bigger single haul). @param {any} sc */
function ranking(sc) {
  const scores = sc.scores && typeof sc.scores === "object" ? sc.scores : {};
  const best = (/** @type {string} */ id) => Math.max(0, ...list(sc.history).filter((r) => r?.thief === id).map((r) => num(r.haul)));
  const ids = new Set([...list(client.view?.roster).map((r) => r?.id), ...Object.keys(scores)].filter((x) => typeof x === "string"));
  return [...ids].map((id) => ({ id, total: num(scores[id]), best: best(id) })).sort((a, b) => b.total - a.total || b.best - a.best);
}

/** @returns {Scene} */
function scoresScene() {
  const W = words(lang);
  const head = h("div", { class: "head" });
  const left = h("div", { class: "panel round deco-frame" });
  const right = h("div", { class: "panel totals deco-frame" });
  const next = h("div", { class: "next", "data-fit": "13" });
  const el = h("div", { class: "scene scores" }, head, left, right, next);
  return {
    el,
    update(v) {
      const sc = screenOf(v);
      const r = roundOf(sc);
      const kind = r?.outcome ?? "police";
      let title = "";
      try {
        title = W.outcomes[kind]?.title ?? "";
      } catch {
        title = "";
      }
      head.replaceChildren(h("div", { class: "kicker deco-caps" }, t.round(num(sc.round), num(sc.rounds))), h("div", { class: "title", "data-fit": "24" }, title), h("div", { class: "thief" }, thiefIcon(50), h("b", {}, nameOf(r?.thief ?? sc.thief))));
      // The round: what was in the sack, the haul, the rewards.
      const got = kind === "gotAway";
      const items = list(r?.items).map((id) => itemById(String(id))).filter((x) => !!x);
      left.replaceChildren(
        h("h2", { class: "deco-caps" }, got ? t.carried : t.confiscated),
        items.length
          ? h("ul", { class: `loot-list${got ? "" : " lost"}` }, ...items.map((it) => h("li", {}, lootIcon(it.id, 28, { grey: !got }), h("span", { class: "name" }, itemName(lang, it)), h("span", { class: "val" }, cash(it.value)))))
          : h("p", { class: "none" }, t.nothing),
        h("div", { class: "haul" }, h("span", { class: "deco-caps" }, W.ui.haul), h("b", {}, cash(num(r?.haul)))),
        h("h2", { class: "deco-caps" }, t.rewards),
        Object.keys(r?.rewards ?? {}).length
          ? h("ul", { class: "rewards" }, ...Object.entries(r?.rewards ?? {}).map(([id, amount]) => h("li", { style: { "--c": colourOf(id) } }, h("b", {}, nameOf(id)), h("span", { class: "val" }, `+${cash(num(amount))}`))))
          : h("p", { class: "none" }, t.noRewards),
      );
      // The totals, richest first, with this round's gain.
      const rank = ranking(sc);
      const top = Math.max(1, ...rank.map((x) => x.total));
      const gain = (/** @type {string} */ id) => (r ? (r.thief === id ? num(r.haul) : num(r.rewards?.[id])) : 0);
      right.replaceChildren(
        h("h2", { class: "deco-caps" }, t.totals),
        h(
          "ol",
          { class: "ranks", style: { "--n": rank.length } },
          ...rank.map((x, k) =>
            h(
              "li",
              { style: { "--c": colourOf(x.id), "--f": (x.total / top).toFixed(3) } },
              h("span", { class: "pos" }, String(k + 1)),
              x.id === r?.thief ? thiefIcon(36) : hatIcon(colourOf(x.id), 36),
              h("span", { class: "nm", "data-fit": "12" }, nameOf(x.id)),
              h("span", { class: "bar" }),
              gain(x.id) > 0 ? h("span", { class: "gain" }, `+${cash(gain(x.id))}`) : h("span", { class: "gain" }),
              h("b", { class: "val" }, cash(x.total)),
            ),
          ),
        ),
      );
      const nx = list(sc.next)[0];
      next.textContent = nx ? t.nextUp(nameOf(nx)) : num(sc.round) >= num(sc.rounds) && num(sc.rounds) > 0 ? t.lastRound : "";
      fitAll(el);
    },
  };
}

// ---------------------------------------------------------------------------
// The end: the podium, every round, the awards (§9)

/** @returns {Scene} */
function finalScene() {
  const W = words(lang);
  const podium = h("div", { class: "podium" });
  const rest = h("ol", { class: "rest" });
  const awards = h("div", { class: "awards" });
  const rounds = h("ol", { class: "rounds" });
  const el = h(
    "div",
    { class: "scene final sunburst" },
    h("div", { class: "head" }, h("div", { class: "title" }, W.ui.podium)),
    h("div", { class: "stand" }, podium, rest),
    h("div", { class: "side deco-frame" }, h("h2", { class: "deco-caps" }, t.rounds2), rounds),
    h("div", { class: "foot" }, awards),
  );
  return {
    el,
    update(v) {
      const sc = screenOf(v);
      const rank = ranking(sc);
      const steps = [rank[1], rank[0], rank[2]];
      podium.replaceChildren(
        ...steps.map((x, k) => {
          if (!x) return h("div", { class: "step empty" });
          const place = k === 1 ? 1 : k === 0 ? 2 : 3;
          return h(
            "div",
            { class: `step p${place}`, style: { "--c": colourOf(x.id) } },
            hatIcon(colourOf(x.id), place === 1 ? 86 : 66),
            h("b", { class: "nm", "data-fit": "12" }, nameOf(x.id)),
            h("span", { class: "val" }, cash(x.total)),
            h("div", { class: "block" }, String(place)),
          );
        }),
      );
      rest.replaceChildren(...rank.slice(3).map((x, k) => h("li", { style: { "--c": colourOf(x.id) } }, h("span", { class: "pos" }, String(k + 4)), h("b", {}, nameOf(x.id)), h("span", { class: "val" }, cash(x.total)))));
      awards.replaceChildren(
        ...list(sc.awards)
          .slice(0, 3)
          .map((a, k) => {
            let w = { name: "", citation: "" };
            try {
              w = award(lang, a.id, /** @type {any} */ ({ ...(a.params ?? {}), name: nameOf(a.player) }), rngOf("award", k, String(a.id)));
            } catch {
              // unknown award
            }
            if (!w.name) return null;
            return h(
              "div",
              { class: "award", style: { "--c": colourOf(a.player) } },
              h("div", { class: "aname deco-title", "data-fit": "14" }, w.name),
              h("div", { class: "who" }, hatIcon(colourOf(a.player), 26), h("b", {}, nameOf(a.player))),
              h("div", { class: "cite", "data-fit": "12" }, w.citation),
            );
          })
          .filter((x) => !!x),
      );
      const hist = list(sc.history);
      rounds.classList.toggle("two", hist.length > 8);
      rounds.replaceChildren(
        ...hist.map((r) => {
          let title = "";
          try {
            title = W.outcomes[/** @type {"pinched"} */ (r?.outcome)]?.title ?? "";
          } catch {
            title = "";
          }
          return h(
            "li",
            { class: `rnd ${r?.outcome === "gotAway" ? "won" : "lost"}`, style: { "--c": colourOf(r?.thief) }, title },
            h("span", { class: "n" }, String(num(r?.round))),
            h("b", { class: "nm", "data-fit": "10" }, nameOf(r?.thief)),
            h("span", { class: "val" }, r?.outcome === "gotAway" ? cash(num(r?.haul)) : "✗"),
          );
        }),
      );
      fitAll(el);
    },
  };
}
