// Test doubles of the Worker's bindings: D1 on node:sqlite, a counting
// rate limiter, a static-files fetcher and Durable Objects with
// hibernating WebSockets (the `Room`s).

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  DurableObjectId,
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStorage,
  DurableObjectStub,
  Env,
  Fetcher,
  RateLimit,
  WorkerWebSocket,
} from "../src/env.ts";
import { Room, runtime } from "../src/room.ts";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

class Statement implements D1PreparedStatement {
  db: DatabaseSync;
  sql: string;
  values: SQLInputValue[];
  constructor(db: DatabaseSync, sql: string, values: SQLInputValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }
  bind(...values: unknown[]): D1PreparedStatement {
    // D1 takes JS values; undefined is an error there too.
    for (const v of values) if (v === undefined) throw new TypeError("D1_TYPE_ERROR: undefined");
    return new Statement(this.db, this.sql, values as SQLInputValue[]);
  }
  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.values);
    return (row as T | undefined) ?? null;
  }
  async run<T>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    if (/\bRETURNING\b/i.test(this.sql) || /^\s*SELECT/i.test(this.sql)) {
      const results = stmt.all(...this.values) as T[];
      return { results, success: true, meta: { changes: results.length } };
    }
    const info = stmt.run(...this.values);
    return { results: [], success: true, meta: { changes: Number(info.changes) } };
  }
  async all<T>(): Promise<D1Result<T>> {
    const results = this.db.prepare(this.sql).all(...this.values) as T[];
    return { results, success: true, meta: { changes: 0 } };
  }
}

export class MemoryD1 implements D1Database {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
    }
  }
  prepare(query: string): D1PreparedStatement {
    return new Statement(this.sqlite, query);
  }
}

export class FakeLimiter implements RateLimit {
  limitPerKey: number;
  counts = new Map<string, number>();
  constructor(limitPerKey: number) {
    this.limitPerKey = limitPerKey;
  }
  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return { success: n <= this.limitPerKey };
  }
  reset(): void {
    this.counts.clear();
  }
}

export class FakeAssets implements Fetcher {
  files: Record<string, string>;
  constructor(files: Record<string, string>) {
    this.files = files;
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const body = this.files[path];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
  }
}

/** A test clock; the rooms' `runtime.now` reads it. */
export const clock = { now: 1_700_000_000_000 };

export class FakeStorage implements DurableObjectStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

/** The object's side of a socket, as workerd's: attachments, readyState. */
export class FakeServerSocket implements WorkerWebSocket {
  readyState = 1;
  attachment: unknown = null;
  client!: FakeClient;
  state: FakeState | null = null;
  send(message: string): void {
    if (this.readyState !== 1) throw new TypeError("WebSocket is closed");
    this.client.received.push(message);
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState !== 1) return;
    if (!(code === 1000 || (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999))) {
      throw new TypeError(`invalid close code ${code}`);
    }
    this.readyState = 3;
    this.client.closed = { code, reason };
    // The client answers the close; the object hears of it.
    const state = this.state;
    if (state) state.later(async () => {
      state.drop(this);
      await state.room.webSocketClose(this, code, reason, true);
    });
  }
  serializeAttachment(value: unknown): void {
    if (JSON.stringify(value).length > 2048) throw new RangeError("attachment over 2048 bytes");
    this.attachment = structuredClone(value);
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

/** The client's side: what it received, how it was closed. */
export class FakeClient {
  received: string[] = [];
  closed: { code: number; reason: string } | null = null;
  server: FakeServerSocket;
  constructor(server: FakeServerSocket) {
    this.server = server;
    server.client = this;
  }
  /** The JSON messages received (not `pong`). */
  messages(): Record<string, unknown>[] {
    return this.received.filter((m) => m !== "pong").map((m) => JSON.parse(m) as Record<string, unknown>);
  }
  /** The close code, once closed. */
  get closeCode(): number | undefined {
    return this.closed?.code;
  }
  last(): Record<string, unknown> | undefined {
    return this.messages().at(-1);
  }
  async send(message: unknown): Promise<void> {
    if (this.closed) throw new Error("closed");
    const text = typeof message === "string" ? message : JSON.stringify(message);
    const state = this.server.state!;
    if (text === "ping" && state.autoResponse !== undefined) {
      this.received.push("pong");
      return;
    }
    await state.room.webSocketMessage(this.server, text);
    await state.idle();
  }
  async close(code = 1000, reason = ""): Promise<void> {
    if (this.closed) return;
    this.closed = { code, reason };
    const state = this.server.state!;
    this.server.readyState = 2;
    await state.room.webSocketClose(this.server, code, reason, true);
    this.server.readyState = 3;
    state.drop(this.server);
    await state.idle();
  }
}

export class FakeState implements DurableObjectState {
  storage = new FakeStorage();
  sockets: { ws: FakeServerSocket; tags: string[] }[] = [];
  autoResponse: unknown = undefined;
  room!: Room;
  env: Env;
  pending: Promise<unknown>[] = [];
  constructor(env: Env) {
    this.env = env;
    this.room = new Room(this, env);
  }
  acceptWebSocket(ws: WorkerWebSocket, tags: string[] = []): void {
    const server = ws as FakeServerSocket;
    server.state = this;
    this.sockets.push({ ws: server, tags });
  }
  getWebSockets(tag?: string): WorkerWebSocket[] {
    return this.sockets.filter((s) => tag === undefined || s.tags.includes(tag)).map((s) => s.ws);
  }
  setWebSocketAutoResponse(pair?: unknown): void {
    this.autoResponse = pair;
  }
  drop(ws: FakeServerSocket): void {
    this.sockets = this.sockets.filter((s) => s.ws !== ws);
  }
  later(f: () => Promise<void>): void {
    this.pending.push(Promise.resolve().then(f));
  }
  async idle(): Promise<void> {
    while (this.pending.length > 0) {
      const all = this.pending;
      this.pending = [];
      await Promise.all(all);
    }
  }
  /** Hibernation: a new instance; only storage and the sockets' attachments stay. */
  hibernate(): void {
    this.room = new Room(this, this.env);
  }
  /** Runs the alarm when it is due at `clock.now`. */
  async fire(): Promise<boolean> {
    const at = this.storage.alarm;
    if (at === null || at > clock.now) return false;
    this.storage.alarm = null;
    await this.room.alarm();
    await this.idle();
    return true;
  }
}

export class FakeRooms implements DurableObjectNamespace {
  env!: Env;
  states = new Map<string, FakeState>();
  idFromName(name: string): DurableObjectId {
    return { toString: () => name };
  }
  get(id: DurableObjectId): DurableObjectStub {
    const name = id.toString();
    return {
      fetch: async (request: Request) => {
        let state = this.states.get(name);
        if (!state) {
          state = new FakeState(this.env);
          this.states.set(name, state);
        }
        return state.room.fetch(request);
      },
    };
  }
  state(name: string): FakeState {
    const s = this.states.get(name);
    if (!s) throw new Error(`no room ${name}`);
    return s;
  }
}

/** The client of the last upgrade (`runtime.upgraded` answers 204 here: Node has no 101). */
export let lastClient: FakeClient | null = null;

runtime.now = () => clock.now;
runtime.pair = () => {
  const server = new FakeServerSocket();
  const client = new FakeClient(server);
  return [client as unknown as WorkerWebSocket, server];
};
runtime.upgraded = (client) => {
  lastClient = client as unknown as FakeClient;
  return new Response(null, { status: 204, headers: { "X-Fake-Upgrade": "1" } });
};
runtime.autoResponse = () => ({ request: "ping", response: "pong" });

export interface TestEnv extends Env {
  DB: MemoryD1;
  LOOKUPS: FakeLimiter;
  CREATES: FakeLimiter;
  UPDATES: FakeLimiter;
  ROOM_LOOKUPS: FakeLimiter;
  TURNS: FakeLimiter;
  ROOMS: FakeRooms;
}

export function testEnv(): TestEnv {
  const env: TestEnv = {
    DB: new MemoryD1(),
    ASSETS: new FakeAssets({ "/": "<h1>tvpipe</h1>", "/index.html": "<h1>tvpipe</h1>" }),
    LOOKUPS: new FakeLimiter(20),
    CREATES: new FakeLimiter(10),
    UPDATES: new FakeLimiter(60),
    ROOM_LOOKUPS: new FakeLimiter(120),
    TURNS: new FakeLimiter(60),
    ROOMS: new FakeRooms(),
  };
  env.ROOMS.env = env;
  return env;
}
