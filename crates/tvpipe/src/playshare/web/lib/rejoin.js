/**
 * The join badge: a small card in a corner of a TV page with the join QR
 * code and the short link to type, there the whole game long. People
 * join with it, and a player whose phone went away comes back with it
 * (the same name brings them back to their seat). {@link PartyClient}
 * draws it on screens by itself; games pick the corner, say when their
 * own join code is showing (the lobby: `client.joinVisible`), and keep
 * their picture out of the corner: while the card shows, `<html>` has
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
const STRINGS = {
    en: {
        join: "Join",
        joinNow: "Join now",
        joinNext: "Join next round",
        rejoin: "Rejoin",
    },
    de: {
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
.mini {
  box-sizing: border-box; background: var(--bg); color: var(--fg); border: var(--tvpipe-join-border, 0 none);
  -webkit-backdrop-filter: blur(1.4vh) saturate(1.4); backdrop-filter: blur(1.4vh) saturate(1.4);
  box-shadow: var(--tvpipe-join-shadow, 0 1.4vh 4vh rgba(0, 0, 0, .38), inset 0 0 0 .15vh rgba(255, 255, 255, .1));
  display: none; grid-template-areas: "k" "q" "l"; justify-items: center; gap: .7vh; width: max-content; max-width: 26vh;
  padding: 1vh 1.1vh 1.1vh; border-radius: 1.8vh; text-align: center;
}
:host([data-layout="row"]) .mini {
  grid-template-areas: "q k" "q l"; grid-template-rows: 1fr 1fr; justify-items: start; column-gap: 1.4vh; row-gap: .5vh;
  max-width: 46vh; padding: 1vh 2vh 1vh 1vh; text-align: left;
}
.mini.shown { display: grid; }
.qr { grid-area: q; width: 15vh; height: 15vh; border-radius: .9vh; overflow: hidden; background: #fff; }
.qr svg { display: block; width: 100%; height: 100%; }
.kicker {
  grid-area: k; display: flex; align-items: center; justify-content: center; font-size: 1.45vh; font-weight: 700;
  letter-spacing: .1em; text-transform: uppercase; color: var(--accent); text-wrap: balance;
}
.link { grid-area: l; font-size: 2vh; font-weight: 700; letter-spacing: .01em; white-space: nowrap; }
:host([data-layout="row"]) .mini.nolink { grid-template-areas: "q k"; grid-template-rows: auto; }
:host([data-layout="row"]) .kicker { align-self: end; justify-content: flex-start; font-size: 1.6vh; }
:host([data-layout="row"]) .mini.nolink .kicker { align-self: center; }
:host([data-layout="row"]) .link { align-self: start; font-size: 2.1vh; }
`;
/** The badge on one page; {@link update} with each view. */
export class RejoinBadge {
    #doc;
    #deps;
    #layout;
    #corner;
    #el;
    #mini;
    #view = {};
    #suppressed = false;
    #miniKey = "";
    /** What `<html>` says of the badge now (`""`: nothing). */
    #reserved = "";
    #onResize = () => this.#reserve();
    constructor(doc, deps, options = {}) {
        this.#doc = doc;
        this.#deps = deps;
        this.#layout = options.layout ?? "column";
        this.#corner = options.corner ?? "bottom-right";
        globalThis.addEventListener?.("resize", this.#onResize);
    }
    get corner() {
        return this.#corner;
    }
    set corner(c) {
        this.#corner = c;
        this.#el?.setAttribute("data-corner", c);
        this.#reserved = "";
        this.#reserve();
    }
    /** The game shows its own join code now: the badge steps aside. */
    set suppressed(on) {
        if (on === this.#suppressed)
            return;
        this.#suppressed = on;
        this.#render();
    }
    get suppressed() {
        return this.#suppressed;
    }
    update(view) {
        this.#view = view;
        this.#render();
    }
    /** Whether the card with the join code shows now. */
    get showing() {
        return !this.#suppressed && !!this.#view["join"]?.qr;
    }
    #texts() {
        const lang = (this.#doc.documentElement?.lang || "en").slice(0, 2).toLowerCase();
        return STRINGS[lang] ?? STRINGS["en"];
    }
    #render() {
        const join = this.#view["join"];
        const shown = this.showing;
        if (shown)
            this.#mount();
        if (this.#mini) {
            this.#mini.classList[shown ? "add" : "remove"]("shown");
            if (shown) {
                const t = this.#texts();
                const link = this.#deps.joinText(join);
                const title = !join.inProgress ? t.join : join.lateJoin === "open" ? t.joinNow : join.lateJoin === "closed" ? t.rejoin : t.joinNext;
                const key = JSON.stringify([link, join.url, title]);
                if (key !== this.#miniKey) {
                    this.#miniKey = key;
                    this.#fill(link, join, title);
                }
            }
        }
        this.#reserve();
    }
    /** Tells the page where the card is and how much room it takes (see the module). */
    #reserve() {
        const root = this.#doc.documentElement;
        if (!root?.style || !root.setAttribute)
            return;
        let w = 0;
        let h = 0;
        const shown = this.showing && !!this.#el;
        if (shown) {
            const el = this.#el;
            const cs = this.#doc.defaultView?.getComputedStyle?.(el);
            const px = (v) => (v ? parseFloat(v) || 0 : 0);
            w = el.offsetWidth + px(this.#corner.endsWith("right") ? cs?.right : cs?.left);
            h = el.offsetHeight + px(this.#corner.startsWith("bottom") ? cs?.bottom : cs?.top);
        }
        const key = shown ? `${this.#corner} ${Math.round(w)} ${Math.round(h)}` : "";
        if (key === this.#reserved)
            return;
        this.#reserved = key;
        if (shown)
            root.setAttribute("data-tvpipe-join", this.#corner);
        else
            root.removeAttribute?.("data-tvpipe-join");
        root.style.setProperty("--tvpipe-join-w", `${Math.round(w)}px`);
        root.style.setProperty("--tvpipe-join-h", `${Math.round(h)}px`);
    }
    #mount() {
        if (this.#el?.isConnected)
            return;
        const d = this.#doc;
        const el = d.createElement("tvpipe-rejoin");
        el.setAttribute("data-corner", this.#corner);
        el.setAttribute("data-layout", this.#layout);
        const root = el.attachShadow({ mode: "open" });
        const style = d.createElement("style");
        style.textContent = CSS;
        const mini = d.createElement("div");
        mini.className = "mini";
        root.append(style, mini);
        (d.body ?? d.documentElement).append(el);
        this.#el = el;
        this.#mini = mini;
        this.#miniKey = "";
    }
    #line(cls, text) {
        const e = this.#doc.createElement("div");
        e.className = cls;
        e.textContent = text;
        return e;
    }
    #fill(link, join, title) {
        const qr = this.#doc.createElement("div");
        qr.className = "qr";
        qr.innerHTML = this.#deps.qrSvg(join.qr, { quiet: 2 });
        this.#mini.classList[link ? "remove" : "add"]("nolink");
        this.#mini.replaceChildren(this.#line("kicker", title), qr, ...(link ? [this.#line("link", link)] : []));
    }
    /** Removes the badge from the page. */
    destroy() {
        globalThis.removeEventListener?.("resize", this.#onResize);
        this.#el?.remove();
        this.#el = undefined;
        this.#mini = undefined;
        this.#reserved = "x";
        this.#reserve();
    }
}
