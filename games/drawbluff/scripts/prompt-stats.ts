/**
 * Measures of a prompts file (docs/drawbluff-scale.md "Prompts"), for
 * `scripts/prompts.ts` and the prompt lints (test/prompts.test.ts).
 */

import { ARTICLES, deck, PromptDeck, seeded, SPREAD, type Lang, type Prompt } from "../game/rules.ts";

/** Words that say little about a prompt (articles, prepositions, …). */
export const STOP: Record<Lang, ReadonlySet<string>> = {
  en: new Set("a an the of in on at to for with and or by your you my its it is who that what when does do from his her their over under into out up off one".split(" ")),
  de: new Set(
    (
      "der die das den dem des ein eine einen einem einer eines im in am an auf aus bei mit nach von vom zum zur und oder für über unter vor hinter " +
      "dein deine sein seine ihr ihre mein meine wenn was wie wer ist sich es er sie nicht kein keine beim ins aufs vorm fürs unterm durch dir man " +
      "haben machen werden will kann nur aber als zu um"
    ).split(" "),
  ),
};

/** A prompt's content words. */
export function contentWords(p: Prompt, lang: Lang): string[] {
  return p.text.split(" ").filter((w) => w && !STOP[lang].has(w));
}

/** Pairs of prompts with two content words or more in common, at least half of the shorter one's. */
export function nearDuplicates(prompts: readonly Prompt[], lang: Lang): [string, string][] {
  const sets = prompts.map((p) => new Set(contentWords(p, lang)));
  const out: [string, string][] = [];
  for (let i = 0; i < prompts.length; i++) {
    for (let j = i + 1; j < prompts.length; j++) {
      const a = sets[i]!;
      const b = sets[j]!;
      const both = [...a].filter((w) => b.has(w)).length;
      if (both >= 2 && both * 2 >= Math.min(a.size, b.size)) out.push([prompts[i]!.text, prompts[j]!.text]);
    }
  }
  return out;
}

/** How a set of titles looks (the prompts, or their decoys): what a player could tell them by. */
export interface Forms {
  /** The share starting with an article ("a …", "the …", "ein …", "der …"). */
  article: number;
  /** The share of at most three words. */
  short: number;
  /** Words on average. */
  words: number;
  /** The most common first word and its share. */
  opening: [string, number];
}

/** Whether a title starts with an article (the ones {@link titleKey} drops). */
export function hasArticle(text: string, lang: Lang): boolean {
  return ARTICLES[lang].test(text);
}

/** {@link Forms} of `texts`. */
export function forms(texts: readonly string[], lang: Lang): Forms {
  const n = texts.length || 1;
  const words = texts.map((t) => t.split(" ").length);
  const first = new Map<string, number>();
  for (const t of texts) first.set(t.split(" ")[0]!, (first.get(t.split(" ")[0]!) ?? 0) + 1);
  const [w, c] = [...first].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  return {
    article: texts.filter((t) => hasArticle(t, lang)).length / n,
    short: words.filter((x) => x <= 3).length / n,
    words: words.reduce((a, b) => a + b, 0) / n,
    opening: [w, c / n],
  };
}

/** Prompts that are the odd one out of their line: no decoy shares whether it starts with an article. */
export function oddForms(prompts: readonly Prompt[], lang: Lang): string[] {
  return prompts.filter((p) => p.decoys?.length && !p.decoys.some((d) => hasArticle(d, lang) === hasArticle(p.text, lang))).map((p) => p.text);
}

/** Prompts per structure, in the file's order. */
export function perStructure(prompts: readonly Prompt[]): Map<string, number> {
  const tags = new Map<string, number>();
  for (const p of prompts) tags.set(p.tag, (tags.get(p.tag) ?? 0) + 1);
  return tags;
}

export interface Session {
  games: number;
  players: number;
  rounds: number;
}

/**
 * Prompts dealt again within one room's session of `games` games, on
 * average over `runs` seeded sessions, and the share of sessions with
 * any, and the share of rounds as mixed as can be (`mixed`: no structure
 * more often than players / structures, rounded up; with up to 17
 * players: every prompt of another structure): with a fresh {@link deck}
 * per game spread over `window` (`fresh`, how Drawbluff dealt before,
 * with a window of 3) or the room's {@link PromptDeck}.
 */
export function repeats(prompts: readonly Prompt[], s: Session, fresh: boolean, runs: number, window = SPREAD): { mean: number; sessions: number; mixed: number } {
  const most = Math.ceil(s.players / perStructure(prompts).size);
  let total = 0;
  let hit = 0;
  let hands = 0;
  let twice = 0;
  for (let seed = 1; seed <= runs; seed++) {
    const rng = seeded(seed);
    const dealt = new Set<string>();
    const room = new PromptDeck(prompts, rng);
    let n = 0;
    for (let g = 0; g < s.games; g++) {
      const d = fresh ? deck(prompts, rng, window) : [];
      for (let r = 0; r < s.rounds; r++) {
        const hand = fresh ? d.splice(-s.players).reverse() : room.deal(s.players);
        hands++;
        if (Math.max(...perStructure(hand).values()) > most) twice++;
        for (const p of hand) {
          if (dealt.has(p.text)) n++;
          dealt.add(p.text);
        }
      }
    }
    total += n;
    if (n > 0) hit++;
  }
  return { mean: total / runs, sessions: hit / runs, mixed: 1 - twice / hands };
}
