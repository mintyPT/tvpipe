// GET /api/turn: the ICE servers pages use for WebRTC
// (docs/browser-party-design.md, "TURN credentials"): public STUN, and
// Cloudflare TURN credentials when the Worker has a TURN key and the
// month's TURN traffic is under the cap (turncap.ts).

import type { Env } from "./env.ts";
import { turnCap, type TurnCap } from "./turncap.ts";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceConfig {
  iceServers: IceServer[];
  /** Seconds the configuration stays good; pages keep it for half. */
  ttl: number;
}

export const STUN: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
/**
 * What Cloudflare is asked for: 1 hour, so that the cap takes effect
 * within the hour (credentials handed out stay good until they expire).
 */
export const TURN_TTL = 3600;
/** Without a TURN key: STUN does not expire, but pages should look again now and then. */
export const STUN_TTL = 21600;
/** When Cloudflare failed or TURN is capped: ask again soon. */
export const FAILED_TTL = 300;
export const TURN_TIMEOUT_MS = 3000;

const TURN_URL = "https://rtc.live.cloudflare.com/v1/turn/keys/";

/**
 * Credentials are shared by everyone the isolate answers for half their
 * life (a page keeps them for half of what is left): one request to
 * Cloudflare per isolate and 30 minutes, not one per phone.
 */
let cache: { servers: IceServer[]; expires: number } | null = null;
/** The cap's last state, to log changes only. */
let lastCap: TurnCap = "ok";

/** Forgets the cached credentials (tests). */
export function clearTurnCache(): void {
  cache = null;
  lastCap = "ok";
}

function stringList(v: unknown): string[] | null {
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((u) => typeof u === "string")) return v as string[];
  return null;
}

/**
 * The TURN servers of Cloudflare's answer (`{iceServers: [...]}`, or one
 * object in older answers), without its STUN (ours is in the list) and
 * without port 53, which browsers block and time out on.
 */
export function turnServers(body: unknown): IceServer[] {
  if (typeof body !== "object" || body === null) return [];
  const raw = (body as { iceServers?: unknown }).iceServers;
  const list = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];
  const out: IceServer[] = [];
  for (const s of list) {
    if (typeof s !== "object" || s === null) continue;
    const { urls, username, credential } = s as Record<string, unknown>;
    if (typeof username !== "string" || typeof credential !== "string") continue;
    const kept = (stringList(urls) ?? []).filter((u) => /^turns?:/.test(u) && !/:53(?:\?|$)/.test(u));
    if (kept.length > 0) out.push({ urls: kept, username, credential });
  }
  return out;
}

/** The ICE configuration, now (ms). `fetcher` is the global fetch, replaceable for tests. */
export async function iceConfig(env: Env, now: number, fetcher: typeof fetch = fetch): Promise<IceConfig> {
  const id = env.TURN_KEY_ID;
  const token = env.TURN_KEY_API_TOKEN;
  if (!id || !token) return { iceServers: STUN, ttl: STUN_TTL };
  const cap = await turnCap(env, now);
  if (cap !== lastCap) {
    if (cap === "over") console.warn("TURN is off: this month's limit is reached");
    else if (cap === "stale") console.error("TURN is off: no recent usage check");
    else console.warn("TURN is on again");
    lastCap = cap;
  }
  if (cap !== "ok") return { iceServers: STUN, ttl: FAILED_TTL };
  if (cache !== null && cache.expires > now) {
    // What is left of its life, as the page counts it.
    const ttl = Math.floor((cache.expires - now) / 1000) + TURN_TTL / 2;
    return { iceServers: [...STUN, ...cache.servers], ttl };
  }
  try {
    const res = await fetcher(`${TURN_URL}${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TURN_TTL }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`TURN: ${res.status}`);
    const servers = turnServers(await res.json());
    if (servers.length === 0) throw new Error("TURN: no servers");
    cache = { servers, expires: now + (TURN_TTL / 2) * 1000 };
    return { iceServers: [...STUN, ...servers], ttl: TURN_TTL };
  } catch (e) {
    console.error("TURN credentials failed:", e instanceof Error ? e.message : e);
    return { iceServers: STUN, ttl: FAILED_TTL };
  }
}
