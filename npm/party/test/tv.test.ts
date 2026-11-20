/** Keeping phones with the TV picture: `tvDelay`, `withTv`, `deadline`, `sentAt`. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { tvDelayOf, type CastStatus } from "../src/tvpipe.ts";
import { setup, tick, until } from "./helpers.ts";

test("withTv: phones and watchers apply a change when the TV shows it, TV pages at once", async () => {
  const s = await setup({ party: { tvDelay: 200 } });
  try {
    const phone = s.phone();
    await phone.join("Ann");
    const tv = s.screen("screen");
    await tv.connect();
    const watch = s.screen("watch");
    await watch.connect();
    await until(() => phone.rtt < 1000 && tv.rtt < 1000 && watch.rtt < 1000, 2000, "clock samples");
    assert.equal(phone.tvDelay, 200);
    assert.equal(tv.tvDelay, 200);

    const at: Record<string, number> = {};
    phone.on("view", (v) => v.room?.phase === "vote" && (at["phone"] ??= Date.now()));
    tv.on("view", (v) => v.screen?.phase === "vote" && (at["tv"] ??= Date.now()));
    watch.on("view", (v) => v.screen?.phase === "vote" && (at["watch"] ??= Date.now()));
    const t0 = Date.now();
    s.party.withTv(() => {
      s.party.room.set({ phase: "vote" });
      s.party.screen.set({ phase: "vote" });
    });
    await until(() => Object.keys(at).length === 3, 2000, "every view");
    assert.ok(at["tv"]! - t0 < 100, `TV at once (${at["tv"]! - t0} ms)`);
    assert.ok(at["phone"]! - t0 >= 150, `phone with the TV (${at["phone"]! - t0} ms)`);
    assert.ok(at["watch"]! - t0 >= 150, `watcher with the TV (${at["watch"]! - t0} ms)`);
  } finally {
    await s.close();
  }
});

test("withTv: what comes after a held change waits behind it; earlier changes go at once", async () => {
  const s = await setup({ party: { tvDelay: 150 } });
  try {
    const phone = s.phone();
    await phone.join("Ann");
    await until(() => phone.rtt < 1000, 2000, "clock samples");
    const seen: string[] = [];
    phone.on("view", (v) => seen.push(`${v.room?.phase}/${v.me?.task ?? "-"}`));
    phone.on("msg", (type) => seen.push(`msg ${type}`));
    const p = s.party.players[0]!;
    s.party.room.set({ phase: "before" });
    s.party.withTv(() => {
      s.party.room.set({ phase: "reveal" });
      s.party.broadcast("buzz");
    });
    p.state.set({ task: "watch" });
    await tick(60);
    assert.deepEqual(seen, ["before/-"], "only the change from before withTv");
    await until(() => seen.length === 4, 2000, "the rest");
    assert.deepEqual(seen, ["before/-", "msg buzz", "reveal/-", "reveal/watch"]);
  } finally {
    await s.close();
  }
});

test("without a TV withTv only runs its function; tvDelay reaches clients and their clocks", async () => {
  const s = await setup();
  try {
    const phone = s.phone();
    await phone.join("Ann");
    const tv = s.screen("screen");
    await tv.connect();
    assert.equal(s.party.withTv(() => 7), 7);
    s.party.withTv(() => s.party.room.set({ phase: "x" }));
    await until(() => phone.view["room"]?.phase === "x", 500, "an unheld change");
    assert.equal(phone.tvDelay, 0);

    const delays: number[] = [];
    tv.on("tv", (d: number) => delays.push(d));
    s.party.tvDelay = 300;
    await until(() => tv.tvDelay === 300 && phone.tvDelay === 300, 1000, "the delay");
    assert.deepEqual(delays, [300]);
    // A TV page counts down by the time its picture is shown; phones by the host's.
    const lead = tv.now() - tv.hostNow();
    assert.ok(Math.abs(lead - 300) < 2, `TV lead ${lead}`);
    assert.ok(Math.abs(phone.now() - phone.hostNow()) < 2);
    const d = s.party.deadline(10_000) - s.party.now();
    assert.ok(d >= 10_300 && d < 10_310, `deadline ${d}`);
    assert.ok(Math.abs(s.party.screenNow() - s.party.now() - 300) < 2);
    // Nobody waits forever: values beyond reason are clamped.
    s.party.tvDelay = 1e9;
    assert.equal(s.party.tvDelay, 5000);
  } finally {
    await s.close();
  }
});

test("a fixed tvDelay is not overridden by what the casts measure", async () => {
  const s = await setup({ party: { tvDelay: 80 } });
  try {
    s.party.followTv(400);
    assert.equal(s.party.tvDelay, 80);
  } finally {
    await s.close();
  }
  const t = await setup();
  try {
    t.party.followTv(400);
    assert.equal(t.party.tvDelay, 400);
    t.party.tvDelay = 120;
    t.party.followTv(500);
    assert.equal(t.party.tvDelay, 120, "set by the game: fixed");
  } finally {
    await t.close();
  }
});

test("actions carry when they were sent, clamped to the second before they arrived", async () => {
  const s = await setup();
  try {
    const sent: number[] = [];
    s.party.handle("buzz", (_data, _from, info) => void sent.push(info.sentAt));
    const phone = s.phone();
    await phone.join("Ann");
    await until(() => phone.rtt < 1000, 2000, "clock samples");
    const before = phone.hostNow();
    await phone.act("buzz");
    assert.equal(sent.length, 1);
    assert.ok(Math.abs(sent[0]! - before) < 20, `sentAt ${sent[0]! - before}`);

    // A raw socket claiming a time long ago (or in the future).
    const ws = new s.relay.WebSocket(s.ws);
    const got: Record<string, unknown>[] = [];
    ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.send(JSON.stringify({ t: "hello", v: 1, room: s.party.code, role: "player", key: s.party.joinKey, name: "Eve" }));
    await until(() => got.some((m) => m["t"] === "welcome"));
    const now = Date.now();
    ws.send(JSON.stringify({ t: "act", id: 1, type: "buzz", at: now - 60_000 }));
    ws.send(JSON.stringify({ t: "act", id: 2, type: "buzz", at: now + 60_000 }));
    ws.send(JSON.stringify({ t: "act", id: 3, type: "buzz", at: "soon" }));
    await until(() => sent.length === 4);
    const [, old, future, junk] = sent as [number, number, number, number];
    assert.ok(now - old >= 990 && now - old < 1100, `old ${now - old}`);
    assert.ok(Math.abs(future - now) < 100, `future ${future - now}`);
    assert.ok(Math.abs(junk - now) < 100, `junk ${junk - now}`);
    ws.close();
  } finally {
    await s.close();
  }
});

test("tvDelayOf: the slowest connected receiver, with the TV's lag", () => {
  const status = (receivers: CastStatus["receivers"], state: CastStatus["state"] = "streaming"): CastStatus => ({ state, receivers });
  assert.equal(tvDelayOf(status([], "starting")), undefined);
  assert.equal(tvDelayOf(status([{ name: "TV", protocol: "cast", state: "connected", delayMs: 300 }], "starting")), 450, "connected, frames to come");
  assert.equal(tvDelayOf(status([{ name: "TV", protocol: "airplay", state: "connected" }])), undefined, "no delay known");
  assert.equal(tvDelayOf(status([{ name: "TV", protocol: "airplay", state: "connected", delayMs: 100 }])), 250);
  assert.equal(
    tvDelayOf(
      status([
        { name: "Kitchen", protocol: "airplay", state: "connected", delayMs: 300 },
        { name: "Den", protocol: "cast", state: "reconnected", delayMs: 300 },
        { name: "Gone", protocol: "cast", state: "lost", delayMs: 900 },
      ]),
    ),
    450,
  );
  assert.equal(tvDelayOf(status([{ name: "browser", protocol: "browser", state: "connected", delayMs: 100 }])), 130, "no TV after a browser");
  assert.equal(tvDelayOf(status([{ name: "TV", protocol: "cast", state: "connected", delayMs: 300 }], "stopped")), undefined);
});
