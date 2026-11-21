/**
 * One tvpipe process speaking the machine interface: spawn, events from
 * stdout, records to stdin, and a stop that escalates.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

import { resolveBinary } from "./binary.ts";
import { TvpipeError } from "./errors.ts";
import { parseEvent, type ErrorEvent, type HelloEvent, type LogEvent, type TvpipeEvent } from "./events.ts";
import * as slrw from "./slrw.ts";

/** The machine-interface version this SDK speaks. */
export const PROTOCOL = 1;

/** How many log lines a process keeps for error messages. */
const LOG_TAIL = 50;

export interface ProcessOptions {
  /** Path of the tvpipe binary (default: `$TVPIPE_BINARY`, then the platform package). */
  binary?: string | undefined;
  /**
   * Where tvpipe keeps AirPlay pairings and the player page's token
   * (`TVPIPE_CONFIG_DIR`; default: the CLI's config directory, so the CLI
   * and the SDK share pairings).
   */
  configDir?: string | undefined;
  /** Extra environment variables for the process. */
  env?: Record<string, string | undefined> | undefined;
  /** Debug logs (`-v`); `"trace"` for protocol traces (`--debug`). */
  verbose?: boolean | "trace" | undefined;
  /**
   * Mirror tvpipe's log to stderr (`true`, or the lowest level: `"info"`
   * by default with `true`), or hand each line to a function. Logs are
   * also `log` events either way.
   */
  logs?: boolean | LogEvent["level"] | ((event: LogEvent) => void) | undefined;
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const LEVELS = ["error", "warn", "info", "debug", "trace"] as const;

function logPrinter(logs: ProcessOptions["logs"]): ((e: LogEvent) => void) | undefined {
  if (typeof logs === "function") return logs;
  if (!logs) return undefined;
  const max = LEVELS.indexOf(logs === true ? "info" : logs);
  return (e) => {
    if (LEVELS.indexOf(e.level) <= max) {
      process.stderr.write(`tvpipe ${e.level.toUpperCase().padEnd(5)} ${e.module}: ${e.message}\n`);
    }
  };
}

/**
 * A running tvpipe. Emits `event` (every {@link TvpipeEvent}) and `exit`.
 */
export class TvpipeProcess extends EventEmitter<{ event: [TvpipeEvent]; exit: [Exit] }> {
  readonly child: ChildProcess;
  readonly exited: Promise<Exit>;
  hello: HelloEvent | undefined;
  /** The last error event, if the command failed. */
  failure: ErrorEvent | undefined;
  /** Whether an `end` event arrived. */
  ended = false;
  #log: string[] = [];
  #stderr: string[] = [];
  #exit: Exit | undefined;
  #spawnError: Error | undefined;
  #inputOpen = true;

  constructor(args: string[], options: ProcessOptions = {}) {
    super();
    const binary = resolveBinary(options);
    const flags = ["--machine"];
    if (options.verbose === "trace") flags.push("--debug");
    else if (options.verbose) flags.push("-v");
    const env: Record<string, string | undefined> = { ...process.env, ...options.env };
    if (options.configDir) env["TVPIPE_CONFIG_DIR"] = options.configDir;
    this.child = spawn(binary, [...flags, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env,
    });
    const printer = logPrinter(options.logs);
    this.exited = new Promise((resolve) => {
      this.child.once("error", (err) => {
        this.#spawnError = err;
        // `close` does not follow a failed spawn.
        if (this.child.pid === undefined) {
          this.#exit = { code: null, signal: null };
          this.emit("exit", this.#exit);
          resolve(this.#exit);
        }
      });
      // `close`: the process exited and its stdio is drained, so every
      // event was read.
      this.child.once("close", (code, signal) => {
        this.#exit = { code, signal };
        this.emit("exit", this.#exit);
        resolve(this.#exit);
      });
    });
    // A closed pipe (tvpipe exited) is reported through `exit`.
    this.child.stdin?.on("error", () => {
      this.#inputOpen = false;
    });
    this.child.stdin?.write(slrw.MAGIC);
    const lines = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const ev = parseEvent(line);
      if (!ev) {
        this.#remember(line);
        return;
      }
      switch (ev.type) {
        case "hello":
          this.hello = ev;
          if (ev.protocol !== PROTOCOL) {
            this.failure = {
              type: "error",
              kind: "usage",
              code: "protocol-mismatch",
              message:
                `tvpipe ${ev.version} speaks machine protocol ${ev.protocol}, this SDK ${PROTOCOL}; ` +
                `install matching versions of @tvpipe/sdk and its binary`,
            };
            this.kill();
          }
          break;
        case "log":
          this.#remember(`${ev.level}: ${ev.message}`);
          printer?.(ev);
          break;
        case "error":
          this.failure ??= ev;
          break;
        case "end":
          this.ended = true;
          break;
      }
      this.emit("event", ev);
    });
    const stderr = createInterface({ input: this.child.stderr!, crlfDelay: Infinity });
    stderr.on("line", (line) => {
      if (line.trim()) {
        this.#remember(line);
        this.#stderr.push(line);
      }
      printer?.({ type: "log", level: "error", module: "stderr", message: line });
    });
  }

  #remember(line: string): void {
    this.#log.push(line);
    if (this.#log.length > LOG_TAIL) this.#log.shift();
  }

  /** The last log lines and stderr output. */
  get log(): string[] {
    return [...this.#log];
  }

  get exit(): Exit | undefined {
    return this.#exit;
  }

  get running(): boolean {
    return this.#exit === undefined;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Whether stdin still takes records. */
  get inputOpen(): boolean {
    return this.#inputOpen && this.running && !!this.child.stdin?.writable;
  }

  /** Bytes written to stdin that the pipe did not take yet. */
  get queuedBytes(): number {
    return this.child.stdin?.writableLength ?? 0;
  }

  /** Writes to stdin; `false` when the pipe is backed up (or closed). */
  write(data: Uint8Array): boolean {
    if (!this.inputOpen) return false;
    return this.child.stdin!.write(data);
  }

  /** Sends a command record (`stop`, `pin`, `navigate`). */
  command(cmd: Record<string, unknown>): boolean {
    return this.write(slrw.command(cmd));
  }

  /** Closes stdin: the end of an SLRW stream, else a stop request. */
  endInput(): void {
    if (this.#inputOpen) {
      this.#inputOpen = false;
      this.child.stdin?.end();
    }
  }

  /** Resolves once stdin took everything written. */
  drain(): Promise<void> {
    const stdin = this.child.stdin;
    if (!stdin || !this.inputOpen || stdin.writableLength === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        stdin.off("drain", done);
        this.off("exit", done);
        resolve();
      };
      stdin.on("drain", done);
      this.once("exit", done);
    });
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (this.running) this.child.kill(signal);
  }

  /**
   * Stops: the `stop` command, stdin closed; after `timeoutMs` SIGTERM
   * (tvpipe still tears down; on Windows this terminates at once), after
   * 2 s more SIGKILL.
   */
  async stop(timeoutMs = 5000, graceful: "stop" | "end" = "stop"): Promise<Exit> {
    if (!this.running) return this.exited;
    if (graceful === "stop") this.command({ type: "stop" });
    else this.write(slrw.record(slrw.Kind.end, 0, new Uint8Array(0)));
    this.endInput();
    const timer = (ms: number) =>
      new Promise<"timeout">((resolve) => setTimeout(resolve, ms, "timeout").unref());
    if ((await Promise.race([this.exited, timer(timeoutMs)])) !== "timeout") return this.exited;
    this.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
    if ((await Promise.race([this.exited, timer(2000)])) !== "timeout") return this.exited;
    this.kill("SIGKILL");
    return this.exited;
  }

  /** The error for a process that failed (or exited without saying why). */
  error(fallback = "tvpipe exited unexpectedly"): TvpipeError {
    const exitCode = this.#exit?.code;
    if (this.#spawnError) {
      return new TvpipeError("binary-missing", `cannot run tvpipe: ${this.#spawnError.message}`, {
        cause: this.#spawnError,
        log: this.log,
      });
    }
    const f = this.failure;
    if (f) {
      return new TvpipeError(f.code ?? f.kind, f.message, {
        kind: f.kind,
        device: f.device,
        exitCode,
        log: this.log,
      });
    }
    // The argument parser's errors: `error: ...` on stderr, status 2.
    const parseError = this.#stderr.find((l) => l.startsWith("error:"));
    if (exitCode === 2 && parseError) {
      return new TvpipeError("usage", `tvpipe rejected the arguments: ${parseError.slice(6).trim()}`, {
        kind: "usage",
        exitCode,
        log: this.log,
      });
    }
    const detail = this.#log.filter((l) => !l.startsWith("info:") && !l.startsWith("debug:"));
    const last = detail.at(-1);
    const how = this.#exit?.signal ? `signal ${this.#exit.signal}` : `exit code ${exitCode}`;
    return new TvpipeError("exited", `${fallback} (${how})${last ? `: ${last}` : ""}`, {
      exitCode,
      log: this.log,
    });
  }
}
