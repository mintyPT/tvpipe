/**
 * Numbers about a prompts file (docs/drawbluff-scale.md "Prompts"): per
 * structure, lengths, the forms of the prompts and their decoys (a
 * leading article, short ones, the commonest opening), distinct words,
 * the most used openings and words, near duplicates, and how often a
 * session of several games in one room deals a prompt again: with a
 * fresh deck per game (as before) and with the room's deck
 * (`PromptDeck`).
 *
 *   node scripts/prompts.ts [--lang de] [--file PATH] [--games 5] [--players 8] [--rounds 2] [--runs 200] [--spread N] [--near]
 *
 * `--spread 3`: the fresh decks spread as before (no structure twice among 3).
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { parsePrompts, pickLang, titleKey } from "../game/rules.ts";
import { contentWords, forms, nearDuplicates, oddForms, perStructure, repeats } from "./prompt-stats.ts";

const { values: args } = parseArgs({
  options: {
    lang: { type: "string", default: "en" },
    file: { type: "string" },
    games: { type: "string", default: "5" },
    players: { type: "string", default: "8" },
    rounds: { type: "string", default: "2" },
    runs: { type: "string", default: "200" },
    spread: { type: "string" },
    near: { type: "boolean", default: false },
  },
});

const lang = pickLang(args.lang);
const file = args.file ?? new URL(`../data/${lang === "en" ? "prompts.txt" : `prompts.${lang}.txt`}`, import.meta.url);
const prompts = parsePrompts(readFileSync(file, "utf8"));

const tags = perStructure(prompts);
console.log(`${prompts.length} prompts in ${tags.size} structures (${lang})`);
for (const [t, n] of tags) console.log(`  ${(t || '""').padEnd(10)} ${n}`);
const lengths = prompts.map((p) => [...p.text].length);
console.log(`length: mean ${(lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(1)}, max ${Math.max(...lengths)}`);
const all = prompts.flatMap((p) => p.text.split(" "));
const longest = Math.max(...all.map((w) => [...w].length));
console.log(`longest word: ${longest} (${[...new Set(all.filter((w) => [...w].length === longest))].join(", ")})`);

const content = prompts.flatMap((p) => contentWords(p, lang));
const freq = new Map<string, number>();
for (const w of content) freq.set(w, (freq.get(w) ?? 0) + 1);
console.log(`words: ${new Set(all).size} distinct of ${all.length}; content words ${freq.size} distinct of ${content.length}`);
const top = [...freq].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
console.log(`most used words: ${top.slice(0, 15).map(([w, n]) => `${w} ${n}`).join(", ")}`);
console.log(`content words used once: ${top.filter(([, n]) => n === 1).length}`);
const open = new Map<string, number>();
for (const p of prompts) {
  const k = p.text.split(" ").slice(0, 2).join(" ");
  open.set(k, (open.get(k) ?? 0) + 1);
}
const opens = [...open].sort((a, b) => b[1] - a[1]);
console.log(`most used openings: ${opens.slice(0, 8).map(([w, n]) => `"${w}" ${n}`).join(", ")}`);

for (const [who, texts] of [["prompts", prompts.map((p) => p.text)], ["decoys", prompts.flatMap((p) => p.decoys ?? [])]] as const) {
  if (!texts.length) continue;
  const f = forms(texts, lang);
  console.log(
    `${who.padEnd(7)}: a leading article ${(100 * f.article).toFixed(0)} %, at most three words ${(100 * f.short).toFixed(0)} %, ` +
      `${f.words.toFixed(1)} words, most common opening "${f.opening[0]}" ${(100 * f.opening[1]).toFixed(0)} %`,
  );
}
const odd = oddForms(prompts, lang);
console.log(`prompts the odd one out of their line (leading article): ${odd.length}${odd.length ? ` (${odd.slice(0, 5).join(", ")})` : ""}`);

const near = nearDuplicates(prompts, lang);
const keys = new Set(prompts.map((p) => titleKey(p.text, lang)));
console.log(`duplicates (titleKey): ${prompts.length - keys.size}; near duplicates: ${near.length}`);
if (args.near) for (const [a, b] of near) console.log(`  ${a} ~ ${b}`);

const s = { games: Number(args.games), players: Number(args.players), rounds: Number(args.rounds) };
const runs = Number(args.runs);
for (const fresh of [true, false]) {
  const r = repeats(prompts, s, fresh, runs, args.spread ? Number(args.spread) : undefined);
  const n = s.games * s.players * s.rounds;
  console.log(
    `${fresh ? "a fresh deck per game" : "the room's deck     "}: ${s.games} games × ${s.players} players × ${s.rounds} rounds = ${n} prompts; ` +
      `repeats ${r.mean.toFixed(1)} on average (${((100 * r.mean) / n).toFixed(1)} %), sessions with a repeat ${(100 * r.sessions).toFixed(0)} %, ` +
      `rounds as mixed as can be ${(100 * r.mixed).toFixed(0)} %`,
  );
}
