// @ts-check
/**
 * What one phone knows during a heist (docs/pinch-design.md §4, §10,
 * §11), without the DOM: the host's frames decoded and remembered (the
 * seen tiles' ages, door states, loot and empty places), the public
 * layer kept up to date, the others drawn ~120 ms in the past between
 * the frames around that moment (by the frames' own clock, so uneven
 * frame spacing does not show), and one's own figure predicted with
 * move.ts the moment one taps. The fog is computed here too, from the
 * predicted position (sight.ts), and joined with what the host says one
 * sees, so it follows the figure without the network's lag.
 *
 * **The prediction.** `body` walks the phone's own path at once; the
 * host's position comes a round trip later. Each frame:
 * - the host on the phone's recent track (same errand, same way): all
 *   well; how far back on the track it is measures the lead (≈ the
 *   round trip);
 * - the host elsewhere while on the same errand (it found another way
 *   from where it was, a door took longer, a frame gap, a correction):
 *   start again from the host's position, its goal, `lead` seconds
 *   ahead along the path from there;
 * - the host standing, frozen in a hold or busy (picking, taking,
 *   climbing): stand where it stands (a `go` still on its way excepted);
 * - a `go` on its way (sent, not yet answered: {@link Heist.goSent},
 *   {@link Heist.goDone}): the frames still show the errand before it;
 *   refused: back to the host's errand.
 * Jumps of the simulated body are never drawn: the drawn position
 * ({@link Heist.at}) carries the difference as an offset that fades in
 * ~150 ms, so prediction and correction never fight over the body.
 * A closed door on the path opens in the prediction after the door
 * pause (the host's frames correct it when they say otherwise).
 *
 * Nothing here throws on odd data: a frame that does not decode is
 * dropped, an unknown id is skipped.
 */

import { createMemory, remember } from "./draw.js";
import { DOOR_LOCKED, DOOR_OPEN, DOOR_PAUSE, DT, PICK_TIME, SPEED, goTo, step } from "../game/move.js";
import { GUARD_RADIUS, LIGHT, THIEF_RADIUS, prepare, seenBy } from "../game/sight.js";
import { applyPublic, decodeFrameMasks } from "../game/protocol.js";

/** @typedef {import("../game/map.ts").Blueprint} Blueprint */
/** @typedef {import("../game/protocol.ts").Frame} Frame */
/** @typedef {import("../game/protocol.ts").SeenPlayer} SeenPlayer */
/** @typedef {import("../game/protocol.ts").PublicState} PublicState */
/** @typedef {import("../game/protocol.ts").ThiefMe} ThiefMe */
/** @typedef {import("../game/protocol.ts").GuardMe} GuardMe */
/** @typedef {import("../game/move.ts").Path} Path */

const fin = (/** @type {unknown} */ v) => typeof v === "number" && Number.isFinite(v);
const clamp = (/** @type {number} */ v, /** @type {number} */ a, /** @type {number} */ b) => (v < a ? a : v > b ? b : v);
/** Shortest turn from a to b, degrees. @param {number} a @param {number} b */
const turn = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;
const dist = (/** @type {{ x: number, y: number }} */ a, /** @type {{ x: number, y: number }} */ b) => Math.hypot(a.x - b.x, a.y - b.y);

/** How long the predicted track is kept to find the host on it (ms). */
const HISTORY = 3000;
/** The host this near the track (tiles): on it. */
const TRACK = 0.35;
/** Standing: off by less than this (tiles) is left alone. */
const IGNORE = 0.12;
/** A drawn offset longer than this (tiles, plus the lead's walk) is not glided: the figure jumps. */
const SNAP = 3;
/** How fast the drawn offset fades (per second, exponential: ~150 ms). */
const FADE = 14;
/** The lead's bounds and first guess (s): how far the prediction runs ahead of the host's frames. */
const LEAD = { min: 0, max: 1, first: 0.2 };
/** Others are drawn this far in the past (s), between the frames around that moment. */
export const RENDER_DELAY = 0.12;
/** Frames further apart than this (s) are not interpolated across (one appears, a gap). */
const GAP = 0.4;

/**
 * Something that happened in a frame that the page reacts to (a buzz, a toast).
 * @typedef {{ k: "hold", thief: string, guard: string } | { k: "holdEnd" } | { k: "arrest" } | { k: "end", outcome: string }
 *   | { k: "event", e: import("../game/protocol.ts").TickerEvent } | { k: "resync" } | { k: "taken", item: number }} Happening
 */

/** @typedef {{ t: number, x: number, y: number, facing: number, walk: number, p: SeenPlayer }} Sample */

export class Heist {
  /** @param {Blueprint} map @param {string} myId @param {"thief" | "guard"} role */
  constructor(map, myId, role) {
    this.map = map;
    this.myId = myId;
    this.role = role;
    const n = map.w * map.h;
    this.n = n;
    /**
     * What one remembers (draw.js Memory): per tile when last seen, the
     * doors' last seen states, the items and empty places.
     */
    this.mem = createMemory(map);
    /** The doors one walks in: the memory's, with the predicted openings. */
    this.walkDoors = Uint8Array.from(this.mem.doors);
    /** Doors the prediction opened (id → until when, ms). @type {Map<number, number>} */
    this.opened = new Map();
    /** @type {PublicState | null} */ this.pub = null;
    /** @type {Frame | null} */ this.frame = null;
    this.frameAt = 0;
    /** Host clock = performance.now() / 1000 + clockOff (s), from the frames that came quickest. */
    this.clockOff = NaN;
    /** The host's masks of the last frame. */
    /** @type {ArrayLike<number>} */ this.hostSeen = new Uint8Array(n);
    /** @type {ArrayLike<number>} */ this.hostLight = new Int32Array(n);
    /** What is drawn: the host's seen tiles and one's own, with the light. */
    this.seen = new Uint8Array(n);
    this.light = new Uint8Array(n);
    this.lastResync = -1e9;

    // One's own figure: the simulated body, and the offset the drawn one still carries.
    /** @type {{ x: number, y: number, angle: number }} */ this.body = { x: 0, y: 0, angle: 90 };
    this.offset = { x: 0, y: 0 };
    this.placed = false;
    /** @type {Path | null} */ this.path = null;
    /** @type {{ x: number, y: number } | null} */ this.goal = null;
    /** `go`s sent and not answered yet, and when the last one left (ms). */
    this.goPending = 0;
    this.goSentAt = -1e9;
    this.waitDoor = -1;
    this.waitSince = 0;
    this.acc = 0;
    this.walked = 0;
    this.moving = false;
    this.lead = LEAD.first;
    /** Corrections so far, by kind, and the last few with why (tests, debugging). @type {Record<string, number>} */
    this.fixes = { resync: 0, stand: 0, snap: 0 };
    /** @type {{ kind: string, t: number, why: string, off: number }[]} */ this.fixLog = [];
    this.why = "";
    /** @type {{ at: number, x: number, y: number }[]} */ this.history = [];
    /** A standing guard's aim, set by dragging (degrees), and until when it holds over the host's. */
    this.aim = 90;
    this.aimUntil = 0;
    /** What the page drew last (draw.js View), for tests. @type {unknown} */ this.view = null;
    /** The others' recent samples by id. @type {Map<string, Sample[]>} */ this.tracks = new Map();

    // Local sight.
    /** @type {import("../game/sight.ts").SightWorld | null} */ this.sight = null;
    this.sightKey = "";
    this.sightAt = -1e9;
    this.seenKey = "";
    /** @type {Uint8Array} */ this.localSeen = new Uint8Array(n);
  }

  /** @returns {ThiefMe | GuardMe | null} */
  get me() {
    return this.frame?.me ?? null;
  }

  /** Where one's figure is drawn: the prediction plus the fading offset. */
  get at() {
    return { x: this.body.x + this.offset.x, y: this.body.y + this.offset.y, angle: this.body.angle };
  }

  /** The host's clock now (s), estimated from the frames' `t` and when they came. @param {number} now performance.now() */
  hostNow(now) {
    if (!this.frame) return 0;
    if (!fin(this.clockOff)) return this.frame.t;
    return now / 1000 + this.clockOff;
  }

  /** The heist clock now (seconds since it started): the host's, never far from the last frame. @param {number} now */
  time(now) {
    if (!this.frame) return 0;
    return clamp(this.hostNow(now), this.frame.t, this.frame.t + 0.6);
  }

  /** Seconds left on the clock now. @param {number} now */
  left(now) {
    if (!this.frame) return 0;
    if (this.pub?.end) return Math.max(0, this.frame.left);
    return Math.max(0, this.frame.left - (this.time(now) - this.frame.t));
  }

  /**
   * A frame from the host.
   * @param {unknown} data @param {number} now performance.now()
   * @returns {Happening[]}
   */
  onFrame(data, now) {
    /** @type {Happening[]} */
    const out = [];
    const f = /** @type {Frame} */ (data);
    if (!f || typeof f !== "object" || f.v !== 1 || !fin(f.t) || !f.me || !fin(f.me.x) || !fin(f.me.y)) return out;
    if (this.frame && f.t <= this.frame.t) return out;
    const masks = decodeFrameMasks(f, this.map);
    if (!masks) return out;
    const map = this.map;

    // The public layer.
    const before = this.pub;
    if (f.pub && typeof f.pub === "object") {
      let next = null;
      try {
        next = applyPublic(this.pub, f.pub, map);
      } catch {
        next = null;
      }
      if (next) this.pub = next;
      else if (now - this.lastResync > 2000) {
        this.lastResync = now;
        out.push({ k: "resync" });
      }
    }
    this.#happenings(before, this.pub, out);

    // Doors, items and empty places on seen tiles.
    remember(this.mem, f, masks.seen);

    // Slots: a new item in the sack.
    if (this.role === "thief" && this.frame?.me.role === "thief" && f.me.role === "thief") {
      const had = this.frame.me.slots?.length ?? 0;
      const has = Array.isArray(f.me.slots) ? f.me.slots : [];
      for (let k = had; k < has.length; k++) out.push({ k: "taken", item: has[k]?.item ?? -1 });
    }

    // The clock: the quickest frames say how far the host is ahead; slowly forget, so a slower link is learnt.
    const off = f.t - now / 1000;
    this.clockOff = !fin(this.clockOff) || off > this.clockOff || off < this.clockOff - 1.5 ? off : Math.max(off, this.clockOff - 0.002);
    this.frame = f;
    this.frameAt = now;
    this.hostSeen = masks.seen;
    this.hostLight = masks.light;
    this.#track(f);
    this.#reconcile(f, now);
    this.sightAt = -1e9;
    return out;
  }

  /** @param {PublicState | null} a @param {PublicState | null} b @param {Happening[]} out */
  #happenings(a, b, out) {
    if (!b) return;
    const ha = a?.holds?.[0];
    const hb = b.holds?.[0];
    if (hb && (!ha || ha.t !== hb.t)) out.push({ k: "hold", thief: hb.thief, guard: hb.guard });
    if (ha && !hb) out.push({ k: "holdEnd" });
    if (b.arrest && !a?.arrest) out.push({ k: "arrest" });
    if (b.end && !a?.end) out.push({ k: "end", outcome: b.end.outcome });
    const last = a?.events?.at(-1)?.seq ?? 0;
    for (const e of b.events ?? []) if (e && e.seq > last) out.push({ k: "event", e });
  }

  // ------------------------------------------------------------ one's own figure

  /** The world move.ts walks in: the blueprint and the doors as one knows or predicts them. */
  get world() {
    return { map: this.map, doors: this.walkDoors };
  }

  /** @param {number} x @param {number} y */
  #pathTo(x, y) {
    return goTo(this.world, this.body, x, y, { locked: this.role === "thief" ? PICK_TIME : 0 });
  }

  /**
   * Walks to a tapped point at once (the phone's prediction of `go`);
   * false when there is no way there (the host gets the `go` anyway).
   * @param {number} x @param {number} y @param {number} now
   */
  walkTo(x, y, now) {
    if (this.me?.frozen) return false;
    const path = this.#pathTo(x, y);
    if (!path || !path.points.length) return false;
    this.path = path;
    const last = path.points[path.points.length - 1];
    this.goal = last ? { x: last.x, y: last.y } : null;
    this.waitDoor = -1;
    return true;
  }

  /**
   * A `go` leaves (the page calls this as it sends one). Until the host's
   * answer is back, frames may still show the errand before it: the host's
   * answer comes on the same ordered connection before any frame made
   * after it, so the answer, not a guess of the round trip, ends the wait.
   * @param {number} now
   */
  goSent(now) {
    this.goPending++;
    this.goSentAt = now;
  }

  /**
   * The host answered a `go` sent at `sentAt`: done (`ok`), or refused
   * (back to what the host does; the next frame puts the figure there,
   * unless a newer `go` is on its way). The round trip seeds the lead.
   * @param {boolean} ok @param {number} sentAt @param {number} now
   */
  goDone(ok, sentAt, now) {
    this.goPending = Math.max(0, this.goPending - 1);
    if (ok) this.lead = clamp(this.lead + ((now - sentAt) / 1000 - this.lead) * 0.5, LEAD.min, LEAD.max);
    else if (this.goPending === 0) {
      this.path = null;
      this.goal = null;
    }
  }

  /** Whether a `go` is on its way (bounded: a lost answer stops counting after 3 s). @param {number} now */
  pending(now) {
    return this.goPending > 0 && now - this.goSentAt < 3000;
  }

  stop() {
    this.path = null;
    this.goal = null;
  }

  /** @param {Frame} f @param {number} now */
  #reconcile(f, now) {
    const me = f.me;
    const host = { x: me.x, y: me.y };
    if (!this.placed) {
      this.body = { x: me.x, y: me.y, angle: fin(me.facing) ? me.facing : 90 };
      this.placed = true;
      return;
    }
    // A `go` on its way: the host's frames still show what it did before.
    const quiet = !this.pending(now);
    const busy = me.busy && me.busy.kind !== "door";

    // Frozen in a hold, or busy picking, taking, climbing: stand where the host stands.
    this.why = me.frozen ? "frozen" : busy ? `busy ${me.busy?.kind}` : "standing";
    if (me.frozen || busy) {
      if (me.frozen || quiet) {
        this.path = null;
        this.goal = null;
      }
      if (!this.path && dist(host, this.body) > IGNORE) this.#fix("stand", host, null);
      return;
    }
    // The host stands, with nowhere to go.
    if (!me.moving && !me.goal && !me.busy) {
      if (this.path && !quiet) return;
      this.path = null;
      this.goal = null;
      if (dist(host, this.body) > IGNORE) this.#fix("stand", host, null);
      return;
    }
    // The host walks (or waits at a door) towards its goal.
    const g = me.goal && fin(me.goal.x) && fin(me.goal.y) ? me.goal : null;
    const same = !!(g && this.goal && dist(g, this.goal) < 0.75);
    if (!same && !quiet) return; // the host still walks the last errand; the new one is on its way
    // Arrived first (the prediction runs a lead ahead): the host follows to the same place.
    if (!this.path && same && this.goal && dist(this.body, this.goal) < 0.3) return;
    if (this.path && same) {
      // On the track one walked? Then all is well, and how far back it is says the lead.
      let best = Infinity;
      let at = now;
      for (const h of this.history) {
        const d = dist(host, h);
        if (d < best) {
          best = d;
          at = h.at;
        }
      }
      if (dist(host, this.body) < best) {
        best = dist(host, this.body);
        at = now;
      }
      if (best < TRACK) {
        if (me.moving) this.lead = clamp(this.lead + ((now - at) / 1000 - this.lead) * 0.25, LEAD.min, LEAD.max);
        return;
      }
      // Waiting at the same door as the host: fine too.
      if (me.busy?.kind === "door" && this.waitDoor === me.busy.target && dist(host, this.body) < 0.8) return;
      this.why = `off track ${best.toFixed(2)}${me.busy ? ` busy ${me.busy.kind}` : ""}${me.moving ? "" : " standing"}`;
    } else this.why = !this.path ? "no path" : `other goal ${g ? dist(g, /** @type {{ x: number, y: number }} */ (this.goal)).toFixed(2) : "none"}`;
    this.#fix("resync", host, g, fin(me.facing) ? me.facing : undefined, !me.busy);
  }

  /**
   * Starts again from the host's position: standing there, or on the way
   * to `goal`, `lead` seconds ahead when `ahead`.
   * @param {string} kind @param {{ x: number, y: number }} host @param {{ x: number, y: number } | null} goal @param {number} [angle] @param {boolean} [ahead]
   */
  #fix(kind, host, goal, angle, ahead = false) {
    this.fixes[kind] = (this.fixes[kind] ?? 0) + 1;
    // The simulated body moves; the drawn figure stays where it was and glides after it (the offset).
    const was = this.at;
    this.fixLog.push({ kind, t: this.frame?.t ?? 0, why: this.why, off: Math.round(dist(was, host) * 100) / 100 });
    if (this.fixLog.length > 30) this.fixLog.shift();
    this.body.x = host.x;
    this.body.y = host.y;
    if (fin(angle)) this.body.angle = /** @type {number} */ (angle);
    this.history = [];
    this.acc = 0;
    this.waitDoor = -1;
    this.path = null;
    this.goal = null;
    if (goal) {
      const p = this.#pathTo(goal.x, goal.y);
      if (p && p.points.length) {
        this.path = p;
        this.goal = { x: goal.x, y: goal.y };
        if (ahead) {
          // The host is `lead` behind the body from here on: the stretch between goes on the track it is compared with.
          const now = performance.now();
          this.history.push({ at: now - this.lead * 1000, x: this.body.x, y: this.body.y });
          for (let t = 0; t < this.lead - 1e-9 && this.path; t += DT) {
            const ev = step(this.body, this.path, DT, this.world);
            this.history.push({ at: now - (this.lead - t - DT) * 1000, x: this.body.x, y: this.body.y });
            if (ev) {
              if (ev.kind === "arrived" || ev.kind === "stuck") this.path = null;
              break;
            }
          }
        }
      }
    }
    this.offset = { x: was.x - this.body.x, y: was.y - this.body.y };
    if (Math.hypot(this.offset.x, this.offset.y) > this.#snap()) {
      this.offset = { x: 0, y: 0 };
      this.fixes["snap"] = (this.fixes["snap"] ?? 0) + 1;
    }
  }

  /** Beyond this (tiles) the drawn figure jumps instead of gliding: more on a slow link, where the prediction runs further ahead. */
  #snap() {
    return SNAP + this.lead * SPEED;
  }

  /** The doors one walks in: the memory's, plus what the prediction opened (for a while). @param {number} now */
  #doors(now) {
    const d = this.walkDoors;
    d.set(this.mem.doors);
    for (const [id, until] of this.opened) {
      if (now > until || this.mem.doors[id] === DOOR_OPEN) this.opened.delete(id);
      else d[id] = DOOR_OPEN;
    }
  }

  /**
   * Advances the prediction to `now` (performance.now(), ms).
   * @param {number} now @param {number} dtMs
   */
  tick(now, dtMs) {
    if (!this.placed) return;
    const dt = clamp(dtMs / 1000, 0, 0.25);
    const me = this.me;
    this.#doors(now);
    const x0 = this.body.x;
    const y0 = this.body.y;
    if (this.path && !me?.frozen) {
      this.acc += dt;
      while (this.acc >= DT && this.path) {
        this.acc -= DT;
        const ev = step(this.body, this.path, DT, this.world);
        // Arrived (the goal stays: the host may still be on its way there) or stuck.
        if (ev?.kind === "arrived" || ev?.kind === "stuck") this.path = null;
        else if (ev?.kind === "door") {
          // At a closed door: it opens after the door pause (the host's says so a little later; a locked one the thief waits out).
          if (this.waitDoor !== ev.door) {
            this.waitDoor = ev.door;
            this.waitSince = now;
          }
          const locked = this.walkDoors[ev.door] === DOOR_LOCKED;
          if ((!locked || this.role === "guard") && now - this.waitSince >= DOOR_PAUSE * 1000) {
            this.opened.set(ev.door, now + 1500 + this.lead * 2000);
            this.walkDoors[ev.door] = DOOR_OPEN;
            continue;
          }
          this.acc = 0;
          break;
        } else this.waitDoor = -1;
      }
    } else this.acc = 0;
    const moved = Math.hypot(this.body.x - x0, this.body.y - y0);
    this.moving = !!this.path && moved > 0.0005;
    this.walked += moved;
    // The drawn offset fades.
    const k = Math.exp(-FADE * dt);
    this.offset.x *= k;
    this.offset.y *= k;
    if (Math.abs(this.offset.x) + Math.abs(this.offset.y) < 0.002) this.offset = { x: 0, y: 0 };
    // Facing: walking sets it; a standing guard's aim, else the host's.
    if (!this.path && me && !me.moving) {
      const want = this.role === "guard" && now < this.aimUntil ? this.aim : fin(me.facing) ? me.facing : this.body.angle;
      this.body.angle = (this.body.angle + turn(this.body.angle, want) * (1 - Math.exp(-14 * dt)) + 360) % 360;
    }
    if (moved > 0) this.history.push({ at: now, x: this.body.x, y: this.body.y });
    while (this.history.length && (this.history[0]?.at ?? now) < now - HISTORY) this.history.shift();
    if (this.history.length > 400) this.history.splice(0, this.history.length - 400);
    this.#see(now);
  }

  /** Aims a standing guard's flashlight (degrees). @param {number} angle @param {number} now */
  aimAt(angle, now) {
    this.aim = ((angle % 360) + 360) % 360;
    this.aimUntil = now + 1500;
  }

  // ------------------------------------------------------------ the others

  /** Keeps the others' samples (by the frames' clock). @param {Frame} f */
  #track(f) {
    const seenNow = new Set();
    for (const o of Array.isArray(f.others) ? f.others : []) {
      if (!o || typeof o.id !== "string" || !fin(o.x) || !fin(o.y)) continue;
      seenNow.add(o.id);
      let list = this.tracks.get(o.id);
      const last = list?.at(-1);
      // After a gap (out of sight, frames lost) a new track: never glide across what one did not see.
      if (!list || !last || f.t - last.t > GAP || dist(last, o) > 2.5) {
        list = [];
        this.tracks.set(o.id, list);
      }
      const walk = (last && list.length ? last.walk + dist(last, o) : 0);
      list.push({ t: f.t, x: o.x, y: o.y, facing: fin(o.facing) ? o.facing : 90, walk, p: o });
      while (list.length > 2 && (list[1]?.t ?? 0) < f.t - 1) list.shift();
    }
    for (const id of this.tracks.keys()) if (!seenNow.has(id)) this.tracks.delete(id);
  }

  /**
   * The others as drawn now: those in the last frame, where they were
   * {@link RENDER_DELAY} ago on the host's clock, between the two frames
   * around that moment (held at the newest when frames are late).
   * @param {number} now
   * @returns {(SeenPlayer & { walk: number })[]}
   */
  others(now) {
    const rt = this.hostNow(now) - RENDER_DELAY;
    /** @type {(SeenPlayer & { walk: number })[]} */
    const out = [];
    for (const list of this.tracks.values()) {
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) continue;
      if (list.length === 1 || rt >= last.t) {
        out.push({ ...last.p, walk: last.walk });
        continue;
      }
      if (rt <= first.t) {
        out.push({ ...first.p, walk: first.walk });
        continue;
      }
      let k = 0;
      while (k + 1 < list.length && (list[k + 1]?.t ?? Infinity) <= rt) k++;
      const a = /** @type {Sample} */ (list[k]);
      const b = /** @type {Sample} */ (list[k + 1] ?? a);
      const u = b.t > a.t ? clamp((rt - a.t) / (b.t - a.t), 0, 1) : 1;
      out.push({
        ...b.p, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, facing: (a.facing + turn(a.facing, b.facing) * u + 360) % 360,
        walk: a.walk + (b.walk - a.walk) * u, moving: a.p.moving || b.p.moving, held: b.p.held, light: u < 0.5 ? a.p.light : b.p.light,
      });
    }
    return out;
  }

  // ------------------------------------------------------------ sight

  /** One's own sight from the predicted position, joined with the host's. @param {number} now */
  #see(now) {
    const map = this.map;
    const me = this.me;
    if (!me) return;
    const lightOn = me.role === "guard" && me.light === "on";
    const at = this.at;
    const tile = Math.floor(at.y) * map.w + Math.floor(at.x);
    const aimKey = lightOn ? Math.round(at.angle / 6) : 0;
    const key = `${tile}|${aimKey}`;
    // The light changes with frames (10 Hz) and one's own flashlight.
    if (!this.sight || (now - this.sightAt > 100 && key !== this.sightKey) || this.sightAt < 0) {
      const pub = this.pub;
      const others = this.others(now).filter((o) => o.role === "guard" && o.light);
      const state = {
        doors: this.walkDoors,
        rooms: pub?.rooms?.length ? pub.rooms : map.rooms.map((r) => (r.lit ? 1 : 0)),
        lamps: pub?.lamps?.length ? pub.lamps : map.lamps.map(() => 1),
        flashlights: [
          ...(lightOn ? [{ x: at.x, y: at.y, facing: at.angle, on: true }] : []),
          ...others.map((o) => ({ x: o.x, y: o.y, facing: o.facing, on: true })),
        ],
      };
      try {
        this.sight = prepare(map, state);
      } catch {
        this.sight = null;
      }
      this.sightAt = now;
      this.sightKey = key;
      this.seenKey = "";
    }
    const sk = `${tile}|${this.sightAt}`;
    if (sk === this.seenKey || !this.sight) return;
    this.seenKey = sk;
    try {
      this.localSeen = seenBy(this.sight, { x: at.x, y: at.y, radius: this.role === "thief" ? THIEF_RADIUS : GUARD_RADIUS });
    } catch {
      this.localSeen = new Uint8Array(this.n);
    }
    // Other guards' torches only the host knows of: keep its torch bits when one sees such a guard.
    const keepTorch = (this.frame?.others ?? []).some((o) => o?.role === "guard" && o.light);
    const local = this.sight.light;
    const t = this.time(now);
    for (let i = 0; i < this.n; i++) {
      const s = this.localSeen[i] || this.hostSeen[i] ? 1 : 0;
      this.seen[i] = s;
      if (!s) {
        this.light[i] = 0;
        continue;
      }
      const host = this.hostSeen[i] ? (this.hostLight[i] ?? 0) & (keepTorch || !lightOn ? 7 : 7 & ~LIGHT.TORCH) : 0;
      this.light[i] = host | (this.localSeen[i] ? (local[i] ?? 0) : 0);
      this.mem.seenAt[i] = t;
    }
  }

  /** Whether a tile is seen now. @param {number} x @param {number} y */
  seesTile(x, y) {
    if (!fin(x) || !fin(y)) return false;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) return false;
    return !!this.seen[ty * this.map.w + tx];
  }
}
