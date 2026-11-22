/**
 * The heist (docs/pinch-design.md §3–§8, §11): one round's state, the
 * phones' inputs, a 50 ms step and what comes out of it (per-player
 * frames, the public layer, the ticker, the tape, the result). Pure and
 * deterministic: no party, no clock, no `Math.random`; the same estate,
 * setup, options and inputs give the same heist.
 *
 *   const h = new Heist(estate, { thief: "a", guards: ["b", "c"], catalogue });
 *   h.act("a", { a: "go", x: 12.5, y: 30.5 });    // null or a Refusal
 *   h.step();                                        // 20 Hz
 *   const { pub, frames } = h.frames();             // 10 Hz: send frames[id] to id, pub to the TV
 *   if (h.result) { const tape = h.tape(); … }
 *
 * Untrusted input never throws: {@link Heist.act} validates everything
 * (protocol.ts `parseAction`) and answers with a refusal code.
 *
 * What the wire carries is in protocol.ts; this file keeps the secrets
 * (the car, the loot places) and decides what each player may know.
 */

import { encodeInk, Ink, INK_DISC, inkMask } from "./ink.ts";
import { pickCatalogue, SLOTS, THIEF_SLOTS, type NightItem } from "./items.ts";
import { inRect, lootCount, lootPlaces, type Blueprint, type Estate, type Place } from "./map.ts";
import { rleEncode } from "./codec.ts";
import {
  climbTarget,
  distToRect,
  distToTile,
  DOOR_CLOSED,
  DOOR_LOCKED,
  DOOR_OPEN,
  doorsInReach,
  DT,
  facing,
  fits,
  goTo,
  inReach,
  nearestWalkable,
  propsInReach,
  REACH,
  step as stepBody,
  validPoint,
  windowsInReach,
  type Body,
  type Path,
  type World,
} from "./move.ts";
import {
  ACTION_KINDS,
  CLOSE_PASS,
  EVENTS_KEPT,
  holdTime,
  parseAction,
  TAPE_HZ,
  TIMES,
  TRACK,
  whereAt,
  encodeTrack,
  type Action,
  type Busy,
  type BusyKind,
  type Frame,
  type GuardMe,
  type HeistResult,
  type HoldMine,
  type MarkKind,
  type MarkPub,
  type Moment,
  type Offer,
  type PlayerStats,
  type PublicDelta,
  type PublicLayer,
  type Refusal,
  type Sample,
  type SeenEmpty,
  type SeenItem,
  type SeenPlayer,
  type Tape,
  type TapeBody,
  type TapeEvent,
  type ThiefMe,
  type TickerBody,
  type TickerEvent,
  type Truth,
  type Where,
} from "./protocol.ts";
import { hashSeed, Rng } from "./rng.ts";
import { FLASHLIGHT_FOV, FLASHLIGHT_RANGE, GUARD_RADIUS, inCone, lineOfSight, prepare, seenBy, THIEF_RADIUS, cameraSees, encodeSeen, type SightWorld } from "./sight.ts";
import { DIRS8, type Dir8 } from "./words.ts";

// ---------------------------------------------------------------- setup

/** The rules' numbers, as protocol.ts {@link TIMES}, widened (any number may be given). */
export type Timings = { -readonly [K in keyof typeof TIMES]: (typeof TIMES)[K] extends number ? number : (typeof TIMES)[K] };

export interface HeistSetup {
  thief: string;
  guards: readonly string[];
  /** The night's catalogue (items.ts `pickCatalogue` over map.ts `lootPlaces(estate)`); default: picked here from the seed. */
  catalogue?: readonly NightItem[];
  /** Mixed into the heist's random stream (tag pings; the default catalogue). */
  seed?: number;
}

export interface HeistOptions {
  /** Seconds (default {@link TIMES.length}, 3:30). */
  length?: number;
  /** The hold time, overriding protocol.ts `holdTime(guards)`. */
  holdTime?: number;
  /** Any of the rules' numbers. */
  times?: Partial<Timings>;
}

type Role = "thief" | "guard";

interface Actor {
  id: string;
  role: Role;
  /** Track order: the thief first, then the guards as given. */
  index: number;
  body: Body;
  path: Path | null;
  goal: { x: number; y: number } | null;
  stuck: number;
  busy: (Busy & { done: () => void }) | null;
  moved: number;
  away: boolean;
  /** Left the party for good (stays away). */
  gone: boolean;
  awayFor: number;
  /** Guards: 0 off, 1 warming, 2 on; `warm` seconds left. */
  light: 0 | 1 | 2;
  warm: number;
  cooldown: number;
  seen: Uint8Array;
  stats: PlayerStats;
  closeT: number;
  // the thief
  slots: { item: number; tagged: boolean }[];
  firecrackers: number;
  immuneUntil: number;
  leftCar: boolean;
  pingAt: number | null;
  lastWriggle: number;
}

interface ItemState {
  item: number;
  night: NightItem;
  place: Place;
  taken: number | null;
  discovered: boolean;
}

interface Hold {
  guard: Actor;
  thief: Actor;
  t: number;
  until: number;
  total: number;
  wriggled: number;
}

interface MarkState extends MarkPub {
  lie: boolean;
  ended: number | null;
  /** Post: the author's nearest approach to it while it stood. */
  near: number;
}

interface HistoryEntry {
  t: number;
  tx: number;
  ty: number;
  /** Per guard index: x, y, angle, light on, sees the thief's tile. */
  g: { x: number; y: number; a: number; on: boolean; sees: boolean }[];
}

const round2 = (v: number) => Math.round(v * 100) / 100;
/** Positions on the wire: down to 1/100 tile, so they stay on their tile (what is seen is decided by tiles). */
const pos = (v: number) => Math.floor(v * 100) / 100;
const angle0 = (a: number) => Math.round(((a % 360) + 360) % 360) % 360;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
};
const newStats = (): PlayerStats => ({
  holds: 0, misses: 0, arrests: 0, marks: 0, lies: 0, lightsOff: 0, lightsOn: 0, lampsSmashed: 0, firecrackers: 0, walked: 0, closest: null,
});

/** The Seen arrow's angle as one of eight directions. */
export function dir8(angle: number): Dir8 {
  const a = Number.isFinite(angle) ? ((angle % 360) + 360) % 360 : 0;
  // 0 = east, 90 = south; DIRS8 is n, ne, e, se, s, sw, w, nw
  const k = Math.round(a / 45) % 8; // 0 e, 1 se, 2 s, 3 sw, 4 w, 5 nw, 6 n, 7 ne
  return DIRS8[(k + 2) % 8]!;
}

/**
 * Where everyone starts (§3), known before the heist (the briefing):
 * the thief on the getaway car's spot (secret!), guards on the security
 * office's spawn tiles in the order of `setup.guards` (without the thief,
 * duplicates dropped), `guards` of them.
 */
export function starts(estate: Estate, guards: number): { thief: { x: number; y: number }; guards: { x: number; y: number }[] } {
  const map = estate.map;
  const world: World = { map, doors: new Uint8Array(map.doors.length) };
  const car = map.spots[estate.car] ?? map.spots[0];
  let thief = { x: 0.5, y: 0.5 };
  if (car) {
    const r = car.rect;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    let bd = Infinity;
    thief = { x: cx, y: cy };
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (!fits(world, x + 0.5, y + 0.5)) continue;
        const e = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
        if (e < bd) {
          bd = e;
          thief = { x: x + 0.5, y: y + 0.5 };
        }
      }
    }
  }
  const sec = map.rooms[map.security];
  const out: { x: number; y: number }[] = [];
  for (let k = 0; k < Math.max(0, Math.floor(guards) || 0); k++) {
    const sp = map.spawn.length ? map.spawn[k % map.spawn.length]! : -1;
    out.push(sp >= 0 ? { x: (sp % map.w) + 0.5, y: Math.floor(sp / map.w) + 0.5 } : sec ? { x: sec.rect.x + 0.5, y: sec.rect.y + 0.5 } : { x: 0.5, y: 0.5 });
  }
  return { thief, guards: out };
}

// ---------------------------------------------------------------- the heist

export class Heist {
  readonly estate: Estate;
  readonly map: Blueprint;
  readonly times: Timings;
  readonly length: number;
  /** The hold time this heist (§5). */
  readonly holdTime: number;
  readonly catalogue: readonly NightItem[];

  readonly #rng: Rng;
  readonly #actors = new Map<string, Actor>();
  readonly #order: Actor[] = [];
  readonly #thief: Actor;
  readonly #guards: Actor[];
  readonly #doors: Uint8Array;
  readonly #rooms: Uint8Array;
  readonly #lamps: Uint8Array;
  readonly #tampered: Uint8Array;
  readonly #camSees: ({ x: number; y: number; facing: number } | null)[];
  readonly #items: ItemState[];
  readonly #ink: Ink;
  readonly #inkMask: Uint8Array;
  readonly #world: World;
  #sight!: SightWorld;

  #t = 0;
  #faults = 0;
  #lastMinute = false;
  #left: number;
  #steps = 0;
  #hold: Hold | null = null;
  #alarm: PublicLayer["alarm"] = null;
  #arrest: PublicLayer["arrest"] = null;
  #result: HeistResult | null = null;
  #noises: PublicLayer["noises"] = [];
  #noiseId = 0;
  #pings: PublicLayer["pings"] = [];
  #missing: PublicLayer["missing"] = [];
  #marks: MarkState[] = [];
  #allMarks: MarkState[] = [];
  #markId = 0;
  #fuses: { at: number; x: number; y: number }[] = [];
  #watches: { t: number; x: number; y: number; far: Set<number>; drew: string[] }[] = [];
  #history: HistoryEntry[] = [];
  #ticker: TickerEvent[] = [];
  #tapeEvents: TapeEvent[] = [];
  #moments: Moment[] = [];
  #samples: Sample[][] = [];
  #nextSample = 0;
  // the public layer's versions
  #pubSeq = 0;
  #pubLast: PublicLayer;
  #pubJson = new Map<string, string>();
  #pubInk: Uint8Array;
  #pubEventSeq = 0;

  constructor(estate: Estate, setup: HeistSetup, opts: HeistOptions = {}) {
    this.estate = estate;
    this.map = estate.map;
    const times: Timings = { ...TIMES, ...(opts.times ?? {}) } as Timings;
    this.times = times;
    const len = opts.length;
    this.length = typeof len === "number" && Number.isFinite(len) && len > 0 ? len : times.length;
    this.#left = this.length;
    const guards = [...new Set(setup.guards.filter((g) => g !== setup.thief))];
    const ht = opts.holdTime;
    this.holdTime = typeof ht === "number" && Number.isFinite(ht) && ht > 0 ? ht : holdTime(guards.length, times);
    this.#rng = new Rng(hashSeed("pinch-heist", estate.seed >>> 0, estate.attempt >>> 0, (setup.seed ?? 0) >>> 0));
    this.catalogue = setup.catalogue
      ? setup.catalogue.filter((n) => estate.places[n.place])
      : pickCatalogue(lootCount(estate.players), () => this.#rng.float(), lootPlaces(estate));
    const map = this.map;
    this.#doors = new Uint8Array(map.doors.length);
    for (const d of map.doors) this.#doors[d.id] = d.locked ? DOOR_LOCKED : DOOR_CLOSED;
    this.#rooms = Uint8Array.from(map.rooms, (r) => (r.lit ? 1 : 0));
    this.#lamps = new Uint8Array(map.lamps.length).fill(1);
    this.#tampered = new Uint8Array(map.cameras.length);
    this.#camSees = map.cameras.map(() => null);
    this.#world = { map, doors: this.#doors };
    this.#items = this.catalogue.map((night, item) => ({ item, night, place: estate.places[night.place]!, taken: null, discovered: false }));
    this.#ink = new Ink(map);
    this.#inkMask = inkMask(map);
    this.#pubInk = new Uint8Array(map.w * map.h);

    const mk = (id: string, role: Role, x: number, y: number, angle: number): Actor => {
      const a: Actor = {
        id, role, index: this.#order.length, body: { x, y, angle }, path: null, goal: null, stuck: 0, busy: null, moved: 0,
        away: false, gone: false, awayFor: 0, light: 0, warm: 0, cooldown: 0, seen: new Uint8Array(map.w * map.h), stats: newStats(), closeT: 0,
        slots: [], firecrackers: role === "thief" ? times.firecrackers : 0, immuneUntil: -Infinity, leftCar: false, pingAt: null, lastWriggle: -Infinity,
      };
      this.#actors.set(id, a);
      this.#order.push(a);
      this.#samples.push([]);
      return a;
    };
    const st = starts(estate, guards.length);
    this.#thief = mk(setup.thief, "thief", st.thief.x, st.thief.y, 270);
    this.#guards = guards.map((g, k) => mk(g, "guard", st.guards[k]!.x, st.guards[k]!.y, 90));

    this.#ink.start(0);
    this.#emit({ k: "start" });
    this.#sense();
    this.#record();
    this.#pubLast = this.#layer();
    this.#remember(this.#pubLast);
  }

  // ---------------------------------------------------------------- reading

  /** Seconds since the start. */
  get t(): number {
    return this.#t;
  }
  /** Seconds on the clock. */
  get left(): number {
    return this.#left;
  }
  /** The end, once over (null while the heist runs). */
  get result(): HeistResult | null {
    return this.#result;
  }
  get over(): boolean {
    return this.#result !== null;
  }
  get thief(): string {
    return this.#thief.id;
  }
  get guards(): string[] {
    return this.#guards.map((g) => g.id);
  }
  /** Inputs that threw inside (a bug; answered "invalid"). Tests keep it 0. */
  get faults(): number {
    return this.#faults;
  }
  /** Every ticker event so far, oldest first. */
  get ticker(): readonly TickerEvent[] {
    return this.#ticker;
  }

  /**
   * The truth about a player, for tests and bots run by the host (never
   * for the wire): position, facing, role, frozen, busy, carried items.
   */
  peek(id: string): { x: number; y: number; angle: number; role: Role; frozen: boolean; busy: BusyKind | null; light: 0 | 1 | 2; slots: number[]; seen: Uint8Array } | null {
    const a = this.#actors.get(id);
    if (!a) return null;
    return {
      x: a.body.x, y: a.body.y, angle: a.body.angle, role: a.role, frozen: this.#frozen(a), busy: a.busy?.kind ?? null, light: a.light,
      slots: a.slots.map((s) => s.item), seen: a.seen,
    };
  }

  /** Where every item is (tests, bots, the tape): catalogue index, place, taken. */
  peekItems(): { item: number; place: Place; taken: number | null; discovered: boolean }[] {
    return this.#items.map((s) => ({ item: s.item, place: s.place, taken: s.taken, discovered: s.discovered }));
  }

  /** The door states (move.ts `DOOR_*`), the truth. */
  peekDoors(): Uint8Array {
    return this.#doors;
  }

  /** The hold going on (truth), or null. */
  peekHold(): { guard: string; thief: string; until: number; total: number; wriggled: number } | null {
    const h = this.#hold;
    return h ? { guard: h.guard.id, thief: h.thief.id, until: h.until, total: h.total, wriggled: h.wriggled } : null;
  }

  /** Tests: put a player somewhere (on a free spot), without a path. */
  place(id: string, x: number, y: number, angle?: number): boolean {
    const a = this.#actors.get(id);
    if (!a || !fits(this.#world, x, y)) return false;
    a.body.x = x;
    a.body.y = y;
    if (typeof angle === "number" && Number.isFinite(angle)) a.body.angle = angle0(angle);
    a.path = null;
    a.goal = null;
    a.busy = null;
    this.#sense();
    return true;
  }

  // ---------------------------------------------------------------- input

  /**
   * A phone's action (protocol.ts `Action`, untrusted): null when done
   * (or started), else why not. `aim` is never refused.
   */
  act(id: string, raw: unknown): Refusal | null {
    try {
      return this.#act(id, raw);
    } catch {
      this.#faults++;
      return "invalid";
    }
  }

  go(id: string, x: number, y: number): Refusal | null { return this.act(id, { a: "go", x, y }); }
  stop(id: string): Refusal | null { return this.act(id, { a: "stop" }); }
  door(id: string, door: number): Refusal | null { return this.act(id, { a: "door", door }); }
  pick(id: string, door: number): Refusal | null { return this.act(id, { a: "pick", door }); }
  climb(id: string, window: number): Refusal | null { return this.act(id, { a: "climb", window }); }
  switchLight(id: string, room: number): Refusal | null { return this.act(id, { a: "switch", room }); }
  take(id: string, item: number): Refusal | null { return this.act(id, { a: "take", item }); }
  smash(id: string, lamp: number): Refusal | null { return this.act(id, { a: "smash", lamp }); }
  tamper(id: string, camera: number): Refusal | null { return this.act(id, { a: "tamper", camera }); }
  strip(id: string): Refusal | null { return this.act(id, { a: "strip" }); }
  firecracker(id: string, x: number, y: number): Refusal | null { return this.act(id, { a: "firecracker", x, y }); }
  flashlight(id: string, on: boolean): Refusal | null { return this.act(id, { a: "flashlight", on }); }
  aim(id: string, angle: number): void { this.act(id, { a: "aim", angle }); }
  hold(id: string, target?: string): Refusal | null { return this.act(id, target === undefined ? { a: "hold" } : { a: "hold", target }); }
  wriggle(id: string): Refusal | null { return this.act(id, { a: "wriggle" }); }
  mark(id: string, kind: MarkKind, x: number, y: number, angle?: number): Refusal | null {
    return this.act(id, angle === undefined ? { a: "mark", kind, x, y } : { a: "mark", kind, x, y, angle });
  }
  unmark(id: string, mark: number): Refusal | null { return this.act(id, { a: "unmark", mark }); }

  /**
   * A phone went away or came back (§11): a guard away stands still; a
   * thief away for {@link TIMES.awayLimit} seconds ends the heist.
   */
  setAway(id: string, away: boolean): void {
    const a = this.#actors.get(id);
    if (!a || this.over) return;
    if (a.gone) return;
    a.away = !!away;
    if (a.away) {
      a.path = null;
      a.goal = null;
      if (a.busy?.kind === "door") a.busy = null;
    } else a.awayFor = 0;
  }

  /**
   * A player left the party for good: the thief ends the heist at once
   * ("left", ticker `left`); a guard stands still from now on (away).
   */
  leave(id: string): void {
    const a = this.#actors.get(id);
    if (!a || this.over) return;
    if (a.role === "thief") {
      this.#emit({ k: "left", thief: a.id });
      this.#finish("left");
      return;
    }
    this.setAway(id, true);
    a.gone = true;
  }

  /** Runs the clock out (a host's or a test's shortcut): the next step ends the heist, "police". */
  timeUp(): void {
    if (!this.over) this.#left = 0;
  }

  #act(id: string, raw: unknown): Refusal | null {
    const a = parseAction(raw);
    if (!a || !ACTION_KINDS.includes(a.a)) return "invalid";
    const p = this.#actors.get(id);
    if (!p) return "invalid";
    if (this.over) return "over";
    if (a.a === "aim") {
      this.#aim(p, a.angle);
      return null;
    }
    // frozen in a hold: the thief only wriggles; the holder only marks (calling for help) and keeps or drops the light
    const h = this.#hold;
    if (h?.thief === p && a.a !== "wriggle") return "held";
    if (h?.guard === p && a.a !== "mark" && a.a !== "unmark" && a.a !== "flashlight") return "holding";
    if (a.a === "hold") return this.#tryHold(p, a.target);
    const plan = this.#plan(p, a);
    if (typeof plan === "string") return plan;
    plan();
    return null;
  }

  /** The thief's tile is a seen tile of `a` now. */
  #seesTile(a: Actor, i: number): boolean {
    return i >= 0 && i < a.seen.length && a.seen[i] === 1;
  }

  /** Validates an action: why not, or what doing it does. */
  #plan(p: Actor, a: Exclude<Action, { a: "aim" } | { a: "hold" }>): Refusal | (() => void) {
    const map = this.map;
    const thief = p.role === "thief";
    const held = this.#hold?.thief === p;
    const holding = this.#hold?.guard === p;
    const free = (): Refusal | null => (held ? "held" : holding ? "holding" : p.busy && p.busy.kind !== "door" ? "busy" : null);
    switch (a.a) {
      case "go": {
        if (held) return "held";
        if (holding) return "holding";
        if (!validPoint(map, a.x, a.y)) return "invalid";
        const path = goTo(this.#world, p.body, a.x, a.y, { locked: thief ? this.times.pick : 0 });
        if (!path) return "nothingHere";
        return () => {
          p.busy = null;
          p.path = path;
          const last = path.points[path.points.length - 1];
          p.goal = last ? { x: last.x, y: last.y } : null;
          p.stuck = 0;
          if (!last) p.path = null;
        };
      }
      case "stop":
        if (held) return "held";
        if (holding) return "holding";
        return () => {
          p.path = null;
          p.goal = null;
          p.busy = null;
        };
      case "door": {
        const d = map.doors[a.door];
        if (!d) return "invalid";
        const f = free();
        if (f) return f;
        if (!inReach(map, p.body, d.i) || !this.#seesTile(p, d.i)) return "tooFar";
        const s = this.#doors[d.id]!;
        if (s === DOOR_OPEN) {
          this.#doors[d.id] = DOOR_CLOSED;
          const ok = this.#order.every((q) => fits(this.#world, q.body.x, q.body.y));
          this.#doors[d.id] = DOOR_OPEN;
          if (!ok) return "blocked";
          return () => {
            this.#stand(p);
            this.#doors[d.id] = DOOR_CLOSED;
            this.#tapeOnly({ k: "doorClose", door: d.id, by: p.id });
          };
        }
        if (s === DOOR_LOCKED && thief) return this.#plan(p, { a: "pick", door: d.id });
        return () => this.#begin(p, "door", d.id, this.times.doorPause, () => this.#openDoor(d.id, p));
      }
      case "pick": {
        const d = map.doors[a.door];
        if (!d) return "invalid";
        if (!thief) return "role";
        const f = free();
        if (f) return f;
        if (!inReach(map, p.body, d.i) || !this.#seesTile(p, d.i)) return "tooFar";
        if (this.#doors[d.id] !== DOOR_LOCKED) return "nothingHere";
        return () => this.#begin(p, "pick", d.id, this.times.pick, () => this.#openDoor(d.id, p, true));
      }
      case "climb": {
        const w = map.windows[a.window];
        if (!w) return "invalid";
        const f = free();
        if (f) return f;
        if (!inReach(map, p.body, w.i)) return "tooFar";
        const to = climbTarget(this.#world, w.id, p.body);
        if (!to) return "blocked";
        return () =>
          this.#begin(p, "climb", w.id, this.times.climb, () => {
            if (fits(this.#world, to.x, to.y)) {
              p.body.x = to.x;
              p.body.y = to.y;
            }
            this.#tapeOnly({ k: "climb", window: w.id, by: p.id });
          });
      }
      case "switch": {
        const r = map.rooms[a.room];
        if (!r) return "invalid";
        if (held) return "held";
        if (holding) return "holding";
        if (!r.switches.some((i) => distToTile(map, p.body, i) <= REACH)) return "tooFar";
        return () => {
          const on = !this.#rooms[r.id];
          this.#rooms[r.id] = on ? 1 : 0;
          if (on) p.stats.lightsOn++;
          else p.stats.lightsOff++;
          this.#emit({ k: on ? "lightsOn" : "lightsOff", where: { room: r.id } });
        };
      }
      case "take": {
        if (!thief) return "role";
        const s = this.#items[a.item];
        if (!s || s.taken !== null || !this.#seesTile(p, s.place.i)) return "nothingHere";
        const f = free();
        if (f) return f;
        if (!inReach(map, p.body, s.place.i)) return "tooFar";
        if (this.#slotsUsed() + SLOTS[s.night.item.size] > THIEF_SLOTS) return "handsFull";
        const keep = s.place.keep;
        return () => {
          if (keep === "case") this.#noise("glass", s.place.x + 0.5, s.place.y + 0.5, { k: "glass", where: { room: s.place.room } });
          this.#begin(p, "take", s.item, this.times.take[keep], () => this.#taken(s));
        };
      }
      case "smash": {
        if (!thief) return "role";
        const l = map.lamps[a.lamp];
        if (!l) return "invalid";
        if (!this.#lamps[l.id]) return "nothingHere";
        const f = free();
        if (f) return f;
        if (!inReach(map, p.body, l.i)) return "tooFar";
        return () =>
          this.#begin(p, "smash", l.id, this.times.smash, () => {
            if (!this.#lamps[l.id]) return;
            this.#lamps[l.id] = 0;
            p.stats.lampsSmashed++;
            p.stats.lightsOff++;
            this.#noise("lamp", l.x + 0.5, l.y + 0.5, { k: "lamp", lamp: l.id, where: this.#whereNear(l.x + 0.5, l.y + 0.5) });
          });
      }
      case "tamper": {
        if (!thief) return "role";
        const c = map.cameras[a.camera];
        if (!c) return "invalid";
        if (this.#tampered[c.id]) return "nothingHere";
        const f = free();
        if (f) return f;
        if (!inReach(map, p.body, c.i)) return "tooFar";
        return () =>
          this.#begin(p, "tamper", c.id, this.times.tamper, () => {
            if (this.#tampered[c.id]) return;
            this.#tampered[c.id] = 1;
            this.#camSees[c.id] = null;
            this.#emit({ k: "tampered", camera: c.id });
            this.#moment(1, "tampered", { thief: p.id, camera: c.id });
          });
      }
      case "strip": {
        if (!thief) return "role";
        const f = free();
        if (f) return f;
        const wb = map.props[map.workbench.prop];
        if (!wb || distToRect(p.body, wb.rect) > REACH) return "tooFar";
        if (!p.slots.some((s) => s.tagged)) return "nothingHere";
        return () =>
          this.#begin(p, "strip", -1, this.times.strip, () => {
            for (const s of p.slots) s.tagged = false;
            this.#tapeOnly({ k: "strip" });
            this.#moment(1, "tags", { thief: p.id });
          });
      }
      case "firecracker": {
        if (!thief) return "role";
        const f = free();
        if (f) return f;
        if (p.firecrackers <= 0) return "noFirecrackers";
        const pt = validPoint(map, a.x, a.y);
        if (!pt) return "invalid";
        if (dist(pt, p.body) > this.times.throwRange) return "tooFar";
        if (!lineOfSight(map, this.#sight.opaque, p.body.x, p.body.y, pt.x, pt.y)) return "notInSight";
        return () => {
          p.firecrackers--;
          p.stats.firecrackers++;
          this.#fuses.push({ at: this.#t + this.times.fuse, x: pt.x, y: pt.y });
          this.#tapeOnly({ k: "throw", x: pos(pt.x), y: pos(pt.y) });
        };
      }
      case "flashlight": {
        if (thief) return "role";
        return () => {
          if (a.on) {
            if (p.light === 0) {
              p.light = 1;
              p.warm = this.times.flashlight;
              this.#tapeOnly({ k: "flashlight", guard: p.id, on: true });
            }
          } else if (p.light !== 0) {
            p.light = 0;
            p.warm = 0;
            this.#tapeOnly({ k: "flashlight", guard: p.id, on: false });
            if (this.#hold?.guard === p) this.#endHold("holdBroken");
          }
        };
      }
      case "wriggle": {
        if (!thief) return "role";
        const h = this.#hold;
        if (!h || h.thief !== p) return "nothingHere";
        return () => {
          if (this.#t - p.lastWriggle < this.times.wriggleGap - 1e-9) return;
          p.lastWriggle = this.#t;
          const take = Math.min(this.times.wriggle, this.times.wriggleMax - h.wriggled);
          if (take <= 0) return;
          h.wriggled += take;
          h.until -= take;
        };
      }
      case "mark":
        if (thief) return "role";
        return this.#planMark(p, a.kind, a.x, a.y, a.angle);
      case "unmark": {
        if (thief) return "role";
        const m = this.#marks.find((q) => q.id === a.mark && q.guard === p.id);
        if (!m) return "nothingHere";
        return () => this.#endMark(m);
      }
    }
  }

  #aim(p: Actor, angle: number): void {
    if (p.role !== "guard" || !Number.isFinite(angle) || this.#hold?.guard === p) return;
    if (p.path && !p.busy && p.moved > 1e-6) return; // walking: the light faces the way
    p.body.angle = ((angle % 360) + 360) % 360;
  }

  /** Stops walking (an action that needs standing). */
  #stand(p: Actor): void {
    p.path = null;
    p.goal = null;
  }

  /** Starts something that takes time; `walking`: on the way (a door's pause or lock), the path waits. */
  #begin(p: Actor, kind: BusyKind, target: number, total: number, done: () => void, walking = false): void {
    if (!walking) this.#stand(p);
    p.busy = { kind, target, left: total, total, done };
  }

  #openDoor(id: number, by: Actor, picked = false): void {
    if (this.#doors[id] === DOOR_OPEN) return;
    this.#doors[id] = DOOR_OPEN;
    if (picked) this.#tapeOnly({ k: "pick", door: id });
    this.#tapeOnly({ k: "doorOpen", door: id, by: by.id });
  }

  #slotsUsed(): number {
    let n = 0;
    for (const s of this.#thief.slots) n += SLOTS[this.#items[s.item]!.night.item.size];
    return n;
  }

  #taken(s: ItemState): void {
    if (s.taken !== null) return;
    const p = this.#thief;
    s.taken = this.#t;
    p.slots.push({ item: s.item, tagged: s.night.tagged });
    this.#tapeOnly({ k: "take", item: s.item, keep: s.place.keep });
    if (s.place.keep === "pedestal") this.#raiseAlarm(s.place);
  }

  #raiseAlarm(place: Place): void {
    if (this.#alarm) return;
    const x = place.x + 0.5;
    const y = place.y + 0.5;
    this.#alarm = { t: round2(this.#t), room: place.room, x, y };
    if (this.#left > this.times.alarmLeft) this.#left = this.times.alarmLeft;
    if (this.#left <= 60 + 1e-6) this.#lastMinute = true;
    this.#noise("alarm", x, y, { k: "alarm", where: { room: place.room }, seconds: Math.round(this.#left) });
    this.#moment(2, "alarm", { thief: this.#thief.id, where: { room: place.room } });
  }

  #noise(kind: PublicLayer["noises"][number]["kind"], x: number, y: number, ev: TickerBody): void {
    this.#noises.push({ id: ++this.#noiseId, kind, x: pos(x), y: pos(y), t: round2(this.#t) });
    this.#emit(ev);
  }

  // -- the hold

  #frozen(a: Actor): boolean {
    const h = this.#hold;
    return !!h && (h.guard === a || h.thief === a);
  }

  /** Whether one history entry gives guard `g` a fair shot. */
  #shot(e: HistoryEntry, g: number): "ok" | "notInLight" | "tooFar" | "notInSight" {
    const s = e.g[g];
    if (!s || !s.on) return "notInLight";
    if (!inCone(s.x, s.y, s.a, FLASHLIGHT_FOV, FLASHLIGHT_RANGE, e.tx, e.ty)) return "notInLight";
    const dx = e.tx - s.x;
    const dy = e.ty - s.y;
    if (dx * dx + dy * dy > this.times.holdRange * this.times.holdRange + 1e-9) return "tooFar";
    return s.sees ? "ok" : "notInSight";
  }

  /** The shot over the lag window: ok, or the best reason why not. */
  #fair(g: Actor): "ok" | "notInLight" | "tooFar" | "notInSight" {
    const gi = this.#guards.indexOf(g);
    let why: "notInLight" | "tooFar" | "notInSight" = "notInLight";
    const rank = { notInLight: 0, tooFar: 1, notInSight: 2 };
    for (let k = this.#history.length - 1; k >= 0; k--) {
      const e = this.#history[k]!;
      if (e.t < this.#t - this.times.holdLag - 1e-6) break;
      const r = this.#shot(e, gi);
      if (r === "ok") return "ok";
      if (rank[r] > rank[why]) why = r;
    }
    return why;
  }

  #tryHold(g: Actor, target: string | undefined): Refusal | null {
    const r = this.#holdCheck(g, target);
    if (r === null || r === "notInLight" || r === "tooFar" || r === "notInSight") {
      this.#tapeOnly(r === null ? { k: "holdTry", guard: g.id, ok: true } : { k: "holdTry", guard: g.id, ok: false, why: r });
    }
    if (r === "notInLight" || r === "tooFar" || r === "notInSight") {
      g.cooldown = this.times.holdCooldown;
      g.stats.misses++;
      return r;
    }
    if (r) return r;
    this.#startHold(g);
    return null;
  }

  #holdCheck(g: Actor, target: string | undefined): Refusal | null {
    if (g.role !== "guard") return "role";
    if (target !== undefined && target !== this.#thief.id) return "invalid";
    if (this.#hold?.guard === g) return "holding";
    if (this.#hold) return "alreadyHeld";
    if (g.light !== 2) return "lightOff";
    if (this.#t < this.#thief.immuneUntil - 1e-9) return "slippery";
    if (g.cooldown > 1e-9) return "cooldown";
    const f = this.#fair(g);
    return f === "ok" ? null : f;
  }

  #startHold(g: Actor): void {
    const th = this.#thief;
    for (const a of [g, th]) {
      a.path = null;
      a.goal = null;
      a.busy = null;
    }
    this.#hold = { guard: g, thief: th, t: this.#t, until: this.#t + this.holdTime, total: this.holdTime, wriggled: 0 };
    g.stats.holds++;
    g.body.angle = facing(th.body.x - g.body.x, th.body.y - g.body.y);
    this.#emit({ k: "held", guard: g.id, thief: th.id, where: this.#whereNear(th.body.x, th.body.y) });
    this.#moment(2, "hold", { guard: g.id, thief: th.id });
    this.#ink.restartAt(this.#t, th.body.x, th.body.y);
  }

  #endHold(kind: "holdBroken" | "holdSlipped"): void {
    const h = this.#hold;
    if (!h) return;
    this.#hold = null;
    h.thief.immuneUntil = this.#t + this.times.holdImmunity;
    this.#emit({ k: kind, guard: h.guard.id, thief: h.thief.id });
    this.#moment(2, "slipped", { guard: h.guard.id, thief: h.thief.id });
    this.#ink.restartAt(this.#t, h.thief.body.x, h.thief.body.y);
  }

  // -- marks

  #planMark(p: Actor, kind: MarkKind, x: number, y: number, angle: number | undefined): Refusal | (() => void) {
    const map = this.map;
    const pt = validPoint(map, x, y);
    if (!pt) return "invalid";
    const tile = nearestWalkable(map, pt.x, pt.y);
    const region: { room: number } | { area: number } | null = tile === null ? null : map.roomAt[tile]! >= 0 ? { room: map.roomAt[tile]! } : map.areaAt[tile]! >= 0 ? { area: map.areaAt[tile]! } : null;
    let where: Where | null = region;
    let mx = pt.x;
    let my = pt.y;
    if (kind === "clear" && !region) return "nothingHere";
    if (kind === "post") {
      const snap = this.#postSnap(pt.x, pt.y);
      if (snap) {
        where = snap.where;
        mx = snap.x;
        my = snap.y;
      }
    }
    if (!where) where = this.#whereNear(pt.x, pt.y);
    const w = where;
    return () => {
      const mine = this.#marks.filter((m) => m.guard === p.id);
      if (mine.length >= this.times.marks) this.#endMark(mine[0]!);
      const id = ++this.#markId;
      const th = this.#thief;
      const tt = this.#tileOf(th);
      let lie = false;
      if (kind === "clear" && region) {
        lie = "room" in region ? map.roomAt[tt] === region.room : map.areaAt[tt] === region.area;
      }
      const m: MarkState = {
        id, guard: p.id, kind, x: pos(mx), y: pos(my), where: w, t: round2(this.#t), until: round2(this.#t + this.times.markFade),
        lie, ended: null, near: dist({ x: mx, y: my }, p.body),
      };
      if (kind === "seen") {
        const a = typeof angle === "number" && Number.isFinite(angle) ? angle0(angle) : 0;
        m.angle = a;
        m.dir = dir8(a);
      }
      this.#marks.push(m);
      this.#allMarks.push(m);
      p.stats.marks++;
      if (kind === "clear" && region) {
        if ("room" in region) this.#ink.clearRoom(this.#t, region.room);
        else this.#ink.clearArea(this.#t, region.area);
      }
      if (lie) {
        p.stats.lies++;
        this.#moment(1, "lieClear", { guard: p.id, thief: th.id, where: w });
      }
      if (kind === "seen") this.#emit({ k: "seen", guard: p.id, where: w, dir: m.dir!, mark: id });
      else this.#emit({ k: kind, guard: p.id, where: w, mark: id });
    };
  }

  /** A Post's place: the door, gate or spot within 2 tiles (nearest), else null. */
  #postSnap(x: number, y: number): { where: Where; x: number; y: number } | null {
    const map = this.map;
    let best: { where: Where; x: number; y: number } | null = null;
    let bd = 2 + 1e-9;
    for (const d of map.doors) {
      const e = distToTile(map, { x, y }, d.i);
      if (e < bd) {
        bd = e;
        best = { where: { door: d.id }, x: d.x + 0.5, y: d.y + 0.5 };
      }
    }
    for (const g of map.gates) {
      const e = distToRect({ x, y }, g.rect);
      if (e < bd) {
        bd = e;
        best = { where: { gate: g.id }, x: g.rect.x + g.rect.w / 2, y: g.rect.y + g.rect.h / 2 };
      }
    }
    for (const s of map.spots) {
      const e = distToRect({ x, y }, s.rect);
      if (e < bd) {
        bd = e;
        best = { where: { spot: s.id }, x: s.rect.x + s.rect.w / 2, y: s.rect.y + s.rect.h / 2 };
      }
    }
    return best;
  }

  #endMark(m: MarkState): void {
    const k = this.#marks.indexOf(m);
    if (k < 0) return;
    this.#marks.splice(k, 1);
    m.ended = round2(this.#t);
    if (m.kind === "post" && m.near > CLOSE_PASS) {
      m.lie = true;
      const g = this.#actors.get(m.guard);
      if (g) g.stats.lies++;
      this.#moment(1, "liePost", { guard: m.guard, where: m.where }, m.t);
    }
  }

  // ---------------------------------------------------------------- the step

  /** Advances the heist by `dt` seconds (default move.ts `DT`, 50 ms). Nothing happens once over. */
  step(dt: number = DT): void {
    if (this.over) return;
    const d = typeof dt === "number" && Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : DT;
    this.#t += d;
    this.#steps++;
    const prevLeft = this.#left;
    this.#left = Math.max(0, this.#left - d);

    const th = this.#thief;
    if (th.away) {
      th.awayFor += d;
      if (th.awayFor >= this.times.awayLimit - 1e-9) {
        this.#emit({ k: "left", thief: th.id });
        this.#finish("left");
        return;
      }
    }

    for (const a of this.#order) this.#move(a, d);

    // fuses
    for (const f of this.#fuses.splice(0).filter((f) => {
      if (f.at <= this.#t + 1e-9) return true;
      this.#fuses.push(f);
      return false;
    })) {
      this.#noise("firecracker", f.x, f.y, { k: "firecracker", where: this.#whereNear(f.x, f.y) });
      this.#tapeOnly({ k: "bang", x: pos(f.x), y: pos(f.y) });
      const far = new Set<number>();
      this.#guards.forEach((g, k) => {
        if (dist(g.body, f) > 5) far.add(k);
      });
      this.#watches.push({ t: this.#t, x: f.x, y: f.y, far, drew: [] });
    }

    this.#sense();
    if (this.over) return;

    // the clock
    if (!this.#lastMinute && prevLeft > 60 + 1e-6 && this.#left <= 60 + 1e-6 && this.#left > 0) {
      this.#lastMinute = true;
      this.#emit({ k: "lastMinute" });
    }
    if (this.#left <= 1e-9) {
      this.#emit({ k: "timeUp" });
      this.#moment(2, "timeUp", { thief: th.id });
      this.#finish("police");
      return;
    }
    this.#record();
  }

  #move(a: Actor, d: number): void {
    if (a.role === "guard") {
      if (a.cooldown > 0) a.cooldown = Math.max(0, a.cooldown - d);
      if (a.light === 1) {
        a.warm -= d;
        if (a.warm <= 1e-9) {
          a.light = 2;
          a.warm = 0;
        }
      }
    }
    a.moved = 0;
    if (this.#frozen(a)) return;
    if (a.busy) {
      a.busy.left -= d;
      if (a.busy.left <= 1e-9) {
        const b = a.busy;
        a.busy = null;
        b.done();
      }
      if (a.busy || !a.path) return;
      // a door pause just ended: walk on next step
      return;
    }
    if (!a.path || a.away) return;
    const x0 = a.body.x;
    const y0 = a.body.y;
    const ev = stepBody(a.body, a.path, d, this.#world);
    a.moved = dist(a.body, { x: x0, y: y0 });
    a.stats.walked += a.moved;
    if (!ev) return;
    if (ev.kind === "arrived") {
      a.path = null;
      a.goal = null;
    } else if (ev.kind === "door") {
      const locked = this.#doors[ev.door] === DOOR_LOCKED;
      if (locked && a.role === "thief") this.#begin(a, "pick", ev.door, this.times.pick, () => this.#openDoor(ev.door, a, true), true);
      else this.#begin(a, "door", ev.door, this.times.doorPause, () => this.#openDoor(ev.door, a), true);
    } else if (ev.kind === "stuck") {
      a.stuck++;
      const g = a.goal;
      if (a.stuck > 3 || !g) {
        a.path = null;
        a.goal = null;
        return;
      }
      const p = goTo(this.#world, a.body, g.x, g.y, { locked: a.role === "thief" ? this.times.pick : 0 });
      a.path = p;
      if (!p) a.goal = null;
    }
  }

  /** Sight and everything that follows from it: cameras, the hold, thefts discovered, pings, marks, the car, the ink. */
  #sense(): void {
    const map = this.map;
    const th = this.#thief;
    this.#sight = prepare(map, {
      doors: this.#doors,
      rooms: this.#rooms,
      lamps: this.#lamps,
      flashlights: this.#guards.map((g) => ({ x: g.body.x, y: g.body.y, facing: g.body.angle, on: g.light === 2 })),
    });
    for (const a of this.#order) a.seen = seenBy(this.#sight, { x: a.body.x, y: a.body.y, radius: a.role === "thief" ? THIEF_RADIUS : GUARD_RADIUS });
    const tt = this.#tileOf(th);

    // cameras
    for (const c of map.cameras) {
      if (this.#tampered[c.id]) {
        this.#camSees[c.id] = null;
        continue;
      }
      const sees = cameraSees(this.#sight, c, th.body.x, th.body.y);
      const was = this.#camSees[c.id] !== null;
      this.#camSees[c.id] = sees ? { x: pos(th.body.x), y: pos(th.body.y), facing: angle0(th.body.angle) } : null;
      if (sees) {
        this.#ink.restartAt(this.#t, th.body.x, th.body.y);
        if (!was) {
          this.#emit({ k: "sighting", camera: c.id, where: this.#whereNear(th.body.x, th.body.y) });
          this.#moment(1, "sighting", { thief: th.id, camera: c.id });
        }
      }
    }

    // the hold
    const h = this.#hold;
    if (h) {
      const g = h.guard;
      g.body.angle = facing(th.body.x - g.body.x, th.body.y - g.body.y);
      if (g.light !== 2 || !lineOfSight(map, this.#sight.opaque, g.body.x, g.body.y, th.body.x, th.body.y)) this.#endHold("holdBroken");
      else {
        const other = this.#guards.find((q) => q !== g && dist(q.body, th.body) <= this.times.arrestRange + 1e-9);
        if (other) {
          other.stats.arrests++;
          this.#arrest = { guard: other.id, x: pos(th.body.x), y: pos(th.body.y), t: round2(this.#t) };
          this.#emit({ k: "arrest", guard: other.id, thief: th.id });
          this.#moment(2, "arrest", { guard: other.id, thief: th.id });
          this.#finish("pinched", g.id, other.id);
          return;
        }
        if (this.#t >= h.until - 1e-9) this.#endHold("holdSlipped");
      }
    }

    // discovered thefts
    for (const s of this.#items) {
      if (s.taken === null || s.discovered) continue;
      if (this.#guards.some((g) => this.#seesTile(g, s.place.i))) {
        s.discovered = true;
        this.#missing.push({ item: s.item, room: s.place.room, x: s.place.x, y: s.place.y, t: round2(this.#t) });
        this.#emit({ k: "missing", item: s.item, where: { room: s.place.room } });
      }
    }

    // tag pings
    if (th.slots.some((s) => s.tagged)) {
      if (th.pingAt === null) th.pingAt = this.#t + this.times.pingEvery;
      else if (this.#t >= th.pingAt - 1e-9) {
        th.pingAt += this.times.pingEvery;
        this.#ping();
      }
    } else th.pingAt = null;

    // marks: fading, Posts visited
    for (const m of [...this.#marks]) {
      if (this.#t >= m.until - 1e-9) {
        this.#endMark(m);
        continue;
      }
      if (m.kind === "post") {
        const g = this.#actors.get(m.guard);
        if (g) m.near = Math.min(m.near, dist(g.body, m));
      }
    }

    // close passes
    for (const g of this.#guards) {
      const e = dist(g.body, th.body);
      if (e < CLOSE_PASS && !this.#seesTile(g, tt) && (g.stats.closest === null || e < g.stats.closest)) {
        g.stats.closest = Math.round(e * 100) / 100;
        g.closeT = this.#t;
        if (th.stats.closest === null || e < th.stats.closest) th.stats.closest = g.stats.closest;
      }
    }

    // firecrackers drawing guards
    for (const w of this.#watches) {
      if (this.#t - w.t > 15) continue;
      this.#guards.forEach((g, k) => {
        if (w.far.has(k) && dist(g.body, w) <= 4 && !w.drew.includes(g.id)) w.drew.push(g.id);
      });
    }

    // the car
    const spot = map.spots[this.estate.car];
    if (spot) {
      const inside = inRect(spot.rect, Math.floor(th.body.x), Math.floor(th.body.y));
      if (!inside) th.leftCar = true;
      else if (th.leftCar && !this.#frozen(th)) {
        this.#emit({ k: "gotAway", thief: th.id });
        this.#moment(2, "car", { thief: th.id, haul: this.#carried() });
        this.#finish("gotAway");
        return;
      }
    }

    this.#ink.step(this.#t);
  }

  #ping(): void {
    const th = this.#thief;
    const r = this.times.pingJitter;
    let dx = 0;
    let dy = 0;
    for (let k = 0; k < 32; k++) {
      dx = (this.#rng.float() * 2 - 1) * r;
      dy = (this.#rng.float() * 2 - 1) * r;
      if (dx * dx + dy * dy <= r * r) break;
    }
    const x = Math.min(this.map.w - 0.01, Math.max(0, th.body.x + dx));
    const y = Math.min(this.map.h - 0.01, Math.max(0, th.body.y + dy));
    this.#pings.push({ x: pos(x), y: pos(y), r: INK_DISC, t: round2(this.#t) });
    this.#emit({ k: "ping", where: this.#whereNear(x, y) });
    this.#ink.restartDisc(this.#t, x, y, INK_DISC);
  }

  #carried(): number {
    let v = 0;
    for (const s of this.#thief.slots) v += this.#items[s.item]!.night.item.value;
    return v;
  }

  #finish(outcome: HeistResult["outcome"], holder: string | null = null, arrester: string | null = null): void {
    if (this.#result) return;
    if (this.#hold && outcome !== "pinched") this.#hold = null;
    for (const m of [...this.#marks]) this.#endMark(m);
    this.#marks = [];
    const th = this.#thief;
    const stats: Record<string, PlayerStats> = {};
    for (const a of this.#order) stats[a.id] = { ...a.stats, walked: Math.round(a.stats.walked * 10) / 10 };
    this.#result = {
      outcome,
      t: round2(this.#t),
      thief: th.id,
      taken: th.slots.map((s) => s.item),
      haul: outcome === "gotAway" ? this.#carried() : 0,
      holder,
      arrester,
      car: this.estate.car,
      stats,
    };
    // close shaves as moments
    for (const g of this.#guards) {
      if (g.stats.closest !== null) this.#moment(2, "closeShave", { guard: g.id, thief: th.id, paces: Math.max(1, Math.round(g.stats.closest)) }, g.closeT);
    }
    for (const w of this.#watches) {
      if (w.drew.length >= 2) this.#moment(1, "firecracker", { thief: th.id, guards: w.drew.length, where: this.#whereNear(w.x, w.y) }, w.t);
    }
    this.#record(true);
  }

  // ---------------------------------------------------------------- bookkeeping

  #tileOf(a: Actor): number {
    const x = Math.min(this.map.w - 1, Math.max(0, Math.floor(a.body.x)));
    const y = Math.min(this.map.h - 1, Math.max(0, Math.floor(a.body.y)));
    return y * this.map.w + x;
  }

  #whereNear(x: number, y: number): Where {
    const w = whereAt(this.map, x, y);
    if (w) return w;
    const i = nearestWalkable(this.map, x, y);
    if (i !== null) {
      const v = whereAt(this.map, (i % this.map.w) + 0.5, Math.floor(i / this.map.w) + 0.5);
      if (v) return v;
    }
    return { area: Math.max(0, this.map.areas.length ? 0 : -1) };
  }

  #emit(b: TickerBody): void {
    const ev = { ...b, seq: this.#ticker.length + 1, t: round2(this.#t) } as TickerEvent;
    this.#ticker.push(ev);
    this.#tapeEvents.push({ ...b, t: round2(this.#t) } as TapeEvent);
  }

  #tapeOnly(b: TapeBody): void {
    this.#tapeEvents.push({ ...b, t: round2(this.#t) } as TapeEvent);
  }

  #moment(weight: 1 | 2, k: Moment["k"], p: Moment["p"], t = this.#t): void {
    this.#moments.push({ t: round2(t), weight, k, p });
  }

  /** The hold's lag window and the tape's 10 Hz samples. */
  #record(final = false): void {
    const th = this.#thief;
    const tt = this.#tileOf(th);
    this.#history.push({
      t: this.#t,
      tx: th.body.x,
      ty: th.body.y,
      g: this.#guards.map((g) => ({ x: g.body.x, y: g.body.y, a: g.body.angle, on: g.light === 2, sees: this.#seesTile(g, tt) })),
    });
    while (this.#history.length > 2 && this.#history[0]!.t < this.#t - this.times.holdLag - 0.2) this.#history.shift();
    if (final || this.#t >= this.#nextSample - 1e-6) {
      this.#nextSample += 1 / TAPE_HZ;
      for (const a of this.#order) {
        let flags = 0;
        if (a.light === 2) flags |= TRACK.LIGHT;
        if (this.#frozen(a)) flags |= TRACK.FROZEN;
        if (a.busy) flags |= TRACK.BUSY;
        if (a.away) flags |= TRACK.AWAY;
        this.#samples[a.index]!.push({ x: a.body.x, y: a.body.y, facing: a.body.angle, flags });
      }
    }
  }

  // ---------------------------------------------------------------- output: the public layer

  #layer(): PublicLayer {
    const t = this.#t;
    const h = this.#hold;
    return {
      v: 1,
      seq: this.#pubSeq,
      t: round2(t),
      left: round2(this.#left),
      length: this.length,
      rooms: Array.from(this.#rooms),
      lamps: Array.from(this.#lamps),
      cameras: this.map.cameras.map((c) => ({ id: c.id, tampered: !!this.#tampered[c.id], sees: this.#camSees[c.id] ?? null })),
      noises: this.#noises.filter((n) => t - n.t <= this.times.noiseShow + 1e-6),
      alarm: this.#alarm,
      missing: [...this.#missing],
      pings: this.#pings.filter((p) => t - p.t <= this.times.pingShow + 1e-6),
      holds: h
        ? [{ guard: h.guard.id, thief: h.thief.id, x: pos(h.thief.body.x), y: pos(h.thief.body.y), t: round2(h.t), until: round2(h.until), total: round2(h.total) }]
        : [],
      marks: this.#marks.map((m) => this.#markPub(m)),
      ink: encodeInk(this.#ink.inked, this.#inkMask),
      events: this.#ticker.slice(-EVENTS_KEPT),
      arrest: this.#arrest,
      end: this.#result ? { outcome: this.#result.outcome, t: this.#result.t } : null,
    };
  }

  #markPub(m: MarkState): MarkPub {
    const out: MarkPub = { id: m.id, guard: m.guard, kind: m.kind, x: m.x, y: m.y, where: m.where, t: m.t, until: m.until };
    if (m.angle !== undefined) out.angle = m.angle;
    if (m.dir !== undefined) out.dir = m.dir;
    return out;
  }

  #remember(l: PublicLayer): void {
    for (const [k, v] of Object.entries(l)) if (k !== "seq" && k !== "events" && k !== "ink" && k !== "t" && k !== "left") this.#pubJson.set(k, JSON.stringify(v));
    this.#pubInk = Uint8Array.from(this.#ink.inked);
    this.#pubEventSeq = this.#ticker.length;
  }

  /** The public layer whole, as of the last {@link Heist.publicDelta} (a keyframe for the TV or a joining phone). */
  publicLayer(): PublicLayer {
    return this.#pubLast;
  }

  /** {@link publicLayer} as a keyframe delta (`prev` -1), to put into a frame for a phone that (re)joins. */
  publicKey(): PublicDelta {
    const { v: _v, ...rest } = this.#pubLast;
    return { ...rest, prev: -1 };
  }

  /**
   * The public layer's changes since the last call (a new version):
   * call once per 10 Hz tick and send the same delta to the TV and every
   * phone (in their frames).
   */
  publicDelta(): PublicDelta {
    const prev = this.#pubSeq;
    this.#pubSeq++;
    const l = this.#layer();
    const d: PublicDelta = { seq: this.#pubSeq, prev, t: l.t, left: l.left };
    const out = d as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(l)) {
      if (k === "v" || k === "seq" || k === "t" || k === "left" || k === "events" || k === "ink") continue;
      const j = JSON.stringify(v);
      if (this.#pubJson.get(k) !== j) out[k] = v;
    }
    let inkChanged = false;
    const inked = this.#ink.inked;
    for (let i = 0; i < inked.length; i++) {
      if (inked[i] !== this.#pubInk[i]) {
        inkChanged = true;
        break;
      }
    }
    if (inkChanged) d.ink = encodeInk(inked, this.#inkMask, this.#pubInk);
    const fresh = this.#ticker.slice(this.#pubEventSeq);
    if (fresh.length) d.events = fresh;
    this.#pubLast = l;
    this.#remember(l);
    return d;
  }

  // ---------------------------------------------------------------- output: frames

  /**
   * Player `id`'s frame (§4, §11): only what that player may know. `pub`:
   * the public delta to carry (default: none, `{seq, prev, t, left}` of
   * the current version). Null for an unknown id.
   */
  frame(id: string, pub?: PublicDelta): Frame | null {
    const a = this.#actors.get(id);
    if (!a) return null;
    const map = this.map;
    const seen = a.seen;
    const light = new Uint8Array(seen.length);
    const L = this.#sight.light;
    for (let i = 0; i < seen.length; i++) if (seen[i]) light[i] = L[i]!;
    const others: SeenPlayer[] = [];
    for (const o of this.#order) {
      if (o === a || !seen[this.#tileOf(o)]) continue;
      const sp: SeenPlayer = {
        id: o.id, role: o.role, x: pos(o.body.x), y: pos(o.body.y), facing: angle0(o.body.angle), moving: o.moved > 1e-6,
        light: o.light === 2, held: this.#frozen(o), holding: this.#hold?.guard === o,
      };
      if (o.role === "thief") sp.sack = this.#slotsUsed();
      others.push(sp);
    }
    const items: SeenItem[] = [];
    const empty: SeenEmpty[] = [];
    for (const s of this.#items) {
      if (!seen[s.place.i]) continue;
      if (s.taken === null) items.push({ item: s.item, x: s.place.x, y: s.place.y, keep: s.place.keep, tagged: s.night.tagged });
      else empty.push({ item: s.item, x: s.place.x, y: s.place.y, keep: s.place.keep });
    }
    const doors: number[] = [];
    for (const d of map.doors) if (seen[d.i]) doors.push(d.id, this.#doors[d.id]!);
    const base = {
      id: a.id,
      x: pos(a.body.x),
      y: pos(a.body.y),
      facing: angle0(a.body.angle),
      moving: a.moved > 1e-6,
      goal: a.goal ? { x: pos(a.goal.x), y: pos(a.goal.y) } : null,
      busy: a.busy ? { kind: a.busy.kind, target: a.busy.target, left: round2(Math.max(0, a.busy.left)), total: a.busy.total } : null,
      frozen: this.#frozen(a),
      hold: this.#holdMine(a),
      offers: this.offers(id),
    };
    let me: ThiefMe | GuardMe;
    if (a.role === "thief") {
      me = {
        ...base,
        role: "thief",
        car: this.estate.car,
        slots: a.slots.map((s) => ({ ...s })),
        free: THIEF_SLOTS - this.#slotsUsed(),
        firecrackers: a.firecrackers,
        immune: round2(Math.max(0, a.immuneUntil - this.#t)),
        ping: a.pingAt === null ? null : round2(Math.max(0, a.pingAt - this.#t)),
      };
    } else {
      const mine = this.#marks.filter((m) => m.guard === a.id).length;
      me = {
        ...base,
        role: "guard",
        light: a.light === 2 ? "on" : a.light === 1 ? "warming" : "off",
        marksLeft: Math.max(0, this.times.marks - mine),
        cooldown: round2(a.cooldown),
        canHold: this.#canHold(a),
      };
    }
    return {
      v: 1,
      t: round2(this.#t),
      left: round2(this.#left),
      me,
      seen: encodeSeen(seen),
      light: rleEncode(light),
      others,
      items,
      empty,
      doors,
      pub: pub ?? { seq: this.#pubSeq, prev: this.#pubSeq, t: round2(this.#t), left: round2(this.#left) },
    };
  }

  /** A 10 Hz tick's output: one public delta (for the TV) and every player's frame carrying it. */
  frames(): { pub: PublicDelta; frames: Record<string, Frame> } {
    const pub = this.publicDelta();
    const frames: Record<string, Frame> = {};
    for (const a of this.#order) frames[a.id] = this.frame(a.id, pub)!;
    return { pub, frames };
  }

  #holdMine(a: Actor): HoldMine | null {
    const h = this.#hold;
    if (!h || (h.guard !== a && h.thief !== a)) return null;
    return { guard: h.guard.id, thief: h.thief.id, left: round2(Math.max(0, h.until - this.#t)), total: round2(h.total), wriggled: round2(h.wriggled) };
  }

  #canHold(g: Actor): boolean {
    if (this.#holdCheck(g, undefined) !== null) return false;
    // now, not just in the lag window: what the HOLD button shows
    const e = this.#history[this.#history.length - 1];
    return !!e && this.#shot(e, this.#guards.indexOf(g)) === "ok";
  }

  /** What player `id` can do where they stand now (the contextual buttons). */
  offers(id: string): Offer[] {
    const a = this.#actors.get(id);
    if (!a || this.over) return [];
    const map = this.map;
    const out: Offer[] = [];
    const ok = (act: Action) => {
      const r = this.#plan(a, act as Exclude<Action, { a: "aim" } | { a: "hold" }>);
      return typeof r !== "string";
    };
    if (a.role === "thief" && this.#hold?.thief === a) return [{ a: "wriggle", button: "wriggle" }];
    if (this.#hold?.guard === a) return [];
    if (a.role === "guard" && this.#canHold(a)) out.push({ a: "hold", target: this.#thief.id, button: "hold" });
    for (const d of doorsInReach(map, a.body)) {
      if (!this.#seesTile(a, map.doors[d]!.i)) continue;
      const s = this.#doors[d];
      if (s === DOOR_LOCKED && a.role === "thief") {
        if (ok({ a: "pick", door: d })) out.push({ a: "pick", door: d, button: "pickLock" });
      } else if (ok({ a: "door", door: d })) out.push({ a: "door", door: d, button: s === DOOR_OPEN ? "close" : "open" });
    }
    for (const w of windowsInReach(map, a.body)) if (ok({ a: "climb", window: w })) out.push({ a: "climb", window: w, button: "climb" });
    for (const r of map.rooms) {
      if (r.switches.some((i) => distToTile(map, a.body, i) <= REACH) && ok({ a: "switch", room: r.id })) {
        out.push({ a: "switch", room: r.id, button: this.#rooms[r.id] ? "lightsOff" : "lightsOn" });
      }
    }
    if (a.role === "thief") {
      for (const s of this.#items) if (s.taken === null && inReach(map, a.body, s.place.i) && ok({ a: "take", item: s.item })) out.push({ a: "take", item: s.item, button: "take" });
      for (const l of map.lamps) if (this.#lamps[l.id] && inReach(map, a.body, l.i) && ok({ a: "smash", lamp: l.id })) out.push({ a: "smash", lamp: l.id, button: "smashLamp" });
      for (const c of map.cameras) if (!this.#tampered[c.id] && inReach(map, a.body, c.i) && ok({ a: "tamper", camera: c.id })) out.push({ a: "tamper", camera: c.id, button: "tamper" });
      if (propsInReach(map, a.body).includes(map.workbench.prop) && ok({ a: "strip" })) out.push({ a: "strip", button: "stripTags" });
    }
    return out;
  }

  // ---------------------------------------------------------------- output: the tape

  /** The recording (§8), for the TV at the outcome (or so far, while running). */
  tape(): Tape {
    const truth: Truth = {
      car: this.estate.car,
      items: this.#items.map((s) => ({ item: s.item, x: s.place.x, y: s.place.y, room: s.place.room, keep: s.place.keep, taken: s.taken === null ? null : round2(s.taken) })),
      marks: this.#allMarks.map((m) => ({ ...this.#markPub(m), lie: m.lie, ended: m.ended ?? round2(this.#t) })),
      close: this.#guards.filter((g) => g.stats.closest !== null).map((g) => ({ guard: g.id, t: round2(g.closeT), d: g.stats.closest! })),
      firecrackers: this.#watches.map((w) => ({ t: round2(w.t), x: pos(w.x), y: pos(w.y), drew: [...w.drew] })),
    };
    const result: HeistResult = this.#result ?? {
      outcome: "police", t: round2(this.#t), thief: this.#thief.id, taken: this.#thief.slots.map((s) => s.item), haul: 0, holder: null, arrester: null,
      car: this.estate.car, stats: Object.fromEntries(this.#order.map((a) => [a.id, { ...a.stats }])),
    };
    return {
      v: 1,
      hz: TAPE_HZ,
      samples: Math.max(0, ...this.#samples.map((s) => s.length)),
      players: this.#order.map((a) => ({ id: a.id, role: a.role })),
      tracks: this.#samples.map((s) => encodeTrack(s)),
      events: [...this.#tapeEvents],
      truth,
      moments: [...this.#moments].sort((a, b) => a.t - b.t),
      result,
    };
  }
}
