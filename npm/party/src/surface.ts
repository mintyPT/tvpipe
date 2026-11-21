/**
 * Surfaces (docs/playshare-design.md §17): a canvas the page draws is
 * encoded here with WebCodecs and streamed by tvpipe to TVs, without a
 * browser of tvpipe's capturing a tab. One surface per screen: different
 * canvases on different TVs.
 *
 *   const s = await tvpipe.surface({ canvas, to: ["Living Room"], fps: 30 });
 *   function draw() { render(ctx); s.frame(); requestAnimationFrame(draw); }   // or clock: "timer"
 *
 * The encoder side runs in a window or a worker (an OffscreenCanvas
 * there): `SurfaceEncoder` needs only `WebSocket`, `VideoEncoder` and
 * `VideoFrame`. Sound: `captureAudio()` on the main thread hands PCM to
 * `pushAudio()`.
 */

import { Emitter } from "./emitter.ts";

/** What `surface.open` answered (and a worker needs to connect). */
export interface SurfaceInfo {
  id: number;
  /** `/_tvpipe/surface?id=N` on the local origin. */
  path: string;
  width: number;
  height: number;
  fps: number;
  audio: { sampleRate: number; channels: number } | null;
}

export interface SurfaceStats {
  /** Frames tvpipe took per second, its bit rate, how long they took to get there. */
  fps: number;
  kbps: number;
  lagMs: number;
  lagMaxMs: number;
  dropped: number;
}

export interface SurfaceStatus {
  state: "starting" | "streaming" | "failed" | "stopped";
  receivers?: { name: string; state: string; error?: string }[];
  player?: string;
  error?: string;
}

export interface SurfaceEvents {
  status: [status: SurfaceStatus];
  stats: [stats: SurfaceStats & { encodeMs: number; skipped: number }];
  end: [];
  error: [error: Error];
}

export type CanvasSource = HTMLCanvasElement | OffscreenCanvas;

export interface EncoderOptions {
  /** Bits per second (default: about 0.1 bit per pixel and frame). */
  bitrate?: number | undefined;
  /** IDRs at least this often, seconds (default 2). */
  keyInterval?: number | undefined;
  /**
   * Who calls `frame()`: the page (`manual`, the default: after drawing),
   * or a timer at the surface's rate (`timer`; in a worker it keeps
   * running while the window is hidden).
   */
  clock?: "manual" | "timer" | undefined;
  /** The WebSocket URL (default: the path on this origin). */
  url?: string | undefined;
}

/** The wall clock in µs, the clock of every record (tvpipe measures the lag with it). */
export function wallMicros(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 1000);
}

/**
 * Which frames are encoded and their timestamps (µs), as tvpipe's capture
 * script (`L.pacer` in capture.js) does. Receivers show each frame at its
 * timestamp, so the timestamps keep an even cadence: a frame takes the
 * next slot of a grid one interval apart when it comes up to 0.4
 * intervals before it or half an interval after it, the nearest slot
 * after a gap, and is skipped when earlier (of a page drawing at twice
 * the rate, every other frame, never alternating). The grid follows the
 * frames' phase by an eighth of each offset. `force` never skips.
 * Returns `null` for a skipped frame.
 */
export function pacer(frameUs: number): (ts: number, force?: boolean) => number | null {
  let next: number | null = null;
  const half = frameUs / 2;
  return (ts, force = false) => {
    if (next === null) next = ts;
    if (ts < next - 0.4 * frameUs && !force) return null;
    let pts = next;
    if (ts >= next + half) pts = next + Math.round((ts - next) / frameUs) * frameUs;
    const e = Math.max(-half, Math.min(half, ts - pts));
    next = pts + frameUs + e / 8;
    return pts;
  };
}

/**
 * Audio timestamps (µs) for chunks of `n` samples at `rate` Hz arriving
 * at `now`, as capture.js's `L.audioClock`: by the sample count, so a
 * message that waited for a busy thread keeps its place. The count starts
 * at the first chunk's arrival minus its length, moves earlier when a
 * chunk comes before its counted end, and later when one ends up a second
 * behind (a gap) or every chunk of two seconds came more than 20 ms after
 * its counted end.
 */
export function audioClock(rate: number): (n: number, now: number) => number {
  let base: number | null = null;
  let count = 0;
  let least = Infinity;
  let since = 0;
  return (n, now) => {
    const dur = (n / rate) * 1e6;
    if (base === null) {
      base = now - dur;
      since = now;
    }
    let pts = base + (count / rate) * 1e6;
    let delay = now - (pts + dur);
    if (delay < 0 || delay > 1e6) {
      base += delay;
      pts += delay;
      delay = 0;
    }
    least = Math.min(least, delay);
    if (now - since >= 2e6) {
      if (least > 20000) {
        base += least;
        pts += least;
      }
      least = Infinity;
      since = now;
    }
    count += n;
    return pts;
  };
}

/** One SLRW record: `u8 kind | u64le pts_us | u32le len | payload`. */
export function slrwRecord(kind: number, ptsUs: number, payload: Uint8Array, prefix?: number): Uint8Array {
  const extra = prefix === undefined ? 0 : 1;
  const out = new Uint8Array(13 + extra + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, kind);
  dv.setBigUint64(1, BigInt(Math.max(0, Math.round(ptsUs))), true);
  dv.setUint32(9, payload.length + extra, true);
  if (prefix !== undefined) out[13] = prefix;
  out.set(payload, 13 + extra);
  return out;
}

/**
 * H.264 profiles and levels to try, the smallest level that fits first
 * (browsers check only the frame size against the level, so a 4K60
 * stream must ask for 5.2 itself).
 */
export function codecs(width: number, height: number, fps: number): string[] {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = mbs * fps;
  // Levels 3.1, 4.0, 4.2, 5.1, 5.2 (MaxFS, MaxMBPS; H.264 Table A-1).
  const levels: [string, number, number][] = [
    ["1F", 3600, 108000],
    ["28", 8192, 245760],
    ["2A", 8704, 522240],
    ["33", 36864, 983040],
    ["34", 36864, 2073600],
  ];
  const level = (levels.find(([, fs, mbps]) => mbs <= fs && rate <= mbps) ?? levels[4]!)[0];
  // Constrained Baseline first (no B-frames anywhere), then Main and High.
  return [`avc1.42E0${level}`, `avc1.4D40${level}`, `avc1.6400${level}`];
}

/**
 * Encodes a canvas and sends it to tvpipe's surface socket. Works in a
 * window or a worker.
 */
export class SurfaceEncoder extends Emitter<SurfaceEvents> {
  readonly info: SurfaceInfo;
  readonly canvas: CanvasSource;
  readonly #ws: WebSocket;
  #encoder: VideoEncoder | undefined;
  readonly #keyInterval: number;
  #lastKey = -Infinity;
  #wantKey = true;
  #config: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #pace: (ts: number, force?: boolean) => number | null;
  #closed = false;
  #skipped = 0;
  #encodeMs = 0;
  #encoded = 0;
  #pending = new Map<number, number>();
  /** Until the first keyframe went out: the encoder warming up. */
  #warm = false;
  #warmUntil = 0;
  readonly #ready: Promise<void>;
  /** The codec in use (`avc1.42E01F`…), once configured. */
  codec = "";

  constructor(info: SurfaceInfo, canvas: CanvasSource, opts: EncoderOptions = {}) {
    super();
    this.info = info;
    this.canvas = canvas;
    this.#keyInterval = (opts.keyInterval ?? 2) * 1e6;
    this.#pace = pacer(1e6 / info.fps);
    const url =
      opts.url ??
      `${globalThis.location.protocol === "https:" ? "wss:" : "ws:"}//${globalThis.location.host}${info.path}`;
    this.#ws = new WebSocket(url);
    this.#ws.binaryType = "arraybuffer";
    this.#ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let m: Record<string, any>;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m["t"] === "keyframe") this.#wantKey = true;
      else if (m["t"] === "status") this.emit("status", m as unknown as SurfaceStatus);
      else if (m["t"] === "stats") {
        const n = Math.max(1, this.#encoded);
        this.emit("stats", { ...(m as unknown as SurfaceStats), encodeMs: Math.round((this.#encodeMs / n) * 10) / 10, skipped: this.#skipped });
        this.#encodeMs = 0;
        this.#encoded = 0;
        this.#skipped = 0;
      } else if (m["t"] === "end") this.close();
    };
    this.#ws.onclose = () => {
      if (!this.#closed) this.close();
    };
    const bitrate = opts.bitrate ?? Math.round(info.width * info.height * info.fps * 0.1);
    this.#ready = this.#configure(bitrate).then(() =>
      new Promise<void>((ok, fail) => {
        if (this.#ws.readyState === 1) return ok();
        this.#ws.onopen = () => ok();
        this.#ws.onerror = () => fail(new Error("cannot reach tvpipe's surface socket"));
      }),
    );
    this.#ready.then(
      () => {
        this.#ws.send(JSON.stringify({ t: "log", codec: this.codec, agent: globalThis.navigator?.userAgent ?? "" }));
        if (opts.clock === "timer") this.#tick(performance.now());
      },
      (e: Error) => this.emit("error", e),
    );
  }

  /** Resolves when the encoder and the socket are ready. */
  get ready(): Promise<void> {
    return this.#ready;
  }

  async #configure(bitrate: number): Promise<void> {
    const { width, height, fps } = this.info;
    for (const accel of ["prefer-hardware", "no-preference"] as const) {
      for (const codec of codecs(width, height, fps)) {
        const config: VideoEncoderConfig = {
          codec,
          width,
          height,
          bitrate,
          framerate: fps,
          latencyMode: "realtime",
          hardwareAcceleration: accel,
          avc: { format: "avc" },
        };
        let ok = false;
        try {
          ok = (await VideoEncoder.isConfigSupported(config)).supported === true;
        } catch {}
        if (!ok) continue;
        this.#encoder = new VideoEncoder({
          output: (chunk, meta) => this.#output(chunk, meta),
          error: (e) => this.emit("error", e instanceof Error ? e : new Error(String(e))),
        });
        this.#encoder.configure(config);
        this.codec = `${codec}${accel === "prefer-hardware" ? " (hw)" : ""}`;
        return;
      }
    }
    throw new Error("this browser cannot encode H.264 (VideoEncoder)");
  }

  #send(data: Uint8Array): void {
    if (this.#ws.readyState !== 1) return;
    this.#ws.send(data);
  }

  #output(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    const started = this.#pending.get(chunk.timestamp);
    this.#pending.delete(chunk.timestamp);
    if (started !== undefined) {
      this.#encodeMs += performance.now() - started;
      this.#encoded++;
    }
    const desc = meta?.decoderConfig?.description;
    if (desc) {
      const bytes = ArrayBuffer.isView(desc)
        ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
        : new Uint8Array(desc as ArrayBuffer);
      const key = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      if (key !== this.#config) {
        this.#config = key;
        this.#send(slrwRecord(4, chunk.timestamp, bytes, 0));
      }
    }
    // Warm-up (as capture.js, docs/share-protocol.md): a hardware encoder's
    // first pictures come out most of a second after their frames; a
    // stale first keyframe would make tvpipe's clock keep that delay.
    // Until a keyframe goes out, drop the others and keyframes more than
    // 150 ms old (and ask for another), for at most 3 s.
    if (!this.#warm) {
      const now = wallMicros();
      if (this.#warmUntil === 0) this.#warmUntil = now + 3e6;
      const fresh = now - chunk.timestamp <= 150_000 || now > this.#warmUntil;
      if (chunk.type !== "key" || !fresh) {
        if (chunk.type === "key") this.#wantKey = true;
        return;
      }
      this.#warm = true;
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    // Without an avcC the encoder wrote Annex B with its parameter sets in band.
    const flags = (chunk.type === "key" ? 1 : 0) | (this.#config === undefined ? 2 : 0);
    this.#send(slrwRecord(3, chunk.timestamp, data, flags));
  }

  /** The timer clock: a frame every 1/fps, catching up on late wake-ups. */
  #tick(due: number): void {
    if (this.#closed) return;
    this.frame(true);
    const step = 1000 / this.info.fps;
    let next = due + step;
    const now = performance.now();
    if (next < now - step) next = now;
    this.#timer = setTimeout(() => this.#tick(next), Math.max(0, next - now));
  }

  /**
   * Encodes what the canvas shows now (call it after drawing; faster than
   * the surface's rate is paced down, with an even cadence: `pacer`).
   * Skipped while the encoder or the socket are behind.
   */
  frame(force = false): void {
    const enc = this.#encoder;
    if (this.#closed || !enc || enc.state !== "configured" || this.#ws.readyState !== 1) return;
    const slot = this.#pace(wallMicros(), force);
    if (slot === null) return;
    const ts = Math.round(slot);
    if (enc.encodeQueueSize > 2 || this.#ws.bufferedAmount > 4 << 20) {
      this.#skipped++;
      return;
    }
    const key = this.#wantKey || ts - this.#lastKey >= this.#keyInterval;
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(this.canvas, { timestamp: ts });
    } catch (e) {
      this.#skipped++;
      return;
    }
    this.#pending.set(ts, performance.now());
    if (this.#pending.size > 64) this.#pending.clear();
    enc.encode(frame, { keyFrame: key });
    frame.close();
    if (key) {
      this.#wantKey = false;
      this.#lastKey = ts;
    }
  }

  /** Interleaved s16 PCM at the surface's rate (`captureAudio` makes it). */
  pushAudio(pcm: Int16Array, ptsUs: number = wallMicros()): void {
    if (this.#closed || !this.info.audio) return;
    this.#send(slrwRecord(2, ptsUs, new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    try {
      if (this.#encoder?.state === "configured") this.#encoder.close();
    } catch {}
    try {
      this.#ws.close();
    } catch {}
    this.emit("end");
  }
}

/** The AudioWorklet that hands its input on as Float32 blocks. */
const WORKLET = `class TvpipePcm extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) this.port.postMessage(ch.map((c) => c.slice(0)));
    return true;
  }
}
registerProcessor("tvpipe-pcm", TvpipePcm);`;

/**
 * Taps a Web Audio node and calls `onPcm` with ~10 ms of interleaved s16
 * PCM and its wall-clock time (µs), at the context's rate. The node still
 * plays wherever it is connected. Main thread only (AudioContext).
 */
export async function captureAudio(
  ctx: AudioContext,
  node: AudioNode,
  channels: number,
  onPcm: (pcm: Int16Array, ptsUs: number) => void,
): Promise<() => void> {
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const tap = new AudioWorkletNode(ctx, "tvpipe-pcm", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: channels, channelCountMode: "explicit" });
  node.connect(tap);
  const per = Math.round(ctx.sampleRate / 100);
  const stamp = audioClock(ctx.sampleRate);
  let buf = new Int16Array(per * channels);
  let fill = 0;
  tap.port.onmessage = (ev: MessageEvent<Float32Array[]>) => {
    const blocks = ev.data;
    const n = blocks[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels; c++) {
        const v = (blocks[c] ?? blocks[0]!)[i]!;
        buf[fill * channels + c] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      }
      if (++fill === per) {
        onPcm(buf, stamp(per, wallMicros()));
        buf = new Int16Array(per * channels);
        fill = 0;
      }
    }
  };
  return () => {
    node.disconnect(tap);
    tap.port.onmessage = null;
  };
}
