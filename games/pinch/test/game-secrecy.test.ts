import assert from "node:assert/strict";
import { suite, test } from "node:test";

import type { Phase } from "../game/game.ts";
import { itemById } from "../game/items.ts";
import { game, until } from "./game-kit.ts";

suite("secrecy", { concurrency: true }, () => {
  test("secrecy: the car and the tip only to the thief; no frame to a screen; frames only to their own player", async () => {
    const { party, g, players, screen, room, screenView, ended, close } = await game(5, { seed: 11, maxRounds: 2 });
    const tv = await screen();
    const tvMsgs: { type: string; phase: Phase; json: string }[] = [];
    tv.on("msg", (type: string, data: unknown) => tvMsgs.push({ type, phase: g.phase, json: JSON.stringify(data) }));
    for (const b of players) b.log = [];
    const leaks: string[] = [];
    let briefed = 0;
    const sample = setInterval(() => {
      const e = g.estate;
      if (!e) return;
      const r = JSON.stringify(room());
      const s = JSON.stringify(screenView());
      for (const [name, j] of [["room", r], ["screen", s]] as const) {
        // The car is public from the outcome on (the TV shows it).
        const over = g.phase === "outcome" || g.phase === "tape" || g.phase === "scores" || g.phase === "final";
        if (/"(briefing|tip|places)":/.test(j) || (!over && /"car":/.test(j))) leaks.push(`${name} ${g.phase}`);
      }
      const thief = g.thief;
      for (const p of party.players) {
        const me = JSON.stringify(p.state.peek());
        if (p.id !== thief && /"(briefing|tip|car)":/.test(me)) leaks.push(`state of ${p.name}`);
        if (p.id === thief && (g.phase === "briefing" || g.phase === "heist") && /"car":/.test(me)) briefed++;
      }
    }, 7);
    try {
      await players[0]!.client.act("start");
      await ended;
      clearInterval(sample);
      assert.deepEqual(leaks, []);
      assert.ok(briefed > 10, "the thief had the briefing");
      // Frames: only "f" and only one's own; a guard's frame has no car.
      for (const b of players) {
        const id = b.client.you!["id"] as string;
        for (const m of b.log!) {
          assert.equal(m.type, "f", `${b.name} got a ${m.type}`);
          const f = m.data as { me: { id: string; role: string; car?: number } };
          assert.equal(f.me.id, id);
          if (f.me.role === "guard") assert.equal("car" in f.me, false);
        }
      }
      // The TV: public deltas and the tape, the tape only at the tape phase, never a frame.
      assert.ok(tvMsgs.some((m) => m.type === "pub"));
      assert.deepEqual([...new Set(tvMsgs.map((m) => m.type))].sort(), ["pub", "tape"]);
      for (const m of tvMsgs) {
        if (m.type === "tape") assert.equal(m.phase, "tape");
        else assert.doesNotMatch(m.json, /"(car|briefing|tip)":/);
      }
      assert.equal(tvMsgs.filter((m) => m.type === "tape").length, 2);
    } finally {
      clearInterval(sample);
      tv.close();
      close();
    }
  });

  test("the briefing: the thief's car and tip (one of the three most valuable), guards' start in the security office", async () => {
    const { g, players, room, close } = await game(4, { seed: 3, timings: { briefing: 3000 } });
    try {
      await players[0]!.client.act("start");
      await until(() => g.phase === "briefing" && players.every((b) => !!b.me.role && b.me.role !== "lobby"));
      const e = g.estate!;
      const thief = players.find((b) => b.client.you!["id"] === g.thief)!;
      await until(() => !!thief.me.briefing);
      const br = thief.me.briefing!;
      assert.equal(br.car, e.car);
      const top3 = g.catalogue.slice(0, 3).map((n) => n.item.id);
      assert.ok(top3.includes(br.tip.item));
      assert.ok(itemById(br.tip.item));
      const r = room();
      assert.equal(r.catalogue!.length, g.catalogue.length);
      assert.ok(r.blueprint && r.estate !== undefined && r.length === 30);
      assert.equal(r.thief, g.thief);
      for (const b of players) {
        if (b === thief) continue;
        assert.equal(b.me.role, "guard");
        const s = b.me.start!;
        assert.equal(e.map.roomAt[s.y * e.map.w + s.x], e.map.security);
      }
      const car = e.map.spots[e.car]!.rect;
      const ts = thief.me.start!;
      assert.ok(ts.x >= car.x - 1 && ts.x <= car.x + car.w && ts.y >= car.y - 1 && ts.y <= car.y + car.h);
    } finally {
      close();
    }
  });
});
