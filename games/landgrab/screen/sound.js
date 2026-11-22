// @ts-check
/**
 * The TV's sound, all synthesized (no files): drums, dice rattling and
 * landing, hits, the clash of a head-on fight, brass for conquests and
 * fanfares, ticks and chimes. Everything goes through one master gain,
 * a little room (a convolver with a made-up impulse) and a compressor.
 * The watch page's preview is muted (`#mute=1`): the TV plays.
 */

/** @type {AudioContext | null} */
let audio = null;
/** @type {GainNode | null} */
let dry = null;
/** @type {GainNode | null} */
let wet = null;
/** @type {AudioBuffer | null} */
let noiseBuf = null;
let muted = false;

/** Turns the sound off for good (the preview). @param {boolean} on */
export function mute(on) {
  muted = on;
}

function ac() {
  if (muted) return null;
  try {
    if (!audio) {
      const a = new AudioContext();
      const comp = a.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 4;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
      const out = a.createGain();
      out.gain.value = 0.85;
      out.connect(comp).connect(a.destination);
      // A small room: noise decaying over 1.4 s, a little of everything goes there.
      const len = Math.floor(a.sampleRate * 1.4);
      const ir = a.createBuffer(2, len, a.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
      }
      const conv = a.createConvolver();
      conv.buffer = ir;
      const send = a.createGain();
      send.gain.value = 0.22;
      send.connect(conv).connect(out);
      audio = a;
      dry = out;
      wet = send;
      noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}
addEventListener("pointerdown", () => ac(), { once: true });

/** Where a voice goes: the master, and some of it into the room. @param {AudioContext} a @param {AudioNode} node @param {number} [room] */
function out(a, node, room = 1) {
  if (!dry || !wet) return;
  node.connect(dry);
  if (room > 0) {
    const g = a.createGain();
    g.gain.value = room;
    node.connect(g).connect(wet);
  }
}

/**
 * Filtered noise.
 * @param {{ f: number, len: number, vol?: number, at?: number, q?: number, type?: BiquadFilterType, to?: number, room?: number }} o
 */
function noise(o) {
  const a = ac();
  if (!a || !noiseBuf) return;
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  const f = a.createBiquadFilter();
  f.type = o.type ?? "bandpass";
  const t0 = a.currentTime + (o.at ?? 0);
  f.frequency.setValueAtTime(o.f, t0);
  if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t0 + o.len);
  f.Q.value = o.q ?? 1;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.vol ?? 0.3, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.len);
  src.connect(f).connect(g);
  out(a, g, o.room ?? 1);
  src.start(t0, Math.random() * 0.4, o.len + 0.05);
}

/**
 * A tone sliding from one pitch to another.
 * @param {{ f: number, to?: number, len: number, type?: OscillatorType, vol?: number, at?: number, attack?: number, room?: number }} o
 */
function tone(o) {
  const a = ac();
  if (!a) return;
  const osc = a.createOscillator();
  osc.type = o.type ?? "sine";
  const g = a.createGain();
  const t0 = a.currentTime + (o.at ?? 0);
  osc.frequency.setValueAtTime(o.f, t0);
  if (o.to && o.to !== o.f) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t0 + o.len);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.vol ?? 0.12, t0 + (o.attack ?? 0.006));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.len);
  osc.connect(g);
  out(a, g, o.room ?? 1);
  osc.start(t0);
  osc.stop(t0 + o.len + 0.05);
}

/** A brass note: two detuned saws through a filter that opens and closes. @param {number} f @param {number} at @param {number} len @param {number} [vol] */
function brass(f, at, len, vol = 0.07) {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + at;
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 2;
  lp.frequency.setValueAtTime(f * 1.5, t0);
  lp.frequency.exponentialRampToValueAtTime(f * 6, t0 + 0.06);
  lp.frequency.exponentialRampToValueAtTime(f * 3, t0 + Math.min(len, 0.3));
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.03);
  g.gain.setValueAtTime(vol, t0 + Math.max(0.04, len - 0.08));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + len + 0.12);
  for (const d of [-6, 6]) {
    const o = a.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = f;
    o.detune.value = d;
    o.connect(lp);
    o.start(t0);
    o.stop(t0 + len + 0.2);
  }
  lp.connect(g);
  out(a, g, 1.4);
}

/** A drum: a falling sine and a little noise. @param {number} [at] @param {number} [vol] @param {number} [pitch] */
function drum(at = 0, vol = 0.55, pitch = 1) {
  tone({ f: 160 * pitch, to: 48 * pitch, len: 0.4, vol, at, room: 0.6 });
  noise({ f: 300 * pitch, len: 0.12, vol: vol * 0.4, at, q: 0.8, type: "lowpass" });
}
/** A snare: a noise crack and a short tone. @param {number} [at] @param {number} [vol] */
function snare(at = 0, vol = 0.18) {
  noise({ f: 2200, len: 0.13, vol, at, q: 0.7 });
  tone({ f: 260, to: 180, len: 0.08, vol: vol * 0.6, at, type: "triangle" });
}
/** A die's click on the table. @param {number} at @param {number} [vol] */
function click(at, vol = 0.22) {
  noise({ f: 3200 + Math.random() * 2200, len: 0.025 + Math.random() * 0.02, vol, at, q: 5, room: 0.3 });
  tone({ f: 900 + Math.random() * 700, len: 0.035, vol: vol * 0.35, at, type: "triangle", room: 0.2 });
}

const NOTE = (/** @type {number} */ n) => 440 * 2 ** ((n - 69) / 12);

export const sfx = {
  /** A round starts: a roll on the drums, a hit. */
  roll: () => {
    for (let i = 0; i < 14; i++) snare(i * 0.045, 0.04 + i * 0.008);
    drum(0.66, 0.6);
    noise({ f: 6000, len: 1.1, vol: 0.06, at: 0.66, type: "highpass" });
  },
  /** The battle starts: drums and a call. */
  battle: () => {
    [0, 0.18, 0.36, 0.72].forEach((t, i) => drum(t, 0.5 + i * 0.06, i === 3 ? 0.8 : 1));
    [67, 72, 76].forEach((n, i) => brass(NOTE(n), 0.36 + i * 0.12, i === 2 ? 0.5 : 0.1, 0.06));
  },
  /** The camera flies. */
  whoosh: () => noise({ f: 300, to: 1800, len: 0.45, vol: 0.06, q: 1.4, room: 0.5 }),
  /** Armies march: footfalls and a snare. */
  march: () => [0, 0.16, 0.32, 0.48].forEach((t, i) => (drum(t, 0.18, 1.6), i % 2 && snare(t, 0.07))),
  /** The dice rattle (`quick`: a short one). @param {boolean} [quick] */
  dice: (quick = false) => {
    const n = quick ? 3 : 8;
    let t = 0;
    for (let i = 0; i < n; i++) {
      click(t, quick ? 0.12 : 0.2);
      t += quick ? 0.03 + Math.random() * 0.03 : 0.035 + Math.random() * 0.05 + i * 0.006;
    }
  },
  /** The dice land. */
  land: () => [0, 0.03, 0.055].forEach((t) => (tone({ f: 520, to: 380, len: 0.07, vol: 0.12, at: t, type: "triangle", room: 0.4 }), click(t, 0.12))),
  /** Armies fall (`big`: the defender, or many). @param {boolean} [big] */
  hit: (big = false) => {
    drum(0, big ? 0.7 : 0.5, big ? 0.7 : 0.9);
    noise({ f: 900, len: big ? 0.35 : 0.22, vol: big ? 0.32 : 0.22, q: 0.6 });
  },
  /** A tiny hit, for the fast-forwarded throws. */
  tap: () => (drum(0, 0.25, 1.2), click(0, 0.08)),
  /** Two armies meet head-on: metal and a boom. */
  clash: () => {
    [523, 1287, 1961, 2731, 3420].forEach((f, i) => tone({ f, to: f * 0.985, len: 0.9 - i * 0.12, type: i % 2 ? "square" : "triangle", vol: 0.045, room: 1.6 }));
    noise({ f: 5000, len: 0.9, vol: 0.18, type: "highpass", room: 1.5 });
    drum(0, 0.8, 0.6);
  },
  /** A territory taken: a short brass call and a drum. */
  conquer: () => {
    drum(0, 0.6, 0.8);
    [[67, 0, 0.1], [67, 0.12, 0.1], [72, 0.24, 0.45]].forEach(([n, t, l]) => (brass(NOTE(n ?? 60), t ?? 0, l ?? 0.1, 0.07), brass(NOTE((n ?? 60) - 12), t ?? 0, l ?? 0.1, 0.04)));
    noise({ f: 7000, len: 0.8, vol: 0.06, at: 0.24, type: "highpass" });
  },
  /** The attack is beaten off. */
  held: () => {
    drum(0, 0.5, 0.7);
    [[64, 0, 0.18], [60, 0.2, 0.4]].forEach(([n, t, l]) => brass(NOTE(n ?? 60) / 2, t ?? 0, l ?? 0.2, 0.06));
  },
  /** A continent taken whole: the big fanfare. */
  fanfare: () => {
    const phrase = [[60, 0, 0.14], [64, 0.15, 0.14], [67, 0.3, 0.14], [72, 0.45, 0.3], [67, 0.78, 0.14], [72, 0.93, 0.8]];
    for (const [n, t, l] of phrase) {
      brass(NOTE(n ?? 60), t ?? 0, l ?? 0.1, 0.06);
      brass(NOTE((n ?? 60) - 5), t ?? 0, l ?? 0.1, 0.035);
    }
    [0, 0.45, 0.93].forEach((t) => drum(t, 0.6, 0.75));
    noise({ f: 6500, len: 1.6, vol: 0.09, at: 0.93, type: "highpass", room: 1.5 });
  },
  /** A player wiped out: a gong and falling brass. */
  wipe: () => {
    [110, 164, 231, 297].forEach((f, i) => tone({ f, to: f * 0.97, len: 2.2 - i * 0.3, type: "sine", vol: 0.12 - i * 0.02, room: 1.8 }));
    [[55, 0.2, 0.3], [53, 0.55, 0.3], [50, 0.9, 0.8]].forEach(([n, t, l]) => brass(NOTE(n ?? 50), t ?? 0, l ?? 0.3, 0.07));
  },
  /** An uprising: a roll and a horn. */
  uprising: () => {
    for (let i = 0; i < 10; i++) snare(i * 0.05, 0.05 + i * 0.01);
    drum(0.5, 0.7, 0.7);
    [[62, 0.5, 0.2], [69, 0.72, 0.6]].forEach(([n, t, l]) => brass(NOTE(n ?? 60), t ?? 0, l ?? 0.3, 0.07));
  },
  /** Reinforcements land, one by one (rising). @param {number} k */
  drop: (k) => (tone({ f: 300 + k * 30, to: 160 + k * 15, len: 0.12, vol: 0.14, type: "triangle", room: 0.4 }), noise({ f: 1500, len: 0.04, vol: 0.05 })),
  /** Armies arrive at their own territory. */
  arrive: () => [0, 0.08].forEach((t, i) => tone({ f: [660, 880][i] ?? 660, len: 0.18, vol: 0.06, at: t, type: "triangle" })),
  /** Someone joins the lobby. */
  join: () => [0, 0.07, 0.14].forEach((t, i) => tone({ f: [523, 659, 988][i] ?? 523, len: 0.2, vol: 0.08, at: t, type: "triangle" })),
  /** Someone is ready. */
  ready: () => [0, 0.06].forEach((t, i) => tone({ f: [1319, 1976][i] ?? 1319, len: 0.25, vol: 0.06, at: t, type: "triangle" })),
  /** Everyone is ready. */
  allReady: () => [72, 76, 79, 84].forEach((n, i) => tone({ f: NOTE(n), len: 0.3, vol: 0.07, at: i * 0.07, type: "triangle" })),
  /** The clock's last seconds. */
  tick: () => (tone({ f: 1800, to: 1500, len: 0.05, vol: 0.06, type: "sine", room: 0.3 }), noise({ f: 2500, len: 0.03, vol: 0.05, q: 4 })),
  /** Stars for the conquerors. */
  stars: () => [84, 88, 91, 96].forEach((n, i) => tone({ f: NOTE(n), len: 0.35, vol: 0.05, at: i * 0.06, type: "triangle", room: 1.5 })),
  /** The winner. */
  victory: () => {
    const phrase = [[60, 0, 0.18], [60, 0.2, 0.1], [60, 0.32, 0.1], [64, 0.44, 0.4], [62, 0.86, 0.18], [64, 1.06, 0.18], [67, 1.26, 0.18], [72, 1.46, 1.2]];
    for (const [n, t, l] of phrase) {
      brass(NOTE(n ?? 60), t ?? 0, l ?? 0.2, 0.065);
      brass(NOTE((n ?? 60) - 12), t ?? 0, l ?? 0.2, 0.04);
    }
    [0, 0.44, 0.86, 1.46].forEach((t) => drum(t, 0.6, 0.7));
    noise({ f: 6000, len: 2.2, vol: 0.1, at: 1.46, type: "highpass", room: 1.8 });
  },
};
