import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { LANGS, parseQuestions, type Lang } from "../game/rules.ts";

const file = (l: Lang) => new URL(`../data/questions${l === "en" ? "" : `.${l}`}.txt`, import.meta.url);

for (const lang of LANGS) {
  test(`the ${lang} question list: every line parses, enough of each kind and level`, { skip: !existsSync(file(lang)) && `no data/questions.${lang}.txt yet` }, () => {
    const errors: string[] = [];
    const qs = parseQuestions(readFileSync(file(lang), "utf8"), errors);
    assert.deepEqual(errors, []);
    for (const kind of ["vote", "answer"] as const) {
      for (const level of ["family", "party"] as const) {
        const n = qs.filter((q) => q.kind === kind && q.level === level).length;
        assert.ok(n >= 40, `${kind} ${level}: ${n}`);
      }
    }
    for (const q of qs) {
      assert.match(q.text, /\?$/, q.text);
      assert.equal(q.text, q.text.normalize("NFC"));
    }
  });
}
