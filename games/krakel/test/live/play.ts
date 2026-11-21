/**
 * A live check of krakel on `tvpipe game play` (not part of `npm test`):
 * tvpipe serves the bundle (`dist/`); a headless Chrome plays the window
 * (the launcher, then the host page), the TV (the watch link at
 * 1280×720) and a phone (joining, picking a word, drawing it in colour,
 * a wrong guess and the right one for every drawing on stage, a heart);
 * bots join in the window (with the game's oracle, so they name the
 * drawings somewhere along their replays). Screenshots of the TV and the
 * phone at each moment, and a layout check of every phone screen at 390
 * and 320 px.
 *
 *   npm run build && node test/live/play.ts [--bots N] [--rounds N] [--lang en|de] [--hints on|off] [--mixed on|off] [--long] [--out DIR] [--shots DIR]
 *
 * `--long`: the first round with the longest words there are (and one
 * longer than any in the lists), to see that none is cut off or broken.
 *
 * `--shots DIR`: the pictures for the games list (docs/game-catalog.md)
 * into DIR, from the fixed round of `scenario.ts` (four people, every
 * drawing made by hand): `phone-draw` (Phil drawing his giraffe),
 * `tv-guess` (Mia's flamingo half redrawn, the guesses coming in) and
 * `phone-guess` (Phil typing his guess under it); the game ends there:
 *
 *   node test/live/play.ts --bots 3 --shots ../../site/static/games/krakel
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

const { values: args } = parseArgs({
  options: {
    bots: { type: "string", default: "4" },
    rounds: { type: "string", default: "2" },
    lang: { type: "string", default: "en" },
    hints: { type: "string", default: "on" },
    mixed: { type: "string", default: "off" },
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
const out = args.out ?? `/tmp/krakel-play${lang === "de" ? "-de" : ""}${shots ? "-shots" : ""}`;
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
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.krakel`, 20_000);
  log("the host page runs the game");
  // A setting as the host picks it (HostPage.set: the form's own path).
  const set = (key: string, value: string) => win.eval(`(() => { krakel.page.set(${JSON.stringify(key)}, ${JSON.stringify(value)}); return true; })()`);
  await set("rounds", shots ? "1" : args.rounds);
  await set("lang", lang);
  await set("hints", args.hints === "off" ? "off" : "on");
  await set("mixed", args.mixed === "on" && !shots ? "on" : "off");
  await win.until(`krakel.game.lang === ${JSON.stringify(lang)} && krakel.game.settings.hints === ${args.hints !== "off"}`, 5000);
  // Short timers; the phone gets time to draw and to guess twice, and to give its heart after
  // the first gallery's drop-out check (a bot away and back by name: about 11 s).
  const timings = shots ? { draw: 60_000, guess: 30_000, lead: 3000, reveal: 4000, vote: 12_000, ranked: 9000, scores: 6000 } : { draw: 30_000, guess: 16_000, lead: 3000, reveal: 4500, vote: 24_000, ranked: 10_000, scores: 6000 };
  await win.eval(`(() => { krakel.game.configure({ timings: ${JSON.stringify(timings)}, lockout: 2 }); return true; })()`);
  if (shots) await win.eval(`(() => { krakel.game.script = ${JSON.stringify(scenario.script())}; return true; })()`);
  if (args.long && !shots) {
    const words = lang === "de" ? ["Schraubenschlüssel", "Meeresschildkröte", "Fliegender Teppich", "Donaudampfschifffahrt", "Geschirrspülmaschine"] : ["brussels sprout", "hot air balloon", "gingerbread man", "rollercoasterride", "washing machine"];
    const names = ["Phil", "Robo1", "Pixel1", "Gizmo1", "Bolt1"];
    const script = { category: lang === "de" ? "Werkzeug & Werkstatt" : "Tools & workshop", words: Object.fromEntries(names.map((n, i) => [n, words[i]])) };
    await win.eval(`(() => { krakel.game.script = ${JSON.stringify(script)}; return true; })()`);
  }
  const links = await win.eval<{ join: string; watch: string }>(`({ join: krakel.party.links.join, watch: krakel.party.links.watch })`);
  const tv = await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720 });
  const PHONE = { width: 390, height: 844, mobile: true };
  const phone = await browser.open(links.join, { ...PHONE, locale: lang === "de" ? "de-DE" : "en-US" });
  await phone.until(`!!document.getElementById("name")`, 20_000);
  // A second TV with its sound on (the first is the muted preview's link). Every page's errors
  // come over DevTools from before it loads (Tab.errors: exceptions, console.error, failed loads).
  const loud = await browser.open(links.watch, { width: 640, height: 360 });
  const pages: [string, Tab][] = [["the window", win], ["the TV", tv], ["the TV with sound", loud], ["the phone", phone]];
  await sleep(600);
  await tv.screenshot(`${out}/tv-00-empty.png`);
  await phone.screenshot(`${out}/phone-00-join.png`);
  await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form button").click(); true`);
  await phone.until(`!!document.querySelector(".lobby")`);
  if (shots) await win.eval(scenario.joinScript());
  else await win.eval(`krakel.addBots(${nBots}).then(() => true)`);
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
      if (r.width > 0 && (r.right > W + 2 || r.left < -2) && !el.closest(".hrt")) out.push("off the side: " + el.localName + "." + el.className);
      if (document.body.classList.contains("full") && r.height > 0 && r.bottom > innerHeight + 2) out.push("off the bottom: " + el.localName + "." + el.className);
    }
    // Words that must be read whole fit their box (fit.js), and nothing that matters ends in an ellipsis.
    for (const el of document.querySelectorAll("[data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    // The pad and the replay: square, on screen, as large as the layout allows.
    const pad = document.querySelector("canvas.pad, canvas.view");
    if (pad) {
      const r = pad.getBoundingClientRect();
      if (Math.abs(r.width - r.height) > 2) out.push("the paper is not square");
      if (r.bottom > innerHeight + 1 || r.top < -1) out.push("the paper runs off the screen");
      // (With the keyboard up there is little left for it: the TV has the picture.)
      if (innerHeight >= 480 && r.width < Math.min(W, innerHeight) * 0.6) out.push("the paper is small: " + Math.round(r.width));
      if (innerHeight < 480 && r.width < 130) out.push("the paper is tiny: " + Math.round(r.width));
    }
    return out;
  })()`;
  const check = async (where: string, tab: Tab) => {
    for (const f of await tab.eval<string[]>(layout).catch((e: Error) => [`cannot check: ${e.message.slice(0, 100)}`])) problem(`${where}: ${f}`);
  };
  /** The TV: nothing wider than its box, nothing off the screen. */
  const tvLayout = `(() => {
    const out = [];
    for (const el of document.querySelectorAll("#stage .scene:not(.leaving) [data-fit]")) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push("a word does not fit: " + JSON.stringify(el.textContent) + " " + el.scrollWidth + " > " + el.clientWidth);
    }
    for (const el of document.querySelectorAll("#stage .scene:not(.leaving) *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "g", "canvas", "i"].includes(el.localName) || el.closest(".confetti, .pen, .doodle, .logo")) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 || r.top < -2)) out.push("off the screen: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
      if (cs.textOverflow !== "ellipsis" && el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.display !== "inline") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify((el.innerText || "").slice(0, 30)));
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
    win.eval<{ phase: string; key: string }>(`(() => { const r = krakel.party.room.peek(); const s = krakel.party.screenView().screen ?? {}; return { phase: krakel.game.phase, key: [krakel.game.phase, r.round, s.index ?? "", s.stage ?? ""].join(":") }; })()`);
  /** What the phone shows now. */
  const task = () =>
    phone
      .eval<string>(
        `document.querySelector(".choices button") ? "pick" : document.querySelector("canvas.pad") ? "draw" : document.querySelector(".guess-form") ? "guess" : document.querySelector(".gotit") ? "got" : document.querySelector(".foot .myword") ? "artist" : document.querySelector(".voting .cand") ? "vote" : ""`,
      )
      .catch(() => "");
  const padBox = () => phone.eval<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector("canvas.pad").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`);
  const pen = (label: string) => phone.eval(`(() => { document.querySelector(${JSON.stringify(`.palette button[aria-label="${label}"], .sizes button[aria-label="${label}"]`)}).click(); return true; })()`);
  const names = lang === "de" ? { yellow: "Gelb", black: "Schwarz", red: "Rot", thick: "dicker Stift", fine: "feiner Stift", rubber: "Radierer" } : { yellow: "yellow", black: "black", red: "red", thick: "thick pen", fine: "fine pen", rubber: "eraser" };
  /** A sun with a face on the pad (touch): a few pens, the eraser, undo. */
  const doodle = async () => {
    const box = await padBox();
    const pt = (a: number, b: number): [number, number] => [box.x + a * box.w, box.y + b * box.w];
    await pen(names.yellow);
    await pen(names.thick);
    await phone.drag(Array.from({ length: 40 }, (_, i) => pt(0.5 + 0.24 * Math.cos((i / 39) * 2 * Math.PI), 0.5 + 0.24 * Math.sin((i / 39) * 2 * Math.PI))));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 2 * Math.PI;
      await phone.drag([pt(0.5 + 0.3 * Math.cos(a), 0.5 + 0.3 * Math.sin(a)), pt(0.5 + 0.36 * Math.cos(a), 0.5 + 0.36 * Math.sin(a)), pt(0.5 + 0.42 * Math.cos(a), 0.5 + 0.42 * Math.sin(a))]);
    }
    await pen(names.black);
    await pen(names.fine);
    await phone.drag([pt(0.42, 0.45), pt(0.425, 0.455)]);
    await phone.drag([pt(0.58, 0.45), pt(0.585, 0.455)]);
    await pen(names.red);
    await phone.drag(Array.from({ length: 14 }, (_, i) => pt(0.4 + (0.2 * i) / 13, 0.58 + 0.06 * Math.sin((i / 13) * Math.PI))));
    // A stray line, taken back; a nick out of a ray with the eraser.
    await phone.drag([pt(0.1, 0.1), pt(0.2, 0.15), pt(0.3, 0.1)]);
    await phone.eval(`document.querySelector('.tools .tool').click(); true`);
    await pen(names.rubber);
    await phone.drag([pt(0.86, 0.5), pt(0.9, 0.5)]);
    await pen(names.black);
  };

  /**
   * Dropping out (not with --shots): during the first guessing a bot's
   * phone goes for 9 s and comes back by name (its token lost, as on
   * another phone): the TV shows the rejoin badge; at the first scores
   * Phil's phone forgets everything, reloads and joins with the same
   * name: his seat again.
   */
  const dropped = new Set<string>();
  const rejoinChecks = async (phase: string) => {
    if (shots) return;
    if (phase === "gallery" && !dropped.has("bot")) {
      dropped.add("bot");
      const name = await win.eval<string>(`(() => { const b = krakel.robots[0]; b.client.drop({ away: 9000, forget: true }); return b.name; })()`);
      log(`${name}'s phone dropped out (back by name in 9 s)`);
      await sleep(5500);
      await tvShot("rejoin");
      const badge = await tv.eval<string>(`document.querySelector("tvpipe-rejoin")?.shadowRoot.querySelector(".card.on")?.innerText ?? ""`);
      log(`the TV's rejoin badge: ${JSON.stringify(badge.replace(/\n/g, " / "))}`);
      if (!badge.includes(name)) throw new Error("no rejoin badge on the TV");
      await win.until(`krakel.party.players.find((p) => p.name === ${JSON.stringify(name)}).connected`, 15_000);
      log(`${name} is back by name`);
    }
    if (phase === "scores" && !dropped.has("phone")) {
      dropped.add("phone");
      await phone.eval(`localStorage.clear(); location.reload(); true`);
      await phone.until(`!!document.getElementById("name")`);
      await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("form button").click(); true`);
      await phone.until(`!document.getElementById("name")`);
      const back = await win.eval<boolean>(`krakel.party.players.filter((p) => p.name === "Phil").length === 1 && krakel.party.players.find((p) => p.name === "Phil").connected`);
      log(`phone: forgot everything, reloaded, joined as Phil again: ${back ? "his seat" : "NOT his seat"}`);
      if (!back) throw new Error("Phil did not get his seat back");
    }
  };

  const seen = new Set<string>();
  const deadline = Date.now() + 25 * 60_000;
  let reloaded = false;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the game took too long");
    if (shots && kept.length >= 3) break;
    const s = await state();
    if (s.phase === "final") break;
    const [phase, round, index, stg] = s.key.split(":");
    const ph = ["draw", "guess", "gallery"].includes(phase!) ? await task() : "";
    const key = `${s.key}:${ph}`;
    if (seen.has(key)) {
      await sleep(120);
      continue;
    }
    seen.add(key);
    const tag = `r${round}-${phase}${index ? `-${index}` : ""}${stg ? `-${stg}` : ""}${ph ? `-${ph}` : ""}`;
    log(tag);
    await rejoinChecks(phase!);
    if (phase === "draw" && ph === "pick") {
      await sleep(900);
      await shot(tag);
      await phone.eval(`document.querySelectorAll(".choices button")[${shots ? scenario.PICK : 1}].click(); true`);
    } else if (phase === "draw" && ph === "draw") {
      await sleep(500);
      if (shots) await scenario.drawOn(phone, await padBox(), scenario.PHIL);
      else await doodle();
      // The page is kept on the phone: a reload in the middle loses nothing.
      if (!shots && !reloaded) {
        reloaded = true;
        await sleep(900);
        const before = await phone.eval<number>(`JSON.parse(localStorage.getItem("krakel:draft")).strokes.length`);
        await phone.eval(`location.reload(); true`);
        await sleep(400);
        await phone.until(`!!document.querySelector("canvas.pad")`, 10_000);
        await sleep(500);
        const after = await phone.eval<number>(`JSON.parse(localStorage.getItem("krakel:draft")).strokes.length`);
        log(`phone: reloaded while drawing: ${before} strokes before, ${after} after`);
        if (before < 10 || after !== before) throw new Error("the drawing did not survive a reload");
      }
      await shot(tag);
      if (shots) await pic(phone, "phone-draw", "phone", 300);
      await phone.eval(`(() => { const b = document.getElementById("done"); b.click(); if (b.classList.contains("arm")) b.click(); return true; })()`);
      await sleep(900);
      await phone.screenshot(`${out}/phone-${String(++n).padStart(2, "0")}-${tag}-handed-in.png`);
      await check(`phone ${tag} handed in`, phone);
      await sleep(400);
      await tvShot(`${tag}-tv`);
    } else if (phase === "guess" && stg === "guess" && ph === "guess") {
      // The count-in, then a wrong guess, then the word.
      await sleep(1200);
      await tvShot(`${tag}-count-in`);
      await win.until(`krakel.party.now() >= krakel.party.screenView().screen.start`, 10_000);
      const type = (text: string) => phone.eval(`(() => { const i = document.querySelector(".guess-form input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      /** Waits until a share of the guess time has passed. */
      const share = (f: number) => win.until(`(() => { const s = krakel.party.screenView().screen; return krakel.party.now() >= s.start + (s.end - s.start) * ${f}; })()`, 60_000);
      if (shots) {
        // Phil's wrong guess, then the next one typed; the pictures a moment before he sends it.
        await share(scenario.PHIL_WRONG[0]);
        await type(scenario.PHIL_WRONG[1]);
        await phone.eval(`document.querySelector(".guess-form").requestSubmit(); true`);
        await share(scenario.SHOT - 0.035);
        await type(scenario.GUESS);
        await pic(tv, "tv-guess", "tv", 250);
        await pic(phone, "phone-guess", "phone", 100);
        continue;
      }
      await share(0.3);
      await type(lang === "de" ? "Kartoffel" : "potato");
      await phone.eval(`document.querySelector(".guess-form").requestSubmit(); true`);
      await sleep(500);
      await shot(`${tag}-wrong`);
      // The keyboard is up on Android: the page is resized to what is left, wider than tall.
      // It is still a phone held upright: the picture above, the guess below it, the field wide.
      await phone.resize({ width: 360, height: 330, mobile: true });
      await sleep(300);
      const field = await phone.eval<{ w: number; h: number; pad: number } | null>(`(() => { const i = document.querySelector(".guess-form input"); const c = document.querySelector("canvas.view"); return i && c ? { w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height, pad: c.getBoundingClientRect().width } : null; })()`);
      // A long guess stays readable whole: the field's font gets smaller.
      await type(lang === "de" ? "Donaudampfschifffahrt" : "rollercoaster carriage");
      const typed = await phone.eval<{ need: number; has: number; font: number }>(`(() => { const i = document.querySelector(".guess-form input"); return { need: i.scrollWidth, has: i.clientWidth, font: parseFloat(getComputedStyle(i).fontSize) }; })()`);
      if (typed.need > typed.has + 1 || typed.font < 12) problem(`${tag}: a long guess does not fit its field (${typed.need} > ${typed.has} at ${typed.font} px)`);
      await phone.screenshot(`${out}/phone-${String(n).padStart(2, "0")}-${tag}-keyboard.png`);
      await type("");
      await check(`phone ${tag} with the keyboard up`, phone);
      if (field && (field.w < 180 || field.h < 44)) problem(`${tag}: with the keyboard up the guess field is ${Math.round(field.w)} × ${Math.round(field.h)} px`);
      await phone.resize(PHONE);
      await sleep(150);
      const word = await win.eval<string>(`krakel.game.meant(krakel.party.players.find((p) => p.name === "Phil").id)?.word ?? ""`);
      if (!word) continue;
      await phone.until(`!document.querySelector(".guess-form .btn").disabled || !document.querySelector(".guess-form")`, 10_000).catch(() => {});
      // A long word with a slip in it (a letter twice) still counts.
      await type(word.length >= 7 ? word.slice(0, 3) + word[2] + word.slice(3) : word);
      await phone.eval(`document.querySelector(".guess-form")?.requestSubmit(); true`);
      await phone.until(`!!document.querySelector(".gotit")`, 5000).catch(() => problem(`${tag}: ${JSON.stringify(word)} was not taken`));
      await sleep(600);
      await shot(`${tag}-right`);
    } else if (phase === "guess" && stg === "guess" && ph === "artist") {
      await sleep(3000 + timings.guess * 0.5);
      await shot(tag);
    } else if (phase === "guess" && stg === "reveal") {
      await sleep(1500);
      await shot(tag);
    } else if (phase === "gallery" && stg === "vote" && ph === "vote") {
      await sleep(1200);
      await shot(tag);
      await phone.eval(`(() => { document.querySelector(".cand:not(:disabled)").click(); return true; })()`);
      await sleep(400);
      await phone.screenshot(`${out}/phone-${String(++n).padStart(2, "0")}-${tag}-picked.png`);
      await check(`phone ${tag} picked`, phone);
      await phone.eval(`document.querySelector(".verdict-bar .btn").click(); true`);
      await sleep(600);
      await shot(`${tag}-given`);
    } else if (phase === "gallery" && stg === "ranked") {
      await sleep(Math.min(7000, timings.ranked - 2500));
      await shot(tag);
    } else if (phase === "scores") {
      await sleep(2600);
      await shot(tag);
    }
  }
  if (shots && kept.length < 3) problem(`only these pictures: ${kept.join(", ")}`);
  if (!shots) {
    await sleep(4500);
    await shot("final");
    const errors = await win.eval<string[]>(`krakel.robots.flatMap((b) => b.errors)`);
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
