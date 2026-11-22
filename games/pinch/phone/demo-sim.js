// @ts-check
/**
 * The demo's host with the real rules (`?demo=…&host=sim`): game/sim.ts
 * runs the heist in the page, the other players wander as simple bots
 * (by `go` actions, as a phone would), and this phone's frames and
 * actions take the network's time: `&lag=MS` each way, `&jitter=MS`
 * more at random (in order, as over a WebSocket), `&pace=uneven` frames
 * 100 or 150 ms apart (a host page whose timer runs late). What the
 * prediction (world.js) has to cope with in a real game, reproducible.
 */

import { Heist } from "../game/sim.js";
import { DT } from "../game/move.js";
import { TILE } from "../game/map.js";

/** @typedef {import("../game/protocol.ts").Frame} Frame */

/**
 * @param {{
 *   estate: import("../game/map.ts").Estate, thief: string, guards: string[], me: string,
 *   catalogue: readonly import("../game/items.ts").NightItem[], rng: () => number,
 *   lag: number, jitter: number, uneven: boolean, still: boolean, scene: string, onFrame: (f: Frame) => void,
 * }} o
 */
export function simHost(o) {
  const h = new Heist(o.estate, { thief: o.thief, guards: o.guards, catalogue: o.catalogue });
  const map = o.estate.map;
  if (o.scene === "door") {
    // Two tiles before a closed inside door (unlocked for the thief), with floor beyond it.
    const floor = (/** @type {number} */ x, /** @type {number} */ y) => x >= 0 && y >= 0 && x < map.w && y < map.h && map.tiles[y * map.w + x] === TILE.FLOOR;
    for (const d of map.doors) {
      if (d.outside || (d.locked && o.me === o.thief)) continue;
      const [dx, dy] = d.wall === "h" ? [0, 1] : [1, 0];
      if (!floor(d.x - dx * 2, d.y - dy * 2) || !floor(d.x - dx, d.y - dy) || !floor(d.x + dx * 3, d.y + dy * 3) || !floor(d.x + dx, d.y + dy)) continue;
      h.place(o.me, d.x - dx * 2 + 0.5, d.y - dy * 2 + 0.5, d.wall === "h" ? 90 : 0);
      break;
    }
  }
  const bots = [o.thief, ...o.guards].filter((id) => id !== o.me);
  for (const id of o.guards) if (id !== o.me) h.flashlight(id, true);
  let key = true;
  let steps = 0;
  let nextFrame = 2;
  let lastDelivery = 0;
  /** In order, after the lag and some jitter. @param {() => void} fn */
  const deliver = (fn) => {
    const at = Math.max(lastDelivery, performance.now() + o.lag + o.rng() * o.jitter);
    lastDelivery = at;
    setTimeout(fn, Math.max(0, at - performance.now()));
  };
  const wait = () => new Promise((r) => setTimeout(r, o.lag + o.rng() * o.jitter));

  /** A bot's errand now and then: somewhere in a random room. @param {string} id */
  function errand(id) {
    if (o.still) return;
    const r = map.rooms[Math.floor(o.rng() * map.rooms.length)];
    if (!r) return;
    h.go(id, r.rect.x + o.rng() * r.rect.w, r.rect.y + o.rng() * r.rect.h);
  }

  function tick() {
    if (h.over) return;
    h.step(DT);
    steps++;
    for (const id of bots) if (o.rng() < 0.012) errand(id);
    if (steps < nextFrame) return;
    nextFrame += o.uneven && o.rng() < 0.4 ? 3 : 2;
    const pub = key ? h.publicKey() : h.publicDelta();
    key = false;
    const f = h.frame(o.me, pub);
    if (f) deliver(() => o.onFrame(f));
  }

  return {
    heist: h,
    tick,
    /** A phone action: to the host after the lag, the answer back after another. @param {unknown} a */
    async act(a) {
      await wait();
      const r = h.act(o.me, a);
      // The answer comes back in order with the frames, as over a WebSocket.
      return new Promise((ok) => deliver(() => ok(r)));
    },
    /** @param {number} angle */
    aim(angle) {
      deliver(() => h.aim(o.me, angle));
    },
    resync() {
      key = true;
    },
  };
}
