// @ts-check
/**
 * The end of the game, in the host's steps; everything is about the room,
 * nobody comes first: `room` (the bank's meter fills past its marks, the
 * chips in wooden tiles, the title stamp, "New record!", the words of the
 * night), `clues` (the best clues of the night pinned up with their
 * authors' chips), `awards` (cards flipped one by one) and `web` (the
 * evening as a red-yarn board).
 *
 * @typedef {import("../game/views.ts").EndScreen} EndScreen
 * @typedef {import("../game/views.ts").Award} Award
 * @typedef {import("../game/views.ts").ScreenView} ScreenView
 * @typedef {import("./tv.js").Ctx} Ctx
 */

import { meter } from "./bank.js";
import { joinRoom, rowLefts } from "./layout.js";
import { A, EASE, clamp, fitLines, fitText, h, hm, short, svg } from "./dom.js";
import { confetti, shake, stampAt } from "./fx.js";
import { INK, cardEl, chip } from "./pieces.js";
import { sfx } from "./sound.js";
import { t as tr } from "./strings.js";

/**
 * @param {Ctx} ctx
 * @param {EndScreen} v
 * @param {ScreenView | null} prev
 */
export function end(ctx, v, prev) {
  ctx.head.set({}, false);
  ctx.host.clear();
  ctx.pot.show(false);
  let step = "";
  /** @type {HTMLElement | null} */
  let box = null;

  /** @param {EndScreen} v @param {boolean} anim */
  const show = (v, anim) => {
    if (v.step === step) return;
    step = v.step;
    const old = box;
    if (old) {
      A(old, [{ transform: "none", opacity: 1 }, { transform: "translateY(120px)", opacity: 0 }], 420, { easing: EASE.in });
      setTimeout(() => old.remove(), 440);
    }
    box = h("div", { class: "abs", style: "inset:0" });
    ctx.layer.append(box);
    ctx.pool.off(anim);
    const b = box;
    const go = () => {
      if (!ctx.alive()) return;
      if (v.step === "room") room(ctx, b, v, anim);
      else if (v.step === "clues") clues(ctx, b, v, anim);
      else if (v.step === "awards") awards(ctx, b, v, anim);
      else web(ctx, b, v, anim);
    };
    if (old && anim) ctx.later(300, go);
    else go();
  };
  show(v, !!prev);
  return {
    /** @param {EndScreen} nv */
    update(nv) {
      show(nv, true);
    },
  };
}

/** @param {HTMLElement} box @param {string} text */
function tab(box, text) {
  box.append(h("div", { class: "tab paper center" }, text));
}

/**
 * The room: the meter fills to the bank, the chips land in wooden tiles,
 * the title stamp, a new record, the words of the night.
 * @param {Ctx} ctx @param {HTMLElement} box @param {EndScreen} v @param {boolean} anim
 */
function room(ctx, box, v, anim) {
  tab(box, tr.endRoom);
  const chips = v.bank.chips;
  const t = v.tally;
  const m = meter(box, v.bank, { x: 240, top: 112, height: 560, from: anim ? 0 : chips });
  const CX = 950;
  const W = 520;
  // the meter fills while the tiles and the words land; the title stamps when both are done
  const fillMs = Math.min(1800, 600 + chips * 25);
  const at = { tiles: 700, words: 1300 };

  const tiles = h("div", { class: "bigtiles mid", style: `top:112px;left:${CX - W / 2}px;right:auto;width:${W}px` });
  tiles.append(...[...String(chips)].map((d) => h("div", { class: "tile" }, d)));
  const cap = h("div", { class: "caption", style: `top:236px;left:${CX - W / 2}px;right:auto;width:${W}px;white-space:nowrap` }, tr.bankCaption(chips, t.found, Math.max(t.played, v.words.length)));
  box.append(tiles, cap);
  fitText(cap, 28, 24, W, 0.7);
  const rots = [-3, 2, -2, 3, -1];
  [...tiles.children].forEach((el, i) => {
    const e = /** @type {HTMLElement} */ (el);
    e.style.transform = `rotate(${rots[i % 5]}deg)`;
    if (!anim) return;
    A(e, [{ transform: "translateY(-300px) rotate(-25deg)", opacity: 0 }, { transform: e.style.transform, opacity: 1 }], 420, { delay: at.tiles + i * 140, easing: EASE.back });
    ctx.later(at.tiles + 200 + i * 140, sfx.thunk);
  });
  if (anim) A(cap, [{ opacity: 0 }, { opacity: 1 }], 300, { delay: at.tiles + 400 });

  // the words of the night, under the title
  const words = v.words.slice(0, 16);
  const perRow = words.length > 12 ? 4 : 3;
  const cw = perRow === 4 ? 120 : 164;
  const gapX = 14;
  const rowsN = Math.max(1, Math.ceil(words.length / perRow));
  const top = 418;
  const ch = Math.min(62, Math.floor((684 - top - (rowsN - 1) * 10) / rowsN));
  words.forEach((w, i) => {
    const col = i % perRow;
    const r = Math.floor(i / perRow);
    const inRow = Math.min(perRow, words.length - r * perRow);
    const x = CX + (col - (inRow - 1) / 2) * (cw + gapX) - cw / 2;
    const y = top + r * (ch + 10);
    const a = ((i * 7) % 5) - 2;
    const c = h("div", { class: `mc ${w.found ? "won" : "lost"}`, style: `left:${x}px;top:${y}px;width:${cw}px;height:${ch}px;transform:rotate(${a}deg);z-index:${i}` }, h("span", null, w.word.toUpperCase()));
    box.append(c);
    // long compounds ("GEBURTSTAGSKUCHEN") condense further than clue cards: the card is small
    fitLines(/** @type {HTMLElement} */ (c.firstElementChild), 28, 24, cw - 18, 0.5, ch - 4);
    if (anim) {
      A(c, [{ transform: `translate(${CX - x - cw / 2}px,420px) rotate(${a * 8}deg)` }, { transform: `rotate(${a}deg)` }], 480, { delay: at.words + i * 80 });
      ctx.later(at.words + i * 80, sfx.slide);
    }
  });

  // the title stamp, and a new record
  const title = tr.titles[v.title] ?? `${v.title}!`;
  /** @param {boolean} a */
  const stamps = (a) => {
    const st = stampAt(box, CX, 312, title, { cls: "gold", rot: -4, size: 52, anim: a, shakePx: a ? 6 : undefined });
    if (st.offsetWidth > W - 10) st.style.fontSize = `${Math.max(36, Math.floor((52 * (W - 10)) / st.offsetWidth))}px`;
    if (!v.record) return;
    const rec = () => stampAt(box, CX + 110, 376, tr.newRecord, { rot: 5, size: 28, anim: a });
    if (!a) {
      rec();
      return;
    }
    ctx.later(800, () => {
      rec();
      confetti(CX + 110, 370, 40, 1.1);
      sfx.fanfare();
    });
  };
  const stampAtMs = Math.max(600 + fillMs, at.words + words.length * 80 + 300) + 200;
  if (anim) {
    A(m.el, [{ transform: "translateY(760px) rotate(4deg)" }, { transform: "none" }], 560, { easing: EASE.back });
    ctx.later(600, () => m.to(chips, fillMs, { alive: () => ctx.alive() }));
    ctx.later(stampAtMs, () => {
      stamps(true);
      ctx.later(200, () => confetti(CX, 330, 30));
      ctx.later(200, sfx.fanfare);
    });
  } else stamps(false);
}

/**
 * The best clues of the night, pinned up: the clue on a card with its
 * author's chip and name, the word it led to on tape.
 * @param {Ctx} ctx @param {HTMLElement} box @param {EndScreen} v @param {boolean} anim
 */
function clues(ctx, box, v, anim) {
  tab(box, tr.endClues);
  box.append(h("div", { class: "caption dimtext", style: "top:104px" }, tr.cluesSub));
  const list = v.clues.slice(0, 8);
  const rows = list.length > 4 ? [list.slice(0, Math.ceil(list.length / 2)), list.slice(Math.ceil(list.length / 2))] : [list];
  const W = list.length > 4 ? 220 : 240;
  const H = list.length > 4 ? 140 : 160;
  const gap = 56;
  const ys = rows.length === 1 ? [290] : [200, 460];
  let k = 0;
  rows.forEach((row, ri) => {
    const y = ys[ri] ?? 200;
    // a row under the join badge's top moves right of it
    const lefts = rowLefts(row.length, W, gap, { bottom: y + H + 20 });
    row.forEach((b, i) => {
      const x = lefts[i] ?? 640;
      const rot = ((k * 5) % 7) - 3;
      const wrap = h("div", { class: "abs", style: `left:0;top:0;width:1280px;height:720px;transform-origin:${x + W / 2}px ${y + H / 2}px` });
      box.append(wrap);
      const el = cardEl({ id: `best${k}`, author: b.author, bold: false, word: b.clue }, ctx.person(b.author), { parent: wrap, x, y, w: W, h: H, font: 40, style: `transform:rotate(${rot}deg)` });
      const tp = h("div", { class: "tape small bestfor", style: `left:44px;top:-22px;transform-origin:left center` }, tr.forWord(b.word.toUpperCase()));
      el.append(tp);
      // right of the author's chip, over the card's top edge (a little past its right edge if need be)
      fitText(tp, 24, 24, W - 24, 0.6);
      tp.style.transform = `rotate(${-rot - 2}deg) ${tp.style.transform}`;
      if (anim) {
        const d = 300 + k * 320;
        A(wrap, [{ transform: "translateY(-60px) scale(1.5)", opacity: 0 }, { transform: "none", opacity: 1 }], 300, { delay: d, easing: EASE.in });
        ctx.later(d + 260, sfx.thwap);
        A(tp, [{ clipPath: "inset(-12px 100% -12px -12px)" }, { clipPath: "inset(-12px -12px -12px -12px)" }], 260, { delay: d + 360, easing: EASE.inout });
        ctx.later(d + 360, sfx.zip);
      }
      k++;
    });
  });
  if (anim && list.length) ctx.later(400 + list.length * 320, () => shake(4));
}

/** @type {Record<Award["kind"], string>} */
const ICONS = {
  "mind meld": `<svg viewBox="0 0 110 90"><circle cx="40" cy="45" r="32" fill="#ff7a5c" stroke="${INK}" stroke-width="5"/><circle cx="70" cy="45" r="32" fill="#8bd648" fill-opacity=".85" stroke="${INK}" stroke-width="5"/><path d="M55 18 A32 32 0 0 1 55 72 A32 32 0 0 1 55 18 Z" fill="${INK}"/></svg>`,
  telepath: `<svg viewBox="0 0 110 90"><path d="M55 4 L55 16 M22 12 L30 22 M88 12 L80 22 M6 34 L18 38 M104 34 L92 38" stroke="${INK}" stroke-width="5" stroke-linecap="round"/><path d="M10 56 Q55 14 100 56 Q55 98 10 56 Z" fill="#fbf1dc" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/><circle cx="55" cy="56" r="19" fill="#4aa8f5" stroke="${INK}" stroke-width="4"/><circle cx="55" cy="56" r="8" fill="${INK}"/><circle cx="61" cy="50" r="4" fill="#fbf1dc"/></svg>`,
};

/**
 * @param {Ctx} ctx @param {HTMLElement} box @param {EndScreen} v @param {boolean} anim
 */
function awards(ctx, box, v, anim) {
  tab(box, tr.endAwards);
  const list = v.awards.slice(0, 3);
  if (list.length === 0) {
    box.append(h("div", { class: "caption", style: "top:320px;font-size:36px" }, tr.noAwards[0], h("b", null, tr.noAwards[1])));
    return;
  }
  // 320 px cards, 50 apart; right of the join badge (the cards reach down to 600)
  const xs = rowLefts(list.length, 320, 50, { bottom: 610 });
  const bursts = h("div", { class: "abs", style: "inset:0" });
  box.append(bursts);
  const cards = list.map((a, i) => {
    const x = xs[i] ?? 480;
    const y = 140;
    const tilt = (i - (list.length - 1) / 2) * 2;
    const burst = h("div", { class: "burst", style: `left:${x + 160 - 260}px;top:${y + 230 - 260}px;transform:scale(${anim ? 0 : 1})` });
    const names = a.ids.map((id) => short(ctx.person(id)?.name, 10)).join(tr.and);
    const el = h("div", { class: `award${anim ? "" : " up"}`, style: `left:${x}px;top:${y}px;transform:rotate(${tilt}deg)` },
      h("div", { class: "flip" },
        h("div", { class: "face front" }, h("h3", null, tr.awards[a.kind] ?? a.kind), hm("div", { class: "icon" }, ICONS[a.kind] ?? ""), h("div", { class: "winners" }, ...a.ids.slice(0, 2).map((id) => chip(ctx.person(id), 68, { style: "position:relative" }))), h("div", { class: "names" }, names), h("div", { class: "stat" }, tr.awardStat(a))),
        h("div", { class: "face back" }, h("b", null, "?"))));
    bursts.append(burst);
    box.append(el);
    const nm = /** @type {HTMLElement} */ (el.querySelector(".names"));
    fitText(nm, 30, 24, 280, 0.7);
    // "Seelenverwandt": the title fits the card
    fitText(/** @type {HTMLElement} */ (el.querySelector("h3")), 40, 28, 276, 0.8);
    if (anim) {
      A(el, [{ transform: `translateY(560px) rotate(${tilt * 10}deg)` }, { transform: `rotate(${tilt}deg)` }], 560, { delay: 150 + i * 150 });
      ctx.later(150 + i * 150, sfx.slide);
    }
    return { el, burst, tilt };
  });
  if (!anim) return;
  (async () => {
    if (!(await ctx.wait(1200))) return;
    for (const c of cards) {
      sfx.drumroll(600);
      A(c.el, [{ transform: `rotate(${c.tilt}deg)` }, { transform: `translateY(-20px) rotate(${c.tilt}deg) scale(1.04)` }], 300, { delay: 300 });
      if (!(await ctx.wait(650))) return;
      sfx.whoosh();
      ctx.later(250, sfx.flipTick);
      const flip = c.el.querySelector(".flip");
      if (flip) A(flip, [{ transform: "rotateY(180deg)" }, { transform: "rotateY(0)" }], 650, { easing: EASE.inout });
      A(c.el, [{ transform: `translateY(-20px) rotate(${c.tilt}deg) scale(1.04)` }, { offset: 0.5, transform: "translateY(-40px) scale(1.14)" }, { transform: `rotate(${c.tilt}deg)` }], 650, { easing: EASE.inout });
      A(c.burst, [{ transform: "scale(0) rotate(-30deg)" }, { transform: "scale(1) rotate(0)" }], 600, { delay: 300, easing: EASE.back });
      if (!(await ctx.wait(640))) return;
      c.el.classList.add("up");
      sfx.thwap();
      sfx.fanfare();
      shake(4);
      c.el.querySelectorAll(".winners .token").forEach((t, k) => A(t, [{ transform: "translateY(-30px) scale(1.4)", opacity: 0 }, { transform: "none", opacity: 1 }], 320, { delay: k * 120, easing: EASE.back }));
      if (!(await ctx.wait(900))) return;
    }
  })();
}

/**
 * Where the words lie: a grid that fills the table, rows centred, the
 * cards as large as fit (row gaps leave room for the shared clues' tags).
 * @param {number} n @param {boolean} hubs
 */
function webGrid(n, hubs) {
  const join = joinRoom();
  const rows = n <= 4 ? 1 : n <= 10 ? 2 : n <= 12 ? 3 : 4;
  const perRow = Math.ceil(n / rows);
  const top = 112;
  const H = 684 - top;
  const gapX = 30;
  const gapY = hubs ? (rows <= 2 ? 120 : 56) : rows <= 2 ? 48 : 30;
  const h = Math.min(rows === 1 ? 230 : 196, Math.floor((H - (rows - 1) * gapY) / rows));
  const y0 = top + (H - (rows * h + (rows - 1) * gapY)) / 2;
  // the last row right of the join badge when it reaches below the badge's top (the cards a little narrower for it)
  const lastIn = n - (rows - 1) * perRow;
  const under = !!join && y0 + rows * h + (rows - 1) * gapY > join.top;
  const lastLeft = under && join ? Math.max(64, join.right) : 64;
  const w = Math.min(300, Math.floor((1152 - (perRow - 1) * gapX) / perRow), Math.floor((1216 - lastLeft - (lastIn - 1) * gapX) / lastIn));
  /** @type {{ x: number, y: number }[]} centres */
  const out = [];
  // the bands where shared clues' tags go: between the rows, else above and below the one row
  /** @type {number[]} */
  const bands = [];
  for (let r = 1; r < rows; r++) bands.push(y0 + r * h + (r - 0.5) * gapY);
  if (rows === 1) bands.push(Math.max(140, y0 - 50), Math.min(650, y0 + h + 50));
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(perRow, n - r * perRow);
    const rowW = inRow * w + (inRow - 1) * gapX;
    const x0 = r === rows - 1 && under ? Math.max(640 - rowW / 2, lastLeft) : 640 - rowW / 2;
    for (let c = 0; c < inRow; c++) out.push({ x: x0 + c * (w + gapX) + w / 2, y: y0 + r * (h + gapY) + h / 2 });
  }
  return { spots: out, w, h, bands };
}

/** Clean form of a clue, for matching links with a word's clues. @param {string} s */
const key = (s) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The word web: every word of the night as a card with its clues; clues
 * used for several words are tags in between, tied to them with red yarn.
 * @param {Ctx} ctx @param {HTMLElement} box @param {EndScreen} v @param {boolean} anim
 */
function web(ctx, box, v, anim) {
  const tabEl = h("div", { class: "tab paper", style: "left:64px;top:36px" }, tr.wordWeb);
  box.append(tabEl);
  const words = v.web.words.slice(0, 16);
  const nWords = words.length;
  const links = v.web.links
    .map((l) => ({ ...l, words: l.words.filter((i) => i < nWords) }))
    .filter((l) => l.words.length > 1)
    .sort((a, b) => b.words.length - a.words.length)
    .slice(0, 10);
  const sub = links.length ? tr.webLinked(nWords) : tr.webAlone(nWords);
  const subEl = h("div", { class: "abs dimtext", style: "left:330px;top:46px;right:64px;white-space:nowrap;overflow:hidden" }, sub);
  box.append(subEl);
  // the line starts after the tab (its width differs by language) and fits the rest
  const left = Math.max(330, 64 + tabEl.offsetWidth + 30);
  subEl.style.left = `${left}px`;
  fitText(subEl, parseFloat(getComputedStyle(subEl).fontSize) || 26, 24, 1216 - left, 0.8);
  const { spots: grid, w: cw, h: ch, bands } = webGrid(Math.max(nWords, 1), links.length > 0);
  const C = { x: 640, y: 398 };

  // words that share a clue sit near each other: swap slots while the yarn gets shorter
  const slotOf = words.map((_, i) => i);
  const yarn = () => {
    let sum = 0;
    for (const l of links) {
      const ps = l.words.map((i) => grid[slotOf[i] ?? 0] ?? C);
      const mx = ps.reduce((a, p) => a + p.x, 0) / ps.length;
      const my = ps.reduce((a, p) => a + p.y, 0) / ps.length;
      for (const p of ps) sum += Math.hypot(p.x - mx, p.y - my);
    }
    return sum;
  };
  let best = yarn();
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let it = 0; it < 400 && links.length && nWords > 2; it++) {
    const a = Math.floor(rnd() * nWords);
    const b = Math.floor(rnd() * nWords);
    if (a === b) continue;
    [slotOf[a], slotOf[b]] = [slotOf[b] ?? 0, slotOf[a] ?? 0];
    const y = yarn();
    if (y < best) best = y;
    else [slotOf[a], slotOf[b]] = [slotOf[b] ?? 0, slotOf[a] ?? 0];
  }
  const spots = words.map((_, i) => grid[slotOf[i] ?? i] ?? C);

  // hubs: in the band nearest the middle of their words, side by side without overlap
  const all = links.map((l) => {
    const ps = l.words.map((i) => spots[i] ?? C);
    const mx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
    const my = ps.reduce((s, p) => s + p.y, 0) / ps.length;
    const y = bands.reduce((b, y) => (Math.abs(y - my) < Math.abs(b - my) ? y : b), bands[0] ?? my);
    return { l, x: mx, y, w: Math.min(380, 34 + [...l.clue].length * 19) };
  });
  // a band holds the tags that fit side by side (the links shared by the most words first): no tag over another
  /** @type {Map<number, number>} */
  const used = new Map();
  const hubs = all.filter((hb) => {
    const w = (used.get(hb.y) ?? 0) + hb.w + 60;
    if (w > 1152 + 20) return false;
    used.set(hb.y, w);
    return true;
  });
  for (const band of new Set(hubs.map((hb) => hb.y))) {
    const row = hubs.filter((hb) => hb.y === band).sort((a, b) => a.x - b.x);
    for (let it = 0; it < 30; it++) {
      for (let i = 1; i < row.length; i++) {
        const a = /** @type {(typeof row)[0]} */ (row[i - 1]);
        const b = /** @type {(typeof row)[0]} */ (row[i]);
        const over = (a.w + b.w) / 2 + 20 - (b.x - a.x);
        if (over > 0) {
          a.x -= over / 2;
          b.x += over / 2;
        }
      }
      for (const hb of row) hb.x = clamp(hb.x, 64 + hb.w / 2, 1216 - hb.w / 2);
    }
  }

  const s = /** @type {SVGSVGElement} */ (svg("svg", { viewBox: "0 0 1280 720", class: "yarn" }));
  box.append(s);
  /** @type {[SVGPathElement, number][][]} */
  const strings = hubs.map((hb) =>
    hb.l.words.map((i) => {
      const p = spots[i] ?? C;
      const mx = (hb.x + p.x) / 2;
      const my = (hb.y + p.y) / 2 + 26;
      const path = /** @type {SVGPathElement} */ (svg("path", { d: `M${hb.x} ${hb.y} Q${mx} ${my} ${p.x} ${p.y}`, fill: "none", stroke: "#df4a3c", "stroke-width": 5, "stroke-linecap": "round" }));
      s.append(path);
      const L = path.getTotalLength();
      if (anim) {
        path.style.strokeDasharray = String(L);
        path.style.strokeDashoffset = String(L);
      }
      return /** @type {[SVGPathElement, number]} */ ([path, L]);
    }),
  );
  const linked = new Set(links.map((l) => key(l.clue)));
  words.forEach((w, i) => {
    const p = spots[i] ?? C;
    const rot = ((i * 7) % 5) - 2;
    const own = w.clues.filter((c) => !linked.has(key(c)));
    const word = h("div", { class: "ww" }, w.word.toUpperCase());
    // clues stay whole on a line: spaces inside a clue do not break
    const clues = h("div", { class: "wc" }, own.map((c) => c.replace(/ /g, "\u00a0")).join("\u00a0· "));
    const c = h("div", { class: `wcard ${w.found ? "won" : "lost"}`, style: `left:${p.x - cw / 2}px;top:${p.y - ch / 2}px;width:${cw}px;height:${ch}px;transform:rotate(${rot}deg)` }, word, own.length ? clues : null);
    if (!w.found) c.append(h("div", { class: "missed" }, tr.missed));
    box.append(c);
    fitLines(word, ch >= 150 ? 40 : 32, 26, cw - 24, 0.6);
    if (own.length) fitClues(clues, ch - word.offsetHeight - 26);
    if (anim) {
      A(c, [{ transform: "scale(1.5) rotate(-12deg)", opacity: 0 }, { transform: `rotate(${rot}deg)`, opacity: 1 }], 300, { delay: 200 + i * 80, easing: EASE.in });
      ctx.later(380 + i * 80, sfx.thwap);
    }
  });
  const tags = hubs.map((hb) => {
    const label = h("span", null, hb.l.clue.toUpperCase());
    const e = h("div", { class: "wtag", style: `left:${hb.x}px;top:${hb.y}px;max-width:${hb.w + 8}px` }, h("i", { class: "pin" }), label);
    box.append(e);
    // a long shared clue gets smaller to fit its tag, never cut
    for (let fs = 26; label.scrollWidth > hb.w - 20 && fs > 18; ) label.style.fontSize = `${(fs -= 1)}px`;
    if (anim) e.style.opacity = "0";
    return e;
  });
  if (!anim) return;
  (async () => {
    if (!(await ctx.wait(1200 + nWords * 40))) return;
    for (let i = 0; i < tags.length; i++) {
      const tg = /** @type {HTMLElement} */ (tags[i]);
      tg.style.opacity = "";
      A(tg, [{ transform: "translate(-50%,-50%) scale(1.8) rotate(-8deg)", opacity: 0 }, { transform: "translate(-50%,-50%) scale(1)", opacity: 1 }], 220, { easing: EASE.in });
      ctx.later(150, sfx.pop);
      (strings[i] ?? []).forEach(([p, L], k) => A(p, [{ strokeDashoffset: L }, { strokeDashoffset: 0 }], 480, { delay: 120 + k * 90, easing: EASE.inout }));
      ctx.later(120, sfx.zip);
      if (!(await ctx.wait(300))) return;
    }
  })();
}

/**
 * A word card's clues: 28 px down to 24 px until they fit the room left,
 * wrapping onto as many lines as fit; past that, the last line ends in "…".
 * @param {HTMLElement} el @param {number} room px of height
 */
function fitClues(el, room) {
  let size = 28;
  const lines = () => Math.max(1, Math.floor(room / (size * 1.18)));
  const fits = () => el.scrollHeight <= Math.ceil(lines() * size * 1.18) + 1;
  el.style.webkitLineClamp = "";
  el.style.fontSize = size + "px";
  while (!fits() && size > 24) el.style.fontSize = (size -= 2) + "px";
  if (!fits()) el.style.webkitLineClamp = String(lines());
}
