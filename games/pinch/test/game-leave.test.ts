import assert from "node:assert/strict";
import { suite, test } from "node:test";

import type { RoomView } from "../game/views.ts";
import { game, until } from "./game-kit.ts";

suite("leaving", { concurrency: true }, () => {
  test("the thief away too long: the heist ends, left, no score, no tape; the next round", async () => {
    const { g, players, phases, ended, close } = await game(3, { seed: 6, timings: { awayLimit: 2 }, maxRounds: 2 });
    try {
      await players[0]!.client.act("start");
      await until(() => g.phase === "heist");
      const thief = players.find((b) => b.client.you!["id"] === g.thief)!;
      thief.client.drop({ away: 3000 });
      const result = await ended;
      assert.equal(result.history[0]!.outcome, "left");
      assert.equal(result.history[0]!.haul, 0);
      assert.deepEqual(result.history[0]!.rewards, {});
      assert.deepEqual(phases.slice(0, 4), ["briefing", "heist", "outcome", "scores"]);
      assert.equal(result.history.length, 2);
    } finally {
      close();
    }
  });

  test("players who leave lose their thief turn; the thief leaving ends the heist", async () => {
    const { g, players, room, ended, close } = await game(5, { seed: 8, timings: { briefing: 300 }, maxRounds: 3 });
    try {
      await players[0]!.client.act("start");
      await until(() => g.phase === "heist");
      // A guard whose turn is still to come leaves.
      const nextId = room().next.at(-1)!;
      const goner = players.find((b) => b.client.you!["id"] === nextId)!;
      await goner.client.leave();
      await until(() => !room().next.includes(nextId));
      // Then a thief leaves during their heist.
      await until(() => g.roundNo === 2 && g.phase === "heist");
      const thief = players.find((b) => b.client.you!["id"] === g.thief)!;
      await thief.client.leave();
      const result = await ended;
      assert.equal(result.history.length, 3);
      assert.equal(result.history[1]!.outcome, "left");
      assert.ok(!result.history.some((h) => h.thief === nextId));
      assert.ok(!(nextId in result.scores) || !result.podium.includes(nextId));
    } finally {
      close();
    }
  });

  test("too few players: a guard leaving a game of 3 ends it at once", async () => {
    const { g, players, ended, close } = await game(3, { seed: 2 });
    try {
      await players[0]!.client.act("start");
      await until(() => g.phase === "heist");
      const guard = players.find((b) => b.client.you!["id"] !== g.thief)!;
      await guard.client.leave();
      const result = await ended;
      assert.equal(result.ended, "few");
      assert.equal(result.history.length, 0);
      assert.equal((g.party.room.peek() as unknown as RoomView).ended, "few");
    } finally {
      close();
    }
  });

  test("the thief leaving during the briefing: straight to the outcome, left, no heist", async () => {
    const { g, players, phases, ended, close } = await game(4, { seed: 13, timings: { briefing: 5000 }, maxRounds: 2 });
    try {
      await players[0]!.client.act("start");
      await until(() => g.phase === "briefing" && !!g.thief);
      const thief = players.find((b) => b.client.you!["id"] === g.thief)!;
      const t0 = Date.now();
      await thief.client.leave();
      await until(() => g.phase === "outcome");
      assert.ok(Date.now() - t0 < 2000, "the briefing was cut short");
      g.configure({ timings: { briefing: 30 } });
      const result = await ended;
      assert.deepEqual(phases.slice(0, 3), ["briefing", "outcome", "scores"]);
      assert.equal(result.history[0]!.outcome, "left");
      assert.equal(result.history.length, 2);
    } finally {
      close();
    }
  });
});
