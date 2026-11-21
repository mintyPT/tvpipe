/**
 * A running session: events, state, stop.
 */

import { EventEmitter } from "node:events";

import { TvpipeError } from "./errors.ts";
import type {
  ConnectedEvent,
  EndEvent,
  KeyframeEvent,
  LogEvent,
  PlayerEvent,
  ReceiverEvent,
  ReceiverProtocol,
  ReceiverState,
  SharePageEvent,
  TunnelEvent,
  StartedEvent,
  StatsEvent,
  TvpipeEvent,
  ViewerEvent,
} from "./events.ts";
import type { Exit, TvpipeProcess } from "./process.ts";

/** How a session ended. */
export interface EndInfo {
  reason: EndEvent["reason"];
  /** Per receiver: how it ended and what it got. */
  receivers: NonNullable<EndEvent["receivers"]>;
  exitCode: number | null;
}

/** The latest state of a receiver. */
export interface ReceiverInfo {
  name: string;
  protocol: ReceiverProtocol | undefined;
  state: ReceiverState;
  error: string | undefined;
  code: string | undefined;
  /** The playout delay it shows video with, ms (once connected). */
  delayMs: number | undefined;
}

/** The plan once streaming started. */
export type StartedInfo = Omit<StartedEvent, "type">;

export interface SessionEvents {
  receiver: [ReceiverEvent];
  viewer: [ViewerEvent];
  player: [PlayerEvent];
  "share-page": [SharePageEvent];
  tunnel: [TunnelEvent];
  connected: [ConnectedEvent];
  started: [StartedEvent];
  stats: [StatsEvent];
  keyframe: [KeyframeEvent];
  log: [LogEvent];
  end: [EndInfo];
  /** A failure; also rejects {@link Session.done}. Unhandled, it is not thrown. */
  error: [TvpipeError];
  /** Every event of the machine interface. */
  event: [TvpipeEvent];
}

export interface SessionOptions {
  /** Stops the session when aborted. */
  signal?: AbortSignal | undefined;
  /** How long `stop()` waits before it kills tvpipe (ms, default 5000). */
  stopTimeout?: number | undefined;
}

/**
 * A tvpipe session (`play`, `testPattern`, `preview`, `share`, `stream`).
 * Stop it with {@link Session.stop} or `await using`.
 */
export class Session extends EventEmitter<SessionEvents> implements AsyncDisposable {
  /** The latest state of each receiver, by name. */
  readonly receivers: Map<string, ReceiverInfo> = new Map();
  /** The page of the `browser` receiver, if there is one. */
  playerUrl: string | undefined;
  /** `share()` without URL: the page to open and share from. */
  shareUrl: string | undefined;
  /** With `tunnel`: the public https link (the player's or the share page's). */
  publicUrl: string | undefined;
  /** The plan, once streaming started. */
  info: StartedInfo | undefined;
  /** The latest statistics (every second while streaming). */
  stats: StatsEvent | undefined;
  /** Resolves when the session ended; rejects with a {@link TvpipeError} when it failed. */
  readonly done: Promise<EndInfo>;
  protected readonly proc: TvpipeProcess;
  #end: EndEvent | undefined;
  #stopTimeout: number;
  #stopping: Promise<EndInfo> | undefined;
  #iterators = new Set<(ev: TvpipeEvent | undefined) => void>();

  constructor(proc: TvpipeProcess, options: SessionOptions = {}) {
    super();
    this.proc = proc;
    this.#stopTimeout = options.stopTimeout ?? 5000;
    proc.on("event", (ev) => this.#handle(ev));
    this.done = proc.exited.then((exit) => this.#finish(exit));
    // `done` may never be awaited; its rejection is also the `error` event.
    this.done.catch(() => {});
    const signal = options.signal;
    if (signal) {
      const onAbort = () => void this.stop().catch(() => {});
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        void proc.exited.then(() => signal.removeEventListener("abort", onAbort));
      }
    }
  }

  /** `error` without listeners is not thrown (failures reject `done`). */
  override emit<K extends keyof SessionEvents>(event: K, ...args: SessionEvents[K]): boolean;
  override emit(event: string, ...args: unknown[]): boolean {
    if (event === "error" && this.listenerCount("error") === 0) return false;
    return super.emit(event as keyof SessionEvents, ...(args as never));
  }

  /** The process id of tvpipe. */
  get pid(): number | undefined {
    return this.proc.pid;
  }

  /** Whether tvpipe still runs. */
  get running(): boolean {
    return this.proc.running;
  }

  /** The last log lines (for diagnostics). */
  get log(): string[] {
    return this.proc.log;
  }

  #handle(ev: TvpipeEvent): void {
    switch (ev.type) {
      case "receiver": {
        const prev = this.receivers.get(ev.name);
        this.receivers.set(ev.name, {
          name: ev.name,
          protocol: ev.protocol ?? prev?.protocol,
          state: ev.state,
          error: ev.error,
          code: ev.code,
          delayMs: ev.delay_ms ?? prev?.delayMs,
        });
        this.emit("receiver", ev);
        break;
      }
      case "player":
        this.playerUrl ??= ev.url;
        this.emit("player", ev);
        break;
      case "share-page":
        this.shareUrl = ev.url;
        this.emit("share-page", ev);
        break;
      case "tunnel":
        this.publicUrl ??= ev.url;
        this.emit("tunnel", ev);
        break;
      case "viewer":
        this.emit("viewer", ev);
        break;
      case "connected":
        this.emit("connected", ev);
        break;
      case "started": {
        const { type: _, ...info } = ev;
        this.info = info;
        this.emit("started", ev);
        break;
      }
      case "stats":
        this.stats = ev;
        this.emit("stats", ev);
        break;
      case "keyframe":
        this.emit("keyframe", ev);
        break;
      case "log":
        this.emit("log", ev);
        break;
      case "end":
        this.#end = ev;
        break;
    }
    this.emit("event", ev);
    for (const push of this.#iterators) push(ev);
  }

  #finish(exit: Exit): EndInfo {
    for (const push of this.#iterators) push(undefined);
    const failed = this.proc.failure !== undefined || exit.code !== 0 || !this.#end;
    // 130: stopped by a signal (Ctrl-C reaching tvpipe too), after a
    // clean teardown.
    const signalled = exit.code === 130 && !this.proc.failure;
    if (failed && !signalled && !(this.#stopping && exit.signal)) {
      const err = this.proc.error();
      this.emit("error", err);
      throw err;
    }
    const info: EndInfo = {
      reason: this.#end?.reason ?? "stopped",
      receivers: this.#end?.receivers ?? [],
      exitCode: exit.code,
    };
    this.emit("end", info);
    return info;
  }

  /**
   * Stops now: receivers get their teardown (the TV leaves mirroring),
   * nothing queued is played. Resolves with the end info; rejects only if
   * the session had failed. Kills tvpipe if it does not exit in time.
   */
  stop(): Promise<EndInfo> {
    this.#stopping ??= this.proc.stop(this.#stopTimeout, "stop").then(() => this.done);
    return this.#stopping;
  }

  /** Kills tvpipe without a teardown (receivers time out by themselves). */
  kill(): void {
    this.proc.kill("SIGKILL");
  }

  /** Lets Node exit while the session runs (it then ends with Node). */
  unref(): void {
    this.proc.child.unref();
    for (const s of [this.proc.child.stdin, this.proc.child.stdout, this.proc.child.stderr]) {
      (s as unknown as { unref?: () => void } | null)?.unref?.();
    }
  }

  /** Every event until the session ends. */
  async *events(): AsyncGenerator<TvpipeEvent, void, undefined> {
    const queue: (TvpipeEvent | undefined)[] = [];
    let wake: (() => void) | undefined;
    const push = (ev: TvpipeEvent | undefined) => {
      queue.push(ev);
      wake?.();
    };
    if (!this.proc.running) return;
    this.#iterators.add(push);
    try {
      for (;;) {
        while (queue.length === 0) await new Promise<void>((r) => (wake = r));
        const ev = queue.shift();
        if (ev === undefined) return;
        yield ev;
      }
    } finally {
      this.#iterators.delete(push);
    }
  }

  /** `await using`: stops the session (failures are not rethrown here). */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop().catch(() => {});
  }
}

/**
 * `share(url)`: a web page in tvpipe's headless browser, which can show
 * other pages while it runs.
 */
export class PageSession extends Session {
  /**
   * Shows `url` in the same tab (an `http(s)://` or `file://` URL, or a
   * host name). The receivers keep their sessions and the browser stays:
   * the picture pauses while the page loads and shares again (a quarter
   * of a second or so) instead of the TVs starting over. Returns at once;
   * tvpipe logs a warning (a `log` event) when it refuses the page.
   */
  navigate(url: string | URL): void {
    const target = String(url);
    if (!target.trim()) throw new TvpipeError("invalid-argument", "navigate: an empty URL");
    if (!this.running || !this.proc.command({ type: "navigate", url: target })) {
      throw new TvpipeError("closed", "navigate: the session is over");
    }
  }
}
