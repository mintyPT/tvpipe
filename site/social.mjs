// Makes the social preview cards (Open Graph images) in site/static/social/.
//
//     node site/social.mjs [NAME ...]
//
// Needs Node 22+ and Google Chrome (CHROME to point elsewhere). Renders each
// card as a page in headless Chrome, with the site's fonts and logo and the
// games' own screenshots, and saves it as a 1200×630 JPEG, which every link
// preview takes (Open Graph, X, iMessage, WhatsApp, Slack, Discord; WhatsApp
// skips images much over 300 KiB, so build.py refuses bigger ones):
//
//   site.jpg           the landing page (and the pages without their own)
//   manual.jpg         the manual
//   games.jpg          /games/
//   join.jpg           join links: tvpipe.party/CODE, /p, /r/, /join
//   games/NAME.jpg     each game of site/static/games.json: /games/NAME/
//                      and its launcher
//
// With NAMEs only those cards (site, manual, games, join or a game's name).
// Re-run it for a game added to the list or when a game's title, players or
// cover change; build.py fails when a listed game has no card.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const outDir = join(here, "static", "social");
const W = 1200, H = 630, QUALITY = 86, MAX = 300 * 1024;
const chromePath = process.env.CHROME || [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].find(existsSync);
if (!chromePath) throw new Error("no Chrome found; set CHROME");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const games = JSON.parse(readFileSync(join(here, "static", "games.json"), "utf8")).games;
// The logo's symbol, as the site's pages have it (colours from CSS variables).
const logo = readFileSync(join(here, "templates", "layout.html"), "utf8").match(/<svg width="0"[\s\S]*?<\/svg>/)[0];
const players = p => (p.min === p.max ? `${p.min} players` : `${p.min}–${p.max} players`);
const cover = g => g.screenshots.find(s => s.kind === "tv") ?? g.screenshots[0];
const phones = g => g.screenshots.filter(s => s.kind === "phone");
const pic = src => `/f/site/${src}`;

// ---------------------------------------------------------------- the cards

const CSS = `
@font-face { font-family: "Sixtyfour"; src: url(/f/crates/tvpipe/src/browser/fonts/sixtyfour.woff2); }
@font-face { font-family: "Michroma"; src: url(/f/crates/tvpipe/src/browser/fonts/michroma.woff2); }
@font-face { font-family: "IBM Plex Sans"; src: url(/f/crates/tvpipe/src/browser/fonts/plex-sans.woff2); font-weight: 300 700; }
* { box-sizing: border-box; }
:root { --bg: #0D1828; --panel: #13223A; --ink: #E8ECF2; --ink-2: rgba(232,236,242,.72); --ink-3: rgba(232,236,242,.46);
  --accent: #E8743B; --logo-ink: #E8ECF2; --logo-screen: #0D1828; }
html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: var(--bg); color: var(--ink);
  font: 400 26px/1.4 "IBM Plex Sans", sans-serif; -webkit-font-smoothing: antialiased; }
body { position: relative; }
/* A faint scanline glow behind everything, like the site's CRT. */
body::before { content: ""; position: absolute; inset: 0;
  background: radial-gradient(900px 520px at 78% 50%, rgba(232,116,59,.16), transparent 70%),
    repeating-linear-gradient(0deg, rgba(255,255,255,.018) 0 2px, transparent 2px 4px); }
.mark { position: absolute; left: 64px; top: 56px; display: flex; align-items: center; gap: 16px; }
.mark svg { width: 58px; height: auto; }
.mark span { font: 26px "Sixtyfour"; font-variation-settings: "SCAN" 60; letter-spacing: -.02em; }
.mark b, .word b { font-weight: 400; color: var(--accent); }
.text { position: absolute; left: 64px; top: 150px; bottom: 64px; display: flex; flex-direction: column; }
h1 { margin: 0; font: 400 64px/1.12 "Michroma"; letter-spacing: -.01em; }
.lbl { font: 400 17px/1.4 "Michroma"; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); margin-bottom: 22px; }
p { margin: 22px 0 0; color: var(--ink-2); }
.foot { margin-top: auto; font: 400 17px/1.4 "Michroma"; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); }
.foot b { color: var(--ink); font-weight: 400; }
.shot { position: absolute; display: block; border-radius: 14px; object-fit: cover;
  box-shadow: 0 0 0 2px rgba(232,236,242,.14), 0 24px 60px rgba(0,0,0,.55); }
.tv { border-radius: 16px; }
.phone { border-radius: 26px; box-shadow: 0 0 0 7px #05090F, 0 0 0 9px rgba(232,236,242,.2), 0 24px 60px rgba(0,0,0,.6); }
`;

function page(body, { title = "card" } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head>
<body>${logo}<div class="mark"><svg viewBox="0 0 560 520"><use href="#logo"/></svg><span>tvpipe<b>.</b>party</span></div>
${body}</body></html>`;
}

/** Fits a game's title on one line: smaller until it is no wider than data-fit. */
const FIT = `(() => {
  for (const h of document.querySelectorAll("h1[data-fit]")) {
    const max = Number(h.dataset.fit);
    let size = parseFloat(getComputedStyle(h).fontSize);
    h.style.width = "max-content";
    while (h.getBoundingClientRect().width > max && size > 20) {
      size -= 2;
      h.style.fontSize = size + "px";
    }
  }
})()`;

// A TV picture 16:9 at x, y with width w; a phone 390:844 at x, y with height h.
const tv = (src, x, y, w, extra = "") =>
  `<img class="shot tv" src="${pic(src)}" style="left:${x}px;top:${y}px;width:${w}px;height:${Math.round(w * 9 / 16)}px;${extra}">`;
const phone = (src, x, y, h, extra = "") =>
  `<img class="shot phone" src="${pic(src)}" style="left:${x}px;top:${y}px;height:${h}px;width:${Math.round(h * 390 / 844)}px;${extra}">`;

function gameCard(g) {
  const c = cover(g), ph = phones(g)[0];
  const langs = (g.languages ?? []).length > 1 ? ` · ${g.languages.length} languages` : "";
  return page(`
<div class="text" style="width:400px">
  <div class="lbl">Party game</div>
  <h1 data-fit="380">${esc(g.title)}</h1>
  <p>${esc(players(g.players))}${langs}<br>Played on everyone's phone</p>
  <div class="foot">Play in the browser<br>or with <b>tvpipe</b></div>
</div>
${tv(c.src, 530, 110, 640)}
${ph ? phone(ph.src, 478, 262, 330) : ""}`, { title: g.title });
}

function siteCard() {
  return page(`
<div class="text" style="width:520px">
  <h1 style="font-size:54px">Video from your computer on the TV</h1>
  <p>Files, cameras, the screen and web pages on Apple TV, Chromecast and in browsers.</p>
  <div class="foot">macOS · Linux · Windows</div>
</div>
${tv("shots/test-pattern.png", 640, 150, 520)}`);
}

function manualCard() {
  return page(`
<div class="text" style="width:520px">
  <div class="lbl">tvpipe</div>
  <h1 style="font-size:60px">Operations Manual</h1>
  <p>Install it, play to the TV, share the screen, host party games, and the Node and Rust libraries.</p>
  <div class="foot">tvpipe.party/manual</div>
</div>
${tv("shots/player-stats.png", 640, 150, 520)}`);
}

function gamesCard() {
  // Six covers in two rows, running off the right edge.
  const shots = games.slice(0, 6).map((g, i) =>
    tv(cover(g).src, 560 + (i % 3) * 300 + (i >= 3 ? 70 : 0), 120 + Math.floor(i / 3) * 196, 280));
  return page(`
<div class="text" style="width:460px">
  <h1 style="font-size:58px">Party games</h1>
  <p>On the TV, played on everyone's phone. Scan the code, type a name, play. Nothing to install.</p>
  <div class="foot">Play in the browser<br>or with <b>tvpipe</b></div>
</div>
${shots.join("\n")}`);
}

function joinCard() {
  // Three games' phones, fanned out.
  const picks = ["drawbluff", "jinx", "krakel"].map(n => games.find(g => g.name === n)).filter(Boolean);
  const fan = picks.map((g, i) => phone(phones(g)[0].src, 700 + i * 140, 96 + Math.abs(i - 1) * 28, 470,
    `transform:rotate(${(i - 1) * 8}deg);z-index:${i === 1 ? 2 : 1}`));
  return page(`
<div class="text" style="width:560px">
  <div class="lbl">You're invited</div>
  <h1 style="font-size:60px">Join the game</h1>
  <p>Open the link on your phone, type a name and play along on the TV.</p>
  <div class="foot">No app, nothing to install</div>
</div>
${fan.join("\n")}`);
}

const cards = new Map([
  ["site", { file: "site.jpg", html: siteCard }],
  ["manual", { file: "manual.jpg", html: manualCard }],
  ["games", { file: "games.jpg", html: gamesCard }],
  ["join", { file: "join.jpg", html: joinCard }],
  ...games.map(g => [g.name, { file: `games/${g.name}.jpg`, html: () => gameCard(g) }]),
]);

// ---------------------------------------------------------------- serving and shooting

const TYPES = { ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/card/")) {
    const card = cards.get(url.pathname.slice(6));
    if (!card) return res.writeHead(404).end();
    return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(card.html());
  }
  if (url.pathname.startsWith("/f/")) {
    const path = normalize(join(repo, decodeURIComponent(url.pathname.slice(3))));
    if (path.startsWith(repo + sep) && existsSync(path)) {
      return res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
    }
  }
  res.writeHead(404).end();
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chromePath, [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "tvpipe-social-"))}`,
  "--hide-scrollbars", "--no-first-run", "--force-color-profile=srgb", "about:blank",
], { stdio: "ignore" });
process.on("exit", () => proc.kill());
let targets = [];
for (let i = 0; i < 100 && !targets.length; i++) {
  try { targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === "page"); }
  catch { await sleep(100); }
}
if (!targets.length) throw new Error("Chrome did not start");
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const [ok, fail] = pending.get(m.id);
    pending.delete(m.id);
    m.error ? fail(new Error(m.error.message)) : ok(m.result);
  }
});
const send = (method, params = {}) => new Promise((ok, fail) => {
  const i = ++id;
  pending.set(i, [ok, fail]);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async expression => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const wanted = process.argv.slice(2);
for (const name of wanted) if (!cards.has(name)) throw new Error(`no card ${name}: ${[...cards.keys()].join(", ")}`);
for (const [name, card] of cards) {
  if (wanted.length && !wanted.includes(name)) continue;
  await send("Page.navigate", { url: `${base}/card/${name}` });
  // Loaded: every picture decoded, every font in.
  for (let i = 0; ; i++) {
    if (await evaluate(`document.readyState === "complete"`)) break;
    if (i > 100) throw new Error(`${name}: the page did not load`);
    await sleep(50);
  }
  const broken = await evaluate(`(async () => { await document.fonts.ready;
    await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
    return [...document.images].filter(i => !i.naturalWidth).map(i => i.getAttribute("src")); })()`);
  if (broken.length) throw new Error(`${name}: missing pictures ${broken.join(", ")}`);
  await evaluate(FIT);
  const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: QUALITY, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  const jpeg = Buffer.from(data, "base64");
  if (jpeg.length > MAX) throw new Error(`${name}: ${Math.round(jpeg.length / 1024)} KiB, at most ${MAX / 1024}`);
  const file = join(outDir, card.file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, jpeg);
  console.log(`wrote site/static/social/${card.file} (${Math.round(jpeg.length / 1024)} KiB)`);
}
process.exit(0);
