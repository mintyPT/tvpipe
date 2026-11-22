// @ts-check
/**
 * Drawbluff's sounds, synthesized with Web Audio (no files): the TV page
 * plays the show (stingers, stamps, the drum roll, the fanfare, applause),
 * the phones a few quiet ones (a tap, your turn, sent, points). Every
 * sound is a short recipe of oscillators and filtered noise through one
 * master gain and a compressor, so nothing clips when several overlap.
 *
 * Browsers start audio only after a gesture (phones) or with autoplay
 * allowed (tvpipe's own browser): {@link Sfx.unlock} on the first tap.
 *
 * iOS gives Web Audio the "ambient" session, which the silent switch
 * mutes; the sounds have their own toggle, so they ask for "playback"
 * (Safari 16.4+) and play with the phone on silent.
 */

/**
 * @typedef {"pop" | "whoosh" | "tick" | "tock" | "stamp" | "fanfare" | "wahwah" | "coin" | "drumroll" | "chime"
 *   | "drop" | "applause" | "done" | "tap" | "send" | "swish" | "reveal" | "join"} SoundName
 */

export class Sfx {
  /** @param {{ volume?: number, muted?: boolean, context?: BaseAudioContext }} [opts] `context`: one of your own (an OfflineAudioContext, to listen in a test) */
  constructor(opts = {}) {
    /** @type {BaseAudioContext | null} */
    this.ctx = null;
    this.given = opts.context ?? null;
    /** @type {GainNode | null} */
    this.master = null;
    /** @type {AudioBuffer | null} */
    this.noiseBuf = null;
    this.volume = opts.volume ?? 0.8;
    this.muted = !!opts.muted;
  }

  /** The audio graph, made on first use (null where there is no Web Audio). */
  #ensure() {
    if (this.ctx) return this.ctx;
    const AC = globalThis.AudioContext ?? /** @type {any} */ (globalThis).webkitAudioContext;
    if (!AC && !this.given) return null;
    if (!this.given) {
      try {
        const session = /** @type {any} */ (globalThis.navigator)?.audioSession;
        if (session && session.type !== "playback") session.type = "playback";
      } catch {}
    }
    try {
      const ctx = /** @type {BaseAudioContext} */ (this.given ?? new AC());
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      const master = ctx.createGain();
      master.gain.value = this.volume;
      master.connect(comp).connect(ctx.destination);
      // Two seconds of white noise, looped where a sound needs longer.
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let seed = 0x2545f491;
      for (let i = 0; i < d.length; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        d[i] = ((seed >>> 0) / 4294967296) * 2 - 1;
      }
      this.ctx = ctx;
      this.master = master;
      this.noiseBuf = buf;
      return ctx;
    } catch {
      return null;
    }
  }

  /** Starts (or resumes) audio: call from a tap on phones. */
  unlock() {
    if (this.muted) return;
    const ctx = this.#ensure();
    if (ctx && ctx.state === "suspended" && !("startRendering" in ctx)) void (/** @type {AudioContext} */ (ctx)).resume().catch(() => {});
  }

  /**
   * Plays a sound now (or `at` seconds from now).
   * @param {SoundName} name
   * @param {{ at?: number, vol?: number, len?: number, pitch?: number }} [o]
   */
  play(name, o = {}) {
    if (this.muted) return;
    const ctx = this.#ensure();
    if (!ctx || !this.master) return;
    if (ctx && ctx.state === "suspended" && !("startRendering" in ctx)) void (/** @type {AudioContext} */ (ctx)).resume().catch(() => {});
    const t = ctx.currentTime + 0.01 + (o.at ?? 0);
    const v = o.vol ?? 1;
    const p = o.pitch ?? 1;
    try {
      RECIPES[name]?.(this, t, v, p, o.len);
    } catch (e) {
      if (this.given) throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Building blocks

  /**
   * An oscillator through an envelope.
   * @param {{ type?: OscillatorType, f: number, to?: number, glide?: number, t: number, a?: number, d: number, v: number, dest?: AudioNode, detune?: number, vibrato?: number }} o
   */
  tone(o) {
    const ctx = /** @type {BaseAudioContext} */ (this.ctx);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(o.f, o.t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, o.t + (o.glide ?? o.d));
    if (o.detune) osc.detune.value = o.detune;
    if (o.vibrato) {
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 6;
      lg.gain.value = o.vibrato;
      lfo.connect(lg).connect(osc.frequency);
      lfo.start(o.t);
      lfo.stop(o.t + (o.a ?? 0.005) + o.d + 0.05);
    }
    const a = o.a ?? 0.005;
    g.gain.setValueAtTime(0.0001, o.t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.v), o.t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, o.t + a + o.d);
    osc.connect(g).connect(o.dest ?? /** @type {GainNode} */ (this.master));
    osc.start(o.t);
    osc.stop(o.t + a + o.d + 0.05);
    return osc;
  }

  /**
   * Filtered noise through an envelope.
   * @param {{ t: number, d: number, v: number, a?: number, type?: BiquadFilterType, f: number, to?: number, q?: number, dest?: AudioNode, hold?: number }} o
   */
  noise(o) {
    const ctx = /** @type {BaseAudioContext} */ (this.ctx);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = o.type ?? "bandpass";
    filt.frequency.setValueAtTime(o.f, o.t);
    if (o.to) filt.frequency.exponentialRampToValueAtTime(o.to, o.t + (o.a ?? 0.005) + (o.hold ?? 0) + o.d);
    filt.Q.value = o.q ?? 1;
    const g = ctx.createGain();
    const a = o.a ?? 0.005;
    g.gain.setValueAtTime(0.0001, o.t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.v), o.t + a);
    if (o.hold) g.gain.setValueAtTime(Math.max(0.0002, o.v), o.t + a + o.hold);
    g.gain.exponentialRampToValueAtTime(0.0001, o.t + a + (o.hold ?? 0) + o.d);
    src.connect(filt).connect(g).connect(o.dest ?? /** @type {GainNode} */ (this.master));
    src.start(o.t, Math.random() * 1.5);
    src.stop(o.t + a + (o.hold ?? 0) + o.d + 0.05);
  }

  /**
   * A lowpassed bus (brass, the trombone): `dest` for tones.
   * @param {number} t
   * @param {number} f cutoff
   * @param {number} [to] the cutoff later
   * @param {number} [d] how long to get there
   */
  lowpass(t, f, to, d = 0.3) {
    const ctx = /** @type {BaseAudioContext} */ (this.ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(f, t);
    if (to) lp.frequency.exponentialRampToValueAtTime(to, t + d);
    lp.Q.value = 2;
    lp.connect(/** @type {GainNode} */ (this.master));
    return lp;
  }
}

/** Every sound there is. @type {readonly SoundName[]} */
export const SOUNDS = /** @type {const} */ (["pop", "join", "whoosh", "swish", "tick", "tock", "stamp", "fanfare", "wahwah", "coin", "drumroll", "chime", "drop", "done", "tap", "send", "reveal", "applause"]);

/** A note's frequency: `n` semitones from A4. @param {number} n */
const note = (n) => 440 * 2 ** (n / 12);
// C5 = 3, E5 = 7, G5 = 10, C6 = 15.

/** @type {Record<SoundName, (s: Sfx, t: number, v: number, p: number, len?: number) => void>} */
const RECIPES = {
  // A player joins: a bubbly up-blip.
  pop: (s, t, v, p) => {
    s.tone({ type: "sine", f: 380 * p, to: 980 * p, glide: 0.07, t, d: 0.11, v: 0.35 * v });
    s.tone({ type: "triangle", f: 1400 * p, t: t + 0.04, d: 0.06, v: 0.08 * v });
  },
  // A player joins, the lobby's two-note doorbell (higher for later players: `pitch`).
  join: (s, t, v, p) => {
    s.tone({ type: "triangle", f: note(7) * p, t, d: 0.16, v: 0.22 * v });
    s.tone({ type: "triangle", f: note(14) * p, t: t + 0.09, d: 0.28, v: 0.22 * v });
    s.tone({ type: "sine", f: note(26) * p, t: t + 0.09, d: 0.2, v: 0.05 * v });
  },
  // The stinger's brush strokes: air sweeping past.
  whoosh: (s, t, v, p, len = 0.55) => {
    s.noise({ t, a: len * 0.45, d: len * 0.55, v: 0.55 * v, type: "bandpass", f: 300 * p, to: 2600 * p, q: 1.2 });
    s.noise({ t: t + 0.03, a: len * 0.4, d: len * 0.5, v: 0.18 * v, type: "highpass", f: 3000, q: 0.5 });
  },
  // A short swish (a card, a page).
  swish: (s, t, v, p) => {
    s.noise({ t, a: 0.06, d: 0.16, v: 0.3 * v, type: "bandpass", f: 1800 * p, to: 4500 * p, q: 1.5 });
  },
  // The clock's last seconds: a wood block, tick and tock.
  tick: (s, t, v, p) => {
    s.tone({ type: "sine", f: 1850 * p, to: 1500 * p, t, a: 0.001, d: 0.05, v: 0.4 * v });
    s.noise({ t, a: 0.001, d: 0.02, v: 0.25 * v, type: "bandpass", f: 3500, q: 3 });
  },
  tock: (s, t, v, p) => {
    s.tone({ type: "sine", f: 1240 * p, to: 1000 * p, t, a: 0.001, d: 0.07, v: 0.42 * v });
    s.noise({ t, a: 0.001, d: 0.025, v: 0.22 * v, type: "bandpass", f: 2400, q: 3 });
  },
  // A rubber stamp slammed on paper.
  stamp: (s, t, v) => {
    s.tone({ type: "sine", f: 150, to: 48, glide: 0.12, t, a: 0.002, d: 0.16, v: 0.75 * v });
    s.noise({ t, a: 0.001, d: 0.09, v: 0.5 * v, type: "lowpass", f: 1800, to: 300, q: 0.7 });
    s.noise({ t: t + 0.005, a: 0.001, d: 0.03, v: 0.25 * v, type: "highpass", f: 4000, q: 0.7 });
  },
  // The truth: a little brass fanfare (saws through a lowpass that opens).
  fanfare: (s, t, v) => {
    const bus = s.lowpass(t, 900, 4200, 0.25);
    /** @type {[number, number, number][]} */
    const seq = [
      [3, 0, 0.12],
      [3, 0.13, 0.08],
      [7, 0.22, 0.12],
      [10, 0.35, 0.7],
    ];
    for (const [n, at, d] of seq) {
      for (const det of [-7, 6]) s.tone({ type: "sawtooth", f: note(n), t: t + at, a: 0.02, d, v: 0.12 * v, dest: bus, detune: det, vibrato: d > 0.3 ? 4 : 0 });
    }
    // The chord under the last note.
    for (const n of [-2, 3, 7]) s.tone({ type: "sawtooth", f: note(n), t: t + 0.35, a: 0.03, d: 0.75, v: 0.06 * v, dest: bus });
    s.tone({ type: "sine", f: note(22), t: t + 0.36, d: 0.9, v: 0.05 * v });
    // A cymbal.
    s.noise({ t: t + 0.35, a: 0.003, d: 1.1, v: 0.16 * v, type: "highpass", f: 5500, q: 0.6 });
  },
  // A lie that fooled people: the sad trombone (wah, wah, wah, waaah).
  wahwah: (s, t, v) => {
    const bus = s.lowpass(t, 700, 1400, 0.2);
    /** @type {[number, number, number][]} */
    const seq = [
      [-2, 0, 0.2],
      [-3, 0.24, 0.2],
      [-4, 0.48, 0.2],
      [-5, 0.72, 0.62],
    ];
    for (const [n, at, d] of seq) {
      s.tone({ type: "sawtooth", f: note(n - 12), t: t + at, a: 0.04, d, v: 0.22 * v, dest: bus, vibrato: d > 0.3 ? 5 : 1.5 });
      s.tone({ type: "triangle", f: note(n - 24), t: t + at, a: 0.04, d, v: 0.12 * v, dest: bus });
    }
  },
  // Points: a coin.
  coin: (s, t, v, p) => {
    s.tone({ type: "square", f: 988 * p, t, a: 0.002, d: 0.07, v: 0.1 * v });
    s.tone({ type: "square", f: 1319 * p, t: t + 0.07, a: 0.002, d: 0.3, v: 0.1 * v });
  },
  // Before the truth: a snare roll that swells (`len` seconds).
  drumroll: (s, t, v, _p, len = 1) => {
    const n = Math.max(4, Math.round(len * 26));
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const at = t + (len * i) / n + (Math.random() - 0.5) * 0.006;
      s.noise({ t: at, a: 0.001, d: 0.05, v: (0.05 + 0.3 * f * f) * v, type: "bandpass", f: 2200 + 600 * Math.random(), q: 0.8 });
    }
  },
  // A bell: your turn, a phase starts.
  chime: (s, t, v, p) => {
    for (const [k, d, g] of [
      [1, 0.9, 0.22],
      [2.76, 0.5, 0.07],
      [5.4, 0.25, 0.04],
    ]) {
      s.tone({ type: "sine", f: note(10) * p * k, t, a: 0.003, d, v: g * v });
      s.tone({ type: "sine", f: note(15) * p * k, t: t + 0.1, a: 0.003, d: d * 1.1, v: g * v });
    }
  },
  // A frame hung on the wall, a card dealt: a soft knock.
  drop: (s, t, v, p) => {
    s.tone({ type: "sine", f: 220 * p, to: 90 * p, glide: 0.08, t, a: 0.002, d: 0.1, v: 0.3 * v });
    s.noise({ t, a: 0.001, d: 0.04, v: 0.12 * v, type: "bandpass", f: 1200 * p, q: 1 });
  },
  // A drawing is done: two bright notes.
  done: (s, t, v, p) => {
    s.tone({ type: "triangle", f: note(10) * p, t, d: 0.1, v: 0.2 * v });
    s.tone({ type: "triangle", f: note(15) * p, t: t + 0.07, d: 0.22, v: 0.2 * v });
    s.tone({ type: "sine", f: note(27) * p, t: t + 0.07, d: 0.15, v: 0.04 * v });
  },
  // A button on the phone.
  tap: (s, t, v, p) => {
    s.tone({ type: "sine", f: 900 * p, to: 600 * p, glide: 0.03, t, a: 0.001, d: 0.04, v: 0.12 * v });
  },
  // Sent from the phone: a paper flick and a rising note.
  send: (s, t, v) => {
    s.noise({ t, a: 0.02, d: 0.12, v: 0.15 * v, type: "bandpass", f: 2000, to: 5000, q: 1.2 });
    s.tone({ type: "triangle", f: note(3), to: note(15), glide: 0.12, t, d: 0.16, v: 0.12 * v });
  },
  // A reveal card turns over.
  reveal: (s, t, v, p) => {
    s.noise({ t, a: 0.02, d: 0.1, v: 0.2 * v, type: "bandpass", f: 900 * p, to: 2800 * p, q: 1.4 });
    s.tone({ type: "triangle", f: note(-2) * p, t: t + 0.02, d: 0.12, v: 0.1 * v });
  },
  // The winner: a room clapping (many short claps), then a cheer of noise.
  applause: (s, t, v, _p, len = 3.2) => {
    const claps = Math.round(len * 70);
    for (let i = 0; i < claps; i++) {
      const at = t + Math.random() * len;
      const f = (at - t) / len;
      const env = f < 0.15 ? f / 0.15 : f > 0.7 ? Math.max(0, (1 - f) / 0.3) : 1;
      s.noise({ t: at, a: 0.001, d: 0.03 + Math.random() * 0.03, v: 0.22 * env * v * (0.5 + Math.random() * 0.5), type: "bandpass", f: 900 + Math.random() * 1800, q: 1.2 });
    }
    s.noise({ t, a: len * 0.2, hold: len * 0.4, d: len * 0.4, v: 0.05 * v, type: "bandpass", f: 1400, q: 0.4 });
  },
};
