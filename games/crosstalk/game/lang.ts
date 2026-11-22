/**
 * Crosstalk's languages: Jinx's clue matchers (match.ts and match-de.ts,
 * copied from games/jinx as they are), one per language, and their data
 * files. Crosstalk uses the cleaning and the check of a clue that is too
 * close to a word (`tooClose`: a clue against a card of the board). The
 * room's language is a host setting; the host page loads the language's
 * word list and dictionary and hands the game the matcher.
 *
 *   English: match.ts    (design/matching/SPEC.md)    data/words.txt, data/dict.txt
 *   German:  match-de.ts (design/matching/de/SPEC.md) data/words.de.txt, data/dict.de.txt
 *
 * Both matchers have the same API and the same reasons (views.ts `Reason`),
 * so the game, the TV and the phones do not care which one runs.
 */

import * as en from "./match.ts";
import * as de from "./match-de.ts";
import type { Clue, Cleaned, MatchOptions, Reason, RoundResult, SubmitResult, WordEntry } from "./match.ts";

export const LANGS = ["en", "de"] as const;
export type Lang = (typeof LANGS)[number];

/** A language tag (`de-AT`, `en`, …) as one of {@link LANGS}: German for `de…`, else English. */
export function pickLang(tag: unknown): Lang {
  return typeof tag === "string" && /^de\b/i.test(tag) ? "de" : "en";
}

/** Options for checkSubmit: the word list's extras for this word and the giver's other clues. */
export type SubmitOptions = MatchOptions & { banned?: readonly string[]; alsoRight?: readonly string[]; english?: readonly string[]; own?: readonly Clue[] };

/** What a word list adds to a word: clues rejected as too close, accepted forms, English translations. */
export interface WordExtras {
  readonly banned: readonly string[];
  readonly alsoRight: readonly string[];
  readonly english: readonly string[];
}

export interface Matcher {
  readonly lang: Lang;
  /** The data files (under `data/`): the secret words and the dictionary. */
  readonly files: { readonly words: string; readonly dict: string };
  /** Phone input to a clue (or an input error with a message in this language). */
  clean(raw: string): Cleaned;
  /** Do two clues jinx? */
  sameClue(a: Clue, b: Clue, opt?: MatchOptions): Reason | null;
  /** Is a clue too close to the secret word? */
  invalidClue(c: Clue, s: Clue, opt?: MatchOptions, banned?: readonly string[]): Reason | null;
  /** Is a clue too close to a word of the list (with its banned translations, accepted forms and, German, English translations)? */
  tooClose(c: Clue, s: Clue, opt: MatchOptions, entry: WordExtras): Reason | null;
  /** Is the guess right (null: wrong)? */
  judgeGuess(g: Clue, s: Clue, opt?: MatchOptions, alsoRight?: readonly string[]): Reason | null;
  /** A round's clues: struck ones and jinx groups (transitive); `english`: the English translations (German: also their forms). */
  groupClues(clues: readonly Clue[], secret: Clue, opt?: MatchOptions, banned?: readonly string[], english?: readonly string[]): RoundResult;
  /** A clue as a giver submits it; rejections carry a message in this language. */
  checkSubmit(raw: string, secret: Clue, opt?: SubmitOptions): SubmitResult;
  /** The dictionary file's text as match options (typo matching, word forms). */
  dictionary(text: string): MatchOptions;
  /** The word list file's text. */
  parseWordList(text: string): WordEntry[];
}

export const MATCHERS: Record<Lang, Matcher> = {
  en: {
    lang: "en",
    files: { words: "words.txt", dict: "dict.txt" },
    clean: en.clean,
    sameClue: en.sameClue,
    invalidClue: en.invalidClue,
    // As Jinx's checkSubmit: an accepted guess is also too close as a clue.
    tooClose: (c, s, opt, e) => en.invalidClue(c, s, opt, [...e.banned, ...e.alsoRight]),
    judgeGuess: en.judgeGuess,
    groupClues: en.groupClues,
    checkSubmit: en.checkSubmit,
    dictionary: (text) => ({ known: en.dictionary(text) }),
    parseWordList: en.parseWordList,
  },
  de: {
    lang: "de",
    files: { words: "words.de.txt", dict: "dict.de.txt" },
    clean: de.clean,
    sameClue: de.sameClue,
    invalidClue: de.invalidClue,
    tooClose: (c, s, opt, e) => de.invalidClue(c, s, opt, e.banned, e.alsoRight, e.english),
    judgeGuess: de.judgeGuess,
    groupClues: de.groupClues,
    checkSubmit: de.checkSubmit,
    dictionary: de.dictionary,
    parseWordList: en.parseWordList,
  },
};

export function matcher(lang: Lang): Matcher {
  return MATCHERS[lang];
}
