/**
 * Web mode's tvpipe (docs/browser-party-design.md, "Web mode"): the calls
 * a `Tvpipe` makes, answered in the page on tvpipe.party, with no tvpipe
 * anywhere. `Tvpipe.connect()` returns a `Tvpipe` on a `WebHub` by itself
 * in web mode (`mode.ts`), so games need no change.
 *
 * API (besides `TvpipeTransport`):
 * - `new WebHub(options?)`: `options.location`, `options.deps` and
 *   `options.confirmScreen` for tests.
 * - `loadWebGames(deps?)`: `/g/index.json` (cached), {@link WebGames}.
 * - `webDevices()`: the screens the launcher offers (kind `browser`,
 *   names `this`, `cable`, `window`, `none`, people's names in `title`).
 *
 * Methods answered: `info` (the game of the page's `/g/NAME/RELEASE/`
 * path, else the session's; `no-game` without one; on a game page the
 * room is registered: `POST /api/links` with a random code, another on
 * `409`, refreshed every 6 hours), `devices.watch`, `select` /
 * `selection` (the session's `screen`), `cast.start` / `cast.stop`
 * (screens.ts), `shortlink` (the room's), `qr` (qr.ts), `quit` (every
 * client closed 4011, the link deleted, the session cleared, `/play/`),
 * `relay.attach` (`WebRtcRelay` on the room's signaling, and the local
 * transport). Pairing, `tvsync.set` and surfaces: `unsupported`.
 * Extra screens are asked about in a dialog (approved tokens stay in the
 * session); Other game switches with `switchGame`.
 */
import { LocalHost } from "./local.js";
import { roomCode, token } from "./party.js";
import { encodeQr } from "./qr.js";
import { WebRtcRelay } from "./rtc-relay.js";
import { fetchPatiently, webDeps } from "./rtc.js";
import { keepAwake, ScreenCaster, screenTitle } from "./screens.js";
import { clearWebSession, readWebSession, writeWebSession } from "./session.js";
import { HostSignal } from "./signaling.js";
import { TvpipeError } from "./tvpipe.js";
/** The standard launcher and the games list (web). */
const LAUNCHER = "/_tvpipe/launcher/";
const PLAY = "/play/";
/** Registration: codes tried at most. */
const CODE_TRIES = 8;
/** The room's link is refreshed this often while it lives, ms. */
const REFRESH_MS = 6 * 3600_000;
const gamesCache = new Map();
/** tvpipe.party's games (`GET /g/index.json`), once per page. */
export function loadWebGames(deps = webDeps()) {
    let p = gamesCache.get(deps.origin);
    if (!p) {
        p = (async () => {
            const r = await fetchPatiently(`${deps.origin}/g/index.json`, {}, 3, deps);
            if (!r.ok)
                throw new TvpipeError("unavailable", `the games list: ${r.status}`);
            const v = await r.json();
            if (v?.v !== 1 || !Array.isArray(v.games))
                throw new TvpipeError("unavailable", "the games list is not version 1");
            return v;
        })();
        p.catch(() => gamesCache.delete(deps.origin));
        gamesCache.set(deps.origin, p);
    }
    return p;
}
function isIpad() {
    const nav = globalThis.navigator;
    return /iPad/.test(nav?.userAgent ?? "") || (nav?.platform === "MacIntel" && (nav?.maxTouchPoints ?? 0) > 1);
}
/** The screens this browser offers (the launcher's "Where should the game show?"). */
export function webDevices(lang = "en") {
    const g = globalThis;
    const touch = (g.navigator?.maxTouchPoints ?? 0) > 0 && (g.matchMedia?.("(pointer: coarse)")?.matches ?? true);
    const cable = g.screen?.isExtended === true;
    const out = [{ name: "this", kind: "browser", title: screenTitle("this", lang, isIpad()) }];
    if (cable)
        out.push({ name: "cable", kind: "browser", title: screenTitle("cable", lang) });
    else if (!touch)
        out.push({ name: "window", kind: "browser", title: screenTitle("window", lang) });
    out.push({ name: "none", kind: "browser", title: screenTitle("none", lang) });
    return out;
}
/** A short name of a browser for people ("Chrome on Android"). */
export function browserName(agent) {
    const b = /Edg\//.test(agent)
        ? "Edge"
        : /SamsungBrowser/.test(agent)
            ? "Samsung Internet"
            : /Firefox\//.test(agent)
                ? "Firefox"
                : /Chrome\/|CriOS/.test(agent)
                    ? "Chrome"
                    : /Safari\//.test(agent)
                        ? "Safari"
                        : "a browser";
    const os = /iPad/.test(agent)
        ? "iPad"
        : /iPhone/.test(agent)
            ? "iPhone"
            : /Android/.test(agent)
                ? /TV|AFT|BRAVIA|SMART-TV/i.test(agent)
                    ? "Android TV"
                    : "Android"
                : /SMART-TV|Tizen|Web0S|webOS/i.test(agent)
                    ? "a TV"
                    : /CrOS/.test(agent)
                        ? "ChromeOS"
                        : /Mac OS X|Macintosh/.test(agent)
                            ? "Mac"
                            : /Windows/.test(agent)
                                ? "Windows"
                                : /Linux/.test(agent)
                                    ? "Linux"
                                    : "";
    return os ? `${b} on ${os}` : b;
}
/** Web mode's in-page tvpipe; see the module docs. */
export class WebHub {
    onevent;
    onclose;
    closed = false;
    #deps;
    #loc;
    #confirm;
    #screens = new ScreenCaster();
    #room;
    #refresh;
    #relay;
    #signal;
    #party;
    #game;
    #awake;
    #asking = Promise.resolve();
    constructor(o = {}) {
        this.#deps = o.deps ?? webDeps();
        this.#loc = o.location ?? globalThis.location;
        this.#confirm = o.confirmScreen ?? askScreen;
        this.#screens.onstatus = (s) => this.#emit("cast", s);
    }
    #emit(type, data) {
        this.onevent?.(type, data);
    }
    get #origin() {
        return this.#deps.origin;
    }
    /** The game of the page's path (`/g/NAME/RELEASE/…`), if it is a game's page. */
    #pathGame() {
        const m = /^\/g\/([^/]+)\/([^/]+)\//.exec(this.#loc.pathname);
        return m ? { name: decodeURIComponent(m[1]), release: decodeURIComponent(m[2]) } : undefined;
    }
    async #currentGame() {
        const fromPath = this.#pathGame();
        const want = fromPath ?? readWebSession().game;
        if (!want)
            throw new TvpipeError("no-game", "no game picked");
        const list = await loadWebGames(this.#deps);
        const game = list.games.find((g) => g.name === want.name && g.release === want.release) ?? list.games.find((g) => g.name === want.name);
        if (!game)
            throw new TvpipeError("no-game", `${want.name} is not in the games list`);
        if (fromPath)
            writeWebSession({ game: { name: game.name, release: game.release } });
        this.#game = game;
        return { game, page: !!fromPath };
    }
    call(method, params) {
        if (this.closed)
            return Promise.reject(new TvpipeError("closed", "closed"));
        try {
            return Promise.resolve(this.#call(method, params));
        }
        catch (err) {
            return Promise.reject(err);
        }
    }
    async #call(method, params) {
        switch (method) {
            case "info":
                return this.#info();
            case "devices.watch":
                if (params["on"] !== false)
                    setTimeout(() => this.#emit("devices", webDevices(lang())), 0);
                return webDevices(lang());
            case "select": {
                const devices = Array.isArray(params["devices"]) ? params["devices"].filter((d) => isScreen(d)) : [];
                writeWebSession({ screen: devices[0] });
                return { devices: devices.slice(0, 1), resolution: null };
            }
            case "selection": {
                const s = readWebSession().screen;
                return { devices: s ? [s] : [], resolution: null };
            }
            case "cast.start": {
                const page = String(params["page"] ?? "");
                if (!page.startsWith("/") || page.startsWith("//"))
                    throw new TvpipeError("bad-page", "a path on this origin");
                const to = Array.isArray(params["to"]) ? params["to"] : undefined;
                const kind = to ? (to.find(isScreen) ?? "none") : (readWebSession().screen ?? "none");
                return this.#screens.start(kind, page);
            }
            case "cast.stop":
                this.#screens.stop();
                return {};
            case "qr": {
                const qr = encodeQr(String(params["text"] ?? ""));
                if (!qr)
                    throw new TvpipeError("too-long", "the text does not fit a QR code");
                return qr;
            }
            case "shortlink": {
                const room = await this.#ensureRoom();
                return { url: room.short, code: room.code };
            }
            case "quit":
                await this.#quit();
                return {};
            case "relay.attach": {
                const relay = await this.relay();
                return { public: relay.publicUrl, local: this.#origin };
            }
            case "catalog":
                return loadWebGames(this.#deps);
            default:
                throw new TvpipeError("unsupported", `${method} needs the tvpipe app`);
        }
    }
    async #info() {
        const { game, page } = await this.#currentGame();
        const q = new URLSearchParams(this.#loc.search);
        const info = {
            name: game.name,
            title: game.title,
            players: game.players,
            pages: game.pages,
            tv: game.tv,
            resolutions: [],
            phone: { url: `${this.#origin}/r/`, mode: "web" },
            tunnel: { state: "off" },
            local: this.#origin,
            version: "web",
            dev: q.has("dev") || q.has("bots"),
        };
        // The room is the host page's (a launcher has none yet).
        if (page) {
            const room = await this.#ensureRoom();
            info.room = { code: room.code, key: room.key };
        }
        return info;
    }
    /** The tab's room, registered (once per page: checked or made). */
    #ensureRoom() {
        if (!this.#room) {
            this.#room = this.#register().then((room) => {
                if (!this.#refresh)
                    this.#refresh = setInterval(() => void this.#renew(), REFRESH_MS);
                return room;
            });
            this.#room.catch(() => (this.#room = undefined));
        }
        return this.#room;
    }
    #joinLink(code, key) {
        return `${this.#origin}/r/?r=${code}#k=${key}`;
    }
    async #register() {
        const old = readWebSession().room;
        if (old) {
            try {
                const r = await this.#put(old);
                if (r === "ok")
                    return old;
                // Gone (expired, deleted): the same code again if it is free.
                const again = await this.#post(old.code, old.key);
                if (again)
                    return again;
            }
            catch {
                // Offline for a moment: the room as it was (signaling says if it is not).
                return old;
            }
        }
        for (let i = 0; i < CODE_TRIES; i++) {
            const room = await this.#post(roomCode(), token());
            if (room)
                return room;
        }
        throw new TvpipeError("unavailable", "no free room code");
    }
    /** `POST /api/links` for `code`; `null` when the code is taken (409). */
    async #post(code, key) {
        const r = await fetchPatiently(`${this.#origin}/api/links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: this.#joinLink(code, key), code }) }, 3, this.#deps);
        if (r.status === 409)
            return null;
        if (!r.ok)
            throw new TvpipeError("unavailable", `registering the room: ${r.status}`);
        const v = await r.json();
        if (v?.code !== code || typeof v?.secret !== "string")
            return null;
        const room = { code, key, secret: v.secret, short: typeof v.short === "string" ? v.short : `${this.#origin}/${code}` };
        writeWebSession({ room });
        return room;
    }
    async #put(room) {
        const r = await fetchPatiently(`${this.#origin}/api/links/${room.code}`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${room.secret}` }, body: "{}" }, 3, this.#deps);
        if (r.status === 404)
            return "gone";
        if (!r.ok)
            throw new Error(`refresh: ${r.status}`);
        return "ok";
    }
    async #renew() {
        const room = readWebSession().room;
        if (!room)
            return;
        try {
            if ((await this.#put(room)) === "gone")
                await this.#post(room.code, room.key);
        }
        catch { }
    }
    async relay() {
        if (this.#relay)
            return this.#relay;
        const room = await this.#ensureRoom();
        const { game } = await this.#currentGame();
        const signal = new HostSignal(HostSignal.url(this.#origin, room.code), room.secret, this.#deps);
        const relay = new WebRtcRelay({ signal, publicUrl: `${this.#origin}/r/`, maxConnections: 2 * game.players.max + 16, deps: this.#deps });
        relay.game = `${game.name}/${game.release}`;
        relay.addLocal(new LocalHost(room.code, relay.nextId, this.#deps));
        relay.onscreen = (req) => void this.#screenRequest(req);
        signal.onstate = (s) => {
            if (s === "replaced")
                this.#emit("detached", null);
            if (s === "bad-secret")
                console.warn("tvpipe: the room's registration is gone; phones cannot join until it is made again (reload)");
        };
        signal.setGame(roomGame(game));
        this.#signal = signal;
        this.#relay = relay;
        this.#awake = keepAwake();
        const g = globalThis;
        g.addEventListener?.("pagehide", () => this.#leave());
        return relay;
    }
    hosted(party) {
        this.#party = party;
    }
    /** The watch link an extra screen shows. */
    #watchLink() {
        const party = this.#party;
        const game = this.#game;
        if (!party || !game)
            return undefined;
        return `${this.#origin}${game.pages.tv}#r=${party.code}&k=${party.watchKey}&role=watch`;
    }
    async #screenRequest(req) {
        const url = this.#watchLink();
        if (!url)
            return req.answer(false);
        if (readWebSession().screens?.includes(req.token))
            return req.answer(true, url);
        // One question at a time; a screen that left meanwhile is not asked about.
        let gone = false;
        req.onclose = () => (gone = true);
        const turn = this.#asking.then(async () => {
            if (gone)
                return;
            const ok = await this.#confirm(browserName(req.agent)).catch(() => false);
            if (ok)
                writeWebSession({ screens: [...(readWebSession().screens ?? []), req.token] });
            req.answer(ok, this.#watchLink());
        });
        this.#asking = turn.catch(() => { });
        await turn;
    }
    /** Web mode's Other game: the room goes on with `next`. */
    async switchGame(next) {
        const list = await loadWebGames(this.#deps);
        const game = list.games.find((g) => g.name === next.name && g.release === next.release);
        if (!game)
            throw new TvpipeError("no-game", `${next.name} is not in the games list`);
        writeWebSession({ game: { name: game.name, release: game.release } });
        // The room's game first, so phones at /r/ find the next one.
        this.#signal?.setGame(roomGame(game));
        await new Promise((r) => setTimeout(r, 150));
        this.#relay?.closeAll(4014, "next game");
        this.#screens.dispose();
        const url = readWebSession().screen ? game.pages.host : (game.pages.launcher ?? LAUNCHER);
        this.#emit("game", { name: game.name, title: game.title, url });
    }
    async #quit() {
        const room = readWebSession().room;
        const relay = this.#relay;
        if (relay) {
            relay.onclosing?.();
            await new Promise((r) => setTimeout(r, 300));
            relay.close(4011, "closed");
        }
        this.#screens.stop();
        if (room) {
            try {
                await this.#deps.fetch(`${this.#origin}/api/links/${room.code}`, { method: "DELETE", headers: { authorization: `Bearer ${room.secret}` }, keepalive: true });
            }
            catch { }
        }
        clearWebSession();
        this.#leave();
        this.#loc.assign(PLAY);
    }
    #leave() {
        if (this.#refresh)
            clearInterval(this.#refresh);
        this.#refresh = undefined;
        this.#awake?.();
        this.#awake = undefined;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.#leave();
        this.#relay?.close();
        this.#screens.dispose();
        this.onclose?.();
    }
}
function isScreen(d) {
    return d === "this" || d === "cable" || d === "window" || d === "none";
}
function lang() {
    return String(globalThis.document?.documentElement?.lang ?? "en").slice(0, 2);
}
function roomGame(g) {
    return { name: g.name, title: g.title, release: g.release, phone: g.pages.phone };
}
/** The extra screen's question, a dialog over the page. */
function askScreen(browser) {
    const doc = globalThis.document;
    if (!doc?.body)
        return Promise.resolve(false);
    const de = lang() === "de";
    return new Promise((resolve) => {
        const dialog = doc.createElement("dialog");
        dialog.className = "tvpipe-screen-request";
        dialog.style.cssText = "border:0;border-radius:14px;padding:22px 24px;max-width:min(420px,92vw);font:16px/1.4 system-ui,sans-serif;background:var(--card,#222530);color:var(--text,#f3f3f6);box-shadow:0 20px 60px rgb(0 0 0 / 50%)";
        const p = doc.createElement("p");
        p.style.margin = "0 0 18px";
        p.textContent = de ? `Ein Bildschirm möchte dazukommen (${browser}). Erlauben?` : `A screen wants to join (${browser}). Allow?`;
        const row = doc.createElement("div");
        row.style.cssText = "display:flex;gap:10px;justify-content:flex-end";
        const button = (text, primary, value) => {
            const b = doc.createElement("button");
            b.type = "button";
            b.textContent = text;
            b.style.cssText = `font:inherit;padding:8px 18px;border-radius:8px;cursor:pointer;border:1px solid var(--line,#343846);${primary ? "background:var(--accent,#ffcf3f);color:var(--accent-text,#241a00);font-weight:700;border-color:transparent" : "background:none;color:inherit"}`;
            b.onclick = () => finish(value);
            return b;
        };
        row.append(button(de ? "Ablehnen" : "Deny", false, false), button(de ? "Erlauben" : "Allow", true, true));
        dialog.append(p, row);
        const finish = (ok) => {
            dialog.close();
            dialog.remove();
            resolve(ok);
        };
        dialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            finish(false);
        });
        doc.body.append(dialog);
        dialog.showModal();
    });
}
