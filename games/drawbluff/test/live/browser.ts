/**
 * A headless Chrome for live checks (not part of `npm test`): open pages,
 * run script in them, take screenshots, over the DevTools protocol with
 * Node's own WebSocket.
 *
 *   const b = await Browser.launch();
 *   const tab = await b.open("http://…", { width: 390, height: 844, mobile: true });
 *   await tab.eval("document.title");
 *   await tab.screenshot("/tmp/x.png");
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env["CHROME"] ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");

export class Tab {
  readonly #ws: WebSocket;
  #id = 0;
  readonly #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly #events = new Map<string, (params: any) => void>();

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.method) {
        this.#events.get(msg.method)?.(msg.params);
        return;
      }
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  /** Handles a DevTools event of the tab (`Fetch.requestPaused`, …); one handler per event. */
  on(method: string, fn: (params: any) => void): void {
    this.#events.set(method, fn);
  }

  /**
   * Answers the page's requests for URLs matching `pattern` (DevTools
   * wildcards, `*` and `?`) with `body` instead of the server's file.
   */
  async serve(pattern: string, body: string, type = "text/plain; charset=utf-8"): Promise<void> {
    this.on("Fetch.requestPaused", (p: { requestId: string }) => {
      void this.send("Fetch.fulfillRequest", {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: type },
          { name: "Cache-Control", value: "no-store" },
        ],
        body: Buffer.from(body).toString("base64"),
      }).catch(() => {});
    });
    await this.send("Fetch.enable", { patterns: [{ urlPattern: pattern, requestStage: "Request" }] });
  }

  /** Evaluates an expression (awaiting promises) as a user gesture. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
    return r.result.value as T;
  }

  /** Polls `expression` until it is truthy. */
  async until(expression: string, ms = 15000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await this.eval(expression))) {
      if (Date.now() > end) throw new Error(`timed out: ${expression}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Changes the viewport (CSS px). */
  async resize(view: { width: number; height: number; mobile?: boolean }): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width: view.width, height: view.height, deviceScaleFactor: view.mobile ? 2 : 1, mobile: view.mobile ?? false });
  }

  async screenshot(path: string): Promise<void> {
    writeFileSync(path, await this.capture());
  }

  /**
   * A screenshot in memory: PNG, or WebP or JPEG at `quality`; `clip` (CSS
   * px from the top left, times `scale`) for a picture of a fixed size.
   */
  async capture(o: { format?: "png" | "webp" | "jpeg"; quality?: number; clip?: { width: number; height: number; scale: number } } = {}): Promise<Buffer> {
    const r = await this.send("Page.captureScreenshot", {
      format: o.format ?? "png",
      ...(o.quality === undefined ? {} : { quality: o.quality }),
      ...(o.clip ? { clip: { x: 0, y: 0, ...o.clip } } : {}),
    });
    return Buffer.from(r.data, "base64");
  }

  /** A pointer drag through the points (CSS px of the viewport). */
  async drag(points: [number, number][]): Promise<void> {
    const [first, ...rest] = points;
    if (!first) return;
    const ev = (type: string, [x, y]: [number, number]) =>
      this.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await ev("touchStart", first);
    for (const p of rest) await ev("touchMove", p);
    await ev("touchEnd", rest.at(-1) ?? first);
  }

  close(): void {
    this.#ws.close();
  }
}

export class Browser {
  readonly #proc: ChildProcess;
  readonly #port: number;

  private constructor(proc: ChildProcess, port: number) {
    this.#proc = proc;
    this.#port = port;
  }

  static async launch(): Promise<Browser> {
    const port = 9300 + Math.floor(Math.random() * 500);
    const dir = mkdtempSync(join(tmpdir(), "drawbluff-chrome-"));
    const proc = spawn(
      CHROME,
      [
        "--headless=new",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${dir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const end = Date.now() + 15000;
    for (;;) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`);
        break;
      } catch {
        if (Date.now() > end) throw new Error("Chrome did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return new Browser(proc, port);
  }

  /** A tab at a viewport; `locale` (`de-DE`) for its language (`navigator.language`, Intl). */
  async open(url: string, view: { width: number; height: number; mobile?: boolean; locale?: string }): Promise<Tab> {
    const t = (await (await fetch(`http://127.0.0.1:${this.#port}/json/new?about:blank`, { method: "PUT" })).json()) as {
      webSocketDebuggerUrl: string;
    };
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    const tab = new Tab(ws);
    await tab.send("Page.enable");
    await tab.send("Emulation.setDeviceMetricsOverride", {
      width: view.width,
      height: view.height,
      deviceScaleFactor: view.mobile ? 2 : 1,
      mobile: view.mobile ?? false,
    });
    if (view.mobile) await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    if (view.locale) {
      const { userAgent } = (await tab.send("Browser.getVersion")) as { userAgent: string };
      await tab.send("Emulation.setUserAgentOverride", { userAgent, acceptLanguage: view.locale });
      await tab.send("Emulation.setLocaleOverride", { locale: view.locale });
    }
    await tab.send("Page.navigate", { url });
    return tab;
  }

  close(): void {
    this.#proc.kill();
  }
}
