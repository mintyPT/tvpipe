/** Rejoining: by name, by a rejoin link, the badge on screens, drop-outs during a game. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryStorage, PartyClient, type PartyActionError } from "../src/client.ts";
import type { Player } from "../src/party.ts";
import { RejoinBadge } from "../src/rejoin.ts";
import { dropOuts } from "../src/testing.ts";
import { setup, tick, until } from "./helpers.ts";

test("an away player's name takes the seat back on another phone; the old token stops working", async () => {
  const s = await setup();
  try {
    const old = s.phone();
    await old.join("Zoë");
    await s.phone().join("Bob");
    const p = s.party.players[0]!;
    p.state.set({ score: 7 });
    const events: string[] = [];
    s.party.on("reconnect", (x) => events.push(`back:${x.name}`));
    s.party.on("join", (x) => events.push(`join:${x.name}`));
    // Connected: the name is taken.
    await assert.rejects(s.phone().join("zoe"), (e: PartyActionError) => e.code === "name-taken");
    const saved = old.saved;
    old.close();
    await until(() => !p.connected);
    // Another phone, the same name (any case or accents): the same player.
    const now = s.phone();
    const w = await now.join(" ZOE ");
    assert.equal(w.you.id, p.id);
    assert.equal(w.you.name, "Zoë");
    assert.equal(w.view.me.score, 7);
    assert.notEqual(w.you.resume, saved!.resume, "a new token");
    assert.deepEqual(events, ["back:Zoë"]);
    assert.equal(s.party.players.length, 2);
    // The first phone comes back with its old token while the new one is in: refused.
    const again = s.client({ key: s.party.joinKey, storage: old.storage as ReturnType<typeof memoryStorage> });
    await assert.rejects(again.connect(), (e: PartyActionError) => e.code === "name-taken");
    assert.equal(now.status, "open");
  } finally {
    await s.close();
  }
});

test("a locked room, a full room and a game closed to newcomers still take their own players back by name", async () => {
  const s = await setup({ party: { maxPlayers: 2, lateJoin: "closed" } });
  try {
    const a = s.phone();
    await a.join("Ann");
    await s.phone().join("Bob");
    s.party.inProgress = true;
    s.party.lock();
    a.close();
    await until(() => !s.party.players[0]!.connected);
    await assert.rejects(s.phone().join("Cy"), (e: PartyActionError) => e.code === "locked");
    const w = await s.phone().join("ann");
    assert.equal(w.you.name, "Ann");
  } finally {
    await s.close();
  }
});

test("reclaim: false keeps names taken while away", async () => {
  const s = await setup({ party: { reclaim: false } });
  try {
    const a = s.phone();
    await a.join("Ann");
    a.close();
    await until(() => !s.party.players[0]!.connected);
    await assert.rejects(s.phone().join("Ann"), (e: PartyActionError) => e.code === "name-taken");
  } finally {
    await s.close();
  }
});

test("a rejoin link brings the player back on a fresh phone, and leaves the address bar", async () => {
  const s = await setup();
  const g = globalThis as any;
  const saved = { location: g.location, history: g.history };
  try {
    const a = s.phone();
    await a.join("Ann");
    const p = s.party.players[0]!;
    const link = s.party.rejoinLink(p)!;
    assert.match(link, /^https:\/\/party\.test\/\?r=[A-Z]{4}#k=[\w-]+&p=[\w-]+$/);
    assert.equal(s.party.rejoinLink({} as Player), null, "not a player of this party");
    a.close();
    await until(() => !p.connected);
    // The phone opens the link.
    const url = new URL(link);
    let replaced = "";
    g.location = { protocol: url.protocol, host: url.host, pathname: url.pathname, search: url.search, hash: url.hash };
    g.history = { state: null, replaceState: (_s: unknown, _t: string, u: string) => (replaced = u) };
    const storage = memoryStorage();
    const phone = PartyClient.fromLocation({ storage, WebSocket: s.relay.WebSocket, url: s.ws });
    assert.equal(phone.canResume, true);
    assert.equal(replaced, `/?r=${s.party.code}#k=${s.party.joinKey}`);
    const w = await phone.connect();
    assert.equal(w.you.id, p.id);
    phone.close();
  } finally {
    g.location = saved.location;
    g.history = saved.history;
    await s.close();
  }
});

test("drop-outs during a game: every phone comes back as itself", async () => {
  const s = await setup();
  try {
    const phones = await Promise.all(
      ["Ann", "Bob", "Cy", "Dee", "Eve", "Flo"].map(async (n) => {
        const c = s.phone();
        await c.join(n);
        return c;
      }),
    );
    // A small game: rounds of answers with deadlines; phones answer whatever they are asked.
    for (const c of phones) {
      c.on("view", (v) => {
        const round = v.room?.round;
        if (typeof round === "number" && v.me?.answered !== round) c.act("answer", round).catch(() => {});
      });
    }
    const rng = (() => {
      let x = 7;
      return () => ((x = (x * 16807) % 2147483647) / 2147483647);
    })();
    const chaos = dropOuts(phones, { rng, every: 40, away: [0, 300] });
    let answered = 0;
    for (let round = 1; round <= 12; round++) {
      s.party.room.set({ round });
      const answers = await s.party.collect<number>("answer", {
        until: s.party.now() + 250,
        validate: (d) => Number(d),
        onAnswer: (p) => p.state.set({ answered: round }),
      });
      answered += answers.size;
    }
    await chaos.stop();
    assert.ok(chaos.counts.network > 0 && chaos.counts.device > 0, JSON.stringify(chaos.counts));
    assert.equal(s.party.players.length, 6, "nobody joined twice");
    assert.ok(s.party.players.every((p) => p.connected));
    assert.ok(answered > 30, `${answered} answers`);
  } finally {
    await s.close();
  }
});

test("dropOuts.stop names a phone that could not come back", async () => {
  const s = await setup({ party: { reclaim: false } });
  try {
    const a = s.phone();
    await a.join("Ann");
    const chaos = dropOuts([a], { every: 1, kinds: ["device"], away: [0, 0] });
    await until(() => chaos.counts.device > 0);
    await assert.rejects(chaos.stop(2000), /phones did not come back: p1 \(closed, name-taken/);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// The badge, on a tiny fake DOM

class El {
  children: El[] = [];
  attrs: Record<string, string> = {};
  className = "";
  textContent = "";
  innerHTML = "";
  isConnected = false;
  offsetWidth = 0;
  classList = {
    set: new Set<string>(),
    add: (c: string) => this.classList.set.add(c),
    remove: (c: string) => this.classList.set.delete(c),
    contains: (c: string) => this.classList.set.has(c),
  };
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  append(...xs: (El | string)[]) {
    for (const x of xs) {
      const e = typeof x === "string" ? Object.assign(new El("#text"), { textContent: x }) : x;
      e.isConnected = true;
      this.children.push(e);
    }
  }
  replaceChildren(...xs: El[]) {
    this.children = [];
    this.append(...xs);
  }
  attachShadow() {
    const root = new El("#shadow");
    this.children.push(root);
    return root;
  }
  remove() {
    this.isConnected = false;
  }
  text(): string {
    return this.textContent + this.children.map((c) => c.text()).join("");
  }
}

test("the badge: a player away during a game sees the same card, nothing grows from it", () => {
  const body = new El("body");
  const doc = { createElement: (t: string) => new El(t), body, documentElement: { lang: "en" } } as unknown as Document;
  const badge = new RejoinBadge(doc, { qrSvg: () => "<svg/>", joinText: (j) => (j.short ? "tvpipe.party/BCDF" : null) });
  try {
    const join = { qr: { size: 1, rows: ["1"] }, url: "https://x/", short: "https://tvpipe.party/BCDF", inProgress: true, lateJoin: "closed" };
    const roster = (away: string[]) => ["Ann", "Bob"].map((n, i) => ({ id: `p${i}`, name: n, connected: !away.includes(n) }));
    badge.update({ roster: roster([]), join });
    const el = body.children[0]!;
    const shadow = el.children[0]!;
    const before = el.text();
    badge.update({ roster: roster(["Bob"]), join });
    assert.equal(el.text(), before, "no names, no other card");
    assert.doesNotMatch(el.text(), /Bob/);
    assert.equal(shadow.children.length, 2, "the style and the card");
    assert.equal(shadow.children[1]!.text(), "Rejointvpipe.party/BCDF", "the join code brings Bob back");
  } finally {
    badge.destroy();
  }
});

test("the badge: the join code in a corner the whole game, titled by who may join", async () => {
  const body = new El("body");
  const doc = { createElement: (t: string) => new El(t), body, documentElement: { lang: "de" } } as unknown as Document;
  const badge = new RejoinBadge(doc, { qrSvg: () => "<svg/>", joinText: (j) => (j.short ? "tvpipe.party/BCDF" : null) }, { corner: "top-left" });
  try {
    const join = { qr: { size: 1, rows: ["1"] }, url: "https://x/", short: "https://tvpipe.party/BCDF", inProgress: false, lateJoin: "wait" };
    badge.update({ roster: [], join: { ...join, qr: null } });
    assert.equal(badge.showing, false, "no code yet");
    badge.update({ roster: [], join });
    assert.equal(badge.showing, true);
    const el = body.children[0]!;
    const mini = el.children[0]!.children[1]!;
    assert.equal(el.attrs["data-corner"], "top-left");
    assert.equal(mini.classList.set.has("shown"), true);
    assert.equal(mini.text(), "Mitspielentvpipe.party/BCDF");
    badge.update({ roster: [], join: { ...join, inProgress: true } });
    assert.match(mini.text(), /^Ab nächster Runde/);
    badge.update({ roster: [], join: { ...join, inProgress: true, lateJoin: "open" } });
    assert.match(mini.text(), /^Jetzt mitspielen/);
    badge.update({ roster: [], join: { ...join, inProgress: true, lateJoin: "closed", short: undefined } });
    assert.equal(mini.text(), "Wieder einsteigen", "no short link: the QR code alone");
    // The lobby's own big code: aside.
    badge.suppressed = true;
    assert.equal(badge.showing, false);
    assert.equal(mini.classList.set.has("shown"), false);
  } finally {
    badge.destroy();
  }
});
