/**
 * WebHub (docs/browser-party-design.md, "Web mode"): a Tvpipe answered in
 * the page, against a fake tvpipe.party; and PartyClient in web mode.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { memoryStorage, PartyClient } from "../src/client.ts";
import { setWebMode } from "../src/mode.ts";
import { setWebDeps } from "../src/rtc.ts";
import { dataChannelSocket, joinUrl, requestScreen } from "../src/rtc-socket.ts";
import { clearWebSession, readWebSession, writeWebSession } from "../src/session.ts";
import { Tvpipe, TvpipeError, type CastStatus, type NextGame } from "../src/tvpipe.ts";
import { browserName, WebHub } from "../src/webhub.ts";
import { FakePeer, FakeService, ORIGIN, tick, until } from "./webfakes.ts";

let service: FakeService;
const cleanup: (() => void)[] = [];

beforeEach(() => {
  service = new FakeService();
  setWebDeps(service.deps);
  FakePeer.all = [];
  clearWebSession();
});

afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) f();
  setWebDeps(undefined);
  setWebMode(undefined);
  clearWebSession();
  await tick(20);
});

function page(pathname: string, search = "") {
  const assigned: string[] = [];
  return { pathname, search, assigned, assign: (u: string) => void assigned.push(u) };
}

function hub(path = "/g/quiz/1.0.0/host/index.html", o: { search?: string; confirm?: (agent: string) => Promise<boolean> } = {}) {
  const loc = page(path, o.search);
  const h = new WebHub({ deps: service.deps, location: loc, confirmScreen: o.confirm ?? (async () => false) });
  const tvpipe = new Tvpipe(h);
  cleanup.push(() => tvpipe.close());
  return { hub: h, tvpipe, loc };
}

function phone(code: string, key: string): PartyClient {
  const c = new PartyClient({ url: joinUrl(ORIGIN, code), room: code, key, storage: memoryStorage(), session: memoryStorage(), WebSocket: dataChannelSocket(service.deps), rejoinBadge: false, followGames: false });
  cleanup.push(() => c.close());
  return c;
}

test("info: the page's game, its room registered; no game without one", async () => {
  const { tvpipe } = hub("/_tvpipe/launcher/");
  await assert.rejects(tvpipe.info(), (e: any) => e instanceof TvpipeError && e.code === "no-game");
  writeWebSession({ game: { name: "snug", release: "0.2.0" } });
  const launcher = await tvpipe.info();
  assert.equal(launcher.name, "snug");
  assert.equal(launcher.room, undefined);
  assert.equal(service.links.size, 0);

  const host = hub("/g/quiz/1.0.0/host/index.html", { search: "?bots" }).tvpipe;
  const info = await host.info();
  assert.equal(info.name, "quiz");
  assert.equal(info.title, "Quiz");
  assert.deepEqual(info.players, { min: 2, max: 8 });
  assert.equal(info.pages.tv, "/g/quiz/1.0.0/screen/index.html");
  assert.deepEqual(info.phone, { url: `${ORIGIN}/r/`, mode: "web" });
  assert.equal(info.local, ORIGIN);
  assert.equal(info.dev, true);
  const room = info.room!;
  assert.match(room.code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.equal(service.links.get(room.code)!.url, `${ORIGIN}/r/?r=${room.code}#k=${room.key}`);
  const s = readWebSession();
  assert.deepEqual(s.game, { name: "quiz", release: "1.0.0" });
  assert.equal(s.room!.code, room.code);
  assert.equal(s.room!.short, `${ORIGIN}/${room.code}`);
});

test("registration: another code on 409, waits on 429; a reload keeps the room (PUT), a lost one is made again", async () => {
  service.refuse = 2;
  service.busy = 1;
  const a = await hub().tvpipe.info();
  const posts = service.requests.filter((r) => r === "POST /api/links");
  assert.equal(posts.length, 4); // 429, 409, 409, 201
  assert.equal(service.links.size, 1);
  // A reload: the same room, checked with a PUT.
  service.requests.length = 0;
  const b = await hub().tvpipe.info();
  assert.deepEqual(b.room, a.room);
  assert.deepEqual(service.requests.filter((r) => !r.startsWith("GET")), [`PUT /api/links/${a.room!.code}`]);
  // Gone from the registry (expired): registered again with the same code and key.
  service.links.clear();
  const c = await hub().tvpipe.info();
  assert.deepEqual(c.room, a.room);
  assert.ok(service.links.has(a.room!.code));
});

test("devices, select, selection; unsupported calls", async () => {
  const { tvpipe } = hub();
  const devices = await tvpipe.watchDevices(true);
  const names = devices.map((d) => d.name);
  assert.equal(names[0], "this");
  assert.equal(names.at(-1), "none");
  assert.ok(devices.every((d) => d.kind === "browser" && d.title));
  assert.deepEqual(await tvpipe.selection(), []);
  assert.deepEqual(await tvpipe.select(["this"]), { devices: ["this"], resolution: null });
  assert.deepEqual(await tvpipe.chosen(), { devices: ["this"], resolution: null });
  assert.equal(readWebSession().screen, "this");
  await assert.rejects(tvpipe.pair("x"), (e: any) => e.code === "unsupported");
  await assert.rejects(tvpipe.setDisplayLag("x", 10), (e: any) => e.code === "unsupported");
  await assert.rejects(tvpipe.openSurface({ width: 1, height: 1 }), (e: any) => e.code === "unsupported");
  const qr = await tvpipe.qr("https://tvpipe.party/BCDF");
  assert.equal(qr.size, 25);
});

test("the host page: a party on the room, phones over data channels, Other game, Quit", async () => {
  const { tvpipe, hub: h, loc } = hub();
  writeWebSession({ screen: "none" });
  const party = await tvpipe.party();
  const code = party.code;
  const room = readWebSession().room!;
  assert.equal(code, room.code);
  assert.equal(party.joinKey, room.key);
  assert.equal(party.links.join, `${ORIGIN}/r/?r=${code}#k=${room.key}`);
  assert.match(party.links.watch, new RegExp(`^${ORIGIN}/g/quiz/1.0.0/screen/index.html#r=${code}&k=.+&role=watch&local=1$`));
  assert.equal(party.links.tv, `/g/quiz/1.0.0/screen/index.html#r=${code}&k=${party.screenKey}&role=screen`);
  await until(() => party.joinInfo.short === `${ORIGIN}/${code}`, 1000, "short");
  assert.equal(party.joinInfo.mode, "web");
  assert.ok(party.joinInfo.qr);
  // The room knows the game.
  await until(() => (service.rooms.get(code)?.game as any)?.phone === "/g/quiz/1.0.0/phone/index.html", 2000, "room game");
  // A phone.
  const ann = phone(code, party.joinKey);
  await ann.join("Ann");
  assert.equal(party.players.length, 1);
  // The cast: `none` shows nothing here.
  assert.equal((await party.cast()).state, "stopped");
  // Other game: the room's next game, 4014, the next host page.
  const next = new Promise<NextGame>((r) => tvpipe.on("game", r));
  await h.switchGame({ name: "snug", release: "0.2.0" });
  assert.deepEqual(await next, { name: "snug", title: "Snug", url: "/g/snug/0.2.0/host/index.html" });
  assert.equal((service.rooms.get(code)!.game as any).name, "snug");
  assert.deepEqual(readWebSession().game, { name: "snug", release: "0.2.0" });
  await until(() => ann.byeReason === "next-game", 2000, "4014");
  assert.ok(ann.carried === null || ann.carried.name === "Ann");
  // Back in (as the next game's page would): Quit closes the room.
  const bob = phone(code, party.joinKey);
  await bob.join("Bob");
  await tvpipe.quit();
  await until(() => bob.byeReason === "room-closed", 2000, "room-closed");
  assert.ok(service.requests.includes(`DELETE /api/links/${code}`));
  assert.equal(service.links.has(code), false);
  assert.deepEqual(readWebSession(), {});
  assert.deepEqual(loc.assigned, ["/games/"]);
});

test("extra screens through the hub: asked once per token, shown the watch link", async () => {
  const asked: string[] = [];
  const { tvpipe } = hub("/g/quiz/1.0.0/host/index.html", {
    confirm: async (agent) => {
      asked.push(agent);
      return true;
    },
  });
  const party = await tvpipe.party();
  const ua = "Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";
  const a = await requestScreen(party.code, { token: "screen-token-1", agent: ua, deps: service.deps });
  assert.deepEqual(a, { ok: true, url: `${ORIGIN}/g/quiz/1.0.0/screen/index.html#r=${party.code}&k=${party.watchKey}&role=watch` });
  const b = await requestScreen(party.code, { token: "screen-token-1", agent: ua, deps: service.deps });
  assert.equal(b.ok, true);
  assert.deepEqual(asked, ["Chrome on Android TV"]);
  assert.deepEqual(readWebSession().screens, ["screen-token-1"]);
  // The watch link works over a data channel.
  const url = new URL((a as { url: string }).url);
  const h = new URLSearchParams(url.hash.slice(1));
  const tv = new PartyClient({ url: joinUrl(ORIGIN, party.code), room: party.code, key: h.get("k")!, role: "watch", storage: memoryStorage(), WebSocket: dataChannelSocket(service.deps), rejoinBadge: false });
  cleanup.push(() => tv.close());
  await tv.connect();
});

test("browser names", () => {
  assert.equal(browserName("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"), "Safari on iPad");
  assert.equal(browserName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"), "Chrome on Mac");
  assert.equal(browserName("Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 SamsungBrowser/4.0 TV Safari/537.36"), "Samsung Internet on a TV");
  assert.equal(browserName(""), "a browser");
});

test("Tvpipe.connect() in web mode is the hub's; PartyClient.fromLocation uses data channels, local for screens", async () => {
  setWebMode(true);
  const g = globalThis as any;
  const replaced: string[] = [];
  const loc = { protocol: "https:", host: "tvpipe.test", origin: ORIGIN, pathname: "/g/quiz/1.0.0/phone/index.html", search: "?r=BCDF", hash: "#k=key123", replace: (u: string) => void replaced.push(u), assign() {} };
  const had = Object.getOwnPropertyDescriptor(g, "location");
  Object.defineProperty(g, "location", { value: loc, configurable: true, writable: true });
  try {
    const t = await Tvpipe.connect();
    assert.equal(t.web, true);
    t.close();
    const player = PartyClient.fromLocation({ storage: memoryStorage(), session: memoryStorage() });
    assert.equal(player.url, `wss://tvpipe.test/api/rooms/BCDF/join?g=quiz/1.0.0`);
    assert.equal(player.role, "player");
    loc.hash = "#r=BCDF&k=sk&role=screen";
    const screen = PartyClient.fromLocation({ rejoinBadge: false, storage: memoryStorage() });
    assert.equal(screen.url, `${ORIGIN}/_tvpipe/local/BCDF`);
    loc.hash = "#r=BCDF&k=wk&role=watch&local=1";
    assert.equal(PartyClient.fromLocation({ rejoinBadge: false, storage: memoryStorage() }).url, `${ORIGIN}/_tvpipe/local/BCDF`);
    loc.hash = "#r=BCDF&k=wk&role=watch";
    assert.match(PartyClient.fromLocation({ rejoinBadge: false, storage: memoryStorage() }).url, /\/api\/rooms\/BCDF\/join/);
    // A player at the next game goes to the room's join link (/r/).
    const { tvpipe, hub: h } = hub();
    writeWebSession({ screen: "none" });
    const party = await tvpipe.party();
    loc.hash = `#k=${party.joinKey}`;
    loc.search = `?r=${party.code}`;
    const ann = PartyClient.fromLocation({ storage: memoryStorage(), session: memoryStorage(), WebSocket: dataChannelSocket(service.deps) });
    cleanup.push(() => ann.close());
    await ann.join("Ann");
    // The games page in the dialog may name the game alone: the list's release.
    await h.switchGame({ name: "snug" });
    assert.deepEqual(readWebSession().game, { name: "snug", release: "0.2.0" });
    await until(() => replaced.length === 1, 2000, "replace");
    assert.equal(replaced[0], `/r/?r=${party.code}#k=${encodeURIComponent(party.joinKey)}`);
  } finally {
    if (had) Object.defineProperty(g, "location", had);
    else delete g.location;
  }
});
