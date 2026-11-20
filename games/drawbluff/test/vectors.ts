/**
 * Rule vectors (once shared with a Rust host, now gone): the Node rules
 * are the reference. `node test/vectors.ts --bless` writes
 * `test/vectors/rules.txt` from `game/rules.ts`; `vectors.test.ts`
 * replays it.
 *
 * Format: tvpipe's test vector files (blocks of `key = value` lines,
 * separated by blank lines, `#` comments). Every block has a `test`:
 *
 * - `rng`: `seed`, `values` (the first outputs of `seeded(seed)` times
 *   2^32, so integers).
 * - `shuffle`: `seed`, `n`, `order` (`shuffle([0..n), seeded(seed))`).
 * - `title`: `input` (a JSON string), maybe `lang` (default `en`),
 *   `clean` (`cleanTitle`), `display` (`displayTitle` of the cleaned
 *   input), `key` (`titleKey(input, lang)`).
 * - `drawing`: `input` (JSON; `repeat = N` repeats its first stroke N
 *   times, `pad = N` appends N `1`s to its first stroke), then `output`
 *   (the normalised drawing; `input` when that is the input) or `error`
 *   (the code).
 * - `plan`: `table`, `[n, spotlights, liars, pipelined]` for n = 0…60.
 * - `share`: `cases`, `[n, base, seen, share(n, base, seen)]`.
 * - `liars`: `pool`, `lied` (`{id: lies so far}`), `n`, `seed`, `first`
 *   (or `null`), then `liars` (`pickLiars(…, seeded(seed), first)`).
 * - `rotate`: `pool`, `keys` (`{id: key}`), `n`, `seed`, then `picked`.
 * - `turn`: one drawing's turn as a seeded game plays it: `artist`,
 *   `truth`, `lies` (`[author, text]` in arrival order), `spares`,
 *   `seed`, `min`, `round`, `voting` (who votes), `dealSeed`, `votes`
 *   (`[voter, option id]`), then `options` (`buildOptions(…,
 *   seeded(seed), min)`), `own` (per player: the ids `optionsFor`
 *   gives), `shown` (`deal(options, voting, PHONE_LIES,
 *   seeded(dealSeed))`), `points`, `voters`, `seen` (`score`), `reveal`
 *   (the ids in `revealOrder`).
 * - `prompts`: `input` (a JSON string: a prompts file), `parsed`
 *   (`[tag, text]` of `parsePrompts`).
 * - `spread`: `tags` (one per item), `window`, then `order` (the item
 *   indices `spread` gives).
 * - `deck`: `prompts` (`[tag, text]`, or `file` for data/prompts.txt),
 *   `seed`, then `dealt` (the texts `deck(…, seeded(seed))` deals with
 *   `pop()`, the first 40 at most).
 * - `decoys`: `spares` (`[tag, text]`), `tag`, then `order` (the texts
 *   of `decoyOrder`).
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PartyError } from "@tvpipe/party";

import { doodle } from "../game/bots.ts";
import { PROMPT_LIST, PROMPTS } from "./prompts.ts";
import {
  buildOptions,
  cleanTitle,
  deal,
  deck,
  decoyOrder,
  displayTitle,
  optionsFor,
  parsePrompts,
  PHONE_LIES,
  pickLiars,
  plan,
  revealOrder,
  rotate,
  score,
  seeded,
  share,
  shuffle,
  spread,
  titleKey,
  validateDrawing,
  type Prompt,
} from "../game/rules.ts";

export const RULES = fileURLToPath(new URL("./vectors/rules.txt", import.meta.url));

export type Block = { line: number; entries: [string, string][] };

export function parseVectors(text: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | undefined;
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") {
      cur = undefined;
      return;
    }
    if (line.startsWith("#")) return;
    const at = line.indexOf(" = ");
    if (at < 0) throw new Error(`rules.txt:${i + 1}: expected "key = value"`);
    if (!cur) {
      cur = { line: i + 1, entries: [] };
      blocks.push(cur);
    }
    cur.entries.push([line.slice(0, at).trim(), line.slice(at + 3)]);
  });
  return blocks;
}

export function get(b: Block, key: string): string {
  const e = b.entries.find(([k]) => k === key);
  if (!e) throw new Error(`rules.txt:${b.line}: no ${key}`);
  return e[1];
}

export function has(b: Block, key: string): boolean {
  return b.entries.some(([k]) => k === key);
}

/** A `drawing` block's input, with `repeat` and `pad` applied. */
export function drawingInput(b: Block): unknown {
  const input = JSON.parse(get(b, "input")) as { strokes: unknown[][] };
  if (has(b, "repeat")) input.strokes = Array(Number(get(b, "repeat"))).fill(input.strokes[0]);
  if (has(b, "pad")) input.strokes[0] = [...input.strokes[0]!, ...Array(Number(get(b, "pad"))).fill(1)];
  return input;
}

// ---------------------------------------------------------------------------
// Writing the file

type Entries = [string, unknown][];

function block(entries: Entries): string {
  return entries.map(([k, v]) => `${k} = ${typeof v === "string" && k !== "input" ? v : JSON.stringify(v)}`).join("\n");
}

/** German titles, compared the German way (`titleKey(…, "de")`). */
const DE_TITLES = [
  "Der Bär, der tanzt!",
  "bär der tanzt",
  "baer der tanzt",
  "Ein Glückspilz",
  "glueckspilz",
  "\u201EDie Straße\u201C",
  "strasse",
  "STRASSE",
  "eine Ente , die quakt",
  "1,5 Liter Milch",
  "Die Kuh vom Eis holen.",
  "kuh vom eis holen",
  "das",
  "Wenn der Bus vor der Nase wegfährt…",
  "ein Ka\u0308se",
];

const TITLES = [
  "A Nervous  Cactus!",
  "nervous cactus",
  "The café",
  "cafe",
  "an apple",
  "an",
  "a",
  "the the cat",
  "theatre",
  "a-b-c",
  "  hi\u0000 there  ",
  "x".repeat(80),
  "Ⅻ angry men",
  "½ a sandwich",
  "ΟΔΟΣ",
  "İstanbul",
  "Straße",
  "ﬁsh ﬂakes",
  "ｆｕｌｌ ｗｉｄｔｈ",
  "Ⓐ circled",
  "🅐 negative",
  "東京タワー",
  "한국어 제목",
  "🍕 pizza 🍕",
  "👩‍👩‍👧 family",
  "!!!",
  "   ",
  "e\u0301te\u0301",
  "Ǆungla",
  "٣ cats",
  "rock'n'roll",
  "A\tB\nC",
  "\u202eevil",
  "zero\u200bwidth",
  // The display form: nothing gives the truth away.
  "A Cat.",
  "a cat",
  '"A Cat!"',
  "Why?!?",
  "wait…",
  "...",
  '""',
  "'tis the season",
  "the dogs'",
  "'single quoted'",
  "\u2018curly\u2019 and \u201Cdouble\u201D",
  "\u00ABguillemets\u00BB",
  "it\u2019s fine",
  "ΣΟΦΟΣ ΟΔΟΣ",
  "  Spaced   OUT  !! ",
  '"half quoted',
  "Paris!? Really.",
];

const DRAWINGS: Entries[] = [
  [["input", { strokes: [[1, 500, -5, 2000, 10.4, 20.6]] }]],
  [["input", { strokes: [] }]],
  [["input", { strokes: [[0, 1, 0.5, 1.5, 2.5, -0.5, 999.5, 1000.49]] }]],
  [["input", { strokes: [[7, 2.5, 3, 4], [6, 119.5, 1, 1, 2, 2]] }]],
  [["input", { strokes: [[1.0, 4, 1, 1]] }]],
  [["input", { strokes: [[0, -10, 5, 5]] }]],
  [["input", null]],
  [["input", {}]],
  [["input", []]],
  [["input", { strokes: {} }]],
  [["input", { strokes: [[1, 2, 3]] }]],
  [["input", { strokes: [[1, 2, 3, 4, 5]] }]],
  [["input", { strokes: [[9, 2, 3, 4]] }]],
  [["input", { strokes: [[-1, 2, 3, 4]] }]],
  [["input", { strokes: [[1.5, 2, 3, 4]] }]],
  [["input", { strokes: [[1, 2, "x", 4]] }]],
  [["input", { strokes: [[1, 2, true, 4]] }]],
  [["input", { strokes: [[1, 2, null, 4]] }]],
  [["input", { strokes: ["1234"] }]],
  [["input", { strokes: [[0, 4, 1, 1]] }], ["repeat", 300]],
  [["input", { strokes: [[0, 4, 1, 1]] }], ["repeat", 301]],
  [["input", { strokes: [[0, 4]] }], ["pad", 24_000]],
  [["input", { strokes: [[0, 4]] }], ["pad", 24_002]],
];

const LIES = [
  "a sad potato",
  "A sad potato!",
  "a confused banana",
  "the cat's revenge",
  "a dancing lamp",
  "abstract art",
  "Abstract   art",
  "a sneaky pancake",
  "the evil teapot",
  "a very tired frog",
];

function turn(seed: number): Entries {
  const r = seeded(seed * 7919 + 1);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  // 3–8 players (today's game), then up to 50.
  const n = seed <= 24 ? 3 + Math.floor(r() * 6) : 9 + Math.floor(r() * 42);
  const players = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const artist = pick(players);
  const others = players.filter((p) => p !== artist);
  const liars = pickLiars(others, new Map(), plan(n).liars, r);
  const truth = pick(PROMPTS);
  const lies: [string, string][] = [];
  for (const p of liars) {
    const x = r();
    if (x < 0.15) continue; // no lie in time
    if (x < 0.25) lies.push([p, truth.toUpperCase() + "!"]); // the truth (refused when typed; never shown)
    else if (x < 0.4) lies.push([p, pick(PROMPTS)]);
    else lies.push([p, pick(LIES)]);
  }
  const spares = shuffle(PROMPTS, r).slice(0, 6);
  const min = Math.min(4, liars.length + 1);
  const options = buildOptions(truth, new Map(lies), spares, seeded(seed), min);
  const voting = r() < 0.2 ? players : others;
  const dealSeed = seed + 1000;
  const shown = deal(options, voting, PHONE_LIES, seeded(dealSeed));
  const ids = [...options.map((o) => o.id), "nope"];
  const votes: [string, string][] = [];
  for (const p of voting) {
    if (r() < 0.1) continue;
    votes.push([p, r() < 0.8 ? pick(shown.get(p)!) : pick(ids)]);
  }
  const round = 1 + Math.floor(r() * 2);
  const scoring = score(artist, options, shown, new Map(votes), round);
  return [
    ["test", "turn"],
    ["artist", JSON.stringify(artist)],
    ["truth", JSON.stringify(truth)],
    ["lies", JSON.stringify(lies)],
    ["spares", JSON.stringify(spares)],
    ["seed", String(seed)],
    ["min", String(min)],
    ["round", String(round)],
    ["voting", JSON.stringify(voting)],
    ["dealSeed", String(dealSeed)],
    ["votes", JSON.stringify(votes)],
    ["options", JSON.stringify(options)],
    ["own", JSON.stringify(Object.fromEntries(players.map((p) => [p, optionsFor(p, options).map((o) => o.id)])))],
    ["shown", JSON.stringify(Object.fromEntries(shown))],
    ["points", JSON.stringify(Object.fromEntries(scoring.points))],
    ["voters", JSON.stringify(Object.fromEntries(scoring.voters))],
    ["seen", JSON.stringify(Object.fromEntries(scoring.seen))],
    ["reveal", JSON.stringify(revealOrder(options, scoring.voters).map((o) => o.id))],
  ];
}

function liarsBlock(seed: number): Entries {
  const r = seeded(seed * 31 + 5);
  const n = 2 + Math.floor(r() * 49);
  const pool = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const lied = new Map(pool.filter(() => r() < 0.6).map((p) => [p, Math.floor(r() * 3)]));
  const want = Math.floor(r() * 9);
  const first = r() < 0.5 ? pick(r, pool) : r() < 0.5 ? "nobody" : null;
  const liars = pickLiars(pool, lied, want, seeded(seed), first ?? undefined);
  return [
    ["test", "liars"],
    ["pool", JSON.stringify(pool)],
    ["lied", JSON.stringify(Object.fromEntries(lied))],
    ["n", String(want)],
    ["seed", String(seed)],
    ["first", JSON.stringify(first)],
    ["liars", JSON.stringify(liars)],
  ];
}

function rotateBlock(seed: number): Entries {
  const r = seeded(seed * 17 + 3);
  const n = 1 + Math.floor(r() * 50);
  const pool = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const keys = new Map(pool.map((p) => [p, Math.floor(r() * 4)]));
  const want = Math.floor(r() * (n + 2));
  const picked = rotate(pool, (id) => keys.get(id)!, want, seeded(seed));
  return [
    ["test", "rotate"],
    ["pool", JSON.stringify(pool)],
    ["keys", JSON.stringify(Object.fromEntries(keys))],
    ["n", String(want)],
    ["seed", String(seed)],
    ["picked", JSON.stringify(picked)],
  ];
}

const PROMPT_FILES = [
  "# a comment\n\n[odd]\na snail in a hurry\n  a lonely sock  \n\n[moment]\nthe moment the toast falls\n",
  "before any tag\n[idiom]\n# inside\nraining cats and dogs\n[view]\n[drama]\nthe last cookie\n",
  "",
  "[Odd]\n[odd ]\nnot a [tag]\n",
];

const SPREADS: [string[], number][] = [
  [["a", "a", "a", "b", "b", "b", "c", "c", "c"], 3],
  [["a", "a", "a", "b", "b", "b", "c", "c", "c"], 2],
  [["m", "m", "m", "m", "x"], 3],
  [["a", "b", "c", "d"], 3],
  [["a", "a", "b"], 1],
  [["a", "a", "b", "b", "a", "c", "c", "a", "", ""], 3],
  [[], 3],
];

function deckBlock(source: string, prompts: readonly Prompt[], seed: number): Entries {
  const d = deck(prompts, seeded(seed));
  const dealt: string[] = [];
  while (d.length > 0 && dealt.length < 40) dealt.push(d.pop()!.text);
  return [
    ["test", "deck"],
    ["prompts", source],
    ["seed", String(seed)],
    ["dealt", JSON.stringify(dealt)],
  ];
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}


function bless(): void {
  const out: string[] = [
    "# Drawbluff's rules, written by `node test/vectors.ts --bless` from game/rules.ts",
    "# (the reference); replayed by test/vectors.test.ts.",
  ];
  for (const seed of [0, 1, 7, 42, 0xdeadbeef, 0xffffffff]) {
    const r = seeded(seed);
    const values = Array.from({ length: 8 }, () => r() * 2 ** 32);
    out.push(block([["test", "rng"], ["seed", String(seed)], ["values", JSON.stringify(values)]]));
  }
  for (const [seed, n] of [[1, 1], [1, 2], [7, 5], [42, 10], [3, 52]] as const) {
    const order = shuffle(Array.from({ length: n }, (_, i) => i), seeded(seed));
    out.push(block([["test", "shuffle"], ["seed", String(seed)], ["n", String(n)], ["order", JSON.stringify(order)]]));
  }
  for (const t of TITLES) {
    out.push(block([["test", "title"], ["input", t], ["clean", JSON.stringify(cleanTitle(t))], ["display", JSON.stringify(displayTitle(cleanTitle(t)))], ["key", JSON.stringify(titleKey(t))]]));
  }
  for (const t of DE_TITLES) {
    out.push(block([["test", "title"], ["input", t], ["lang", "de"], ["clean", JSON.stringify(cleanTitle(t))], ["display", JSON.stringify(displayTitle(cleanTitle(t)))], ["key", JSON.stringify(titleKey(t, "de"))]]));
  }
  for (const d of DRAWINGS) {
    const b: Block = { line: 0, entries: d.map(([k, v]) => [k, k === "input" ? JSON.stringify(v) : String(v)]) };
    let result: [string, unknown];
    try {
      const input = drawingInput(b);
      const output = JSON.stringify(validateDrawing(input));
      // Long ones that pass unchanged stay short.
      result = ["output", output.length > 400 && output === JSON.stringify(input) ? "input" : output];
    } catch (e) {
      if (!(e instanceof PartyError)) throw e;
      result = ["error", e.code];
    }
    out.push(block([["test", "drawing"], ...d, result]));
  }
  const table = Array.from({ length: 61 }, (_, n) => {
    const p = plan(n);
    return [n, p.spotlights, p.liars, p.pipelined];
  });
  out.push(block([["test", "plan"], ["table", JSON.stringify(table)]]));
  const cases: number[][] = [];
  for (const [n, base, seen] of [[0, 500, 0], [3, 500, 7], [7, 1000, 7], [1, 500, 8], [14, 500, 30], [20, 1000, 43], [1, 1000, 49], [5, 500, 14], [1, 500, 28], [3, 1000, 42]] as const) {
    cases.push([n, base, seen, share(n, base, seen)]);
  }
  out.push(block([["test", "share"], ["cases", JSON.stringify(cases)]]));
  for (let seed = 1; seed <= 12; seed++) out.push(block(liarsBlock(seed)));
  for (let seed = 1; seed <= 8; seed++) out.push(block(rotateBlock(seed)));
  for (let seed = 1; seed <= 48; seed++) out.push(block(turn(seed)));
  for (const input of PROMPT_FILES) {
    out.push(block([["test", "prompts"], ["input", input], ["parsed", JSON.stringify(parsePrompts(input).map((p) => [p.tag, p.text]))]]));
  }
  for (const [tags, window] of SPREADS) {
    const order = spread(tags.map((_, i) => i), (i) => tags[i]!, window);
    out.push(block([["test", "spread"], ["tags", JSON.stringify(tags)], ["window", String(window)], ["order", JSON.stringify(order)]]));
  }
  for (let seed = 1; seed <= 6; seed++) {
    const r = seeded(seed * 13 + 1);
    const tags = ["odd", "idiom", "moment", "view"].slice(0, 1 + Math.floor(r() * 4));
    const prompts: Prompt[] = Array.from({ length: 3 + Math.floor(r() * 14) }, (_, i) => ({ tag: pick(r, tags), text: `prompt ${String.fromCharCode(97 + i)}` }));
    out.push(block(deckBlock(JSON.stringify(prompts.map((p) => [p.tag, p.text])), prompts, seed)));
  }
  for (const seed of [1, 2, 3]) out.push(block(deckBlock("file", PROMPT_LIST, seed)));
  for (let seed = 1; seed <= 4; seed++) {
    const r = seeded(seed * 7 + 2);
    const spares: Prompt[] = Array.from({ length: Math.floor(r() * 9) }, (_, i) => ({ tag: pick(r, ["odd", "moment", "title"]), text: `spare ${i}` }));
    const tag = pick(r, ["odd", "moment", "title", "drama"]);
    out.push(block([["test", "decoys"], ["spares", JSON.stringify(spares.map((p) => [p.tag, p.text]))], ["tag", tag], ["order", JSON.stringify(decoyOrder(spares, tag).map((p) => p.text))]]));
  }
  writeFileSync(RULES, out.join("\n\n") + "\n");
  console.log(`wrote ${RULES}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--bless")) bless();
  else console.log("usage: node test/vectors.ts --bless");
}
