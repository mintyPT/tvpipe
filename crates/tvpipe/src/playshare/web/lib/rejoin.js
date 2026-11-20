/**
 * The rejoin badge: a small card a TV page shows in a corner while a
 * game runs and a player's phone has been away for a few seconds: the
 * join QR code, the short link to type, and who is missing. Scanning it
 * (or typing the link and the same name) brings the player back to
 * their seat ({@link PartyClient} draws it on screens by itself; games
 * only pick the corner, or say when their own join code is showing).
 *
 * It lives in a shadow root (the game's styles do not reach it, its own
 * do not leak), takes no pointer events and sizes itself by the
 * viewport's height, like the TV pages do.
 */
const STRINGS = {
    en: { kicker: "Rejoin", scan: "Scan the code", open: "Scan or open", name: "and enter the same name" },
    de: { kicker: "Wieder einsteigen", scan: "Code scannen", open: "Scannen oder öffnen:", name: "dann denselben Namen eingeben" },
};
const CSS = `
:host { all: initial; position: fixed; z-index: 2147483647; pointer-events: none; }
:host([data-corner^="bottom"]) { bottom: 3vh; }
:host([data-corner^="top"]) { top: 3vh; }
:host([data-corner$="right"]) { right: 2.2vw; }
:host([data-corner$="left"]) { left: 2.2vw; }
.card {
  display: flex; align-items: center; gap: 1.8vh; box-sizing: border-box;
  padding: 1.3vh 2.4vh 1.3vh 1.3vh; border-radius: 2.4vh; max-width: 46vh;
  background: rgba(16, 17, 24, .84); color: #fff;
  -webkit-backdrop-filter: blur(1.4vh) saturate(1.4); backdrop-filter: blur(1.4vh) saturate(1.4);
  box-shadow: 0 1.4vh 4vh rgba(0, 0, 0, .38), inset 0 0 0 .15vh rgba(255, 255, 255, .1);
  font: 500 2vh/1.25 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  opacity: 0; transform: translateY(1.6vh) scale(.97);
  transition: opacity .4s ease, transform .5s cubic-bezier(.2, 1.2, .4, 1);
}
:host([data-corner^="top"]) .card { transform: translateY(-1.6vh) scale(.97); }
.card.on { opacity: 1; transform: none; }
.qr { flex: none; width: 14vh; height: 14vh; border-radius: 1.2vh; overflow: hidden; background: #fff; }
.qr svg { display: block; width: 100%; height: 100%; }
.text { display: flex; flex-direction: column; gap: .35vh; min-width: 0; }
.names { margin-bottom: .4vh; }
.kicker {
  display: flex; align-items: center; gap: .8vh; font-size: 1.5vh; font-weight: 700;
  letter-spacing: .14em; text-transform: uppercase; color: #8ee6a8;
}
.dot { width: 1vh; height: 1vh; border-radius: 50%; background: currentColor; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }
.names { font-size: 2.7vh; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hint { font-size: 1.75vh; color: rgba(255, 255, 255, .72); white-space: nowrap; }
.link { font-size: 2.3vh; font-weight: 700; color: #fff; letter-spacing: .01em; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .card { transition: opacity .3s; transform: none !important; } .dot { animation: none; } }
`;
/** Names on the badge at most (then `+N`). */
const MAX_NAMES = 3;
/** The badge on one page; {@link update} with each view. */
export class RejoinBadge {
    #doc;
    #deps;
    #delay;
    #corner;
    #el;
    #card;
    /** Since when each player has been away (by id). */
    #since = new Map();
    #timer;
    #view = {};
    #suppressed = false;
    #shownKey = "";
    constructor(doc, deps, options = {}) {
        this.#doc = doc;
        this.#deps = deps;
        this.#delay = options.delay ?? 4000;
        this.#corner = options.corner ?? "bottom-right";
    }
    get corner() {
        return this.#corner;
    }
    set corner(c) {
        this.#corner = c;
        this.#el?.setAttribute("data-corner", c);
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
        const now = this.#deps.now();
        const away = new Set();
        for (const p of Array.isArray(view["roster"]) ? view["roster"] : []) {
            if (p && typeof p.id === "string" && p.connected === false)
                away.add(p.id);
        }
        for (const id of [...this.#since.keys()])
            if (!away.has(id))
                this.#since.delete(id);
        for (const id of away)
            if (!this.#since.has(id))
                this.#since.set(id, now);
        this.#render();
    }
    /** Who the badge names now (names of players away long enough, while a game runs). */
    missing() {
        const join = this.#view["join"];
        if (!join?.inProgress || !join.qr)
            return [];
        const now = this.#deps.now();
        const roster = Array.isArray(this.#view["roster"]) ? this.#view["roster"] : [];
        return roster.filter((p) => p && this.#since.has(p.id) && now - this.#since.get(p.id) >= this.#delay).map((p) => String(p.name ?? ""));
    }
    #render() {
        if (this.#timer)
            clearTimeout(this.#timer);
        this.#timer = undefined;
        const names = this.#suppressed ? [] : this.missing();
        // Wake up when the next player has been away long enough.
        const now = this.#deps.now();
        const next = Math.min(...[...this.#since.values()].map((t) => t + this.#delay - now).filter((d) => d > 0));
        if (Number.isFinite(next))
            this.#timer = setTimeout(() => this.#render(), next + 20);
        if (names.length === 0) {
            this.#card?.classList.remove("on");
            this.#shownKey = "";
            return;
        }
        const join = this.#view["join"];
        const link = this.#deps.joinText(join);
        const lang = (this.#doc.documentElement?.lang || "en").slice(0, 2).toLowerCase();
        const key = JSON.stringify([names, link, join.url, lang, this.#corner]);
        this.#mount();
        if (key !== this.#shownKey) {
            this.#shownKey = key;
            this.#fill(names, link, join, STRINGS[lang] ?? STRINGS["en"]);
        }
        // After a style flush, so a new card slides in (no animation frame:
        // a page in the background, a hidden preview, gets none).
        const card = this.#card;
        if (!card.classList.contains("on")) {
            void card.offsetWidth;
            card.classList.add("on");
        }
    }
    #mount() {
        if (this.#el?.isConnected)
            return;
        const d = this.#doc;
        const el = d.createElement("tvpipe-rejoin");
        el.setAttribute("data-corner", this.#corner);
        el.setAttribute("aria-live", "polite");
        const root = el.attachShadow({ mode: "open" });
        const style = d.createElement("style");
        style.textContent = CSS;
        const card = d.createElement("div");
        card.className = "card";
        root.append(style, card);
        (d.body ?? d.documentElement).append(el);
        this.#el = el;
        this.#card = card;
    }
    #fill(names, link, join, t) {
        const d = this.#doc;
        const card = this.#card;
        const qr = d.createElement("div");
        qr.className = "qr";
        qr.innerHTML = this.#deps.qrSvg(join.qr, { quiet: 2 });
        const kicker = d.createElement("div");
        kicker.className = "kicker";
        const dot = d.createElement("span");
        dot.className = "dot";
        kicker.append(dot, t.kicker);
        const who = d.createElement("div");
        who.className = "names";
        const shown = names.slice(0, MAX_NAMES).join(", ");
        who.textContent = names.length > MAX_NAMES ? `${shown} +${names.length - MAX_NAMES}` : shown;
        const line = (cls, text) => {
            const e = d.createElement("div");
            e.className = cls;
            e.textContent = text;
            return e;
        };
        const how = link ? [line("hint", t.open), line("link", link), line("hint", t.name)] : [line("hint", t.scan), line("hint", t.name)];
        const text = d.createElement("div");
        text.className = "text";
        text.append(kicker, who, ...how);
        card.replaceChildren(qr, text);
    }
    /** Removes the badge from the page. */
    destroy() {
        if (this.#timer)
            clearTimeout(this.#timer);
        this.#el?.remove();
        this.#el = undefined;
        this.#card = undefined;
    }
}
