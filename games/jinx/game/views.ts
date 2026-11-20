/**
 * The contract between the host page (game.ts, the only authority), the TV
 * page (screen/) and the phone page (phone/): every view the host sets and
 * every action a phone sends. Types only. The pages are checked JavaScript
 * and import these with JSDoc: `@typedef {import("../game/views.ts").ScreenView} ScreenView`.
 *
 * The design: docs/jinx-design.md. Times (`deadline`, `until`) are on the
 * host's clock (`party.now()`; phones and TVs have `client.now()`).
 *
 * Secrecy (the design's rule): the secret word is in `party.screen` only from
 * the `verdict` phase on, and in a `player.state` only for clue-givers.
 * Clue words are on the TV only once turned (reveal) or from the verdict on.
 * Nothing on the TV or a phone tells who jinxed with whom before `jinx`.
 *
 * Language: `lang` in the screen view and the room view is the room's
 * language (`en`, `de`; the host page's setting, changed only between
 * games). The TV, the phones and the host page say everything in it (a
 * phone may pick its own); the words and the clues are in it.
 */

import type { Lang } from "./lang.ts";

export type { Lang };

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * A face: one of the ready-made faces (`preset`, 0–7), or a doodle drawn on
 * the phone: strokes on a 1000×1000 grid, each `[x0, y0, x1, y1, …]`, one ink
 * colour (the chip's centre is a circle inscribed in that grid). At most 40
 * strokes, 2000 points in all.
 */
export type Face = { preset: number } | { strokes: number[][] };

export interface Person {
  id: string;
  name: string;
  /** The chip's colour, 0–7 (the TV's and the phone's palette); unique in the room while there are 8 or fewer. */
  color: number;
  face: Face;
  vip: boolean;
  connected: boolean;
  /** Points this game (0 in the lobby). */
  score: number;
  /** A bot (the host page's), drawn with a dashed rim. */
  bot?: boolean;
  /**
   * Left the room during this game: kept (with `connected: false`) until the
   * next game, so cards, words, the replay and the end can still draw the chip.
   */
  left?: boolean;
}

/**
 * Everyone in the room, in join order (players waiting to join late
 * included), then those who left during this game (`left: true`).
 */
export type People = Person[];

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export type Reason =
  | "same word"
  | "same number"
  | "spelling"
  | "plural"
  | "verb form"
  | "word form"
  | "same family"
  | "typo"
  | "sounds the same"
  | "contains the word"
  | "part of the word"
  | "too close";

/** A clue card. `id` is stable for the round ("c0", "c1", …). */
export interface Card {
  id: string;
  /** The author's person id. */
  author: string;
  bold: boolean;
  /** The clue as typed (cleaned of invisible characters), only once the TV may show it. */
  word?: string;
  /** `alive` (survived the jinx check) or `jinxed`; absent before the jinx check. */
  fate?: "alive" | "jinxed";
  /** Turn order, 1, 2, … once turned in the reveal. */
  turned?: number;
}

/** One jinx group: its cards and every matching pair with its reason (the TV slams pair by pair). */
export interface JinxGroup {
  cards: string[];
  pairs: { a: string; b: string; reason: Reason }[];
}

// ---------------------------------------------------------------------------
// The room's count
// ---------------------------------------------------------------------------

export interface Tally {
  /** Words found so far. */
  found: number;
  /** Rounds played so far. */
  played: number;
  /** Rounds in this game (grows when someone joins late). */
  total: number;
  /** Per round so far: found or missed. */
  history: ("found" | "missed")[];
}

export interface ScoreLine {
  id: string;
  score: number;
  /** This round's change. */
  delta: number;
  /** 1-based, ties share a rank. */
  rank: number;
}

/**
 * Points paid at the verdict, with why (for the TV's chips and the phones):
 * one entry per person and `why`, summed (two turned cards: one `turned`
 * entry of +4). A person may have several entries (3 players: a bold card
 * turned and the other jinxed): renderers sum by `id`.
 */
export interface Payout {
  id: string;
  delta: number;
  /** `pot` (the guesser, right), `wrong` (the guesser, −2), `turned` (+2), `bold` (+4), `bold-jinxed` (−2), `mvp` (+3). */
  why: "pot" | "wrong" | "turned" | "bold" | "bold-jinxed" | "mvp";
}

// ---------------------------------------------------------------------------
// The TV: party.screen
// ---------------------------------------------------------------------------

interface Base {
  /** The room's language. */
  lang: Lang;
  people: People;
}

interface InRound extends Base {
  round: number;
  rounds: number;
  /** The guesser's person id. */
  guesser: string;
  tally: Tally;
  /** The pot (chips), from the jinx check on. */
  pot?: number;
}

export interface LobbyScreen extends Base {
  phase: "lobby";
  minPlayers: number;
  maxPlayers: number;
}

/** The round intro (~4 s): "ANNA IS IN THE HOT SEAT". */
export interface HotseatScreen extends InRound {
  phase: "hotseat";
  until: number;
}

/** Clue-givers write. The TV shows only who is done (`done`: person ids). */
export interface WriteScreen extends InRound {
  phase: "write";
  givers: string[];
  /** Clues each giver writes (2 with 3 players, else 1). */
  each: 1 | 2;
  /** Givers who sent all their clues. */
  done: string[];
  /** Cards sent so far (a count: nothing else about them). */
  sent: number;
  /** Cards sent so far per giver id (the TV throws each from its author's chip; no words). */
  sentBy: Record<string, number>;
  /** When writing began (host time): with `deadline`, the dial's full length. */
  started: number;
  deadline: number;
}

/**
 * The jinx check: all cards face down (no `word`), `fate` set, the groups
 * to slam in order. `pot` is after the jinx losses, `potBefore` before
 * (10). The host waits until `until` (time for the animation:
 * 4 s + 4.5 s per group, a group of 3+ cards counting 1.5; faster groups after the first are the TV's business).
 */
export interface JinxScreen extends InRound {
  phase: "jinx";
  cards: Card[];
  groups: JinxGroup[];
  potBefore: number;
  pot: number;
  until: number;
}

/**
 * The reveal: the surviving cards (turned ones with `word` and `turned`).
 * `picked` is the card the guesser just picked (the TV's "ANNA TRUSTS… BEN"),
 * set with the turn. `draft` is the guess being typed, live (may be "");
 * `typing` once the guesser started typing this decision.
 */
export interface RevealScreen extends InRound {
  phase: "reveal";
  cards: Card[];
  jinxed: number;
  pot: number;
  picked?: string;
  draft: string;
  typing: boolean;
  /** When the current decision began (host time): with `deadline`, the dial's length. */
  started: number;
  deadline: number;
}

/**
 * The verdict. `result`: `right`, `wrong`, `pass`, or `lost` (every card
 * jinxed: no guess). `guess` as typed (absent for pass/lost); `near`: the
 * reason a near miss was accepted ("typo", "plural", …; absent for an exact
 * match). `payouts` for the round so far (the MVP clue comes later).
 */
export interface VerdictScreen extends InRound {
  phase: "verdict";
  word: string;
  result: "right" | "wrong" | "pass" | "lost";
  guess?: string;
  near?: Reason;
  cards: Card[];
  payouts: Payout[];
  until: number;
}

/**
 * The replay: every card of the round face up (`word` set), with `fate`
 * and `turned`; `groups` as in the jinx check. `mvp`: the card the guesser
 * picked (absent while picking, or none). `picking` while the guesser may
 * still pick (only after a right guess).
 */
export interface ReplayScreen extends InRound {
  phase: "replay";
  word: string;
  result: "right" | "wrong" | "pass" | "lost";
  cards: Card[];
  groups: JinxGroup[];
  picking: boolean;
  /** The verdict's payouts, plus the MVP payout once picked. */
  payouts: Payout[];
  mvp?: string;
  deadline?: number;
}

export interface ScoresScreen extends InRound {
  phase: "scores";
  lines: ScoreLine[];
  /** The next guesser, absent after the last round. */
  next?: string;
  until: number;
}

export type RoomTitle = "telepaths" | "mind readers" | "in sync" | "mixed signals" | "total jinx";

export interface Award {
  kind: "mind meld" | "lone wolf" | "kamikaze";
  /** Mind meld: two ids; the others: one. */
  ids: string[];
  count: number;
}

/** The word web: the words of the game and their clues (cleaned key → shown text). */
export interface Web {
  words: { word: string; found: boolean; clues: string[] }[];
  /** Clues used for more than one word: the clue as shown, and indices into `words`. */
  links: { clue: string; words: number[] }[];
}

/**
 * The end of the game, in steps the TV plays in order: `room` (the count,
 * the title, the words), `mvp`, `awards`, `web`. The host sets `step` and
 * holds each one; `web` stays until the VIP plays again.
 */
export interface EndScreen extends Base {
  phase: "end";
  step: "room" | "mvp" | "awards" | "web";
  tally: Tally;
  title: RoomTitle;
  words: { word: string; found: boolean; guesser: string }[];
  /** Absent when nobody scored. */
  mvp?: { id: string; score: number; mvpClues: number; jinxed: number };
  awards: Award[];
  web: Web;
  lines: ScoreLine[];
}

export type ScreenView =
  | LobbyScreen
  | HotseatScreen
  | WriteScreen
  | JinxScreen
  | RevealScreen
  | VerdictScreen
  | ReplayScreen
  | ScoresScreen
  | EndScreen;

// ---------------------------------------------------------------------------
// Phones: party.room (everyone) and player.state (one phone)
// ---------------------------------------------------------------------------

/** Every phone: the phase and the people (for faces and names). */
export interface RoomView {
  phase: ScreenView["phase"];
  /** The room's language. */
  lang: Lang;
  people: People;
  round?: number;
  rounds?: number;
  guesser?: string;
  minPlayers: number;
  maxPlayers: number;
}

/**
 * One phone's task:
 * - `lobby`: draw a face (or keep the preset); the VIP starts (`canStart`).
 * - `wait`: joined during a game, plays from the next round.
 * - `hotseat`: the round intro (`guesser`: am I the guesser).
 * - `write`: a clue-giver: the word, the clues sent so far (`sent`, one or two
 *   slots), `deadline`.
 * - `blind`: the guesser while clues are written (`done`/`givers` counts).
 * - `tv`: nothing to do, watch the TV (the jinx check's slams and the
 *   verdict's envelope come first on the TV; `fate`, `check` and `result`
 *   follow when the TV has shown them).
 * - `fate`: after the jinx check, a giver's cards: survived or jinxed with
 *   whom (names) and why.
 * - `check`: the guesser during the jinx check: how many cards survived and
 *   how many were jinxed (counts only).
 * - Clue-givers keep `result` through the replay (the phone shows "Anna is
 *   picking the MVP clue…" from `room.phase`).
 * - `guess`: the guesser in the reveal: the cards (face down unless turned),
 *   the pot, `deadline`.
 * - `watch`: a clue-giver in the reveal: the word, the cards, "Shh".
 * - `result`: the verdict for this phone: the word, the result, own points.
 * - `mvp`: the guesser picks the MVP clue among `cards` (turned or not, not jinxed).
 * - `scores`: own rank and total, `next` (am I up next).
 * - `final`: the end: the room, own line, own award; the VIP: `canRestart`.
 */
export type PlayerState =
  | { task: "lobby"; face: Face; color: number; canStart: boolean }
  | { task: "wait" }
  | { task: "hotseat"; guesser: boolean }
  | {
      task: "write";
      word: string;
      each: 1 | 2;
      /** Accepted clues so far, by slot. */
      sent: ({ text: string; bold: boolean } | null)[];
      deadline: number;
    }
  | { task: "blind"; givers: number; done: number; deadline: number }
  | { task: "fate"; word: string; cards: { text: string; bold: boolean; fate: "alive" | "jinxed"; with: string[]; reason?: Reason }[] }
  | { task: "check"; survived: number; jinxed: number }
  | { task: "tv" }
  | { task: "guess"; cards: Card[]; pot: number; deadline: number; jinxed: number }
  | { task: "watch"; word: string; cards: Card[]; pot: number }
  | { task: "result"; word: string; result: "right" | "wrong" | "pass" | "lost"; guesser: boolean; delta: number; why: Payout["why"][] }
  | { task: "mvp"; cards: Card[]; deadline: number }
  | { task: "scores"; score: number; rank: number; of: number; next: boolean }
  | { task: "final"; score: number; rank: number; of: number; award?: Award["kind"]; canRestart: boolean; found: number; total: number; title: RoomTitle };

// ---------------------------------------------------------------------------
// Actions (phone → host), `client.act(type, data)`; refusals are PartyErrors.
// Phones show them by code in their language (the messages are English,
// except a refused clue's, which is the matcher's wording in the room's
// language).
// ---------------------------------------------------------------------------

export interface Actions {
  /** Lobby (and while waiting): set your face. */
  face: Face;
  /** VIP, lobby: start with the players there. */
  start: null;
  /** VIP, end: play again (same players, a new game). */
  again: null;
  /** VIP, lobby: remove a player. */
  kick: { id: string };
  /**
   * A clue-giver, write phase: send (or replace) the clue in `slot` (0, or 1
   * with 3 players). Refused with code `too-close:REASON`, `own-clue:REASON`
   * (`REASON` a {@link Reason}: "too-close:plural"), `empty`, `too-long`,
   * `too-many-words`, `not-english` (or the matcher's other input codes;
   * the message says why, in the room's language) or `late`.
   */
  clue: { text: string; bold: boolean; slot: number };
  /** The guesser, reveal: turn this card. */
  pick: { card: string };
  /** The guesser, reveal: the one guess (after at least one turned card). */
  guess: { text: string };
  /** The guesser, reveal: no guess. */
  pass: null;
  /** The guesser, replay after a right guess: the MVP clue. */
  mvp: { card: string };
}

/**
 * Continuous input (`client.input(data)`, latest wins, never acked): the
 * guesser's draft while typing, `{ draft: string }` (at most 24 characters).
 */
export interface DraftInput {
  draft: string;
}
