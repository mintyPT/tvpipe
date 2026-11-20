// @ts-check
/**
 * The jinx check: every card face down with its author; the jinx groups
 * lift, accelerate into each other and slam, shatter into paper shards, a
 * JINX! stamp lands with the reason on tape, bold authors lose 2, chips fall
 * off the pot. Groups play one after another, each faster. Then the
 * survivors glide into the reveal row. Paced to `until`.
 *
 * @typedef {import("../game/views.ts").JinxScreen} JinxScreen
 * @typedef {import("../game/views.ts").JinxGroup} JinxGroup
 * @typedef {import("../game/views.ts").Card} Card
 * @typedef {import("../game/views.ts").Reason} Reason
 * @typedef {import("../game/views.ts").ScreenView} ScreenView
 * @typedef {import("./tv.js").Ctx} Ctx
 */

import { A, EASE, clamp, fadeOut, h, removeLater, short } from "./dom.js";
import { dust, floatText, shake, shatter, stampAt, tapeAt } from "./fx.js";
import { grid } from "./layout.js";
import { cardEl } from "./pieces.js";
import { sfx } from "./sound.js";
import { t as tr } from "./strings.js";

/** How a reason reads on tape, in the TV's language. @param {Reason} r */
export const reasonText = (r) => tr.reasons[r] ?? r;

/** The tape under a group's stamp: "same word × 3", "plural", "plural · typo". @param {JinxGroup} g */
export function groupReason(g) {
  const kinds = [...new Set(g.pairs.map((p) => p.reason))];
  if (kinds.length === 0) return reasonText("same word");
  if (kinds.length === 1 && kinds[0] === "same word" && g.cards.length > 2) return tr.sameWordTimes(g.cards.length);
  return kinds.map(reasonText).join(" · ");
}

/**
 * @param {Ctx} ctx
 * @param {JinxScreen} v
 * @param {ScreenView | null} prev
 */
export function jinx(ctx, v, prev) {
  const L = ctx.layer;
  const g = ctx.person(v.guesser);
  const alive = v.cards.filter((c) => c.fate !== "jinxed");
  const lost = v.cards.length - alive.length;
  const slots = grid(v.cards);
  const finalSlots = grid(alive, { big: true });
  const dealt = prev?.phase === "write";
  const groupMs = v.groups.map((_, k) => 2800 * Math.pow(0.78, k));
  // jinxed without a group: too close to the word (struck out on their own)
  const grouped = new Set(v.groups.flatMap((g) => g.cards));
  const invalid = v.cards.filter((c) => c.fate === "jinxed" && !grouped.has(c.id));
  const natural = (dealt ? 1300 : 300) + 1000 + (v.groups.length || invalid.length ? groupMs.reduce((a, b) => a + b, 0) : 1300) + invalid.length * 1700 + 1600;
  // done a second before `until`: the result line holds before the reveal
  // with time to spare (the host allows 4 s + 4.5 s per group) the slams get a little more room
  const spare = prev ? (v.until - 800 - ctx.now()) / natural : 0;
  const pace = !prev ? 0 : spare >= 1 ? Math.min(1.3, spare) : ctx.pace(natural, v.until - 800);

  ctx.head.set({ tab: tr.jinxCheck, guesser: g, blind: pace > 0, tally: v.tally }, !!prev);
  ctx.pool.off(!!prev);
  ctx.pot.show(true, !!prev && pace > 0);

  /** @param {boolean} anim */
  const end = (anim) => {
    // the end state: survivors in the reveal row, the pot after the losses
    L.replaceChildren();
    for (const c of alive) {
      const s = finalSlots.get(c.id);
      if (s) cardEl(c, ctx.person(c.author), { parent: L, down: true, x: s.x, y: s.y, w: s.w, h: s.h, who: s.who, whoLeft: s.whoLeft, font: 44 });
    }
    ctx.pot.set(v.pot);
    ctx.head.set({ tab: tr.jinxCheck, guesser: g, blind: false, tally: v.tally }, false);
    sayResult(anim);
    if (alive.length === 0) stampAt(L, 522, 330, tr.totalJinx, { rot: -6, size: 72, anim });
  };

  /** @param {boolean} anim */
  const sayResult = (anim) => {
    if (alive.length === 0) ctx.host.say(tr.everyCard, { second: tr.jinxedHit, anim });
    else if (lost === 0) ctx.host.say(tr.nobodyAlike(short(g?.name, 12)), { anim });
    else ctx.host.say(tr.lost(lost), { second: tr.leftFor(alive.length, short(g?.name, 12)), anim });
  };

  if (!pace) {
    end(false);
    return {};
  }
  const T = (/** @type {number} */ ms) => ms * pace;

  (async () => {
    ctx.pot.set(v.potBefore, true);
    ctx.host.say(tr.sameClueSmoke);
    /** @type {Map<string, HTMLElement>} */
    const els = new Map();
    v.cards.forEach((c, i) => {
      const s = slots.get(c.id);
      if (!s) return;
      const el = cardEl(c, ctx.person(c.author), { parent: L, down: true, x: s.x, y: s.y, w: s.w, h: s.h, who: s.who, whoLeft: s.whoLeft });
      els.set(c.id, el);
      if (dealt) {
        const dx = 640 - (s.x + s.w / 2);
        const dy = 317 - (s.y + s.h / 2);
        A(el, [{ transform: `translate(${dx}px,${dy}px) rotate(${((i * 37) % 40) - 20}deg) scale(.7)` }, { transform: "none" }], T(460), { delay: T(80 + i * 100) });
        ctx.later(T(80 + i * 100), sfx.slide);
      }
      el.querySelectorAll(".flame").forEach((f) => A(f, [{ transform: "scale(0)" }, { transform: "scale(1)" }], 300, { delay: T(dealt ? 900 : 200), easing: EASE.back }));
    });
    if (v.cards.some((c) => c.bold)) ctx.later(T(dealt ? 920 : 220), sfx.pop);
    if (!(await ctx.wait(T(dealt ? 1300 : 300)))) return;

    // the inspector's magnifying glass sweeps the rows
    const lens = h("div", { class: "lens" });
    lens.innerHTML = `<svg viewBox="0 0 140 140" width="150" height="150"><circle cx="56" cy="56" r="44" fill="rgba(255,255,255,.22)" stroke="#1d1a2b" stroke-width="15"/><circle cx="56" cy="56" r="44" fill="none" stroke="#f6b93b" stroke-width="7"/><path d="M90 90 L128 128" stroke="#1d1a2b" stroke-width="24" stroke-linecap="round"/><path d="M92 92 L125 125" stroke="#a86b32" stroke-width="13" stroke-linecap="round"/></svg>`;
    ctx.fx.append(lens);
    const ys = [...new Set([...slots.values()].map((s) => s.y + s.h / 2))];
    const Lp = (/** @type {number} */ x, /** @type {number} */ y) => `translate(${x - 60}px,${y - 60}px)`;
    /** @type {Keyframe[]} */
    const path = [{ transform: Lp(-80, (ys[0] ?? 300) - 20), offset: 0 }];
    ys.forEach((y, i) => {
      const o = (i + 1) / (ys.length + 1);
      path.push({ transform: Lp(i % 2 ? 860 : 160, y - 10), offset: o - 0.5 / (ys.length + 1) });
      path.push({ transform: Lp(i % 2 ? 160 : 860, y + 10), offset: o });
    });
    path.push({ transform: Lp(1100, 780), offset: 1 });
    A(lens, path, T(1000), { easing: EASE.inout });
    sfx.whoosh();
    ctx.later(T(500), sfx.whoosh);
    removeLater(lens, T(1000) + 20);
    if (!(await ctx.wait(T(1000)))) return;

    let potLeft = v.potBefore - v.pot;
    if (v.groups.length === 0 && invalid.length === 0) {
      ctx.host.say(tr.cleanSweep, { second: tr.nobodyAlikeHit });
      stampAt(L, 522, 330, tr.clean, { cls: "gold", rot: -6, size: 84 });
      ctx.later(200, sfx.sparkle);
      if (!(await ctx.wait(T(1300)))) return;
    }
    const lines = tr.groupLines;
    for (let k = 0; k < v.groups.length; k++) {
      const grp = /** @type {JinxGroup} */ (v.groups[k]);
      const s = Math.pow(0.78, k) * pace;
      const S = (/** @type {number} */ ms) => ms * s;
      ctx.host.say(lines[Math.min(k, lines.length - 1)] ?? "");
      const ids = grp.cards.filter((id) => els.has(id));
      const target = slots.get(ids[0] ?? "");
      if (!target) continue;
      // they meet between them, kept clear of the table's edges
      const ss = ids.map((id) => slots.get(id)).filter((x) => !!x);
      const mx = clamp(ss.reduce((a, x) => a + x.x + x.w / 2, 0) / ss.length, 64 + 190, 980 - 190);
      const my = clamp(ss.reduce((a, x) => a + x.y + x.h / 2, 0) / ss.length, 230, 470);
      const rots = [-10, 6, 13, -5, 9, -13, 3];
      ids.forEach((id, i) => {
        const el = /** @type {HTMLElement} */ (els.get(id));
        const sl = slots.get(id);
        if (!sl) return;
        el.style.zIndex = String(20 + i);
        const off = (i - (ids.length - 1) / 2) * 10;
        const dx = mx + off - (sl.x + sl.w / 2);
        const dy = my + off * 0.6 - (sl.y + sl.h / 2);
        const r = rots[i % rots.length] ?? 0;
        A(el, [
          { transform: "none", easing: EASE.out },
          { offset: 0.32, transform: `translate(${dx * -0.06}px,${dy * -0.06 - 22}px) rotate(${r * -0.4}deg) scale(1.14)`, easing: EASE.in },
          { transform: `translate(${dx}px,${dy}px) rotate(${r}deg) scale(1)` },
        ], S(680));
      });
      sfx.whoosh();
      if (!(await ctx.wait(S(680)))) return;
      sfx.slam();
      shake(k === 0 ? 13 : 9, 380);
      dust(mx, my + 70, 12, 130);
      if (!(await ctx.wait(S(200)))) return;
      sfx.shatter();
      ids.forEach((id, i) => {
        const el = els.get(id);
        if (!el) return;
        const off = (i - (ids.length - 1) / 2) * 10;
        shatter(el, mx + off, my + off * 0.6, rots[i % rots.length] ?? 0, target.w, target.h);
        el.remove();
        els.delete(id);
      });
      if (!(await ctx.wait(S(160)))) return;
      const authors = new Set(grp.cards.map((id) => v.cards.find((c) => c.id === id)?.author));
      const st = stampAt(L, mx, my - 10, authors.size === 1 ? tr.selfJinx : tr.jinx, { rot: -8, size: authors.size === 1 ? 64 : 84 });
      if (!(await ctx.wait(S(330)))) return;
      const tp = tapeAt(L, mx, my + 56, groupReason(grp), { rot: 2 });
      if (!(await ctx.wait(S(400)))) return;
      let fy = my - 70;
      for (const id of grp.cards) {
        const c = v.cards.find((x) => x.id === id);
        if (!c?.bold) continue;
        floatText(mx, fy, tr.boldMinus(short(ctx.person(c.author)?.name, 10)), "minus", 2400);
        fy -= 44;
      }
      const drop = Math.min(potLeft, grp.cards.length);
      potLeft -= drop;
      ctx.pot.drain(ctx.fx, drop, null, S(170));
      if (!(await ctx.wait(S(1000)))) return;
      fadeOut(st, 300);
      fadeOut(tp, 300);
    }
    for (const c of invalid) {
      const el = els.get(c.id);
      const sl = slots.get(c.id);
      if (!el || !sl) continue;
      ctx.host.say(tr.tooCloseLine);
      el.style.zIndex = "20";
      A(el, [{ transform: "none" }, { transform: "translateY(-10px) scale(1.06)" }], T(220));
      if (!(await ctx.wait(T(240)))) return;
      const cx = sl.x + sl.w / 2;
      const cy = sl.y + sl.h / 2;
      const st = stampAt(L, cx, cy, tr.void, { cls: "ink", rot: 6, size: 54 });
      if (!(await ctx.wait(T(320)))) return;
      const tp = tapeAt(L, cx, cy + 50, tr.tooCloseTape, { rot: -2, size: 24 });
      if (!(await ctx.wait(T(700)))) return;
      sfx.shatter();
      shatter(el, cx, cy, 0, sl.w, sl.h);
      el.remove();
      els.delete(c.id);
      if (potLeft > 0) {
        potLeft--;
        ctx.pot.drain(ctx.fx, 1);
      }
      if (!(await ctx.wait(T(400)))) return;
      fadeOut(st, 300);
      fadeOut(tp, 300);
    }
    if (potLeft > 0) ctx.pot.drain(ctx.fx, potLeft, null, 120);

    // clean up: the survivors glide into the reveal row
    if (!(await ctx.wait(T(300)))) return;
    alive.forEach((c, k) => {
      const el = els.get(c.id);
      const a = slots.get(c.id);
      const b = finalSlots.get(c.id);
      if (!el || !a || !b) return;
      el.style.transformOrigin = "0 0";
      A(el, [{ transform: "none" }, { transform: `translate(${b.x - a.x}px,${b.y - a.y}px) scale(${b.w / a.w},${b.h / a.h})` }], T(620), { delay: k * 80, easing: EASE.inout });
      ctx.later(k * 80, sfx.slide);
    });
    if (!(await ctx.wait(T(620) + alive.length * 80 + 100))) return;
    // redraw at the final size (crisp text, the reveal's layout)
    end(true);
    const who = ctx.head.who.firstElementChild;
    if (who) A(who, [{ transform: "scale(1.2)" }, { transform: "scale(1)" }], 300, { easing: EASE.back });
  })();
  return {};
}
