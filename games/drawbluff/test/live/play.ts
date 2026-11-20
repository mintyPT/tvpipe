/**
 * A live check of Drawbluff on `tvpipe game play` (not part of `npm
 * test`): tvpipe serves the bundle (`dist/`, or `drawbluff.zip` with
 * `--zip`); a headless Chrome plays the window (the launcher, then the
 * host page), a phone (joining, drawing with touch events, lying,
 * voting) and the TV (the `browser` receiver's player page, so the
 * picture went through tvpipe's own headless Chrome, the capture and the
 * stream); bots join through the public listener. Screenshots of the
 * launcher, the host window, the TV and the phone per phase.
 *
 *   npm run build && node test/live/play.ts [--zip] [--bots N] [--rounds N] [--tunnel=PROVIDER] [--tv page|canvas] [--lang en|de] [--out DIR] [--shots DIR]
 *
 * `--lang de`: the host page sets the room to German (its Language
 * setting), the phone is a German one (`de-DE`); the screenshots go to
 * `/tmp/drawbluff-de` unless `--out`. Every shot also checks the layout
 * (the phone, also at 320 px wide, and the TV page in the host's
 * preview): no text running out of its box, nothing off the screen, no
 * English left in a German room.
 *
 * `--tv canvas`: the TV page drawn into a canvas in the window
 * (HTML-in-Canvas) and streamed as a surface instead of tvpipe's own
 * browser capturing it (docs/playshare-design.md §17).
 *
 * `--shots DIR`: the pictures for the games list (docs/game-catalog.md)
 * into DIR: `tv-vote` (the TV page), `phone-draw` and `phone-vote`. The
 * round is then the one of `scenario.ts`: the host page gets its seven
 * prompts as `data/prompts.txt` (so the game deals exactly those and has
 * no decoys), the six others (`actors.ts`, people's names instead of
 * bots) and Phil draw the drawing made for their prompt and write the
 * fake titles made for each drawing; normal timers. The host page's
 * `Math.random` is seeded (`--seed`, default `SEED` in `scenario.ts`), so
 * who draws what and which drawing comes first are the same every time
 * (and the alt texts in site/static/games.json stay true).
 *
 *   node test/live/play.ts --shots ../../site/static/games/drawbluff
 *
 * Needs Chrome and tvpipe built (target/release, else target/debug, or
 * TVPIPE_BINARY).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { bots, type Bot } from "../../game/bots.ts";
import { actors, NAMES } from "./actors.ts";
import { Browser, type Tab } from "./browser.ts";
import { dealt, LAST_TOUCHES, lieFor, promptsFile, scene, SEED } from "./scenario.ts";
import { keep } from "./shots.ts";

const { values: args } = parseArgs({
  options: {
    zip: { type: "boolean", default: false },
    bots: { type: "string" },
    rounds: { type: "string", default: "1" },
    tunnel: { type: "string" },
    out: { type: "string" },
    tv: { type: "string", default: "page" },
    lang: { type: "string", default: "en" },
    shots: { type: "string" },
    seed: { type: "string", default: String(SEED) },
  },
});

const here = new URL("../../", import.meta.url);
const repo = new URL("../../", here);
const exe = process.platform === "win32" ? "tvpipe.exe" : "tvpipe";
const binary =
  process.env["TVPIPE_BINARY"] ??
  ["release", "debug"].map((p) => fileURLToPath(new URL(`target/${p}/${exe}`, repo))).find((p) => existsSync(p));
if (!binary) throw new Error("build tvpipe first (cargo build --release -p tvpipe-cli)");
const bundle = fileURLToPath(args.zip ? new URL("drawbluff.zip", here) : here);
const lang = args.lang === "de" ? "de" : "en";
if (args.shots && (lang !== "en" || (args.bots !== undefined && Number(args.bots) !== NAMES.length))) {
  throw new Error(`--shots plays scenario.ts: in English, with ${NAMES.length} others`);
}
const nBots = args.shots ? NAMES.length : Number(args.bots ?? 2);
const out = `${args.out ?? (lang === "de" ? "/tmp/drawbluff-de" : "/tmp/drawbluff-play")}${args.zip ? "-zip" : ""}${args.tv === "canvas" ? "-canvas" : ""}`;
mkdirSync(out, { recursive: true });
if (args.shots) mkdirSync(args.shots, { recursive: true });
const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} ${m}`);

// tvpipe game play, the window left to us (--window none prints its URL).
const tunnel = args.tunnel ? [`--tunnel=${args.tunnel}`] : ["--no-tunnel"];
const proc = spawn(binary, ["-v", "game", "play", bundle, "--window", "none", ...tunnel], { stdio: ["ignore", "pipe", "pipe"] });
const exited = new Promise<number | null>((r) => proc.on("exit", (c) => r(c)));
const tvpipeLog: string[] = [];
createInterface({ input: proc.stderr! }).on("line", (l) => {
  tvpipeLog.push(l);
  if (/ (WARN|ERROR) |playshare: /.test(l)) log(`tvpipe: ${l.replace(/^\s*\S+ /, "")}`);
});
const start = await new Promise<string>((resolve, reject) => {
  createInterface({ input: proc.stdout! }).once("line", resolve);
  exited.then(() => reject(new Error(`tvpipe exited:\n${tvpipeLog.join("\n")}`)));
});
log(`tvpipe game play ${args.zip ? "drawbluff.zip" : "games/drawbluff"}: ${start.replace(/t=.*/, "t=…")}`);

const browser = await Browser.launch();
let failed = false;
try {
  // The window: the launcher first.
  const win = await browser.open(start, { width: 1100, height: 760 });
  await win.until(`document.querySelectorAll("#devices .device").length > 0`);
  await new Promise((r) => setTimeout(r, 1500)); // a discovery round: real TVs show up too
  await win.screenshot(`${out}/launcher.png`);
  const listed = await win.eval<string[]>(`[...document.querySelectorAll("#devices .device")].map((d) => d.dataset.name)`);
  log(`launcher lists: ${listed.join(", ")}`);
  // Only the browser receiver (no real TV without asking).
  await win.eval(`document.querySelector('#devices .device[data-name="browser"]').click(); true`);
  await win.until(`!document.getElementById("start").disabled`);
  if (args.shots) {
    // The scenario's prompts, as the host page fetches data/prompts.txt.
    await win.serve("*/data/prompts.txt*", promptsFile());
    // The host page's Math.random seeded (mulberry32, as `seeded` in
    // game/rules.ts): the same deal and the same first drawing every time.
    await win.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => { let a = ${Number(args.seed) >>> 0}; Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();`,
    });
  }
  await win.eval(`document.getElementById("start").click(); true`);
  await win.until(`location.pathname.endsWith("/host/index.html") && !!globalThis.drawbluff`, 20_000);
  log("the host page runs the game");
  await win.eval(`(() => { const r = document.getElementById("rounds"); r.value = ${JSON.stringify(args.rounds)}; r.dispatchEvent(new Event("change")); const t = document.getElementById("timers"); t.value = ${JSON.stringify(args.shots ? "normal" : "fast")}; t.dispatchEvent(new Event("change")); return true; })()`);
  // The room's language, as the host page sets it.
  await win.eval(`(() => { const l = document.getElementById("lang"); l.value = ${JSON.stringify(lang)}; l.dispatchEvent(new Event("change")); return true; })()`);
  await win.until(`drawbluff.game.lang === ${JSON.stringify(lang)} && document.documentElement.lang === ${JSON.stringify(lang)}`);
  log(`the room speaks ${lang}`);
  const links = await win.eval<{ join: string; phone: string; code: string; watch: string }>(
    `({ join: drawbluff.party.links.join, phone: drawbluff.party.info.phone.url, code: drawbluff.party.code, watch: drawbluff.party.links.watch })`,
  );
  log(`room ${links.code}, phones join at ${links.join.replace(/#.*/, "#k=…")}`);
  // The TV: the browser receiver's player page, once the cast streams.
  await win.until(`!document.getElementById("player").hidden`, 60_000);
  if (args.tv === "canvas") {
    const before = await win.eval<string>(`document.getElementById("player").href`);
    await win.eval(`(() => { const m = document.getElementById("tvmode"); m.value = "canvas"; m.dispatchEvent(new Event("change")); return true; })()`);
    await win.until(`document.getElementById("player").href !== ${JSON.stringify(before)} && !document.getElementById("player").hidden`, 60_000);
    log("the TV picture is drawn in the window (HTML-in-Canvas) and streamed as a surface");
  }
  const playerUrl = await win.eval<string>(`document.getElementById("player").href`);
  const tv = await browser.open(playerUrl, { width: 1280, height: 720 });
  log(`TV: ${playerUrl.replace(/t=.*/, "t=…")}`);
  // The TV page itself (the watch link, muted) for crisp pictures.
  const screen = args.shots ? await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720 }) : undefined;
  const kept: string[] = [];
  const pic = async (tab: Tab, name: string, kind: "tv" | "phone", settle?: number) => {
    if (!args.shots || kept.some((f) => f.startsWith(`${name}.`))) return;
    kept.push(await keep(tab, args.shots, name, kind, settle));
    log(`picture: ${kept.at(-1)}`);
  };
  // A phone (through the phones' listener, as the QR code says).
  const phoneUrl = links.join.startsWith("https://") ? links.join : links.join;
  const PHONE = { width: 390, height: 844, mobile: true };
  const phone = await browser.open(phoneUrl, { ...PHONE, locale: lang === "de" ? "de-DE" : "en-US" });
  await phone.until(`!!document.getElementById("name")`, 20_000);
  await phone.screenshot(`${out}/phone-join.png`);
  log(`phone: navigator.language ${await phone.eval<string>("navigator.language")}, the join form says "${await phone.eval<string>(`document.querySelector("h1").textContent`)}"`);
  await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("#join-form button").click(); true`);
  await phone.until(`!!document.querySelector(".card.lobby") && document.documentElement.lang === ${JSON.stringify(lang)}`);
  const ws = `${links.phone.replace(/^http/, "ws")}_tvpipe/ws`;
  const u = new URL(links.join);
  const joinAs = {
    url: ws,
    room: u.searchParams.get("r")!,
    key: new URLSearchParams(u.hash.slice(1)).get("k")!,
    think: () => 1200 + Math.random() * 2000,
  };
  const botList: Bot[] = args.shots ? [] : await bots(nBots, joinAs);
  const robots: { errors?: string[]; close(): void }[] = args.shots ? await actors(joinAs) : botList;
  log(`${robots.length} ${args.shots ? "players" : "bots"} joined through the phones' listener`);

  const shots: string[] = [];
  const problems: string[] = [];
  /**
   * Layout problems in a document (`doc`: an expression): text running
   * out of its box (but where it ends with … on purpose), boxes off the
   * screen, and in a German room English words left.
   */
  const layout = (doc: string) => `(() => {
    const doc = ${doc};
    if (!doc) return ["no document"];
    const win = doc.defaultView;
    const out = [];
    const W = win.innerWidth, H = win.innerHeight;
    if (doc.documentElement.scrollWidth > W + 1) out.push("the page is wider than the screen: " + doc.documentElement.scrollWidth);
    for (const el of doc.querySelectorAll("body *")) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      if (["svg", "path", "rect", "canvas", "i", "input", "select", "option", "template"].includes(el.localName)) continue;
      const cs = win.getComputedStyle(el);
      const text = (el.innerText || "").trim().slice(0, 60);
      const clipped = cs.textOverflow === "ellipsis" || cs.webkitLineClamp !== "none" || cs.overflow === "hidden" && el.closest(".qr, #corner-qr");
      if (!clipped && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && cs.overflowX !== "auto" && cs.overflowX !== "scroll") out.push("too wide: " + el.localName + "." + el.className + " " + JSON.stringify(text));
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > W + 2 || r.left < -2)) out.push("off the side: " + el.localName + "." + el.className + " " + JSON.stringify(text));
    }
    ${
      lang === "de"
        ? `const words = (doc.body.innerText.match(/\\b(the|you|your|you're|waiting|players?|round|drawing|liars?|vote[sd]?|scores?|points?|found|fooled|meanwhile|which|title)\\b/gi) || []);
    if (words.length) out.push("English left: " + [...new Set(words)].join(", "));`
        : ""
    }
    return out;
  })()`;
  const check = async (where: string, tab: Tab, doc = "document") => {
    const found = await tab.eval<string[]>(layout(doc)).catch((e: Error) => [`cannot check: ${e.message.slice(0, 120)}`]);
    for (const f of found) {
      const p = `${where}: ${f}`;
      if (!problems.includes(p)) {
        problems.push(p);
        log(`LAYOUT ${p}`);
      }
    }
  };
  const shot = async (name: string) => {
    await new Promise((r) => setTimeout(r, 1500)); // the TV is a stream: a little behind
    await tv.screenshot(`${out}/tv-${name}.png`);
    await win.screenshot(`${out}/host-${name}.png`);
    await phone.screenshot(`${out}/phone-${name}.png`);
    await check(`phone ${name}`, phone);
    // The TV page itself, in the host's preview (the TV's 1280×720).
    await check(`tv ${name}`, win, `document.getElementById("preview").contentDocument`);
    // A small phone (320 px wide, an iPhone SE): long German words.
    await phone.resize({ width: 320, height: 640, mobile: true });
    await new Promise((r) => setTimeout(r, 300));
    await phone.screenshot(`${out}/phone-small-${name}.png`);
    await check(`small phone ${name}`, phone);
    await phone.resize(PHONE);
    shots.push(name);
    log(`screenshots: ${name}`);
  };
  await shot("lobby");
  // The phone's own language switch (in the lobby), there and back.
  const other = lang === "de" ? "en" : "de";
  await phone.eval(`document.getElementById("lang").click(); true`);
  await phone.until(`document.documentElement.lang === ${JSON.stringify(other)} && !!document.querySelector(".card.lobby")`);
  await phone.screenshot(`${out}/phone-lobby-switched.png`);
  await phone.eval(`document.getElementById("lang").click(); true`);
  await phone.until(`document.documentElement.lang === ${JSON.stringify(lang)} && localStorage.getItem("drawbluff:lang") === null`);
  log(`phone: switched to ${other} and back to the room's ${lang}`);
  // Phil picks a free colour (the bots have some) and, as the VIP, turns undo on.
  const pick = await phone.eval<number>(`[...document.querySelectorAll(".colors button")].findIndex((b) => !b.classList.contains("taken") && !b.classList.contains("chosen"))`);
  await phone.eval(`document.querySelectorAll(".colors button")[${pick}].click(); true`);
  await phone.until(`document.querySelectorAll(".colors button")[${pick}]?.classList.contains("chosen")`);
  await phone.eval(`document.querySelectorAll(".rules .seg")[0].querySelectorAll("button")[1].click(); true`);
  await win.until(`drawbluff.game.settings.undo === true`);
  log("phone: picked a colour, turned undo on");
  // Phil (the VIP) starts from the phone.
  await phone.until(`!document.querySelector("button.primary")?.disabled`);
  await phone.eval(`document.querySelector("button.primary").click(); true`);

  const phase = () => win.eval<string>(`drawbluff.game.phase`);
  const key = () => win.eval<string>(`drawbluff.game.phase + ":" + JSON.stringify([drawbluff.party.room.peek().round, drawbluff.party.room.peek().spot])`);
  /** Phil's state on the host (his task, prompt, the drawing he lies about). */
  const phil = () => win.eval<Record<string, any>>(`drawbluff.party.players.find((p) => p.name === "Phil")?.state.peek() ?? {}`);
  const padBox = (tab: Tab) =>
    tab.eval<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector("canvas.pad").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; })()`);
  /** Strokes of the 1000 grid with the pad's pens and sizes (the phone's widths: 8, 20, 48). */
  const strokes = async (tab: Tab, list: readonly number[][]) => {
    const box = await padBox(tab);
    let pen = -1;
    let width = -1;
    for (const [p, w, ...xy] of list) {
      if (p !== pen) await tab.eval(`document.querySelectorAll(".swatches button")[${(pen = p!)}].click(); true`);
      if (w !== width) await tab.eval(`document.querySelectorAll(".sizes button")[${[8, 20, 48].indexOf((width = w!))}].click(); true`);
      const pts: [number, number][] = [];
      for (let i = 0; i < xy.length; i += 2) pts.push([box.x + (xy[i]! / 1000) * box.w, box.y + (xy[i + 1]! / 1000) * box.w]);
      await tab.drag(pts);
    }
  };
  /** Phil draws, `shoot` before he is done (in shots: his prompt's drawing, shot before its last touches). */
  const draw = async (tab: Tab, shoot: () => Promise<void>) => {
    await tab.until(`!!document.querySelector("canvas.pad")`, 30_000);
    if (args.shots) {
      const prompt = String((await phil())["prompt"] ?? "");
      dealt.set("Phil", prompt);
      const all = scene(prompt).strokes;
      const upTo = all.length - LAST_TOUCHES;
      log(`phone: draws "${prompt}"`);
      await strokes(tab, all.slice(0, upTo));
      await shoot();
      await strokes(tab, all.slice(upTo));
      return;
    }
    const box = await padBox(tab);
    const pt = (a: number, b: number): [number, number] => [box.x + a * box.w, box.y + b * box.w];
    await tab.drag(Array.from({ length: 30 }, (_, i) => pt(0.5 + 0.3 * Math.cos((i / 29) * 2 * Math.PI), 0.5 + 0.3 * Math.sin((i / 29) * 2 * Math.PI))));
    await tab.eval(`document.querySelectorAll(".swatches button")[1].click(); true`);
    await tab.drag([pt(0.38, 0.4), pt(0.4, 0.42)]);
    await tab.drag([pt(0.6, 0.4), pt(0.62, 0.42)]);
    await tab.drag(Array.from({ length: 12 }, (_, i) => pt(0.35 + (0.3 * i) / 11, 0.6 + 0.08 * Math.sin((i / 11) * Math.PI))));
    await shoot();
  };
  const tasks = new Set<string>();
  const drivePhone = async () => {
    const t = await phone
      .eval<{ lie: boolean; vote: number; key: string }>(
        `(() => { const i = document.querySelector("form input"); const o = document.querySelectorAll(".options button:not(.chosen)"); const c = document.querySelector(".options .chosen"); return { lie: !!i, vote: c ? 0 : o.length, key: document.querySelector("main")?.innerText.slice(0, 200) ?? "" }; })()`,
      )
      .catch(() => ({ lie: false, vote: 0, key: "" }));
    if (t.lie && !tasks.has(`lie:${t.key}`)) {
      tasks.add(`lie:${t.key}`);
      const artist = args.shots ? String((await phil())["artist"]?.name ?? "") : "";
      const text = args.shots ? lieFor("Phil", artist) : lang === "de" ? "ein verdächtiger Streuselkuchen" : "a suspicious muffin";
      await phone.eval(`(() => { const i = document.querySelector("form input"); i.value = ${JSON.stringify(text)}; i.form.requestSubmit(); return true; })()`);
      log(`phone: lied${args.shots ? ` about ${artist}'s drawing: "${text}"` : ""}`);
    } else if (t.vote > 0 && !tasks.has(`vote:${t.key}`)) {
      tasks.add(`vote:${t.key}`);
      await phone.eval(`(() => { const o = document.querySelectorAll(".options button"); o[0].click(); return true; })()`);
      log(`phone: voted (${t.vote} options)`);
    }
  };
  /**
   * Dropping out (not with --shots): at the first vote a bot's phone goes
   * for 9 s and comes back by name (its token lost, as on another phone):
   * the TV shows the rejoin badge, the host page a Rejoin button; at the
   * first scores Phil's phone forgets everything, reloads and joins with
   * the same name: his seat again.
   */
  const dropped = new Set<string>();
  const rejoinChecks = async (p: string, at: string) => {
    const bot = botList[0];
    if (p === "vote" && bot && !dropped.has("bot")) {
      dropped.add("bot");
      bot.client.drop({ away: 9000, forget: true });
      log(`${bot.name}'s phone dropped out (back by name in 9 s)`);
      await new Promise((r) => setTimeout(r, 6500)); // 4 s away, then the TV's lag
      await tv.screenshot(`${out}/tv-${at}-rejoin.png`);
      const badge = await win.eval<string>(`document.getElementById("preview").contentDocument.querySelector("tvpipe-rejoin")?.shadowRoot.querySelector(".card.on")?.innerText ?? ""`);
      const button = await win.eval<boolean>(`[...document.querySelectorAll("#players button")].some((b) => b.textContent === ${JSON.stringify(lang === "de" ? "Rückkehrcode" : "Rejoin code")})`);
      log(`the TV's rejoin badge: ${JSON.stringify(badge.replace(/\n/g, " / "))}; the host's Rejoin button: ${button}`);
      if (!badge.includes(bot.name) || !button) throw new Error("no rejoin badge on the TV, or no Rejoin button");
      await win.eval(`[...document.querySelectorAll("#players button")].find((b) => b.textContent === ${JSON.stringify(lang === "de" ? "Rückkehrcode" : "Rejoin code")}).click(); true`);
      await win.until(`!!document.querySelector("dialog.tvpipe-rejoin")`);
      await win.screenshot(`${out}/host-${at}-rejoin.png`);
      await win.until(`!document.querySelector("dialog.tvpipe-rejoin") && drawbluff.party.players.find((p) => p.name === ${JSON.stringify(bot.name)}).connected`, 15_000);
      log(`${bot.name} is back by name; the host's dialog closed by itself`);
    }
    if (p === "scores" && !dropped.has("phone")) {
      dropped.add("phone");
      await phone.eval(`localStorage.clear(); location.reload(); true`);
      await phone.until(`!!document.getElementById("name")`);
      await phone.eval(`document.getElementById("name").value = "Phil"; document.querySelector("#join-form button").click(); true`);
      await phone.until(`!document.getElementById("name") && !!document.querySelector("main .card")`);
      const back = await win.eval<boolean>(`drawbluff.party.players.filter((p) => p.name === "Phil").length === 1 && drawbluff.party.players.find((p) => p.name === "Phil").connected`);
      log(`phone: forgot everything, reloaded, joined as Phil again: ${back ? "his seat" : "NOT his seat"}`);
      if (!back) throw new Error("Phil did not get his seat back");
    }
  };
  const seen = new Set<string>();
  let n = 0;
  const deadline = Date.now() + 10 * 60_000;
  while ((await phase()) !== "final") {
    if (Date.now() > deadline) throw new Error("the game took too long");
    const k = await key();
    if (seen.has(k)) {
      await drivePhone();
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    seen.add(k);
    const p = k.split(":")[0]!;
    const at = String(++n).padStart(2, "0");
    if (!args.shots) await rejoinChecks(p, at);
    if (p === "draw") {
      await draw(phone, async () => {
        await shot(`${at}-draw`);
        await pic(phone, "phone-draw", "phone");
      });
      await phone.eval(`document.getElementById("done").click(); true`);
    } else if (p === "lie" || p === "vote" || p === "scores" || p === "gallery") {
      // The phone's input or options first, then its answer.
      await new Promise((r) => setTimeout(r, 400));
      await shot(`${at}-${p}`);
      if (p === "vote" && screen) {
        if (!kept.some((f) => f.startsWith("tv-vote."))) {
          const artist = await win.eval<string>(`drawbluff.party.room.peek().artist?.name ?? ""`);
          log(`the TV's first vote: ${artist}'s "${dealt.get(artist) ?? "?"}"`);
        }
        await pic(screen, "tv-vote", "tv", 4500); // the TV draws the drawing again first (up to 3.5 s)
        if (await phone.eval<boolean>(`document.querySelectorAll(".options button").length > 3`)) await pic(phone, "phone-vote", "phone");
      }
      await drivePhone();
    } else if (p === "reveal") {
      await new Promise((r) => setTimeout(r, 3000));
      await shot(`${at}-reveal`);
    }
  }
  await shot("final");
  const errors = robots.flatMap((b) => b.errors ?? []);
  if (args.shots && kept.length < 3) {
    log(`only these pictures: ${kept.join(", ")}`);
    failed = true;
  }
  log(`game over: ${shots.length} screenshot sets in ${out}; bot errors: ${errors.length ? errors.join(", ") : "none"}; layout problems: ${problems.length || "none"}`);
  if (problems.length > 0) failed = true;
  // The End button: tvpipe ends, everyone is told.
  await win.eval(`document.getElementById("quit").click(); true`);
  const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("still running"), 15_000))]);
  await phone.until(`document.body.innerText.toLowerCase().includes("closed") || document.body.innerText.toLowerCase().includes("over")`, 5000).catch(() => {});
  await phone.screenshot(`${out}/phone-after-end.png`);
  log(`tvpipe exited: ${code}; the phone says: ${(await phone.eval<string>(`document.querySelector("main")?.innerText.slice(0, 80) ?? ""`)).replace(/\n/g, " / ")}`);
  for (const b of robots) b.close();
  if (code !== 0) failed = true;
} catch (err) {
  failed = true;
  log(`FAILED: ${(err as Error).stack ?? String(err)}`);
  writeFileSync(`${out}/tvpipe.log`, tvpipeLog.join("\n"));
} finally {
  browser.close();
  proc.kill();
}
process.exit(failed ? 1 : 0);
