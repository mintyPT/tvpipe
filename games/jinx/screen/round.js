// @ts-check
/**
 * The round's start: the hot seat (the guesser in the light pool, the
 * blindfold drops on) and the writing (the sealed envelope, the pile of
 * face-down cards growing, the kitchen timer, the clue-givers' chips).
 *
 * @typedef {import("../game/views.ts").HotseatScreen} HotseatScreen
 * @typedef {import("../game/views.ts").WriteScreen} WriteScreen
 * @typedef {import("../game/views.ts").ScreenView} ScreenView
 * @typedef {import("./tv.js").Ctx} Ctx
 */

import { A, EASE, h, rnd, short } from "./dom.js";
import { dust, stampAt } from "./fx.js";
import { seatRow } from "./layout.js";
import { PENCIL, cardEl, chip, dial, envelope } from "./pieces.js";
import { sfx } from "./sound.js";
import { t as tr } from "./strings.js";

/** @param {{ round: number, rounds: number }} v */
export const roundTab = (v) => tr.roundTab(v.round, v.rounds);

/**
 * @param {Ctx} ctx
 * @param {HotseatScreen} v
 * @param {ScreenView | null} prev
 */
export function hotseat(ctx, v, prev) {
  const L = ctx.layer;
  const g = ctx.person(v.guesser);
  const pace = prev ? ctx.pace(2400, v.until) : 0;
  const anim = pace > 0;
  const T = (/** @type {number} */ ms) => ms * (pace || 1);
  ctx.head.set({ tab: roundTab(v), tally: v.tally, bank: v.bank.chips }, !!prev);
  ctx.pot.show(false);
  ctx.host.say(tr.makeItCount, { anim });
  ctx.pool.to(640, 330, 230, anim);

  const t = chip(g, 210, { style: "left:535px;top:225px;z-index:3" });
  L.append(t);
  const blind = h("div", { class: "blindfold" });
  const n = short(g?.name, 12).toUpperCase();
  const [first, second] = tr.hotSeat(n);
  const a = h("span", null, first);
  const b = h("span", { class: "gold" }, second);
  const title = h("div", { class: "bigline", style: "top:500px" }, a, b);
  L.append(title);
  // a long name (or language) shrinks the line to the safe area
  if (title.scrollWidth > 1152) title.style.fontSize = `${Math.max(36, Math.floor((60 * 1152) / title.scrollWidth))}px`;
  if (!anim) {
    t.append(blind);
    return {};
  }
  sfx.riser(1);
  A(t, [
    { transform: "translateY(-420px) scale(1.5)", opacity: 0 },
    { offset: 0.6, transform: "translateY(0) scale(1)", opacity: 1, easing: EASE.out },
    { offset: 0.8, transform: "scale(1.12,.86)", easing: EASE.out },
    { transform: "scale(1)", opacity: 1 },
  ], T(520), { easing: EASE.in, delay: T(250) });
  ctx.later(T(250) + T(320), () => {
    sfx.slam();
    dust(640, 430, 10, 150);
  });
  A(a, [{ transform: "translateY(-40px) scale(1.6)", opacity: 0 }, { transform: "none", opacity: 1 }], 240, { delay: T(800), easing: EASE.in });
  A(b, [{ transform: "translateY(-40px) scale(1.8)", opacity: 0 }, { transform: "none", opacity: 1 }], 260, { delay: T(800) + 650, easing: EASE.in });
  ctx.later(T(800) + 200, sfx.stamp);
  ctx.later(T(800) + 850, sfx.stamp);
  ctx.later(T(800) + 650 + T(500), () => {
    t.append(blind);
    A(blind, [{ transform: "translateY(-90px) rotate(-30deg)", opacity: 0 }, { transform: "rotate(-8deg)", opacity: 1 }], 280, { easing: EASE.in });
    A(t, [{ transform: "scale(1)" }, { transform: "scale(1.08,.9)" }, { transform: "scale(1)" }], 280, { delay: 240, fill: "none" });
    ctx.later(240, sfx.thunk);
  });
  return {};
}

const TOTALS = [30, 45, 60, 90, 120];

/** The pile: a card's place and angle, the same every time for slot i. @param {number} i */
function pileSpot(i) {
  const r = (/** @type {number} */ k) => (Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1;
  return { x: 640 + r(1) * 30, y: 310 + r(2) * 18, rot: r(3) * 18 };
}

/**
 * @param {Ctx} ctx
 * @param {WriteScreen} v
 * @param {ScreenView | null} prev
 */
export function write(ctx, v, prev) {
  const L = ctx.layer;
  const anim = !!prev;
  const g = ctx.person(v.guesser);
  ctx.head.set({ tab: roundTab(v), guesser: g, blind: true, tally: v.tally, bank: v.bank.chips }, anim);
  ctx.pot.show(false);
  ctx.pool.off(anim);
  ctx.host.say(tr.writeLine(v.each), { anim });

  const env = envelope(150, 236);
  L.append(env);
  L.append(h("div", { class: "caption", style: "left:120px;top:436px;width:360px;font-size:26px;color:var(--dim)" }, tr.cantSee(short(g?.name, 10))));
  L.append(h("div", { class: "zone", style: "left:490px;top:212px;width:300px;height:210px" }));
  const pile = h("div", { class: "abs", style: "inset:0" });
  L.append(pile);
  const total = v.givers.length * v.each;
  const count = h("div", { class: "paper tag", style: "left:640px;top:404px" });
  L.append(count);
  const leftMs = v.deadline - ctx.now();
  // the dial's full turn: the writing time (from `started`), else a guess
  let full = v.started && v.deadline > v.started ? Math.round((v.deadline - v.started) / 1000) : (TOTALS.find((t) => t * 1000 >= leftMs - 500) ?? 120);
  const d = dial(940, 226, 180);
  L.append(d.el);

  // the seats (a chip, the name under it, 150 px each) keep out of the join badge's corner
  const seats = seatRow(v.givers.length, 150, 150, { bottom: 620, minStep: 112 });
  const gx = (/** @type {number} */ i) => seats.xs[i] ?? 640;
  const nameW = Math.min(150, Math.floor(seats.step) - 4);
  /** @type {Map<string, HTMLElement>} */
  const chips = new Map();
  v.givers.forEach((id, i) => {
    const p = ctx.person(id);
    const t = chip(p, 84, { style: `left:${gx(i) - 42}px;top:492px` });
    L.append(t, h("div", { class: "seatname", style: `left:${gx(i) - nameW / 2}px;top:590px;width:${nameW}px` }, short(p?.name, 10)));
    chips.set(id, t);
    if (anim) A(t, [{ transform: "translateY(200px)" }, { transform: "none" }], 420, { delay: 200 + i * 70, easing: EASE.back });
  });
  if (anim) {
    A(env, [{ transform: "translate(-300px,40px) rotate(-20deg)" }, { transform: "none" }], 520, { easing: EASE.out });
    A(d.el, [{ transform: "translate(300px,40px) rotate(40deg)" }, { transform: "none" }], 520, { easing: EASE.out, delay: 100 });
    ctx.later(0, sfx.slide);
  }

  let sent = 0;
  /** @type {Set<string>} */
  let done = new Set();
  /** @type {Record<string, number>} */
  let sentBy = {};
  let allIn = false;
  let low = false;

  /** @param {WriteScreen} v @param {boolean} anim */
  const render = (v, anim) => {
    // new cards on the pile, each thrown from its author's chip (`sentBy`)
    /** @type {string[]} */
    const newly = [];
    for (const id of v.givers) for (let k = sentBy[id] ?? 0; k < (v.sentBy?.[id] ?? 0); k++) newly.push(id);
    if (!v.sentBy) newly.push(...v.done.filter((id) => !done.has(id)));
    sentBy = { ...(v.sentBy ?? {}) };
    for (let i = sent; i < Math.min(v.sent, 16); i++) {
      const s = pileSpot(i);
      const c = cardEl(null, undefined, { parent: pile, down: true, x: s.x - 75, y: s.y - 51, w: 150, h: 102, bold: false, style: `transform:rotate(${s.rot}deg);z-index:${i + 1}` });
      if (!anim) continue;
      const from = newly[i - sent];
      const idx = from ? v.givers.indexOf(from) : -1;
      const fx0 = idx >= 0 ? gx(idx) : 640 + rnd(-200, 200);
      const fy0 = idx >= 0 ? 534 : -80;
      const dx = fx0 - s.x;
      const dy = fy0 - s.y;
      A(c, [
        { transform: `translate(${dx}px,${dy}px) rotate(${s.rot - 50}deg) scale(.45)`, opacity: 0 },
        { offset: 0.15, opacity: 1 },
        { offset: 0.55, transform: `translate(${dx * 0.4}px,${dy * 0.4 - 80}px) rotate(${s.rot - 14}deg) scale(1.1)`, opacity: 1 },
        { transform: `rotate(${s.rot}deg)`, opacity: 1 },
      ], 560, { easing: "cubic-bezier(.3,.6,.4,1)", delay: (i - sent) * 120 });
      ctx.later((i - sent) * 120, sfx.slide);
      ctx.later((i - sent) * 120 + 540, sfx.thwap);
      A(count, [{ transform: "translateX(-50%) scale(1.25)" }, { transform: "translateX(-50%) scale(1)" }], 300, { delay: 540 });
    }
    sent = Math.max(sent, Math.min(v.sent, 16));
    count.textContent = tr.sentOf(v.sent, total);
    for (const [id, t] of chips) {
      const isDone = v.done.includes(id);
      const had = done.has(id);
      if (isDone && !had) {
        t.querySelector(".pencil")?.remove();
        const ck = h("div", { class: "check" }, "✓");
        t.append(ck);
        if (anim) {
          A(ck, [{ transform: "scale(0) rotate(-40deg)" }, { transform: "scale(1) rotate(0)" }], 300, { delay: 120, easing: EASE.back });
          ctx.later(140, sfx.pop);
        }
      } else if (!isDone && !t.querySelector(".pencil")) {
        t.querySelector(".check")?.remove();
        const pen = h("div", { class: "pencil" });
        pen.innerHTML = PENCIL;
        t.append(pen);
        A(pen, [{ transform: "rotate(-14deg) translateY(0)" }, { transform: "rotate(10deg) translateY(-4px)" }], 300, { iterations: Infinity, direction: "alternate", easing: "ease-in-out", fill: "none" });
      }
    }
    done = new Set(v.done);
    if (!allIn && v.givers.length > 0 && v.done.length >= v.givers.length) {
      allIn = true;
      ctx.host.say(tr.cluesLocked, { anim });
      if (anim) ctx.later(700, () => stampAt(L, 640, 312, tr.allIn, { cls: "green", rot: -7, size: 50 }));
      else stampAt(L, 640, 312, tr.allIn, { cls: "green", rot: -7, size: 50, anim: false });
    }
  };

  const tick = () => {
    const s = Math.max(0, Math.ceil((v.deadline - ctx.now()) / 1000));
    d.set(s, full);
    if (allIn) return;
    if (s <= 10 && s > 0) {
      sfx.tick();
      A(d.el, [{ transform: "rotate(-5deg)" }, { transform: "rotate(5deg)" }, { transform: "rotate(0)" }], 160, { fill: "none" });
      if (!low) {
        low = true;
        ctx.host.say(tr.tenSeconds);
      }
    }
  };
  render(v, anim);
  d.set(Math.max(0, Math.ceil(leftMs / 1000)), full);
  ctx.every(1000, tick);
  return {
    /** @param {WriteScreen} nv */
    update(nv) {
      v = nv;
      if (nv.started && nv.deadline > nv.started) full = Math.round((nv.deadline - nv.started) / 1000);
      render(nv, true);
    },
  };
}
