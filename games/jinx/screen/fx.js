// @ts-check
/**
 * Effects on the table: shakes (a budget of three per round), dust, paper
 * confetti, floating numbers, rubber stamps, masking tape, shards, marker
 * strokes. Few, big particles; transform and opacity only.
 */

import { A, EASE, h, hm, removeLater, rnd } from "./dom.js";
import { sfx } from "./sound.js";

/** @type {{ table: HTMLElement, fx: HTMLElement, shakes: number }} */
const R = { table: document.createElement("div"), fx: document.createElement("div"), shakes: 3 };

/** @param {HTMLElement} table the shaken surface @param {HTMLElement} fx the particle layer */
export function setSurfaces(table, fx) {
  R.table = table;
  R.fx = fx;
}

/** A new round: three table shakes again. */
export function resetShakes() {
  R.shakes = 3;
}

/**
 * A short table shake. Big ones (≥ 6 px) use the round's budget; small
 * ones are free but stay at ≤ 4 px.
 * @param {number} [px] @param {number} [ms]
 */
export function shake(px = 8, ms = 320) {
  if (px >= 6) {
    if (R.shakes <= 0) px = 3;
    else R.shakes--;
  }
  A(R.table, [
    { transform: "translate(0,0)" },
    { transform: `translate(${-px}px,${px * 0.6}px)` },
    { transform: `translate(${px * 0.8}px,${-px * 0.5}px)` },
    { transform: `translate(${-px * 0.4}px,${px * 0.3}px)` },
    { transform: "translate(0,0)" },
  ], ms, { easing: EASE.lin, fill: "none" });
}

/** @param {number} x @param {number} y @param {number} [n] @param {number} [spread] @param {string} [color] */
export function dust(x, y, n = 8, spread = 90, color = "var(--paper)") {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd(-0.3, 0.3);
    const d = rnd(spread * 0.6, spread);
    const p = h("div", { class: "dust", style: `left:${x - 17}px;top:${y - 17}px;background:${color}` });
    R.fx.append(p);
    A(p, [{ transform: "scale(.6)", opacity: 0.9 }, { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d * 0.5}px) scale(${rnd(0.15, 0.4)})`, opacity: 0 }], rnd(380, 520));
    removeLater(p, 540);
  }
}

const CONFETTI = ["#ff7a5c", "#4aa8f5", "#8bd648", "#ffc63d", "#b48fff", "#ff8cc6", "#fbf1dc", "#3fd9c7"];
/** @param {number} x @param {number} y @param {number} [n] @param {number} [up] */
export function confetti(x, y, n = 44, up = 1) {
  for (let i = 0; i < n; i++) {
    const p = h("div", { class: `confetti${i % 3 === 0 ? " sq" : ""}`, style: `left:${x}px;top:${y}px;background:${CONFETTI[i % CONFETTI.length]}` });
    R.fx.append(p);
    const a = rnd(-Math.PI * 0.95, -Math.PI * 0.05);
    const v = rnd(220, 520) * up;
    const dx = Math.cos(a) * v;
    const dy = Math.sin(a) * v;
    const dur = rnd(1300, 2000);
    A(p, [
      { transform: "translate(0,0) rotate(0)", opacity: 1 },
      { offset: 0.35, transform: `translate(${dx}px,${dy}px) rotate(${rnd(-200, 200)}deg)`, opacity: 1, easing: "cubic-bezier(.4,0,1,1)" },
      { transform: `translate(${dx * 1.3}px,${dy + 760}px) rotate(${rnd(-600, 600)}deg)`, opacity: 1 },
    ], dur, { easing: "cubic-bezier(.1,.7,.4,1)" });
    removeLater(p, dur + 20);
  }
}

/** Numbers (chips won or lost) that float up and fade. @param {number} x @param {number} y @param {string} text @param {"plus" | "minus"} [cls] @param {number} [dur] */
export function floatText(x, y, text, cls = "plus", dur = 1800) {
  x = Math.max(64 + text.length * 11, Math.min(1216 - text.length * 11, x));
  const f = h("div", { class: `float ${cls}`, style: `left:${x}px;top:${y}px` }, text);
  R.fx.append(f);
  A(f, [
    { transform: "translate(-50%,10px) scale(.6)", opacity: 0 },
    { offset: 0.15, transform: "translate(-50%,0) scale(1.1)", opacity: 1 },
    { offset: 0.75, transform: "translate(-50%,-40px) scale(1)", opacity: 1 },
    { transform: "translate(-50%,-60px) scale(1)", opacity: 0 },
  ], dur, { easing: EASE.lin });
  removeLater(f, dur + 20);
}

/**
 * A rubber stamp, centred at (x, y) in `parent`; `anim` false: it is already there.
 * @param {HTMLElement} parent @param {number} x @param {number} y @param {string} text
 * @param {{ cls?: string, rot?: number, size?: number, anim?: boolean, shakePx?: number }} [o]
 */
export function stampAt(parent, x, y, text, { cls = "", rot = -8, size = 64, anim = true, shakePx } = {}) {
  const s = h("div", { class: `stamp ${cls}`, style: `left:${x}px;top:${y}px;font-size:${size}px;transform:translate(-50%,-50%) rotate(${rot}deg)` }, text);
  parent.append(s);
  if (!anim) return s;
  A(s, [
    { transform: `translate(-50%,-50%) scale(2.8) rotate(${rot - 16}deg)`, opacity: 0 },
    { offset: 0.65, transform: `translate(-50%,-50%) scale(.9) rotate(${rot}deg)`, opacity: 1 },
    { transform: `translate(-50%,-50%) scale(1) rotate(${rot}deg)`, opacity: 1 },
  ], 260, { easing: EASE.in });
  setTimeout(() => {
    sfx.stamp();
    shake(shakePx ?? Math.min(4, size / 16));
  }, 170);
  return s;
}

/**
 * Masking tape with a reason, wiped on left to right, centred at x (kept inside x 64–1216).
 * @param {HTMLElement} parent @param {number} x @param {number} y @param {string} text
 * @param {{ rot?: number, anim?: boolean, size?: number }} [o]
 */
export function tapeAt(parent, x, y, text, { rot = 2, anim = true, size = 26 } = {}) {
  const wrap = h("div", { class: "abs", style: `left:${x}px;top:${y}px;z-index:41` });
  const t = h("div", { class: "tape", style: `position:relative;font-size:${size}px` }, text);
  wrap.append(t);
  parent.append(wrap);
  const w = t.offsetWidth;
  wrap.style.left = Math.max(64, Math.min(1216 - w, x - w / 2)) + "px";
  wrap.style.transform = `rotate(${rot}deg)`;
  if (anim) {
    A(wrap, [{ clipPath: "inset(-10px 100% -10px -10px)" }, { clipPath: "inset(-10px -10px -10px -10px)" }], 320, { easing: EASE.inout });
    sfx.zip();
  }
  return wrap;
}

/**
 * Breaks a card into paper shards (clones of its back) that fly apart and fall.
 * @param {HTMLElement} card @param {number} cx @param {number} cy centre on the stage
 * @param {number} rot @param {number} w @param {number} hh
 */
export function shatter(card, cx, cy, rot, w, hh) {
  const back = card.querySelector(".back");
  if (!back) return;
  const bold = card.classList.contains("bold");
  const c = { x: w / 2 + rnd(-20, 20), y: hh / 2 + rnd(-14, 14) };
  const per = 2 * (w + hh);
  const ts = [0, w, w + hh, 2 * w + hh];
  for (let i = 0; i < 6; i++) ts.push(rnd(0, per));
  ts.sort((a, b) => a - b);
  /** @param {number} t @returns {[number, number]} */
  const at = (t) => (t <= w ? [t, 0] : t <= w + hh ? [w, t - w] : t <= 2 * w + hh ? [w - (t - w - hh), hh] : [0, hh - (t - 2 * w - hh)]);
  for (let i = 0; i < ts.length; i++) {
    const p1 = at(ts[i] ?? 0);
    const p2 = at(ts[(i + 1) % ts.length] ?? 0);
    if (Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) < 2) continue;
    const poly = [[c.x, c.y], p1, p2];
    const piece = h("div", {
      class: `card shard${bold ? " bold" : ""}`,
      style: `left:${cx - w / 2}px;top:${cy - hh / 2}px;width:${w}px;height:${hh}px;clip-path:polygon(${poly.map((p) => `${p[0]}px ${p[1]}px`).join(",")})`,
    });
    const face = /** @type {HTMLElement} */ (back.cloneNode(true));
    face.style.transform = "none";
    piece.append(face);
    R.fx.append(piece);
    const gx = (c.x + p1[0] + p2[0]) / 3;
    const gy = (c.y + p1[1] + p2[1]) / 3;
    let dx = gx - w / 2;
    let dy = gy - hh / 2;
    const len = Math.hypot(dx, dy) || 1;
    const d = rnd(170, 340);
    dx = (dx / len) * d;
    dy = (dy / len) * d * 0.8;
    const spin = rnd(-320, 320);
    piece.style.transformOrigin = `${gx}px ${gy}px`;
    const dur = rnd(650, 950);
    A(piece, [
      { transform: `rotate(${rot}deg)`, opacity: 1 },
      { offset: 0.45, transform: `translate(${dx * 0.7}px,${dy * 0.7 - 50}px) rotate(${rot + spin * 0.5}deg) scale(.95)`, opacity: 1, easing: "cubic-bezier(.5,0,1,1)" },
      { transform: `translate(${dx}px,${dy + 160}px) rotate(${rot + spin}deg) scale(.8)`, opacity: 0 },
    ], dur, { easing: "cubic-bezier(.15,.75,.35,1)" });
    removeLater(piece, dur + 20);
  }
}

/**
 * One marker line through an element (it stays readable).
 * @param {HTMLElement} el @param {boolean} [anim]
 */
export function strikeThrough(el, anim = true) {
  const w = el.offsetWidth;
  const hh = el.offsetHeight;
  const d = `M14 ${hh * 0.62} Q ${w / 2} ${hh * 0.42} ${w - 14} ${hh * 0.5}`;
  const s = hm("div", { class: "strikeline" }, `<svg width="${w}" height="${hh}" style="overflow:visible"><path d="${d}" stroke="#fbf1dc" stroke-width="13" fill="none" stroke-linecap="round"/><path d="${d}" stroke="#1d1a2b" stroke-width="6" fill="none" stroke-linecap="round"/></svg>`);
  el.append(s);
  if (anim) {
    s.querySelectorAll("path").forEach((p) => {
      p.style.strokeDasharray = String(w + 40);
      A(p, [{ strokeDashoffset: w + 40 }, { strokeDashoffset: 0 }], 300, { easing: EASE.inout });
    });
    sfx.marker();
  }
  return s;
}
