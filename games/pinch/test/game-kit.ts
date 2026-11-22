/**
 * The whole-game tests' helpers (test/game-*.test.ts): a party on a
 * memory relay, the game with short phases and a heist ten times faster
 * than real time, bots, phones and a screen.
 */

import { Party } from "@tvpipe/party";
import { memoryStorage, PartyClient } from "@tvpipe/party/client";
import { MemoryRelay } from "@tvpipe/party/testing";

import { Bot, bots, type BotOptions } from "../game/bots.ts";
import { Pinch, type Phase, type Result, type Timings } from "../game/game.ts";
import { Rng } from "../game/rng.ts";
import type { RoomView } from "../game/views.ts";

/** The thief's player, by the game's thief id. */
export function thiefOf(players: readonly Bot[], g: Pinch): Bot {
  return players.find((b) => b.client.you!["id"] === g.thief)!;
}

/**
 * Short phases and a fast heist: 30 heist seconds at about 33 times real
 * time (0.9 s at most), frames every 8 ms (about 270 heist ms).
 */
export const fast: Partial<Timings> = { briefing: 20, outcome: 10, tape: 20, scores: 10, heist: 30, step: 1.5, frame: 8 };

export async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function seeded(seed: number): () => number {
  const r = new Rng(seed);
  return () => r.float();
}

export interface Opts {
  timings?: Partial<Timings>;
  rounds?: 1 | 2;
  seed?: number;
  oracle?: boolean;
  bot?: Partial<BotOptions>;
  minPlayers?: number;
  /** Stop after this many rounds (game.ts `maxRounds`). */
  maxRounds?: number;
}

export async function game(n: number, opts: Opts = {}) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 50, maxPlayers: 8, limits: { rate: 400, burst: 400 } }).listen(relay);
  const g = new Pinch(party, { timings: { ...fast, ...opts.timings }, rng: seeded(opts.seed ?? 7), rounds: opts.rounds, minPlayers: opts.minPlayers });
  g.maxRounds = opts.maxRounds ?? null;
  g.open();
  const phases: Phase[] = [];
  g.on("phase", (p) => phases.push(p));
  const o: Omit<BotOptions, "name"> = {
    url: "ws://party.test/_tvpipe/ws",
    WebSocket: relay.WebSocket,
    room: party.code,
    key: party.joinKey,
    seed: opts.seed ?? 7,
    oracle: opts.oracle === false ? undefined : () => g.truth(),
    // Bots act at most every 10 ms (the party's rate raised above), and the thief runs for the car with 12 of the 30 s left.
    gap: 10,
    margin: 12,
    ...opts.bot,
  };
  const players = await bots(n, o);
  const bot = async (name: string, more: Partial<BotOptions> = {}) => {
    const b = new Bot({ ...o, name, seed: name.length, ...more });
    await b.join();
    players.push(b);
    return b;
  };
  const phone = async (name: string) => {
    const c = new PartyClient({ url: o.url, room: party.code, key: party.joinKey, storage: memoryStorage(), WebSocket: relay.WebSocket });
    await c.join(name);
    return c;
  };
  const screen = async () => {
    const c = new PartyClient({ url: o.url, room: party.code, key: party.screenKey, role: "screen", storage: memoryStorage(), WebSocket: relay.WebSocket });
    await c.connect();
    return c;
  };
  const room = () => party.room.peek() as unknown as RoomView;
  const screenView = () => party.screenView()["screen"] as unknown as RoomView & Record<string, unknown>;
  const ended = new Promise<Result>((r) => g.once("end", r));
  const close = () => {
    g.close();
    for (const b of players) b.close();
    party.close();
  };
  return { relay, party, g, players, phases, bot, phone, screen, room, screenView, ended, close };
}

/** Every round's phases, in order. */

/** Every round's phases, in order. */
export const ROUND: Phase[] = ["briefing", "heist", "outcome", "tape", "scores"];
