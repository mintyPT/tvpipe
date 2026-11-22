// The few Cloudflare types the Worker uses, declared here instead of
// depending on @cloudflare/workers-types. They follow the runtime's API.

export interface D1Meta {
  changes: number;
  [key: string]: unknown;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

/** The `ratelimits` binding. */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The `assets` binding. */
export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/** A WebSocket of the runtime (the server side of a `WebSocketPair`). */
export interface WorkerWebSocket {
  readonly readyState: number;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  /** Kept across hibernation; at most 2,048 bytes serialized. */
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** The `ctx` of a Durable Object, with the hibernation WebSocket API. */
export interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  acceptWebSocket(ws: WorkerWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WorkerWebSocket[];
  setWebSocketAutoResponse(pair?: unknown): void;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Lookups of codes: 20 a minute per client. */
  LOOKUPS: RateLimit;
  /** POST /api/links: 10 a minute per client. */
  CREATES: RateLimit;
  /** PUT/DELETE /api/links/CODE: 60 a minute per client. */
  UPDATES: RateLimit;
  /** GET /api/rooms/CODE: 120 a minute per client (a party behind one IP loads /r/ in bursts). */
  ROOM_LOOKUPS: RateLimit;
  /** GET /api/turn: 60 a minute per client. */
  TURNS: RateLimit;
  /** The `Room` Durable Objects (room.ts), one per web room's code. */
  ROOMS: DurableObjectNamespace;
  /** Cloudflare Realtime TURN key (a secret; without it /api/turn is STUN only). */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}
