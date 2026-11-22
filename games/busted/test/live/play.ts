/**
 * A live check of Busted on `tvpipe game play` (not part of `npm test`):
 * tvpipe serves the bundle (`dist/`); a headless Chrome plays the window
 * (the launcher, then the host page), the TV (the watch link at
 * 1280×720) and a phone (joining, drawing its press photo by touch,
 * suggesting a question and rating one, ranking its podium, writing an
 * answer, matching the anonymous answers with a heart); bots join in the
 * window and play the rest. Screenshots of the TV and the phone at each
 * stage, a layout check of the TV (nothing off the screen, no text cut,
 * nothing under the join badge) and of every phone screen at 390 and
 * 320 px.
 *
 *   npm run build && node test/live/play.ts [--bots N] [--rounds N] [--lang en|de] [--long] [--extras] [--out DIR] [--shots DIR]
 *
 * `--long`: the bots answer with 80 characters (the longest an answer
 * gets) and long names; `--extras`: three honorary candidates (with
 * `--bots 9`, the most candidates there can be: 13).
 *
 * `--shots DIR`: the pictures for the games list (docs/game-catalog.md)
 * into DIR from a fixed game (`SCRIPT`, four people): `tv-title` (the
 * front page with the winner's title), `tv-reveal` (a note busted),
 * `phone-rank` (Phil's podium), `phone-match` (Phil matching):
 *
 *   node test/live/play.ts --bots 3 --shots ../../site/static/games/busted
 *
 * Needs Chrome and tvpipe built (TVPIPE_BINARY, else target/release, else target/debug).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Browser, type Tab } from "./browser.ts";
import { keep } from "./shots.ts";
import { tie } from "./tie.ts";

const { values: args } = parseArgs({
  options: {
    bots: { type: "string", default: "4" },
    rounds: { type: "string", default: "4" },
    lang: { type: "string", default: "en" },
    out: { type: "string" },
    shots: { type: "string" },
    long: { type: "boolean", default: false },
    extras: { type: "boolean", default: false },
  },
});

const SCRIPT = { vote: "Who would most likely sleep through an entire day?", answer: "What would be your most useless superpower?" };
const PEOPLE = ["Mia", "Lena", "Jonas"];
const PEOPLE_ANSWERS = [["Turning invisible, but only when nobody is looking"], ["Talking to pigeons. They never listen"], ["Always knowing the exact time of day"]];
const PHIL_ANSWER = { en: "Making toast slightly warmer by staring at it", de: "Toast durch Anstarren leicht anwärmen" };
const BOT_TIP = { en: { kind: "vote", text: "Who would most likely adopt a goat by accident?", title: "Accidental Goat Owner" }, de: { kind: "vote", text: "Wer würde am ehesten aus Versehen eine Ziege adoptieren?", title: "Ziegenhalter:in wider Willen" } };
const PHIL_TIP = { en: "What would your autobiography be called?", de: "Wie würde deine Autobiografie heißen?" };

const here = new URL("../../", import.meta.url);
const repo = new URL("../../", here);
const exe = process.platform === "win32" ? "tvpipe.exe" : "tvpipe";
const binary = process.env["TVPIPE_BINARY"] ?? ["release", "debug"].map((p) => fileURLToPath(new URL(`target/${p}/${exe}`, repo))).find((p) => existsSync(p));
if (!binary) throw new Error("build tvpipe first (cargo build --release -p tvpipe-cli)");
const lang = args.lang === "de" ? "de" : "en";
const shots = args.shots;
const nBots = Number(args.bots);
if (shots && (nBots !== PEOPLE.length || lang !== "en")) throw new Error(`--shots plays a scripted game in English: --bots ${PEOPLE.length}`);
const out = args.out ?? `/tmp/busted-play${lang === "de" ? "-de" : ""}${args.long ? "-long" : ""}${shots ? "-shots" : ""}`;
const LONG = {
  en: ["Probably a tiny accordion orchestra playing sea shanties in my kitchen at midnight", "Whatever happens I would definitely blame the neighbour's suspiciously quiet cat first"],
  de: ["Wahrscheinlich ein winziges Akkordeonorchester, das um Mitternacht in meiner Küche spielt", "Egal was passiert, ich würde zuerst die verdächtig stille Katze der Nachbarn beschuldigen"],
};
const LONG_NAMES = ["Maximiliane", "Konstantin", "Bartholomew", "Wilhelmina", "Christopher", "Alexandria", "Friederike", "Jean-Baptiste", "Annemarie"];
mkdirSync(out, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.busted`, 20_000);
  log("the host page runs the game");
  const set = (key: string, value: string) => win.eval(`(() => { busted.page.set(${JSON.stringify(key)}, ${JSON.stringify(value)}); return true; })()`);
  await set("lang", lang);
  await win.until(`busted.game.lang === ${JSON.stringify(lang)}`, 5000);
  const timings = { ask: 4000, rank: 25_000, ballot: 900, tallied: 2400, title: 6500, write: 40_000, board: 4000, boardPer: 800, boardMax: 9000, match: 30_000, matchPer: 2000, matchMax: 60_000, card: 4800, revealed: 1200, scores: 5000 };
  await win.eval(`(() => { busted.game.configure({ rounds: ${shots ? 2 : Number(args.rounds)}, timings: ${JSON.stringify(timings)} }); return true; })()`);
  if (shots) await win.eval(`(() => { busted.game.script = ${JSON.stringify(SCRIPT)}; return true; })()`);
  const links = await win.eval<{ join: string; watch: string }>(`({ join: busted.party.links.join, watch: busted.party.links.watch })`);
  const tv = await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720 });
  const PHONE = { width: 390, height: 844, mobile: true };
  const phone = await browser.open(links.join, { ...PHONE, locale: lang === "de" ? "de-DE" : "en-US" });
  await phone.until(`!!document.getElementById("name")`, 20_000);
  const loud = await browser.open(links.watch, { width: 640, height: 360 });
  const pages: [string, Tab][] = [["the window", win], ["the TV", tv], ["the TV with sound", loud], ["the phone", phone]];
  await sleep(600);
  await phone.screenshot(`${out}/phone-00-join.png`);
  await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form button").click(); true`);
  await phone.until(`!!document.querySelector(".portrait")`);

  // The press photo, drawn by touch.
  await phone.eval(`document.querySelector(".portrait .btn").click(); true`);
  await phone.until(`!!document.querySelector(".pad canvas")`);
  await sleep(400);
  const pad = await phone.eval<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector(".pad canvas").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`);
  const P = (u: number, v: number): [number, number] => [pad.x + (u / 100) * pad.w, pad.y + (v / 100) * pad.w];
  const ring = (cx: number, cy: number, rx: number, ry: number, n = 24) => Array.from({ length: n + 1 }, (_, i) => P(cx + Math.cos((i / n) * 2 * Math.PI) * rx, cy + Math.sin((i / n) * 2 * Math.PI) * ry));
  for (const stroke of [ring(50, 54, 27, 33), ring(39, 47, 4, 3, 10), ring(61, 47, 4, 3, 10), [P(50, 52), P(47, 62), P(52, 63)], [P(38, 70), P(44, 75), P(50, 76), P(57, 75), P(63, 70)], [P(24, 40), P(30, 22), P(40, 16), P(50, 19), P(60, 14), P(70, 20), P(77, 38)]]) await phone.drag(stroke);
  await sleep(300);
  await phone.screenshot(`${out}/phone-01-pad.png`);
  await phone.eval(`[...document.querySelectorAll("#sheet .btn")].find((b) => !b.classList.contains("ghost")).click(); true`);
  await phone.until(`document.getElementById("sheet").hidden`);

  // A suggestion of his own.
  await phone.eval(`document.getElementById("tip").click(); true`);
  await phone.until(`!!document.querySelector("#sheet textarea")`);
  await phone.eval(`(() => { const ta = document.querySelector("#sheet textarea"); [...document.querySelectorAll("#sheet .kinds button")][1].click(); ta.value = ${JSON.stringify(PHIL_TIP[lang])}; ta.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await phone.screenshot(`${out}/phone-02-suggest.png`);
  await phone.eval(`[...document.querySelectorAll("#sheet .btn")].find((b) => !b.classList.contains("ghost")).click(); true`);
  await phone.until(`document.querySelectorAll("#sheet .mytips li").length === 1`);
  await phone.eval(`[...document.querySelectorAll("#sheet .btn.ghost")].at(-1).click(); true`);

  const bots = shots
    ? `busted.addBots(${PEOPLE.length}, { names: ${JSON.stringify(PEOPLE)}, answers: ${JSON.stringify(PEOPLE_ANSWERS)}, think: 1500, favor: ["Lena", "Jonas", "Mia"] })`
    : args.long
      ? `busted.addBots(${nBots}, { names: ${JSON.stringify(LONG_NAMES)}, answers: Array.from({ length: ${nBots} }, () => ${JSON.stringify(LONG[lang])}), suggest: [[${JSON.stringify(BOT_TIP[lang])}]] })`
      : `busted.addBots(${nBots}, { suggest: [[${JSON.stringify(BOT_TIP[lang])}]] })`;
  await win.eval(`${bots}.then(() => true)`);
  await phone.until(`document.querySelectorAll(".chips .chip").length >= ${nBots + 1}`, 20_000);
  log(`${nBots} bots joined in the window`);
  if (args.extras) {
    await win.eval(`(() => { for (const n of ${JSON.stringify(lang === "de" ? ["Oma Hildegard", "Bello", "Onkel Ferdinand"] : ["Grandma Rose", "Rex the dog", "Uncle Bartholomew"])}) busted.game.addExtra(n); return true; })()`);
    log("three honorary candidates");
  }
  if (!shots) {
    await phone.until(`!!document.querySelector(".desk:not([hidden]) .stamps")`, 8000).catch(() => problem("no suggestion to rate on the desk"));
    await phone.screenshot(`${out}/phone-03-desk.png`);
    await phone.eval(`document.querySelector(".desk .stamps .up")?.click(); true`);
  }
  await sleep(1200);
  await win.screenshot(`${out}/host.png`);

  const layout = `(() => {
    const out = [];
    const W = innerWidth;
    if (document.documentElement.scrollWidth > W + 1) out.push("the page is wider than the screen: " + document.documentElement.scrollWidth);
    for (const el of document.querySelectorAll("body *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "canvas", "input", "textarea"].includes(el.localName) || el.closest(".logo, #sheet")) continue;
      const cs = getComputedStyle(el);
      const clipped = cs.textOverflow === "ellipsis";
      if (!clipped && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.overflowX === "visible") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 40)));
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > W + 2 || r.left < -2)) out.push("off the side: " + el.localName + "." + el.className);
    }
    for (const el of document.querySelectorAll("[data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    return out;
  })()`;
  const check = async (where: string, tab: Tab) => {
    for (const f of await tab.eval<string[]>(layout).catch((e: Error) => [`cannot check: ${e.message.slice(0, 100)}`])) problem(`${where}: ${f}`);
  };
  /** The TV: no text cut, nothing off the screen, nothing that matters under the join badge. */
  const tvLayout = `(() => {
    const out = [];
    const moving = document.getAnimations().filter((a) => a.playState === "running" && !(a.effect?.getTiming?.().iterations === Infinity)).map((a) => a.effect?.target).filter((x) => x instanceof Element);
    const still = (el) => !moving.some((m) => m.contains(el));
    for (const el of document.querySelectorAll("#main .fitbox")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) out.push("text does not fit: " + JSON.stringify(el.textContent.slice(0, 40)) + " " + el.scrollWidth + "x" + el.scrollHeight + " > " + el.clientWidth + "x" + el.clientHeight);
    }
    const badge = document.querySelector("tvpipe-rejoin")?.shadowRoot?.querySelector(".mini.shown")?.getBoundingClientRect();
    for (const el of document.querySelectorAll("#page *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "canvas"].includes(el.localName) || el.id === "flash") continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && still(el) && (r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 || r.top < -2)) out.push("off the screen: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
      if (cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.display !== "inline" && cs.overflow !== "hidden") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
      if (badge && r.width > 0 && still(el) && el.children.length === 0 && (el.innerText || "").trim() && r.left < badge.right && r.right > badge.left && r.top < badge.bottom && r.bottom > badge.top) out.push("under the join badge: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
    }
    return out;
  })()`;
  const kept: string[] = [];
  const pic = async (tab: Tab, name: string, kind: "tv" | "phone", settle?: number) => {
    if (!shots || kept.some((f) => f.startsWith(`${name}.`))) return;
    kept.push(await keep(tab, shots, name, kind, settle));
    log(`picture: ${kept.at(-1)}`);
  };
  let n = 3;
  const tvShot = async (name: string) => {
    await tv.send("Page.bringToFront");
    await sleep(150);
    await tv.screenshot(`${out}/tv-${String(++n).padStart(2, "0")}-${name}.png`);
    for (const f of await tv.eval<string[]>(tvLayout).catch(() => [])) problem(`tv ${name}: ${f}`);
  };
  const shot = async (name: string, tvToo = true) => {
    if (tvToo) await tvShot(name);
    const at = String(tvToo ? n : ++n).padStart(2, "0");
    await phone.screenshot(`${out}/phone-${at}-${name}.png`);
    await check(`phone ${name}`, phone);
    await phone.resize({ width: 320, height: 568, mobile: true });
    await sleep(250);
    await check(`small phone ${name}`, phone);
    await phone.screenshot(`${out}/phone-${at}-${name}-320.png`);
    await phone.resize(PHONE);
    await sleep(150);
  };
  await shot("lobby");
  await phone.until(`!document.getElementById("start")?.disabled`);
  await phone.eval(`document.getElementById("start").click(); true`);

  const state = () => win.eval<{ phase: string; key: string }>(`(() => { const g = busted.game; return { phase: g.phase, key: [g.phase, g.stage ?? "", g.round, g.asked?.text ?? ""].join("|") }; })()`);
  const seen = new Set<string>();
  const deadline = Date.now() + 25 * 60_000;
  let dropped = false;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the game took too long");
    if (shots && kept.length >= 4) break;
    const s = await state();
    if (s.phase === "final") break;
    if (seen.has(s.key)) {
      await sleep(120);
      continue;
    }
    seen.add(s.key);
    const [phase, stg, round] = s.key.split("|");
    const tag = `r${round}-${phase}${stg ? `-${stg}` : ""}`;
    log(tag);
    if (stg === "ask") {
      await sleep(1600);
      await shot(tag);
    } else if (stg === "rank") {
      await phone.until(`document.querySelectorAll(".cand").length > 0`, 8000);
      await sleep(1200);
      await shot(tag);
      // Lena, Phil himself and Mia (the pictures); else the third, the second and the fourth.
      const k = await phone.eval<number>(`document.querySelectorAll(".cand").length`);
      const order = shots ? [2, 0, 1] : [2, 1, 3, 0].filter((i) => i < k);
      for (const i of order.slice(0, Math.min(3, k - 1))) {
        await phone.eval(`document.querySelectorAll(".cand")[${i}].click(); true`);
        await sleep(250);
      }
      await sleep(300);
      await pic(phone, "phone-rank", "phone", 200);
      await shot(`${tag}-podium`, false);
      await phone.eval(`document.querySelector(".card .btn").click(); true`);
      await sleep(900);
      await shot(`${tag}-filed`);
      if (!shots && !dropped) {
        // Dropping out: the phone reloads with its memory gone and joins by name: its seat again.
        dropped = true;
        await phone.eval(`localStorage.clear(); location.reload(); true`);
        await phone.until(`!!document.getElementById("name")`);
        await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form button").click(); true`);
        await phone.until(`!document.getElementById("name")`);
        const back = await win.eval<boolean>(`busted.party.players.filter((p) => p.name === "Phil").length === 1 && busted.party.players.find((p) => p.name === "Phil").connected`);
        log(`phone: forgot everything, reloaded, joined as Phil again: ${back ? "his seat" : "NOT his seat"}`);
        if (!back) throw new Error("Phil did not get his seat back");
      }
    } else if (stg === "count") {
      await sleep(2600);
      await tvShot(tag);
      const ballots = await win.eval<number>(`(busted.party.screenView().screen.ballots ?? []).length`);
      await sleep(ballots * timings.ballot + 600);
      await shot(`${tag}-tallied`);
    } else if (stg === "title") {
      await sleep(1400);
      await pic(tv, "tv-title", "tv", 200);
      await shot(tag);
    } else if (stg === "write") {
      await phone.until(`!!document.querySelector("textarea")`, 8000);
      await sleep(1500);
      await phone.eval(`(() => { const tas = document.querySelectorAll(".card textarea"); tas.forEach((ta, i) => { ta.value = ${JSON.stringify(PHIL_ANSWER[lang])} + (i ? " twice" : ""); ta.dispatchEvent(new Event("input", { bubbles: true })); }); return true; })()`);
      await shot(tag);
      await phone.eval(`document.querySelector(".card .btn").click(); true`);
      await sleep(1500);
      await shot(`${tag}-sent`);
    } else if (stg === "board") {
      await sleep(1800);
      await shot(tag);
    } else if (stg === "match") {
      await phone.until(`document.querySelectorAll(".note").length > 0`, 8000);
      await sleep(1000);
      await shot(tag);
      const k = await phone.eval<number>(`document.querySelectorAll(".note:not(.mine)").length`);
      for (let i = 0; i < k; i++) {
        await phone.eval(`document.querySelectorAll(".note:not(.mine)")[${i}].click(); true`);
        await phone.until(`!!document.querySelector("#sheet .picks")`, 3000);
        await sleep(200);
        if (i === 0) await shot(`${tag}-picker`, false);
        await phone.eval(`[...document.querySelectorAll("#sheet .picks button")].find((b) => !b.disabled)?.click(); true`);
        await sleep(200);
      }
      await phone.eval(`document.querySelector(".note:not(.mine) .heart")?.click(); true`);
      await sleep(300);
      await pic(phone, "phone-match", "phone", 200);
      await shot(`${tag}-matched`, false);
      await phone.eval(`document.querySelector(".card > .btn").click(); true`);
      await sleep(900);
      await shot(`${tag}-filed`);
    } else if (stg === "reveal") {
      // At a note's stamp: 80 % into the first note whose stamp is still to come.
      const r = await win.eval<{ start: number; per: number; now: number }>(`(() => { const r = busted.party.screenView().screen.reveal; return { start: r.start, per: r.per, now: busted.party.now() }; })()`);
      const k = Math.max(0, Math.ceil((r.now - r.start - r.per * 0.8) / r.per));
      await sleep(Math.max(0, r.start + r.per * (k + 0.8) - r.now));
      await pic(tv, "tv-reveal", "tv", 50);
      await shot(tag);
      await sleep(timings.card);
      await tvShot(`${tag}-2`);
    } else if (phase === "scores") {
      await sleep(1600);
      await shot(tag);
    }
  }
  if (shots && kept.length < 4) problem(`only these pictures: ${kept.join(", ")}`);
  if (!shots) {
    await sleep(3000);
    await shot("final");
    await sleep(9000);
    await tvShot("final-newsstand");
    const errors = await win.eval<string[]>(`busted.robots.flatMap((b) => b.errors)`);
    if (errors.length > 0) problem(`the bots' errors: ${errors.join(", ")}`);
  }
  for (const [name, tab] of pages) for (const e of tab.errors.splice(0)) problem(`${name}: ${e.replace(/:\d+\/favicon/, ":PORT/favicon")}`);
  log(`game over; problems: ${problems.length || "none"}; screenshots in ${out}`);
  if (problems.length > 0) failed = true;
  await win.eval(`document.getElementById("quit").click(); true`);
  await Promise.race([exited, sleep(10_000)]);
} catch (err) {
  failed = true;
  log(`FAILED: ${(err as Error).stack ?? String(err)}`);
  writeFileSync(`${out}/tvpipe.log`, tvpipeLog.join("\n"));
} finally {
  browser.close();
  proc.kill();
}
process.exit(failed ? 1 : 0);
