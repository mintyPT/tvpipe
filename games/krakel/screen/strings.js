// @ts-check
/**
 * What the TV says, per language (the room's: `screen.lang`). Names,
 * words and guesses are passed in, rendered as text.
 */

import { format } from "../phone/i18n.js";

/** @param {import("../phone/i18n.js").Format} f */
const en = (f) => ({
  /** A number as the language writes it. */
  n: f.n,
  reconnecting: "Reconnecting…",
  over: "The game has ended.",
  // Lobby
  tagline: "Draw it. Name it. Fast.",
  scanToJoin: "Scan to play",
  players: "Players",
  waitingSeat: "waiting…",
  freeSeat: "free",
  needed: (/** @type {number} */ n) => f.p(n, { one: "# more player to start", other: "# more players to start" }),
  vipStarts: (/** @type {string | undefined} */ name) => (name ? `${name} starts the game on the phone` : "The VIP starts the game"),
  how: [
    ["Draw", "Everyone picks one of three words and draws it."],
    ["Guess", "The TV redraws each picture. Type what it is!"],
    ["Score", "The sooner it is named, the more points for both."],
  ],
  rounds: (/** @type {number} */ n) => f.p(n, { one: "# round", other: "# rounds" }),
  drawTime: (/** @type {number} */ s) => `${f.n(s)} s to draw`,
  guessTime: (/** @type {number} */ s) => `${f.n(s)} s to guess`,
  modeCategory: "one category a round",
  modeMixed: "mixed words",
  hintsOn: "letters shown",
  hintsOff: "letters hidden",
  lockout: (/** @type {number} */ s) => (s > 0 ? `wrong guess: wait ${f.n(s)} s` : "guess freely"),
  // Drawing
  round: (/** @type {number} */ n, /** @type {number} */ of) => `Round ${f.n(n)} of ${f.n(of)}`,
  category: "Category",
  everyoneDraws: "Everyone draws something from this category",
  mixedKicker: "This round",
  mixed: "A bit of everything",
  everyoneDrawsMixed: "Everyone draws something else: the category shows when it is redrawn",
  tips: [
    "Start with what gives it away: the TV redraws your picture in the order you drew it.",
    "Everyone has a different word. Draw what makes yours yours!",
    "The sooner the others name your picture, the more points for you.",
    "Colours help. So does the eraser.",
  ],
  doneCount: (/** @type {number} */ n, /** @type {number} */ of) => `${f.n(n)} of ${f.n(of)} handed in`,
  // Guessing
  drawing: (/** @type {number} */ n, /** @type {number} */ of) => `Krakel ${f.n(n)} of ${f.n(of)}`,
  next: "Next up",
  krakelOf: (/** @type {string} */ name) => `${name}'s Krakel`,
  whatIsIt: "What is it? Type it on your phone!",
  ready: "Get ready…",
  close: "so close!",
  first: "first!",
  itIs: "It was",
  forArtist: (/** @type {string} */ name) => `for ${name}`,
  nobody: "Nobody had it!",
  everybody: "Everybody had it!",
  some: (/** @type {number} */ n, /** @type {number} */ of) => `${f.n(n)} of ${f.n(of)} had it`,
  // Gallery
  heartTitle: "Which one do you like best?",
  heartHelp: "Give it your heart on your phone.",
  voted: (/** @type {number} */ n, /** @type {number} */ of) => `${f.n(n)} of ${f.p(of, { one: "# heart", other: "# hearts" })} given`,
  rankedTitle: "The round's Krakels",
  rankedHelp: "The sooner it was named, the higher it ranks.",
  favourite: "favourite",
  had: (/** @type {number} */ n, /** @type {number} */ of) => `${f.n(n)}/${f.n(of)}`,
  // Scores
  scoresTitle: "Scores",
  scoresAfter: (/** @type {number} */ n, /** @type {number} */ of) => (n >= of ? "final round" : `after round ${f.n(n)} of ${f.n(of)}`),
  kinds: { drawn: "drawing", guessed: "guesses", first: "first", favourite: "♥" },
  // The end
  gameOver: "Game over!",
  playAgain: "Play again? The VIP starts the next game.",
  bestTitle: "Krakel of the game",
  bestBy: (/** @type {string} */ name) => `by ${name}`,
  eyeTitle: "Sharpest eye",
  points: "points",
  /** Points with their number: "+1 point", "1,200 points". */
  pointsN: (/** @type {number} */ n, sign = "") => sign + f.p(n, { one: "# point", other: "# points" }),
});

/** @typedef {ReturnType<typeof en>} Strings */

/** @type {(f: import("../phone/i18n.js").Format) => Strings} */
const de = (f) => ({
  n: f.n,
  reconnecting: "Verbinde neu…",
  over: "Das Spiel ist vorbei.",
  tagline: "Zeichnen. Erraten. Schnell sein.",
  scanToJoin: "Scannen und mitspielen",
  players: "Wer spielt mit",
  waitingSeat: "wartet…",
  freeSeat: "frei",
  needed: (n) => f.p(n, { one: "Noch # Person, dann geht's los", other: "Noch # Leute, dann geht's los" }),
  vipStarts: (name) => (name ? `${name} startet das Spiel am Handy` : "Der VIP startet das Spiel"),
  how: [
    ["Zeichnen", "Alle suchen sich eins von drei Wörtern aus und zeichnen es."],
    ["Raten", "Der Fernseher zeichnet jedes Bild nach. Tippt, was es ist!"],
    ["Punkten", "Je früher erraten, desto mehr Punkte für beide."],
  ],
  rounds: (n) => f.p(n, { one: "# Runde", other: "# Runden" }),
  drawTime: (s) => `${f.n(s)} s zeichnen`,
  guessTime: (s) => `${f.n(s)} s raten`,
  modeCategory: "eine Kategorie pro Runde",
  modeMixed: "gemischte Wörter",
  hintsOn: "Buchstaben sichtbar",
  hintsOff: "Buchstaben versteckt",
  lockout: (s) => (s > 0 ? `falsch geraten: ${f.n(s)} s warten` : "frei raten"),
  round: (n, of) => `Runde ${f.n(n)} von ${f.n(of)}`,
  category: "Kategorie",
  everyoneDraws: "Alle zeichnen etwas aus dieser Kategorie",
  mixedKicker: "Diese Runde",
  mixed: "Kunterbunt",
  everyoneDrawsMixed: "Alle zeichnen etwas anderes: Die Kategorie seht ihr beim Nachzeichnen",
  tips: [
    "Fangt mit dem an, was es verrät: Der Fernseher zeichnet euer Bild in eurer Reihenfolge nach.",
    "Alle haben ein anderes Wort. Zeichnet, was eures besonders macht!",
    "Je früher die anderen euer Bild erraten, desto mehr Punkte gibt es für euch.",
    "Farben helfen. Der Radierer auch.",
  ],
  doneCount: (n, of) => `${f.n(n)} von ${f.n(of)} abgegeben`,
  drawing: (n, of) => `Krakel ${f.n(n)} von ${f.n(of)}`,
  next: "Als Nächstes",
  krakelOf: (name) => `Krakel von ${name}`,
  whatIsIt: "Was ist das? Tippt es ins Handy!",
  ready: "Gleich geht's los…",
  close: "ganz knapp!",
  first: "Erste:r!",
  itIs: "Es war",
  forArtist: (name) => `für ${name}`,
  nobody: "Niemand hat es erraten!",
  everybody: "Alle haben es erraten!",
  some: (n, of) => f.p(n, { one: `# von ${f.n(of)} hat es erraten`, other: `# von ${f.n(of)} haben es erraten` }),
  heartTitle: "Welches gefällt euch am besten?",
  heartHelp: "Schenkt ihm am Handy euer Herz.",
  voted: (n, of) => `${f.n(n)} von ${f.p(of, { one: "# Herz", other: "# Herzen" })} verschenkt`,
  rankedTitle: "Die Krakel der Runde",
  rankedHelp: "Je früher erraten, desto weiter vorn.",
  favourite: "Lieblingsbild",
  had: (n, of) => `${f.n(n)}/${f.n(of)}`,
  scoresTitle: "Punkte",
  scoresAfter: (n, of) => (n >= of ? "letzte Runde" : `nach Runde ${f.n(n)} von ${f.n(of)}`),
  kinds: { drawn: "Bild", guessed: "Tipps", first: "Erste:r", favourite: "♥" },
  gameOver: "Spiel vorbei!",
  playAgain: "Noch mal? Der VIP startet das nächste Spiel.",
  bestTitle: "Krakel des Spiels",
  bestBy: (name) => `von ${name}`,
  eyeTitle: "Schärfstes Auge",
  points: "Punkte",
  pointsN: (n, sign = "") => sign + f.p(n, { one: "# Punkt", other: "# Punkte" }),
});

/** @param {string} lang @returns {Strings} */
export function strings(lang) {
  return lang === "de" ? de(format("de")) : en(format("en"));
}
