/**
 * Protocol vectors (`test/vectors/`): sessions, diffs and names, recorded
 * from this host by `node test/vectors.ts --bless` (first written when a
 * Node and a Rust host both replayed them); `vectors.test.ts` replays
 * them against the host on a relay in memory.
 *
 * File format: tvpipe's test vector files (blocks of `key = value` lines,
 * separated by blank lines, `#` comments).
 *
 * - `diff.txt`: `a`, `b` (JSON objects), `diff` (the `{set, del}` of a
 *   `state` message, or `none`).
 * - `names.txt`: `input` (a JSON string), `clean` (the cleaned name, `""`
 *   when refused), `key` (the uniqueness key of `clean`).
 * - `sessions.txt`: `options` (party options as JSON) and `step` lines,
 *   run in order:
 *   - `cN open` opens client N's WebSocket (`cN refused STATUS` when the
 *     upgrade is refused), `cN close` closes it (1000);
 *   - `cN > JSON` sends a message (`cN >*K JSON` K times, `cN >pad N JSON`
 *     with a `pad` field of N `x`s added, `cN >text TEXT`, `cN >binary HEX`
 *     other frames);
 *   - `cN < JSON` expects the client's next message, `cN closed CODE` the
 *     server closing its socket;
 *   - `host VERB …` runs the host: `room.set JSON`, `room.replace JSON`,
 *     `screen.set JSON`, `me ID JSON` (a player's own state, merged),
 *     `lock`, `unlock`, `kick ID`, `close`, `send ID TYPE JSON`,
 *     `broadcast TYPE JSON`, `late-join MODE` (`closed`, `wait`,
 *     `open`), `in-progress true|false`, `activate ID`, `tv-delay MS`
 *     (sets `party.tvDelay`), `with-tv VERB …` (a verb inside
 *     `party.withTv`). `now` and `at` fields match anything.
 *   Strings `"$NAME"` in JSON are variables: `ROOM`, `JOIN`, `SCREEN`,
 *   `WATCH` are the party's; others are bound by the first expected
 *   message that has them (resume tokens: `R1`, `R2`, …); `"$_"` matches
 *   anything. Objects compare without key order. After the last step no
 *   client may have unread messages.
 *
 *   Actions the host handles: `echo` (the result is the data), `fail`
 *   (a PartyError with `data.code` and `data.message`), `set-room`,
 *   `set-screen`, `set-me` (merge the data into that state, no result),
 *   `inputs` (the latest `in` of each player that sent one, by id).
 *   The join info is `{code, url: "https://party.test/", qr: {size: 1,
 *   rows: ["1"]}}`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cleanText, MAX_NAME, nameKey } from "../src/names.ts";
import { PartyError, type LateJoin, type Party, type Player } from "../src/party.ts";
import { Party as PartyHost } from "../src/party.ts";
import { MemoryRelay } from "../src/testing.ts";
import { diff, isObject, type Json, type JsonObject } from "../src/sync.ts";

export const VECTORS = fileURLToPath(new URL("./vectors/", import.meta.url));

// ---------------------------------------------------------------------------
// The file format

export type Block = { line: number; entries: [string, string][] };

export function parseVectors(text: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | undefined;
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") {
      cur = undefined;
      return;
    }
    if (line.startsWith("#")) return;
    if (/^\s/.test(line) && cur && cur.entries.length > 0) {
      cur.entries[cur.entries.length - 1]![1] += line.trim();
      return;
    }
    const eq = line.indexOf(" = ");
    if (eq < 0) throw new Error(`vectors line ${i + 1}: expected "key = value"`);
    if (!cur) {
      cur = { line: i + 1, entries: [] };
      blocks.push(cur);
    }
    cur.entries.push([line.slice(0, eq).trim(), line.slice(eq + 3)]);
  });
  return blocks;
}

export function get(b: Block, key: string): string {
  const e = b.entries.find(([k]) => k === key);
  if (!e) throw new Error(`vector block at line ${b.line}: missing ${key}`);
  return e[1];
}

export function all(b: Block, key: string): string[] {
  return b.entries.filter(([k]) => k === key).map(([, v]) => v);
}

/** JSON with every non-ASCII and invisible character escaped (readable files). */
export function asciiJson(v: Json): string {
  return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function header(what: string): string {
  return (
    `# ${what}\n` +
    "# Generated from @tvpipe/party (the reference): `node test/vectors.ts --bless` in npm/party.\n" +
    "# Format: npm/party/test/vectors.ts.\n"
  );
}

// ---------------------------------------------------------------------------
// diff.txt

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomValue(r: () => number, depth: number): Json {
  switch (Math.floor(r() * (depth > 2 ? 4 : 7))) {
    case 0:
      return null;
    case 1:
      return r() < 0.5;
    case 2:
      return Math.floor(r() * 5);
    case 3:
      return ["a", "b", "", "é"][Math.floor(r() * 4)]!;
    case 4:
      return [randomValue(r, depth + 1), randomValue(r, depth + 1)].slice(0, Math.floor(r() * 3));
    default:
      return randomObject(r, depth + 1);
  }
}

function randomObject(r: () => number, depth: number): JsonObject {
  const o: JsonObject = {};
  const n = Math.floor(r() * 4);
  for (let i = 0; i < n; i++) o[["x", "y", "z", "w"][Math.floor(r() * 4)]!] = randomValue(r, depth);
  return o;
}

export function diffCases(): { name: string; a: JsonObject; b: JsonObject }[] {
  const cases: { name: string; a: JsonObject; b: JsonObject }[] = [
    { name: "equal", a: { x: 1, o: { a: [1, 2] } }, b: { x: 1, o: { a: [1, 2] } } },
    {
      name: "set, nested merge, delete, arrays and null replace",
      a: { x: 1, o: { a: 1, b: { c: 2 } }, arr: [1, 2], gone: true, n: 3 },
      b: { x: 1, o: { a: 2, b: { c: 2 } }, arr: [1, 2, 3], n: null, added: { k: "v" } },
    },
    { name: "object replaces a scalar and back", a: { o: { y: 1 }, x: 5 }, b: { o: 5, x: { y: 1 } } },
    { name: "nested delete", a: { o: { a: 1, b: { c: 1, d: 2 } } }, b: { o: { a: 1, b: { c: 1 } } } },
    { name: "emptied object", a: { o: { a: 1 } }, b: { o: {} } },
    { name: "from empty", a: {}, b: { roster: [{ id: "p1", name: "Ann", vip: true, connected: true }], room: {}, me: {} } },
    { name: "to empty", a: { x: 1, y: { z: 2 } }, b: {} },
    { name: "numbers", a: { i: 1, f: 1.5, neg: -3, big: 1700000000000 }, b: { i: 2, f: 1.25, neg: -3, big: 1700000000001 } },
    { name: "strings with escapes", a: { s: "a\"b" }, b: { s: "line\nnext \u00e9 \ud83d\ude00 \u0001" } },
    { name: "same array", a: { a: [{ x: 1 }] }, b: { a: [{ x: 1 }] } },
    { name: "array element change replaces the array", a: { a: [{ x: 1 }, 2] }, b: { a: [{ x: 2 }, 2] } },
  ];
  const r = rng(7);
  for (let i = 0; i < 40; i++) cases.push({ name: `random ${i}`, a: randomObject(r, 0), b: randomObject(r, 0) });
  return cases;
}

function diffFile(): string {
  let out = header("State diffs: the `set`/`del` of a `state` message from view `a` to view `b`.");
  for (const c of diffCases()) {
    const d = diff(c.a, c.b);
    out += `\nname = ${c.name}\na = ${asciiJson(c.a)}\nb = ${asciiJson(c.b)}\ndiff = ${d ? asciiJson(d as JsonObject) : "none"}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// names.txt

export const NAME_CASES: [string, string][] = [
  ["plain", "Ann"],
  ["trimmed", "  Ann  "],
  ["whitespace collapsed", "  a\tb\n\nc  "],
  ["bidi override and zero width", "x\u202ey\u200bz\u0007"],
  ["bidi isolates, BOM, separators", "\u2066a\u2069b\ufeffc\u2028d\u2029"],
  ["C1 controls and private use", "a\u0085b\u009fc\ue000d"],
  ["ZWNJ removed, ZWJ kept", "a\u200cb\u200dc"],
  ["empty", ""],
  ["only spaces", "   "],
  ["only invisible", "\u200b\u202e"],
  ["too long: 16 characters", "abcdefghijklmnopqrstuvwxyz"],
  ["exactly 16", "abcdefghijklmnop"],
  ["truncated then trimmed", "abcdefghijklmno pqr"],
  ["accents (NFC input)", "Zo\u00eb M\u00fcller"],
  ["combining mark (not NFC)", "Zoe\u0308"],
  ["uppercase accents", "\u00c9LODIE"],
  ["Latin Extended-A", "\u0141ukasz \u0160imon"],
  ["German sharp s", "Stra\u00dfe"],
  ["emoji", "Ann \ud83c\udf55"],
  ["emoji ZWJ family counts as one", "\ud83d\udc69\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66abcdefghijklmnopq"],
  ["emoji skin tone counts as one", "\ud83d\udc4d\ud83c\udffdabcdefghijklmnopq"],
  ["flags count as one each", "\ud83c\udde6\ud83c\uddf9\ud83c\udde9\ud83c\uddeaabcdefghijklmnopq"],
  ["combining marks count with their base", "e\u0301e\u0301e\u0301abcdefghijklmnopq"],
  ["Cyrillic", "\u041c\u0430\u0448\u0430"],
  ["Greek with tonos", "\u0386\u03bd\u03bd\u03b1"],
  ["CJK", "\u5c0f\u660e"],
  ["Hangul", "\ud55c\uae00"],
  ["Arabic", "\u0639\u0644\u064a"],
  ["fullwidth (compatibility)", "\uff21\uff4e\uff4e"],
  ["ligature (compatibility)", "\ufb01sh"],
  ["superscript (compatibility)", "x\u00b2"],
  ["non-breaking space", "a\u00a0b"],
  ["ideographic space", "a\u3000b"],
  ["dotless i and dotted I", "\u0131 \u0130"],
  ["digits and punctuation", "R2-D2!"],
];

function namesFile(): string {
  let out = header("Player names: `input` (from the phone), `clean` (the name, \"\" when refused), `key` (uniqueness).");
  for (const [name, input] of NAME_CASES) {
    const clean = cleanText(input, MAX_NAME);
    out += `\nname = ${name}\ninput = ${asciiJson(input)}\nclean = ${asciiJson(clean)}\nkey = ${asciiJson(nameKey(clean))}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// sessions.txt

export interface Scenario {
  name: string;
  options?: JsonObject;
  /** Steps without expectations (`<`, `closed`): the recording adds them. */
  steps: string[];
}

const hello = (name: string) => `{"t":"hello","v":1,"room":"$ROOM","role":"player","key":"$JOIN","name":${JSON.stringify(name)}}`;
const act = (id: number, type: string, data: Json = null) => `{"t":"act","id":${id},"type":"${type}","data":${JSON.stringify(data)}}`;

export const SCENARIOS: Scenario[] = [
  {
    name: "two players join; the first is VIP; views and diffs",
    steps: [
      "c1 open",
      `c1 > ${hello("  Ann\u202e  ")}`,
      "c2 open",
      `c2 > ${hello("Bob")}`,
      'host room.set {"phase":"lobby","n":1}',
      'host me p2 {"secret":"pineapple"}',
      'host room.set {"n":2,"deep":{"a":{"b":1}}}',
      'host room.set {"deep":{"a":{"c":2}}}',
      'host room.replace {"phase":"draw"}',
      'host screen.set {"phase":"lobby"}',
    ],
  },
  {
    name: "actions: results, errors, unknown types, state before the ack",
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      `c1 > ${act(1, "echo", { x: [1, "two"] })}`,
      `c1 > ${act(2, "echo")}`,
      `c1 > ${act(3, "fail", { code: "not-vip", message: "Only the VIP starts" })}`,
      `c1 > ${act(4, "nope")}`,
      `c1 > ${act(5, "set-room", { phase: "x" })}`,
      `c1 > ${act(6, "set-me", { mine: true })}`,
      `c1 > {"t":"act","id":7,"type":"echo"}`,
    ],
  },
  {
    name: "actions are applied once: repeated ids get the cached ack",
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      `c1 > ${act(1, "set-room", { count: 1 })}`,
      `c1 > ${act(1, "set-room", { count: 2 })}`,
      `c1 > ${act(2, "echo", "two")}`,
      `c1 > ${act(2, "echo", "again")}`,
    ],
  },
  {
    name: "bad acts are protocol errors",
    steps: ["c1 open", `c1 > ${hello("Ann")}`, `c1 > {"t":"act","id":0,"type":"echo"}`],
  },
  {
    name: "bad acts: a fractional id",
    steps: ["c1 open", `c1 > ${hello("Ann")}`, `c1 > {"t":"act","id":1.5,"type":"echo"}`],
  },
  {
    name: "bad acts: no type",
    steps: ["c1 open", `c1 > ${hello("Ann")}`, `c1 > {"t":"act","id":1}`],
  },
  {
    name: "resume: the same player, the newest socket wins, acts continue",
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      "c2 open",
      `c2 > ${hello("Bob")}`,
      `c1 > ${act(1, "echo", 1)}`,
      "c3 open",
      `c3 > {"t":"hello","v":1,"room":"$ROOM","role":"player","key":"$JOIN","resume":"$R1"}`,
      `c3 > ${act(1, "echo", "replayed")}`,
      `c3 > ${act(2, "echo", 2)}`,
    ],
  },
  {
    name: "away and back: the roster shows it",
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      "c2 open",
      `c2 > ${hello("Bob")}`,
      "c2 close",
      "c3 open",
      `c3 > {"t":"hello","v":1,"room":"$ROOM","role":"player","resume":"$R2"}`,
    ],
  },
  {
    name: "unknown resume token without a name",
    steps: ["c1 open", `c1 > {"t":"hello","v":1,"room":"$ROOM","role":"player","key":"$JOIN","resume":"nope"}`],
  },
  {
    name: "unknown resume token with a name joins anew",
    steps: ["c1 open", `c1 > {"t":"hello","v":1,"room":"$ROOM","role":"player","key":"$JOIN","resume":"nope","name":"Ann"}`],
  },
  {
    name: "wrong key",
    steps: ["c1 open", `c1 > {"t":"hello","v":1,"room":"$ROOM","role":"player","key":"nope","name":"Ann"}`],
  },
  {
    name: "unknown room",
    steps: ["c1 open", `c1 > {"t":"hello","v":1,"room":"ZZZZ","role":"player","key":"$JOIN","name":"Ann"}`],
  },
  {
    name: "room codes are case-insensitive",
    steps: ["c1 open", `c1 > {"t":"hello","v":1,"room":"$room","role":"player","key":"$JOIN","name":"Ann"}`],
  },
  {
    name: "wrong protocol version",
    steps: ["c1 open", `c1 > {"t":"hello","v":2,"room":"$ROOM","role":"player","key":"$JOIN","name":"Ann"}`],
  },
  { name: "not JSON first", steps: ["c1 open", "c1 >text hello"] },
  { name: "not a hello first", steps: ["c1 open", `c1 > {"t":"ping","c":1}`] },
  { name: "binary first", steps: ["c1 open", "c1 >binary 0102"] },
  {
    name: "unknown role",
    steps: ["c1 open", `c1 > {"t":"hello","v":1,"room":"$ROOM","role":"admin","key":"$JOIN","name":"Ann"}`],
  },
  {
    name: "names: invalid and taken (case and accents)",
    steps: [
      "c1 open",
      `c1 > ${hello("Zo\u00eb")}`,
      "c2 open",
      `c2 > ${hello("ZOE")}`,
      "c3 open",
      `c3 > ${hello("  \u200b ")}`,
      "c4 open",
      `c4 > {"t":"hello","v":1,"room":"$ROOM","role":"player","key":"$JOIN","name":42}`,
    ],
  },
  {
    name: "full",
    options: { maxPlayers: 2 },
    steps: ["c1 open", `c1 > ${hello("Ann")}`, "c2 open", `c2 > ${hello("Bob")}`, "c3 open", `c3 > ${hello("Cy")}`],
  },
  {
    name: "locked: no new names, resumes still work",
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      "host lock",
      "c2 open",
      `c2 > ${hello("Bob")}`,
      "c1 close",
      "c3 open",
      `c3 > {"t":"hello","v":1,"room":"$ROOM","role":"player","resume":"$R1"}`,
      "host unlock",
      "c4 open",
      `c4 > ${hello("Bob")}`,
    ],
  },
  {
    name: "late join closed: refused while a game is in progress, resumes still work",
    options: { lateJoin: "closed" },
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      "c2 open",
      `c2 > {"t":"hello","v":1,"room":"$ROOM","role":"screen","key":"$SCREEN"}`,
      "host in-progress true",
      "c3 open",
      `c3 > ${hello("Bob")}`,
      "c1 close",
      "c4 open",
      `c4 > {"t":"hello","v":1,"room":"$ROOM","role":"player","resume":"$R1"}`,
      "host in-progress false",
      "c5 open",
      `c5 > ${hello("Bob")}`,
    ],
  },
  {
    name: "late join wait and open: newcomers wait until the game activates them",
    steps: [
      "c1 open",
      `c1 > {"t":"hello","v":1,"room":"$ROOM","role":"screen","key":"$SCREEN"}`,
      "c2 open",
      `c2 > ${hello("Ann")}`,
      "host in-progress true",
      "c3 open",
      `c3 > ${hello("Bob")}`,
      "host late-join open",
      "c4 open",
      `c4 > ${hello("Cy")}`,
      "host activate p2",
      "host activate p1",
      "c4 close",
      "c5 open",
      `c5 > {"t":"hello","v":1,"room":"$ROOM","role":"player","resume":"$R3"}`,
      "host in-progress false",
      "host activate p3",
    ],
  },
  {
    name: "leave: the VIP passes to the next connected player",
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      "c2 open",
      `c2 > ${hello("Bob")}`,
      "c3 open",
      `c3 > ${hello("Cy")}`,
      "c2 close",
      `c1 > {"t":"leave"}`,
    ],
  },
  {
    name: "kick",
    steps: ["c1 open", `c1 > ${hello("Ann")}`, "c2 open", `c2 > ${hello("Bob")}`, "host kick p2"],
  },
  {
    name: "screens and watchers",
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      'host screen.set {"phase":"lobby"}',
      "c2 open",
      `c2 > {"t":"hello","v":1,"room":"$ROOM","role":"screen","key":"$SCREEN"}`,
      "c3 open",
      `c3 > {"t":"hello","v":1,"room":"$ROOM","role":"watch","key":"$WATCH"}`,
      `c2 > ${act(1, "echo", "from the screen")}`,
      `c2 > ${act(1, "echo", "repeated")}`,
      `c3 > ${act(1, "echo", "watching")}`,
      'host screen.set {"phase":"draw"}',
      "c4 open",
      `c4 > {"t":"hello","v":1,"room":"$ROOM","role":"screen","key":"$JOIN"}`,
    ],
  },
  {
    name: "the TV's delay: clients learn it, changes synced with the TV carry their time",
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      "c2 open",
      `c2 > {"t":"hello","v":1,"room":"$ROOM","role":"screen","key":"$SCREEN"}`,
      "host tv-delay 250",
      'host room.set {"phase":"lobby"}',
      'host with-tv room.set {"phase":"vote"}',
      'host with-tv screen.set {"phase":"vote"}',
      "host with-tv broadcast buzz null",
      "c3 open",
      `c3 > ${hello("Bob")}`,
      `c1 > {"t":"act","id":1,"type":"echo","data":"pressed","at":1}`,
      "host tv-delay 0",
    ],
  },
  {
    name: "screens are limited",
    options: { limits: { screens: 1 } },
    steps: [
      "c1 open",
      `c1 > {"t":"hello","v":1,"room":"$ROOM","role":"screen","key":"$SCREEN"}`,
      "c2 open",
      `c2 > {"t":"hello","v":1,"room":"$ROOM","role":"watch","key":"$WATCH"}`,
    ],
  },
  {
    name: "ping, resync, unknown messages",
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      `c1 > {"t":"ping","c":12345}`,
      `c1 > {"t":"ping"}`,
      'host room.set {"a":1}',
      `c1 > {"t":"resync"}`,
      `c1 > {"t":"future","x":1}`,
      `c1 > {"t":"ping","c":1}`,
    ],
  },
  {
    name: "messages: to one player and broadcast",
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      "c2 open",
      `c2 > ${hello("Bob")}`,
      "c3 open",
      `c3 > {"t":"hello","v":1,"room":"$ROOM","role":"screen","key":"$SCREEN"}`,
      'host send p2 toast {"text":"hi"}',
      "host broadcast sound null",
    ],
  },
  {
    name: "rate limited",
    options: { limits: { rate: 1, burst: 5 } },
    steps: ["c1 open", `c1 > ${hello("Ann")}`, `c1 >*6 {"t":"ping","c":1}`],
  },
  {
    name: "control messages are limited to 16 KiB",
    steps: ["c1 open", `c1 > ${hello("Ann")}`, `c1 >pad 16384 {"t":"ping"}`],
  },
  {
    name: "after a protocol error: not an object",
    steps: ["c1 open", `c1 > ${hello("Ann")}`, "c1 > [1,2]"],
  },
  {
    name: "after hello: binary messages are refused",
    steps: ["c1 open", `c1 > ${hello("Ann")}`, "c1 >binary 00"],
  },
  {
    name: "continuous input: the latest by sequence, players only, small",
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      "c2 open",
      `c2 > {"t":"hello","v":1,"room":"$ROOM","role":"screen","key":"$SCREEN"}`,
      `c1 > ${act(1, "inputs")}`,
      `c1 > {"t":"in","s":1,"data":[0.5,-1]}`,
      `c1 > {"t":"in","s":3,"data":"three"}`,
      `c1 > {"t":"in","s":2,"data":"stale"}`,
      `c1 > {"t":"in","s":0,"data":"zero"}`,
      `c1 > {"t":"in","s":3.5,"data":"fraction"}`,
      `c1 > {"t":"in","data":"no sequence"}`,
      `c2 > {"t":"in","s":10,"data":"from the screen"}`,
      `c1 > ${act(2, "inputs")}`,
      `c1 >pad 4096 {"t":"in","s":4,"data":"big"}`,
      `c1 > {"t":"in","s":5}`,
      `c1 > ${act(3, "inputs")}`,
      `c1 > {"t":"in","s":6,"data":{"x":1}}`,
      `c1 > ${act(4, "inputs")}`,
    ],
  },
  {
    name: "the room closes",
    steps: [
      "c1 open",
      `c1 > ${hello("Ann")}`,
      "c2 open",
      `c2 > {"t":"hello","v":1,"room":"$ROOM","role":"screen","key":"$SCREEN"}`,
      "host close",
    ],
  },
];

// ---------------------------------------------------------------------------
// Running a session against this server (record or replay)

interface Conn {
  ws: { send(data: string | Uint8Array): void; close(code?: number): void };
  inbox: string[];
  closed: number | undefined;
  waiters: (() => void)[];
}

function settle(conns: Map<string, Conn>, quietMs = 60, maxMs = 2000): Promise<void> {
  return new Promise((ok) => {
    const start = Date.now();
    let last = conns.size === 0 ? 0 : total();
    let since = Date.now();
    function total(): number {
      let n = 0;
      for (const c of conns.values()) n += c.inbox.length + (c.closed === undefined ? 0 : 1);
      return n;
    }
    const t = setInterval(() => {
      const n = total();
      if (n !== last) {
        last = n;
        since = Date.now();
      }
      if (Date.now() - since >= quietMs || Date.now() - start > maxMs) {
        clearInterval(t);
        ok();
      }
    }, 5);
  });
}

/** Replaces strings "$NAME" with bound values (`$room`: the room in lowercase). */
function substitute(v: Json, vars: Map<string, Json>): Json {
  if (typeof v === "string" && v.startsWith("$")) {
    const name = v.slice(1);
    if (name === "room") return String(vars.get("ROOM")).toLowerCase();
    if (vars.has(name)) return vars.get(name)!;
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => substitute(x, vars));
  if (isObject(v)) {
    const o: JsonObject = {};
    for (const [k, x] of Object.entries(v)) o[k] = substitute(x, vars);
    return o;
  }
  return v;
}

/** Whether `actual` matches `expected` (variables bound on the way). */
export function matches(expected: Json, actual: Json, vars: Map<string, Json>): boolean {
  if (typeof expected === "string" && expected.startsWith("$")) {
    const name = expected.slice(1);
    if (name === "_") return true;
    if (vars.has(name)) return JSON.stringify(vars.get(name)) === JSON.stringify(actual);
    vars.set(name, actual);
    return true;
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matches(e, actual[i]!, vars));
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return false;
    const ek = Object.keys(expected);
    if (ek.length !== Object.keys(actual).length) return false;
    return ek.every((k) => Object.hasOwn(actual, k) && matches(expected[k]!, actual[k]!, vars));
  }
  return expected === actual;
}

/** A received message with the party's secrets and fresh tokens replaced by variables. */
function scrub(v: Json, vars: Map<string, Json>, key?: string): Json {
  if ((key === "now" || key === "at") && typeof v === "number") return "$_";
  if (typeof v === "string") {
    for (const [name, value] of vars) if (value === v) return `$${name}`;
    if (key === "resume") {
      const name = `R${[...vars.keys()].filter((k) => /^R\d+$/.test(k)).length + 1}`;
      vars.set(name, v);
      return `$${name}`;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, vars));
  if (isObject(v)) {
    const o: JsonObject = {};
    for (const [k, x] of Object.entries(v)) o[k] = scrub(x, vars, k);
    return o;
  }
  return v;
}

function installGame(party: Party): void {
  party.handle("echo", (data) => data);
  party.handle("fail", (data) => {
    const d = isObject(data) ? data : {};
    throw new PartyError(String(d["code"] ?? "failed"), String(d["message"] ?? "failed"));
  });
  party.handle("set-room", (data) => {
    if (isObject(data)) party.room.set(data);
  });
  party.handle("set-screen", (data) => {
    if (isObject(data)) party.screen.set(data);
  });
  party.handle("set-me", (data, from) => {
    if (from.role === "player" && isObject(data)) (from as Player).state.set(data);
  });
  party.handle("inputs", () => {
    const o: JsonObject = {};
    for (const p of party.players) if (p.input !== undefined) o[p.id] = p.input;
    return o;
  });
}

function partyOptions(o: JsonObject | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!o) return out;
  if (typeof o["maxPlayers"] === "number") out["maxPlayers"] = o["maxPlayers"];
  if (isObject(o["limits"])) out["limits"] = o["limits"];
  if (typeof o["lateJoin"] === "string") out["lateJoin"] = o["lateJoin"];
  return out;
}

/**
 * Runs a session. `record`: expectations in `steps` are ignored and the
 * returned steps have them, from what this server sent. Otherwise every
 * expectation is checked (throws on a mismatch).
 */
export async function runSession(options: JsonObject | undefined, steps: string[], record: boolean): Promise<string[]> {
  const relay = new MemoryRelay();
  const party = new PartyHost(partyOptions(options)).listen(relay);
  party.joinInfo = { code: party.code, url: "https://party.test/", qr: { size: 1, rows: ["1"] } };
  installGame(party);
  const vars = new Map<string, Json>([
    ["ROOM", party.code],
    ["JOIN", party.joinKey],
    ["SCREEN", party.screenKey],
    ["WATCH", party.watchKey],
  ]);
  const conns = new Map<string, Conn>();
  const out: string[] = [];
  const url = "ws://party.test/_tvpipe/ws";

  const flushRecorded = async () => {
    await settle(conns);
    for (const [name, c] of conns) {
      for (const m of c.inbox.splice(0)) out.push(`${name} < ${asciiJson(scrub(JSON.parse(m) as Json, vars))}`);
      if (c.closed !== undefined && c.closed !== -1) {
        out.push(`${name} closed ${c.closed}`);
        c.closed = -1;
      }
    }
  };

  const next = async (name: string, what: string): Promise<{ msg?: string; closed?: number }> => {
    const c = conns.get(name);
    if (!c) throw new Error(`${what}: no client ${name}`);
    const end = Date.now() + 3000;
    while (c.inbox.length === 0 && (c.closed === undefined || c.closed === -1)) {
      if (Date.now() > end) throw new Error(`${what}: timed out`);
      await new Promise((r) => setTimeout(r, 5));
    }
    if (c.inbox.length > 0) return { msg: c.inbox.shift()! };
    const code = c.closed!;
    c.closed = -1;
    return { closed: code };
  };

  try {
    for (const step of steps) {
      const m = /^(\S+) (\S+)(?: (.*))?$/s.exec(step);
      if (!m) throw new Error(`bad step ${step}`);
      const [, who, verb, rest = ""] = m as unknown as [string, string, string, string?];
      if (who === "host") {
        if (record) out.push(step);
        hostStep(party, verb, rest);
        if (record) await flushRecorded();
        continue;
      }
      if (verb === "<" || verb === "closed") {
        if (record) continue;
        const got = await next(who!, step);
        if (verb === "closed") {
          if (got.closed !== Number(rest)) throw new Error(`${step}: got ${got.msg ?? `closed ${got.closed}`}`);
        } else if (got.msg === undefined || !matches(JSON.parse(rest) as Json, JSON.parse(got.msg) as Json, vars)) {
          throw new Error(`${step}\n  got ${got.msg ?? `closed ${got.closed}`}`);
        }
        continue;
      }
      if (record) out.push(verb === ">" || verb.startsWith(">*") ? `${who} ${verb} ${asciiJson(JSON.parse(rest) as Json)}` : step);
      if (verb === "open") {
        const ws = new relay.WebSocket(url) as unknown as Conn["ws"] & {
          onmessage: (e: { data: unknown }) => void;
          onclose: (e: { code: number }) => void;
          onopen: () => void;
          onerror: () => void;
        };
        const c: Conn = { ws, inbox: [], closed: undefined, waiters: [] };
        conns.set(who!, c);
        ws.onmessage = (e) => c.inbox.push(typeof e.data === "string" ? e.data : `<binary>`);
        ws.onclose = (e) => {
          if (c.closed === undefined) c.closed = e.code;
        };
        await new Promise<void>((ok, fail) => {
          ws.onopen = () => ok();
          ws.onerror = () => fail(new Error(`${step}: refused`));
        });
      } else if (verb === "close") {
        const c = conns.get(who!)!;
        c.closed = -1;
        c.ws.close(1000);
      } else if (verb === ">" || verb.startsWith(">*")) {
        const times = verb === ">" ? 1 : Number(verb.slice(2));
        const text = JSON.stringify(substitute(JSON.parse(rest) as Json, vars));
        for (let i = 0; i < times; i++) conns.get(who!)!.ws.send(text);
      } else if (verb === ">pad") {
        const sp = rest.indexOf(" ");
        const msg = substitute(JSON.parse(rest.slice(sp + 1)) as Json, vars) as JsonObject;
        msg["pad"] = "x".repeat(Number(rest.slice(0, sp)));
        conns.get(who!)!.ws.send(JSON.stringify(msg));
      } else if (verb === ">text") {
        conns.get(who!)!.ws.send(rest);
      } else if (verb === ">binary") {
        conns.get(who!)!.ws.send(Uint8Array.from(Buffer.from(rest, "hex")));
      } else {
        throw new Error(`bad step ${step}`);
      }
      if (record) await flushRecorded();
    }
    if (!record) {
      await settle(conns, 100);
      for (const [name, c] of conns) {
        if (c.inbox.length > 0) throw new Error(`${name} has unread messages: ${c.inbox.join(" | ")}`);
        if (c.closed !== undefined && c.closed !== -1) throw new Error(`${name} was closed (${c.closed}) unexpectedly`);
      }
    }
  } finally {
    for (const c of conns.values()) c.ws.close();
    party.close();
  }
  return out;
}

function hostStep(party: Party, verb: string, rest: string): void {
  const json = (s: string) => JSON.parse(s) as Json;
  const player = (id: string) => {
    const p = party.player(id);
    if (!p) throw new Error(`no player ${id}`);
    return p;
  };
  switch (verb) {
    case "room.set":
      return party.room.set(json(rest) as JsonObject);
    case "room.replace":
      return party.room.replace(json(rest) as JsonObject);
    case "screen.set":
      return party.screen.set(json(rest) as JsonObject);
    case "me": {
      const sp = rest.indexOf(" ");
      return player(rest.slice(0, sp)).state.set(json(rest.slice(sp + 1)) as JsonObject);
    }
    case "lock":
      return party.lock();
    case "late-join":
      party.lateJoin = rest as LateJoin;
      return;
    case "in-progress":
      party.inProgress = rest === "true";
      return;
    case "activate":
      party.activate(player(rest));
      return;
    case "unlock":
      return party.unlock();
    case "kick":
      return party.kick(player(rest));
    case "close":
      return party.close();
    case "send": {
      const [id, type, ...data] = rest.split(" ");
      return party.send(player(id!), type!, json(data.join(" ")));
    }
    case "broadcast": {
      const [type, ...data] = rest.split(" ");
      return party.broadcast(type!, json(data.join(" ")), "all");
    }
    case "tv-delay":
      party.tvDelay = Number(rest);
      return;
    case "with-tv": {
      const sp = rest.indexOf(" ");
      return party.withTv(() => hostStep(party, rest.slice(0, sp), rest.slice(sp + 1)));
    }
    default:
      throw new Error(`bad host step ${verb}`);
  }
}

async function sessionsFile(): Promise<string> {
  let out = header("Sessions: clients and the host in steps, with what the server answers.");
  for (const s of SCENARIOS) {
    const steps = await runSession(s.options, s.steps, true);
    out += `\nname = ${s.name}\n`;
    if (s.options) out += `options = ${asciiJson(s.options)}\n`;
    for (const st of steps) out += `step = ${st}\n`;
  }
  return out;
}

// ---------------------------------------------------------------------------

export function readVectors(file: string): Block[] {
  return parseVectors(readFileSync(VECTORS + file, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--bless")) {
    console.error("usage: node test/vectors.ts --bless   (rewrites crates/tvpipe-party/tests/vectors/*.txt)");
    process.exit(2);
  }
  writeFileSync(VECTORS + "diff.txt", diffFile());
  writeFileSync(VECTORS + "names.txt", namesFile());
  writeFileSync(VECTORS + "sessions.txt", await sessionsFile());
  console.log(`wrote ${VECTORS}{diff,names,sessions}.txt`);
}
