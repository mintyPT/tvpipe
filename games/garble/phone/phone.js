// @ts-check
/**
 * Garble's phone page: joining, the lobby, the round's secret card, the
 * drawing pad (black ink; undo only when the room allows it), guessing
 * (with the round's twist), passing on, reactions during the reveal,
 * judging your own chain, accusing the Wrecker, scores. Everything it
 * shows comes from the party's view (`{ roster, room, me }`); everything
 * it does is an action. The secret word is shown only while a finger
 * holds it, and looks the same on every phone until then.
 */

import { PartyClient } from "/_tvpipe/lib/client.js";
import { browserLang, num, pickLang } from "./i18n.js";
import { drawInk, fit, GRID, Live, replay, replayTime } from "./ink.js";
import { strings } from "./strings.js";

const WIDTHS = [7, 16, 38];
const DOTS = [7, 13, 22];
const MAX_STROKES = 400;
const MAX_POINTS = 16000;
const MAX_GUESS = 40;

// A controller, not a document: no pinch or double-tap zoom, no selection.
for (const type of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener("touchmove", (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
document.addEventListener("selectstart", (e) => {
  const t = e.target instanceof Element ? e.target : /** @type {Node} */ (e.target).parentElement;
  if (!t?.closest("input")) e.preventDefault();
});

// The visible height (the keyboard takes the rest): full-screen layouts fit it.
function appHeight() {
  const hgt = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-h", `${Math.round(hgt)}px`);
  if (document.body.classList.contains("full")) window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener("resize", appHeight);
window.addEventListener("resize", appHeight);
appHeight();

const client = PartyClient.fromLocation();
const app = /** @type {HTMLElement} */ (document.getElementById("app"));
const banner = /** @type {HTMLElement} */ (document.getElementById("banner"));
const who = /** @type {HTMLElement} */ (document.getElementById("who"));
const langButton = /** @type {HTMLButtonElement} */ (document.getElementById("lang"));
const headerPeek = /** @type {HTMLButtonElement} */ (document.getElementById("peek"));
const peeked = /** @type {HTMLElement} */ (document.getElementById("peeked"));

// ---------------------------------------------------------------------------
// The language: the phone's own choice, else the room's, else the browser's.

const LANG_KEY = "garble:lang";
function ownLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v ? pickLang(v) : null;
  } catch {
    return null;
  }
}
function roomLang() {
  const l = client.view?.room?.lang;
  return typeof l === "string" ? pickLang(l) : browserLang();
}
let lang = ownLang() ?? roomLang();
let t = strings(lang);
document.documentElement.lang = lang;
function useLang() {
  const l = ownLang() ?? roomLang();
  if (l === lang) return false;
  lang = l;
  t = strings(l);
  document.documentElement.lang = l;
  return true;
}
langButton.addEventListener("click", () => {
  const next = lang === "de" ? "en" : "de";
  try {
    if (next === roomLang()) localStorage.removeItem(LANG_KEY);
    else localStorage.setItem(LANG_KEY, next);
  } catch {}
  if (!useLang()) return;
  if (shown === "join") joinForm("", /** @type {HTMLInputElement | null} */ (document.getElementById("name"))?.value);
  else if (client.view?.me) {
    shown = "";
    render(client.view);
  }
});

let shown = "";
/** @type {(() => void) | null} called on every view while the screen stays */
let refresh = null;
/** @type {(() => void) | null} sends what there is when time is up */
let autoSubmit = null;
/** @type {(() => void)[]} cleanups of the screen on show */
let cleanups = [];

// ---------------------------------------------------------------------------
// DOM helpers: text always as text.

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} kids
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, String(x));
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
/** @param {...(Node | null)} nodes */
function show(...nodes) {
  app.replaceChildren(...nodes.filter((n) => n !== null));
}
/** @param {string | null} text */
function setBanner(text) {
  banner.hidden = !text;
  banner.textContent = text ?? "";
}
const SVG_NS = "http://www.w3.org/2000/svg";
/** @param {string} d */
function icon(d) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const part of d.split("|")) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", part);
    svg.append(p);
  }
  return svg;
}
const TRASH = "M4 7h16|M9 7V4h6v3|M6 7l1 13h10l1-13";
const UNDO = "M9 14L4 9l5-5|M4 9h10a6 6 0 0 1 0 12h-3";
const EYE = "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z|M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z";
const PENCIL = "M4 20l1-5L16 4l4 4L9 19z|M14 6l4 4";

/** A player's colour from the room (`colors` by id). */
function colorOf(/** @type {string | undefined} */ id) {
  const c = id ? client.view?.room?.colors?.[id] : undefined;
  return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : "#7c8696";
}
/** @param {{ id?: string, name?: string, color?: string } | null | undefined} p */
function avatar(p) {
  const c = typeof p?.color === "string" ? p.color : colorOf(p?.id);
  return h("span", { class: "avatar", style: { "--c": c } }, [...(p?.name ?? "?")][0]?.toUpperCase() ?? "?");
}

// ---------------------------------------------------------------------------
// The secret word: held to read.

/** @param {any} me */
function peekContent(me) {
  const out = [h("div", { class: "lbl" }, t.secretWord), h("div", { class: "word" }, me.word ?? "")];
  if (me.wrecker) out.push(h("div", { class: "role" }, t.youWrecker));
  return out;
}
/**
 * Makes an element show the secret while pressed.
 * @param {HTMLElement} el
 * @param {(on: boolean) => void} [onChange]
 */
function holdable(el, onChange) {
  let on = false;
  const set = (/** @type {boolean} */ v) => {
    if (on === v) return;
    on = v;
    onChange?.(v);
  };
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    set(true);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(type, () => set(false));
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}
/** A slip that shows the secret word while held. */
function peekButton(compact = false) {
  const b = h("button", { class: "peek", type: "button", "aria-label": t.myWord }, icon(EYE), compact ? t.holdShort : t.myWord);
  holdable(b, (on) => {
    b.classList.toggle("on", on);
    peeked.hidden = !on;
    if (on) peeked.replaceChildren(...peekContent(client.view?.me ?? {}));
  });
  return b;
}
headerPeek.replaceWith(peekButton());
const peekSlot = /** @type {HTMLElement} */ (document.querySelector("#bar .peek"));

// ---------------------------------------------------------------------------
// Joining

/** @param {string} [error] @param {string} [typed] */
function joinForm(error = "", typed) {
  shown = "join";
  refresh = null;
  langButton.hidden = false;
  langButton.textContent = t.otherLang;
  const input = /** @type {HTMLInputElement} */ (h("input", { id: "name", maxlength: 16, autocapitalize: "words", enterkeyhint: "go", autocomplete: "off", required: true }));
  const err = h("p", { class: "error" }, error);
  input.value = typed ?? client.saved?.name ?? localStorage.getItem("garble:name") ?? "";
  const form = h(
    "form",
    {
      autocomplete: "off",
      onsubmit: async (/** @type {Event} */ e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        try {
          localStorage.setItem("garble:name", name);
        } catch {}
        err.textContent = "";
        try {
          await client.join(name);
        } catch (x) {
          joinForm(message(x), name);
        }
      },
    },
    h("label", { for: "name" }, t.yourName),
    input,
    h("button", { class: "btn", type: "submit" }, t.join),
    err,
  );
  show(logo(), h("section", { class: "card tilt" }, h("h1", {}, t.joinTitle), form));
  if (!input.value) input.focus();
}

function logo() {
  return h("div", { class: "logo" }, ...[..."Garble"].map((c, i) => h("span", { class: i === 3 ? "red" : "", style: { "--r": `${[-4, 3, -2, 4, -3, 2][i]}deg` } }, c)));
}

/** @param {any} e */
function message(e) {
  switch (e?.code) {
    case "name-taken":
      return t.nameTaken;
    case "name-invalid":
      return t.pickAnother;
    case "full":
      return t.full;
    case "locked":
    case "in-progress":
      return t.closed;
    case "bad-key":
      return t.badKey;
    case "no-room":
      return t.noRoom;
    default:
      return (typeof e?.code === "string" ? t.errors[e.code] : undefined) ?? e?.message ?? String(e);
  }
}

client.on("status", (s) => {
  if (s === "reconnecting") setBanner(t.reconnecting);
  else if (s === "open") setBanner(null);
});
client.on("bye", (reason) => {
  const text = reason === "kicked" ? t.kicked : reason === "replaced" ? t.replaced : reason === "room-closed" ? t.roomClosed : null;
  if (!text) return;
  shown = "bye";
  refresh = null;
  document.body.classList.remove("full");
  setBanner(null);
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, text)));
});
client.on("view", (view) => render(view));

// ---------------------------------------------------------------------------
// Views

/** @param {any} me @param {any} room */
function keyOf(me, room) {
  const d = me.done ? 1 : 0;
  switch (me.task) {
    case "draw":
    case "guess":
      return `${me.task}:${room.round}:${me.step}:${d}`;
    case "judge":
      return `judge:${room.round}:${me.chain?.id}:${d}`;
    case "watch":
      return `watch:${room.round}:${me.index}`;
    case "accuse":
      return `accuse:${room.round}:${d}`;
    default:
      return `${me.task}:${room.round ?? ""}`;
  }
}

/** @param {Record<string, any>} view */
function render(view) {
  const me = view.me ?? {};
  const room = view.room ?? {};
  const mine = (view.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id);
  if (useLang()) shown = "";
  const scoreText = typeof me.score === "number" && me.task !== "lobby" && me.of > 0 ? ` · ${num(lang, me.score)}` : "";
  who.replaceChildren(...(mine ? [h("span", { class: "dot", style: { "--c": colorOf(mine.id) } }), h("b", {}, `${mine.vip ? "★ " : ""}${mine.name}`), scoreText] : []));
  peekSlot.hidden = !me.word;
  const key = keyOf(me, room);
  if (key !== shown) {
    shown = key;
    refresh = null;
    autoSubmit = null;
    for (const c of cleanups) c();
    cleanups = [];
    peeked.hidden = true;
    langButton.hidden = !(me.task === "lobby" || me.task === "final");
    langButton.textContent = t.otherLang;
    document.body.classList.toggle("full", (me.task === "draw" || me.task === "guess") && !me.done);
    appHeight();
    build(view);
  }
  refresh?.();
}

/** @param {Record<string, any>} view */
function build(view) {
  const me = view.me ?? {};
  switch (me.task) {
    case "lobby":
      return lobby();
    case "wait":
      return show(h("section", { class: "card" }, h("p", { class: "big" }, me.note === "game" ? t.waitGame : t.waitRound)));
    case "secret":
      return secret(me, view.room ?? {});
    case "draw":
      return me.done ? passed(me, "draw") : draw(me);
    case "guess":
      return me.done ? passed(me, "guess") : guess(me);
    case "watch":
      return watch(me);
    case "judge":
      return me.done ? show(h("section", { class: "card" }, h("p", { class: "big" }, t.verdictSent))) : judge(me);
    case "accuse":
      return accuse(me);
    case "unmask":
      return unmask(me);
    case "scores":
      return scoreCard(me, view.room ?? {});
    case "final":
      return final();
    default:
      return show(h("section", { class: "card" }, h("p", { class: "big" }, t.lookTv)));
  }
}

/** @param {string} type @param {any} data @param {HTMLElement} [err] */
async function act(type, data, err) {
  if (err) err.textContent = "";
  try {
    return await client.act(type, data);
  } catch (e) {
    if (err) err.textContent = message(e);
    throw e;
  }
}

const isVip = () => !!(client.view?.roster ?? []).find((/** @type {any} */ r) => r.id === client.you?.id)?.vip;

// ---------------------------------------------------------------------------
// Lobby and final: players, the VIP's settings, start.

/** @param {HTMLElement} err */
function settings(err) {
  /** @type {{ key: string, row: HTMLElement, buttons: HTMLButtonElement[], values: any[], line: HTMLElement | null }[]} */
  const items = [];
  const box = h("div", {});
  const add = (/** @type {string} */ key, /** @type {any[]} */ values, /** @type {string[]} */ labels, /** @type {string | null} */ title, /** @type {boolean} */ withLine) => {
    const buttons = values.map((v, i) => /** @type {HTMLButtonElement} */ (h("button", { type: "button", onclick: () => act("settings", { [key]: v }, err).catch(() => {}) }, labels[i])));
    const row = h("div", { class: "seg" }, ...buttons);
    const line = withLine ? h("p", { class: "line" }) : null;
    box.append(h("div", { class: "setting" }, title ? h("label", {}, title) : null, row, line));
    items.push({ key, row, buttons, values, line });
  };
  add("undo", [false, true], [t.off, t.on], t.undoLabel, true);
  add("twists", [false, true], [t.off, t.on], t.twistsLabel, true);
  add("length", [4, 6, 8], ["4", "6", "8"], t.chainLength, false);
  const update = () => {
    const room = client.view?.room ?? {};
    box.hidden = !isVip();
    for (const it of items) {
      const cur = room[it.key];
      it.buttons.forEach((b, i) => b.classList.toggle("on", it.values[i] === cur));
      if (it.key === "undo" && it.line) it.line.textContent = t.undo[cur ? 1 : 0];
      if (it.key === "twists" && it.line) it.line.textContent = t.twists[cur ? 1 : 0];
    }
  };
  return { box, update };
}

function lobby() {
  const err = h("p", { class: "error" });
  const list = h("div", { class: "chips" });
  const hint = h("p", { class: "muted small" });
  const start = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.start));
  const set = settings(err);
  const rulesLine = h("p", { class: "small muted" });
  show(
    h("section", { class: "card tilt lobby" }, h("h1", {}, t.youreIn), h("h2", {}, t.players), list, start, err, hint, h("h2", {}, t.rules), rulesLine, set.box),
    h("section", { class: "card dark" }, h("h2", { style: { "margin-top": "0" } }, t.howTitle), h("ol", { class: "how" }, ...t.how.map((x) => h("li", {}, x)))),
  );
  refresh = () => {
    const v = client.view;
    const roster = v.roster ?? [];
    const vip = isVip();
    const min = v.room?.minPlayers ?? 4;
    const ready = roster.filter((/** @type {any} */ r) => r.connected).length;
    list.replaceChildren(
      ...roster.map((/** @type {any} */ r) =>
        h(
          "span",
          { class: `chip${r.connected ? "" : " away"}` },
          h("span", { class: "dot", style: { "--c": colorOf(r.id) } }),
          r.name,
          r.vip ? h("small", {}, t.vip) : null,
          vip && r.id !== client.you?.id ? h("button", { type: "button", onclick: () => act("kick", { id: r.id }, err).catch(() => {}) }, "✕") : null,
        ),
      ),
    );
    start.hidden = !vip;
    start.disabled = ready < min;
    hint.textContent = vip ? (ready < min ? t.vipWait(min - ready) : t.vipReady) : t.waitVip;
    const room = v.room ?? {};
    rulesLine.textContent = `${t.length(room.length ?? 6)} · ${t.undo[room.undo ? 1 : 0]} · ${t.twists[room.twists ? 1 : 0]}`;
    rulesLine.hidden = vip;
    set.update();
  };
}

function final() {
  const me = client.view?.me ?? {};
  const err = h("p", { class: "error" });
  const again = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "start", onclick: () => act("start", null, err).catch(() => {}) }, t.playAgain));
  const set = settings(err);
  show(
    h(
      "section",
      { class: "card tilt" },
      h("h1", {}, me.rank === 1 ? t.won : t.gameOver),
      h("p", { class: "score" }, num(lang, me.score ?? 0), h("small", {}, t.points)),
      h("p", { class: "typed" }, me.of ? t.rank(me.rank ?? 0, me.of) : ""),
      again,
      err,
      set.box,
    ),
  );
  refresh = () => {
    again.hidden = !isVip();
    set.update();
  };
}

// ---------------------------------------------------------------------------
// The round's secret: one card, the same on every phone until held.

/** @param {any} me @param {any} room */
function secret(me, room) {
  const env = h(
    "div",
    { class: "envelope" },
    h("div", { class: "face outside" }, h("span", { class: "stampish" }, "top secret"), h("span", { class: "hold" }, t.hold)),
    h(
      "div",
      { class: "face inside" },
      h("span", { class: "lbl" }, t.secretWord),
      h("span", { class: "word" }, me.word ?? ""),
      h("p", {}, t.smuggle),
      h("span", { class: `role${me.wrecker ? " wreck" : ""}` }, me.wrecker ? t.youWrecker : ""),
      h("p", {}, me.wrecker ? t.wreckerJob : t.notWrecker),
    ),
  );
  holdable(env, (on) => env.classList.toggle("open", on));
  const tw = t.twist[/** @type {"clear" | "glimpse" | "peephole"} */ (me.twist)] ?? "";
  show(h("section", { class: "secret" }, h("div", { class: "title" }, t.roundN(room.round ?? 1)), env, tw ? h("p", { class: "twistline" }, tw) : null));
}

// ---------------------------------------------------------------------------
// The clock

/**
 * A time bar and the seconds, ticking until the deadline.
 * @param {number} deadline
 */
function clock(deadline) {
  const bar = h("div", { class: "timebar" }, h("i"));
  const secs = h("span", { class: "secs" });
  const total = Math.max(1000, deadline - client.now());
  const fill = /** @type {HTMLElement} */ (bar.firstChild);
  const tick = () => {
    const ms = deadline - client.now();
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, ms / total))})`;
    secs.textContent = String(Math.max(0, Math.ceil(ms / 1000)));
    const low = ms < 10_000;
    bar.classList.toggle("low", low);
    secs.classList.toggle("low", low && ms > 0);
    if (ms < 900) autoSubmit?.();
  };
  tick();
  const timer = setInterval(tick, 200);
  cleanups.push(() => clearInterval(timer));
  return { bar, secs };
}

// ---------------------------------------------------------------------------
// Drawing: black ink, three pens, undo only when the room allows it.

class Pad {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    /** @type {number[][]} */
    this.strokes = [];
    this.points = 0;
    this.width = WIDTHS[1];
    /** @type {Live | null} */
    this.live = null;
    this.locked = false;
    this.onchange = () => {};
    const f = fit(canvas);
    this.ctx = f.ctx;
    this.size = f.size;
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    cleanups.push(() => ro.disconnect());
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", () => this.up());
    canvas.addEventListener("pointercancel", () => this.up());
    for (const type of ["touchstart", "touchmove", "touchend"]) canvas.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    this.redraw();
  }
  resize() {
    const f = fit(this.canvas);
    this.ctx = f.ctx;
    this.size = f.size;
    this.redraw();
  }
  redraw() {
    drawInk(this.ctx, { strokes: this.strokes }, 0, 0, this.size);
  }
  /** @param {PointerEvent} e */
  at(e) {
    const r = this.canvas.getBoundingClientRect();
    const k = GRID / r.width;
    return [Math.round(Math.min(GRID, Math.max(0, (e.clientX - r.left) * k))), Math.round(Math.min(GRID, Math.max(0, (e.clientY - r.top) * k)))];
  }
  /** @param {PointerEvent} e */
  down(e) {
    if (this.locked || this.live || this.strokes.length >= MAX_STROKES || this.points >= MAX_POINTS) return;
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {}
    const [x, y] = this.at(e);
    const s = [this.width, x, y];
    this.strokes.push(s);
    this.points++;
    this.live = new Live(this.ctx, s, this.size / GRID);
    this.onchange();
  }
  /** @param {PointerEvent} e */
  move(e) {
    const live = this.live;
    if (!live) return;
    e.preventDefault();
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      if (this.points >= MAX_POINTS) return this.up();
      const [x, y] = this.at(ev);
      const s = live.s;
      if (Math.hypot(x - s[s.length - 2], y - s[s.length - 1]) < 4) continue;
      s.push(x, y);
      this.points++;
      live.add();
    }
  }
  up() {
    this.live?.end();
    this.live = null;
  }
  clear() {
    this.strokes = [];
    this.points = 0;
    this.redraw();
    this.onchange();
  }
  undo() {
    if (this.live) return;
    const s = this.strokes.pop();
    if (!s) return;
    this.points -= (s.length - 1) / 2;
    this.redraw();
    this.onchange();
  }
}

/** @param {any} me */
function draw(me) {
  const { bar, secs } = clock(me.deadline ?? 0);
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "pad" }));
  const err = h("p", { class: "error" });
  const textEl = h("span", { class: `text${me.choices ? " prompt" : ""}` }, me.text ?? "");
  const labelEl = h("span", { class: "label" }, me.choices ? t.draw : me.from ? `${t.draw} · ${t.fromName(me.from)}` : t.draw);
  const paper = h("div", { class: "paperbox" }, canvas);
  const done = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", id: "done", type: "button" }, t.done));
  const sizes = h("div", { class: "sizes" });
  const tools = h("div", { class: "tools" }, sizes);
  show(h("section", { class: "full-grid" }, bar, h("div", { class: "top" }, h("div", { class: "what" }, labelEl, textEl), peekButton(true), secs), h("div", { class: "padbox" }, paper), tools), err);
  const pad = new Pad(canvas);
  const widthButtons = WIDTHS.map((w, i) =>
    h("button", { type: "button", "aria-label": t.sizes[i], onclick: () => pickWidth(i) }, h("i", { style: { width: `${DOTS[i]}px`, height: `${DOTS[i]}px` } })),
  );
  sizes.append(...widthButtons);
  const pickWidth = (/** @type {number} */ i) => {
    pad.width = WIDTHS[i];
    widthButtons.forEach((b, j) => b.classList.toggle("on", i === j));
  };
  pickWidth(1);
  if (me.undo) {
    const undo = /** @type {HTMLButtonElement} */ (h("button", { class: "tool", type: "button", "aria-label": t.undoBtn, onclick: () => pad.undo() }, icon(UNDO)));
    const clear = /** @type {HTMLButtonElement} */ (h("button", { class: "tool", type: "button", "aria-label": t.clear }, icon(TRASH)));
    // Clear asks once.
    /** @type {ReturnType<typeof setTimeout> | 0} */
    let armed = 0;
    const disarm = () => {
      if (armed) clearTimeout(armed);
      armed = 0;
      clear.classList.remove("arm");
      clear.replaceChildren(icon(TRASH));
    };
    clear.addEventListener("click", () => {
      if (armed) {
        disarm();
        pad.clear();
        return;
      }
      clear.classList.add("arm");
      clear.textContent = t.clearSure;
      armed = setTimeout(disarm, 2200);
    });
    tools.append(undo, clear);
    const changed = () => {
      undo.disabled = clear.disabled = pad.strokes.length === 0;
    };
    pad.onchange = changed;
    changed();
  }
  tools.append(done);
  // The first step: pick one of two prompts, then draw.
  /** @type {number | undefined} */
  let choice;
  if (Array.isArray(me.choices)) {
    pad.locked = true;
    done.disabled = true;
    const box = h(
      "div",
      { class: "choices" },
      h("div", { class: "h" }, t.pick),
      ...me.choices.map((/** @type {string} */ c, /** @type {number} */ i) =>
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              choice = i;
              textEl.textContent = c;
              box.remove();
              pad.locked = false;
              done.disabled = false;
            },
          },
          c,
        ),
      ),
    );
    paper.append(box);
  }
  let sent = false;
  const submit = async () => {
    if (sent) return;
    sent = true;
    done.disabled = true;
    pad.up();
    try {
      await act("draw", { strokes: pad.strokes, ...(me.choices ? { choice: choice ?? 0 } : {}) }, err);
    } catch {
      sent = false;
      done.disabled = false;
    }
  };
  done.addEventListener("click", () => void submit());
  autoSubmit = () => void submit();
}

// ---------------------------------------------------------------------------
// Guessing, with the round's twist.

/** @param {any} me */
function guess(me) {
  const { bar, secs } = clock(me.deadline ?? 0);
  const canvas = /** @type {HTMLCanvasElement} */ (h("canvas", { class: "view" }));
  const overlay = h("div", { class: "overlay" });
  const paper = h("div", { class: "paperbox" }, canvas, overlay);
  const input = /** @type {HTMLInputElement} */ (
    h("input", { maxlength: MAX_GUESS, placeholder: t.guessPlaceholder, enterkeyhint: "send", autocapitalize: "none", autocomplete: "off", spellcheck: "true", lang })
  );
  const err = h("p", { class: "error" });
  const send = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", type: "submit" }, t.send));
  const form = h("form", { class: "guess-form", autocomplete: "off" }, input, send);
  const twistName = t.twistName[/** @type {"clear" | "glimpse" | "peephole"} */ (me.twist ?? "clear")] ?? "";
  show(
    h(
      "section",
      { class: "full-grid guessing" },
      bar,
      h(
        "div",
        { class: "top" },
        h("div", { class: "what" }, h("span", { class: "label" }, me.from ? t.drawnBy(me.from) : "", twistName ? h("b", { class: "twist" }, twistName) : null), h("span", { class: "text" }, t.whatIsIt)),
        peekButton(true),
        secs,
      ),
      h("div", { class: "padbox" }, paper),
      h("div", {}, form, err),
    ),
  );
  const drawing = me.drawing ?? { strokes: [] };
  const twist = me.twist ?? "clear";
  const signal = { aborted: false };
  cleanups.push(() => (signal.aborted = true));
  let size = 0;
  /** @type {CanvasRenderingContext2D} */
  let ctx;
  /** 'replay' while drawing itself, then 'shown', 'gone' (glimpse) or 'peep' */
  let mode = "replay";
  /** @type {[number, number] | null} the peephole, grid units */
  let hole = null;
  const sizeUp = () => {
    const f = fit(canvas);
    ctx = f.ctx;
    size = f.size;
  };
  const paint = () => {
    if (mode === "shown") drawInk(ctx, drawing, 0, 0, size);
    else if (mode === "peep") {
      ctx.fillStyle = "#3a3f4b";
      ctx.fillRect(0, 0, size, size);
      if (hole) {
        const k = size / GRID;
        ctx.save();
        ctx.beginPath();
        ctx.arc(hole[0] * k, hole[1] * k, size * 0.2, 0, Math.PI * 2);
        ctx.clip();
        drawInk(ctx, drawing, 0, 0, size);
        ctx.restore();
        ctx.strokeStyle = "rgba(255,225,74,.9)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(hole[0] * k, hole[1] * k, size * 0.2, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (mode === "gone") {
      ctx.fillStyle = "#fbf8f1";
      ctx.fillRect(0, 0, size, size);
    }
  };
  sizeUp();
  const ro = new ResizeObserver(() => {
    sizeUp();
    if (mode !== "replay") paint();
  });
  ro.observe(canvas);
  cleanups.push(() => ro.disconnect());
  const run = async () => {
    mode = "replay";
    overlay.replaceChildren();
    await replay(ctx, drawing, size, replayTime(drawing, 900, 2200), signal);
    if (signal.aborted) return;
    if (twist === "glimpse") {
      mode = "shown";
      paint();
      setTimeout(() => {
        if (signal.aborted) return;
        canvas.classList.add("gone");
        setTimeout(() => {
          if (signal.aborted) return;
          mode = "gone";
          canvas.classList.remove("gone");
          paint();
          overlay.replaceChildren(h("span", {}, h("b", {}, t.glimpseGone)));
        }, 650);
      }, 3200);
    } else {
      mode = "shown";
      paint();
      if (!(drawing.strokes?.length > 0)) return;
      paper.append(
        h(
          "button",
          {
            class: "replay",
            type: "button",
            onclick: (/** @type {Event} */ e) => {
              /** @type {HTMLElement} */ (e.currentTarget).remove();
              void run();
            },
          },
          `↻ ${t.replay}`,
        ),
      );
    }
  };
  if (twist === "peephole") {
    paper.classList.add("peep");
    mode = "peep";
    paint();
    overlay.replaceChildren(h("span", {}, t.peepHint));
    const at = (/** @type {PointerEvent} */ e) => {
      const r = canvas.getBoundingClientRect();
      hole = [((e.clientX - r.left) / r.width) * GRID, ((e.clientY - r.top) / r.height) * GRID];
      overlay.replaceChildren();
      paint();
    };
    canvas.addEventListener("pointerdown", (e) => {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
      at(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.buttons || e.pointerType === "touch") at(e);
    });
    canvas.addEventListener("pointerup", () => {
      hole = null;
      paint();
    });
    for (const type of ["touchstart", "touchmove"]) canvas.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  } else void run();

  let sent = false;
  const submit = async (/** @type {boolean} */ auto) => {
    const text = input.value.trim();
    if (sent || !text) return;
    sent = true;
    send.disabled = true;
    try {
      await act("guess", { text }, auto ? undefined : err);
    } catch {
      sent = false;
      send.disabled = false;
    }
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void submit(false);
  });
  autoSubmit = () => void submit(true);
}

// ---------------------------------------------------------------------------
// Passed on: the slip flies to the next player.

/** @param {any} me @param {"draw" | "guess"} kind */
function passed(me, kind) {
  const slip = h("div", { class: `slip${me.next ? "" : " stay"}` }, kind === "draw" ? icon(PENCIL) : h("span", { class: "hand", style: { "font-size": "64px", color: "#17161c" } }, "?"));
  show(
    h(
      "section",
      { class: "passed" },
      slip,
      h("div", { class: "to" }, me.next ? fragment(t.passedTo("\u0000"), me.next) : t.lastDone),
      h("p", { class: "tip" }, t.waitOthers),
    ),
  );
}

/** A text with a name in bold where the placeholder (\0) is. @param {string} text @param {string} name */
function fragment(text, name) {
  const [a, b] = text.split("\u0000");
  const f = document.createDocumentFragment();
  f.append(a ?? "", h("b", {}, name), b ?? "");
  return f;
}

// ---------------------------------------------------------------------------
// The reveal: reactions, judging your own chain.

/** @param {any} me */
function watch(me) {
  const reacts = h(
    "div",
    { class: "reacts" },
    ...t.reactions.map((r, i) =>
      h(
        "button",
        {
          type: "button",
          onclick: () => {
            navigator.vibrate?.(12);
            client.act("react", { r: i }).catch(() => {});
          },
        },
        r,
      ),
    ),
  );
  show(
    h(
      "section",
      { class: "card tilt" },
      h("div", { class: "watching" }, avatar({ name: me.author, color: undefined }), h("div", {}, h("div", { class: "t" }, t.chainOf(me.author ?? "")), h("div", { class: "typed small muted" }, `${me.index ?? 1} / ${me.of ?? 1}`))),
      h("p", { class: "big" }, me.mine ? t.yourChain : t.lookTv),
    ),
    h("h2", {}, t.react),
    reacts,
  );
}

/** @param {any} me */
function judge(me) {
  const chain = me.chain ?? { links: [] };
  const links = /** @type {any[]} */ (chain.links ?? []);
  /** @type {number | null | undefined} undefined: nothing picked yet */
  let died;
  const err = h("p", { class: "error" });
  const confirm = /** @type {HTMLButtonElement} */ (h("button", { class: "btn", type: "button", disabled: true }, t.sendVerdict));
  const survived = /** @type {HTMLButtonElement} */ (h("button", { class: "btn ghost", type: "button" }, t.survived));
  /** @type {{ el: HTMLElement, g: number, by: string }[]} */
  const rows = [];
  const list = h("div", { class: "links" });
  let g = 0;
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (l.kind !== "guess") continue;
    const d = links[i - 1];
    const c = /** @type {HTMLCanvasElement} */ (h("canvas"));
    const idx = g++;
    const el = h(
      "button",
      { class: "link", type: "button", onclick: () => pick(idx) },
      c,
      h("span", { class: "g" }, l.text || t.noGuess, h("small", {}, `${l.by?.name ?? ""}`)),
    );
    rows.push({ el, g: idx, by: l.by?.name ?? "" });
    list.append(el);
    requestAnimationFrame(() => {
      const f = fit(c);
      drawInk(f.ctx, d?.drawing, 0, 0, f.size);
    });
  }
  const pick = (/** @type {number | null} */ v) => {
    died = v;
    for (const r of rows) {
      const dead = v !== null && r.g >= v;
      r.el.classList.toggle("dead", dead);
      r.el.classList.toggle("first", dead && r.g === v);
      r.el.classList.toggle("ok", !dead);
    }
    survived.classList.toggle("on", v === null);
    confirm.disabled = false;
    confirm.textContent = v === null ? t.survived : t.diedAt(rows[v]?.by ?? "");
    confirm.classList.toggle("red", v !== null);
  };
  survived.addEventListener("click", () => pick(null));
  confirm.addEventListener("click", async () => {
    if (died === undefined) return;
    confirm.disabled = true;
    try {
      await act("judge", { died }, err);
    } catch {
      confirm.disabled = false;
    }
  });
  const { bar, secs } = clock(me.deadline ?? 0);
  show(
    h(
      "section",
      { class: "judge" },
      bar,
      h("div", { class: "top" }, h("div", { class: "what" }, h("h1", { style: { margin: "6px 0 2px" } }, t.judgeTitle)), secs),
      h("p", { class: "small muted", style: { margin: "0 0 12px" } }, t.judgeHelp),
      h("div", { class: "tag" }, h("small", {}, t.prompt), chain.prompt ?? ""),
      list,
      survived,
      h("div", { class: "verdict-bar" }, confirm, err),
    ),
  );
}

// ---------------------------------------------------------------------------
// The hunt

/** @param {any} me */
function accuse(me) {
  const suspects = /** @type {any[]} */ (me.suspects ?? []);
  if (me.done) {
    const s = suspects.find((x) => x.id === me.choice);
    return show(h("section", { class: "card tilt" }, h("h1", {}, t.whoWrecker), h("p", { class: "big" }, t.accused(s?.name ?? "")), h("p", { class: "muted" }, t.lookTv)));
  }
  const err = h("p", { class: "error" });
  /** @type {string | null} */
  let pick = null;
  const confirm = /** @type {HTMLButtonElement} */ (h("button", { class: "btn red", type: "button", disabled: true }, t.accuse("…")));
  const buttons = suspects.map((s) =>
    h(
      "button",
      {
        class: "suspect",
        type: "button",
        onclick: () => {
          pick = s.id;
          buttons.forEach((b, i) => b.classList.toggle("on", suspects[i].id === s.id));
          confirm.disabled = false;
          confirm.textContent = t.accuse(s.name);
        },
      },
      avatar(s),
      h("span", {}, h("span", { class: "nm" }, s.name), s.breaks > 0 ? h("small", {}, t.atDeaths(s.breaks)) : null),
    ),
  );
  confirm.addEventListener("click", async () => {
    if (!pick) return;
    confirm.disabled = true;
    try {
      await act("accuse", { suspect: pick }, err);
    } catch {
      confirm.disabled = false;
    }
  });
  const { bar, secs } = clock(me.deadline ?? 0);
  show(
    bar,
    h("div", { class: "top" }, h("div", { class: "what" }, h("h1", { style: { margin: "6px 0 0" } }, t.whoWrecker)), secs),
    h("p", { class: "small muted", style: { margin: "0" } }, me.wrecker ? t.huntHelpWrecker : t.huntHelp),
    h("div", { class: "suspects" }, ...buttons),
    h("div", { class: "verdict-bar" }, confirm, err),
  );
}

/** @param {any} me */
function unmask(me) {
  const card = h("section", { class: "card tilt" }, h("p", { class: "big" }, t.drumroll));
  show(card);
  // The TV unmasks first: the phone follows a few seconds later.
  const timer = setTimeout(() => {
    const good = me.you ? !me.caught : me.caught;
    card.replaceChildren(
      h("p", { class: "big" }, me.you ? t.youWere : me.wreckerName ? t.wreckerWas(me.wreckerName) : ""),
      h("p", { class: `outcome ${good ? "good" : "bad"}` }, me.caught ? t.caught : t.gotAway),
    );
    if (!me.you) card.append(h("p", { class: "big" }, me.right ? t.rightGuess : t.wrongGuess));
  }, 5200);
  cleanups.push(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Scores

/** @param {any} me @param {any} room */
function scoreCard(me, room) {
  const e = me.earned ?? {};
  const kinds = /** @type {const} */ (["links", "smuggles", "wrecks", "spot", "escape"]);
  show(
    h(
      "section",
      { class: "card tilt" },
      h("h2", { style: { "margin-top": "0" } }, `${t.roundN(room.round ?? 1)} · ${t.thisRound}`),
      h("p", { class: "score" }, `+${num(lang, me.delta ?? 0)}`),
      h("ul", { class: "gains" }, ...kinds.filter((k) => e[k] > 0).map((k) => h("li", {}, h("span", {}, t.kinds[k]), h("b", {}, `+${num(lang, e[k])}`)))),
      me.word ? h("p", { class: "wordline" }, t.yourWord(""), h("mark", {}, me.word), ` · ${t.smuggledN(me.smuggled ?? 0)}`) : null,
      h("p", { class: "typed", style: { "margin-top": "14px" } }, `${num(lang, me.score ?? 0)} ${t.points} · ${me.of ? t.rank(me.rank ?? 0, me.of) : ""}`),
    ),
  );
}

// Keep the screen on while playing.
async function wake() {
  try {
    await /** @type {any} */ (navigator).wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void wake();
});

// ---------------------------------------------------------------------------

/** @type {HTMLElement} */ (app.querySelector(".big")).textContent = t.connecting;
if (!client.room || !client.key) {
  show(logo(), h("section", { class: "card" }, h("p", { class: "big" }, t.scanToJoin)));
} else if (client.canResume) {
  client.connect().then(wake, (e) => joinForm(e?.code === "no-player" ? "" : message(e)));
} else {
  joinForm();
}
