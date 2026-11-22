// @ts-check
/**
 * The look, previewed (not part of dist): a sample estate
 * (`fixture.ts`) drawn by phone/draw.js as the TV's blueprint with a
 * public layer, a phone's seen view, the tape's full colour, a prop
 * sheet, the intertitle. `shots.ts` screenshots it.
 *
 *   index.html?view=tv|phone|tape|props|card&sample=5-1&t=3
 */

import {
  createArt, createMemory, decoCard, drawBlueprint, drawFigure, drawLootIcon, drawPropAlone, drawPublic, drawTrail, drawWorld,
  fitCanvas, fitView, followView, GUARD_COLOURS, sunburst, useTiles,
} from "../../phone/draw.js";

const q = new URLSearchParams(location.search);
const view = q.get("view") ?? "tv";
const sampleName = q.get("sample") ?? "5-1";
const T0 = Number(q.get("t") ?? 3);
const dpr = Math.min(3, devicePixelRatio || 1);

/** @param {any} m */
function blueprint(m) {
  return {
    ...m,
    tiles: Uint8Array.from(m.tiles),
    floors: Uint8Array.from(m.floors),
    roomAt: Int16Array.from(m.roomAt),
    areaAt: Int16Array.from(m.areaAt),
    doorAt: Int16Array.from(m.doorAt),
    windowAt: Int16Array.from(m.windowAt),
  };
}

const sample = await (await fetch(`sample-${sampleName}.json`)).json();
const map = blueprint(sample.map);
await document.fonts.load('20px "Limelight"');
await document.fonts.load('600 20px "Josefin Sans"');
await document.fonts.load('700 20px "Courier Prime"');
await document.fonts.ready;
const art = createArt(map);
if (!art) throw new Error("no art");

const names = ["Ben", "Clara", "Dot", "Eddie", "Flo", "Gus", "Hattie"];
const now = sample.now;

const ids = ["ben", "clara", "dot", "eddie"];
/** @type {Record<string, string>} */
const colors = Object.fromEntries(ids.map((id, k) => [id, GUARD_COLOURS[k] ?? "#fff"]));
colors["anna"] = "#222222";
/** @type {Record<string, string>} */
const playerNames = { ben: "Ben", clara: "Clara", dot: "Dot", eddie: "Eddie", anna: "Anna" };
/** The night's catalogue (views.ts CatalogueEntry) from the sample's loot. */
const catalogue = sample.loot.map((/** @type {any} */ it) => ({ id: it.icon, size: it.large ? "large" : "small", tagged: it.tagged, value: 1000 }));

/** A public layer (protocol.ts PublicState) at heist time `t`. @returns {import("../../phone/draw.js").PublicLike} */
function publicLayer(/** @type {number} */ t) {
  const vault = map.rooms.find((/** @type {any} */ r) => r.kind === "vault");
  const gallery = map.rooms.find((/** @type {any} */ r) => r.kind === "gallery" || r.kind === "library") ?? map.rooms[2];
  const gate = map.gates[0];
  const spot = map.spots[1] ?? map.spots[0];
  const cam0 = map.cameras[0];
  const cam1 = map.cameras[1];
  const cleared = map.rooms[sample.cleared];
  const sp = map.spots[2] ?? map.spots[0];
  return {
    t,
    rooms: sample.rooms,
    lamps: sample.lamps,
    ink: sample.ink,
    cameras: [
      ...(cam0 ? [{ id: cam0.id, tampered: false, sees: { x: cam0.x + 0.5 + Math.cos((cam0.angle * Math.PI) / 180) * 4, y: cam0.y + 0.5 + Math.sin((cam0.angle * Math.PI) / 180) * 4, facing: cam0.angle + 160 } }] : []),
      ...(cam1 ? [{ id: cam1.id, tampered: true, sees: null }] : []),
    ],
    noises: [{ id: 1, kind: "glass", x: gallery.rect.x + 1.5, y: gallery.rect.y + 1.5, t: t - 0.8 }],
    alarm: vault ? { t: t - 2, room: vault.id, x: vault.rect.x + 1, y: vault.rect.y + 1 } : null,
    missing: [{ item: 3, room: gallery.id, x: sample.loot[3].x, y: sample.loot[3].y, t: t - 30 }],
    pings: [{ x: sp.rect.x + 6, y: sp.rect.y + 6, r: 3, t: t - 1.2 }],
    holds: q.get("held") === "1" || view === "tv" ? [{ guard: "ben", thief: "anna", x: sample.thief.x, y: sample.thief.y, t: t - 3.8, until: t + 6.2, total: 10 }] : [],
    marks: [
      { id: 1, guard: "ben", kind: "clear", x: cleared.rect.x + cleared.rect.w / 2, y: cleared.rect.y + cleared.rect.h / 2, where: { room: cleared.id }, t: t - 24 },
      { id: 2, guard: "clara", kind: "seen", x: spot.rect.x + 1, y: spot.rect.y + 4, angle: 300, where: { area: 0 }, t: t - 41 },
      { id: 3, guard: "dot", kind: "post", x: (gate?.rect.x ?? 10) + 0.5, y: (gate?.rect.y ?? 10) + 0.5, where: { gate: 0 }, t: t - 3 },
      { id: 4, guard: "eddie", kind: "look", x: gallery.rect.x + gallery.rect.w / 2, y: gallery.rect.y + gallery.rect.h / 2, where: { room: gallery.id }, t: t - 70 },
    ],
    arrest: null,
  };
}

/** Players as a Frame's `others` (protocol.ts SeenPlayer), and one's own figure. */
function figures(/** @type {number} */ t, /** @type {boolean} */ held) {
  /** @type {import("../../phone/draw.js").Figure[]} */
  const f = [
    { id: "ben", role: "guard", x: sample.guard.x, y: sample.guard.y, facing: sample.guard.facing, light: q.get("scene") !== "lit", moving: !held, held, holding: held, self: view === "phone" },
    { id: "anna", role: "thief", x: sample.thief.x, y: sample.thief.y, facing: sample.thief.facing, sack: 3, moving: !held, light: false, held },
    { id: "clara", role: "guard", x: sample.guard.x - 1.3, y: sample.guard.y + 1.1, facing: 30, light: false, moving: true, held: false },
  ];
  return f;
}

/** The sample's loot as a Frame's `items` / `empty` on the tiles `on` lets through. */
function seenLoot(/** @type {(i: number) => boolean} */ on) {
  /** @type {import("../../game/protocol.ts").SeenItem[]} */
  const items = [];
  /** @type {import("../../game/protocol.ts").SeenEmpty[]} */
  const empty = [];
  sample.loot.forEach((/** @type {any} */ it, /** @type {number} */ k) => {
    if (!on(it.y * map.w + it.x)) return;
    if (it.empty) empty.push({ item: k, x: it.x, y: it.y, keep: it.keep });
    else items.push({ item: k, x: it.x, y: it.y, keep: it.keep, tagged: it.tagged });
  });
  return { items, empty };
}

function render(/** @type {number} */ t) {
  if (view === "tv") return tv(t);
  if (view === "phone") return phone(t);
  if (view === "tape") return tape(t);
  if (view === "props") return props();
  if (view === "card") return card();
}

let tvBuilt = false;
function tv(/** @type {number} */ t) {
  if (!tvBuilt) {
    tvBuilt = true;
    document.body.innerHTML = `
      <div class="tv">
        <div class="tv-top"><span class="logo">Pinch</span><span class="who"><b>Anna</b> is the thief · The Van Doren Estate</span>
          <span class="alarm">ALARM 1:00</span><span class="clock">2:41</span></div>
        <div class="tv-cat"><h2>CATALOGUE</h2><div id="cat"></div></div>
        <div class="tv-map"><canvas id="map"></canvas></div>
        <div class="tv-ticker"><span>2:20 ALARM: THE VAULT</span><span>2:31 CAMERA 1: A STRIPED JERSEY</span><span class="claim" style="color:#8a6a00">Ben: the foyer is clear. Ben seems sure.</span></div>
      </div>`;
    const cat = /** @type {HTMLElement} */ (document.getElementById("cat"));
    sample.loot.slice(0, 12).forEach((/** @type {any} */ it, /** @type {number} */ k) => {
      const row = document.createElement("div");
      row.className = `item${k === 3 ? " gone" : ""}`;
      const cv = document.createElement("canvas");
      const c = fitCanvas(cv, 30, 30, dpr);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawLootIcon(c, it.icon, 15, 15, 26, { tagged: it.tagged, grey: k === 3 });
      row.append(cv);
      const name = document.createElement("span");
      name.textContent = it.icon.replace(/-/g, " ").replace(/\b\w/g, (/** @type {string} */ s) => s.toUpperCase());
      const v = document.createElement("span");
      v.className = "v";
      v.textContent = `$${(((k * 7919) % 20) + 1) * 400}`;
      row.append(name, v);
      if (k === 3) {
        const room = document.createElement("span");
        room.className = "room";
        room.textContent = "✗ missing · the library";
        row.append(room);
      }
      cat.append(row);
    });
  }
  const cv = /** @type {HTMLCanvasElement} */ (document.getElementById("map"));
  const box = /** @type {HTMLElement} */ (cv.parentElement).getBoundingClientRect();
  const c = fitCanvas(cv, box.width, box.height, dpr);
  const v = fitView(map, box.width, box.height, dpr, { pad: 6 });
  drawBlueprint(c, art, v);
  drawPublic(c, art, v, publicLayer(now + t), { colors, names: playerNames });
}

function phone(/** @type {number} */ t) {
  if (!document.getElementById("map")) {
    document.body.innerHTML = `
      <div class="phone"><canvas id="map"></canvas>
        <div class="ph-top"><span class="clock">2:41</span><span class="role">Security</span><span class="slots"><span></span><span></span><span></span></span></div>
        <div class="ph-bottom"><button class="deco-btn">Lamp</button><button class="deco-btn deco-btn-big">HOLD</button><button class="deco-btn">Switch</button></div>
      </div>`;
  }
  const cv = /** @type {HTMLCanvasElement} */ (document.getElementById("map"));
  const w = innerWidth;
  const h = innerHeight;
  const c = fitCanvas(cv, w, h, dpr);
  const sec = map.rooms[map.security].rect;
  const lit = q.get("scene") === "lit";
  if (lit) {
    sample.guard = sample.guard2;
    sample.seen = sample.seen2;
    sample.light = sample.light2;
    sample.thief = { x: sample.guard2.x + 2.5, y: sample.guard2.y + 1.2, facing: 160 };
  }
  const at = q.get("at") === "sec" ? { x: (sec.x + sec.w / 2 + sample.guard.x) / 2, y: (sec.y + sec.h / 2 + sample.guard.y) / 2 } : { x: sample.guard.x + 2, y: sample.guard.y };
  const v = followView(at.x, at.y, Number(q.get("across") ?? 14), w, h, dpr);
  const seen = Uint8Array.from(sample.seen);
  const held = q.get("held") === "1";
  // The memory as the phone would have built it (createMemory + remember per frame).
  const mem = createMemory(map);
  mem.seenAt.set(sample.memory);
  const old = seenLoot((i) => sample.memory[i] >= 0 && !seen[i]);
  for (const it of old.items) mem.items.set(it.y * map.w + it.x, { ...it, t: sample.memory[it.y * map.w + it.x] });
  for (const e of old.empty) mem.empty.set(e.y * map.w + e.x, { ...e, t: sample.memory[e.y * map.w + e.x] });
  sample.doors.forEach((/** @type {number} */ st, /** @type {number} */ k) => (mem.doors[k] = st));
  const { items, empty } = seenLoot((i) => !!seen[i]);
  const figs = figures(t, held).filter((f) => f.self || seen[Math.floor(f.y) * map.w + Math.floor(f.x)]);
  drawWorld(c, art, v, { seen, light: sample.light, memory: mem, now: now + t, lamps: sample.lamps, items, empty, catalogue, colors, names: playerNames, figures: figs }, { budget: 99 });
  if (q.get("public") !== "0") drawPublic(c, art, v, publicLayer(now + t), { lights: false, colors, names: playerNames, quiet: true, seen });
}

function tape(/** @type {number} */ t) {
  const cv = document.getElementById("map") ?? document.body.appendChild(Object.assign(document.createElement("canvas"), { id: "map" }));
  const c = fitCanvas(/** @type {HTMLCanvasElement} */ (cv), innerWidth, innerHeight, dpr);
  const rect = q.get("zoom") === "1" ? { x: sample.guard.x - 14, y: sample.guard.y - 8, w: 28, h: 16 } : undefined;
  const v = fitView(map, innerWidth, innerHeight, dpr, { pad: 0, rect });
  // Everything in full colour with the light (`seen` null).
  const { items, empty } = seenLoot(() => true);
  drawWorld(c, art, v, { seen: null, light: sample.light, now: now + t, doors: sample.doors, lamps: sample.lamps, items, empty, catalogue, colors, names: playerNames, figures: figures(t, false) }, { budget: 999 });
  useTiles(c, v);
  const s = map.spots[0];
  drawTrail(c, [[s.rect.x + 1, s.rect.y + 1], [s.rect.x + 3, s.rect.y + 6], [sample.thief.x - 6, sample.thief.y + 3], [sample.thief.x, sample.thief.y]], "#f2ede2");
  drawTrail(c, [[sample.guard.x - 8, sample.guard.y - 3], [sample.guard.x - 3, sample.guard.y], [sample.guard.x, sample.guard.y]], GUARD_COLOURS[0] ?? "#fff", { dashed: true });
}

function props() {
  const cv = document.body.appendChild(document.createElement("canvas"));
  const c = fitCanvas(cv, innerWidth, innerHeight, dpr);
  const kinds = ["table", "desk", "bookshelf", "armchair", "chair", "piano", "plant", "plinth", "case", "safe", "counter", "stove", "icebox", "bed", "wardrobe", "dresser", "nightstand", "bathtub", "sink", "toilet", "billiards", "cuerack", "bar", "sideboard", "dining", "bench", "clock", "coatstand", "monitors", "lockers", "vintagecar", "workbench", "tools", "crates", "shelf", "hedge", "tree", "car", "fountain", "hut"];
  /** @type {Record<string, [number, number]>} */
  const size = { table: [2, 1], desk: [2, 1], bookshelf: [3, 1], piano: [3, 3], bed: [2, 3], billiards: [4, 2], dining: [5, 3], bar: [3, 2], vintagecar: [4, 2], car: [4, 2], fountain: [3, 3], hut: [3, 3], hedge: [4, 1], tree: [2, 2], bathtub: [2, 1], counter: [3, 1], monitors: [3, 1], lockers: [3, 1], workbench: [3, 1], sideboard: [3, 1], crates: [2, 2], wardrobe: [2, 1], dresser: [2, 1], tools: [2, 1], shelf: [2, 1], cuerack: [2, 1], bench: [2, 1] };
  const k = 44 * dpr;
  c.fillStyle = "#3a3530";
  c.fillRect(0, 0, cv.width, cv.height);
  const half = cv.width / 2;
  for (const bp of [false, true]) {
    let x = 0.4;
    let y = 0.4;
    let rowH = 0;
    const cols = half / k;
    if (bp) {
      c.fillStyle = "#17406f";
      c.fillRect(half, 0, half, cv.height);
    }
    kinds.forEach((kind, id) => {
      const [w, h] = size[kind] ?? [1, 1];
      if (x + w > cols - 0.2) {
        x = 0.4;
        y += rowH + 0.9;
        rowH = 0;
      }
      c.setTransform(k, 0, 0, k, bp ? half : 0, 0);
      c.fillStyle = bp ? "#17406f" : "#b37f47";
      if (!bp) c.fillRect(x - 0.2, y - 0.2, w + 0.4, h + 0.4);
      drawPropAlone(c, { id, kind: /** @type {any} */ (kind), rect: { x, y, w, h }, block: 1, room: 0, side: "n" }, { blueprint: bp });
      x += w + 0.8;
      rowH = Math.max(rowH, h);
    });
    // Figures and loot below.
    y += rowH + 1.2;
    c.setTransform(k, 0, 0, k, bp ? half : 0, 0);
    const figs = [
      { role: "guard", x: 1, y: y + 0.5, facing: 0, colour: GUARD_COLOURS[0], light: true, moving: true, walk: 0.3 },
      { role: "guard", x: 2.4, y: y + 0.5, facing: 90, colour: GUARD_COLOURS[2], moving: true, walk: 0.8 },
      { role: "thief", x: 3.8, y: y + 0.5, facing: 180, sack: 0 },
      { role: "thief", x: 5.2, y: y + 0.5, facing: 270, sack: 4, moving: true, walk: 0.2 },
      { role: "thief", x: 6.6, y: y + 0.5, facing: 45, sack: 2, held: true },
      { role: "thief", x: 8, y: y + 0.5, facing: 0, sack: 1, cuffed: true },
    ];
    for (const f of figs) drawFigure(c, /** @type {any} */ (f), 0);
    const icons = ["gem", "ring", "pearls", "egg", "crown", "papers", "bottle", "crate", "painting", "vase", "bust", "violin", "record", "watch", "gadget", "bars", "box", "plant", "lamp", "bag"];
    icons.forEach((ic, n) => drawLootIcon(c, ic, 0.8 + (n % 10) * 1.1, y + 1.8 + Math.floor(n / 10) * 1.1, 0.8, { tagged: n % 7 === 0, grey: bp }));
  }
}

function card() {
  const mode = q.get("mode") ?? "css";
  if (mode === "css") {
    document.body.innerHTML = `<div class="intertitle"><div class="intertitle-card"><div class="intertitle-text">Meanwhile, at the<br>Van Doren Estate…<span class="intertitle-rule"></span><small>Round 2 · Ben is the thief</small></div></div></div>`;
    return;
  }
  const cv = document.body.appendChild(document.createElement("canvas"));
  const c = fitCanvas(cv, innerWidth, innerHeight, dpr);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  sunburst(c, innerWidth / 2, innerHeight / 2, Math.max(innerWidth, innerHeight), 24, "#1d1a17", "#0d0c0e");
  decoCard(c, innerWidth * 0.15, innerHeight * 0.15, innerWidth * 0.7, innerHeight * 0.7);
  c.font = `${innerHeight * 0.09}px Limelight`;
  c.fillStyle = "#d6a842";
  c.textAlign = "center";
  c.fillText("PINCHED!", innerWidth / 2, innerHeight / 2);
}

render(T0);
if (q.get("bench") === "1") {
  // Frame times after the caches are warm (the phone moving a little each frame).
  const times = [];
  for (let k = 0; k < 60; k++) {
    const t0 = performance.now();
    render(T0 + k / 60);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  document.documentElement.dataset["bench"] = `median ${times[30]?.toFixed(2)} ms, p90 ${times[54]?.toFixed(2)} ms`;
}
if (q.get("animate") === "1") {
  const start = performance.now();
  const loop = () => {
    render(T0 + (performance.now() - start) / 1000);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
document.documentElement.dataset["ready"] = "1";
