/**
 * A live check of garble on `tvpipe game play` (not part of `npm test`):
 * tvpipe serves the bundle (`dist/`); a headless Chrome plays the window
 * (the launcher, then the host page), the TV (the watch link at
 * 1280×720) and a phone (joining, picking a word and drawing it,
 * guessing, drawing on top, reacting, voting for the best move); bots
 * join in the window (with the game's oracle, so most layers are read
 * right). Screenshots of the TV and the phone at each moment, a layout
 * check of every phone screen at 390 and 320 px and of the TV (nothing
 * off the screen, every word to read whole), and the run fails on any
 * page's errors (exceptions, console.error, failed loads, over DevTools
 * from before the pages load) and on the bots' errors. A second TV with
 * its sound on plays along.
 *
 *   npm run build && node test/live/play.ts [--bots N] [--rounds N] [--length 3|5|7] [--lang en|de] [--undo on|off] [--long] [--out DIR] [--shots DIR]
 *
 * `--long`: the first round with the longest words there are (and some
 * longer than any in the lists) and the longest guess the phone takes,
 * to see that none is cut off or broken.
 *
 * `--shots DIR`: the pictures for the games list (docs/game-catalog.md)
 * into DIR, from the fixed round of `scenario.ts` (four people, every
 * layer and guess written by hand): `phone-guess` (Phil guessing Lena's
 * cat), `phone-draw` (Phil turning it into a submarine on top) and
 * `tv-reveal` (Mia's sun, Jonas's lion, Lena's clock rebuilt in their
 * colours, with the guesses); the game ends there:
 *
 *   node test/live/play.ts --bots 3 --shots ../../site/static/games/garble
 *
 * Needs Chrome and tvpipe built (TVPIPE_BINARY, else target/release, else target/debug).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
    rounds: { type: "string", default: "2" },
    length: { type: "string", default: "5" },
    lang: { type: "string", default: "en" },
    undo: { type: "string", default: "on" },
    long: { type: "boolean", default: false },
    out: { type: "string" },
    shots: { type: "string" },
  },
});

const here = new URL("../../", import.meta.url);
const repo = new URL("../../", here);
const exe = process.platform === "win32" ? "tvpipe.exe" : "tvpipe";
const binary = process.env["TVPIPE_BINARY"] ?? ["release", "debug"].map((p) => fileURLToPath(new URL(`target/${p}/${exe}`, repo))).find((p) => existsSync(p));
if (!binary) throw new Error("build tvpipe first (cargo build --release -p tvpipe-cli)");
const lang = args.lang === "de" ? "de" : "en";
const shots = args.shots;
const nBots = Number(args.bots);
if (shots && (nBots !== scenario.PEOPLE.length - 1 || lang !== "en")) throw new Error(`--shots plays scenario.ts (in English): --bots ${scenario.PEOPLE.length - 1}`);
const out = args.out ?? `/tmp/garble-play${lang === "de" ? "-de" : ""}${shots ? "-shots" : ""}${args.long ? "-long" : ""}`;
/** --long: the longest words (some longer than any in the lists), and the longest guess (28 characters). */
const LONG = {
  en: { words: ["traffic light", "rollercoasterride", "ferris wheel", "hot air balloon", "washing machine", "gingerbread man"], guess: "rollercoasterride with a cat" },
  de: { words: ["Außerirdischer", "Donaudampfschifffahrt", "Schmetterling", "Geschirrspülmaschine", "Eichhörnchen", "Meeresschildkröte"], guess: "Geschirrspülmaschinenmonster" },
}[lang];
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
  const win = await browser.open(start, { width: 1200, height: 800 });
  await win.until(`document.querySelectorAll("#devices .device").length > 0`, 20_000);
  await win.eval(`document.querySelector('#devices .device[data-name="browser"]').click(); true`);
  await win.until(`!document.getElementById("start").disabled`);
  await win.eval(`document.getElementById("start").click(); true`);
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.garble`, 20_000);
  log("the host page runs the game");
  // A setting as the host picks it (HostPage.set: the form's own path).
  const set = (key: string, value: string) => win.eval(`(() => { garble.page.set(${JSON.stringify(key)}, ${JSON.stringify(value)}); return true; })()`);
  await set("rounds", shots ? "1" : args.rounds);
  await set("length", shots ? "3" : args.length);
  await set("timers", "fast");
  // The fast timers, but time for the phone's screenshots and checks before its guess is due.
  await win.eval(`(() => { garble.game.configure({ timings: { ...garble.game.timings, guess: 25_000 } }); return true; })()`);
  await set("lang", lang);
  await set("undo", args.undo === "off" ? "off" : "on");
  await win.until(`garble.game.lang === ${JSON.stringify(lang)} && garble.game.settings.undo === ${args.undo !== "off"}`, 5000);
  if (shots) {
    // The scripted round; the reveal lingers on each finished picture for the TV's picture.
    await win.eval(`(() => { garble.game.script = ${JSON.stringify(scenario.script())}; garble.game.timings.legend = 9000; return true; })()`);
  } else if (args.long) {
    // Every picture of round 1 the longest words, each picture its own order (the bots' names: host.ts).
    const names = ["Phil", ...["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket", "Widget", "Servo", "Cog", "Dynamo", "Fuse"].slice(0, nBots).map((x) => `${x}1`)];
    const w = LONG.words;
    const pictures = names.map((_, i) => {
      const order = w.map((_, j) => w[(i + j) % w.length]!);
      return { choices: [order[0]!, order[1]!], words: order.slice(2) };
    });
    await win.eval(`(() => { garble.game.script = ${JSON.stringify({ seats: names, pictures })}; return true; })()`);
  }
  const links = await win.eval<{ join: string; watch: string }>(`({ join: garble.party.links.join, watch: garble.party.links.watch })`);
  const tv = await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720 });
  const PHONE = { width: 390, height: 844, mobile: true };
  const phone = await browser.open(links.join, { ...PHONE, locale: lang === "de" ? "de-DE" : "en-US" });
  await phone.until(`!!document.getElementById("name")`, 20_000);
  // A second TV with its sound on (the first is muted), for the sound's errors.
  const loud = await browser.open(links.watch, { width: 640, height: 360 });
  const pages: [string, Tab][] = [["the window", win], ["the TV", tv], ["the TV with sound", loud], ["the phone", phone]];
  await tv.screenshot(`${out}/tv-00-empty.png`);
  await phone.screenshot(`${out}/phone-00-join.png`);
  await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form button").click(); true`);
  await phone.until(`!!document.querySelector(".lobby")`);
  if (shots) await win.eval(scenario.joinScript());
  else await win.eval(`garble.addBots(${nBots}).then(() => true)`);
  await phone.until(`document.querySelectorAll(".chips .chip").length === ${nBots + 1}`, 20_000);
  log(`${nBots} ${shots ? "scripted players" : "bots"} joined in the window`);
  await win.screenshot(`${out}/host.png`);

  const layout = `(() => {
    const out = [];
    const W = innerWidth;
    if (document.documentElement.scrollWidth > W + 1) out.push("the page is wider than the screen: " + document.documentElement.scrollWidth);
    for (const el of document.querySelectorAll("body *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "canvas", "input", "i"].includes(el.localName)) continue;
      const cs = getComputedStyle(el);
      const clipped = cs.textOverflow === "ellipsis" || cs.webkitLineClamp !== "none";
      if (!clipped && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.overflowX === "visible") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 40)));
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > W + 2 || r.left < -2) && !el.closest(".slip")) out.push("off the side: " + el.localName + "." + el.className);
    }
    // Words that must be read whole fit their box (fit.js), and a typed guess its field (fitField).
    for (const el of document.querySelectorAll("[data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    for (const el of document.querySelectorAll("input")) {
      if (!el.value || (el.checkVisibility && !el.checkVisibility())) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("the typed text does not fit: " + JSON.stringify(el.value) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    // The pad and the guess's picture: square, on screen, as large as the layout allows.
    const pad = document.querySelector("canvas.pad, canvas.view");
    if (pad) {
      const r = pad.getBoundingClientRect();
      if (Math.abs(r.width - r.height) > 2) out.push("the paper is not square");
      if (r.bottom > innerHeight + 1 || r.top < -1) out.push("the paper runs off the screen");
      if (r.width < Math.min(W, innerHeight) * 0.6) out.push("the paper is small: " + Math.round(r.width));
    }
    return out;
  })()`;
  const check = async (where: string, tab: Tab) => {
    for (const f of await tab.eval<string[]>(layout).catch((e: Error) => [`cannot check: ${e.message.slice(0, 100)}`])) problem(`${where}: ${f}`);
  };
  /** The TV: every word to read whole, nothing off the screen or wider than its box. */
  const tvLayout = `(() => {
    const out = [];
    for (const el of document.querySelectorAll("#stage .scene:not(.leaving) [data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    // What is moving now (a card flying in, a row sliding in) is checked where it lands, in a later shot.
    const moving = document.getAnimations().filter((a) => a.playState === "running").map((a) => a.effect?.target).filter((x) => x instanceof Element);
    for (const el of document.querySelectorAll("#stage .scene:not(.leaving) *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "g", "canvas", "i"].includes(el.localName) || el.closest(".confetti, .logo")) continue;
      if (moving.some((m) => m.contains(el))) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 || r.top < -2)) out.push("off the screen: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
      // (An underline drawn by ::after past the ends is not text running out.)
      const deco = ["::before", "::after"].some((p) => getComputedStyle(el, p).position === "absolute");
      if (!deco && cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.display !== "inline") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
    }
    return out;
  })()`;
  const tvShot = async (name: string) => {
    await tv.screenshot(`${out}/tv-${String(++n).padStart(2, "0")}-${name}.png`);
    for (const f of await tv.eval<string[]>(tvLayout).catch(() => [])) problem(`tv ${name}: ${f}`);
  };
  let n = 0;
  const kept: string[] = [];
  const pic = async (tab: Tab, name: string, kind: "tv" | "phone", settle?: number) => {
    if (!shots || kept.some((f) => f.startsWith(`${name}.`))) return;
    kept.push(await keep(tab, shots, name, kind, settle));
    log(`picture: ${kept.at(-1)}`);
  };
  const shot = async (name: string, tvToo = true) => {
    if (tvToo) await tvShot(name);
    const at = String(tvToo ? n : ++n).padStart(2, "0");
    await phone.screenshot(`${out}/phone-${at}-${name}.png`);
    await check(`phone ${name}`, phone);
    await phone.resize({ width: 320, height: 640, mobile: true });
    await sleep(250);
    await check(`small phone ${name}`, phone);
    await phone.screenshot(`${out}/phone-${at}-${name}-320.png`);
    await phone.resize(PHONE);
    await sleep(150);
  };
  await shot("lobby");
  await phone.until(`!document.getElementById("start")?.disabled`);
  await phone.eval(`document.getElementById("start").click(); true`);

  const state = () =>
    win.eval<{ phase: string; key: string }>(
      `(() => { const r = garble.party.room.peek(); const s = garble.party.screenView().screen ?? {}; return { phase: garble.game.phase, key: [garble.game.phase, r.round, r.step, s.index, s.stage, s.cursor].join(":") }; })()`,
    );
  /** What the phone shows now. */
  const task = () =>
    phone
      .eval<string>(
        `document.querySelector(".choices button") ? "pick" : document.querySelector("canvas.pad") ? "draw" : document.querySelector(".guess-form") ? "guess" : document.querySelector(".voting .cand") ? "vote" : document.querySelector(".reacts") ? "react" : document.querySelector(".passed") ? "passed" : ""`,
      )
      .catch(() => "");
  const padBox = () => phone.eval<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector("canvas.pad").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`);
  /** A face doodle on the pad (touch), wherever there is room or not. */
  const doodle = async () => {
    const box = await padBox();
    const pt = (a: number, b: number): [number, number] => [box.x + a * box.w, box.y + b * box.w];
    await phone.drag(Array.from({ length: 40 }, (_, i) => pt(0.5 + 0.28 * Math.cos((i / 39) * 2 * Math.PI), 0.52 + 0.3 * Math.sin((i / 39) * 2 * Math.PI))));
    await phone.drag(Array.from({ length: 12 }, (_, i) => pt(0.3 + i * 0.01, 0.3 - i * 0.012)));
    await phone.drag([pt(0.42, 0.45), pt(0.425, 0.455)]);
    await phone.drag([pt(0.58, 0.45), pt(0.585, 0.455)]);
    await phone.drag(Array.from({ length: 14 }, (_, i) => pt(0.38 + (0.24 * i) / 13, 0.62 + 0.06 * Math.sin((i / 13) * Math.PI))));
  };

  /**
   * Dropping out (not with --shots): at the first reveal a bot's phone
   * goes for 15 s and comes back by name (its token lost, as on another
   * phone): the TV still shows the join badge, the host page a Rejoin button;
   * at the first scores Phil's phone forgets everything, reloads and
   * joins with the same name: his seat again.
   */
  const dropped = new Set<string>();
  const rejoin = lang === "de" ? "Rückkehrcode" : "Rejoin code";
  const rejoinChecks = async (phase: string) => {
    if (shots) return;
    if (phase === "reveal" && !dropped.has("bot")) {
      dropped.add("bot");
      const name = await win.eval<string>(`(() => { const b = garble.robots[0]; b.client.drop({ away: 15_000, forget: true }); return b.name; })()`);
      log(`${name}'s phone dropped out (back by name in 15 s)`);
      await sleep(5500);
      // Both before the screenshot: with several windows a screenshot can take seconds.
      const badge = await tv.eval<string>(`(() => { const r = document.querySelector("tvpipe-rejoin")?.shadowRoot; return r?.querySelector(".card") ? "a rejoin card" : r?.querySelector(".mini.shown")?.innerText ?? ""; })()`);
      const button = await win.eval<boolean>(`[...document.querySelectorAll("button")].some((b) => b.textContent === ${JSON.stringify(rejoin)})`);
      await tv.screenshot(`${out}/tv-${String(++n).padStart(2, "0")}-rejoin.png`);
      log(`the TV's join badge: ${JSON.stringify(badge.replace(/\n/g, " / "))}; the host's Rejoin button: ${button}`);
      if (!badge || badge === "a rejoin card" || !button) throw new Error("no join badge on the TV (or a rejoin card), or no Rejoin button");
      await win.eval(`[...document.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(rejoin)}).click(); true`);
      await win.until(`!!document.querySelector("dialog.tvpipe-rejoin")`);
      await win.screenshot(`${out}/host-rejoin.png`);
      await win.until(`!document.querySelector("dialog.tvpipe-rejoin") && garble.party.players.find((p) => p.name === ${JSON.stringify(name)}).connected`, 15_000);
      log(`${name} is back by name; the host's dialog closed by itself`);
    }
    if (phase === "scores" && !dropped.has("phone")) {
      dropped.add("phone");
      await phone.eval(`localStorage.clear(); location.reload(); true`);
      await phone.until(`!!document.getElementById("name")`);
      await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form button").click(); true`);
      await phone.until(`!document.getElementById("name")`);
      const back = await win.eval<boolean>(`garble.party.players.filter((p) => p.name === "Phil").length === 1 && garble.party.players.find((p) => p.name === "Phil").connected`);
      log(`phone: forgot everything, reloaded, joined as Phil again: ${back ? "his seat" : "NOT his seat"}`);
      if (!back) throw new Error("Phil did not get his seat back");
    }
  };

  const seen = new Set<string>();
  const deadline = Date.now() + 25 * 60_000;
  let step = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the game took too long");
    if (shots && kept.length >= 3) break;
    const s = await state();
    if (s.phase === "final") break;
    const [phase, round, stepNo, index, stg, cursor] = s.key.split(":");
    step = Number(stepNo) || step;
    const ph = phase === "play" ? await task() : phase === "vote" ? await task() : "";
    const key = `${s.key}:${ph}`;
    if (seen.has(key)) {
      await sleep(150);
      continue;
    }
    seen.add(key);
    const tag = `r${round}-${phase}${phase === "play" ? `-s${stepNo}-${ph}` : ""}${phase === "reveal" ? `-p${index}-${stg}${stg === "layers" ? cursor : ""}` : ""}`;
    log(tag);
    await rejoinChecks(phase!);
    const k = step - 1;
    if (phase === "play" && ph === "pick") {
      await sleep(800);
      await shot(tag);
      const pick = shots ? scenario.PICTURES[0]!.pick : 0;
      await phone.eval(`document.querySelectorAll(".choices button")[${pick}].click(); true`);
    } else if (phase === "play" && ph === "draw") {
      await sleep(600);
      const where = shots ? scenario.work("Phil", k) : null;
      if (where) await scenario.drawOn(phone, await padBox(), scenario.PICTURES[where.picture]!.layers[where.layer]!);
      else await doodle();
      if (!shots && args.undo !== "off") {
        // Undo takes back your own last stroke (the mouth), never the old ink.
        const before = await phone.eval<number>(`document.querySelector("canvas.pad") ? 1 : 0`);
        if (before) await phone.eval(`document.querySelector('.tools .tool').click(); true`);
      }
      await shot(tag);
      if (shots && k === 1) await pic(phone, "phone-draw", "phone", 300);
      await phone.eval(`document.getElementById("done").click(); true`);
      await sleep(700);
      await phone.screenshot(`${out}/phone-${String(++n).padStart(2, "0")}-${tag}-passed.png`);
    } else if (phase === "play" && ph === "guess") {
      await sleep(900);
      const where = shots ? scenario.work("Phil", k) : null;
      const text = where ? scenario.PICTURES[where.picture]!.guesses[k - 1]! : args.long && round === "1" ? LONG.guess : lang === "de" ? "eine Katze" : "a cat";
      // Typed (input events: the field fits its text), as a keyboard would.
      await phone.send("Page.bringToFront");
      await phone.eval(`(() => { const i = document.querySelector(".guess-form input"); i.value = ""; i.focus(); return true; })()`);
      const typed = Date.now();
      await phone.type(text);
      log(`typed ${JSON.stringify(text)} in ${Date.now() - typed} ms`);
      await shot(tag);
      if (shots && k === 1) await pic(phone, "phone-guess", "phone", 300);
      await phone.eval(`document.querySelector(".guess-form").requestSubmit(); true`);
    } else if (phase === "reveal") {
      if (stg === "layers") {
        await sleep(1800);
        await tvShot(tag);
        if (cursor === "0") {
          await check(`phone ${tag}`, phone);
          await phone.eval(`document.querySelectorAll(".reacts button")[${Math.floor(Math.random() * 4)}]?.click(); true`).catch(() => {});
        }
      } else if (stg === "legend") {
        const id = await win.eval<number>(`garble.party.screenView().screen.picture.id`);
        if (shots && id === scenario.COVER) await pic(tv, "tv-reveal", "tv", 700);
        else {
          await sleep(500);
          await tvShot(tag);
        }
      }
    } else if (phase === "vote" && ph === "vote") {
      await sleep(1200);
      await shot(tag);
      const pickIt = shots
        ? `document.querySelector('.cand[data-layer="${scenario.VOTES.Phil}"]')`
        : `document.querySelector(".cand:not(:disabled)")`;
      await phone.eval(`(() => { ${pickIt}.click(); return true; })()`);
      await sleep(300);
      await phone.screenshot(`${out}/phone-${String(++n).padStart(2, "0")}-${tag}-picked.png`);
      await check(`phone ${tag} picked`, phone);
      await phone.eval(`document.querySelector(".verdict-bar .btn").click(); true`);
    } else if (phase === "best") {
      await sleep(2600);
      await shot(tag);
    } else if (phase === "scores") {
      await sleep(2200);
      await shot(tag);
    }
  }
  if (shots && kept.length < 3) problem(`only these pictures: ${kept.join(", ")}`);
  if (!shots) {
    await sleep(2000);
    await shot("final");
    const errors = await win.eval<string[]>(`garble.robots.flatMap((b) => b.errors.map((e) => b.name + ": " + e))`);
    if (errors.length > 0) problem(`the bots' errors: ${errors.join(", ")}`);
    const end = await loud.eval<string>(`document.querySelector(".scene.final") ? "final" : ""`);
    if (end !== "final") problem("the TV with sound did not reach the end");
  }
  for (const [name, tab] of pages) for (const e of tab.errors) problem(`${name}: ${e}`);
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
