// @ts-check
/**
 * A scripted round of Jinx as ScreenViews, for the TV harness (not
 * shipped). Each step makes its view from the time it is shown (`t`, host
 * time), so `until`/`deadline` are right; `then` lists updates inside the
 * step (ms after it, a view) such as the draft being typed.
 *
 * Options: n (3 or 8 players), jinx ("one", "two", "none", "all",
 * "self", "invalid"), wrong (the guess is wrong), pass, long (long clue words and
 * names), web ("few": one shared clue, "none": none; default: many).
 *
 * @typedef {import("../../game/views.ts").ScreenView} ScreenView
 * @typedef {import("../../game/views.ts").Person} Person
 * @typedef {import("../../game/views.ts").Card} Card
 * @typedef {import("../../game/views.ts").JinxGroup} JinxGroup
 * @typedef {{ n: number, jinx: string, wrong: boolean, pass: boolean, long: boolean, web?: string }} Opts
 * @typedef {{ name: string, make: (t: number) => ScreenView, then?: [number, (t: number) => ScreenView][] }} Step
 */

/** A doodled face: a squiggly smile and two eyes on the 1000 grid. @param {number} k */
function doodle(k) {
  const eye = (/** @type {number} */ x) => [x, 380 + k * 10, x + 4, 384 + k * 10];
  const smile = [];
  for (let i = 0; i <= 12; i++) smile.push(260 + i * 40, 620 + Math.sin((i / 12) * Math.PI) * (90 + k * 20) + (i % 2) * 8);
  return { strokes: [eye(360), eye(640), smile, [200, 220, 300, 160, 420, 200]] };
}

const NAMES = ["Anna", "Ben", "Chiara", "Dev", "Emeka", "Fatima", "Gus", "Hiroko"];

/** @param {Opts} o @returns {Step[]} */
export function script(o) {
  const n = o.n === 3 ? 3 : 8;
  /** @type {Person[]} */
  const people = NAMES.slice(0, n).map((name, i) => ({
    id: `p${i}`,
    name: o.long && i === 1 ? "Bartholomew-Maximilian" : o.long && i === 3 ? "Devendranath" : name,
    color: i,
    face: i === 2 || i === 5 ? doodle(i) : { preset: i },
    vip: i === 0,
    connected: !(o.long && i === 3),
    score: 0,
    bot: i === 4 ? true : undefined,
  }));
  const guesser = /** @type {Person} */ (people[n - 1]);
  const rounds = n === 3 ? 6 : 8;
  const round = n === 3 ? 3 : 4;
  const historyBefore = /** @type {("found" | "missed")[]} */ (n === 3 ? ["found", "missed"] : ["found", "missed", "found"]);
  const tallyBefore = { found: historyBefore.filter((x) => x === "found").length, played: historyBefore.length, total: rounds, history: historyBefore };
  const right = !o.wrong && !o.pass && o.jinx !== "all";
  const result = o.jinx === "all" ? "lost" : o.pass ? "pass" : o.wrong ? "wrong" : "right";
  const historyAfter = /** @type {("found" | "missed")[]} */ ([...historyBefore, right ? "found" : "missed"]);
  const tallyAfter = { found: historyAfter.filter((x) => x === "found").length, played: historyAfter.length, total: rounds, history: historyAfter };
  const bank = { chips: 12, goals: { "mixed signals": 2 * rounds, "in sync": 4 * rounds, "mind readers": 6 * rounds, telepaths: 8 * rounds } };
  const base = (/** @type {Person[]} */ ps = people) => ({ people: ps, round, rounds, guesser: guesser.id, bank });

  // the clues
  /** @type {[string, string, boolean][]} author, word, bold */
  const clues =
    n === 3
      ? [["p0", "Lava", true], ["p0", "Crater", false], ["p1", o.jinx === "self" ? "Ashes" : "lava", false], ["p1", "Ash", false]]
      : [["p0", "Lava", true], ["p1", o.long ? "Watermelonseeds" : "Eruption", false], ["p2", "lava", false], ["p3", o.jinx === "two" ? "Craters" : "Mountain", false], ["p4", o.long ? "Supercalifragilisticexp" : o.jinx === "two" ? "Crater" : "Magma", false], ["p5", o.long ? "Congratulations" : "Pompeii", true], ["p6", "LAVA", false]];
  /** @type {JinxGroup[]} */
  let groups = [];
  if (o.jinx === "none") groups = [];
  else if (o.jinx === "all") groups = n === 3 ? [{ cards: ["c0", "c2"], pairs: [{ a: "c0", b: "c2", reason: "same word" }] }, { cards: ["c1", "c3"], pairs: [{ a: "c1", b: "c3", reason: "same family" }] }] : [{ cards: ["c0", "c2", "c6", "c1", "c3", "c4", "c5"], pairs: [{ a: "c0", b: "c2", reason: "same word" }, { a: "c1", b: "c3", reason: "typo" }] }];
  else if (o.jinx === "self" && n === 3) groups = [{ cards: ["c2", "c3"], pairs: [{ a: "c2", b: "c3", reason: "plural" }] }];
  else if (n === 3) groups = [{ cards: ["c0", "c2"], pairs: [{ a: "c0", b: "c2", reason: "same word" }] }];
  else {
    groups = [{ cards: ["c0", "c2", "c6"], pairs: [{ a: "c0", b: "c2", reason: "same word" }, { a: "c2", b: "c6", reason: "same word" }] }];
    if (o.jinx === "two") groups.push({ cards: ["c3", "c4"], pairs: [{ a: "c3", b: "c4", reason: "plural" }] });
  }
  const jinxed = new Set(groups.flatMap((g) => g.cards));
  // jinx=invalid: one clue too close to the word (jinxed without a group)
  if (o.jinx === "invalid" && n === 8) {
    jinxed.add("c4");
    const c4 = clues[4];
    if (c4) c4[1] = "Volcanic";
  }
  /** @type {Card[]} */
  const all = clues.map(([author, word, bold], i) => ({ id: `c${i}`, author, bold, word, fate: jinxed.has(`c${i}`) ? "jinxed" : "alive" }));
  const alive = all.filter((c) => c.fate === "alive");
  const potBefore = 10;
  const potAfterJinx = Math.max(2, potBefore - jinxed.size);
  const picks = alive.slice(n === 3 ? 0 : 1, n === 3 ? 2 : 3).map((c) => c.id).slice(0, alive.length);
  if (picks.length === 0 && alive[0]) picks.push(alive[0].id);
  /** @param {number} k cards turned so far */
  const potAt = (k) => Math.max(2, potAfterJinx - 2 * Math.max(0, k - 1));
  /** @param {number} k @param {boolean} words */
  const revealCards = (k, words) =>
    alive.map((c) => {
      const at = picks.indexOf(c.id);
      const turned = at >= 0 && at < k ? at + 1 : undefined;
      return { id: c.id, author: c.author, bold: c.bold, fate: c.fate, ...(turned ? { turned, word: words ? c.word : undefined } : {}) };
    });
  const word = "Volcano";
  const guess = o.long ? "SUPERCALIFRAGILISTICEXPI" : o.wrong ? "ETNA" : "VOLCANO";
  const drafts = o.long ? ["SUPERCALIFRAGILISTICEXPI"] : o.wrong ? ["E", "ET", "ETN", "ETNA"] : ["V", "VO", "VOL", "VOLC", "VOLCA", "VOLCAM", "VOLCAMO", "VOLCAM", "VOLCA", "VOLCAN", "VOLCANO"];
  const pot = potAt(picks.length);
  /** @type {import("../../game/views.ts").Payout[]} */
  const payouts = [];
  if (result === "right") {
    payouts.push({ id: guesser.id, delta: pot, why: "pot" });
    for (const id of picks) {
      const c = all.find((x) => x.id === id);
      if (c) payouts.push({ id: c.author, delta: c.bold ? 4 : 2, why: c.bold ? "bold" : "turned" });
    }
  } else if (result === "wrong") payouts.push({ id: guesser.id, delta: -2, why: "wrong" });
  for (const c of all) if (c.fate === "jinxed" && c.bold) payouts.push({ id: c.author, delta: -2, why: "bold-jinxed" });
  const deltas = new Map();
  for (const p of payouts) deltas.set(p.id, (deltas.get(p.id) ?? 0) + p.delta);
  const before = [14, 11, 17, 9, 6, 19, 8, 12];
  const scored = people.map((p, i) => ({ ...p, score: (before[i] ?? 0) + (deltas.get(p.id) ?? 0) }));
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const lines = sorted.map((p) => ({ id: p.id, score: p.score, delta: deltas.get(p.id) ?? 0, rank: 1 + sorted.findIndex((q) => q.score === p.score) }));
  const mvpCard = picks[picks.length - 1];
  const nightWords = ["Volcano", "Dragon", "Castle", "Ghost", "Pizza", "Robot", "Desert", "Snowman"].slice(0, n === 3 ? 6 : 8);

  const givers = people.filter((p) => p.id !== guesser.id).map((p) => p.id);
  /**
   * A writing view: `sent` lists the author of each card sent so far, in order.
   * @param {number} started @param {number} deadline @param {string[]} sent
   * @returns {ScreenView}
   */
  const writeView = (started, deadline, sent) => {
    /** @type {Record<string, number>} */
    const sentBy = {};
    for (const id of sent) sentBy[id] = (sentBy[id] ?? 0) + 1;
    const each = n === 3 ? 2 : 1;
    return { phase: "write", ...base(), tally: tallyBefore, givers, each, done: givers.filter((id) => (sentBy[id] ?? 0) >= each), sent: sent.length, sentBy, started, deadline };
  };

  /** @type {Step[]} */
  const steps = [
    { name: "lobby-empty", make: () => ({ phase: "lobby", people: [], minPlayers: 3, maxPlayers: 8 }) },
    {
      name: "lobby",
      make: () => ({ phase: "lobby", people: people.slice(0, n - 1).map((p) => ({ ...p, score: 0 })), minPlayers: 3, maxPlayers: 8 }),
      then: [[900, () => ({ phase: "lobby", people: people.map((p) => ({ ...p, score: 0 })), minPlayers: 3, maxPlayers: 8 })]],
    },
    { name: "hotseat", make: (t) => ({ phase: "hotseat", ...base(), tally: tallyBefore, until: t + 4000 }) },
    {
      name: "write",
      make: (t) => writeView(t, t + 45000, []),
      then: [
        [600, (t) => writeView(t - 600, t + 44400, ["p0"])],
        [1300, (t) => writeView(t - 1300, t + 43700, n === 3 ? ["p0", "p1", "p0"] : ["p0", "p3", "p5"])],
      ],
    },
    { name: "write-low", make: (t) => writeView(t - 37000, t + 8000, n === 3 ? ["p0", "p0", "p1"] : ["p0", "p1", "p3", "p5", "p6"]) },
    { name: "write-allin", make: (t) => writeView(t - 39000, t + 6000, all.map((c) => c.author)) },
    {
      name: "jinx",
      make: (t) => ({ phase: "jinx", ...base(), tally: tallyBefore, cards: all.map(({ word: _w, ...c }) => c), groups, potBefore, pot: potAfterJinx, until: t + 4000 + Math.round(4500 * groups.reduce((w, g) => w + (g.cards.length >= 3 ? 1.5 : 1), 0)) }),
    },
    ...(alive.length === 0
      ? []
      : /** @type {Step[]} */ ([
          {
            name: "reveal",
            make: (t) => ({ phase: "reveal", ...base(), tally: tallyBefore, cards: revealCards(0, true), jinxed: jinxed.size, pot: potAt(0), draft: "", typing: false, started: t, deadline: t + 30000 }),
            then: picks.map((id, k) => [1200 + k * 3400, (t) => ({ phase: "reveal", ...base(), tally: tallyBefore, cards: revealCards(k + 1, true), jinxed: jinxed.size, pot: potAt(k + 1), picked: id, draft: "", typing: false, started: t, deadline: t + 30000 })]),
          },
          {
            name: "typing",
            make: (t) => ({ phase: "reveal", ...base(), tally: tallyBefore, cards: revealCards(picks.length, true), jinxed: jinxed.size, pot, draft: "", typing: false, started: t - 4000, deadline: t + 26000 }),
            then: o.pass
              ? []
              : [
                  [300, (t) => ({ phase: "reveal", ...base(), tally: tallyBefore, cards: revealCards(picks.length, true), jinxed: jinxed.size, pot, draft: "", typing: true, started: t - 4300, deadline: t + 25700 })],
                  ...drafts.map((d, i) => /** @type {[number, (t: number) => ScreenView]} */ ([1500 + i * 260, (t) => ({ phase: "reveal", ...base(), tally: tallyBefore, cards: revealCards(picks.length, true), jinxed: jinxed.size, pot, draft: d, typing: true, started: t - 5500 - i * 260, deadline: t + 24500 - i * 260 })])),
                ],
          },
        ])),
    {
      name: "verdict",
      make: (t) => ({ phase: "verdict", ...base(), tally: tallyAfter, word, result, ...(result === "right" || result === "wrong" ? { guess } : {}), cards: revealCards(picks.length, true), payouts, until: t + 6500 }),
    },
    {
      name: "replay",
      make: (t) => ({ phase: "replay", ...base(), tally: tallyAfter, word, result, cards: all.map((c) => ({ ...c, turned: picks.includes(c.id) ? picks.indexOf(c.id) + 1 : undefined })), groups, picking: result === "right", payouts, pot, ...(result === "right" ? { deadline: t + 20000 } : {}) }),
      then: result === "right" && mvpCard ? [[2400, (t) => ({ phase: "replay", ...base(), tally: tallyAfter, word, result, cards: all.map((c) => ({ ...c, turned: picks.includes(c.id) ? picks.indexOf(c.id) + 1 : undefined })), groups, picking: false, mvp: mvpCard, payouts: [...payouts, { id: all.find((c) => c.id === mvpCard)?.author ?? "p0", delta: 3, why: "mvp" }], pot, deadline: t + 4000 })]] : [],
    },
    { name: "bank", make: (t) => ({ phase: "bank", ...base(scored), bank: { ...bank, record: 11 }, tally: tallyAfter, banked: 4, next: people[0]?.id, until: t + 5000 }) },
    ...["room", "mvp", "awards", "web"].map((step) => ({
      name: `end-${step}`,
      make: () => ({
        phase: /** @type {"end"} */ ("end"),
        people: scored,
        step: /** @type {any} */ (step),
        tally: { found: nightWords.length - 2, played: nightWords.length, total: nightWords.length, history: nightWords.map((_, i) => (i === 2 || i === 5 ? "missed" : "found")) },
        title: /** @type {"in sync"} */ ("mind readers"),
        bank: { ...bank, chips: 30, record: 11 },
        clues: [],
        words: nightWords.map((w, i) => ({ word: w, found: !(i === 2 || i === 5), guesser: people[i % n]?.id ?? "p0" })),
        mvp: { id: sorted[0]?.id ?? "p0", score: sorted[0]?.score ?? 0, mvpClues: 3, jinxed: 0 },
        awards: /** @type {import("../../game/views.ts").Award[]} */ (n === 3 ? [{ kind: "kamikaze", ids: ["p1"], count: 3 }] : [
          { kind: "mind meld", ids: ["p0", "p2"], count: 4 },
          { kind: "lone wolf", ids: ["p3"], count: 6 },
          { kind: "kamikaze", ids: ["p6"], count: 5 },
        ]),
        web: {
          words: nightWords.map((w, i) => ({ word: w, found: !(i === 2 || i === 5), clues: [["hot", "lava", "italy", "eruption", "magma", "mountain"], ["fire", "knight", "hot", "wings", "scales"], ["knight", "haunted", "armor", "fortress", "drawbridge"], ["haunted", "white", "boo", "spooky"], ["italy", "cheese", "hot", "pepperoni", "margherita", "slice"], ["beep", "armor", "metal", "android"], ["sand", "hot", "camel", "cactus", "dune", "oasis", "mirage"], ["cold", "white", "carrot", "ice cream"]][i] ?? [] })),
          links: o.web === "none" ? [] : o.web === "few" ? [{ clue: "hot", words: [0, 4] }] : n === 3
            ? [{ clue: "hot", words: [0, 1, 4] }, { clue: "knight", words: [1, 2] }, { clue: "haunted", words: [2, 3] }]
            : [
                { clue: "hot", words: [0, 1, 4, 6] },
                { clue: "knight", words: [1, 2] },
                { clue: "haunted", words: [2, 3] },
                { clue: "armor", words: [2, 5] },
                { clue: "italy", words: [0, 4] },
                { clue: "white", words: [3, 7] },
              ],
        },
        lines,
      }),
    })),
  ];
  return steps;
}
