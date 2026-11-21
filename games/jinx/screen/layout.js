// @ts-check
/**
 * Where the cards lie. The card area is x 64–980 (the pot is on the
 * right). A player's two cards (3 players) lie side by side under one
 * name tab.
 *
 * @typedef {import("../game/views.ts").Card} Card
 * @typedef {{ x: number, y: number, w: number, h: number, who: boolean, whoLeft?: number }} Slot
 */

export const AREA = { x: 64, w: 916 };

/**
 * The room tvpipe's join badge takes in the stage's bottom-left corner
 * (screen.js puts it there), in stage px: where it ends on the right (with
 * a margin) and where it starts at the top; null while it is hidden (the
 * lobby shows the code itself). The library says it on `<html>`
 * (`data-tvpipe-join`, `--tvpipe-join-w`/`-h`, window px from the window's
 * edges); the stage is scaled into the window, centred.
 * @returns {{ right: number, top: number } | null}
 */
export function joinRoom() {
  const root = document.documentElement;
  if (root.getAttribute("data-tvpipe-join") !== "bottom-left") return null;
  const cs = getComputedStyle(root);
  const w = parseFloat(cs.getPropertyValue("--tvpipe-join-w")) || 0;
  const hh = parseFloat(cs.getPropertyValue("--tvpipe-join-h")) || 0;
  if (w <= 0 || hh <= 0) return null;
  const s = Math.min(innerWidth / 1280, innerHeight / 720) || 1;
  const offX = (innerWidth - 1280 * s) / 2;
  const offY = (innerHeight - 720 * s) / 2;
  return { right: Math.ceil((w - offX) / s) + 18, top: Math.floor((innerHeight - hh - offY) / s) - 10 };
}

/**
 * A row's left edge (`x`, `width` wide, reaching down to `bottom`) moved
 * right out of the join badge's room when it reaches below the badge's
 * top, but not past `maxRight`.
 * @param {number} x @param {number} width @param {number} bottom @param {number} [maxRight]
 */
export function clearOfJoin(x, width, bottom, maxRight = 1216) {
  const j = joinRoom();
  if (!j || bottom <= j.top || x >= j.right) return x;
  return Math.max(x, Math.min(j.right, maxRight - width));
}

/**
 * A row of `n` boxes `w` wide, `step` apart around `cx`, reaching down to
 * `bottom`: their centres and the step. Out of the join badge's room the
 * row keeps its right end and its steps get shorter (not under
 * `minStep`); the boxes keep their size.
 * @param {number} n @param {number} w @param {number} step @param {{ cx?: number, bottom: number, minStep?: number }} o
 * @returns {{ xs: number[], step: number }}
 */
export function seatRow(n, w, step, { cx = 640, bottom, minStep = step }) {
  const xs = Array.from({ length: n }, (_, i) => cx + (i - (n - 1) / 2) * step);
  const j = joinRoom();
  const first = xs[0] ?? cx;
  const last = xs[n - 1] ?? cx;
  if (!j || n < 2 || bottom <= j.top || first - w / 2 >= j.right) return { xs, step };
  const k = Math.min(1, Math.max(minStep / step, (last - w / 2 - j.right) / (last - first)));
  return { xs: xs.map((x) => last - (last - x) * k), step: step * k };
}

/**
 * Cards grouped by author when someone has two (3 players), in first-seen order.
 * @param {Card[]} cards
 * @returns {Card[][]}
 */
export function units(cards) {
  /** @type {Map<string, Card[]>} */
  const by = new Map();
  for (const c of cards) {
    const u = by.get(c.author);
    if (u) u.push(c);
    else by.set(c.author, [c]);
  }
  return [...by.values()];
}

/**
 * Rows of cards: up to 4 per row, two rows for 5 or more; pairs together.
 * @param {Card[]} cards
 * @param {{ big?: boolean, top?: number }} [o] big: few cards larger (the reveal)
 * @returns {Map<string, Slot>}
 */
export function grid(cards, { big = false, top } = {}) {
  /** @type {Map<string, Slot>} */
  const out = new Map();
  const n = cards.length;
  const us = units(cards);
  const paired = us.some((u) => u.length > 1);
  let w = 210;
  let hh = 150;
  if (big && n <= 3) {
    w = 240;
    hh = 165;
  } else if (n === 4 && paired) {
    w = 200;
    hh = 144;
  }
  const gap = big && n <= 3 ? 50 : 26;
  const pairGap = 34;
  /** @type {Card[][][]} rows of units */
  const rows = [];
  if (n <= 4) rows.push(us);
  else {
    // fill the first row with up to 4 cards (pairs never split)
    const first = [];
    let k = 0;
    const rest = [];
    for (const u of us) {
      if (rest.length === 0 && k + u.length <= 4) {
        first.push(u);
        k += u.length;
      } else rest.push(u);
    }
    rows.push(first, rest);
  }
  const ys = rows.length === 1 ? [top ?? (big ? 200 : 236)] : [top ?? 176, (top ?? 176) + 216];
  rows.forEach((row, ri) => {
    const unitGap = paired ? Math.max(gap, 44) : gap;
    const total = row.reduce((s, u) => s + u.length * w + (u.length - 1) * pairGap, 0) + (row.length - 1) * unitGap;
    // under the join badge's top: the row moves right of it (the pot's column starts at 1000)
    let x = clearOfJoin(AREA.x + (AREA.w - total) / 2, total, (ys[ri] ?? 176) + hh + 48, 1000);
    for (const u of row) {
      u.forEach((c, i) => {
        /** @type {Slot} */
        const s = { x: Math.round(x), y: ys[ri] ?? 176, w, h: hh, who: i === 0 };
        if (u.length > 1 && i === 0) s.whoLeft = w + pairGap / 2;
        out.set(c.id, s);
        x += w + (i < u.length - 1 ? pairGap : 0);
      });
      x += unitGap;
    }
  });
  return out;
}

/**
 * The left edges of `n` boxes `w` wide with `gap` between them, centred on
 * `cx`, reaching down to `bottom`. Out of the join badge's room the row
 * starts right of it and ends at `maxRight` at the most, its gaps
 * narrowed for that (not under `minGap`).
 * @param {number} n @param {number} w @param {number} gap @param {{ cx?: number, bottom: number, maxRight?: number, minGap?: number }} o
 * @returns {number[]}
 */
export function rowLefts(n, w, gap, { cx = 640, bottom, maxRight = 1216, minGap = 12 }) {
  const total = n * w + (n - 1) * gap;
  let x = cx - total / 2;
  const moved = clearOfJoin(x, total, bottom, maxRight);
  if (moved !== x && n > 1) {
    const j = joinRoom();
    const left = j ? j.right : moved;
    if (left + total > maxRight) gap = Math.max(minGap, (maxRight - left - n * w) / (n - 1));
    x = Math.max(moved, Math.min(left, maxRight - (n * w + (n - 1) * gap)));
  } else x = moved;
  return Array.from({ length: n }, (_, i) => x + i * (w + gap));
}
