/** A hosted party pairs a TV its cast failed on for want of pairing, then casts again. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { needsPairing, Tvpipe, type CastStatus, type Info } from "../src/tvpipe.ts";
import { until } from "./helpers.ts";

const INFO: Info = {
  name: "t",
  title: "T",
  players: { min: 1, max: 8 },
  pages: { host: "/host/", tv: "/tv/", phone: "/phone/" },
  tv: null,
  resolutions: [],
  phone: { url: "http://127.0.0.1:5000/", mode: "local" },
  tunnel: { state: "off" },
  local: "http://127.0.0.1:4000",
  version: "0",
};

/** tvpipe's API socket, faked like the hub: `cast.start` sends its `starting` event before the reply. */
class FakeApi {
  static last: FakeApi;
  binaryType = "";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  calls: { method: string; params: any }[] = [];
  selection = ["Den"];

  constructor(_url: string) {
    FakeApi.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }

  send(text: string): void {
    const msg = JSON.parse(text);
    if (msg.t !== "call") return;
    this.calls.push({ method: msg.method, params: msg.params });
    const reply = (value: unknown): void => {
      const data = JSON.stringify({ t: "reply", n: msg.n, ok: true, value });
      setTimeout(() => this.onmessage?.({ data }), 0);
    };
    switch (msg.method) {
      case "info":
        return reply(structuredClone(INFO));
      case "relay.attach":
        return reply({ public: "http://127.0.0.1:5000", local: "http://127.0.0.1:4000" });
      case "qr":
        return reply({ size: 21, rows: [] });
      case "cast.start": {
        const to = msg.params.to ?? this.selection;
        setTimeout(() => this.event("cast", { state: "starting", to }), 0);
        return reply({ state: "starting", receivers: [] });
      }
    }
    reply({});
  }

  event(type: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ t: "event", type, data }) });
  }

  casts(): number {
    return this.calls.filter((c) => c.method === "cast.start").length;
  }

  close(): void {}
}

const FAILED: CastStatus = {
  state: "failed",
  error: "every receiver failed",
  receivers: [
    { name: "Den", protocol: "airplay", state: "failed", error: "Den requires pairing", code: "pairing-required" },
    { name: "Kitchen", protocol: "cast", state: "failed", error: "gone" },
  ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("needsPairing names the receivers that failed for want of pairing", () => {
  assert.deepEqual(needsPairing(FAILED), ["Den"]);
  assert.deepEqual(needsPairing({ state: "streaming", receivers: [{ name: "Den", state: "connected" }] }), []);
  assert.deepEqual(needsPairing({ state: "failed" }), []);
});

test("a cast that fails because a TV needs pairing pairs it, then casts again, once", async () => {
  const tvpipe = await Tvpipe.connect({ url: "ws://x/_tvpipe/api", WebSocket: FakeApi as any });
  const api = FakeApi.last;
  const asked: string[] = [];
  let answer = true;
  const party = await tvpipe.party({ pair: async (d) => (asked.push(d), answer) });
  await party.cast(undefined, { resolution: "720p" });
  await sleep(5);
  api.event("cast", FAILED);
  await until(() => api.casts() === 2, 2000, "cast again");
  assert.deepEqual(asked, ["Den"]);
  const again = api.calls.filter((c) => c.method === "cast.start")[1]!;
  assert.equal(again.params.page, party.links.tv);
  assert.equal(again.params.resolution, "720p", "the same cast again");

  // It fails again: no second dialog for the same TV (until the next cast()).
  await sleep(5);
  api.event("cast", FAILED);
  await sleep(20);
  assert.deepEqual(asked, ["Den"]);
  assert.equal(api.casts(), 2);

  // A new cast offers it again; cancelled: no cast again.
  answer = false;
  await party.cast();
  await sleep(5);
  api.event("cast", FAILED);
  await until(() => asked.length === 2, 2000, "asked again");
  await sleep(20);
  assert.equal(api.casts(), 3);
  party.close();
});

test("another page's cast (the launcher's sync page) and pair: false leave the failure alone", async () => {
  const tvpipe = await Tvpipe.connect({ url: "ws://x/_tvpipe/api", WebSocket: FakeApi as any });
  const api = FakeApi.last;
  const asked: string[] = [];
  const party = await tvpipe.party({ pair: async (d) => (asked.push(d), true) });
  await party.cast();
  await sleep(5);
  // The cast picker casts its sync page: a cast this party did not start.
  api.event("cast", { state: "starting", to: ["Den"] });
  api.event("cast", FAILED);
  await sleep(20);
  assert.deepEqual(asked, []);
  assert.equal(api.casts(), 1);
  party.close();

  const t2 = await Tvpipe.connect({ url: "ws://x/_tvpipe/api", WebSocket: FakeApi as any });
  const api2 = FakeApi.last;
  const off = await t2.party({ pair: false });
  await off.cast();
  await sleep(5);
  api2.event("cast", FAILED);
  await sleep(20);
  assert.equal(api2.casts(), 1);
  off.close();
});
