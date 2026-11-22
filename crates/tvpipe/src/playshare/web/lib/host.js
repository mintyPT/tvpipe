/**
 * The standard host page (docs/party-design.md §9): the window people
 * run the party from. A game describes its settings as data (a list of
 * {@link Field}s: a label, the choices, how to read and change the
 * value) and gets the whole page: its logo and status, the join QR code
 * and link, the TVs, the players (VIP, rejoin codes, removing), the
 * settings form, Start and End, a preview of the TV, the bots in test
 * mode. The page speaks the room's language (its own texts in English
 * and German; a game's labels are {@link Text}s per language), keeps
 * the host's settings and language in the page's `localStorage` (a
 * reload keeps them; tvpipe's own window has a temporary profile, so a
 * new run starts afresh), and lays out for long words: every label sits
 * above its control, at least 240 px wide, and a control is as wide as
 * its column.
 *
 *   const page = await HostPage.connect({ name: "quiz", title: "Quiz", lang: preferredLang("quiz", LANGS) });
 *   const party = await page.tvpipe.party();
 *   const game = new Quiz(party);
 *   page.run({ party, game, lang: () => game.lang, settings: [
 *     languageField({ langs: LANGS, get: () => game.lang, set: (l) => game.configure({ lang: l }) }),
 *     { key: "rounds", type: "buttons", label: { en: "Rounds", de: "Runden" },
 *       choices: [1, 2, 3].map((n) => ({ value: n, label: String(n) })),
 *       get: () => game.rounds, set: (n) => game.configure({ rounds: n }) },
 *   ] });
 *   game.on("settings", () => page.update());
 *
 * A game that wants a page of its own skips this module, or uses only
 * {@link SettingsForm} (the form alone, in any element). The page is
 * styled through CSS variables (`--bg`, `--card`, `--line`, `--text`,
 * `--muted`, `--accent`, `--accent-text`, `--link`, `--ok`, `--error`)
 * and `.logo`; its own rules sit in the `tvpipe` cascade layer, so any
 * rule of the game's stylesheet wins.
 *
 * @module
 */
import { qrSvg } from "./client.js";
import { Tvpipe } from "./tvpipe.js";
/** `text` in `lang` (see {@link Text}). */
export function textIn(text, lang) {
    if (text === undefined)
        return "";
    if (typeof text === "string")
        return text;
    if (typeof text === "function")
        return text(lang);
    return text[lang] ?? text["en"] ?? Object.values(text)[0] ?? "";
}
/** The page's own texts. */
const STRINGS = {
    en: {
        onTv: "On the TV",
        noTv: "No TV: open the TV view on a screen yourself.",
        tryAgain: "Try again",
        openTv: "Open the TV view",
        changeTv: "Change TVs…",
        players: "Players",
        noPlayers: "Nobody yet: scan the code to join.",
        addBot: "Add a bot",
        addBots: "Add 3 bots",
        settings: "Settings",
        lockedHint: "Settings change between games.",
        end: "End",
        otherGame: "Other game",
        otherGameTitle: "Pick another game: the TVs and the join link stay, phones follow",
        otherGameSure: "Switch to another game? This one ends for everybody.",
        previewNote: "What the TV shows (a preview, no sound). The VIP's phone can start the game too.",
        preview: "What the TV shows",
        copy: "Copy",
        copied: "Copied",
        lanOnly: "Phones on this Wi-Fi join with the QR code.",
        scanQr: "Phones join with the QR code or the link (it is on the TV too).",
        opening: "Opening a public link…",
        localOnly: "This computer only (no public link).",
        vip: "VIP",
        waiting: "waiting",
        away: "away",
        remove: (name) => `Remove ${name}`,
        removeSure: "Remove?",
        rejoin: "Rejoin code",
        rejoinTitle: (name) => `Show ${name} a code to get back in on any phone`,
        makeVip: "Make VIP",
        makeVipTitle: (name) => `Make ${name} the VIP`,
        playing: "Playing…",
        waitingMore: (n) => (n === 1 ? "Waiting for 1 more" : `Waiting for ${n} more`),
        start: "Start the game",
        lobby: "Lobby",
        browserTab: "A browser tab",
        showing: "showing",
        connected: "connected",
        starting: (to) => `Starting${to?.length ? `: ${to.join(", ")}` : ""}…`,
        tvFailed: (e) => `The TV failed: ${e}`,
        tvState: (s) => `The TV: ${s}`,
        noTvpipe: (msg) => `${msg}. Start the game with tvpipe game play.`,
        stopped: "tvpipe stopped: the game is over.",
        botFailed: (msg) => `A bot could not join: ${msg}`,
        language: "Language",
        latecomers: "Latecomers",
        late: { wait: "join at the next round", open: "join anytime", closed: "not during a game" },
        on: "on",
        off: "off",
        webOnTv: "Screen",
        webChangeTv: "Change screen…",
        webNoTv: "Other screens join at tvpipe.party/tv with the code.",
    },
    de: {
        onTv: "Am Fernseher",
        noTv: "Kein Fernseher: Öffne die TV-Ansicht selbst auf einem Bildschirm.",
        tryAgain: "Nochmal versuchen",
        openTv: "TV-Ansicht öffnen",
        changeTv: "Fernseher wechseln…",
        players: "Spieler",
        noPlayers: "Noch niemand da: Zum Mitspielen den Code scannen.",
        addBot: "Bot dazu",
        addBots: "3 Bots dazu",
        settings: "Einstellungen",
        lockedHint: "Einstellungen ändern sich zwischen den Spielen.",
        end: "Beenden",
        otherGame: "Anderes Spiel",
        otherGameTitle: "Ein anderes Spiel wählen: Fernseher und Link bleiben, die Handys wechseln mit",
        otherGameSure: "Zu einem anderen Spiel wechseln? Dieses endet für alle.",
        previewNote: "Was der Fernseher zeigt (Vorschau, ohne Ton). Der VIP kann das Spiel auch am Handy starten.",
        preview: "Was der Fernseher zeigt",
        copy: "Kopieren",
        copied: "Kopiert",
        lanOnly: "Handys in diesem WLAN spielen über den QR-Code mit.",
        scanQr: "Mitspielen über den QR-Code oder den Link (beides auch am Fernseher).",
        opening: "Öffentlicher Link wird geöffnet…",
        localOnly: "Nur dieser Computer (kein öffentlicher Link).",
        vip: "VIP",
        waiting: "wartet",
        away: "weg",
        remove: (name) => `${name} entfernen`,
        removeSure: "Entfernen?",
        rejoin: "Rückkehrcode",
        rejoinTitle: (name) => `${name} einen Code zeigen, um mit jedem Handy zurückzukommen`,
        makeVip: "Zum VIP",
        makeVipTitle: (name) => `${name} zum VIP machen`,
        playing: "Spiel läuft…",
        waitingMore: (n) => (n === 1 ? "Warte auf 1 weitere Person" : `Warte auf ${n} weitere Personen`),
        start: "Spiel starten",
        lobby: "Lobby",
        browserTab: "Ein Browser-Tab",
        showing: "zeigt an",
        connected: "verbunden",
        starting: (to) => `Startet${to?.length ? `: ${to.join(", ")}` : ""}…`,
        tvFailed: (e) => `Fehler am Fernseher: ${e}`,
        tvState: (s) => `Fernseher: ${s}`,
        noTvpipe: (msg) => `${msg}. Starte das Spiel mit tvpipe game play.`,
        stopped: "tvpipe wurde beendet: Das Spiel ist vorbei.",
        botFailed: (msg) => `Ein Bot konnte nicht beitreten: ${msg}`,
        language: "Sprache",
        latecomers: "Nachzügler",
        late: { wait: "ab der nächsten Runde", open: "jederzeit", closed: "nicht während eines Spiels" },
        on: "an",
        off: "aus",
        webOnTv: "Bildschirm",
        webChangeTv: "Bildschirm wechseln…",
        webNoTv: "Weitere Bildschirme kommen über tvpipe.party/tv und den Code dazu.",
    },
};
/** The page's own texts in `lang` (English for a language it does not speak). */
export function hostStrings(lang) {
    return STRINGS[lang] ?? STRINGS.en;
}
/** Languages by their own names (the language setting's choices). */
const LANGUAGE_NAMES = {
    en: "English",
    de: "Deutsch",
    fr: "Français",
    es: "Español",
    it: "Italiano",
    nl: "Nederlands",
    pt: "Português",
    pl: "Polski",
    sv: "Svenska",
    da: "Dansk",
    nb: "Norsk",
    fi: "Suomi",
    cs: "Čeština",
    tr: "Türkçe",
    ja: "日本語",
};
/**
 * The room's language: its choices by their own names, a language the
 * game cannot play now (`available` says no) greyed out.
 */
export function languageField(o) {
    return {
        key: "lang",
        label: (l) => hostStrings(l).language,
        choices: o.langs.map((l) => ({
            value: l,
            label: LANGUAGE_NAMES[l] ?? l,
            disabled: () => (o.available ? !o.available(l) : false),
            title: o.unavailable,
        })),
        get: o.get,
        set: o.set,
    };
}
/**
 * Who may join during a game ({@link LateJoin}): `allowed` in this
 * order (default all three). `changed` runs after a change (to show it
 * to the phones, say).
 */
export function lateJoinField(party, allowed = ["wait", "open", "closed"], changed) {
    return {
        key: "late",
        label: (l) => hostStrings(l).latecomers,
        choices: allowed.map((m) => ({ value: m, label: (l) => hostStrings(l).late[m] })),
        // A mode this game does not offer reads as the nearest it does.
        get: () => (allowed.includes(party.lateJoin) ? party.lateJoin : party.lateJoin === "open" && allowed.includes("wait") ? "wait" : allowed[0]),
        set: (m) => {
            party.lateJoin = m;
            changed?.(m);
        },
    };
}
const STORE = (name) => `${name}:host`;
function loadSaved(name) {
    try {
        const v = globalThis.localStorage?.getItem(STORE(name));
        const s = v ? JSON.parse(v) : {};
        return s && typeof s === "object" ? s : {};
    }
    catch {
        return {};
    }
}
function saveSaved(name, s) {
    try {
        globalThis.localStorage?.setItem(STORE(name), JSON.stringify(s));
    }
    catch {
        // Full or blocked: this party still has them.
    }
}
/**
 * The language a host page starts in: the last one picked in this
 * browser (for the game `name`), else the browser's, else `langs[0]`.
 */
export function preferredLang(name, langs) {
    const pick = (s) => {
        if (typeof s !== "string")
            return undefined;
        const two = s.slice(0, 2).toLowerCase();
        return langs.find((l) => l === s || l === two);
    };
    let old = null;
    try {
        old = globalThis.localStorage?.getItem(`${name}:host-lang`) ?? null;
    }
    catch { }
    const nav = globalThis.navigator;
    return pick(loadSaved(name).lang) ?? pick(old) ?? pick(nav?.languages?.[0]) ?? pick(nav?.language) ?? langs[0];
}
const CSS = `
@layer tvpipe {
  :root { color-scheme: dark; --bg: #16181f; --card: #222530; --line: #343846; --text: #f3f3f6; --muted: #a3a7b6; --accent: #ffcf3f; --accent-text: #241a00; --link: var(--accent); --ok: #7dffa8; --error: #ff7a8a; font: 15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--bg); color: var(--text); height: 100vh; overflow: hidden; }
  .tvh { display: grid; grid-template-columns: minmax(340px, 400px) minmax(0, 1fr); height: 100vh; }
  .tvh-side { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); }
  .tvh-scroll { flex: 1; overflow-y: auto; padding: 20px 22px 12px; display: flex; flex-direction: column; gap: 18px; }
  .tvh-main { overflow-y: auto; padding: 22px 26px; display: flex; flex-direction: column; gap: 22px; min-width: 0; }
  .tvh header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .tvh .logo { font-size: 24px; font-weight: 800; color: var(--accent); }
  .tvh-status { color: var(--muted); text-align: right; overflow-wrap: anywhere; }
  .tvh h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; margin: 0 0 6px; color: var(--muted); font-weight: 650; }
  .tvh-muted { color: var(--muted); margin: 0; }
  .tvh-small { font-size: 12.5px; }
  .tvh-join { display: flex; gap: 14px; align-items: center; }
  .tvh-qr { width: 120px; height: 120px; flex: none; background: #fff; border-radius: 10px; overflow: hidden; }
  .tvh-qr svg { width: 100%; height: 100%; display: block; }
  .tvh-join-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
  .tvh-link { display: flex; gap: 6px; align-items: center; }
  .tvh-url { flex: 1; min-width: 0; font: 500 12px ui-monospace, "SF Mono", Menlo, monospace; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: all; }
  .tvh ul { list-style: none; margin: 0; padding: 0; }
  .tvh-list li { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--line); min-height: 34px; }
  .tvh-list li.tvh-empty { color: var(--muted); border-bottom: 0; }
  .tvh-who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .tvh-list li.away .tvh-who { opacity: .5; }
  .tvh-end { display: flex; gap: 6px; align-items: center; flex: none; }
  .tvh-tag { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .tvh-tag.ok { color: var(--ok); }
  .tvh-tag.bad { color: var(--error); white-space: normal; text-align: right; }
  .tvh-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; align-items: center; }
  .tvh select, .tvh button { font: inherit; color: var(--text); background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; }
  .tvh button { cursor: pointer; }
  .tvh button:disabled, .tvh select:disabled { opacity: .45; cursor: default; }
  .tvh button.tvh-primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 700; padding: 10px 20px; flex: 1; }
  .tvh button.tvh-quiet { background: none; }
  .tvh button.tvh-act { font-size: 12px; padding: 1px 8px; white-space: nowrap; }
  .tvh button.tvh-kick { background: none; border-color: transparent; color: var(--muted); }
  .tvh button.tvh-kick.sure { color: var(--error); border-color: var(--error); }
  .tvh a { color: var(--link); }
  .tvh-foot { display: flex; flex-wrap: wrap; gap: 10px; padding: 14px 22px 18px; border-top: 1px solid var(--line); }
  .tvh-foot button.tvh-primary { flex: 1 1 100%; }
  .tvh-foot button.tvh-quiet { flex: 1 1 0; }
  .tvh-error { color: var(--error); margin: 0; padding: 0 22px 14px; }
  .tvh-preview { width: min(100%, 80vh); align-self: center; }
  .tvh-screen { width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; overflow: hidden; border: 1px solid var(--line); }
  .tvh-screen iframe { border: 0; transform-origin: 0 0; display: block; }
  .tvh-preview p { margin-top: 6px; }
  .tvh-settings h2 { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .tvh-settings h2 .tvh-small { text-transform: none; letter-spacing: 0; font-weight: 400; }
  .tvh-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px 22px; align-items: start; }
  .tvh-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .tvh-label { font-weight: 600; }
  .tvh-hint { color: var(--muted); font-size: 12.5px; }
  .tvh-field select { width: 100%; }
  .tvh-seg { display: flex; flex-wrap: wrap; gap: 6px; }
  .tvh-seg button { min-width: 42px; padding: 6px 10px; }
  .tvh-seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 700; }
  .tvh-toggle { flex-direction: row; align-items: flex-start; gap: 12px; cursor: pointer; }
  .tvh-toggle > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .tvh-toggle input { appearance: none; flex: none; width: 40px; height: 24px; margin: 0; border-radius: 12px; background: var(--card); border: 1px solid var(--line); position: relative; cursor: pointer; transition: background .15s; }
  .tvh-toggle input::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--muted); transition: transform .15s, background .15s; }
  .tvh-toggle input:checked { background: var(--accent); border-color: var(--accent); }
  .tvh-toggle input:checked::after { transform: translateX(16px); background: var(--accent-text); }
  .tvh-toggle input:disabled { opacity: .45; cursor: default; }
  .tvh-toggle input:focus-visible, .tvh-seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (max-width: 760px) {
    body { height: auto; overflow: auto; }
    .tvh { display: flex; flex-direction: column; height: auto; }
    .tvh-side { border-right: 0; border-bottom: 1px solid var(--line); }
    .tvh-main { overflow: visible; }
  }
}
`;
function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    const { class: cls, ...rest } = props;
    if (cls)
        e.className = cls;
    Object.assign(e, rest);
    e.append(...children);
    return e;
}
function choicesOf(f) {
    return typeof f.choices === "function" ? f.choices() : f.choices;
}
const isOff = (d) => (typeof d === "function" ? d() : !!d);
/**
 * A settings form from a list of {@link Field}s, in any element: each
 * field a label over its control (a dropdown, a row of buttons or a
 * switch) and an optional hint. {@link HostPage} uses it; a host page of
 * a game's own can too.
 */
export class SettingsForm {
    element;
    #fields;
    #parts = new Map();
    #lang;
    #locked = false;
    /** After the host changed a setting (it went through): `(key, value)`. */
    onChange;
    /** A setting refused the change (the field's `set` threw). */
    onError;
    constructor(fields, lang) {
        this.#fields = fields;
        this.#lang = lang;
        this.element = el("div", { class: "tvh-fields" });
        for (const f of fields) {
            const part = f.type === "toggle" ? this.#toggle(f) : f.type === "buttons" ? this.#buttons(f) : this.#select(f);
            this.#parts.set(f.key, part);
            this.element.append(part.box);
        }
        this.update();
    }
    get fields() {
        return this.#fields;
    }
    /** Draws every value, label and choice again (the language, the game's values). */
    update(o = {}) {
        if (o.lang !== undefined)
            this.#lang = o.lang;
        if (o.locked !== undefined)
            this.#locked = o.locked;
        for (const f of this.#fields) {
            const part = this.#parts.get(f.key);
            part.box.hidden = f.hidden?.() ?? false;
            part.render();
        }
    }
    /**
     * Changes a setting as if the host had: `value` as a choice's value
     * (or its string). For tests and checks.
     */
    set(key, value) {
        const f = this.#fields.find((x) => x.key === key);
        if (!f)
            throw new Error(`no setting ${key}`);
        if (f.type === "toggle") {
            this.#apply(f, value === true || value === "on" || value === "true");
            return;
        }
        const c = choicesOf(f).find((x) => x.value === value || String(x.value) === String(value));
        if (!c)
            throw new Error(`${key}: no choice ${String(value)}`);
        this.#apply(f, c.value);
    }
    #disabled(f) {
        return this.#locked && !f.live;
    }
    #apply(f, v) {
        try {
            f.set(v);
            this.onChange?.(f.key, f.get());
        }
        catch (err) {
            this.onError?.(err);
        }
        this.update();
    }
    #head(box) {
        const label = el("span", { class: "tvh-label" });
        const hint = el("span", { class: "tvh-hint" });
        box.append(label);
        return { label, hint };
    }
    #select(f) {
        const box = el("label", { class: "tvh-field", htmlFor: f.key });
        const { label, hint } = this.#head(box);
        const select = el("select", { id: f.key });
        box.append(select, hint);
        let shown = "";
        select.onchange = () => {
            const c = choicesOf(f)[select.selectedIndex];
            if (c)
                this.#apply(f, c.value);
        };
        return {
            box,
            render: () => {
                const choices = choicesOf(f);
                const key = JSON.stringify(choices.map((c) => [String(c.value), textIn(c.label, this.#lang), isOff(c.disabled), textIn(c.title, this.#lang)]));
                if (key !== shown) {
                    shown = key;
                    select.replaceChildren(...choices.map((c) => {
                        const off = isOff(c.disabled);
                        const title = off ? textIn(c.title, this.#lang) : "";
                        return el("option", { value: String(c.value), textContent: textIn(c.label, this.#lang), disabled: off, title });
                    }));
                }
                const v = f.get();
                const i = choices.findIndex((c) => c.value === v);
                select.selectedIndex = i;
                select.disabled = this.#disabled(f);
                label.textContent = textIn(f.label, this.#lang);
                hint.textContent = textIn(f.hint, this.#lang);
                hint.hidden = !hint.textContent;
            },
        };
    }
    #buttons(f) {
        const box = el("div", { class: "tvh-field", role: "group" });
        const { label, hint } = this.#head(box);
        label.id = `${f.key}-label`;
        box.setAttribute("aria-labelledby", label.id);
        const row = el("div", { class: "tvh-seg", id: f.key });
        box.append(row, hint);
        let shown = "";
        return {
            box,
            render: () => {
                const choices = choicesOf(f);
                const key = JSON.stringify(choices.map((c) => [String(c.value), textIn(c.label, this.#lang)]));
                if (key !== shown) {
                    shown = key;
                    row.replaceChildren(...choices.map((c) => {
                        const b = el("button", { type: "button", textContent: textIn(c.label, this.#lang) });
                        b.dataset["value"] = String(c.value);
                        b.onclick = () => {
                            if (f.get() !== c.value)
                                this.#apply(f, c.value);
                        };
                        return b;
                    }));
                }
                const v = f.get();
                const locked = this.#disabled(f);
                choices.forEach((c, i) => {
                    const b = row.children[i];
                    b.setAttribute("aria-pressed", String(c.value === v));
                    b.disabled = locked || isOff(c.disabled);
                    b.title = isOff(c.disabled) ? textIn(c.title, this.#lang) : "";
                });
                label.textContent = textIn(f.label, this.#lang);
                hint.textContent = textIn(f.hint, this.#lang);
                hint.hidden = !hint.textContent;
            },
        };
    }
    #toggle(f) {
        const input = el("input", { type: "checkbox", id: f.key });
        input.setAttribute("role", "switch");
        const label = el("span", { class: "tvh-label" });
        const hint = el("span", { class: "tvh-hint" });
        const box = el("label", { class: "tvh-field tvh-toggle", htmlFor: f.key }, input, el("span", {}, label, hint));
        input.onchange = () => this.#apply(f, input.checked);
        return {
            box,
            render: () => {
                input.checked = f.get();
                input.disabled = this.#disabled(f) || (!input.checked && (f.disabled?.() ?? false));
                label.textContent = textIn(f.label, this.#lang);
                hint.textContent = textIn(f.hint, this.#lang);
                hint.hidden = !hint.textContent;
            },
        };
    }
}
/**
 * The standard host page: {@link HostPage.connect} draws it and connects
 * to tvpipe (a failure is shown on it and thrown), {@link HostPage.run}
 * fills it in for a party and its game.
 */
export class HostPage {
    tvpipe;
    name;
    /** The page's parts, by role (for a game that adds to them). */
    parts;
    #lang;
    #run;
    #form;
    #cast;
    #confirmKick;
    #confirmTimer;
    #playersKey = "";
    #copied = false;
    #error;
    #saved = {};
    /** Whether {@link update} drew the page's texts in its language yet. */
    #drawn = false;
    /** Draws the page in `o.root` and connects to tvpipe. */
    static async connect(o) {
        const root = o.root ?? document.body;
        let tvpipe;
        try {
            tvpipe = await Tvpipe.connect(o);
        }
        catch (err) {
            const page = new HostPage(undefined, o, root);
            page.error(hostStrings(o.lang).noTvpipe(err.message));
            throw err;
        }
        return new HostPage(tvpipe, o, root);
    }
    constructor(tvpipe, o, root) {
        this.tvpipe = tvpipe;
        this.name = o.name;
        this.#lang = o.lang;
        if (!document.getElementById("tvpipe-host-css")) {
            // First in <head>: the game's stylesheet comes after (and the layer loses to it anyway).
            document.head.prepend(el("style", { id: "tvpipe-host-css", textContent: CSS }));
        }
        const t = hostStrings(this.#lang);
        const status = el("span", { class: "tvh-status", id: "phase" });
        const join = el("section", { class: "tvh-join" }, el("div", { class: "tvh-qr", id: "qr" }), el("div", { class: "tvh-join-text" }, el("p", { class: "tvh-muted tvh-small", id: "link-note" }), el("div", { class: "tvh-link" }, el("span", { class: "tvh-url", id: "join-url" }), el("button", { class: "tvh-act", id: "copy-link", textContent: t.copy }))));
        const tvs = el("section", {}, el("h2", { id: "on-tv" }), el("ul", { class: "tvh-list", id: "tvs" }), el("div", { class: "tvh-row" }, el("button", { id: "change-tv" }), el("button", { id: "cast-again", hidden: true }), el("a", { id: "player", href: "#", target: "_blank", hidden: true })));
        const players = el("section", {}, el("h2", {}, el("span", { id: "players-title" }), " ", el("span", { class: "tvh-muted", id: "count" })), el("ul", { class: "tvh-list", id: "players" }), el("div", { class: "tvh-row", id: "bots", hidden: true }, el("button", { id: "bot1" }), el("button", { id: "bot3" })));
        const foot = el("footer", { class: "tvh-foot" }, el("button", { class: "tvh-primary", id: "start", disabled: true }), el("button", { class: "tvh-quiet", id: "other-game", hidden: true }), el("button", { class: "tvh-quiet", id: "quit" }));
        this.#error = el("p", { class: "tvh-error", id: "error", hidden: true });
        const side = el("aside", { class: "tvh-side" }, el("div", { class: "tvh-scroll" }, el("header", {}, el("span", { class: "logo", textContent: o.title }), status), join, tvs, players), foot, this.#error);
        const settings = el("section", { class: "tvh-settings", hidden: true }, el("h2", {}, el("span", { id: "settings-title" }), el("span", { class: "tvh-small", id: "settings-locked", hidden: true })));
        const preview = el("div", { class: "tvh-preview" }, el("div", { class: "tvh-screen" }, el("iframe", { id: "preview" })), el("p", { class: "tvh-muted tvh-small", id: "preview-note" }));
        const main = el("main", { class: "tvh-main" }, preview, settings);
        const page = el("div", { class: "tvh" }, side, main);
        root.replaceChildren(page);
        this.parts = { root: page, side, main, status, join, tvs, players, settings, foot };
        this.#texts();
    }
    get lang() {
        return this.#lang;
    }
    /** Shows an error under Start (`null` hides it). */
    error(text) {
        this.#error.hidden = !text;
        this.#error.textContent = text ?? "";
    }
    /** The settings form (after {@link run}). */
    get form() {
        return this.#form;
    }
    /** Changes a setting as if the host had (tests and checks): see {@link SettingsForm.set}. */
    set(key, value) {
        this.#form?.set(key, value);
    }
    /** Shows the party and its game; restores the host's last settings. */
    run(o) {
        this.#run = o;
        const { party, game } = o;
        const remember = o.remember !== false;
        this.#saved = remember ? loadSaved(this.name) : {};
        // The last party's settings, as far as this one takes them.
        const saved = this.#saved.settings ?? {};
        for (const f of o.settings) {
            if (f.remember === false || !(f.key in saved))
                continue;
            const v = saved[f.key];
            try {
                if (f.type === "toggle") {
                    if (typeof v === "boolean" && v !== f.get() && !(v && f.disabled?.()))
                        f.set(v);
                }
                else {
                    const c = choicesOf(f).find((x) => x.value === v);
                    if (c && c.value !== f.get() && !isOff(c.disabled))
                        f.set(c.value);
                }
            }
            catch {
                // Not here (another language's data, say): the game's default.
            }
        }
        this.#lang = o.lang();
        const form = new SettingsForm(o.settings, this.#lang);
        this.#form = form;
        form.onError = (err) => this.error(err.message);
        form.onChange = (key, value) => {
            this.error(null);
            if (remember) {
                const s = { ...this.#saved, settings: { ...this.#saved.settings, [key]: value } };
                if (key === "lang" && typeof value === "string")
                    s.lang = value;
                this.#saved = s;
                saveSaved(this.name, s);
            }
            this.update();
        };
        this.parts.settings.append(form.element);
        this.parts.settings.hidden = o.settings.length === 0;
        const $ = (id) => document.getElementById(id);
        $("copy-link").onclick = () => void this.#copyLink();
        $("change-tv").onclick = () => void this.#changeTvs();
        $("cast-again").onclick = () => void this.cast();
        $("quit").onclick = () => void this.tvpipe.quit();
        // Another game in the same room (a tvpipe with a games list: it gives the room).
        $("other-game").hidden = !party.info.room;
        $("other-game").onclick = () => {
            if (game.running && !globalThis.confirm?.(hostStrings(this.#lang).otherGameSure))
                return;
            void this.tvpipe.showGamePicker();
        };
        $("start").onclick = () => {
            if (game.running || party.connectedPlayers.length < game.minPlayers)
                return;
            void game.play();
            this.update();
        };
        // Bots are for tests, not for players: in test mode (tvpipe game play --dev) or with ?bots.
        $("bots").hidden = !o.bots || (!party.info.dev && !new URLSearchParams(location.search).has("bots"));
        const addBots = async (n) => {
            this.error(null);
            try {
                await o.bots?.(n);
            }
            catch (err) {
                this.error(hostStrings(this.#lang).botFailed(err.message));
            }
            this.update();
        };
        $("bot1").onclick = () => void addBots(1);
        $("bot3").onclick = () => void addBots(3);
        const frame = $("preview");
        const tv = party.info.tv ?? { width: 1280, height: 720 };
        frame.width = String(tv.width);
        frame.height = String(tv.height);
        frame.parentElement.style.aspectRatio = `${tv.width} / ${tv.height}`;
        frame.src = `${party.links.watch}&mute=1`;
        const fit = () => (frame.style.transform = `scale(${frame.parentElement.clientWidth / tv.width})`);
        new ResizeObserver(fit).observe(frame.parentElement);
        fit();
        party.on("screen-view", () => this.update());
        this.tvpipe.on("cast", (s) => {
            this.#cast = s;
            this.#renderCast();
        });
        this.tvpipe.on("tunnel", () => setTimeout(() => this.update(), 100));
        this.tvpipe.on("close", () => this.error(hostStrings(this.#lang).stopped));
        this.update();
    }
    /** Casts the TV page to the launcher's choice (shown in the TV list). */
    async cast() {
        const party = this.#run?.party;
        if (!party)
            return;
        this.error(null);
        try {
            this.#cast = await party.cast();
        }
        catch (err) {
            this.#cast = { state: "failed", error: err.message };
        }
        this.#renderCast();
    }
    /** Casts when the launcher chose TVs. */
    async castChosen() {
        if ((await this.tvpipe.selection()).length > 0)
            await this.cast();
    }
    /** Draws everything again: after the game's phase or settings changed. */
    update() {
        const o = this.#run;
        if (!o)
            return;
        // Often (every change of the TV's view): the fixed texts and the TVs only when the language changed.
        const lang = o.lang();
        if (lang !== this.#lang || !this.#drawn) {
            this.#lang = lang;
            this.#drawn = true;
            this.#playersKey = "";
            this.#texts();
            this.#renderCast();
        }
        this.#renderJoin();
        this.#renderPlayers();
        const t = hostStrings(this.#lang);
        const running = o.game.running;
        this.#form?.update({ lang: this.#lang, locked: running });
        const locked = document.getElementById("settings-locked");
        locked.hidden = !running || !o.settings.some((f) => !f.live);
        locked.textContent = t.lockedHint;
        this.parts.status.textContent = o.status ? o.status(this.#lang) : running ? t.playing : t.lobby;
    }
    /** The page's fixed texts in its language (and `lang`, for hyphenation). */
    #texts() {
        const t = hostStrings(this.#lang);
        document.documentElement.lang = this.#lang;
        const set = (id, text) => {
            const e = document.getElementById(id);
            if (e)
                e.textContent = text;
        };
        // Web mode (tvpipe.party in the browser): screens, not TVs.
        const web = this.tvpipe?.web === true;
        set("on-tv", web ? t.webOnTv : t.onTv);
        set("change-tv", web ? t.webChangeTv : t.changeTv);
        set("cast-again", t.tryAgain);
        set("player", t.openTv);
        set("players-title", t.players);
        set("bot1", t.addBot);
        set("bot3", t.addBots);
        set("quit", t.end);
        set("other-game", t.otherGame);
        const other = document.getElementById("other-game");
        if (other)
            other.title = t.otherGameTitle;
        set("settings-title", t.settings);
        if (!this.#copied)
            set("copy-link", t.copy);
        set("preview-note", this.#run?.previewNote !== undefined ? textIn(this.#run.previewNote, this.#lang) : t.previewNote);
        const frame = document.getElementById("preview");
        if (frame)
            frame.title = t.preview;
    }
    #renderJoin() {
        const party = this.#run.party;
        const j = party.joinInfo;
        const t = hostStrings(this.#lang);
        const qr = document.getElementById("qr");
        if (qr.dataset["url"] !== j.url) {
            qr.dataset["url"] = j.url;
            qr.innerHTML = qrSvg(j.qr, { quiet: 2 });
        }
        // Shown without the scheme to fit; Copy copies the whole link (the short one when tvpipe has it).
        const link = j.short ?? j.url;
        const url = document.getElementById("join-url");
        url.textContent = link.replace(/^https?:\/\//, "");
        url.title = link;
        document.getElementById("link-note").textContent =
            j.mode === "tunnel" || j.mode === "web" ? t.scanQr : j.mode === "lan" ? t.lanOnly : party.info.tunnel.state === "starting" ? t.opening : t.localOnly;
    }
    async #copyLink() {
        const j = this.#run.party.joinInfo;
        const link = j.short ?? j.url;
        try {
            await navigator.clipboard.writeText(link);
        }
        catch {
            const field = el("textarea", { value: link });
            document.body.append(field);
            field.select();
            document.execCommand("copy");
            field.remove();
        }
        this.#copied = true;
        document.getElementById("copy-link").textContent = hostStrings(this.#lang).copied;
        setTimeout(() => {
            this.#copied = false;
            this.#texts();
        }, 1500);
    }
    /** A player's buttons: their rejoin code (away), make them the VIP, remove them (asks once more). */
    #playerButtons(p) {
        const party = this.#run.party;
        const t = hostStrings(this.#lang);
        const out = [];
        if (!p.connected) {
            const back = el("button", { class: "tvh-act", title: t.rejoinTitle(p.name), textContent: t.rejoin });
            back.onclick = () => void party.showRejoin(p).catch(() => { });
            out.push(back);
        }
        if (!p.vip && p.connected) {
            const vip = el("button", { class: "tvh-act", title: t.makeVipTitle(p.name), textContent: t.makeVip });
            vip.onclick = () => party.makeVip(p);
            out.push(vip);
        }
        const sure = this.#confirmKick === p.id;
        const kick = el("button", { class: sure ? "tvh-act tvh-kick sure" : "tvh-act tvh-kick", title: t.remove(p.name), textContent: sure ? t.removeSure : "✕" });
        kick.setAttribute("aria-label", t.remove(p.name));
        kick.onclick = () => {
            clearTimeout(this.#confirmTimer);
            if (sure) {
                this.#confirmKick = undefined;
                party.kick(p);
            }
            else {
                this.#confirmKick = p.id;
                this.#confirmTimer = setTimeout(() => {
                    this.#confirmKick = undefined;
                    this.#renderPlayers();
                }, 4000);
            }
            this.#renderPlayers();
        };
        out.push(kick);
        return out;
    }
    #renderPlayers() {
        const o = this.#run;
        const { party, game } = o;
        const t = hostStrings(this.#lang);
        const tags = (p) => [...(o.tags?.(p, this.#lang) ?? []), p.vip ? t.vip : "", p.waiting ? t.waiting : "", p.connected ? "" : t.away].filter(Boolean);
        // Rebuilt only when it changes: views change many times a second
        // during a game, and a rebuilt button loses the click.
        const key = JSON.stringify([this.#lang, this.#confirmKick, party.players.map((p) => [p.id, p.name, p.connected, tags(p)])]);
        if (key !== this.#playersKey) {
            this.#playersKey = key;
            const rows = party.players.map((p) => {
                const li = el("li", { class: p.connected ? "" : "away" }, el("span", { class: "tvh-who", textContent: p.name, title: p.name }), el("span", { class: "tvh-end" }, el("span", { class: "tvh-tag", textContent: tags(p).join(" · ") }), ...this.#playerButtons(p)));
                return li;
            });
            if (rows.length === 0)
                rows.push(el("li", { class: "tvh-empty", textContent: t.noPlayers }));
            document.getElementById("players").replaceChildren(...rows);
        }
        document.getElementById("count").textContent = `${party.players.length} / ${party.maxPlayers}`;
        const ready = party.connectedPlayers.length;
        const short = ready < game.minPlayers;
        const start = document.getElementById("start");
        start.disabled = game.running || short;
        start.textContent = game.running ? t.playing : short ? t.waitingMore(game.minPlayers - ready) : (o.startLabel?.(this.#lang) ?? t.start);
        document.getElementById("bot1").disabled = party.players.length >= party.maxPlayers;
        document.getElementById("bot3").disabled = party.players.length + 3 > party.maxPlayers;
    }
    #renderCast() {
        const s = this.#cast ?? { state: "stopped" };
        const t = hostStrings(this.#lang);
        // Stopped on purpose (no TVs chosen): as before the first cast.
        const none = s.state === "stopped" && !s.error && !s.receivers?.length;
        const rows = (s.receivers ?? []).map((r) => {
            const ok = r.state === "connected" || r.state === "reconnected";
            const tag = el("span", {
                class: `tvh-tag ${ok ? "ok" : r.state === "failed" || r.state === "gave-up" ? "bad" : ""}`,
                textContent: ok ? (s.state === "streaming" ? t.showing : t.connected) : r.error ? `${r.state}: ${r.error}` : r.state,
            });
            return el("li", {}, el("span", { class: "tvh-who", textContent: r.title ?? (r.name === "browser" ? t.browserTab : r.name) }), tag);
        });
        if (rows.length === 0) {
            rows.push(el("li", { class: "tvh-empty", textContent: none ? (this.tvpipe?.web ? t.webNoTv : t.noTv) : s.state === "starting" ? t.starting(s.to) : s.error ? t.tvFailed(s.error) : t.tvState(s.state) }));
        }
        document.getElementById("tvs").replaceChildren(...rows);
        document.getElementById("cast-again").hidden = none || !(s.state === "failed" || s.state === "stopped");
        const player = document.getElementById("player");
        player.hidden = !s.player;
        if (s.player)
            player.href = s.player;
    }
    /** tvpipe's cast picker over this page: other TVs, another resolution; none stops casting. */
    async #changeTvs() {
        const party = this.#run?.party;
        if (!party)
            return;
        this.error(null);
        try {
            const s = await party.changeCast();
            if (s)
                this.#cast = s;
        }
        catch (err) {
            this.error(err.message);
        }
        this.#renderCast();
    }
}
