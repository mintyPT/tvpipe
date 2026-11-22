// @ts-check
/**
 * The heist on the phone (docs/pinch-design.md §4, §5, §10): the whole
 * screen a map centred on one's figure, drawn by draw.js 60 times a
 * second from {@link Heist} (world.js); the top bar (the clock, the
 * role, the sack or the marks), the bottom (the action button from the
 * frame's offers with the busy progress, the flashlight or the
 * firecrackers, a big HOLD or WRIGGLE), and the gestures:
 *
 * - tap the floor: walk (predicted at once, `go` to the host);
 * - tap the thief (a guard): hold;
 * - drag from one's own figure (a guard): aim the flashlight (`aim` input);
 * - long press (a guard): the radial marks menu; Seen takes a drag for its arrow;
 * - two fingers: zoom (10–24 tiles across);
 * - the firecracker button arms a throw, the next tap throws.
 *
 * Refusals come back as a toast with words.ts' words; buzzes for the
 * thief's heartbeat, a hold, the arrest and the car.
 */

import {
  createArt, drawLootIcon, drawPublic, drawWorld, fitCanvas, followView, FONTS, PALETTE, toScreen, toTile, useTiles,
} from "./draw.js";
import { Heist } from "./world.js";
import { TIMES, wordsArea } from "../game/protocol.js";
import { itemById, THIEF_SLOTS } from "../game/items.js";
import { claim, fact, noun, words } from "../game/words.js";

/** @typedef {import("../game/map.ts").Blueprint} Blueprint */
/** @typedef {import("../game/protocol.ts").Action} Action */
/** @typedef {import("../game/protocol.ts").Offer} Offer */
/** @typedef {import("../game/views.ts").CatalogueEntry} CatalogueEntry */
/** @typedef {import("./draw.js").Figure} Figure */

/**
 * What the heist screen needs from the page.
 * @typedef {{
 *   client: { act: (type: string, data?: any) => Promise<any>, input: (data: unknown) => void, on: (e: string, fn: (...a: any[]) => void) => () => void },
 *   myId: string, role: "thief" | "guard", map: Blueprint, lang: "en" | "de", strings: import("./strings.js").Strings,
 *   catalogue: () => CatalogueEntry[], colorOf: (id: string | null | undefined) => string, nameOf: (id: string | null | undefined) => string,
 *   colors: () => Record<string, string>, names: () => Record<string, string>,
 *   buzz: (p: number | number[]) => void, frames?: unknown[],
 * }} HeistContext
 */

const fin = (/** @type {unknown} */ v) => typeof v === "number" && Number.isFinite(v);
const clamp = (/** @type {number} */ v, /** @type {number} */ a, /** @type {number} */ b) => (v < a ? a : v > b ? b : v);
const ZOOM_KEY = "pinch:across";
const MIN_ACROSS = 10;
const MAX_ACROSS = 24;
/** A press this long without moving opens the marks menu (ms); a move this far (px) is a drag. */
const LONG = 450;
const SLOP = 10;

/** One art per map (its caches). @type {{ key: string, art: ReturnType<typeof createArt> } | null} */
let artCache = null;

/** @param {string} tag @param {Record<string, any>} [attrs] @param {...(Node | string | null | false | undefined)} kids */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

/** "2:05". @param {number} s */
export function clock(s) {
  const t = Math.max(0, Math.ceil(fin(s) ? s : 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** The art for a map (made once per blueprint, the room names in the language). @param {Blueprint} map @param {"en" | "de"} lang @param {string} key */
export function artFor(map, lang, key) {
  if (artCache && artCache.key === `${key}|${lang}`) return artCache.art;
  const names = map.rooms.map((r) => {
    const a = wordsArea(map, { room: r.id });
    return a ? noun(lang, a).label.toLocaleUpperCase(lang) : "";
  });
  const areaNames = map.areas.map((r) => {
    const a = wordsArea(map, { area: r.id });
    return a ? noun(lang, a).label.toLocaleUpperCase(lang) : "";
  });
  const art = createArt(map, { names, areaNames });
  artCache = { key: `${key}|${lang}`, art };
  return art;
}

/**
 * The heist screen.
 * @param {HeistContext} ctx
 * @param {string} artKey
 */
export function heistScreen(ctx, artKey) {
  const { map, role, strings: t, lang } = ctx;
  const w = words(lang);
  const art = artFor(map, lang, artKey);
  /** The printed words on the map. @type {import("./draw.js").MapWords} */
  const mapWords = {
    ...t.mapWords, held: w.ui.held.toLocaleUpperCase(lang), missing: w.ui.missing.toLocaleUpperCase(lang),
    clear: w.buttons.clear.toLocaleUpperCase(lang), seen: w.buttons.seen.toLocaleUpperCase(lang), post: w.buttons.post.toLocaleUpperCase(lang), look: w.buttons.look.toLocaleUpperCase(lang),
  };
  const model = new Heist(map, ctx.myId, role);
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  let across = 14;
  try {
    const z = Number(localStorage.getItem(ZOOM_KEY));
    if (z >= MIN_ACROSS && z <= MAX_ACROSS) across = z;
  } catch {}
  let layerOn = true;
  try {
    layerOn = localStorage.getItem("pinch:layer") !== "0";
  } catch {}

  // ---------------------------------------------------------------- the DOM

  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "map" }));
  const clockEl = h("b", { class: "clock" }, "0:00");
  const roleName = w.roles[role].name;
  const roleEl = h("span", { class: "role", "data-fit": "1" }, roleName);
  const roleBox = h("div", { class: `rolebox ${role}` }, h("i", { class: "dot" }), roleEl);
  const slotsEl = h("div", { class: "slots", "aria-label": role === "thief" ? t.slots : t.marksLeft });
  const layerBtn = /** @type {HTMLButtonElement} */ (h("button", { class: `layer${layerOn ? " on" : ""}`, type: "button", title: t.layerTitle, "aria-pressed": String(layerOn) }, h("i"), t.layer));
  const top = h("header", { class: "hud-top" }, clockEl, roleBox, slotsEl, layerBtn);
  const ticker = h("div", { class: "ticker", hidden: true });
  const banner = h("div", { class: "holdbanner", hidden: true }, h("span", { class: "txt", "data-fit": "1" }), h("i", { class: "bar" }, h("i")));
  const hint = h("div", { class: "hint", hidden: true });
  const toastEl = h("div", { class: "toast", hidden: true });
  const toolIcon = h("i", { class: "icon" });
  const toolLabel = h("span", { class: "lbl", "data-fit": "2" });
  const toolCount = h("b", { class: "count" });
  const tool = /** @type {HTMLButtonElement} */ (h("button", { class: `tool ${role}`, type: "button" }, toolIcon, toolCount, toolLabel));
  /** @type {HTMLButtonElement[]} */
  const actBtns = [0, 1].map(() => /** @type {HTMLButtonElement} */ (h("button", { class: "act", type: "button" }, h("i", { class: "fill" }), h("span", { class: "lbl", "data-fit": "1" }), h("span", { class: "sub", "data-fit": "1" }))));
  const acts = h("div", { class: "acts" }, ...actBtns);
  const bottom = h("footer", { class: "hud-bottom" }, tool, acts);
  const bigLbl = h("span", {});
  const big = /** @type {HTMLButtonElement} */ (h("button", { class: "bigbtn", type: "button", hidden: true }, bigLbl));
  const radial = h("div", { class: "radial", hidden: true });
  const under = h("div", { class: "under" }, banner, ticker, hint);
  const el = h("div", { class: `heist ${role}` }, canvas, top, under, toastEl, radial, big, bottom);
  el.style.setProperty("--me", ctx.colorOf(ctx.myId));

  // ---------------------------------------------------------------- acting

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let toastTimer;
  /** @param {string} text */
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    toastEl.classList.remove("show");
    void toastEl.offsetWidth;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }
  /** @param {unknown} code */
  function refusal(code) {
    if (typeof code !== "string") return null;
    const r = /** @type {Record<string, string>} */ (w.refusals);
    return r[code] ?? null;
  }
  /** @param {Action} a */
  function act(a) {
    return ctx.client.act("h", a).then(
      () => true,
      (e) => {
        const text = refusal(e?.code);
        if (text) {
          toast(text);
          ctx.buzz(30);
        }
        return false;
      },
    );
  }

  layerBtn.addEventListener("click", () => {
    layerOn = !layerOn;
    layerBtn.classList.toggle("on", layerOn);
    layerBtn.setAttribute("aria-pressed", String(layerOn));
    try {
      localStorage.setItem("pinch:layer", layerOn ? "1" : "0");
    } catch {}
    if (!layerOn) ticker.hidden = true;
  });

  let armed = false;
  tool.addEventListener("click", () => {
    const me = model.me;
    if (!me) return;
    if (me.role === "guard") {
      void act({ a: "flashlight", on: me.light === "off" });
      return;
    }
    if (me.firecrackers <= 0) {
      toast(refusal("noFirecrackers") ?? "");
      return;
    }
    armed = !armed;
    showHint(armed ? t.fireArmed : null);
  });
  /** @type {(Offer | null)[]} */
  let shownOffers = [null, null];
  actBtns.forEach((b, k) => {
    b.addEventListener("click", () => {
      const o = shownOffers[k];
      if (!o) return;
      const { button: _b, ...a } = o;
      void act(/** @type {Action} */ (a));
    });
  });
  big.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const me = model.me;
    if (!me) return;
    if (me.role === "thief") void act({ a: "wriggle" });
    else {
      const thief = model.others(performance.now()).find((o) => o.role === "thief");
      void act(thief ? { a: "hold", target: thief.id } : { a: "hold" });
    }
    big.classList.remove("press");
    void big.offsetWidth;
    big.classList.add("press");
  });

  /** @param {string | null} text */
  function showHint(text) {
    hint.hidden = !text;
    hint.textContent = text ?? "";
  }

  // ---------------------------------------------------------------- frames

  let lastBeat = 0;
  const offMsg = ctx.client.on("msg", (/** @type {string} */ type, /** @type {unknown} */ data) => {
    if (type === "f") frame(data);
  });
  /** @param {unknown} data */
  function frame(data) {
    const happened = model.onFrame(data, performance.now());
    for (const x of happened) {
      if (x.k === "resync") ctx.client.act("resync").catch(() => {});
      else if (x.k === "hold") ctx.buzz(x.thief === ctx.myId ? [300, 80, 300] : [180, 80, 180]);
      else if (x.k === "arrest") ctx.buzz([500, 120, 500]);
      else if (x.k === "end" && x.outcome === "gotAway") ctx.buzz([80, 60, 80, 60, 320]);
      else if (x.k === "taken") ctx.buzz(35);
      else if (x.k === "event" && layerOn) {
        const line = tickerLine(x.e);
        if (line) showTicker(line, x.e);
      }
    }
  }
  for (const f of ctx.frames ?? []) frame(f);

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let tickerTimer;
  /** @param {string} line @param {import("../game/protocol.ts").TickerEvent} e */
  function showTicker(line, e) {
    const isClaim = e.k === "clear" || e.k === "seen" || e.k === "post" || e.k === "look";
    ticker.textContent = line;
    ticker.className = `ticker ${isClaim ? "claim" : "fact"}`;
    ticker.style.setProperty("--c", isClaim ? ctx.colorOf(/** @type {any} */ (e).guard) : "");
    ticker.hidden = false;
    clearTimeout(tickerTimer);
    tickerTimer = setTimeout(() => (ticker.hidden = true), 5000);
  }

  /** A ticker event in words, or null. @param {import("../game/protocol.ts").TickerEvent} e */
  function tickerLine(e) {
    try {
      const rng = () => (((e.seq ?? 0) * 0.6180339) % 1 + 1) % 1;
      const where = "where" in e && e.where ? wordsArea(map, e.where) : null;
      const item = "item" in e ? itemById(ctx.catalogue()[e.item]?.id ?? "") : undefined;
      const name = (/** @type {string} */ id) => ctx.nameOf(id);
      switch (e.k) {
        case "sighting":
          return where ? fact(lang, "sighting", { camera: e.camera + 1, where }, rng) : null;
        case "tampered":
          return fact(lang, "tampered", { camera: e.camera + 1 }, rng);
        case "glass":
        case "lamp":
        case "firecracker":
        case "ping":
        case "lightsOn":
        case "lightsOff":
          return where ? fact(lang, e.k, { where }, rng) : null;
        case "alarm":
          return where ? fact(lang, "alarm", { where, seconds: e.seconds }, rng) : null;
        case "missing":
          return where && item ? fact(lang, "missing", { item, where }, rng) : null;
        case "held":
          return where ? fact(lang, "held", { guard: name(e.guard), thief: name(e.thief), where }, rng) : null;
        case "holdBroken":
        case "holdSlipped":
        case "arrest":
          return fact(lang, e.k, { guard: name(e.guard), thief: name(e.thief) }, rng);
        case "gotAway":
          return fact(lang, "gotAway", { thief: name(e.thief) }, rng);
        case "timeUp":
        case "lastMinute":
        case "start":
          return fact(lang, e.k, {}, rng);
        case "clear":
        case "post":
        case "look":
          return where ? claim(lang, e.k, { guard: name(e.guard), where }, rng) : null;
        case "seen":
          return where ? claim(lang, "seen", { guard: name(e.guard), where, dir: e.dir }, rng) : null;
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- gestures

  /** @type {Map<number, { x0: number, y0: number, x: number, y: number, t0: number }>} */
  const pointers = new Map();
  /** "idle" | "press" | "aim" | "drag" | "pinch" | "radial" | "arrow" */
  let mode = "idle";
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let longTimer;
  let pinch0 = { d: 1, across: 14 };
  /** The marks menu's place (tiles and px) and what the finger is over. */
  let menu = { tx: 0, ty: 0, sx: 0, sy: 0, over: "" };
  /** The Seen mark waiting for its arrow: from (tiles), to (px). */
  let arrow = { tx: 0, ty: 0, sx: 0, sy: 0, ex: 0, ey: 0, down: false };
  /** @type {import("./draw.js").View | null} */
  let view = null;

  /** @param {PointerEvent} e */
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const meScreen = () => (view ? toScreen(view, model.at.x, model.at.y) : { x: -1e4, y: -1e4 });

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
    const p = local(e);
    pointers.set(e.pointerId, { x0: p.x, y0: p.y, x: p.x, y: p.y, t0: performance.now() });
    if (pointers.size === 2) {
      clearTimeout(longTimer);
      const [a, b] = [...pointers.values()];
      pinch0 = { d: Math.max(20, Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0))), across };
      if (mode === "radial") closeRadial();
      mode = "pinch";
      return;
    }
    if (pointers.size > 2) return;
    if (mode === "radial") {
      closeRadial();
      mode = "idle";
      pointers.delete(e.pointerId);
      return;
    }
    if (mode === "arrow") {
      arrow.down = true;
      arrow.ex = p.x;
      arrow.ey = p.y;
      return;
    }
    mode = "press";
    if (role === "guard") {
      longTimer = setTimeout(() => {
        if (mode !== "press") return;
        const q = [...pointers.values()][0];
        if (q) openRadial(q.x, q.y, true);
      }, LONG);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const q = pointers.get(e.pointerId);
    if (!q) return;
    const p = local(e);
    q.x = p.x;
    q.y = p.y;
    if (mode === "pinch" && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.max(20, Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0)));
      across = clamp((pinch0.across * pinch0.d) / d, MIN_ACROSS, MAX_ACROSS);
      return;
    }
    if (mode === "press" && Math.hypot(q.x - q.x0, q.y - q.y0) > SLOP) {
      clearTimeout(longTimer);
      const m = meScreen();
      const near = view ? Math.max(30, view.scale * 0.9) : 30;
      mode = role === "guard" && Math.hypot(q.x0 - m.x, q.y0 - m.y) < near ? "aim" : "drag";
    }
    if (mode === "aim") {
      const m = meScreen();
      const angle = (Math.atan2(q.y - m.y, q.x - m.x) * 180) / Math.PI;
      const a = Math.round(((angle % 360) + 360) % 360);
      model.aimAt(a, performance.now());
      ctx.client.input({ a: "aim", angle: a });
    } else if (mode === "radial") {
      hoverRadial(q.x, q.y);
    } else if (mode === "arrow" && arrow.down) {
      arrow.ex = q.x;
      arrow.ey = q.y;
    }
  });
  /** @param {PointerEvent} e */
  const up = (e) => {
    const q = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!q) return;
    clearTimeout(longTimer);
    if (mode === "pinch") {
      if (pointers.size === 0) {
        mode = "idle";
        try {
          localStorage.setItem(ZOOM_KEY, String(Math.round(across * 10) / 10));
        } catch {}
      }
      return;
    }
    if (e.type === "pointercancel") {
      if (mode !== "radial" && mode !== "arrow") mode = "idle";
      return;
    }
    if (mode === "press") {
      mode = "idle";
      tap(q.x, q.y);
    } else if (mode === "aim" || mode === "drag") mode = "idle";
    else if (mode === "radial") {
      // Released over an option: that one; at the centre: the menu stays for a tap.
      if (menu.over) pickRadial(menu.over);
    } else if (mode === "arrow" && arrow.down) {
      arrow.down = false;
      const s = view ? toScreen(view, arrow.tx, arrow.ty) : { x: arrow.sx, y: arrow.sy };
      if (Math.hypot(arrow.ex - s.x, arrow.ey - s.y) > 36) {
        const angle = Math.round(((((Math.atan2(arrow.ey - s.y, arrow.ex - s.x) * 180) / Math.PI) % 360) + 360) % 360);
        void act({ a: "mark", kind: "seen", x: arrow.tx, y: arrow.ty, angle });
        mode = "idle";
        showHint(null);
      }
    }
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  /** A tap on the map (CSS px). @param {number} sx @param {number} sy */
  function tap(sx, sy) {
    if (!view) return;
    const p = toTile(view, sx, sy);
    const now = performance.now();
    if (armed && role === "thief") {
      armed = false;
      showHint(null);
      void act({ a: "firecracker", x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
      return;
    }
    if (role === "guard") {
      const thief = model.others(now).find((o) => o.role === "thief");
      if (thief) {
        const s = toScreen(view, thief.x, thief.y);
        if (Math.hypot(s.x - sx, s.y - sy) < Math.max(34, view.scale * 0.9)) {
          void act({ a: "hold", target: thief.id });
          return;
        }
      }
    }
    if (role === "guard") {
      // One's own mark: the first tap only offers to remove it (a second tap on it walks there).
      const mk = ownMarkAt(sx, sy);
      if (mk !== null && mk !== popMark) {
        openPop(mk, now);
        return;
      }
      closePop();
    }
    if (model.me?.frozen) {
      if (role === "thief") void act({ a: "wriggle" });
      return;
    }
    model.walkTo(p.x, p.y, now);
    tapMark = { x: p.x, y: p.y, at: now };
    const seq = ++goSeq;
    void act({ a: "go", x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }).then((ok) => {
      // Refused (and no newer tap since): the prediction goes back to what the host does.
      if (!ok && seq === goSeq) model.refused();
    });
  }
  let goSeq = 0;
  let tapMark = { x: 0, y: 0, at: -1e9 };

  // The marks menu: four crayon buttons round the finger.
  const KINDS = /** @type {const} */ (["look", "post", "clear", "seen"]);
  /** @type {Record<string, HTMLElement>} */
  const opts = {};
  /**
   * A menu button acts on its own tap only (down and up on it): the
   * long press that opened the menu ends over it without choosing.
   * @param {HTMLElement} b @param {() => void} fn
   */
  const onTap = (b, fn) => {
    let down = -1;
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      down = e.pointerId;
    });
    b.addEventListener("pointerup", (e) => {
      if (e.pointerId === down) fn();
      down = -1;
    });
    b.addEventListener("pointercancel", () => (down = -1));
  };
  for (const k of KINDS) {
    const b = h("button", { class: `opt ${k}`, type: "button", "data-kind": k }, h("i"), h("span", { "data-fit": "1" }, w.buttons[k]));
    onTap(b, () => pickRadial(k));
    opts[k] = b;
    radial.append(b);
  }
  const cancel = h("button", { class: "opt cancel", type: "button", "aria-label": w.buttons.cancel }, "✕");
  onTap(cancel, () => {
    closeRadial();
    mode = "idle";
  });
  radial.append(cancel);

  // Removing one of one's own marks: a tap on it opens a small pop, Remove sends `unmark`.
  const popBtn = h("button", { class: "opt remove", type: "button" }, h("span", { "data-fit": "1" }, t.removeMark));
  const pop = h("div", { class: "markpop", hidden: true }, popBtn);
  el.append(pop);
  /** The mark the pop is for (its id), and when it closes by itself. @type {number | null} */
  let popMark = null;
  let popUntil = 0;
  onTap(popBtn, () => {
    if (popMark !== null) void act({ a: "unmark", mark: popMark });
    closePop();
  });
  /** One's own visible mark under a tap (CSS px), nearest, or null. @param {number} sx @param {number} sy */
  function ownMarkAt(sx, sy) {
    if (!view || !layerOn) return null;
    let best = null;
    let bestD = Math.max(26, view.scale * 0.8);
    for (const m of model.pub?.marks ?? []) {
      if (!m || m.guard !== ctx.myId || !fin(m.x) || !fin(m.y)) continue;
      const q = toScreen(view, m.x, m.y);
      const d = Math.hypot(q.x - sx, q.y - sy);
      if (d < bestD) {
        bestD = d;
        best = m.id;
      }
    }
    return best;
  }
  /** @param {number} id @param {number} now */
  function openPop(id, now) {
    popMark = id;
    popUntil = now + 4000;
    pop.hidden = false;
    placePop(now);
    ctx.buzz(15);
  }
  function closePop() {
    popMark = null;
    pop.hidden = true;
  }
  /** Keeps the pop over its mark as the map moves; closes it when the mark is gone or it timed out. @param {number} now */
  function placePop(now) {
    if (popMark === null) return;
    const m = (model.pub?.marks ?? []).find((k) => k?.id === popMark);
    if (!m || !view || !layerOn || now > popUntil) {
      closePop();
      return;
    }
    const q = toScreen(view, m.x, m.y);
    pop.style.transform = `translate(${Math.round(clamp(q.x, 60, size.w - 60))}px, ${Math.round(clamp(q.y, size.top + 70, size.h - size.bottom - 10))}px)`;
  }
  const R = 78;
  /** @param {number} sx @param {number} sy @param {boolean} down */
  function openRadial(sx, sy, down) {
    if (!view) return;
    const p = toTile(view, sx, sy);
    const W = el.clientWidth;
    const H = el.clientHeight;
    const cx = clamp(sx, R + 46, W - R - 46);
    const cy = clamp(sy, R + 90, H - R - 120);
    menu = { tx: p.x, ty: p.y, sx: cx, sy: cy, over: "" };
    radial.style.setProperty("--x", `${cx}px`);
    radial.style.setProperty("--y", `${cy}px`);
    radial.hidden = false;
    mode = down ? "radial" : "idle";
    if (down) mode = "radial";
    ctx.buzz(20);
  }
  /** @param {number} sx @param {number} sy */
  function hoverRadial(sx, sy) {
    const dx = sx - menu.sx;
    const dy = sy - menu.sy;
    let over = "";
    if (Math.hypot(dx, dy) > R * 0.5) {
      const a = Math.atan2(dy, dx);
      // look up, post right, clear down, seen left
      const k = Math.round(a / (Math.PI / 2));
      over = k === -1 ? "look" : k === 0 ? "post" : k === 1 ? "clear" : "seen";
    }
    if (over !== menu.over) {
      menu.over = over;
      for (const k of KINDS) opts[k]?.classList.toggle("over", k === over);
      if (over) ctx.buzz(8);
    }
    if (over === "seen" && Math.hypot(dx, dy) > R * 0.9) {
      // On with the same finger: the arrow follows it.
      pickRadial("seen");
      arrow.down = true;
      arrow.ex = sx;
      arrow.ey = sy;
    }
  }
  /** @param {string} kind */
  function pickRadial(kind) {
    closeRadial();
    if (kind === "seen") {
      const s = view ? toScreen(view, menu.tx, menu.ty) : { x: menu.sx, y: menu.sy };
      arrow = { tx: menu.tx, ty: menu.ty, sx: s.x, sy: s.y, ex: s.x, ey: s.y, down: false };
      mode = "arrow";
      showHint(t.arrow);
      return;
    }
    mode = "idle";
    if (kind === "look" || kind === "post" || kind === "clear") void act({ a: "mark", kind, x: Math.round(menu.tx * 100) / 100, y: Math.round(menu.ty * 100) / 100 });
  }
  function closeRadial() {
    radial.hidden = true;
    menu.over = "";
    for (const k of KINDS) opts[k]?.classList.remove("over");
  }

  // ---------------------------------------------------------------- the HUD

  let slotsKey = "";
  /** @param {number} now */
  function hud(now) {
    const me = model.me;
    const left = model.left(now);
    clockEl.textContent = clock(left);
    clockEl.classList.toggle("low", left <= 30 || !!model.pub?.alarm);
    if (!me) return;

    // The sack, or the marks left.
    const cat = ctx.catalogue();
    const key = me.role === "thief" ? `t|${me.slots.map((s) => `${s.item}:${s.tagged ? 1 : 0}`).join(",")}` : `g|${me.marksLeft}|${ctx.colorOf(ctx.myId)}`;
    if (key !== slotsKey) {
      slotsKey = key;
      slotsEl.replaceChildren();
      if (me.role === "thief") {
        let used = 0;
        for (const s of Array.isArray(me.slots) ? me.slots : []) {
          const entry = cat[s.item];
          const large = entry?.size === "large";
          const cv = /** @type {HTMLCanvasElement} */ (h("canvas", {}));
          const box = h("span", { class: `slot full${large ? " large" : ""}` }, cv, s.tagged ? h("b", { class: "tag" }, w.ui.tag) : null);
          slotsEl.append(box);
          const px = 26;
          const c = fitCanvas(cv, large ? px * 2 : px, px, dpr);
          c.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawLootIcon(c, entry?.id ?? "box", large ? px : px / 2, px / 2, px * 0.9, { tagged: false });
          used += large ? 2 : 1;
        }
        for (let k = used; k < THIEF_SLOTS; k++) slotsEl.append(h("span", { class: "slot" }));
      } else {
        for (let k = 0; k < TIMES.marks; k++) slotsEl.append(h("span", { class: `pip${k < me.marksLeft ? " on" : ""}` }));
      }
    }

    // The tool.
    if (me.role === "guard") {
      tool.classList.toggle("on", me.light === "on");
      tool.classList.toggle("warming", me.light === "warming");
      setText(toolLabel, me.light === "off" ? w.buttons.flashlightOn : w.buttons.flashlightOff);
      setText(toolCount, "");
    } else {
      tool.classList.toggle("on", armed);
      tool.disabled = me.firecrackers <= 0 && !armed;
      setText(toolLabel, armed ? w.buttons.throw : w.buttons.firecracker);
      setText(toolCount, String(Math.max(0, me.firecrackers | 0)));
      if (armed && me.firecrackers <= 0) {
        armed = false;
        showHint(null);
      }
    }

    // The action buttons: what can be done here, or what one is busy with.
    // Two buttons: what one came for first (the host lists doors and switches before the loot).
    const offers = (Array.isArray(me.offers) ? me.offers : []).filter((o) => o && o.a !== "hold" && o.a !== "wriggle").sort((a, b) => offerRank(a) - offerRank(b));
    const busy = me.busy;
    /** @type {(Offer | null)[]} */
    const show = [offers[0] ?? null, offers[1] ?? null];
    actBtns.forEach((b, k) => {
      const lbl = /** @type {HTMLElement} */ (b.querySelector(".lbl"));
      const sub = /** @type {HTMLElement} */ (b.querySelector(".sub"));
      const fill = /** @type {HTMLElement} */ (b.querySelector(".fill"));
      if (k === 0 && busy && fin(busy.total) && busy.total > 0) {
        const l = Math.max(0, busy.left - (now - model.frameAt) / 1000);
        b.hidden = false;
        b.classList.add("busy");
        b.disabled = true;
        setText(lbl, busyLabel(busy.kind));
        setText(sub, busy.kind === "take" ? itemLabel(busy.target) : "");
        fill.style.transform = `scaleX(${clamp(1 - l / busy.total, 0, 1).toFixed(3)})`;
        shownOffers[k] = null;
        return;
      }
      const o = show[k] ?? null;
      b.classList.remove("busy");
      b.disabled = false;
      fill.style.transform = "scaleX(0)";
      shownOffers[k] = o;
      b.dataset["a"] = o?.a ?? "";
      b.hidden = !o;
      if (o) setText(lbl, /** @type {Record<string, string>} */ (w.buttons)[o.button] ?? o.button);
      setText(sub, o?.a === "take" ? itemLabel(o.item) : "");
    });
    acts.classList.toggle("two", !actBtns[1]?.hidden);

    // HOLD and WRIGGLE.
    let bigText = "";
    if (me.role === "guard" && !me.hold && (me.canHold || me.offers?.some((o) => o?.a === "hold"))) bigText = w.buttons.hold;
    if (me.role === "thief" && (me.frozen || me.offers?.some((o) => o?.a === "wriggle"))) bigText = w.buttons.wriggle;
    big.hidden = !bigText;
    if (bigText) setText(bigLbl, bigText);
    big.classList.toggle("cool", me.role === "guard" && me.cooldown > 0);
    big.classList.toggle("wriggle", me.role === "thief");

    // A hold going on: everyone's banner.
    const hold = model.pub?.holds?.[0];
    if (hold && fin(hold.until) && fin(hold.total)) {
      const l = Math.max(0, hold.until - model.time(now));
      const txt = hold.thief === ctx.myId ? t.heldBy(ctx.nameOf(hold.guard)) : hold.guard === ctx.myId ? t.holding(ctx.nameOf(hold.thief)) : t.held(ctx.nameOf(hold.thief));
      banner.hidden = false;
      setText(/** @type {HTMLElement} */ (banner.querySelector(".txt")), `${w.ui.held} · ${txt} · ${clock(l)}`);
      /** @type {HTMLElement} */ (banner.querySelector(".bar > i")).style.transform = `scaleX(${clamp(l / Math.max(0.1, hold.total), 0, 1).toFixed(3)})`;
    } else banner.hidden = true;
  }

  /** A catalogue item's name. @param {number} k */
  function itemLabel(k) {
    const it = itemById(ctx.catalogue()[k]?.id ?? "");
    return it ? it.name[lang] : "";
  }

  /** @param {string} kind */
  function busyLabel(kind) {
    const b = w.buttons;
    switch (kind) {
      case "door":
        return b.open;
      case "pick":
        return b.pickLock;
      case "climb":
        return b.climb;
      case "take":
        return b.take;
      case "tamper":
        return b.tamper;
      case "smash":
        return b.smashLamp;
      case "strip":
        return b.stripTags;
      default:
        return "…";
    }
  }

  // ---------------------------------------------------------------- drawing

  /** @param {number} now */
  function figures(now) {
    const me = model.me;
    /** @type {Figure[]} */
    const list = [];
    for (const o of model.others(now)) {
      list.push({
        id: o.id, role: o.role, x: o.x, y: o.y, facing: o.facing, moving: o.moving, walk: o.walk, light: o.role === "guard" && o.light,
        held: o.held, sack: o.sack ?? 0, name: ctx.nameOf(o.id), cuffed: o.role === "thief" && !!model.pub?.arrest,
      });
    }
    if (me) {
      const used = me.role === "thief" ? THIEF_SLOTS - (fin(me.free) ? me.free : THIEF_SLOTS) : 0;
      list.push({
        role, x: model.at.x, y: model.at.y, facing: model.at.angle, moving: model.moving || (!model.path && !!me.moving), walk: model.walked,
        light: me.role === "guard" && me.light === "on", sack: used, held: me.frozen, self: true, colour: role === "guard" ? ctx.colorOf(ctx.myId) : undefined,
        cuffed: me.role === "thief" && !!model.pub?.arrest,
      });
    }
    return list;
  }

  /** What drawWorld draws. @param {number} now @returns {import("./draw.js").Scene} */
  function scene(now) {
    const f = model.frame;
    return {
      seen: model.seen, light: model.light, memory: model.mem, now: model.time(now), lamps: model.pub?.lamps?.length ? model.pub.lamps : null,
      items: f?.items ?? [], empty: f?.empty ?? [], catalogue: ctx.catalogue(), figures: figures(now), colors: ctx.colors(), names: ctx.names(),
    };
  }

  /** The public layer; with the layer off only what one must never miss (holds, noises, the arrest). @returns {import("./draw.js").PublicLike | null} */
  function publicLayer() {
    const p = model.pub;
    if (!p || layerOn) return p;
    return { t: p.t, holds: p.holds, noises: p.noises, arrest: p.arrest };
  }

  /** One's own marks on top: the goal, the busy ring, the throw's reach, the aim, the arrow. @param {CanvasRenderingContext2D} c @param {import("./draw.js").View} v @param {number} now */
  function overlay(c, v, now) {
    useTiles(c, v);
    const px = 1 / v.scale;
    const me = model.me;
    const b = model.at;
    // Where one walks to.
    const g = model.path ? model.goal : null;
    if (g) {
      c.strokeStyle = "rgba(243,210,122,0.9)";
      c.lineWidth = 2.5 * px;
      const s = 0.22;
      c.beginPath();
      c.moveTo(g.x - s, g.y - s);
      c.lineTo(g.x + s, g.y + s);
      c.moveTo(g.x + s, g.y - s);
      c.lineTo(g.x - s, g.y + s);
      c.stroke();
    }
    // The tap itself: a ripple.
    const ta = (now - tapMark.at) / 450;
    if (ta >= 0 && ta < 1) {
      c.strokeStyle = `rgba(243,210,122,${(1 - ta) * 0.8})`;
      c.lineWidth = 2 * px;
      c.beginPath();
      c.arc(tapMark.x, tapMark.y, 0.15 + ta * 0.5, 0, Math.PI * 2);
      c.stroke();
    }
    // Busy: a ring round oneself.
    if (me?.busy && fin(me.busy.total) && me.busy.total > 0) {
      const l = Math.max(0, me.busy.left - (now - model.frameAt) / 1000);
      const f = clamp(1 - l / me.busy.total, 0, 1);
      c.lineWidth = 5 * px;
      c.strokeStyle = "rgba(13,12,14,0.55)";
      c.beginPath();
      c.arc(b.x, b.y, 0.75, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = PALETTE.goldLight;
      c.beginPath();
      c.arc(b.x, b.y, 0.75, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
      c.stroke();
    }
    // The firecracker's reach.
    if (armed) {
      c.setLineDash([6 * px, 6 * px]);
      c.strokeStyle = "rgba(255,179,71,0.85)";
      c.lineWidth = 2 * px;
      c.beginPath();
      c.arc(b.x, b.y, TIMES.throwRange, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = "rgba(255,179,71,0.07)";
      c.fill();
    }
    // Aiming: the line the finger draws.
    if (mode === "aim") {
      const a = (model.aim * Math.PI) / 180;
      c.strokeStyle = "rgba(255,243,184,0.8)";
      c.lineWidth = 2 * px;
      c.setLineDash([4 * px, 5 * px]);
      c.beginPath();
      c.moveTo(b.x, b.y);
      c.lineTo(b.x + Math.cos(a) * 7, b.y + Math.sin(a) * 7);
      c.stroke();
      c.setLineDash([]);
    }
    // The Seen mark's arrow.
    if (mode === "arrow") {
      const from = { x: arrow.tx, y: arrow.ty };
      const to = arrow.down ? toTile(v, arrow.ex, arrow.ey) : from;
      const colour = ctx.colorOf(ctx.myId);
      c.fillStyle = colour;
      c.beginPath();
      c.arc(from.x, from.y, 0.25, 0, Math.PI * 2);
      c.fill();
      const d = Math.hypot(to.x - from.x, to.y - from.y);
      if (d > 0.3) {
        const ux = (to.x - from.x) / d;
        const uy = (to.y - from.y) / d;
        c.strokeStyle = colour;
        c.lineWidth = 5 * px;
        c.beginPath();
        c.moveTo(from.x, from.y);
        c.lineTo(to.x, to.y);
        c.moveTo(to.x - ux * 0.6 - uy * 0.4, to.y - uy * 0.6 + ux * 0.4);
        c.lineTo(to.x, to.y);
        c.lineTo(to.x - ux * 0.6 + uy * 0.4, to.y - uy * 0.6 - ux * 0.4);
        c.stroke();
      }
    }
    // The thief's car: its spot outlined, and an arrow at the edge while it is off screen.
    const spot = me?.role === "thief" ? map.spots[me.car] : undefined;
    if (spot) {
      const r = spot.rect;
      const pulse = 0.6 + 0.4 * Math.sin(now / 300);
      c.setLineDash([8 * px, 6 * px]);
      c.strokeStyle = `rgba(243,210,122,${pulse})`;
      c.lineWidth = 3 * px;
      c.strokeRect(r.x - 0.3, r.y - 0.3, r.w + 0.6, r.h + 0.6);
      c.setLineDash([]);
      c.font = `700 ${12 * px}px ${FONTS.sans}`;
      c.textAlign = "center";
      c.textBaseline = "bottom";
      c.fillStyle = PALETTE.goldLight;
      c.strokeStyle = PALETTE.black;
      c.lineWidth = 3 * px;
      const label = t.carHere.toLocaleUpperCase(lang);
      c.strokeText(label, r.x + r.w / 2, r.y - 0.4);
      c.fillText(label, r.x + r.w / 2, r.y - 0.4);
      const s = toScreen(v, r.x + r.w / 2, r.y + r.h / 2);
      const m = 26;
      const top0 = size.top + m;
      const bot0 = size.h - size.bottom - m;
      if (s.x < m || s.x > v.width - m || s.y < top0 || s.y > bot0) {
        const me0 = toScreen(v, b.x, b.y);
        const dx = s.x - me0.x;
        const dy = s.y - me0.y;
        // Where the line from oneself to the car leaves the free area.
        let k = 1;
        if (dx > 0) k = Math.min(k, (v.width - m - me0.x) / dx);
        if (dx < 0) k = Math.min(k, (m - me0.x) / dx);
        if (dy > 0) k = Math.min(k, (bot0 - me0.y) / dy);
        if (dy < 0) k = Math.min(k, (top0 - me0.y) / dy);
        const ax = me0.x + dx * k;
        const ay = me0.y + dy * k;
        const a = Math.atan2(dy, dx);
        c.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
        c.translate(ax, ay);
        c.rotate(a);
        c.beginPath();
        c.moveTo(14, 0);
        c.lineTo(-8, -10);
        c.lineTo(-3, 0);
        c.lineTo(-8, 10);
        c.closePath();
        c.fillStyle = PALETTE.goldLight;
        c.strokeStyle = PALETTE.black;
        c.lineWidth = 2.5;
        c.stroke();
        c.fill();
        c.rotate(-a);
        c.font = `700 10px ${FONTS.sans}`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.lineWidth = 3;
        const ly = ay > size.h / 2 ? -18 : 18;
        const lx = clamp(0, 40 - ax, v.width - 40 - ax);
        c.strokeText("P", lx, ly);
        c.fillText("P", lx, ly);
        useTiles(c, v);
      }
    }
    // The marks menu's place.
    if (!radial.hidden) {
      c.strokeStyle = ctx.colorOf(ctx.myId);
      c.lineWidth = 3 * px;
      c.beginPath();
      c.arc(menu.tx, menu.ty, 0.35, 0, Math.PI * 2);
      c.stroke();
    }
  }

  // ---------------------------------------------------------------- the loop

  let raf = 0;
  let last = performance.now();
  let size = { w: 0, h: 0, top: 0, bottom: 0 };
  const measure = () => {
    const r = el.getBoundingClientRect();
    size = { w: Math.round(r.width), h: Math.round(r.height), top: top.getBoundingClientRect().bottom - r.top, bottom: r.bottom - bottom.getBoundingClientRect().top };
  };
  const ro = new ResizeObserver(measure);
  ro.observe(el);
  /** @param {number} now */
  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(250, now - last);
    last = now;
    try {
      model.tick(now, dt);
      hud(now);
      if (!size.w) measure();
      if (!art || !size.w || !size.h || !model.placed) return;
      const c = fitCanvas(canvas, size.w, size.h, dpr);
      // The figure in the middle of what the bars leave free.
      const mid = (size.top + size.h - size.bottom) / 2;
      const scale = size.w / across;
      const at = model.at;
      view = followView(at.x, at.y - (mid - size.h / 2) / scale, across, size.w, size.h, dpr);
      model.view = view;
      drawWorld(c, art, view, scene(now), { budget: 4 });
      drawPublic(c, art, view, publicLayer(), { lights: false, quiet: true, seen: model.seen, colors: ctx.colors(), names: ctx.names(), words: mapWords, now: model.time(now) });
      overlay(c, view, now);
      placePop(now);
      heartbeat(now);
    } catch (e) {
      console.warn("pinch: frame", e);
    }
  }
  raf = requestAnimationFrame(loop);

  /** The thief's heart: a beat when a seen guard is within 4 tiles, faster the nearer. @param {number} now */
  function heartbeat(now) {
    if (role !== "thief" || !model.me) return;
    let d = Infinity;
    for (const o of model.others(now)) if (o.role === "guard") d = Math.min(d, Math.hypot(o.x - model.at.x, o.y - model.at.y));
    if (d > 4) return;
    const every = 420 + d * 160;
    if (now - lastBeat < every) return;
    lastBeat = now;
    ctx.buzz([45, 110, 35]);
  }

  return {
    el,
    model,
    destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(longTimer);
      clearTimeout(toastTimer);
      clearTimeout(tickerTimer);
      ro.disconnect();
      offMsg();
    },
  };
}

/** The order of the action buttons: loot and the thief's work before doors and lights. */
const OFFER_ORDER = ["take", "strip", "pick", "tamper", "smash", "climb", "door", "switch"];
/** @param {{ a: string }} o */
function offerRank(o) {
  const k = OFFER_ORDER.indexOf(o.a);
  return k < 0 ? OFFER_ORDER.length : k;
}

/** Sets text only when it changed (no layout work at 60 fps otherwise). @param {HTMLElement} el @param {string} text */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
