/**
 * Checks a word list and prints its numbers (the tests run the same
 * checks on `data/`):
 *
 *   node scripts/words.ts                  # data/words.txt and data/words.de.txt
 *   node scripts/words.ts FILE [en|de]     # another file
 *
 * What a list has to be (docs/krakel-design.md "Words"): categories of
 * at least 20 words (two to pick from for each of ten players); a word
 * in one category only; in a category no word or other name that says
 * another entry as written (`ship` and `pirate ship` cannot both be
 * there: typing one would be right for the other); words of at most
 * three words and 24 characters.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fold, MIN_CATEGORY, parseCategories, says, tokens, type Category, type Lang } from "../game/rules.ts";

export const MAX_WORD = 24;
export const MAX_TITLE = 26;

/** What is wrong with a list, a line each (none: it is fine). */
export function lint(categories: readonly Category[], lang: Lang): string[] {
  const out: string[] = [];
  const titles = new Set<string>();
  const home = new Map<string, string>();
  for (const c of categories) {
    if (titles.has(fold(c.title))) out.push(`${c.title}: the category twice`);
    titles.add(fold(c.title));
    if ([...c.title].length > MAX_TITLE) out.push(`${c.title}: a title of more than ${MAX_TITLE} characters`);
    if (c.words.length < MIN_CATEGORY) out.push(`${c.title}: ${c.words.length} words, fewer than ${MIN_CATEGORY}`);
    for (const w of c.words) {
      const forms = [w.word, ...w.also];
      for (const f of forms) {
        if ([...f].length > MAX_WORD) out.push(`${c.title}: ${f}: more than ${MAX_WORD} characters`);
        const n = tokens(f, lang).length;
        if (n === 0 || n > 3) out.push(`${c.title}: ${f}: ${n} words`);
        if (fold(f).replace(/ /g, "").length < 2) out.push(`${c.title}: ${f}: too short`);
        if (fold(f) !== fold(f.trim()) || /[|#=]/.test(f)) out.push(`${c.title}: ${f}: odd characters`);
      }
      if (new Set(forms.map((f) => fold(f))).size !== forms.length) out.push(`${c.title}: ${w.word}: a name twice`);
      const k = fold(w.word);
      const was = home.get(k);
      if (was !== undefined) out.push(`${w.word}: in ${was} and in ${c.title}`);
      home.set(k, c.title);
    }
    for (const a of c.words) {
      for (const b of c.words) {
        if (a === b) continue;
        for (const f of [a.word, ...a.also]) if (says(f, b, lang)) out.push(`${c.title}: "${f}" (${a.word}) says ${b.word}`);
      }
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, tag] = process.argv.slice(2);
  const lists: [string, Lang][] = file ? [[file, tag === "de" ? "de" : "en"]] : [
    [fileURLToPath(new URL("../data/words.txt", import.meta.url)), "en"],
    [fileURLToPath(new URL("../data/words.de.txt", import.meta.url)), "de"],
  ];
  let failed = false;
  for (const [path, lang] of lists) {
    const cats = parseCategories(readFileSync(path, "utf8"));
    const words = cats.reduce((n, c) => n + c.words.length, 0);
    console.log(`${path} (${lang}): ${cats.length} categories, ${words} words`);
    for (const c of cats) console.log(`  ${String(c.words.length).padStart(3)}  ${c.title}`);
    const problems = lint(cats, lang);
    for (const p of problems) console.log(`  ! ${p}`);
    if (problems.length > 0) failed = true;
  }
  if (failed) process.exitCode = 1;
}
