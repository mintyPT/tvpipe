import assert from "node:assert/strict";
import { suite, test } from "node:test";

import { game, ROUND, until } from "./game-kit.ts";

suite("whole games", { concurrency: true }, () => {
  for (const n of [3, 5, 8]) {
    test(`a whole game of ${n}: every player the thief once, scores from the rounds, the podium and awards`, async () => {
      const { party, g, players, phases, room, ended, close } = await game(n, { seed: n });
      try {
        await players[0]!.client.act("start");
        const result = await ended;
        assert.equal(result.history.length, n);
        assert.deepEqual(new Set(result.history.map((h) => h.thief)), new Set(party.players.map((p) => p.id)));
        assert.deepEqual(phases.slice(0, 5), ROUND);
        assert.equal(phases.at(-1), "final");
        for (const h of result.history) if (h.outcome === "left") assert.fail("nobody left");
        // Scores: the thief's haul when got away, $1,000 for the hold and $2,000 for the arrest.
        const expect: Record<string, number> = Object.fromEntries(party.players.map((p) => [p.id, 0]));
        for (const h of result.history) {
          if (h.outcome === "gotAway") expect[h.thief]! += h.haul;
          else assert.equal(h.haul, 0);
          if (h.outcome === "pinched") assert.deepEqual(Object.values(h.rewards).sort(), [1000, 2000]);
          for (const [id, v] of Object.entries(h.rewards)) expect[id]! += v;
        }
        assert.deepEqual(result.scores, expect);
        const podium = result.podium.map((id) => result.scores[id]!);
        assert.deepEqual(podium, [...podium].sort((a, b) => b - a));
        await until(() => players.every((b) => b.me.role === "final"));
        const r = room();
        assert.equal(r.phase, "final");
        assert.deepEqual(r.podium, result.podium);
        assert.ok((r.awards ?? []).length <= 3);
        const earned = result.history.some((h) => h.outcome === "pinched" || h.haul > 0);
        if (earned) assert.ok(r.awards!.length >= 1, `an award at least: ${JSON.stringify(result.history)}`);
        assert.equal(r.thief, null);
        assert.equal(party.inProgress, false);
        // Refusals happen in play (a hold that just missed, …); malformed or misrouted actions never.
        for (const b of players) assert.deepEqual(b.errors.filter((e) => e === "invalid" || e === "role" || !/^[a-z]+([A-Z][a-z]+)*$/.test(e)), [], `${b.name}: ${b.errors}`);
        assert.ok(players.every((b) => b.frames > 10));
        assert.equal(g.running, false);
      } finally {
        close();
      }
    });
  }

  test("bots with less skill (0.3): slower to react, clumsier holds, a looser patrol; still a whole game", async () => {
    const { players, ended, close } = await game(4, { seed: 17, bot: { skill: 0.3 } });
    try {
      await players[0]!.client.act("start");
      const result = await ended;
      assert.equal(result.history.length, 4);
      for (const b of players) assert.deepEqual(b.errors.filter((e) => e === "invalid" || e === "role"), []);
    } finally {
      close();
    }
  });
});
