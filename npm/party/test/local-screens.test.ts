/**
 * The app's local screens (`local:this`, `local:cable`) beside its TVs:
 * HostedParty shows them in the page and casts only the rest through
 * tvpipe; the launcher's list of them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { appScreens } from "../src/launcher-options.ts";
import { localScreen } from "../src/screens.ts";
import { mergeCast, Tvpipe, type CastStatus, type Info } from "../src/tvpipe.ts";

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

/** tvpipe's API socket: `select` keeps any names (as the hub does), `cast.start` streams to its `to`. */
class FakeApi {
  static last: FakeApi;
  binaryType = "";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  calls: { method: string; params: any }[] = [];
  selection: string[] = [];

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
      case "select":
        this.selection = msg.params.devices;
        return reply({ devices: this.selection, resolution: "auto" });
      case "selection":
        return reply({ devices: this.selection, resolution: "auto" });
      case "cast.start": {
        const to: string[] = msg.params.to ?? this.selection;
        const s: CastStatus = { state: "streaming", to, receivers: to.map((name) => ({ name, protocol: "airplay", state: "connected", delayMs: 100 })) };
        setTimeout(() => this.event("cast", s), 0);
        return reply(s);
      }
    }
    reply({});
  }

  event(type: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ t: "event", type, data }) });
  }

  casts(): any[] {
    return this.calls.filter((c) => c.method === "cast.start").map((c) => c.params);
  }

  close(): void {}
}

test("local screens: the names, the launcher's list", () => {
  assert.equal(localScreen("local:this"), "this");
  assert.equal(localScreen("local:cable"), "cable");
  assert.equal(localScreen("this"), undefined);
  assert.equal(localScreen("Den"), undefined);
  assert.deepEqual(
    appScreens(false).map((d) => d.name),
    ["local:this"],
  );
  assert.deepEqual(
    appScreens(true).map((d) => [d.name, d.kind, d.title]),
    [
      ["local:this", "browser", "This screen"],
      ["local:cable", "browser", "The TV on the cable"],
    ],
  );
});

test("mergeCast: receivers together, streaming when either streams, an idle one changes nothing", () => {
  const tv: CastStatus = { state: "streaming", to: ["Den"], receivers: [{ name: "Den", state: "connected" }] };
  assert.equal(mergeCast(tv, { state: "stopped" }), tv);
  assert.equal(mergeCast({ state: "stopped" }, tv), tv);
  const local: CastStatus = { state: "failed", to: ["local:cable"], error: "blocked", receivers: [{ name: "local:cable", state: "failed", code: "popup-blocked" }] };
  assert.deepEqual(mergeCast(tv, local), {
    state: "streaming",
    to: ["Den", "local:cable"],
    error: "blocked",
    receivers: [...tv.receivers!, ...local.receivers!],
  });
});

test("HostedParty.cast: the TVs through tvpipe, the local screen in the page", async () => {
  const tvpipe = await Tvpipe.connect({ url: "ws://x/_tvpipe/api", WebSocket: FakeApi as any });
  const api = FakeApi.last;
  const party = await tvpipe.party({ pair: false });
  const seen: CastStatus[] = [];
  party.onCastChange((s) => seen.push(s));

  // TVs only: as before (no `to`: tvpipe's selection).
  await tvpipe.select(["Den"]);
  await party.cast();
  assert.equal(api.casts().length, 1);
  assert.equal(api.casts()[0].to, undefined);

  // A TV and this screen: tvpipe gets the TV, the page shows the rest
  // (Node has no page: the local screen fails, the TV streams).
  await tvpipe.select(["Den", "local:this"]);
  const both = await party.cast();
  assert.deepEqual(api.casts()[1].to, ["Den"]);
  assert.equal(both.state, "streaming");
  assert.deepEqual(
    both.receivers!.map((r) => r.name),
    ["Den", "local:this"],
  );

  // Only this screen: no cast through tvpipe, the running one stops.
  await new Promise((r) => setTimeout(r, 5));
  await tvpipe.select(["local:this"]);
  await party.cast();
  assert.equal(api.casts().length, 2);
  assert.equal(api.calls.filter((c) => c.method === "cast.stop").length, 1);
  assert.ok(seen.length > 0);
  assert.equal(party.castStatus.receivers?.some((r) => r.name === "local:this"), true);
  party.close();
});
