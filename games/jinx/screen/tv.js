// @ts-check
/**
 * The TV: renders `view.screen` (a ScreenView) and `view.join` on a
 * 1280×720 table scaled to the window. Each phase is a scene; the TV
 * animates the difference between the previous view and the new one, and
 * a view that arrives cold (the first one, or after a reconnect) is drawn
 * in its final state without replaying anything.
 *
 * Layers on the table, bottom to top: the light pool, the scenes (the old
 * one is swept off while the new one is dealt on), the pot, the header
 * (round tab, guesser, the room's tally and bank) and the host line (masking tape
 * under the header). Particles fly in #fx above the table.
 *
 * The TV speaks the room's language (`screen.lang`, strings.js): a view in
 * another language draws everything again, without animation.
 *
 * @typedef {import("../game/views.ts").ScreenView} ScreenView
 * @typedef {import("../game/views.ts").Person} Person
 * @typedef {import("../game/views.ts").Tally} Tally
 * @typedef {{ code?: string, url?: string, short?: string, qr?: unknown, lateJoin?: string, inProgress?: boolean }} Join
 * @typedef {{ update?: (v: any, prev: any) => void, sweepDelay?: number, continuous?: boolean }} Scene
 * @typedef {(ctx: Ctx, v: any, prev: ScreenView | null) => Scene} SceneFn
 */

import { A, EASE, clamp, h, rich, short } from "./dom.js";
import { resetShakes, setSurfaces } from "./fx.js";
import { Pot, chip } from "./pieces.js";
import { quiet, setMuted, sfx } from "./sound.js";
import { t, useLang } from "./strings.js";

export class Ctx {
  /**
   * @param {Tv} tv
   * @param {HTMLElement} layer
   * @param {number} gen
   */
  constructor(tv, layer, gen) {
    this.tv = tv;
    this.layer = layer;
    this.gen = gen;
    this.fx = tv.fx;
    this.pot = tv.pot;
    this.head = tv.head;
    this.host = tv.host;
    this.pool = tv.pool;
    /** @type {HTMLElement | null} */
    this.prevLayer = null;
    /** @type {ReturnType<typeof setInterval>[]} */
    this.timers = [];
  }

  /** Host time (ms). */
  now() {
    return this.tv.now();
  }

  /** Whether this scene is still the current one. */
  alive() {
    return this.gen === this.tv.gen;
  }

  /** Waits; false when the scene was replaced meanwhile. @param {number} ms */
  wait(ms) {
    const g = this.gen;
    return new Promise((r) => setTimeout(() => r(g === this.tv.gen), Math.max(0, ms)));
  }

  /** Repeats `fn` while the scene lives. @param {number} ms @param {() => void} fn */
  every(ms, fn) {
    const id = setInterval(() => (this.alive() ? fn() : clearInterval(id)), ms);
    this.timers.push(id);
    return id;
  }

  /** Runs `fn` after `ms` if the scene still lives. @param {number} ms @param {() => void} fn */
  later(ms, fn) {
    setTimeout(() => this.alive() && fn(), Math.max(0, ms));
  }

  /** @param {string | undefined} id */
  person(id) {
    return id == null ? undefined : this.tv.people.get(id);
  }

  /** @param {string | undefined} id */
  name(id) {
    return short(this.person(id)?.name);
  }

  get join() {
    return this.tv.join;
  }

  /** The QR code's SVG markup. @param {number} quiet */
  qr(quiet) {
    return this.tv.qrSvg(this.tv.join?.qr, { quiet });
  }

  /**
   * How fast to play a sequence of `natural` ms so it ends before `until`
   * (host time): 1 normally, < 1 compresses; 0 when there is not enough
   * time left to play it at all (draw the end state).
   * @param {number} natural @param {number | undefined} until
   */
  pace(natural, until) {
    if (until == null) return 1;
    const left = until - this.now();
    if (left < natural * 0.4) return 0;
    return clamp(left / natural, 0.4, 1);
  }

  /** Memory carried over the round. */
  get memo() {
    return this.tv.memo;
  }
}

// ---------------------------------------------------------------------------
// The header: round tab, who guesses, the room's tally and bank.

class Header {
  constructor() {
    this.tab = h("div", { class: "tab paper" });
    this.who = h("div", { class: "who-guesses" });
    this.tally = h("div", { class: "tally" });
    this.bankNum = h("b", null, "0");
    this.bankWord = h("small", null, t.bank);
    this.bank = h("div", { class: "bank-lbl paper", hidden: true }, h("div", { class: "minichips" }, h("i"), h("i"), h("i")), this.bankWord, this.bankNum);
    this.el = h("div", { class: "head" }, h("div", { class: "head-left" }, this.tab, this.who), h("div", { class: "head-right" }, this.tally, this.bank));
    this.state = "";
    this.tabText = "";
    this.whoKey = "";
    /** The bank's chips as drawn (-1: hidden). */
    this.bankN = -1;
  }

  /** Forgets what is drawn (another language): the next `set` draws it all. */
  relabel() {
    this.state = "";
    this.whoKey = "";
    this.bankWord.textContent = t.bank;
  }

  /**
   * The bank's label: hidden without `n`; a changed number pops when `anim`.
   * @param {number | undefined} n @param {boolean} [anim]
   */
  setBank(n, anim = false) {
    if (n == null) {
      this.bank.hidden = true;
      this.bankN = -1;
      return;
    }
    const was = this.bankN;
    this.bank.hidden = false;
    this.bankN = n;
    this.bankNum.textContent = String(n);
    if (anim && was >= 0 && was !== n) A(this.bankNum, [{ transform: "scale(1.45)", color: n > was ? "#2f9e57" : "#df4a3c" }, { transform: "scale(1)", color: "#1d1a2b" }], 320, { easing: EASE.back });
  }

  /** The bank label's centre on the table (for chips flying in or out). */
  bankPoint() {
    const e = this.bank;
    return { x: 64 + e.offsetLeft + 38, y: 36 + e.offsetTop + e.offsetHeight / 2 };
  }

  /**
   * @param {{ tab?: string, guesser?: Person, blind?: boolean, tally?: Tally, bank?: number, round?: number, hideWho?: boolean }} o
   * @param {boolean} anim
   */
  set(o, anim) {
    this.setBank(o.bank, anim);
    if (o.tab !== this.tabText) {
      this.tabText = o.tab ?? "";
      this.tab.textContent = this.tabText;
      this.tab.hidden = !o.tab;
      if (anim && o.tab) {
        A(this.tab, [{ transform: "scale(2.4) rotate(-12deg)", opacity: 0 }, { offset: 0.7, transform: "scale(.94) rotate(-1.5deg)", opacity: 1 }, { transform: "rotate(-1.5deg)", opacity: 1 }], 280, { easing: EASE.in, delay: 120 });
        setTimeout(sfx.stamp, 300);
      }
    }
    const whoKey = o.guesser && !o.hideWho ? `${o.guesser.id}:${o.guesser.name}:${o.blind}:${o.guesser.connected}` : "";
    if (whoKey !== this.whoKey) {
      this.whoKey = whoKey;
      this.who.replaceChildren();
      if (o.guesser && !o.hideWho) {
        const tok = chip(o.guesser, 52, { style: "position:relative;flex:none" });
        if (o.blind) tok.append(h("div", { class: "blindfold" }));
        this.who.append(tok, h("span", null, t.guesses(short(o.guesser.name, 12))));
      }
    }
    this.setTally(o.tally, anim);
  }

  /** @param {Tally | undefined} tl @param {boolean} anim */
  setTally(tl, anim) {
    const key = tl ? `${tl.found}/${tl.played}/${tl.total}/${tl.history.join(",")}` : "";
    if (key === this.state) return;
    const before = this.state;
    this.state = key;
    this.tally.replaceChildren();
    if (!tl) return;
    const n = Math.max(tl.total, tl.history.length);
    // room for the bank beside it: up to 16 rounds in about 260 px (the count's words go when it is that long)
    const w = n > 12 ? 12 : n > 8 ? 16 : 22;
    this.tally.style.gap = n > 12 ? "4px" : "";
    const minis = [];
    for (let i = 0; i < n; i++) {
      const s = tl.history[i];
      minis.push(h("i", { class: `mini ${s === "found" ? "won" : s === "missed" ? "lost" : "todo"}`, style: `width:${w}px;height:${Math.round(w * 1.42)}px` }));
    }
    this.tally.append(n > 12 ? "" : h("span", { class: "tl" }, t.tally(tl.found, tl.total)), ...minis);
    // the round that just ended turns over
    const prevLen = before ? (before.split("/")[3] ?? "").split(",").filter(Boolean).length : tl.history.length;
    if (anim && tl.history.length > prevLen) {
      const m = minis[tl.history.length - 1];
      if (m) {
        A(m, [{ transform: "rotateY(90deg) scale(1.3)" }, { transform: "rotateY(0) scale(1)" }], 300, { easing: EASE.back, delay: 100 });
        setTimeout(sfx.flipTick, 100);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The host line: one line of copy on masking tape; big moments in two hits.

class HostLine {
  constructor() {
    this.el = h("div", { class: "hostline", hidden: true });
    this.key = "";
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.timer = null;
  }

  /**
   * @param {string} first sentence case, `*bold*` marks emphasis
   * @param {{ second?: string, anim?: boolean, gap?: number, cls?: string }} [o] second: the second hit (uppercase, after `gap` ms)
   */
  say(first, { second, anim = true, gap = 650, cls = "" } = {}) {
    const key = `${first}|${second ?? ""}|${cls}`;
    if (key === this.key) return;
    this.key = key;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const strip = h("div", { class: `strip ${cls}` }, ...rich(first));
    this.el.replaceChildren(strip);
    this.el.hidden = false;
    // never cut: a long line (a clue of 24 letters in the second hit) gets smaller to fit the tape's 1100 px
    const fit = () => {
      strip.style.fontSize = "";
      if (strip.scrollWidth > strip.clientWidth + 1) strip.style.fontSize = `${Math.max(16, Math.floor((28 * strip.clientWidth) / strip.scrollWidth))}px`;
    };
    fit();
    if (anim) {
      A(strip, [{ clipPath: "inset(-12px 100% -12px -12px)" }, { clipPath: "inset(-12px -12px -12px -12px)" }], 300, { easing: EASE.inout });
      sfx.zip();
    }
    if (second) {
      const s = h("b", { class: "hit" }, second);
      const land = () => {
        strip.append(s);
        fit();
        if (anim) {
          A(s, [{ transform: "translateY(-30px) scale(2)", opacity: 0 }, { transform: "none", opacity: 1 }], 220, { easing: EASE.in });
          setTimeout(sfx.stamp, 180);
        }
      };
      if (anim) this.timer = setTimeout(land, gap + 300);
      else land();
    }
  }

  clear() {
    this.key = "";
    if (this.timer) clearTimeout(this.timer);
    this.el.replaceChildren();
    this.el.hidden = true;
  }

  /** @param {boolean} on */
  hide(on) {
    if (this.el.classList.contains("off") === on) return;
    this.el.classList.toggle("off", on);
    A(this.el, [{ opacity: on ? 1 : 0 }, { opacity: on ? 0 : 1 }], 250);
  }
}


// ---------------------------------------------------------------------------
// The light pool: a flat lighter disc on the felt that moves to what matters.

class Pool {
  constructor() {
    this.el = h("div", { class: "pool", style: "opacity:0" });
    this.at = { x: 640, y: 360, r: 0 };
  }

  /** @param {number} x @param {number} y @param {number} r @param {boolean} [anim] */
  to(x, y, r, anim = true) {
    const tf = (/** @type {{x:number,y:number,r:number}} */ p) => `translate(${p.x - 250}px,${p.y - 250}px) scale(${p.r / 250})`;
    const from = this.at.r ? tf(this.at) : tf({ x, y, r: r * 0.2 });
    const to = tf({ x, y, r });
    const fromOpacity = this.at.r ? 1 : 0;
    this.at = { x, y, r };
    this.el.getAnimations().forEach((a) => a.cancel());
    this.el.style.transform = to;
    this.el.style.opacity = "1";
    if (anim) A(this.el, [{ transform: from, opacity: fromOpacity }, { transform: to, opacity: 1 }], 550, { easing: EASE.inout, fill: "none" });
  }

  /** @param {boolean} [anim] */
  off(anim = true) {
    if (!this.at.r) return;
    this.at = { ...this.at, r: 0 };
    this.el.getAnimations().forEach((a) => a.cancel());
    this.el.style.opacity = "0";
    if (anim) A(this.el, [{ opacity: 1 }, { opacity: 0 }], 400, { fill: "none" });
  }
}

// ---------------------------------------------------------------------------

export class Tv {
  /**
   * @param {{ root: HTMLElement, now: () => number, qrSvg: (qr: any, o: { quiet?: number }) => string, muted?: boolean, scenes: Record<string, SceneFn> }} o
   */
  constructor(o) {
    this.now = o.now;
    this.qrSvg = o.qrSvg;
    this.scenes = o.scenes;
    setMuted(!!o.muted);
    this.gen = 0;
    /** @type {Map<string, Person>} */
    this.people = new Map();
    /** @type {Join | null} */
    this.join = null;
    /** @type {Record<string, any>} */
    this.memo = {};
    this.stage = h("div", { class: "stage" });
    this.table = h("div", { class: "table" });
    this.fx = h("div", { class: "fx" });
    this.layers = h("div", { class: "layers" });
    this.pool = new Pool();
    this.pot = new Pot();
    this.head = new Header();
    this.host = new HostLine();
    this.table.append(h("div", { class: "mat" }), this.pool.el, this.layers, this.pot.el, this.head.el, this.host.el);
    this.stage.append(this.table, this.fx);
    o.root.append(this.stage);
    setSurfaces(this.table, this.fx);
    /** @type {ScreenView | null} */
    this.prev = null;
    this.sceneKey = "";
    /** @type {Scene | null} */
    this.scene = null;
    /** @type {HTMLElement | null} */
    this.layer = null;
    /** @type {Ctx | null} */
    this.ctx = null;
    this.coldNext = true;
    this.fit = () => {
      const r = o.root.getBoundingClientRect();
      const s = Math.min(r.width / 1280, r.height / 720) || 1;
      this.stage.style.transform = `translate(-50%,-50%) scale(${s})`;
    };
    addEventListener("resize", this.fit);
    this.fit();
  }

  /** The next view is drawn cold (after a reconnect). */
  cold() {
    this.coldNext = true;
  }

  /** @param {{ screen?: ScreenView, join?: Join }} view */
  update(view) {
    const v = view.screen;
    this.join = view.join ?? null;
    if (!v || typeof v !== "object" || !v.phase || !this.scenes[v.phase]) return;
    this.people = new Map((Array.isArray(v.people) ? v.people : []).map((p) => [p.id, p]));
    if (useLang(v.lang)) {
      // Another language (between games): everything drawn again as it is.
      this.sceneKey = "";
      this.coldNext = true;
      this.head.relabel();
      this.pot.relabel();
    }
    const round = "round" in v ? v.round : 0;
    const key = v.phase === "end" || v.phase === "lobby" ? v.phase : `${v.phase}:${round}`;
    try {
      if (key !== this.sceneKey || !this.scene) this.#enter(v, key);
      else this.scene.update?.(v, this.prev);
    } catch (err) {
      console.error(err);
    }
    this.prev = v;
  }

  /** @param {ScreenView} v @param {string} key */
  #enter(v, key) {
    const prev = this.coldNext ? null : this.prev;
    this.coldNext = false;
    const prevRound = this.prev && "round" in this.prev ? this.prev.round : -1;
    const round = "round" in v ? v.round : -1;
    if (round !== prevRound) {
      resetShakes();
      this.memo = {};
    }
    this.gen++;
    this.ctx?.timers.forEach(clearInterval);
    quiet();
    const old = this.layer;
    const layer = h("div", { class: "layer" });
    this.layers.append(layer);
    this.layer = layer;
    const ctx = new Ctx(this, layer, this.gen);
    ctx.prevLayer = old;
    this.ctx = ctx;
    this.sceneKey = key;
    const fn = /** @type {SceneFn} */ (this.scenes[v.phase]);
    const scene = fn(ctx, v, prev);
    this.scene = scene;
    if (old) {
      if (!prev || scene.continuous) old.remove();
      else {
        const go = () => {
          old.getAnimations({ subtree: true }).forEach((a) => a.pause());
          A(old, [{ transform: "none", opacity: 1 }, { transform: "translate(-40px,90px) rotate(-1.5deg)", opacity: 0 }], 380, { easing: EASE.in });
          setTimeout(() => old.remove(), 400);
          sfx.whoosh();
        };
        if (scene.sweepDelay) setTimeout(go, scene.sweepDelay);
        else go();
      }
    }
  }
}
