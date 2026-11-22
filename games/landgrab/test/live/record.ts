/**
 * Records a whole game's TV views for `test/live/stage.ts` (not part of
 * `npm test`): bots play a game in memory with short timings, and every
 * screen view the host sets goes to a JSON file, in order. The stage
 * then plays them on the TV page at the real pace.
 *
 *   node test/live/record.ts [--players N] [--rounds N] [--lang en|de] [--seed N] [--out FILE]
 */

import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { Party } from "@tvpipe/party";
import { MemoryRelay } from "@tvpipe/party/testing";

import { bots } from "../../game/bots.ts";
import { Landgrab } from "../../game/game.ts";
import { seeded } from "../../game/rules.ts";
import { FAST_PACE } from "../../game/timeline.ts";
import { parseWorld } from "../../game/world.ts";

const { values: args } = parseArgs({
  options: {
    players: { type: "string", default: "4" },
    rounds: { type: "string", default: "3" },
    lang: { type: "string", default: "en" },
    seed: { type: "string", default: "7" },
    out: { type: "string", default: "/tmp/landgrab-views.json" },
  },
});

const world = parseWorld(readFileSync(new URL("../../data/world.txt", import.meta.url), "utf8"));
const relay = new MemoryRelay();
const party = new Party({ grace: 50, maxPlayers: 6, lateJoin: "wait" }).listen(relay);
const lang = args.lang === "de" ? "de" : "en";
const tiny = { ...FAST_PACE, place: 2, move: 2, intro: 2, clash: 2, roll: 1, fastRoll: 1, maxRolls: 10, outro: 2, fanfare: 2, budget: 1000 };
const g = new Landgrab(party, { world, rounds: Number(args.rounds), lang, timings: { plan: 300, firstPlan: 0, ready: 5, banner: 5, after: 5, pace: tiny }, rng: seeded(Number(args.seed)) });
g.open();
const views: unknown[] = [];
let last = "";
party.on("screen-view", (v) => {
  const s = JSON.stringify(v);
  if (s === last) return;
  last = s;
  views.push(JSON.parse(s));
});
const names = lang === "de" ? ["Phil", "Maximiliane", "Bartholomäus", "Ana", "Tom", "Lena"] : ["Phil", "Mia", "Jonas", "Alexandria", "Tom", "Lena"];
const o = { url: "ws://party.test/_tvpipe/ws", WebSocket: relay.WebSocket, room: party.code, key: party.joinKey, world, rng: seeded(Number(args.seed) + 1), think: () => 3, names };
const players = await bots(Number(args.players), o);
await new Promise((r) => setTimeout(r, 100));
const end = new Promise((r) => g.once("end", r));
await players[0]!.client.act("start");
await end;
await new Promise((r) => setTimeout(r, 100));
for (const b of players) b.close();
party.close();
writeFileSync(args.out, JSON.stringify(views));
console.log(`${views.length} views in ${args.out}`);
process.exit(0);
