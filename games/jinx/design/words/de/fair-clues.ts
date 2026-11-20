// Fair clues that must pass: for each secret, the obvious clues in fair-clues.tsv run through the
// German matcher's checkSubmit (with the lexicon and the word's banned/also_right lists).
//   node fair-clues.ts   -> fair-rejected.tsv (secret, clue, reason) and a count by reason
import { readFileSync, writeFileSync } from "node:fs";
import { checkSubmit, clean, dictionary, parseWordList } from "../../../game/match-de.ts";

const at = (p: string) => new URL(p, import.meta.url);
const opt = dictionary(readFileSync(at("../../../data/dict.de.txt"), "utf8"));
const byWord = new Map(parseWordList(readFileSync(at("../../../data/words.de.txt"), "utf8")).map((e) => [e.word, e]));
const out = ["secret\tclue\treason"];
const reasons = new Map<string, number>();
let n = 0;
for (const line of readFileSync(at("fair-clues.tsv"), "utf8").split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const [word, clues = ""] = line.split("\t");
  const e = byWord.get(word!);
  if (!e) continue;
  const c = clean(e.word);
  if (!c.ok) continue;
  for (const clue of clues.split(",").map((s) => s.trim()).filter(Boolean)) {
    n++;
    const r = checkSubmit(clue, c.clue, { ...opt, banned: e.banned, alsoRight: e.alsoRight });
    if (r.ok) continue;
    const why = "reason" in r && r.reason ? r.reason : r.code;
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
    out.push(`${e.word}\t${clue}\t${why}`);
  }
}
writeFileSync(at("fair-rejected.tsv"), out.join("\n") + "\n");
console.log(`${n} clues, ${out.length - 1} rejected -> fair-rejected.tsv: ${[...reasons].map(([k, v]) => `${k} ${v}`).join(", ")}`);
