/**
 * The round `play.ts --shots` plays for the games list: four people draw
 * zoo animals, every drawing made by hand (strokes on the game's 1000 ×
 * 1000 grid, in the pad's pens and widths), and the guesses at the first
 * one on stage typed at fixed moments of its replay.
 *
 * Phil (the phone) draws a giraffe by touch; Mia's elephant goes on
 * stage first: a grey shape with four legs (Lena: "rock", Phil: "hippo",
 * Jonas: "rhino"), then the big ear (Lena has it), then the trunk. The
 * pictures are taken when the replay is not quite half through.
 *
 *   node test/live/scenario.ts --preview /tmp/krakel-scenario   (each drawing whole and half replayed, as PNG)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { costOf, totalCost } from "../../game/ink.ts";
import type { Script } from "../../game/game.ts";
import type { Tab } from "./browser.ts";

type Stroke = number[];

/** The pad's pens (`PALETTE` in game/ink.ts) and widths (`WIDTHS`). */
const BLACK = 1;
const GREY = 2;
const RED = 3;
const ORANGE = 4;
const YELLOW = 5;
const LIME = 6;
const GREEN = 7;
const SKY = 8;
const PINK = 11;
const BROWN = 12;
const SKIN = 13;
const FINE = 6;
const PEN = 14;
const FAT = 30;
const BRUSH = 64;
const PENS: Record<number, string> = { 0: "eraser", 1: "black", 2: "grey", 3: "red", 4: "orange", 5: "yellow", 6: "light green", 7: "green", 8: "light blue", 9: "blue", 10: "purple", 11: "pink", 12: "brown", 13: "skin" };
const SIZES: Record<number, string> = { [FINE]: "fine pen", [PEN]: "medium pen", [FAT]: "thick pen", [BRUSH]: "brush" };

// A steady hand that is not a machine's: small fixed wobbles.
let seed = 11;
function wobble(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648 - 0.5;
}
const at = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));

/** A line through the points, a little unsteady (the ink's smoothing rounds its corners). */
function line(color: number, w: number, ...xy: number[]): Stroke {
  const out = [color, w];
  for (let i = 0; i < xy.length; i += 2) out.push(at(xy[i]! + wobble() * 5), at(xy[i + 1]! + wobble() * 5));
  return out;
}

/** A polyline with sharp corners (each inner corner twice, so the smoothing keeps it). */
function sharp(color: number, w: number, ...xy: number[]): Stroke {
  const out = [color, w];
  for (let i = 0; i < xy.length; i += 2) {
    const p = [at(xy[i]!), at(xy[i + 1]!)];
    out.push(...p);
    if (i > 0 && i < xy.length - 2) out.push(...p);
  }
  return out;
}

/** An ellipse drawn in one go (from `from`, `turns` of a turn), a little unsteady. */
function oval(color: number, w: number, cx: number, cy: number, rx: number, ry: number, from = -0.25, turns = 1.03): Stroke {
  const out = [color, w];
  const n = Math.max(10, Math.round((rx + ry) / 12));
  for (let i = 0; i <= n; i++) {
    const a = (from + (i / n) * turns) * Math.PI * 2;
    out.push(at(cx + Math.cos(a) * rx * (1 + wobble() * 0.03)), at(cy + Math.sin(a) * ry * (1 + wobble() * 0.03)));
  }
  return out;
}

/** A dot. */
function dot(color: number, w: number, x: number, y: number): Stroke {
  return [color, w, at(x), at(y)];
}

/** An ellipse coloured in with one zigzag of the brush. */
function fill(color: number, cx: number, cy: number, rx: number, ry: number, w = BRUSH): Stroke {
  const out = [color, w];
  const rows = Math.max(2, Math.round((2 * ry) / (w * 0.75)));
  for (let i = 0; i <= rows; i++) {
    const y = cy - ry + w / 2 + ((2 * ry - w) * i) / rows;
    const half = Math.max(0, rx * Math.sqrt(Math.max(0, 1 - ((y - cy) / ry) ** 2)) - w / 2);
    const xs = i % 2 === 0 ? [cx - half, cx + half] : [cx + half, cx - half];
    out.push(at(xs[0]! + wobble() * 8), at(y), at(xs[1]! + wobble() * 8), at(y + wobble() * 6));
  }
  return out;
}

/** A row of grass: a zigzag. */
function grass(color: number, y: number, from = 60, to = 940, step = 38, hgt = 34): Stroke {
  const out = [color, PEN];
  for (let x = from, i = 0; x <= to; x += step, i++) out.push(at(x), at(y - (i % 2 ? hgt : 0) + wobble() * 8));
  return out;
}

// ---------------------------------------------------------------------------
// Mia's elephant (looking left): the grey shape first, the ear, then the trunk.

const ELEPHANT: Stroke[] = [
  fill(GREY, 580, 500, 250, 170),
  fill(GREY, 300, 420, 125, 125),
  line(GREY, BRUSH, 430, 620, 432, 790),
  line(GREY, BRUSH, 540, 640, 538, 795),
  line(GREY, BRUSH, 680, 640, 682, 795),
  line(GREY, BRUSH, 770, 610, 772, 790),
  // The ear: big, with a pink inside.
  oval(PINK, FAT, 395, 420, 62, 100),
  oval(BLACK, PEN, 395, 420, 92, 132, 0.3),
  dot(BLACK, FAT, 245, 385),
  // The trunk.
  line(GREY, BRUSH, 215, 470, 170, 560, 160, 660, 200, 730, 260, 720),
  line(BLACK, PEN, 178, 470, 132, 560, 122, 668, 178, 762, 282, 752),
  line(BLACK, PEN, 252, 500, 205, 580, 200, 650, 222, 692, 262, 686),
  line(SKIN, FAT, 262, 520, 222, 566, 168, 574),
  // The outline, the toes, the tail.
  line(BLACK, PEN, 262, 300, 330, 285, 400, 292),
  line(BLACK, PEN, 480, 350, 580, 322, 700, 332, 790, 380, 832, 470, 826, 560, 806, 640),
  line(BLACK, PEN, 806, 640, 806, 825, 738, 825, 736, 690, 716, 690, 716, 828, 646, 828, 646, 676, 576, 676, 574, 828, 504, 828, 504, 690, 468, 690, 466, 824, 396, 824, 396, 640),
  line(BLACK, PEN, 396, 640, 372, 560),
  line(BLACK, PEN, 262, 300, 190, 350, 176, 440, 178, 470),
  line(BLACK, FINE, 832, 470, 880, 520, 892, 600),
  line(BLACK, PEN, 882, 596, 902, 630),
  grass(LIME, 870),
  grass(GREEN, 905, 40, 960, 44, 30),
];

// ---------------------------------------------------------------------------
// Jonas's zebra (looking right): a white horse, then its stripes.

const ZEBRA: Stroke[] = [
  oval(BLACK, PEN, 470, 520, 210, 120),
  line(BLACK, PEN, 620, 440, 690, 330, 740, 250),
  line(BLACK, PEN, 560, 420, 610, 320, 668, 232),
  oval(BLACK, PEN, 760, 232, 100, 56, 0.4),
  line(BLACK, PEN, 690, 190, 676, 130, 716, 176),
  dot(BLACK, FAT, 778, 216),
  dot(BLACK, PEN, 846, 244),
  line(BLACK, FINE, 812, 262, 850, 268),
  line(BLACK, PEN, 330, 610, 322, 800),
  line(BLACK, PEN, 392, 632, 388, 810),
  line(BLACK, PEN, 560, 632, 566, 810),
  line(BLACK, PEN, 622, 600, 632, 800),
  line(BLACK, PEN, 270, 480, 216, 560, 206, 640),
  line(BLACK, FAT, 204, 640, 196, 690),
  // The mane and the stripes.
  line(BLACK, FAT, 668, 232, 640, 280, 604, 330, 574, 400),
  line(BLACK, FAT, 320, 430, 340, 520, 318, 600),
  line(BLACK, FAT, 392, 404, 414, 520, 396, 628),
  line(BLACK, FAT, 468, 400, 488, 520, 472, 636),
  line(BLACK, FAT, 544, 410, 562, 520, 548, 628),
  line(BLACK, FAT, 612, 446, 632, 520, 620, 590),
  line(BLACK, FAT, 622, 372, 668, 392),
  line(BLACK, FAT, 648, 324, 698, 340),
  line(BLACK, PEN, 322, 680, 356, 684),
  line(BLACK, PEN, 322, 740, 354, 744),
  line(BLACK, PEN, 566, 700, 628, 696),
  line(BLACK, PEN, 568, 756, 630, 750),
  grass(LIME, 850),
];

// ---------------------------------------------------------------------------
// Lena's crocodile (looking left): green, long, a zigzag back, teeth.

const CROCODILE: Stroke[] = [
  fill(LIME, 520, 560, 290, 80),
  line(LIME, BRUSH, 250, 540, 120, 548),
  line(LIME, BRUSH, 250, 600, 130, 600),
  line(LIME, BRUSH, 800, 560, 900, 520, 950, 450),
  line(GREEN, PEN, 250, 500, 110, 512, 84, 548, 250, 566),
  line(GREEN, PEN, 250, 574, 100, 590, 96, 626, 250, 648),
  sharp(BLACK, FINE, 120, 566, 140, 590, 160, 566, 180, 590, 200, 566, 220, 590, 240, 566),
  line(GREEN, PEN, 250, 500, 300, 462, 350, 480),
  dot(BLACK, FAT, 300, 500),
  sharp(GREEN, PEN, 350, 480, 390, 430, 430, 480, 470, 430, 510, 480, 550, 430, 590, 480, 630, 430, 670, 480, 710, 430, 750, 484),
  line(GREEN, PEN, 750, 484, 850, 480, 920, 430, 960, 370),
  line(GREEN, PEN, 250, 648, 500, 660, 760, 640, 880, 580, 960, 470),
  line(GREEN, FAT, 360, 640, 340, 710, 300, 716),
  line(GREEN, FAT, 440, 650, 430, 720, 392, 726),
  line(GREEN, FAT, 640, 650, 650, 720, 612, 726),
  line(GREEN, FAT, 720, 640, 740, 706, 702, 716),
  grass(SKY, 800, 60, 940, 60, 26),
];

// ---------------------------------------------------------------------------
// Phil's giraffe (looking right), drawn on the phone by touch.

export const PHIL: Stroke[] = [
  fill(YELLOW, 430, 600, 180, 95),
  line(YELLOW, BRUSH, 560, 540, 620, 400, 670, 250),
  line(YELLOW, BRUSH, 660, 220, 760, 236),
  line(YELLOW, FAT, 310, 670, 300, 880),
  line(YELLOW, FAT, 380, 690, 378, 890),
  line(YELLOW, FAT, 500, 690, 506, 890),
  line(YELLOW, FAT, 566, 660, 580, 880),
  // The spots.
  dot(BROWN, BRUSH, 340, 580),
  dot(BROWN, BRUSH, 450, 630),
  dot(BROWN, BRUSH, 520, 560),
  dot(BROWN, FAT, 400, 540),
  dot(BROWN, FAT, 590, 470),
  dot(BROWN, FAT, 628, 380),
  dot(BROWN, FAT, 650, 300),
  // The horns, the ear, the face, the tail, the hooves.
  line(BROWN, PEN, 670, 190, 664, 130),
  line(BROWN, PEN, 708, 192, 712, 132),
  dot(BROWN, FAT, 663, 124),
  dot(BROWN, FAT, 713, 126),
  line(ORANGE, PEN, 640, 214, 596, 190, 634, 236),
  dot(BLACK, PEN, 712, 222),
  line(BLACK, FINE, 742, 256, 782, 250),
  line(BROWN, PEN, 256, 560, 214, 640, 208, 700),
  dot(BLACK, FAT, 206, 716),
  dot(BLACK, FAT, 300, 890),
  dot(BLACK, FAT, 378, 900),
  dot(BLACK, FAT, 506, 900),
  dot(BLACK, FAT, 580, 890),
  grass(LIME, 940, 60, 940, 40, 30),
];

export const PEOPLE = ["Phil", "Mia", "Jonas", "Lena"] as const;
export type Person = (typeof PEOPLE)[number];

export const CATEGORY = "Zoo animals";
export const WORDS: Record<Person, string> = { Phil: "giraffe", Mia: "elephant", Jonas: "zebra", Lena: "crocodile" };
export const DRAWINGS: Record<Exclude<Person, "Phil">, Stroke[]> = { Mia: ELEPHANT, Jonas: ZEBRA, Lena: CROCODILE };
/** Phil has one word (no picking). */
export const PICK = 0;

/**
 * The guesses at Mia's elephant, as shares of the guess time: `[share,
 * text]`. The pictures are taken at {@link SHOT}: Phil's wrong guess is
 * sent on the phone (play.ts), his next one typed and not sent yet.
 */
export const GUESSES: Record<Exclude<Person, "Phil" | "Mia">, [number, string][]> = {
  Lena: [
    [0.1, "rock"],
    [0.37, "elephant"],
  ],
  Jonas: [
    [0.33, "rhino"],
    [0.6, "elephant"],
  ],
};
export const PHIL_WRONG: [number, string] = [0.24, "hippo"];
export const GUESS = "elephant";
export const SHOT = 0.41;

/** The game's script: the category, everyone's word, Mia's drawing first. */
export function script(): Script {
  return { category: CATEGORY, words: { ...WORDS }, order: ["Mia", "Lena", "Jonas", "Phil"] };
}

/**
 * Script for the host page: Mia, Jonas and Lena join from the window
 * (clients on tvpipe's relay, like phones), hand in their drawings after
 * a while, type their guesses at Mia's elephant at their moments (the
 * other drawings they name half way through), and give a heart.
 */
export function joinScript(): string {
  return `(async () => {
    const { memoryStorage, PartyClient } = await import("/_tvpipe/lib/client.js");
    const url = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/_tvpipe/ws";
    const people = ${JSON.stringify(PEOPLE)};
    const drawings = ${JSON.stringify(DRAWINGS)};
    const guesses = ${JSON.stringify(GUESSES)};
    const words = ${JSON.stringify(WORDS)};
    globalThis.__people = [];
    for (const name of people.slice(1)) {
      const s = people.indexOf(name);
      const c = new PartyClient({ url, room: krakel.party.code, key: krakel.party.joinKey, storage: memoryStorage() });
      const done = new Set();
      const once = (key, ms, fn) => {
        if (done.has(key)) return;
        done.add(key);
        setTimeout(() => fn().catch((e) => console.error("scenario: " + name + " " + key + ": " + (e.message ?? e))), ms);
      };
      c.on("view", (v) => {
        const me = v.me ?? {};
        const spot = v.room?.spot ?? {};
        if (me.task === "draw" && !me.done) {
          once("draw", 9000 + s * 3500, () => c.act("draw", { strokes: drawings[name], choice: 0 }));
        } else if (me.task === "guess" && !me.right) {
          const artist = spot.artist?.name;
          const list = artist === "Mia" ? guesses[name] : [[0.35 + s * 0.12, words[artist]]];
          for (const [share, text] of list ?? []) {
            once("guess" + me.key + ":" + text, Math.max(0, spot.start + (spot.end - spot.start) * share - c.now()), () => c.act("guess", { key: me.key, text }));
          }
        } else if (me.task === "vote" && !me.done) {
          const pick = (v.room?.gallery ?? []).find((g) => g.artist?.name === (name === "Mia" ? "Phil" : "Mia"));
          if (pick) once("vote", 1500 + s * 1200, () => c.act("vote", { id: pick.id }));
        }
      });
      await c.join(name);
      globalThis.__people.push(c);
    }
    return true;
  })()`;
}

/** Draws strokes on the phone's pad (touch drags; the pad's box in CSS px), each pen and width picked first. */
export async function drawOn(phone: Tab, box: { x: number; y: number; w: number }, strokes: Stroke[]): Promise<void> {
  let color = -1;
  let width = -1;
  const tap = (label: string) => phone.eval(`(() => { document.querySelector(${JSON.stringify(`.palette button[aria-label="${label}"], .sizes button[aria-label="${label}"]`)}).click(); return true; })()`);
  for (const s of strokes) {
    if (s[0] !== color) await tap(PENS[(color = s[0]!)]!);
    if (s[1] !== width) await tap(SIZES[(width = s[1]!)]!);
    const pts: [number, number][] = [];
    for (let i = 2; i + 1 < s.length; i += 2) pts.push([box.x + (s[i]! / 1000) * box.w, box.y + (s[i + 1]! / 1000) * box.w]);
    // A dot: down and up on the spot.
    await phone.drag(pts.length === 1 ? [pts[0]!, pts[0]!] : pts);
  }
}

// ---------------------------------------------------------------------------

if (process.argv[2] === "--preview") {
  const dir = process.argv[3] ?? "/tmp/krakel-scenario";
  mkdirSync(dir, { recursive: true });
  const { Browser } = await import("./browser.ts");
  const dist = new URL("../../dist/", import.meta.url);
  const geometry = readFileSync(new URL("game/ink.js", dist), "utf8").replace(/^export /gm, "");
  const ink = readFileSync(new URL("phone/ink.js", dist), "utf8")
    .replace(/^import [^;]*;$/gm, "")
    .replace(/^export \{[^}]*\}[^;]*;$/gm, "")
    .replace(/^export /gm, "");
  const all: [string, Stroke[]][] = [["giraffe", PHIL], ["elephant", ELEPHANT], ["zebra", ZEBRA], ["crocodile", CROCODILE]];
  for (const [name, strokes] of all) {
    const total = totalCost(strokes);
    let sum = 0;
    console.log(`${name}: ${strokes.length} strokes, ${strokes.reduce((n, s) => n + (s.length - 2) / 2, 0)} points; a stroke ends at:`);
    console.log("  " + strokes.map((s) => ((sum += costOf(s)) / total).toFixed(2)).join(" "));
  }
  const shares = [1, SHOT / 0.85, 0.25];
  const html = `<!doctype html><body style="margin:0;background:#888;display:grid;grid-template-columns:repeat(${shares.length},400px);gap:8px;padding:8px">
${all.flatMap(([name]) => shares.map((p) => `<canvas data-name="${name}" data-p="${p}" style="width:400px;height:400px"></canvas>`)).join("\n")}
<script>
${geometry}
${ink}
const drawings = ${JSON.stringify(Object.fromEntries(all))};
for (const c of document.querySelectorAll("canvas")) { const f = fit(c); drawInk(f.ctx, { strokes: drawings[c.dataset.name] }, 0, 0, f.size, { progress: Number(c.dataset.p) }); }
</script>`;
  writeFileSync(`${dir}/preview.html`, html);
  const b = await Browser.launch();
  const tab = await b.open(`file://${dir}/preview.html`, { width: shares.length * 408 + 8, height: all.length * 408 + 8 });
  await new Promise((r) => setTimeout(r, 800));
  await tab.screenshot(`${dir}/preview.png`);
  b.close();
  console.log(`${dir}/preview.png`);
  process.exit(0);
}
