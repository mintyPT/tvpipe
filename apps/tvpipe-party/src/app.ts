// The tvpipe.party request handler (docs/short-links.md). Static files of
// the website are served by Cloudflare before the Worker runs; it sees only
// what is not a file: the API, /CODE, /join and the 404 page. Web rooms'
// signaling is in room.ts (docs/browser-party-design.md).

import type { Env, RateLimit } from "./env.ts";
import {
  framePath,
  isJoinUrl,
  lookup,
  lookupRow,
  normalizeCode,
  refresh,
  register,
  registerExactly,
  remove,
  webLink,
} from "./links.ts";
import { joinPage, notFoundPage } from "./pages.ts";
import { MAX_QUERY, OWNER_HEADER, type RoomState } from "./room.ts";
import { iceConfig } from "./turn.ts";

/** Request bodies over this many bytes: 413. */
export const MAX_BODY = 4096;

// Only letters of the code alphabet: /join, /nope and the like are not codes.
const CODE_PATH = /^\/([BCDFGHJKLMNPQRSTVWXZ]{4})\/?$/i;
const API_CODE_PATH = /^\/api\/links\/([^/]*)$/;
const API_ROOM_PATH = /^\/api\/rooms\/([^/]*)(?:\/(host|join))?$/;

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function apiError(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  const res = json(status, { error: { code, message } });
  for (const [k, v] of Object.entries(headers ?? {})) res.headers.set(k, v);
  return res;
}

function html(request: Request, status: number, body: string): Response {
  return new Response(request.method === "HEAD" ? null : body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function methodNotAllowed(allow: string, api: boolean): Response {
  if (api) return apiError(405, "method-not-allowed", `Use ${allow}.`, { Allow: allow });
  return new Response("Method Not Allowed\n", {
    status: 405,
    headers: { Allow: allow, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function clientKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function allowed(limiter: RateLimit, request: Request): Promise<boolean> {
  const { success } = await limiter.limit({ key: clientKey(request) });
  return success;
}

function bearer(request: Request): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") ?? "");
  return m ? m[1]! : null;
}

/** The body as text, at most MAX_BODY bytes (413 beyond). */
async function readBody(request: Request): Promise<string> {
  const tooLarge = new HttpError(413, "too-large", `Request bodies are at most ${MAX_BODY} bytes.`);
  const length = request.headers.get("Content-Length");
  if (length !== null && Number(length) > MAX_BODY) throw tooLarge;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw tooLarge;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The body as a JSON object; `{}` for an empty body when `emptyOk`. */
async function readJsonObject(request: Request, emptyOk: boolean): Promise<Record<string, unknown>> {
  const text = await readBody(request);
  if (emptyOk && text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad-request", "The body is not JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "bad-request", "The body is not a JSON object.");
  }
  return value as Record<string, unknown>;
}

const BAD_URL = new HttpError(400, "bad-url", "Only tvpipe's own join links can be registered.");

async function createLink(request: Request, env: Env, now: number): Promise<Response> {
  if (!(await allowed(env.CREATES, request))) {
    return apiError(429, "rate-limited", "Too many links; wait a minute.", { "Retry-After": "60" });
  }
  const body = await readJsonObject(request, false);
  if (body.url === undefined) throw new HttpError(400, "bad-request", "The body has no url.");
  const origin = new URL(request.url).origin;
  const web = webLink(body.url, origin);
  let reg;
  if (web !== null) {
    // A web room's link names its code: exactly that one, or the page
    // tries another code.
    if (body.code !== undefined && normalizeCode(body.code) !== web.code) {
      throw new HttpError(400, "bad-request", "The code must be the link's.");
    }
    reg = await registerExactly(env.DB, body.url as string, web.code, now);
    if (!reg) return apiError(409, "code-taken", "The code is taken; try another.");
  } else {
    if (!isJoinUrl(body.url)) throw BAD_URL;
    reg = await register(env.DB, body.url, body.code, now);
    if (!reg) return apiError(503, "no-code", "No free code was found; try again.");
  }
  return json(201, { code: reg.code, short: `${origin}/${reg.code}`, url: reg.url, secret: reg.secret });
}

async function updateLink(request: Request, env: Env, rawCode: string, now: number): Promise<Response> {
  if (!(await allowed(env.UPDATES, request))) {
    return apiError(429, "rate-limited", "Too many requests; wait a minute.", { "Retry-After": "60" });
  }
  const notFound = new HttpError(404, "not-found", "No such link (or a different secret); register again.");
  const body = await readJsonObject(request, true);
  const code = normalizeCode(rawCode);
  const origin = new URL(request.url).origin;
  let url: string | null = null;
  if (body.url !== undefined) {
    // A web room's link only under its own code.
    const web = webLink(body.url, origin);
    if (web !== null ? web.code !== code : !isJoinUrl(body.url)) throw BAD_URL;
    url = body.url as string;
  }
  const secret = bearer(request);
  if (code === null || secret === null) throw notFound;
  const current = await refresh(env.DB, code, secret, url, now);
  if (current === null) throw notFound;
  return json(200, { code, short: `${origin}/${code}`, url: current });
}

async function deleteLink(request: Request, env: Env, rawCode: string): Promise<Response> {
  if (!(await allowed(env.UPDATES, request))) {
    return apiError(429, "rate-limited", "Too many requests; wait a minute.", { "Retry-After": "60" });
  }
  await readBody(request);
  const code = normalizeCode(rawCode);
  const secret = bearer(request);
  if (code !== null && secret !== null) await remove(env.DB, code, secret);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

/**
 * GET /CODE and /join?code=: the redirect to the frame page (`/p#…`, the
 * game inside a page of tvpipe.party) or, for a web room, to its join
 * link (`/r/?r=CODE#k=KEY`); else the join page saying why not.
 */
async function joinCode(request: Request, env: Env, input: string): Promise<Response> {
  const shown = input.toUpperCase();
  const code = normalizeCode(input);
  if (code === null) {
    return html(request, 404, joinPage(`No game with the code ${shown}. Check the code on the TV.`, shown));
  }
  // Every lookup counts, hits too: limiting only misses would still let a
  // scanner tell live codes (302) from dead ones (429) at full speed.
  if (!(await allowed(env.LOOKUPS, request))) {
    const res = html(request, 429, joinPage("Too many tries. Wait a minute, then try again.", code));
    res.headers.set("Retry-After", "60");
    return res;
  }
  const url = await lookup(env.DB, code);
  if (url === null) {
    return html(request, 404, joinPage(`No game with the code ${code}. Check the code on the TV.`, code));
  }
  // Rows are tunnel join links (isJoinUrl), with a frame page, or web
  // rooms' links; the link itself would do too.
  const web = webLink(url, new URL(request.url).origin);
  const location = web !== null ? `/r/?r=${web.code}#k=${web.key}` : (framePath(url) ?? url);
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

async function joinForm(request: Request, env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get("code");
  if (raw === null) return html(request, 200, joinPage());
  const input = raw.replace(/\s+/g, "");
  if (input === "") return html(request, 400, joinPage("Type the code shown on the TV."));
  if (!/^[A-Za-z]{4}$/.test(input)) {
    return html(request, 400, joinPage("A code is four letters, like BCDF. Check the code on the TV.", input.slice(0, 8)));
  }
  return joinCode(request, env, input);
}

const NO_ROOM = new HttpError(404, "no-room", "No room with this code.");

/** GET /api/rooms/CODE: `{code, host, game}` of a web room. */
async function roomState(request: Request, env: Env, rawCode: string): Promise<Response> {
  const code = normalizeCode(rawCode);
  if (code === null) throw NO_ROOM;
  // Hits count too (as for /CODE): a scanner learns nothing from 429s.
  if (!(await allowed(env.ROOM_LOOKUPS, request))) {
    return apiError(429, "rate-limited", "Too many requests; wait a minute.", { "Retry-After": "60" });
  }
  const row = await lookupRow(env.DB, code);
  const origin = new URL(request.url).origin;
  if (row === null || webLink(row.url, origin)?.code !== code) throw NO_ROOM;
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const res = await stub.fetch(
    new Request(`${origin}/api/rooms/${code}`, { headers: { [OWNER_HEADER]: row.secret } }),
  );
  if (!res.ok) throw new HttpError(503, "unavailable", "The room did not answer; try again.");
  const state = (await res.json()) as RoomState;
  return json(200, { code, host: state.host, game: state.game });
}

/** The host's and joins' WebSockets: to the room's object. */
async function roomSocket(request: Request, env: Env, rawCode: string, url: URL): Promise<Response> {
  const code = normalizeCode(rawCode);
  if (code === null) throw NO_ROOM;
  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
    return apiError(426, "upgrade-required", "This is a WebSocket.", { Upgrade: "websocket" });
  }
  if (url.search.length > MAX_QUERY + 1) throw new HttpError(414, "too-long", "The query is too long.");
  // The object reads the code from the path: upper case.
  const forward = new URL(url);
  forward.pathname = forward.pathname.replace(/\/api\/rooms\/[^/]*/, `/api/rooms/${code}`);
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  return stub.fetch(new Request(forward.toString(), request));
}

async function turn(request: Request, env: Env, now: number): Promise<Response> {
  if (!(await allowed(env.TURNS, request))) {
    return apiError(429, "rate-limited", "Too many requests; wait a minute.", { "Retry-After": "60" });
  }
  return json(200, await iceConfig(env, now));
}

async function fallback(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET" || request.method === "HEAD") {
    // With the default asset-first routing a file never gets here; asking
    // is cheap and keeps a run_worker_first configuration working.
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
  }
  return html(request, 404, notFoundPage());
}

/** The Worker's fetch, with the clock injectable for tests. */
export async function handle(request: Request, env: Env, now: number = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const isGet = method === "GET" || method === "HEAD";
  try {
    if (path === "/api/links") {
      if (method !== "POST") return methodNotAllowed("POST", true);
      return await createLink(request, env, now);
    }
    const api = API_CODE_PATH.exec(path);
    if (api) {
      if (method === "PUT") return await updateLink(request, env, decodeURIComponent(api[1]!), now);
      if (method === "DELETE") return await deleteLink(request, env, decodeURIComponent(api[1]!));
      return methodNotAllowed("PUT, DELETE", true);
    }
    const room = API_ROOM_PATH.exec(path);
    if (room) {
      if (method !== "GET") return methodNotAllowed("GET", true);
      const rawCode = decodeURIComponent(room[1]!);
      if (room[2] === undefined) return await roomState(request, env, rawCode);
      return await roomSocket(request, env, rawCode, url);
    }
    if (path === "/api/turn") {
      if (method !== "GET") return methodNotAllowed("GET", true);
      return await turn(request, env, now);
    }
    if (path.startsWith("/api/")) return apiError(404, "not-found", "No such API.");
    if (path === "/join" || path === "/join/") {
      if (!isGet) return methodNotAllowed("GET, HEAD", false);
      return await joinForm(request, env, url);
    }
    const code = CODE_PATH.exec(path);
    if (code) {
      if (!isGet) return methodNotAllowed("GET, HEAD", false);
      return await joinCode(request, env, code[1]!);
    }
    return await fallback(request, env);
  } catch (e) {
    if (e instanceof HttpError) return apiError(e.status, e.code, e.message);
    if (e instanceof URIError) return apiError(404, "not-found", "No such link.");
    throw e;
  }
}
