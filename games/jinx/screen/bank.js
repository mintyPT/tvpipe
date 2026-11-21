// @ts-check
/**
 * The room's bank: one score for everybody (design §4). Between rounds a
 * tall meter of gold chips with the room titles' marks and the record, this
 * round's +N or −N, the next title to reach, the words so far and who
 * guesses next. The meter is also the end's (end.js).
 *
 * @typedef {import("../game/views.ts").BankScreen} BankScreen
 * @typedef {import("../game/views.ts").Bank} Bank
 * @typedef {import("../game/views.ts").RoomTitle} RoomTitle
 * @typedef {import("../game/views.ts").ScreenView} ScreenView
 * @typedef {import("./tv.js").Ctx} Ctx
 */

import { A, EASE, fitText, h, removeLater, rich, short } from "./dom.js";
import { floatText } from "./fx.js";
import { joinRoom } from "./layout.js";
import { chip } from "./pieces.js";
import { sfx } from "./sound.js";
import { t as tr } from "./strings.js";

/** The titles' marks, lowest first. @type {Exclude<RoomTitle, "total jinx">[]} */
export const GOALS = ["mixed signals", "in sync", "mind readers", "telepaths"];

/**
 * The bank's meter: a tube of gold chips (the fill moves with transform
 * only), the titles' marks on tape to its right, the record a red dashed
 * line on the tube's left (keep 170 px free there; on the right when the
 * join badge is under it), the chips on a paper
 * tag at the fill's top.
 * @param {HTMLElement} parent
 * @param {Bank} bank `chips` sets the scale (the fill starts at `from`)
 * @param {{ x: number, top: number, height: number, from: number, tube?: number }} o
 */
export function meter(parent, bank, { x, top, height, from, tube = 116 }) {
  const max = Math.max(bank.goals.telepaths * 1.12, (bank.record ?? 0) * 1.06, bank.chips * 1.06, from * 1.06, 8);
  const inner = height - 16;
  /** y of `n` chips in the meter's box. @param {number} n */
  const yOf = (n) => 8 + inner * (1 - Math.max(0, n) / max);
  const box = h("div", { class: "meter", style: `left:${x}px;top:${top}px;width:${tube}px;height:${height}px` });
  const fill = h("div", { class: "fill", style: `height:${inner}px` });
  const well = h("div", { class: "well" }, fill);
  box.append(well);
  parent.append(box);
  /** @type {{ n: number, lbl: HTMLElement, line: HTMLElement }[]} */
  const marks = [];
  /** @type {HTMLElement[]} */
  const labels = [];
  for (const g of GOALS) {
    const n = bank.goals[g];
    const y = yOf(n);
    const line = h("div", { class: "mk", style: `top:${y - 2}px` });
    const lbl = h("div", { class: "mklbl", style: `left:${tube + 22}px;top:${y}px` }, h("span", null, tr.goalNames[g]), h("b", null, String(n)));
    box.append(line, lbl);
    marks.push({ n, lbl, line });
    labels.push(lbl);
  }
  for (const l of labels) fitText(l, 24, 24, 270, 0.7);
  /** @type {HTMLElement | null} */
  let rec = null;
  if (bank.record != null && bank.record > 0) {
    const y = yOf(bank.record);
    const line = h("div", { class: "mk rec", style: `top:${y - 2}px` });
    // on the tube's left: the titles' labels are on its right
    rec = h("div", { class: "mklbl rec", style: `right:${tube + 22}px;top:${y}px` }, h("span", null, tr.record), h("b", null, String(bank.record)));
    box.append(line, rec);
    fitText(rec, 24, 24, 150, 0.7);
    // under tvpipe's join badge (a low record, bottom left): on the right with the titles, clear of their labels
    const j = joinRoom();
    if (j && top + y + 19 > j.top && x - 22 - rec.offsetWidth < j.right) {
      rec.style.right = "";
      rec.style.left = `${tube + 22}px`;
      rec.style.transformOrigin = "left center";
      const taken = GOALS.map((g) => yOf(bank.goals[g]));
      let ly = y;
      for (let i = 0; i < 4; i++) {
        const near = taken.find((t) => Math.abs(t - ly) < 42);
        if (near === undefined) break;
        ly = near + (ly >= near ? 42 : -42);
      }
      rec.style.top = `${ly}px`;
    }
    marks.push({ n: bank.record, lbl: rec, line });
  }
  const num = h("b", null, String(from));
  const tag = h("div", { class: "level paper" }, num);
  box.append(tag);

  let cur = from;
  /** @param {number} n */
  const place = (n) => {
    const y = yOf(n);
    fill.style.transform = `translateY(${y - 8}px)`;
    tag.style.transform = `translate(-50%,${y}px) translateY(-50%)`;
    for (const m of marks) m.lbl.classList.toggle("on", n >= m.n);
  };
  place(from);

  return {
    el: box,
    yOf,
    /** The fill's top on the table. @param {number} n */
    at: (n) => ({ x: x + tube / 2, y: top + yOf(n) }),
    /**
     * Fills (or drains) to `n` over `ms` (0: at once): the tag counts, the
     * marks passed light up.
     * @param {number} n @param {number} [ms] @param {{ alive?: () => boolean }} [o]
     */
    to(n, ms = 0, { alive = () => true } = {}) {
      const a = cur;
      cur = n;
      if (!ms || a === n) {
        num.textContent = String(n);
        place(n);
        return;
      }
      const ya = yOf(a);
      const yb = yOf(n);
      A(fill, [{ transform: `translateY(${ya - 8}px)` }, { transform: `translateY(${yb - 8}px)` }], ms, { easing: EASE.lin, fill: "none" });
      A(tag, [{ transform: `translate(-50%,${ya}px) translateY(-50%)` }, { transform: `translate(-50%,${yb}px) translateY(-50%)` }], ms, { easing: EASE.lin, fill: "none" });
      place(n);
      for (const m of marks) m.lbl.classList.toggle("on", a >= m.n);
      const steps = Math.min(Math.abs(n - a), 40);
      for (let s = 1; s <= steps; s++)
        setTimeout(() => {
          if (alive()) num.textContent = String(Math.round(a + ((n - a) * s) / steps));
        }, (ms * s) / steps);
      for (const m of marks) {
        const up = a < m.n && n >= m.n;
        const down = a >= m.n && n < m.n;
        if (!up && !down) continue;
        setTimeout(() => {
          if (!alive()) return;
          m.lbl.classList.toggle("on", up);
          if (up) {
            A(m.lbl, [{ scale: "1.25" }, { scale: "1" }], 300, { easing: EASE.back, fill: "none" });
            sfx.pop();
          }
        }, (ms * (m.n - a)) / (n - a));
      }
    },
  };
}

/**
 * Between rounds: the bank.
 * @param {Ctx} ctx
 * @param {BankScreen} v
 * @param {ScreenView | null} prev
 */
export function bank(ctx, v, prev) {
  const L = ctx.layer;
  const pace = prev ? ctx.pace(2600, v.until) : 0;
  const anim = pace > 0;
  const T = (/** @type {number} */ ms) => ms * (pace || 1);
  ctx.head.set({ tab: tr.bankTab(v.round, v.rounds) }, !!prev);
  ctx.host.clear();
  ctx.pot.show(false);
  ctx.pool.off(!!prev);
  const chips = v.bank.chips;
  const before = Math.max(0, chips - v.banked);
  const m = meter(L, v.bank, { x: 250, top: 112, height: 560, from: anim ? before : chips });

  // the right side: this round, the next title, the words so far, who is next
  const d = v.banked;
  const right = h("div", { class: "bankside" });
  const big = h("div", { class: `big ${d > 0 ? "plus" : d < 0 ? "minus" : "zero"}` }, d > 0 ? `+${d}` : d < 0 ? `−${-d}` : "±0");
  right.append(h("div", { class: "k" }, tr.thisRound), big, h("div", { class: "sub" }, ...rich(tr.bankLine(d))));
  const goal = GOALS.find((g) => chips < v.bank.goals[g]);
  const goalEl = h("div", { class: "goal" }, ...rich(goal ? tr.toGoal(v.bank.goals[goal] - chips, tr.goalNames[goal]) : tr.topGoal));
  right.append(goalEl);
  const t = v.tally;
  const n = Math.max(t.total, t.history.length);
  const slots = h("div", { class: "slots small" });
  for (let i = 0; i < n; i++) {
    const s = t.history[i];
    slots.append(h("i", { class: s === "found" ? "won" : s === "missed" ? "lost" : "todo" }, s === "found" ? "✓" : s === "missed" ? "✕" : ""));
  }
  right.append(h("div", { class: "words" }, tr.wordsSoFar(t.found, t.played)), slots);
  const nextP = v.next ? ctx.person(v.next) : undefined;
  right.append(
    v.next
      ? h("div", { class: "next" }, h("span", { class: "dim" }, tr.nextUp), chip(nextP, 72, { style: "position:relative" }), tr.guesses(short(nextP?.name, 10)))
      : h("div", { class: "next" }, tr.thatsTheGame),
  );
  L.append(right);
  fitText(goalEl, 28, 24, 496, 0.8);
  if (!anim) return {};

  A(m.el, [{ transform: "translateY(760px) rotate(4deg)" }, { transform: "none" }], T(560), { easing: EASE.back });
  sfx.slide();
  A(right, [{ transform: "translateX(500px)", opacity: 0 }, { transform: "none", opacity: 1 }], T(480), { delay: T(160) });
  A(big, [{ transform: "scale(0)" }, { transform: "scale(1.2)" }, { transform: "none" }], 420, { delay: T(900), easing: EASE.back });
  ctx.later(T(900), d > 0 ? sfx.clink : d < 0 ? sfx.bonk : sfx.pop);
  (async () => {
    if (!(await ctx.wait(T(700)))) return;
    const ms = Math.min(1600, 300 + Math.abs(d) * 110) * pace;
    if (d > 0) {
      // chips drop into the tube, the fill rises with them
      const k = Math.min(d, 8);
      const top = m.at(before);
      for (let i = 0; i < k; i++) {
        const c = h("div", { class: "chip", style: `left:${top.x - 65}px;top:${top.y - 13}px` });
        ctx.fx.append(c);
        const delay = (i * ms) / k;
        A(c, [{ transform: "translateY(-420px) scale(.7)", opacity: 0 }, { offset: 0.2, opacity: 1 }, { transform: "scale(.7)", opacity: 1 }], 360, { delay, easing: EASE.in });
        A(c, [{ opacity: 1 }, { opacity: 0 }], 120, { delay: delay + 360 });
        removeLater(c, delay + 500);
        ctx.later(delay + 340, sfx.clink);
      }
      ctx.later(300, () => m.to(chips, ms, { alive: () => ctx.alive() }));
      ctx.later(ms + 400, () => {
        const p = m.at(chips);
        floatText(p.x, p.y - 60, `+${d}`, "plus", 2000);
      });
    } else if (d < 0) {
      m.to(chips, ms, { alive: () => ctx.alive() });
      const p = m.at(before);
      floatText(p.x, p.y - 50, `−${-d}`, "minus", 2000);
      sfx.drain(0);
    }
  })();
  return {};
}
