// @ts-check
/**
 * Pinch's sounds on the TV, all synthesized with Web Audio (no files),
 * docs/pinch-design.md §12: a police whistle (a hold), an alarm bell
 * (the police alarm), breaking glass (a display case), a firecracker, a
 * camera shutter (a sighting), a record scratch (the arrest), a modern
 * car alarm's chirp (got away), a ticking clock (the last 10 s) and the
 * tape's VHS whirr. One master gain and a compressor, so overlapping
 * sounds never clip. `?mute=1` or `#mute=1` (the host page's preview) is
 * silent; nothing here throws (no AudioContext: no sound).
 *
 *   import { sfx } from "./sound.js";
 *   sfx.whistle();
 */

const MUTED = (() => {
  try {
    return new URLSearchParams(location.hash.slice(1)).get("mute") === "1" || new URLSearchParams(location.search).get("mute") === "1";
  } catch {
    return false;
  }
})();

/** @type {AudioContext | null} */
let audio = null;
/** @type {GainNode | null} */
let master = null;
/** @type {AudioBuffer | null} */
let noiseBuf = null;

function ac() {
  if (MUTED) return null;
  try {
    if (!audio) {
      const a = new AudioContext();
      const comp = a.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 10;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      const out = a.createGain();
      out.gain.value = 0.8;
      out.connect(comp).connect(a.destination);
      audio = a;
      master = out;
    }
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}
// A TV page opened by hand gets its sound with the first tap.
try {
  addEventListener("pointerdown", () => void ac(), { once: true });
} catch {
  // no window
}

/** Two seconds of white noise, shared. @param {AudioContext} a */
function noise(a) {
  if (!noiseBuf || noiseBuf.sampleRate !== a.sampleRate) {
    noiseBuf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

/**
 * An envelope: silence, a ramp to `vol` in `attack`, held for `hold`, decaying over `decay`.
 * @param {AudioParam} p @param {number} at @param {number} vol @param {number} attack @param {number} hold @param {number} decay
 */
function env(p, at, vol, attack, hold, decay) {
  p.setValueAtTime(0.0001, at);
  p.exponentialRampToValueAtTime(Math.max(0.0002, vol), at + Math.max(0.001, attack));
  p.setValueAtTime(Math.max(0.0002, vol), at + attack + hold);
  p.exponentialRampToValueAtTime(0.0001, at + attack + hold + Math.max(0.005, decay));
}

/**
 * An oscillator through a gain with an envelope; returns the nodes for modulation.
 * @param {{ type?: OscillatorType, freq: number, to?: number, delay?: number, vol?: number, attack?: number, hold?: number, decay?: number, glide?: number, out?: AudioNode }} o
 */
function osc(o) {
  const a = ac();
  if (!a || !master) return null;
  const at = a.currentTime + 0.02 + (o.delay ?? 0);
  const n = a.createOscillator();
  const g = a.createGain();
  n.type = o.type ?? "sine";
  n.frequency.setValueAtTime(o.freq, at);
  const attack = o.attack ?? 0.005;
  const hold = o.hold ?? 0;
  const decay = o.decay ?? 0.2;
  if (o.to !== undefined) n.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), at + (o.glide ?? attack + hold + decay));
  env(g.gain, at, o.vol ?? 0.15, attack, hold, decay);
  n.connect(g).connect(o.out ?? master);
  n.start(at);
  n.stop(at + attack + hold + decay + 0.05);
  return { a, at, osc: n, gain: g };
}

/**
 * Filtered noise with an envelope.
 * @param {{ type?: BiquadFilterType, freq: number, to?: number, q?: number, delay?: number, vol?: number, attack?: number, hold?: number, decay?: number, out?: AudioNode }} o
 */
function hiss(o) {
  const a = ac();
  if (!a || !master) return null;
  const at = a.currentTime + 0.02 + (o.delay ?? 0);
  const src = a.createBufferSource();
  src.buffer = noise(a);
  src.loop = true;
  const f = a.createBiquadFilter();
  f.type = o.type ?? "bandpass";
  f.frequency.setValueAtTime(o.freq, at);
  const attack = o.attack ?? 0.002;
  const hold = o.hold ?? 0;
  const decay = o.decay ?? 0.1;
  if (o.to !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), at + attack + hold + decay);
  f.Q.value = o.q ?? 1;
  const g = a.createGain();
  env(g.gain, at, o.vol ?? 0.2, attack, hold, decay);
  src.connect(f).connect(g).connect(o.out ?? master);
  src.start(at, Math.random() * 1.5);
  src.stop(at + attack + hold + decay + 0.05);
  return { a, at, src, filter: f, gain: g };
}

/** A low-frequency oscillator on a param. @param {AudioContext} a @param {AudioParam} p @param {number} rate @param {number} depth @param {number} at @param {number} len @param {OscillatorType} [type] */
function lfo(a, p, rate, depth, at, len, type = "sine") {
  const l = a.createOscillator();
  l.type = type;
  l.frequency.value = rate;
  const g = a.createGain();
  g.gain.value = depth;
  l.connect(g).connect(p);
  l.start(at);
  l.stop(at + len + 0.05);
}

export const sfx = {
  /** A hold: a pea whistle, a short blast and a long one, the pea trilling. */
  whistle() {
    for (const [delay, len] of [[0, 0.22], [0.32, 0.75]]) {
      const n = osc({ freq: 2750, delay, vol: 0.14, attack: 0.02, hold: len, decay: 0.08 });
      if (n) lfo(n.a, n.osc.frequency, 32, 160, n.at, len + 0.1, "triangle");
      const h = hiss({ freq: 2900, q: 6, delay, vol: 0.05, attack: 0.02, hold: len, decay: 0.08 });
      if (h) lfo(h.a, h.gain.gain, 32, 0.03, h.at, len + 0.1);
    }
  },
  /** The police alarm: an electric bell, a clapper on a brass dome, two and a half seconds. */
  bell() {
    const a = ac();
    if (!a || !master) return;
    const len = 2.5;
    const at = a.currentTime + 0.02;
    const bus = a.createGain();
    bus.gain.value = 0;
    // The clapper: the dome struck 18 times a second.
    const clap = a.createOscillator();
    clap.type = "square";
    clap.frequency.value = 18;
    const depth = a.createGain();
    depth.gain.value = 0.5;
    const offset = a.createConstantSource();
    offset.offset.value = 0.5;
    clap.connect(depth).connect(bus.gain);
    offset.connect(bus.gain);
    clap.start(at);
    offset.start(at);
    clap.stop(at + len);
    offset.stop(at + len);
    const out = a.createGain();
    env(out.gain, at, 1, 0.01, len - 0.4, 0.4);
    bus.connect(out).connect(master);
    // The dome: inharmonic partials.
    for (const [ratio, vol] of [[1, 0.09], [2.76, 0.05], [5.4, 0.03], [8.9, 0.015]]) {
      const o = a.createOscillator();
      o.frequency.value = 1180 * (ratio ?? 1);
      const g = a.createGain();
      g.gain.value = vol ?? 0.05;
      o.connect(g).connect(bus);
      o.start(at);
      o.stop(at + len + 0.05);
    }
  },
  /** A display case smashed: a crack, then shards tinkling down. */
  glass() {
    hiss({ type: "highpass", freq: 2500, vol: 0.35, decay: 0.12 });
    hiss({ type: "bandpass", freq: 5200, q: 2, vol: 0.2, decay: 0.35 });
    osc({ freq: 180, to: 60, vol: 0.18, decay: 0.08 });
    for (let k = 0; k < 16; k++) {
      const f = 3000 + Math.random() * 5000;
      osc({ freq: f, to: f * 0.98, delay: 0.04 + Math.random() * 0.6 * Math.sqrt(k / 16), vol: 0.03 + Math.random() * 0.04, decay: 0.05 + Math.random() * 0.12 });
    }
  },
  /** A firecracker: the bang and a few crackles. */
  firecracker() {
    hiss({ type: "lowpass", freq: 3000, to: 300, vol: 0.6, decay: 0.25 });
    osc({ freq: 120, to: 40, vol: 0.35, decay: 0.2 });
    for (let k = 0; k < 6; k++) hiss({ type: "bandpass", freq: 1500 + Math.random() * 3000, q: 2, delay: 0.12 + k * 0.05 + Math.random() * 0.04, vol: 0.18, decay: 0.03 });
  },
  /** A camera sighting: the shutter's two clicks and the film advancing. */
  shutter() {
    hiss({ type: "bandpass", freq: 3500, q: 3, vol: 0.4, decay: 0.03 });
    osc({ type: "square", freq: 900, to: 500, vol: 0.05, decay: 0.03 });
    hiss({ type: "bandpass", freq: 2200, q: 3, delay: 0.07, vol: 0.35, decay: 0.04 });
    const w = osc({ type: "sawtooth", freq: 420, to: 520, delay: 0.16, vol: 0.035, attack: 0.02, hold: 0.22, decay: 0.05 });
    if (w) lfo(w.a, w.gain.gain, 45, 0.02, w.at, 0.3, "square");
  },
  /** The arrest: a record scratch, back and forth, and the music stopping. */
  scratch() {
    hiss({ type: "bandpass", freq: 500, to: 2600, q: 4, vol: 0.4, attack: 0.01, decay: 0.12 });
    hiss({ type: "bandpass", freq: 2400, to: 400, q: 4, delay: 0.13, vol: 0.4, attack: 0.01, decay: 0.16 });
    osc({ type: "sawtooth", freq: 220, to: 660, vol: 0.08, decay: 0.12 });
    osc({ type: "sawtooth", freq: 620, to: 90, delay: 0.13, vol: 0.08, decay: 0.3 });
  },
  /** Got away: a modern car alarm's chirp-chirp, seventy years early. */
  chirp() {
    for (const delay of [0, 0.16]) {
      osc({ type: "square", freq: 2400, to: 2900, delay, vol: 0.08, attack: 0.004, hold: 0.07, decay: 0.03, glide: 0.08 });
      osc({ type: "square", freq: 1200, to: 1450, delay, vol: 0.04, attack: 0.004, hold: 0.07, decay: 0.03, glide: 0.08 });
    }
  },
  /** The last ten seconds: a clock's tick (and tock, `high` false). @param {boolean} [high] */
  tick(high = true) {
    hiss({ type: "bandpass", freq: high ? 3200 : 2300, q: 8, vol: 0.5, decay: 0.03 });
    osc({ freq: high ? 1800 : 1300, vol: 0.06, decay: 0.04 });
  },
  /** The tape: a VHS deck's whirr, the motor spinning up with a clunk. @param {number} [len] seconds */
  whirr(len = 1.4) {
    const l = Math.max(0.3, Math.min(6, Number.isFinite(len) ? len : 1.4));
    hiss({ type: "lowpass", freq: 900, vol: 0.4, decay: 0.06 });
    osc({ freq: 90, to: 50, vol: 0.25, decay: 0.1 });
    const m = osc({ type: "sawtooth", freq: 40, to: 62, delay: 0.08, vol: 0.06, attack: 0.15, hold: l - 0.35, decay: 0.25, glide: 0.5 });
    if (m) lfo(m.a, m.osc.frequency, 3.5, 2, m.at, l);
    const h = hiss({ type: "bandpass", freq: 1400, q: 0.8, delay: 0.08, vol: 0.05, attack: 0.15, hold: l - 0.35, decay: 0.25 });
    if (h) lfo(h.a, h.filter.frequency, 0.8, 400, h.at, l);
  },
};
