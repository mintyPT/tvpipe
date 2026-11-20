// Pairs of secret words that game/rules.ts related() keeps apart (one is an invalid clue for the other),
// with the German matcher and lexicon. Node >= 23, no packages.
//   node related.ts   -> related-pairs.tsv (word_a, word_b, reason a-as-clue-for-b, reason b-as-clue-for-a)
import { readFileSync, writeFileSync } from "node:fs";
import { matcher } from "../../../game/lang.ts";
import { related, wordClue } from "../../../game/rules.ts";

const at = (p: string) => new URL(p, import.meta.url);
const m = matcher("de");
const opt = m.dictionary(readFileSync(at("../../../data/dict.de.txt"), "utf8"));
const words = m.parseWordList(readFileSync(at("../../../data/words.de.txt"), "utf8"));
const clues = words.map((w) => wordClue(w.word, m)!);
const rows = ["a\tb\ta_as_clue_for_b\tb_as_clue_for_a"];
for (let i = 0; i < words.length; i++)
  for (let j = i + 1; j < words.length; j++) {
    const a = words[i]!, b = words[j]!;
    if (!related(a, b, opt, m)) continue;
    const ab = m.invalidClue(clues[i]!, clues[j]!, opt, b.banned) ?? "";
    const ba = m.invalidClue(clues[j]!, clues[i]!, opt, a.banned) ?? "";
    rows.push(`${a.word}\t${b.word}\t${ab}\t${ba}`);
  }
writeFileSync(at("related-pairs.tsv"), rows.join("\n") + "\n");
console.log(`${words.length} words, ${rows.length - 1} related pairs -> related-pairs.tsv`);
