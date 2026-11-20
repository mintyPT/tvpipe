// Short German secrets against the German matcher (Node >= 23, no packages):
//
//   node short-secrets.ts          containment sweep: for every secret of at most 5 letters, the lexicon
//                                  words (data/dict.de.txt) the matcher rejects as "contains the word" or
//                                  "part of the word" -> ../raw/de/short-secrets.tsv (ordered by subtitle
//                                  frequency when ../raw/de/de_50k.txt is there; review only, not committed)
//   node short-secrets.ts --plausible   natural clues (plausible-clues.tsv) through checkSubmit with the
//                                  lexicon -> plausible-rejected.tsv
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { checkSubmit, clean, dictionary, foldWord, invalidClue, parseWordList } from "../../../game/match-de.ts";

const at = (p: string) => new URL(p, import.meta.url);
const opt = dictionary(readFileSync(at("../../../data/dict.de.txt"), "utf8"));
const entries = parseWordList(readFileSync(at("../../../data/words.de.txt"), "utf8"));
const byWord = new Map(entries.map((e) => [e.word, e]));

if (process.argv.includes("--plausible")) {
  const out = ["secret\tclue\treason"];
  let n = 0;
  for (const line of readFileSync(at("plausible-clues.tsv"), "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [word, clues = ""] = line.split("\t");
    const e = byWord.get(word!);
    if (!e) throw new Error(`plausible-clues.tsv: ${word} is not a secret`);
    const secret = (clean(e.word) as { ok: true; clue: any }).clue;
    for (const c of clues.split(",").map((s) => s.trim()).filter(Boolean)) {
      n++;
      const r = checkSubmit(c, secret, { ...opt, banned: e.banned, alsoRight: e.alsoRight });
      if (!r.ok) out.push(`${e.word}\t${c}\t${"reason" in r ? r.reason : r.code}`);
    }
  }
  writeFileSync(at("plausible-rejected.tsv"), out.join("\n") + "\n");
  console.log(`${n} plausible clues, ${out.length - 1} rejected -> plausible-rejected.tsv`);
} else {
  const rank = new Map<string, number>();
  const freq = at("../raw/de/de_50k.txt");
  if (existsSync(freq)) readFileSync(freq, "utf8").split("\n").forEach((l, i) => rank.set(l.split(" ")[0]!, i + 1));
  const lemmas = readFileSync(at("../../../data/dict.de.txt"), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("\t")[0]!);
  const rows = ["secret\thits\tcommon_hits (subtitle top 50k, most frequent first)"];
  let total = 0;
  for (const e of entries) {
    const key = foldWord(e.word).replace(/[^\p{L}\p{N}]/gu, "");
    if ([...key].length > 5) continue;
    const secret = (clean(e.word) as { ok: true; clue: any }).clue;
    const hits: string[] = [];
    for (const l of lemmas) {
      if (l === key || !l.includes(key)) continue;
      const c = clean(l);
      if (!c.ok) continue;
      const r = invalidClue(c.clue, secret, opt, []);
      if (r === "contains the word" || r === "part of the word") hits.push(l);
    }
    total++;
    const common = hits.filter((h) => rank.has(h)).sort((a, b) => rank.get(a)! - rank.get(b)!);
    rows.push(`${e.word}\t${hits.length}\t${common.slice(0, 40).join(" ")}`);
  }
  writeFileSync(at("../raw/de/short-secrets.tsv"), rows.join("\n") + "\n");
  console.log(`${total} secrets of at most 5 letters -> ../raw/de/short-secrets.tsv`);
}
