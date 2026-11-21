/**
 * One party (a room): its players and screens, their views, actions and
 * messages (docs/party-protocol.md). It runs in the game's host page and
 * takes its connections from tvpipe's relay ({@link Party.listen}); the
 * protocol checks (`hello`, keys, names, limits) are all here.
 */
import { Emitter } from "./emitter.js";
import { TokenBucket, WindowCounter } from "./limits.js";
import { cleanText, MAX_NAME, nameKey } from "./names.js";
import { deepEqual, diffAt, isObject, StateBox, toJson } from "./sync.js";
export const PROTOCOL = 1;
/** Why a client was sent away (`bye`), and the close code that goes with it. */
export const BYE = {
    protocol: 4002,
    "bad-key": 4003,
    "no-room": 4004,
    "no-player": 4005,
    "name-taken": 4006,
    "name-invalid": 4007,
    "rate-limited": 4008,
    replaced: 4009,
    kicked: 4010,
    "room-closed": 4011,
    slow: 4013,
    /** The room goes on with another game (tvpipe's, docs/game-switching.md): phones go to their join link. */
    "next-game": 4014,
    full: 4029,
    locked: 4029,
    "in-progress": 4030,
};
export const LATE_JOIN = ["closed", "wait", "open"];
/** An error for the phone: `act()` there rejects with this code and message. */
export class PartyError extends Error {
    code;
    constructor(code, message = code) {
        super(message);
        this.name = "PartyError";
        this.code = code;
    }
}
function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
}
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** Base64url without padding. */
export function base64url(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
        out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
        if (i + 1 < bytes.length)
            out += B64URL[(n >> 6) & 63];
        if (i + 2 < bytes.length)
            out += B64URL[n & 63];
    }
    return out;
}
/** A random token: 128 bits, base64url. */
export function token() {
    return base64url(randomBytes(16));
}
/** Constant-time string comparison (for keys and tokens). */
export function sameToken(a, b) {
    if (typeof a !== "string" || a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
/** Room codes: four consonants (no words, no 0/O confusion). */
const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
export function roomCode() {
    return [...randomBytes(4)].map((x) => CODE_LETTERS[x % CODE_LETTERS.length]).join("");
}
/** The first message must come within this, ms. */
export const HELLO_TIMEOUT = 5000;
/** Failed `hello`s per address and minute before its new sockets are closed. */
const FAILED_HELLOS = 20;
/** UTF-8 length of a string (stats). */
function utf8Length(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80)
            n += 1;
        else if (c < 0x800)
            n += 2;
        else if (c >= 0xd800 && c <= 0xdbff) {
            n += 4;
            i++;
        }
        else
            n += 3;
    }
    return n;
}
/** Results of earlier actions kept per player, for replays. */
const ACK_CACHE = 32;
/** Largest message other than `act`. */
const MAX_CONTROL_MESSAGE = 16 * 1024;
/** Largest `in` message (continuous input). */
const MAX_INPUT = 4 * 1024;
/** A player: a person with a phone, across reconnects. */
export class Player {
    role = "player";
    id;
    name;
    vip = false;
    /** @internal */ waitingFlag = false;
    /** What only this player sees (`view.me` on the phone). */
    state;
    /** The game's own data about the player (not sent anywhere). */
    data = {};
    joinedAt = Date.now();
    /** @internal */ resume;
    /** @internal */ lastAct = 0;
    /** @internal */ results = new Map();
    /** @internal */ client;
    /** The latest continuous input (`in`) from the phone, if any. */
    input;
    constructor(id, name, changed) {
        this.id = id;
        this.name = name;
        this.resume = token();
        this.state = new StateBox(changed);
    }
    get connected() {
        return this.client !== undefined;
    }
    /**
     * Joined while a game was in progress and not dealt in yet: the game
     * decides when ({@link Party.activate}). In the roster as `waiting: true`.
     */
    get waiting() {
        return this.waitingFlag;
    }
    toJSON() {
        const o = { id: this.id, name: this.name, vip: this.vip, connected: this.connected };
        if (this.waitingFlag)
            o["waiting"] = true;
        return o;
    }
}
/** One socket after its `hello`. @internal */
export class Client {
    conn;
    role;
    id;
    address;
    player;
    /** The view this client has (after the last `state`). */
    sent;
    /** The versions of `sent`'s sections (`Section.id` → version). */
    have = new Map();
    rev = 0;
    waiting = false;
    bucket;
    /** Screens: action ids seen on this connection. */
    lastAct = 0;
    /** The last `in` sequence number on this connection. */
    inSeq = 0;
    /** While `waiting`: the latest `at` of a TV-synced change it has not got. */
    heldAt;
    constructor(conn, role, id, address, rate, burst) {
        this.conn = conn;
        this.role = role;
        this.id = id;
        this.address = address;
        this.bucket = new TokenBucket(rate, burst);
    }
    send(msg) {
        return this.sendText(JSON.stringify(msg));
    }
    /** A message already serialized (tvpipe closes a client that falls too far behind: 4013). */
    sendText(text) {
        if (this.conn.closed)
            return false;
        this.conn.send(text);
        return true;
    }
    bye(reason, message) {
        bye(this.conn, reason, message);
    }
}
/** The most a TV may be behind, ms (larger values are taken as this). */
export const MAX_TV_DELAY = 5000;
/** How far back an action's `at` may claim it was sent, ms. */
const MAX_ACT_AGE = 1000;
let partySeq = 0;
export class Party extends Emitter {
    code;
    joinKey;
    screenKey = token();
    watchKey = token();
    /** What every player sees (`view.room`). */
    room;
    /** What screens see (`view.screen`). */
    screen;
    maxPlayers;
    grace;
    /** @internal */ uid = ++partySeq;
    #join;
    #players = [];
    #clients = new Set();
    #handlers = new Map();
    #locked = false;
    #lateJoin;
    #reclaim;
    #inProgress = false;
    #closed = false;
    #seq = 0;
    #screenSeq = 0;
    #flushQueued = false;
    #tvDelay = 0;
    #tvFixed = false;
    /** Inside {@link Party.withTv}: when the changes are to show. */
    #at;
    #stats = { flushes: 0, states: 0, stateBytes: 0, flushMs: 0 };
    #screenView;
    #rosterSection = { version: 0, value: [] };
    #joinSection = { version: 0, value: null };
    #moderate;
    #limits;
    #log;
    #failed = new WindowCounter(FAILED_HELLOS, 60_000);
    /** @internal */ onClose;
    constructor(options = {}) {
        super();
        this.code = options.code ?? roomCode();
        this.joinKey = options.joinKey ?? token();
        this.maxPlayers = options.maxPlayers ?? 8;
        this.grace = options.grace ?? 500;
        this.#moderate = options.moderate;
        this.#limits = { rate: 20, burst: 50, screens: 16, ...options.limits };
        this.#log = options.log ?? (() => { });
        this.#lateJoin = options.lateJoin ?? "wait";
        this.#reclaim = options.reclaim ?? true;
        if (!LATE_JOIN.includes(this.#lateJoin))
            throw new TypeError(`lateJoin: ${String(options.lateJoin)}`);
        this.room = new StateBox(() => this.#changed());
        this.screen = new StateBox(() => this.#changed());
        this.#join = { code: this.code, url: "", qr: null };
        if (options.tvDelay !== undefined) {
            this.#tvFixed = true;
            this.#tvDelay = clampDelay(options.tvDelay);
        }
    }
    /** The server's clock (ms since the epoch): deadlines in views use it. */
    now() {
        return Date.now();
    }
    /**
     * How far the TV picture is behind the host, ms: from a change here to
     * the TV showing it (render, capture, the receivers' playout delay,
     * the TV's own lag). 0 without a TV. A party in a host page follows
     * its casts and surfaces (`HostedParty`); setting it fixes it (a
     * game's own calibration, a fake TV in tests).
     */
    get tvDelay() {
        return this.#tvDelay;
    }
    set tvDelay(ms) {
        this.#tvFixed = true;
        this.#setTvDelay(ms);
    }
    /** The measured delay, unless the game fixed it. @internal */
    followTv(ms) {
        if (!this.#tvFixed)
            this.#setTvDelay(ms);
    }
    #setTvDelay(ms) {
        const d = clampDelay(ms);
        if (d === this.#tvDelay)
            return;
        this.#tvDelay = d;
        this.#log("info", `party ${this.code}: the TV is ${d} ms behind`);
        const msg = JSON.stringify({ t: "tv", delay: d });
        for (const c of this.#clients)
            if (c.sent)
                c.sendText(msg);
        this.emit("tv", d);
    }
    /**
     * A deadline `ms` after what is changed now shows on the TV (and,
     * with {@link withTv}, on the phones): `now() + tvDelay + ms`. Players
     * get the whole `ms`, counted from when they see the question.
     */
    deadline(ms) {
        return this.now() + this.#tvDelay + ms;
    }
    /**
     * The time a TV picture drawn now is shown at: `now() + tvDelay`. A
     * surface or video screen drawn in the host page counts down with it
     * (TV pages have it as their client's `now()`).
     */
    screenNow() {
        return this.now() + this.#tvDelay;
    }
    /**
     * Runs `fn` (synchronously) and has what it changes reach phones when
     * the TV shows it: the views (`room`, `me`, `screen`) and messages
     * (`send`, `broadcast`) carry the time the TV picture with them comes
     * up, and phones and watchers apply them then (TV pages at once).
     * For what the TV shows: a new phase, results, a buzz with a flash.
     * Changes from before `fn` go out at once, as usual; replies to a
     * phone's own action belong outside. Without a TV (`tvDelay` 0) it
     * only runs `fn`. Returns what `fn` returns.
     */
    withTv(fn) {
        if (this.#at !== undefined || this.#tvDelay === 0)
            return fn();
        this.#flushNow();
        this.#at = this.now() + this.#tvDelay;
        try {
            return fn();
        }
        finally {
            this.#flushNow();
            this.#at = undefined;
        }
    }
    /** Players in join order (away ones included). */
    get players() {
        return this.#players;
    }
    /** Players whose phone is connected. */
    get connectedPlayers() {
        return this.#players.filter((p) => p.connected);
    }
    get vip() {
        return this.#players.find((p) => p.vip);
    }
    get locked() {
        return this.#locked;
    }
    get closed() {
        return this.#closed;
    }
    /** The join link and its QR code, shown by screens (`view.join`). */
    get joinInfo() {
        return this.#join;
    }
    set joinInfo(info) {
        this.#join = info;
        this.#joinChanged();
    }
    /**
     * A link that brings `player` back on any phone: the join link with
     * the player's resume token (`#k=JOINKEY&p=TOKEN`). Show it only to
     * that player (the host page: {@link HostedParty.showRejoin}); it is
     * as good as their phone. `null` before the party has a join link.
     */
    rejoinLink(player) {
        const url = this.#join.url;
        if (!url || !this.#players.includes(player))
            return null;
        return `${url}${url.includes("#") ? "&" : "#"}p=${player.resume}`;
    }
    /** Who may join while a game is in progress (screens see it as `join.lateJoin`). */
    get lateJoin() {
        return this.#lateJoin;
    }
    set lateJoin(mode) {
        if (!LATE_JOIN.includes(mode))
            throw new TypeError(`lateJoin: ${String(mode)}`);
        if (mode === this.#lateJoin)
            return;
        this.#lateJoin = mode;
        this.#joinChanged();
    }
    /**
     * Whether a game is in progress (the game says so): new names then
     * join as waiting players, or are refused with `lateJoin` `closed`.
     * Screens see it as `join.inProgress`.
     */
    get inProgress() {
        return this.#inProgress;
    }
    set inProgress(on) {
        if (on === this.#inProgress)
            return;
        this.#inProgress = on;
        this.#joinChanged();
    }
    /** Deals a waiting player in (`waiting` off, the `active` event); false if they were not waiting. */
    activate(p) {
        if (!p.waitingFlag || !this.#players.includes(p))
            return false;
        p.waitingFlag = false;
        this.emit("active", p);
        this.#changed();
        return true;
    }
    /** The join section: the join info, the late-join setting, whether a game is on. */
    #joinValue() {
        return toJson({ ...this.#join, lateJoin: this.#lateJoin, inProgress: this.#inProgress });
    }
    #joinChanged() {
        this.#joinSection = { version: this.#joinSection.version + 1, value: this.#joinValue() };
        this.#changed();
    }
    /** What the views cost so far (a copy). */
    get stats() {
        return { ...this.#stats };
    }
    player(id) {
        return this.#players.find((p) => p.id === id);
    }
    /** What screens see: `{ roster, screen, join }` (also what a video renderer draws). */
    screenView() {
        this.#screenView ??= {
            roster: this.#roster(),
            screen: this.screen.peek(),
            join: this.#joinValue(),
        };
        return this.#screenView;
    }
    /** What a player sees: `{ roster, room, me }`. */
    playerView(p) {
        return { roster: this.#roster(), room: this.room.peek(), me: p.state.peek() };
    }
    #roster() {
        return this.#players.map((p) => p.toJSON());
    }
    /** No new players from now on (resumes still work). */
    lock() {
        this.#locked = true;
    }
    unlock() {
        this.#locked = false;
    }
    /** Handles actions of `type`; the return value is the phone's result. */
    handle(type, handler) {
        this.#handlers.set(type, handler);
        return () => {
            if (this.#handlers.get(type) === handler)
                this.#handlers.delete(type);
        };
    }
    /** Runs the `moderate` hook on a text the game shows (`false`: refused). */
    moderate(text, kind, player) {
        const r = this.#moderate?.(text, { kind, player });
        if (r === false)
            return false;
        return typeof r === "string" ? r : text;
    }
    /** A transient message to one player (lost when the phone is away). */
    send(to, type, data = null) {
        to.client?.send(this.#msg(type, data));
    }
    /** A transient message to every connected client of a role (default: players). */
    broadcast(type, data = null, role = "player") {
        const msg = this.#msg(type, data);
        for (const c of this.#clients)
            if (role === "all" || c.role === role)
                c.send(msg);
    }
    #msg(type, data) {
        const msg = { t: "msg", type, data: toJson(data) };
        if (this.#at !== undefined)
            msg["at"] = this.#at;
        return msg;
    }
    /** Removes a player for good, telling their phone. */
    kick(player, reason = "kicked") {
        player.client?.bye("kicked", reason);
        this.#remove(player, "kicked");
    }
    /**
     * Makes a player the VIP (the host's choice: the roster and the `vip`
     * event follow). The VIP stays when the player is away; a player who
     * left is ignored.
     */
    makeVip(player) {
        if (player.vip || !this.#players.includes(player))
            return;
        for (const p of this.#players)
            p.vip = false;
        player.vip = true;
        this.#log("info", `party ${this.code}: ${player.name} is the VIP`);
        this.emit("vip", player);
        this.#changed();
    }
    /** Ends the party: every client gets `bye room-closed`. */
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        for (const c of this.#clients)
            c.bye("room-closed");
        this.#clients.clear();
        this.onClose?.();
    }
    /**
     * Waits for one action of `type` from each player (or the deadline),
     * resolving with the answers. Answers from others, or a second one,
     * are refused (`not-asked`, `already-answered`).
     */
    collect(type, options = {}) {
        const from = new Set(options.from ?? this.#players);
        const answers = new Map();
        const grace = options.grace ?? this.grace;
        return new Promise((resolve) => {
            let done = false;
            let timer;
            const finish = () => {
                if (done)
                    return;
                done = true;
                if (timer)
                    clearTimeout(timer);
                off();
                this.off("away", check);
                this.off("leave", onLeave);
                options.signal?.removeEventListener("abort", finish);
                resolve(answers);
            };
            // With a deadline, players who are away may still come back and
            // answer; without one (or with `skipAway`), only connected players
            // are waited for, and at least one must be there.
            const check = () => {
                if (from.size === 0)
                    return finish();
                const all = [...from];
                if (options.until !== undefined && !options.skipAway) {
                    if (all.every((p) => answers.has(p)))
                        finish();
                    return;
                }
                if (!all.some((p) => p.connected))
                    return;
                if (all.every((p) => answers.has(p) || !p.connected))
                    finish();
            };
            const onLeave = (p) => {
                from.delete(p);
                check();
            };
            const off = this.handle(type, (data, sender, info) => {
                if (sender.role !== "player" || !from.has(sender))
                    throw new PartyError("not-asked", "Not your turn");
                if (answers.has(sender) && !options.replace)
                    throw new PartyError("already-answered", "Already sent");
                const value = options.validate ? options.validate(data, sender, info) : data;
                answers.set(sender, value);
                options.onAnswer?.(sender, value, answers, info);
                queueMicrotask(check);
                return options.reply ? options.reply(value, sender) : null;
            });
            this.on("away", check);
            this.on("leave", onLeave);
            options.signal?.addEventListener("abort", finish, { once: true });
            if (options.signal?.aborted)
                return finish();
            if (options.until !== undefined) {
                timer = setTimeout(finish, Math.max(0, options.until + grace - this.now()));
            }
            check();
        });
    }
    // -------------------------------------------------------------------------
    // Connections
    /** Takes the connections of a relay (tvpipe's, or a test's). */
    listen(relay) {
        relay.onopen = (conn) => this.accept(conn);
        relay.onclosing = () => this.close();
        return this;
    }
    /** A new connection: waits for its `hello` (5 s). */
    accept(conn) {
        const address = conn.address;
        if (this.#closed)
            return bye(conn, "room-closed");
        if (this.#failed.over(address)) {
            this.#log("warn", `party ${this.code}: too many failed joins from ${address}`);
            return bye(conn, "rate-limited");
        }
        const fail = (reason, message) => {
            this.#failed.hit(address);
            bye(conn, reason, message);
        };
        const timer = setTimeout(() => fail("protocol", "no hello"), HELLO_TIMEOUT);
        conn.onclose = () => clearTimeout(timer);
        conn.onmessage = (data) => {
            clearTimeout(timer);
            conn.onmessage = undefined;
            conn.onclose = undefined;
            let hello;
            try {
                hello = typeof data === "string" ? JSON.parse(data) : undefined;
            }
            catch {
                hello = undefined;
            }
            if (!isObject(hello) || hello["t"] !== "hello" || hello["v"] !== PROTOCOL) {
                return fail("protocol", "expected hello, version 1");
            }
            const code = typeof hello["room"] === "string" ? hello["room"].toUpperCase() : "";
            if (code !== this.code) {
                this.#log("warn", `party ${this.code}: hello for room ${JSON.stringify(code.slice(0, 8))} from ${address}`);
                return fail("no-room");
            }
            this.attach(conn, hello, address, () => this.#failed.hit(address));
        };
    }
    /** A connection's `hello` for this party. @internal */
    attach(ws, hello, address, failed = () => { }) {
        if (this.#closed) {
            bye(ws, "room-closed");
            return;
        }
        const role = hello.role;
        if (role === "screen" || role === "watch") {
            const key = role === "screen" ? this.screenKey : this.watchKey;
            if (!sameToken(hello.key, key)) {
                this.#log("warn", `party ${this.code}: ${role} with a wrong key from ${address}`);
                failed();
                return bye(ws, "bad-key");
            }
            const screens = [...this.#clients].filter((c) => c.role !== "player").length;
            if (screens >= this.#limits.screens)
                return bye(ws, "full");
            const c = new Client(ws, role, `s${++this.#screenSeq}`, address, this.#limits.rate, this.#limits.burst);
            this.#adopt(c);
            this.#welcome(c);
            this.emit("screen", { role, id: c.id }, true);
            return;
        }
        if (role !== "player")
            return bye(ws, "protocol");
        // A known player coming back.
        if (typeof hello.resume === "string") {
            const p = this.#players.find((x) => sameToken(hello.resume, x.resume));
            if (p)
                return this.#takeBack(ws, p, address, "is back");
        }
        if (!sameToken(hello.key, this.joinKey)) {
            this.#log("warn", `party ${this.code}: a join with a wrong key from ${address}`);
            failed();
            return bye(ws, "bad-key");
        }
        if (hello.name === undefined || hello.name === null)
            return bye(ws, "no-player");
        // The name of a player who is away: that player, on a new phone (the
        // old one's token stops working). Before the checks for newcomers:
        // a locked or full room takes its own players back.
        if (this.#reclaim) {
            const typed = cleanText(hello.name, MAX_NAME);
            const p = typed ? this.#players.find((x) => !x.connected && nameKey(x.name) === nameKey(typed)) : undefined;
            if (p) {
                p.resume = token();
                return this.#takeBack(ws, p, address, "is back on another phone");
            }
        }
        if (this.#locked)
            return bye(ws, "locked");
        if (this.#inProgress && this.#lateJoin === "closed")
            return bye(ws, "in-progress", "A game is in progress");
        if (this.#players.length >= this.maxPlayers)
            return bye(ws, "full");
        let name = cleanText(hello.name, MAX_NAME);
        if (!name)
            return bye(ws, "name-invalid", "Pick a name");
        const moderated = this.moderate(name, "name");
        if (moderated === false)
            return bye(ws, "name-invalid", "Pick another name");
        name = cleanText(moderated, MAX_NAME);
        if (!name)
            return bye(ws, "name-invalid", "Pick a name");
        const key = nameKey(name);
        if (this.#players.some((p) => nameKey(p.name) === key))
            return bye(ws, "name-taken", "Someone has that name");
        const p = new Player(`p${++this.#seq}`, name, () => this.#changed());
        p.waitingFlag = this.#inProgress;
        const c = new Client(ws, "player", p.id, address, this.#limits.rate, this.#limits.burst);
        c.player = p;
        p.client = c;
        this.#players.push(p);
        if (!this.vip) {
            p.vip = true;
        }
        this.#adopt(c);
        this.#welcome(c);
        this.#log("info", `party ${this.code}: ${name} joined (${address})`);
        this.emit("join", p);
        if (p.vip)
            this.emit("vip", p);
        this.#changed();
    }
    /** A known player's new socket: replaces the old one (`bye replaced`). */
    #takeBack(ws, p, address, how) {
        const old = p.client;
        const c = new Client(ws, "player", p.id, address, this.#limits.rate, this.#limits.burst);
        c.player = p;
        p.client = c;
        if (old) {
            old.player = undefined;
            old.bye("replaced");
            this.#clients.delete(old);
        }
        this.#adopt(c);
        this.#welcome(c);
        this.#log("info", `party ${this.code}: ${p.name} ${how}`);
        this.emit("reconnect", p);
        this.#changed();
    }
    #adopt(c) {
        this.#clients.add(c);
        c.conn.onmessage = (data) => this.#onMessage(c, data);
        c.conn.onclose = () => this.#onClose(c);
        c.conn.ondrain = () => {
            if (c.waiting) {
                this.#refreshRoster();
                const at = c.heldAt !== undefined && c.heldAt > this.now() ? c.heldAt : undefined;
                c.heldAt = undefined;
                this.#flushClient(c, new Map(), at);
            }
        };
    }
    /** The roster's section: a new version only when it changed. */
    #refreshRoster() {
        const roster = this.#roster();
        if (!deepEqual(roster, this.#rosterSection.value))
            this.#rosterSection = { version: this.#rosterSection.version + 1, value: roster };
    }
    /** A client's view as sections (snapshots: do not modify). */
    #sections(c) {
        const roster = { key: "roster", id: "roster", ...this.#rosterSection };
        if (c.player) {
            const p = c.player;
            return [
                roster,
                { key: "room", id: "room", version: this.room.version, value: this.room.snapshot() },
                { key: "me", id: `me:${p.id}`, version: p.state.version, value: p.state.snapshot() },
            ];
        }
        if (this.#joinSection.version === 0)
            this.#joinSection = { version: 1, value: this.#joinValue() };
        return [
            roster,
            { key: "screen", id: "screen", version: this.screen.version, value: this.screen.snapshot() },
            { key: "join", id: "join", ...this.#joinSection },
        ];
    }
    /** The client's whole view now, remembered as what it has. */
    #fullView(c) {
        this.#refreshRoster();
        const view = {};
        c.have = new Map();
        for (const s of this.#sections(c)) {
            view[s.key] = s.value;
            c.have.set(s.id, s.version);
        }
        c.sent = view;
        return view;
    }
    #welcome(c) {
        const view = this.#fullView(c);
        c.rev = 0;
        const you = { id: c.id, role: c.role };
        if (c.player) {
            you["name"] = c.player.name;
            you["vip"] = c.player.vip;
            you["resume"] = c.player.resume;
            you["lastAct"] = c.player.lastAct;
        }
        const welcome = { t: "welcome", v: PROTOCOL, room: { code: this.code }, you, now: this.now(), view, rev: 0 };
        if (this.#tvDelay > 0)
            welcome["tv"] = { delay: this.#tvDelay };
        c.send(welcome);
    }
    #onClose(c) {
        this.#clients.delete(c);
        const p = c.player;
        if (p && p.client === c) {
            p.client = undefined;
            this.#log("info", `party ${this.code}: ${p.name} is away`);
            this.emit("away", p);
            this.#changed();
        }
        else if (c.role !== "player") {
            this.emit("screen", { role: c.role, id: c.id }, false);
        }
    }
    #remove(p, reason) {
        const i = this.#players.indexOf(p);
        if (i < 0)
            return;
        this.#players.splice(i, 1);
        if (p.client) {
            p.client.player = undefined;
            p.client = undefined;
        }
        const wasVip = p.vip;
        p.vip = false;
        this.#log("info", `party ${this.code}: ${p.name} left (${reason})`);
        this.emit("leave", p, reason);
        if (wasVip) {
            const next = this.#players.find((x) => x.connected) ?? this.#players[0];
            if (next)
                next.vip = true;
            this.emit("vip", next);
        }
        this.#changed();
    }
    #onMessage(c, data) {
        if (c.conn.closed)
            return;
        if (!c.bucket.take())
            return c.bye("rate-limited");
        if (typeof data !== "string")
            return c.bye("protocol", "binary messages are not used");
        let msg;
        try {
            msg = JSON.parse(data);
        }
        catch {
            return c.bye("protocol", "not JSON");
        }
        if (!isObject(msg))
            return c.bye("protocol", "not an object");
        if (msg["t"] === "in" && data.length > MAX_INPUT)
            return;
        if (msg["t"] !== "act" && data.length > MAX_CONTROL_MESSAGE)
            return c.bye("protocol", "too big");
        switch (msg["t"]) {
            case "act":
                return void this.#onAct(c, msg);
            case "ping":
                c.send({ t: "pong", c: typeof msg["c"] === "number" ? msg["c"] : 0, now: this.now() });
                return;
            case "resync": {
                const view = this.#fullView(c);
                c.send({ t: "state", rev: ++c.rev, full: view });
                return;
            }
            case "in": {
                // Latest wins by `s` (per connection).
                const seq = msg["s"];
                const p = c.player;
                if (!p || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= c.inSeq)
                    return;
                c.inSeq = seq;
                p.input = msg["data"] ?? null;
                this.emit("input", p, p.input);
                return;
            }
            case "leave":
                if (c.player) {
                    const p = c.player;
                    this.#remove(p, "left");
                }
                c.conn.close(1000, "left");
                return;
            default:
                return; // unknown types are ignored
        }
    }
    async #onAct(c, msg) {
        const id = msg["id"];
        const type = msg["type"];
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || typeof type !== "string") {
            return c.bye("protocol", "bad act");
        }
        const data = msg["data"] ?? null;
        const received = this.now();
        const at = msg["at"];
        const info = {
            sentAt: typeof at === "number" && Number.isFinite(at) ? Math.min(received, Math.max(received - MAX_ACT_AGE, at)) : received,
        };
        if (c.role === "watch") {
            c.send({ t: "ack", id, ok: false, error: { code: "read-only", message: "Watchers cannot act" } });
            return;
        }
        const p = c.player;
        if (!p) {
            if (id <= c.lastAct)
                return;
            c.lastAct = id;
            const ack = await this.#run(id, type, data, { role: c.role, id: c.id }, info);
            c.send(ack);
            return;
        }
        if (id <= p.lastAct) {
            const cached = p.results.get(id);
            const ack = cached ? await cached : { t: "ack", id, ok: true, dup: true };
            p.client?.send(ack);
            return;
        }
        p.lastAct = id;
        const pending = this.#run(id, type, data, p, info);
        p.results.set(id, pending);
        const ack = await pending;
        p.results.set(id, ack);
        while (p.results.size > ACK_CACHE)
            p.results.delete(p.results.keys().next().value);
        // The player's current socket: it may have reconnected meanwhile.
        p.client?.send(ack);
    }
    async #run(id, type, data, from, info) {
        const handler = this.#handlers.get(type);
        if (!handler)
            return { t: "ack", id, ok: false, error: { code: "unknown-action", message: `No ${type} now` } };
        try {
            const result = await handler(data, from, info);
            const ack = { t: "ack", id, ok: true };
            if (result !== undefined && result !== null)
                ack.result = toJson(result);
            return ack;
        }
        catch (err) {
            if (err instanceof PartyError)
                return { t: "ack", id, ok: false, error: { code: err.code, message: err.message } };
            this.#log("error", `party ${this.code}: action ${type}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
            return { t: "ack", id, ok: false, error: { code: "internal", message: "Something went wrong" } };
        }
    }
    // -------------------------------------------------------------------------
    // Views
    #changed() {
        this.#screenView = undefined;
        if (this.#flushQueued)
            return;
        this.#flushQueued = true;
        queueMicrotask(() => this.#flushNow());
    }
    /** Sends the changes so far (if any) now; inside `withTv` stamped with its time. */
    #flushNow() {
        if (!this.#flushQueued)
            return;
        this.#flushQueued = false;
        const t0 = performance.now();
        this.#refreshRoster();
        const diffs = new Map();
        for (const c of this.#clients)
            this.#flushClient(c, diffs, this.#at);
        this.#stats.flushes++;
        this.#stats.flushMs += performance.now() - t0;
        if (this.listenerCount("screen-view") > 0)
            this.emit("screen-view", this.screenView());
    }
    /**
     * Sends a client the diff of its view: only the sections whose version
     * moved, each section's diff computed and serialized once per flush
     * for every client that had the same version (`diffs`). The message is
     * what `JSON.stringify({t, rev, set, del})` of the whole view's diff
     * gives.
     */
    #flushClient(c, diffs, at) {
        if (c.conn.closed || !c.sent || (c.role === "player" && !c.player))
            return;
        if (c.conn.busy) {
            // Latest wins: one diff against what it has once the socket drains.
            c.waiting = true;
            if (at !== undefined)
                c.heldAt = Math.max(c.heldAt ?? 0, at);
            return;
        }
        c.waiting = false;
        const sent = c.sent;
        const set = [];
        const del = [];
        for (const s of this.#sections(c)) {
            const had = c.have.get(s.id);
            if (had === s.version)
                continue;
            const cacheKey = had === undefined ? undefined : `${s.id}:${had}`;
            let d = cacheKey ? diffs.get(cacheKey) : undefined;
            if (!d) {
                const old = sent[s.key];
                if (old !== undefined && isObject(old) && isObject(s.value)) {
                    const at = diffAt(old, s.value, [s.key]);
                    d = { del: at.del.map((p) => JSON.stringify(p)) };
                    if (Object.keys(at.set).length > 0)
                        d.set = `${JSON.stringify(s.key)}:${JSON.stringify(at.set)}`;
                }
                else if (old === undefined || !deepEqual(old, s.value)) {
                    d = { set: `${JSON.stringify(s.key)}:${JSON.stringify(s.value)}`, del: [] };
                }
                else {
                    d = { del: [] };
                }
                if (cacheKey)
                    diffs.set(cacheKey, d);
            }
            if (d.set)
                set.push(d.set);
            del.push(...d.del);
            sent[s.key] = s.value;
            c.have.set(s.id, s.version);
        }
        if (set.length === 0 && del.length === 0)
            return;
        let text = `{"t":"state","rev":${++c.rev}`;
        if (at !== undefined)
            text += `,"at":${at}`;
        if (set.length > 0)
            text += `,"set":{${set.join(",")}}`;
        if (del.length > 0)
            text += `,"del":[${del.join(",")}]`;
        text += "}";
        this.#stats.states++;
        this.#stats.stateBytes += utf8Length(text);
        c.sendText(text);
    }
}
function clampDelay(ms) {
    return Number.isFinite(ms) ? Math.round(Math.min(MAX_TV_DELAY, Math.max(0, ms))) : 0;
}
function bye(conn, reason, message) {
    if (conn.closed)
        return;
    const msg = { t: "bye", reason };
    if (message)
        msg["message"] = message;
    conn.send(JSON.stringify(msg));
    conn.close(BYE[reason], reason);
}
export { bye as sendBye };
