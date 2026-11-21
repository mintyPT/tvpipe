/**
 * A live check of Shifty on `tvpipe game play` (not part of `npm test`):
 * tvpipe serves the bundle (`dist/`); a headless Chrome plays the window
 * (the launcher, then the host page), the TV (the watch link at
 * 1280×720) and a phone (joining, turning its card, typing its clues
 * letter by letter with a word of the board refused first, accusing,
 * picking the word when it is the phony); bots join in the window and
 * play the rest. Screenshots of the TV and the phone at each moment, a
 * layout check of the TV (nothing off the screen, no word cut, nothing
 * under the join badge) and of every phone screen at 390 and 320 px.
 *
 *   npm run build && node test/live/play.ts [--bots N] [--rounds N] [--lang en|de] [--mode typed|spoken] [--long] [--out DIR] [--shots DIR]
 *
 * `--long`: the first round's board is the language's longest words and
 * the phone's clue a word of 24 letters, to see that none is cut off.
 *
 * `--shots DIR`: the pictures for the games list (docs/game-catalog.md)
 * into DIR, from the fixed round of `SCRIPT` below (four people, zoo
 * animals, the giraffe, Lena the phony): `tv-clue` (Phil typing his clue
 * under the spotlight, the needle running), `phone-clue` (his phone),
 * `phone-card` (his card turned up), `tv-verdict` (the red strings and
 * the stamp on Lena); the game ends there:
 *
 *   node test/live/play.ts --bots 3 --shots ../../site/static/games/shifty
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

const { values: args } = parseArgs({
  options: {
    bots: { type: "string", default: "4" },
    rounds: { type: "string", default: "2" },
    lang: { type: "string", default: "en" },
    mode: { type: "string", default: "typed" },
    long: { type: "boolean", default: false },
    out: { type: "string" },
    shots: { type: "string" },
  },
});

/** The round for the games list's pictures. */
const SCRIPT = {
  category: "Zoo animals",
  board: ["giraffe", "zebra", "lion", "elephant", "hippo", "rhino", "flamingo", "kangaroo", "camel", "penguin", "gorilla", "crocodile", "panda", "koala", "tiger", "ostrich"],
  secret: "giraffe",
  phony: "Lena",
  order: ["Mia", "Lena", "Phil", "Jonas"],
};
const PEOPLE = ["Mia", "Lena", "Jonas"];
const PEOPLE_CLUES = [["spots"], ["savanna"], ["leaves"]];
const PHIL_CLUE = "neck";

const here = new URL("../../", import.meta.url);
const repo = new URL("../../", here);
const exe = process.platform === "win32" ? "tvpipe.exe" : "tvpipe";
const binary = process.env["TVPIPE_BINARY"] ?? ["release", "debug"].map((p) => fileURLToPath(new URL(`target/${p}/${exe}`, repo))).find((p) => existsSync(p));
if (!binary) throw new Error("build tvpipe first (cargo build --release -p tvpipe-cli)");
const lang = args.lang === "de" ? "de" : "en";
const shots = args.shots;
const nBots = Number(args.bots);
if (shots && (nBots !== PEOPLE.length || lang !== "en")) throw new Error(`--shots plays a scripted round in English: --bots ${PEOPLE.length}`);
const out = args.out ?? `/tmp/shifty-play${lang === "de" ? "-de" : ""}${args.long ? "-long" : ""}${shots ? "-shots" : ""}`;
mkdirSync(out, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const proc = spawn(binary, ["game", "play", fileURLToPath(here), "--window", "none", "--no-tunnel"], { stdio: ["ignore", "pipe", "pipe"] });
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
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.shifty`, 20_000);
  log("the host page runs the game");
  const set = (key: string, value: string) => win.eval(`(() => { shifty.page.set(${JSON.stringify(key)}, ${JSON.stringify(value)}); return true; })()`);
  await set("lang", lang);
  await set("mode", args.mode === "spoken" ? "spoken" : "typed");
  await win.until(`shifty.game.lang === ${JSON.stringify(lang)}`, 5000);
  const timings = { deal: 6000, clue: 22_000, pin: 1600, skip: 1400, talk: 30_000, verdict: 2200, string: 750, swing: 3000, last: 15_000, reveal: 9000, scores: 6000 };
  await win.eval(`(() => { shifty.game.configure({ rounds: ${shots ? 1 : Number(args.rounds)}, clues: ${shots ? 1 : 0}, timings: ${JSON.stringify(timings)} }); return true; })()`);
  if (shots) await win.eval(`(() => { shifty.game.script = ${JSON.stringify(SCRIPT)}; return true; })()`);
  if (args.long && !shots) {
    // The language's longest words on the board, Phil the first to give a clue.
    const script = await win.eval<object>(`(async () => {
      const res = await fetch("/data/words${lang === "de" ? ".de" : ""}.txt");
      const text = await res.text();
      const cats = []; let cur = null;
      for (const line of text.split("\\n")) { if (line.startsWith("#") || !line.trim()) continue; if (line.startsWith("==")) { cur = { title: line.replace(/^==\\s*/, "").trim(), words: [] }; cats.push(cur); continue; } cur?.words.push(line.split("|")[0].trim()); }
      const len = (c) => c.words.map((w) => w.length).sort((a, b) => b - a).slice(0, 16).reduce((a, b) => a + b, 0);
      const best = cats.sort((a, b) => len(b) - len(a))[0];
      const board = [...best.words].sort((a, b) => b.length - a.length).slice(0, 16);
      return { category: best.title, board, secret: board[0], phony: "Robo1", order: ["Phil"] };
    })()`);
    await win.eval(`(() => { shifty.game.script = ${JSON.stringify(script)}; return true; })()`);
    log(`--long: ${JSON.stringify(script)}`);
  }
  const links = await win.eval<{ join: string; watch: string }>(`({ join: shifty.party.links.join, watch: shifty.party.links.watch })`);
  const tv = await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720 });
  const PHONE = { width: 390, height: 844, mobile: true };
  const phone = await browser.open(links.join, { ...PHONE, locale: lang === "de" ? "de-DE" : "en-US" });
  await phone.until(`!!document.getElementById("name")`, 20_000);
  const loud = await browser.open(links.watch, { width: 640, height: 360 });
  const pages: [string, Tab][] = [["the window", win], ["the TV", tv], ["the TV with sound", loud], ["the phone", phone]];
  await sleep(600);
  await phone.screenshot(`${out}/phone-00-join.png`);
  await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form button").click(); true`);
  await phone.until(`!!document.querySelector(".lobby")`);
  if (shots) await win.eval(`shifty.addBots(${PEOPLE.length}, { names: ${JSON.stringify(PEOPLE)}, clues: ${JSON.stringify(PEOPLE_CLUES)}, sharp: 1, think: 1800 }).then(() => true)`);
  else if (args.long) await win.eval(`shifty.addBots(${nBots}, { clues: Array.from({ length: ${nBots} }, () => ${JSON.stringify(lang === "de" ? ["Rindfleischetikettierung", "Kraftfahrzeughaftpflicht", "Donaudampfschifffahrt"] : ["incomprehensibilities", "counterrevolutionaries", "uncharacteristically"])}) }).then(() => true)`);
  else await win.eval(`shifty.addBots(${nBots}).then(() => true)`);
  await phone.until(`document.querySelectorAll(".chips .chip").length === ${nBots + 1}`, 20_000);
  log(`${nBots} bots joined in the window`);
  await win.screenshot(`${out}/host.png`);

  const layout = `(() => {
    const out = [];
    const W = innerWidth;
    if (document.documentElement.scrollWidth > W + 1) out.push("the page is wider than the screen: " + document.documentElement.scrollWidth);
    for (const el of document.querySelectorAll("body *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "canvas", "input", "i"].includes(el.localName) || el.closest(".back, .logo")) continue;
      const cs = getComputedStyle(el);
      const clipped = cs.textOverflow === "ellipsis";
      if (!clipped && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.overflowX === "visible") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 40)));
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > W + 2 || r.left < -2)) out.push("off the side: " + el.localName + "." + el.className);
    }
    for (const el of document.querySelectorAll("[data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.closest(".secret:not(.up) .face")) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    return out;
  })()`;
  const check = async (where: string, tab: Tab) => {
    for (const f of await tab.eval<string[]>(layout).catch((e: Error) => [`cannot check: ${e.message.slice(0, 100)}`])) problem(`${where}: ${f}`);
  };
  /** The TV: no word cut, nothing off the screen, nothing that matters under the join badge. */
  const tvLayout = `(() => {
    const out = [];
    const moving = document.getAnimations().filter((a) => a.playState === "running" && !(a.effect?.getTiming?.().iterations === Infinity)).map((a) => a.effect?.target).filter((x) => x instanceof Element);
    const still = (el) => !moving.some((m) => m.contains(el));
    for (const el of document.querySelectorAll("#stage .scene:not(.leaving) [data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    const badge = document.querySelector("tvpipe-rejoin")?.shadowRoot?.querySelector(".mini.shown")?.getBoundingClientRect();
    for (const el of document.querySelectorAll("#stage .scene:not(.leaving) *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "g", "circle", "rect", "text", "canvas", "i"].includes(el.localName) || el.closest(".logo, .tape, .overlay")) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && still(el) && (r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 || r.top < -2)) out.push("off the screen: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
      if (cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.display !== "inline") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
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
  let n = 0;
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
  await sleep(500);
  await shot("lobby");
  await phone.until(`!document.getElementById("start")?.disabled`);
  await phone.eval(`document.getElementById("start").click(); true`);

  const state = () =>
    win.eval<{ phase: string; key: string; mine: boolean; phony: boolean }>(`(() => {
      const g = shifty.game; const s = shifty.party.screenView().screen ?? {};
      const phil = shifty.party.players.find((p) => p.name === "Phil");
      return { phase: g.phase, key: [g.phase, g.stage ?? "", s.round ?? "", s.turn?.key ?? ""].join("|"), mine: s.turn?.id === phil?.id && !s.turn?.done, phony: g.isPhony(phil?.id ?? "") };
    })()`);
  /** Types into the clue field letter by letter (the TV's tiles and needle follow), or deletes. */
  const type = async (text: string, gap = 140) => {
    for (const ch of [...text]) {
      await phone.eval(`(() => { const i = document.querySelector("input.clue"); i.value += ${JSON.stringify(ch)}; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await sleep(gap + Math.random() * 80);
    }
  };
  const erase = async (k: number) => {
    for (let i = 0; i < k; i++) {
      await phone.eval(`(() => { const i = document.querySelector("input.clue"); i.value = [...i.value].slice(0, -1).join(""); i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await sleep(90);
    }
  };

  const dropped = new Set<string>();
  const seen = new Set<string>();
  const deadline = Date.now() + 25 * 60_000;
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
    const [phase, stg, round, turn] = s.key.split("|");
    const tag = `r${round}-${phase}${stg ? `-${stg}` : ""}${turn ? `-${turn.split(":")[1]}${s.mine ? "-phil" : ""}` : ""}`;
    log(tag);
    if (stg === "deal") {
      await sleep(1800);
      await shot(`${tag}-down`, true);
      await phone.eval(`document.querySelector(".secret").click(); true`);
      await sleep(700);
      await shot(`${tag}-up`, false);
      await pic(phone, "phone-card", "phone", 300);
      await phone.eval(`document.querySelector(".secret").click(); true`);
    } else if (stg === "clue" && s.mine) {
      await phone.until(`!!document.querySelector("input.clue") || !!document.querySelector(".turn .btn")`, 8000);
      await sleep(900);
      if (args.mode === "spoken") {
        await shot(tag);
        await phone.eval(`document.querySelector(".clueform .btn").click(); true`);
        continue;
      }
      const secret = await win.eval<string>(`shifty.game.secret()?.word ?? ""`);
      const board0 = await win.eval<string>(`shifty.game.round.board[0].word`);
      // A false start (deleted), a word of the board (refused), then the clue.
      if (shots) {
        await type("lo", 180);
        await sleep(900);
        await erase(2);
        await sleep(700);
        await type(PHIL_CLUE.slice(0, 3), 200);
        await sleep(400);
        await pic(tv, "tv-clue", "tv", 350);
        await pic(phone, "phone-clue", "phone", 100);
        await type(PHIL_CLUE.slice(3));
      } else {
        await type((s.phony ? board0 : secret).replace(/\s+/g, "").slice(0, 24) || "x", 90);
        await phone.eval(`document.querySelector(".clueform").requestSubmit(); true`);
        await phone.until(`!!document.querySelector(".error")?.textContent`, 5000).catch(() => problem(`${tag}: a word of the board was not refused`));
        await sleep(600);
        await shot(`${tag}-refused`);
        await phone.eval(`(() => { const i = document.querySelector("input.clue"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
        const clue = args.long ? (lang === "de" ? "Rindfleischetikettierung" : "electroencephalographers") : lang === "de" ? "flauschig" : "fluffy";
        await type(clue, 110);
        // A long clue stays readable whole: the field's font gets smaller.
        const typed = await phone.eval<{ need: number; has: number }>(`(() => { const i = document.querySelector("input.clue"); return { need: i.scrollWidth, has: i.clientWidth }; })()`);
        if (typed.need > typed.has + 1) problem(`${tag}: the clue does not fit its field (${typed.need} > ${typed.has})`);
        await sleep(300);
        await shot(`${tag}-typing`);
      }
      await phone.eval(`document.querySelector(".clueform").requestSubmit(); true`);
      await sleep(900);
      await shot(`${tag}-sent`);
    } else if (stg === "clue") {
      await sleep(Math.min(6000, timings.clue * 0.25));
      await tvShot(tag);
      // Dropping out (not with --shots): the phone reloads with its memory gone and joins by name: its seat again.
      if (!shots && !dropped.has("phone")) {
        dropped.add("phone");
        await phone.eval(`localStorage.clear(); location.reload(); true`);
        await phone.until(`!!document.getElementById("name")`);
        await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form button").click(); true`);
        await phone.until(`!document.getElementById("name")`);
        const back = await win.eval<boolean>(`shifty.party.players.filter((p) => p.name === "Phil").length === 1 && shifty.party.players.find((p) => p.name === "Phil").connected`);
        log(`phone: forgot everything, reloaded, joined as Phil again: ${back ? "his seat" : "NOT his seat"}`);
        if (!back) throw new Error("Phil did not get his seat back");
        await sleep(500);
        await shot(`${tag}-rejoined`, false);
      }
    } else if (stg === "accuse") {
      if (!shots && !dropped.has("bot")) {
        dropped.add("bot");
        const name = await win.eval<string>(`(() => { const b = shifty.robots[0]; b.client.drop({ away: 8000, forget: true }); return b.name; })()`);
        log(`${name}'s phone dropped out (back by name in 8 s)`);
        await sleep(4000);
        const badge = await tv.eval<string>(`(() => { const r = document.querySelector("tvpipe-rejoin")?.shadowRoot; return r?.querySelector(".card") ? "a rejoin card" : r?.querySelector(".mini.shown")?.innerText ?? ""; })()`);
        log(`the TV's join badge: ${JSON.stringify(badge.replace(/\n/g, " / "))}`);
        if (!badge || badge === "a rejoin card") throw new Error("no join badge on the TV (or a rejoin card)");
      }
      await phone.until(`document.querySelectorAll(".suspects .suspect").length > 0`, 8000);
      await sleep(1000);
      await shot(tag);
      const target = shots ? `[...document.querySelectorAll(".suspects .suspect")].find((b) => b.textContent.includes("Lena"))` : `document.querySelector(".suspects .suspect")`;
      await phone.eval(`(() => { ${target}.click(); return true; })()`);
      await sleep(300);
      await shot(`${tag}-picked`, false);
      await phone.eval(`document.querySelector(".btn.red").click(); true`);
      await sleep(800);
      await shot(`${tag}-accused`);
    } else if (stg === "verdict") {
      const votes = await win.eval<number>(`shifty.game.round.votes.size`);
      await sleep(900 + votes * 750 + 1200);
      await pic(tv, "tv-verdict", "tv", 100);
      await shot(tag);
      if (!shots) {
        await sleep(2600);
        await tvShot(`${tag}-swing`);
      }
    } else if (stg === "last") {
      await sleep(1500);
      if (s.phony) {
        await phone.until(`document.querySelectorAll(".board.picking .w").length > 0`, 8000);
        await shot(`${tag}-picking`);
        await phone.eval(`document.querySelectorAll(".board.picking .w")[3].click(); true`);
        await sleep(300);
        await phone.eval(`document.querySelector(".btn.red").click(); true`);
        await sleep(600);
        await shot(`${tag}-picked`, false);
      } else await shot(tag);
    } else if (stg === "reveal" || stg === "gone") {
      await sleep(4500);
      await shot(tag);
    } else if (phase === "scores") {
      await sleep(2600);
      await shot(tag);
    }
  }
  if (shots && kept.length < 4) problem(`only these pictures: ${kept.join(", ")}`);
  if (!shots) {
    await sleep(4500);
    await shot("final");
    const errors = await win.eval<string[]>(`shifty.robots.flatMap((b) => b.errors)`);
    if (errors.length > 0) problem(`the bots' errors: ${errors.join(", ")}`);
    const sound = await loud.eval<string>(`document.querySelector(".scene.final") ? "final" : ""`);
    if (sound !== "final") problem("the TV with sound did not reach the end");
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
