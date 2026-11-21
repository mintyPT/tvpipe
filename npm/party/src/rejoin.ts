/**
 * The join badge: a small card in a corner of a TV page with the join QR
 * code and the short link to type, there the whole game long (people
 * join, or come back, without asking anyone), and a bigger one in its
 * place while a player's phone has been away for a few seconds, naming
 * who is missing. Scanning it (or typing the link and the same name)
 * brings a player back to their seat. {@link PartyClient} draws it on
 * screens by itself; games pick the corner, say when their own join code
 * is showing (the lobby: `client.joinVisible`), and keep their picture
 * out of the corner: while the card shows, `<html>` has
 * `data-tvpipe-join="CORNER"` and the space it takes from the screen's
 * edges as `--tvpipe-join-w` and `--tvpipe-join-h` (both `0px`
 * otherwise).
 *
 * It lives in a shadow root (the game's styles do not reach it, its own
 * do not leak), takes no pointer events and sizes itself by the
 * viewport's height, like the TV pages do. Its look follows CSS
 * variables set on the page: `--tvpipe-join-bg`, `--tvpipe-join-fg`,
 * `--tvpipe-join-accent`, `--tvpipe-join-font`, `--tvpipe-join-border`,
 * `--tvpipe-join-shadow`, and its distance from the edges,
 * `--tvpipe-join-x` and `--tvpipe-join-y`.
 */

/** Where the badge sits on the TV. */
export type Corner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

export interface RejoinBadgeOptions {
  /** Default `bottom-right`. */
  corner?: Corner | undefined;
  /** How long a phone is away before the badge names it, ms (default 4000). */
  delay?: number | undefined;
  /**
   * The small card with the join code the whole time (default `true`);
   * `false`: only the rejoin card, while someone is away during a game.
   */
  always?: boolean | undefined;
  /**
   * The small card's shape: `column` (default; the title, the QR code
   * and the link one under the other: narrow) or `row` (the QR code
   * beside them: low).
   */
  layout?: "column" | "row" | undefined;
}

interface Deps {
  qrSvg: (qr: any, opts?: { dark?: string; light?: string; quiet?: number }) => string;
  joinText: (join: any) => string | null;
  /** The page's clock (local time is fine: only for the delay). */
  now: () => number;
}

interface Texts {
  kicker: string;
  scan: string;
  open: string;
  name: string;
  /** The small card's title: before a game, during one (by `lateJoin`). */
  join: string;
  joinNow: string;
  joinNext: string;
  rejoin: string;
}

const STRINGS: Record<string, Texts> = {
  en: {
    kicker: "Rejoin",
    scan: "Scan the code",
    open: "Scan or open",
    name: "and enter the same name",
    join: "Join",
    joinNow: "Join now",
    joinNext: "Join next round",
    rejoin: "Rejoin",
  },
  de: {
    kicker: "Wieder einsteigen",
    scan: "Code scannen",
    open: "Scannen oder öffnen:",
    name: "dann denselben Namen eingeben",
    join: "Mitspielen",
    joinNow: "Jetzt mitspielen",
    joinNext: "Ab nächster Runde",
    rejoin: "Wieder einsteigen",
  },
};

const CSS = `
:host {
  all: initial; position: fixed; z-index: 2147483647; pointer-events: none;
  --bg: var(--tvpipe-join-bg, rgba(16, 17, 24, .84)); --fg: var(--tvpipe-join-fg, #fff); --accent: var(--tvpipe-join-accent, #8ee6a8);
  --x: var(--tvpipe-join-x, 2.2vw); --y: var(--tvpipe-join-y, 3vh);
  font: 500 2vh/1.25 var(--tvpipe-join-font, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif);
}
:host([data-corner^="bottom"]) { bottom: var(--y); }
:host([data-corner^="top"]) { top: var(--y); }
:host([data-corner$="right"]) { right: var(--x); }
:host([data-corner$="left"]) { left: var(--x); }
.mini, .card {
  box-sizing: border-box; background: var(--bg); color: var(--fg); border: var(--tvpipe-join-border, 0 none);
  -webkit-backdrop-filter: blur(1.4vh) saturate(1.4); backdrop-filter: blur(1.4vh) saturate(1.4);
  box-shadow: var(--tvpipe-join-shadow, 0 1.4vh 4vh rgba(0, 0, 0, .38), inset 0 0 0 .15vh rgba(255, 255, 255, .1));
}
.mini {
  display: none; grid-template-areas: "k" "q" "l"; justify-items: center; gap: .7vh; width: max-content; max-width: 26vh;
  padding: 1vh 1.1vh 1.1vh; border-radius: 1.8vh; text-align: center; transition: opacity .35s ease;
}
:host([data-layout="row"]) .mini {
  grid-template-areas: "q k" "q l"; grid-template-rows: 1fr 1fr; justify-items: start; column-gap: 1.4vh; row-gap: .5vh;
  max-width: 46vh; padding: 1vh 2vh 1vh 1vh; text-align: left;
}
.mini.shown { display: grid; }
.mini.under { opacity: 0; }
.mini .qr { grid-area: q; width: 15vh; height: 15vh; border-radius: .9vh; }
.mini .kicker { grid-area: k; justify-content: center; font-size: 1.45vh; letter-spacing: .1em; text-wrap: balance; }
.mini .link { grid-area: l; font-size: 2vh; }
:host([data-layout="row"]) .mini.nolink { grid-template-areas: "q k"; grid-template-rows: auto; }
:host([data-layout="row"]) .mini .kicker { align-self: end; justify-content: flex-start; font-size: 1.6vh; }
:host([data-layout="row"]) .mini.nolink .kicker { align-self: center; }
:host([data-layout="row"]) .mini .link { align-self: start; font-size: 2.1vh; }
.card {
  position: absolute; display: flex; align-items: center; gap: 1.8vh;
  padding: 1.3vh 2.4vh 1.3vh 1.3vh; border-radius: 2.4vh; width: max-content; max-width: 50vh;
  opacity: 0; transform: translateY(1.6vh) scale(.97);
  transition: opacity .4s ease, transform .5s cubic-bezier(.2, 1.2, .4, 1);
}
:host([data-corner^="bottom"]) .card { bottom: 0; }
:host([data-corner^="top"]) .card { top: 0; transform: translateY(-1.6vh) scale(.97); }
:host([data-corner$="right"]) .card { right: 0; }
:host([data-corner$="left"]) .card { left: 0; }
.card.on { opacity: 1; transform: none; }
.qr { flex: none; width: 14vh; height: 14vh; border-radius: 1.2vh; overflow: hidden; background: #fff; }
.qr svg { display: block; width: 100%; height: 100%; }
.text { display: flex; flex-direction: column; gap: .35vh; min-width: 0; }
.names { margin-bottom: .4vh; }
.kicker {
  display: flex; align-items: center; gap: .8vh; font-size: 1.5vh; font-weight: 700;
  letter-spacing: .14em; text-transform: uppercase; color: var(--accent);
}
.dot { width: 1vh; height: 1vh; border-radius: 50%; background: currentColor; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }
.names { font-size: 2.7vh; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hint { font-size: 1.75vh; opacity: .72; text-wrap: balance; }
.link { font-size: 2.3vh; font-weight: 700; letter-spacing: .01em; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .card, .mini { transition: opacity .3s; transform: none !important; } .dot { animation: none; } }
`;

/** Names on the badge at most (then `+N`). */
const MAX_NAMES = 3;

/** The badge on one page; {@link update} with each view. */
export class RejoinBadge {
  readonly #doc: Document;
  readonly #deps: Deps;
  readonly #delay: number;
  readonly #always: boolean;
  readonly #layout: "column" | "row";
  #corner: Corner;
  #el: HTMLElement | undefined;
  #mini: HTMLElement | undefined;
  #card: HTMLElement | undefined;
  /** Since when each player has been away (by id). */
  readonly #since = new Map<string, number>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #view: Record<string, any> = {};
  #suppressed = false;
  #shownKey = "";
  #miniKey = "";
  /** What `<html>` says of the badge now (`""`: nothing). */
  #reserved = "";
  readonly #onResize = () => this.#reserve();

  constructor(doc: Document, deps: Deps, options: RejoinBadgeOptions = {}) {
    this.#doc = doc;
    this.#deps = deps;
    this.#delay = options.delay ?? 4000;
    this.#always = options.always ?? true;
    this.#layout = options.layout ?? "column";
    this.#corner = options.corner ?? "bottom-right";
    (globalThis as { addEventListener?: (t: string, f: () => void) => void }).addEventListener?.("resize", this.#onResize);
  }

  get corner(): Corner {
    return this.#corner;
  }

  set corner(c: Corner) {
    this.#corner = c;
    this.#el?.setAttribute("data-corner", c);
    this.#reserved = "";
    this.#reserve();
  }

  /** The game shows its own join code now: the badge steps aside. */
  set suppressed(on: boolean) {
    if (on === this.#suppressed) return;
    this.#suppressed = on;
    this.#render();
  }

  get suppressed(): boolean {
    return this.#suppressed;
  }

  update(view: Record<string, any>): void {
    this.#view = view;
    const now = this.#deps.now();
    const away = new Set<string>();
    for (const p of Array.isArray(view["roster"]) ? view["roster"] : []) {
      if (p && typeof p.id === "string" && p.connected === false) away.add(p.id);
    }
    for (const id of [...this.#since.keys()]) if (!away.has(id)) this.#since.delete(id);
    for (const id of away) if (!this.#since.has(id)) this.#since.set(id, now);
    this.#render();
  }

  /** Who the badge names now (names of players away long enough, while a game runs). */
  missing(): string[] {
    const join = this.#view["join"];
    if (!join?.inProgress || !join.qr) return [];
    const now = this.#deps.now();
    const roster: any[] = Array.isArray(this.#view["roster"]) ? this.#view["roster"] : [];
    return roster.filter((p) => p && this.#since.has(p.id) && now - this.#since.get(p.id)! >= this.#delay).map((p) => String(p.name ?? ""));
  }

  /** Whether the small card with the join code shows now. */
  get showing(): boolean {
    return this.#always && !this.#suppressed && !!this.#view["join"]?.qr;
  }

  #texts(): Texts {
    const lang = (this.#doc.documentElement?.lang || "en").slice(0, 2).toLowerCase();
    return STRINGS[lang] ?? STRINGS["en"]!;
  }

  #render(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const names = this.#suppressed ? [] : this.missing();
    // Wake up when the next player has been away long enough.
    const now = this.#deps.now();
    const next = Math.min(...[...this.#since.values()].map((t) => t + this.#delay - now).filter((d) => d > 0));
    if (Number.isFinite(next)) this.#timer = setTimeout(() => this.#render(), next + 20);
    const join = this.#view["join"];
    const t = this.#texts();
    const mini = this.showing;
    if (mini || names.length > 0) this.#mount();
    if (this.#mini) {
      this.#mini.classList[mini ? "add" : "remove"]("shown");
      this.#mini.classList[names.length > 0 ? "add" : "remove"]("under");
      if (mini) {
        const link = this.#deps.joinText(join);
        const title = !join.inProgress ? t.join : join.lateJoin === "open" ? t.joinNow : join.lateJoin === "closed" ? t.rejoin : t.joinNext;
        const key = JSON.stringify([link, join.url, title]);
        if (key !== this.#miniKey) {
          this.#miniKey = key;
          this.#fillMini(link, join, title);
        }
      }
    }
    this.#reserve();
    if (names.length === 0) {
      this.#card?.classList.remove("on");
      this.#shownKey = "";
      return;
    }
    const link = this.#deps.joinText(join);
    const key = JSON.stringify([names, link, join.url, t.kicker, this.#corner]);
    if (key !== this.#shownKey) {
      this.#shownKey = key;
      this.#fill(names, link, join, t);
    }
    // After a style flush, so a new card slides in (no animation frame:
    // a page in the background, a hidden preview, gets none).
    const card = this.#card!;
    if (!card.classList.contains("on")) {
      void card.offsetWidth;
      card.classList.add("on");
    }
  }

  /** Tells the page where the small card is and how much room it takes (see the module). */
  #reserve(): void {
    const root = this.#doc.documentElement as HTMLElement | undefined;
    if (!root?.style || !root.setAttribute) return;
    let w = 0;
    let h = 0;
    const shown = this.showing && !!this.#el;
    if (shown) {
      const el = this.#el!;
      const cs = this.#doc.defaultView?.getComputedStyle?.(el);
      const px = (v: string | undefined) => (v ? parseFloat(v) || 0 : 0);
      w = el.offsetWidth + px(this.#corner.endsWith("right") ? cs?.right : cs?.left);
      h = el.offsetHeight + px(this.#corner.startsWith("bottom") ? cs?.bottom : cs?.top);
    }
    const key = shown ? `${this.#corner} ${Math.round(w)} ${Math.round(h)}` : "";
    if (key === this.#reserved) return;
    this.#reserved = key;
    if (shown) root.setAttribute("data-tvpipe-join", this.#corner);
    else root.removeAttribute?.("data-tvpipe-join");
    root.style.setProperty("--tvpipe-join-w", `${Math.round(w)}px`);
    root.style.setProperty("--tvpipe-join-h", `${Math.round(h)}px`);
  }

  #mount(): void {
    if (this.#el?.isConnected) return;
    const d = this.#doc;
    const el = d.createElement("tvpipe-rejoin");
    el.setAttribute("data-corner", this.#corner);
    el.setAttribute("data-layout", this.#layout);
    el.setAttribute("aria-live", "polite");
    const root = el.attachShadow({ mode: "open" });
    const style = d.createElement("style");
    style.textContent = CSS;
    const mini = d.createElement("div");
    mini.className = "mini";
    const card = d.createElement("div");
    card.className = "card";
    root.append(style, mini, card);
    (d.body ?? d.documentElement).append(el);
    this.#el = el;
    this.#mini = mini;
    this.#card = card;
    this.#miniKey = "";
    this.#shownKey = "";
  }

  #line(cls: string, text: string): HTMLElement {
    const e = this.#doc.createElement("div");
    e.className = cls;
    e.textContent = text;
    return e;
  }

  #fillMini(link: string | null, join: any, title: string): void {
    const qr = this.#doc.createElement("div");
    qr.className = "qr";
    qr.innerHTML = this.#deps.qrSvg(join.qr, { quiet: 2 });
    this.#mini!.classList[link ? "remove" : "add"]("nolink");
    this.#mini!.replaceChildren(this.#line("kicker", title), qr, ...(link ? [this.#line("link", link)] : []));
  }

  #fill(names: string[], link: string | null, join: any, t: Texts): void {
    const d = this.#doc;
    const card = this.#card!;
    const qr = d.createElement("div");
    qr.className = "qr";
    qr.innerHTML = this.#deps.qrSvg(join.qr, { quiet: 2 });
    const kicker = d.createElement("div");
    kicker.className = "kicker";
    const dot = d.createElement("span");
    dot.className = "dot";
    kicker.append(dot, t.kicker);
    const shown = names.slice(0, MAX_NAMES).join(", ");
    const who = this.#line("names", names.length > MAX_NAMES ? `${shown} +${names.length - MAX_NAMES}` : shown);
    const how = link ? [this.#line("hint", t.open), this.#line("link", link), this.#line("hint", t.name)] : [this.#line("hint", t.scan), this.#line("hint", t.name)];
    const text = d.createElement("div");
    text.className = "text";
    text.append(kicker, who, ...how);
    card.replaceChildren(qr, text);
  }

  /** Removes the badge from the page. */
  destroy(): void {
    if (this.#timer) clearTimeout(this.#timer);
    (globalThis as { removeEventListener?: (t: string, f: () => void) => void }).removeEventListener?.("resize", this.#onResize);
    this.#el?.remove();
    this.#el = undefined;
    this.#mini = undefined;
    this.#card = undefined;
    this.#reserved = "x";
    this.#reserve();
  }
}
