/**
 * Signaling through tvpipe.party's room objects
 * (docs/browser-party-design.md, "Signaling"): JSON over WebSockets,
 * one offer and one answer per connection (no trickle).
 *
 * - {@link joinSignal}: a phone's or screen's join socket
 *   (`/api/rooms/CODE/join?QUERY`): sends the offer, resolves with the
 *   host's answer.
 * - {@link HostSignal}: the host page's socket (`/api/rooms/CODE/host`):
 *   offers in, answers and refusals out, the room's game; reconnects with
 *   backoff, pings every 30 s.
 */
import { webDeps } from "./rtc.js";
/** A join that did not get an answer: `no-host`, `rejected` (`reason`), `timeout`, `rate-limited`, `full`, `closed`. */
export class SignalError extends Error {
    code;
    reason;
    constructor(code, reason = "") {
        super(reason ? `${code}: ${reason}` : code);
        this.name = "SignalError";
        this.code = code;
        this.reason = reason;
    }
}
/** `wss://HOST` for `https://HOST`. */
export function wsOrigin(origin) {
    return origin.replace(/^http(s?):/, "ws$1:");
}
/** `https://HOST` for `wss://HOST/…`. */
export function httpOrigin(url) {
    try {
        const u = new URL(url);
        return `${u.protocol === "wss:" || u.protocol === "https:" ? "https:" : "http:"}//${u.host}`;
    }
    catch {
        return webDeps().origin;
    }
}
/** Close codes of a join socket that say why, when no message did. */
const JOIN_CLOSES = { 1013: "no-host", 4008: "rate-limited", 1009: "bad-message", 1008: "bad-message", 4002: "timeout" };
/**
 * Sends `sdp` (an offer) on a join socket at `url`; resolves with the
 * answer's SDP, rejects with a {@link SignalError}. `cancel()` closes the
 * socket (the promise rejects `closed`).
 */
export function joinSignal(url, sdp, deps = webDeps()) {
    let ws;
    let settled = false;
    let fail = () => { };
    const answer = new Promise((resolve, reject) => {
        const done = (f) => {
            if (settled)
                return;
            settled = true;
            f();
            try {
                ws?.close(1000);
            }
            catch { }
        };
        fail = (e) => done(() => reject(e));
        try {
            ws = new deps.WebSocket(url);
        }
        catch (err) {
            return fail(new SignalError("closed", String(err)));
        }
        ws.onopen = () => ws.send(JSON.stringify({ t: "offer", sdp }));
        ws.onmessage = (ev) => {
            let m;
            try {
                m = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
            }
            catch {
                return;
            }
            if (!m || typeof m !== "object")
                return;
            switch (m.t) {
                case "answer":
                    if (typeof m.sdp === "string")
                        done(() => resolve(m.sdp));
                    return;
                case "reject":
                    return fail(new SignalError("rejected", String(m.reason ?? "")));
                case "no-host":
                    return fail(new SignalError("no-host"));
                case "timeout":
                    return fail(new SignalError("timeout"));
                case "error":
                    return fail(new SignalError(String(m.code ?? "error")));
            }
        };
        ws.onerror = () => { };
        ws.onclose = (ev) => fail(new SignalError(JOIN_CLOSES[ev.code] ?? "closed", ev.reason ?? ""));
    });
    return { answer, cancel: () => fail(new SignalError("closed")) };
}
/** Pings this often, ms (the room answers `pong` without waking up). */
export const HOST_PING_MS = 30_000;
/** The host page's signaling socket; see the module docs. */
export class HostSignal {
    url;
    #secret;
    #deps;
    #ws;
    #state = "connecting";
    #attempt = 0;
    #retry;
    #pinger;
    #game;
    onoffer;
    onstate;
    /** `url`: `wss://HOST/api/rooms/CODE/host`; `secret`: the room's registration secret. */
    constructor(url, secret, deps = webDeps()) {
        this.url = url;
        this.#secret = secret;
        this.#deps = deps;
        this.#open();
    }
    /** The URL of a room's host socket on `origin`. */
    static url(origin, code) {
        return `${wsOrigin(origin)}/api/rooms/${encodeURIComponent(code)}/host`;
    }
    get state() {
        return this.#state;
    }
    #set(s) {
        if (this.#state === s)
            return;
        this.#state = s;
        this.onstate?.(s);
    }
    #open() {
        this.#retry = undefined;
        if (this.#state === "closed" || this.#state === "replaced" || this.#state === "bad-secret")
            return;
        let ws;
        try {
            ws = new this.#deps.WebSocket(this.url);
        }
        catch {
            return this.#again();
        }
        this.#ws = ws;
        ws.onopen = () => ws.send(JSON.stringify({ t: "host", secret: this.#secret }));
        ws.onmessage = (ev) => {
            if (typeof ev.data !== "string" || ev.data === "pong")
                return;
            let m;
            try {
                m = JSON.parse(ev.data);
            }
            catch {
                return;
            }
            if (!m || typeof m !== "object")
                return;
            switch (m.t) {
                case "hosted":
                    this.#attempt = 0;
                    this.#set("hosted");
                    if (this.#game)
                        this.#sendNow({ t: "game", game: this.#game });
                    if (this.#pinger)
                        clearInterval(this.#pinger);
                    this.#pinger = setInterval(() => this.#sendRaw("ping"), HOST_PING_MS);
                    return;
                case "offer":
                    if (typeof m.sdp !== "string" || typeof m.conn !== "number")
                        return;
                    this.onoffer?.({ conn: m.conn, sdp: m.sdp, query: String(m.query ?? ""), addr: String(m.addr ?? "?"), agent: String(m.agent ?? "") });
                    return;
                case "replaced":
                    this.#set("replaced");
                    return;
                case "error":
                    if (m.code === "bad-secret")
                        this.#set("bad-secret");
                    return;
            }
        };
        ws.onerror = () => { };
        ws.onclose = (ev) => {
            if (this.#ws !== ws)
                return;
            this.#ws = undefined;
            if (this.#pinger)
                clearInterval(this.#pinger);
            this.#pinger = undefined;
            if (ev.code === 4009)
                this.#set("replaced");
            else if (ev.code === 4003)
                this.#set("bad-secret");
            this.#again();
        };
    }
    #again() {
        if (this.#state === "closed" || this.#state === "replaced" || this.#state === "bad-secret")
            return;
        this.#set("connecting");
        const delay = Math.min(30_000, 1000 * 2 ** this.#attempt++) * (0.75 + Math.random() * 0.5);
        this.#retry = setTimeout(() => this.#open(), delay);
    }
    #sendRaw(text) {
        const ws = this.#ws;
        if (!ws || ws.readyState !== 1)
            return false;
        try {
            ws.send(text);
            return true;
        }
        catch {
            return false;
        }
    }
    #sendNow(msg) {
        return this.#sendRaw(JSON.stringify(msg));
    }
    /** An answer to the offer of `conn`. */
    answer(conn, sdp) {
        return this.#state === "hosted" && this.#sendNow({ t: "answer", conn, sdp });
    }
    /** Refuses the offer of `conn` (`full`, `failed`). */
    reject(conn, reason) {
        return this.#state === "hosted" && this.#sendNow({ t: "reject", conn, reason });
    }
    /** The room's game: sent now and after every reconnect. */
    setGame(game) {
        this.#game = game;
        if (this.#state === "hosted")
            this.#sendNow({ t: "game", game });
    }
    /** For tests: drops the socket as a network loss would (it reconnects). */
    drop() {
        try {
            this.#ws?.close(4999, "dropped");
        }
        catch { }
    }
    close() {
        this.#set("closed");
        if (this.#retry)
            clearTimeout(this.#retry);
        if (this.#pinger)
            clearInterval(this.#pinger);
        const ws = this.#ws;
        this.#ws = undefined;
        try {
            ws?.close(1000);
        }
        catch { }
    }
}
