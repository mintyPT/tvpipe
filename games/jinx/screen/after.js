// @ts-check
/**
 * After the verdict: the replay (every card face up, the jinxed ones taped
 * back together, the best clue gets a rosette: the guesser's thank-you,
 * no points). The bank between rounds is bank.js.
 *
 * @typedef {import("../game/views.ts").ReplayScreen} ReplayScreen
 * @typedef {import("../game/views.ts").Card} Card
 * @typedef {import("../game/views.ts").ScreenView} ScreenView
 * @typedef {import("./tv.js").Ctx} Ctx
 */

import { A, EASE, fitText, h, hm, rnd, short } from "./dom.js";
import { dust, shake } from "./fx.js";
import { groupReason } from "./jinx.js";
import { clearOfJoin } from "./layout.js";
import { cardEl, chip, fitRosette, rosette } from "./pieces.js";
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
  ctx.head.set({ tab: tr.replayTab(v.round), guesser: g, tally: v.tally, bank: v.bank.chips }, anim);
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
    const y = ys[ri] ?? 160;
    // a row under the join badge's top moves right of it (the right column starts at 985)
    let x = clearOfJoin(64 + (896 - total) / 2, total, y + H + 60, 975);
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

  // the right column: what the room banked this round, and the best clue
  const note = h("div", { class: "paper note", style: "left:984px;width:232px;top:150px;transform:rotate(1.5deg)" });
  const d = v.banked;
  note.append(
    h("div", { class: "k" }, tr.thisRound),
    h("div", { class: `bignum ${d > 0 ? "plus" : d < 0 ? "minus" : "zero"}` }, d > 0 ? `+${d}` : d < 0 ? `−${-d}` : "±0"),
    h("div", { class: "line center" }, h("div", { class: "minichips" }, h("i"), h("i"), h("i")), h("span", null, tr.bankIs(v.bank.chips))),
  );
  L.append(note);
  if (anim) A(note, [{ transform: "translateX(300px) rotate(8deg)" }, { transform: "rotate(1.5deg)" }], 500, { delay: 600 });
  const bestNote = h("div", { class: "paper note bestnote", style: "left:984px;width:232px;top:400px;transform:rotate(-1.5deg)" });
  L.append(bestNote);
  let bestShown = "";
  let picking = false;

  /** @param {ReplayScreen} v */
  const noteText = (v) => {
    if (v.best) return;
    bestNote.hidden = v.result !== "right";
    if (v.picking) {
      const s = v.deadline ? Math.max(0, Math.ceil((v.deadline - ctx.now()) / 1000)) : 0;
      bestNote.replaceChildren(tr.picksThe(gname), h("span", { style: "color:#df4a3c" }, tr.bestClueLower), s ? `… ${s}` : "…");
    } else bestNote.replaceChildren(tr.noBest);
  };

  /** @param {ReplayScreen} v @param {boolean} anim */
  const render = (v, anim) => {
    if (v.picking && !picking && !v.best) {
      picking = true;
      ctx.host.say(tr.whichCracked(gname), { anim });
    }
    noteText(v);
    if (v.best && v.best !== bestShown) {
      bestShown = v.best;
      const c = byId.get(v.best);
      const at = els.get(v.best);
      if (!c || !at) return;
      const author = ctx.person(c.author);
      // a small rosette with a heart on the card's bottom-left corner, ribbons swung left off the name tab
      const r = rosette();
      const x = at.x - 42;
      const y = at.y + H - 92;
      r.style.left = x + "px";
      r.style.top = y + "px";
      r.style.transform = "rotate(32deg) scale(.65)";
      L.append(r);
      // the note: a big rosette that says BEST CLUE, the clue, its author
      const big = rosette({ d: 150, label: true });
      big.style.left = "41px";
      big.style.top = "-70px";
      const word = (c.word ?? "").toUpperCase();
      const wordEl = h("div", { class: "bestword" }, word);
      const who = h("div", { class: "line center" }, chip(author, 40, { style: "position:relative;flex:none;box-shadow:0 0 0 3px #1d1a2b" }), h("span", { class: "n" }, tr.thanks(short(author?.name, 10))));
      bestNote.hidden = false;
      bestNote.classList.add("has-rosette");
      bestNote.replaceChildren(big, wordEl, who);
      fitRosette(big);
      fitText(wordEl, 36, 24, 200, 0.6);
      const n = /** @type {HTMLElement} */ (who.querySelector(".n"));
      fitText(n, 26, 24, 150, 0.6);
      ctx.pool.to(at.x + W / 2, at.y + H / 2, 200, anim);
      ctx.host.say(tr.bestClueHit, { second: word, anim });
      if (!anim) return;
      sfx.whoosh();
      A(r, [{ transform: "translate(420px,-380px) rotate(80deg) scale(2.4)", opacity: 0 }, { offset: 0.2, opacity: 1 }, { transform: "rotate(32deg) scale(.65)", opacity: 1 }], 520, { easing: EASE.in, delay: 650 });
      A(bestNote, [{ transform: "translateX(300px) rotate(-8deg)" }, { transform: "rotate(-1.5deg)" }], 460, { delay: 1100, easing: EASE.back });
      ctx.later(1170, () => {
        sfx.stamp();
        shake(7);
        dust(x + 62, y + 62, 10, 110, "#f6b93b");
        const shine = h("div", { class: "shine" }, h("i"));
        at.el.querySelector(".front")?.append(shine);
        if (shine.firstElementChild) A(shine.firstElementChild, [{ transform: "skewX(-20deg) translateX(-120px)" }, { transform: "skewX(-20deg) translateX(380px)" }], 700, { delay: 150, easing: EASE.inout });
        ctx.later(150, sfx.sparkle);
        // the author's chip on the card beams
        const st = at.el.querySelector(".front .sticker");
        if (st) A(st, [{ transform: "none" }, { transform: "translateY(-14px) scale(1.25)" }, { transform: "none" }], 500, { delay: 200, easing: EASE.back, fill: "none" });
      });
    } else if (!v.best && !v.picking && picking) {
      picking = false;
      ctx.host.say(tr.noBestLine, { anim });
    }
  };
  render(v, anim);
  ctx.every(1000, () => noteText(v));
  return {
    /** @param {ReplayScreen} nv */
    update(nv) {
      v = nv;
      render(nv, true);
    },
  };
}
