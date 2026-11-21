// @ts-check
/**
 * What the TV says, per language (the room's: `screen.lang`). Names,
 * words and player texts are passed in and always rendered as text.
 */

import { format } from "../phone/i18n.js";

/** @param {import("../phone/i18n.js").Format} f */
const en = (f) => ({
  tagline: "draw · guess · draw on top",
  scanToJoin: "Scan to join",
  players: "Players",
  waitingSeat: "waiting…",
  freeSeat: "free seat",
  needed: (/** @type {number} */ n) => `${f.n(n)} more to start`,
  vipStarts: (/** @type {string | undefined} */ name) => (name ? `${name} starts the game` : "The VIP starts the game"),
  how: [
    ["Draw", "a word you pick"],
    ["Guess", "what the picture you get is now"],
    ["Draw on top", "and turn it into your word"],
  ],
  howLine: "One picture each goes round the table. Nothing is ever erased.",
  layers: (/** @type {number} */ n) => f.p(n, { one: "# layer", other: "# layers" }),
  undoOn: "undo",
  undoOff: "no undo",
  rounds: (/** @type {number} */ n) => f.p(n, { one: "# round", other: "# rounds" }),
  round: (/** @type {number} */ r, /** @type {number} */ of) => `Round ${f.n(r)} of ${f.n(of)}`,
  // Play
  draw: "Draw!",
  guess: "Guess!",
  onTop: "Draw on top!",
  lastGuess: "Last guess!",
  stepOf: (/** @type {number} */ k, /** @type {number} */ n) => `step ${f.n(k)} of ${f.n(n)}`,
  firstStep: "pick a word and draw it",
  turnGuess: "what is it now?",
  turnDraw: "make it your word",
  lastStep: "what did it end up as?",
  waitingFor: (/** @type {string[]} */ names) => `waiting for ${f.list(names)}`,
  // Reveal
  pictureOf: (/** @type {string} */ name) => `${name}'s picture`,
  pictureCount: (/** @type {number} */ i, /** @type {number} */ n) => `Picture ${f.n(i)}/${f.n(n)}`,
  drewIt: (/** @type {string} */ name) => `drawn by ${name}`,
  read: (/** @type {string} */ name) => `${name} read`,
  noGuess: "(no guess)",
  hiddenGuess: "(hidden)",
  blank: "(nothing drawn)",
  each: (/** @type {number} */ n) => `+${f.n(n)} each`,
  // Best move
  bestTitle: "Best move",
  bestHelp: "Which layer made the cleverest use of what was there? Vote on your phone.",
  voted: (/** @type {number} */ n, /** @type {number} */ of) => `${f.n(n)} of ${f.n(of)} voted`,
  bestBy: (/** @type {string} */ name) => `by ${name}`,
  votes: (/** @type {number} */ n) => f.p(n, { one: "# vote", other: "# votes" }),
  shared: "a tie: they share it",
  sharedMore: (/** @type {number} */ n) => `a tie: they share it with ${f.n(n)} more`,
  noVotes: "No layer got two votes this round",
  // Scores
  scoresAfter: (/** @type {number} */ r, /** @type {number} */ of) => (r >= of ? "Final round" : `After round ${f.n(r)} of ${f.n(of)}`),
  scoresTitle: "Scores",
  kinds: { drawn: "drawn", read: "read", best: "best move" },
  gameOver: "Game over",
  playAgain: "The VIP can start another game",
  // Reactions (the phones' buttons)
  reactions: ["haha!", "what?!", "nooo", "genius"],
  reconnecting: "Reconnecting…",
  over: "The game has ended",
});

/** @typedef {ReturnType<typeof en>} Strings */

/** @type {(f: import("../phone/i18n.js").Format) => Strings} */
const de = (f) => ({
  tagline: "zeichnen · raten · drüberzeichnen",
  scanToJoin: "Zum Mitspielen scannen",
  players: "Spieler",
  waitingSeat: "fehlt noch…",
  freeSeat: "frei",
  needed: (n) => `noch ${f.n(n)} bis zum Start`,
  vipStarts: (name) => (name ? `${name} startet das Spiel` : "Der VIP startet das Spiel"),
  how: [
    ["Zeichnen", "ein Wort deiner Wahl"],
    ["Raten", "was das Bild jetzt ist"],
    ["Drüber", "zeichnen, bis es dein Wort ist"],
  ],
  howLine: "Jedes Bild geht reihum. Nichts wird je radiert.",
  layers: (n) => f.p(n, { one: "# Schicht", other: "# Schichten" }),
  undoOn: "Rückgängig",
  undoOff: "kein Rückgängig",
  rounds: (n) => f.p(n, { one: "# Runde", other: "# Runden" }),
  round: (r, of) => `Runde ${f.n(r)} von ${f.n(of)}`,
  draw: "Zeichnen!",
  guess: "Raten!",
  onTop: "Drüberzeichnen!",
  lastGuess: "Letzter Tipp!",
  stepOf: (k, n) => `Schritt ${f.n(k)} von ${f.n(n)}`,
  firstStep: "Wort wählen und zeichnen",
  turnGuess: "was ist es jetzt?",
  turnDraw: "mach dein Wort daraus",
  lastStep: "was ist daraus geworden?",
  waitingFor: (names) => `warten auf ${f.list(names)}`,
  pictureOf: (name) => `Bild von ${name}`,
  pictureCount: (i, n) => `Bild ${f.n(i)}/${f.n(n)}`,
  drewIt: (name) => `gezeichnet von ${name}`,
  read: (name) => `${name} las`,
  noGuess: "(kein Tipp)",
  hiddenGuess: "(ausgeblendet)",
  blank: "(nichts gezeichnet)",
  each: (n) => `je +${f.n(n)}`,
  bestTitle: "Bester Zug",
  bestHelp: "Welche Schicht hat am cleversten genutzt, was schon da war? Wählt am Handy.",
  voted: (n, of) => `${f.n(n)} von ${f.n(of)} ${of === 1 ? "hat" : "haben"} gewählt`,
  bestBy: (name) => `von ${name}`,
  votes: (n) => f.p(n, { one: "# Stimme", other: "# Stimmen" }),
  shared: "Gleichstand: geteilt",
  sharedMore: (n) => `Gleichstand: geteilt, mit ${f.n(n)} weiteren`,
  noVotes: "Keine Schicht hat diesmal zwei Stimmen bekommen",
  scoresAfter: (r, of) => (r >= of ? "Letzte Runde" : `Nach Runde ${f.n(r)} von ${f.n(of)}`),
  scoresTitle: "Punkte",
  kinds: { drawn: "gezeichnet", read: "erkannt", best: "bester Zug" },
  gameOver: "Spielende",
  playAgain: "Der VIP kann ein neues Spiel starten",
  reactions: ["haha!", "was?!", "neiin", "genial"],
  reconnecting: "Verbindung wird wiederhergestellt…",
  over: "Das Spiel ist zu Ende",
});

/**
 * The TV's strings in a language.
 * @param {string} lang
 * @returns {Strings}
 */
export function strings(lang) {
  return lang === "de" ? de(format("de")) : en(format("en"));
}
