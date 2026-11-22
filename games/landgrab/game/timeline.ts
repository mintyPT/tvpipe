/**
 * How long the TV takes for each event of a round's resolution, and how
 * that time is split (docs/landgrab-design.md §5). The host waits
 * {@link eventMs} per event before the next one; the TV page plays the
 * event along {@link timeline}'s marks, so both agree without talking.
 */

import type { Event } from "./rules.ts";

export interface Pace {
  /** The reinforcements landing. */
  place: number;
  /** Armies marching between one's own territories. */
  move: number;
  /** Before the first throw: the camera, the arrow, the armies lining up. */
  intro: number;
  /** A head-on clash's extra lead-in (the two columns marching). */
  clash: number;
  /** Each of the first {@link Pace.slowRolls} throws, shown die by die. */
  roll: number;
  slowRolls: number;
  /** Each later throw (fast forward). */
  fastRoll: number;
  /** The most all throws of one fight take together. */
  maxRolls: number;
  /** After the last throw: the result, the flag going up or the retreat. */
  outro: number;
  /** A continent taken whole, or a player wiped out: a fanfare. */
  fanfare: number;
  /** The whole resolution's goal: longer rounds are played faster (down to {@link Pace.minScale}). */
  budget: number;
  minScale: number;
}

export const PACE: Pace = {
  place: 2600,
  move: 1500,
  intro: 1500,
  clash: 1400,
  roll: 1100,
  slowRolls: 2,
  fastRoll: 380,
  maxRolls: 5200,
  outro: 1500,
  fanfare: 2200,
  budget: 100_000,
  minScale: 0.45,
};

/** For tests and `?fast`: everything quick. */
export const FAST_PACE: Pace = { ...PACE, place: 900, move: 500, intro: 500, clash: 400, roll: 350, fastRoll: 120, maxRolls: 1500, outro: 500, fanfare: 600, budget: 30_000 };

/** The time of a fight's throws: the first few slowly, the rest fast, all of them within {@link Pace.maxRolls}. */
export function rollTimes(rolls: number, pace: Pace): number[] {
  const slow = Math.min(rolls, pace.slowRolls);
  const fast = rolls - slow;
  const room = pace.maxRolls - slow * pace.roll;
  const each = fast === 0 ? 0 : Math.max(60, Math.min(pace.fastRoll, room / fast));
  return Array.from({ length: rolls }, (_, i) => (i < slow ? pace.roll : Math.round(each)));
}

/**
 * An event's parts, in ms from its start: `[name, start, length]`.
 * Names: `place`, `move`, `intro`, `clash-intro`, `clash` (the head-on
 * throws, one mark per throw as `clash:N`), `roll:N` (each throw of the
 * attack), `outro`, `fanfare`.
 */
export function timeline(ev: Event, pace: Pace, scale = 1): [string, number, number][] {
  const out: [string, number, number][] = [];
  let at = 0;
  const push = (name: string, ms: number) => {
    const len = Math.round(ms * scale);
    out.push([name, at, len]);
    at += len;
  };
  switch (ev.type) {
    case "cancel":
      return [];
    case "place":
      push("place", pace.place);
      return out;
    case "move":
      push("move", pace.move);
      return out;
    case "attack":
      push("intro", pace.intro);
      rollTimes(ev.rolls.length, pace).forEach((ms, i) => push(`roll:${i}`, ms));
      push("outro", pace.outro);
      break;
    case "clash":
      push("intro", pace.intro);
      push("clash-intro", pace.clash);
      rollTimes(ev.rolls.length, pace).forEach((ms, i) => push(`clash:${i}`, ms));
      if (ev.then) {
        rollTimes(ev.then.rolls.length, pace).forEach((ms, i) => push(`roll:${i}`, ms));
      }
      push("outro", pace.outro);
      break;
  }
  if (ev.continent || ev.out) push("fanfare", pace.fanfare);
  return out;
}

/** An event's length on the TV, ms. */
export function eventMs(ev: Event, pace: Pace, scale = 1): number {
  const t = timeline(ev, pace, scale);
  const last = t[t.length - 1];
  return last ? last[1] + last[2] : 0;
}

/** The scale that keeps a round's events within the budget. */
export function paceScale(events: readonly Event[], pace: Pace): number {
  const total = events.reduce((s, e) => s + eventMs(e, pace), 0);
  if (total <= pace.budget) return 1;
  return Math.max(pace.minScale, pace.budget / total);
}
