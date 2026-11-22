/**
 * The web mode's state of a tab (docs/browser-party-design.md, "The
 * session"): `sessionStorage["tvpipe-web"]`, so a reload keeps the room
 * and a new tab makes a new one. Pages of tvpipe.party (the games list,
 * the launcher, the host page's `WebHub`) share it.
 */

export interface WebSession {
  /** The registered room. */
  room?: { code: string; key: string; secret: string; short: string };
  /** The launcher's choice. */
  screen?: "this" | "window" | "cable" | "none";
  /** The game in the slot. */
  game?: { name: string; release: string };
  /** Approved extra screens' tokens. */
  screens?: string[];
}

export const SESSION_KEY = "tvpipe-web";

/** In-memory fallback (no `sessionStorage`, or it refuses). */
let fallback: WebSession = {};

function storage(): Storage | null {
  try {
    const s = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (!s) return null;
    s.getItem(SESSION_KEY);
    return s;
  } catch {
    return null;
  }
}

function clean(v: unknown): WebSession {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const o = v as Record<string, any>;
  const out: WebSession = {};
  const r = o["room"];
  if (r && typeof r.code === "string" && typeof r.key === "string" && typeof r.secret === "string" && typeof r.short === "string") {
    out.room = { code: r.code, key: r.key, secret: r.secret, short: r.short };
  }
  if (o["screen"] === "this" || o["screen"] === "window" || o["screen"] === "cable" || o["screen"] === "none") out.screen = o["screen"];
  const g = o["game"];
  if (g && typeof g.name === "string" && typeof g.release === "string") out.game = { name: g.name, release: g.release };
  if (Array.isArray(o["screens"])) out.screens = o["screens"].filter((t: unknown): t is string => typeof t === "string").slice(-64);
  return out;
}

/** The tab's session (empty when there is none). */
export function readWebSession(): WebSession {
  const s = storage();
  if (!s) return clean(fallback);
  try {
    const text = s.getItem(SESSION_KEY);
    return text ? clean(JSON.parse(text)) : {};
  } catch {
    return {};
  }
}

/** Merges `patch` into the session (an `undefined` field removes it); returns the new session. */
export function writeWebSession(patch: Partial<WebSession>): WebSession {
  const next: Record<string, unknown> = { ...readWebSession() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  const out = clean(next);
  const s = storage();
  if (!s) fallback = out;
  else {
    try {
      s.setItem(SESSION_KEY, JSON.stringify(out));
    } catch {
      fallback = out;
    }
  }
  return out;
}

/** Forgets the session (Quit). */
export function clearWebSession(): void {
  fallback = {};
  try {
    storage()?.removeItem(SESSION_KEY);
  } catch {}
}
