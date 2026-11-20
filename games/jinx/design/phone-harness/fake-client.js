// The phone harness's stand-in for /_tvpipe/lib/client.js: no server, a
// fake view per scenario (`?s=NAME`), actions answered locally the way the
// host would (clues rejected, cards turned, …). Not shipped.
//
//   frame.html?s=write             a scenario
//   frame.html?s=write&do=reject   then a scripted step (see STEPS)

const q = new URLSearchParams(location.search);
const scenarioName = q.get("s") ?? "lobby-vip";
const step = q.get("do") ?? "";

const NAMES = ["Anna", "Ben", "Chiara", "Dev", "Emeka", "Fatima", "Gus", "Hiroko"];
const BEN_DOODLE = [
  [300, 380, 340, 360, 380, 380],
  [620, 380, 660, 360, 700, 380],
  [280, 600, 360, 700, 500, 740, 640, 700, 720, 600],
  [500, 460, 480, 540, 520, 560],
];

function people(n = 8, over = {}) {
  return NAMES.slice(0, n).map((name, i) => ({
    id: name.toLowerCase(),
    name,
    color: i,
    face: i === 1 ? { strokes: BEN_DOODLE } : { preset: i },
    vip: i === 0,
    connected: true,
    score: 0,
    ...(over[name.toLowerCase()] ?? {}),
  }));
}
const SCORES = { anna: { score: 14 }, ben: { score: 9 }, chiara: { score: 6 }, dev: { score: 11 }, emeka: { score: 2, connected: false }, fatima: { score: 17 }, gus: { score: 4, bot: true }, hiroko: { score: 8 } };

function room(phase, extra = {}) {
  return { phase, people: people(8, SCORES), round: 4, rounds: 8, guesser: "hiroko", minPlayers: 3, maxPlayers: 8, ...extra };
}

const soon = (s) => Date.now() + s * 1000;
const WORDS = { c0: "Eruption", c1: "Mountain", c2: "Pompeii", c3: "Magma", c4: "Hot", c5: "Ash", c6: "Crater" };
const reveal = (n, turned = 0, words = false) =>
  ["ben", "dev", "fatima", "chiara", "anna", "gus", "emeka"].slice(0, n).map((a, i) => ({
    id: `c${i}`,
    author: a,
    bold: a === "fatima" || a === "chiara",
    fate: "alive",
    ...(i < turned ? { word: WORDS[`c${i}`], turned: i + 1 } : words ? { word: WORDS[`c${i}`] } : {}),
  }));

/** Each scenario: who this phone is, the room, the task (and whether it has joined). */
const SCENARIOS = {
  join: { joined: false, me: "anna", room: room("lobby", { people: people(4) }), task: { task: "lobby", face: { preset: 0 }, color: 0, canStart: true } },
  "join-error": { joined: false, joinError: { code: "name-taken", message: "name taken" }, me: "anna", room: room("lobby"), task: { task: "lobby", face: { preset: 0 }, color: 0, canStart: true } },
  "no-room": { noRoom: true, me: "anna", room: room("lobby"), task: { task: "wait" } },
  "lobby-vip": { me: "anna", room: room("lobby", { people: people(5).map((p) => ({ ...p, score: 0 })) }), task: { task: "lobby", face: { preset: 0 }, color: 0, canStart: true } },
  "lobby-few": { me: "anna", room: room("lobby", { people: people(2) }), task: { task: "lobby", face: { preset: 0 }, color: 0, canStart: false } },
  "lobby-guest": { me: "ben", room: room("lobby", { people: people(4, { dev: { connected: false } }) }), task: { task: "lobby", face: { strokes: BEN_DOODLE }, color: 1, canStart: false } },
  wait: { me: "ivy", extra: { id: "ivy", name: "Ivy", color: 0, face: { preset: 3 }, vip: false, connected: true, score: 0 }, room: room("write"), task: { task: "wait" } },
  "hotseat-guesser": { me: "hiroko", room: room("hotseat"), task: { task: "hotseat", guesser: true } },
  "hotseat-giver": { me: "anna", room: room("hotseat"), task: { task: "hotseat", guesser: false } },
  write: { me: "anna", room: room("write"), task: { task: "write", word: "Volcano", each: 1, sent: [null], deadline: soon(38) } },
  "write-long": { me: "anna", room: room("write"), task: { task: "write", word: "Refrigerator", each: 1, sent: [null], deadline: soon(7) } },
  "write-sent": { me: "anna", room: room("write"), task: { task: "write", word: "Volcano", each: 1, sent: [{ text: "Beacon", bold: true }], deadline: soon(21) } },
  write3: { me: "anna", room: room("write", { people: people(3), guesser: "chiara", rounds: 6 }), task: { task: "write", word: "Volcano", each: 2, sent: [{ text: "Lava", bold: false }, null], deadline: soon(30) } },
  blind: { me: "hiroko", room: room("write"), task: { task: "blind", givers: 7, done: 4, deadline: soon(24) } },
  check: { me: "hiroko", room: room("jinx"), task: { task: "check", survived: 3, jinxed: 4 } },
  "check-lost": { me: "hiroko", room: room("jinx"), task: { task: "check", survived: 0, jinxed: 7 } },
  "fate-alive": { me: "fatima", room: room("jinx"), task: { task: "fate", word: "Volcano", cards: [{ text: "Pompeii", bold: true, fate: "alive", with: [] }] } },
  "fate-jinxed": { me: "anna", room: room("jinx"), task: { task: "fate", word: "Volcano", cards: [{ text: "Lava", bold: true, fate: "jinxed", with: ["Chiara", "Gus"], reason: "same word" }] } },
  fate3: { me: "anna", room: room("jinx", { people: people(3), guesser: "chiara" }), task: { task: "fate", word: "Volcano", cards: [{ text: "Lava", bold: false, fate: "jinxed", with: ["Ben"], reason: "plural" }, { text: "Mountain", bold: true, fate: "alive", with: [] }] } },
  guess: { me: "hiroko", room: room("reveal"), task: { task: "guess", cards: reveal(3), pot: 6, deadline: soon(28), jinxed: 4 } },
  "guess-turned": { me: "hiroko", room: room("reveal"), task: { task: "guess", cards: reveal(3, 1), pot: 6, deadline: soon(19), jinxed: 4 } },
  "guess-7": { me: "hiroko", room: room("reveal"), task: { task: "guess", cards: reveal(7, 2), pot: 8, deadline: soon(25), jinxed: 0 } },
  "guess-all": { me: "hiroko", room: room("reveal"), task: { task: "guess", cards: reveal(3, 3), pot: 2, deadline: soon(8), jinxed: 4 } },
  "tv-jinx": { me: "anna", room: room("jinx"), task: { task: "tv" } },
  "tv-verdict": { me: "hiroko", room: room("verdict"), task: { task: "tv" } },
  "hold-write": { me: "anna", room: room("jinx"), task: { task: "write", word: "Volcano", each: 1, sent: [{ text: "Lava", bold: true }], deadline: soon(-2) } },
  "hold-blind": { me: "hiroko", room: room("jinx"), task: { task: "blind", givers: 7, done: 7, deadline: soon(-2) } },
  "hold-guess": { me: "hiroko", room: room("verdict"), task: { task: "guess", cards: reveal(3, 2), pot: 4, deadline: soon(20), jinxed: 4 } },
  "hold-watch": { me: "anna", room: room("verdict"), task: { task: "watch", word: "Volcano", cards: reveal(3, 2), pot: 4 } },
  "watch-long": { me: "anna", room: room("reveal"), task: { task: "watch", word: "Vegetable", cards: reveal(3, 1), pot: 10 } },
  watch: { me: "anna", room: room("reveal"), task: { task: "watch", word: "Volcano", cards: reveal(3, 2), pot: 4 } },
  "result-right": { me: "hiroko", room: room("verdict"), task: { task: "result", word: "Volcano", result: "right", guesser: true, delta: 6, why: ["pot"] } },
  "result-wrong": { me: "hiroko", room: room("verdict"), task: { task: "result", word: "Volcano", result: "wrong", guesser: true, delta: -2, why: ["wrong"] } },
  "result-pass": { me: "hiroko", room: room("verdict"), task: { task: "result", word: "Volcano", result: "pass", guesser: true, delta: 0, why: [] } },
  "result-giver": { me: "fatima", room: room("verdict"), task: { task: "result", word: "Volcano", result: "right", guesser: false, delta: 7, why: ["bold", "mvp"] } },
  "result-jinxed": { me: "anna", room: room("replay"), task: { task: "result", word: "Volcano", result: "right", guesser: false, delta: -2, why: ["bold-jinxed"] } },
  "result-lost": { me: "anna", room: room("verdict"), task: { task: "result", word: "Volcano", result: "lost", guesser: false, delta: 0, why: [] } },
  mvp: { me: "hiroko", room: room("replay"), task: { task: "mvp", cards: reveal(3, 2, true), deadline: soon(17) } },
  scores: { me: "dev", room: room("scores"), task: { task: "scores", score: 11, rank: 3, of: 8, next: false } },
  "scores-next": { me: "anna", room: room("scores"), task: { task: "scores", score: 14, rank: 2, of: 8, next: true } },
  final: { me: "ben", room: room("end"), task: { task: "final", score: 33, rank: 2, of: 8, award: "lone wolf", canRestart: false, found: 7, total: 10, title: "in sync" } },
  "final-vip": { me: "anna", room: room("end"), task: { task: "final", score: 41, rank: 1, of: 8, award: "kamikaze", canRestart: true, found: 10, total: 10, title: "telepaths" } },
  reconnecting: { me: "anna", room: room("write"), task: { task: "write", word: "Volcano", each: 1, sent: [null], deadline: soon(30) }, status: "reconnecting" },
  closed: { me: "anna", room: room("write"), task: { task: "write", word: "Volcano", each: 1, sent: [null], deadline: soon(30) }, status: "closed" },
  kicked: { me: "ben", room: room("lobby"), task: { task: "lobby", face: { preset: 1 }, color: 1, canStart: false }, bye: "kicked" },
};

export class PartyActionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function log(kind, data) {
  try {
    parent.postMessage({ harness: true, kind, data }, "*");
  } catch {}
  console.info("[fake]", kind, JSON.stringify(data));
}

// `lang=de`: the room in German, with German words (long compounds: the fitting).
const LANG = q.get("lang") ?? "en";
const GERMAN = { Volcano: "Geburtstagskuchen", VOLCANO: "GEBURTSTAGSKUCHEN", Eruption: "Feuerwehrauto", Mountain: "Weihnachtsbaum", Pompeii: "Kerzen", Magma: "Torte", Lava: "Kerze", lava: "kerze", LAVA: "KERZE", Crater: "Schneemann", Craters: "Schneemänner", Watermelonseeds: "Wassermelonenkerne", Congratulations: "Glückwunschkarte", Beacon: "Leuchtturmwärter", Refrigerator: "Kühlschranktür", Vegetable: "Gemüsesuppe" };
const clone = (v) => {
  let json = JSON.stringify(v);
  if (LANG === "de") json = json.replace(/"([A-Za-z]+)"/g, (m, w) => (GERMAN[w] ? `"${GERMAN[w]}"` : m));
  return JSON.parse(json);
};

export class PartyClient {
  static fromLocation() {
    return new PartyClient();
  }

  constructor() {
    const sc = SCENARIOS[scenarioName] ?? SCENARIOS["lobby-vip"];
    this.sc = sc;
    this.room = sc.noRoom ? "" : "KQZM";
    this.key = sc.noRoom ? undefined : "k";
    this.role = "player";
    this.status = "idle";
    this.byeReason = null;
    this.you = null;
    this.view = {};
    this.listeners = new Map();
    const r = clone(sc.room);
    if (sc.extra) r.people.push(clone(sc.extra));
    this.state = { room: r, me: clone(sc.task) };
    if (sc.joined === false) setTimeout(() => STEPS[step]?.(this), 300);
  }

  get saved() {
    return this.sc.joined === false ? null : { resume: "x", name: "Anna" };
  }
  get canResume() {
    return this.sc.joined !== false;
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }
  off(event, fn) {
    this.listeners.get(event)?.delete(fn);
  }
  emit(event, ...args) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }

  setStatus(s) {
    this.status = s;
    this.emit("status", s);
  }

  push() {
    this.view = { roster: [], room: { ...clone(this.state.room), lang: LANG }, me: clone(this.state.me) };
    this.emit("view", this.view);
  }

  async join(name) {
    log("join", { name });
    await wait(200);
    if (this.sc.joinError) {
      const e = this.sc.joinError;
      this.sc = { ...this.sc, joinError: null };
      throw new PartyActionError(e.code, e.message);
    }
    const p = this.state.room.people.find((x) => x.id === this.sc.me);
    if (p) p.name = name;
    return this.connect();
  }

  async connect() {
    this.setStatus("connecting");
    await wait(50);
    this.you = { id: this.sc.me };
    this.setStatus("open");
    this.push();
    setTimeout(() => this.after(), 150);
    return this.you;
  }

  after() {
    if (this.sc.status === "reconnecting") this.setStatus("reconnecting");
    if (this.sc.status === "closed") this.setStatus("closed");
    if (this.sc.bye) {
      this.byeReason = this.sc.bye;
      this.emit("bye", this.sc.bye);
      this.setStatus("closed");
    }
    STEPS[step]?.(this);
  }

  now() {
    return Date.now();
  }

  input(data) {
    log("input", data);
    this.state.lastDraft = data;
  }

  async act(type, data = null) {
    log("act", { type, data });
    await wait(250);
    const s = this.state;
    const me = s.me;
    switch (type) {
      case "face": {
        me.face = data;
        const p = s.room.people.find((x) => x.id === this.you?.id);
        if (p) p.face = data;
        break;
      }
      case "start":
        s.room.phase = "hotseat";
        s.room.people.forEach((p) => (p.score = 0));
        s.me = { task: "hotseat", guesser: false };
        break;
      case "kick":
        s.room.people = s.room.people.filter((p) => p.id !== data.id);
        if (me.task === "lobby") me.canStart = s.room.people.length >= 3;
        break;
      case "clue": {
        const t = String(data.text).toLowerCase().replace(/[^a-z0-9 ]/g, "");
        if (t.includes(me.word.toLowerCase().slice(0, 6))) throw new PartyActionError("too-close", "Too close to the word: contains the word");
        if (t.split(/\s+/).length > 2) throw new PartyActionError("too-many-words", "One word, please (two at most, like “ice cream”)");
        if (me.sent.some((x, i) => i !== data.slot && x && x.text.toLowerCase() === t)) throw new PartyActionError("own-clue", "You already wrote that");
        me.sent[data.slot] = { text: data.text, bold: !!data.bold };
        break;
      }
      case "pick": {
        const c = me.cards.find((x) => x.id === data.card);
        if (!c || c.turned) throw new PartyActionError("bad", "That card is already turned");
        const n = me.cards.filter((x) => x.turned).length;
        c.turned = n + 1;
        c.word = WORDS[c.id];
        if (n > 0) me.pot = Math.max(2, me.pot - 2);
        me.deadline = soon(30);
        break;
      }
      case "guess": {
        const right = /volcano/i.test(data.text);
        s.room.phase = "verdict";
        s.me = { task: "result", word: "Volcano", result: right ? "right" : "wrong", guesser: true, delta: right ? me.pot : -2, why: [right ? "pot" : "wrong"] };
        break;
      }
      case "pass":
        s.room.phase = "verdict";
        s.me = { task: "result", word: "Volcano", result: "pass", guesser: true, delta: 0, why: [] };
        break;
      case "mvp":
        break;
      case "again":
        s.room.phase = "lobby";
        s.me = { task: "lobby", face: { preset: 0 }, color: 0, canStart: true };
        break;
      default:
        throw new PartyActionError("unknown", `Unknown action ${type}`);
    }
    this.push();
    return null;
  }

  leave() {}
  close() {
    this.setStatus("closed");
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {string} sel @param {string} text */
function type(sel, text) {
  const el = document.querySelector(sel);
  if (!el) return null;
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el;
}

/** Scripted steps for screenshots (`&do=NAME`). */
const STEPS = {
  submitjoin: () => {
    type("#name", "Anna");
    document.querySelector("#dock button[type=submit]")?.click();
  },
  focus: () => document.querySelector("#dock input")?.focus(),
  reject: async () => {
    type("#dock input", "Volcanoes");
    document.querySelector("#dock .send")?.click();
  },
  reject3: async () => {
    document.querySelector("#dock .sent button")?.click();
    await wait(50);
    const inputs = document.querySelectorAll("#dock input");
    inputs[1].value = "lava";
    inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    inputs[1].focus();
    document.querySelectorAll("#dock .send")[1]?.click();
    await wait(400);
    inputs[0].value = "Mount Etna erupts";
    document.querySelectorAll("#dock .send")[0]?.click();
  },
  bold: async () => {
    type("#dock input", "Lava");
    document.querySelector("#dock button.bold")?.click();
  },
  draft: () => type("#dock input", "volcam"),
  play: async () => {
    document.querySelector("main button.card")?.click();
    await wait(400);
    type("#dock input", "volcano");
    await wait(150);
    document.querySelector("#dock .editor .primary")?.click();
  },
  pass: () => document.querySelector("#dock .pass")?.click(),
  pick: () => document.querySelector("main button.card")?.click(),
  mvp: () => document.querySelectorAll("main button.card")[1]?.click(),
  kick: () => document.querySelector("button.kick")?.click(),
  scroll: () => {
    const m = document.querySelector("main");
    if (m) m.scrollTop = m.scrollHeight;
  },
  draw: () => {
    const c = document.querySelector("canvas.pad");
    if (!c) return;
    const r = c.getBoundingClientRect();
    const at = (x, y) => ({ clientX: r.left + (x / 1000) * r.width, clientY: r.top + (y / 1000) * r.height, pointerId: 1, bubbles: true });
    const line = (pts) => {
      c.dispatchEvent(new PointerEvent("pointerdown", at(...pts[0])));
      for (const p of pts.slice(1)) c.dispatchEvent(new PointerEvent("pointermove", at(...p)));
      c.dispatchEvent(new PointerEvent("pointerup", at(...pts[pts.length - 1])));
    };
    line([[330, 380]]);
    line([[670, 380]]);
    line([[260, 560], [330, 680], [500, 740], [670, 680], [740, 560]]);
    line([[200, 250], [300, 150], [420, 230], [520, 120], [640, 230], [760, 140], [820, 260]]);
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);
