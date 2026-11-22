/**
 * A whole party on tvpipe.party in browsers, with no tvpipe (not part of
 * `npm test`; docs/browser-party-design.md). One headless Chrome, a
 * browser context per participant (the host, each phone, each extra
 * screen: storage of their own), WebRTC between them through the room's
 * signaling:
 *
 *   npm run dev                                         # another terminal
 *   node test/live/web-party.ts [BASE] [--only a,b] [--games x,y] [--out DIR] [--relay]
 *
 * BASE defaults to http://localhost:8787 (wrangler dev; use localhost, not
 * 127.0.0.1), DIR to /tmp/tvpipe-web-validate. Scenarios (`--only`, default
 * all): `table` (/games/ → Play now → launcher → This screen → host page in table
 * mode, 4 phones join over WebRTC, the VIP starts, rounds are played),
 * `games` (every game of /g/index.json through lobby, start and its first
 * round; `--games` picks some), `full` (jinx and drawbluff to the end, or
 * the `--games`),
 * `switch` (Other game through /games/?switch in the dialog: phones follow with their names), `reload` (the
 * host reloads, phones come back), `phone` (a phone reloads, one goes
 * offline and back), `screen` (an extra screen at /tv, approved; after
 * Other game it is back without asking), `window` (A second window,
 * Change screen), `quit` (End), `short` (BASE/CODE), `burst` (12 phones
 * at once), `looks` (/games/ and the launcher on desktop, iPad, phone, also
 * with the tvpipe app's row picked).
 *
 * Phones join through their page (the name form, the VIP's Start); their
 * moves in the game are the game's own bot (`game/bots.js`) driving the
 * phone page's own `PartyClient`, so every move goes over the phone's data
 * channel and the phone's page shows what follows. Exits 1 when a check
 * failed; every page's console errors are reported. `DBG_PC=1` logs the
 * host's peer connection states around a phone closing its page.
 *
 * `--relay` forces every page's peer connections to TURN only
 * (`iceTransportPolicy: "relay"`, the constructor wrapped before any page
 * script runs) and checks with getStats that each phone's and the host's
 * selected candidate pair is a relay one (logged: protocol, TURN server).
 * Without TURN servers from `/api/turn` (local dev without the secrets)
 * it stops at once with that.
 *
 * `--local-lib` serves the library (`/_tvpipe/lib/`) and `/r/`'s script
 * from this checkout's build (`npm run build:web`) to pages of BASE: a
 * library change against production's signaling and TURN before it is
 * deployed.
 *
 * Not reachable here: DevTools' offline mode does not reach WebRTC (a
 * locked phone is a frozen page instead), real NAT and TURN, Safari.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Tab } from "../../../../games/drawbluff/test/live/browser.ts";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const valued = new Set(["--only", "--games", "--out", "--phones"]);
/** `DBG_JOIN=1`: each party's joins as a timeline of the host's and the phones' fetches, sockets and ICE. */
const TIMELINE = !!process.env["DBG_JOIN"];
/** `--relay`: every peer connection TURN only (iceTransportPolicy "relay"), checked with getStats. */
const RELAY = args.includes("--relay");
const BASE = (args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? "")) ?? "http://localhost:8787").replace(/\/$/, "");
const OUT = opt("out") ?? "/tmp/tvpipe-web-validate";
const ONLY = opt("only")?.split(",");
const GAMES = opt("games")?.split(",");
const PHONES = Number(opt("phones") ?? 4);
mkdirSync(OUT, { recursive: true });

const CHROME = process.env["CHROME"] ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const DESK = { width: 1280, height: 800 };
const PAD = { width: 1024, height: 1366, mobile: true };
const PHONE = { width: 390, height: 844, mobile: true };
const TV = { width: 1280, height: 720 };
const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const NAMES = ["Ann", "Bob", "Cleo", "Dan", "Eve", "Finn", "Gia", "Hugo", "Ida", "Jon", "Kai", "Lou"];

const t0 = Date.now();
const log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(7)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Chrome with browser contexts

class Chrome {
  readonly #proc: ChildProcess;
  readonly #dir: string;
  readonly port: number;
  readonly #root: Tab;

  private constructor(proc: ChildProcess, dir: string, port: number, root: Tab) {
    this.#proc = proc;
    this.#dir = dir;
    this.port = port;
    this.#root = root;
  }

  static async launch(): Promise<Chrome> {
    const dir = mkdtempSync(join(tmpdir(), "tvpipe-web-chrome-"));
    const proc = spawn(
      CHROME,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${dir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    process.on("exit", () => proc.kill());
    const end = Date.now() + 15000;
    for (;;) {
      try {
        const port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]);
        if (port > 0) {
          const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
          const ws = new WebSocket(v.webSocketDebuggerUrl);
          await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
          return new Chrome(proc, dir, port, new Tab(ws));
        }
      } catch {}
      if (Date.now() > end) throw new Error("Chrome did not start");
      await sleep(100);
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.#root.send(method, params);
  }

  async context(name: string): Promise<Ctx> {
    const { browserContextId } = await this.send("Target.createBrowserContext", { disposeOnDetach: true });
    return new Ctx(this, browserContextId, name);
  }

  /** A tab of a target (a popup the page opened). */
  async attach(targetId: string, name: string): Promise<Page> {
    const list = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()) as { id: string; webSocketDebuggerUrl: string }[];
    const t = list.find((x) => x.id === targetId);
    if (!t) throw new Error(`no target ${targetId}`);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    const tab = new Tab(ws);
    await tab.send("Page.enable");
    await tab.watch();
    return new Page(tab, name, targetId);
  }

  async targets(): Promise<{ targetId: string; url: string; type: string; browserContextId?: string; openerId?: string }[]> {
    return (await this.send("Target.getTargets")).targetInfos;
  }

  close(): void {
    this.#root.close();
    this.#proc.kill();
    setTimeout(() => rmSync(this.#dir, { recursive: true, force: true }), 1000);
  }
}

/** All pages opened, for the console errors. */
const pages: Page[] = [];

class Page {
  readonly tab: Tab;
  readonly name: string;
  readonly targetId: string;
  /** Errors reported so far (moved out of `tab.errors`). */
  readonly errors: string[] = [];
  constructor(tab: Tab, name: string, targetId: string) {
    this.tab = tab;
    this.name = name;
    this.targetId = targetId;
    pages.push(this);
    // Dialogs (confirm "another game while one runs?"): yes.
    tab.on("Page.javascriptDialogOpening", () => void tab.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}));
  }
  eval<T = unknown>(expr: string): Promise<T> {
    return this.tab.eval<T>(expr);
  }
  until(expr: string, ms = 15000): Promise<void> {
    return this.tab.until(expr, ms);
  }
  async go(url: string): Promise<void> {
    await this.tab.send("Page.navigate", { url });
  }
  async shot(name: string): Promise<string> {
    const path = join(OUT, `${name}.png`);
    await this.tab.screenshot(path).catch(() => {});
    return path;
  }
  async close(): Promise<void> {
    this.collect();
    await this.tab.send("Page.close").catch(() => {});
    this.tab.close();
  }
  collect(): string[] {
    const e = this.tab.errors.splice(0);
    this.errors.push(...e);
    return e;
  }
}

class Ctx {
  readonly chrome: Chrome;
  readonly id: string;
  readonly name: string;
  constructor(chrome: Chrome, id: string, name: string) {
    this.chrome = chrome;
    this.id = id;
    this.name = name;
  }
  async open(url: string, view: { width: number; height: number; mobile?: boolean }, o: { ua?: string; hook?: boolean; name?: string } = {}): Promise<Page> {
    const { targetId } = await this.chrome.send("Target.createTarget", { url: "about:blank", browserContextId: this.id, newWindow: true });
    const page = await this.chrome.attach(targetId, o.name ?? this.name);
    const tab = page.tab;
    await tab.send("Emulation.setDeviceMetricsOverride", { width: view.width, height: view.height, deviceScaleFactor: view.mobile ? 2 : 1, mobile: view.mobile ?? false });
    if (view.mobile) await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    if (o.ua) await tab.send("Emulation.setUserAgentOverride", { userAgent: o.ua, platform: o.ua.includes("iPhone") ? "iPhone" : "MacIntel" });
    if (o.hook) await hookClients(tab);
    else if (LOCAL_LIB) await intercept(tab, false);
    if (RELAY) await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: RELAY_ONLY });
    if (TIMELINE) await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: TIMELINE_HOOK });
    if (url !== "about:blank") await page.go(url);
    return page;
  }
  async dispose(): Promise<void> {
    for (const p of pages.filter((p) => p.name.startsWith(this.name))) p.collect();
    await this.chrome.send("Target.disposeBrowserContext", { browserContextId: this.id }).catch(() => {});
  }
}

/**
 * The phone page's `PartyClient`s, for the checks and the bot that plays
 * on them: `globalThis.__tvp` = `{clients, listeners, acts}`, from a line
 * added to `/_tvpipe/lib/client.js` as it loads (the DevTools Fetch
 * domain; the page is otherwise as served).
 */
async function hookClients(tab: Tab): Promise<void> {
  await intercept(tab, true);
}

/** `--local-lib`: the library and `/r/`'s script from this checkout's `site/_out` (built), BASE's for everything else. */
const LOCAL_LIB = args.includes("--local-lib");
const SITE = new URL("../../../../site/_out/", import.meta.url);
const CLIENT_HOOK = `
;{ const reg = (globalThis.__tvp ??= { clients: [], listeners: [], acts: { ok: 0, refused: [] } });
  const on = PartyClient.prototype.on;
  PartyClient.prototype.on = function (ev, fn) { if (!reg.clients.includes(this)) reg.clients.push(this); reg.listeners.push([this, ev, fn]); return on.call(this, ev, fn); };
  const act = PartyClient.prototype.act;
  PartyClient.prototype.act = function (type, data) { const p = act.call(this, type, data); p.then(() => reg.acts.ok++, (e) => reg.acts.refused.push(type + ":" + (e && e.code))); return p; };
}`;

/** The page's requests for the library: `hook` adds the client hook to client.js; `--local-lib` serves the local build. */
async function intercept(tab: Tab, hook: boolean): Promise<void> {
  type Paused = { requestId: string; request: { url: string }; responseStatusCode?: number; responseHeaders?: { name: string; value: string }[] };
  tab.on("Fetch.requestPaused", (p: Paused) => {
    void (async () => {
      const path = new URL(p.request.url).pathname;
      const addHook = hook && path === "/_tvpipe/lib/client.js";
      let text: string;
      let headers: { name: string; value: string }[];
      if (LOCAL_LIB) {
        text = readFileSync(new URL(path.slice(1), SITE), "utf8");
        headers = [{ name: "Content-Type", value: "text/javascript; charset=utf-8" }, { name: "Cache-Control", value: "no-store" }];
      } else {
        if (p.responseStatusCode !== 200) return void (await tab.send("Fetch.continueRequest", { requestId: p.requestId }));
        const body = (await tab.send("Fetch.getResponseBody", { requestId: p.requestId })) as { body: string; base64Encoded: boolean };
        text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
        headers = (p.responseHeaders ?? []).filter((h) => !/^(content-(length|encoding)|etag)$/i.test(h.name));
      }
      await tab.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: headers, body: Buffer.from(text + (addHook ? CLIENT_HOOK : "")).toString("base64") });
    })().catch(() => void tab.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {}));
  });
  const patterns = LOCAL_LIB
    ? [{ urlPattern: "*/_tvpipe/lib/*.js*", requestStage: "Request" }, { urlPattern: "*/r/join.js*", requestStage: "Request" }]
    : [{ urlPattern: "*/_tvpipe/lib/client.js*", requestStage: "Response" }];
  await tab.send("Fetch.enable", { patterns });
  await tab.send("Network.enable");
  await tab.send("Network.setCacheDisabled", { cacheDisabled: true });
  // The service worker (/games/ registers it) would fetch past the interception.
  if (LOCAL_LIB) await tab.send("Network.setBypassServiceWorker", { bypass: true });
}

/**
 * `--relay`: the page's `RTCPeerConnection` with `iceTransportPolicy:
 * "relay"` (TURN only), the connections in `globalThis.__relayPcs`.
 */
const RELAY_ONLY = `{
  const P = globalThis.RTCPeerConnection;
  if (P && !P.__relayOnly) {
    const pcs = (globalThis.__relayPcs = []);
    const R = function RTCPeerConnection(config, ...rest) {
      const pc = new P({ ...(config ?? {}), iceTransportPolicy: "relay" }, ...rest);
      pcs.push(pc);
      return pc;
    };
    R.prototype = P.prototype;
    Object.setPrototypeOf(R, P);
    R.__relayOnly = true;
    globalThis.RTCPeerConnection = R;
  }
}`;

/** `DBG_JOIN`: the page's fetches, WebSockets and peer connections into `globalThis.__t` ([epoch ms, what]). */
const TIMELINE_HOOK = `{
  const T = (globalThis.__t = []);
  const mark = (m) => T.push([Math.round(performance.timeOrigin + performance.now()), m]);
  mark("page " + location.pathname);
  const P = globalThis.RTCPeerConnection;
  if (P) {
    const R = function RTCPeerConnection(c, ...r) {
      const pc = new P(c, ...r);
      const id = (globalThis.__pcn = (globalThis.__pcn ?? 0) + 1);
      mark("pc" + id + " new (" + (c?.iceServers ?? []).length + " servers)");
      pc.addEventListener("icegatheringstatechange", () => mark("pc" + id + " gathering " + pc.iceGatheringState));
      pc.addEventListener("icecandidate", (e) => mark("pc" + id + " candidate " + (e.candidate ? e.candidate.type + " " + e.candidate.protocol + " " + (e.candidate.url ?? "") : "(end)")));
      pc.addEventListener("connectionstatechange", () => mark("pc" + id + " " + pc.connectionState));
      return pc;
    };
    R.prototype = P.prototype;
    Object.setPrototypeOf(R, P);
    globalThis.RTCPeerConnection = R;
  }
  const W = globalThis.WebSocket;
  const S = function WebSocket(u, p) {
    const ws = p === undefined ? new W(u) : new W(u, p);
    const at = String(u).replace(/^.*\\/api/, "/api").replace(/\\?.*/, "");
    mark("ws " + at);
    ws.addEventListener("open", () => mark("ws open " + at));
    ws.addEventListener("message", (e) => mark("ws message " + at + " " + String(e.data).slice(0, 40)));
    ws.addEventListener("close", (e) => mark("ws close " + at + " " + e.code));
    return ws;
  };
  S.prototype = W.prototype;
  Object.setPrototypeOf(S, W);
  globalThis.WebSocket = S;
  const F = globalThis.fetch;
  globalThis.fetch = function (u, ...r) {
    const at = String(u?.url ?? u).replace(/^https?:\\/\\/[^/]+/, "");
    mark("fetch " + at);
    return F.call(this, u, ...r).then((x) => (mark("fetched " + at + " " + x.status), x));
  };
}`;

/** `DBG_JOIN`: the host's and a phone's timeline from `from` on (ms after it). */
async function timeline(h: Host, p: Phone, from: number): Promise<void> {
  const get = (page: Page) => page.eval<[number, string][]>(`globalThis.__t ?? []`).catch(() => [] as [number, string][]);
  const rows = [...(await get(h.page)).map(([t, m]) => [t, "host ", m] as const), ...(await get(p.page)).map(([t, m]) => [t, p.name.padEnd(5), m] as const)]
    .filter(([t]) => t >= from)
    .sort((a, b) => a[0] - b[0]);
  log(`${p.name}'s join:`);
  for (const [t, who, m] of rows.slice(0, 80)) console.log(`        +${String(t - from).padStart(5)} ${who} ${m}`);
}

/** The selected candidate pairs of the page's connected peer connections (`--relay`). */
const SELECTED_PAIRS = `(async () => {
  const out = [];
  for (const pc of globalThis.__relayPcs ?? []) {
    if (pc.connectionState !== "connected") continue;
    const st = await pc.getStats();
    let pair;
    st.forEach((r) => { if (r.type === "transport" && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId); });
    if (!pair) st.forEach((r) => { if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r; });
    if (!pair) { out.push({ local: "none" }); continue; }
    const l = st.get(pair.localCandidateId) ?? {};
    const r = st.get(pair.remoteCandidateId) ?? {};
    out.push({ local: l.candidateType, remote: r.candidateType, proto: l.relayProtocol ?? l.protocol, url: l.url ?? "", rtt: pair.currentRoundTripTime ?? null });
  }
  return out;
})()`;

interface Pair {
  local: string;
  remote?: string;
  proto?: string;
  url?: string;
  rtt?: number | null;
}

/** `--relay`: every phone's (and the host's) connected peer connections go through TURN. */
async function checkRelay(h: Host, phones: Phone[]): Promise<void> {
  const show = (p: Pair) => `${p.local}→${p.remote ?? "?"} ${p.proto ?? ""} ${p.url ?? ""}${p.rtt != null ? ` rtt ${Math.round(p.rtt * 1000)} ms` : ""}`.trim();
  for (const p of phones) {
    const pairs = await p.page.eval<Pair[]>(SELECTED_PAIRS).catch(() => [] as Pair[]);
    check(pairs.length > 0 && pairs.every((x) => x.local === "relay"), `${p.name}: through TURN: ${pairs.map(show).join("; ") || "no connected peer connection"}`);
  }
  const host = await h.page.eval<Pair[]>(SELECTED_PAIRS).catch(() => [] as Pair[]);
  check(host.length >= phones.length && host.every((x) => x.local === "relay"), `host: ${host.length} connections through TURN: ${[...new Set(host.map(show))].join("; ")}`);
}

// ---------------------------------------------------------------------------
// Checks

let failures = 0;
function check(ok: boolean, what: string): boolean {
  log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
  return ok;
}
async function step<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    check(false, `${what}: ${(err as Error).message.slice(0, 400)}`);
    return undefined;
  }
}

interface WebGame {
  name: string;
  title: string;
  release: string;
  players: { min: number; max: number };
  pages: { host: string; tv: string; phone: string };
}
const index = (await (await fetch(`${BASE}/g/index.json`)).json()) as { games: WebGame[] };
const gameOf = (name: string) => {
  const g = index.games.find((x) => x.name === name);
  if (!g) throw new Error(`${name} is not on ${BASE}/g/index.json`);
  return g;
};

// ---------------------------------------------------------------------------
// The host

interface Host {
  ctx: Ctx;
  page: Page;
  game: WebGame;
  code: string;
  join: string;
}

/** The host page's global of the running game (`jinx`, `drawbluff`, …). */
const G = (h: Host) => h.game.name;

/** /games/ → Play now → the launcher → `screen` → Start → the host page. */
async function startHost(ctx: Ctx, game: WebGame, screen: "this" | "window" | "none" = "this", o: { bots?: boolean; view?: typeof DESK; ua?: string } = {}): Promise<Host> {
  const page = await ctx.open("about:blank", o.view ?? DESK, { ua: o.ua, name: `${ctx.name}` });
  if (process.env["DBG_PC"])
    await page.tab.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `{ const P = RTCPeerConnection; globalThis.__pcs = []; globalThis.RTCPeerConnection = class extends P { constructor(...a) { super(...a); const rec = { pc: this, log: [] }; globalThis.__pcs.push(rec); this.addEventListener("connectionstatechange", () => rec.log.push([Date.now(), "conn:" + this.connectionState])); this.addEventListener("iceconnectionstatechange", () => rec.log.push([Date.now(), "ice:" + this.iceConnectionState])); } }; }`,
    });
  await page.go(`${BASE}/games/${o.bots ? "?bots" : ""}`);
  await page.until(`!!document.querySelector('a[data-play="${game.name}"]')`);
  await page.eval(`document.querySelector('a[data-play="${game.name}"]').click(); true`);
  await page.until(`location.pathname === "/_tvpipe/launcher/" && document.querySelectorAll("#devices .device").length > 1 && document.getElementById("web-title").textContent === ${JSON.stringify(game.title)}`);
  const offered = await page.eval<string[]>(`[...document.querySelectorAll("#devices .device")].map((d) => d.dataset.name ?? "off")`);
  log(`${ctx.name}: launcher offers ${offered.join(", ")}`);
  await page.eval(`document.querySelector('#devices .device[data-name="${screen}"]').click(); true`);
  await page.until(`document.querySelector('#devices .device[data-name="${screen}"]').classList.contains("selected") && !document.getElementById("start").disabled`);
  await page.eval(`document.getElementById("start").click(); true`);
  await page.until(`location.pathname === ${JSON.stringify(game.pages.host)} && !!globalThis.${game.name}?.party`, 30_000);
  const h = await hostInfo(page, game);
  // Phones scan once the QR code is up and the room answers (the host's signaling is a moment behind the page).
  const t = Date.now();
  for (;;) {
    const r = await fetch(`${BASE}/api/rooms/${h.code}`).catch(() => null);
    const room = r?.ok ? ((await r.json()) as { host?: boolean; game?: unknown }) : null;
    if (room?.host && room.game) break;
    if (Date.now() - t > 20_000) throw new Error(`room ${h.code}: no host after 20 s`);
    await sleep(200);
  }
  return { ctx, page, game, ...h };
}

async function hostInfo(page: Page, game: WebGame): Promise<{ code: string; join: string }> {
  await page.until(`!!globalThis.${game.name}?.party?.joinInfo?.url`, 20_000);
  return page.eval<{ code: string; join: string }>(`({ code: ${game.name}.party.code, join: ${game.name}.party.joinInfo.url })`);
}

/** The TV page in the host's tab (table mode), as text. */
const tableTv = `(() => { const f = document.querySelector(".tvpipe-table iframe"); return f?.contentDocument?.body?.innerText ?? ""; })()`;
/** Whether a page's text shows `name` (TV pages set names in capitals with CSS: innerText has them so). */
const shows = (text: string, name: string) => text.toLowerCase().includes(name.toLowerCase());
/** What the TV page shows (its text and the phases it marks), to tell its screens apart. */
const tableTvKey = `(() => { const d = document.querySelector(".tvpipe-table iframe")?.contentDocument; if (!d?.body) return ""; return [...d.querySelectorAll("[data-phase]")].map((e) => e.dataset.phase).join(",") + "|" + d.body.innerText.replace(/\\s+/g, " "); })()`;

// ---------------------------------------------------------------------------
// Phones

interface Phone {
  ctx: Ctx;
  page: Page;
  name: string;
  joinedMs?: number;
}

/** A phone opens the join link (the QR code's), joins with `name`; resolves once the host lists it. */
async function joinPhone(chrome: Chrome, h: Host, name: string, o: { wait?: boolean } = {}): Promise<Phone> {
  const ctx = await chrome.context(`phone-${name}`);
  const t = Date.now();
  if (TIMELINE) await h.page.eval(`(globalThis.__t ??= []).push([Date.now(), "phone ${name} opens the link"]), true`);
  const page = await ctx.open(h.join, PHONE, { ua: IPHONE_UA, hook: true });
  const phone: Phone = { ctx, page, name };
  if (o.wait === false) return phone;
  await fillName(phone, h);
  phone.joinedMs = Date.now() - t;
  if (TIMELINE) await timeline(h, phone, t);
  return phone;
}

async function fillName(phone: Phone, h: Host, ms = 30_000): Promise<void> {
  await phone.page.until(`location.pathname === ${JSON.stringify(h.game.pages.phone)} && !!document.getElementById("name")`, ms);
  await phone.page.eval(
    `(() => { const i = document.getElementById("name"); i.value = ${JSON.stringify(phone.name)}; i.dispatchEvent(new Event("input", { bubbles: true })); const f = i.closest("form"); (f.querySelector("button[type=submit], button") ?? f).click(); if (!f.querySelector("button")) f.requestSubmit(); return true; })()`,
  );
  await h.page.until(`${G(h)}.party.players.some((p) => p.name === ${JSON.stringify(phone.name)} && p.connected)`, ms);
}

/** What the phone's client says (the hook's `__tvp`). */
function phoneState(p: Phone): Promise<{ status: string; url: string; bye: string | null; you: string | null; acts: number; refused: string[]; text: string }> {
  return p.page.eval(`(() => { const r = globalThis.__tvp; const c = r?.clients.find((c) => c.role === "player"); return { status: c?.status ?? "none", url: c?.url ?? "", bye: c?.byeReason ?? null, you: c?.you?.name ?? null, acts: r?.acts.ok ?? 0, refused: r?.acts.refused ?? [], text: document.body.innerText.replace(/\\s+/g, " ").slice(0, 160) }; })()`);
}

/**
 * The game's bot plays on the phone page's own client (its seat, its data
 * channel): its view listeners go onto the phone's client, its moves out
 * of it.
 */
async function botOnPhone(p: Phone, game: WebGame): Promise<void> {
  const base = `/g/${game.name}/${game.release}/`;
  await p.page.eval(`(async () => {
    const r = globalThis.__tvp;
    const phone = r.clients.find((c) => c.role === "player");
    if (!phone) throw new Error("no player client");
    const m = await import(${JSON.stringify(base + "game/bots.js")});
    const extra = {};
    if (${JSON.stringify(game.name)} === "landgrab") {
      const w = await import(${JSON.stringify(base + "game/world.js")});
      extra.world = w.parseWorld(await (await fetch(${JSON.stringify(base + "data/world.txt")})).text());
    }
    const before = r.listeners.length;
    const bot = new m.Bot({ url: "ws://unused.invalid/", WebSocket: function () { throw new Error("unused"); }, room: phone.room, key: phone.key, name: phone.you?.name ?? "x", think: () => 300 + Math.random() * 900, ...extra });
    const mine = r.listeners.slice(before).filter(([c]) => c === bot.client);
    const dummy = bot.client;
    Object.defineProperty(bot, "client", { value: phone, configurable: true, writable: true });
    for (const [, ev, fn] of mine) {
      phone.on(ev, fn);
      if (ev === "view" && phone.view) fn(phone.view);
    }
    dummy.close?.();
    r.bot = bot;
    return true;
  })()`);
}

/** The VIP's phone starts (its Start button). */
async function vipStarts(p: Phone): Promise<void> {
  const button = `[...document.querySelectorAll("#start, #dock button.primary, button.primary")].find((b) => b.offsetParent !== null && !b.disabled && /start|everybody|everyone|go|los|play/i.test(b.textContent))`;
  await p.page.until(`!!${button}`, 20_000);
  const label = await p.page.eval<string>(`${button}.textContent`);
  await p.page.eval(`${button}.click(); true`);
  log(`${p.name} (VIP) taps "${label.trim()}"`);
}

async function closePhone(p: Phone): Promise<void> {
  p.page.collect();
  await p.ctx.dispose();
}

// ---------------------------------------------------------------------------
// Playing

/** The host's game as the checks see it. */
async function hostState(h: Host): Promise<{ phase: string; round: unknown; running: boolean; players: { name: string; connected: boolean }[] }> {
  return h.page.eval(
    `(() => { const g = ${G(h)}; const s = g.party.screen.peek(); const r = g.party.room.peek(); return { phase: String(s.phase ?? r.phase ?? "?"), round: s.round ?? r.round ?? null, running: !!g.game.running, players: g.party.players.map((p) => ({ name: p.name, connected: p.connected })) }; })()`,
  );
}

/** Settings for a quick game: one round, fast timers where the game has them. */
async function quickSettings(h: Host): Promise<void> {
  const name = G(h);
  await h.page.eval(`(() => {
    const g = ${name};
    const tryset = (k, v) => { try { g.page.set(k, v); } catch {} };
    if (${JSON.stringify(name)} === "jinx") { tryset("rounds", 1); tryset("write", 30); }
    else if (${JSON.stringify(name)} === "drawbluff") { tryset("rounds", 1); tryset("timers", "fast"); }
    else if (${JSON.stringify(name)} === "garble") { tryset("timers", "fast"); }
    else if (g.FAST_TIMINGS && g.game.configure) {
      if (${JSON.stringify(name)} === "busted") tryset("rounds", 6); try { g.game.configure({ timings: g.FAST_TIMINGS }); } catch {} }
    return true;
  })()`);
}

/**
 * Starts the game from the VIP's phone with bots on every phone and
 * plays until `until`: `round` (the phases moved on at least three times
 * with moves from every phone), or `end` (the game is over).
 */
async function play(h: Host, phones: Phone[], until: "round" | "end", maxMs: number): Promise<boolean> {
  await quickSettings(h);
  for (const p of phones) await botOnPhone(p, h.game);
  const lobbyText = await Promise.all(phones.map((p) => phoneState(p).then((s) => s.text)));
  await vipStarts(phones[0]!);
  const phases: string[] = [];
  const end = Date.now() + maxMs;
  let started = false;
  let done = false;
  let firstRound: string | undefined;
  let tvTexts = new Set<string>();
  while (Date.now() < end) {
    const s = await hostState(h);
    if (s.running) started = true;
    const tag = `${s.phase}${s.round !== null ? `#${JSON.stringify(s.round)}` : ""}`;
    if (phases.at(-1) !== tag) {
      phases.push(tag);
      log(`${h.game.name}: ${tag}`);
      tvTexts.add(await h.page.eval<string>(tableTvKey).catch(() => ""));
    }
    const acts = await Promise.all(phones.map((p) => phoneState(p).then((x) => x.acts)));
    // The first round is over when the round counter moves on (or, for games without one, after 5 phases), or the game ends.
    if (s.running && firstRound === undefined && s.round !== null && s.round !== 0) firstRound = JSON.stringify(s.round);
    const nextRound = firstRound !== undefined && s.round !== null && JSON.stringify(s.round) !== firstRound;
    const over = nextRound || (s.round === null && new Set(phases.slice(1)).size >= 5) || (started && !s.running);
    if (until === "round" && started && over && acts.every((a) => a >= 1)) {
      done = true;
      break;
    }
    if (until === "end" && started && (!s.running || /^(end|over|final|podium)/i.test(s.phase)) && phases.length > 3) {
      done = true;
      break;
    }
    await sleep(400);
  }
  const states = await Promise.all(phones.map((p) => phoneState(p)));
  const moved = states.filter((s, i) => s.text !== lobbyText[i]).length;
  const refused = states.flatMap((s) => s.refused);
  const acts = states.map((s) => s.acts);
  check(started, `${h.game.name}: the VIP's Start started the game`);
  check(done, `${h.game.name}: ${until === "end" ? "played to the end" : "played the first round"} (phases ${phases.join(" → ")})`);
  check(acts.every((a) => a >= 1), `${h.game.name}: every phone's moves accepted over its data channel (${acts.join(", ")} acts${refused.length ? `; refused: ${refused.join(", ")}` : ""})`);
  check(moved === phones.length, `${h.game.name}: every phone's page moved on from the lobby (${moved}/${phones.length})`);
  check(tvTexts.size >= 2, `${h.game.name}: the TV (table mode) showed ${tvTexts.size} different screens`);
  for (const p of phones) await p.page.eval(`(() => { globalThis.__tvp.bot?.close?.(); return true; })()`).catch(() => {});
  return done;
}

// ---------------------------------------------------------------------------
// Scenarios

if (RELAY) {
  const turn = (await (await fetch(`${BASE}/api/turn`)).json()) as { iceServers?: { urls: string | string[] }[] };
  const urls = (turn.iceServers ?? []).flatMap((x) => (Array.isArray(x.urls) ? x.urls : [x.urls]));
  const relays = urls.filter((u) => /^turns?:/.test(u));
  if (relays.length === 0) {
    log(`FAIL --relay: ${BASE}/api/turn gives no TURN server (${urls.join(", ") || "none"}): nothing to relay through`);
    process.exit(1);
  }
  log(`--relay: TURN servers from /api/turn: ${relays.join(", ")}`);
}

const chrome = await Chrome.launch();
const want = (s: string) => !ONLY || ONLY.includes(s);

async function party(game: WebGame, n: number, o: { bots?: boolean; screen?: "this" | "window" | "none" } = {}): Promise<{ h: Host; phones: Phone[] }> {
  const ctx = await chrome.context(`host-${game.name}`);
  const h = await startHost(ctx, game, o.screen ?? "this", o);
  log(`${game.name}: room ${h.code}, join link ${h.join.replace(/#.*/, "#k=…")}`);
  const phones: Phone[] = [];
  for (let i = 0; i < n; i++) {
    const p = await joinPhone(chrome, h, NAMES[i]!);
    phones.push(p);
    log(`${p.name} joined in ${p.joinedMs} ms (link opened → the host lists them)`);
  }
  if (RELAY) await checkRelay(h, phones);
  return { h, phones };
}

async function endParty(h: Host, phones: Phone[]): Promise<void> {
  for (const p of phones) await closePhone(p);
  h.page.collect();
  await h.ctx.dispose();
}

/** Scenario 1: table mode, 4 phones, the first rounds. */
async function scenarioTable(): Promise<void> {
  log("== table: /games/ → Play now jinx → This screen → table mode, 4 phones over WebRTC");
  const game = gameOf("jinx");
  const { h, phones } = await party(game, PHONES);
  const p = h.page;
  check(await p.eval<boolean>(`!!document.querySelector(".tvpipe-table iframe") && getComputedStyle(document.querySelector(".tvpipe-table")).visibility !== "hidden"`), "table mode: the TV page covers the host page");
  await p.shot("table-tv");
  await p.eval(`document.querySelector('.tvpipe-table button[aria-label^="The room"]').click(); true`);
  await sleep(300);
  const shown = await p.eval<{ hidden: boolean; back: boolean; players: string }>(`({ hidden: getComputedStyle(document.querySelector(".tvpipe-table")).visibility === "hidden", back: [...document.querySelectorAll("button")].some((b) => b.textContent === "Back to the game" && !b.hidden), players: document.getElementById("players")?.innerText ?? "" })`);
  check(shown.hidden && shown.back, "⋯ shows the host page with Back to the game");
  check(NAMES.slice(0, PHONES).every((n) => shown.players.includes(n)), `the host page lists the phones: ${shown.players.replace(/\s+/g, " ").slice(0, 120)}`);
  await p.shot("table-host");
  await p.eval(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Back to the game").click(); true`);
  await sleep(300);
  check(await p.eval<boolean>(`getComputedStyle(document.querySelector(".tvpipe-table")).visibility !== "hidden"`), "Back returns to the game");
  const tv = await p.eval<string>(tableTv);
  check(NAMES.slice(0, PHONES).every((n) => shows(tv, n)), `the TV shows the phones' names: ${tv.replace(/\s+/g, " ").slice(0, 120)}`);
  const via = await Promise.all(phones.map((x) => phoneState(x)));
  check(via.every((s) => /\/api\/rooms\/[A-Z]+\/join/.test(s.url) && s.status === "open"), `phones are on data channels through the room's signaling (${via.map((s) => s.url.replace(/^.*\/api/, "/api").replace(/\?.*/, "")).join(", ")})`);
  await phones[0]!.page.shot("table-phone-lobby");
  await play(h, phones, "round", 150_000);
  await p.shot("table-tv-playing");
  await phones[0]!.page.shot("table-phone-playing");
  await endParty(h, phones);
}

/** Scenario 2: every game, lobby + start + first round; `full`: to the end. */
async function scenarioGames(names: string[], until: "round" | "end"): Promise<void> {
  for (const name of names) {
    log(`== ${until === "end" ? "full" : "games"}: ${name}`);
    await step(name, async () => {
      const game = gameOf(name);
      const n = Math.max(PHONES, game.players.min);
      const { h, phones } = await party(game, n);
      const tv = await h.page.eval<string>(tableTv);
      check(phones.every((p) => shows(tv, p.name)), `${name}: the TV lists the phones`);
      await play(h, phones, until, until === "end" ? 420_000 : 180_000);
      await h.page.shot(`${name}-${until}-tv`);
      await phones[0]!.page.shot(`${name}-${until}-phone`);
      await endParty(h, phones);
    });
  }
}

/** Opens the games list over the host page (/games/?switch) and picks `next`. */
async function otherGame(h: Host, next: WebGame): Promise<Host> {
  await h.page.eval(`(() => { document.querySelector('.tvpipe-table button[aria-label^="The room"]')?.click(); document.getElementById("other-game").click(); return true; })()`);
  const doc = `document.querySelector("dialog.tvpipe-game-picker iframe")?.contentDocument`;
  await h.page.until(`(() => { const d = ${doc}; return !!d?.querySelector('a[data-play="${next.name}"]') && !!d.querySelector("#${h.game.name} .now"); })()`, 15_000);
  const dialog = await h.page.eval<{ src: string; top: string; playing: string[] }>(
    `(() => { const d = ${doc}; return { src: document.querySelector("dialog.tvpipe-game-picker iframe").getAttribute("src"), top: getComputedStyle(d.querySelector("header.top")).display, playing: [...d.querySelectorAll("article.gm .now")].map((n) => n.closest("article").id) }; })()`,
  );
  check(
    dialog.src === `/games/?switch&current=${h.game.name}` && dialog.top === "none" && dialog.playing.join() === h.game.name,
    `Other game: /games/ in the dialog (${dialog.src}), no site header, ${h.game.name} marked Playing (${await h.page.shot("switch-dialog")})`,
  );
  await h.page.eval(`${doc}.querySelector('a[data-play="${next.name}"]').click(); true`);
  await h.page.until(`location.pathname === ${JSON.stringify(next.pages.host)} && !!globalThis.${next.name}?.party`, 30_000);
  const info = await hostInfo(h.page, next);
  return { ...h, game: next, ...info };
}

/** Scenario 3 (+ 6's second half): Other game mid-party. */
async function scenarioSwitch(): Promise<void> {
  log("== switch: Other game mid-party (jinx → drawbluff), an extra screen along");
  const { h, phones } = await party(gameOf("jinx"), 3);
  const screen = await extraScreen(h);
  await quickSettings(h);
  for (const p of phones) await botOnPhone(p, h.game);
  const screenText = () => screen?.page.eval<string>(`document.getElementById("tv").contentDocument?.body?.innerText.replace(/\\s+/g, " ") ?? ""`) ?? Promise.resolve("");
  const lobby = await screenText();
  await vipStarts(phones[0]!);
  await h.page.until(`${G(h)}.game.running`, 15_000);
  await sleep(3000);
  if (screen) {
    const now = await screenText();
    check(now !== lobby && now !== "", `the extra screen follows the game: ${now.slice(0, 100)}`);
  }
  const code = h.code;
  const next = await otherGame(h, gameOf("drawbluff"));
  check(next.code === code, `the room code stays (${code} → ${next.code})`);
  check(await h.page.eval<boolean>(`!!document.querySelector(".tvpipe-table iframe")`), "the next game's host page is in table mode again");
  for (const p of phones) {
    const ok = await p.page
      .until(`location.pathname === ${JSON.stringify(next.game.pages.phone)}`, 30_000)
      .then(() => h.page.until(`drawbluff.party.players.some((x) => x.name === ${JSON.stringify(p.name)} && x.connected)`, 30_000))
      .then(() => true)
      .catch(() => false);
    check(ok, `${p.name} followed to drawbluff with the name carried`);
  }
  const tv = await h.page.eval<string>(tableTv);
  check(phones.every((p) => shows(tv, p.name)), `drawbluff's TV lists ${phones.map((p) => p.name).join(", ")}`);
  if (screen) {
    const back = await screen.page
      .until(`document.body.dataset.state === "shown" && document.getElementById("tv").src.includes("/g/drawbluff/")`, 30_000)
      .then(() => true)
      .catch(() => false);
    const asked = await h.page.eval<boolean>(`!!document.querySelector("dialog.tvpipe-screen-request")`);
    check(back && !asked, `the extra screen came back with drawbluff without asking (${await screen.page.eval<string>(`document.body.dataset.state + " " + document.getElementById("tv").src`)})`);
    await screen.page.shot("screen-after-switch");
    await screen.ctx.dispose();
  }
  await h.page.shot("switch-host");
  await endParty(next, phones);
}

/** Scenario 6: an extra screen at /tv/ joins with the code, approved by the host. */
async function extraScreen(h: Host): Promise<{ ctx: Ctx; page: Page } | undefined> {
  return step("extra screen", async () => {
    const ctx = await chrome.context("screen");
    const page = await ctx.open(`${BASE}/tv/`, TV);
    await page.until(`document.body.dataset.state === "code" && !!document.getElementById("form").onsubmit`);
    await page.eval(`(() => { const i = document.getElementById("code"); i.value = ${JSON.stringify(h.code)}; i.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("form").requestSubmit(); return true; })()`);
    await h.page.until(`!!document.querySelector("dialog.tvpipe-screen-request[open]")`, 20_000).catch(async (e: Error) => {
      await page.shot("screen-fail");
      log(`screen: ${await page.eval<string>(`document.body.dataset.state + ": " + document.body.innerText.replace(/\\s+/g, " ")`)}; errors ${page.collect().join(" | ")}`);
      throw e;
    });
    const q = await h.page.eval<string>(`document.querySelector("dialog.tvpipe-screen-request p").textContent`);
    log(`host asks: ${q}`);
    await h.page.shot("screen-ask");
    await h.page.eval(`[...document.querySelectorAll("dialog.tvpipe-screen-request button")].find((b) => b.textContent === "Allow").click(); true`);
    await page.until(`document.body.dataset.state === "shown"`, 20_000);
    await sleep(2500);
    const names = await h.page.eval<string[]>(`${G(h)}.party.players.map((p) => p.name)`);
    const text = await page.eval<string>(`document.getElementById("tv").contentDocument?.body?.innerText ?? ""`);
    check(names.every((n) => shows(text, n)), `the extra screen shows the TV page with ${names.join(", ")}`);
    await page.shot("screen-shown");
    return { ctx, page };
  });
}

/** Scenario 4: the host reloads; the room stays, phones come back. */
async function scenarioReload(): Promise<void> {
  log("== reload: the host page reloads");
  const { h, phones } = await party(gameOf("garble"), 3);
  const code = h.code;
  await h.page.eval(`globalThis.__before = true; location.reload(); true`);
  await h.page.until(`!globalThis.__before && !!globalThis.garble?.party?.joinInfo?.url`, 30_000);
  log(`host reloaded: ${JSON.stringify(await h.page.eval(`garble.party.players.map((p) => p.name + (p.connected ? "" : " (away)"))`))}`);
  const again = await hostInfo(h.page, h.game);
  check(again.code === code, `the room code is kept over the reload (${code} → ${again.code})`);
  const back = await h.page
    .until(`garble.party.players.filter((p) => p.connected).length === ${phones.length}`, 45_000)
    .then(() => true)
    .catch(() => false);
  check(back, `phones came back: ${JSON.stringify(await h.page.eval(`garble.party.players.map((p) => p.name + (p.connected ? "" : " (away)"))`))}`);
  const names = await h.page.eval<string[]>(`garble.party.players.map((p) => p.name)`);
  check(phones.every((p) => names.includes(p.name)) && names.length === phones.length, "with their names, no duplicates");
  check(await h.page.eval<boolean>(`!!document.querySelector(".tvpipe-table iframe")`), "still in table mode");
  await endParty(h, phones);
}

/** Scenario 5: a phone reloads; one closes its page and opens the link again; one goes offline. */
async function scenarioPhone(): Promise<void> {
  log("== phone: reload, close and reopen, offline and back");
  const { h, phones } = await party(gameOf("krakel"), 3);
  const ids = await h.page.eval<Record<string, string>>(`Object.fromEntries(krakel.party.players.map((p) => [p.name, p.id]))`);
  const [a, b, c] = phones as [Phone, Phone, Phone];
  // Reload.
  await a.page.eval(`location.reload(); true`);
  await sleep(1500);
  await h.page.until(`krakel.party.players.find((p) => p.name === "${a.name}")?.connected`, 30_000).catch(() => {});
  check((await phoneState(a)).you === a.name && (await h.page.eval<string>(`krakel.party.players.find((p) => p.name === "${a.name}")?.id`)) === ids[a.name], `${a.name} reloaded and is back in the seat`);
  // Close the page, open the join link again (same context: the phone's storage).
  const tClose = Date.now();
  await b.page.close();
  const gone = await h.page
    .until(`!krakel.party.players.find((p) => p.name === "${b.name}")?.connected`, 60_000)
    .then(() => true)
    .catch(() => false);
  if (process.env["DBG_PC"]) log(`pcs: ${JSON.stringify(await h.page.eval(`globalThis.__pcs.map((r) => r.log.map(([t, s]) => (t - ${tClose}) + " " + s))`))}`);
  check(gone && Date.now() - tClose < 15_000, `${b.name} closed the page: away on the host after ${Date.now() - tClose} ms`);
  b.page = await b.ctx.open(h.join, PHONE, { ua: IPHONE_UA, hook: true });
  const resumed = await b.page
    .until(`globalThis.__tvp?.clients.some((c) => c.role === "player" && c.you?.name === "${b.name}")`, 30_000)
    .then(() => true)
    .catch(() => false);
  check(resumed && (await h.page.eval<boolean>(`krakel.party.players.find((p) => p.name === "${b.name}")?.connected === true && krakel.party.players.length === 3`)), `${b.name} closed the page, opened the link again: resumed without typing the name`);
  // A locked phone: the page frozen (no script runs, the channel stays up: DevTools' offline does not reach WebRTC) for 55 s, then back.
  await c.page.tab.send("Page.setWebLifecycleState", { state: "frozen" });
  log(`${c.name}: frozen (a locked phone)`);
  const tAway = Date.now();
  const away = await h.page
    .until(`!krakel.party.players.find((p) => p.name === "${c.name}")?.connected`, 60_000)
    .then(() => true)
    .catch(() => false);
  log(`${c.name}: away on the host after ${Date.now() - tAway} ms frozen: ${away}`);
  await sleep(2000);
  await c.page.tab.send("Page.setWebLifecycleState", { state: "active" });
  const tBack = Date.now();
  const backC = await h.page
    .until(`krakel.party.players.find((p) => p.name === "${c.name}")?.connected`, 60_000)
    .then(() => true)
    .catch(() => false);
  check(away && backC && (await h.page.eval<string>(`krakel.party.players.find((p) => p.name === "${c.name}")?.id`)) === ids[c.name], `${c.name} locked (away after the pings' timeout), unlocked: back in the seat ${Date.now() - tBack} ms later`);
  await endParty(h, phones);
}

/** Scenario 7: A second window (a popup from the Start click), Change screen. */
async function scenarioWindow(): Promise<void> {
  log("== window: A second window, Change screen");
  const game = gameOf("shifty");
  const ctx = await chrome.context("host-window");
  const before = new Set((await chrome.targets()).map((t) => t.targetId));
  const h = await startHost(ctx, game, "window");
  const popupT = (await chrome.targets()).find((t) => !before.has(t.targetId) && t.type === "page" && t.browserContextId === ctx.id && t.targetId !== h.page.targetId);
  if (!check(!!popupT, `the Start click opened a window (${popupT?.url ?? "none"})`)) return;
  const popup = await chrome.attach(popupT!.targetId, "host-window-popup");
  await popup.until(`location.pathname === "/_tvpipe/screen/" && document.getElementById("tv").src.includes(${JSON.stringify(game.pages.tv)})`, 20_000);
  const p1 = await joinPhone(chrome, h, "Ann");
  await sleep(1500);
  const text = await popup.eval<string>(`document.getElementById("tv").contentDocument?.body?.innerText ?? ""`);
  check(shows(text, "Ann"), `the window shows the TV page with Ann: ${text.replace(/\s+/g, " ").slice(0, 80)}`);
  await popup.shot("window-popup");
  check(!(await h.page.eval<boolean>(`!!document.querySelector(".tvpipe-table")`)), "the host page shows itself (no table mode)");
  await h.page.shot("window-host");
  // Change screen → This screen.
  await h.page.eval(`document.getElementById("change-tv").click(); true`);
  const frame = `document.querySelector("dialog.tvpipe-cast-picker iframe")?.contentDocument`;
  await h.page.until(`!!${frame}?.querySelector('#devices .device[data-name="this"]')`, 15_000);
  await h.page.eval(`(() => { const d = ${frame}; d.querySelector('#devices .device[data-name="this"]').click(); return true; })()`);
  await h.page.until(`!${frame}.getElementById("start").disabled && ${frame}.querySelector('#devices .device[data-name="this"]').classList.contains("selected")`);
  await h.page.eval(`${frame}.getElementById("start").click(); true`);
  const toThis = await h.page
    .until(`!document.querySelector("dialog.tvpipe-cast-picker") && !!document.querySelector(".tvpipe-table iframe")`, 15_000)
    .then(() => true)
    .catch(() => false);
  check(toThis, "Change screen → This screen: table mode");
  await sleep(1500);
  const closed = (await chrome.targets()).every((t) => t.targetId !== popupT!.targetId);
  check(closed, "the second window closed");
  // And back to a window (the dialog's Apply is a click: the window may open).
  const before2 = new Set((await chrome.targets()).map((t) => t.targetId));
  await h.page.eval(`(() => { document.querySelector('.tvpipe-table button[aria-label^="The room"]').click(); document.getElementById("change-tv").click(); return true; })()`);
  await h.page.until(`!!${frame}?.querySelector('#devices .device[data-name="window"]')`, 15_000);
  await h.page.eval(`${frame}.querySelector('#devices .device[data-name="window"]').click(); true`);
  await h.page.until(`!${frame}.getElementById("start").disabled && ${frame}.querySelector('#devices .device[data-name="window"]').classList.contains("selected")`);
  await h.page.eval(`${frame}.getElementById("start").click(); true`);
  await sleep(2500);
  const popup2 = (await chrome.targets()).find((t) => !before2.has(t.targetId) && t.type === "page" && t.browserContextId === ctx.id);
  const tableGone = await h.page.eval<boolean>(`!document.querySelector(".tvpipe-table")`);
  const cast = await h.page.eval<string>(`document.getElementById("tvs")?.innerText ?? ""`);
  check(!!popup2 && tableGone, `Change screen → A second window: a window again (${popup2?.url ?? "none"}), table mode gone; the host page says: ${cast.replace(/\s+/g, " ")}`);
  await h.page.shot("window-change-back");
  await closePhone(p1);
  await ctx.dispose();
}

/** Scenario 8: End. */
async function scenarioQuit(): Promise<void> {
  log("== quit: End");
  const { h, phones } = await party(gameOf("jinx"), 2);
  const code = h.code;
  await h.page.eval(`(() => { document.querySelector('.tvpipe-table button[aria-label^="The room"]').click(); document.getElementById("quit").click(); return true; })()`);
  await h.page.until(`location.pathname === "/games/"`, 15_000);
  check(true, "End: the host is back at /games/");
  check(await h.page.eval<boolean>(`sessionStorage.getItem("tvpipe-web") === null || !JSON.parse(sessionStorage.getItem("tvpipe-web")).room`), "the session is cleared");
  for (const p of phones) {
    const s = await p.page
      .until(`globalThis.__tvp.clients.some((c) => c.byeReason === "room-closed")`, 15_000)
      .then(() => phoneState(p))
      .catch(() => phoneState(p));
    check(s.bye === "room-closed" || /closed|over|ended|vorbei/i.test(s.text), `${p.name}'s phone: ${s.bye}: "${s.text}"`);
  }
  await phones[0]!.page.shot("quit-phone");
  const r = await fetch(`${BASE}/${code}`, { redirect: "manual" });
  check(r.status === 404, `${BASE}/${code} after End: ${r.status}`);
  const api = await fetch(`${BASE}/api/rooms/${code}`);
  check(api.status === 404, `/api/rooms/${code} after End: ${api.status}`);
  await endParty(h, phones);
}

/** Scenario 9: the short link. */
async function scenarioShort(): Promise<void> {
  log("== short: BASE/CODE");
  const ctx = await chrome.context("host-short");
  const h = await startHost(ctx, gameOf("snug"), "this");
  const r = await fetch(`${BASE}/${h.code.toLowerCase()}`, { redirect: "manual" });
  const loc = r.headers.get("location") ?? "";
  check(r.status === 302 && loc.includes(`/r/?r=${h.code}#k=`), `GET /${h.code.toLowerCase()}: ${r.status} → ${loc.replace(/#k=.*/, "#k=…")}`);
  const pctx = await chrome.context("phone-short");
  const page = await pctx.open(`${BASE}/${h.code}`, PHONE, { ua: IPHONE_UA, hook: true });
  const phone: Phone = { ctx: pctx, page, name: "Ann" };
  await fillName(phone, h);
  check(true, `a phone at ${BASE}/${h.code} joined snug as Ann`);
  await endParty(h, [phone]);
}

/** Scenario 10: 12 phones join at once (one address). */
async function scenarioBurst(): Promise<void> {
  log("== burst: 12 phones at once");
  const ctx = await chrome.context("host-burst");
  const h = await startHost(ctx, gameOf("drawbluff"), "this");
  const t = Date.now();
  const phones = await Promise.all(NAMES.map((n) => joinPhone(chrome, h, n, { wait: false })));
  const joined = await Promise.all(
    phones.map((p) =>
      fillName(p, h, 90_000)
        .then(() => Date.now() - t)
        .catch((e: Error) => {
          log(`${p.name}: ${e.message.slice(0, 200)}`);
          return -1;
        }),
    ),
  );
  check(joined.every((ms) => ms > 0), `12 phones joined at once: ${joined.map((ms, i) => `${NAMES[i]} ${ms} ms`).join(", ")}`);
  const n = await h.page.eval<number>(`drawbluff.party.connectedPlayers.length`);
  check(n === 12, `the host lists ${n} connected players`);
  await h.page.shot("burst-tv");
  await endParty(h, phones);
}

/** /games/ and the launcher's look on desktop, iPad and phone, also with the tvpipe app's row. */
async function scenarioLooks(): Promise<void> {
  log("== looks: /games/ and the launcher");
  const game = gameOf("jinx");
  for (const [name, view, ua] of [
    ["desktop", DESK, undefined],
    ["ipad", PAD, IPAD_UA],
    ["phone", PHONE, IPHONE_UA],
  ] as const) {
    const ctx = await chrome.context(`looks-${name}`);
    const page = await ctx.open(`${BASE}/games/`, view, { ua });
    await page.until(`!!document.querySelector('a[data-play="${game.name}"]')`);
    check(await page.eval<boolean>(`document.documentElement.scrollWidth <= innerWidth + 1`), `/games/ on ${name}: no sideways scroll (${await page.shot(`games-${name}`)})`);
    await page.eval(`document.querySelector('a[data-play="${game.name}"]').click(); true`);
    await page.until(`location.pathname === "/_tvpipe/launcher/" && document.querySelectorAll("#devices .device").length > 1`);
    await sleep(500);
    const offered = await page.eval<string[]>(`[...document.querySelectorAll("#devices .device")].map((d) => d.dataset.name + ":" + d.querySelector(".name").textContent)`);
    const wide = await page.eval<boolean>(`document.documentElement.scrollWidth <= innerWidth + 1`);
    check(wide, `launcher on ${name}: no sideways scroll; offers ${offered.join(" | ")} (${await page.shot(`launcher-${name}`)})`);
    await page.eval(`document.querySelector('#devices .device[data-name="app"]').click(); true`);
    await page.until(`!document.getElementById("app-way").hidden && document.getElementById("start").hidden`);
    await sleep(600); // the row scrolls its commands into view
    const cmds = await page.eval<string[]>(`[...document.querySelectorAll("#app-commands code")].map((c) => c.textContent)`);
    const wideApp = await page.eval<boolean>(`document.documentElement.scrollWidth <= innerWidth + 1`);
    check(
      wideApp && cmds.at(-1) === `tvpipe game play ${game.name}` && cmds.length === (name === "desktop" ? 2 : 3),
      `launcher on ${name}, the tvpipe app: ${cmds.join(" | ")} (${await page.shot(`launcher-${name}-app`)})`,
    );
    await ctx.dispose();
  }
}

try {
  if (want("looks")) await step("looks", scenarioLooks);
  if (want("table")) await step("table", scenarioTable);
  if (want("screen") || want("switch")) await step("switch", scenarioSwitch);
  if (want("reload")) await step("reload", scenarioReload);
  if (want("phone")) await step("phone", scenarioPhone);
  if (want("window")) await step("window", scenarioWindow);
  if (want("quit")) await step("quit", scenarioQuit);
  if (want("short")) await step("short", scenarioShort);
  if (want("burst")) await step("burst", scenarioBurst);
  if (want("games")) await scenarioGames(GAMES ?? index.games.map((g) => g.name), "round");
  if (want("full")) await scenarioGames(GAMES ?? ["jinx", "drawbluff"], "end");
} finally {
  for (const p of pages) p.collect();
  const errs = pages.filter((p) => p.errors.length > 0);
  log(`console errors: ${errs.length === 0 ? "none" : ""}`);
  for (const p of errs) for (const e of [...new Set(p.errors)]) log(`  ${p.name}: ${e.slice(0, 300)}`);
  log(failures === 0 ? "all checks passed" : `${failures} checks failed`);
  chrome.close();
}
process.exit(failures > 0 ? 1 : 0);
