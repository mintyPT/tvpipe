// @ts-check
/**
 * What the TV says, per language (the room's: `screen.lang`). Names,
 * words and player texts are passed in and always rendered as text.
 */

/** @typedef {typeof EN} Strings */

const EN = {
  tagline: "draw · guess · draw on top",
  scanToJoin: "Scan to join",
  players: "Players",
  waitingSeat: "waiting…",
  freeSeat: "free seat",
  needed: (/** @type {number} */ n) => `${n} more to start`,
  vipStarts: (/** @type {string | undefined} */ name) => (name ? `${name} starts the game` : "The VIP starts the game"),
  how: [
    ["Draw", "a word you pick"],
    ["Guess", "what the picture you get is now"],
    ["Draw on top", "and turn it into your word"],
  ],
  howLine: "One picture each goes round the table. Nothing is ever erased.",
  layers: (/** @type {number} */ n) => `${n} layers`,
  undoOn: "undo",
  undoOff: "no undo",
  rounds: (/** @type {number} */ n) => (n === 1 ? "1 round" : `${n} rounds`),
  round: (/** @type {number} */ r, /** @type {number} */ of) => `Round ${r} of ${of}`,
  // Play
  draw: "Draw!",
  guess: "Guess!",
  onTop: "Draw on top!",
  lastGuess: "Last guess!",
  stepOf: (/** @type {number} */ k, /** @type {number} */ n) => `step ${k} of ${n}`,
  firstStep: "pick a word and draw it",
  turnGuess: "what is it now?",
  turnDraw: "make it your word",
  lastStep: "what did it end up as?",
  waitingFor: (/** @type {string[]} */ names) => `waiting for ${names.join(", ")}`,
  // Reveal
  pictureOf: (/** @type {string} */ name) => `${name}'s picture`,
  pictureCount: (/** @type {number} */ i, /** @type {number} */ n) => `Picture ${i}/${n}`,
  drewIt: (/** @type {string} */ name) => `drawn by ${name}`,
  read: (/** @type {string} */ name) => `${name} read`,
  noGuess: "(no guess)",
  hiddenGuess: "(hidden)",
  blank: "(nothing drawn)",
  each: (/** @type {number} */ n) => `+${n} each`,
  // Best move
  bestTitle: "Best move",
  bestHelp: "Which layer made the cleverest use of what was there? Vote on your phone.",
  voted: (/** @type {number} */ n, /** @type {number} */ of) => `${n} of ${of} voted`,
  bestBy: (/** @type {string} */ name) => `by ${name}`,
  votes: (/** @type {number} */ n) => (n === 1 ? "1 vote" : `${n} votes`),
  shared: "a tie: they share it",
  sharedMore: (/** @type {number} */ n) => `a tie: they share it with ${n} more`,
  noVotes: "No layer got two votes this round",
  // Scores
  scoresAfter: (/** @type {number} */ r, /** @type {number} */ of) => (r >= of ? "Final round" : `After round ${r} of ${of}`),
  scoresTitle: "Scores",
  kinds: { drawn: "drawn", read: "read", best: "best move" },
  gameOver: "Game over",
  playAgain: "The VIP can start another game",
  // Reactions (the phones' buttons)
  reactions: ["haha!", "what?!", "nooo", "genius"],
  reconnecting: "Reconnecting…",
  over: "The game has ended",
};

/** @type {Strings} */
const DE = {
  tagline: "zeichnen · raten · drüberzeichnen",
  scanToJoin: "Zum Mitspielen scannen",
  players: "Spieler",
  waitingSeat: "fehlt noch…",
  freeSeat: "frei",
  needed: (n) => `noch ${n} bis zum Start`,
  vipStarts: (name) => (name ? `${name} startet das Spiel` : "Der VIP startet das Spiel"),
  how: [
    ["Zeichnen", "ein Wort deiner Wahl"],
    ["Raten", "was das Bild jetzt ist"],
    ["Drüber", "zeichnen, bis es dein Wort ist"],
  ],
  howLine: "Jedes Bild geht reihum. Nichts wird je radiert.",
  layers: (n) => `${n} Schichten`,
  undoOn: "Rückgängig",
  undoOff: "kein Rückgängig",
  rounds: (n) => (n === 1 ? "1 Runde" : `${n} Runden`),
  round: (r, of) => `Runde ${r} von ${of}`,
  draw: "Zeichnen!",
  guess: "Raten!",
  onTop: "Drüberzeichnen!",
  lastGuess: "Letzter Tipp!",
  stepOf: (k, n) => `Schritt ${k} von ${n}`,
  firstStep: "Wort wählen und zeichnen",
  turnGuess: "was ist es jetzt?",
  turnDraw: "mach dein Wort daraus",
  lastStep: "was ist daraus geworden?",
  waitingFor: (names) => `warten auf ${names.join(", ")}`,
  pictureOf: (name) => `Bild von ${name}`,
  pictureCount: (i, n) => `Bild ${i}/${n}`,
  drewIt: (name) => `gezeichnet von ${name}`,
  read: (name) => `${name} las`,
  noGuess: "(kein Tipp)",
  hiddenGuess: "(ausgeblendet)",
  blank: "(nichts gezeichnet)",
  each: (n) => `je +${n}`,
  bestTitle: "Bester Zug",
  bestHelp: "Welche Schicht hat am cleversten genutzt, was schon da war? Wählt am Handy.",
  voted: (n, of) => `${n} von ${of} haben gewählt`,
  bestBy: (name) => `von ${name}`,
  votes: (n) => (n === 1 ? "1 Stimme" : `${n} Stimmen`),
  shared: "Gleichstand: geteilt",
  sharedMore: (n) => `Gleichstand: geteilt, mit ${n} weiteren`,
  noVotes: "Keine Schicht hat diesmal zwei Stimmen bekommen",
  scoresAfter: (r, of) => (r >= of ? "Letzte Runde" : `Nach Runde ${r} von ${of}`),
  scoresTitle: "Punkte",
  kinds: { drawn: "gezeichnet", read: "erkannt", best: "bester Zug" },
  gameOver: "Spielende",
  playAgain: "Der VIP kann ein neues Spiel starten",
  reactions: ["haha!", "was?!", "neiin", "genial"],
  reconnecting: "Verbindung wird wiederhergestellt…",
  over: "Das Spiel ist zu Ende",
};

/** @param {string} lang */
export function strings(lang) {
  return lang === "de" ? DE : EN;
}
