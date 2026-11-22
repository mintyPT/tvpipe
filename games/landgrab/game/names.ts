/**
 * Where territories' names go on a map: the TV's whole world and the
 * phone's close-ups (docs/landgrab-design.md §6, §7). A name is a block
 * of one or two lines next to its army badge, on its own land as far as
 * it can be (a name over a neighbour's land reads as the neighbour's),
 * clear of every badge, of the other names and of what the caller keeps
 * free. Map units throughout: a hex's radius is 1.
 *
 * Greedy: the territories with the fewest hexes choose first (they have
 * the least room), each the cheapest of a few spots around its badge, in
 * one line or two, at the size asked for or a smaller one. A name that
 * finds no free spot takes the one it overlaps least on: every name
 * asked for is placed.
 */

import { HEX_ROW, HEX_W, hexCenter, type World } from "./world.ts";

/** A rectangle: x, y (its top left), width, height. */
export type Box = [number, number, number, number];

export interface Label {
  /** The territory's index. */
  t: number;
  lines: string[];
  /** The font size. */
  size: number;
  /** The block's centre. */
  x: number;
  y: number;
  /** The block's width and height (lines × size × lead). */
  w: number;
  h: number;
}

export interface PlaceOptions {
  /** The font size. */
  size: number;
  /** A smaller size to try where the first does not fit. */
  small?: number;
  /** A text's width at a size. */
  measure(text: string, size: number): number;
  /** The army badges' radius around their territories' anchors: kept free. */
  badge: number;
  /** Territories with a badge (default: all). Without one, a name may sit on the anchor. */
  badges?: Iterable<number>;
  /** Kept free, like the badges. */
  avoid?: Box[];
  /** Rather not: the HUD's places. */
  shun?: Box[];
  /** Names stay inside. */
  bounds?: Box;
  /** A line's height as a multiple of the size (1). */
  lead?: number;
  /** The order the territories choose in (default: the fewest hexes first). */
  order?: number[];
}

/** The territory at a point, or -1 (the sea, off the map). */
export function territoryAt(w: World, x: number, y: number): number {
  const r0 = Math.round((y - 1) / HEX_ROW);
  let best = -1;
  let bd = Infinity;
  for (let r = r0 - 1; r <= r0 + 1; r++) {
    const c0 = Math.round(x / HEX_W - 0.5 - 0.5 * (r & 1));
    for (let c = c0 - 1; c <= c0 + 1; c++) {
      const [cx, cy] = hexCenter(c, r, 1);
      const d = (cx - x) ** 2 + (cy - y) ** 2;
      if (d < bd) (bd = d), (best = r < 0 || r >= w.rows || c < 0 || c >= w.cols ? -1 : r * w.cols + c);
    }
  }
  return best < 0 ? -1 : (w.cells[best] ?? -1);
}

/** A name as one line, and as two (split at the space that makes the wider line narrowest). */
export function splits(name: string, measure: (text: string) => number): string[][] {
  const out = [[name]];
  const words = name.split(" ");
  let best: [string, string] | null = null;
  let bw = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const wd = Math.max(measure(a), measure(b));
    if (wd < bw) (bw = wd), (best = [a, b]);
  }
  if (best) out.push(best);
  return out;
}

const overlaps = (a: Box, b: Box) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const overlapArea = (a: Box, b: Box) => Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
/** Whether a circle touches a box. */
const touches = (cx: number, cy: number, r: number, b: Box) => {
  const dx = cx - Math.max(b[0], Math.min(cx, b[0] + b[2]));
  const dy = cy - Math.max(b[1], Math.min(cy, b[1] + b[3]));
  return dx * dx + dy * dy < r * r;
};

/**
 * Places the names of territories (`names` by index; an empty or missing
 * name is left out).
 */
export function placeNames(w: World, names: ReadonlyMap<number, string>, o: PlaceOptions): Label[] {
  const lead = o.lead ?? 1;
  const anchors = w.territories.map((t) => hexCenter(t.anchor[0], t.anchor[1], 1));
  const badged = new Set(o.badges ?? w.territories.map((t) => t.index));
  const wanted = [...names.keys()].filter((t) => names.get(t) && w.territories[t]);
  const order = o.order ? o.order.filter((t) => wanted.includes(t)) : wanted.sort((a, b) => (w.territories[a]?.hexes.length ?? 0) - (w.territories[b]?.hexes.length ?? 0) || a - b);
  const hexes = w.territories.map((t) => t.hexes.map((cell) => hexCenter(cell % w.cols, Math.floor(cell / w.cols), 1)));
  const placed: Box[] = [];
  const out: Label[] = [];
  const sizes = o.small && o.small < o.size ? [o.size, o.small] : [o.size];
  for (const t of order) {
    const name = names.get(t) ?? "";
    const [ax, ay] = anchors[t] ?? [0, 0];
    const own = hexes[t] ?? [];
    const mid = own.reduce((m, p) => [m[0] + p[0] / own.length, m[1] + p[1] / own.length], [0, 0]);
    const hasBadge = badged.has(t);
    let best: { label: Label; cost: number; clash: number } | null = null;
    for (const [si, size] of sizes.entries()) {
      for (const [li, lines] of splits(name, (x) => o.measure(x, size)).entries()) {
        const bw = Math.max(...lines.map((x) => o.measure(x, size))) + size * 0.3;
        const bh = lines.length * size * lead;
        const g = hasBadge ? o.badge + size * 0.15 : 0;
        /** Centres to try, with what each costs by its place. */
        const spots: [number, number, number][] = [
          [ax, ay + g + bh / 2, 0],
          [ax, ay - g - bh / 2, 0.08],
          [ax + g + bw / 2, ay, 0.12],
          [ax - g - bw / 2, ay, 0.15],
          [ax - bw * 0.3, ay + g + bh / 2, 0.06],
          [ax + bw * 0.3, ay + g + bh / 2, 0.06],
          [ax - bw * 0.3, ay - g - bh / 2, 0.12],
          [ax + bw * 0.3, ay - g - bh / 2, 0.12],
          [mid[0], mid[1], 0.2],
          [mid[0], mid[1] + bh * 0.6, 0.22],
          [mid[0], mid[1] - bh * 0.6, 0.22],
        ];
        if (!hasBadge) spots.unshift([ax, ay, -0.05]);
        for (const [x, y, where] of spots) {
          const box: Box = [x - bw / 2, y - bh / 2, bw, bh];
          let clash = 0;
          if (o.bounds) {
            const [bx, by, bbw, bbh] = o.bounds;
            // Outside: the more of it, the worse.
            if (box[0] < bx || box[1] < by || box[0] + bw > bx + bbw || box[1] + bh > by + bbh) clash += 2 - overlapArea(box, o.bounds) / (bw * bh);
          }
          const m = size * 0.12;
          const grown: Box = [box[0] - m, box[1] - m, bw + 2 * m, bh + 2 * m];
          for (const p of placed) if (overlaps(grown, p)) clash += 1 + overlapArea(grown, p) / (bw * bh);
          for (const a of o.avoid ?? []) if (overlaps(box, a)) clash += 1 + overlapArea(box, a) / (bw * bh);
          for (const b of badged) {
            const [cx, cy] = anchors[b] ?? [0, 0];
            if (touches(cx, cy, o.badge, box)) clash += 1;
          }
          // What the block covers: its own land, a neighbour's, the sea.
          const nx = Math.max(2, Math.ceil(bw / 0.5));
          const ny = Math.max(2, Math.ceil(bh / 0.5));
          let mine = 0;
          let other = 0;
          for (let i = 0; i < nx; i++) {
            for (let j = 0; j < ny; j++) {
              const at = territoryAt(w, box[0] + ((i + 0.5) / nx) * bw, box[1] + ((j + 0.5) / ny) * bh);
              if (at === t) mine++;
              else if (at >= 0) other++;
            }
          }
          const n = nx * ny;
          const sea = n - mine - other;
          let cost = (other / n) * 2.5 + (sea / n) * 0.6 + where + li * 0.12 + si * 0.25;
          for (const s of o.shun ?? []) cost += (overlapArea(box, s) / (bw * bh)) * 3;
          if (!best || clash < best.clash || (clash === best.clash && cost < best.cost)) best = { label: { t, lines, size, x, y, w: bw, h: bh }, cost, clash };
        }
      }
    }
    if (!best) continue;
    const { label } = best;
    placed.push([label.x - label.w / 2, label.y - label.h / 2, label.w, label.h]);
    out.push(label);
  }
  return out;
}
