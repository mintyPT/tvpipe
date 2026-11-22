/**
 * Web mode's transport end to end (docs/browser-party-design.md): a real
 * Party behind WebRtcRelay, real PartyClients on DataChannelSockets and
 * LocalSockets, through a fake tvpipe.party (signaling) and fake WebRTC.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { memoryStorage, PartyClient } from "../src/client.ts";
import { LocalHost, localSocketFor, localUrl } from "../src/local.ts";
import { Party } from "../src/party.ts";
import type { RelayConn } from "../src/relay.ts";
import { setWebDeps } from "../src/rtc.ts";
import { WebRtcRelay, type WebRtcRelayOptions } from "../src/rtc-relay.ts";
import { dataChannelSocket, DataChannelSocket, joinUrl, requestScreen } from "../src/rtc-socket.ts";
import { HostSignal, joinSignal, SignalError, type HostState } from "../src/signaling.ts";
import { FakeChannel, FakePeer, FakeService, ORIGIN, tick, until } from "./webfakes.ts";

let service: FakeService;
const cleanup: (() => void)[] = [];

beforeEach(() => {
  service = new FakeService();
  setWebDeps(service.deps);
  FakePeer.all = [];
});

afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) f();
  setWebDeps(undefined);
  await tick(20);
});

/** A registered room, a host on it, a party listening. */
async function host(o: { party?: ConstructorParameters<typeof Party>[0]; relay?: Partial<WebRtcRelayOptions>; code?: string } = {}) {
  const code = o.code ?? "BCDF";
  const reg = await service.fetch(`${ORIGIN}/api/links`, { method: "POST", body: JSON.stringify({ url: `${ORIGIN}/r/?r=${code}#k=x`, code }) });
  const { secret } = await reg.json();
  const signal = new HostSignal(HostSignal.url(ORIGIN, code), secret, service.deps);
  const states: HostState[] = [];
  signal.onstate = (s) => states.push(s);
  const relay = new WebRtcRelay({ signal, publicUrl: `${ORIGIN}/r/`, deps: service.deps, ...o.relay });
  const local = new LocalHost(code, relay.nextId, service.deps);
  relay.addLocal(local);
  const party = new Party({ code, ...o.party }).listen(relay);
  party.joinInfo = { code, url: `${ORIGIN}/r/?r=${code}#k=${party.joinKey}`, qr: null, mode: "web" };
  cleanup.push(() => {
    party.close();
    relay.close();
  });
  await until(() => signal.state === "hosted", 2000, "hosted");
  return { code, signal, relay, party, states, secret };
}

function phone(code: string, key: string | undefined, o: { role?: "player" | "screen" | "watch"; query?: string } = {}): PartyClient {
  const c = new PartyClient({ url: joinUrl(ORIGIN, code, o.query ?? ""), room: code, key, role: o.role ?? "player", storage: memoryStorage(), session: memoryStorage(), WebSocket: dataChannelSocket(service.deps), rejoinBadge: false });
  cleanup.push(() => c.close());
  return c;
}

function localClient(code: string, key: string, role: "player" | "screen" | "watch" = "screen"): PartyClient {
  const c = new PartyClient({ url: localUrl(ORIGIN, code), room: code, key, role, storage: memoryStorage(), session: memoryStorage(), WebSocket: localSocketFor(code, service.deps), rejoinBadge: false });
  cleanup.push(() => c.close());
  return c;
}

test("a phone joins over a data channel, acts, sees the view", async () => {
  const { code, party, relay } = await host();
  party.handle("hi", (data, from) => {
    party.room.set({ said: `${(from as any).name}: ${String(data)}` });
    return "ok";
  });
  const ann = phone(code, party.joinKey);
  const welcome = await ann.join("Ann");
  assert.equal(welcome["you"].name, "Ann");
  assert.equal(await ann.act("hi", "hello"), "ok");
  await until(() => ann.view["room"]?.said === "Ann: hello", 2000, "view");
  // The host saw where it came from.
  const conn = [...relay.connections()][0]!;
  assert.equal(conn.via, "public");
  assert.equal(conn.address, "203.0.113.9");
  assert.equal(conn.agent, "FakePhone/1.0");
  // ICE servers from /api/turn, fetched once (cached).
  assert.deepEqual((FakePeer.all[0]!.config as any).iceServers, [{ urls: "stun:stun.test:3478" }]);
  assert.equal(service.requests.filter((r) => r === "GET /api/turn").length, 1);
});

test("a dropped phone comes back by its token; a network cut is 1006 and reconnects", async () => {
  const { code, party } = await host();
  const ann = phone(code, party.joinKey);
  await ann.join("Ann");
  const id = ann.you!["id"];
  ann.drop({ away: 50 });
  await until(() => ann.status === "reconnecting", 2000, "reconnecting");
  await until(() => ann.status === "open", 4000, "back");
  assert.equal(ann.you!["id"], id);
  // A cut channel (no close frame): the host sees 1006, the phone reconnects.
  let hostSaw = 0;
  party.on("away", () => hostSaw++);
  const ch = FakePeer.all.filter((p) => p.channel).at(-1)!.channel as FakeChannel;
  ch.cut();
  await until(() => hostSaw === 1, 2000, "away");
  await until(() => ann.status === "open" && party.connectedPlayers.length === 1, 4000, "back again");
  assert.equal(ann.you!["id"], id);
});

test("a phone that vanishes without a word (its tab closed): away once ICE says so, not after the pings", async () => {
  const { code, party, relay } = await host({ relay: { limits: { lostMs: 30 } } });
  const ann = phone(code, party.joinKey);
  await ann.join("Ann");
  let away = 0;
  party.on("away", () => away++);
  // The host's peer connection: ICE disconnected (no close frame, the channel still "open").
  const hostPeer = FakePeer.all.find((p) => p.remoteDescription?.type === "offer")!;
  hostPeer.connectionState = "disconnected";
  hostPeer.onconnectionstatechange?.({});
  await tick(10);
  assert.equal(away, 0, "a short disconnect is waited out");
  hostPeer.connectionState = "connected";
  hostPeer.onconnectionstatechange?.({});
  await tick(60);
  assert.equal(away, 0, "back within the wait: nothing happened");
  hostPeer.connectionState = "disconnected";
  hostPeer.onconnectionstatechange?.({});
  await until(() => away === 1, 1000, "away after the wait");
  assert.equal([...relay.connections()].length, 0);
  // `failed` ends it at once (on the phone's side too: it reconnects).
  await until(() => ann.status === "open" && party.connectedPlayers.length === 1, 4000, "back");
  const peer = FakePeer.all.filter((p) => p.channel).at(-1)!;
  peer.connectionState = "failed";
  peer.onconnectionstatechange?.({});
  await until(() => ann.status !== "open", 1000, "the phone saw it");
});

test("a phone's page goes (pagehide): the host hears 1001 at once", async () => {
  // Node has no window: the page's events, for this test.
  const g = globalThis as { addEventListener?: unknown; removeEventListener?: unknown };
  const page = new EventTarget();
  g.addEventListener = page.addEventListener.bind(page);
  g.removeEventListener = page.removeEventListener.bind(page);
  cleanup.push(() => {
    delete g.addEventListener;
    delete g.removeEventListener;
  });
  const { code, party } = await host();
  const ann = phone(code, party.joinKey);
  await ann.join("Ann");
  const closes: number[] = [];
  party.on("away", () => closes.push(Date.now()));
  const t = Date.now();
  page.dispatchEvent(new Event("pagehide"));
  await until(() => closes.length === 1, 1000, "away");
  assert.ok(closes[0]! - t < 500);
});

test("close codes travel: kicked is final on the phone", async () => {
  const { code, party } = await host();
  const ann = phone(code, party.joinKey);
  await ann.join("Ann");
  const bye = new Promise<string>((r) => ann.on("bye", (reason: string) => r(reason)));
  party.kick(party.players[0]!);
  assert.equal(await bye, "kicked");
  await until(() => ann.status === "closed", 2000, "closed");
});

test("a wrong key: bad-key (4003)", async () => {
  const { code } = await host();
  const eve = phone(code, "wrong-key-wrong-key");
  await assert.rejects(eve.join("Eve"), (e: any) => e.code === "bad-key");
});

test("screens over the local transport; the watch preview too", async () => {
  const { code, party, relay } = await host();
  party.screen.set({ phase: "lobby" });
  const tv = localClient(code, party.screenKey, "screen");
  const welcome = await tv.connect();
  assert.equal(welcome["you"].role, "screen");
  await until(() => tv.view["screen"]?.phase === "lobby", 2000, "screen view");
  const conn = [...relay.connections()].find((c) => c.via === "local");
  assert.ok(conn);
  const watch = localClient(code, party.watchKey, "watch");
  await watch.connect();
  party.screen.set({ phase: "play" });
  await until(() => watch.view["screen"]?.phase === "play" && tv.view["screen"]?.phase === "play", 2000, "both");
  // A bot in the host's tab (a player over the local transport).
  const bot = localClient(code, party.joinKey, "player");
  await bot.join("Bot");
  assert.equal(party.players.length, 1);
  // A new host page (a reload): the local clients go to it.
  tv.drop();
  await until(() => tv.status === "open", 3000, "tv back");
});

test("a host that restarts: local screens reconnect (1012 on `up`)", async () => {
  const { code, party } = await host();
  const tv = localClient(code, party.screenKey, "screen");
  await tv.connect();
  const statuses: string[] = [];
  tv.on("status", (s: string) => statuses.push(s));
  // Another LocalHost appears (the next page): the old connection goes.
  const relay2 = new WebRtcRelay({ signal: { onoffer: undefined, answer: () => false, reject: () => false, close() {} }, publicUrl: "x", deps: service.deps });
  const party2 = new Party({ code, joinKey: party.joinKey }).listen(relay2);
  // `screenKey` is per party: the old screen key is wrong for the new one.
  relay2.addLocal(new LocalHost(code, relay2.nextId, service.deps));
  cleanup.push(() => {
    party2.close();
    relay2.close();
  });
  await until(() => statuses.includes("reconnecting"), 2000, "dropped by up");
});

test("limits: too big (1009), too fast (4008), no first message (4002)", async () => {
  const { code, party, relay } = await host({ relay: { limits: { message: 2000, rate: 5, burst: 5, firstMs: 300 } } });
  const conns: RelayConn[] = [];
  const prev = relay.onopen!;
  relay.onopen = (c) => {
    conns.push(c);
    prev(c);
  };
  // Too big.
  const big = phone(code, party.joinKey);
  await big.join("Big");
  const bigBye = new Promise<string>((r) => big.on("bye", (reason: string) => r(reason)));
  void big.act("x", "y".repeat(3000)).catch(() => {});
  assert.equal(await bigBye, "too-big");
  // Too fast (pings and acts count).
  const fast = phone(code, party.joinKey);
  await fast.join("Fast");
  const fastBye = new Promise<string>((r) => fast.on("bye", (reason: string) => r(reason)));
  for (let i = 0; i < 12; i++) void fast.act("x", i).catch(() => {});
  assert.equal(await fastBye, "rate-limited");
  // No first message: a raw data channel that says nothing.
  const Raw = dataChannelSocket(service.deps);
  const raw = new Raw(joinUrl(ORIGIN, code));
  const closed = new Promise<number>((r) => (raw.onclose = (ev) => r(ev.code)));
  assert.equal(await closed, 4002);
});

test("the connection limit: a refused offer, the phone tries again (1013) until there is room", async () => {
  const { code, party } = await host({ relay: { maxConnections: 1 } });
  const ann = phone(code, party.joinKey);
  await ann.join("Ann");
  const Raw = dataChannelSocket(service.deps);
  const raw = new Raw(joinUrl(ORIGIN, code));
  const ev = await new Promise<{ code: number; reason: string }>((r) => (raw.onclose = r));
  assert.equal(ev.code, 1013);
  assert.equal(raw.failure, "rejected");
  // Ann leaves: Bob gets in.
  ann.leave();
  await until(() => party.players.length === 0, 2000, "left");
  const bob = phone(code, party.joinKey);
  await bob.join("Bob");
});

test("backpressure: busy above 64 KiB, drain when it went out", async () => {
  const { code, party, relay } = await host();
  const ann = phone(code, party.joinKey);
  await ann.join("Ann");
  const conn = [...relay.connections()][0]!;
  // The host's channel: the peer of the phone's.
  const phoneCh = FakePeer.all.find((p) => p.channel)!.channel!;
  const ch = phoneCh.peer!;
  ch.hold = true;
  let drained = 0;
  const ondrain = conn.ondrain;
  conn.ondrain = () => {
    drained++;
    ondrain?.();
  };
  for (let i = 0; i < 5; i++) conn.send(JSON.stringify({ t: "msg", type: "x", data: "z".repeat(20_000) }));
  assert.equal(conn.busy, true);
  ch.hold = false;
  ch.flush();
  await until(() => drained === 1 && !conn.busy, 2000, "drain");
});

test("no host: the join is refused (no-host) and the client keeps trying", async () => {
  const sig = joinSignal(joinUrl(ORIGIN, "ZZZZ"), "offer:x", service.deps);
  await assert.rejects(sig.answer, (e: any) => e instanceof SignalError && e.code === "no-host");
  const c = phone("ZZZZ", "k");
  void c.join("Ann").catch(() => {});
  await tick(400);
  assert.equal(c.status, "connecting");
});

test("host signaling: reconnects after a drop and says the game again; replaced is final", async () => {
  const { code, signal, secret, states } = await host();
  signal.setGame({ name: "quiz", title: "Quiz", release: "1.0.0", phone: "/g/quiz/1.0.0/phone/index.html" });
  await until(() => (service.rooms.get(code)!.game as any)?.name === "quiz", 1000, "game");
  service.rooms.get(code)!.game = null;
  signal.drop();
  await until(() => states.filter((s) => s === "hosted").length === 2, 4000, "hosted again");
  await until(() => (service.rooms.get(code)!.game as any)?.name === "quiz", 1000, "game again");
  // Another tab hosts: this one is replaced and stays down.
  const other = new HostSignal(HostSignal.url(ORIGIN, code), secret, service.deps);
  cleanup.push(() => other.close());
  await until(() => signal.state === "replaced", 2000, "replaced");
  await tick(50);
  assert.equal(signal.state, "replaced");
  // A wrong secret: bad-secret, no retry.
  const bad = new HostSignal(HostSignal.url(ORIGIN, code), "nope", service.deps);
  cleanup.push(() => bad.close());
  await until(() => bad.state === "bad-secret", 2000, "bad-secret");
});

test("a page of another game is sent on (4014)", async () => {
  const { code, party, relay } = await host();
  relay.game = "quiz/1.0.0";
  const old = phone(code, party.joinKey, { query: "g=snug/0.2.0" });
  await assert.rejects(old.join("Ann"), (e: any) => e.code === "next-game");
  const ok = phone(code, party.joinKey, { query: "g=quiz/1.0.0" });
  await ok.join("Bob");
});

test("next game: every phone gets 4014", async () => {
  const { code, party, relay } = await host();
  const ann = phone(code, party.joinKey);
  await ann.join("Ann");
  relay.closeAll(4014, "next game");
  await until(() => ann.byeReason === "next-game", 2000, "next-game");
});

test("extra screens: asked, approved with the TV link, refused", async () => {
  const { code, relay } = await host();
  const asked: string[] = [];
  relay.onscreen = (req) => {
    asked.push(`${req.token} ${req.agent}`);
    req.answer(req.token === "goodtoken1", "https://tvpipe.test/g/quiz/1.0.0/screen/index.html#r=BCDF&k=w&role=watch");
  };
  const yes = await requestScreen(code, { token: "goodtoken1", agent: "SmartTV", deps: service.deps });
  assert.deepEqual(yes, { ok: true, url: "https://tvpipe.test/g/quiz/1.0.0/screen/index.html#r=BCDF&k=w&role=watch" });
  const no = await requestScreen(code, { token: "badtoken12", agent: "Other", deps: service.deps });
  assert.deepEqual(no, { ok: false, reason: "refused" });
  assert.deepEqual(asked, ["goodtoken1 SmartTV", "badtoken12 Other"]);
  // Screen connections never reach the party, and close after the answer.
  await until(() => relay.size === 0, 2000, "screens gone");
  const none = await requestScreen("QQQQ", { token: "goodtoken1", deps: service.deps });
  assert.deepEqual(none, { ok: false, reason: "no-host" });
});

test("DataChannelSocket: control frames carry close codes both ways", async () => {
  const { code, relay } = await host();
  const got: RelayConn[] = [];
  relay.onopen = (c) => {
    got.push(c);
    c.onmessage = (d) => c.send(`echo:${String(d)}`);
  };
  const ws = new DataChannelSocket(joinUrl(ORIGIN, code), service.deps);
  await new Promise((r) => (ws.onopen = r));
  const msg = new Promise<unknown>((r) => (ws.onmessage = (ev) => r(ev.data)));
  ws.send('{"t":"x"}');
  assert.equal(await msg, 'echo:{"t":"x"}');
  const hostClosed = new Promise<[number, string]>((r) => (got[0]!.onclose = (code, reason) => r([code, reason])));
  ws.close(4321, "bye now");
  assert.deepEqual(await hostClosed, [4321, "bye now"]);
});
