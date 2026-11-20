// Jinx — the TV page as a Saturday-night show. A clickable mockup with fake
// data: no network, no build, no dependencies. Keys: ←/→ phase, Space next
// beat, A autoplay, S safe area, M sound. URL hash: #p=reveal&b=2&shot
// (jump to a phase, fast-forward beats, hide the controls).
"use strict";

const TV = document.getElementById("tv");
const SCENE = document.getElementById("scene");
const FX = document.getElementById("fx");
const WIPE = document.getElementById("wipe");
const FLASH = FX.querySelector(".flash");
const SAFE = document.getElementById("safe");
const CONTROLS = document.getElementById("controls");
const Q = new URLSearchParams(location.hash.slice(1));

// ---------------------------------------------------------------- timing
let SPEED = 1; // duration multiplier: tiny when fast-forwarding
let gen = 0; // bumps on every phase change; stale beats stop at their next wait
class Stale extends Error {}
const E = {
  out: "cubic-bezier(.2,.8,.2,1)",
  back: "cubic-bezier(.34,1.56,.64,1)",
  in: "cubic-bezier(.6,0,.9,.4)",
  snap: "cubic-bezier(.7,0,.2,1)",
  lin: "linear",
};
function wait(ms) {
  const g = gen;
  return new Promise((res, rej) => setTimeout(() => (g === gen ? res() : rej(new Stale())), ms * SPEED));
}
function anim(el, kf, o = {}) {
  return el.animate(kf, { easing: E.out, fill: "both", ...o, duration: (o.duration ?? 400) * SPEED, delay: (o.delay ?? 0) * SPEED });
}
async function play(a) {
  const g = gen;
  await a.finished.catch(() => {});
  if (g !== gen) throw new Stale();
}
let leaves = [];
const onLeave = (f) => leaves.push(f);
function every(ms, f) {
  const id = setInterval(f, ms);
  onLeave(() => clearInterval(id));
}
const rnd = (a, b) => a + Math.random() * (b - a);
const fmt = (n) => Math.round(n).toLocaleString("en-US");

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function add(parent, html) {
  const e = el(html);
  parent.append(e);
  return e;
}
function countTo(node, from, to, ms, f = fmt) {
  const g = gen;
  if (SPEED < 0.5) return void (node.textContent = f(to));
  const t0 = performance.now();
  const step = (now) => {
    if (g !== gen) return;
    const k = Math.min(1, (now - t0) / ms);
    node.textContent = f(from + (to - from) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------- sound (Web Audio, synthesized)
const AU = { ctx: null, out: null, noise: null, muted: Q.has("mute") };
function au() {
  if (AU.muted || SPEED < 0.5) return null;
  if (!AU.ctx) {
    try {
      const c = new AudioContext();
      const comp = c.createDynamicsCompressor();
      AU.out = c.createGain();
      AU.out.gain.value = 0.55;
      AU.out.connect(comp).connect(c.destination);
      const b = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      AU.noise = b;
      AU.ctx = c;
    } catch {
      return null;
    }
  }
  if (AU.ctx.state === "suspended") AU.ctx.resume();
  return AU.ctx;
}
function tone(f, dur, { type = "triangle", gain = 0.2, at = 0, to = null, attack = 0.005, filter = null } = {}) {
  const c = au();
  if (!c) return;
  const t = c.currentTime + at;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let n = o;
  if (filter) {
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = filter;
    o.connect(lp);
    n = lp;
  }
  n.connect(g).connect(AU.out);
  o.start(t);
  o.stop(t + dur + 0.05);
}
function noise(dur, { type = "bandpass", f = 1000, to = null, q = 1, gain = 0.3, at = 0, attack = 0.005 } = {}) {
  const c = au();
  if (!c) return;
  const t = c.currentTime + at;
  const s = c.createBufferSource();
  s.buffer = AU.noise;
  s.loop = true;
  const fl = c.createBiquadFilter();
  fl.type = type;
  fl.frequency.setValueAtTime(f, t);
  if (to) fl.frequency.exponentialRampToValueAtTime(to, t + dur);
  fl.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(fl).connect(g).connect(AU.out);
  s.start(t, Math.random() * 0.5);
  s.stop(t + dur + 0.05);
}
const sfx = {
  whoosh: () => noise(0.55, { f: 300, to: 3500, q: 1.2, gain: 0.35, attack: 0.22 }),
  swish: () => noise(0.25, { f: 900, to: 3000, gain: 0.18, attack: 0.08 }),
  slam: () => { tone(150, 0.4, { type: "sine", to: 38, gain: 0.95 }); noise(0.2, { type: "lowpass", f: 1400, gain: 0.55 }); },
  thud: (i = 0) => { tone(90 + i * 18, 0.2, { type: "sine", to: 45, gain: 0.6 }); noise(0.06, { type: "lowpass", f: 2500, gain: 0.2 }); },
  shatter: () => {
    for (let i = 0; i < 12; i++) noise(rnd(0.06, 0.18), { type: "highpass", f: rnd(2500, 7000), gain: 0.22, at: rnd(0, 0.35) });
    for (let i = 0; i < 7; i++) tone(rnd(2000, 5000), 0.09, { gain: 0.05, at: rnd(0, 0.45) });
  },
  flip: () => { noise(0.07, { f: 2200, q: 2, gain: 0.35 }); tone(500, 0.09, { to: 900, gain: 0.12 }); },
  tick: () => tone(1400, 0.03, { type: "square", gain: 0.05 }),
  drain: (i) => tone(1150 - i * 45, 0.05, { type: "square", gain: 0.07, filter: 3200 }),
  key: () => { noise(0.03, { f: 3800, q: 3, gain: 0.28 }); tone(190, 0.05, { type: "sine", gain: 0.28, to: 120 }); },
  backspace: () => tone(320, 0.07, { type: "square", gain: 0.06, to: 200 }),
  heartbeat: () => { tone(64, 0.16, { type: "sine", gain: 0.75, to: 44 }); tone(58, 0.14, { type: "sine", gain: 0.5, at: 0.22, to: 42 }); },
  drumroll: (sec) => {
    for (let t = 0; t < sec; t += 0.045) noise(0.05, { f: 900, q: 0.7, gain: 0.06 + 0.26 * (t / sec), at: t });
    noise(1.3, { type: "highpass", f: 4500, gain: 0.32, at: sec });
    tone(80, 0.45, { type: "sine", gain: 0.8, at: sec, to: 40 });
  },
  fanfare: () => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.24, { type: "sawtooth", gain: 0.11, filter: 2600, at: i * 0.1 }));
    [523, 659, 784, 1047].forEach((f) => tone(f, 1.4, { type: "sawtooth", gain: 0.06, filter: 3200, at: 0.45, attack: 0.03 }));
    sfx.sparkle(0.5);
  },
  buzzer: () => { tone(110, 0.75, { type: "sawtooth", gain: 0.22, filter: 900 }); tone(117, 0.75, { type: "sawtooth", gain: 0.22, filter: 900 }); },
  sparkle: (at = 0) => [2093, 2637, 3136, 4186, 3136, 4186, 5274].forEach((f, i) => tone(f, 0.18, { gain: 0.06, at: at + i * 0.05 })),
  ding: () => { tone(1320, 0.7, { type: "sine", gain: 0.22 }); tone(1980, 0.45, { type: "sine", gain: 0.08 }); },
  pop: () => tone(380, 0.14, { type: "sine", to: 950, gain: 0.3 }),
  stamp: () => { tone(70, 0.3, { type: "sine", gain: 0.9, to: 38 }); noise(0.06, { type: "lowpass", f: 3000, gain: 0.45 }); },
  block: (hi) => tone(hi ? 1040 : 780, 0.06, { type: "sine", gain: 0.32 }),
  bulb: (i) => tone(523 * Math.pow(2, i / 12), 0.18, { gain: 0.16 }),
  riser: (sec = 1.2) => tone(180, sec, { type: "sawtooth", to: 900, gain: 0.06, filter: 1600, attack: sec * 0.8 }),
  sting: () => { [392, 523, 659].forEach((f, i) => tone(f, 0.18, { type: "sawtooth", gain: 0.1, filter: 2400, at: i * 0.07 })); sfx.slam(); },
};

// ---------------------------------------------------------------- fake data
const PLAYERS = [
  { id: "anna", name: "Anna", color: "#ffc928", shape: "circle" },
  { id: "ben", name: "Ben", color: "#ff4f9a", shape: "square" },
  { id: "cleo", name: "Cleo", color: "#25e2ff", shape: "triangle" },
  { id: "dev", name: "Dev", color: "#b5f23d", shape: "star" },
  { id: "esme", name: "Esme", color: "#ff8a1f", shape: "hex" },
  { id: "farouk", name: "Farouk", color: "#a77bff", shape: "diamond" },
  { id: "gus", name: "Gus", color: "#ff5a5a", shape: "drop" },
  { id: "hana", name: "Hana", color: "#f4efe0", shape: "pill" },
];
const P = Object.fromEntries(PLAYERS.map((p) => [p.id, p]));
const WORD = "LIGHTHOUSE";
const GUESSER = "anna";
// The lineup order on the TV (shuffled so jinx partners are far apart).
const CLUES = [
  { by: "ben", word: "beacon", bold: true },
  { by: "dev", word: "lamp" },
  { by: "cleo", word: "foghorn" },
  { by: "gus", word: "lights" },
  { by: "farouk", word: "keeper" },
  { by: "esme", word: "lamps" },
  { by: "hana", word: "shipwrecks" },
];
const SURVIVORS = ["ben", "cleo", "farouk", "hana"];
const POT_START = 1000;
const SEG = 50; // points per pot segment (20 segments)

// ---------------------------------------------------------------- avatars: shape characters with eyes
function starPts(cx, cy, ro, ri, n = 5) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 ? ri : ro;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}
function hexPts(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}
const SHAPES = {
  circle: { d: '<circle cx="50" cy="52" r="43"/>', ey: 48, ex: 15, r: 10 },
  square: { d: '<rect x="8" y="10" width="84" height="84" rx="20"/>', ey: 48, ex: 15, r: 10 },
  triangle: { d: '<path d="M50 5 L96 91 L4 91 Z"/>', ey: 64, ex: 11, r: 8.5 },
  star: { d: `<polygon points="${starPts(50, 56, 52, 26)}"/>`, ey: 54, ex: 9, r: 8 },
  hex: { d: `<polygon points="${hexPts(50, 52, 47)}"/>`, ey: 48, ex: 15, r: 10 },
  diamond: { d: '<path d="M50 3 L97 52 L50 99 L3 52 Z"/>', ey: 50, ex: 13, r: 9 },
  drop: { d: '<path d="M50 3 C58 18 88 42 88 63 A38 36 0 0 1 12 63 C12 42 42 18 50 3 Z"/>', ey: 62, ex: 13, r: 9 },
  pill: { d: '<rect x="17" y="3" width="66" height="95" rx="33"/>', ey: 42, ex: 13, r: 9.5 },
};
function avatarSVG(p, mood = "normal") {
  const s = SHAPES[p.shape];
  const { ey, ex, r } = s;
  const x1 = 50 - ex, x2 = 50 + ex;
  const D = "#0b0620";
  let face = "";
  if (mood === "blind") {
    face = `<g transform="rotate(-6 50 ${ey})"><rect x="-2" y="${ey - 12}" width="104" height="22" rx="5" fill="${D}"/>
      <path d="M100 ${ey} l12 14 M100 ${ey} l14 4" stroke="${D}" stroke-width="7" stroke-linecap="round"/></g>
      <path d="M${50 - 7} ${ey + 20} q7 -4 14 0" stroke="${D}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
  } else if (mood === "happy") {
    face = `<path d="M${x1 - r} ${ey + 3} q${r} -${r * 1.6} ${2 * r} 0 M${x2 - r} ${ey + 3} q${r} -${r * 1.6} ${2 * r} 0" stroke="${D}" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M${50 - 11} ${ey + 13} h22 a11 11 0 0 1 -22 0 Z" fill="${D}"/>`;
  } else if (mood === "shock") {
    face = `<circle cx="${x1}" cy="${ey}" r="${r + 2}" fill="#fff" stroke="${D}" stroke-width="3.5"/><circle cx="${x2}" cy="${ey}" r="${r + 2}" fill="#fff" stroke="${D}" stroke-width="3.5"/>
      <circle cx="${x1}" cy="${ey}" r="3" fill="${D}"/><circle cx="${x2}" cy="${ey}" r="3" fill="${D}"/>
      <ellipse cx="50" cy="${ey + 20}" rx="6" ry="8" fill="${D}"/>`;
  } else if (mood === "sad") {
    face = `<circle cx="${x1}" cy="${ey}" r="${r}" fill="#fff" stroke="${D}" stroke-width="3.5"/><circle cx="${x2}" cy="${ey}" r="${r}" fill="#fff" stroke="${D}" stroke-width="3.5"/>
      <circle cx="${x1}" cy="${ey + 3}" r="${r * 0.45}" fill="${D}"/><circle cx="${x2}" cy="${ey + 3}" r="${r * 0.45}" fill="${D}"/>
      <path d="M${x1 - r - 2} ${ey - r + 2} L${x1 + r} ${ey - r - 3} M${x2 + r + 2} ${ey - r + 2} L${x2 - r} ${ey - r - 3}" stroke="${D}" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M${50 - 9} ${ey + 22} q9 -8 18 0" stroke="${D}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`;
  } else {
    face = `<circle cx="${x1}" cy="${ey}" r="${r}" fill="#fff" stroke="${D}" stroke-width="3.5"/><circle cx="${x2}" cy="${ey}" r="${r}" fill="#fff" stroke="${D}" stroke-width="3.5"/>
      <g class="pupils"><circle cx="${x1}" cy="${ey}" r="${r * 0.48}" fill="${D}"/><circle cx="${x2}" cy="${ey}" r="${r * 0.48}" fill="${D}"/></g>
      <g class="lids"><rect x="${x1 - r - 2}" y="${ey - r - 2}" width="${2 * ex + 2 * r + 4}" height="${2 * r + 4}" rx="${r}" fill="${p.color}"/></g>
      <path d="M${50 - 8} ${ey + 17} q8 6 16 0" stroke="${D}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`;
  }
  return `<svg viewBox="0 0 100 100"><g fill="${p.color}" stroke="${D}" stroke-width="5" stroke-linejoin="round">${s.d}</g>${face}</svg>`;
}
const av = (id, mood = "normal", cls = "") => `<span class="av ${cls}" data-p="${id}">${avatarSVG(P[id], mood)}</span>`;
function mood(node, m) {
  const a = node.classList?.contains("av") ? node : node.querySelector(".av");
  a.innerHTML = avatarSVG(P[a.dataset.p], m);
}
function look(node, dx, dy) {
  node.querySelectorAll(".pupils").forEach((p) => (p.style.transform = `translate(${dx * 4}px, ${dy * 3}px)`));
}
setInterval(() => {
  const all = TV.querySelectorAll(".av");
  if (!all.length) return;
  const a = all[Math.floor(Math.random() * all.length)];
  a.classList.remove("blink");
  void a.offsetWidth;
  a.classList.add("blink");
}, 700);

const FLAME = `<svg class="flame" viewBox="0 0 64 64"><path d="M32 2 C36 16 52 22 52 40 A20 20 0 0 1 12 40 C12 30 18 26 20 18 C24 24 26 26 28 26 C28 16 30 8 32 2 Z" fill="#ff7a1a" stroke="#0b0620" stroke-width="4" stroke-linejoin="round"/><path d="M32 30 C34 36 42 38 42 46 A10 10 0 0 1 22 46 C22 40 28 38 32 30 Z" fill="#ffc928"/></svg>`;
const CROWN = `<svg viewBox="0 0 132 72"><path d="M10 64 L4 14 L36 36 L66 4 L96 36 L128 14 L122 64 Z" fill="#ffc928" stroke="#0b0620" stroke-width="6" stroke-linejoin="round"/><circle cx="66" cy="44" r="8" fill="#ff2f7d" stroke="#0b0620" stroke-width="4"/></svg>`;
const TICK = `<svg viewBox="0 0 26 26"><path d="M5 14 l5 5 l11 -12" stroke="#0b0620" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// A fake QR code (finder patterns + deterministic noise): the real one comes from qrSvg().
function fakeQR() {
  const n = 29;
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const on = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) on.push(r() < 0.48);
  const finder = (fx, fy) => {
    for (let y = -1; y < 8; y++) for (let x = -1; x < 8; x++) {
      const X = fx + x, Y = fy + y;
      if (X < 0 || Y < 0 || X >= n || Y >= n) continue;
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      on[Y * n + X] = x >= 0 && y >= 0 && x < 7 && y < 7 && ring !== 2;
    }
  };
  finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (on[y * n + x]) d += `M${x + 2} ${y + 2}h1v1h-1z`;
  return `<svg class="qr" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#0b0620"/></svg>`;
}

// ---------------------------------------------------------------- studio
(function buildBurst() {
  const g = TV.querySelector(".burst .rays");
  const n = 16;
  let d = "";
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = a0 + Math.PI / n;
    d += `<path d="M0 0 L${150 * Math.cos(a0)} ${150 * Math.sin(a0)} L${150 * Math.cos(a1)} ${150 * Math.sin(a1)} Z"/>`;
  }
  g.innerHTML = d;
})();
const CONES = [...TV.querySelectorAll(".cone")];
function aim(i, x, y) {
  const c = CONES[i];
  const cx = parseFloat(getComputedStyle(c).left), cy = -40;
  const deg = (-Math.atan2(x - cx, y - cy) * 180) / Math.PI;
  c.classList.add("aimed");
  c.style.transform = `rotate(${deg}deg)`;
}
function aimAll(x, y) { CONES.forEach((_, i) => aim(i, x, y)); }
function freeCones() { CONES.forEach((c) => { c.classList.remove("aimed"); c.style.transform = ""; }); }
function mode(m) { TV.classList.remove("hero", "win", "bad"); if (m) TV.classList.add(m); }

// ---------------------------------------------------------------- motion kit
function slamHTML(text, cls = "", style = "") {
  // *gold*, _hot_, ~cyan~ segments
  let out = "", color = "";
  for (const ch of text) {
    if (ch === "*") { color = color === "gold" ? "" : "gold"; continue; }
    if (ch === "_") { color = color === "hot" ? "" : "hot"; continue; }
    if (ch === "~") { color = color === "cyan" ? "" : "cyan"; continue; }
    out += ch === " " ? '<span class="sp"></span>' : `<span class="ch ${color}">${ch}</span>`;
  }
  return `<div class="slam ${cls}" style="${style}">${out}</div>`;
}
async function slamIn(node, { stagger = 30, dur = 380, sound = true, from = "drop" } = {}) {
  const chs = [...node.querySelectorAll(".ch")];
  const kf = from === "zoom"
    ? [{ transform: "scale(3)", opacity: 0 }, { transform: "none", opacity: 1 }]
    : [{ transform: "translateY(-70px) scale(1.7)", opacity: 0 }, { transform: "none", opacity: 1 }];
  let last;
  chs.forEach((c, i) => (last = anim(c, kf, { duration: dur, delay: i * stagger, easing: E.back })));
  if (sound) sfx.thud(0);
  if (last) await play(last);
}
function popIn(node, o = {}) {
  return anim(node, [{ transform: `${o.base ?? ""} scale(.2)`, opacity: 0 }, { transform: `${o.base ?? ""} scale(1)`, opacity: 1 }], { duration: 420, easing: E.back, ...o });
}
function fadeOut(node, o = {}) { return anim(node, [{ opacity: 1 }, { opacity: 0 }], { duration: 250, ...o }); }
async function flash(strength = 0.7, dur = 260) { await play(anim(FLASH, [{ opacity: strength }, { opacity: 0 }], { duration: dur, easing: E.lin, fill: "none" })); }
function shake(node = SCENE, px = 14, dur = 340) {
  const kf = [];
  for (let i = 0; i < 8; i++) kf.push({ transform: `translate(${rnd(-px, px)}px, ${rnd(-px, px)}px)` });
  kf.push({ transform: "none" });
  return anim(node, kf, { duration: dur, easing: E.lin, fill: "none" });
}
function shards(x, y, colors, n = 16) {
  for (let i = 0; i < n; i++) {
    const s = add(FX, `<div class="shard"></div>`);
    const w = rnd(36, 90), h = rnd(36, 90);
    s.style.width = w + "px";
    s.style.height = h + "px";
    s.style.background = colors[i % colors.length];
    s.style.clipPath = `polygon(${rnd(0, 40)}% ${rnd(0, 30)}%, 100% ${rnd(20, 60)}%, ${rnd(10, 60)}% 100%)`;
    const a = rnd(0, Math.PI * 2), dist = rnd(260, 620);
    const tx = x + Math.cos(a) * dist, ty = y + Math.sin(a) * dist * 0.75 + 120;
    anim(s, [
      { transform: `translate(${x - w / 2}px, ${y - h / 2}px) rotate(0deg)`, opacity: 1 },
      { transform: `translate(${tx}px, ${ty}px) rotate(${rnd(-540, 540)}deg)`, opacity: 0 },
    ], { duration: rnd(650, 1000), easing: "cubic-bezier(.1,.7,.3,1)" }).finished.then(() => s.remove());
  }
  const ring = add(FX, `<div class="shock" style="left:${x}px;top:${y}px"></div>`);
  anim(ring, [{ transform: "scale(.2)", opacity: 1 }, { transform: "scale(4)", opacity: 0 }], { duration: 520 }).finished.then(() => ring.remove());
}
function confetti(n = 44) {
  const colors = ["#ffc928", "#ff2f7d", "#25e2ff", "#b5f23d", "#fff7e6", "#a77bff"];
  for (let i = 0; i < n; i++) {
    const left = i % 2 === 0;
    const sx = left ? 60 : 1220, sy = 740;
    const s = add(FX, `<div class="confetti"></div>`);
    const w = rnd(18, 34), h = rnd(12, 30);
    s.style.width = w + "px";
    s.style.height = h + "px";
    s.style.background = colors[i % colors.length];
    s.style.borderRadius = i % 3 === 0 ? "50%" : "4px";
    if (i % 5 === 0) s.style.clipPath = "polygon(50% 0, 100% 100%, 0 100%)";
    const px = left ? rnd(150, 760) : rnd(520, 1130), py = rnd(40, 330);
    const ex = px + (left ? rnd(60, 260) : -rnd(60, 260)), ey = 780;
    const r = rnd(-720, 720);
    anim(s, [
      { transform: `translate(${sx}px, ${sy}px) rotate(0deg)`, easing: "cubic-bezier(.1,.6,.3,1)" },
      { transform: `translate(${px}px, ${py}px) rotate(${r / 2}deg)`, easing: "cubic-bezier(.5,0,.9,.6)", offset: 0.4 },
      { transform: `translate(${ex}px, ${ey}px) rotate(${r}deg)` },
    ], { duration: rnd(2000, 2900), delay: rnd(0, 350), easing: E.lin }).finished.then(() => s.remove());
  }
}
function flyChip(text, x, y, cls = "red", dy = -90) {
  const c = add(FX, `<div class="chip-fly ${cls}" style="left:${x}px;top:${y}px">${text}</div>`);
  anim(c, [
    { transform: "translate(-50%, 0) scale(.6)", opacity: 0 },
    { transform: "translate(-50%, -20px) scale(1.15)", opacity: 1, offset: 0.25 },
    { transform: `translate(-50%, ${dy}px) scale(1)`, opacity: 0 },
  ], { duration: 1300, easing: E.out }).finished.then(() => c.remove());
}

// ---------------------------------------------------------------- transitions
const SLABS = [...WIPE.querySelectorAll(".slab")];
const STINGER = WIPE.querySelector(".stinger");
async function wipe(swap, stinger = "") {
  const g = gen;
  STINGER.innerHTML = stinger ? `<span>${stinger}</span>` : "";
  sfx.whoosh();
  SLABS.forEach((s, i) => anim(s, [{ transform: "translateX(-1900px) skewX(-14deg)" }, { transform: "translateX(-210px) skewX(-14deg)" }], { duration: 360, delay: i * 70, easing: E.snap }));
  await wait(360 + 3 * 70);
  if (g !== gen) throw new Stale();
  swap();
  if (stinger) {
    sfx.sting();
    await play(anim(STINGER.firstChild, [{ transform: "skewX(-8deg) scale(2.2)", opacity: 0 }, { transform: "skewX(-8deg) scale(1)", opacity: 1 }], { duration: 300, easing: E.back }));
    await wait(520);
  }
  SLABS.forEach((s, i) => anim(s, [{ transform: "translateX(-210px) skewX(-14deg)" }, { transform: "translateX(1900px) skewX(-14deg)" }], { duration: 420, delay: (3 - i) * 60, easing: E.snap }));
  await wait(420 + 3 * 60);
}

// ---------------------------------------------------------------- shared parts
function header(round = 3, extra = "", room = true) {
  const bulbs = [1, 1, 2, 0, 0, 0, 0, 0].map((b, i) => `<i class="bulb ${i === 2 ? "now" : b ? "on" : ""}"></i>`).join("");
  return `<div class="hdr"><div class="logo-chip"><span>JINX!</span></div><div class="round">ROUND ${round} OF 8</div>${extra}<div class="grow"></div>
    ${room ? `<span class="room-label">ROOM</span><div class="bulbs">${bulbs}</div>` : ""}</div>`;
}
function cardHTML(c, { w, h, x, y, face = "back", num = 0, cls = "", tagline = "" }) {
  const size = Math.min(48, Math.floor((w - 40) / (Math.max(c.word.length, 4) * 0.66)));
  return `<div class="card ${c.bold ? "bold" : ""} ${cls}" data-by="${c.by}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px">
    <div class="inner" style="transform:rotateY(${face === "front" ? 180 : 0}deg)">
      <div class="face back"><div class="mark">J<span class="x">!</span></div></div>
      <div class="face front">${tagline ? `<div class="tagline">${tagline}</div>` : ""}<div class="word" style="font-size:${Math.max(26, size)}px">${c.word}</div></div>
    </div>
    ${c.bold ? FLAME : ""}${num ? `<div class="num">${num}</div>` : ""}
    <div class="who">${av(c.by)}<span>${P[c.by].name}</span></div>
  </div>`;
}
function potHTML(x, y, value, scale = 1) {
  let segs = "";
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * 360;
    segs += `<i class="seg ${i * SEG >= value ? "off" : ""}" style="transform:rotate(${a}deg) translateY(-118px)"></i>`;
  }
  const small = scale < 1;
  return `${small ? `<div class="label abs" style="left:${x}px;top:${y - 36}px;width:${300 * scale}px;text-align:center">THE POT</div>` : ""}<div class="pot" style="left:${x}px;top:${y}px;transform:scale(${scale});transform-origin:0 0"><div class="mid"><div class="num">${fmt(value)}</div>${small ? "" : '<div class="pl">THE POT</div>'}</div>${segs}</div>`;
}
async function drain(pot, from, to, label = true) {
  const segs = [...pot.querySelectorAll(".seg")];
  const num = pot.querySelector(".num");
  countTo(num, from, to, 120 * ((from - to) / SEG));
  if (label) {
    const t = TV.getBoundingClientRect(), k = t.width / 1280, r = pot.getBoundingClientRect();
    flyChip(`−${fmt(from - to)}`, (r.left - t.left + r.width / 2) / k, (r.top - t.top) / k - 10);
  }
  let k = 0;
  for (let i = Math.ceil(from / SEG) - 1; i >= Math.ceil(to / SEG); i--) {
    const seg = segs[i];
    sfx.drain(k++);
    const base = seg.style.transform;
    anim(seg, [{ transform: `${base} scale(1.4)`, background: "#fff7e6" }, { transform: `${base} scale(1)` }], { duration: 220, fill: "none" });
    seg.classList.add("off");
    await wait(120);
  }
}
function tilesHTML(text, cls = "", n = text.length) {
  let out = "";
  for (let i = 0; i < n; i++) out += `<div class="tile ${cls}">${text[i] ?? ""}</div>`;
  return out;
}

// ---------------------------------------------------------------- phases
const PHASES = [];
const phase = (p) => PHASES.push(p);

// 1 ------------------------------------------------------------ cold open
phase({
  id: "open", name: "Cold open", noWipe: true,
  phone: "Phones: the logo and \"Scan the TV to join\".",
  enter(s) {
    s.innerHTML = `<div class="ident">
      <div class="marquee" style="left:250px;top:140px;width:780px;height:360px"></div>
      <div class="abs center" style="left:0;right:0;top:170px;height:300px">${slamHTML("JINX!", "logo")}</div>
      <div class="abs center" style="left:0;right:0;top:540px"><div class="plate hot sub" style="font-size:40px;opacity:0"><span>Great minds collide</span></div></div>
    </div>`;
    const m = s.querySelector(".marquee");
    const bulbs = [];
    const W = 780, H = 360, per = 2 * (W + H), n = 40;
    for (let i = 0; i < n; i++) {
      let d = (i / n) * per, x, y;
      if (d < W) (x = d), (y = 0);
      else if ((d -= W) < H) (x = W), (y = d);
      else if ((d -= H) < W) (x = W - d), (y = H);
      else (x = 0), (y = H - (d - W));
      bulbs.push(add(m, `<i style="left:${x - 8}px;top:${y - 8}px"></i>`));
    }
    let k = 0;
    every(130, () => { k++; bulbs.forEach((b, i) => b.classList.toggle("lit", (i + k) % 3 === 0)); });
  },
  async intro(s) {
    mode("hero");
    const logo = s.querySelector(".logo");
    logo.querySelectorAll(".ch").forEach((c) => (c.style.opacity = 0));
    anim(s.querySelector(".marquee"), [{ transform: "scale(.6)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 500, easing: E.back });
    aimAll(640, 320);
    await wait(250);
    const chs = [...logo.querySelectorAll(".ch")];
    for (let i = 0; i < chs.length; i++) {
      anim(chs[i], [{ transform: "translateY(-260px) scale(2.4) rotate(-12deg)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 300, easing: E.back });
      await wait(260);
      sfx.thud(i);
      if (i === chs.length - 1) { sfx.slam(); shake(s, 10); flash(0.35); }
      await wait(i === chs.length - 2 ? 260 : 120);
    }
    await wait(200);
    sfx.sparkle();
    await play(popIn(s.querySelector(".sub")));
    freeCones();
    mode(null);
  },
  beats: [{ label: "Replay the ident", async run(s) { PHASES[cur].enter(s); await PHASES[cur].intro(s); } }],
});

// 2 ------------------------------------------------------------ lobby
phase({
  id: "lobby", name: "Lobby", stinger: "",
  phone: "Phone: name + pick your character (shape + colour, or doodle a face); the VIP gets START once 3 are in.",
  enter(s) {
    st.joined = 3;
    s.innerHTML = `<div class="lobby-left">
        <div class="lobby-logo">JINX<span class="x">!</span></div>
        <div class="ticket"><div class="code" style="margin:0 0 10px">SCAN TO PLAY</div>${fakeQR()}<div class="code">ROOM <b>WXYZ</b></div></div>
      </div>
      <div class="lobby-right">
        <div class="tonight">TONIGHT'S CONTESTANTS</div>
        <div class="podiums">${PLAYERS.map((p, i) => `<div class="podium ${i < 3 ? "on" : ""}" data-i="${i}">
            ${i < 3 ? av(p.id) : `<div class="seat">SEAT<br>OPEN</div>`}
            <div class="stand"></div><div class="nm">${i < 3 ? p.name : ""}</div>
            ${i === 0 ? `<div class="vip plate gold" style="font-size:22px;padding:6px 12px"><span>VIP</span></div>` : ""}
          </div>`).join("")}</div>
        <div class="lobby-foot"><div class="plate dark host"><span>Phones out. Scan in. No word is safe.</span></div></div>
      </div>`;
  },
  async intro(s) {
    const pods = [...s.querySelectorAll(".podium")];
    pods.forEach((p, i) => popIn(p, { delay: i * 60, duration: 380 }));
    await wait(600);
  },
  beats: [
    ...[3, 4, 5, 6, 7].map((i) => ({
      label: `${PLAYERS[i].name} joins`,
      async run(s) {
        const pod = s.querySelector(`.podium[data-i="${i}"]`);
        pod.querySelector(".seat")?.remove();
        const a = el(av(PLAYERS[i].id));
        pod.prepend(a);
        pod.classList.add("on");
        sfx.swish();
        await play(anim(a, [{ transform: "translateY(-520px) rotate(-20deg)" }, { transform: "translateY(12px) scaleY(.8) scaleX(1.15)", offset: 0.75 }, { transform: "none" }], { duration: 620, easing: E.in }));
        sfx.pop();
        sfx.ding();
        anim(pod.querySelector(".stand"), [{ transform: "scaleX(1.12)" }, { transform: "none" }], { duration: 300 });
        const nm = pod.querySelector(".nm");
        nm.textContent = PLAYERS[i].name;
        popIn(nm);
        s.querySelectorAll(".podium .av").forEach((x) => { const r = x.getBoundingClientRect(), q = a.getBoundingClientRect(); look(x, Math.sign(q.left - r.left), Math.sign(q.top - r.top)); });
        look(a, 0, 1);
        const host = s.querySelector(".host span");
        host.textContent = [`Welcome, ${PLAYERS[i].name}. Mind your words.`, `${PLAYERS[i].name} is in. The plot thickens.`, `Here comes ${PLAYERS[i].name}!`, `${PLAYERS[i].name} has entered the studio.`, `${PLAYERS[i].name}: full house!`][i - 3];
      },
    })),
    {
      label: "VIP presses START",
      async run(s) {
        const avs = [...s.querySelectorAll(".podium .av")];
        avs.forEach((a) => look(a, 0, 0));
        sfx.riser(0.9);
        avs.forEach((a, i) => anim(a, [{ transform: "none" }, { transform: "translateY(-40px)" }, { transform: "none" }], { duration: 380, delay: i * 70, easing: E.out, fill: "none" }));
        await wait(900);
        mode("hero");
        const go = add(s, `<div class="abs center" style="left:0;right:0;top:250px">${slamHTML("LET'S *PLAY!*", "", "font-size:150px")}</div>`);
        sfx.sting();
        await slamIn(go, { stagger: 40, from: "zoom" });
        shake(s, 8);
      },
    },
  ],
});

// 3 ------------------------------------------------------------ the hot seat (round intro)
phase({
  id: "hotseat", name: "Hot seat", stinger: "Round 3",
  phone: "Guesser: \"You're in the hot seat. Eyes on the TV, not on their phones.\" Clue-givers: \"Anna guesses. Get ready.\"",
  enter(s) {
    s.innerHTML = header() + `<div class="hotseat-ring" style="opacity:0"></div>
      <div class="abs" style="left:530px;top:220px;width:220px;height:220px">${av(GUESSER, "normal")}</div>
      <div class="abs center" style="left:0;right:0;top:470px">${slamHTML("*ANNA* IS IN THE HOT SEAT", "", "font-size:72px")}</div>
      <div class="abs center" style="left:0;right:0;top:580px"><div class="plate dark sub" style="opacity:0"><span>Everyone else: one word. Make it count.</span></div></div>`;
    s.querySelector(".abs .av").style.cssText = "width:220px;height:220px;opacity:0";
  },
  async intro(s) {
    mode("hero");
    aimAll(640, 330);
    sfx.riser(0.8);
    await wait(500);
    const a = s.querySelector(".abs .av");
    anim(s.querySelector(".hotseat-ring"), [{ transform: "scale(.3)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 450, easing: E.back });
    await play(anim(a, [{ transform: "translateY(-600px)", opacity: 1 }, { transform: "translateY(10px) scaleY(.85) scaleX(1.12)", opacity: 1, offset: 0.8 }, { transform: "none", opacity: 1 }], { duration: 560, easing: E.in }));
    sfx.slam();
    shake(s, 8);
    await slamIn(s.querySelector(".slam"), { stagger: 26 });
    await wait(300);
    // The blindfold drops on.
    sfx.swish();
    mood(a, "blind");
    anim(a, [{ transform: "translateY(0)" }, { transform: "translateY(8px) scaleY(.94)" }, { transform: "none" }], { duration: 280, fill: "none" });
    sfx.stamp();
    await play(popIn(s.querySelector(".sub")));
    await wait(500);
    freeCones();
    mode(null);
  },
  beats: [{ label: "Replay the intro", async run(s) { PHASES[cur].enter(s); await PHASES[cur].intro(s); } }],
});

// 4 ------------------------------------------------------------ writing
phase({
  id: "writing", name: "Writing", stinger: "",
  phone: "Clue-givers: the word LIGHTHOUSE, one text field, a 🔥 BOLD toggle, SUBMIT. Guesser: \"Blindfold on\" + who's done.",
  enter(s) {
    st.time = 40;
    st.done = new Set();
    const givers = CLUES.map((c) => c.by);
    s.innerHTML = header() + `
      <div class="hot-seat">${av(GUESSER, "blind")}<div class="plate hot sign"><span>HOT SEAT</span></div><div class="sub">Anna can't see the word.<br>You can.</div></div>
      <div class="vault"><div class="lid"><div class="q">?</div><div class="lbl">THE SECRET WORD</div><div class="label count" style="color:var(--gold)">0 OF 7 CLUES IN</div></div></div>
      <div class="timer"><div class="box">0:40</div><div class="bar"><i></i></div><div class="label lbl">WRITING TIME</div></div>
      <div class="abs center" style="left:0;right:0;top:410px"><div class="say host">One word each. <b>Don't think alike.</b></div></div>
      <div class="givers">${givers.map((id) => `<div class="giver" data-p="${id}"><div class="state dots"><i></i><i></i><i></i></div>${av(id)}<div class="nm">${P[id].name}</div></div>`).join("")}</div>`;
    const box = s.querySelector(".timer .box"), bar = s.querySelector(".timer .bar i");
    every(1000, () => {
      if (st.time <= 0) return;
      st.time--;
      box.textContent = `0:${String(st.time).padStart(2, "0")}`;
      bar.style.transform = `scaleX(${st.time / 40})`;
      bar.style.transition = "transform 1s linear";
      if (st.time <= 5) {
        s.querySelector(".timer").classList.add("low");
        sfx.block(st.time % 2);
        anim(box, [{ transform: "scale(1.12)" }, { transform: "none" }], { duration: 300, fill: "none" });
      }
    });
  },
  beats: [
    { label: "Clues come in", async run(s) { for (const id of ["ben", "farouk", "dev", "cleo"]) { await submit(s, id); await wait(rnd(350, 750)); } } },
    { label: "Last 5 seconds", async run(s) {
      st.time = 6;
      s.querySelector(".host").innerHTML = "<b>Five seconds.</b> Commit to something!";
      await wait(2600);
      for (const id of ["gus", "esme", "hana"]) { await submit(s, id); await wait(250); }
      st.time = 0;
      await wait(300);
      const t = add(s, `<div class="abs center" style="left:0;right:0;top:400px;height:100px"><div class="plate gold" style="font-size:56px;padding:14px 34px"><span>CLUES LOCKED!</span></div></div>`);
      s.querySelector(".host").remove();
      sfx.stamp();
      await play(anim(t.firstChild, [{ transform: "skewX(-8deg) scale(2.5)", opacity: 0 }, { transform: "skewX(-8deg) scale(1)", opacity: 1 }], { duration: 260, easing: E.back }));
      shake(s, 6);
    } },
  ],
});
async function submit(s, id) {
  if (st.done.has(id)) return;
  st.done.add(id);
  const g = s.querySelector(`.giver[data-p="${id}"]`);
  const clue = CLUES.find((c) => c.by === id);
  const state = g.querySelector(".state");
  state.className = "state";
  state.innerHTML = `<div class="tick">${TICK}</div>`;
  popIn(state.firstChild);
  // A face-down card flies from the giver into the vault.
  const gr = g.getBoundingClientRect(), tr = TV.getBoundingClientRect(), k = tr.width / 1280;
  const x0 = (gr.left - tr.left) / k + 73, y0 = (gr.top - tr.top) / k + 90;
  const card = add(FX, `<div class="card ${clue.bold ? "bold" : ""}" style="left:0;top:0;width:90px;height:120px"><div class="inner"><div class="face back"><div class="mark" style="font-size:40px">J<span class="x">!</span></div></div></div>${clue.bold ? FLAME : ""}</div>`);
  sfx.swish();
  await play(anim(card, [
    { transform: `translate(${x0 - 45}px, ${y0 - 60}px) rotate(0deg) scale(1)` },
    { transform: `translate(${(x0 + 640) / 2 - 45}px, ${y0 - 260}px) rotate(${rnd(-25, 25)}deg) scale(1.1)`, offset: 0.5 },
    { transform: `translate(${640 - 45}px, ${260 - 60}px) rotate(${rnd(-10, 10)}deg) scale(.5)`, opacity: 0.2 },
  ], { duration: 520, easing: E.lin }));
  card.remove();
  sfx.pop();
  if (clue.bold) {
    const b = add(s, `<div class="abs" style="left:640px;top:120px"><div class="plate" style="background:var(--flame);font-size:30px"><span>🔥 SOMEONE WENT BOLD</span></div></div>`);
    anim(b, [{ transform: "translate(-50%, 20px) scale(.4)", opacity: 0 }, { transform: "translate(-50%, 0) scale(1)", opacity: 1, offset: 0.2 }, { transform: "translate(-50%, 0) scale(1)", opacity: 1, offset: 0.85 }, { transform: "translate(-50%, -20px)", opacity: 0 }], { duration: 2000, easing: E.out }).finished.then(() => b.remove());
  }
  const lid = s.querySelector(".vault .lid");
  anim(lid, [{ transform: "scale(1.06) rotate(-1.5deg)" }, { transform: "none" }], { duration: 300, easing: E.back, fill: "none" });
  s.querySelector(".vault .count").textContent = `${st.done.size} OF 7 CLUES IN`;
}

// 5 ------------------------------------------------------------ jinx
const LINE = { w: 136, h: 184, y: 196, gap: 20 };
const lineX = (i, n = 7) => 640 - (n * LINE.w + (n - 1) * LINE.gap) / 2 + i * (LINE.w + LINE.gap);
phase({
  id: "jinx", name: "Jinx check", stinger: "Jinx check",
  phone: "Everyone: \"Checking for jinxes…\" then \"3 clues lost\". Jinxed givers: \"JINX! You and Esme: same word (plural).\" Guesser sees only the counts.",
  enter(s) {
    s.innerHTML = header() + `
      <div class="abs center" style="left:0;right:0;top:112px;height:50px"><div class="say host">Same clue? <b>Both cards go up in smoke.</b></div></div>
      ${CLUES.map((c, i) => cardHTML(c, { w: LINE.w, h: LINE.h, x: lineX(i), y: LINE.y })).join("")}
      <div class="scanner"></div>
      ${potHTML(1006, 470, POT_START, 0.7)}
      <div class="lost-count abs" style="top:440px;left:64px"><div class="label" style="color:var(--hot)">LOST</div><div class="lost" style="font:700 120px/1 var(--sans);color:var(--hot);text-shadow:0 8px 0 var(--dark)">0</div></div>`;
    st.pot = POT_START;
    st.lost = 0;
  },
  async intro(s) {
    const cards = [...s.querySelectorAll(".card")];
    cards.forEach((c, i) => anim(c, [{ transform: "translateY(-500px) rotate(-30deg)" }, { transform: "none" }], { duration: 480, delay: i * 70, easing: E.back }));
    for (let i = 0; i < cards.length; i++) { await wait(70); sfx.flip(); }
    await wait(400);
  },
  beats: [
    { label: "Scan for matches", async run(s) {
      const sc = s.querySelector(".scanner");
      sfx.riser(1.3);
      const a = anim(sc, [{ transform: `translateX(${lineX(0) - 30}px)`, opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.9 }, { transform: `translateX(${lineX(6) + LINE.w + 30}px)`, opacity: 0 }], { duration: 1400, easing: E.lin });
      const cards = [...s.querySelectorAll(".card")];
      for (let i = 0; i < cards.length; i++) {
        await wait(170);
        sfx.tick();
        anim(cards[i], [{ transform: "translateY(-14px)" }, { transform: "none" }], { duration: 260, fill: "none" });
      }
      await play(a);
    } },
    { label: "JINX! (Dev + Esme)", async run(s) { await jinxPair(s, "dev", "esme", "SAME WORD · PLURAL"); } },
    { label: "Strike: too close (Gus)", async run(s) {
      const c = s.querySelector('.card[data-by="gus"]');
      const x = parseFloat(c.style.left), y = parseFloat(c.style.top);
      const sl = add(s, `<div class="slash" style="left:${x - 20}px;top:${y + 80}px;width:${LINE.w + 40}px;transform:rotate(-28deg) scaleX(0)"></div>`);
      sfx.swish();
      await play(anim(sl, [{ transform: "translate(0, 40px) rotate(-28deg) scaleX(0)" }, { transform: "translate(0, 40px) rotate(-28deg) scaleX(1)" }], { duration: 200, easing: E.snap }));
      sfx.stamp();
      const tag = add(s, `<div class="abs" style="left:${x + LINE.w / 2}px;top:${y + LINE.h + 40}px"><div class="plate red" style="font-size:26px"><span>TOO CLOSE TO THE WORD</span></div></div>`);
      await play(popIn(tag, { base: "translateX(-50%)" }));
      await wait(700);
      anim(c, [{ transform: "none", opacity: 1 }, { transform: "translateY(520px) rotate(40deg)", opacity: 0 }], { duration: 700, easing: E.in });
      anim(sl, [{ opacity: 1 }, { opacity: 0 }], { duration: 300, delay: 100 });
      fadeOut(tag, { delay: 900 });
      await lose(s, 1);
    } },
    { label: "Survivors close ranks", async run(s) {
      const live = SURVIVORS.map((id) => s.querySelector(`.card[data-by="${id}"]`));
      live.forEach((c, i) => {
        const nx = lineX(i, live.length) , ox = parseFloat(c.style.left);
        c.style.left = nx + "px";
        anim(c, [{ transform: `translateX(${ox - nx}px)` }, { transform: "none" }], { duration: 520, delay: i * 50, easing: E.back });
      });
      sfx.whoosh();
      await wait(700);
      const t = add(s, `<div class="abs center" style="left:0;right:300px;top:470px">${slamHTML("*4* CLUES SURVIVE", "", "font-size:84px")}</div>`);
      s.querySelector(".lost-count").style.opacity = 0;
      await slamIn(t, { stagger: 26 });
      sfx.ding();
      s.querySelector(".host").innerHTML = "Anna, <b>eyes up.</b> Blindfold off.";
      popIn(s.querySelector(".host"));
    } },
  ],
});
async function lose(s, n) {
  st.lost += n;
  const l = s.querySelector(".lost");
  l.textContent = st.lost;
  anim(l, [{ transform: "scale(1.6)" }, { transform: "none" }], { duration: 350, easing: E.back, fill: "none" });
  const pot = s.querySelector(".pot");
  await drain(pot, st.pot, st.pot - n * SEG);
  st.pot -= n * SEG;
}
async function jinxPair(s, a, b, reason) {
  mode("hero");
  const A = s.querySelector(`.card[data-by="${a}"]`), B = s.querySelector(`.card[data-by="${b}"]`);
  const cx = 640, cy = 470;
  s.querySelector(".host").innerHTML = "Uh-oh. <b>Great minds…</b>";
  // 1. both glow and lift (450 ms)
  for (const c of [A, B]) {
    c.querySelector(".back").style.borderColor = "#fff7e6";
    anim(c, [{ transform: "none" }, { transform: "translateY(-34px) scale(1.08)" }], { duration: 420, easing: E.back });
  }
  sfx.riser(0.7);
  aim(0, parseFloat(A.style.left) + 68, 300);
  aim(2, parseFloat(B.style.left) + 68, 300);
  await wait(650);
  // 2. they fly at each other, accelerating (420 ms)
  sfx.whoosh();
  const fly = (c, side) => {
    const x = parseFloat(c.style.left), y = parseFloat(c.style.top);
    return anim(c, [
      { transform: "translateY(-34px) scale(1.08)" },
      { transform: `translate(${(cx + side * 60 - LINE.w / 2 - x) * 0.4}px, ${-80}px) rotate(${side * -12}deg) scale(1.2)`, offset: 0.45 },
      { transform: `translate(${cx + side * 58 - LINE.w / 2 - x}px, ${cy - LINE.h / 2 - y}px) rotate(${side * 18}deg) scale(1.25)` },
    ], { duration: 440, easing: E.in });
  };
  fly(A, -1);
  await play(fly(B, 1));
  // 3. impact: flash, shake, shards, shock ring (0 ms)
  sfx.slam();
  sfx.shatter();
  flash(0.75);
  shake(TV.querySelector("#scene"), 18, 380);
  A.style.visibility = B.style.visibility = "hidden";
  shards(cx, cy, ["#ff2f7d", "#ff2f7d", "#fff7e6", "#0b0620"], 20);
  // 4. the stamp (260 ms) and the reason
  const stamp = add(s, `<div class="stamp" style="left:${cx}px;top:${cy}px">JINX!</div>`);
  await play(anim(stamp, [{ transform: "translate(-50%,-50%) rotate(-10deg) scale(3)", opacity: 0 }, { transform: "translate(-50%,-50%) rotate(-10deg) scale(1)", opacity: 1 }], { duration: 260, easing: E.back }));
  sfx.stamp();
  const r = add(s, `<div class="abs center" style="left:0;right:0;top:${cy + 92}px;gap:14px">
      <div class="plate hot" style="font-size:30px">${av(a, "shock")}${av(b, "shock")}<span>${P[a].name} + ${P[b].name}</span></div>
      <div class="plate dark" style="font-size:30px"><span>${reason}</span></div></div>`);
  r.querySelectorAll(".av").forEach((x) => (x.style.cssText = "width:48px;height:48px"));
  r.querySelectorAll(".plate").forEach((p, i) => popIn(p, { delay: i * 120, base: "skewX(-8deg)" }));
  freeCones();
  await lose(s, 2);
  await wait(900);
  mode(null);
  fadeOut(stamp, { duration: 300 });
  fadeOut(r, { duration: 300 });
  await wait(300);
  stamp.remove();
  r.remove();
}

// 6 ------------------------------------------------------------ reveal
const GRID = { x: 64, y: 186, w: 828, h: 348, gap: 28 };
function gridPos(i, n) {
  const cols = n <= 2 ? n : n <= 4 ? 2 : 3, rows = Math.ceil(n / cols);
  const w = (GRID.w - (cols - 1) * GRID.gap) / cols;
  const h = Math.min(200, (GRID.h - (rows - 1) * (GRID.gap + 14)) / rows);
  const col = i % cols, row = Math.floor(i / cols);
  const totalH = rows * h + (rows - 1) * (GRID.gap + 14);
  return { x: GRID.x + col * (w + GRID.gap), y: GRID.y + (GRID.h - totalH) / 2 + row * (h + GRID.gap + 14), w, h };
}
phase({
  id: "reveal", name: "Reveal", stinger: "The reveal",
  phone: "Guesser: the face-down cards with avatars to tap (\"turn next\"), a big GUESS field and PASS. Clue-givers: \"Shhh — Anna is choosing\", their own card's state.",
  enter(s) {
    st.pot = 850;
    st.turned = 0;
    const live = CLUES.filter((c) => SURVIVORS.includes(c.by));
    s.innerHTML = header(3, `<div class="plate dark" style="font-size:24px;padding:8px 16px"><span>4 CLUES · 3 LOST</span></div>`) + `
      <div class="abs host-line" style="left:64px;top:104px;height:60px;width:828px;display:flex;align-items:center;gap:20px"><div class="say host">Anna, <b>whose card do you turn first?</b></div></div>
      ${live.map((c, i) => cardHTML(c, gridPos(i, live.length))).join("")}
      ${potHTML(938, 150, st.pot)}
      <div class="pot-cap abs label" style="left:938px;top:470px;width:300px;line-height:1.3">ANNA'S IF SHE<br>NAILS IT</div>
      <div class="guessbar">${av(GUESSER)}<div class="who">ANNA'S<br>GUESS</div><div class="wait">Pick a card on your phone… or take a guess.</div></div>`;
  },
  async intro(s) {
    const cards = [...s.querySelectorAll(".card")];
    cards.forEach((c, i) => popIn(c, { delay: i * 90 }));
    popIn(s.querySelector(".pot"), { base: "", delay: 200 });
    await wait(700);
  },
  beats: [
    { label: "Anna trusts Ben (bold)", async run(s) { await turn(s, "ben"); } },
    { label: "Anna trusts Farouk", async run(s) { await turn(s, "farouk"); } },
    { label: "Anna types (live)", async run(s) { await typeGuess(s, ["L", "I", "G", "H", "T", "H", "O", "S", "<", "U", "S", "E"]); } },
    { label: "Lock in → verdict", async run(s) {
      const tiles = [...s.querySelectorAll(".guessbar .tile:not(.caret)")];
      s.querySelector(".guessbar .caret")?.remove();
      stopHeart();
      tiles.forEach((t, i) => anim(t, [{ transform: "none" }, { transform: "translateY(-14px)", background: "#ffc928" }, { transform: "none", background: "#ffc928" }], { duration: 300, delay: i * 40 }));
      sfx.stamp();
      const lk = s.querySelector(".shh");
      lk.outerHTML = `<div class="plate gold shh" style="font-size:34px"><span>LOCKED IN!</span></div>`;
      s.querySelector(".host-line .say").innerHTML = "<b>One guess.</b> No take-backs.";
      popIn(s.querySelector(".shh"), { base: "skewX(-8deg)" });
      await wait(1100);
      go(cur + 1, { verdict: "right" });
    } },
  ],
  alts: [{ label: "…or Anna passes", async run(s) { stopHeart(); go(cur + 1, { verdict: "pass" }); } }],
});
async function turn(s, id) {
  const c = s.querySelector(`.card[data-by="${id}"]`);
  const host = s.querySelector(".host-line");
  const n = ++st.turned;
  // 1. the host line (two hits): "ANNA TRUSTS…" then the name
  host.innerHTML = slamHTML(`ANNA TRUSTS… *${P[id].name}*`, "", "font-size:52px");
  const chs = [...host.querySelectorAll(".ch")];
  const split = chs.length - P[id].name.length;
  chs.forEach((ch, i) => anim(ch, [{ transform: "translateY(-50px) scale(1.6)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 320, delay: i < split ? i * 22 : 650 + (i - split) * 40, easing: E.back }));
  sfx.thud(0);
  // 2. the spotlight swings onto the card, the card lifts
  const x = parseFloat(c.style.left) + c.offsetWidth / 2, y = parseFloat(c.style.top) + c.offsetHeight / 2;
  aim(1, x, y);
  aim(0, x, y);
  look(s.querySelector(".guessbar"), x < 480 ? -1 : 1, -1);
  await wait(650);
  sfx.stamp();
  await wait(250);
  c.style.zIndex = 5;
  await play(anim(c, [{ transform: "none" }, { transform: "translateY(-18px) scale(1.06)" }], { duration: 260, easing: E.back }));
  // 3. the turn (420 ms), a pop at 90°
  const inner = c.querySelector(".inner");
  sfx.flip();
  await play(anim(inner, [{ transform: "rotateY(0deg)" }, { transform: "rotateY(200deg)", offset: 0.75 }, { transform: "rotateY(180deg)" }], { duration: 480, easing: E.out }));
  c.classList.add("picked");
  add(c, `<div class="num">${n}</div>`);
  popIn(c.querySelector(".num"));
  anim(c, [{ transform: "translateY(-18px) scale(1.06)" }, { transform: "none" }], { duration: 300 });
  if (c.classList.contains("bold")) {
    sfx.sparkle();
    const b = add(c, `<div class="abs" style="left:50%;top:-26px;z-index:6"><div class="plate" style="background:var(--flame);font-size:26px;padding:6px 18px"><span>BOLD ×2</span></div></div>`);
    popIn(b, { base: "translateX(-50%) rotate(-3deg)" });
    anim(c.querySelector(".flame"), [{ transform: "scale(1)" }, { transform: "scale(1.6) rotate(-10deg)" }, { transform: "scale(1.2)" }], { duration: 500, easing: E.back });
  }
  freeCones();
  await wait(350);
  // 4. the pot drains (3 segments, 120 ms each)
  await drain(s.querySelector(".pot"), st.pot, st.pot - 150);
  st.pot -= 150;
  look(s.querySelector(".guessbar"), 0, 0);
}
let heart = null;
function stopHeart() { if (heart) clearInterval(heart); heart = null; }
onLeave(stopHeart);
async function typeGuess(s, keys) {
  const bar = s.querySelector(".guessbar");
  const host = s.querySelector(".host-line");
  host.innerHTML = `<div class="plate red shh" style="font-size:34px"><span>SHHH!</span></div><div class="say"><b>Anna is typing.</b> Not a sound, people.</div>`;
  bar.querySelector(".who").remove();
  bar.querySelector(".wait").outerHTML = `<div class="tiles"><div class="tile caret"></div></div>`;
  popIn(host.querySelector(".shh"), { base: "skewX(-8deg)" });
  look(bar, 1, 0);
  // The room goes quiet: only a heartbeat under the typing.
  stopHeart();
  sfx.heartbeat();
  heart = setInterval(sfx.heartbeat, 900);
  onLeave(stopHeart);
  await wait(900);
  const tiles = bar.querySelector(".tiles");
  for (const k of keys) {
    const caret = tiles.querySelector(".caret");
    if (k === "<") {
      const last = caret.previousElementSibling;
      sfx.backspace();
      await play(anim(last, [{ transform: "none", opacity: 1 }, { transform: "translateY(40px) rotate(20deg)", opacity: 0 }], { duration: 220, easing: E.in }));
      last.remove();
    } else {
      const t = el(`<div class="tile">${k}</div>`);
      caret.before(t);
      sfx.key();
      anim(t, [{ transform: "translateY(-30px) scale(1.5)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 200, easing: E.back });
    }
    await wait(k === "S" && !tiles.dataset.paused ? ((tiles.dataset.paused = 1), 900) : rnd(140, 380));
  }
}

// 7 ------------------------------------------------------------ verdict
phase({
  id: "verdict", name: "Verdict", noWipe: true,
  phone: "Guesser: big ✓/✗ and the word. Clue-givers: \"+400 — your bold clue paid off\" (or \"+0\").",
  enter(s, opt = {}) {
    st.verdict = opt.verdict ?? "right";
    const guess = st.verdict === "wrong" ? "LAMPPOST" : st.verdict === "pass" ? "" : WORD;
    const n = Math.max(WORD.length, guess.length);
    const tw = Math.min(82, Math.floor((1152 - (n - 1) * 8) / n));
    st.tw = tw;
    s.innerHTML = header() + `
      <div class="abs center" style="left:0;right:0;top:118px"><div class="label">ANNA SAYS</div></div>
      <div class="abs center guess-row" style="left:0;right:0;top:160px;height:110px">${guess ? `<div class="tiles big">${tilesHTML(guess)}</div>` : `<div class="plate dark" style="font-size:56px"><span>ANNA PASSED</span></div>`}</div>
      <div class="abs center" style="left:0;right:0;top:312px"><div class="label">THE WORD WAS</div></div>
      <div class="abs center word-row" style="left:0;right:0;top:354px;height:110px"><div class="tiles big secret">${tilesHTML("?".repeat(WORD.length), "q")}</div></div>
      <div class="abs center headline" style="left:0;right:0;top:492px;height:110px"></div>
      <div class="abs center points" style="left:0;right:0;top:614px;gap:44px"></div>`;
    s.querySelectorAll(".tiles.big .tile").forEach((t) => { t.style.width = tw + "px"; t.style.fontSize = Math.round(tw * 0.9) + "px"; });
  },
  async intro(s) {
    const tiles = [...s.querySelectorAll(".guess-row .tile, .guess-row .plate")];
    tiles.forEach((t, i) => anim(t, [{ transform: "translateY(340px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 420, delay: i * 30, easing: E.back }));
    await wait(500);
  },
  beats: [{ label: "Drumroll → reveal", async run(s) { await verdict(s); } }],
  alts: [
    { label: "Variant: right", async run() { go(cur, { verdict: "right", noWipe: true }); } },
    { label: "Variant: wrong", async run() { go(cur, { verdict: "wrong", noWipe: true }); } },
    { label: "Variant: pass", async run() { go(cur, { verdict: "pass", noWipe: true }); } },
  ],
});
async function verdict(s) {
  const secret = [...s.querySelectorAll(".secret .tile")];
  const guess = [...s.querySelectorAll(".guess-row .tile")];
  mode("hero");
  aim(0, 640, 400); aim(2, 640, 400);
  // 1. drumroll (1400 ms): the "?" tiles jitter
  sfx.drumroll(1.4);
  secret.forEach((t, i) => anim(t, [{ transform: "translateY(0)" }, { transform: "translateY(-8px)" }, { transform: "translateY(0)" }], { duration: 180, iterations: 7, delay: i * 18, easing: "ease-in-out", fill: "none" }));
  await wait(1400);
  // 2. the word flips in, left to right (70 ms stagger)
  for (let i = 0; i < secret.length; i++) {
    const t = secret[i];
    anim(t, [{ transform: "rotateX(0)" }, { transform: "rotateX(90deg)", offset: 0.5 }, { transform: "rotateX(0)" }], { duration: 220, easing: E.lin, fill: "none" });
    setTimeout(() => { t.textContent = WORD[i]; t.classList.remove("q"); }, 110 * SPEED);
    sfx.tick();
    await wait(70);
  }
  await wait(300);
  const head = s.querySelector(".headline"), pts = s.querySelector(".points");
  if (st.verdict === "right") {
    // 3. match: both rows go gold, letter by letter, rising pitch
    for (let i = 0; i < secret.length; i++) {
      for (const t of [secret[i], guess[i]]) {
        t.classList.add("gold");
        anim(t, [{ transform: "scale(1.25)" }, { transform: "none" }], { duration: 260, easing: E.back, fill: "none" });
      }
      sfx.bulb(i);
      await wait(55);
    }
    // 4. the explosion
    mode("win");
    sfx.fanfare();
    flash(0.6, 320);
    confetti();
    head.innerHTML = slamHTML("NAILED IT!", "gold", "font-size:112px");
    await slamIn(head, { stagger: 35, from: "zoom" });
    shake(s, 8);
    const chips = [["anna", "+550", "THE POT"], ["ben", "+400", "BOLD ×2"], ["farouk", "+200", ""]];
    for (const [id, n] of chips) {
      const c = add(pts, `<div class="pts">${av(id, "happy")}<span>${P[id].name}</span><span class="n">${n}</span></div>`);
      popIn(c);
      sfx.pop();
      await wait(220);
    }
    await wait(1600);
    freeCones();
  } else {
    // 3'. no match: guess tiles go red and drop; the buzzer
    mode("bad");
    sfx.buzzer();
    guess.forEach((t) => t.classList.add("red"));
    shake(s.querySelector(".guess-row"), 12, 400);
    secret.forEach((t, i) => { t.classList.add("gold"); anim(t, [{ transform: "scale(1.2)" }, { transform: "none" }], { duration: 300, delay: i * 30, easing: E.back, fill: "none" }); });
    head.innerHTML = slamHTML(st.verdict === "pass" ? "NO GUESS. *NO GLORY.*" : "SO CLOSE. _SO WRONG._", "", "font-size:84px");
    await slamIn(head, { stagger: 22 });
    guess.forEach((t, i) => anim(t, [{ transform: "none", opacity: 1 }, { transform: `translateY(30px) rotate(${rnd(-14, 14)}deg)`, opacity: 0.5 }], { duration: 500, delay: 400 + i * 30, easing: E.in }));
    const c = add(pts, `<div class="pts">${av("anna", "sad")}<span>Anna</span><span class="n" style="color:var(--ink)">+0</span><span class="say" style="opacity:.8">· The pot goes home empty.</span></div>`);
    popIn(c);
    freeCones();
  }
}

// 8 ------------------------------------------------------------ replay + MVP
const REPLAY = [
  { by: "ben", word: "beacon", bold: true, tag: "TURNED 1ST", num: 1 },
  { by: "farouk", word: "keeper", tag: "TURNED 2ND", num: 2 },
  { by: "cleo", word: "foghorn", tag: "NEVER TURNED" },
  { by: "hana", word: "shipwrecks", tag: "NEVER TURNED" },
  { by: "dev", word: "lamp", tag: "JINXED", jinx: "esme", cls: "jinxed" },
  { by: "gus", word: "lights", tag: "TOO CLOSE", cls: "struck" },
];
phase({
  id: "replay", name: "Replay + MVP", stinger: "The replay",
  phone: "Guesser: all clues as buttons — \"Which clue cracked it? Tap the MVP.\" Others: the same list, read-only, their own highlighted.",
  enter(s) {
    const pos = (i) => ({ x: 64 + (i % 3) * (368 + 24), y: 184 + Math.floor(i / 3) * 206, w: 368, h: 168 });
    s.innerHTML = header() + `
      <div class="abs" style="left:64px;top:110px;display:flex;align-items:center;gap:18px"><div class="label">HOW WE GOT TO</div>${slamHTML("*LIGHTHOUSE*", "", "font-size:56px")}</div>
      ${REPLAY.map((c, i) => cardHTML(c, { ...pos(i), face: "front", num: c.num, cls: c.cls ?? "", tagline: c.tag })).join("")}
      <div class="abs center foot" style="left:64px;right:64px;top:606px;height:72px;gap:20px"><div class="plate hot two"><span>TWO OF YOU WROTE LAMP</span></div><div class="say host">Anna, <b>tap the MVP clue.</b></div></div>`;
    const j = s.querySelector('.card[data-by="dev"]');
    j.querySelector(".word").textContent = "lamp · lamps";
    j.querySelector(".who").innerHTML = `${av("dev")}${av("esme")}<span>Dev + Esme</span>`;
    j.querySelector(".front").insertAdjacentHTML("beforeend", `<svg class="crack" viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M58 0 L50 30 L60 46 L44 70 L52 100" stroke="#0b0620" stroke-width="2.4" fill="none" vector-effect="non-scaling-stroke" style="stroke-width:5px"/></svg>`);
  },
  async intro(s) {
    const cards = [...s.querySelectorAll(".card")];
    cards.forEach((c) => { c.querySelector(".inner").style.transform = "rotateY(0deg)"; });
    for (let i = 0; i < cards.length; i++) {
      const inner = cards[i].querySelector(".inner");
      anim(cards[i], [{ transform: "translateY(-30px) scale(.9)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 300, easing: E.back });
      anim(inner, [{ transform: "rotateY(0deg)" }, { transform: "rotateY(180deg)" }], { duration: 420, delay: 150 });
      sfx.flip();
      await wait(140);
    }
    await wait(400);
    const two = s.querySelector(".two");
    popIn(two, { base: "skewX(-8deg)" });
    sfx.stamp();
  },
  beats: [{ label: "Anna picks the MVP (Farouk)", async run(s) {
    const c = s.querySelector('.card[data-by="farouk"]');
    mode("hero");
    s.querySelectorAll(".card").forEach((x) => x !== c && x.classList.add("dim"));
    const x = parseFloat(c.style.left) + 184, y = parseFloat(c.style.top) + 75;
    aimAll(x, y);
    sfx.riser(0.6);
    c.style.zIndex = 5;
    await play(anim(c, [{ transform: "none" }, { transform: "scale(1.14)" }], { duration: 420, easing: E.back }));
    const crown = add(c, `<div class="mvp-badge">${CROWN}</div>`);
    await play(anim(crown, [{ transform: "translateY(-260px) rotate(-30deg)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 420, easing: E.back }));
    sfx.stamp();
    sfx.sparkle();
    confetti(20);
    const foot = s.querySelector(".foot");
    foot.innerHTML = `<div class="plate gold" style="font-size:36px"><span>MVP CLUE · FAROUK +100</span></div><div class="say">“Keeper” <b>did the heavy lifting.</b></div>`;
    popIn(foot.firstChild, { base: "skewX(-8deg)" });
    await wait(1400);
    freeCones();
    mode(null);
  } }],
});

// 9 ------------------------------------------------------------ scores
const SCORES = [
  { id: "ben", old: 1450, add: 400 },
  { id: "anna", old: 1350, add: 550 },
  { id: "farouk", old: 1100, add: 300 },
  { id: "hana", old: 1000, add: 0 },
  { id: "cleo", old: 900, add: 0 },
  { id: "esme", old: 750, add: 0 },
  { id: "dev", old: 600, add: 0 },
  { id: "gus", old: 300, add: 0 },
];
const MAXS = 2000, BAR = 236;
const colX = (i) => 64 + i * ((1152 - 124) / 7);
phase({
  id: "scores", name: "Scores", stinger: "Scoreboard",
  phone: "Each phone: your total, your rank (\"#2 of 8\"), this round's points with the reason; the room's 3/3.",
  enter(s) {
    s.innerHTML = header(3, "", false) + `
      <div class="abs roomrow" style="left:64px;top:118px;display:flex;align-items:center;gap:22px"><div class="label" style="color:var(--cyan)">THE ROOM</div>
        <div class="bulbs big">${[1, 1, 1, 0, 0, 0, 0, 0].map((b) => `<i class="bulb ${b ? "on" : ""}"></i>`).join("")}</div>
        <div class="say"><b>3 for 3.</b> The room is on fire.</div></div>
      <div class="baseline"></div>
      <div class="cols">${SCORES.map((p, i) => `<div class="col ${i === 0 ? "lead" : ""}" data-p="${p.id}" style="left:${colX(i) - 64}px;height:520px">
          <div class="bar" style="transform:scaleY(${p.old / MAXS * BAR / 340})"></div>
          <div class="top" style="transform:translateY(-${p.old / MAXS * BAR}px)"><div class="score">${fmt(p.old)}</div>${av(p.id)}</div>
          <div class="nm">${P[p.id].name}</div></div>`).join("")}</div>`;
  },
  async intro(s) {
    const cols = [...s.querySelectorAll(".col")];
    cols.forEach((c, i) => {
      const p = SCORES[i];
      const h = p.old / MAXS * BAR;
      anim(c.querySelector(".bar"), [{ transform: "scaleY(0)" }, { transform: `scaleY(${h / 340})` }], { duration: 600, delay: i * 60, easing: E.back });
      anim(c.querySelector(".top"), [{ transform: "translateY(0)" }, { transform: `translateY(-${h}px)` }], { duration: 600, delay: i * 60, easing: E.back });
    });
    await wait(1000);
  },
  beats: [
    { label: "Add this round", async run(s) {
      for (const p of SCORES.filter((p) => p.add)) {
        const c = s.querySelector(`.col[data-p="${p.id}"]`);
        const h0 = p.old / MAXS * BAR, h1 = (p.old + p.add) / MAXS * BAR;
        const d = add(c, `<div class="delta" style="bottom:${44 + h1 + 150}px">+${p.add}</div>`);
        popIn(d, { base: "translateX(-50%)" });
        sfx.pop();
        anim(c.querySelector(".bar"), [{ transform: `scaleY(${h0 / 340})` }, { transform: `scaleY(${h1 / 340})` }], { duration: 700, easing: E.back });
        anim(c.querySelector(".top"), [{ transform: `translateY(-${h0}px)` }, { transform: `translateY(-${h1}px)` }], { duration: 700, easing: E.back });
        countTo(c.querySelector(".score"), p.old, p.old + p.add, 700);
        for (let k = 0; k < 5; k++) setTimeout(() => sfx.tick(), k * 120 * SPEED);
        await wait(520);
      }
    } },
    { label: "Re-rank + leader", async run(s) {
      const order = [...SCORES].sort((a, b) => b.old + b.add - (a.old + a.add));
      order.forEach((p, i) => {
        const c = s.querySelector(`.col[data-p="${p.id}"]`);
        const ox = parseFloat(c.style.left), nx = colX(i) - 64;
        c.classList.toggle("lead", i === 0);
        if (ox === nx) return;
        c.style.left = nx + "px";
        anim(c, [{ transform: `translateX(${ox - nx}px)` }, { transform: `translate(${(ox - nx) / 2}px, ${i === 0 ? -40 : 30}px)` }, { transform: "none" }], { duration: 650, easing: E.out });
      });
      sfx.whoosh();
      await wait(700);
      const lead = s.querySelector(`.col[data-p="${order[0].id}"]`);
      const h = (order[0].old + order[0].add) / MAXS * BAR;
      const cr = add(lead, `<div class="crown" style="bottom:${44 + h + 140}px">${CROWN}</div>`);
      anim(cr, [{ transform: "translateY(-300px) rotate(-20deg)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 450, easing: E.back });
      lead.querySelector(".delta")?.remove();
      mood(lead, "happy");
      sfx.stamp();
      sfx.sparkle();
      s.querySelectorAll(".delta").forEach((d) => fadeOut(d));
      fadeOut(s.querySelector(".roomrow"), { duration: 200 });
      const t = add(s, `<div class="abs center" style="left:0;right:0;top:112px">${slamHTML("*ANNA* TAKES THE LEAD", "", "font-size:72px")}</div>`);
      await slamIn(t, { stagger: 22 });
    } },
  ],
});

// 10 ------------------------------------------------------------ the end
const WEB = {
  words: [
    ["LIGHTHOUSE", 230, 470, 1], ["PIRATE", 250, 250, 1], ["DIAMOND", 560, 170, 1], ["MOON", 700, 360, 1],
    ["MOUSE", 990, 470, 1], ["PIZZA", 760, 620, 0], ["OWL", 1060, 230, 1], ["VOLCANO", 470, 610, 1],
    ["DRAGON", 640, 500, 0], ["GHOST", 1080, 610, 1], ["ROBOT", 860, 150, 0], ["SNOWMAN", 360, 360, 0], ["ORCHESTRA", 1000, 350, 1],
  ],
  // [clue, x, y, words it links (indices); bridge when 2+]
  clues: [
    ["SEA", 200, 360, [0, 1]], ["TREASURE", 410, 200, [1, 2]], ["CHEESE", 860, 520, [3, 4, 5]], ["NIGHT", 880, 290, [3, 6]],
    ["FIRE", 560, 560, [7, 8]], ["KEEPER", 120, 560, [0]], ["SHEET", 1172, 524, [9]], ["METAL", 860, 84, [10]],
    ["CARROT", 300, 300, [11]], ["VIOLINS", 1160, 400, [12]], ["RING", 690, 104, [2]], ["CRATER", 610, 290, [3]],
  ],
};
phase({
  id: "end", name: "The end", stinger: "That's the show!",
  phone: "Everyone: room result, your personal stats and your award if any; VIP gets PLAY AGAIN / NEW PLAYERS.",
  enter(s) {
    s.innerHTML = `<div class="abs center" style="left:0;right:0;top:70px"><div class="label">TONIGHT THE ROOM GOT</div></div>
      <div class="abs center" style="left:0;right:0;top:130px"><div class="big-score"><span class="got">0</span><span class="of"> / 13</span></div></div>
      <div class="abs center" style="left:0;right:0;top:400px"><div class="bulbs big">${[1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1].map((b) => `<i class="bulb" data-b="${b}"></i>`).join("")}</div></div>
      <div class="abs center rank" style="left:0;right:0;top:500px;height:110px"></div>`;
  },
  async intro(s) {
    mode("hero");
    const bulbs = [...s.querySelectorAll(".bulb")];
    const got = s.querySelector(".got");
    let n = 0;
    for (let i = 0; i < bulbs.length; i++) {
      const b = bulbs[i];
      if (b.dataset.b === "1") { b.classList.add("on"); sfx.bulb(n * 2); got.textContent = ++n; anim(got, [{ transform: "scale(1.2)" }, { transform: "none" }], { duration: 160, fill: "none" }); }
      else { b.classList.add("miss"); sfx.block(false); }
      anim(b, [{ transform: "scale(1.5)" }, { transform: "none" }], { duration: 260, easing: E.back, fill: "none" });
      await wait(170);
    }
    await wait(300);
    const r = s.querySelector(".rank");
    r.innerHTML = `<div class="plate gold" style="font-size:64px;padding:16px 40px"><span>CERTIFIED MIND READERS</span></div>`;
    sfx.fanfare();
    await play(anim(r.firstChild, [{ transform: "skewX(-8deg) scale(2.6)", opacity: 0 }, { transform: "skewX(-8deg) scale(1)", opacity: 1 }], { duration: 300, easing: E.back }));
    shake(s, 8);
    confetti(24);
    mode(null);
  },
  beats: [
    { label: "MVP of the night", async run(s) {
      await wipe(() => {
        s.innerHTML = `<div class="abs center" style="left:0;right:0;top:60px"><div class="label" style="color:var(--gold)">THE MVP OF THE NIGHT</div></div>
          <div class="hotseat-ring" style="top:300px;width:320px;height:320px;margin:-160px 0 0 -160px"></div>
          <div class="abs mvp-av" style="left:520px;top:180px;width:240px;height:240px">${av("farouk")}</div>
          <div class="abs center nm" style="left:0;right:0;top:460px"></div>
          <div class="abs center stats" style="left:0;right:0;top:604px;gap:16px"></div>`;
        s.querySelector(".mvp-av .av").style.cssText = "width:240px;height:240px;opacity:0";
      });
      mode("hero");
      aimAll(640, 300);
      sfx.drumroll(1.6);
      await wait(1600);
      const a = s.querySelector(".mvp-av .av");
      mood(a, "happy");
      a.style.opacity = 1;
      mode("win");
      flash(0.6);
      await play(anim(a, [{ transform: "translateY(420px) scale(.6)" }, { transform: "translateY(-30px) scale(1.08)", offset: 0.7 }, { transform: "none" }], { duration: 650, easing: E.out }));
      sfx.fanfare();
      confetti();
      const nm = s.querySelector(".nm");
      nm.innerHTML = slamHTML("*FAROUK*", "", "font-size:130px");
      await slamIn(nm, { stagger: 50, from: "zoom" });
      const st2 = s.querySelector(".stats");
      for (const t of ["5 MVP CLUES", "NEVER JINXED", "2,950 PTS"]) { const p = add(st2, `<div class="plate dark" style="font-size:32px"><span>${t}</span></div>`); popIn(p, { base: "skewX(-8deg)" }); sfx.pop(); await wait(200); }
      await wait(1200);
      freeCones();
    } },
    { label: "Awards", async run(s) {
      const AW = [
        { t: "MIND MELD", who: ["dev", "esme"], n: "Dev + Esme", d: "Jinxed each other 4 times. Get a room." },
        { t: "LONE WOLF", who: ["hana"], n: "Hana", d: "6 one-of-a-kind clues that got turned." },
        { t: "KAMIKAZE", who: ["gus"], n: "Gus", d: "Jinxed 5 times. Fearless. Wrong, but fearless." },
      ];
      await wipe(() => {
        mode(null);
        s.innerHTML = `<div class="abs center" style="left:0;right:0;top:52px">${slamHTML("THE *AWARDS*", "", "font-size:64px")}</div>` +
          AW.map((a, i) => `<div class="award" style="left:${64 + i * 406}px;top:180px"><div class="inner">
            <div class="face back"><div class="mark">J<span class="x">!</span></div></div>
            <div class="face front"><div class="t">${a.t}</div><div class="avs">${a.who.map((id) => av(id, "happy")).join("")}</div><div class="n">${a.n}</div><div class="d">${a.d}</div></div>
          </div></div>`).join("");
      }, "Awards");
      const cards = [...s.querySelectorAll(".award")];
      for (const c of cards) {
        aimAll(parseFloat(c.style.left) + 170, 390);
        sfx.drumroll(0.5);
        await wait(600);
        sfx.flip();
        await play(anim(c.querySelector(".inner"), [{ transform: "rotateY(0)" }, { transform: "rotateY(200deg) scale(1.08)", offset: 0.7 }, { transform: "rotateY(180deg)" }], { duration: 520 }));
        sfx.sparkle();
        sfx.stamp();
        await wait(900);
      }
      freeCones();
    } },
    { label: "Word web", async run(s) {
      await wipe(() => {
        const lines = [];
        for (const [, cx, cy, ws] of WEB.clues) for (const w of ws) {
          const [, wx, wy, ok] = WEB.words[w];
          const mx = (cx + wx) / 2 + (cy - wy) * 0.12, my = (cy + wy) / 2 - (cx - wx) * 0.12;
          lines.push(`<path class="${ok ? "" : "miss"}" d="M${cx} ${cy} Q${mx} ${my} ${wx} ${wy}"/>`);
        }
        s.innerHTML = `<div class="web"><svg class="lines" viewBox="0 0 1280 720">${lines.join("")}</svg>
          ${WEB.clues.map(([c, x, y, ws]) => `<div class="wn clue ${ws.length > 1 ? "bridge" : ""}" style="left:${x}px;top:${y}px">${c}</div>`).join("")}
          ${WEB.words.map(([w, x, y, ok]) => `<div class="wn word ${ok ? "" : "miss"}" style="left:${x}px;top:${y}px">${w}</div>`).join("")}
          <div class="abs" style="left:64px;top:36px;display:flex;gap:18px;align-items:center">${slamHTML("TONIGHT'S *WORD WEB*", "", "font-size:48px")}</div>
          <div class="abs say" style="left:64px;top:636px;font-size:24px;opacity:.85"><b class="gold">Gold</b> got it · <b style="color:#9a88e0">outline</b> missed · <b class="cyan">cyan</b> clues</div></div>`;
      }, "");
      const words = [...s.querySelectorAll(".wn.word")], clues = [...s.querySelectorAll(".wn.clue")], paths = [...s.querySelectorAll(".lines path")];
      [...words, ...clues].forEach((n) => (n.style.opacity = 0));
      paths.forEach((p) => { const L = p.getTotalLength(); p.style.strokeDasharray = p.classList.contains("miss") ? "2 12" : `${L}`; p.style.strokeDashoffset = L; p.style.opacity = 0; });
      for (const w of words) {
        w.style.opacity = 1;
        anim(w, [{ transform: "translate(-50%,-50%) scale(.2)" }, { transform: "translate(-50%,-50%) scale(1)" }], { duration: 380, easing: E.back });
        sfx.pop();
        await wait(140);
      }
      let pi = 0;
      for (const [i, [, , , ws]] of WEB.clues.entries()) {
        const c = clues[i];
        c.style.opacity = 1;
        anim(c, [{ transform: "translate(-50%,-50%) scale(0)" }, { transform: "translate(-50%,-50%) scale(1)" }], { duration: 320, easing: E.back });
        for (let k = 0; k < ws.length; k++) {
          const p = paths[pi++];
          p.style.opacity = 1;
          anim(p, [{ strokeDashoffset: p.getTotalLength() }, { strokeDashoffset: 0 }], { duration: 420, easing: E.out });
        }
        ws.length > 1 ? (sfx.sparkle(), sfx.bulb(i)) : sfx.tick();
        await wait(ws.length > 1 ? 380 : 160);
      }
    } },
  ],
});

// ---------------------------------------------------------------- the runner
let cur = -1, beatIdx = 0, busy = false, auto = false;
let st = {};
async function safe(f) {
  try { await f(); } catch (e) { if (!(e instanceof Stale)) console.error(e); }
}
async function go(i, opt = {}) {
  i = Math.max(0, Math.min(PHASES.length - 1, i));
  gen++;
  leaves.forEach((f) => f());
  leaves = [];
  FX.querySelectorAll(":scope > :not(.flash)").forEach((n) => n.remove());
  mode(null);
  freeCones();
  cur = i;
  beatIdx = 0;
  st = {};
  const ph = PHASES[i];
  const build = () => { SCENE.getAnimations({ subtree: true }).forEach((a) => a.cancel()); SCENE.innerHTML = ""; ph.enter(SCENE, opt); };
  location.hash = `p=${ph.id}` + (Q.has("shot") ? "&shot" : "");
  renderControls();
  busy = true;
  await safe(async () => {
    if (ph.noWipe || opt.noWipe || SPEED < 0.5) build();
    else await wipe(build, ph.stinger);
    if (ph.intro) await ph.intro(SCENE, opt);
  });
  busy = false;
  renderControls();
}
async function beat(k = beatIdx, alt = false) {
  const ph = PHASES[cur];
  const b = alt ? ph.alts[k] : ph.beats[k];
  if (!b || busy) return;
  busy = true;
  if (!alt) beatIdx = k + 1;
  renderControls();
  const g = gen;
  await safe(() => b.run(SCENE));
  if (g === gen) busy = false;
  renderControls();
}
async function autoplay() {
  while (auto) {
    if (busy) { await new Promise((r) => setTimeout(r, 200)); continue; }
    const ph = PHASES[cur];
    if (beatIdx < ph.beats.length) { await beat(); await new Promise((r) => setTimeout(r, 1300)); }
    else if (cur < PHASES.length - 1) { await new Promise((r) => setTimeout(r, 1200)); if (auto) await go(cur + 1); }
    else auto = false;
  }
  renderControls();
}

function renderControls() {
  if (cur < 0) return;
  const ph = PHASES[cur];
  CONTROLS.innerHTML = "";
  PHASES.forEach((p, i) => {
    const b = add(CONTROLS, `<button class="${i === cur ? "on" : ""}" title="key ${(i + 1) % 10}">${i + 1}. ${p.name}</button>`);
    b.onclick = () => { auto = false; go(i); };
  });
  add(CONTROLS, `<span class="sep"></span>`);
  ph.beats.forEach((bt, i) => {
    const b = add(CONTROLS, `<button class="beat ${i < beatIdx ? "done" : ""}">${i === beatIdx ? "▶ " : ""}${bt.label}</button>`);
    b.onclick = () => beat(i);
  });
  (ph.alts ?? []).forEach((bt, i) => { const b = add(CONTROLS, `<button class="beat">${bt.label}</button>`); b.onclick = () => beat(i, true); });
  add(CONTROLS, `<span class="sep"></span>`);
  const a = add(CONTROLS, `<button class="${auto ? "on" : ""}">Auto (A)</button>`);
  a.onclick = toggleAuto;
  const sf = add(CONTROLS, `<button class="${SAFE.hidden ? "" : "on"}">Safe area (S)</button>`);
  sf.onclick = () => { SAFE.hidden = !SAFE.hidden; renderControls(); };
  const m = add(CONTROLS, `<button class="${AU.muted ? "" : "on"}">Sound (M)</button>`);
  m.onclick = () => { AU.muted = !AU.muted; renderControls(); };
  add(CONTROLS, `<span class="keys">←/→ phase · Space next beat · 1–0 jump</span>`);
  add(CONTROLS, `<span class="phone" title="${ph.phone.replace(/"/g, "&quot;")}">📱 ${ph.phone}</span>`);
}
function toggleAuto() { auto = !auto; renderControls(); if (auto) autoplay(); }
addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") { auto = false; go(cur + 1); }
  else if (e.key === "ArrowLeft") { auto = false; go(cur - 1); }
  else if (e.key === " ") { e.preventDefault(); beat(); }
  else if (e.key === "a" || e.key === "A") toggleAuto();
  else if (e.key === "s" || e.key === "S") { SAFE.hidden = !SAFE.hidden; renderControls(); }
  else if (e.key === "m" || e.key === "M") { AU.muted = !AU.muted; renderControls(); }
  else if (/^[0-9]$/.test(e.key)) { auto = false; go((+e.key + 9) % 10); }
});

function fit() {
  const vp = document.getElementById("viewport");
  const k = Math.min(vp.clientWidth / 1280, vp.clientHeight / 720);
  TV.style.transform = `scale(${k})`;
}
addEventListener("resize", fit);
fit();

// Start: #p=<phase id>&b=<beats to fast-forward>&shot (hide the controls)
(async () => {
  if (Q.has("shot")) { document.body.classList.add("shot"); fit(); }
  if (Q.has("safe")) SAFE.hidden = false;
  const start = Math.max(0, PHASES.findIndex((p) => p.id === Q.get("p")));
  const nb = +(Q.get("b") ?? 0);
  const variant = Q.get("v");
  if (nb || Q.has("ff")) SPEED = 0.01;
  await go(start, variant ? { verdict: variant } : {});
  for (let i = 0; i < nb; i++) { await beat(i); await new Promise((r) => setTimeout(r, 30)); }
  SPEED = 1;
})();
