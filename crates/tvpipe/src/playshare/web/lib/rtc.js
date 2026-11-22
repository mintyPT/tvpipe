/**
 * What both ends of web mode's data channels share
 * (docs/browser-party-design.md, "The transport"): the browser APIs they
 * use (replaceable for tests: {@link setWebDeps}), ICE servers from
 * `GET /api/turn`, non-trickle gathering, and {@link ChannelEnd}: one
 * data channel with the control frames (`!` and JSON: close codes, pings,
 * screen requests), liveness and backpressure.
 */
let overrides = {};
/** The browser APIs (or a test's, {@link setWebDeps}). */
export function webDeps() {
    const g = globalThis;
    return {
        fetch: overrides.fetch ?? ((url, init) => g.fetch(url, init)),
        WebSocket: overrides.WebSocket ?? g.WebSocket,
        RTCPeerConnection: overrides.RTCPeerConnection ?? g.RTCPeerConnection,
        BroadcastChannel: overrides.BroadcastChannel ?? g.BroadcastChannel,
        origin: overrides.origin ?? g.location?.origin ?? "https://tvpipe.party",
    };
}
/** For tests: replaces browser APIs (`undefined`: the globals again). */
export function setWebDeps(deps) {
    overrides = deps ?? {};
    iceCache = undefined;
}
/** STUN only: without `/api/turn`, or when it fails. */
export const PUBLIC_STUN = [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];
let iceCache;
/** ICE servers from `GET /api/turn` (STUN, and TURN when the service has it), cached for half their `ttl`. */
export async function iceServers(deps = webDeps()) {
    const now = Date.now();
    if (iceCache && iceCache.origin === deps.origin && iceCache.until > now)
        return iceCache.servers;
    try {
        const r = await deps.fetch(`${deps.origin}/api/turn`);
        if (!r.ok)
            throw new Error(`turn: ${r.status}`);
        const v = await r.json();
        const servers = Array.isArray(v?.iceServers) ? v.iceServers : PUBLIC_STUN;
        const ttl = typeof v?.ttl === "number" && v.ttl > 0 ? v.ttl : 600;
        iceCache = { servers, until: now + (ttl * 1000) / 2, origin: deps.origin };
        return servers;
    }
    catch {
        return PUBLIC_STUN;
    }
}
/** Resolves when the peer's ICE gathering is complete, or after `ms` (no trickle: one description each way). */
export function gathered(pc, ms = 3000) {
    if (pc.iceGatheringState === "complete")
        return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            pc.onicegatheringstatechange = null;
            resolve();
        };
        const timer = setTimeout(done, ms);
        pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === "complete")
                done();
        };
    });
}
/**
 * `fetch` that waits and tries again on `429` (`Retry-After`, at most 10 s
 * a time; a whole party shares one address), `tries` times in all.
 */
export async function fetchPatiently(url, init = {}, tries = 3, deps = webDeps()) {
    for (let i = 1;; i++) {
        const r = await deps.fetch(url, init);
        if (r.status !== 429 || i >= tries)
            return r;
        const after = Number(r.headers.get("Retry-After"));
        await new Promise((res) => setTimeout(res, Math.min(10, Number.isFinite(after) && after > 0 ? after : 1) * 1000));
    }
}
/** Largest message a peer takes, bytes (playshare-design.md §6.3, the web's). */
export const MAX_MESSAGE = 64 * 1024;
/** `busy` above this many bytes waiting. */
export const BUSY_BYTES = 64 * 1024;
/** Control pings every this, ms. */
export const PING_MS = 15_000;
/** Closed (1006) after this without any message, ms. */
export const DEAD_MS = 45_000;
/** The data channel's label. */
export const CHANNEL_LABEL = "party";
/**
 * One open data channel with web mode's framing: text frames starting
 * with `!` are control (JSON after it), anything else is the party
 * protocol's. A close sends `!{"t":"close",…}` first; a channel that ends
 * without one closed with 1006.
 */
export class ChannelEnd {
    #ch;
    #o;
    #closeFrame;
    #ended = false;
    #closing = false;
    #lastSeen = Date.now();
    #timer;
    #busy = false;
    constructor(ch, o) {
        this.#ch = ch;
        this.#o = o;
        try {
            ch.binaryType = "arraybuffer";
        }
        catch { }
        ch.bufferedAmountLowThreshold = BUSY_BYTES;
        ch.onbufferedamountlow = () => {
            if (!this.#busy)
                return;
            this.#busy = false;
            this.#o.ondrain?.();
        };
        ch.onmessage = (ev) => this.#receive(ev.data);
        ch.onclose = () => this.#end(this.#closeFrame?.code ?? 1006, this.#closeFrame?.reason ?? "");
        ch.onerror = () => { };
        const pingMs = o.pingMs ?? PING_MS;
        const deadMs = o.deadMs ?? DEAD_MS;
        this.#timer = setInterval(() => {
            if (Date.now() - this.#lastSeen > deadMs) {
                this.#end(1006, "timeout");
                try {
                    ch.close();
                }
                catch { }
                return;
            }
            this.control({ t: "ping" });
        }, pingMs);
    }
    /** More than 64 KiB wait to be sent. */
    get busy() {
        return this.#busy;
    }
    get ended() {
        return this.#ended || this.#closing;
    }
    #receive(data) {
        if (this.#ended)
            return;
        this.#lastSeen = Date.now();
        if (typeof data === "string") {
            if (data.startsWith("!")) {
                let msg;
                try {
                    msg = JSON.parse(data.slice(1));
                }
                catch {
                    return;
                }
                if (typeof msg !== "object" || msg === null || Array.isArray(msg))
                    return;
                const m = msg;
                if (m["t"] === "ping")
                    this.control({ t: "pong" });
                else if (m["t"] === "pong")
                    return;
                else if (m["t"] === "close") {
                    const code = Number(m["code"]);
                    this.#closeFrame = { code: Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 1005, reason: String(m["reason"] ?? "").slice(0, 120) };
                }
                else
                    this.#o.oncontrol?.(m);
                return;
            }
            this.#o.onmessage(data);
            return;
        }
        if (data instanceof ArrayBuffer)
            this.#o.onmessage(new Uint8Array(data));
        else if (ArrayBuffer.isView(data))
            this.#o.onmessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
    }
    #send(data) {
        if (this.#ended || this.#closing || this.#ch.readyState !== "open")
            return false;
        try {
            this.#ch.send(data);
        }
        catch {
            // The browser's own queue is full (or the channel went): over.
            this.#closing = true;
            this.#hardClose(4013, "too far behind");
            return false;
        }
        if (!this.#busy && this.#ch.bufferedAmount > BUSY_BYTES)
            this.#busy = true;
        return true;
    }
    send(data) {
        return this.#send(data);
    }
    control(msg) {
        return this.#send(`!${JSON.stringify(msg)}`);
    }
    /** Sends what is queued and a close frame, then closes the channel; `onclose(code, reason)` follows. */
    close(code, reason = "") {
        if (this.#ended || this.#closing)
            return;
        reason = reason.slice(0, 120);
        this.control({ t: "close", code, reason });
        this.#closing = true;
        this.#hardClose(code, reason);
    }
    /** Waits (at most 2 s) for the queue to go out, then closes. */
    #hardClose(code, reason) {
        const ch = this.#ch;
        const start = Date.now();
        const finish = () => {
            this.#end(code, reason);
            try {
                ch.close();
            }
            catch { }
        };
        const wait = () => {
            if (ch.bufferedAmount <= 0 || ch.readyState !== "open" || Date.now() - start > 2000)
                finish();
            else
                setTimeout(wait, 20);
        };
        wait();
    }
    #end(code, reason) {
        if (this.#ended)
            return;
        this.#ended = true;
        this.#closing = true;
        if (this.#timer)
            clearInterval(this.#timer);
        this.#timer = undefined;
        this.#ch.onmessage = null;
        this.#ch.onbufferedamountlow = null;
        this.#ch.onclose = null;
        this.#o.onclose(code, reason);
    }
}
/** UTF-8 length of `s`, at most counting to `limit + 1`. */
export function utf8Over(s, limit) {
    if (s.length > limit)
        return true;
    if (s.length * 3 <= limit)
        return false;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3;
        if (n > limit)
            return true;
    }
    return false;
}
