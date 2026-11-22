// @ts-check
/**
 * Shifty's TV page: tvpipe casts it with its own browser, or anyone opens
 * the watch link (the host page's preview, muted). It shows the screen
 * view (`{ roster, screen, join }`) in the room's language and animates
 * it, in neon noir (docs/shifty-design.md §7): the lobby; a round as one
 * scene (the line-up of suspects with their name plates, the lie
 * detector's oscilloscopes and their clue cards on top, the board of
 * sixteen words below), through the deal, the clues (the searchlight, the
 * typing as tiles and a needle, never the letters), the accusations, the
 * verdict's lasers and neon sign, the phony's last chance and the reveal
 * with its threads of light; the scores; the final screen. Players' texts
 * are always text.
 */

import { joinText, PartyClient, qrSvg } from "/_tvpipe/lib/client.js";
import { watchFit } from "../phone/fit.js";
import { pickLang } from "../phone/i18n.js";
import { strings } from "./strings.js";

const params = new URLSearchParams(location.hash.slice(1));
// The bottom left corner is tvpipe's join badge (the join code the whole game): the board starts right of it.
const client = PartyClient.fromLocation({ role: /** @type {any} */ (params.get("role") ?? "screen"), rejoinBadge: { corner: "bottom-left" } });
const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const statusBar = /** @type {HTMLElement} */ (document.getElementById("status"));
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

let lang = pickLang(undefined);
let t = strings(lang);

// ---------------------------------------------------------------------------
// Helpers

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} kids
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, String(x));
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
/**
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 * @returns {SVGElement}
 */
function s(tag, attrs = {}) {
  const el = /** @type {SVGElement} */ (document.createElementNS(SVG_NS, tag));
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A stable pseudo-random number in [-1, 1) for a key (tilts that do not jump between views). */
function jitter(/** @type {string} */ key) {
  let x = 2166136261;
  for (let i = 0; i < key.length; i++) x = Math.imul(x ^ key.charCodeAt(i), 16777619);
  return ((x >>> 0) / 4294967296) * 2 - 1;
}

const isColor = (/** @type {unknown} */ c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);

/** A player's colour: their own (`who.color`), else from the screen view (`colors`, by id), else a grey. */
function colorOf(/** @type {{ id?: string, color?: string } | null | undefined} */ who) {
  if (isColor(who?.color)) return /** @type {string} */ (who?.color);
  const c = who?.id ? client.view?.screen?.colors?.[who.id] : undefined;
  return isColor(c) ? c : "#7c8696";
}

const initial = (/** @type {string | undefined} */ name) => [...(name ?? "?").trim()][0]?.toUpperCase() ?? "?";

/**
 * @param {{ id?: string, name?: string, color?: string } | null | undefined} who
 * @param {string} [size] CSS length
 */
function avatar(who, size) {
  return h("span", { class: "avatar", style: { "--c": colorOf(who), ...(size ? { "--s": size } : {}) } }, initial(who?.name));
}

/** The outline of a suspect: a coat with its collar up, a head, a fedora. */
const SILHOUETTE = [
  "M43 56V72H57V56Z", // the neck
  "M6 110C6 86 20 72 38 69L50 82L62 69C80 72 94 86 94 110Z", // the coat
  "M36 46a14 16 0 1 0 28 0a14 16 0 1 0-28 0Z", // the head
  "M33 33C33 18 39 11 50 11C61 11 67 18 67 33Z", // the hat's crown
  "M20 34C20 30 34 29 50 29S80 30 80 34S68 38 50 38S20 38 20 34Z", // the brim
];

/**
 * A suspect's figure: a fedora silhouette outlined in their colour (a
 * wide faint stroke under a sharp one: a neon glow without filters), the
 * eyes under the brim glancing about on their own beat, the initial on
 * the coat.
 */
function figure(/** @type {{ id?: string, name?: string, color?: string }} */ who) {
  const el = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (s("svg", { viewBox: "0 0 100 110", class: "fig", "aria-hidden": "true" })));
  el.style.setProperty("--c", colorOf(who));
  const j = jitter(`eyes:${who.id ?? who.name ?? ""}`);
  el.style.setProperty("--g", `${(4.2 + j * 1.6).toFixed(2)}s`);
  el.style.setProperty("--gd", `${(-Math.abs(j) * 5).toFixed(2)}s`);
  for (const d of SILHOUETTE) el.append(s("path", { class: "halo", d }));
  for (const d of SILHOUETTE) el.append(s("path", { class: "sil", d }));
  el.append(s("path", { class: "line", d: "M33.5 32.5H66.5" }), s("path", { class: "line", d: "M50 82V110" }));
  const eyes = s("g", { class: "eyes" });
  eyes.append(s("ellipse", { class: "eye", cx: 44, cy: 45, rx: 2.6, ry: 1.7 }), s("ellipse", { class: "eye", cx: 56, cy: 45, rx: 2.6, ry: 1.7 }));
  el.append(eyes);
  const letter = s("text", { x: 50, y: 102, "text-anchor": "middle", class: "init" });
  letter.textContent = initial(who.name);
  el.append(letter);
  return el;
}

/** The time left until a deadline (host clock), ms. */
function left(/** @type {number} */ deadline) {
  return deadline - client.now();
}

// ---------------------------------------------------------------------------
// Sound: a typewriter, a lie detector's hum, lasers, neon and thuds, all
// synthesized (the preview is muted: the TV plays them), mixed through one
// master gain and a compressor so nothing clips when sounds overlap.

const MUTED = params.get("mute") === "1";
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
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      const out = a.createGain();
      out.gain.value = 0.9;
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
/** @param {AudioContext} a @returns {AudioNode} */
const mix = (a) => master ?? a.destination;
/** A watch page opened by hand gets its sound with the first tap. */
addEventListener("pointerdown", () => void ac(), { once: true });

/** @type {AudioBuffer | null} */
let noiseBuf = null;
function noiseBuffer(/** @type {AudioContext} */ a) {
  if (noiseBuf) return noiseBuf;
  noiseBuf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

/** A burst of filtered noise. @param {number} freq @param {number} len @param {number} [vol] @param {number} [delay] @param {number} [q] */
function burst(freq, len, vol = 0.4, delay = 0, q = 1) {
  const a = ac();
  if (!a) return;
  const at = a.currentTime + 0.02 + delay;
  const src = a.createBufferSource();
  src.buffer = noiseBuffer(a);
  const f = a.createBiquadFilter();
  f.type = freq < 600 ? "lowpass" : "bandpass";
  f.frequency.value = freq;
  f.Q.value = q;
  const g = a.createGain();
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  src.connect(f).connect(g).connect(mix(a));
  src.start(at, Math.random());
  src.stop(at + len + 0.02);
}

/** A tone, sliding from one pitch to another. @param {number} from @param {number} to @param {number} len @param {OscillatorType} [type] @param {number} [vol] @param {number} [delay] */
function tone(from, to, len, type = "sine", vol = 0.12, delay = 0) {
  const a = ac();
  if (!a) return;
  const at = a.currentTime + 0.02 + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, at);
  if (to !== from) o.frequency.exponentialRampToValueAtTime(to, at + len);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g).connect(mix(a));
  o.start(at);
  o.stop(at + len + 0.02);
}

/** The lie detector's hum while a turn runs: a low buzz, louder with the needle. */
const hum = (() => {
  /** @type {{ g: GainNode, o: OscillatorNode } | null} */
  let v = null;
  return {
    /** @param {number} level 0–1 */
    set(level) {
      const a = ac();
      if (!a) return;
      if (!v) {
        const o = a.createOscillator();
        const f = a.createBiquadFilter();
        const g = a.createGain();
        o.type = "sawtooth";
        o.frequency.value = 55;
        f.type = "lowpass";
        f.frequency.value = 260;
        g.gain.value = 0;
        o.connect(f).connect(g).connect(mix(a));
        o.start();
        v = { g, o };
      }
      v.g.gain.setTargetAtTime(0.012 + level * 0.05, a.currentTime, 0.05);
    },
    off() {
      if (v && audio) v.g.gain.setTargetAtTime(0, audio.currentTime, 0.08);
    },
  };
})();

const sfx = {
  /** A typewriter key. */
  clack: () => {
    burst(2600 + Math.random() * 900, 0.05, 0.5, 0, 2);
    burst(240, 0.04, 0.35);
  },
  /** The backspace: duller. */
  back: () => {
    burst(900, 0.06, 0.4, 0, 1.4);
    tone(220, 160, 0.06, "triangle", 0.06);
  },
  /** The carriage bell: a clue is in. */
  bell: () => {
    tone(2637, 2637, 0.9, "sine", 0.16);
    tone(5274, 5274, 0.4, "sine", 0.04);
    burst(300, 0.12, 0.3, 0.05);
  },
  /** A refused clue: a buzzer. */
  buzz: () => tone(140, 110, 0.32, "square", 0.08),
  /** A card dealt. */
  flick: () => burst(3800, 0.05, 0.22, 0, 0.8),
  /** A rubber stamp. */
  thud: () => {
    burst(180, 0.25, 0.9);
    tone(90, 50, 0.3, "sine", 0.3);
  },
  /** A drum roll. @param {number} ms */
  roll: (ms) => {
    for (let x = 0; x < ms / 1000; x += 0.045) burst(380, 0.06, 0.12 + (x / (ms / 1000)) * 0.22, x);
  },
  /** The noir sting: a minor chord on muted brass. */
  sting: () => {
    for (const [f, d] of [
      [196, 0],
      [233.08, 0.02],
      [293.66, 0.04],
      [369.99, 0.06],
    ])
      tone(f, f * 0.98, 1.6, "sawtooth", 0.035, d);
  },
  /** A word named: a bright chord. */
  win: () => {
    for (const [f, d] of [
      [523.25, 0],
      [659.25, 0.08],
      [783.99, 0.16],
      [1046.5, 0.26],
    ])
      tone(f, f, 0.7, "triangle", 0.12, d);
  },
  /** A wrong word: a sad trombone. */
  lose: () => {
    for (const [f, d] of [
      [392, 0],
      [369.99, 0.3],
      [349.23, 0.6],
    ])
      tone(f, f, 0.32, "sawtooth", 0.05, d);
    tone(329.63, 300, 0.9, "sawtooth", 0.05, 0.9);
  },
  /** A suspect joins: a camera's shutter and its flash charging. */
  pop: () => {
    burst(4200, 0.03, 0.5, 0, 3);
    burst(1800, 0.05, 0.35, 0.06, 2);
    tone(1800, 5200, 0.35, "sine", 0.03, 0.08);
  },
  /** A laser: a zap falling in pitch. */
  zap: () => {
    tone(2400, 300, 0.22, "sawtooth", 0.05);
    tone(1200, 160, 0.26, "square", 0.03);
    burst(6000, 0.05, 0.12);
  },
  /** A neon sign buzzing on: crackles over the mains hum. */
  neon: () => {
    for (const d of [0, 0.1, 0.16, 0.3]) burst(5200, 0.04, 0.3, d, 1.5);
    tone(120, 120, 0.9, "sawtooth", 0.04, 0.3);
    tone(240, 240, 0.9, "square", 0.015, 0.3);
  },
  /** The scanner's blip. */
  blip: () => tone(1320, 1320, 0.06, "sine", 0.05),
  /** Tiles powering on. */
  power: () => {
    tone(80, 420, 0.5, "sawtooth", 0.03);
    burst(3000, 0.4, 0.05, 0.05, 0.6);
  },
  /** The clock's last seconds. */
  tick: () => burst(2200, 0.03, 0.4, 0, 6),
  tock: () => burst(1500, 0.035, 0.4, 0, 6),
  /** A new scene: a swish. */
  swish: () => burst(2600, 0.3, 0.12, 0, 0.5),
};

// ---------------------------------------------------------------------------
// Scenes: built when the phase changes, updated on every view.

/**
 * @typedef {{ el: HTMLElement, update?: (view: any) => void, frame?: () => void, dispose?: () => void }} Scene
 */
/** @type {Scene | null} */
let scene = null;
let sceneKey = "";
/** @type {ReturnType<typeof setTimeout>[]} timers of the scene on screen */
let timers = [];
function later(/** @type {number} */ ms, /** @type {() => void} */ fn) {
  timers.push(setTimeout(fn, ms));
}

client.on("view", (view) => render(view));
client.on("status", (st) => {
  statusBar.hidden = st === "open";
  statusBar.textContent = st === "reconnecting" || st === "connecting" ? t.reconnecting : st === "closed" ? t.over : "";
});

/** @param {any} view */
function keyOf(view) {
  const sc = view.screen ?? {};
  if (sc.phase === "round" || sc.phase === "scores") return `${sc.phase}:${sc.round ?? ""}`;
  return String(sc.phase ?? "");
}

/** @param {any} view */
function render(view) {
  const sc = view.screen ?? {};
  const l = pickLang(sc.lang);
  const relang = l !== lang;
  if (relang) {
    lang = l;
    t = strings(l);
    document.documentElement.lang = l;
  }
  const key = keyOf(view);
  if (key !== sceneKey || relang) {
    if (sceneKey && key !== "lobby") sfx.swish();
    sceneKey = key;
    for (const x of timers) clearTimeout(x);
    timers = [];
    const old = scene;
    old?.dispose?.();
    if (old) {
      old.el.classList.add("leaving");
      setTimeout(() => old.el.remove(), 420);
    }
    scene = build(view);
    stage.append(scene.el);
  }
  scene?.update?.(view);
  // The join badge steps aside in the lobby, which shows the code big.
  client.joinVisible = sc.phase === "lobby" || !sc.phase;
}

function frame() {
  scene?.frame?.();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** @param {any} view @returns {Scene} */
function build(view) {
  const sc = view.screen ?? {};
  switch (sc.phase) {
    case "lobby":
      return lobby();
    case "round":
      return table(sc);
    case "scores":
      return scores(sc);
    case "final":
      return final(sc);
    default:
      return { el: h("div", { class: "scene lobby" }, logo()) };
  }
}

/** The neon sign: its F a tube that is going (it buzzes), a pair of eyes peering over it. */
function logo(small = false) {
  return h("div", { class: `logo${small ? " small" : ""}` }, h("span", { class: "wordmark" }, ...[..."SHIFTY"].map((c, i) => h("b", { class: i === 3 ? "bad" : "" }, c))), h("span", { class: "eyes" }, h("i"), h("i")));
}

/**
 * The clock: a stopwatch whose ring runs out, the seconds inside.
 * `set(f, ms)`: the share left and the time.
 */
function stopwatch() {
  const ring = s("circle", { class: "run", cx: 50, cy: 56, r: 36, pathLength: 100 });
  const el = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (s("svg", { viewBox: "0 0 100 100", class: "watch", "aria-hidden": "true" })));
  const secs = s("text", { x: 50, y: 63, "text-anchor": "middle", class: "secs" });
  ring.setAttribute("cy", "50");
  ring.setAttribute("r", "42");
  el.append(s("circle", { class: "face", cx: 50, cy: 50, r: 42 }), ring, secs);
  const box = h("div", { class: "clock" });
  box.append(el);
  let shown = -1;
  let ticked = -1;
  return {
    el: box,
    /** @param {number} f @param {number} ms @param {boolean} [sound] */
    set(f, ms, sound = true) {
      ring.setAttribute("stroke-dasharray", `${(Math.max(0, Math.min(1, f)) * 100).toFixed(2)} 100`);
      const n = Math.max(0, Math.ceil(ms / 1000));
      if (n === shown) return;
      shown = n;
      secs.textContent = String(n);
      box.classList.toggle("low", ms > 0 && ms <= 5000);
      if (sound && ms > 0 && n <= 5 && n !== ticked) {
        ticked = n;
        (n % 2 ? sfx.tick : sfx.tock)();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The lobby

/** @returns {Scene} */
function lobby() {
  const cards = h("div", { class: "mugs" });
  const count = h("small");
  const hint = h("p", { class: "hint" });
  const badges = h("div", { class: "badges" });
  const qr = h("div", { class: "qr" });
  const short = h("div", { class: "short" });
  const how = h(
    "div",
    { class: "how" },
    ...t.how.map(([b, x], i) => h("div", { class: "index", style: { "--k": ["var(--cyan)", "var(--amber)", "var(--red)"][i % 3], "--d": `${(0.5 + i * 0.15).toFixed(2)}s` } }, h("b", {}, h("i", {}, `${i + 1}`), h("em", { "data-fit": "1" }, b)), h("span", {}, x))),
  );
  // The ticker: twice the same run, scrolled by half, so it never ends.
  const tick = () => Array.from({ length: 4 }, () => [h("span", {}, t.suspects), h("b", {}, "●"), h("span", {}, t.scanToJoin), h("b", {}, "●"), h("span", {}, t.tickerLine), h("b", {}, "●")]).flat();
  // The viewfinder's timecode: the time the lobby has been up.
  const code = h("span");
  const born = performance.now();
  // The tagline's last sentence ("Except one.") in red.
  const [line1, ...rest] = t.tagline.split(/(?<=\.)\s+/);
  const el = h(
    "div",
    { class: "scene lobby" },
    h("div", { class: "ticker" }, h("div", { class: "run" }, ...tick(), ...tick())),
    h(
      "div",
      { class: "left" },
      logo(),
      h("p", { class: "tagline" }, line1 ?? "", rest.length ? h("br") : "", rest.length ? h("b", {}, rest.join(" ")) : ""),
      h("div", { class: "joinbox" }, h("div", { class: "finder" }, h("i"), h("i"), h("i"), h("i"), h("span", { class: "rec" }, h("i"), "REC", code), h("div", { class: "qrcard" }, qr)), h("div", { class: "joininfo" }, h("div", { class: "big" }, t.scanToJoin), short)),
    ),
    h("div", { class: "right" }, h("h2", {}, t.suspects, count), cards, hint, how, badges),
  );
  /** @type {Map<string, HTMLElement>} */
  const shown = new Map();
  let qrUrl = "";
  return {
    el,
    update(v) {
      const sc = v.screen ?? {};
      if (v.join?.url && v.join.url !== qrUrl) {
        qrUrl = v.join.url;
        qr.innerHTML = qrSvg(v.join.qr, { quiet: 2 });
      }
      const text = joinText(v.join) ?? "";
      const cut = text.lastIndexOf("/") + 1;
      short.replaceChildren(h("span", {}, text.slice(0, cut)), h("b", {}, text.slice(cut)));
      short.hidden = !text;
      const roster = /** @type {any[]} */ (v.roster ?? []);
      const max = sc.maxPlayers ?? 10;
      const min = sc.minPlayers ?? 3;
      count.textContent = `${roster.length} / ${max}`;
      /** @type {HTMLElement[]} */
      const kids = [];
      roster.forEach((r, i) => {
        let mug = shown.get(r.id);
        if (!mug) {
          // A mugshot: the camera's flash.
          const m = h("div", { class: "mug new" });
          mug = m;
          shown.set(r.id, m);
          later(900, () => m.classList.remove("new"));
          sfx.pop();
        }
        mug.replaceChildren(figure(r), h("div", { class: "plate" }, h("span", { "data-fit": "1" }, r.name), h("small", {}, `#${i + 1}`)), r.vip ? h("span", { class: "vip" }, "VIP") : "");
        mug.classList.toggle("away", !r.connected);
        kids.push(mug);
      });
      for (const id of [...shown.keys()]) if (!roster.some((r) => r.id === id)) shown.delete(id);
      for (let i = roster.length; i < Math.max(min, Math.min(5, max)); i++) {
        const label = i < min ? t.waitingSeat : t.freeSeat;
        kids.push(h("div", { class: "mug empty" }, h("span", {}, "?"), h("div", { class: "plate" }, h("span", {}, label))));
      }
      cards.replaceChildren(...kids);
      cards.classList.toggle("many", kids.length > 5);
      const ready = roster.filter((r) => r.connected).length;
      hint.textContent = ready < min ? t.needed(min - ready) : t.vipStarts(roster.find((r) => r.vip)?.name);
      hint.classList.toggle("ready", ready >= min);
      const b = [t.rounds(sc.rounds ?? 4), sc.mode === "spoken" ? t.spoken : t.typed, t.clueTime(sc.clueTime ?? 25), t.talkTime(sc.talkTime ?? 60), sc.typing === false ? t.typingOff : t.typingOn];
      const key = b.join("|");
      if (badges.dataset["k"] !== key) {
        badges.dataset["k"] = key;
        badges.replaceChildren(...b.map((x) => h("span", { class: "badge" }, x)));
      }
    },
    frame() {
      const sec = Math.floor((performance.now() - born) / 1000);
      const txt = [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map((x) => String(x).padStart(2, "0")).join(":");
      if (code.textContent !== txt) code.textContent = txt;
    },
  };
}

// ---------------------------------------------------------------------------
// The needle: drawn from a turn's typing log alone (docs/shifty-design.md §4)

/** A turn's typing: `keys` ([ms, letters, typed, deleted]), refusals (ms), its length (ms). */
/** @typedef {{ keys: number[][], refused: number[], ms: number }} Trace */

/** The pen's rest: a faint tremor, from the time alone (the same on every screen). @param {number} ms */
function tremor(ms) {
  return (Math.sin(ms * 0.031) + Math.sin(ms * 0.0547 + 1.3) * 0.7 + Math.sin(ms * 0.0113 + 0.4) * 0.5) / 2.2;
}

/**
 * Where the needle is at `ms` of a turn (−1.5 … 1.5, up is positive):
 * each typed key a spike that rings out, each deletion a deep kick down,
 * a refusal a big red kick; between them a tremor, or a flat line when
 * nothing was typed for a while; the last seconds (`shake`) more of it.
 * @param {number[][]} keys @param {number[]} refused @param {number} ms @param {number} shake 0–1
 */
function needleAt(keys, refused, ms, shake) {
  let v = 0;
  let pk = 0;
  let pd = 0;
  let last = -1e9;
  for (const [at = 0, , k = 0, d = 0] of keys) {
    const dk = k - pk;
    const dd = d - pd;
    pk = k;
    pd = d;
    if (at > ms) break;
    last = at;
    const dt = ms - at;
    if (dt > 700) continue;
    const env = Math.exp(-dt / 110);
    if (dk > 0) v += Math.min(1, 0.4 + 0.14 * dk) * Math.sin(dt / 16) * env;
    if (dd > 0) v -= Math.min(1.35, 0.75 + 0.2 * dd) * Math.abs(Math.sin(dt / 13 + 0.6)) * env;
  }
  for (const r of refused) {
    const dt = ms - r;
    if (dt >= 0 && dt < 900) v += 1.45 * Math.sin(dt / 20) * Math.exp(-dt / 230);
  }
  const idle = ms - Math.max(0, last);
  const rest = last < 0 && ms > 2500 ? 0.012 : idle > 2500 ? 0.012 : 0.06;
  return Math.max(-1.5, Math.min(1.5, v + tremor(ms) * (rest + shake * 0.18)));
}

/**
 * Draws a suspect's strip: one segment per clue (`passes`), each a
 * finished trace squeezed to its length, the live one up to `now` with
 * the pen's tip.
 * @param {HTMLCanvasElement} canvas
 * @param {(Trace | null)[]} segs
 * @param {{ pass: number, keys: number[][], refused: number[], start: number, end: number, now: number } | null} live
 * @param {string} color the suspect's colour (#rrggbb): the trace's phosphor
 */
function drawStrip(canvas, segs, live, color) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const hgt = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== hgt) {
    canvas.width = w;
    canvas.height = hgt;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, hgt);
  const n = Math.max(1, segs.length);
  const segW = w / n;
  const mid = hgt / 2;
  const amp = hgt * 0.32;
  const step = Math.max(1, Math.round(dpr * 1.5));
  for (let i = 0; i < n; i++) {
    const x0 = i * segW;
    if (i > 0) {
      ctx.strokeStyle = "rgba(46, 230, 255, .3)";
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0, hgt);
      ctx.stroke();
    }
    const isLive = live && live.pass === i + 1;
    const seg = isLive ? { keys: live.keys, refused: live.refused, ms: Math.max(1, live.end - live.start) } : segs[i];
    if (!seg) continue;
    const until = isLive ? Math.max(0, Math.min(seg.ms, live.now - live.start)) : seg.ms;
    const span = Math.max(1, seg.ms);
    const shakeFrom = isLive ? seg.ms - 5000 : Infinity;
    /** @type {[number, number, boolean][]} */
    const pts = [];
    for (let x = 0; x <= segW; x += step) {
      const ms = (x / segW) * span;
      if (ms > until) break;
      const shake = ms > shakeFrom ? (ms - shakeFrom) / 5000 : 0;
      const red = seg.refused.some((r) => ms >= r && ms - r < 900);
      pts.push([x0 + x, mid - needleAt(seg.keys, seg.refused, ms, shake) * amp, red]);
    }
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    // Phosphor: a wide faint pass for the glow, a thin bright one on it;
    // a refusal's stretch in red. One path per colour run.
    for (const [width, alpha] of [
      [5, 0.28],
      [1.7, 1],
    ]) {
      ctx.lineWidth = /** @type {number} */ (width) * dpr;
      ctx.globalAlpha = /** @type {number} */ (alpha);
      let j = 1;
      while (j < pts.length) {
        const red = /** @type {[number, number, boolean]} */ (pts[j])[2];
        ctx.strokeStyle = red ? "#ff2d55" : color;
        ctx.beginPath();
        const [ax, ay] = /** @type {[number, number, boolean]} */ (pts[j - 1]);
        ctx.moveTo(ax, ay);
        while (j < pts.length && /** @type {[number, number, boolean]} */ (pts[j])[2] === red) {
          const [bx, by] = /** @type {[number, number, boolean]} */ (pts[j]);
          ctx.lineTo(bx, by);
          j++;
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    if (isLive && pts.length > 0) {
      const [px, py] = /** @type {[number, number, boolean]} */ (pts[pts.length - 1]);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(px, py, 6 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(px, py, 2.4 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------------------
// A round: the line-up, the strips, the clue cards, the board

/**
 * @typedef {{ id: string, name: string, color: string, el: HTMLElement, fig: HTMLElement, plate: HTMLElement,
 *   canvas: HTMLCanvasElement, cards: HTMLElement, mark: HTMLElement, pts: HTMLElement, drawn: string, slots: Map<string, HTMLElement> }} Suspect
 */

/** @param {any} s0 @returns {Scene} */
function table(s0) {
  const suspects = /** @type {{ id: string, name: string, color: string }[]} */ (s0.suspects ?? []);
  const passes = Math.max(1, s0.passes ?? 1);
  const board = /** @type {string[]} */ (s0.board ?? []);
  const title = h("div", { class: "title", "data-fit": "1" });
  const sub = h("div", { class: "sub", "data-fit": "1" });
  const clock = stopwatch();
  const head = h("div", { class: "head" }, h("div", { class: "words" }, title, sub), clock.el);
  const top = h(
    "div",
    { class: "topline" },
    logo(true),
    h("span", { class: "chip" }, t.round(s0.round ?? 1, s0.rounds ?? 1)),
    h("span", { class: "chip cat" }, h("small", {}, t.category), h("span", { "data-fit": "1" }, s0.category ?? "")),
    head,
  );
  const chart = h("div", { class: "chart" }, ...[190, 180, 170, 160, 150].map((cm) => h("i", {}, h("span", {}, String(cm)))));
  // No needle when nothing is typed (out loud) or the room hides the typing.
  const beam = h("i", { class: "beam" });
  const lineup = h("div", { class: `lineup${s0.mode === "spoken" || s0.typing === false ? " nostrip" : ""}`, style: { "--n": String(suspects.length), "--passes": String(passes) } }, chart, beam);
  /** @type {Map<string, Suspect>} */
  const byId = new Map();
  suspects.forEach((who, i) => {
    const canvas = /** @type {HTMLCanvasElement} */ (h("canvas"));
    const fig = h("div", { class: "figwrap" }, figure(who));
    const mark = h("span", { class: "mark" }, t.accusedMark);
    const pts = h("span", { class: "pts" });
    const plate = h("div", { class: "plate" }, h("span", { class: "nm", "data-fit": "1" }, who.name), h("small", {}, `#${i + 1}`));
    const cards = h("div", { class: "cards" });
    const el = h("div", { class: "suspect", style: { "--c": colorOf(who) } }, fig, mark, pts, plate, h("div", { class: "strip" }, canvas), cards);
    lineup.append(el);
    byId.set(who.id, { ...who, el, fig, plate, canvas, cards, mark, pts, drawn: "", slots: new Map() });
  });
  // The tiles power on in a diagonal wave from the top left (--d: row + column).
  const words = board.map((w, i) => h("div", { class: "word", style: { "--d": String((i % 4) + Math.floor(i / 4)) } }, h("span", { "data-fit": "1" }, w)));
  const sweep = h("i", { class: "sweep" });
  const boardEl = h("div", { class: "board", "data-label": t.boardLabel }, h("div", { class: "grid" }, ...words, sweep));
  const overlay = /** @type {SVGSVGElement} */ (/** @type {unknown} */ (s("svg", { class: "overlay" })));
  const stamp = h("div", { class: "stamp", hidden: true });
  const flash = h("i", { class: "flash" });
  // The rig holds everything that shakes with a verdict (the scene itself animates its entrance).
  const rig = h("div", { class: "rig" }, top, lineup, boardEl, overlay, stamp);
  const el = h("div", { class: "scene table" }, rig, flash);
  later(200, sfx.power);
  for (let d = 0; d < 7; d++) later(280 + d * 70, sfx.flick);
  later(1500, sfx.blip);

  /** The room's colour flashing from a point, and the rig shaking. @param {number[]} p @param {string} color @param {boolean} [quake] */
  function bang(p, color, quake = false) {
    const b = el.getBoundingClientRect();
    flash.style.setProperty("--fx", `${(((p[0] ?? 0) / Math.max(1, b.width)) * 100).toFixed(1)}%`);
    flash.style.setProperty("--fy", `${(((p[1] ?? 0) / Math.max(1, b.height)) * 100).toFixed(1)}%`);
    flash.style.setProperty("--fc", color);
    flash.classList.remove("go");
    void flash.offsetWidth;
    flash.classList.add("go");
    if (quake && !reduced.matches) {
      rig.classList.remove("quake");
      void rig.offsetWidth;
      rig.classList.add("quake");
    }
  }

  /** The searchlight on a suspect (or off), red for a phony. @param {Suspect | undefined} who @param {boolean} [red] */
  function spot(who, red = false) {
    beam.classList.toggle("on", !!who);
    beam.classList.toggle("red", red);
    if (!who) return;
    const a = who.el.getBoundingClientRect();
    const b = lineup.getBoundingClientRect();
    beam.style.setProperty("--x", `${(a.left - b.left + a.width / 2).toFixed(1)}px`);
  }

  let stageNow = "";
  /** @type {any} */
  let last = s0;
  let turnKey = "";
  let lastKeys = 0;
  let refusedN = 0;
  let accusedN = 0;
  let scanTimer = 0;
  let scanAt = -1;
  let belled = "";

  /**
   * The clue cards of a suspect: what came, the one being typed (tiles),
   * the ones to come. A card stays the same element while it shows the
   * same thing (a sent clue is not built again with every key of the
   * next one, so it keeps its fitted font and its animation runs once);
   * the one being typed gains and loses tiles one by one.
   * @param {any} sc @param {Suspect} who
   */
  function cardsOf(sc, who) {
    const clues = /** @type {any[]} */ (sc.clues?.[who.id] ?? []);
    const turn = sc.turn && !sc.turn.done && sc.stage === "clue" && sc.turn.id === who.id && !sc.turn.skipped ? sc.turn : null;
    const n = turn ? (turn.keys?.at(-1)?.[1] ?? 0) : 0;
    const key = JSON.stringify([clues, turn ? [turn.key, sc.typing !== false ? n : -1, sc.mode] : null]);
    if (who.drawn === key) return;
    const fresh = who.drawn !== "" && clues.length > (JSON.parse(who.drawn)[0]?.length ?? 0);
    who.drawn = key;
    /** @type {Map<string, HTMLElement>} */
    const slots = new Map();
    /** The card for a slot: the one shown before when it is the same, else a new one. @param {string} id @param {() => HTMLElement} make */
    const slot = (id, make) => {
      const el = who.slots.get(id) ?? make();
      slots.set(id, el);
      return el;
    };
    /** @type {HTMLElement[]} */
    const kids = [];
    for (let p = 0; p < passes; p++) {
      const c = clues[p];
      if (c) {
        const text = c.away ? t.awayCard : c.text ? c.text : c.spoken ? "🗣" : t.silent;
        const cls = `clue${c.text ? "" : " none"}${fresh && p === clues.length - 1 ? " flip" : ""}`;
        kids.push(slot(`${p}|clue|${text}`, () => h("div", { class: cls }, h("span", { "data-fit": "1" }, text))));
      } else if (turn && p === clues.length) {
        const mode = sc.mode === "spoken" ? "say" : sc.typing === false ? "dots" : "tiles";
        const card = slot(`${p}|${turn.key}|${mode}`, () => {
          const tiles = h("div", { class: "tiles" });
          if (mode === "say") tiles.append(h("span", { class: "say" }, "🗣"));
          else if (mode === "dots") tiles.append(h("span", { class: "dots" }, h("i"), h("i"), h("i")));
          return h("div", { class: "clue pending" }, tiles);
        });
        if (mode === "tiles") {
          const tiles = /** @type {HTMLElement} */ (card.firstElementChild);
          const want = Math.min(n, 24);
          while (tiles.childElementCount > want) tiles.lastElementChild?.remove();
          while (tiles.childElementCount < want) tiles.append(h("i"));
        }
        kids.push(card);
      } else kids.push(slot(`${p}|empty`, () => h("div", { class: "clue empty" })));
    }
    who.slots = slots;
    if (kids.length !== who.cards.childElementCount || kids.some((k, i) => who.cards.children[i] !== k)) who.cards.replaceChildren(...kids);
  }

  /** The strips' finished traces (the live one is drawn every frame). @param {any} sc */
  function strips(sc) {
    for (const who of byId.values()) {
      const tr = /** @type {Trace[]} */ (sc.traces?.[who.id] ?? []);
      const segs = Array.from({ length: passes }, (_, i) => tr[i] ?? null);
      const live = sc.stage === "clue" && sc.turn && !sc.turn.done && sc.turn.id === who.id && sc.mode !== "spoken" ? sc.turn : null;
      if (!live) drawStrip(who.canvas, segs, null, colorOf(who));
    }
  }

  /** The stage's headline and spotlights. @param {any} sc */
  function headline(sc) {
    const before = title.textContent;
    later(0, () => {
      if (title.textContent === before) return;
      title.classList.remove("swap");
      void title.offsetWidth;
      title.classList.add("swap");
    });
    const turnWho = sc.turn ? byId.get(sc.turn.id) : undefined;
    const phony = sc.phony ? byId.get(sc.phony.id) : undefined;
    let lit = /** @type {string | null} */ (null);
    switch (sc.stage) {
      case "deal":
        title.textContent = t.dealTitle;
        sub.textContent = t.dealHelp;
        break;
      case "clue":
        if (sc.turn?.skipped) {
          title.textContent = t.away(turnWho?.name ?? "");
          sub.textContent = t.turnOf(sc.turn.index ?? 1, sc.turn.of ?? 1);
        } else {
          title.textContent = sc.mode === "spoken" ? t.sayIt(turnWho?.name ?? "") : t.typing(turnWho?.name ?? "");
          sub.textContent = `${t.turnOf(sc.turn?.index ?? 1, sc.turn?.of ?? 1)} · ${sc.mode === "spoken" ? t.sayHelp : t.clueHelp}`;
        }
        lit = sc.turn?.id ?? null;
        break;
      case "accuse":
        title.textContent = t.accuseTitle;
        sub.textContent = t.accused((sc.accused ?? []).length, suspects.length);
        break;
      case "verdict":
        title.textContent = t.verdictTitle;
        sub.textContent = "";
        break;
      case "last":
        title.textContent = t.lastTitle(sc.phony?.name ?? "");
        sub.textContent = t.lastHelp;
        lit = sc.phony?.id ?? null;
        break;
      case "reveal":
        title.textContent = sc.named ? t.named : sc.pick === null || sc.pick === undefined ? t.noPick : t.missed;
        sub.textContent = sc.caught ? t.caught : t.phonyWas(sc.phony?.name ?? "");
        lit = sc.phony?.id ?? null;
        break;
      case "gone":
        title.textContent = t.goneTitle;
        sub.textContent = t.goneHelp;
        break;
    }
    for (const who of byId.values()) {
      who.el.classList.toggle("lit", lit === who.id);
      who.el.classList.toggle("dim", lit !== null && lit !== who.id);
    }
    el.classList.toggle("spot", lit !== null);
    spot(lit ? byId.get(lit) : undefined, (sc.stage === "last" || sc.stage === "reveal") && !!phony);
  }

  /** A point on the stage, from an element's box. @param {Element} e @param {number} fx @param {number} fy */
  function at(e, fx, fy) {
    const a = e.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return [a.left - b.left + a.width * fx, a.top - b.top + a.height * fy];
  }

  /**
   * A beam from one point to another, bowed a little, drawn in: a laser
   * (`red`), a thread of light with pulses running along it (`gold`) or
   * one that fizzles out (`loose`).
   * @param {number[]} a @param {number[]} b @param {string} cls
   */
  function string(a, b, cls) {
    const [ax = 0, ay = 0] = a;
    const [bx = 0, by = 0] = b;
    const mx = (ax + bx) / 2;
    const my = Math.max(ay, by) + Math.min(80, Math.abs(bx - ax) * 0.12) + 10;
    const d = `M${ax} ${ay}Q${mx} ${my} ${bx} ${by}`;
    if (cls !== "loose") overlay.append(s("path", { d, class: `${cls}-glow`, pathLength: 100 }));
    const p = s("path", { d, class: cls, pathLength: 100 });
    overlay.append(p, s("circle", { cx: ax, cy: ay, r: 4, class: `pin ${cls}` }), s("circle", { cx: bx, cy: by, r: 4, class: `pin ${cls}` }));
    if (cls === "gold") overlay.append(s("path", { d, class: "pulse", pathLength: 100 }));
    if (cls === "red") later(300, () => overlay.append(s("circle", { cx: bx, cy: by, r: 14, class: "ring" })));
    return p;
  }

  /** The verdict: red lasers one by one, the counts, the neon sign; the searchlight swinging to a phony who was not caught. @param {any} sc */
  function verdict(sc) {
    const votes = /** @type {[string, string][]} */ (sc.votes ?? []);
    overlay.replaceChildren();
    const step = 750;
    sfx.roll(900 + votes.length * step);
    votes.forEach(([from, to], i) => {
      later(900 + i * step, () => {
        const a = byId.get(from);
        const b = byId.get(to);
        if (!a || !b) return;
        string(at(a.plate, 0.5, 1), at(b.fig, 0.5, 0.35), "red");
        sfx.zap();
        later(300, () => {
          b.fig.classList.remove("jolt");
          void b.fig.offsetWidth;
          b.fig.classList.add("jolt");
        });
        const n = votes.slice(0, i + 1).filter(([, x]) => x === to).length;
        b.pts.textContent = `×${n}`;
        b.pts.className = "pts count show";
        void b.pts.offsetWidth;
        b.pts.classList.add("bump");
      });
    });
    const after = 900 + votes.length * step + 900;
    later(after, () => {
      const top = sc.top ? byId.get(sc.top) : undefined;
      for (const who of byId.values()) {
        who.el.classList.toggle("lit", who === top);
        who.el.classList.toggle("dim", !!top && who !== top);
      }
      el.classList.toggle("spot", !!top);
      spot(top, !!sc.caught);
      if (top) {
        const [x, y] = at(top.fig, 0.5, 0.45);
        stamp.textContent = sc.caught ? t.phonyStamp : t.innocentStamp;
        stamp.className = `stamp ${sc.caught ? "guilty" : "clear"}`;
        stamp.hidden = false;
        // On the screen, also on the first or the last suspect (a tilted sign is wider than it looks).
        const half = (stamp.offsetWidth * Math.cos(0.1) + stamp.offsetHeight * Math.sin(0.1)) / 2 + 12;
        const w = el.getBoundingClientRect().width;
        stamp.style.left = `${Math.max(half, Math.min(w - half, x))}px`;
        stamp.style.top = `${y}px`;
        sfx.neon();
        sfx.thud();
        bang([x, y], sc.caught ? "rgba(255, 45, 85, .6)" : "rgba(46, 230, 255, .45)", true);
        if (sc.caught) later(250, sfx.sting);
        title.textContent = sc.caught ? t.caught : t.innocentStamp;
      } else {
        title.textContent = t.nobodySure;
        sfx.lose();
      }
    });
    if (!sc.caught) {
      later(after + 1800, () => {
        const p = sc.phony ? byId.get(sc.phony.id) : undefined;
        for (const who of byId.values()) {
          who.el.classList.toggle("lit", who === p);
          who.el.classList.toggle("dim", !!p && who !== p);
        }
        el.classList.add("spot");
        el.classList.add("swing");
        // The searchlight swings over to the one who got away, red.
        spot(p, true);
        if (p) bang(at(p.fig, 0.5, 0.4), "rgba(255, 45, 85, .4)");
        title.textContent = t.phonyWas(sc.phony?.name ?? "");
        sfx.sting();
      });
    }
  }

  /** The last chance: the scanner hops over the board until the pick comes. */
  function scanner() {
    clearInterval(scanTimer);
    boardEl.classList.add("scanning");
    scanTimer = window.setInterval(() => {
      if (reduced.matches) return;
      let next = Math.floor(Math.random() * words.length);
      if (next === scanAt) next = (next + 1) % words.length;
      scanAt = next;
      words.forEach((w, i) => w.classList.toggle("scanned", i === next));
      sfx.blip();
    }, 420);
  }

  /** The reveal: the pick, the word, the threads from every clue to it, the points. @param {any} sc */
  function reveal(sc) {
    clearInterval(scanTimer);
    boardEl.classList.remove("scanning");
    for (const w of words) w.classList.remove("scanned");
    stamp.hidden = true;
    overlay.replaceChildren();
    for (const who of byId.values()) who.pts.className = "pts";
    const secret = words[sc.secret ?? -1];
    const pick = sc.pick === null || sc.pick === undefined ? undefined : words[sc.pick];
    if (pick) {
      pick.classList.add("picked");
      pick.dataset["who"] = t.pickOf(sc.phony?.name ?? "");
      sfx.thud();
    }
    later(pick ? 1300 : 300, () => {
      secret?.classList.add("secret");
      if (secret) {
        secret.dataset["label"] = t.theWord;
        if (!secret.querySelector(".rays")) secret.prepend(h("i", { class: "rays" }));
        for (const w of words) w.classList.toggle("dim", w !== secret && w !== pick);
        bang(at(secret, 0.5, 0.5), "rgba(255, 194, 61, .45)");
      }
      if (sc.stage === "reveal") (sc.named ? sfx.win : sfx.lose)();
      else sfx.sting();
    });
    if (!secret) return;
    // The threads: from every clue card to the word; the phony's hang loose.
    later(pick ? 2200 : 1200, () => {
      let i = 0;
      for (const who of byId.values()) {
        const isPhony = who.id === sc.phony?.id;
        for (const card of who.cards.querySelectorAll(".clue:not(.empty)")) {
          const a = at(card, 0.5, 0.92);
          const k = i++;
          later(k * 110, () => {
            if (isPhony) {
              const [ax = 0, ay = 0] = a;
              string(a, [ax + (jitter(who.id) * 40 || 20), ay + 70], "loose");
            } else string(a, at(secret, 0.5, 0.1), "gold");
          });
        }
      }
    });
    later(pick ? 3200 : 2200, () => {
      for (const who of byId.values()) {
        const n = sc.earned?.[who.id] ?? 0;
        who.pts.textContent = n > 0 ? `+${n}` : "";
        who.pts.className = `pts${n > 0 ? " show" : ""}`;
      }
    });
  }

  return {
    el,
    update(v) {
      const sc = v.screen ?? {};
      last = sc;
      for (const who of byId.values()) cardsOf(sc, who);
      const stageNew = sc.stage ?? "";
      const turnNew = sc.turn?.key ?? "";
      if (stageNew !== stageNow || turnNew !== turnKey) {
        headline(sc);
        strips(sc);
        if (turnNew !== turnKey && stageNew === "clue") {
          lastKeys = 0;
          refusedN = 0;
        }
        if (stageNew === "verdict" && stageNow !== "verdict") later(50, () => verdict(sc));
        if (stageNew === "last" && stageNow !== "last") {
          overlay.replaceChildren();
          stamp.hidden = true;
          el.classList.remove("swing");
          for (const who of byId.values()) who.pts.className = "pts";
          scanner();
        }
        if ((stageNew === "reveal" || stageNew === "gone") && stageNow !== stageNew) later(50, () => reveal(sc));
        if (stageNew !== "clue") hum.off();
        stageNow = stageNew;
        turnKey = turnNew;
      }
      if (stageNew !== "accuse") for (const who of byId.values()) who.mark.classList.remove("on");
      if (stageNew === "accuse") {
        const set = new Set(/** @type {string[]} */ (sc.accused ?? []));
        for (const who of byId.values()) who.mark.classList.toggle("on", set.has(who.id));
        if (set.size > accusedN) sfx.flick();
        accusedN = set.size;
        sub.textContent = t.accused(set.size, suspects.length);
      }
      if (stageNew === "clue" && sc.turn) {
        const keys = /** @type {number[][]} */ (sc.turn.keys ?? []);
        // A sound per change: the typewriter's key, or its backspace.
        if (keys.length > lastKeys && sc.typing !== false) {
          const prev = keys[lastKeys - 1] ?? [0, 0, 0, 0];
          const cur = keys[keys.length - 1] ?? prev;
          const typed = (cur[2] ?? 0) - (prev[2] ?? 0);
          const deleted = (cur[3] ?? 0) - (prev[3] ?? 0);
          for (let i = 0; i < Math.min(4, typed); i++) later(i * 45, sfx.clack);
          for (let i = 0; i < Math.min(3, deleted); i++) later(i * 50, sfx.back);
          // A deletion makes the suspect flinch.
          const who = deleted > 0 ? byId.get(sc.turn.id) : undefined;
          if (who && !reduced.matches) {
            who.fig.classList.remove("jolt");
            void who.fig.offsetWidth;
            who.fig.classList.add("jolt");
          }
        }
        lastKeys = keys.length;
        const refused = (sc.turn.refused ?? []).length;
        if (refused > refusedN) sfx.buzz();
        refusedN = refused;
        if (sc.turn.done && belled !== sc.turn.key) {
          belled = sc.turn.key;
          const c = sc.clues?.[sc.turn.id]?.at(-1);
          if (c?.text || c?.spoken) sfx.bell();
          hum.off();
          strips(sc);
        }
      }
    },
    frame() {
      const sc = last;
      if (sc.stage === "clue" && sc.turn && !sc.turn.done && !sc.turn.skipped) {
        const ms = left(sc.turn.end ?? 0);
        clock.el.hidden = false;
        clock.set(ms / Math.max(1, (sc.turn.end ?? 0) - (sc.turn.start ?? 0)), ms);
        const who = byId.get(sc.turn.id);
        if (who && sc.mode !== "spoken") {
          const tr = /** @type {Trace[]} */ (sc.traces?.[who.id] ?? []);
          const segs = Array.from({ length: passes }, (_, i) => tr[i] ?? null);
          const now = client.now();
          drawStrip(who.canvas, segs, { pass: sc.turn.pass ?? 1, keys: sc.turn.keys ?? [], refused: sc.turn.refused ?? [], start: sc.turn.start ?? now, end: sc.turn.end ?? now, now }, colorOf(who));
          if (sc.typing !== false) {
            const v = Math.abs(needleAt(sc.turn.keys ?? [], sc.turn.refused ?? [], now - (sc.turn.start ?? now), 0));
            hum.set(Math.min(1, v));
          }
        }
      } else if ((sc.stage === "accuse" || sc.stage === "last") && sc.deadline) {
        const ms = left(sc.deadline);
        clock.el.hidden = false;
        clock.set(ms / Math.max(1, sc.duration ?? 60_000), ms);
      } else clock.el.hidden = true;
    },
    dispose() {
      clearInterval(scanTimer);
      hum.off();
    },
  };
}

// ---------------------------------------------------------------------------
// Scores and the end

/** @param {HTMLElement} el @param {number} from @param {number} to @param {number} delay */
function countUp(el, from, to, delay) {
  el.textContent = t.n(from);
  if (from === to) return;
  later(delay, () => {
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / 700);
      el.textContent = t.n(Math.round(from + (to - from) * p));
      if (p < 1 && el.isConnected) requestAnimationFrame(step);
    };
    step();
  });
}

/** @param {any} sc @returns {Scene} */
function scores(sc) {
  const lines = /** @type {any[]} */ (sc.lines ?? []);
  const board = h("div", { class: `ranks${lines.length > 6 ? " many" : ""}` });
  const top = Math.max(1, ...lines.map((l) => l.score ?? 0));
  let rank = 0;
  let prev = Number.NaN;
  lines.forEach((l, i) => {
    if (l.score !== prev) rank = i + 1;
    prev = l.score;
    const pts = h("b");
    const e = l.earned ?? {};
    const gains = /** @type {const} */ (["accuse", "team", "escape", "word"]).filter((k) => e[k] > 0).map((k) => h("span", { class: `gain ${k}` }, `${t.kinds[k]} +${t.n(e[k])}`));
    const bar = h("i", { class: "bar", style: { "--c": colorOf(l), "--w": `${((l.score - (l.delta ?? 0)) / top) * 100}%` } });
    board.append(h("div", { class: "row", style: { "--d": `${(0.1 + i * 0.08).toFixed(2)}s` } }, h("span", { class: "rk" }, String(rank)), avatar(l, "4.6rem"), h("span", { class: "nm", "data-fit": "1" }, l.name), h("span", { class: "mid" }, bar, h("span", { class: "gains" }, ...gains)), h("span", { class: "pt" }, pts)));
    countUp(pts, l.score - (l.delta ?? 0), l.score, 700 + i * 80);
    later(700 + i * 80, () => bar.style.setProperty("--w", `${(l.score / top) * 100}%`));
    if ((l.delta ?? 0) > 0) later(700 + i * 80, sfx.blip);
  });
  later(700, sfx.flick);
  const el = h("div", { class: "scene scores" }, h("div", { class: "topline" }, logo(true), h("span", { class: "chip" }, t.round(sc.round ?? 1, sc.rounds ?? 1))), h("h1", {}, t.scoresTitle, h("small", {}, t.scoresAfter(sc.round ?? 1, sc.rounds ?? 1))), board);
  return { el };
}

/** @param {any} sc @returns {Scene} */
function final(sc) {
  const lines = /** @type {any[]} */ (sc.lines ?? []);
  const order = [1, 0, 2].filter((i) => lines[i]);
  const podium = h(
    "div",
    { class: "podium" },
    ...order.map((i) => {
      const l = lines[i];
      return h("div", { class: `step p${i + 1}`, style: { "--d": `${[1.5, 0.9, 0.3][i]}s` } }, h("div", { class: "figwrap" }, figure(l)), h("div", { class: "plate" }, h("span", { "data-fit": "1" }, l.name)), h("div", { class: "block" }, h("b", {}, String(i + 1)), h("span", {}, t.points(l.score ?? 0))));
    }),
  );
  const rest = h("div", { class: "rest" }, ...lines.slice(3).map((l, i) => h("span", {}, `${t.n(i + 4)}. ${l.name} · ${t.n(l.score)}`)));
  const awards = sc.awards ?? {};
  const cards = /** @type {const} */ (["liar", "eye", "hand"])
    .filter((k) => awards[k])
    .map((k, i) => {
      const a = awards[k];
      const [label, line] = t.awards[k];
      return h("div", { class: `award ${k}`, style: { "--d": `${2.2 + i * 0.5}s` } }, h("small", {}, label), avatar(a.who, "4.4rem"), h("b", { "data-fit": "1" }, a.who?.name ?? ""), h("span", {}, line(a.n ?? 0)));
    });
  const lights = h("div", { class: "lights" }, h("i"), h("i"), h("i"));
  const el = h("div", { class: "scene final" }, lights, h("div", { class: "main" }, h("h1", {}, t.gameOver), podium, rest, h("div", { class: "again" }, t.playAgain)), h("div", { class: "awards" }, ...cards));
  later(300, () => sfx.roll(1400));
  later(1800, sfx.win);
  for (let i = 0; i < cards.length; i++) later(2200 + i * 500, sfx.neon);
  return { el };
}

watchFit();

client.connect().catch((e) => {
  stage.replaceChildren(h("div", { class: "scene lobby" }, logo(), h("p", { class: "hint" }, e?.message ?? String(e))));
});
