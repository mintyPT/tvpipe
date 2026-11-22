/**
 * What crosses the wire during a heist (docs/pinch-design.md §4–§8,
 * §10, §11): the per-phone frame, the public layer (TV and phones), the
 * phones' actions and the refusals, the tape. The host's `game/sim.ts`
 * produces all of it; `game/game.ts` sends it (`party.send` per phone at
 * 10 Hz, the public layer to the TV at 10 Hz, the tape once at the
 * outcome); the pages decode it with the helpers at the end.
 *
 * Conventions:
 * - Coordinates as map.ts: floats in tiles (x east, y south), rounded
 *   to 1/100 tile on the wire; tiles as integer `x`, `y`. Angles
 *   degrees, 0 = east, 90 = south, integers on the wire.
 * - Time `t`: seconds since the heist started (the 50 ms step's clock,
 *   rounded to 1/100 s). `left`: seconds on the heist clock.
 * - Players by their party ids (strings). Items by their index in the
 *   night's catalogue (`NightItem[]`, most valuable first, as
 *   items.ts `pickCatalogue` returns it; public). Rooms, areas, doors,
 *   windows, lamps, cameras, spots, gates by their blueprint ids.
 * - Loot places (`Estate.places`) and the car (`Estate.car`) are
 *   secrets: they never appear on the wire except as what a phone sees
 *   (an item or an empty place on a seen tile: its tile), the thief's
 *   own car, and the tape (everything is revealed there).
 *
 * Secrecy (§4, §7): a frame holds only what its player may know: other
 * players, items, empty places and door states on tiles in that
 * player's seen mask, the public layer, and the player's own state. The
 * public layer holds only public facts: never a guard's position (a
 * hold shows the thief's place, a sighting the thief's figure), never an
 * item that was not discovered missing.
 */

import { VarintReader, VarintWriter, fromBase64, rleDecode, toBase64 } from "./codec.ts";
import { decodeInk, inkMask } from "./ink.ts";
import type { Blueprint, Keep } from "./map.ts";
import { CLIMB_TIME, DOOR_PAUSE, PICK_TIME } from "./move.ts";
import { decodeSeen } from "./sight.ts";
import type { Area, ButtonId, CaptionKind, Dir8, OutcomeKind, RefusalId } from "./words.ts";

// ---------------------------------------------------------------- timings

/** Frames and the public layer per second (§11); the tape's samples per second (§8). */
export const FRAME_HZ = 10;
export const TAPE_HZ = 10;

/**
 * The rules' numbers (§3–§7), seconds and tiles. `sim.ts` takes them as
 * defaults (`HeistOptions` may override any); pages use them for
 * progress rings and the HOLD button's prediction.
 */
export const TIMES = {
  /** Heist lengths to choose from (§13) and the default. */
  lengths: [150, 210, 300] as readonly number[],
  length: 210,
  doorPause: DOOR_PAUSE,
  pick: PICK_TIME,
  climb: CLIMB_TIME,
  take: { loose: 0.6, case: 2, safe: 5, pedestal: 1 } as Readonly<Record<Keep, number>>,
  /** The flashlight's switching on. */
  flashlight: 0.5,
  /** The hold (§5): reach, the lag window, a miss's cooldown, immunity after a hold, the arrest's reach. */
  holdRange: 5,
  /**
   * The lag window (§5, §15): `holdLag` without the action's age; with it
   * (the party's `sentAt`), 2 × age + `holdLagExtra`, clamped to
   * `holdLag`–`holdLagMax`.
   */
  holdLag: 0.25,
  holdLagExtra: 0.15,
  holdLagMax: 0.5,
  holdCooldown: 2,
  holdImmunity: 5,
  arrestRange: 1.5,
  /** Hold time: `holdBase` with 2 guards, `holdPerGuard` less per extra guard, at least `holdMin`. */
  holdBase: 10,
  holdPerGuard: 0.8,
  holdMin: 6,
  /** Each wriggle tap; at most `wriggleMax` in all; taps closer than `wriggleGap` count once. */
  wriggle: 0.15,
  wriggleMax: 3,
  wriggleGap: 0.05,
  /** Tag pings (§6): every `pingEvery` while a tagged item is carried; the ping lies within `pingJitter` of the thief. */
  pingEvery: 20,
  pingJitter: 2.25,
  strip: 3,
  firecrackers: 2,
  throwRange: 8,
  fuse: 1,
  tamper: 2,
  smash: 1,
  /** The police alarm sets the clock to this when more was left. */
  alarmLeft: 60,
  /** Marks (§7): per guard, their life. */
  marks: 3,
  markFade: 90,
  /** A thief away this long ends the heist (§11). */
  awayLimit: 10,
  /** How long a noise ripple, a ping and a finished hold stay in the public layer. */
  noiseShow: 3,
  pingShow: 6,
} as const;

/** The hold's lag window for an action `age` seconds old when it arrived (undefined, junk: unknown, the default window). */
export function holdWindow(age: number | undefined, t: { holdLag: number; holdLagExtra: number; holdLagMax: number } = TIMES): number {
  if (typeof age !== "number" || !Number.isFinite(age) || age < 0) return t.holdLag;
  return Math.min(t.holdLagMax, Math.max(t.holdLag, 2 * age + t.holdLagExtra));
}

/** The hold time for this many guards (§5): 10 s with 2, 0.8 s less per extra guard, at least 6 s. */
export function holdTime(guards: number, t: { holdBase: number; holdPerGuard: number; holdMin: number } = TIMES): number {
  const g = Number.isFinite(guards) ? Math.max(2, Math.floor(guards)) : 2;
  return Math.max(t.holdMin, t.holdBase - t.holdPerGuard * (g - 2));
}

// ---------------------------------------------------------------- places

/** A place for the ticker and marks, by blueprint id; {@link wordsArea} turns it into words.ts' `Area`. */
export type Where = { room: number } | { area: number } | { door: number } | { gate: number } | { spot: number };

/** The kinds of marks (§7). */
export const MARK_KINDS = ["clear", "seen", "post", "look"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

// ---------------------------------------------------------------- the ticker

/**
 * A ticker event (§7): a fact (words.ts `FactParams`) or a claim
 * (`ClaimParams`), language-free: `where` a {@link Where}, `item` a
 * catalogue index, `guard`/`thief` player ids, `dir` a words.ts `Dir8`.
 * Pages render them with words.ts `fact` / `claim` (`left`: outcome
 * "left"). `seq` counts from 1, without gaps, per heist.
 */
export type TickerBody =
  | { k: "start" }
  | { k: "sighting"; camera: number; where: Where }
  | { k: "tampered"; camera: number }
  | { k: "glass"; where: Where }
  | { k: "lamp"; lamp: number; where: Where }
  | { k: "firecracker"; where: Where }
  | { k: "alarm"; where: Where; seconds: number }
  | { k: "missing"; item: number; where: Where }
  | { k: "ping"; where: Where }
  | { k: "held"; guard: string; thief: string; where: Where }
  /** The hold ended early: sight broken or the light off. */
  | { k: "holdBroken"; guard: string; thief: string }
  /** The hold ran out (wriggled free or not). */
  | { k: "holdSlipped"; guard: string; thief: string }
  | { k: "arrest"; guard: string; thief: string }
  | { k: "gotAway"; thief: string }
  | { k: "timeUp" }
  | { k: "lastMinute" }
  | { k: "lightsOn"; where: Where }
  | { k: "lightsOff"; where: Where }
  | { k: "left"; thief: string }
  | { k: "clear"; guard: string; where: Where; mark: number }
  | { k: "seen"; guard: string; where: Where; dir: Dir8; mark: number }
  | { k: "post"; guard: string; where: Where; mark: number }
  | { k: "look"; guard: string; where: Where; mark: number };
export type TickerKind = TickerBody["k"];
export type TickerEvent = TickerBody & { seq: number; t: number };
/** Claims (marks, in the guard's colour) as opposed to facts (teletype). */
export const CLAIM_KINDS: readonly TickerKind[] = ["clear", "seen", "post", "look"];

// ---------------------------------------------------------------- the public layer

/** A camera (§7): tampered (static, a fact) and, while it sees the thief, the thief's figure. */
export interface CameraPub {
  id: number;
  tampered: boolean;
  /** The thief's position and facing while this camera sees them, else null. */
  sees: { x: number; y: number; facing: number } | null;
}

/** A noise (§4): ripples at a place, for {@link TIMES.noiseShow} seconds. */
export interface NoisePub {
  id: number;
  kind: "glass" | "lamp" | "firecracker" | "alarm";
  x: number;
  y: number;
  t: number;
}

/** The police alarm (§6), once rung. */
export interface AlarmPub {
  t: number;
  room: number;
  x: number;
  y: number;
}

/** A discovered theft (§6): the item, the room and the empty place's tile. */
export interface MissingPub {
  item: number;
  room: number;
  x: number;
  y: number;
  t: number;
}

/** A tag ping (§6): somewhere within `r` tiles of `(x, y)` (the disc the ink restarts on). */
export interface PingPub {
  x: number;
  y: number;
  r: number;
  t: number;
}

/**
 * A hold (§5), public: the thief's place (not the guard's!), the
 * deadline and the full time (a countdown ring), wriggles included.
 */
export interface HoldPub {
  guard: string;
  thief: string;
  x: number;
  y: number;
  t: number;
  /** When it ends unless broken (heist time). Moves earlier with every wriggle. */
  until: number;
  total: number;
}

/** A guard's mark, a claim (§7). */
export interface MarkPub {
  /** Unique per heist, from 1. */
  id: number;
  guard: string;
  kind: MarkKind;
  /** Where it was put (the tile's centre for Clear and Post snapped to their place). */
  x: number;
  y: number;
  /** Clear: the room or area; Post: the door, gate or spot near it, else the room/area; the others: the room/area at the place. */
  where: Where;
  /** Seen: the arrow. */
  angle?: number;
  dir?: Dir8;
  /** Placed, and when it fades (t + {@link TIMES.markFade}). */
  t: number;
  until: number;
}

/** The arrest (§5), the cuffs at the thief's place. */
export interface ArrestPub {
  guard: string;
  x: number;
  y: number;
  t: number;
}

/** The end of the heist, once over (the car itself is in the result and the tape). */
export interface EndPub {
  outcome: OutcomeKind;
  t: number;
}

/** The public layer, whole (a keyframe): what the TV shows (§7), and every phone as an overlay. */
export interface PublicLayer {
  v: 1;
  /** Counts the layer's versions: a delta applies to the version it names as `prev`. */
  seq: number;
  t: number;
  left: number;
  /** The heist's full length (seconds). */
  length: number;
  /** Per room id: 1 lit, 0 dark. */
  rooms: number[];
  /** Per lamp id: 1 on, 0 smashed. */
  lamps: number[];
  cameras: CameraPub[];
  noises: NoisePub[];
  alarm: AlarmPub | null;
  missing: MissingPub[];
  /** Pings of the last {@link TIMES.pingShow} seconds. */
  pings: PingPub[];
  /** Holds going on (at most one). */
  holds: HoldPub[];
  /** Marks not faded, oldest first. */
  marks: MarkPub[];
  /** The ink (ink.ts `encodeInk`, a keyframe over `inkMask(map)`). */
  ink: string;
  /** The last {@link EVENTS_KEPT} ticker events, oldest first. */
  events: TickerEvent[];
  arrest: ArrestPub | null;
  end: EndPub | null;
}
export const EVENTS_KEPT = 24;

/**
 * The public layer's changes since version `prev`: `t`, `left` always,
 * any other field of {@link PublicLayer} only when it changed (whole),
 * `ink` as ink.ts `encodeInk` against the previous ink (a `D` delta or a
 * keyframe), `events` only the new ones. Apply with {@link applyPublic};
 * a phone whose version is not `prev` waits for the next keyframe (the
 * game sends one on joining and every few seconds).
 */
export interface PublicDelta extends Partial<Omit<PublicLayer, "v" | "seq" | "events">> {
  seq: number;
  prev: number;
  t: number;
  left: number;
  events?: TickerEvent[];
}

// ---------------------------------------------------------------- the frame

/** What one is busy with: a progress ring. */
export type BusyKind = "door" | "pick" | "climb" | "take" | "tamper" | "smash" | "strip";
export interface Busy {
  kind: BusyKind;
  /** What it is done to: a door, window, lamp or camera id, a catalogue index (take), -1 (strip). */
  target: number;
  left: number;
  total: number;
}

/** Another player on a seen tile (§4). */
export interface SeenPlayer {
  id: string;
  role: "thief" | "guard";
  x: number;
  y: number;
  facing: number;
  moving: boolean;
  /** Guards: the flashlight is on. */
  light: boolean;
  /** In a hold (held or holding). */
  held: boolean;
  /** The guard holding the thief (draw the beam, not the net); `held && !holding`: the held thief. */
  holding?: boolean;
  /** The thief: slots filled (the sack, 0–4). */
  sack?: number;
}

/** An item on a seen tile (its place's tile). */
export interface SeenItem {
  item: number;
  x: number;
  y: number;
  keep: Keep;
  tagged: boolean;
}

/** An empty place on a seen tile: an item was taken from here (an empty pedestal, a smashed case, an open safe). */
export interface SeenEmpty {
  item: number;
  x: number;
  y: number;
  keep: Keep;
}

/**
 * Something one can do here, for the contextual button (§10): the
 * action to send (without the fields the phone adds itself) and its
 * button. `open`/`close`: a door (not yet in words.ts BUTTONS).
 */
export type Offer =
  | { a: "door"; door: number; button: "open" | "close" }
  | { a: "pick"; door: number; button: "pickLock" }
  | { a: "climb"; window: number; button: "climb" }
  | { a: "switch"; room: number; button: "lightsOn" | "lightsOff" }
  | { a: "take"; item: number; button: "take" }
  | { a: "smash"; lamp: number; button: "smashLamp" }
  | { a: "tamper"; camera: number; button: "tamper" }
  | { a: "strip"; button: "stripTags" }
  | { a: "hold"; target: string; button: "hold" }
  | { a: "wriggle"; button: "wriggle" };
/** Every button an offer may name: words.ts BUTTONS plus `open` / `close`. */
export type OfferButton = ButtonId | "open" | "close";

/** A hold one is part of, as one's phone shows it. */
export interface HoldMine {
  guard: string;
  thief: string;
  left: number;
  total: number;
  /** Seconds wriggled off so far. */
  wriggled: number;
}

interface MeBase {
  id: string;
  x: number;
  y: number;
  facing: number;
  moving: boolean;
  /** Where one walks to (the path's end), or null. */
  goal: { x: number; y: number } | null;
  busy: Busy | null;
  /** Held (the thief) or holding (the guard): no walking. */
  frozen: boolean;
  hold: HoldMine | null;
  offers: Offer[];
}

/** The thief's own state. */
export interface ThiefMe extends MeBase {
  role: "thief";
  /** The getaway car's spot (only ever in the thief's frame). */
  car: number;
  /** What is carried, in taking order. */
  slots: { item: number; tagged: boolean }[];
  /** Slots still free (of items.ts THIEF_SLOTS). */
  free: number;
  firecrackers: number;
  /** Seconds of immunity after a hold (0: none). */
  immune: number;
  /** Seconds to the next tag ping, or null (nothing tagged carried). */
  ping: number | null;
}

/** A guard's own state. */
export interface GuardMe extends MeBase {
  role: "guard";
  light: "off" | "warming" | "on";
  /** Marks before the oldest is replaced. */
  marksLeft: number;
  /** Seconds before the next hold attempt (a miss's cooldown). */
  cooldown: number;
  /** The thief is in this guard's lit cone, in reach and in sight now (the HOLD button). */
  canHold: boolean;
}

/**
 * A phone's frame at 10 Hz (§11). Everything about the world is on the
 * player's seen tiles (`seen`); the rest of what one knows is the
 * blueprint and the public layer.
 */
export interface Frame {
  v: 1;
  t: number;
  left: number;
  me: ThiefMe | GuardMe;
  /** The seen mask (sight.ts `encodeSeen`; `decodeSeen(seen, w * h)`). */
  seen: string;
  /** sight.ts `LIGHT` bits on seen tiles (0 elsewhere), codec.ts `rleEncode` (`rleDecode(light, w * h, 7)`). */
  light: string;
  others: SeenPlayer[];
  items: SeenItem[];
  empty: SeenEmpty[];
  /** Door states (move.ts `DOOR_*`) on seen tiles, flat: `[id, state, id, state, …]`. */
  doors: number[];
  /** The public layer's changes (or a keyframe: then `prev` is -1 and every field is there). */
  pub: PublicDelta;
}

// ---------------------------------------------------------------- actions

/**
 * A phone's input (§10, §11). Everything but `aim` is answered at once
 * with null (done) or a {@link Refusal}; `aim` is continuous (at most
 * every 100 ms) and never answered.
 */
export type Action =
  /** Walk to a point (snapped to the nearest standable tile; a new `go` cancels what one is busy with). */
  | { a: "go"; x: number; y: number }
  | { a: "stop" }
  /** Open or close a door within reach (walking through a closed door opens it anyway). */
  | { a: "door"; door: number }
  /** The thief picks a locked door within reach (walking through one picks it too). */
  | { a: "pick"; door: number }
  | { a: "climb"; window: number }
  /** A room's light, from one of its switch tiles. */
  | { a: "switch"; room: number }
  /** The thief takes a seen item within reach. */
  | { a: "take"; item: number }
  | { a: "smash"; lamp: number }
  | { a: "tamper"; camera: number }
  /** The thief strips the tags at the workbench. */
  | { a: "strip" }
  /** The thief throws a firecracker to a point in sight within {@link TIMES.throwRange}. */
  | { a: "firecracker"; x: number; y: number }
  | { a: "flashlight"; on: boolean }
  /** A standing guard aims the flashlight (degrees). */
  | { a: "aim"; angle: number }
  /** A guard holds the thief (`target`: the thief's id, optional). */
  | { a: "hold"; target?: string }
  | { a: "wriggle" }
  /** A guard's mark; `angle`: Seen's arrow. */
  | { a: "mark"; kind: MarkKind; x: number; y: number; angle?: number }
  | { a: "unmark"; mark: number };
export type ActionKind = Action["a"];
export const ACTION_KINDS: readonly ActionKind[] = [
  "go", "stop", "door", "pick", "climb", "switch", "take", "smash", "tamper", "strip",
  "firecracker", "flashlight", "aim", "hold", "wriggle", "mark", "unmark",
];

/**
 * Why an action was refused: words.ts' refusals, and a few more:
 * `busy` (doing something else), `blocked` (someone stands in the
 * doorway), `holding` (a guard frozen in a hold), `role` (not for this
 * role), `over` (the heist is over), `invalid` (malformed: a bug or a
 * forgery; pages show nothing).
 */
export type Refusal = RefusalId | "busy" | "blocked" | "holding" | "role" | "over" | "invalid";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1 << 20;

/** An action from untrusted data, or null. Never throws. */
export function parseAction(v: unknown): Action | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  switch (o["a"]) {
    case "go":
    case "firecracker":
      return isNum(o["x"]) && isNum(o["y"]) ? { a: o["a"], x: o["x"], y: o["y"] } : null;
    case "stop":
    case "strip":
    case "wriggle":
      return { a: o["a"] };
    case "door":
    case "pick":
      return isInt(o["door"]) ? { a: o["a"], door: o["door"] } : null;
    case "climb":
      return isInt(o["window"]) ? { a: "climb", window: o["window"] } : null;
    case "switch":
      return isInt(o["room"]) ? { a: "switch", room: o["room"] } : null;
    case "take":
      return isInt(o["item"]) ? { a: "take", item: o["item"] } : null;
    case "smash":
      return isInt(o["lamp"]) ? { a: "smash", lamp: o["lamp"] } : null;
    case "tamper":
      return isInt(o["camera"]) ? { a: "tamper", camera: o["camera"] } : null;
    case "flashlight":
      return typeof o["on"] === "boolean" ? { a: "flashlight", on: o["on"] } : null;
    case "aim":
      return isNum(o["angle"]) ? { a: "aim", angle: o["angle"] } : null;
    case "hold": {
      const t = o["target"];
      if (t === undefined || t === null) return { a: "hold" };
      return typeof t === "string" && t.length <= 200 ? { a: "hold", target: t } : null;
    }
    case "mark": {
      const kind = o["kind"];
      if (typeof kind !== "string" || !(MARK_KINDS as readonly string[]).includes(kind) || !isNum(o["x"]) || !isNum(o["y"])) return null;
      const angle = o["angle"];
      if (angle !== undefined && angle !== null && !isNum(angle)) return null;
      return isNum(angle) ? { a: "mark", kind: kind as MarkKind, x: o["x"], y: o["y"], angle } : { a: "mark", kind: kind as MarkKind, x: o["x"], y: o["y"] };
    }
    case "unmark":
      return isInt(o["mark"]) ? { a: "unmark", mark: o["mark"] } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- results

/** Per player, for the awards (§9) and the tape. */
export interface PlayerStats {
  /** Guards: holds made, holds tried and missed, arrests (as the second guard). */
  holds: number;
  misses: number;
  arrests: number;
  marks: number;
  /** Marks the truth contradicts (a Post never visited, a Clear with the thief inside). */
  lies: number;
  lightsOff: number;
  lightsOn: number;
  lampsSmashed: number;
  firecrackers: number;
  /** Tiles walked. */
  walked: number;
  /**
   * The closest unseen pass (tiles, centre to centre): guards, the
   * nearest the thief came to this guard without being in the guard's
   * seen mask; the thief, the nearest to any guard. Null: never within
   * {@link CLOSE_PASS}.
   */
  closest: number | null;
}
/** Passes nearer than this count as close (the tape's slow motion, §8). */
export const CLOSE_PASS = 3;

/** The heist's end (§2). */
export interface HeistResult {
  /** `gotAway` the car, `pinched` an arrest, `police` time's up, `left` the thief left. */
  outcome: OutcomeKind;
  t: number;
  thief: string;
  /** The catalogue indices the thief carried at the end. */
  taken: number[];
  /** Dollars that count: the carried value when got away, else 0. */
  haul: number;
  /** The guard whose hold ended in the arrest, and the arresting guard (pinched only). */
  holder: string | null;
  arrester: string | null;
  car: number;
  stats: Record<string, PlayerStats>;
}

// ---------------------------------------------------------------- the tape

/** Track sample flags. */
export const TRACK = {
  LIGHT: 1,
  /** In a hold (held or holding). */
  FROZEN: 2,
  BUSY: 4,
  AWAY: 8,
} as const;

/** One sample of a track. */
export interface Sample {
  x: number;
  y: number;
  facing: number;
  flags: number;
}

/**
 * Something that happened, for the tape (§8): every ticker event
 * (`TickerBody`), and the private ones nobody saw.
 */
export type TapeBody =
  | TickerBody
  | { k: "take"; item: number; keep: Keep }
  | { k: "pick"; door: number }
  | { k: "doorOpen"; door: number; by: string }
  | { k: "doorClose"; door: number; by: string }
  | { k: "climb"; window: number; by: string }
  | { k: "throw"; x: number; y: number }
  | { k: "bang"; x: number; y: number }
  | { k: "strip" }
  | { k: "holdTry"; guard: string; ok: boolean; why?: Refusal }
  | { k: "flashlight"; guard: string; on: boolean };
export type TapeEvent = TapeBody & { t: number };

/** A moment the tape slows down for, with its caption (words.ts `caption`; ids, catalogue indices and {@link Where}s as in the ticker). */
export interface Moment {
  t: number;
  /** How much it matters: 1 a little (×6 → ×2), 2 much (×1). */
  weight: 1 | 2;
  k: CaptionKind;
  p: Record<string, string | number | Where>;
}

/** The truth the tape reveals (§8). */
export interface Truth {
  car: number;
  /** Every item of the night: where it lay and when it was taken (null: never). */
  items: { item: number; x: number; y: number; room: number; keep: Keep; taken: number | null }[];
  /** Every mark with the verdict. */
  marks: (MarkPub & { lie: boolean; ended: number })[];
  /** Per guard, the closest unseen pass (only those within {@link CLOSE_PASS}). */
  close: { guard: string; t: number; d: number }[];
  /** Firecrackers and the guards they drew (came from beyond 5 tiles to within 4 in 15 s). */
  firecrackers: { t: number; x: number; y: number; drew: string[] }[];
}

/** The recording the TV gets once at the outcome (§8). */
export interface Tape {
  v: 1;
  hz: number;
  /** Samples per track. */
  samples: number;
  players: { id: string; role: "thief" | "guard" }[];
  /** Per player, in `players` order: {@link encodeTrack}. */
  tracks: string[];
  events: TapeEvent[];
  truth: Truth;
  moments: Moment[];
  result: HeistResult;
}

const Q = 20; // positions in 1/20 tile
const zz = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);
const unzz = (n: number) => (n & 1 ? -(n + 1) / 2 : n / 2);

/**
 * A track as varints, base64url: per sample a header `h`; odd `h`: the
 * last sample repeats `(h − 1) / 2` times; even: `h / 2` are the flags,
 * then the position's change in 1/20 tile and the facing's change in 2°
 * steps (the shorter way round), all zigzag. Standing costs nothing
 * (repeats), walking about four bytes a sample.
 */
export function encodeTrack(samples: readonly Sample[]): string {
  const w = new VarintWriter();
  let qx = 0;
  let qy = 0;
  let qf = 0;
  let fl = -1;
  let rep = 0;
  for (const s of samples) {
    const nx = Math.round((isNum(s.x) ? s.x : 0) * Q);
    const ny = Math.round((isNum(s.y) ? s.y : 0) * Q);
    const nf = ((Math.round((isNum(s.facing) ? s.facing : 0) / 2) % 180) + 180) % 180;
    const nfl = s.flags & 0xff;
    if (nx === qx && ny === qy && nf === qf && nfl === fl) {
      rep++;
      continue;
    }
    if (rep) w.uint(rep * 2 + 1);
    rep = 0;
    w.uint(nfl * 2);
    w.uint(zz(nx - qx));
    w.uint(zz(ny - qy));
    w.uint(zz(((nf - qf + 270) % 180) - 90));
    qx = nx;
    qy = ny;
    qf = nf;
    fl = nfl;
  }
  if (rep) w.uint(rep * 2 + 1);
  return toBase64(w.bytes);
}

/** {@link encodeTrack} back (at most `max` samples), or null. Never throws. */
export function decodeTrack(s: unknown, max = 1 << 16): Sample[] | null {
  const bytes = fromBase64(s);
  if (!bytes) return null;
  const r = new VarintReader(bytes);
  const out: Sample[] = [];
  let last: Sample | null = null;
  let qx = 0;
  let qy = 0;
  let qf = 0;
  while (!r.done) {
    const h = r.uint();
    if (h < 0) return null;
    if (h & 1) {
      const n = (h - 1) / 2;
      if (!last || out.length + n > max) return null;
      for (let k = 0; k < n; k++) out.push(last);
      continue;
    }
    const dx = r.uint();
    const dy = r.uint();
    const f = r.uint();
    if (dx < 0 || dy < 0 || f < 0 || f > 180 || out.length >= max) return null;
    qx += unzz(dx);
    qy += unzz(dy);
    qf = (((qf + unzz(f)) % 180) + 180) % 180;
    last = { x: qx / Q, y: qy / Q, facing: qf * 2, flags: h / 2 };
    out.push(last);
  }
  return out;
}

// ---------------------------------------------------------------- helpers for the pages

/** The {@link Where} of a tile: its room, else its outside area, else its door; null for none. */
export function whereAt(map: Blueprint, x: number, y: number): Where | null {
  if (!isNum(x) || !isNum(y)) return null;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return null;
  const i = ty * map.w + tx;
  if (map.roomAt[i]! >= 0) return { room: map.roomAt[i]! };
  if (map.areaAt[i]! >= 0) return { area: map.areaAt[i]! };
  if (map.doorAt[i]! >= 0) return { door: map.doorAt[i]! };
  return null;
}

/**
 * A {@link Where} as words.ts' `Area` (rooms numbered as the blueprint
 * labels them: `n` = nth + 1 when the kind repeats, corridors never;
 * variant 0); null for an unknown id.
 */
export function wordsArea(map: Blueprint, w: Where): Area | null {
  const num = <T extends { kind: string; nth: number }>(list: readonly T[], r: T) =>
    r.kind !== "corridor" && list.filter((q) => q.kind === r.kind).length > 1 ? { n: r.nth + 1 } : {};
  if ("room" in w) {
    const r = map.rooms[w.room];
    return r ? { room: r.kind, ...num(map.rooms, r) } : null;
  }
  if ("area" in w) {
    const a = map.areas[w.area];
    return a ? { outside: a.kind, ...num(map.areas, a) } : null;
  }
  if ("door" in w) {
    const d = map.doors[w.door];
    if (!d) return null;
    const r = map.rooms[Math.max(d.rooms[0], d.rooms[1])];
    return r ? { door: r.kind, ...num(map.rooms, r) } : null;
  }
  if ("gate" in w) {
    const g = map.gates[w.gate];
    return g ? { gate: g.side } : null;
  }
  const s = map.spots[w.spot];
  return s ? { spot: String(s.id + 1) } : null;
}

/** The public layer as a page keeps it: the ink decoded, the events gathered. */
export interface PublicState extends Omit<PublicLayer, "ink"> {
  /** 0/1 per tile. */
  ink: Uint8Array;
}

/** A keyframe decoded (null for anything malformed). */
export function publicState(layer: PublicLayer, map: Blueprint): PublicState | null {
  if (!layer || layer.v !== 1) return null;
  const ink = decodeInk(layer.ink, inkMask(map));
  if (!ink) return null;
  return { ...layer, ink, events: Array.isArray(layer.events) ? layer.events.slice(-EVENTS_KEPT) : [] };
}

/**
 * Applies a delta to a page's state; null when it does not apply (the
 * state's `seq` is not the delta's `prev`, or it is malformed): keep the
 * old state and wait for a keyframe. A keyframe delta (`prev` -1, every
 * field present) applies to anything, null included.
 */
export function applyPublic(state: PublicState | null, d: PublicDelta, map: Blueprint): PublicState | null {
  if (!d || typeof d !== "object") return null;
  const key = d.prev === -1;
  if (!key && (!state || state.seq !== d.prev)) return null;
  const mask = inkMask(map);
  let ink = state?.ink ?? null;
  if (d.ink !== undefined) {
    ink = decodeInk(d.ink, mask, ink);
    if (!ink) return null;
  }
  if (!ink) return null;
  const base: Omit<PublicState, "seq" | "t" | "left" | "ink" | "events"> =
    state ?? { v: 1, length: 0, rooms: [], lamps: [], cameras: [], noises: [], alarm: null, missing: [], pings: [], holds: [], marks: [], arrest: null, end: null };
  const events = key ? (d.events ?? []) : [...(state?.events ?? []), ...(d.events ?? [])];
  const { prev: _prev, events: _events, ink: _ink, ...rest } = d;
  return { ...base, ...rest, v: 1, ink, events: events.slice(-EVENTS_KEPT) };
}

/** A frame's masks decoded: the seen tiles (0/1) and their light bits. Null for malformed data. */
export function decodeFrameMasks(f: Frame, map: Blueprint): { seen: Uint8Array; light: Int32Array } | null {
  const n = map.w * map.h;
  const seen = decodeSeen(f?.seen, n);
  const light = rleDecode(f?.light, n, 7);
  return seen && light ? { seen, light } : null;
}
