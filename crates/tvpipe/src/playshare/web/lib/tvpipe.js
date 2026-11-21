/**
 * The local API of `tvpipe game play` (docs/playshare-design.md §5): the
 * launcher and the host page talk to tvpipe with it. One WebSocket
 * (`/_tvpipe/api`, the session cookie or `?t=TOKEN`): calls, events, and
 * the relay of the phones' connections once the host attaches.
 *
 *   const tvpipe = await Tvpipe.connect();
 *   const party = await tvpipe.party({ lateJoin: "wait" });   // the host
 *   await party.cast();                                      // the TV page on the chosen TVs
 *   await party.changeCast();                                // the cast picker: other TVs, resolution
 */
import { Emitter } from "./emitter.js";
import { Party } from "./party.js";
import { showPairDialog } from "./pair-dialog.js";
import { showRejoinDialog } from "./rejoin-dialog.js";
import { TvpipeRelay } from "./relay.js";
import { captureAudio, SurfaceEncoder } from "./surface.js";
/**
 * What a TV adds to its receiver's playout delay, ms: its own picture
 * processing (not in game mode) and the receiver's output. Measured: an
 * Apple TV 4K at a 100 ms lead showed frames ~250 ms after they were
 * made (docs/measurements.md).
 */
export const TV_DISPLAY_MS = 120;
/** From a change in the host to the frame that shows it: a page renders, the frame is captured, ms. */
export const TV_RENDER_MS = 30;
/**
 * How far the picture of a cast or surface is behind the host, ms: the
 * slowest connected receiver's delay, with the TV's lag and a frame of
 * rendering: as measured for that TV (`displayMs`, which has both), else
 * {@link TV_DISPLAY_MS} and {@link TV_RENDER_MS} (the `browser` receiver
 * has no TV). `undefined` when no receiver is connected.
 */
export function tvDelayOf(status) {
    if (status.state === "stopped" || status.state === "failed")
        return undefined;
    let max;
    for (const r of status.receivers ?? []) {
        if ((r.state !== "connected" && r.state !== "reconnected") || typeof r.delayMs !== "number")
            continue;
        const lag = typeof r.displayMs === "number" ? r.displayMs : TV_RENDER_MS + (r.protocol === "browser" ? 0 : TV_DISPLAY_MS);
        const d = r.delayMs + lag;
        max = Math.max(max ?? 0, d);
    }
    return max;
}
/** A refused call. */
export class TvpipeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "TvpipeError";
        this.code = code;
    }
}
/** tvpipe's standard launcher. */
const LAUNCHER = "/_tvpipe/launcher/";
/** The page the launcher casts to a TV to sync it (`flashsync.ts`). */
export const TVSYNC_PAGE = "/_tvpipe/tvsync/";
/** The message the launcher in change mode sends its parent page. */
export const PICKER_MESSAGE = "tvpipe:cast-picker";
export class Tvpipe extends Emitter {
    /** Connects to tvpipe's API. */
    static connect(opts = {}) {
        let url = opts.url;
        if (!url) {
            const loc = globalThis.location;
            url = `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/_tvpipe/api`;
        }
        if (opts.token)
            url += `${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(opts.token)}`;
        const WS = opts.WebSocket ?? globalThis.WebSocket;
        const ws = new WS(url);
        ws.binaryType = "arraybuffer";
        return new Promise((resolve, reject) => {
            ws.onopen = () => resolve(new Tvpipe(ws));
            ws.onerror = () => reject(new TvpipeError("connect", `cannot reach tvpipe at ${url.replace(/t=[^&]*/, "t=…")}`));
        });
    }
    #ws;
    #n = 0;
    #calls = new Map();
    #relay;
    #closed = false;
    constructor(ws) {
        super();
        this.#ws = ws;
        ws.onerror = null;
        ws.onmessage = (ev) => {
            if (typeof ev.data === "string")
                this.#onText(ev.data);
            else if (ev.data instanceof ArrayBuffer)
                this.#relay?.handleBinary(new Uint8Array(ev.data));
        };
        ws.onclose = () => {
            this.#closed = true;
            const err = new TvpipeError("closed", "the connection to tvpipe closed");
            for (const w of this.#calls.values())
                w.reject(err);
            this.#calls.clear();
            this.#relay?.handleDetach();
            this.emit("close");
        };
    }
    get closed() {
        return this.#closed;
    }
    #onText(text) {
        let msg;
        try {
            msg = JSON.parse(text);
        }
        catch {
            return;
        }
        if (typeof msg !== "object" || msg === null)
            return;
        if (msg["t"] === "reply") {
            const w = this.#calls.get(msg["n"]);
            if (!w)
                return;
            this.#calls.delete(msg["n"]);
            if (msg["ok"])
                w.resolve(msg["value"]);
            else
                w.reject(new TvpipeError(msg["error"]?.code ?? "failed", msg["error"]?.message ?? "failed"));
            return;
        }
        if (msg["t"] === "event") {
            const data = msg["data"];
            switch (msg["type"]) {
                case "devices":
                    this.emit("devices", Array.isArray(data) ? data : []);
                    return;
                case "pair":
                    this.emit("pair", data);
                    return;
                case "cast":
                    this.emit("cast", data);
                    return;
                case "tunnel":
                    this.emit("tunnel", data);
                    return;
                case "closing":
                    this.#relay?.onclosing?.();
                    this.emit("closing");
                    return;
                case "detached":
                    this.emit("detached");
                    return;
                case "surface":
                    this.emit("surface", data);
                    return;
            }
            return;
        }
        this.#relay?.handleControl(msg);
    }
    /** Calls an API method (docs/playshare-design.md §5). */
    call(method, params = {}) {
        if (this.#closed)
            return Promise.reject(new TvpipeError("closed", "the connection to tvpipe closed"));
        const n = ++this.#n;
        return new Promise((resolve, reject) => {
            this.#calls.set(n, { resolve, reject });
            this.#ws.send(JSON.stringify({ t: "call", n, method, params }));
        });
    }
    info() {
        return this.call("info");
    }
    /** Starts (or stops) discovery; `devices` events follow. Resolves with the list so far. */
    watchDevices(on = true) {
        return this.call("devices.watch", { on });
    }
    /**
     * The launcher's choice, kept by tvpipe across the navigation to the
     * host page: the TVs and the resolution (default: unchanged).
     */
    async select(devices, opts = {}) {
        const params = { devices };
        if (opts.resolution)
            params["resolution"] = opts.resolution;
        return this.call("select", params);
    }
    /** The chosen TVs. */
    async selection() {
        return (await this.chosen()).devices;
    }
    /** The chosen TVs and resolution. */
    chosen() {
        return this.call("selection");
    }
    /** AirPlay PIN pairing: `pair` events say when the PIN is wanted. */
    async pair(device) {
        await this.call("pair.start", { device });
    }
    async pairPin(device, pin) {
        await this.call("pair.pin", { device, pin });
    }
    async pairCancel(device) {
        await this.call("pair.cancel", { device });
    }
    /**
     * Pairs an AirPlay TV in a dialog over this page: it asks the TV for a
     * code and people type what it shows. Resolves `true` once paired,
     * `false` when cancelled. {@link HostedParty} shows it by itself when
     * a cast fails because a TV needs pairing.
     */
    async showPairing(device) {
        if (!globalThis.document)
            throw new TvpipeError("unsupported", "the pairing dialog needs a page");
        return showPairDialog(this, device);
    }
    /**
     * Keeps a TV's display lag (`ms`; `null` forgets it): how much later
     * than a phone it shows a picture beyond its playout delay, as the
     * launcher's Sync measures it (`flashsync.ts`). tvpipe stores it
     * per TV; devices and cast statuses carry it as `displayMs`, and a
     * party's `tvDelay` follows.
     */
    async setDisplayLag(device, ms) {
        await this.call("tvsync.set", { device, displayMs: ms === null ? null : Math.round(ms) });
    }
    /**
     * Casts a page of this game (a path with its fragment) to `to`, at
     * `resolution` (default: the selection's). Replaces a running cast.
     */
    cast(opts) {
        const params = { page: opts.page };
        if (opts.to)
            params["to"] = opts.to;
        if (opts.resolution)
            params["resolution"] = opts.resolution;
        return this.call("cast.start", params);
    }
    /**
     * The cast picker (docs/playshare-design.md §7.1): the launcher (the
     * game's own, else tvpipe's) in a dialog over this page, to choose
     * other TVs or another resolution while the game runs. It saves the
     * choice (`select`); resolves with it, or `null` when cancelled. The
     * caller casts again (`HostedParty.changeCast` does both).
     */
    async showCastPicker() {
        const doc = globalThis.document;
        if (!doc)
            throw new TvpipeError("unsupported", "the cast picker needs a page");
        const info = await this.info();
        const src = `${info.pages.launcher ?? LAUNCHER}?mode=change`;
        return new Promise((resolve) => {
            const dialog = doc.createElement("dialog");
            dialog.className = "tvpipe-cast-picker";
            dialog.style.cssText =
                "padding:0;border:0;border-radius:12px;width:min(760px,94vw);height:min(680px,90vh);overflow:hidden;background:transparent;box-shadow:0 20px 60px rgb(0 0 0 / 40%)";
            const frame = doc.createElement("iframe");
            frame.title = "Change the TVs";
            frame.src = src;
            frame.style.cssText = "display:block;width:100%;height:100%;border:0";
            dialog.append(frame);
            const done = (sel) => {
                removeEventListener("message", onMessage);
                dialog.close();
                dialog.remove();
                resolve(sel);
            };
            const onMessage = (ev) => {
                if (ev.source !== frame.contentWindow || ev.origin !== globalThis.location.origin)
                    return;
                const d = ev.data;
                if (d?.type !== PICKER_MESSAGE)
                    return;
                done(d.selection ?? null);
            };
            addEventListener("message", onMessage);
            dialog.addEventListener("cancel", (ev) => {
                ev.preventDefault();
                done(null);
            });
            doc.body.append(dialog);
            dialog.showModal();
        });
    }
    async stopCast() {
        await this.call("cast.stop");
    }
    /**
     * A short link to the tunnel's join link `url` (docs/short-links.md):
     * tvpipe registers it at tvpipe.party (`code`: the code to ask for, the
     * room's). Rejects with `unavailable` without a tunnel, with
     * `--no-short-link` or when the service fails.
     */
    shortLink(url, code) {
        return this.call("shortlink", { url, code });
    }
    /** A QR code made by tvpipe: `size` modules, `rows` of "0"/"1". */
    qr(text) {
        return this.call("qr", { text });
    }
    /**
     * Opens a surface: tvpipe streams what an encoder sends to `to`
     * (default: the selection). A worker can connect a `SurfaceEncoder`
     * with the answer.
     */
    openSurface(opts) {
        const params = { width: opts.width, height: opts.height, fps: opts.fps ?? 30 };
        if (opts.to)
            params["to"] = opts.to;
        if (opts.audio)
            params["audio"] = true;
        if (opts.bitrate)
            params["bitrate"] = opts.bitrate;
        return this.call("surface.open", params);
    }
    async closeSurface(id) {
        await this.call("surface.close", { id });
    }
    /**
     * A canvas on TVs without a browser in between
     * (docs/playshare-design.md §17): opens a surface of the canvas's size
     * and encodes it here. `audio`: a Web Audio node whose sound goes along.
     */
    async surface(opts) {
        const info = await this.openSurface({
            width: opts.canvas.width,
            height: opts.canvas.height,
            fps: opts.fps,
            to: opts.to,
            audio: !!opts.audio,
            bitrate: opts.bitrate,
        });
        const enc = new SurfaceEncoder(info, opts.canvas, opts);
        if (opts.audio && info.audio) {
            const stop = await captureAudio(opts.audio.context, opts.audio.node, info.audio.channels, (pcm, pts) => enc.pushAudio(pcm, pts));
            enc.on("end", stop);
        }
        enc.on("end", () => void this.closeSurface(info.id).catch(() => { }));
        await enc.ready;
        return enc;
    }
    /** Ends playshare (the TVs stop, phones are told). */
    async quit() {
        await this.call("quit").catch(() => { });
    }
    /** Becomes the relay's host: phones' connections come here. */
    async relay() {
        const r = await this.call("relay.attach");
        const ws = this.#ws;
        this.#relay = new TvpipeRelay({
            sendText: (t) => ws.send(t),
            sendBinary: (d) => ws.send(d),
        }, r.public);
        return this.#relay;
    }
    /** The host: a party on the relay, its links and QR code, casting. */
    async party(options = {}) {
        const info = await this.info();
        const relay = await this.relay();
        const party = new HostedParty(this, info, relay, options);
        await party.refreshJoin();
        return party;
    }
    /** Closes the API socket (tvpipe ends after a while without a page). */
    close() {
        this.#ws.close();
    }
}
/** The error code of a receiver that needs pairing first (AirPlay with a PIN). */
export const PAIRING_REQUIRED = "pairing-required";
/** The receivers of a cast status that failed because they need pairing. */
export function needsPairing(status) {
    return (status.receivers ?? []).filter((r) => r.state === "failed" && r.code === PAIRING_REQUIRED).map((r) => r.name);
}
/** A {@link Party} in a host page, with tvpipe behind it. */
export class HostedParty extends Party {
    tvpipe;
    info;
    relay;
    links;
    /** The delay of each picture on TVs (`cast`, `surface:ID`), for `tvDelay`. */
    #pictures = new Map();
    #pair;
    /** Set while this party's `cast.start` call runs (its `starting` event comes before the reply). */
    #starting = false;
    /** The running cast is this party's (not, say, the cast picker's sync page). */
    #mine = false;
    /** What the running cast was asked for, to cast it again once paired. */
    #castArgs = null;
    /** The TVs paired (or offered pairing) since the last `cast()`: once each. */
    #offered = new Set();
    #pairing = false;
    constructor(tvpipe, info, relay, options) {
        const { pair, ...rest } = options;
        super({ maxPlayers: info.players.max, ...rest });
        this.tvpipe = tvpipe;
        this.info = info;
        this.relay = relay;
        this.#pair = pair ?? (globalThis.document ? (device) => tvpipe.showPairing(device) : false);
        this.listen(relay);
        const tv = `${info.pages.tv}#r=${this.code}&k=${this.screenKey}&role=screen`;
        this.links = {
            join: this.#joinUrl(info.phone.url),
            tv,
            watch: `${info.local}${info.pages.tv}#r=${this.code}&k=${this.watchKey}&role=watch`,
        };
        tvpipe.on("tunnel", (t) => {
            if (t.state === "up" && t.url) {
                this.info.phone = { ...this.info.phone, url: t.url, mode: "tunnel" };
                void this.refreshJoin();
            }
        });
        tvpipe.on("cast", (s) => {
            // A new cast (its first event names its TVs): this party's while its call runs.
            if (s.state === "starting" && s.to !== undefined)
                this.#mine = this.#starting;
            this.#picture("cast", s);
            if (this.#mine)
                void this.#pairFailed(s);
        });
        tvpipe.on("surface", (s) => this.#picture(`surface:${s.id}`, s));
    }
    /**
     * A picture's status: `tvDelay` follows the slowest picture on a TV
     * (kept while one restarts; gone when it stops).
     */
    #picture(key, s) {
        const d = tvDelayOf(s);
        if (d !== undefined)
            this.#pictures.set(key, d);
        else if (s.state !== "starting")
            this.#pictures.delete(key);
        this.followTv(Math.max(0, ...this.#pictures.values()));
    }
    #joinUrl(base) {
        return `${base.endsWith("/") ? base : `${base}/`}?r=${this.code}#k=${this.joinKey}`;
    }
    #refreshes = 0;
    /**
     * Makes the join link and its QR code (again: after the tunnel came up).
     * With a tunnel the short link (`joinInfo.short`) follows in the
     * background: `screen-view` fires when it is there.
     */
    async refreshJoin() {
        const n = ++this.#refreshes;
        const join = this.#joinUrl(this.info.phone.url);
        const mode = this.info.phone.mode;
        this.links = { ...this.links, join };
        let qr = null;
        try {
            qr = await this.tvpipe.qr(join);
        }
        catch { }
        if (n !== this.#refreshes)
            return;
        // The short link of the same link stays while it is asked for again.
        const keep = this.joinInfo.url === join ? this.joinInfo.short : undefined;
        this.joinInfo = { code: this.code, url: join, qr, mode, ...(keep ? { short: keep } : {}) };
        if (mode !== "tunnel")
            return;
        void this.tvpipe.shortLink(join, this.code).then((r) => {
            if (n === this.#refreshes && r.url !== this.joinInfo.short)
                this.joinInfo = { ...this.joinInfo, short: r.url };
        }, () => { });
    }
    /**
     * Shows `player`'s rejoin code over the host page (a dialog): the QR
     * code of {@link Party.rejoinLink} and a link to copy, for a phone
     * that lost its way back (another browser, a new phone). It closes
     * when the player is back (resolving `true`), when they leave, or by
     * hand (`false`). Put it beside away players (`!player.connected`).
     */
    async showRejoin(player) {
        const link = this.rejoinLink(player);
        if (!link || !globalThis.document)
            throw new TvpipeError("unavailable", "no join link or no page");
        let qr = null;
        try {
            qr = await this.tvpipe.qr(link);
        }
        catch { }
        return showRejoinDialog(this, player, link, qr);
    }
    /**
     * Casts the TV page to `to` (default: what the launcher chose). A TV
     * that needs pairing is paired (the `pair` option, a dialog by
     * default), then the page is cast again: `cast` events tell.
     */
    cast(to, opts = {}) {
        this.#offered.clear();
        return this.#cast({ to, resolution: opts.resolution });
    }
    async #cast(args) {
        this.#castArgs = args;
        this.#starting = true;
        try {
            const status = await this.tvpipe.cast({ page: this.links.tv, to: args.to, resolution: args.resolution });
            if (this.#mine)
                void this.#pairFailed(status);
            return status;
        }
        finally {
            this.#starting = false;
        }
    }
    /** Pairs the TVs of this party's cast that failed for want of it, once each, then casts again. */
    async #pairFailed(status) {
        const pair = this.#pair;
        if (!pair || this.#pairing || !this.#castArgs)
            return;
        const devices = needsPairing(status).filter((d) => !this.#offered.has(d));
        if (devices.length === 0)
            return;
        this.#pairing = true;
        let paired = false;
        try {
            for (const d of devices) {
                this.#offered.add(d);
                try {
                    if (await pair(d))
                        paired = true;
                }
                catch {
                    // No dialog: the cast's failure stays.
                }
            }
        }
        finally {
            this.#pairing = false;
        }
        if (!paired || !this.#castArgs)
            return;
        await this.#cast(this.#castArgs).catch(() => { });
    }
    /**
     * The cast picker over the host page, then the TV page on what was
     * chosen (no TVs: the cast stops). `null` when cancelled.
     */
    async changeCast() {
        const sel = await this.tvpipe.showCastPicker();
        if (!sel)
            return null;
        if (sel.devices.length === 0) {
            await this.stopCast();
            return { state: "stopped" };
        }
        return this.cast();
    }
    stopCast() {
        this.#castArgs = null;
        return this.tvpipe.stopCast();
    }
}
