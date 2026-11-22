// @ts-check
/**
 * The TV page's demo (`screen/index.html?demo=PHASE`): canned views and
 * messages for every phase, from a real generated estate (game/map.js),
 * a made-up public layer and a made-up tape walked with move.js'
 * pathfinding, so the page can be looked at and screenshot without a
 * running game (test/live/tv-shots.ts). Not used otherwise.
 *
 * Parameters: `demo` lobby | briefing | heist | held | alarm |
 * outcome-pinched | outcome-gotAway | outcome-police | outcome-left |
 * tape | scores | final; `players` (3–8, default 5), `seed`, `lang`
 * (en, de), `t` (the tape: seconds to start at), `card=1` (show the
 * phase's intertitle and keep it), `badge=0` (no stand-in for the join
 * badge), `empty=1` (the lobby with nobody).
 */

import { GUARD_COLOURS } from "../phone/draw.js";
import { Ink, encodeInk, inkMask } from "../game/ink.js";
import { pickCatalogue } from "../game/items.js";
import { encodeBlueprint, generate, lootCount } from "../game/map.js";
import { findPath, SPEED } from "../game/move.js";
import { encodeTrack, TRACK } from "../game/protocol.js";
import { Rng } from "../game/rng.js";

/**
 * The demo's QR code: the library's encoder where this tvpipe serves it
 * (newer than 0.3.0); loaded by name at run time so the bundle does not
 * depend on it (tvpipe 0.3.0's game check refuses a missing import).
 * @type {(text: string) => any}
 */
const encodeQr = await import(/* @vite-ignore */ ["/_tvpipe/lib", "qr.js"].join("/"))
  .then((m) => m.encodeQr)
  .catch(() => () => null);

/** @typedef {import("../game/protocol.ts").Sample} Sample */
/** @typedef {import("../game/map.ts").Blueprint} Blueprint */

const NAMES = ["Anna", "Ben", "Clara", "Dot", "Eddie", "Flo", "Gus", "Hattie"];

/**
 * A client that hands the page canned views.
 * @param {URLSearchParams} q
 */
export function demoClient(q) {
  const phase = q.get("demo") || "heist";
  const players = Math.min(8, Math.max(3, Number(q.get("players")) || 5));
  const seed = Number(q.get("seed")) || 1;
  const lang = q.get("lang") === "de" ? "de" : "en";
  /** @type {Map<string, ((...a: any[]) => void)[]>} */
  const on = new Map();
  const emit = (/** @type {string} */ ev, /** @type {any[]} */ ...args) => {
    for (const fn of on.get(ev) ?? []) fn(...args);
  };
  const t0 = Date.now();
  const d = build(phase, players, seed, lang, q);
  const badge = q.get("badge") !== "0";
  const client = {
    view: d.view,
    /** @param {string} ev @param {(...a: any[]) => void} fn */
    on(ev, fn) {
      on.set(ev, [...(on.get(ev) ?? []), fn]);
    },
    now: () => Date.now() - t0 + 1_000_000,
    get joinVisible() {
      return visible;
    },
    set joinVisible(v) {
      visible = v;
      standIn(badge && !v);
    },
  };
  let visible = false;
  setTimeout(() => {
    if (d.tape) emit("msg", "tape", d.tape);
    emit("view", client.view, null);
    // The heist runs on: a delta every 100 ms, keyframes now and then.
    if (d.pub) {
      let layer = d.pub;
      let k = 0;
      setInterval(() => {
        k++;
        const next = { ...layer, seq: layer.seq + 1, t: Math.round((layer.t + 0.1) * 100) / 100, left: Math.max(0, Math.round((layer.left - 0.1) * 100) / 100) };
        emit("msg", "pub", k % 50 === 0 ? { ...next, prev: -1 } : { seq: next.seq, prev: layer.seq, t: next.t, left: next.left });
        layer = next;
      }, 100);
    }
    document.documentElement.dataset["ready"] = "1";
  }, 50);
  return client;
}

/** A box where tvpipe's join badge would be (bottom left, the size it has at 720p). @param {boolean} show */
function standIn(show) {
  let el = document.getElementById("demo-badge");
  const root = document.documentElement;
  if (!show) {
    el?.remove();
    root.removeAttribute("data-tvpipe-join");
    root.style.setProperty("--tvpipe-join-w", "0px");
    root.style.setProperty("--tvpipe-join-h", "0px");
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "demo-badge";
    el.textContent = "JOIN BADGE";
    Object.assign(el.style, {
      position: "fixed", left: "12px", bottom: "12px", width: "160px", height: "164px", zIndex: "99",
      border: "2px dashed #ff00ff", background: "rgba(255,0,255,0.25)", color: "#fff", font: "700 14px sans-serif",
      display: "grid", placeItems: "center",
    });
    document.body.append(el);
  }
  root.dataset["tvpipeJoin"] = "bottom-left";
  root.style.setProperty("--tvpipe-join-w", "172px");
  root.style.setProperty("--tvpipe-join-h", "176px");
}

/**
 * @param {string} phase @param {number} players @param {number} seed @param {"en" | "de"} lang @param {URLSearchParams} q
 * @returns {{ view: any, pub?: any, tape?: any }}
 */
function build(phase, players, seed, lang, q) {
  const est = generate(players, seed);
  const map = est.map;
  const rng = new Rng(seed * 7 + players);
  const ids = NAMES.slice(0, players).map((n) => n.toLowerCase());
  const roster = ids.map((id, i) => ({ id, name: NAMES[i], vip: i === 0, connected: i !== 4 }));
  /** @type {Record<string, string>} */
  const colors = {};
  ids.forEach((id, i) => (colors[id] = GUARD_COLOURS[i % GUARD_COLOURS.length] ?? "#ffd447"));
  const places = est.places.map((p) => ({ keep: p.keep, room: map.rooms[p.room]?.kind ?? "foyer", depth: p.depth }));
  const night = pickCatalogue(lootCount(players), () => rng.float(), places);
  const catalogue = night.map((n) => ({ id: n.item.id, value: n.item.value, size: n.item.size, tagged: n.tagged }));
  const placeOf = (/** @type {number} */ k) => est.places[night[k]?.place ?? 0] ?? est.places[0];
  const thief = ids[1] ?? "ben";
  const join = { code: "BCDF", url: "https://tvpipe.party/p#c=BCDF&r=XYZW&k=abcdefgh", short: "https://tvpipe.party/BCDF", qr: encodeQr("https://tvpipe.party/p#c=BCDF&r=XYZW&k=abcdefgh") };
  const base = {
    lang,
    settings: { length: 210, rounds: 1 },
    minPlayers: 3,
    colors,
    round: 2,
    rounds: players,
    thief,
    next: ids.slice(2),
    estate: seed + 2,
    blueprint: encodeBlueprint(map),
    catalogue,
    scores: /** @type {Record<string, number>} */ ({}),
    history: /** @type {any[]} */ ([]),
  };
  const view = (/** @type {any} */ screen) => ({ roster: q.get("empty") === "1" ? [] : roster, screen: { ...base, ...screen }, join });

  if (phase === "lobby") return { view: view({ phase: "lobby", round: 0, thief: null, blueprint: undefined, catalogue: undefined }) };
  if (phase === "briefing") return { view: view({ phase: "briefing", deadline: 1_000_000 + 14_000 }) };

  // The heist's public layer at t = 95.
  const T = 95;
  const room = (/** @type {string} */ kind) => map.rooms.find((r) => r.kind === kind) ?? map.rooms[0];
  const centre = (/** @type {{ rect: { x: number, y: number, w: number, h: number } } | undefined} */ r) => ({ x: (r?.rect.x ?? 0) + (r?.rect.w ?? 0) / 2, y: (r?.rect.y ?? 0) + (r?.rect.h ?? 0) / 2 });
  const corridor = map.rooms.filter((r) => r.kind === "corridor").sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0] ?? room("foyer");
  const thiefAt = centre(corridor);
  const ink = new Ink(map);
  ink.start(0);
  ink.restartAt(80, thiefAt.x, thiefAt.y);
  const cleared = room("library") ?? room("study");
  if (cleared) ink.clearRoom(84, cleared.id);
  ink.step(T);
  const cam0 = map.cameras[0];
  const sees = cam0 ? { x: cam0.x + 0.5 + Math.cos((cam0.angle * Math.PI) / 180) * 4, y: cam0.y + 0.5 + Math.sin((cam0.angle * Math.PI) / 180) * 4, facing: cam0.angle + 180 } : null;
  const gallery = room("gallery") ?? room("ballroom");
  const vault = room("vault");
  const where = (/** @type {any} */ r) => ({ room: r?.id ?? 0 });
  const gate = map.gates[0];
  const spot = map.spots[1] ?? map.spots[0];
  const missingPlace = placeOf(3);
  const marks = [
    { id: 1, guard: ids[2], kind: "clear", ...centre(cleared), where: where(cleared), t: 84, until: 174 },
    { id: 2, guard: ids[3], kind: "seen", x: (spot?.rect.x ?? 2) + 2, y: (spot?.rect.y ?? 2) - 3, where: { area: spot?.area ?? 0 }, angle: 300, dir: "ne", t: 60, until: 150 },
    { id: 3, guard: ids[0], kind: "post", x: (gate?.rect.x ?? 4) + 0.5, y: (gate?.rect.y ?? 4) + 0.5, where: { gate: gate?.id ?? 0 }, t: 90, until: 180 },
    { id: 4, guard: ids[4] ?? ids[2], kind: "look", ...centre(gallery), where: where(gallery), t: 92, until: 182 },
  ];
  /** @type {any[]} */
  const evs = [
    { k: "start", t: 0 },
    { k: "lightsOff", where: where(room("kitchen")), t: 31 },
    { k: "missing", item: 3, where: where(map.rooms[missingPlace?.room ?? 0]), t: 52 },
    { k: "seen", guard: ids[3], where: { area: spot?.area ?? 0 }, dir: "ne", mark: 2, t: 60 },
    { k: "sighting", camera: cam0?.id ?? 0, where: where(corridor), t: 80 },
    { k: "clear", guard: ids[2], where: where(cleared), mark: 1, t: 84 },
    { k: "post", guard: ids[0], where: { gate: gate?.id ?? 0 }, mark: 3, t: 90 },
    { k: "glass", where: where(gallery), t: 93.5 },
  ];
  const variant = phase;
  if (variant === "alarm" || variant.startsWith("outcome")) evs.push({ k: "alarm", where: where(vault), seconds: 60, t: 94 });
  if (variant === "held" || variant === "outcome-pinched") evs.push({ k: "held", guard: ids[2], thief, where: where(corridor), t: 94.5 });
  const events = evs.map((e, k) => ({ ...e, seq: k + 1 }));
  const pub = {
    v: 1,
    seq: 500,
    t: T,
    left: variant === "alarm" ? 47 : 210 - T,
    length: 210,
    rooms: map.rooms.map((r) => (r.kind === "kitchen" ? 0 : r.lit ? 1 : 0)),
    lamps: map.lamps.map((l, k) => (k === 1 ? 0 : 1)),
    cameras: map.cameras.map((c) => ({ id: c.id, tampered: c.id === 1, sees: c.id === 0 ? sees : null })),
    noises: gallery ? [{ id: 1, kind: "glass", x: gallery.rect.x + 1.5, y: gallery.rect.y + 1.5, t: 93.5 }] : [],
    alarm: variant === "alarm" && vault ? { t: 94, room: vault.id, ...centre(vault) } : null,
    missing: missingPlace ? [{ item: 3, room: missingPlace.room, x: missingPlace.x, y: missingPlace.y, t: 52 }] : [],
    pings: spot ? [{ x: spot.rect.x + 5, y: spot.rect.y - 4, r: 3, t: 92 }] : [],
    holds: variant === "held" ? [{ guard: ids[2], thief, x: thiefAt.x, y: thiefAt.y, t: 94.5, until: 103.5, total: 9 }] : [],
    marks,
    ink: encodeInk(ink.inked, inkMask(map)),
    events,
    arrest: null,
    end: null,
  };
  if (phase === "heist" || phase === "held" || phase === "alarm") return { view: view({ phase: "heist", pub }), pub };

  const outcomeKind = phase.startsWith("outcome-") ? phase.slice(8) : "gotAway";
  const tape = fakeTape(map, est.car, ids, thief, night.map((n, k) => ({ item: k, ...placeOf(k) })), outcomeKind, rng);
  const endPub = { ...pub, end: { outcome: outcomeKind, t: tape.result.t }, arrest: outcomeKind === "pinched" ? { guard: ids[2], x: thiefAt.x, y: thiefAt.y, t: T } : null, holds: [] };
  if (phase.startsWith("outcome")) {
    return { view: view({ phase: "outcome", pub: endPub, outcome: { kind: outcomeKind, by: outcomeKind === "pinched" ? ids[2] : undefined } }), tape: { tape, result: tape.result } };
  }
  if (phase === "tape") return { view: view({ phase: "tape", deadline: 1_000_000 + 60_000 }), tape: { tape, result: tape.result } };

  // Scores and the end.
  const hist = ids.map((id, k) => {
    const got = k % 3 !== 1;
    const items = catalogue.slice(k % 4, (k % 4) + 2 + (k % 2)).map((c) => c.id);
    const haul = got ? catalogue.slice(k % 4, (k % 4) + 2 + (k % 2)).reduce((s, c) => s + c.value, 0) : 0;
    /** @type {Record<string, number>} */
    const rewards = got ? {} : { [ids[(k + 2) % ids.length] ?? "anna"]: 2000, [ids[(k + 3) % ids.length] ?? "ben"]: 1000 };
    return { round: k + 1, thief: id, outcome: got ? "gotAway" : k % 2 ? "pinched" : "police", haul, items, rewards };
  });
  /** @type {Record<string, number>} */
  const scores = {};
  for (const id of ids) scores[id] = 0;
  const upto = phase === "scores" ? 2 : hist.length;
  for (const r of hist.slice(0, upto)) {
    scores[r.thief] = (scores[r.thief] ?? 0) + r.haul;
    for (const [g, v] of Object.entries(r.rewards)) scores[g] = (scores[g] ?? 0) + v;
  }
  if (phase === "scores") return { view: view({ phase: "scores", round: 2, thief: ids[1], history: hist.slice(0, 2), scores, next: ids.slice(2), deadline: 1_000_000 + 8000 }) };
  const awards = [
    { id: "stickyFingers", player: ids[0], params: { haul: 14200 } },
    { id: "longArm", player: ids[2], params: { holds: 3, arrests: 2 } },
    { id: "closeShave", player: ids[3] ?? ids[1], params: { paces: 1 } },
  ];
  return { view: view({ phase: "final", round: players, thief: null, history: hist, scores, awards, next: [] }) };
}

/**
 * A made-up recording: the thief walks from the car to three items and
 * back, the guards walk from the security office from room to room.
 * @param {Blueprint} map @param {number} car @param {string[]} ids @param {string} thief
 * @param {{ item: number, x: number, y: number, room: number, keep: any }[]} loot @param {string} outcomeKind @param {Rng} rng
 */
function fakeTape(map, car, ids, thief, loot, outcomeKind, rng) {
  const world = { map, doors: new Uint8Array(map.doors.length).fill(1) };
  const hz = 10;
  /** @type {any[]} */
  const events = [];
  /**
   * Walks through the goals, sampling at 10 Hz.
   * @param {string} id @param {{ x: number, y: number }} from @param {{ x: number, y: number, wait?: number }[]} goals @param {number} max
   */
  const walk = (id, from, goals, max, light = false) => {
    /** @type {Sample[]} */
    const out = [];
    let at = { ...from };
    let facing = 90;
    /** @type {number[]} */
    const arrive = [];
    for (const g of goals) {
      const path = findPath(world, at, g, { locked: 0 });
      const pts = path ? [at, ...path.points] : [at, g];
      for (let k = 1; k < pts.length; k++) {
        const a = /** @type {{ x: number, y: number }} */ (pts[k - 1]);
        const b = /** @type {{ x: number, y: number }} */ (pts[k]);
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(1, Math.round((dist / SPEED) * hz));
        facing = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        const door = path?.doors[k - 1] ?? -1;
        if (door >= 0) events.push({ k: "doorOpen", door, by: id, t: out.length / hz });
        for (let s = 1; s <= steps; s++) {
          const f = s / steps;
          const flags = light && out.length % 400 < 260 ? TRACK.LIGHT : 0;
          out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, facing, flags });
        }
      }
      at = { x: g.x, y: g.y };
      arrive.push(out.length / hz);
      for (let s = 0; s < (g.wait ?? 0) * hz; s++) out.push({ x: at.x, y: at.y, facing, flags: TRACK.BUSY });
      if (out.length >= max) break;
    }
    return { samples: out.slice(0, max), arrive };
  };
  const spot = map.spots[car] ?? map.spots[0];
  const carAt = { x: (spot?.rect.x ?? 1) + (spot?.rect.w ?? 1) / 2, y: (spot?.rect.y ?? 1) + (spot?.rect.h ?? 1) / 2 };
  const goals = loot.slice(0, 3).map((l) => ({ x: l.x + 0.5, y: l.y + 1.5, wait: 1 }));
  const tw = walk(thief, carAt, [...goals, { ...carAt, wait: 0 }], 1400);
  const n = tw.samples.length;
  const security = map.rooms[map.security];
  const sx = (security?.rect.x ?? 2) + 1.5;
  const sy = (security?.rect.y ?? 2) + 1.5;
  const tracks = [];
  const players = [];
  for (const id of ids) {
    if (id === thief) {
      players.push({ id, role: "thief" });
      tracks.push(tw.samples);
      continue;
    }
    const rooms = map.rooms.filter((r) => r.kind !== "corridor");
    const g = [];
    for (let k = 0; k < 8; k++) {
      const r = rooms[Math.floor(rng.float() * rooms.length)];
      if (r) g.push({ x: r.rect.x + r.rect.w / 2, y: r.rect.y + r.rect.h / 2, wait: 2 });
    }
    const w = walk(id, { x: sx + rng.float() * 2, y: sy + rng.float() }, g, n, true);
    while (w.samples.length < n) w.samples.push(w.samples.at(-1) ?? { x: sx, y: sy, facing: 0, flags: 0 });
    players.push({ id, role: "guard" });
    tracks.push(w.samples);
  }
  const end = n / hz;
  const takenAt = tw.arrive.slice(0, 3).map((t) => t + 0.6);
  const items = loot.map((l, k) => ({ item: l.item, x: l.x, y: l.y, room: l.room, keep: l.keep, taken: k < 3 ? (takenAt[k] ?? null) : null }));
  const g2 = ids.find((x) => x !== thief) ?? thief;
  const g3 = ids.filter((x) => x !== thief)[1] ?? g2;
  const lounge = map.rooms.find((r) => r.kind === "kitchen") ?? map.rooms[0];
  events.push({ k: "lightsOff", where: { room: lounge?.id ?? 0 }, t: 12 });
  const moments = [
    { t: Math.min(end - 1, 14), weight: 1, k: "sighting", p: { thief, camera: 0 } },
    { t: takenAt[0] ?? 20, weight: 2, k: "closeShave", p: { guard: g2, thief, paces: 2 } },
    { t: Math.max(1, end * 0.6), weight: 1, k: "liePost", p: { guard: g3, where: { gate: 0 } } },
    { t: Math.max(1, end - 2), weight: 2, k: outcomeKind === "gotAway" ? "car" : outcomeKind === "pinched" ? "arrest" : "timeUp", p: { guard: g2, thief, haul: 12400 } },
  ];
  const result = {
    outcome: outcomeKind,
    t: end - 0.5,
    thief,
    taken: [0, 1, 2],
    haul: outcomeKind === "gotAway" ? loot.slice(0, 3).reduce((s, l) => s + 1000 * (l.item + 1), 0) : 0,
    holder: outcomeKind === "pinched" ? g3 : null,
    arrester: outcomeKind === "pinched" ? g2 : null,
    car,
    stats: {},
  };
  const gate = map.gates[0];
  return {
    v: 1,
    hz,
    samples: n,
    players,
    tracks: tracks.map((s) => encodeTrack(s)),
    events: events.sort((a, b) => a.t - b.t),
    truth: {
      car,
      items,
      marks: [{ id: 3, guard: g3, kind: "post", x: (gate?.rect.x ?? 3) + 0.5, y: (gate?.rect.y ?? 3) + 0.5, where: { gate: 0 }, t: end * 0.4, until: end * 0.4 + 90, lie: true, ended: end }],
      close: [],
      firecrackers: [],
    },
    moments,
    result,
  };
}
