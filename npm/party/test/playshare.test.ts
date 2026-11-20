/**
 * End to end with the real `tvpipe game play` (skipped when no binary is
 * built: `cargo build -p tvpipe-cli`, or `TVPIPE_BINARY`): Node plays the
 * host page (the API with `?t=`), fake phones connect through tvpipe's
 * public listener, a fake TV page through the local one.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { memoryStorage, PartyActionError, PartyClient } from "../src/client.ts";
import { PartyError } from "../src/party.ts";
import { Tvpipe, TV_RENDER_MS } from "../src/tvpipe.ts";
import { until } from "./helpers.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const exe = process.platform === "win32" ? "tvpipe.exe" : "tvpipe";
const binary =
  process.env["TVPIPE_BINARY"] ??
  [`${repo}target/debug/${exe}`, `${repo}target/release/${exe}`].find((p) => existsSync(p));
const game = `${repo}crates/tvpipe/tests/fixtures/playshare/game`;

interface Run {
  child: ChildProcess;
  url: URL;
  exited: Promise<number | null>;
}

async function playshare(path: string): Promise<Run> {
  const child = spawn(binary!, ["game", "play", path, "--window", "none", "--no-tunnel"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TVPIPE_NO_QR: "1" },
  });
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  let log = "";
  child.stderr!.on("data", (d) => (log += String(d)));
  const line = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout! });
    rl.once("line", resolve);
    exited.then(() => reject(new Error(`tvpipe exited:\n${log}`)));
  });
  return { child, url: new URL(line), exited };
}

test("playshare: Node as the host page, phones and a TV page through tvpipe", { skip: !binary && "no tvpipe binary" }, async () => {
  const run = await playshare(game);
  try {
    // The window's link sets the cookie and leads to the launcher.
    const start = await fetch(run.url, { redirect: "manual" });
    assert.equal(start.status, 302);
    assert.match(start.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
    const launcher = await fetch(new URL("/_tvpipe/launcher/", run.url));
    assert.match(await launcher.text(), /tvpipe game/);

    const token = run.url.searchParams.get("t")!;
    const tvpipe = await Tvpipe.connect({ url: `ws://${run.url.host}/_tvpipe/api`, token });
    const info = await tvpipe.info();
    assert.equal(info.name, "test-game");
    assert.equal(info.phone.mode, "local");
    assert.equal(info.tunnel.state, "off");
    // The resolution: offered, chosen with the TVs, kept without one.
    assert.deepEqual(info.resolutions, ["auto", "720p", "1080p", "2160p"]);
    assert.deepEqual(await tvpipe.chosen(), { devices: [], resolution: "auto" });
    assert.deepEqual(await tvpipe.select(["browser"], { resolution: "2160p" }), { devices: ["browser"], resolution: "2160p" });
    assert.deepEqual(await tvpipe.select([]), { devices: [], resolution: "2160p" });
    assert.deepEqual(await tvpipe.selection(), []);

    const party = await tvpipe.party({ lateJoin: "wait" });
    assert.equal(party.maxPlayers, 4);
    assert.ok(party.links.join.startsWith(info.phone.url), party.links.join);
    assert.ok(party.joinInfo.qr && party.joinInfo.qr.size >= 21);
    party.handle("hi", (data, from) => `hello ${(from as { name?: string }).name}, ${String(data)}`);
    party.handle("nope", () => {
      throw new PartyError("nope", "Not now");
    });
    party.screen.set({ phase: "lobby" });

    // Phones: the public listener (here on loopback).
    const ws = `${info.phone.url.replace(/^http/, "ws")}_tvpipe/ws`;
    const phone = (name: string) => {
      const c = new PartyClient({ url: ws, room: party.code, key: party.joinKey, storage: memoryStorage() });
      return { c, joined: c.join(name) };
    };
    const ann = phone("Ann");
    await ann.joined;
    const bob = phone("Bob");
    await bob.joined;
    assert.equal(await ann.c.act("hi", "there"), "hello Ann, there");
    await assert.rejects(bob.c.act("nope"), (e: PartyActionError) => e.code === "nope");
    party.room.set({ phase: "lobby", n: 2 });
    await until(() => bob.c.view["room"]?.n === 2);

    // The TV page: the local listener, with the screen key.
    const tvUrl = new URL(party.links.tv, info.local);
    const h = new URLSearchParams(tvUrl.hash.slice(1));
    const tv = new PartyClient({
      url: `ws://${new URL(info.local).host}/_tvpipe/ws`,
      room: h.get("r")!,
      key: h.get("k")!,
      role: "screen",
      storage: memoryStorage(),
    });
    await tv.connect();
    assert.deepEqual(
      tv.view["roster"].map((p: { name: string }) => p.name),
      ["Ann", "Bob"],
    );
    assert.equal(tv.view["join"].url, party.links.join);

    // A picture on a receiver: the party learns how far it is behind
    // (the player page's delay and a frame; no TV lag).
    assert.equal(party.tvDelay, 0);
    const surface = await tvpipe.openSurface({ width: 320, height: 180, fps: 30, to: ["browser"] });
    await until(() => party.tvDelay > 0, 5000);
    assert.equal(party.tvDelay, 100 + TV_RENDER_MS);
    await until(() => ann.c.tvDelay === party.tvDelay && tv.tvDelay === party.tvDelay);
    await tvpipe.closeSurface(surface.id);
    await until(() => party.tvDelay === 0, 5000);

    // The page asks tvpipe to quit: phones hear the room closed.
    await tvpipe.quit();
    await until(() => ann.c.status === "closed" && bob.c.status === "closed" && tv.status === "closed", 5000);
    assert.equal(ann.c.byeReason, "room-closed");
    assert.equal(await run.exited, 0);
  } finally {
    run.child.kill();
  }
});

test("playshare: a zip bundle, and a host that goes away", { skip: !binary && "no tvpipe binary" }, async () => {
  const run = await playshare(`${game}.zip`);
  try {
    const token = run.url.searchParams.get("t")!;
    const tvpipe = await Tvpipe.connect({ url: `ws://${run.url.host}/_tvpipe/api`, token });
    const info = await tvpipe.info();
    const page = await fetch(new URL(info.pages.phone, info.phone.url));
    assert.match(await page.text(), /phone/);
    const party = await tvpipe.party();
    const ws = `${info.phone.url.replace(/^http/, "ws")}_tvpipe/ws`;
    const c = new PartyClient({ url: ws, room: party.code, key: party.joinKey, storage: memoryStorage() });
    await c.join("Cy");
    // The host page closes (a reload): the phone is told to come back
    // (1012) and then refused by nobody being there (503) until a host is.
    tvpipe.close();
    await until(() => c.status === "reconnecting", 5000);
    const again = await Tvpipe.connect({ url: `ws://${run.url.host}/_tvpipe/api`, token });
    const fresh = await again.party();
    await until(() => c.status === "closed", 10_000);
    assert.equal(c.byeReason, "no-room");
    assert.notEqual(fresh.code, party.code);
    await again.quit();
    assert.equal(await run.exited, 0);
  } finally {
    run.child.kill();
  }
});
