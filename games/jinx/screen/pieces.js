// @ts-check
/**
 * The objects on the table: poker-chip avatars, clue cards, the pot, the
 * envelope, the kitchen timer, the label-maker tape, the SHHH sign, the MVP
 * rosette. Faces come from the phone's faces.js so the TV and the phones
 * draw them the same.
 *
 * @typedef {import("../game/views.ts").Person} Person
 * @typedef {import("../game/views.ts").Card} Card
 */

import { COLORS, FLAME, INK, faceSvg } from "../phone/faces.js";
import { A, EASE, clamp, h, hm, removeLater, short } from "./dom.js";
import { sfx } from "./sound.js";
import { t } from "./strings.js";

export { INK };

/** A person who left or lost the connection is drawn greyed. @param {Person | undefined} p */
export function away(p) {
  return !p || !p.connected || !!p.left;
}

/**
 * A poker-chip avatar.
 * @param {Person | undefined} p
 * @param {number} size px
 * @param {{ cls?: string, style?: string, crown?: boolean }} [o]
 */
export function chip(p, size, { cls = "", style = "", crown = false } = {}) {
  const color = p ? COLORS[((p.color % 8) + 8) % 8] : "#7a8b88";
  const el = h("div", {
    class: `token${p?.bot ? " bot" : ""}${away(p) ? " away" : ""} ${cls}`,
    style: `--s:${size}px;--c:${color};${style}`,
  });
  el.append(faceSvg(p?.face));
  if (crown) el.append(h("div", { class: "crown" }));
  return el;
}

export const flame = () => hm("div", { class: "flame" }, FLAME);

export const PENCIL = `<svg viewBox="0 0 40 40"><g transform="rotate(40 20 20)"><rect x="15" y="1" width="10" height="27" rx="2" fill="#f6b93b" stroke="${INK}" stroke-width="3"/><path d="M15 28 L20 39 L25 28 Z" fill="#fbf1dc" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/></g></svg>`;

/**
 * A clue card: the face (the word, once known) and the back (tomato, or
 * ink with a gold flame when bold), the author's sticker and name tab.
 * @param {Card | null} c null: a bare back (the writing pile)
 * @param {Person | undefined} author
 * @param {{ parent: HTMLElement, x: number, y: number, w?: number, h?: number, down?: boolean, font?: number,
 *   who?: boolean, whoLeft?: number, bold?: boolean, sticker?: number, style?: string }} o
 */
export function cardEl(c, author, o) {
  const w = o.w ?? 210;
  const hh = o.h ?? 150;
  const bold = o.bold ?? !!c?.bold;
  const el = h("div", {
    class: `card${w < 180 ? " mini" : ""}${o.down ? " down" : ""}${bold ? " bold" : ""}${c && c.fate === "jinxed" ? " jinxed" : ""}`,
    style: `left:${o.x}px;top:${o.y}px;width:${w}px;height:${hh}px;${o.style ?? ""}`,
  });
  if (c) el.dataset.id = c.id;
  const word = h("div", { class: "word" }, (c?.word ?? "").toUpperCase());
  const front = h("div", { class: "face front" }, h("div", { class: "hl", style: c?.turned ? "" : "transform:scaleX(0)" }), word);
  const back = h("div", { class: "face back" }, h("div", { class: "emblem" }, h("span", null, "J")));
  if (c) {
    const s = o.sticker ?? 52;
    front.append(chip(author, s - 4, { cls: "sticker" }));
    back.append(chip(author, s, { cls: "sticker" }));
  }
  if (bold) {
    front.append(flame());
    back.append(flame());
  }
  el.append(h("div", { class: "flip" }, front, back));
  if (c && o.who !== false) {
    const tab = h("div", { class: `who${away(author) ? " gone" : ""}` }, short(author?.name, 11).toUpperCase());
    if (o.whoLeft != null) tab.style.left = `${o.whoLeft}px`;
    el.append(tab);
  }
  if (c?.turned) el.append(h("div", { class: "order" }, String(c.turned)));
  o.parent.append(el);
  fitWord(el, o.font ?? 40);
  return el;
}

/** (Re)fits a card's word to its width: 40–44 px, down to 24, then condensed with scaleX. @param {HTMLElement} card @param {number} [font] */
export function fitWord(card, font = 40) {
  const word = /** @type {HTMLElement | null} */ (card.querySelector(".word"));
  if (!word) return;
  const w = parseFloat(card.style.width) || card.offsetWidth;
  const fit = () => {
    let s = font;
    word.style.fontSize = s + "px";
    word.style.transform = "";
    word.style.letterSpacing = "";
    const avail = w - 26;
    while (word.scrollWidth > avail && s > 24) word.style.fontSize = (s -= 2) + "px";
    if (word.scrollWidth > avail) word.style.letterSpacing = "0";
    // condensed: ≥ 0.74 fits 15 letters; the longest clues (24) go further rather than overflow
    if (word.scrollWidth > avail) word.style.transform = `scaleX(${Math.max(0.5, avail / word.scrollWidth)})`;
  };
  fit();
}

/** Sets a card's word (turning it face up later). @param {HTMLElement} card @param {string} text @param {number} [font] */
export function setWord(card, text, font = 40) {
  const word = card.querySelector(".word");
  if (word) word.textContent = text.toUpperCase();
  fitWord(card, font);
}

// ---------------------------------------------------------------------------
// The pot: a tower of gold chips with a number label.

export class Pot {
  constructor() {
    this.n = 0;
    this.chips = h("div", { class: "chips" });
    this.num = h("b", null, "0");
    this.label = h("small", null, t.thePot);
    this.el = h("div", { class: "pot", hidden: true }, h("div", { class: "base" }), this.chips, h("div", { class: "label paper" }, this.label, this.num));
  }

  /** The label in the TV's language. */
  relabel() {
    this.label.textContent = t.thePot;
  }

  /** @param {number} n @param {boolean} [anim] chips dropped on one by one */
  set(n, anim = false) {
    n = clamp(Math.round(n), 0, 30);
    this.chips.replaceChildren();
    for (let i = 0; i < n; i++) {
      const c = this.#chip(i);
      this.chips.append(c);
      if (anim) {
        A(c, [{ transform: `translate(${(i * 37) % 9 - 4}px,-260px)`, opacity: 0 }, { transform: `translateX(${(i * 37) % 9 - 4}px)`, opacity: 1 }], 300, { delay: i * 60, easing: EASE.in });
        setTimeout(sfx.clink, 280 + i * 60);
      }
    }
    this.n = n;
    this.num.textContent = String(n);
  }

  /** @param {number} i */
  #chip(i) {
    return h("div", { class: "chip", style: `bottom:${i * 15}px;transform:translateX(${((i * 37) % 9) - 4}px)` });
  }

  /** @param {boolean} on @param {boolean} [anim] */
  show(on, anim = false) {
    if (on === !this.el.hidden) return;
    this.el.hidden = !on;
    if (on && anim) A(this.el, [{ transform: "translateX(320px)" }, { transform: "none" }], 460, { easing: EASE.out });
  }

  /** @param {number} n */
  count(n) {
    this.n = n;
    this.num.textContent = String(n);
    A(this.num, [{ transform: "scale(1.35)", color: "#df4a3c" }, { transform: "scale(1)", color: INK }], 300);
  }

  /**
   * Chips leave the pot: off the table, or into a point (stage coordinates).
   * @param {HTMLElement} fx @param {number} k @param {{ x: number, y: number } | null} [to] @param {number} [gap] ms between chips
   * @returns {number} ms until the last chip is gone
   */
  drain(fx, k, to = null, gap = 170) {
    const base = { x: 1010 + 38, y: 140 + 520 - 150 - 26 };
    let t = 0;
    for (let i = 0; i < k; i++) {
      const last = this.chips.lastElementChild;
      if (!last) break;
      const idx = this.chips.children.length - 1;
      last.remove();
      const p = { x: base.x, y: base.y - idx * 15 };
      const c2 = h("div", { class: "chip", style: `left:${p.x}px;top:${p.y}px;opacity:0` });
      fx.append(c2);
      const delay = i * gap;
      if (!to) {
        const dir = i % 2 ? 1 : -1;
        A(c2, [
          { transform: "none", opacity: 1 },
          { offset: 0.3, transform: `translate(${dir * 50}px,-46px) rotate(${dir * 25}deg)`, opacity: 1, easing: EASE.in },
          { transform: `translate(${dir * 170}px,330px) rotate(${dir * 200}deg)`, opacity: 0 },
        ], 700, { delay });
        removeLater(c2, delay + 720);
        setTimeout(sfx.clink, delay);
      } else {
        A(c2, [
          { transform: "none", opacity: 1 },
          { offset: 0.4, transform: `translate(${(to.x - p.x - 65) * 0.4}px,${(to.y - p.y) * 0.4 - 90}px) scale(1.1)`, opacity: 1, easing: EASE.in },
          { transform: `translate(${to.x - p.x - 65}px,${to.y - p.y - 13}px) scale(.5)`, opacity: 0.2 },
        ], 520, { delay });
        removeLater(c2, delay + 540);
        setTimeout(sfx.clink, delay + 480);
      }
      setTimeout(() => {
        this.count(Math.max(0, this.n - 1));
        sfx.drain(i);
      }, delay);
      t = delay + 720;
    }
    return t;
  }
}

// ---------------------------------------------------------------------------

/** The kraft envelope with a wax seal (the secret word lives in it). @param {number} x @param {number} y */
export function envelope(x, y) {
  return h("div", { class: "envelope", style: `left:${x}px;top:${y}px` },
    h("div", { class: "body" }),
    h("div", { class: "pocket" }),
    h("div", { class: "flapwrap" }, h("div", { class: "flap" })),
    h("div", { class: "seal" }, "?"));
}

/**
 * A kitchen dial timer: a gold wedge (tomato from 10 s), the seconds in the middle.
 * @param {number} x @param {number} y @param {number} [size]
 */
export function dial(x, y, size = 170) {
  let ticks = "";
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ticks += `<path d="M${Math.sin(a) * 64} ${-Math.cos(a) * 64} L${Math.sin(a) * 75} ${-Math.cos(a) * 75}" stroke="${INK}" stroke-width="${i % 3 ? 3 : 6}" stroke-linecap="round"/>`;
  }
  const el = hm("div", { class: "dial", style: `left:${x}px;top:${y}px;width:${size}px;height:${size}px` },
    `<svg viewBox="-85 -85 170 170"><circle r="80" fill="#fbf1dc" stroke="${INK}" stroke-width="6"/><path class="wedge"/>${ticks}<circle r="38" fill="${INK}"/><circle r="38" fill="none" stroke="#fbf1dc" stroke-width="3" stroke-dasharray="4 6"/></svg><div class="num" style="font-size:${Math.round(size * 0.235)}px"></div>`);
  const wedge = /** @type {SVGPathElement} */ (el.querySelector(".wedge"));
  const num = /** @type {HTMLElement} */ (el.querySelector(".num"));
  return {
    el,
    /** @param {number} s seconds left @param {number} total a full turn */
    set(s, total) {
      const f = clamp(s / total, 0, 1);
      const a = f * Math.PI * 2;
      const r = 60;
      const d = f >= 0.999 ? `M0 -${r} A${r} ${r} 0 1 1 -0.01 -${r} Z` : f <= 0 ? "" : `M0 0 L0 -${r} A${r} ${r} 0 ${f > 0.5 ? 1 : 0} 1 ${Math.sin(a) * r} ${-Math.cos(a) * r} Z`;
      wedge.setAttribute("d", d);
      wedge.setAttribute("fill", s <= 10 ? "#df4a3c" : "#f6b93b");
      num.textContent = String(Math.max(0, s));
    },
  };
}

/** The MVP rosette with ribbons. */
export function rosette() {
  const pts = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    const r = i % 2 ? 43 : 50;
    pts.push(`${50 + Math.sin(a) * r}% ${50 - Math.cos(a) * r}%`);
  }
  const poly = pts.join(",");
  return h("div", { class: "rosette" },
    h("div", { style: "position:absolute;left:22px;top:72px;width:80px;height:88px" },
      h("i", { style: "position:absolute;left:0;top:0;width:36px;height:88px;background:#df4a3c;transform:rotate(14deg);clip-path:polygon(0 0,100% 0,100% 100%,50% 80%,0 100%)" }),
      h("i", { style: "position:absolute;right:0;top:0;width:36px;height:88px;background:#df4a3c;transform:rotate(-14deg);clip-path:polygon(0 0,100% 0,100% 100%,50% 80%,0 100%)" })),
    h("div", { style: `position:absolute;left:0;top:0;width:124px;height:124px;background:${INK};clip-path:polygon(${poly})` }),
    h("div", { style: `position:absolute;left:5px;top:5px;width:114px;height:114px;background:#f6b93b;clip-path:polygon(${poly})` }),
    h("div", { class: "rosette-mid" }, t.mvp));
}

/** The SHHH! sign on two strings. @param {number} x centre @param {string} name */
export function sign(x, name) {
  return h("div", { class: "sign", style: `left:${x}px` },
    hm("div", { class: "strings" }, `<svg viewBox="0 0 220 60" width="220" height="60"><path d="M110 0 L20 56 M110 0 L200 56" stroke="${INK}" stroke-width="4" fill="none"/><circle cx="110" cy="4" r="7" fill="#df4a3c" stroke="${INK}" stroke-width="3"/></svg>`),
    h("div", { class: "board" }, h("b", null, t.shhh), h("span", null, t.isGuessing(short(name, 12)))));
}

/** @param {HTMLElement} el */
export function swingIn(el) {
  A(el, [
    { transform: "translateY(-240px) rotate(0)", offset: 0 },
    { transform: "translateY(0) rotate(-12deg)", offset: 0.22, easing: "ease-out" },
    { transform: "rotate(9deg)", offset: 0.42, easing: "ease-in-out" },
    { transform: "rotate(-5deg)", offset: 0.6, easing: "ease-in-out" },
    { transform: "rotate(2.5deg)", offset: 0.76, easing: "ease-in-out" },
    { transform: "rotate(-1deg)", offset: 0.9, easing: "ease-in-out" },
    { transform: "rotate(0)", offset: 1 },
  ], 1700, { easing: EASE.lin });
}

/** The red label-maker tape: letters punched in as the draft changes. */
export class Dymo {
  /** @param {number} [height] @param {number} [width] at most, px */
  constructor(height = 84, width = 840) {
    this.width = width;
    this.text = "";
    this.caret = h("i", { class: "caret" });
    this.el = h("div", { class: "dymo", style: `height:${height}px` }, this.caret);
    this.height = height;
    this.max = height >= 80 ? 54 : 46;
  }

  /** Font size so that `n` letters fit in about 860 px. @param {number} n */
  #font(n) {
    return Math.round(clamp((this.width - 90) / (Math.max(n, 1) * 0.72), 24, this.max));
  }

  /**
   * @param {string} text
   * @param {boolean} anim punch the new letters, knock off the removed ones
   */
  set(text, anim) {
    const next = [...String(text ?? "").toUpperCase().slice(0, 30)];
    const cur = [...this.text];
    let same = 0;
    while (same < cur.length && same < next.length && cur[same] === next[same]) same++;
    const letters = /** @type {HTMLElement[]} */ ([...this.el.querySelectorAll(".l:not(.gone)")]);
    for (let i = letters.length - 1; i >= same; i--) {
      const l = letters[i];
      if (!l) continue;
      if (anim) {
        l.classList.add("gone");
        A(l, [{ transform: "none", opacity: 1 }, { transform: "translateY(26px) rotate(30deg) scale(.4)", opacity: 0 }], 140);
        removeLater(l, 150);
      } else l.remove();
    }
    if (anim && cur.length > same) sfx.unpunch();
    for (let i = same; i < next.length; i++) {
      const l = h("span", { class: "l" }, next[i] === " " ? "\u00a0" : next[i]);
      this.caret.before(l);
      if (anim) A(l, [{ transform: "translateY(-16px) scale(1.8)", opacity: 0 }, { transform: "none", opacity: 1 }], 140, { delay: (i - same) * 40 });
    }
    if (anim && next.length > same) {
      sfx.punch();
      A(this.el, [{ translate: "0 4px" }, { translate: "0 0" }], 120, { fill: "none" });
    }
    this.el.style.fontSize = this.#font(next.length) + "px";
    this.text = next.join("");
  }

  /** Done: no caret. */
  done() {
    this.el.classList.add("done");
  }
}
