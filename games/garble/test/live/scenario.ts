/**
 * The round `play.ts --shots` plays for the games list: four people, one
 * picture each, every layer drawn by hand for its word ON TOP of the
 * picture it was given (reusing its lines: that is the game), and every
 * guess a fair reading of the picture as it then was. Strokes are on the
 * game's 1000 × 1000 grid in the phone's three pen widths.
 *
 * The seats are Phil (the phone), Mia, Jonas, Lena; picture `c` is
 * started by `PEOPLE[c]`, its layer `k` drawn by `PEOPLE[(c + k) % 4]`
 * and read by the next one:
 *
 * - Phil's fish → (Mia) a rocket: the head is the nose cone, the tail the
 *   fins, flames behind → (Jonas) a carrot: the flames grow leaves, rings
 *   round the body.
 * - Mia's sun → (Jonas) a lion: the rays become a mane, ears, a muzzle →
 *   (Lena) a clock: numbers round the face, hands from the nose; Phil
 *   still reads a lion.
 * - Jonas's cloud → (Lena) a sheep: a head, legs, a tail → (Phil) a tree:
 *   a trunk under the wool, apples in it.
 * - Lena's cat → (Phil) a submarine: the body is the hull, a tower and a
 *   periscope, portholes, a propeller at the tail, the sea → (Mia) a
 *   hedgehog: spikes all over the back, a pointed snout.
 *
 *   node test/live/scenario.ts --preview /tmp/garble-scenario   (every layer's stage as PNG, to look at)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { WIDTHS } from "../../game/ink.ts";
import type { Tab } from "./browser.ts";

type Stroke = number[];

/** The phone's pens. */
const [FINE, PEN, FAT] = WIDTHS as readonly number[] as [number, number, number];

// A steady hand that is not a machine's: small fixed wobbles.
let seed = 7;
function wobble(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648 - 0.5;
}
const at = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));

/** A polyline with sharp corners (each inner corner twice, so the ink's smoothing keeps it). */
function line(w: number, ...xy: number[]): Stroke {
  const out = [w];
  for (let i = 0; i < xy.length; i += 2) {
    const p = [at(xy[i]!), at(xy[i + 1]!)];
    out.push(...p);
    if (i > 0 && i + 2 < xy.length) out.push(...p);
  }
  return out;
}

/** A smooth stroke through (near) the points. */
function curve(w: number, ...xy: number[]): Stroke {
  return [w, ...xy.map(at)];
}

/** An arc of an ellipse, degrees (0 = right, 90 = down), turned by `rot`. */
function arc(cx: number, cy: number, rx: number, ry: number, from = 0, to = 360, w = PEN, rot = 0): Stroke {
  const out = [w];
  const n = Math.max(3, Math.ceil(Math.abs(to - from) / 12));
  const t = (rot * Math.PI) / 180;
  for (let i = 0; i <= n; i++) {
    const a = ((from + ((to - from) * i) / n) * Math.PI) / 180;
    const k = 1 + wobble() * 0.04;
    const x = Math.cos(a) * rx * k;
    const y = Math.sin(a) * ry * k;
    out.push(at(cx + x * Math.cos(t) - y * Math.sin(t)), at(cy + x * Math.sin(t) + y * Math.cos(t)));
  }
  return out;
}

/** A closed ellipse (it overlaps its start a little, as a hand does). */
const ring = (cx: number, cy: number, rx: number, ry = rx, w = PEN, rot = 0): Stroke => arc(cx, cy, rx, ry, -100, 272, w, rot);
const dot = (x: number, y: number, w = FAT): Stroke => [w, at(x), at(y)];
/** A four-ray sparkle. */
const sparkle = (x: number, y: number, r = 30): Stroke[] => [line(FINE, x - r, y, x + r, y), line(FINE, x, y - r, x, y + r)];
/** A point at angle `a` (degrees) and radius `r` round (cx, cy). */
const polar = (cx: number, cy: number, r: number, a: number): [number, number] => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];

/** Hand-written digits in a box `s` high at (x, y) (its top left). */
function digit(d: string, x: number, y: number, s: number, w = PEN): Stroke[] {
  const W = s * 0.55;
  switch (d) {
    case "1":
      return [line(w, x + W * 0.2, y + s * 0.2, x + W * 0.55, y, x + W * 0.55, y + s)];
    case "2":
      return [curve(w, x, y + s * 0.25, x + W * 0.3, y, x + W, y + s * 0.15, x + W * 0.9, y + s * 0.45, x, y + s, x + W, y + s)];
    case "3":
      return [curve(w, x, y + s * 0.1, x + W * 0.6, y, x + W, y + s * 0.22, x + W * 0.4, y + s * 0.47, x + W, y + s * 0.7, x + W * 0.6, y + s, x, y + s * 0.92)];
    case "6":
      return [curve(w, x + W * 0.9, y, x + W * 0.2, y + s * 0.3, x, y + s * 0.75, x + W * 0.45, y + s, x + W, y + s * 0.75, x + W * 0.6, y + s * 0.5, x + W * 0.05, y + s * 0.7)];
    case "9":
      return [curve(w, x + W, y + s * 0.3, x + W * 0.55, y + s * 0.5, x, y + s * 0.3, x + W * 0.45, y, x + W, y + s * 0.3, x + W * 0.8, y + s * 0.7, x + W * 0.2, y + s)];
    default:
      return [];
  }
}
function number(n: string, cx: number, cy: number, s: number): Stroke[] {
  const W = s * 0.55;
  const gap = s * 0.18;
  const total = n.length * W + (n.length - 1) * gap;
  return [...n].flatMap((d, i) => digit(d, cx - total / 2 + i * (W + gap), cy - s / 2, s));
}

// ---------------------------------------------------------------------------
// Picture 0, Phil's: fish → rocket → carrot.

const fish: Stroke[] = [
  // The body: a lens from the snout (left) to the tail.
  curve(PEN, 170, 505, 250, 400, 380, 340, 520, 345, 640, 400, 720, 495),
  curve(PEN, 170, 505, 250, 600, 380, 660, 520, 655, 640, 600, 720, 505),
  // The tail.
  line(PEN, 715, 500, 860, 385, 840, 500, 860, 615, 715, 500),
  // Eye, gill, mouth.
  ring(280, 470, 26, 26, FINE),
  dot(284, 472, 22),
  curve(FINE, 370, 405, 395, 500, 370, 595),
  line(FINE, 175, 510, 215, 520),
  // Scales and a fin.
  arc(470, 470, 40, 40, -70, 70, FINE),
  arc(540, 520, 40, 40, -70, 70, FINE),
  arc(470, 570, 40, 40, -70, 70, FINE),
  curve(FINE, 470, 350, 530, 270, 600, 375),
  // Bubbles.
  ring(120, 380, 18, 18, FINE),
  ring(95, 300, 12, 12, FINE),
];

const rocket: Stroke[] = [
  // The eye becomes a porthole; bands round the body.
  ring(282, 470, 52, 52, PEN),
  curve(PEN, 430, 350, 445, 500, 430, 652),
  curve(PEN, 610, 380, 625, 500, 610, 615),
  // More fins, above and below.
  line(PEN, 560, 360, 650, 230, 700, 260, 680, 420),
  line(PEN, 560, 640, 650, 770, 700, 740, 680, 580),
  // Flames out of the tail.
  line(PEN, 860, 410, 985, 450, 905, 480, 995, 510, 905, 540, 985, 575, 860, 595),
  line(FINE, 870, 470, 940, 500, 870, 530),
  // Space: stars, and speed lines.
  ...sparkle(150, 160),
  ...sparkle(820, 130, 24),
  ...sparkle(150, 830, 24),
  ...sparkle(560, 880),
  line(FINE, 760, 300, 900, 300),
  line(FINE, 770, 700, 910, 700),
];

const carrot: Stroke[] = [
  // The flames grow into a bunch of big leaves, each with its rib.
  arc(845, 305, 42, 150, 0, 360, PEN, 12),
  line(FINE, 865, 452, 815, 170),
  arc(920, 345, 36, 120, 0, 360, PEN, 35),
  line(FINE, 880, 450, 960, 245),
  arc(770, 330, 34, 120, 0, 360, PEN, -25),
  line(FINE, 830, 445, 720, 220),
  // Rings round the body, all along it.
  ...[220, 300, 380, 500, 580, 660].flatMap((x, i) => [
    curve(PEN, x - 20, 440 - (i % 2) * 20, x + 10, 455 - (i % 2) * 20, x + 30, 445 - (i % 2) * 20),
    curve(PEN, x, 570 + (i % 2) * 25, x + 25, 585 + (i % 2) * 25, x + 50, 570 + (i % 2) * 25),
  ]),
  // A few roots off the tip.
  line(FINE, 170, 505, 95, 525),
  line(FINE, 200, 555, 150, 600),
];

// ---------------------------------------------------------------------------
// Picture 1, Mia's: sun → lion → clock.

const sun: Stroke[] = [
  ring(500, 500, 170, 170, PEN),
  // Rays.
  ...Array.from({ length: 12 }, (_, i) => {
    const a = i * 30 + 15;
    const [x0, y0] = polar(500, 500, 205, a);
    const [x1, y1] = polar(500, 500, 290, a);
    return line(PEN, x0, y0, x1, y1);
  }),
  // A face.
  dot(440, 460, 30),
  dot(560, 460, 30),
  arc(500, 520, 80, 60, 20, 160, PEN),
];

const lion: Stroke[] = [
  // The mane: scallops round the rays.
  ...Array.from({ length: 14 }, (_, i) => {
    const a0 = (i * 360) / 14;
    const a1 = ((i + 1) * 360) / 14;
    const [x0, y0] = polar(500, 500, 300, a0);
    const [xm, ym] = polar(500, 500, 352, (a0 + a1) / 2);
    const [x1, y1] = polar(500, 500, 300, a1);
    return curve(PEN, x0, y0, xm, ym, x1, y1);
  }),
  // Ears on the face.
  arc(395, 355, 45, 45, 150, 380, PEN),
  arc(605, 355, 45, 45, 160, 390, PEN),
  // A muzzle: the nose, the mouth, whisker dots.
  line(PEN, 470, 505, 530, 505, 500, 540, 470, 505),
  curve(PEN, 500, 540, 495, 575, 455, 590),
  curve(PEN, 500, 540, 505, 575, 545, 590),
  dot(440, 545, 12),
  dot(425, 565, 12),
  dot(560, 545, 12),
  dot(575, 565, 12),
];

const clock: Stroke[] = [
  // Numbers round the face, hands from the middle.
  ...number("12", 500, 375, 60),
  ...number("3", 630, 500, 60),
  ...number("6", 500, 625, 60),
  ...number("9", 370, 500, 60),
  line(FAT, 500, 505, 500, 400),
  line(PEN, 500, 505, 585, 450),
  // Ticks between the numbers.
  ...[30, 60, 120, 150, 210, 240, 300, 330].map((a) => {
    const [x0, y0] = polar(500, 500, 148, a);
    const [x1, y1] = polar(500, 500, 165, a);
    return line(FINE, x0, y0, x1, y1);
  }),
];

// ---------------------------------------------------------------------------
// Picture 2, Jonas's: cloud → sheep → tree.

const cloud: Stroke[] = [
  curve(PEN, 270, 520, 220, 470, 250, 400, 320, 390, 340, 320, 420, 290, 480, 320, 520, 260, 610, 260, 650, 320, 720, 310, 770, 370, 760, 430, 800, 480, 770, 540, 700, 560, 640, 550, 590, 580, 520, 560, 460, 585, 400, 560, 340, 575, 270, 520),
  // Puffs inside.
  arc(430, 380, 60, 45, 200, 320, FINE),
  arc(620, 370, 60, 45, 210, 330, FINE),
  // A few drops of wind.
  curve(FINE, 140, 300, 180, 280, 220, 300),
  curve(FINE, 840, 260, 880, 240, 920, 260),
];

const sheep: Stroke[] = [
  // The head, dark, with ears and eyes.
  ring(215, 470, 70, 85, PEN, -15),
  line(PEN, 160, 420, 100, 400, 150, 450),
  line(PEN, 265, 410, 320, 380, 290, 440),
  dot(195, 465, 20),
  dot(240, 460, 20),
  curve(FINE, 200, 520, 215, 530, 232, 520),
  // Legs with hooves.
  line(PEN, 360, 570, 355, 740),
  line(PEN, 430, 580, 430, 750),
  line(PEN, 600, 575, 605, 745),
  line(PEN, 680, 560, 690, 730),
  dot(352, 745, FAT),
  dot(430, 755, FAT),
  dot(606, 750, FAT),
  dot(692, 735, FAT),
  // The tail, and grass.
  curve(PEN, 790, 470, 830, 450, 840, 480, 805, 495),
  line(FINE, 80, 770, 920, 770),
  line(FINE, 150, 770, 165, 735, 180, 770),
  line(FINE, 780, 770, 795, 735, 810, 770),
];

const tree: Stroke[] = [
  // A trunk under the wool, with roots.
  curve(PEN, 480, 570, 470, 700, 455, 880, 400, 935),
  curve(PEN, 545, 570, 555, 700, 570, 880, 630, 935),
  line(PEN, 430, 925, 500, 890, 520, 940),
  line(FINE, 60, 945, 940, 945),
  // Branches into the crown.
  line(PEN, 490, 560, 440, 470, 380, 440),
  line(PEN, 530, 560, 580, 450, 650, 420),
  line(FINE, 450, 490, 480, 420),
  // Apples.
  ring(340, 470, 24, 24, PEN),
  ring(510, 350, 24, 24, PEN),
  ring(690, 470, 24, 24, PEN),
  ring(600, 330, 22, 22, PEN),
  line(FINE, 340, 446, 350, 425),
  line(FINE, 510, 326, 520, 305),
  line(FINE, 690, 446, 700, 425),
  // A bird.
  curve(PEN, 820, 160, 850, 135, 880, 160, 910, 135, 940, 160),
];

// ---------------------------------------------------------------------------
// Picture 3, Lena's: cat → submarine → hedgehog.

const cat: Stroke[] = [
  // The body, lying along; the head at the front.
  ring(520, 560, 230, 120, PEN),
  ring(255, 450, 95, 88, PEN),
  // Ears.
  line(PEN, 185, 395, 190, 300, 245, 365),
  line(PEN, 268, 362, 320, 292, 335, 395),
  // Eyes, nose, whiskers.
  dot(222, 440, 26),
  dot(290, 440, 26),
  line(PEN, 245, 478, 268, 478, 256, 492, 245, 478),
  line(FINE, 230, 492, 140, 475),
  line(FINE, 230, 502, 140, 515),
  line(FINE, 285, 492, 370, 475),
  // Legs and the tail.
  line(PEN, 390, 665, 385, 770),
  line(PEN, 450, 675, 448, 775),
  line(PEN, 600, 675, 602, 772),
  line(PEN, 665, 662, 672, 765),
  curve(PEN, 745, 540, 830, 490, 860, 400, 820, 330, 780, 345),
];

const submarine: Stroke[] = [
  // A conning tower on the back, a periscope.
  line(PEN, 470, 450, 485, 360, 610, 360, 625, 452),
  line(PEN, 545, 360, 545, 240, 610, 240),
  line(PEN, 610, 225, 640, 225, 640, 258, 610, 258),
  // Portholes along the hull.
  ring(430, 560, 32),
  ring(530, 565, 32),
  ring(630, 560, 32),
  // A propeller at the tail.
  line(PEN, 750, 560, 800, 560),
  line(PEN, 800, 500, 800, 620),
  arc(815, 520, 18, 30, -90, 90, PEN),
  arc(815, 600, 18, 30, -90, 90, PEN),
  // The sea: waves above, bubbles from the propeller.
  curve(PEN, 30, 175, 110, 140, 190, 175, 270, 140, 350, 175, 430, 140, 510, 175),
  curve(PEN, 680, 175, 760, 140, 840, 175, 920, 140, 990, 170),
  ring(870, 450, 20),
  ring(900, 390, 14),
  ring(880, 335, 10),
  // Weed on the sea floor.
  curve(FINE, 120, 900, 140, 840, 110, 780, 135, 720),
  curve(FINE, 860, 900, 880, 830, 850, 770),
  line(FINE, 30, 900, 970, 900),
];

const hedgehog: Stroke[] = [
  // Spikes all over the back.
  ...Array.from({ length: 17 }, (_, i) => {
    // From the hull's outline outwards, a zigzag: out, back a little.
    const t = ((192 + i * 9.5) * Math.PI) / 180;
    const bx = 520 + 230 * Math.cos(t);
    const by = 560 + 120 * Math.sin(t);
    return line(PEN, bx, by, bx + 75 * Math.cos(t), by + 75 * Math.sin(t) - 25, bx + 40 * Math.cos(t + 0.25), by + 40 * Math.sin(t + 0.25));
  }),
  // A pointed snout with a nose, a little mouth.
  line(PEN, 175, 470, 80, 520, 200, 535),
  dot(80, 520, FAT),
  // Feet.
  arc(388, 780, 28, 14, 180, 360, PEN),
  arc(605, 780, 28, 14, 180, 360, PEN),
  // An apple carried on the spikes.
  ring(700, 330, 34),
  line(FINE, 700, 296, 712, 270),
];

// ---------------------------------------------------------------------------
// The round.

/** The seats in order: picture `c` is started by `PEOPLE[c]`. */
export const PEOPLE = ["Phil", "Mia", "Jonas", "Lena"] as const;
export type Person = (typeof PEOPLE)[number];

export interface ScriptedPicture {
  /** The two words dealt to the starter, and which they pick. */
  choices: [string, string];
  pick: 0 | 1;
  /** The words of the later layers (dealt). */
  words: string[];
  /** One drawing per layer. */
  layers: Stroke[][];
  /** What the next player wrote after each layer. */
  guesses: string[];
}

export const PICTURES: ScriptedPicture[] = [
  { choices: ["fish", "hat"], pick: 0, words: ["rocket", "carrot"], layers: [fish, rocket, carrot], guesses: ["a fish", "rocket", "carrot"] },
  { choices: ["kite", "sun"], pick: 1, words: ["lion", "clock"], layers: [sun, lion, clock], guesses: ["sun", "lion", "lion"] },
  { choices: ["cloud", "shoe"], pick: 0, words: ["sheep", "tree"], layers: [cloud, sheep, tree], guesses: ["cloud", "sheep", "apple tree"] },
  { choices: ["bell", "cat"], pick: 1, words: ["submarine", "hedgehog"], layers: [cat, submarine, hedgehog], guesses: ["cat", "submarine", "porcupine"] },
];

/** The picture the TV's screenshot shows, finished: Mia's sun, a lion, a clock (read as a lion). */
export const COVER = 1;

/** The best-move votes (picture:layer); Phil's is tapped on the phone. */
export const VOTES: Record<Person, string> = { Phil: "0:2", Mia: "3:1", Jonas: "3:1", Lena: "3:1" };

/** The game's script (`game.script`): the seats and the words. */
export function script(): { seats: string[]; pictures: { choices: [string, string]; words: string[] }[]; first: number } {
  // The reveal starts two pictures before the cover: the TV's picture has two finished ones beside it.
  return { seats: [...PEOPLE], pictures: PICTURES.map((p) => ({ choices: p.choices, words: p.words })), first: (COVER + 2) % PEOPLE.length };
}

/** The picture a person works on at step `k` (0-based), and its layer there. */
export function work(person: Person, k: number): { picture: number; layer: number } {
  const s = PEOPLE.indexOf(person);
  return { picture: (((s - k) % 4) + 4) % 4, layer: k };
}

/**
 * Script for the host page (`win.eval`): Mia, Jonas and Lena join as
 * clients (as the host's bots do, through tvpipe) and play their part:
 * pick and draw, guess, draw on top, vote, each a little while after it
 * is their turn. Resolves once all joined.
 */
export function joinScript(): string {
  return `(async () => {
    const { memoryStorage, PartyClient } = await import("/_tvpipe/lib/client.js");
    const url = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/_tvpipe/ws";
    const people = ${JSON.stringify(PEOPLE)};
    const pictures = ${JSON.stringify(PICTURES)};
    const votes = ${JSON.stringify(VOTES)};
    globalThis.__people = [];
    for (const name of people.slice(1)) {
      const s = people.indexOf(name);
      const c = new PartyClient({ url, room: garble.party.code, key: garble.party.joinKey, storage: memoryStorage() });
      const done = new Set();
      const once = (key, ms, fn) => {
        if (done.has(key)) return;
        done.add(key);
        setTimeout(() => fn().catch((e) => console.error("scenario: " + name + " " + key + ": " + (e.message ?? e))), ms);
      };
      c.on("view", (v) => {
        const me = v.me ?? {};
        const k = (me.step ?? 1) - 1;
        const p = pictures[(((s - k) % 4) + 4) % 4];
        const think = 2500 + s * 1400;
        if (me.task === "draw" && !me.done) {
          once("draw" + k, think, () => c.act("draw", { strokes: p.layers[k], ...(k === 0 ? { choice: p.pick } : {}) }));
        } else if (me.task === "guess" && !me.done) {
          once("guess" + k, 1500 + s * 900, () => c.act("guess", { text: p.guesses[k - 1] }));
        } else if (me.task === "vote" && !me.done) {
          once("vote", 1500 + s * 1200, () => c.act("vote", { layer: votes[name] }));
        }
      });
      await c.join(name);
      globalThis.__people.push(c);
    }
    return true;
  })()`;
}

/** Draws strokes on the phone's pad (touch drags; the pad's box in CSS px), each pen picked first. */
export async function drawOn(phone: Tab, box: { x: number; y: number; w: number }, strokes: Stroke[]): Promise<void> {
  const widths = [FINE, PEN, FAT];
  let pen = -1;
  for (const s of strokes) {
    const w = widths.indexOf(s[0]!);
    if (w !== pen && w >= 0) {
      await phone.eval(`document.querySelectorAll(".sizes button")[${w}].click(); true`);
      pen = w;
    }
    const pts: [number, number][] = [];
    for (let i = 1; i + 1 < s.length; i += 2) pts.push([box.x + (s[i]! / 1000) * box.w, box.y + (s[i + 1]! / 1000) * box.w]);
    // A dot is a tap that moves a hair.
    if (pts.length === 1) pts.push([pts[0]![0] + 0.5, pts[0]![1] + 0.5]);
    await phone.drag(pts);
  }
}

// ---------------------------------------------------------------------------
// Every layer's stage as a PNG (`--preview DIR`): the picture as the next
// player sees it (one ink), and as the reveal shows it (colours).

if (process.argv[2] === "--preview") {
  const dir = process.argv[3] ?? "/tmp/garble-scenario";
  mkdirSync(dir, { recursive: true });
  const ink = readFileSync(new URL("../../phone/ink.js", import.meta.url), "utf8").replace(/^export /gm, "");
  const colors = ["#d62d3a", "#2f5bd8", "#cc6a0a", "#13895a"];
  // One row per picture: what each reader saw (one ink), then the reveal (colours).
  const S = 300;
  const html = `<!doctype html><body style="margin:0;background:#333"><canvas id="c" width="${S * 4 + 30}" height="${S * PICTURES.length + 30}"></canvas><script>${ink}
const pictures = ${JSON.stringify(PICTURES)};
const colors = ${JSON.stringify(colors)};
const ctx = document.getElementById("c").getContext("2d");
ctx.fillStyle = "#333"; ctx.fillRect(0, 0, 9999, 9999);
pictures.forEach((pic, p) => {
  for (let k = 0; k <= 3; k++) {
    const coloured = k === 3;
    const upTo = coloured ? 3 : k + 1;
    const layers = pic.layers.slice(0, upTo).map((strokes, i) => ({ drawing: { strokes }, color: coloured ? colors[(p + i) % 4] : INK }));
    drawLayers(ctx, layers, k * (${S} + 10), p * (${S} + 10), ${S});
    ctx.fillStyle = "#c00"; ctx.font = "bold 18px sans-serif";
    ctx.fillText(coloured ? "reveal" : (k === 0 ? pic.choices[pic.pick] : pic.words[k - 1]) + "  → " + pic.guesses[k], k * (${S} + 10) + 6, p * (${S} + 10) + ${S} - 8);
  }
});
window.ready = true;
</script>`;
  writeFileSync(`${dir}/preview.html`, html);
  const { Browser } = await import("./browser.ts");
  const b = await Browser.launch();
  try {
    const tab = await b.open(`file://${dir}/preview.html`, { width: S * 4 + 30, height: S * PICTURES.length + 30 });
    await tab.until(`window.ready === true`);
    await tab.screenshot(`${dir}/sheet.png`);
  } finally {
    b.close();
  }
  console.log(`${dir}/sheet.png: a row per picture, each stage as the reader saw it (its word → their guess), then the reveal`);
}
