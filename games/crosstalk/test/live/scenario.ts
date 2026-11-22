/**
 * The game the pictures for the games list show (`play.ts --shots`): a
 * fixed board instead of a dealt one, people's names for the bots, the
 * clues of Phil's team chosen (sent for its spymaster before the bot's
 * own) and the lines Phil writes on the pad, so that what is on screen
 * makes sense.
 *
 * Phil's team has the sea and the night: WHALE, ANCHOR, PIRATE for
 * SAILOR; MOON and GHOST for NIGHT. The other team's ROCKET sits next to
 * MOON, the SHARK (the assassin) next to WHALE.
 */

import type { Color } from "../../game/rules.ts";

/** The bots' names, in join order. */
export const NAMES = ["Mia", "Leo", "Sara", "Tom", "Ava", "Ben", "Zoe"];

type Mine = "ours" | "theirs" | "neutral" | "assassin";

/** The board, row by row: the word and whose card it is (from Phil's team's side). */
const BOARD: [string, Mine][] = [
  ["whale", "ours"], ["rocket", "theirs"], ["bridge", "neutral"], ["piano", "ours"], ["jungle", "theirs"],
  ["candle", "neutral"], ["anchor", "ours"], ["crown", "theirs"], ["shark", "assassin"], ["tiger", "neutral"],
  ["moon", "ours"], ["violin", "theirs"], ["garden", "neutral"], ["pirate", "ours"], ["snow", "theirs"],
  ["kettle", "neutral"], ["dragon", "theirs"], ["ghost", "ours"], ["spider", "neutral"], ["mirror", "theirs"],
  ["honey", "ours"], ["map", "neutral"], ["camera", "theirs"], ["train", "neutral"], ["castle", "ours"],
];

/** The board for `crosstalk.game.script`, Phil's team being `team`. */
export function script(team: "red" | "blue"): { word: string; color: Color }[] {
  const other = team === "red" ? "blue" : "red";
  return BOARD.map(([word, mine]) => ({ word, color: mine === "ours" ? team : mine === "theirs" ? other : mine }));
}

/** The clues of Phil's team, round by round. */
export const CLUES = [
  { word: "sailor", number: 3 },
  { word: "night", number: 2 },
  { word: "music", number: 1 },
  { word: "sweet", number: 1 },
];

/** Phil's lines on the pad: typed, then the card tapped (its word typed for him). */
export const PAD = [
  { text: "they whispered “space”, so not", tap: "rocket" },
  { text: "left over for later:", tap: "piano" },
];

/** The card Phil pins in the step of the picture, if still face down (else another of his team's). */
export const PIN = "ghost";

/** The clue the spymaster's picture shows being typed. */
export const SPY_CLUE = { word: "sailor", number: 3 };
