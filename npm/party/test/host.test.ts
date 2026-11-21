/** The standard host page's pieces that need no page: texts, the stock settings, the language a page starts in. */

import assert from "node:assert/strict";
import test from "node:test";

import { hostStrings, languageField, lateJoinField, preferredLang, textIn, type Choice, type LateJoin } from "../src/index.ts";

test("a text in the page's language: one for all, per language (English, then the first, for the others), or a function", () => {
  assert.equal(textIn("Rounds", "de"), "Rounds");
  assert.equal(textIn({ en: "Rounds", de: "Runden" }, "de"), "Runden");
  assert.equal(textIn({ en: "Rounds", de: "Runden" }, "fr"), "Rounds");
  assert.equal(textIn({ de: "Runden" }, "fr"), "Runden");
  assert.equal(textIn((l) => `${l}!`, "de"), "de!");
  assert.equal(textIn(undefined, "de"), "");
  assert.equal(hostStrings("de").start, "Spiel starten");
  assert.equal(hostStrings("xx").start, "Start the game", "English for a language the page does not speak");
});

test("the language setting: by their own names, a language without data greyed out", () => {
  let lang: "en" | "de" = "en";
  const f = languageField({ langs: ["en", "de"] as const, get: () => lang, set: (l) => (lang = l), available: (l) => l === "en", unavailable: { en: "No words" } });
  assert.equal(f.key, "lang");
  assert.equal(textIn(f.label, "de"), "Sprache");
  const choices = f.choices as readonly Choice[];
  assert.deepEqual(
    choices.map((c) => [c.value, textIn(c.label, "en"), typeof c.disabled === "function" ? c.disabled() : c.disabled]),
    [
      ["en", "English", false],
      ["de", "Deutsch", true],
    ],
  );
  f.set("de");
  assert.equal(f.get(), "de");
});

test("latecomers: the game's modes in its order, labelled in the page's language; a mode it does not offer reads as the nearest", () => {
  const party: { lateJoin: LateJoin } = { lateJoin: "wait" };
  const told: LateJoin[] = [];
  const f = lateJoinField(party, ["wait", "closed"], (m) => told.push(m));
  assert.deepEqual(
    (f.choices as readonly Choice[]).map((c) => textIn(c.label, "de")),
    ["ab der nächsten Runde", "nicht während eines Spiels"],
  );
  f.set("closed");
  assert.equal(party.lateJoin, "closed");
  assert.deepEqual(told, ["closed"]);
  party.lateJoin = "open";
  assert.equal(f.get(), "wait");
});

test("the language a host page starts in: the last one picked here, an older key, the browser's, the first", () => {
  const store = new Map<string, string>();
  const g = globalThis as Record<string, unknown>;
  const saved = { localStorage: Object.getOwnPropertyDescriptor(g, "localStorage"), navigator: Object.getOwnPropertyDescriptor(g, "navigator") };
  const nav = { languages: ["fr-FR"], language: "fr-FR" };
  Object.defineProperty(g, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } });
  Object.defineProperty(g, "navigator", { configurable: true, value: nav });
  try {
    const langs = ["en", "de"] as const;
    assert.equal(preferredLang("quiz", langs), "en", "nothing fits: the first");
    nav.languages = ["de-AT"];
    assert.equal(preferredLang("quiz", langs), "de", "the browser's");
    store.set("quiz:host-lang", "en");
    assert.equal(preferredLang("quiz", langs), "en", "the key of before the standard page");
    store.set("quiz:host", JSON.stringify({ lang: "de", settings: { lang: "de" } }));
    assert.equal(preferredLang("quiz", langs), "de", "the last one picked");
    store.set("quiz:host", "not json");
    assert.equal(preferredLang("quiz", langs), "en");
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
});
