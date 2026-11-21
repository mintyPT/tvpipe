// @ts-check
/**
 * The TV's sound: every cue is synthesized with Web Audio (oscillators and
 * one noise buffer, no files), mixed through one compressor into the
 * context's destination, as Drawbluff's TV does (tvpipe's browser captures
 * the page's sound and allows autoplay). The host page's preview is muted
 * (`#mute=1`); a watch page opened by hand in a browser gets its sound
 * with the first tap (`unlock`, as Drawbluff's TV). Recipes: games/jinx/design/tabletop/README.md §6 and the game
 * show's (heartbeat, drumroll).
 *
 * Two loops: the bed (a soft tick-tock under the reveal) and the heartbeat
 * (under the typing: everything else goes quiet).
 */

import { rnd } from "./dom.js";

/** @type {{ muted: boolean, ctx: AudioContext | null, noise: AudioBuffer | null, out: GainNode | null, duck: GainNode | null }} */
const S = { muted: false, ctx: null, noise: null, out: null, duck: null };

/** @param {boolean} m */
export function setMuted(m) {
  S.muted = m;
}

function ac() {
  if (S.muted) return null;
  try {
    if (!S.ctx) {
      const ctx = new AudioContext();
      const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const comp = ctx.createDynamicsCompressor();
      const out = ctx.createGain();
      out.gain.value = 0.7;
      const duck = ctx.createGain();
      duck.connect(out);
      out.connect(comp).connect(ctx.destination);
      Object.assign(S, { ctx, noise: b, out, duck });
    }
    if (S.ctx && S.ctx.state === "suspended") void S.ctx.resume();
    return S.ctx;
  } catch {
    return null;
  }
}

/** A watch page opened by hand gets its sound with the first tap (a browser starts audio only in a gesture). */
export function unlock() {
  ac();
}

/** @param {GainNode} g @param {number} t @param {number} gain @param {number} attack @param {number} dur */
function env(g, t, gain, attack, dur) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

/**
 * @param {{ t?: number, dur?: number, type?: BiquadFilterType, f?: number, f2?: number, q?: number, gain?: number, attack?: number, duck?: boolean }} o
 */
function noise({ t = 0, dur = 0.1, type = "bandpass", f = 1000, f2, q = 1, gain = 0.4, attack = 0.003, duck = true }) {
  const ctx = ac();
  if (!ctx || !S.noise || !S.out || !S.duck) return;
  const t0 = ctx.currentTime + 0.01 + t;
  const s = ctx.createBufferSource();
  s.buffer = S.noise;
  s.loop = true;
  const fl = ctx.createBiquadFilter();
  fl.type = type;
  fl.Q.value = q;
  fl.frequency.setValueAtTime(f, t0);
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  const g = ctx.createGain();
  env(g, t0, gain, attack, dur);
  s.connect(fl).connect(g).connect(duck ? S.duck : S.out);
  s.start(t0, Math.random() * 0.5);
  s.stop(t0 + dur + 0.05);
}

/**
 * @param {{ t?: number, f?: number, f2?: number, dur?: number, type?: OscillatorType, gain?: number, attack?: number, lp?: number, duck?: boolean }} o
 */
function tone({ t = 0, f = 440, f2, dur = 0.2, type = "sine", gain = 0.3, attack = 0.004, lp, duck = true }) {
  const ctx = ac();
  if (!ctx || !S.out || !S.duck) return;
  const t0 = ctx.currentTime + 0.01 + t;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
  const g = ctx.createGain();
  env(g, t0, gain, attack, dur);
  /** @type {AudioNode} */
  let n = o;
  if (lp) {
    const fl = ctx.createBiquadFilter();
    fl.type = "lowpass";
    fl.frequency.value = lp;
    n = o.connect(fl);
  }
  n.connect(g).connect(duck ? S.duck : S.out);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

/** While the guesser types everything but the clicks and the heartbeat goes quiet. @param {boolean} on */
function hush(on) {
  const ctx = ac();
  if (!ctx || !S.duck) return;
  S.duck.gain.cancelScheduledValues(ctx.currentTime);
  S.duck.gain.setTargetAtTime(on ? 0.12 : 1, ctx.currentTime, 0.08);
}

export const sfx = {
  slide() { noise({ dur: 0.18, f: 1800, f2: 700, q: 0.8, gain: 0.22, attack: 0.03 }); },
  thwap() { noise({ dur: 0.07, type: "lowpass", f: 1400, gain: 0.55 }); tone({ f: 150, f2: 80, dur: 0.07, gain: 0.25 }); },
  whoosh() { noise({ dur: 0.28, f: 500, f2: 2600, q: 1.2, gain: 0.18, attack: 0.08 }); },
  flipTick() { noise({ dur: 0.03, type: "highpass", f: 3000, gain: 0.25 }); noise({ t: 0.07, dur: 0.03, type: "highpass", f: 3000, gain: 0.2 }); },
  thunk() { tone({ f: 240, f2: 110, dur: 0.14, type: "triangle", gain: 0.5 }); noise({ dur: 0.05, f: 800, q: 2, gain: 0.3 }); },
  slam() { tone({ f: 120, f2: 38, dur: 0.45, gain: 0.95 }); noise({ dur: 0.3, type: "lowpass", f: 500, gain: 0.9 }); noise({ dur: 0.08, type: "highpass", f: 2000, gain: 0.3 }); },
  shatter() {
    noise({ dur: 0.45, type: "highpass", f: 1400, gain: 0.45, attack: 0.002 });
    noise({ dur: 0.3, f: 2400, f2: 900, q: 3, gain: 0.3 });
    for (let i = 0; i < 7; i++) tone({ t: rnd(0.01, 0.25), f: rnd(1800, 4200), dur: 0.05, gain: 0.06, type: "triangle" });
  },
  stamp() { noise({ dur: 0.09, type: "lowpass", f: 1100, gain: 0.8 }); tone({ f: 190, f2: 90, dur: 0.1, gain: 0.45 }); },
  marker() { noise({ dur: 0.22, f: 3200, f2: 2400, q: 6, gain: 0.18, attack: 0.03 }); },
  clink() {
    const f = rnd(2400, 2900);
    tone({ f, dur: 0.14, gain: 0.12 });
    tone({ f: f * 1.52, dur: 0.1, gain: 0.07 });
    tone({ t: 0.05, f: f * 0.83, dur: 0.12, gain: 0.08 });
  },
  /** A label-maker letter: never ducked (it is what the room hears while the guesser types). */
  punch() { noise({ dur: 0.025, type: "highpass", f: 2500, gain: 0.35, duck: false }); noise({ t: 0.012, dur: 0.05, f: 450, q: 2, gain: 0.45, duck: false }); },
  unpunch() { noise({ dur: 0.04, f: 900, q: 2, gain: 0.25, duck: false }); },
  snip() { noise({ dur: 0.025, type: "highpass", f: 4000, gain: 0.4, duck: false }); noise({ t: 0.06, dur: 0.03, type: "highpass", f: 3500, gain: 0.45, duck: false }); },
  tick() { tone({ f: 1900, dur: 0.025, type: "square", gain: 0.05 }); noise({ dur: 0.02, f: 3000, q: 3, gain: 0.2 }); },
  pop() { tone({ f: 380, f2: 900, dur: 0.09, gain: 0.22 }); },
  bonk() { tone({ f: 220, f2: 140, dur: 0.16, type: "triangle", gain: 0.3 }); },
  zip() { noise({ dur: 0.3, f: 700, f2: 3200, q: 2, gain: 0.12, attack: 0.05 }); },
  ding() { tone({ f: 1320, dur: 0.7, gain: 0.18 }); tone({ f: 1980, dur: 0.45, gain: 0.07 }); },
  sparkle() { for (let i = 0; i < 9; i++) tone({ t: i * 0.045, f: rnd(1500, 3600), dur: 0.09, gain: 0.06 }); },
  /** The pot loses a point: a falling blip. @param {number} i */
  drain(i) { tone({ f: 1150 - i * 45, dur: 0.05, type: "square", gain: 0.06, lp: 3200 }); },
  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => { tone({ t: i * 0.1, f, dur: i === 3 ? 0.7 : 0.18, gain: 0.25 }); tone({ t: i * 0.1, f: f * 4, dur: 0.05, gain: 0.04 }); });
    [523, 659, 784].forEach((f) => tone({ t: 0.4, f, dur: 0.8, type: "triangle", gain: 0.12 }));
    noise({ t: 0.4, dur: 0.7, type: "highpass", f: 6000, gain: 0.12, attack: 0.01 });
  },
  trombone() {
    const ctx = ac();
    if (!ctx || !S.duck) return;
    const out = S.duck;
    [[392, 370], [370, 349], [349, 330], [330, 300]].forEach(([a, b], i) => {
      const t0 = ctx.currentTime + 0.02 + i * 0.32;
      const dur = i === 3 ? 0.9 : 0.3;
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(a ?? 330, t0);
      o.frequency.linearRampToValueAtTime(b ?? 300, t0 + dur);
      if (i === 3) {
        const l = ctx.createOscillator();
        const lg = ctx.createGain();
        l.frequency.value = 6;
        lg.gain.value = 9;
        l.connect(lg).connect(o.frequency);
        l.start(t0);
        l.stop(t0 + dur);
      }
      const fl = ctx.createBiquadFilter();
      fl.type = "lowpass";
      fl.frequency.value = 1100;
      const g = ctx.createGain();
      env(g, t0, 0.16, 0.03, dur);
      o.connect(fl).connect(g).connect(out);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    });
  },
  /** @param {number} ms */
  drumroll(ms) {
    const n = Math.floor(ms / 45);
    for (let i = 0; i < n; i++) noise({ t: i * 0.045, dur: 0.05, f: 260, q: 1.5, gain: 0.12 + 0.3 * (i / n) * Math.random() + 0.1 * (i / n) });
  },
  cymbal() { noise({ dur: 0.9, type: "highpass", f: 5500, gain: 0.2, attack: 0.005 }); },
  riser(sec = 1) { tone({ f: 180, f2: 900, dur: sec, type: "sawtooth", gain: 0.05, lp: 1600, attack: sec * 0.8 }); },
};

/** @type {ReturnType<typeof setInterval> | null} */
let bedTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let heartTimer = null;

/** The sound bed: a soft kitchen-timer tick-tock (the reveal's thinking time). @param {boolean} on */
export function bed(on) {
  if (on === !!bedTimer) return;
  if (bedTimer) clearInterval(bedTimer);
  bedTimer = null;
  if (!on) return;
  let k = 0;
  bedTimer = setInterval(() => {
    k++;
    noise({ dur: 0.03, f: k % 2 ? 2600 : 2000, q: 6, gain: 0.07 });
    if (k % 4 === 1) tone({ f: 98, dur: 0.5, gain: 0.04, attack: 0.08 });
  }, 600);
}

/** The heartbeat under the typing: the bed stops and the rest is hushed. @param {boolean} on */
export function heartbeat(on) {
  if (on === !!heartTimer) return;
  if (heartTimer) clearInterval(heartTimer);
  heartTimer = null;
  hush(on);
  if (!on) return;
  bed(false);
  const beat = () => {
    tone({ f: 64, f2: 44, dur: 0.16, gain: 0.75, duck: false });
    tone({ t: 0.22, f: 58, f2: 42, dur: 0.14, gain: 0.5, duck: false });
  };
  beat();
  heartTimer = setInterval(beat, 900);
}

/** Stops both loops (a new scene). */
export function quiet() {
  bed(false);
  heartbeat(false);
}
