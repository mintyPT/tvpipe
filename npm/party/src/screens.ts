/**
 * Where web mode shows the TV page (docs/browser-party-design.md, "The
 * launcher" and "Table mode"): the cast of a host page without tvpipe.
 *
 * - `this`: the TV page full screen over the host page, in its tab; a ⋯
 *   button shows the host page with "Back to the game" (back by itself
 *   after 20 s without a touch); ⛶ asks for full screen.
 * - `cable`: a window of the TV page placed on the other screen (Window
 *   Management API); `window`: a plain window of it. Both open
 *   {@link screenWindowUrl} in the window named {@link SCREEN_WINDOW}.
 *   A window that is already open (a game ago) is asked first on the
 *   `BroadcastChannel` {@link SCREEN_CHANNEL}: `{t: "show", url}`, which
 *   the window page answers `{t: "shown", url}` after showing `url`
 *   (no new window: browsers block those without a click); it says
 *   `{t: "gone"}` when it closes. Without an answer a window is opened;
 *   when the browser blocks it the cast fails with the code
 *   `popup-blocked` (the host page's "Try again" is a click).
 * - `none`: nothing here (screens join at tvpipe.party/tv).
 */

import type { CastStatus } from "./tvpipe.ts";
import { webDeps, type BroadcastLike } from "./rtc.ts";

export type ScreenKind = "this" | "cable" | "window" | "none";

/** The name of the TV page's window (cable, second window). */
export const SCREEN_WINDOW = "tvpipe-screen";
/** The channel between host pages and that window. */
export const SCREEN_CHANNEL = "tvpipe-screen";
/** The window's page. */
export const SCREEN_PAGE = "/_tvpipe/screen/";
/** Table mode: back to the game after this long without a touch, ms. */
export const BACK_AFTER_MS = 20_000;

/** The window page showing the TV page `page` (a same-origin path with its fragment). */
export function screenWindowUrl(page: string): string {
  if (!page.startsWith("/") || page.startsWith("//")) throw new TypeError("screenWindowUrl: a path on this origin");
  return `${SCREEN_PAGE}?u=${encodeURIComponent(page)}`;
}

/** What people call each screen (`lang` `de` or else English). */
export function screenTitle(kind: ScreenKind, lang = "en", ipad = false): string {
  const de = lang === "de";
  switch (kind) {
    case "this":
      return ipad ? (de ? "Dieses iPad" : "This iPad") : de ? "Dieser Bildschirm" : "This screen";
    case "cable":
      return de ? "Der Fernseher am Kabel" : "The TV on the cable";
    case "window":
      return de ? "Ein zweites Fenster" : "A second window";
    default:
      return de ? "Ein anderer Bildschirm" : "Another screen";
  }
}

const g = globalThis as any;

function lang(): string {
  return String(g.document?.documentElement?.lang ?? "en").slice(0, 2);
}

/** The full-screen TV page over the host page (table mode). */
class TableScreen {
  readonly #root: HTMLElement;
  readonly #frame: HTMLIFrameElement;
  readonly #back: HTMLButtonElement;
  #idle: ReturnType<typeof setTimeout> | undefined;
  readonly #onActivity = () => this.#armIdle();

  constructor(page: string) {
    const doc: Document = g.document;
    const de = lang() === "de";
    const root = doc.createElement("div");
    root.className = "tvpipe-table";
    root.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:#000";
    const frame = doc.createElement("iframe");
    frame.title = de ? "Das Spiel" : "The game";
    frame.allow = "autoplay; fullscreen; screen-wake-lock";
    frame.src = page;
    frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;display:block";
    const bar = doc.createElement("div");
    bar.style.cssText = "position:absolute;top:10px;right:10px;display:flex;gap:8px;z-index:1";
    const button = (text: string, label: string) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.setAttribute("aria-label", label);
      b.title = label;
      b.style.cssText =
        "font:600 20px/1 system-ui,sans-serif;min-width:44px;height:44px;padding:0 12px;border-radius:22px;border:1px solid rgb(255 255 255 / 25%);background:rgb(0 0 0 / 45%);color:#fff;cursor:pointer;opacity:.7";
      return b;
    };
    const menu = button("⋯", de ? "Der Raum: Spieler, Einstellungen, Ende" : "The room: players, settings, End");
    menu.onclick = () => this.showHost();
    bar.append(menu);
    if (doc.fullscreenEnabled) {
      const full = button("⛶", de ? "Vollbild" : "Full screen");
      full.onclick = () => {
        if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {});
        else void doc.documentElement.requestFullscreen().catch(() => {});
      };
      bar.append(full);
    }
    root.append(frame, bar);
    const back = button(de ? "Zurück zum Spiel" : "Back to the game", de ? "Zurück zum Spiel" : "Back to the game");
    back.style.cssText += ";position:fixed;right:16px;bottom:16px;z-index:2147483001;font-size:17px;opacity:1;background:var(--accent,#ffcf3f);color:var(--accent-text,#241a00);border:0;box-shadow:0 6px 20px rgb(0 0 0 / 40%)";
    back.hidden = true;
    back.onclick = () => this.showGame();
    doc.body.append(root, back);
    this.#root = root;
    this.#frame = frame;
    this.#back = back;
  }

  /** The host page (players, settings, End) instead of the game, for 20 s after the last touch. */
  showHost(): void {
    this.#root.style.visibility = "hidden";
    this.#root.style.pointerEvents = "none";
    this.#back.hidden = false;
    for (const ev of ["pointerdown", "keydown", "wheel", "touchstart", "input"]) g.document.addEventListener(ev, this.#onActivity, { capture: true, passive: true });
    this.#armIdle();
  }

  showGame(): void {
    clearTimeout(this.#idle);
    for (const ev of ["pointerdown", "keydown", "wheel", "touchstart", "input"]) g.document.removeEventListener(ev, this.#onActivity, { capture: true });
    this.#root.style.visibility = "";
    this.#root.style.pointerEvents = "";
    this.#back.hidden = true;
  }

  #armIdle(): void {
    clearTimeout(this.#idle);
    // A dialog open over the host page (the games list, a screen's request) keeps it.
    this.#idle = setTimeout(() => (g.document.querySelector("dialog[open]") ? this.#armIdle() : this.showGame()), BACK_AFTER_MS);
  }

  navigate(page: string): void {
    this.#frame.src = page;
  }

  remove(): void {
    this.showGame();
    this.#root.remove();
    this.#back.remove();
  }
}

/** Plays the TV page on one of the {@link ScreenKind}s; `onstatus` gets its cast statuses. */
export class ScreenCaster {
  onstatus: ((s: CastStatus) => void) | undefined;
  #kind: ScreenKind | undefined;
  #table: TableScreen | undefined;
  #win: Window | null = null;
  #poll: ReturnType<typeof setInterval> | undefined;
  #channel: BroadcastLike | undefined;
  #status: CastStatus = { state: "stopped" };

  get status(): CastStatus {
    return this.#status;
  }

  #emit(s: CastStatus): CastStatus {
    this.#status = s;
    this.onstatus?.(s);
    return s;
  }

  #receiver(kind: ScreenKind, state: string, extra: { error?: string; code?: string } = {}): CastStatus["receivers"] {
    return [{ name: kind, title: screenTitle(kind, lang()), protocol: "browser", state, delayMs: 0, ...extra }];
  }

  /** Shows `page` (the TV page with its screen key) on `kind`. */
  async start(kind: ScreenKind, page: string): Promise<CastStatus> {
    // Another kind: the table goes; the window too, unless the picture stays in a window (second window ↔ cable).
    if (this.#kind !== kind) this.stop(!(kind === "window" || kind === "cable"));
    this.#kind = kind;
    this.#emit({ state: "starting", to: [kind] });
    if (kind === "none") return this.#emit({ state: "stopped", to: [] });
    if (kind === "this") {
      if (!g.document?.body) return this.#emit({ state: "failed", error: "no page", receivers: this.#receiver(kind, "failed", { error: "no page" }) });
      if (this.#table) this.#table.navigate(page);
      else this.#table = new TableScreen(page);
      return this.#emit({ state: "streaming", to: [kind], receivers: this.#receiver(kind, "connected") });
    }
    // A window of the TV page: ours, one already open (a game ago), else a new one.
    if (this.#win && !this.#win.closed) {
      try {
        this.#win.location.assign(screenWindowUrl(page));
        return this.#emit({ state: "streaming", to: [kind], receivers: this.#receiver(kind, "connected") });
      } catch {}
    }
    if (await this.#reuse(page)) return this.#emit({ state: "streaming", to: [kind], receivers: this.#receiver(kind, "connected") });
    let features = "popup,width=1280,height=720";
    if (kind === "cable") {
      try {
        const details = await g.getScreenDetails?.();
        const other = details?.screens?.find((s: any) => s !== details.currentScreen && !s.isPrimary) ?? details?.screens?.find((s: any) => s !== details.currentScreen);
        if (other) features = `popup,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
      } catch {
        // No permission: a window here, to be dragged over.
      }
    }
    const win: Window | null = g.open?.(screenWindowUrl(page), SCREEN_WINDOW, features) ?? null;
    if (!win) {
      const error = lang() === "de" ? "Der Browser hat das Fenster blockiert: Nochmal versuchen" : "The browser blocked the window: Try again";
      return this.#emit({ state: "failed", to: [kind], error, receivers: this.#receiver(kind, "failed", { error, code: "popup-blocked" }) });
    }
    this.#win = win;
    this.#watchWindow();
    return this.#emit({ state: "streaming", to: [kind], receivers: this.#receiver(kind, "connected") });
  }

  /** Asks an open window of the TV page to show `page`; true once it did. */
  async #reuse(page: string): Promise<boolean> {
    const ch = this.#listen();
    if (!ch) return false;
    const shown = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 500);
      this.#onShown = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
    ch.postMessage({ t: "show", url: page });
    const ok = await shown;
    this.#onShown = undefined;
    return ok;
  }

  #onShown: (() => void) | undefined;

  #listen(): BroadcastLike | undefined {
    if (this.#channel) return this.#channel;
    try {
      const ch = new (webDeps().BroadcastChannel)(SCREEN_CHANNEL);
      ch.onmessage = (ev) => {
        const m = ev.data as { t?: unknown } | null;
        if (m?.t === "shown") this.#onShown?.();
        else if (m?.t === "gone" && (this.#kind === "cable" || this.#kind === "window") && this.#status.state === "streaming") this.#gone();
      };
      this.#channel = ch;
      return ch;
    } catch {
      return undefined;
    }
  }

  #watchWindow(): void {
    clearInterval(this.#poll);
    this.#poll = setInterval(() => {
      if (this.#win?.closed) this.#gone();
    }, 1000);
  }

  #gone(): void {
    clearInterval(this.#poll);
    this.#win = null;
    const kind = this.#kind ?? "window";
    this.#emit({ state: "stopped", to: [kind], receivers: this.#receiver(kind, "ended") });
  }

  /** Table mode: the host page instead of the game (⋯). */
  showHost(): void {
    this.#table?.showHost();
  }

  /** Stops showing (closes the window; `closeWindow` false keeps it for the next game). */
  stop(closeWindow = true): void {
    this.#table?.remove();
    this.#table = undefined;
    clearInterval(this.#poll);
    if (closeWindow) {
      try {
        this.#win?.close();
      } catch {}
      this.#channel?.postMessage({ t: "close" });
    }
    this.#win = null;
    const was = this.#kind;
    this.#kind = undefined;
    if (was && this.#status.state !== "stopped") this.#emit({ state: "stopped" });
  }

  /** The page goes away (the next game): the window stays for it. */
  dispose(): void {
    clearInterval(this.#poll);
    try {
      this.#channel?.close();
    } catch {}
    this.#channel = undefined;
  }
}

/**
 * Keeps the screen on (Wake Lock) while the room is open, asking again
 * when the page is visible again or touched (browsers drop the lock on
 * hide; some want a touch). Returns the stop.
 */
export function keepAwake(): () => void {
  const nav = g.navigator;
  const doc = g.document;
  if (!nav?.wakeLock || !doc) return () => {};
  let lock: any;
  let stopped = false;
  const ask = () => {
    if (stopped || lock || doc.visibilityState !== "visible") return;
    nav.wakeLock.request("screen").then(
      (l: any) => {
        if (stopped) return void l.release().catch(() => {});
        lock = l;
        l.addEventListener?.("release", () => {
          if (lock === l) lock = undefined;
        });
      },
      () => {},
    );
  };
  doc.addEventListener("visibilitychange", ask);
  doc.addEventListener("pointerdown", ask, { passive: true });
  ask();
  return () => {
    stopped = true;
    doc.removeEventListener("visibilitychange", ask);
    doc.removeEventListener("pointerdown", ask);
    void lock?.release?.().catch?.(() => {});
    lock = undefined;
  };
}
