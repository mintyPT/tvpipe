// @ts-check
/**
 * The TV's renderer without a connection: `createTv` builds the table in
 * `root` and returns the Tv; feed it views with `tv.update(view)`. The TV
 * page (screen.js) connects it to the party; the dev harness
 * (design/harness/) feeds it scripted views.
 */

import { bank, end, hotseat, jinx, lobby, replay, reveal, verdict, write } from "./scenes.js";
import { Tv } from "./tv.js";

/**
 * @param {{ root: HTMLElement, now: () => number, qrSvg: (qr: any, o: { quiet?: number }) => string, muted?: boolean }} o
 */
export function createTv(o) {
  return new Tv({ ...o, scenes: { lobby, hotseat, write, jinx, reveal, verdict, replay, bank, end } });
}
