/**
 * A live check of Crosstalk on `tvpipe game play` (not part of `npm test`):
 * tvpipe serves the bundle (`dist/`); a headless Chrome plays the window
 * (the launcher, then the host page, which adds the bots), the TV (the
 * watch link at 1280×720, muted, and a second one with its sound on) and
 * one phone (390×844). The phone joins as Phil, starts the game as the VIP
 * and plays a whole game with short timers:
 *
 * - as an operative (the default): it pins a card of its own, then goes
 *   with its team (the bots know the key), locks, passes when its team
 *   does; while its team listens (stopped for the round) it writes a line
 *   on the pad, taps a card while writing (its word typed in), edits the
 *   line, and keeps unsent typing over a reload;
 * - as the spymaster (`--role spymaster`): it takes the role in the
 *   lobby and gives real clues (a word not on the board, from a short
 *   list; the first one of the game too close on purpose, refused, then
 *   another), its team's bots guessing.
 *
 * Screenshots of the TV and the phone at each moment (the lobby, the
 * intro, the clues, every step and flip, between rounds, the end: the TV
 * every 5 s until it holds still). Every phone shot also checks the layout (also at
 * 320 px wide: nothing wider than the screen, nothing off it, words that
 * do not fit), every TV shot the TV's (nothing off the screen or running
 * out of its box, `data-fit` words that fit), and the secrets: the TV
 * never shows a clue during the game, the phone never the other team's
 * clue nor an operative the colour of a card face down. Every tab's
 * errors (over DevTools: exceptions, console errors, failed loads) and
 * the bots' refused actions fail the run too.
 *
 *   npm run build && node test/live/play.ts [--bots N] [--lang en|de] [--role operative|spymaster] [--out DIR] [--shots DIR]
 *
 * `--shots DIR`: the pictures for the games list (docs/game-catalog.md)
 * into DIR, from the fixed game of `scenario.ts` (a board of plain
 * English words, people's names for the bots, Phil's team's clues):
 * `tv-flip` (the TV in the step after a flip where both teams found one
 * of theirs: the cards turned so far, one team locked, the other guessing), `phone-operative`
 * (Phil's board with his and a teammate's pins, the clue, the pad) and,
 * from a second game, `phone-spymaster` (the key, a clue being typed);
 * the game ends there:
 *
 *   node test/live/play.ts --shots ../../site/static/games/crosstalk
 *
 * Needs Chrome and tvpipe built (TVPIPE_BINARY, else target/release, else
 * target/debug of this repository):
 *
 *   TVPIPE_BINARY=…/target/debug/tvpipe node test/live/play.ts --lang de
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Browser, type Tab } from "./browser.ts";
import * as scenario from "./scenario.ts";
import { keep } from "./shots.ts";
import { tie } from "./tie.ts";

const { values: args } = parseArgs({
  options: {
    bots: { type: "string", default: "5" },
    lang: { type: "string", default: "en" },
    role: { type: "string", default: "operative" },
    out: { type: "string" },
    shots: { type: "string" },
  },
});

const here = new URL("../../", import.meta.url);
const repo = new URL("../../", here);
const exe = process.platform === "win32" ? "tvpipe.exe" : "tvpipe";
const binary = process.env["TVPIPE_BINARY"] ?? ["release", "debug"].map((p) => fileURLToPath(new URL(`target/${p}/${exe}`, repo))).find((p) => existsSync(p));
if (!binary) throw new Error("build tvpipe first (cargo build --release -p tvpipe-cli), or set TVPIPE_BINARY");
const lang = args.lang === "de" ? "de" : "en";
const shots = args.shots;
const spymaster = args.role === "spymaster" && !shots;
if (args.role !== "operative" && args.role !== "spymaster") throw new Error("--role operative|spymaster");
const nBots = Number(args.bots);
if (!(nBots >= 3 && nBots <= 11)) throw new Error("--bots 3 to 11");
if (shots && lang !== "en") throw new Error("--shots plays scenario.ts, in English");
if (shots && nBots > scenario.NAMES.length) throw new Error(`--shots: at most ${scenario.NAMES.length} bots`);
const out = args.out ?? `/tmp/crosstalk-play${lang === "de" ? "-de" : ""}${spymaster ? "-spymaster" : ""}${shots ? "-shots" : ""}`;
mkdirSync(out, { recursive: true });
// The last run's screenshots go (this one's are numbered anew).
for (const f of readdirSync(out)) if (/^(tv|phone)-.*\.png$/.test(f)) rmSync(`${out}/${f}`);
if (shots) mkdirSync(shots, { recursive: true });
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Clues the phone gives as the spymaster (the first the board allows). */
const CLUES = {
  en: ["orbit", "velvet", "harbor", "lantern", "meadow", "riddle", "pocket", "signal", "marble", "breeze", "puzzle", "copper", "whisper", "canyon"],
  de: ["Umlaufbahn", "Samt", "Hafen", "Laterne", "Wiese", "Rätsel", "Tasche", "Signal", "Murmel", "Brise", "Kupfer", "Flüstern", "Schlucht"],
}[lang];
/** What the phone writes on the pad. */
const NOTE = lang === "de" ? { text: "die anderen flüsterten was von", edit: " (sicher?)", draft: "halber Gedanke" } : { text: "the others whispered something about", edit: " (sure?)", draft: "half a thought" };

const proc = tie(spawn(binary, ["game", "play", fileURLToPath(here), "--window", "none", "--no-tunnel"], { stdio: ["ignore", "pipe", "pipe"] }));
const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
const tvpipeLog: string[] = [];
createInterface({ input: proc.stderr! }).on("line", (l) => {
  tvpipeLog.push(l);
  if (/ (WARN|ERROR) /.test(l)) log(`tvpipe: ${l}`);
});
const start = await new Promise<string>((resolve, reject) => {
  createInterface({ input: proc.stdout! }).once("line", resolve);
  exited.then(() => reject(new Error(`tvpipe exited:\n${tvpipeLog.join("\n")}`)));
});

type Team = "red" | "blue";
type Choice = number | "pass";
interface Me {
  task: string;
  team: Team | null;
  clue: { word: string; number: number } | null;
  turned: number;
  pins: Record<string, Choice>;
  mine: Choice | null;
  majority: Choice | null;
  locked: Choice | null;
  canPass: boolean;
  active: boolean;
  key: string[] | null;
  pad: { id: number; text: string }[] | null;
  history: { word: string }[];
}
interface View {
  phase: string;
  round: number;
  roundStep: number;
  open: boolean;
  flip: number;
  /** The last flip's cards: right, neutral, theirs, assassin. */
  results: string[];
  /** The teams' status (thinking, ready, guessing, locked, done, …). */
  statuses: Record<Team, string>;
  words: string[];
  colors: (string | null)[];
  id: string;
  me: Me | null;
  clues: Record<Team, string | null>;
  pads: Record<Team, string[]>;
  next: Record<Team, string | null>;
}

const browser = await Browser.launch();
let failed = false;
const problems: string[] = [];
const problem = (p: string) => {
  if (problems.includes(p)) return;
  problems.push(p);
  log(`PROBLEM ${p}`);
};
try {
  const win = await browser.open(start, { width: 1200, height: 860 });
  await win.until(`document.querySelectorAll("#devices .device").length > 0`, 20_000);
  await win.eval(`document.querySelector('#devices .device[data-name="browser"]').click(); true`);
  await win.until(`!document.getElementById("start").disabled`);
  await win.eval(`document.getElementById("start").click(); true`);
  // (Slow with a debug build of tvpipe, or other checks running.)
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.crosstalk`, 60_000);
  log("the host page runs the game");
  // The language as the host picks it (HostPage.set: the form's own path); short timers.
  await win.eval(`(() => { crosstalk.page.set("lang", ${JSON.stringify(lang)}); return true; })()`);
  await win.until(`crosstalk.game.lang === ${JSON.stringify(lang)}`, 5000);
  const timings = shots ? { intro: 3000, clue: 60_000, step: 30_000, flip: 2800, roundEnd: 3000 } : { intro: 3000, clue: 40_000, step: 20_000, flip: 2800, roundEnd: 3000 };
  await win.eval(`(() => { crosstalk.game.configure({ timings: ${JSON.stringify(timings)} }); return true; })()`);

  const links = await win.eval<{ join: string; watch: string }>(`({ join: crosstalk.party.links.join, watch: crosstalk.party.links.watch })`);
  const tv = await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720 });
  const PHONE = { width: 390, height: 844, mobile: true };
  const phone = await browser.open(links.join, { ...PHONE, locale: lang === "de" ? "de-DE" : "en-US" });
  await phone.until(`!!document.getElementById("name")`, 20_000);
  // A second TV with its sound on. Every page's errors come over DevTools from before it loads.
  const loud = await browser.open(links.watch, { width: 640, height: 360 });
  const pages: [string, Tab][] = [["the window", win], ["the TV", tv], ["the TV with sound", loud], ["the phone", phone]];
  await sleep(600);
  await tv.screenshot(`${out}/tv-00-empty.png`);
  await phone.screenshot(`${out}/phone-00-join.png`);
  await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form button").click(); true`);
  await phone.until(`!!document.querySelector(".lobby")`);
  await win.eval(`crosstalk.addBots(${nBots}${shots ? `, ${JSON.stringify(scenario.NAMES.slice(0, nBots))}` : ""}).then(() => true)`);
  await phone.until(`document.querySelectorAll(".teamcol li").length === ${nBots + 1}`, 20_000);
  log(`${nBots} bots joined in the window`);
  await win.screenshot(`${out}/host.png`);

  const VIEW = `(() => {
    const r = crosstalk.party.room.peek();
    const p = crosstalk.party.players.find((x) => x.name === "Phil");
    const g = crosstalk.game.state;
    const pad = (t) => (r.reveal?.pads?.[t] ?? g?.teams[t].pad ?? []).map((l) => l.text);
    return {
      phase: crosstalk.game.phase, round: r.round, roundStep: r.roundStep, open: r.open, flip: r.flip?.step ?? 0, results: (r.flip?.cards ?? []).map((c) => c.result), statuses: { red: r.teams.red.status, blue: r.teams.blue.status },
      words: (r.board ?? []).map((c) => c.word), colors: (r.board ?? []).map((c) => c.color),
      id: p?.id ?? "", me: p ? p.state.peek() : null,
      clues: { red: g?.teams.red.clue?.word ?? null, blue: g?.teams.blue.clue?.word ?? null },
      pads: { red: pad("red"), blue: pad("blue") }, next: r.next,
    };
  })()`;
  const view = () => win.eval<View>(VIEW);
  let v = await view();
  const phil = v.id;
  const team = await win.eval<Team>(`crosstalk.game.teamOf(${JSON.stringify(phil)})`);
  log(`Phil plays for ${team}`);

  // The roles: the phone's team's spymaster is Phil (--role spymaster) or one of its bots.
  if (spymaster) {
    if (v.next[team] !== phil) await phone.eval(`document.getElementById("be-spymaster").click(); true`);
  } else if (v.next[team] === phil) {
    await win.eval(`(() => { const b = crosstalk.robots.find((b) => crosstalk.game.teamOf(b.client.you.id) === ${JSON.stringify(team)}); return b.client.act("spymaster").then(() => true); })()`);
  }
  await win.until(`crosstalk.party.room.peek().next[${JSON.stringify(team)}] ${spymaster ? "===" : "!=="} ${JSON.stringify(phil)}`, 5000);
  if (shots) {
    // The fixed board; Phil's team's clues sent for its (bot) spymaster before the bot's own.
    await win.eval(`(() => {
      crosstalk.game.script = ${JSON.stringify(scenario.script(team))};
      const clues = ${JSON.stringify(scenario.CLUES)};
      crosstalk.game.on("phase", (p) => {
        if (p !== "clue") return;
        setTimeout(() => {
          const g = crosstalk.game.state;
          const bot = g && crosstalk.robots.find((b) => b.client.you?.id === g.spymasters[${JSON.stringify(team)}]);
          const c = g && clues[g.round - 1];
          if (bot && c) bot.client.act("clue", c).catch(() => {});
        }, 250);
      });
      return true;
    })()`);
  }

  // -------------------------------------------------------------------------
  // The checks

  const layout = `(() => {
    const out = [];
    const W = innerWidth, H = innerHeight;
    const full = document.body.classList.contains("full");
    if (document.documentElement.scrollWidth > W + 1) out.push("the page is wider than the screen: " + document.documentElement.scrollWidth);
    // Inside a box that scrolls (the pad's lines), below its edge is fine.
    const scrolled = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if (o === "auto" || o === "scroll") return true; } return false; };
    for (const el of document.querySelectorAll("body *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "circle", "input", "textarea", "i"].includes(el.localName)) continue;
      const cs = getComputedStyle(el);
      // A card's word is narrowed with a transform (checked below), its card may hold it wider.
      if (!el.matches(".tile") && cs.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.overflowX === "visible") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 40)));
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > W + 2 || r.left < -2) && !el.closest(".word")) out.push("off the side: " + el.localName + "." + el.className);
      if (full && r.height > 0 && r.bottom > H + 2 && !scrolled(el)) out.push("off the bottom: " + el.localName + "." + el.className);
    }
    for (const el of document.querySelectorAll("[data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    // The cards' words: whole, inside their card, not too small to read.
    for (const w of document.querySelectorAll(".tile .word")) {
      if (w.checkVisibility && !w.checkVisibility()) continue;
      const r = w.getBoundingClientRect(), b = w.parentElement.getBoundingClientRect();
      if (r.left < b.left - 0.5 || r.right > b.right + 0.5) out.push("a card's word runs out of its card: " + JSON.stringify(w.textContent));
      if (parseFloat(getComputedStyle(w).fontSize) < 5.5) out.push("a card's word is tiny: " + JSON.stringify(w.textContent));
    }
    return out;
  })()`;
  const check = async (where: string, tab: Tab) => {
    for (const f of await tab.eval<string[]>(layout).catch((e: Error) => [`cannot check: ${e.message.slice(0, 100)}`])) problem(`${where}: ${f}`);
  };
  /** The TV: words that fit, nothing wider than its box, nothing off the screen (what moves is checked where it lands). */
  const tvLayout = `(() => {
    const out = [];
    // Seen: not hidden, not transparent (itself or what it is in: a part waiting for its stage).
    const SEEN = { opacityProperty: true, visibilityProperty: true };
    const moving = document.getAnimations().filter((a) => a.playState === "running").map((a) => a.effect?.target).filter((x) => x instanceof Element);
    const still = (el) => !moving.some((m) => m.contains(el));
    const stage = document.getElementById("stage") ?? document.body;
    for (const el of stage.querySelectorAll("[data-fit]")) {
      if (!el.checkVisibility(SEEN)) continue;
      if (still(el) && el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    for (const el of stage.querySelectorAll("*")) {
      if (!el.checkVisibility(SEEN) || !still(el)) continue;
      if (["svg", "path", "g", "circle", "line", "canvas", "i"].includes(el.localName) || el.closest("svg")) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      // Wholly off the screen is parked (waiting to slide in), not cut off.
      const shown = r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
      if (shown && r.width > 0 && r.height > 0 && (r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 || r.top < -2)) out.push("off the screen: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
      if (cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.display !== "inline" && cs.overflowX === "visible") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
    }
    return out;
  })()`;

  /** A word in a text, whole (not inside another word), any case. */
  const has = (text: string, word: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu").test(text);
  /**
   * The secrets, while a game runs: no clue on the TV; not the other
   * team's on the phone (its pad aside: anyone may write anything there);
   * no colour of a face-down card on an operative's phone.
   */
  const secrets = async (where: string) => {
    const s = await view();
    if (!["intro", "clue", "guess", "round"].includes(s.phase)) return;
    const board = s.words.map((w) => w.toLowerCase());
    const tvText = await tv.eval<string>(`document.body.innerText`);
    for (const t of ["red", "blue"] as const) {
      const clue = s.clues[t];
      // A clue may be a word turned already: that one the TV shows as a card.
      if (clue && !board.includes(clue.toLowerCase()) && has(tvText, clue)) problem(`${where}: the TV shows ${t}'s clue ${JSON.stringify(clue)}`);
    }
    const otherClue = s.clues[team === "red" ? "blue" : "red"];
    // (Both spymasters may give the same word: then the phone shows its own.)
    const own = [s.clues[team], ...(s.me?.history ?? []).map((c) => c.word)].map((w) => w?.toLowerCase());
    if (otherClue && !board.includes(otherClue.toLowerCase()) && !own.includes(otherClue.toLowerCase())) {
      const phoneText = await phone.eval<string>(`document.body.innerText.replace(document.querySelector(".pad")?.innerText ?? "", "")`);
      if (has(phoneText, otherClue)) problem(`${where}: the phone shows the other team's clue ${JSON.stringify(otherClue)}`);
    }
    if (!spymaster) {
      const leaks = await phone.eval<string[]>(
        `[...document.querySelectorAll(".board.op .tile")].flatMap((el, i) => /\\bc-(red|blue|neutral|assassin)\\b/.test(el.className) && ${JSON.stringify(s.colors)}[i] === null ? [el.textContent] : [])`,
      );
      if (leaks.length > 0) problem(`${where}: the operative's phone shows the colour of face-down cards: ${leaks.join(", ")}`);
    }
  };

  let n = 0;
  const tvShot = async (name: string) => {
    await tv.screenshot(`${out}/tv-${String(++n).padStart(2, "0")}-${name}.png`);
    for (const f of await tv.eval<string[]>(tvLayout).catch(() => [])) problem(`tv ${name}: ${f}`);
  };
  const shot = async (name: string, tvToo = true) => {
    if (tvToo) await tvShot(name);
    const at = String(tvToo ? n : ++n).padStart(2, "0");
    await phone.screenshot(`${out}/phone-${at}-${name}.png`);
    await check(`phone ${name}`, phone);
    await secrets(name);
    await phone.resize({ width: 320, height: 568, mobile: true });
    await sleep(250);
    await check(`small phone ${name}`, phone);
    await phone.screenshot(`${out}/phone-${at}-${name}-320.png`);
    await phone.resize(PHONE);
    await sleep(150);
  };
  const kept: string[] = [];
  const pic = async (tab: Tab, name: string, kind: "tv" | "phone", settle?: number) => {
    if (!shots || kept.some((f) => f.startsWith(`${name}.`))) return;
    kept.push(await keep(tab, shots, name, kind, settle));
    log(`picture: ${kept.at(-1)}`);
  };

  // -------------------------------------------------------------------------
  // The phone's hands

  /** A tap on a card (touch, as a finger: while writing, the field keeps the keyboard). */
  const tapCard = async (i: number) => {
    const p = await phone.eval<[number, number] | null>(`(() => { const t = document.querySelectorAll(".tile")[${i}]; if (!t) return null; const r = t.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (p) await phone.drag([p]);
  };
  const click = (selector: string) => phone.eval<boolean>(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b || b.hidden || b.disabled) return false; b.click(); return true; })()`);
  const typeInto = (selector: string, text: string) =>
    phone.eval(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

  let lastAct = "";
  let lastAt = 0;
  /** Does `what` once (the view takes a moment to show it). */
  const once = async (what: string, fn: () => Promise<unknown>) => {
    if (what === lastAct && Date.now() - lastAt < 2000) return;
    lastAct = what;
    lastAt = Date.now();
    await fn();
  };

  /** The operative: an own guess first, then with the team; lock, pass. */
  const operative = async (s: View) => {
    const me = s.me;
    if (!me || me.task !== "operative") return;
    const faceDown = s.colors.flatMap((c, i) => (c === null ? [i] : []));
    if (s.phase === "clue" && me.clue && me.mine === null && faceDown.length > 0) {
      // Pins are allowed once the clue is in (locks wait for the step).
      const i = faceDown[(s.round * 7) % faceDown.length]!;
      return once(`pin:${s.round}:clue`, () => tapCard(i));
    }
    if (s.phase !== "guess" || !me.active || me.locked !== null || !s.open || !me.clue) return;
    const step = `${s.round}:${s.roundStep}`;
    if (me.majority !== null && me.mine === me.majority) return once(`lock:${step}`, () => click(".btn.lock"));
    if (me.canPass && me.turned >= me.clue.number) {
      if (me.mine !== "pass") return once(`pass:${step}`, () => click(".pass"));
      return;
    }
    const mate = Object.entries(me.pins).find(([id, c]) => id !== s.id && typeof c === "number");
    if (mate && me.mine !== mate[1]) return once(`follow:${step}:${mate[1]}`, () => tapCard(mate[1] as number));
    if (!mate && me.mine === null && faceDown.length > 0) return once(`own:${step}`, () => tapCard(faceDown[(s.round * 3 + s.roundStep * 5) % faceDown.length]!));
  };

  const tried = new Map<number, number>();
  let refusals = 0;
  /** The spymaster: a clue for its cards still face down; the first of the game too close on purpose. */
  const giveClue = async (s: View) => {
    const me = s.me;
    if (!me || me.task !== "spymaster" || s.phase !== "clue" || me.clue || !me.key) return;
    const visible = await phone.eval<boolean>(`!!document.querySelector(".clueform:not([hidden])")`);
    if (!visible) return;
    const k = tried.get(s.round) ?? 0;
    tried.set(s.round, k + 1);
    const mine = me.key.flatMap((c, i) => (c === team && s.colors[i] === null ? [i] : []));
    const number = Math.max(1, Math.min(2, mine.length));
    const board = s.words.map((w) => w.toLowerCase());
    const pool = CLUES.filter((w) => !board.includes(w.toLowerCase()));
    const word = s.round === 1 && k === 0 && mine.length > 0 ? `${s.words[mine[0]!]}${lang === "de" ? "chen" : "s"}` : pool[(s.round * 3 + k) % pool.length]!;
    await typeInto("#clue", word);
    await phone.eval(`document.querySelectorAll(".numbers button")[${number - 1}].click(); true`);
    await sleep(200);
    if (s.round === 1 && k === 0) await shot(`r1-clue-typed`, false);
    await click(".clueform .send");
    await sleep(700);
    const refused = await phone.eval<string>(`document.querySelector(".clueform .error")?.textContent ?? ""`);
    const after = await view();
    if (after.me?.clue) log(`phone: the clue ${JSON.stringify(word)} ${number}`);
    else if (refused) {
      refusals++;
      log(`phone: ${JSON.stringify(word)} refused: ${refused}`);
      const kept = await phone.eval<string>(`document.getElementById("clue").value`);
      if (kept !== word) problem(`a refused clue's field was not kept (${JSON.stringify(kept)})`);
      await phone.screenshot(`${out}/phone-${String(++n).padStart(2, "0")}-r${s.round}-clue-refused.png`);
    }
  };

  /**
   * The pad, while the team listens: a line with a card tapped in, the
   * line edited, and unsent typing kept over a reload.
   */
  let padDone = false;
  const pad = async () => {
    padDone = true;
    await typeInto(".padadd textarea", `${NOTE.text} `);
    const target = (await view()).colors.findIndex((c) => c === null);
    const word = (await view()).words[target]!;
    await tapCard(target);
    const typed = await phone.eval<{ value: string; focused: boolean }>(`(() => { const ta = document.querySelector(".padadd textarea"); return { value: ta.value, focused: document.activeElement === ta }; })()`);
    if (!typed.value.includes(word) || !typed.focused) problem(`a card tapped while writing did not type its word (${JSON.stringify(typed)})`);
    await shot("pad-writing", false);
    await click(".addbtn");
    const line = `${NOTE.text} ${word}`;
    await win.until(`crosstalk.game.state.teams[${JSON.stringify(team)}].pad.some((l) => l.text === ${JSON.stringify(line)})`, 5000);
    await phone.eval(`document.activeElement?.blur(); true`);
    await sleep(300);
    // Edit it: a tap on the line, more text, the tick.
    await phone.eval(`(() => { const li = [...document.querySelectorAll(".lines li")].find((l) => l.textContent.includes(${JSON.stringify(NOTE.text)})); li.click(); return true; })()`);
    await phone.until(`!!document.querySelector(".lines li.editing textarea")`, 3000);
    await phone.eval(`(() => { const ta = document.querySelector(".lines li.editing textarea"); ta.value += ${JSON.stringify(NOTE.edit)}; ta.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await shot("pad-editing", false);
    await click(".edbtns .ok");
    await win.until(`crosstalk.game.state.teams[${JSON.stringify(team)}].pad.some((l) => l.text === ${JSON.stringify(line + NOTE.edit)} && l.edit === null)`, 5000);
    log(`phone: wrote ${JSON.stringify(line + NOTE.edit)} on the pad`);
    // Half a line, a reload: still there.
    await typeInto(".padadd textarea", NOTE.draft);
    await phone.eval(`location.reload(); true`);
    await sleep(400);
    await phone.until(`!!document.querySelector(".padadd textarea")`, 10_000);
    await sleep(300);
    const kept = await phone.eval<string>(`document.querySelector(".padadd textarea").value`);
    log(`phone: reloaded with ${JSON.stringify(NOTE.draft)} typed: ${JSON.stringify(kept)} after`);
    if (kept !== NOTE.draft) problem(`unsent typing on the pad did not survive a reload (${JSON.stringify(kept)})`);
    await typeInto(".padadd textarea", "");
    await phone.eval(`document.activeElement?.blur(); true`);
  };

  /** The pictures' pad: Phil's lines, a card tapped into each. */
  const shotsPad = async () => {
    padDone = true;
    const s = await view();
    for (const l of scenario.PAD) {
      // The field empties when the last line is taken (the reply, a moment after the host has it).
      await phone.until(`document.querySelector(".padadd textarea").value === ""`, 5000);
      await typeInto(".padadd textarea", `${l.text} `);
      await tapCard(s.words.indexOf(l.tap));
      await click(".addbtn");
      await win.until(`crosstalk.game.state.teams[${JSON.stringify(team)}].pad.length > 0 && crosstalk.game.state.teams[${JSON.stringify(team)}].pad.at(-1).text.endsWith(${JSON.stringify(l.tap)})`, 5000);
    }
    await phone.eval(`document.activeElement?.blur(); true`);
  };

  /** The flip after which the cover is taken (0: none yet). */
  let coverAfter = 0;
  /** The pictures of a game in round 2: Phil's own pin beside a teammate's; the TV after a flip. */
  const shotsGame = async (s: View) => {
    if (!shots || s.round < 2) return false;
    const me = s.me;
    if (!kept.some((f) => f.startsWith("phone-operative.")) && padDone && s.phase === "guess" && s.open && me?.active && me.locked === null && me.clue) {
      // One of the team's cards still face down that no teammate pinned (the bots go for theirs).
      const taken = Object.entries(me.pins).flatMap(([id, c]) => (id !== s.id ? [c] : []));
      const ours = scenario.script(team).flatMap((c, i) => (c.color === team && s.colors[i] === null && !taken.includes(i) ? [i] : []));
      const pin = [s.words.indexOf(scenario.PIN), ...ours].find((i) => ours.includes(i));
      if (pin !== undefined && me.mine !== pin) await tapCard(pin);
      await win.until(`Object.keys(crosstalk.party.players.find((p) => p.name === "Phil").state.peek().pins).length >= 2`, 8000).catch(() => {});
      await pic(phone, "phone-operative", "phone", 400);
      return true;
    }
    // The cover: after a flip where both teams found one of theirs (from round 3 on, any), the next
    // step with the cards in place and the stamps gone: one team locked, the other still guessing.
    if (kept.some((f) => f.startsWith("tv-flip."))) return false;
    const good = s.results.length === 2 && s.results.every((r) => r === "right");
    if (s.phase === "guess" && !s.open && s.flip > coverAfter && s.colors.filter((c) => c !== null).length >= 6 && (good || s.round >= 3)) coverAfter = s.flip;
    const st = [s.statuses.red, s.statuses.blue];
    if (coverAfter && s.phase === "guess" && s.open && s.flip === coverAfter && st.includes("locked") && st.includes("guessing")) {
      await pic(tv, "tv-flip", "tv", 500);
      return true;
    }
    return false;
  };

  // -------------------------------------------------------------------------
  // The game

  await sleep(500);
  await shot("lobby");
  await phone.until(`!document.getElementById("start")?.disabled`);
  await phone.eval(`document.getElementById("start").click(); true`);

  const seen = new Set<string>();
  const deadline = Date.now() + 25 * 60_000;
  let openedAt = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the game took too long");
    if (shots && kept.length >= 2) break;
    v = await view();
    if (v.phase === "end") break;
    const me = v.me;
    if (await shotsGame(v)) continue;
    if (spymaster) await giveClue(v);
    else await operative(v);
    // The pad, while the team listens (stopped, or between rounds).
    if (!spymaster && !padDone && me?.pad && ((v.phase === "guess" && !me.active) || v.phase === "round")) await (shots ? shotsPad() : pad());
    let moment = "";
    if (v.phase === "intro") moment = "intro";
    else if (v.phase === "clue") moment = `r${v.round}-clue${me?.clue ? "-in" : ""}`;
    else if (v.phase === "round") moment = `r${v.round}-over`;
    else if (v.phase === "guess" && v.open) {
      if (!seen.has(`r${v.round}-step${v.roundStep}:open`)) {
        seen.add(`r${v.round}-step${v.roundStep}:open`);
        openedAt = Date.now();
      }
      // Once the phone's team has pinned (or after a while): the pins are in the picture.
      const pinned = me && (Object.keys(me.pins).length > 0 || !me.active || me.locked !== null);
      if (pinned || Date.now() - openedAt > 3000) moment = `r${v.round}-step${v.roundStep}`;
    } else if (v.phase === "guess" && v.flip > 0) moment = `r${v.round}-step${v.roundStep}-flip`;
    if (moment && !seen.has(moment)) {
      seen.add(moment);
      log(moment);
      await sleep(moment.endsWith("-flip") ? 1000 : 500);
      await shot(moment);
      continue;
    }
    await sleep(150);
  }

  if (shots) {
    // A second game for the spymaster's picture: Phil takes the role, the same board.
    await win.eval(`(() => { crosstalk.game.close(); crosstalk.game.script = ${JSON.stringify(scenario.script(team))}; return true; })()`);
    await phone.until(`!!document.getElementById("be-spymaster")`, 10_000);
    await phone.eval(`document.getElementById("be-spymaster").click(); true`);
    await win.until(`crosstalk.party.room.peek().next[${JSON.stringify(team)}] === ${JSON.stringify(phil)}`, 5000);
    await phone.eval(`document.getElementById("start").click(); true`);
    await phone.until(`!!document.querySelector(".seat.spymaster .clueform:not([hidden])")`, 20_000);
    await typeInto("#clue", scenario.SPY_CLUE.word);
    await phone.eval(`document.querySelectorAll(".numbers button")[${scenario.SPY_CLUE.number - 1}].click(); document.activeElement.blur(); true`);
    await pic(phone, "phone-spymaster", "phone", 500);
    await check("phone the spymaster's picture", phone);
    await win.eval(`(() => { crosstalk.game.close(); return true; })()`);
    if (kept.length < 3) problem(`only these pictures: ${kept.join(", ")}`);
  } else {
    // The end: the TV over 20 s (the key, the clues, the pads, the result), the phone long.
    log(`the end: ${await win.eval<string>(`JSON.stringify([crosstalk.party.room.peek().winner, crosstalk.party.room.peek().reason])`)}`);
    await phone.until(`!!document.querySelector(".result")`, 10_000);
    const endAt = Date.now();
    await sleep(800);
    await shot("end");
    // The TV's end runs in stages (the key, the clues round by round, the pads, the result): every 5 s
    // until it holds still (at least 20 s, at most 60).
    let was = "";
    for (let at = 5000; at <= 60_000; at += 5000) {
      await sleep(Math.max(0, endAt + at - Date.now()));
      await tvShot(`end-${at / 1000}s`);
      const now = await tv.eval<string>(`document.body.innerText`);
      if (at >= 20_000 && now === was) break;
      was = now;
    }
    await phone.resize({ width: 390, height: 4200, mobile: true });
    await sleep(400);
    await phone.screenshot(`${out}/phone-${String(++n).padStart(2, "0")}-end-whole.png`);
    await check("phone the whole end", phone);
    await phone.resize(PHONE);
    const end = await view();
    if (!spymaster) {
      const mine = end.pads[team];
      if (!mine.some((l) => l.startsWith(NOTE.text) && l.endsWith(NOTE.edit))) problem(`the end's pad of ${team} has not Phil's line: ${JSON.stringify(mine)}`);
      const shown = await phone.eval<string>(`[...document.querySelectorAll(".teamblock .padlines")].map((e) => e.innerText).join("\\n")`);
      if (!shown.includes(NOTE.edit.trim())) problem("the phone's end does not show Phil's pad line");
    } else if (refusals === 0) problem("the too close clue was not refused");
    const errors = await win.eval<string[]>(`crosstalk.robots.flatMap((b) => b.errors)`);
    if (errors.length > 0) problem(`the bots' errors: ${errors.join(", ")}`);
    const loudText = await loud.eval<string>(`(document.getElementById("stage") ?? document.body).innerText.trim()`);
    if (!loudText) problem("the TV with sound shows nothing at the end");
  }
  for (const [name, tab] of pages) for (const e of tab.errors.splice(0)) problem(`${name}: ${e.replace(/:\d+\/favicon/, ":PORT/favicon")}`);
  log(`game over; problems: ${problems.length || "none"}; screenshots in ${out}`);
  if (problems.length > 0) failed = true;
  await win.eval(`document.getElementById("quit")?.click(); true`);
  await Promise.race([exited, sleep(10_000)]);
} catch (err) {
  failed = true;
  log(`FAILED: ${(err as Error).stack ?? String(err)}`);
  writeFileSync(`${out}/tvpipe.log`, tvpipeLog.join("\n"));
} finally {
  browser.close();
  proc.kill();
}
for (const p of problems) console.log(`PROBLEM ${p}`);
process.exit(failed ? 1 : 0);
