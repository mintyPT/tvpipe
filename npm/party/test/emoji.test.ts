import assert from "node:assert/strict";
import test from "node:test";

import { blockEmoji, hasEmoji, stripEmoji } from "../src/emoji.ts";
import { cleanText } from "../src/names.ts";

// [input, without emoji]
const CASES: [string, string][] = [
  ["Ann", "Ann"],
  ["Ann \u{1F355}", "Ann "], // pizza
  ["\u{1F600}\u{1F600}", ""],
  ["\u{1F44D}\u{1F3FD}ok", "ok"], // thumbs up, skin tone
  ["a\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}b", "ab"], // family (ZWJ)
  ["\u2764\uFE0F\u200D\u{1F525}x", "x"], // heart on fire
  ["\u{1F3F3}\uFE0F\u200D\u26A7\uFE0F!", "!"], // transgender flag
  ["\u{1F1E6}\u{1F1F9}AT", "AT"], // flag of Austria
  ["\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}gb", "gb"], // flag of Scotland (tags)
  ["1\uFE0F\u20E3 and #\u20E3", " and "], // keycaps
  ["\u2764\uFE0F love", " love"], // red heart (text symbol asked to be emoji)
  ["\u2615 tea \u26BD", " tea "], // emoji by default below U+1F000
  ["\u{1F54A} dove", " dove"], // text by default, but an emoji on phones
  ["\u00A9 \u00AE \u2122 \u2665 \u2192 \u263A", "\u00A9 \u00AE \u2122 \u2665 \u2192 \u263A"], // text symbols stay
  ["12 #3 *", "12 #3 *"],
  ["\u24B6 \u{1F150} \u{1F130}", "\u24B6 \u{1F150} \u{1F130}"], // circled and squared letters stay
  ["\u{1F170}\uFE0F \u{1F18E}", " "], // blood types A and AB are emoji
  ["Stra\u00DFe caf\u00E9 \u5C0F\u660E \u0639\u0644\u064A", "Stra\u00DFe caf\u00E9 \u5C0F\u660E \u0639\u0644\u064A"],
  ["\u0915\u094D\u200D\u0937", "\u0915\u094D\u200D\u0937"], // ZWJ in Devanagari stays
  ["x\uFE0F", "x"], // a stray selector
];

test("stripEmoji: known answers", () => {
  for (const [input, want] of CASES) {
    assert.equal(stripEmoji(input), want, JSON.stringify(input));
    assert.equal(hasEmoji(input), input !== want, JSON.stringify(input));
    assert.equal(hasEmoji(input), hasEmoji(input), "no state between calls");
  }
});

test("cleanText drops emoji: a name of only emoji is empty", () => {
  assert.equal(cleanText("\u{1F355} Ann \u{1F355}", 16), "Ann");
  assert.equal(cleanText("Ann \u{1F355} Bo", 16), "Ann Bo");
  assert.equal(cleanText("\u{1F600}\u{1F44D}\u{1F3FD}", 16), "");
});

test("blockEmoji: text fields lose emoji as typed, the caret stays", () => {
  type Listener = (e: { target: unknown; isComposing?: boolean }) => void;
  const listeners = new Map<string, Listener>();
  const root = {
    addEventListener: (type: string, l: Listener) => listeners.set(type, l),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const field = (tagName: string, type: string, value: string, caret: number) => {
    const f = {
      tagName,
      type,
      value,
      selectionStart: caret,
      setSelectionRange(start: number) {
        f.selectionStart = start;
      },
    };
    return f;
  };
  const stop = blockEmoji(root);
  const input = listeners.get("input")!;

  const a = field("INPUT", "text", "ab\u{1F355}cd", 4);
  input({ target: a });
  assert.equal(a.value, "abcd");
  assert.equal(a.selectionStart, 2);

  const t = field("TEXTAREA", "textarea", "x\u{1F44D}\u{1F3FD}", 5);
  input({ target: t });
  assert.equal(t.value, "x");
  assert.equal(t.selectionStart, 1);

  // Not while composing: once the composition ends.
  const c = field("INPUT", "text", "a\u{1F600}", 3);
  input({ target: c, isComposing: true });
  assert.equal(c.value, "a\u{1F600}");
  listeners.get("compositionend")!({ target: c });
  assert.equal(c.value, "a");

  const r = field("INPUT", "range", "5", 1);
  input({ target: r });
  assert.equal(r.value, "5");

  stop();
  assert.equal(listeners.size, 0);
});
