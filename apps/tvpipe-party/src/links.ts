// Short join links: validation, codes, secrets and the SQL
// (docs/short-links.md, "The service").

import type { D1Database } from "./env.ts";

/** The room code alphabet: no vowels (no words), no 0/O. */
export const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const CODE_LENGTH = 4;
/** A code nobody refreshed for this long may be given to someone else. */
export const STALE_MS = 24 * 60 * 60 * 1000;
/** Random codes tried before giving up (503 no-code). */
export const RANDOM_TRIES = 32;
export const MAX_URL_LENGTH = 300;

const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/**
 * Cloudflare: `LABEL.trycloudflare.com`; OpenTunnel: `ROUTE.ID.opentunnel.xyz`
 * (a label per run under the machine's tunnel, docs/tunnels.md).
 */
const JOIN_URL_RE = new RegExp(
  `^https://(?:(${LABEL})\\.trycloudflare\\.com|(${LABEL}\\.${LABEL})\\.opentunnel\\.xyz)/\\?r=([A-Z]{4,8})#k=([A-Za-z0-9_-]{16,64})$`,
);

/** The code in upper case when `input` is one (any case), else null. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

/**
 * Whether `url` is one of tvpipe's own join links: one label before
 * trycloudflare.com or two before opentunnel.xyz, no port or user info, path `/`,
 * query exactly `r=ROOM`, fragment exactly `k=KEY`. Checked on the
 * string itself (not a parsed URL), so nothing is normalized away.
 */
export function isJoinUrl(url: unknown): url is string {
  return typeof url === "string" && url.length <= MAX_URL_LENGTH && JOIN_URL_RE.test(url);
}

/**
 * The frame page's link of a join link (`/p#c=LABEL&r=ROOM&k=KEY` or
 * `/p#o=ROUTE.ID&r=ROOM&k=KEY`, docs/short-links.md, "The frame page"):
 * the game in a page of tvpipe.party. Null when `url` is no join link.
 */
export function framePath(url: string): string | null {
  if (!isJoinUrl(url)) return null;
  const m = JOIN_URL_RE.exec(url)!;
  const host = m[1] !== undefined ? `c=${m[1]}` : `o=${m[2]!}`;
  return `/p#${host}&r=${m[3]!}&k=${m[4]!}`;
}

/** A uniformly random code. */
export function randomCode(): string {
  let code = "";
  const bytes = new Uint8Array(16);
  while (code.length < CODE_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      // 240 is the largest multiple of 20 below 256: no bias.
      if (b < 240 && code.length < CODE_LENGTH) code += ALPHABET[b % ALPHABET.length];
    }
  }
  return code;
}

/** 32 random bytes, base64url without padding. */
export function newSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 of the secret, lower-case hex: what the database keeps. */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

const TAKE_SQL = `INSERT INTO links (code, url, secret, created, updated) VALUES (?1, ?2, ?3, ?4, ?4)
ON CONFLICT (code) DO UPDATE SET url = ?2, secret = ?3, created = ?4, updated = ?4
WHERE links.updated < ?5`;

/**
 * Takes `code` for `url` when it is free (no row, or not refreshed for 24
 * hours). One statement, so two registrations cannot both get it.
 */
export async function takeCode(
  db: D1Database,
  code: string,
  url: string,
  secretHash: string,
  now: number,
): Promise<boolean> {
  const res = await db.prepare(TAKE_SQL).bind(code, url, secretHash, now, now - STALE_MS).run();
  return res.meta.changes === 1;
}

export interface Registration {
  code: string;
  url: string;
  secret: string;
}

/**
 * Registers `url`: under `proposed` when that is a valid, free code, else
 * under a random free one. Null when no free code was found.
 */
export async function register(
  db: D1Database,
  url: string,
  proposed: unknown,
  now: number,
): Promise<Registration | null> {
  const secret = newSecret();
  const hash = await hashSecret(secret);
  const wanted = normalizeCode(proposed);
  if (wanted !== null && (await takeCode(db, wanted, url, hash, now))) {
    return { code: wanted, url, secret };
  }
  for (let i = 0; i < RANDOM_TRIES; i++) {
    const code = randomCode();
    if (await takeCode(db, code, url, hash, now)) return { code, url, secret };
  }
  return null;
}

/**
 * Refreshes the code's row (and replaces its url when given). The url it
 * now redirects to, or null when the code has no row or the secret does
 * not match.
 */
export async function refresh(
  db: D1Database,
  code: string,
  secret: string,
  url: string | null,
  now: number,
): Promise<string | null> {
  const hash = await hashSecret(secret);
  const row = await db
    .prepare(
      "UPDATE links SET updated = ?1, url = COALESCE(?2, url) WHERE code = ?3 AND secret = ?4 RETURNING url",
    )
    .bind(now, url, code, hash)
    .first<{ url: string }>();
  return row ? row.url : null;
}

/** Deletes the code's row when the secret matches; nothing otherwise. */
export async function remove(db: D1Database, code: string, secret: string): Promise<void> {
  const hash = await hashSecret(secret);
  await db.prepare("DELETE FROM links WHERE code = ?1 AND secret = ?2").bind(code, hash).run();
}

/** The join link of `code`, regardless of its age. */
export async function lookup(db: D1Database, code: string): Promise<string | null> {
  const row = await db.prepare("SELECT url FROM links WHERE code = ?1").bind(code).first<{ url: string }>();
  return row ? row.url : null;
}
