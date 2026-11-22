import assert from "node:assert/strict";
import { test } from "node:test";

import { joinText } from "../src/client.ts";
import { frameLink } from "../src/frame.ts";
import { Tvpipe, type Info } from "../src/tvpipe.ts";
import { until } from "./helpers.ts";

test("joinText shows the short link without its scheme, else nothing", () => {
  assert.equal(joinText({ short: "https://tvpipe.party/BCDF" }), "tvpipe.party/BCDF");
  assert.equal(joinText({ short: "http://127.0.0.1:8787/BCDF" }), "127.0.0.1:8787/BCDF");
  assert.equal(joinText({}), null);
  assert.equal(joinText(null), null);
  assert.equal(joinText(undefined), null);
  assert.equal(joinText({ short: "https://x.trycloudflare.com/?r=BCDF#k=abc" }), null);
  assert.equal(joinText({ short: "javascript:alert(1)" }), null);
});

const INFO: Info = {
  name: "t",
  title: "T",
  players: { min: 1, max: 8 },
  pages: { host: "/host/", tv: "/tv/", phone: "/phone/" },
  tv: null,
  resolutions: [],
  phone: { url: "http://127.0.0.1:5000/", mode: "local" },
  tunnel: { state: "starting" },
  local: "http://127.0.0.1:4000",
  version: "0",
};
/** What the fake tvpipe answers to `info`. */
let info: Info = INFO;

/** tvpipe's API socket, faked: answers calls, sends events. */
class FakeApi {
  static last: FakeApi;
  binaryType = "";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  calls: { method: string; params: any }[] = [];
  short: (params: any) => { ok: true; value: unknown } | { ok: false } = (p) => ({
    ok: true,
    value: { url: `https://tvpipe.party/${p.code}`, code: p.code },
  });

  constructor(_url: string) {
    FakeApi.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }

  send(text: string): void {
    const msg = JSON.parse(text);
    if (msg.t !== "call") return;
    this.calls.push({ method: msg.method, params: msg.params });
    const reply = (r: { ok: boolean; value?: unknown }): void => {
      const data = JSON.stringify({ t: "reply", n: msg.n, ...r, ...(r.ok ? {} : { error: { code: "unavailable", message: "no" } }) });
      setTimeout(() => this.onmessage?.({ data }), 0);
    };
    switch (msg.method) {
      case "info":
        return reply({ ok: true, value: structuredClone(info) });
      case "relay.attach":
        return reply({ ok: true, value: { public: "http://127.0.0.1:5000", local: "http://127.0.0.1:4000" } });
      case "qr":
        return reply({ ok: true, value: { size: 21, rows: [] } });
      case "shortlink":
        return reply(this.short(msg.params));
    }
    reply({ ok: false });
  }

  event(type: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ t: "event", type, data }) });
  }

  close(): void {}
}

test("a hosted party asks for a short link once the tunnel is up", async () => {
  const tvpipe = await Tvpipe.connect({ url: "ws://x/_tvpipe/api", WebSocket: FakeApi as any });
  const api = FakeApi.last;
  const party = await tvpipe.party();
  assert.equal(party.joinInfo.short, undefined);
  assert.equal(api.calls.filter((c) => c.method === "shortlink").length, 0, "no short link without a tunnel");

  let views = 0;
  party.on("screen-view", () => views++);
  api.event("tunnel", { state: "up", url: "https://abc.opentunnel.xyz/", provider: "opentunnel" });
  await until(() => party.joinInfo.short !== undefined, 2000, "short link");
  assert.equal(party.joinInfo.short, `https://tvpipe.party/${party.code}`);
  assert.equal(joinText(party.joinInfo), `tvpipe.party/${party.code}`);
  assert.equal(party.joinInfo.url, `https://abc.opentunnel.xyz/?r=${party.code}#k=${party.joinKey}`);
  const asked = api.calls.find((c) => c.method === "shortlink")!;
  assert.deepEqual(asked.params, { url: party.joinInfo.url, code: party.code });
  await until(() => views > 0, 2000, "screen view");
  assert.equal((party.screenView()["join"] as any).short, party.joinInfo.short);

  // The same link again keeps the short link while it is asked for again.
  await party.refreshJoin();
  assert.equal(party.joinInfo.short, `https://tvpipe.party/${party.code}`);
  party.close();
});

test("without the service the party has no short link", async () => {
  const tvpipe = await Tvpipe.connect({ url: "ws://x/_tvpipe/api", WebSocket: FakeApi as any });
  const api = FakeApi.last;
  api.short = () => ({ ok: false });
  const party = await tvpipe.party();
  api.event("tunnel", { state: "up", url: "https://abc.trycloudflare.com/", provider: "cloudflare" });
  await until(() => api.calls.some((c) => c.method === "shortlink"), 2000, "asked");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(party.joinInfo.short, undefined);
  assert.equal(joinText(party.joinInfo), null);
  assert.equal(party.joinInfo.mode, "tunnel");
  party.close();
});

test("with a frame page phones open the tunnel's link on it", async () => {
  info = { ...INFO, phone: { ...INFO.phone, frame: "https://tvpipe.party/p" } };
  try {
    const tvpipe = await Tvpipe.connect({ url: "ws://x/_tvpipe/api", WebSocket: FakeApi as any });
    const api = FakeApi.last;
    const party = await tvpipe.party();
    // Not on the LAN or this computer: there is no tunnel yet.
    assert.equal(party.joinInfo.url, `http://127.0.0.1:5000/?r=${party.code}#k=${party.joinKey}`);

    api.event("tunnel", { state: "up", url: "https://words-and-more.trycloudflare.com/", provider: "cloudflare" });
    await until(() => party.joinInfo.short !== undefined, 2000, "short link");
    const framed = `https://tvpipe.party/p#c=words-and-more&r=${party.code}&k=${party.joinKey}`;
    assert.equal(party.joinInfo.url, framed);
    assert.equal(party.links.join, framed);
    const qr = api.calls.filter((c) => c.method === "qr").at(-1)!;
    assert.deepEqual(qr.params, { text: framed });
    // tvpipe registers its own link: the service leads to the frame page.
    const asked = api.calls.find((c) => c.method === "shortlink")!;
    assert.deepEqual(asked.params, {
      url: `https://words-and-more.trycloudflare.com/?r=${party.code}#k=${party.joinKey}`,
      code: party.code,
    });
    party.close();
  } finally {
    info = INFO;
  }
});

test("frameLink: known answers", () => {
  const KEY = "AbCdEfGhIjKlMnOp_-12";
  const page = "https://tvpipe.party/p";
  assert.equal(
    frameLink(page, `https://some-random-words.trycloudflare.com/?r=BCDF#k=${KEY}`),
    `https://tvpipe.party/p#c=some-random-words&r=BCDF&k=${KEY}`,
  );
  assert.equal(
    frameLink(page, `https://65b3d1e2edd55529.baqlo7vg7agz.opentunnel.xyz/?r=BCDF#k=${KEY}`),
    `https://tvpipe.party/p#o=65b3d1e2edd55529.baqlo7vg7agz&r=BCDF&k=${KEY}`,
  );
  assert.equal(
    frameLink("http://127.0.0.1:8787/p", `https://x.trycloudflare.com/?r=BCDF#k=${KEY}`),
    `http://127.0.0.1:8787/p#c=x&r=BCDF&k=${KEY}`,
  );
  // No frame page, or a link it cannot take: phones open the link itself.
  for (const [pg, url] of [
    [undefined, `https://x.trycloudflare.com/?r=BCDF#k=${KEY}`],
    ["", `https://x.trycloudflare.com/?r=BCDF#k=${KEY}`],
    ["javascript:alert(1)//", `https://x.trycloudflare.com/?r=BCDF#k=${KEY}`],
    [page, `https://abc.opentunnel.xyz/?r=BCDF#k=${KEY}`],
    [page, `https://a.b.tunnel.example.com/?r=BCDF#k=${KEY}`],
    [page, `http://192.168.1.2:5000/?r=BCDF#k=${KEY}`],
    [page, `https://x.trycloudflare.com/?r=BCDF#k=short`],
  ] as const) {
    assert.equal(frameLink(pg, url), null, `${pg} ${url}`);
  }
});
