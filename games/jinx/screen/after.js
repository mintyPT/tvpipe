// @ts-check
/**
 * After the verdict: the replay (every card face up, the jinxed ones taped
 * back together, the MVP clue gets a rosette) and the scores (a spiral
 * score pad that re-sorts, the room's count).
 *
 * @typedef {import("../game/views.ts").ReplayScreen} ReplayScreen
 * @typedef {import("../game/views.ts").ScoresScreen} ScoresScreen
 * @typedef {import("../game/views.ts").Card} Card
 * @typedef {import("../game/views.ts").Payout} Payout
 * @typedef {import("../game/views.ts").ScreenView} ScreenView
 * @typedef {import("./tv.js").Ctx} Ctx
 */

import { joinText } from "/_tvpipe/lib/client.js";
import { A, EASE, fitText, h, hm, rnd, short } from "./dom.js";
import { dust, floatText, shake } from "./fx.js";
import { groupReason } from "./jinx.js";
import { cardEl, chip, rosette } from "./pieces.js";
import { sfx } from "./sound.js";
import { t as tr } from "./strings.js";

const CRACK = `<svg viewBox="0 0 196 132" width="100%" height="100%" preserveAspectRatio="none"><path d="M0 50 L42 58 L66 38 L104 70 L140 55 L196 82" fill="none" stroke="#8a7b65" stroke-width="3"/><path d="M104 70 L97 132" fill="none" stroke="#8a7b65" stroke-width="3"/></svg>`;

/** Clean form for "the same word" captions. @param {string | undefined} w */
const clean = (w) => (w ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * @param {Ctx} ctx
 * @param {ReplayScreen} v
 * @param {ScreenView | null} prev
 */
export function replay(ctx, v, prev) {
  const L = ctx.layer;
  const g = ctx.person(v.guesser);
  const gname = short(g?.name, 12);
  const anim = !!prev;
  ctx.head.set({ tab: tr.replayTab(v.round), guesser: g, tally: v.tally }, anim);
  ctx.pot.show(false);
  ctx.pool.off(anim);
  const mark = v.result === "right" ? " ✓" : " ✗";
  ctx.host.say(tr.howWeGot(v.word.toUpperCase(), mark), { anim });

  // units: the survivors in turn order, then each jinx group as a taped stack
  const byId = new Map(v.cards.map((c) => [c.id, c]));
  const alive = v.cards.filter((c) => c.fate !== "jinxed").sort((a, b) => (a.turned ?? 99) - (b.turned ?? 99));
  /** @type {{ cards: Card[], stack: boolean, caption?: string }[]} */
  const units = alive.map((c) => ({ cards: [c], stack: false }));
  const inGroup = new Set();
  for (const grp of v.groups) {
    const cs = grp.cards.map((id) => byId.get(id)).filter((c) => !!c);
    cs.forEach((c) => inGroup.add(c.id));
    const words = new Set(cs.map((c) => clean(c.word)));
    const authors = new Set(cs.map((c) => c.author));
    let caption;
    if (authors.size === 1) caption = tr.selfJinxed(short(ctx.person(cs[0]?.author)?.name, 10));
    else if (words.size === 1) caption = tr.ofYouWrote(cs.length, (cs[0]?.word ?? "").toUpperCase());
    else caption = groupReason(grp);
    units.push({ cards: cs, stack: true, caption });
  }
  // jinxed without a group: too close to the word (the matcher's invalid clues)
  for (const c of v.cards) if (c.fate === "jinxed" && !inGroup.has(c.id)) units.push({ cards: [c], stack: true, caption: tr.tooCloseTape });

  let W = 196;
  let H = 132;
  const OFF = 30;
  const GAP = 34;
  const cardsW = (/** @type {{ cards: Card[] }} */ u) => W + (u.cards.length - 1) * OFF;
  /** A stack's caption is often wider than its cards (24 px uppercase tape). */
  const width = (/** @type {{ cards: Card[], stack: boolean, caption?: string }} */ u) => Math.max(cardsW(u), u.stack ? [...(u.caption ?? "")].length * 16 + 34 : 0);
  /** @type {(typeof units)[]} */
  let rows = [];
  const flow = () => {
    rows = [[]];
    let x = 0;
    for (const u of units) {
      const row = /** @type {typeof units} */ (rows[rows.length - 1]);
      const w = width(u);
      if (row.length && x + GAP + w > 896) {
        rows.push([u]);
        x = w;
      } else {
        x += (row.length ? GAP : 0) + w;
        row.push(u);
      }
    }
  };
  flow();
  if (rows.length > 2) {
    W = 176;
    H = 118;
    flow();
  }
  const ys = rows.length === 1 ? [250] : rows.length === 2 ? [200, 414] : [188, 344, 500];

  /** @type {Map<string, { el: HTMLElement, x: number, y: number }>} */
  const els = new Map();
  let k = 0;
  rows.forEach((row, ri) => {
    const total = row.reduce((s, u) => s + width(u), 0) + (row.length - 1) * GAP;
    let x = 64 + (896 - total) / 2;
    const y = ys[ri] ?? 160;
    for (const u of row) {
      if (!u.stack) {
        const c = /** @type {Card} */ (u.cards[0]);
        const el = cardEl(c, ctx.person(c.author), { parent: L, x, y, w: W, h: H, font: 40 });
        els.set(c.id, { el, x, y });
        if (!c.turned && v.result !== "lost") el.append(h("div", { class: "tape small", style: "left:50%;bottom:2px;transform:translateX(-50%) rotate(-3deg);z-index:6;letter-spacing:.02em" }, tr.notTurned));
        if (anim) {
          A(el, [{ transform: `translateY(500px) rotate(${rnd(-30, 30)}deg)` }, { transform: "none" }], 520, { delay: k * 110 });
          ctx.later(k * 110, sfx.slide);
        }
        k++;
      } else {
        const x0 = x;
        x += (width(u) - cardsW(u)) / 2;
        u.cards.forEach((c, i) => {
          const r = [-6, 4, 9, -3, 7][i % 5] ?? 0;
          const el = cardEl(c, ctx.person(c.author), { parent: L, x: x + i * OFF, y: y + (i % 2) * 8, w: W, h: H, font: 40, who: false, style: `transform:rotate(${r}deg)` });
          el.append(hm("div", { class: "crack" }, CRACK));
          els.set(c.id, { el, x: x + i * OFF, y });
          if (anim) {
            A(el, [{ transform: `translateY(500px) rotate(${rnd(-30, 30)}deg)` }, { transform: `rotate(${r}deg)` }], 520, { delay: k * 110 });
            ctx.later(k * 110, sfx.slide);
          }
          k++;
        });
        const w = cardsW(u);
        const bits = [
          h("div", { class: "tapebit", style: `left:${x - 14}px;top:${y + H - 40}px;transform:rotate(-58deg);z-index:9` }),
          h("div", { class: "tapebit", style: `left:${x + w - 70}px;top:${y - 6}px;transform:rotate(38deg);z-index:9` }),
        ];
        const cap = h("div", { class: "tape small", style: `left:${x + w / 2}px;top:${y + H + 18}px;transform:translateX(-50%) rotate(-1.5deg);z-index:9` }, u.caption ?? "");
        L.append(...bits, cap);
        x = x0;
        if (anim) {
          bits.forEach((b, i) => {
            A(b, [{ opacity: 0, scale: "1.8" }, { opacity: 1, scale: "1" }], 160, { delay: 1100 + i * 180, easing: EASE.in });
            ctx.later(1220 + i * 180, sfx.stamp);
          });
          A(cap, [{ opacity: 0, translate: "0 20px" }, { opacity: 1, translate: "0 0" }], 300, { delay: 1400 });
        }
      }
      x += width(u) + GAP;
    }
  });

  // the right column: this round's points (`payouts`, with the MVP's +3 once picked) and the MVP note
  const note = h("div", { class: "paper note", style: "left:984px;width:232px;top:150px;transform:rotate(1.5deg)" });
  let paysKey = "";
  /** @param {Payout[] | undefined} pays @param {boolean} anim */
  const fillNote = (pays, anim) => {
    const key = JSON.stringify(pays ?? null);
    if (key === paysKey) return;
    const first = !paysKey;
    paysKey = key;
    note.hidden = !pays;
    if (!pays) return;
    /** @type {Map<string, number>} */
    const sums = new Map();
    for (const p of pays) sums.set(p.id, (sums.get(p.id) ?? 0) + p.delta);
    const list = [...sums].filter(([, d]) => d !== 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const lineEls = list.map(([id, d]) =>
      h("div", { class: "line" }, chip(ctx.person(id), 40, { style: "position:relative;flex:none;box-shadow:0 0 0 3px #1d1a2b" }), h("span", { class: "n" }, short(ctx.person(id)?.name, 12)), h("span", { class: d > 0 ? "plus" : "minus" }, d > 0 ? `+${d}` : `−${-d}`)),
    );
    note.replaceChildren(h("div", { class: "k" }, tr.thisRound), ...(lineEls.length ? lineEls : [h("div", { class: "line" }, tr.nobodyScored)]));
    // names fit the note: smaller, then condensed (never cut)
    note.querySelectorAll(".line .n").forEach((n) => fitText(/** @type {HTMLElement} */ (n), 26, 24, 104, 0.6));
    if (anim && first) A(note, [{ transform: "translateX(300px) rotate(8deg)" }, { transform: "rotate(1.5deg)" }], 500, { delay: 600 });
    else if (anim) A(note, [{ transform: "rotate(1.5deg) scale(1.08)" }, { transform: "rotate(1.5deg)" }], 300, { delay: 1200, easing: EASE.back });
  };
  L.append(note);
  fillNote(v.payouts ?? /** @type {Payout[] | undefined} */ (ctx.memo.payouts), anim);
  const mvpNote = h("div", { class: "paper note mvpnote", style: "left:984px;width:232px;top:450px;transform:rotate(-1.5deg)" });
  L.append(mvpNote);
  let mvpShown = "";
  let picking = false;

  /** @param {ReplayScreen} v */
  const noteText = (v) => {
    if (v.mvp) return;
    mvpNote.hidden = v.result !== "right";
    if (v.picking) {
      const s = v.deadline ? Math.max(0, Math.ceil((v.deadline - ctx.now()) / 1000)) : 0;
      mvpNote.replaceChildren(tr.picksThe(gname), h("span", { style: "color:#df4a3c" }, tr.mvpClue), s ? `… ${s}` : "…");
    } else mvpNote.replaceChildren(tr.noMvp);
  };

  /** @param {ReplayScreen} v @param {boolean} anim */
  const render = (v, anim) => {
    if (v.picking && !picking && !v.mvp) {
      picking = true;
      ctx.host.say(tr.whichCracked(gname), { anim });
    }
    noteText(v);
    if (v.mvp && v.mvp !== mvpShown) {
      mvpShown = v.mvp;
      const c = byId.get(v.mvp);
      const at = els.get(v.mvp);
      if (!c || !at) return;
      const author = ctx.person(c.author);
      const r = rosette();
      // on the bottom-left corner, ribbons swung left off the name tab: the sticker, the flame and the turn-order badge stay visible
      const x = at.x - 42;
      const y = at.y + H - 92;
      r.style.left = x + "px";
      r.style.top = y + "px";
      r.style.transform = "rotate(32deg) scale(.65)";
      L.append(r);
      mvpNote.hidden = false;
      // "MVP-HINWEIS" on one line; a long clue ("GEBURTSTAGSKUCHEN") smaller, hyphenated if need be
      const k = h("div", { class: "k", style: "white-space:nowrap;letter-spacing:.04em" }, tr.mvpClueK);
      const word = (c.word ?? "").toUpperCase();
      const wordEl = h("div", { class: "mvpword", style: [...word].length > 10 ? "font-size:28px" : "" }, word);
      mvpNote.replaceChildren(k, wordEl, h("div", { class: "plus" }, `${short(author?.name, 9)} +3`));
      ctx.pool.to(at.x + W / 2, at.y + H / 2, 200, anim);
      ctx.host.say(tr.mvpClueHit, { second: (c.word ?? "").toUpperCase(), anim });
      if (!anim) return;
      sfx.whoosh();
      A(r, [{ transform: "translate(420px,-380px) rotate(80deg) scale(2.4)", opacity: 0 }, { offset: 0.2, opacity: 1 }, { transform: "rotate(32deg) scale(.65)", opacity: 1 }], 520, { easing: EASE.in, delay: 650 });
      ctx.later(1170, () => {
        sfx.stamp();
        shake(7);
        dust(x + 62, y + 62, 10, 110, "#f6b93b");
        const shine = h("div", { class: "shine" }, h("i"));
        at.el.querySelector(".front")?.append(shine);
        if (shine.firstElementChild) A(shine.firstElementChild, [{ transform: "skewX(-20deg) translateX(-120px)" }, { transform: "skewX(-20deg) translateX(380px)" }], 700, { delay: 150, easing: EASE.inout });
        ctx.later(150, sfx.sparkle);
        floatText(at.x + W / 2, at.y - 10, `+3 ${short(author?.name, 10)}`, "plus", 2200);
        A(mvpNote, [{ transform: "rotate(-1.5deg) scale(1.2)" }, { transform: "rotate(-1.5deg) scale(1)" }], 300, { easing: EASE.back });
      });
    } else if (!v.mvp && !v.picking && picking) {
      picking = false;
      ctx.host.say(tr.noMvpLine, { anim });
    }
  };
  render(v, anim);
  ctx.every(1000, () => noteText(v));
  return {
    /** @param {ReplayScreen} nv */
    update(nv) {
      v = nv;
      fillNote(nv.payouts, true);
      render(nv, true);
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * @param {Ctx} ctx
 * @param {ScoresScreen} v
 * @param {ScreenView | null} prev
 */
export function scores(ctx, v, prev) {
  const L = ctx.layer;
  const pace = prev ? ctx.pace(3400, v.until) : 0;
  const anim = pace > 0;
  const T = (/** @type {number} */ ms) => ms * (pace || 1);
  ctx.head.set({}, false);
  ctx.host.clear();
  ctx.pot.show(false);
  ctx.pool.off(!!prev);

  const lines = [...v.lines].sort((a, b) => a.rank - b.rank).slice(0, 8);
  const before = [...lines].sort((a, b) => b.score - b.delta - (a.score - a.delta) || a.rank - b.rank);
  const pad = h("div", { class: "pad paper" },
    h("div", { class: "binding" }, ...Array.from({ length: 9 }, (_, i) => h("i", { style: `left:${40 + i * 68}px` }))),
    h("div", { class: "margin" }),
    h("h2", null, tr.scores, h("span", null, tr.afterRound(v.round, v.rounds))));
  L.append(pad);
  const order = anim ? before : lines;
  /** @type {Map<string, { r: HTMLElement, i: number, t: HTMLElement, d: HTMLElement, rank: HTMLElement }>} */
  const rows = new Map();
  order.forEach((l, i) => {
    const d = l.delta;
    const dEl = h("div", { class: `d ${d > 0 ? "plus" : d < 0 ? "minus" : "zero"}` }, d > 0 ? `+${d}` : d < 0 ? `−${-d}` : "–");
    const tEl = h("div", { class: "t" }, String(anim ? l.score - l.delta : l.score));
    const rank = h("div", { class: "rank" }, String(anim ? i + 1 : l.rank));
    const r = h("div", { class: `prow${!anim && l.rank === 1 && l.score > 0 ? " first" : ""}`, style: `top:${120 + i * 64}px` }, rank, chip(ctx.person(l.id), 46), h("div", { class: "n" }, short(ctx.person(l.id)?.name, 16)), dEl, tEl);
    pad.append(r);
    rows.set(l.id, { r, i, t: tEl, d: dEl, rank });
    if (anim) dEl.style.clipPath = "inset(0 100% 0 0)";
  });

  const t = v.tally;
  const n = Math.max(t.total, t.history.length);
  const small = n > 10;
  const slots = h("div", { class: `slots${small ? " small" : ""}` });
  for (let i = 0; i < n; i++) {
    const s = t.history[i];
    slots.append(h("i", { class: s === "found" ? "won" : s === "missed" ? "lost" : "todo" }, s === "found" ? "✓" : s === "missed" ? "✕" : ""));
  }
  const nextP = v.next ? ctx.person(v.next) : undefined;
  const ratio = t.played ? t.found / t.played : 0;
  const quip = t.played && t.found === t.played ? tr.onFire(t.found, t.played) : ratio >= 0.5 ? tr.inSync : t.found === 0 ? tr.nothingYet : tr.mixed;
  const room = h("div", { class: "room" },
    h("div", { class: "k" }, tr.together),
    h("div", { class: "big" }, String(t.found), h("span", null, tr.ofN(t.played))),
    h("div", { class: "sub" }, quip),
    slots,
    v.next
      ? h("div", { class: "next" }, h("span", { class: "dim" }, tr.nextUp), chip(nextP, 72, { style: "position:relative" }), tr.guesses(short(nextP?.name, 10)))
      : h("div", { class: "next" }, tr.thatsTheGame));
  L.append(room);
  // newcomers may join for the next round
  const j = ctx.join;
  const link = joinText(j);
  if (v.next && link && j?.lateJoin && j.lateJoin !== "closed") room.append(h("div", { class: "joinline" }, tr.joiningLate, h("b", null, link)));
  if (!anim) return {};

  A(pad, [{ transform: "translateY(760px) rotate(6deg)" }, { transform: "rotate(-1deg)" }], T(620), { easing: EASE.back });
  sfx.slide();
  A(room, [{ transform: "translateX(500px)", opacity: 0 }, { transform: "none", opacity: 1 }], T(520), { delay: T(200) });
  (async () => {
    if (!(await ctx.wait(T(700)))) return;
    let k = 0;
    for (const l of order) {
      const row = rows.get(l.id);
      if (!row) continue;
      A(row.d, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], 240, { delay: k * T(100), easing: EASE.inout });
      if (l.delta) ctx.later(k * T(100), sfx.marker);
      k++;
    }
    if (!(await ctx.wait(k * T(100) + T(300)))) return;
    for (const l of order) {
      const row = rows.get(l.id);
      if (!row || !l.delta) continue;
      const a = l.score - l.delta;
      const steps = Math.min(Math.abs(l.delta), 12);
      for (let s = 1; s <= steps; s++) ctx.later((s * T(500)) / steps, () => (row.t.textContent = String(Math.round(a + (l.delta * s) / steps))));
      A(row.t, [{ transform: "scale(1)" }, { transform: "scale(1.3)" }, { transform: "scale(1)" }], T(500), { fill: "none" });
    }
    sfx.clink();
    ctx.later(200, sfx.clink);
    if (!(await ctx.wait(T(700)))) return;
    lines.forEach((l, ni) => {
      const row = rows.get(l.id);
      if (!row) return;
      const i = row.i;
      if (ni !== i) {
        row.r.style.zIndex = ni < i ? "3" : "1";
        A(row.r, [{ transform: "none" }, { offset: 0.5, transform: `translateY(${(ni - i) * 32}px) scale(${ni < i ? 1.04 : 0.98})` }, { transform: `translateY(${(ni - i) * 64}px)` }], T(700), { easing: EASE.inout });
        if (ni < i) ctx.later(T(700), () => floatText(380, 120 + ni * 64 + 50 + 8, `▲${i - ni}`, "plus", 1500));
      }
    });
    sfx.whoosh();
    if (!(await ctx.wait(T(720)))) return;
    for (const l of lines) {
      const row = rows.get(l.id);
      if (!row) continue;
      row.rank.textContent = String(l.rank);
      row.t.textContent = String(l.score);
    }
    const first = lines[0] ? rows.get(lines[0].id) : undefined;
    if (first && (lines[0]?.score ?? 0) > 0) {
      first.r.classList.add("first");
      A(first.r, [{ backgroundColor: "#fbf1dc" }, { backgroundColor: "#fde7a6" }], 300);
      sfx.pop();
    }
  })();
  return {};
}
