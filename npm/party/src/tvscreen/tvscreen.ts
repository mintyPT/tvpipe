/**
 * An extra screen of a room, `tvpipe.party/tv` (docs/browser-party-design.md,
 * "Extra screens"): the room's code (typed, or `#r=CODE`), the host's
 * approval over a data channel (`requestScreen`), then the TV page it
 * names full page in a frame. At the next game the TV page in the frame
 * says so (`tvpipe:next-game`) and this page asks again; the host knows
 * this screen's token and says yes by itself.
 */

import { requestScreen } from "../rtc-socket.ts";

const TOKEN_KEY = "tvpipe-screen-token";
const ROOM = /^[A-Z]{4,8}$/;
/** What a watch client in a frame tells its page at the next game. */
const NEXT_GAME = "tvpipe:next-game";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** This browser's token: random, kept, so the host knows it again. */
function token(): string {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t && /^[A-Za-z0-9_-]{16,64}$/.test(t)) return t;
  } catch {
    // No storage: a new token every time (the host asks every time).
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const t = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    // As above.
  }
  return t;
}

/** The TV page the host named, when it is a page of this site. */
export function framable(url: string, origin: string): string | null {
  try {
    const u = new URL(url, origin);
    return u.origin === origin ? u.href : null;
  } catch {
    return null;
  }
}

type State = "code" | "ask" | "bad" | "shown";

let code = "";
/** Bumped by every request and by leaving: answers of older ones are dropped. */
let round = 0;
let wake: { release(): Promise<void> } | null = null;

function setState(s: State): void {
  document.body.dataset["state"] = s;
  if (s === "shown") void keepAwake();
}

function codeView(error?: string): void {
  round++;
  code = "";
  history.replaceState(null, "", location.pathname);
  $("tv").removeAttribute("src");
  const e = $("code-error");
  e.hidden = !error;
  e.textContent = error ?? "";
  setState("code");
  $<HTMLInputElement>("code").focus();
}

function bad(title: string, text: string): void {
  $("bad-title").textContent = title;
  $("bad-text").textContent = text;
  setState("bad");
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Asks the host to show this screen; again after a while while there is no host. */
async function ask(quiet = false): Promise<void> {
  const mine = ++round;
  if (!quiet) {
    $("ask-title").textContent = "Asking the game";
    $("ask-text").textContent = "The person running the game says yes on their screen.";
    setState("ask");
  }
  for (;;) {
    let reason: string;
    try {
      // The room first: an unknown code says so, a room without its host waits.
      const r = await fetch(`/api/rooms/${code}`, { cache: "no-store" });
      if (mine !== round) return;
      if (r.status === 404) return codeView(`No game with the code ${code}. Check the code on the game's screen.`);
      const room = r.ok ? ((await r.json()) as { host?: boolean }) : { host: false };
      if (r.ok && !room.host) reason = "no-host";
      else {
        // The user agent as it is: the host names the browser in its question (webhub.ts `browserName`).
        const a = await requestScreen(code, { token: token(), agent: navigator.userAgent });
        if (mine !== round) return;
        if (a.ok) {
          const src = framable(a.url, location.origin);
          if (!src) return bad("Not shown", "The game named a page of another site.");
          const frame = $<HTMLIFrameElement>("tv");
          if (frame.src !== src) frame.src = src;
          setState("shown");
          return;
        }
        reason = a.reason;
      }
    } catch (err) {
      if (mine !== round) return;
      reason = `failed: ${(err as Error).message}`;
    }
    if (/no-host|timeout|failed|unavailable|offline/.test(reason)) {
      // The host's tab is away or the network hiccupped: ask again in a moment.
      if (document.body.dataset["state"] !== "shown") {
        $("ask-title").textContent = "Waiting for the game";
        $("ask-text").textContent = "The game's screen does not answer right now. This page asks again by itself.";
        setState("ask");
      }
      await sleep(5000);
      if (mine !== round) return;
      continue;
    }
    return bad("Not shown", "The game said no to this screen. Ask again, and say yes on the game's screen.");
  }
}

function start(c: string): void {
  code = c;
  history.replaceState(null, "", `#r=${c}`);
  void ask();
}

async function keepAwake(): Promise<void> {
  const lock = (navigator as { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
  if (!lock || wake) return;
  try {
    wake = await lock.request("screen");
    (wake as unknown as EventTarget).addEventListener?.("release", () => (wake = null));
  } catch {
    // Not allowed now (no tap yet, the tab in the background).
  }
}

function setupFullscreen(): void {
  const full = $<HTMLButtonElement>("full");
  const can = !!document.documentElement.requestFullscreen;
  let idle = 0;
  const shown = () => {
    full.hidden = !can || !!document.fullscreenElement;
    full.classList.remove("idle");
    clearTimeout(idle);
    idle = window.setTimeout(() => full.classList.add("idle"), 4000);
  };
  full.onclick = () => void document.documentElement.requestFullscreen().catch(() => {});
  document.addEventListener("fullscreenchange", shown);
  addEventListener("pointermove", shown);
  addEventListener("keydown", shown);
  shown();
}

function main(): void {
  setupFullscreen();
  $("form").onsubmit = (e) => {
    e.preventDefault();
    const c = $<HTMLInputElement>("code").value.trim().toUpperCase();
    if (!ROOM.test(c)) {
      const err = $("code-error");
      err.hidden = false;
      err.textContent = "The code is the four letters the game shows.";
      return;
    }
    start(c);
  };
  $("ask-cancel").onclick = () => codeView();
  $("bad-code").onclick = () => codeView();
  $("bad-again").onclick = () => void ask();
  addEventListener("message", (ev) => {
    const frame = $<HTMLIFrameElement>("tv");
    if (ev.source !== frame.contentWindow || ev.origin !== location.origin) return;
    if ((ev.data as { type?: unknown } | null)?.type === NEXT_GAME && code) void ask(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && document.body.dataset["state"] === "shown") void keepAwake();
  });
  const c = (new URLSearchParams(location.hash.slice(1)).get("r") ?? "").toUpperCase();
  if (ROOM.test(c)) start(c);
  else codeView();
}

if (typeof document !== "undefined") main();
