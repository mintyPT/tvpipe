// @ts-check
/**
 * Busted's sounds on the TV, all synthesized (no files): the newsroom.
 * A camera's shutter and flash, a rubber stamp, typewriter keys and its
 * bell, the rumble of the press with a page spinning in, a drumroll, a
 * paper rustle, a ticking clock, a little fanfare. One master gain and a
 * compressor, so overlapping sounds never clip. `?mute=1` (the host
 * page's preview) is silent.
 */

const MUTED = new URLSearchParams(location.hash.slice(1)).get("mute") === "1" || new URLSearchParams(location.search).get("mute") === "1";

/** @type {AudioContext | null} */
let audio = null;
/** @type {GainNode | null} */
let master = null;

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
      comp.release.value = 0.2;
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
// A watch page opened by hand gets its sound with the first tap.
addEventListener("pointerdown", () => void ac(), { once: true });

/**
 * A tone gliding from one pitch to another.
 * @param {number} from @param {number} to @param {number} len
 * @param {{ type?: OscillatorType, vol?: number, delay?: number, attack?: number }} [o]
 */
function tone(from, to, len, o = {}) {
  const a = ac();
  if (!a || !master) return;
  const at = a.currentTime + 0.02 + (o.delay ?? 0);
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + len);
  const vol = o.vol ?? 0.15;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + (o.attack ?? 0.008));
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  osc.connect(g).connect(master);
  osc.start(at);
  osc.stop(at + len + 0.05);
}

/**
 * A burst of filtered noise.
 * @param {number} freq @param {number} len @param {number} vol
 * @param {{ delay?: number, type?: BiquadFilterType, q?: number, decay?: number }} [o]
 */
function noise(freq, len, vol, o = {}) {
  const a = ac();
  if (!a || !master) return;
  const at = a.currentTime + 0.02 + (o.delay ?? 0);
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * len), a.sampleRate);
  const d = buf.getChannelData(0);
  const decay = o.decay ?? 3;
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** decay;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = o.type ?? "bandpass";
  f.frequency.value = freq;
  f.Q.value = o.q ?? 2;
  const g = a.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(master);
  src.start(at);
}

export const sound = {
  /** A camera: the shutter's two clicks and the flash's whine. */
  shutter() {
    noise(3200, 0.03, 0.5, { q: 1.5 });
    noise(2200, 0.05, 0.45, { delay: 0.06, q: 1.5 });
    tone(2400, 5200, 0.35, { type: "sine", vol: 0.03, delay: 0.08 });
  },
  /** A rubber stamp hitting the page. */
  stamp() {
    noise(180, 0.18, 0.9, { type: "lowpass", q: 0.8, decay: 4 });
    tone(110, 55, 0.18, { type: "sine", vol: 0.35 });
    noise(1600, 0.04, 0.25, { q: 1 });
  },
  /** One key of a typewriter. */
  key() {
    noise(2600 + Math.random() * 900, 0.025, 0.28, { q: 4 });
    noise(500, 0.04, 0.12, { delay: 0.012, type: "lowpass" });
  },
  /** A typewriter's bell at the end of the line. */
  bell() {
    tone(2093, 2093, 0.6, { type: "triangle", vol: 0.08 });
    tone(4186, 4186, 0.3, { type: "sine", vol: 0.02 });
  },
  /** A letter dropped in the box. */
  letter() {
    noise(1200, 0.12, 0.22, { type: "bandpass", q: 0.7, decay: 2 });
    tone(320, 260, 0.08, { type: "triangle", vol: 0.06, delay: 0.05 });
  },
  /** The press rolls and a page spins in. */
  press() {
    for (let i = 0; i < 8; i++) noise(90 + (i % 2) * 40, 0.12, 0.35, { delay: i * 0.09, type: "lowpass", q: 0.7 });
    noise(900, 0.5, 0.2, { delay: 0.2, type: "bandpass", q: 0.5, decay: 1.5 });
  },
  /** Paper rustling (a new page, the board). */
  rustle() {
    noise(2400, 0.25, 0.18, { q: 0.6, decay: 1.2 });
    noise(1500, 0.2, 0.12, { delay: 0.12, q: 0.6, decay: 1.5 });
  },
  /** A snare roll before the winner. @param {number} [len] seconds */
  drumroll(len = 1.8) {
    const n = Math.round(len * 24);
    for (let i = 0; i < n; i++) noise(1800, 0.05, 0.1 + 0.25 * (i / n), { delay: i / 24, q: 0.8 });
    noise(120, 0.4, 0.8, { delay: len, type: "lowpass", q: 0.7 });
    noise(3000, 0.5, 0.3, { delay: len, q: 0.5, decay: 1.5 });
  },
  /** A ballot counted: a soft pencil tick. @param {number} [pitch] */
  tally(pitch = 0) {
    tone(520 + pitch * 60, 760 + pitch * 60, 0.09, { type: "triangle", vol: 0.08 });
    noise(4000, 0.02, 0.1, { q: 3 });
  },
  /** The clock's last seconds. */
  tick() {
    noise(5000, 0.015, 0.25, { q: 6 });
  },
  /** Time's up: the press bell. */
  ding() {
    tone(1318, 1318, 0.5, { type: "triangle", vol: 0.12 });
    tone(1760, 1760, 0.5, { type: "sine", vol: 0.05, delay: 0.02 });
  },
  /** A right guess, a heart: a little chime. */
  chime() {
    tone(1046, 1046, 0.18, { type: "triangle", vol: 0.08 });
    tone(1568, 1568, 0.3, { type: "triangle", vol: 0.07, delay: 0.09 });
  },
  /** The special edition: a short brass fanfare. */
  fanfare() {
    const notes = [392, 523, 659, 784, 659, 784];
    notes.forEach((f, i) => {
      tone(f, f, i === notes.length - 1 ? 0.7 : 0.16, { type: "sawtooth", vol: 0.05, delay: i * 0.13 });
      tone(f * 2, f * 2, i === notes.length - 1 ? 0.6 : 0.14, { type: "triangle", vol: 0.03, delay: i * 0.13 });
    });
  },
  /** Someone joined the newsroom. */
  join() {
    tone(660, 990, 0.12, { type: "triangle", vol: 0.07 });
    tone(990, 1320, 0.12, { type: "triangle", vol: 0.05, delay: 0.08 });
  },
};
