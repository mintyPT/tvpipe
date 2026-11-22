import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ITEMS,
  ITEM_COUNT,
  ITEM_NAME_MAX,
  ITEM_NOTE_MAX,
  KEEPS,
  LANGS,
  MAX_VALUE,
  MIN_VALUE,
  NIGHT_MAX,
  NIGHT_MIN,
  OUTSIDE_KINDS,
  ROOM_KINDS,
  TAG_VALUE,
  fits,
  itemById,
  pickCatalogue,
  tagCount,
  type Keep,
  type Lang,
  type LootPlace,
  type RoomKind,
} from "../game/items.ts";
import {
  BUTTONS,
  BUTTON_MAX,
  CAPTION_MAX,
  DIRS4,
  DIRS8,
  ESTATE_COUNT,
  REFUSALS,
  REFUSAL_MAX,
  TICKER_MAX,
  UI,
  WORDS,
  award,
  caption,
  claim,
  estate,
  fact,
  intertitle,
  money,
  noun,
  outcome,
  pick,
  placeLabel,
  roleCard,
  tip,
  type Area,
  type Noun,
  type Template,
} from "../game/words.ts";

// Typical names: a long-ish guard and thief (the ticker limit holds for these).
const GUARD = "Benedikt";
const THIEF = "Clara";

/** mulberry32, for the tests' own randomness. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An rng that picks variant i of n. */
const nth = (i: number, n: number) => () => (i + 0.5) / n;

/** A finished line: no leftover placeholders or JavaScript leaks, NFC, trimmed. */
function clean(s: string, what: string): void {
  assert.equal(typeof s, "string", what);
  assert.ok(s.trim().length > 0, `${what}: empty`);
  assert.equal(s, s.trim(), `${what}: spaces at the ends: ${JSON.stringify(s)}`);
  assert.equal(s, s.normalize("NFC"), `${what}: not NFC`);
  assert.doesNotMatch(s, /\$\{|\{\w+\}|undefined|NaN|null|\[object|  /, `${what}: ${s}`);
}

// Every place of every kind, each variant, numbered and not.
function areas(withDoors: boolean): Area[] {
  const out: Area[] = [];
  for (const room of ROOM_KINDS) for (let v = 0; v < 4; v++) for (const n of [undefined, 2]) out.push(n ? { room, variant: v, n } : { room, variant: v });
  for (const outside of OUTSIDE_KINDS) for (let v = 0; v < 3; v++) out.push({ outside, variant: v });
  if (withDoors) {
    for (const door of ROOM_KINDS) for (let v = 0; v < 4; v++) out.push({ door, variant: v, n: 2 });
    for (const gate of DIRS4) out.push({ gate });
    out.push({ spot: "P3" });
  }
  return out;
}
const ROOMS = areas(false);
const PLACES = areas(true);

function each<P>(list: readonly Template<P>[], p: P, check: (s: string, i: number) => void): void {
  assert.ok(list.length > 0);
  list.forEach((t, i) => check(t(p), i));
}

// ---------------------------------------------------------------------------
// Items

test("the catalogue: 60 items, unique ids, values in range, names and notes short", () => {
  assert.equal(ITEMS.length, ITEM_COUNT);
  assert.equal(new Set(ITEMS.map((i) => i.id)).size, ITEMS.length);
  for (const lang of LANGS) assert.equal(new Set(ITEMS.map((i) => i.name[lang])).size, ITEMS.length, `${lang} names unique`);
  for (const it of ITEMS) {
    assert.match(it.id, /^[a-z][a-z-]*$/);
    assert.ok(Number.isInteger(it.value) && it.value >= MIN_VALUE && it.value <= MAX_VALUE, it.id);
    assert.ok(it.keep.length > 0 && it.rooms.length > 0, it.id);
    assert.equal(new Set(it.keep).size, it.keep.length, it.id);
    assert.equal(new Set(it.rooms).size, it.rooms.length, it.id);
    for (const k of it.keep) assert.ok((KEEPS as readonly string[]).includes(k), it.id);
    for (const r of it.rooms) assert.ok((ROOM_KINDS as readonly string[]).includes(r), it.id);
    assert.equal(it.tagged, it.value >= TAG_VALUE, it.id);
    if (it.keep.includes("pedestal")) assert.ok(it.value >= 7_000, `${it.id}: a pedestal item is precious`);
    for (const lang of LANGS) {
      clean(it.name[lang], `${it.id} name ${lang}`);
      assert.ok(it.name[lang].length <= ITEM_NAME_MAX, `${it.id}: ${it.name[lang]}`);
      if (it.note) {
        clean(it.note[lang], `${it.id} note ${lang}`);
        assert.ok(it.note[lang].length <= ITEM_NOTE_MAX, `${it.id}: ${it.note[lang]}`);
      }
    }
    assert.equal(itemById(it.id), it);
  }
  assert.equal(itemById("nope"), undefined);
  // The spread: most are cheap, a few big, the extremes present.
  const values = ITEMS.map((i) => i.value);
  assert.equal(Math.min(...values), MIN_VALUE);
  assert.equal(Math.max(...values), MAX_VALUE);
  assert.ok(values.filter((v) => v <= 1_500).length >= 30, "most are cheap");
  assert.ok(values.filter((v) => v >= 10_000).length >= 8, "some are big");
  assert.ok(ITEMS.filter((i) => i.tagged).length >= 10);
  assert.ok(ITEMS.filter((i) => i.size === "large").length >= 15);
});

test("the catalogue covers every room and every kind of place", () => {
  for (const room of ROOM_KINDS) {
    const loose = ITEMS.filter((i) => fits(i, { keep: "loose", room }));
    assert.ok(loose.length >= 3, `${room}: ${loose.length} loose items`);
  }
  const needs: [Keep, RoomKind[]][] = [
    ["case", ["gallery", "library", "study", "ballroom", "bedroom"]],
    ["safe", ["vault", "study", "bedroom"]],
    ["pedestal", ["vault", "gallery", "library", "study", "ballroom", "bedroom"]],
  ];
  for (const [keep, rooms] of needs) {
    for (const room of rooms) {
      const n = ITEMS.filter((i) => fits(i, { keep, room })).length;
      assert.ok(n >= 3, `${keep} in ${room}: ${n}`);
    }
  }
});

const TYPICAL: LootPlace[] = [
  { keep: "pedestal", room: "vault", depth: 12 },
  { keep: "safe", room: "vault", depth: 12 },
  { keep: "safe", room: "study", depth: 8 },
  { keep: "case", room: "gallery", depth: 9 },
  { keep: "case", room: "gallery", depth: 9 },
  { keep: "case", room: "library", depth: 7 },
  { keep: "case", room: "bedroom", depth: 10 },
  { keep: "loose", room: "dining", depth: 4 },
  { keep: "loose", room: "kitchen", depth: 3 },
  { keep: "loose", room: "billiards", depth: 6 },
  { keep: "loose", room: "library", depth: 7 },
  { keep: "loose", room: "study", depth: 8 },
  { keep: "loose", room: "bedroom", depth: 10 },
  { keep: "loose", room: "bathroom", depth: 9 },
  { keep: "loose", room: "garage", depth: 2 },
  { keep: "loose", room: "conservatory", depth: 5 },
  { keep: "loose", room: "ballroom", depth: 6 },
  { keep: "loose", room: "foyer", depth: 1 },
];

function checkNight(night: ReturnType<typeof pickCatalogue>, places: readonly LootPlace[], want: number): void {
  assert.equal(night.length, want);
  assert.equal(new Set(night.map((n) => n.item.id)).size, night.length, "items distinct");
  assert.equal(new Set(night.map((n) => n.place)).size, night.length, "places distinct");
  for (let i = 1; i < night.length; i++) assert.ok(night[i - 1]!.item.value >= night[i]!.item.value, "most valuable first");
  for (const n of night) {
    const p = places[n.place];
    assert.ok(p, "a place given");
    assert.ok(n.item.keep.includes(p.keep), `${n.item.id} kept ${p.keep}`);
  }
  const ped = night.filter((n) => places[n.place]!.keep === "pedestal");
  assert.ok(ped.length <= 1, "at most one pedestal");
  if (ped.length === 1) {
    assert.equal(night[0], ped[0], "the pedestal holds the most valuable");
    assert.ok(night.slice(1).every((n) => n.item.value < ped[0]!.item.value), "strictly");
  }
  const tags = night.filter((n) => n.tagged);
  assert.ok(tags.length <= tagCount(night.length));
  for (const t of tags) assert.ok(t.item.tagged);
  // The tags sit on the most valuable eligible items.
  const eligible = night.filter((n) => n.item.tagged).slice(0, tagCount(night.length));
  assert.deepEqual(tags, eligible);
}

test("pickCatalogue: counts, distinct suitable places, one pedestal at the top, tags", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const want = NIGHT_MIN + (seed % (NIGHT_MAX - NIGHT_MIN + 1));
    const night = pickCatalogue(want, rng(seed), TYPICAL);
    checkNight(night, TYPICAL, want);
    // With a typical estate everything suits its room too, and there is a pedestal piece, tags and a spread.
    for (const n of night) assert.ok(fits(n.item, TYPICAL[n.place]!), `${seed}: ${n.item.id} in ${TYPICAL[n.place]!.room}`);
    assert.equal(TYPICAL[night[0]!.place]!.keep, "pedestal", `${seed}: the pedestal is used`);
    assert.ok(night.filter((n) => n.tagged).length >= 2, `${seed}: tags`);
    assert.ok(night.filter((n) => n.item.value < 1_600).length >= want / 2 - 1, `${seed}: mostly cheap`);
  }
});

test("pickCatalogue: the same rng gives the same night; clamps the count", () => {
  assert.deepEqual(pickCatalogue(10, rng(7), TYPICAL), pickCatalogue(10, rng(7), TYPICAL));
  assert.equal(pickCatalogue(3, rng(1), TYPICAL).length, NIGHT_MIN);
  assert.equal(pickCatalogue(40, rng(1), TYPICAL).length, NIGHT_MAX);
});

test("pickCatalogue: no pedestal place, odd rooms, few places", () => {
  const noPedestal = TYPICAL.filter((p) => p.keep !== "pedestal");
  for (let seed = 1; seed <= 100; seed++) {
    const night = pickCatalogue(12, rng(seed), noPedestal);
    checkNight(night, noPedestal, 12);
  }
  // Two pedestals: only one is used.
  const two: LootPlace[] = [...TYPICAL, { keep: "pedestal", room: "gallery", depth: 3 }];
  for (let seed = 1; seed <= 100; seed++) checkNight(pickCatalogue(10, rng(seed), two), two, 10);
  // Places nothing suits by room: items still go by keep.
  const odd: LootPlace[] = Array.from({ length: 10 }, () => ({ keep: "case", room: "shed" }));
  checkNight(pickCatalogue(8, rng(3), odd), odd, 8);
  // Fewer places than items: as many as there are.
  assert.equal(pickCatalogue(10, rng(3), TYPICAL.slice(0, 5)).length, 5);
  assert.deepEqual(pickCatalogue(10, rng(3), []), []);
});

test("pickCatalogue: the valuable go deep where the places allow", () => {
  const places: LootPlace[] = Array.from({ length: 14 }, (_, i) => ({ keep: "loose" as const, room: "study" as const, depth: i }));
  for (let seed = 1; seed <= 50; seed++) {
    const night = pickCatalogue(14, rng(seed), places);
    for (let i = 1; i < night.length; i++) {
      if (night[i - 1]!.item.value > night[i]!.item.value) assert.ok(places[night[i - 1]!.place]!.depth! > places[night[i]!.place]!.depth!, `${seed}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Words: both languages, every field

test("both languages have the same tables with enough variants", () => {
  const shape = (w: object): unknown =>
    Object.fromEntries(
      Object.entries(w)
        .filter(([k]) => k !== "lang")
        .map(([k, v]) => [k, typeof v === "function" || typeof v === "string" ? typeof v : Array.isArray(v) ? "list" : shape(v as object)]),
    );
  assert.deepEqual(shape(WORDS.de), shape(WORDS.en));
  for (const lang of LANGS) {
    const w = WORDS[lang];
    assert.equal(w.lang, lang);
    assert.equal(w.estates.length, ESTATE_COUNT);
    assert.equal(w.howTo.length, 3);
    const lists: [string, readonly unknown[], number][] = [
      ["tips", w.tips, 4],
      ["asides", w.asides, 4],
      ...Object.entries(w.intertitles).map(([k, v]): [string, readonly unknown[], number] => [`intertitle ${k}`, v, k === "briefing" ? 4 : 3]),
      ...Object.entries(w.facts).map(([k, v]): [string, readonly unknown[], number] => [`fact ${k}`, v, 2]),
      ...Object.entries(w.claims).map(([k, v]): [string, readonly unknown[], number] => [`claim ${k}`, v, 2]),
      ...Object.entries(w.captions).map(([k, v]): [string, readonly unknown[], number] => [`caption ${k}`, v, 2]),
      ...Object.entries(w.outcomes).map(([k, v]): [string, readonly unknown[], number] => [`outcome ${k}`, v.subs, 2]),
      ...Object.entries(w.awards).map(([k, v]): [string, readonly unknown[], number] => [`award ${k}`, v.citations, 2]),
    ];
    for (const [what, list, min] of lists) assert.ok(list.length >= min, `${lang} ${what}: ${list.length} < ${min}`);
    assert.equal(Object.keys(w.awards).length, 5);
    assert.deepEqual(Object.keys(w.buttons).sort(), [...BUTTONS].sort());
    assert.deepEqual(Object.keys(w.refusals).sort(), [...REFUSALS].sort());
    assert.deepEqual(Object.keys(w.ui).sort(), [...UI].sort());
  }
});

test("short texts: buttons, refusals, ui, how-to, tagline, estates, outcome and award names", () => {
  for (const lang of LANGS) {
    const w = WORDS[lang];
    for (const [k, s] of Object.entries(w.buttons)) {
      clean(s, `${lang} button ${k}`);
      assert.ok(s.length <= BUTTON_MAX, `${lang} button ${k}: ${s}`);
    }
    for (const [k, s] of Object.entries(w.refusals)) {
      clean(s, `${lang} refusal ${k}`);
      assert.ok(s.length <= REFUSAL_MAX, `${lang} refusal ${k}: ${s}`);
    }
    for (const [k, s] of Object.entries(w.ui)) clean(s, `${lang} ui ${k}`);
    for (const s of w.howTo) {
      clean(s, `${lang} how-to`);
      assert.ok(s.length <= 120, s);
    }
    clean(w.tagline, `${lang} tagline`);
    assert.ok(w.tagline.length <= 70);
    assert.equal(new Set(w.estates.map((e) => e.name)).size, ESTATE_COUNT, `${lang} estates unique`);
    for (const e of w.estates) {
      clean(e.name, "estate");
      clean(e.at, "estate at");
      assert.ok(e.name.length <= 34, e.name);
      assert.ok(e.at.toLowerCase().endsWith(e.name.toLowerCase()), e.at);
    }
    assert.equal(estate(lang, ESTATE_COUNT + 2), w.estates[2]);
    for (const o of Object.values(w.outcomes)) clean(o.title, "outcome title");
    assert.equal(new Set(Object.values(w.awards).map((a) => a.name)).size, 5);
    for (const a of Object.values(w.awards)) clean(a.name, "award name");
    for (const r of Object.values(w.roles)) {
      clean(r.name, "role name");
      clean(r.title, "role title");
    }
  }
  assert.notEqual(WORDS.de.awards.longArm.name, WORDS.en.awards.longArm.name);
});

test("places: every kind has names in both languages, nouns are clean", () => {
  for (const lang of LANGS) {
    for (const kind of [...ROOM_KINDS, ...OUTSIDE_KINDS]) {
      const names = WORDS[lang].names(kind);
      assert.ok(names.length >= 2, `${lang} ${kind}`);
      assert.equal(new Set(names).size, names.length);
      assert.equal(placeLabel(lang, kind, names.length), names[0], "variants wrap");
    }
    for (const a of PLACES) {
      const n = noun(lang, a);
      for (const [k, v] of Object.entries(n)) clean(v, `${lang} ${JSON.stringify(a)} ${k}`);
      assert.ok(n.label.length <= 34, n.label);
    }
    for (const wing of [...DIRS4, "garden"] as const) {
      for (const building of [undefined, 0, 1]) {
        const n = noun(lang, building === undefined ? { wing } : { wing, building });
        for (const v of Object.values(n)) clean(v, `${lang} wing ${wing}`);
      }
    }
  }
  // Known answers for the grammar.
  assert.deepEqual(noun("en", { room: "billiards" }), { label: "Billiard Room", the: "the billiard room", in: "in the billiard room", to: "to the billiard room" });
  assert.deepEqual(noun("en", { outside: "street" }).in, "on the street");
  assert.deepEqual(noun("en", { room: "bedroom", n: 2 }), { label: "Bedroom 2", the: "bedroom 2", in: "in bedroom 2", to: "to bedroom 2" });
  assert.equal(noun("en", { gate: "n" }).in, "at the north gate");
  assert.equal(noun("en", { door: "library" }).the, "the library door");
  assert.equal(noun("en", { wing: "e", building: 1 }).in, "in the east wing of the guest house");
  assert.deepEqual(noun("de", { room: "library" }), { label: "Bibliothek", the: "die Bibliothek", in: "in der Bibliothek", to: "in die Bibliothek" });
  assert.deepEqual(noun("de", { room: "billiards" }), { label: "Billardzimmer", the: "das Billardzimmer", in: "im Billardzimmer", to: "ins Billardzimmer" });
  assert.deepEqual(noun("de", { room: "vault" }), { label: "Tresorraum", the: "der Tresorraum", in: "im Tresorraum", to: "in den Tresorraum" });
  assert.equal(noun("de", { outside: "carpark" }).in, "auf dem Parkplatz");
  assert.equal(noun("de", { outside: "street" }).to, "auf die Straße");
  assert.equal(noun("de", { gate: "n" }).in, "am Nordtor");
  assert.equal(noun("de", { door: "library" }).the, "die Tür zur Bibliothek");
  assert.equal(noun("de", { door: "kitchen", variant: 0 }).in, "an der Tür zur Küche");
  assert.equal(noun("de", { door: "vault" }).in, "an der Tür zum Tresorraum");
  assert.equal(noun("de", { spot: "P2" }).in, "auf dem Stellplatz P2");
  assert.equal(noun("de", { wing: "e", building: 1 }).in, "im Ostflügel des Gästehauses");
  assert.equal(noun("de", { wing: "garden" }).in, "im Garten");
  assert.equal(money("en", 12_500), "$12,500");
  assert.equal(money("en", 200), "$200");
  assert.equal(money("de", 1_234_567), "1.234.567 $");
});

// ---------------------------------------------------------------------------
// Templates: every variant, every place, substituted and within the limits

test("ticker facts: every variant, every room and item, ≤ 70 characters", () => {
  for (const lang of LANGS) {
    const f = WORDS[lang].facts;
    const names = ITEMS.map((i) => i.name[lang]);
    for (const where of ROOMS.map((a) => noun(lang, a))) {
      const p = { where, camera: 4, seconds: 60, guard: GUARD, thief: THIEF, item: "" };
      const check = (s: string) => {
        clean(s, `${lang} fact`);
        assert.ok(s.length <= TICKER_MAX, `${lang} (${s.length}): ${s}`);
      };
      for (const [k, list] of Object.entries(f)) {
        if (k === "missing") continue;
        each(list as readonly Template<typeof p>[], p, check);
      }
      for (const item of names) each(f.missing, { where, item }, check);
    }
  }
});

test("ticker claims: every variant and place, with and without asides, ≤ 70", () => {
  for (const lang of LANGS) {
    const w = WORDS[lang];
    for (const where of PLACES.map((a) => noun(lang, a))) {
      for (const dir of DIRS8) {
        const p = { guard: GUARD, where, dir: w.dir(dir) };
        for (const [k, list] of Object.entries(w.claims)) {
          // Seen, Clear and Look snap to a room or an area; only a Post goes on a door, a gate or a spot.
          if (k !== "post" && !ROOMS.some((a) => noun(lang, a).the === where.the)) continue;
          each(list as readonly Template<typeof p>[], p, (s) => {
            clean(s, `${lang} claim`);
            assert.ok(s.length <= TICKER_MAX, `${lang} (${s.length}): ${s}`);
            assert.ok(s.startsWith(`${GUARD}: `), s);
          });
        }
        if (dir !== "n") break;
      }
    }
    for (const a of w.asides) clean(a({ guard: GUARD }), `${lang} aside`);
    // The API: asides only when they fit.
    for (let seed = 1; seed <= 200; seed++) {
      const s = claim(lang, "clear", { guard: GUARD, where: { room: "security", variant: 2, n: 2 } }, rng(seed));
      clean(s, "claim");
      assert.ok(s.length <= TICKER_MAX, s);
      const seen = claim(lang, "seen", { guard: GUARD, where: { outside: "carpark" }, dir: "ne" }, rng(seed));
      assert.match(seen, lang === "en" ? /north-east/ : /Nordosten/);
    }
  }
  assert.equal(claim("en", "clear", { guard: "Ben", where: { room: "library" } }, nth(0, 6)), "Ben: the library is clear. Ben seems sure.");
});

test("intertitles, tips, outcomes, captions, awards, roles: every variant substituted", () => {
  for (const lang of LANGS) {
    const w = WORDS[lang];
    const it = w.intertitles;
    for (const e of w.estates) {
      each(it.briefing, { estate: e }, (s) => {
        clean(s, "briefing");
        assert.equal(s, s.toLocaleUpperCase(lang), s);
        assert.ok(s.includes(e.name.toLocaleUpperCase(lang)), s);
      });
    }
    each(it.round, { thief: THIEF, round: 3 }, (s) => {
      clean(s, "round");
      assert.ok(s.includes(THIEF.toLocaleUpperCase(lang)) && s.includes("3"), s);
    });
    for (const k of ["heist", "tape", "scores", "final"] as const) each(it[k], {}, (s) => clean(s, k));

    for (const item of ITEMS.filter((i) => i.value >= 7_000)) {
      // Loot is never outside: tips name a building's half, with the house when there are two.
      const wings = DIRS4.flatMap((wing) => [noun(lang, { wing }), noun(lang, { wing, building: 0 }), noun(lang, { wing, building: 1 })]);
      for (const where of wings) {
        each(w.tips, { item: item.name[lang], where }, (s) => {
          clean(s, "tip");
          assert.ok(s.toLocaleUpperCase(lang).includes(item.name[lang].toLocaleUpperCase(lang)), s);
        });
      }
    }

    for (const [k, o] of Object.entries(w.outcomes)) {
      each(o.subs as readonly Template<{ thief: string; guard: string }>[], { thief: THIEF, guard: GUARD }, (s) => {
        clean(s, `outcome ${k}`);
        assert.ok(s.length <= CAPTION_MAX && s.includes(THIEF), s);
      });
    }

    const where: Noun = noun(lang, { room: "security", variant: 2, n: 2 });
    for (const [k, list] of Object.entries(w.captions)) {
      for (const guards of [1, 3]) {
        const p = { guard: GUARD, thief: THIEF, where, paces: 2, guards, haul: 12_500, camera: 3 };
        each(list as readonly Template<typeof p>[], p, (s) => {
          clean(s, `caption ${k}`);
          assert.ok(s.length <= CAPTION_MAX, `${lang} caption ${k} (${s.length}): ${s}`);
        });
      }
    }

    for (const [k, a] of Object.entries(w.awards)) {
      for (const n of [1, 4]) {
        const p = { name: THIEF, haul: 31_400, holds: n, arrests: 1, paces: n, lies: n, lights: n };
        each(a.citations as readonly Template<typeof p>[], p, (s) => {
          clean(s, `award ${k}`);
          assert.ok(s.length <= CAPTION_MAX && s.includes(THIEF), `${lang} ${k}: ${s}`);
        });
      }
    }

    const thief = roleCard(lang, "thief", { spot: "P2", where: { outside: "alley" } });
    assert.ok(thief.lines.length >= 2 && thief.lines[0]!.includes("P2"));
    const guard = roleCard(lang, "guard", { where: { room: "security" } });
    for (const s of [...thief.lines, ...guard.lines, thief.title, guard.title]) clean(s, "role");
  }
});

test("the API resolves areas, items and numbers in the language asked", () => {
  const ruby = itemById("ruby")!;
  assert.equal(fact("en", "missing", { item: ruby, where: { room: "vault" } }, nth(0, 2)), "MISSING in the vault: Maharaja's Ruby.");
  assert.equal(fact("de", "missing", { item: ruby, where: { room: "vault" } }, nth(0, 2)), "VERMISST im Tresorraum: Rubin des Maharadschas.");
  assert.equal(fact("en", "alarm", { where: { room: "gallery" }, seconds: 60 }, nth(0, 2)), "ALARM in the gallery! Police in 60 seconds.");
  assert.equal(fact("de", "held", { guard: "Ben", thief: "Anna", where: { room: "library" } }, nth(0, 2)), "GESTELLT in der Bibliothek! Ben hat Anna im Licht.");
  assert.equal(caption("en", "liePost", { guard: "Ben", where: { gate: "n" } }, nth(0, 2)), "Ben's post at the north gate. Ben was never at the north gate.");
  assert.equal(caption("en", "closeShave", { guard: "Clara", thief: "Anna", paces: 2.2 }, nth(0, 2)), "Clara, two paces from Anna, looking the other way.");
  assert.equal(caption("en", "firecracker", { thief: "Anna", guards: 3, where: { room: "kitchen" } }, nth(0, 2)), "One firecracker sent three guards to the kitchen.");
  assert.equal(caption("de", "firecracker", { thief: "Anna", guards: 3, where: { room: "kitchen" } }, nth(0, 2)), "Ein Knallfrosch schickt drei Wachen in die Küche.");
  assert.equal(caption("de", "firecracker", { thief: "Anna", guards: 1, where: { room: "kitchen" } }, nth(1, 2)), "Eine Wache stürmt in die Küche. Dort wartet: ein Knallfrosch.");
  assert.equal(caption("de", "closeShave", { guard: "Ben", thief: "Anna", paces: 1 }, nth(0, 2)), "Ben, einen Schritt von Anna entfernt, schaut woandershin.");
  assert.equal(intertitle("en", "briefing", { estate: estate("en", 0) }, nth(0, 5)), "MEANWHILE, AT THE VAN DOREN ESTATE…");
  assert.equal(intertitle("de", "briefing", { estate: estate("de", 1) }, nth(0, 5)), "UNTERDESSEN, AUF SCHLOSS GROSCHENSTEIN …");
  assert.equal(tip("en", { item: ruby, wing: "e" }, nth(0, 5)), "Word is: Maharaja's Ruby, in the east wing.");
  assert.equal(tip("de", { item: ruby, wing: "w" }, nth(0, 5)), "Ein Vögelchen zwitschert: Rubin des Maharadschas, im Westflügel.");
  // map.ts's wing: the house is named only on a lot with two buildings.
  assert.equal(tip("en", { item: ruby, wing: { building: 0, half: "n" }, buildings: 1 }, nth(0, 5)), "Word is: Maharaja's Ruby, in the north wing.");
  assert.equal(tip("en", { item: ruby, wing: { building: 1, half: "s" }, buildings: 2 }, nth(0, 5)), "Word is: Maharaja's Ruby, in the south wing of the guest house.");
  assert.equal(tip("de", { item: ruby, wing: { building: 0, half: "e" }, buildings: 2 }, nth(0, 5)), "Ein Vögelchen zwitschert: Rubin des Maharadschas, im Ostflügel des Haupthauses.");
  // The door buttons and the new refusals.
  assert.equal(WORDS.en.buttons.open, "Open");
  assert.equal(WORDS.de.buttons.close, "Schließen");
  for (const lang of LANGS) for (const k of ["busy", "blocked", "holding"] as const) assert.ok(WORDS[lang].refusals[k].length > 0);
  assert.notEqual(WORDS.de.refusals.busy, WORDS.de.refusals.holding);
  assert.deepEqual(outcome("en", "pinched", { thief: "Anna", guard: "Ben" }, nth(0, 2)), { title: "PINCHED!", sub: "Ben collars Anna. The loot goes back on the shelf." });
  assert.equal(award("en", "stickyFingers", { name: "Anna", haul: 31_400 }, nth(0, 2)).citation, "Anna walked off with $31,400. Allegedly.");
  assert.equal(award("de", "longArm", { name: "Ben", holds: 0, arrests: 2 }, nth(0, 2)).citation, "Ben: kein Mal gestellt, 2-mal festgenommen. Die Pfeife glüht noch.");
  assert.equal(pick(["a", "b", "c"], () => 0.9999), "c");
  assert.equal(pick(["a", "b", "c"], () => 1), "c");
  assert.throws(() => pick([], () => 0));
});

// ---------------------------------------------------------------------------
// Item names carry no article: every template that names an item puts it
// after a colon or a dash, after "a certain", or in a telegram's capitals.
// PINCH_WORDS_SAMPLE=1 npm test prints every such template with a few items.

test("item names read well without an article", () => {
  const ITEM = "ITEMX";
  const ok = /(?:: |– |a certain )ITEMX\b/;
  const sample = process.env.PINCH_WORDS_SAMPLE === "1";
  const items = ["ruby", "bible", "walkman", "rembrandt", "sandal", "gin", "piano-key"].map((id) => itemById(id)!);
  // The names themselves: no article in front, no comma inside (it would read as the end of the name).
  for (const it of ITEMS) {
    assert.doesNotMatch(it.name.en, /^(the|a|an) |,/i, it.name.en);
    assert.doesNotMatch(it.name.de, /^(der|die|das|des|dem|den|ein|eine|einer|eines|einem|einen) |,/i, it.name.de);
  }
  for (const lang of LANGS) {
    const w = WORDS[lang];
    const where = noun(lang, { wing: "e" });
    const room = noun(lang, { room: "library" });
    const templates: [string, (item: string) => string][] = [
      ...w.tips.map((t, i): [string, (item: string) => string] => [`tip ${i}`, (item) => t({ item, where })]),
      ...w.facts.missing.map((t, i): [string, (item: string) => string] => [`missing ${i}`, (item) => t({ item, where: room })]),
    ];
    for (const [what, render] of templates) {
      const s = render(ITEM);
      assert.ok(ok.test(s), `${lang} ${what}: the item needs a colon, a dash or "a certain" before it: ${s}`);
      for (const item of items) {
        const line = render(item.name[lang]);
        clean(line, `${lang} ${what}`);
        if (sample) console.log(`${lang} ${what.padEnd(9)} ${line}`);
      }
    }
  }
});
