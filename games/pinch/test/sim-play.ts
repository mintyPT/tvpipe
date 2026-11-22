/** The whole-heist drivers and checks of the secrecy tests (§4, §7). */

import assert from "node:assert/strict";

import { TILE, type Estate } from "../game/map.ts";
import { ACTION_KINDS, applyPublic, decodeFrameMasks, publicState, type Frame, type PublicDelta, type PublicState } from "../game/protocol.ts";
import { Rng } from "../game/rng.ts";
import { Heist } from "../game/sim.ts";

export const IDS = ["T", "A", "B", "C", "D", "E", "F", "G"];
const floor2 = (v: number) => Math.floor(v * 100) / 100;

export function walkable(e: Estate): number[] {
  const out: number[] = [];
  for (let i = 0; i < e.map.tiles.length; i++) if (e.map.tiles[i] === TILE.FLOOR) out.push(i);
  return out;
}

/**
 * Plays a heist with scripted random inputs: the thief heads for loot,
 * takes what it can, throws, picks, runs; guards wander with their
 * lights, chase (they cheat: the test knows where the thief is), hold
 * when their phone says so, mark. Calls `check` with every 10 Hz output.
 */
export function play(
  e: Estate,
  players: number,
  seed: number,
  seconds: number,
  check: (h: Heist, pub: PublicDelta, frames: Record<string, Frame>) => void,
  junk = 0,
  chase = 0.15,
): Heist {
  const rng = new Rng(seed);
  const ids = IDS.slice(0, players);
  const h = new Heist(e, { thief: "T", guards: ids.slice(1), seed });
  const floor = walkable(e);
  const centre = (i: number) => ({ x: (i % e.map.w) + 0.5, y: Math.floor(i / e.map.w) + 0.5 });
  let frames: Record<string, Frame> = {};
  for (let k = 0; k < seconds * 20 && !h.over; k++) {
    for (const id of ids) {
      const f = frames[id];
      if (rng.chance(junk)) h.act(id, fuzz(rng));
      if (id === "T") {
        const take = f?.me.offers.find((o) => o.a === "take" || o.a === "pick" || o.a === "strip");
        if (take && !f?.me.busy) h.act(id, take);
        else if (f && f.me.offers.length && rng.chance(0.05)) h.act(id, rng.pick(f.me.offers)!);
        if (f && !f.me.busy && (!f.me.goal || rng.chance(0.003))) {
          const items = h.peekItems().filter((s) => s.taken === null);
          const target = rng.chance(0.7) && items.length ? centre((chase === 0 ? items[0]! : rng.pick(items)!).place.access) : centre(rng.pick(floor)!);
          h.go(id, target.x, target.y);
        }
        if (rng.chance(0.005)) {
          const p = h.peek("T")!;
          h.firecracker(id, p.x + rng.int(-6, 6), p.y + rng.int(-6, 6));
        }
        if (h.peekHold() && rng.chance(0.5)) h.wriggle(id);
        if (chase > 0 && rng.chance(0.001)) h.setAway(id, true);
        if (rng.chance(0.01)) h.setAway(id, false);
      } else {
        if (rng.chance(0.01)) h.flashlight(id, rng.chance(0.85));
        if (chase > 0 && f && (f.me as { canHold?: boolean }).canHold) h.hold(id);
        else if (rng.chance(0.01 * chase)) h.hold(id);
        if (rng.chance(0.015)) {
          const t = h.peek("T")!;
          const target = rng.chance(chase) ? t : centre(rng.pick(floor)!);
          h.go(id, target.x, target.y);
        }
        if (rng.chance(0.05)) h.aim(id, rng.int(0, 359));
        if (rng.chance(0.004)) {
          const p = centre(rng.pick(floor)!);
          h.mark(id, rng.pick(["clear", "seen", "post", "look"] as const)!, p.x, p.y, rng.int(0, 359));
        }
        const offers = f?.me.offers.filter((o) => chase > 0 || o.a !== "hold") ?? [];
        if (offers.length && rng.chance(0.02)) h.act(id, rng.pick(offers)!);
      }
    }
    h.step();
    if (k % 2 === 1) {
      const out = h.frames();
      frames = out.frames;
      check(h, out.pub, frames);
    }
  }
  return h;
}

export function fuzz(rng: Rng): unknown {
  const vals: unknown[] = [NaN, Infinity, -1, 0, 1e9, 3.5, -0.0, "x", "", null, undefined, {}, [], true, { a: "go" }, 2 ** 31, 12, 7.25];
  const v = () => rng.pick(vals);
  const r = rng.float();
  if (r < 0.1) return v();
  const kind = rng.chance(0.9) ? rng.pick(ACTION_KINDS) : rng.pick(["fly", "", "__proto__", "constructor"]);
  const o: Record<string, unknown> = { a: kind };
  for (const k of ["x", "y", "door", "window", "room", "item", "lamp", "camera", "on", "angle", "target", "kind", "mark"]) {
    if (rng.chance(0.5)) o[k] = k === "kind" ? rng.pick(["clear", "seen", "post", "look", "lie", 3]) : k === "target" ? rng.pick(["T", "A", "zz", 5]) : v();
  }
  return o;
}

/** Every rule of what a frame may hold (§4) and what the public layer may hold (§7). */
export function secrecy(e: Estate) {
  const pubs = new Map<string, PublicState | null>();
  let tv: PublicState | null = null;
  let frames = 0;
  let ticks = 0;
  return {
    get frames() {
      return frames;
    },
    check(h: Heist, pub: PublicDelta, all: Record<string, Frame>) {
      const map = e.map;
      const thief = h.peek("T")!;
      const items = h.peekItems();
      const doors = h.peekDoors();
      for (const [id, f] of Object.entries(all)) {
        frames++;
        const masks = decodeFrameMasks(f, map);
        assert.ok(masks, "masks decode");
        const seen = masks.seen;
        const truth = h.peek(id)!;
        for (let i = 0; i < seen.length; i++) if (seen[i] !== truth.seen[i]) assert.fail(`${id}: the seen mask is not the truth's at ${i}`);
        const at = (x: number, y: number) => Math.floor(y) * map.w + Math.floor(x);
        for (let i = 0; i < seen.length; i++) if (!seen[i]) assert.equal(masks.light[i], 0, "no light outside the seen tiles");
        for (const o of f.others) {
          assert.ok(seen[at(o.x, o.y)], `${id} sees ${o.id} only on a seen tile`);
          const p = h.peek(o.id)!;
          assert.equal(at(o.x, o.y), at(p.x, p.y));
        }
        // completeness: whoever stands on a seen tile is there
        for (const other of IDS) {
          const p = h.peek(other);
          if (!p || other === id) continue;
          assert.equal(f.others.some((o) => o.id === other), !!seen[at(p.x, p.y)]);
        }
        for (const it of f.items) {
          assert.ok(seen[it.y * map.w + it.x], "items only on seen tiles");
          const s = items[it.item]!;
          assert.equal(s.taken, null);
          assert.deepEqual([s.place.x, s.place.y], [it.x, it.y]);
        }
        for (const it of f.empty) {
          assert.ok(seen[it.y * map.w + it.x], "empty places only on seen tiles");
          assert.notEqual(items[it.item]!.taken, null);
        }
        for (let k = 0; k < f.doors.length; k += 2) {
          const d = map.doors[f.doors[k]!]!;
          assert.ok(seen[d.i], "door states only on seen tiles");
          assert.equal(f.doors[k + 1], doors[d.id]);
        }
        if (id === "T") {
          assert.equal(f.me.role, "thief");
          assert.equal((f.me as { car: number }).car, e.car);
        } else {
          assert.equal(f.me.role, "guard");
          assert.ok(!("car" in f.me), "only the thief's frame has the car");
          assert.ok(!JSON.stringify(f).includes('"car"'));
          for (const o of f.me.offers) if (o.a === "hold") assert.ok(seen[at(thief.x, thief.y)], "HOLD only when the thief is seen");
        }
        // the public layer as each phone keeps it
        const st = applyPublic(pubs.get(id) ?? null, f.pub, map) ?? (pubs.has(id) ? null : publicState(h.publicLayer(), map));
        assert.ok(st, "deltas apply");
        pubs.set(id, st);
      }
      tv = tv ? applyPublic(tv, pub, map) : publicState(h.publicLayer(), map);
      assert.ok(tv);
      const full = h.publicLayer();
      // the delta chain gives the keyframe (every second)
      if (++ticks % 10 === 0) {
        const key = publicState(full, map)!;
        assert.deepEqual({ ...tv, events: [] }, { ...key, events: [] });
        assert.deepEqual(tv.events.map((x) => x.seq), key.events.map((x) => x.seq));
      }
      // never a guard's position; the thief's only where public
      const tx = floor2(thief.x);
      const ty = floor2(thief.y);
      for (const hd of full.holds) assert.deepEqual([hd.x, hd.y], [tx, ty]);
      for (const c of full.cameras) if (c.sees) assert.deepEqual([c.sees.x, c.sees.y], [tx, ty]);
      if (full.arrest) assert.deepEqual([full.arrest.x, full.arrest.y], [tx, ty]);
      for (const m of full.missing) {
        const s = items[m.item]!;
        assert.ok(s.taken !== null && s.discovered, "only discovered thefts");
      }
      const json = JSON.stringify({ ...full, marks: [] });
      for (const g of h.guards) {
        const p = h.peek(g)!;
        const gx = floor2(p.x);
        const gy = floor2(p.y);
        if (gx === tx && gy === ty) continue;
        assert.ok(!json.includes(`"x":${gx},"y":${gy}`), `guard ${g} not in the public layer`);
      }
      assert.ok(!json.includes('"car"'));
      for (const id of h.guards) assert.ok(!json.includes(`"${id}"`) || full.holds.length || full.events.length || full.marks.length || full.arrest, "guards named only in facts");
    },
  };
}

