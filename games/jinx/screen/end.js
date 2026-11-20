// @ts-check
/**
 * The end of the game, in the host's steps: `room` (the count in wooden
 * tiles, the words of the night, the room's title stamp), `mvp` (the
 * winner's chip drops onto a pedestal in the light pool), `awards` (cards
 * flipped one by one) and `web` (the evening as a red-yarn board).
 *
 * @typedef {import("../game/views.ts").EndScreen} EndScreen
 * @typedef {import("../game/views.ts").Award} Award
 * @typedef {import("../game/views.ts").ScreenView} ScreenView
 * @typedef {import("./tv.js").Ctx} Ctx
 */

import { A, EASE, clamp, fitText, h, hm, short, svg } from "./dom.js";
import { confetti, dust, shake, stampAt } from "./fx.js";
import { INK, chip } from "./pieces.js";
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
      else if (v.step === "mvp") mvp(ctx, b, v, anim);
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
 * @param {Ctx} ctx @param {HTMLElement} box @param {EndScreen} v @param {boolean} anim
 */
function room(ctx, box, v, anim) {
  tab(box, tr.endRoom);
  const t = v.tally;
  const tiles = h("div", { class: "bigtiles", style: "top:104px" });
  const tilesOf = (/** @type {number} */ n) => [...String(n)].map((d) => h("div", { class: "tile" }, d));
  tiles.append(...tilesOf(t.found), h("div", { class: "of" }, tr.of), ...tilesOf(t.played));
  box.append(tiles, h("div", { class: "caption", style: "top:270px" }, tr.wordsTogether));
  const rots = [-3, 2, -2, 3, -1];
  [...tiles.children].forEach((el, i) => {
    const e = /** @type {HTMLElement} */ (el);
    if (e.classList.contains("of")) return;
    e.style.transform = `rotate(${rots[i % 5]}deg)`;
    if (!anim) return;
    A(e, [{ transform: "translateY(-300px) rotate(-25deg)", opacity: 0 }, { transform: e.style.transform, opacity: 1 }], 420, { delay: 200 + i * 140, easing: EASE.back });
    ctx.later(400 + i * 140, sfx.thunk);
  });
  const words = v.words.slice(0, 18);
  const perRow = words.length > 10 ? 6 : 5;
  const cw = perRow === 6 ? 170 : 186;
  const ch = perRow === 6 ? 66 : 78;
  const pitchX = cw + 18;
  const rowsN = Math.ceil(words.length / perRow);
  const top = rowsN > 2 ? 324 : 340;
  words.forEach((w, i) => {
    const col = i % perRow;
    const r = Math.floor(i / perRow);
    const inRow = Math.min(perRow, words.length - r * perRow);
    const x = 640 + (col - (inRow - 1) / 2) * pitchX - cw / 2;
    const y = top + r * (ch + 20);
    const a = ((i * 7) % 5) - 2;
    const c = h("div", { class: `mc ${w.found ? "won" : "lost"}`, style: `left:${x}px;top:${y}px;width:${cw}px;height:${ch}px;transform:rotate(${a}deg);z-index:${i}` }, h("span", null, w.word.toUpperCase()));
    box.append(c);
    const span = /** @type {HTMLElement} */ (c.firstElementChild);
    // long compounds ("GEBURTSTAGSKUCHEN") condense further than clue cards: the card is small
    fitText(span, perRow === 6 ? 26 : 30, 24, cw - 20, 0.55);
    if (anim) {
      A(c, [{ transform: `translate(${640 - x - cw / 2}px,420px) rotate(${a * 8}deg)` }, { transform: `rotate(${a}deg)` }], 480, { delay: 900 + i * 80 });
      ctx.later(900 + i * 80, sfx.slide);
    }
  });
  const title = tr.titles[v.title] ?? `${v.title}!`;
  const sy = Math.min(640, top + rowsN * (ch + 20) + 46);
  if (anim) {
    ctx.later(1100 + words.length * 80, () => {
      stampAt(box, 640, sy, title, { cls: "gold", rot: -4, size: 60, shakePx: 6 });
      ctx.later(200, () => confetti(640, sy - 30, 30));
      ctx.later(200, sfx.fanfare);
    });
  } else stampAt(box, 640, sy, title, { cls: "gold", rot: -4, size: 60, anim: false });
}

/**
 * @param {Ctx} ctx @param {HTMLElement} box @param {EndScreen} v @param {boolean} anim
 */
function mvp(ctx, box, v, anim) {
  tab(box, tr.endMvp);
  const m = v.mvp;
  ctx.pool.to(640, 330, 250, anim);
  const ped = h("div", { class: "pedestal", style: "left:490px;top:396px" });
  box.append(ped);
  if (!m) {
    box.append(h("div", { class: "caption", style: "top:520px;font-size:34px" }, tr.nobodyTonight[0], h("b", null, tr.nobodyTonight[1])));
    return;
  }
  const p = ctx.person(m.id);
  const t = chip(p, 220, { style: "left:530px;top:196px;z-index:5" });
  const rib = h("div", { class: "ribbon", style: "top:508px;z-index:6" }, tr.mvpOfNight);
  const cap = h("div", { class: "caption", style: "top:612px;font-size:32px" }, h("b", null, short(p?.name, 16)), ` · ${tr.mvpStats(m)}`);
  box.append(t, rib, cap);
  if (!anim) return;
  A(ped, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], 300, { delay: 300, easing: EASE.back });
  sfx.drumroll(1500);
  A(t, [
    { transform: "translateY(-420px) scale(1.5)", opacity: 0 },
    { offset: 0.6, transform: "translateY(0) scale(1)", opacity: 1, easing: EASE.out },
    { offset: 0.8, transform: "scale(1.12,.86)", easing: EASE.out },
    { transform: "scale(1)", opacity: 1 },
  ], 520, { easing: EASE.in, delay: 1550 });
  ctx.later(1870, () => {
    sfx.slam();
    sfx.cymbal();
    shake(12, 400);
    dust(640, 428, 12, 160);
  });
  ctx.later(1990, () => {
    confetti(640, 300, 70, 1.2);
    sfx.fanfare();
  });
  A(rib, [{ clipPath: "polygon(50% 0,50% 0,50% 100%,50% 100%)" }, { clipPath: "polygon(0 0,100% 0,95% 50%,100% 100%,0 100%,5% 50%)" }], 420, { delay: 2170 });
  A(cap, [{ opacity: 0, transform: "translateY(20px)" }, { opacity: 1, transform: "none" }], 400, { delay: 2520 });
}

/** @type {Record<Award["kind"], string>} */
const ICONS = {
  "mind meld": `<svg viewBox="0 0 110 90"><circle cx="40" cy="45" r="32" fill="#ff7a5c" stroke="${INK}" stroke-width="5"/><circle cx="70" cy="45" r="32" fill="#8bd648" fill-opacity=".85" stroke="${INK}" stroke-width="5"/><path d="M55 18 A32 32 0 0 1 55 72 A32 32 0 0 1 55 18 Z" fill="${INK}"/></svg>`,
  "lone wolf": `<svg viewBox="0 0 110 90"><path d="M55 6 L65 34 L95 35 L71 53 L80 83 L55 65 L30 83 L39 53 L15 35 L45 34 Z" fill="#f6b93b" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/></svg>`,
  kamikaze: `<svg viewBox="0 0 110 90"><circle cx="50" cy="54" r="30" fill="${INK}"/><path d="M68 30 Q80 14 92 18" stroke="${INK}" stroke-width="6" fill="none" stroke-linecap="round"/><path d="M92 6 L95 15 L104 14 L97 20 L102 28 L93 24 L88 31 L88 21 L80 18 L89 15 Z" fill="#f6b93b" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round"/><circle cx="40" cy="44" r="7" fill="#fbf1dc" opacity=".6"/></svg>`,
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
  const xs = list.length === 3 ? [110, 480, 850] : list.length === 2 ? [295, 665] : [480];
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
    // "Seelenverwandt", "Einzelgänger": the title fits the card
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
  const rows = n <= 4 ? 1 : n <= 10 ? 2 : n <= 12 ? 3 : 4;
  const perRow = Math.ceil(n / rows);
  const top = 112;
  const H = 684 - top;
  const gapX = 30;
  const gapY = hubs ? (rows <= 2 ? 120 : 56) : rows <= 2 ? 48 : 30;
  const w = Math.min(300, Math.floor((1152 - (perRow - 1) * gapX) / perRow));
  const h = Math.min(rows === 1 ? 230 : 196, Math.floor((H - (rows - 1) * gapY) / rows));
  const y0 = top + (H - (rows * h + (rows - 1) * gapY)) / 2;
  /** @type {{ x: number, y: number }[]} centres */
  const out = [];
  // the bands where shared clues' tags go: between the rows, else above and below the one row
  /** @type {number[]} */
  const bands = [];
  for (let r = 1; r < rows; r++) bands.push(y0 + r * h + (r - 0.5) * gapY);
  if (rows === 1) bands.push(Math.max(140, y0 - 50), Math.min(650, y0 + h + 50));
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(perRow, n - r * perRow);
    const x0 = 640 - (inRow * w + (inRow - 1) * gapX) / 2;
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
  const hubs = links.map((l) => {
    const ps = l.words.map((i) => spots[i] ?? C);
    const mx = ps.reduce((s, p) => s + p.x, 0) / ps.length;
    const my = ps.reduce((s, p) => s + p.y, 0) / ps.length;
    const y = bands.reduce((b, y) => (Math.abs(y - my) < Math.abs(b - my) ? y : b), bands[0] ?? my);
    return { l, x: mx, y, w: Math.min(260, 34 + [...l.clue].length * 19) };
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
    fitText(word, ch >= 150 ? 40 : 32, 26, cw - 24, 0.6);
    if (own.length) fitClues(clues, ch - word.offsetHeight - 26);
    if (anim) {
      A(c, [{ transform: "scale(1.5) rotate(-12deg)", opacity: 0 }, { transform: `rotate(${rot}deg)`, opacity: 1 }], 300, { delay: 200 + i * 80, easing: EASE.in });
      ctx.later(380 + i * 80, sfx.thwap);
    }
  });
  const tags = hubs.map((hb) => {
    const e = h("div", { class: "wtag", style: `left:${hb.x}px;top:${hb.y}px;max-width:${hb.w + 40}px` }, h("i", { class: "pin" }), h("span", null, hb.l.clue.toUpperCase()));
    box.append(e);
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
