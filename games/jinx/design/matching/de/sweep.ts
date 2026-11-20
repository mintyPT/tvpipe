// A sweep over common German words (node sweep.ts [N]): which pairs of
// different common words the matcher jinxes, by reason, with samples to read.
// Needs ../../words/raw/de/de_full.txt (./fetch.sh) and ../../../data/dict.de.txt.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { clean, dictionary, forms, foldWord, sameClue } from "../../../game/match-de.ts";

const here = dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] ?? 8000);
const opt = dictionary(readFileSync(join(here, "..", "..", "..", "data", "dict.de.txt"), "utf8"));
const lex = opt.lexicon!;
const words: string[] = [];
for (const line of readFileSync(join(here, "..", "..", "words", "raw", "de", "de_full.txt"), "utf8").split("\n")) {
  const w = foldWord(line.split(" ")[0] ?? "");
  if (w.length < 3 || !/^[a-zäöüß]+$/.test(w) || !lex.forms.has(w)) continue;
  // lemmas of nouns, verbs and adjectives only: the words players write as clues
  if (!(lex.pos.get(w) ?? []).some((p) => p === "n" || p === "v" || p === "a" || p === "n*")) continue;
  words.push(w);
  if (words.length >= N) break;
}
const index = new Map<string, string[]>();
for (const w of words) {
  const f = forms(w, opt);
  for (const x of new Set([...f.infl.keys(), ...f.fam])) {
    const a = index.get(x) ?? [];
    a.push(w);
    index.set(x, a);
  }
}
const seen = new Set<string>();
const byReason = new Map<string, string[]>();
for (const list of index.values()) {
  if (list.length > 60) continue;
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      const id = a < b ? a + " " + b : b + " " + a;
      if (seen.has(id)) continue;
      seen.add(id);
      const ca = clean(a);
      const cb = clean(b);
      if (!ca.ok || !cb.ok) continue;
      const r = sameClue(ca.clue, cb.clue, opt);
      if (r) byReason.set(r, [...(byReason.get(r) ?? []), `${a}/${b}`]);
    }
}
const out: string[] = [`# Sweep: ${words.length} common lemmas (subtitle frequency), pairs that jinx`, ""];
for (const [r, pairs] of byReason) {
  out.push(`## ${r}: ${pairs.length}`, "", pairs.join(", "), "");
}
writeFileSync(join(here, "sweep-report.md"), out.join("\n"));
for (const [r, pairs] of byReason) console.log(r, pairs.length);
