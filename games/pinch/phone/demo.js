// @ts-check
/**
 * The phone without a party (`phone/index.html?demo=thief|guard`): a
 * stand-in for `PartyClient` driven by a small host in the page, on a
 * generated estate. It sends real views (views.ts) and real frames
 * (protocol.ts, encoded as the host would), answers actions with
 * refusals from words.ts' list, and moves bots about, so the phone can
 * be screenshot and its gestures tried without a game. Not the rules:
 * sim.ts is; this only has to look and feel right.
 *
 *   ?demo=thief|guard           the role
 *   &phase=join|lobby|briefing|heist|outcome|tape|scores|final  (default heist)
 *   &scene=walk|loot|hold|held|busy   where the heist starts (default: walk)
 *   &seed=N  &players=3..8  &lang=en|de  &t=SECONDS (heist clock)
 *   &lag=MS   one-way network delay for actions and frames (tries the prediction)
 *   &host=sim  the real rules (game/sim.ts, demo-sim.js) instead of this file's stand-in,
 *              with &jitter=MS (more delay at random, in order) and &pace=uneven (frames 100–150 ms apart)
 */

import { GUARD_COLOURS } from "./draw.js";
import { simHost } from "./demo-sim.js";
import { encodeBlueprint, generate, lootPlaces } from "../game/map.js";
import { pickCatalogue, SLOTS, THIEF_SLOTS } from "../game/items.js";
import { climbTarget, distToTile, DOOR_CLOSED, DOOR_LOCKED, DOOR_OPEN, doorsInReach, DT, goTo, PICK_TIME, step, windowsInReach } from "../game/move.js";
import { cameraSees, FLASHLIGHT_FOV, GUARD_RADIUS, inCone, lineOfSight, prepare, seenBy, THIEF_RADIUS, encodeSeen } from "../game/sight.js";
import { encodeInk, Ink, inkMask } from "../game/ink.js";
import { rleEncode } from "../game/codec.js";
import { holdTime, TIMES, whereAt } from "../game/protocol.js";
import { Rng } from "../game/rng.js";
import { DIRS8 } from "../game/words.js";

/** @typedef {import("../game/protocol.ts").Action} Action */
/** @typedef {import("../game/protocol.ts").Busy} Busy */
/** @typedef {import("../game/move.ts").Path} Path */

const NAMES = ["Ada", "Ben", "Clara", "Dot", "Eddie", "Flo", "Gus", "Hattie"];
const fin = (/** @type {unknown} */ v) => typeof v === "number" && Number.isFinite(v);
const r2 = (/** @type {number} */ v) => Math.round(v * 100) / 100;

/** A refusal as the client throws it. @param {string} code */
function refuse(code) {
  return Object.assign(new Error(code), { name: "PartyActionError", code });
}

/**
 * @typedef {{ id: string, role: "thief" | "guard", x: number, y: number, angle: number, path: Path | null, bot: boolean,
 *   light: "off" | "warming" | "on", warm: number, busy: (Busy & { then: () => void }) | null, frozen: boolean, still: boolean,
 *   slots: { item: number, tagged: boolean }[], firecrackers: number, marksLeft: number, cooldown: number, moving: boolean }} Body
 */

/** @param {URLSearchParams} q */
export function demoClient(q) {
  const role = q.get("demo") === "guard" ? "guard" : "thief";
  const phase0 = q.get("phase") ?? "heist";
  const scene = q.get("scene") ?? "walk";
  const seed = Number(q.get("seed")) || 1;
  const players = Math.min(8, Math.max(3, Number(q.get("players")) || 4));
  /** @type {"en" | "de"} */
  const lang = q.get("lang") === "de" ? "de" : "en";
  const lag = Math.min(2000, Math.max(0, Number(q.get("lag")) || 0));
  const later = (/** @type {() => void} */ fn) => (lag ? setTimeout(fn, lag) : fn());
  const useSim = q.get("host") === "sim";
  const jitter = Math.min(2000, Math.max(0, Number(q.get("jitter")) || 0));
  /** @type {ReturnType<typeof simHost> | null} */
  let sim = null;
  const rng = new Rng(seed * 7919 + 13);
  const estate = generate(players, seed);
  const map = estate.map;
  const W = map.w;
  const places = estate.places;
  const night = pickCatalogue(14, () => rng.float(), lootPlaces(estate));
  const catalogue = night.map((n) => ({ id: n.item.id, value: n.item.value, size: n.item.size, tagged: n.tagged }));
  const loot = night.map((n, k) => {
    const p = places[n.place];
    return { item: k, x: p?.x ?? 0, y: p?.y ?? 0, i: p?.i ?? 0, keep: p?.keep ?? "loose", access: p?.access ?? 0, room: p?.room ?? -1, tagged: n.tagged, taken: false };
  });

  // The players.
  const ids = NAMES.slice(0, players).map((_, k) => (k === 0 ? "me" : `p${k + 1}`));
  const thiefId = role === "thief" ? "me" : "p2";
  const colors = /** @type {Record<string, string>} */ ({});
  ids.forEach((id, k) => (colors[id] = GUARD_COLOURS[k % GUARD_COLOURS.length] ?? "#ffd447"));
  const guest = !!q.get("guest");
  const roster = ids.map((id, k) => ({ id, name: NAMES[k] ?? id, vip: guest ? k === 1 : k === 0, connected: true }));
  const car = estate.car;
  const carSpot = map.spots[car];
  /** @type {Body[]} */
  const bodies = ids.map((id, k) => {
    const thief = id === thiefId;
    const spawn = map.spawn[k % Math.max(1, map.spawn.length)] ?? 0;
    const x = thief && carSpot ? carSpot.rect.x + carSpot.rect.w / 2 : (spawn % W) + 0.5;
    const y = thief && carSpot ? carSpot.rect.y + carSpot.rect.h / 2 : Math.floor(spawn / W) + 0.5;
    return {
      id, role: thief ? "thief" : "guard", x, y, angle: 90, path: null, bot: id !== "me", light: thief || id === "me" ? "off" : "on", warm: 0,
      busy: null, frozen: false, still: false, slots: [], firecrackers: TIMES.firecrackers, marksLeft: TIMES.marks, cooldown: 0, moving: false,
    };
  });
  const meBody = /** @type {Body} */ (bodies[0]);
  const thief = /** @type {Body} */ (bodies.find((b) => b.role === "thief"));

  // The world.
  const doors = Uint8Array.from(map.doors, (d) => (d.locked ? DOOR_LOCKED : DOOR_CLOSED));
  const rooms = Uint8Array.from(map.rooms, (r) => (r.lit ? 1 : 0));
  const lamps = new Uint8Array(map.lamps.length).fill(1);
  const world = { map, doors };
  const ink = new Ink(map);
  ink.start(0);
  const mask = inkMask(map);
  let t = Number(q.get("t")) || 0;
  const length = TIMES.length;
  /** @type {import("../game/protocol.ts").TickerEvent[]} */
  const events = [{ k: "start", seq: 1, t: 0 }];
  /** @param {import("../game/protocol.ts").TickerBody} e */
  const event = (e) => events.push({ ...e, seq: events.length + 1, t: r2(t) });
  /** @type {import("../game/protocol.ts").MarkPub[]} */
  const marks = [];
  /** @type {import("../game/protocol.ts").NoisePub[]} */
  const noises = [];
  /** @type {import("../game/protocol.ts").MissingPub[]} */
  const missing = [];
  /** @type {import("../game/protocol.ts").HoldPub | null} */
  let hold = null;
  /** @type {import("../game/protocol.ts").AlarmPub | null} */
  let alarm = null;
  const tampered = new Set();
  let seq = 0;

  // Scenes: where things start.
  const corridor = map.rooms.filter((r) => r.kind === "corridor").sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0] ?? map.rooms[0];
  /** Opens the doors of a room. @param {number} id */
  const openRoom = (id) => map.doors.forEach((d, k) => d.rooms.includes(id) && (doors[k] = DOOR_OPEN));
  if ((scene === "hold" || scene === "held") && corridor) {
    const wide = corridor.rect.w >= corridor.rect.h;
    const gx = corridor.rect.x + (wide ? Math.floor(corridor.rect.w * 0.3) : Math.floor(corridor.rect.w / 2)) + 0.5;
    const gy = corridor.rect.y + (wide ? Math.floor(corridor.rect.h / 2) : Math.floor(corridor.rect.h * 0.3)) + 0.5;
    const guard = /** @type {Body} */ (bodies.find((b) => b.role === "guard" && (scene === "hold" ? b.id === "me" : b.bot)));
    Object.assign(guard, { x: gx, y: gy, angle: wide ? 0 : 90, light: "on", bot: guard.id !== "me", still: true });
    Object.assign(thief, { x: wide ? gx + 3.5 : gx, y: wide ? gy : gy + 3.5, angle: wide ? 0 : 90, still: true });
    openRoom(corridor.id);
    rooms[corridor.id] = 0;
    if (scene === "held") {
      thief.frozen = true;
      guard.frozen = true;
      hold = { guard: guard.id, thief: thief.id, x: thief.x, y: thief.y, t, until: t + holdTime(players - 1) - 1.5, total: holdTime(players - 1) };
      event({ k: "held", guard: guard.id, thief: thief.id, where: whereAt(map, thief.x, thief.y) ?? { room: 0 } });
    }
  } else if ((scene === "loot" || scene === "busy") && role === "thief") {
    const it = [...loot].sort((a, b) => (map.rooms[b.room]?.lit ? 1 : 0) - (map.rooms[a.room]?.lit ? 1 : 0))[0];
    if (it) {
      meBody.x = (it.access % W) + 0.5;
      meBody.y = Math.floor(it.access / W) + 0.5;
      rooms[it.room] = 1;
      openRoom(it.room);
      if (scene === "busy") {
        const total = TIMES.take[it.keep] * 4;
        meBody.busy = { kind: "take", target: it.item, left: total * 0.6, total, then: () => {} };
      }
      const other = loot.find((l) => l !== it);
      if (other) {
        other.taken = true;
        meBody.slots.push({ item: other.item, tagged: other.tagged });
      }
    }
  }

  // ------------------------------------------------------------ the client

  /** @type {Map<string, Set<(...a: any[]) => void>>} */
  const listeners = new Map();
  /** @param {string} e @param {...any} a */
  const emit = (e, ...a) => {
    for (const fn of [...(listeners.get(e) ?? [])]) {
      try {
        fn(...a);
      } catch (x) {
        console.error(x);
      }
    }
  };
  let phase = phase0 === "join" ? "lobby" : phase0;
  /** @type {any} */
  const client = {
    room: "DEMO",
    key: "demo",
    canResume: phase0 !== "join",
    saved: null,
    status: "open",
    you: { id: "me", name: NAMES[0] },
    view: {},
    rtt: 0,
    now: () => Date.now(),
    /** @param {string} e @param {(...a: any[]) => void} fn */
    on(e, fn) {
      let s = listeners.get(e);
      if (!s) listeners.set(e, (s = new Set()));
      s.add(fn);
      return () => s.delete(fn);
    },
    async connect() {
      publish();
    },
    /** @param {string} name */
    async join(name) {
      if (roster[0]) roster[0].name = String(name).slice(0, 16);
      publish();
    },
    /** @param {unknown} data */
    input(data) {
      const d0 = /** @type {any} */ (data);
      if (sim) {
        if (d0?.a === "aim" && fin(d0.angle)) sim.aim(d0.angle);
        return;
      }
      later(() => {
        const d = /** @type {any} */ (data);
        if (d?.a === "aim" && fin(d.angle) && !meBody.moving) meBody.angle = d.angle;
      });
    },
    /** @param {string} type @param {any} data */
    async act(type, data) {
      await new Promise((r) => setTimeout(r, 30 + lag));
      if (type === "start") {
        phase = "briefing";
        deadline = Date.now() + 8000;
        publish();
        return null;
      }
      if (type === "skip") {
        phase = phase === "tape" ? "scores" : phase === "scores" ? "final" : phase;
        publish();
        return null;
      }
      if (type === "settings") {
        Object.assign(settings, data?.length ? { length: data.length } : {}, data?.rounds ? { rounds: data.rounds } : {}, data?.late ? { late: data.late } : {});
        if (data?.lang === "en" || data?.lang === "de") roomLang = data.lang;
        publish();
        return null;
      }
      if (type === "resync") {
        sim?.resync();
        return null;
      }
      if (type === "h" && sim) {
        const r = await sim.act(data);
        if (r) throw refuse(r);
        return null;
      }
      if (type === "h") {
        const r = heistAction(/** @type {Action} */ (data));
        await new Promise((ok) => setTimeout(ok, lag));
        return r;
      }
      throw refuse("invalid");
    },
  };

  /** @type {import("../game/views.ts").SettingsView} */
  const settings = { length, rounds: 1, late: "wait" };
  /** Players left out of this phone's frames until then (ms): `client.hide(id, ms)`, for tests (out of the light, behind a door). @type {Map<string, number>} */
  const hidden = new Map();
  client.hide = (/** @type {string} */ id, /** @type {number} */ ms) => hidden.set(id, Date.now() + ms);
  let roomLang = lang;
  /** @type {number | null} */
  let deadline = phase0 === "briefing" ? Date.now() + 20_000 : phase0 === "scores" ? Date.now() + 8000 : null;

  function publish() {
    const thiefName = thiefId;
    const scores = Object.fromEntries(ids.map((id, k) => [id, [4200, 0, 12500, 1000, 2000, 0, 700, 300][k] ?? 0]));
    /** @type {import("../game/views.ts").RoomView} */
    const room = {
      phase: /** @type {any} */ (phase), lang: roomLang, settings, minPlayers: 3, colors, round: phase === "lobby" ? 0 : 2, rounds: players,
      thief: phase === "lobby" ? null : thiefName, next: ids.filter((id) => id !== thiefId).slice(0, 2), estate: seed % 30,
      blueprint: encodeBlueprint(map), catalogue, deadline,
      outcome: phase === "outcome" ? { kind: role === "thief" ? "gotAway" : "pinched", by: "p3", car } : undefined,
      scores,
      history: [{ round: 1, thief: thiefId, outcome: "gotAway", haul: 14800, items: [catalogue[1]?.id ?? "", catalogue[5]?.id ?? ""], rewards: { p3: 2000, p4: 1000 } }],
      awards: phase === "final" ? [
        { id: "stickyFingers", player: "p3", params: { haul: 12500 } },
        { id: "longArm", player: "p4", params: { holds: 2, arrests: 1 } },
        { id: "closeShave", player: "me", params: { paces: 2 } },
      ] : undefined,
    };
    /** @type {import("../game/views.ts").PlayerView} */
    const me = { role, color: colors["me"] ?? "#ffd447" };
    if (phase !== "lobby") {
      if (role === "thief") me.briefing = { car, tip: { item: catalogue[0]?.id ?? "", wing: "e", building: 0 } };
      else me.start = { x: Math.floor(meBody.x), y: Math.floor(meBody.y) };
    }
    client.view = { roster, room, me };
    emit("view", client.view);
  }

  // ------------------------------------------------------------ the heist

  /** @param {Body} b */
  const tileOf = (b) => Math.floor(b.y) * W + Math.floor(b.x);
  /** @param {Body} b @param {Busy["kind"]} kind @param {number} target @param {number} total @param {() => void} then */
  const busy = (b, kind, target, total, then) => {
    b.path = null;
    b.busy = { kind, target, left: total, total, then };
  };

  /** @param {Action} a */
  function heistAction(a) {
    const b = meBody;
    if (!a || typeof a !== "object") throw refuse("invalid");
    if (phase !== "heist") throw refuse("over");
    // Frozen in a hold: the thief may wriggle; the guard may switch the light off and place or remove marks.
    const frozenOk = b.role === "thief" ? a.a === "wriggle" : a.a === "flashlight" || a.a === "mark" || a.a === "unmark";
    if (b.frozen && !frozenOk) throw refuse(b.role === "thief" ? "held" : "holding");
    switch (a.a) {
      case "go": {
        const p = goTo(world, b, a.x, a.y, { locked: b.role === "thief" ? PICK_TIME : 0 });
        if (!p) throw refuse("tooFar");
        b.busy = null;
        b.path = p;
        return null;
      }
      case "stop":
        b.path = null;
        return null;
      case "door": {
        const d = map.doors[a.door];
        if (!d || distToTile(map, b, d.i) > 1.3) throw refuse("tooFar");
        if (doors[a.door] === DOOR_LOCKED && b.role === "thief") throw refuse("nothingHere");
        busy(b, "door", a.door, TIMES.doorPause, () => (doors[a.door] = doors[a.door] === DOOR_OPEN ? DOOR_CLOSED : DOOR_OPEN));
        return null;
      }
      case "pick": {
        const d = map.doors[a.door];
        if (!d || distToTile(map, b, d.i) > 1.3) throw refuse("tooFar");
        busy(b, "pick", a.door, TIMES.pick, () => (doors[a.door] = DOOR_OPEN));
        return null;
      }
      case "climb": {
        const to = climbTarget(world, a.window, b);
        if (!to) throw refuse("tooFar");
        busy(b, "climb", a.window, TIMES.climb, () => Object.assign(b, to));
        return null;
      }
      case "switch": {
        if (!map.rooms[a.room]?.switches.includes(tileOf(b))) throw refuse("tooFar");
        rooms[a.room] = rooms[a.room] ? 0 : 1;
        event({ k: rooms[a.room] ? "lightsOn" : "lightsOff", where: { room: a.room } });
        return null;
      }
      case "take": {
        const it = loot[a.item];
        if (!it || it.taken || distToTile(map, b, it.i) > 1.3) throw refuse("tooFar");
        const need = SLOTS[catalogue[it.item]?.size ?? "small"];
        const used = b.slots.reduce((s, x) => s + SLOTS[catalogue[x.item]?.size ?? "small"], 0);
        if (used + need > THIEF_SLOTS) throw refuse("handsFull");
        busy(b, "take", it.item, TIMES.take[it.keep], () => {
          it.taken = true;
          b.slots.push({ item: it.item, tagged: it.tagged });
          if (it.keep === "case") noise("glass", it.x + 0.5, it.y + 0.5);
          if (it.keep === "pedestal") {
            alarm = { t, room: it.room, x: it.x, y: it.y };
            event({ k: "alarm", where: { room: it.room }, seconds: TIMES.alarmLeft });
          }
        });
        return null;
      }
      case "firecracker": {
        if (b.firecrackers <= 0) throw refuse("noFirecrackers");
        if (Math.hypot(a.x - b.x, a.y - b.y) > TIMES.throwRange) throw refuse("tooFar");
        b.firecrackers--;
        setTimeout(() => noise("firecracker", a.x, a.y), TIMES.fuse * 1000);
        return null;
      }
      case "flashlight":
        if (b.role !== "guard") throw refuse("role");
        if (a.on) {
          b.light = "warming";
          b.warm = TIMES.flashlight;
        } else b.light = "off";
        if (!a.on && hold && hold.guard === b.id) endHold();
        return null;
      case "aim":
        if (!b.path) b.angle = a.angle;
        return null;
      case "hold": {
        if (b.role !== "guard") throw refuse("role");
        if (hold) throw refuse("alreadyHeld");
        if (b.light !== "on") throw refuse("lightOff");
        if (b.cooldown > 0) throw refuse("cooldown");
        if (!canHold(b)) {
          b.cooldown = TIMES.holdCooldown;
          throw refuse(Math.hypot(thief.x - b.x, thief.y - b.y) > TIMES.holdRange ? "tooFar" : "notInLight");
        }
        b.frozen = thief.frozen = true;
        b.path = thief.path = null;
        const total = holdTime(players - 1);
        hold = { guard: b.id, thief: thief.id, x: thief.x, y: thief.y, t, until: t + total, total };
        event({ k: "held", guard: b.id, thief: thief.id, where: whereAt(map, thief.x, thief.y) ?? { room: 0 } });
        return null;
      }
      case "wriggle":
        if (!hold || hold.thief !== b.id) throw refuse("nothingHere");
        hold.until -= TIMES.wriggle;
        return null;
      case "mark": {
        if (b.role !== "guard") throw refuse("role");
        const where = whereAt(map, a.x, a.y);
        if (!where) throw refuse("nothingHere");
        if (marks.filter((m) => m.guard === b.id).length >= TIMES.marks) marks.splice(marks.findIndex((m) => m.guard === b.id), 1);
        const id = marks.length ? Math.max(...marks.map((m) => m.id)) + 1 : 1;
        const dir = DIRS8[((Math.round((a.angle ?? 0) / 45) + 2) % 8 + 8) % 8] ?? "n";
        marks.push({ id, guard: b.id, kind: a.kind, x: a.x, y: a.y, where, ...(a.kind === "seen" ? { angle: a.angle ?? 0, dir } : {}), t, until: t + TIMES.markFade });
        b.marksLeft = Math.max(0, TIMES.marks - marks.filter((m) => m.guard === b.id).length);
        if (a.kind === "clear" && "room" in where) ink.clearRoom(t, where.room);
        event(a.kind === "seen" ? { k: "seen", guard: b.id, where, dir, mark: id } : { k: a.kind, guard: b.id, where, mark: id });
        return null;
      }
      case "unmark": {
        const k = marks.findIndex((m) => m.id === a.mark && m.guard === b.id);
        if (k < 0) throw refuse("nothingHere");
        marks.splice(k, 1);
        b.marksLeft = Math.max(0, TIMES.marks - marks.filter((m) => m.guard === b.id).length);
        return null;
      }
      default:
        throw refuse("nothingHere");
    }
  }

  /** @param {"glass" | "lamp" | "firecracker" | "alarm"} kind @param {number} x @param {number} y */
  function noise(kind, x, y) {
    noises.push({ id: noises.length + 1, kind, x, y, t });
    const where = whereAt(map, x, y);
    if (where && kind === "lamp") event({ k: "lamp", lamp: 0, where });
    else if (where && (kind === "glass" || kind === "firecracker")) event(kind === "glass" ? { k: "glass", where } : { k: "firecracker", where });
  }
  function endHold() {
    if (!hold) return;
    for (const b of bodies) if (b.id === hold.guard || b.id === hold.thief) b.frozen = false;
    event({ k: "holdSlipped", guard: hold.guard, thief: hold.thief });
    ink.restartAt(t, hold.x, hold.y);
    hold = null;
  }

  /** @type {import("../game/sight.ts").SightWorld} */
  let sight = prepare(map, sightState());
  function sightState() {
    return {
      doors: Uint8Array.from(doors, (s) => (s === DOOR_OPEN ? 1 : 0)), rooms, lamps,
      flashlights: bodies.filter((b) => b.role === "guard" && b.light === "on").map((b) => ({ x: b.x, y: b.y, facing: b.angle, on: true })),
    };
  }
  /** @param {Body} g */
  function canHold(g) {
    if (g.light !== "on" || thief.frozen) return false;
    const d = Math.hypot(thief.x - g.x, thief.y - g.y);
    if (d > TIMES.holdRange) return false;
    if (!inCone(g.x, g.y, g.angle, FLASHLIGHT_FOV, TIMES.holdRange, thief.x, thief.y) && d > 0.8) return false;
    return lineOfSight(map, sight.opaque, g.x, g.y, thief.x, thief.y);
  }

  /** A bot's next errand: somewhere in a random room or area. @param {Body} b */
  function errand(b) {
    for (let k = 0; k < 6; k++) {
      const r = rng.pick(map.rooms);
      if (!r) break;
      const x = r.rect.x + rng.float() * r.rect.w;
      const y = r.rect.y + rng.float() * r.rect.h;
      const p = goTo(world, b, x, y, { locked: b.role === "thief" ? PICK_TIME : 0 });
      if (p && p.complete) return p;
    }
    return null;
  }

  function simStep() {
    t += DT;
    for (const b of bodies) {
      if (b.cooldown > 0) b.cooldown = Math.max(0, b.cooldown - DT);
      if (b.light === "warming" && (b.warm -= DT) <= 0) b.light = "on";
      if (b.busy) {
        b.busy.left -= DT;
        if (b.busy.left <= 0) {
          const then = b.busy.then;
          b.busy = scene === "busy" && b === meBody ? { ...b.busy, left: b.busy.total } : null;
          if (!(scene === "busy" && b === meBody)) then();
        }
        b.moving = false;
        continue;
      }
      if (b.frozen) {
        b.moving = false;
        if (hold && hold.guard === b.id) b.angle = (Math.atan2(thief.y - b.y, thief.x - b.x) * 180) / Math.PI;
        continue;
      }
      if (!b.path && b.bot && !b.still && rng.chance(0.02)) b.path = errand(b);
      if (!b.path) {
        b.moving = false;
        continue;
      }
      const x0 = b.x;
      const y0 = b.y;
      const body = { x: b.x, y: b.y, angle: b.angle };
      const ev = step(body, b.path, DT, world);
      Object.assign(b, { x: body.x, y: body.y, angle: body.angle });
      b.moving = Math.hypot(b.x - x0, b.y - y0) > 1e-4;
      if (ev?.kind === "arrived" || ev?.kind === "stuck") b.path = null;
      else if (ev?.kind === "door") {
        const id = ev.door;
        if (ev.locked && b.role === "thief") busy(b, "pick", id, TIMES.pick, () => (doors[id] = DOOR_OPEN));
        else {
          const path = b.path;
          busy(b, "door", id, TIMES.doorPause, () => {
            doors[id] = DOOR_OPEN;
            b.path = path;
          });
        }
      }
    }
    if (hold && t >= hold.until) endHold();
    ink.step(t);
  }

  function frame() {
    sight = prepare(map, sightState());
    const radius = meBody.role === "thief" ? THIEF_RADIUS : GUARD_RADIUS;
    const seen = seenBy(sight, { x: meBody.x, y: meBody.y, radius });
    const n = map.w * map.h;
    const light = new Int32Array(n);
    for (let i = 0; i < n; i++) light[i] = seen[i] ? (sight.light[i] ?? 0) : 0;
    const at = (/** @type {number} */ x, /** @type {number} */ y) => !!seen[Math.floor(y) * W + Math.floor(x)];
    const others = bodies
      .filter((b) => b !== meBody && at(b.x, b.y) && !((hidden.get(b.id) ?? 0) > Date.now()))
      .map((b) => ({
        id: b.id, role: b.role, x: r2(b.x), y: r2(b.y), facing: Math.round(b.angle), moving: b.moving, light: b.light === "on", held: b.frozen,
        ...(b.role === "thief" ? { sack: b.slots.length } : {}),
      }));
    const items = loot.filter((l) => !l.taken && seen[l.i]).map((l) => ({ item: l.item, x: l.x, y: l.y, keep: l.keep, tagged: l.tagged }));
    const empty = loot.filter((l) => l.taken && seen[l.i]).map((l) => ({ item: l.item, x: l.x, y: l.y, keep: l.keep }));
    for (const l of empty) {
      if (meBody.role === "guard" && !missing.some((m) => m.item === l.item)) {
        const it = loot[l.item];
        missing.push({ item: l.item, room: it?.room ?? -1, x: l.x, y: l.y, t });
        event({ k: "missing", item: l.item, where: { room: it?.room ?? 0 } });
      }
    }
    /** @type {number[]} */
    const doorList = [];
    for (const d of map.doors) if (seen[d.i]) doorList.push(d.id, doors[d.id] ?? 0);
    // Offers.
    /** @type {import("../game/protocol.ts").Offer[]} */
    const offers = [];
    const b = meBody;
    if (!b.frozen && !b.busy) {
      if (b.role === "thief") {
        for (const l of loot) if (!l.taken && seen[l.i] && distToTile(map, b, l.i) <= 1.1) offers.push({ a: "take", item: l.item, button: "take" });
      }
      for (const id of doorsInReach(map, b, 1.1)) {
        const s = doors[id];
        if (s === DOOR_LOCKED && b.role === "thief") offers.push({ a: "pick", door: id, button: "pickLock" });
        else offers.push({ a: "door", door: id, button: s === DOOR_OPEN ? "close" : "open" });
      }
      for (const id of windowsInReach(map, b, 1.1)) offers.push({ a: "climb", window: id, button: "climb" });
      const rid = map.roomAt[tileOf(b)] ?? -1;
      if (rid >= 0 && map.rooms[rid]?.switches.includes(tileOf(b))) offers.push({ a: "switch", room: rid, button: rooms[rid] ? "lightsOff" : "lightsOn" });
    }
    if (b.role === "thief" && b.frozen) offers.unshift({ a: "wriggle", button: "wriggle" });
    const guardCan = b.role === "guard" && canHold(b);
    if (guardCan) offers.unshift({ a: "hold", target: thief.id, button: "hold" });
    const base = {
      id: b.id, x: r2(b.x), y: r2(b.y), facing: Math.round(b.angle), moving: b.moving,
      goal: b.path ? (() => { const p = b.path.points[b.path.points.length - 1]; return p ? { x: r2(p.x), y: r2(p.y) } : null; })() : null,
      busy: b.busy ? { kind: b.busy.kind, target: b.busy.target, left: r2(b.busy.left), total: b.busy.total } : null,
      frozen: b.frozen,
      hold: hold && (hold.thief === b.id || hold.guard === b.id) ? { guard: hold.guard, thief: hold.thief, left: r2(hold.until - t), total: hold.total, wriggled: 0 } : null,
      offers,
    };
    const used = b.slots.reduce((s, x) => s + SLOTS[catalogue[x.item]?.size ?? "small"], 0);
    /** @type {import("../game/protocol.ts").ThiefMe | import("../game/protocol.ts").GuardMe} */
    const me = b.role === "thief"
      ? { ...base, role: "thief", car, slots: b.slots, free: THIEF_SLOTS - used, firecrackers: b.firecrackers, immune: 0, ping: b.slots.some((s) => s.tagged) ? 12 : null }
      : { ...base, role: "guard", light: b.light, marksLeft: b.marksLeft, cooldown: r2(b.cooldown), canHold: guardCan };
    const left = Math.max(0, (alarm ? Math.min(length - t, TIMES.alarmLeft - (t - alarm.t)) : length - t));
    seq++;
    for (let k = noises.length - 1; k >= 0; k--) if (t - (noises[k]?.t ?? 0) > TIMES.noiseShow) noises.splice(k, 1);
    /** @type {import("../game/protocol.ts").PublicDelta} */
    const pub = {
      seq, prev: -1, t: r2(t), left: r2(left), length, rooms: [...rooms], lamps: [...lamps],
      cameras: map.cameras.map((c) => ({ id: c.id, tampered: tampered.has(c.id), sees: !tampered.has(c.id) && cameraSees(sight, c, thief.x, thief.y) ? { x: r2(thief.x), y: r2(thief.y), facing: Math.round(thief.angle) } : null })),
      noises: [...noises], alarm, missing: [...missing], pings: [], holds: hold ? [{ ...hold, x: r2(thief.x), y: r2(thief.y) }] : [], marks: [...marks],
      ink: encodeInk(ink.inked, mask), events: events.slice(-24), arrest: null, end: null,
    };
    /** @type {import("../game/protocol.ts").Frame} */
    const f = { v: 1, t: r2(t), left: r2(left), me, seen: encodeSeen(seen), light: rleEncode(light), others, items, empty, doors: doorList, pub };
    later(() => emit("msg", "f", f));
  }

  // Clocks: 20 Hz steps, 10 Hz frames, briefing → heist.
  let ticks = 0;
  setInterval(() => {
    if (phase === "briefing" && deadline && Date.now() > deadline) {
      phase = "heist";
      deadline = null;
      publish();
    }
    if (phase !== "heist") return;
    if (useSim) {
      sim ??= simHost({
        estate, thief: thiefId, guards: ids.filter((id) => id !== thiefId), me: "me", catalogue: night, rng: () => rng.float(),
        lag, jitter, uneven: q.get("pace") === "uneven", still: q.get("bots") === "still", scene, onFrame: (f) => emit("msg", "f", f),
      });
      sim.tick();
      return;
    }
    simStep();
    if (++ticks % 2 === 0) frame();
  }, DT * 1000);
  if (!useSim) {
    // A few steps before the first frame, so the bots are on their way.
    for (let k = 0; k < 3; k++) simStep();
    setTimeout(() => {
      if (phase === "heist") frame();
    }, 0);
  }
  return client;
}
