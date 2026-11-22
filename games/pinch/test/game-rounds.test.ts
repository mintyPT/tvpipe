import assert from "node:assert/strict";
import { suite, test } from "node:test";

import { dropOuts } from "@tvpipe/party/testing";

import { itemById } from "../game/items.ts";
import type { RoomView } from "../game/views.ts";
import { game, seeded, until } from "./game-kit.ts";

suite("rounds", { concurrency: true }, () => {
  test("got away: the haul counts for the thief (guards who let it be)", async () => {
    const { g, players, ended, close } = await game(3, { seed: 5, bot: { idle: "guard", greed: 1 }, maxRounds: 2 });
    try {
      await players[0]!.client.act("start");
      const result = await ended;
      const away = result.history.filter((h) => h.outcome === "gotAway");
      assert.ok(away.length >= 1, JSON.stringify(result.history));
      for (const h of result.history) assert.ok(h.outcome === "gotAway" || h.outcome === "police", h.outcome);
      for (const h of away) {
        assert.equal(h.items.length, 1);
        assert.equal(h.haul, itemById(h.items[0]!)!.value);
        assert.deepEqual(h.rewards, {});
      }
      const r = (g.party.room.peek() as unknown as RoomView).awards!;
      assert.equal(r[0]!.id, "stickyFingers");
    } finally {
      close();
    }
  });

  test("rounds: twice: everyone the thief twice, never twice in a row", async () => {
    const { party, players, ended, close } = await game(3, { seed: 9, rounds: 2 });
    try {
      await players[0]!.client.act("start");
      const result = await ended;
      const thieves = result.history.map((h) => h.thief);
      assert.equal(thieves.length, 6);
      for (const p of party.players) assert.equal(thieves.filter((t) => t === p.id).length, 2);
      for (let i = 1; i < thieves.length; i++) assert.notEqual(thieves[i], thieves[i - 1]);
    } finally {
      close();
    }
  });

  test("a latecomer waits, plays guard from the next round and is the thief at the end", async () => {
    const { g, players, bot, room, ended, close } = await game(3, { seed: 4, timings: { briefing: 400 } });
    try {
      await players[0]!.client.act("start");
      await until(() => g.phase === "heist");
      const late = await bot("Latecomer");
      await until(() => late.me.role === "wait");
      assert.ok(!room().next.includes(late.client.you!["id"] as string));
      await until(() => g.roundNo === 2 && g.phase === "briefing");
      await until(() => late.me.role === "guard");
      assert.equal(room().next.at(-1), late.client.you!["id"]);
      const result = await ended;
      assert.equal(result.history.length, 4);
      assert.equal(result.history.at(-1)!.thief, late.client.you!["id"]);
    } finally {
      close();
    }
  });

  test("phones dropping out all game long: the game goes on and everyone is back at the end", async () => {
    const { players, ended, close } = await game(4, { seed: 12, maxRounds: 2 });
    try {
      const chaos = dropOuts(
        players.map((b) => b.client),
        { rng: seeded(2), every: 30, away: [0, 300] },
      );
      await players[0]!.client.act("start");
      const result = await ended;
      await chaos.stop();
      assert.equal(result.history.length, 2);
      // How many drops fit depends on the machine's speed (the heist runs on a fast clock): some, not a number.
      assert.ok(chaos.counts.network + chaos.counts.device > 1);
      await until(() => players.every((b) => b.me.role === "final"));
    } finally {
      close();
    }
  });

  test("the thief order hook: a fixed order (unknown ids skipped, the rest after it); the same seed, the same shuffle", async () => {
    const { g, party, players, ended, close } = await game(4, { seed: 21, maxRounds: 4, timings: { heist: 3 } });
    try {
      const ids = party.players.map((p) => p.id);
      g.thiefOrder = [ids[2]!, "nobody", ids[0]!];
      await players[0]!.client.act("start");
      const result = await ended;
      const thieves = result.history.map((h) => h.thief);
      assert.deepEqual(thieves.slice(0, 2), [ids[2], ids[0]]);
      assert.deepEqual(new Set(thieves.slice(2)), new Set([ids[1], ids[3]]));
    } finally {
      close();
    }
    // Shuffled from the game's rng: two games with the same seed pick the same order.
    const orders: string[][] = [];
    for (let k = 0; k < 2; k++) {
      const { g, players, ended, close } = await game(4, { seed: 33, maxRounds: 4, timings: { heist: 3 } });
      try {
        await players[0]!.client.act("start");
        await ended;
        orders.push(g.history.map((h) => g.party.player(h.thief)!.name));
      } finally {
        close();
      }
    }
    assert.deepEqual(orders[0], orders[1]);
  });
});
