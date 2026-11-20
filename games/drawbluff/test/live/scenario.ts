/**
 * The round the screenshots show (`play.ts --shots`): seven friends,
 * seven prompts from `data/prompts.txt` (the host page is given only
 * these, so the game deals exactly them), a drawing by hand for each
 * prompt and, per drawing, the fake titles the others write for it. So
 * what is on the TV and the phones fits together: the drawing shows its
 * prompt, the titles next to it are bluffs about that very drawing.
 *
 * Drawings are strokes on the 1000×1000 grid with the phone's pen sizes
 * (8, 20, 48) and the player's two pens (dark and light: the game's
 * default; colour mode's pens lean so far to the player's colour that a
 * toast would come out green); `node test/live/scenario.ts DIR` draws them into DIR as PNGs
 * (headless Chrome) to look at.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { palette, seeded } from "../../game/rules.ts";

/**
 * The host page's random seed (`play.ts --seed`): it decides who is dealt
 * which prompt and which drawing comes first (the order of the titles on
 * the TV varies a little from run to run). With this one Phil draws the
 * snowman and the first vote is Noah's laser eyes, as the alt texts in
 * site/static/games.json say.
 */
export const SEED = 5;

/** The players in the order the titles go round: Phil (the phone), then the actors. */
export const PLAYERS = ["Phil", "Mia", "Jonas", "Lena", "Sam", "Noah", "Zoe"] as const;

type Pt = [number, number];

/** The pens: the player's colour, dark and light. */
const D = 0;
const L = 1;
const THIN = 8;
const MID = 20;
const FAT = 48;

/** The phone's pen size nearest to `width` (it has 8, 20 and 48). */
function size(width: number): number {
  return width < 14 ? THIN : width < 34 ? MID : FAT;
}

/** Points along a polyline, at most `step` apart. */
function resample(pts: readonly Pt[], step = 20): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i]!;
    if (i === 0) {
      out.push([x, y]);
      continue;
    }
    const [px, py] = pts[i - 1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / step));
    for (let k = 1; k <= n; k++) out.push([px + ((x - px) * k) / n, py + ((y - py) * k) / n]);
  }
  return out;
}

/** A Catmull-Rom curve through the points. */
function spline(pts: readonly Pt[]): Pt[] {
  if (pts.length < 3) return [...pts];
  const out: Pt[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 15));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts.at(-1)!);
  return out;
}

/** Points on an ellipse from `a0` to `a1` degrees (0: right, 90: down). */
function arc(cx: number, cy: number, rx: number, ry: number, a0 = 0, a1 = 360, rot = 0): Pt[] {
  const n = Math.max(8, Math.ceil((Math.abs(a1 - a0) / 360) * ((rx + ry) * Math.PI) / 18));
  const r = (rot * Math.PI) / 180;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    out.push([cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)]);
  }
  return out;
}

/** A drawing in progress: strokes as a phone sends them, with a hand's wobble. */
class Pad {
  readonly strokes: number[][] = [];
  readonly #rng: () => number;
  /** A transform for the points (`at`). */
  #t: (p: Pt) => Pt = (p) => p;
  #k = 1;

  constructor(seed: number) {
    this.#rng = seeded(seed);
  }

  /** Draws `fn` moved to (x, y), scaled by `k` and turned by `rot` degrees. */
  at(x: number, y: number, k: number, rot: number, fn: () => void): void {
    const outer = this.#t;
    const outerK = this.#k;
    const r = (rot * Math.PI) / 180;
    this.#t = ([px, py]) => outer([x + k * (px * Math.cos(r) - py * Math.sin(r)), y + k * (px * Math.sin(r) + py * Math.cos(r))]);
    this.#k = outerK * k;
    fn();
    this.#t = outer;
    this.#k = outerK;
  }

  #push(pen: number, width: number, pts: readonly Pt[], wobble = 2.5): void {
    const s = [pen, size(width)];
    let dx = 0;
    let dy = 0;
    let lx = -99;
    let ly = -99;
    const all = resample(pts.map(this.#t), 20);
    all.forEach(([x, y], i) => {
      dx = Math.max(-wobble * 2, Math.min(wobble * 2, dx + (this.#rng() - 0.5) * wobble));
      dy = Math.max(-wobble * 2, Math.min(wobble * 2, dy + (this.#rng() - 0.5) * wobble));
      const px = Math.round(Math.max(0, Math.min(1000, x + dx)));
      const py = Math.round(Math.max(0, Math.min(1000, y + dy)));
      if (i > 0 && i < all.length - 1 && Math.hypot(px - lx, py - ly) < 5) return;
      s.push(px, py);
      lx = px;
      ly = py;
    });
    if (s.length === 4) s.push(s[2]! + 1, s[3]!);
    this.strokes.push(s);
  }

  line(pen: number, width: number, ...pts: Pt[]): void {
    this.#push(pen, width, pts);
  }

  curve(pen: number, width: number, ...pts: Pt[]): void {
    this.#push(pen, width, spline(pts));
  }

  oval(pen: number, width: number, cx: number, cy: number, rx: number, ry: number, a0 = 0, a1 = 360, rot = 0): void {
    this.#push(pen, width, arc(cx, cy, rx, ry, a0, a1, rot));
  }

  dot(pen: number, width: number, x: number, y: number): void {
    const [px, py] = this.#t([x, y]);
    this.strokes.push([pen, size(width), Math.round(px), Math.round(py)]);
  }

  /** Colours a shape in, back and forth (`width` the pen, the polygon in local points). */
  fill(pen: number, width: number, poly: readonly Pt[]): void {
    const pts = poly.map(this.#t);
    const w = width;
    const ys = pts.map((p) => p[1]);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    const step = w * 0.7;
    let chain: Pt[] = [];
    let flip = false;
    const flush = () => {
      if (chain.length > 0) this.#raw(pen, width, chain);
      chain = [];
    };
    for (let y = top + w * 0.45; y <= bottom - w * 0.3; y += step) {
      const xs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const [x0, y0] = pts[i]!;
        const [x1, y1] = pts[(i + 1) % pts.length]!;
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
      xs.sort((a, b) => a - b);
      const spans: [number, number][] = [];
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const a = xs[i]! + w * 0.4;
        const b = xs[i + 1]! - w * 0.4;
        if (b > a) spans.push([a, b]);
      }
      if (spans.length === 1) {
        const [a, b] = spans[0]!;
        chain.push(...((flip ? [[b, y], [a, y]] : [[a, y], [b, y]]) as Pt[]));
        flip = !flip;
      } else {
        flush();
        for (const [a, b] of spans) this.#raw(pen, width, [[a, y], [b, y]]);
      }
    }
    flush();
  }

  /** Points already transformed. */
  #raw(pen: number, width: number, pts: Pt[]): void {
    const t = this.#t;
    this.#t = (p) => p;
    this.#push(pen, width, pts, 1.5);
    this.#t = t;
  }

  fillOval(pen: number, width: number, cx: number, cy: number, rx: number, ry: number, rot = 0): void {
    this.fill(pen, width, arc(cx, cy, rx, ry, 0, 360, rot));
  }

  /** A falling drop (outline and filled), its tip up. */
  drop(pen: number, x: number, y: number, s: number): void {
    this.curve(D, THIN, [x, y - s], [x - s * 0.45, y + s * 0.15], [x - s * 0.35, y + s * 0.5], [x, y + s * 0.62], [x + s * 0.35, y + s * 0.5], [x + s * 0.45, y + s * 0.15], [x, y - s]);
    this.dot(pen, Math.max(THIN, Math.round(s * 0.55)), x, y + s * 0.25);
  }
}

/** Horizontal planks across the picture but around the `holes` (ellipses: cx, cy, rx, ry). */
function around(y: number, x0: number, x1: number, holes: readonly [number, number, number, number][], gap = 22): [number, number][] {
  let spans: [number, number][] = [[x0, x1]];
  for (const [cx, cy, rx, ry] of holes) {
    const d = (y - cy) / (ry + gap);
    if (Math.abs(d) >= 1) continue;
    const half = (rx + gap) * Math.sqrt(1 - d * d);
    spans = spans.flatMap(([a, b]): [number, number][] => [
      [a, Math.min(b, cx - half)],
      [Math.max(a, cx + half), b],
    ]).filter(([a, b]) => b - a > 30);
  }
  return spans;
}

// ---------------------------------------------------------------------------
// The drawings.

function snowmanInASauna(): number[][] {
  const p = new Pad(11);
  const bottom: [number, number, number, number] = [560, 520, 150, 105];
  const middle: [number, number, number, number] = [560, 345, 100, 80];
  const head: [number, number, number, number] = [560, 200, 72, 68];
  // The sauna's wooden wall, around the snowman, the hat and the thermometer.
  for (const y of [95, 185, 275, 365, 455, 545]) {
    const holes: [number, number, number, number][] = [bottom, middle, head, [560, 95, 90, 60], [890, 190, 45, 150], [870, 585, 70, 60]];
    for (const [a, b] of around(y, 25, 975, holes)) p.line(L, THIN, [a, y], [b, y]);
  }
  // The bench.
  p.fill(L, FAT, [[235, 622], [965, 622], [965, 678], [235, 678]]);
  p.line(D, THIN, [235, 622], [965, 622], [965, 678], [235, 678], [235, 622]);
  p.line(D, MID, [300, 680], [300, 945]);
  p.line(D, MID, [900, 680], [900, 945]);
  // The snowman.
  p.oval(D, MID, ...bottom);
  p.oval(D, MID, ...middle, 200, 520);
  p.oval(D, MID, ...head, 205, 515);
  p.fill(D, FAT, [[515, 55], [605, 55], [605, 140], [515, 140]]);
  p.line(D, MID, [480, 142], [640, 140]);
  p.line(L, THIN, [515, 128], [605, 128]);
  p.dot(D, MID, 535, 190);
  p.dot(D, MID, 588, 190);
  p.line(D, THIN, [515, 172], [547, 160]);
  p.line(D, THIN, [576, 160], [608, 172]);
  p.fill(L, MID, [[555, 200], [655, 222], [555, 228]]);
  p.line(L, THIN, [555, 200], [655, 222], [555, 228]);
  p.curve(D, THIN, [530, 245], [545, 238], [560, 246], [575, 238], [590, 245]);
  p.dot(D, MID, 560, 315);
  p.dot(D, MID, 560, 370);
  p.line(D, THIN, [462, 330], [380, 290]);
  p.line(D, THIN, [405, 302], [395, 268]);
  p.line(D, THIN, [658, 330], [740, 290]);
  p.line(D, THIN, [715, 302], [728, 268]);
  // Melting: sweat flying off, drips off the bench, a puddle.
  p.drop(L, 455, 150, 34);
  p.drop(L, 668, 165, 30);
  p.drop(L, 440, 255, 26);
  p.drop(L, 690, 410, 28);
  p.line(D, THIN, [470, 105], [445, 85]);
  p.line(D, THIN, [650, 105], [675, 85]);
  p.curve(L, MID, [440, 600], [430, 640], [445, 676]);
  p.curve(L, MID, [690, 590], [700, 630], [688, 676]);
  p.line(L, MID, [480, 680], [480, 760]);
  p.dot(L, 30, 480, 800);
  p.line(L, MID, [610, 680], [610, 730]);
  p.dot(L, 30, 610, 775);
  p.line(L, MID, [680, 680], [680, 710]);
  p.fillOval(L, MID, 560, 925, 190, 32);
  // The stove: hot stones and steam.
  p.line(D, MID, [40, 720], [210, 720], [210, 940], [40, 940], [40, 720]);
  p.line(D, THIN, [80, 800], [170, 800], [170, 880], [80, 880], [80, 800]);
  p.fill(L, MID, [[90, 845], [160, 845], [160, 872], [90, 872]]);
  p.oval(D, THIN, 75, 700, 32, 20);
  p.oval(D, THIN, 128, 692, 32, 24);
  p.oval(D, THIN, 180, 702, 30, 18);
  p.curve(D, THIN, [85, 660], [65, 610], [100, 560], [75, 500], [100, 440]);
  p.curve(D, THIN, [135, 650], [160, 590], [125, 530], [155, 470], [130, 400]);
  p.curve(D, THIN, [190, 665], [215, 615], [190, 565], [215, 515]);
  // A wooden bucket with a ladle on the bench.
  p.fill(L, MID, [[815, 545], [925, 545], [912, 620], [828, 620]]);
  p.line(D, THIN, [815, 545], [925, 545], [912, 620], [828, 620], [815, 545]);
  p.line(D, THIN, [820, 572], [920, 572]);
  p.line(D, THIN, [825, 600], [915, 600]);
  p.line(D, THIN, [870, 555], [945, 465]);
  // The thermometer, in the red.
  p.oval(D, THIN, 890, 300, 34, 34);
  p.line(D, THIN, [872, 270], [872, 70], [908, 70], [908, 270]);
  p.dot(L, 50, 890, 300);
  p.line(L, MID, [890, 290], [890, 85]);
  for (const y of [110, 150, 190, 230]) p.line(D, THIN, [850, y], [866, y]);
  return p.strokes;
}

function cat(p: Pad): void {
  // Local: head at (0, -60), body below; legs splayed (falling).
  p.fillOval(L, MID, 0, 40, 46, 60);
  p.fillOval(L, MID, 0, -60, 52, 46);
  p.oval(D, THIN, 0, 40, 46, 60);
  p.line(D, THIN, [-40, -40], [-48, -118], [-14, -100], [14, -100], [48, -118], [40, -40]);
  p.oval(D, THIN, 0, -60, 52, 46, 15, 165);
  p.dot(D, 16, -18, -68);
  p.dot(D, 16, 18, -68);
  p.dot(L, 12, 0, -52);
  p.oval(D, THIN, 0, -36, 14, 12, 20, 160);
  p.line(D, THIN, [-22, -48], [-75, -60]);
  p.line(D, THIN, [-22, -42], [-72, -34]);
  p.line(D, THIN, [22, -48], [75, -60]);
  p.line(D, THIN, [22, -42], [72, -34]);
  p.line(D, THIN, [-12, 10], [10, 14]);
  p.line(D, THIN, [-18, 34], [16, 38]);
  p.line(D, MID, [-38, 10], [-90, -20]);
  p.line(D, MID, [38, 10], [90, -20]);
  p.line(D, MID, [-30, 90], [-70, 135]);
  p.line(D, MID, [30, 90], [70, 135]);
  p.curve(D, MID, [20, 95], [60, 130], [100, 110], [110, 70]);
}

function dog(p: Pad): void {
  // Local: head at (0, -60), floppy ears, tongue out.
  p.oval(D, THIN, 0, 45, 50, 62);
  p.oval(D, THIN, 0, -62, 50, 46);
  p.fill(D, MID, [[-44, -92], [-78, -70], [-82, -10], [-58, -20], [-44, -60]]);
  p.fill(D, MID, [[44, -92], [78, -70], [82, -10], [58, -20], [44, -60]]);
  p.dot(D, 16, -18, -72);
  p.dot(D, 16, 18, -72);
  p.oval(D, THIN, 0, -38, 24, 18);
  p.dot(D, 22, 0, -46);
  p.fill(L, THIN, [[-10, -24], [10, -24], [10, -6], [0, 2], [-10, -6]]);
  p.fillOval(D, MID, 18, 50, 20, 24);
  p.line(D, MID, [-42, 15], [-95, -15]);
  p.line(D, MID, [42, 15], [95, -15]);
  p.line(D, MID, [-30, 100], [-65, 140]);
  p.line(D, MID, [30, 100], [65, 140]);
  p.line(D, MID, [-10, 105], [-30, 150]);
}

function rainingCatsAndDogs(): number[][] {
  const p = new Pad(23);
  // A dark cloud.
  const cloud: Pt[] = [
    ...arc(230, 200, 90, 75, 90, 270),
    ...arc(370, 130, 110, 95, 200, 330),
    ...arc(570, 110, 120, 90, 200, 340),
    ...arc(760, 160, 100, 80, 220, 360),
    ...arc(850, 220, 70, 55, 270, 450),
  ];
  const base: Pt[] = [[850, 275], [230, 275]];
  p.fill(L, FAT, [...cloud, ...base]);
  p.curve(D, MID, ...cloud, [850, 275], [540, 285], [230, 275]);
  // Rain.
  const rain: Pt[] = [
    [130, 330], [380, 320], [610, 330], [880, 330], [100, 560], [560, 400], [860, 470],
    [140, 820], [430, 760], [600, 520], [930, 600], [70, 440], [390, 950], [500, 870], [940, 840], [260, 560],
  ];
  for (const [x, y] of rain) p.line(L, THIN, [x, y], [x - 14, y + 46]);
  // Cats and dogs tumbling down.
  p.at(210, 470, 1.05, -20, () => cat(p));
  p.at(720, 420, 1, 25, () => dog(p));
  p.at(430, 600, 0.95, 160, () => cat(p));
  p.at(220, 790, 0.95, -35, () => dog(p));
  for (const [x, y] of [[180, 330], [230, 320], [690, 290], [750, 300], [470, 430], [520, 440], [180, 640], [240, 640]] as Pt[]) {
    p.line(D, THIN, [x, y], [x, y - 40]);
  }
  // Someone under an umbrella, looking up.
  p.fill(L, FAT, arc(700, 690, 170, 140, 180, 360));
  p.curve(D, MID, ...arc(700, 690, 170, 140, 180, 360));
  p.curve(D, MID, [530, 690], [560, 676], [587, 690], [615, 676], [643, 690], [672, 676], [700, 690], [728, 676], [757, 690], [785, 676], [813, 690], [842, 676], [870, 690]);
  p.line(D, THIN, [700, 552], [700, 690]);
  p.curve(D, THIN, [700, 552], [640, 610], [615, 680]);
  p.curve(D, THIN, [700, 552], [760, 610], [785, 680]);
  p.line(D, THIN, [700, 530], [700, 552]);
  p.curve(D, MID, [700, 690], [700, 850], [690, 880], [670, 880], [660, 860]);
  p.oval(D, MID, 610, 790, 48, 50);
  p.dot(D, 14, 596, 770);
  p.dot(D, 14, 628, 770);
  p.oval(D, THIN, 612, 812, 10, 13);
  p.fill(L, MID, [[570, 850], [650, 850], [680, 965], [540, 965]]);
  p.line(D, THIN, [570, 850], [650, 850], [680, 965], [540, 965], [570, 850]);
  p.line(D, MID, [650, 880], [690, 860]);
  p.fillOval(L, THIN, 820, 960, 90, 18);
  p.fillOval(L, THIN, 420, 975, 70, 14);
  return p.strokes;
}

function iceCreamFalls(): number[][] {
  const p = new Pad(37);
  // Sun and grass.
  p.fillOval(L, MID, 870, 130, 60, 60);
  for (let a = 0; a < 360; a += 45) {
    const r = (a * Math.PI) / 180;
    p.line(L, THIN, [870 + Math.cos(r) * 82, 130 + Math.sin(r) * 82], [870 + Math.cos(r) * 115, 130 + Math.sin(r) * 115]);
  }
  p.curve(L, MID, [20, 905], [200, 895], [400, 910], [600, 898], [800, 908], [980, 900]);
  for (const x of [80, 470, 900]) p.line(L, THIN, [x - 15, 890], [x, 860], [x + 8, 890], [x + 22, 865], [x + 25, 892]);
  // The kid.
  p.oval(D, MID, 320, 320, 110, 115);
  p.curve(D, MID, [215, 290], [230, 230], [260, 250], [280, 200], [310, 235], [340, 195], [365, 235], [400, 210], [410, 260], [430, 290]);
  p.oval(D, THIN, 285, 315, 28, 32);
  p.oval(D, THIN, 360, 315, 28, 32);
  p.dot(D, 18, 292, 325);
  p.dot(D, 18, 367, 325);
  p.curve(D, THIN, [255, 268], [285, 255], [312, 266]);
  p.curve(D, THIN, [335, 266], [362, 255], [392, 268]);
  p.oval(D, THIN, 325, 395, 28, 26);
  p.fillOval(L, THIN, 325, 400, 16, 14);
  p.line(D, THIN, [185, 210], [155, 185]);
  p.line(D, THIN, [175, 255], [140, 248]);
  p.line(D, THIN, [230, 165], [215, 130]);
  // T-shirt, arms, legs.
  p.fill(L, FAT, [[240, 445], [400, 445], [430, 660], [210, 660]]);
  p.line(D, THIN, [240, 445], [400, 445], [430, 660], [210, 660], [240, 445]);
  p.line(D, MID, [250, 470], [160, 380]);
  p.line(D, THIN, [160, 380], [140, 345]);
  p.line(D, THIN, [160, 380], [125, 365]);
  p.line(D, THIN, [160, 380], [150, 340]);
  p.line(D, MID, [395, 475], [530, 445]);
  p.oval(D, MID, 545, 440, 22, 20);
  p.line(D, MID, [270, 660], [262, 870]);
  p.line(D, MID, [370, 660], [380, 870]);
  p.fillOval(D, MID, 245, 882, 34, 16);
  p.fillOval(D, MID, 398, 882, 34, 16);
  // The empty cone, tipped over.
  const cone: Pt[] = [[505, 355], [625, 330], [570, 495]];
  p.fill(L, MID, cone);
  p.line(D, THIN, ...cone, cone[0]!);
  p.line(D, THIN, [530, 380], [590, 460]);
  p.line(D, THIN, [570, 360], [612, 420]);
  p.line(D, THIN, [540, 420], [608, 350]);
  p.line(D, THIN, [555, 460], [600, 415]);
  // The scoop, on its way down.
  for (let i = 0; i < 6; i++) {
    const t = i / 6;
    const x = 620 + t * 110;
    const y = 320 + t * t * 260 - t * 40;
    p.dot(D, 10, x, y);
  }
  p.at(735, 650, 1.1, 15, () => {
    // A round scoop over a frilly rim of little bumps (where it sat in the cone).
    const top = arc(0, 18, 82, 82, 167, 373);
    const rim: Pt[] = [];
    for (let i = 0; i < 4; i++) rim.push(...arc(60 - i * 40, 34, 20, 24, 0, 180).slice(i === 0 ? 0 : 1));
    const scoop: Pt[] = [...top, ...rim];
    p.fill(L, FAT, scoop);
    p.line(D, MID, ...scoop, scoop[0]!);
    for (const [x, y] of [[-40, -20], [5, -45], [35, -5], [-15, 0], [40, -40], [-55, 5]] as Pt[]) p.line(D, THIN, [x, y], [x + 14, y + 6]);
  });
  p.line(D, THIN, [700, 540], [690, 500]);
  p.line(D, THIN, [760, 535], [760, 490]);
  p.line(D, THIN, [820, 540], [830, 500]);
  p.oval(D, THIN, 735, 905, 80, 12);
  return p.strokes;
}

function seagullAndSandwich(): number[][] {
  const p = new Pad(41);
  // Sun, sea, sand.
  p.fillOval(L, MID, 120, 120, 65, 65);
  for (let a = 0; a < 360; a += 45) {
    const r = (a * Math.PI) / 180;
    p.line(L, THIN, [120 + Math.cos(r) * 85, 120 + Math.sin(r) * 85], [120 + Math.cos(r) * 115, 120 + Math.sin(r) * 115]);
  }
  const wave = (y: number, w: number) =>
    p.curve(L, w, ...Array.from({ length: 11 }, (_, i): Pt => [i * 100, y + (i % 2 ? -10 : 10)]));
  wave(560, MID);
  wave(610, THIN);
  wave(655, THIN);
  // The seagull, off with the sandwich.
  const tail: Pt[] = [[530, 300], [450, 285], [460, 345], [535, 335]];
  p.line(D, MID, ...tail);
  p.oval(D, MID, 640, 300, 125, 58, 0, 360, -12);
  p.oval(D, MID, 770, 250, 46, 42, 120, 410);
  const wing = spline([[700, 285], [690, 190], [630, 110], [520, 60], [445, 55], [490, 90], [520, 95], [530, 125], [565, 135], [575, 170], [610, 185], [615, 225], [640, 250], [630, 300]]);
  p.fill(L, MID, wing);
  p.line(D, MID, ...wing);
  p.fill(D, MID, [[450, 58], [520, 64], [530, 120], [495, 95]]);
  p.dot(D, 16, 785, 240);
  p.line(D, THIN, [762, 222], [800, 232]);
  p.fill(L, MID, [[808, 245], [870, 262], [808, 275]]);
  p.line(D, THIN, [808, 245], [870, 262], [808, 275]);
  p.line(D, MID, [610, 355], [585, 395]);
  p.line(D, MID, [650, 352], [635, 398]);
  // The sandwich in its beak.
  p.at(880, 290, 1, 12, () => {
    p.fill(L, MID, [[-70, -50], [70, -50], [80, -30], [-80, -30]]);
    p.curve(D, THIN, [-80, -20], [-60, -10], [-40, -22], [-20, -8], [0, -22], [20, -8], [40, -22], [60, -10], [80, -20]);
    p.line(L, MID, [-70, 2], [70, 2]);
    p.fill(L, MID, [[-80, 12], [80, 12], [70, 35], [-70, 35]]);
    p.line(D, THIN, [-70, -52], [70, -52], [82, -30], [-82, -30], [-70, -52]);
    p.line(D, THIN, [-80, 12], [80, 12], [70, 36], [-70, 36], [-80, 12]);
  });
  for (const y of [250, 290, 330]) p.line(D, THIN, [420, y + 40], [340, y + 50]);
  // Someone on a towel, reaching for their lunch.
  p.fill(L, FAT, [[80, 820], [470, 820], [430, 950], [40, 950]]);
  for (const x of [150, 240, 330]) p.line(D, THIN, [x + 10, 822], [x - 30, 948]);
  p.oval(D, MID, 240, 610, 62, 66);
  p.line(D, THIN, [200, 575], [232, 592]);
  p.line(D, THIN, [285, 575], [252, 592]);
  p.dot(D, 16, 220, 605);
  p.dot(D, 16, 265, 605);
  p.oval(D, THIN, 245, 645, 22, 16);
  p.curve(D, MID, [185, 575], [205, 545], [245, 538], [290, 555], [300, 585]);
  p.fill(L, FAT, [[180, 690], [300, 690], [330, 830], [150, 830]]);
  p.line(D, THIN, [180, 690], [300, 690], [330, 830], [150, 830], [180, 690]);
  p.line(D, MID, [295, 710], [380, 600], [420, 520]);
  p.line(D, THIN, [420, 520], [415, 480]);
  p.line(D, THIN, [420, 520], [440, 485]);
  p.line(D, THIN, [420, 520], [455, 505]);
  p.line(D, MID, [185, 710], [120, 780], [150, 820]);
  p.line(D, MID, [330, 830], [430, 870]);
  p.line(D, MID, [180, 830], [300, 890]);
  p.line(D, THIN, [460, 445], [480, 410]);
  p.line(D, THIN, [480, 465], [515, 445]);
  // Crumbs falling, the sand.
  for (const [x, y] of [[840, 380], [880, 420], [930, 395], [860, 470]] as Pt[]) p.dot(L, 14, x, y);
  for (const [x, y] of [[560, 760], [640, 820], [720, 760], [820, 840], [900, 770], [600, 920], [760, 930], [930, 920], [480, 860]] as Pt[]) p.dot(L, 14, x, y);
  return p.strokes;
}

function giraffeSoreThroat(): number[][] {
  const p = new Pad(53);
  const head: Pt[] = arc(370, 175, 95, 55, 0, 360, -8);
  const neck: Pt[] = [[420, 215], [470, 205], [600, 600], [520, 640]];
  const body: Pt[] = arc(650, 680, 220, 105);
  p.fill(L, FAT, body);
  p.fill(L, FAT, neck);
  p.fill(L, MID, head);
  // Spots.
  for (const [x, y, dx, dy] of [[555, 650, 30, 8], [650, 700, 26, -10], [745, 650, 24, 10], [805, 720, 14, -6], [590, 735, 16, 4], [700, 615, 18, -4], [520, 575, 8, 6]] as [number, number, number, number][]) {
    p.line(D, FAT, [x - dx / 2, y - dy / 2], [x + dx / 2, y + dy / 2]);
  }
  p.oval(D, MID, 650, 680, 220, 105, 200, 540);
  p.line(D, MID, [420, 215], [520, 615]);
  p.line(D, MID, [475, 200], [600, 590]);
  p.oval(D, MID, 370, 175, 95, 55, 0, 360, -8);
  // Horns, ear, a tired eye, a sad mouth.
  p.line(D, MID, [400, 125], [390, 60]);
  p.line(D, MID, [445, 130], [450, 65]);
  p.dot(D, 34, 390, 55);
  p.dot(D, 34, 452, 60);
  p.curve(D, MID, [460, 145], [520, 120], [500, 165], [470, 170]);
  p.oval(D, THIN, 385, 160, 22, 14, 0, 180);
  p.line(D, THIN, [363, 160], [407, 160]);
  p.dot(D, 12, 385, 166);
  p.line(D, THIN, [360, 135], [405, 145]);
  p.dot(D, 16, 300, 165);
  p.curve(D, THIN, [295, 210], [320, 198], [345, 210]);
  // A thermometer in its mouth.
  p.line(D, MID, [310, 205], [205, 255]);
  p.dot(L, 30, 200, 258);
  // Sick: sweat, a hot face.
  p.drop(L, 470, 95, 30);
  p.drop(L, 300, 100, 26);
  // A long scarf wound round the neck, the end blowing.
  for (const [y, c] of [[255, D], [310, L], [365, D], [420, L], [475, D]] as [number, number][]) {
    const x0 = 420 + (y - 215) * 0.25;
    const x1 = 475 + (y - 205) * 0.32;
    p.line(c, FAT, [x0 - 18, y + 18], [x1 + 18, y - 12]);
  }
  const end: Pt[] = [[455, 455], [505, 470], [478, 615], [425, 602]];
  p.fill(L, FAT, end);
  p.line(D, THIN, ...end, end[0]!);
  p.line(D, MID, [445, 540], [490, 550]);
  for (const x of [432, 450, 468]) p.line(D, THIN, [x, 608], [x - 4, 645]);
  // Legs and tail.
  for (const [x, dx] of [[480, -15], [560, 0], [760, 0], [830, 15]] as Pt[]) {
    p.line(D, MID, [x, 760], [x + dx, 950]);
    p.line(D, MID, [x + 28, 765], [x + 28 + dx, 950]);
    p.fill(D, MID, [[x + dx - 5, 935], [x + dx + 33, 935], [x + dx + 33, 965], [x + dx - 5, 965]]);
  }
  p.curve(D, THIN, [866, 640], [910, 700], [920, 770]);
  p.fillOval(D, MID, 922, 790, 14, 26);
  // Cough!
  p.line(D, THIN, [180, 170], [130, 150]);
  p.line(D, THIN, [175, 205], [115, 210]);
  p.line(D, THIN, [190, 140], [160, 100]);
  // A mug of hot tea.
  p.line(D, MID, [90, 830], [90, 950], [210, 950], [210, 830]);
  p.oval(D, MID, 225, 890, 35, 40, 270, 450);
  p.fill(L, MID, [[100, 860], [200, 860], [200, 940], [100, 940]]);
  p.curve(D, THIN, [125, 800], [110, 760], [135, 720], [118, 680]);
  p.curve(D, THIN, [175, 800], [160, 760], [185, 720], [168, 680]);
  return p.strokes;
}

function laserToast(): number[][] {
  const p = new Pad(67);
  // The hero: cape, suit, mask.
  p.fill(L, FAT, [[150, 450], [300, 450], [330, 900], [40, 900]]);
  p.fill(D, FAT, [[165, 450], [285, 450], [300, 760], [150, 760]]);
  p.line(D, THIN, [165, 450], [285, 450], [300, 760], [150, 760], [165, 450]);
  p.line(D, THIN, [150, 452], [40, 900], [330, 900], [300, 452]);
  p.line(L, MID, [190, 520], [262, 520]);
  p.line(L, MID, [226, 520], [226, 600]);
  p.line(D, MID, [175, 760], [170, 950]);
  p.line(D, MID, [275, 760], [285, 950]);
  p.oval(D, MID, 225, 340, 100, 105);
  p.fill(D, MID, [[130, 295], [320, 295], [320, 345], [130, 345]]);
  p.fillOval(L, THIN, 195, 320, 22, 14);
  p.fillOval(L, THIN, 268, 320, 22, 14);
  p.dot(D, 16, 200, 320);
  p.dot(D, 16, 273, 320);
  p.line(D, MID, [165, 285], [225, 300]);
  p.line(D, MID, [240, 300], [300, 285]);
  p.line(D, MID, [200, 400], [255, 395]);
  p.curve(D, FAT, [135, 270], [150, 235], [200, 228], [250, 225], [300, 240], [325, 275]);
  // The lasers.
  p.line(L, MID, [205, 320], [655, 360]);
  p.line(L, MID, [278, 320], [655, 382]);
  p.line(L, THIN, [330, 300], [360, 285]);
  p.line(L, THIN, [335, 345], [365, 360]);
  // The slice turning into toast, smoking.
  const slice: Pt[] = spline([[640, 470], [640, 300], [622, 262], [650, 220], [705, 212], [730, 230], [760, 212], [815, 220], [842, 262], [820, 300], [820, 470], [640, 470]]);
  p.fill(L, FAT, slice);
  p.curve(D, MID, [640, 470], [640, 300], [622, 262], [650, 220], [705, 212], [730, 230], [760, 212], [815, 220], [842, 262], [820, 300], [820, 470], [640, 470]);
  p.curve(D, MID, [670, 340], [700, 330], [690, 370], [720, 360], [700, 400], [745, 385]);
  // A plate piled with toast already.
  for (let i = 0; i < 4; i++) {
    const y = 840 - i * 42;
    const d = i % 2 ? 8 : -6;
    p.fill(L, MID, [[600 + d, y - 36], [880 + d, y - 36], [880 + d, y], [600 + d, y]]);
    p.line(D, THIN, [600 + d, y - 36], [880 + d, y - 36], [880 + d, y], [600 + d, y], [600 + d, y - 36]);
  }
  p.curve(D, MID, ...arc(740, 860, 200, 32, 0, 180));
  p.line(D, MID, [540, 860], [940, 860]);
  p.curve(D, THIN, [680, 180], [660, 140], [690, 100], [670, 60]);
  p.curve(D, THIN, [760, 180], [780, 140], [750, 100], [775, 55]);
  return p.strokes;
}

function helmetWipers(): number[][] {
  const p = new Pad(79);
  // Rain clouds and rain.
  for (const [cx, cy] of [[160, 110], [820, 100]] as Pt[]) {
    const c: Pt[] = [...arc(cx - 60, cy + 10, 60, 50, 90, 270), ...arc(cx + 10, cy - 20, 70, 60, 190, 340), ...arc(cx + 80, cy + 15, 50, 45, 260, 450)];
    p.fill(L, MID, c);
    p.curve(D, MID, ...c, [cx - 60, cy + 60]);
  }
  for (const [x, y] of [[90, 240], [180, 290], [250, 230], [60, 400], [130, 520], [770, 240], [860, 260], [930, 380], [880, 520], [940, 640], [70, 650], [400, 140], [610, 150], [500, 90], [800, 640], [160, 700]] as Pt[]) {
    p.line(L, THIN, [x, y], [x - 12, y + 44]);
  }
  // Shoulders in a rain jacket.
  p.fill(L, FAT, [[310, 745], [690, 745], [820, 905], [180, 905]]);
  p.line(D, MID, [180, 905], [310, 745], [690, 745], [820, 905]);
  p.line(D, THIN, [500, 755], [500, 900]);
  // The face, the helmet.
  p.oval(D, MID, 500, 585, 145, 150);
  p.curve(D, MID, [445, 680], [475, 700], [500, 705], [525, 700], [555, 680]);
  const dome: Pt[] = arc(500, 452, 212, 232, 180, 360);
  p.fill(L, FAT, dome);
  p.curve(D, MID, ...dome);
  p.line(D, MID, [285, 452], [715, 452]);
  for (const [x0, x1] of [[410, 395], [500, 500], [590, 605]] as Pt[]) p.line(D, MID, [x0, 280], [x1, 390]);
  // The visor, rain on it but where the two wipers sweep.
  p.line(D, MID, [300, 455], [300, 600], [330, 640], [670, 640], [700, 600], [700, 455]);
  const pivots: Pt[] = [[410, 630], [590, 630]];
  const R = 150;
  const swept = ([x, y]: Pt) =>
    pivots.some(([px, py]) => {
      const a = (Math.atan2(y - py, x - px) * 180) / Math.PI + 360;
      return Math.hypot(x - px, y - py) < R + 18 && a > 205 && a < 295;
    });
  for (let y = 478; y < 630; y += 40) {
    for (let x = 322 + ((y / 40) % 2) * 22; x < 690; x += 44) if (!swept([x, y])) p.drop(L, x, y, 17);
  }
  p.dot(D, 26, 455, 545);
  p.dot(D, 26, 548, 545);
  for (const [px, py] of pivots) {
    p.curve(L, THIN, ...arc(px, py, R + 6, R + 6, 212, 288));
    const r = (240 * Math.PI) / 180;
    const tip: Pt = [px + Math.cos(r) * R, py + Math.sin(r) * R];
    const mid: Pt = [px + Math.cos(r) * 45, py + Math.sin(r) * 45];
    p.line(D, THIN, [px, py], mid);
    p.line(D, MID, mid, tip);
    p.dot(D, 30, px, py);
  }
  // Handlebars and hands.
  p.line(D, MID, [140, 930], [420, 905], [580, 905], [860, 930]);
  p.line(D, FAT, [100, 930], [180, 935]);
  p.line(D, FAT, [820, 935], [900, 930]);
  p.dot(D, 30, 500, 905);
  return p.strokes;
}

/** The strokes the phone's picture leaves out (it shows Phil nearly done): every drawing ends with small details. */
export const LAST_TOUCHES = 3;

export interface Scene {
  /** The prompt as `data/prompts.txt` has it, and its structure there. */
  prompt: string;
  tag: string;
  strokes: number[][];
  /** Fake titles for this drawing, one per player who is not its artist, in {@link PLAYERS} order. */
  lies: readonly string[];
}

export const SCENES: readonly Scene[] = [
  {
    prompt: "a snowman in a sauna",
    tag: "odd",
    strokes: snowmanInASauna(),
    lies: ["a snowman with a fever", "the last day of winter", "a snowman at the spa", "a snowman who loves summer", "a meltdown in the steam room", "a cold guy in a hot room"],
  },
  {
    prompt: "raining cats and dogs",
    tag: "idiom",
    strokes: rainingCatsAndDogs(),
    lies: ["the worst weather forecast ever", "a cloud full of pets", "when pets fly", "a storm at the animal shelter", "the day the pet shop blew away", "an umbrella full of luck"],
  },
  {
    prompt: "the moment the ice cream falls",
    tag: "moment",
    strokes: iceCreamFalls(),
    lies: ["the saddest day of summer", "a kid learning about gravity", "a scoop making a run for it", "an ice cream's great escape", "the moment you needed a cup", "a cone with commitment issues"],
  },
  {
    prompt: "the seagull and the sandwich",
    tag: "drama",
    strokes: seagullAndSandwich(),
    lies: ["lunch at the beach gone wrong", "a seagull's lucky day", "a sandwich that learned to fly", "the great beach heist", "home delivery for seagulls", "a picnic under attack"],
  },
  {
    prompt: "a giraffe with a sore throat",
    tag: "animal",
    strokes: giraffeSoreThroat(),
    lies: ["a giraffe catching a cold", "the longest scarf in the world", "a giraffe on a sick day", "a very long cough", "a giraffe at the doctor", "winter at the zoo"],
  },
  {
    prompt: "laser eyes that only make toast",
    tag: "power",
    strokes: laserToast(),
    lies: ["a superhero's breakfast", "the world's fastest toaster", "the power to make breakfast", "burnt toast again", "a hero who hates bread", "a superhero working at a cafe"],
  },
  {
    prompt: "a helmet with windshield wipers",
    tag: "gadget",
    strokes: helmetWipers(),
    lies: ["cycling to work in the rain", "a car wash for your face", "glasses for rainy days", "the safest bike ride ever", "a raincoat for your face", "a hat with a built in umbrella"],
  },
];

/** `data/prompts.txt` for the round: only the scenes' prompts. */
export function promptsFile(): string {
  return SCENES.map((s) => `[${s.tag}]\n${s.prompt}\n`).join("\n");
}

/** Who drew which prompt this round (name → prompt), as each one learns it. */
export const dealt = new Map<string, string>();

/** The scene of a prompt as dealt (the display form: the same here). */
export function scene(prompt: string): Scene {
  const s = SCENES.find((x) => x.prompt === prompt.trim().toLowerCase());
  if (!s) throw new Error(`no drawing for the prompt ${JSON.stringify(prompt)}`);
  return s;
}

/** The fake title `name` writes for `artist`'s drawing. */
export function lieFor(name: string, artist: string): string {
  const prompt = dealt.get(artist);
  if (!prompt) throw new Error(`${artist}'s prompt is not known`);
  const others = PLAYERS.filter((p) => p !== artist);
  const i = others.indexOf(name as (typeof PLAYERS)[number]);
  const lies = scene(prompt).lies;
  return lies[(i < 0 ? 0 : i) % lies.length]!;
}

// `node test/live/scenario.ts DIR`: the drawings as PNGs (in the pens of player colour N, default 0: `DIR N`; only scene I, larger: `DIR N I`).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] ?? "/tmp/drawbluff-scenes";
  mkdirSync(dir, { recursive: true });
  const strokesJs = readFileSync(new URL("../../phone/strokes.js", import.meta.url), "utf8").replace(/^export /gm, "");
  const pens = palette(Number(process.argv[3] ?? 0));
  const only = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
  const shown = SCENES.filter((_, i) => only === undefined || i === only);
  const size = only === undefined ? 500 : 900;
  const cells = shown.map((s, i) => `<figure><canvas id="c${i}" width="${size}" height="${size}"></canvas><figcaption>${s.prompt} (${s.strokes.length} strokes, ${s.strokes.reduce((n, x) => n + (x.length - 2) / 2, 0)} points)</figcaption></figure>`).join("");
  const html = `<!doctype html><style>body{margin:0;background:#333;display:flex;flex-wrap:wrap;gap:10px;padding:10px;font:16px sans-serif;color:#fff}figure{margin:0}</style>${cells}<script>${strokesJs}
const scenes = ${JSON.stringify(shown.map((s) => s.strokes))};
scenes.forEach((strokes, i) => drawDrawing(document.getElementById("c" + i).getContext("2d"), { strokes, palette: ${JSON.stringify(pens)} }, 0, 0, ${size}));
</script>`;
  writeFileSync(`${dir}/scenes.html`, html);
  const chrome = process.env["CHROME"] ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
  execFileSync(chrome, ["--headless=new", `--screenshot=${dir}/scenes.png`, only === undefined ? "--window-size=1560,1640" : "--window-size=940,960", "--hide-scrollbars", `file://${dir}/scenes.html`], { stdio: "ignore" });
  console.log(`${dir}/scenes.png`);
}
