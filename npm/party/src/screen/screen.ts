/**
 * The TV page's own window on tvpipe.party (docs/browser-party-design.md,
 * "The launcher": `cable`, `window`): `/_tvpipe/screen/?u=PATH`, where
 * PATH is the TV page with its fragment (a path of this site, nothing
 * else), in a full-page frame. A Full screen button (gone once the
 * window is full screen) and, for the second window, the hint to drag it
 * onto the TV first. `screens.ts` opens it and talks to it on the
 * `BroadcastChannel` SCREEN_CHANNEL: `{t: "show", url}` shows another
 * page (the next game's TV page; answered `{t: "shown", url}`),
 * `{t: "close"}` closes the window, and the window says `{t: "gone"}`
 * when it goes.
 */

import { SCREEN_CHANNEL } from "../screens.ts";

/** The page to frame: a path of this site (`/…`, not `//…`), or null. */
export function framedPath(u: string | null, origin: string): string | null {
  if (!u || !u.startsWith("/") || u.startsWith("//") || u.includes("\\")) return null;
  try {
    const url = new URL(u, origin);
    return url.origin === origin ? url.pathname + url.search + url.hash : null;
  } catch {
    return null;
  }
}

function main(): void {
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const path = framedPath(new URLSearchParams(location.search).get("u"), location.origin);
  if (!path) {
    $("bad").hidden = false;
    return;
  }
  const frame = $("tv") as HTMLIFrameElement;
  frame.src = path;
  if (typeof BroadcastChannel === "function") {
    const ch = new BroadcastChannel(SCREEN_CHANNEL);
    ch.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { t?: unknown; url?: unknown } | null;
      if (m?.t === "close") {
        window.close();
        return;
      }
      if (m?.t !== "show" || typeof m.url !== "string") return;
      const next = framedPath(m.url, location.origin);
      if (!next) return;
      if (frame.getAttribute("src") !== next) frame.src = next;
      history.replaceState(null, "", `${location.pathname}?u=${encodeURIComponent(next)}`);
      ch.postMessage({ t: "shown", url: next });
    };
    addEventListener("pagehide", () => ch.postMessage({ t: "gone" }));
  }
  const bar = $("bar");
  const can = !!document.documentElement.requestFullscreen;
  let idle = 0;
  const show = () => {
    bar.hidden = !can || !!document.fullscreenElement;
    bar.classList.remove("idle");
    clearTimeout(idle);
    idle = window.setTimeout(() => bar.classList.add("idle"), 6000);
  };
  $("full").onclick = () => void document.documentElement.requestFullscreen().catch(() => {});
  // A double click or F anywhere too (the frame takes the clicks on the picture).
  addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") void document.documentElement.requestFullscreen().catch(() => {});
    show();
  });
  document.addEventListener("fullscreenchange", show);
  addEventListener("pointermove", show);
  show();
}

if (typeof document !== "undefined") main();
