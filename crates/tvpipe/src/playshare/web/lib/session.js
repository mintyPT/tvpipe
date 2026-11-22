/**
 * The web mode's state of a tab (docs/browser-party-design.md, "The
 * session"): `sessionStorage["tvpipe-web"]`, so a reload keeps the room
 * and a new tab makes a new one. Pages of tvpipe.party (the games list,
 * the launcher, the host page's `WebHub`) share it.
 */
export const SESSION_KEY = "tvpipe-web";
/** In-memory fallback (no `sessionStorage`, or it refuses). */
let fallback = {};
function storage() {
    try {
        const s = globalThis.sessionStorage;
        if (!s)
            return null;
        s.getItem(SESSION_KEY);
        return s;
    }
    catch {
        return null;
    }
}
function clean(v) {
    if (typeof v !== "object" || v === null || Array.isArray(v))
        return {};
    const o = v;
    const out = {};
    const r = o["room"];
    if (r && typeof r.code === "string" && typeof r.key === "string" && typeof r.secret === "string" && typeof r.short === "string") {
        out.room = { code: r.code, key: r.key, secret: r.secret, short: r.short };
    }
    if (o["screen"] === "this" || o["screen"] === "window" || o["screen"] === "cable" || o["screen"] === "none")
        out.screen = o["screen"];
    const g = o["game"];
    if (g && typeof g.name === "string" && typeof g.release === "string")
        out.game = { name: g.name, release: g.release };
    if (Array.isArray(o["screens"]))
        out.screens = o["screens"].filter((t) => typeof t === "string").slice(-64);
    return out;
}
/** The tab's session (empty when there is none). */
export function readWebSession() {
    const s = storage();
    if (!s)
        return clean(fallback);
    try {
        const text = s.getItem(SESSION_KEY);
        return text ? clean(JSON.parse(text)) : {};
    }
    catch {
        return {};
    }
}
/** Merges `patch` into the session (an `undefined` field removes it); returns the new session. */
export function writeWebSession(patch) {
    const next = { ...readWebSession() };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined)
            delete next[k];
        else
            next[k] = v;
    }
    const out = clean(next);
    const s = storage();
    if (!s)
        fallback = out;
    else {
        try {
            s.setItem(SESSION_KEY, JSON.stringify(out));
        }
        catch {
            fallback = out;
        }
    }
    return out;
}
/** Forgets the session (Quit). */
export function clearWebSession() {
    fallback = {};
    try {
        storage()?.removeItem(SESSION_KEY);
    }
    catch { }
}
