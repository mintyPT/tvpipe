import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Party } from "@tvpipe/party";
import { MemoryRelay } from "@tvpipe/party/testing";

import { Bot, bots } from "../game/bots.ts";
import { Garble, type Timings } from "../game/game.ts";
import { bestMove, earnedTotal, flatten, judge, parseWords, pictureAt, scoreRound, seeded, type Picture, type Word } from "../game/rules.ts";

const data = (f: string) => parseWords(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const WORDS = { en: data("words.txt"), de: data("words.de.txt") };

const fast: Timings = {
  firstDraw: 1500,
  guess: 800,
  draw: 1200,
  layer: 3,
  read: 3,
  legend: 3,
  vote: 1000,
  best: 5,
  scores: 5,
};

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function game(n: number, opts: { rounds?: number; silent?: number; length?: number; oracle?: boolean; lang?: "en" | "de"; voter?: boolean } = {}) {
  const relay = new MemoryRelay();
  const party = new Party({ grace: 100, maxPlayers: 12 }).listen(relay);
  const g = new Garble(party, { words: WORDS, rounds: opts.rounds ?? 1, timings: fast, rng: seeded(11), length: opts.length, lang: opts.lang });
  g.open();
  const phases: string[] = [];
  g.on("phase", (p) => phases.push(p));
  const o = {
    url: "ws://party.test/_tvpipe/ws",
    WebSocket: relay.WebSocket,
    room: party.code,
    key: party.joinKey,
    rng: seeded(n),
    think: () => 3,
    oracle: opts.oracle === false ? undefined : (id: string) => g.meant(id),
  };
  const silent = opts.silent ?? 0;
  const players = await bots(n - silent, o);
  // Players who never answer: connected, but silent.
  for (let i = 0; i < silent; i++) {
    const b = new Bot({ ...o, name: `Mute${i + 1}`, silent: true });
    await b.join();
    players.push(b);
  }
  // A player who votes by hand (the test's).
  if (opts.voter) {
    const b = new Bot({ ...o, name: "Voter", skip: ["vote"] });
    await b.join();
    players.push(b);
  }
  /** The round's pictures, seats and words once it is revealed (the game forgets them at the end). */
  const rounds: { pictures: Picture[]; seats: string[]; deals: { choices: Word[]; words: Word[] }[] }[] = [];
  g.on("phase", (p) => {
    if (p === "reveal") rounds.push(structuredClone({ pictures: g.round!.pictures, seats: g.round!.seats.map((x) => x.id), deals: g.round!.deals }));
  });
  return { party, g, players, phases, rounds, close: () => party.close() };
}

test("a whole game with 4 players", async () => {
  const { party, g, players, phases, rounds, close } = await game(4, { rounds: 2 });
  try {
    const end = new Promise<{ score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    assert.equal(table.length, 4);
    assert.equal(phases.filter((p) => p === "play").length, 8, "4 players: 3 layers, then the last guess: 4 steps a round");
    for (const p of ["reveal", "vote", "best", "scores"]) assert.equal(phases.filter((x) => x === p).length, 2, p);
    assert.equal(phases.at(-1), "final");
    assert.ok(table.reduce((s, l) => s + l.score, 0) > 0, "someone scored");
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], [], []],
    );
    assert.equal(rounds.length, 2);
    for (const r of rounds) {
      assert.equal(r.pictures.length, 4);
      for (const p of r.pictures) {
        assert.equal(p.layers.length, 3);
        assert.ok(p.layers.every((l) => l.guess !== null && l.drawing.strokes.length > 0));
      }
    }
    await until(() => players.every((b) => b.client.view["me"].task === "final"));
    assert.equal((party.screenView()["screen"] as { phase: string }).phase, "final");
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a whole game with 3 players: two layers, then the last guess", async () => {
  const { players, phases, rounds, g, close } = await game(3);
  try {
    const end = new Promise<{ score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    assert.equal(table.length, 3);
    assert.equal(phases.filter((p) => p === "play").length, 3, "3 players: 2 layers, then the last guess");
    assert.equal(phases.at(-1), "final");
    assert.deepEqual(
      players.map((b) => b.errors),
      [[], [], []],
    );
    for (const p of rounds[0]!.pictures) assert.equal(p.layers.length, 2);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("pictures: who draws and guesses which layer, the words, the verdicts", async () => {
  const { g, players, rounds, close } = await game(7, { length: 7 });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const { pictures, seats, deals } = rounds[0]!;
    const n = seats.length;
    assert.equal(pictures.length, 7);
    let right = 0;
    for (const p of pictures) {
      assert.equal(p.layers.length, 6, "7 players: 6 layers (at most one less than the players)");
      const deal = deals[p.id]!;
      assert.ok(deal.choices.some((w) => w.word === p.layers[0]!.word.word), "the first layer is a word picked from two");
      p.layers.slice(1).forEach((l, i) => assert.equal(l.word.word, deal.words[i]!.word, "then the dealt words"));
      assert.equal(new Set(p.layers.map((l) => l.word.word)).size, 6, "no word twice in a picture");
      // Layer k by seat p + k; its guess by seat p + k + 1: seven different players.
      p.layers.forEach((l, k) => {
        assert.equal(l.by, seats[(p.id + k) % n]);
        assert.equal(l.guess!.by, seats[(p.id + k + 1) % n]);
        assert.equal(l.guess!.right, judge(l.guess!.text, l.word));
        if (l.guess!.right) right++;
      });
      assert.equal(new Set([...p.layers.map((l) => l.by), p.layers.at(-1)!.guess!.by]).size, 7);
    }
    // The bots read the layer's word most of the time (the host page's oracle).
    assert.ok(right >= 42 * 0.5, `${right} of 42 read right`);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("privacy: a layer's word, a guess and a step's picture reach only their player until the reveal", async () => {
  const { party, g, players, rounds, close } = await game(5);
  try {
    const seen: { who: string; id: string | undefined; view: Record<string, any> }[] = [];
    for (const b of players) b.client.on("view", (v) => seen.push({ who: b.name, id: b.client.you?.id, view: structuredClone(v) }));
    const tv: Record<string, any>[] = [];
    party.on("screen-view", (v) => tv.push(structuredClone(v)));
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const { pictures, seats, deals } = rounds[0]!;
    const n = seats.length;
    const SECRET = new Set(["word", "choices", "picture", "drawing", "strokes", "text", "guess", "gallery", "layers"]);
    /** The keys of a JSON value, deep. */
    const keys = (v: unknown, out: string[] = []): string[] => {
      if (Array.isArray(v)) for (const x of v) keys(x, out);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          out.push(k);
          keys(x, out);
        }
      return out;
    };
    const before = (phase: unknown) => phase === "lobby" || phase === "play";
    const leaks: string[] = [];
    let checked = 0;
    for (const v of tv) {
      if (!before((v["screen"] as { phase?: string })?.phase)) continue;
      for (const k of keys(v["screen"])) if (SECRET.has(k)) leaks.push(`the TV sees ${k}`);
    }
    for (const { who, id, view } of seen) {
      if (!before(view["room"]?.phase)) continue;
      for (const k of keys(view["room"])) if (SECRET.has(k)) leaks.push(`${who}: the room has ${k}`);
      for (const k of keys(view["roster"])) if (SECRET.has(k)) leaks.push(`${who}: the roster has ${k}`);
      const me = view["me"] ?? {};
      if (me.task !== "draw" && me.task !== "guess") {
        for (const k of keys(me)) if (SECRET.has(k)) leaks.push(`${who}: ${me.task} has ${k}`);
        continue;
      }
      if (keys(me).includes("text") || keys(me).includes("guess")) leaks.push(`${who}: a guess in their view`);
      // Step k (0-based) of the player at seat s: picture s − k, as it was after k layers.
      const k = me.step - 1;
      const s = seats.indexOf(id!);
      const c = pictureAt(s, k, n);
      const p = pictures[c]!;
      checked++;
      if (JSON.stringify(me.picture) !== JSON.stringify(flatten(p.layers.slice(0, k)))) leaks.push(`${who}: step ${k + 1} shows another picture`);
      if (me.task === "draw") {
        if (k === 0 && JSON.stringify(me.choices) !== JSON.stringify(deals[c]!.choices.map((w) => w.word))) leaks.push(`${who}: someone else's choices`);
        if (k > 0 && me.word !== p.layers[k]!.word.word) leaks.push(`${who}: someone else's word`);
        if (k > 0 && p.layers[k]!.by !== id) leaks.push(`${who}: a word for a layer they do not draw`);
      } else if (keys(me).includes("word") || keys(me).includes("choices")) leaks.push(`${who}: a word while guessing`);
    }
    assert.deepEqual([...new Set(leaks)], []);
    assert.ok(checked > 20, `${checked} views checked`);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("silent players: blank layers, no guesses (wrong), the game goes on", async () => {
  const { g, players, rounds, close } = await game(4, { silent: 2 });
  try {
    const end = new Promise<{ id: string; score: number }[]>((r) => g.once("end", r));
    await players[0]!.client.act("start");
    const table = await end;
    const mute = new Set(players.filter((b) => b.name.startsWith("Mute")).map((b) => b.client.you!.id));
    for (const p of rounds[0]!.pictures) {
      for (const l of p.layers) {
        if (mute.has(l.by)) assert.deepEqual(l.drawing.strokes, [], "a silent player's layer is blank");
        if (mute.has(l.guess!.by)) assert.deepEqual([l.guess!.text, l.guess!.right], ["", false]);
      }
    }
    for (const id of mute) assert.equal(table.find((l) => l.id === id)!.score, 0);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("in German: German words, judged in German", async () => {
  const { g, players, rounds, close } = await game(5, { lang: "de" });
  try {
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    assert.equal(g.lang, "de");
    const german = new Set(WORDS.de.map((w) => w.word));
    const layers = rounds[0]!.pictures.flatMap((p) => p.layers);
    assert.ok(layers.every((l) => german.has(l.word.word)));
    assert.ok(layers.some((l) => l.guess!.right));
    for (const l of layers) assert.equal(l.guess!.right, !!l.guess!.text && judge(l.guess!.text, l.word, "de"));
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the best move: others' layers only, 200 to the most votes", async () => {
  const { g, players, close } = await game(4, { voter: true });
  try {
    const mute = players.find((b) => b.name === "Voter")!;
    let before = new Map<string, number>();
    let votes = new Map<string, string>();
    let pictures: Picture[] = [];
    const checks: Promise<void>[] = [];
    g.on("phase", (p) => {
      if (p === "vote") {
        before = new Map(g.scores);
        // The silent player tries their own layer and one that is not there, then votes.
        checks.push(
          until(() => mute.client.view["me"]?.task === "vote").then(async () => {
            const mine = mute.client.view["me"].mine as string[];
            assert.ok(mine.length > 0);
            await assert.rejects(mute.client.act("vote", { layer: mine[0] }), /own/i);
            await assert.rejects(mute.client.act("vote", { layer: "99:0" }), /layer/i);
            const other = (mute.client.view["room"].gallery as { id: number; layers: unknown[] }[]).flatMap((x) => x.layers.map((_, k) => `${x.id}:${k}`)).find((id) => !mine.includes(id))!;
            await mute.client.act("vote", { layer: other });
          }),
        );
      }
      if (p === "best") {
        votes = new Map(g.round!.votes);
        pictures = structuredClone(g.round!.pictures);
      }
    });
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    await Promise.all(checks);
    assert.equal(votes.size, 5, "everyone voted");
    for (const [voter, id] of votes) {
      const [pi, li] = id.split(":").map(Number);
      assert.notEqual(pictures[pi!]!.layers[li!]!.by, voter, "never your own layer");
    }
    const best = bestMove(votes);
    const earned = scoreRound(pictures, votes);
    for (const [id, e] of earned) assert.equal(g.scores.get(id)! - (before.get(id) ?? 0), earnedTotal(e), "the round's points");
    for (const id of best.ids) {
      const [pi, li] = id.split(":").map(Number);
      assert.ok(earned.get(pictures[pi!]!.layers[li!]!.by)!.best >= best.points);
    }
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("a scripted first round: the seats and the words as written", async () => {
  const { g, players, rounds, close } = await game(4);
  try {
    const names = ["Cy", "Ada", "Dot", "Bea"];
    g.script = {
      seats: names,
      pictures: [
        { choices: ["cat", "owl"], words: ["submarine", "hedgehog"] },
        { choices: ["sun", "key"], words: ["lion", "clock"] },
        { choices: ["fish", "hat"], words: ["rocket", "car"] },
        { choices: ["house", "tree"], words: ["robot", "zebra"] },
      ],
    };
    const end = new Promise((r) => g.once("end", r));
    await players[0]!.client.act("start");
    await end;
    const { seats, pictures } = rounds[0]!;
    const byId = new Map(players.map((b) => [b.client.you!.id, b.name]));
    assert.deepEqual(
      seats.map((id) => byId.get(id)),
      names,
    );
    assert.deepEqual(
      pictures[0]!.layers.slice(1).map((l) => l.word.word),
      ["submarine", "hedgehog"],
    );
    assert.deepEqual(pictures[0]!.layers[1]!.word.also, ["sub"], "the list's synonyms");
    assert.ok(["cat", "owl"].includes(pictures[0]!.layers[0]!.word.word));
    assert.equal(g.script, undefined, "for one round only");
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("the host page removes players and moves the VIP during a game: it plays on", async () => {
  const { party, g, players, close } = await game(9, { rounds: 2 });
  try {
    const end = new Promise((r) => g.once("end", r));
    const removed: string[] = [];
    // One player removed in each kind of phase, the first time it comes.
    g.on("phase", (p) => {
      if (removed.includes(p) || !["play", "reveal", "vote", "best", "scores"].includes(p)) return;
      removed.push(p);
      setTimeout(() => {
        const victim = party.players.find((x) => !x.vip);
        if (victim) party.kick(victim);
        const next = party.players.find((x) => !x.vip);
        if (next) party.makeVip(next);
      }, 10);
    });
    await players[0]!.client.act("start");
    await end;
    assert.equal(removed.length, 5, "every kind of phase came");
    assert.equal(g.phase, "final");
    assert.equal(party.players.length, 4);
    assert.equal(party.players.filter((p) => p.vip).length, 1);
  } finally {
    for (const b of players) b.close();
    close();
  }
});

test("settings: the VIP only, before a game", async () => {
  const { g, players, close } = await game(4);
  try {
    assert.deepEqual(g.settings, { undo: true, length: 5 }, "undo is on by default");
    await players[0]!.client.act("settings", { undo: false, length: 3, rounds: 3 });
    assert.deepEqual(g.settings, { undo: false, length: 3 });
    assert.equal(g.rounds, 3);
    await assert.rejects(players[1]!.client.act("settings", { undo: true }), /VIP/);
    await assert.rejects(players[0]!.client.act("settings", { length: 4 }), /length/);
    await assert.rejects(players[0]!.client.act("settings", { rounds: 9 }), /rounds/);
    await until(() => players[2]!.client.view["room"].undo === false && players[2]!.client.view["room"].rounds === 3);
  } finally {
    for (const b of players) b.close();
    close();
  }
});
