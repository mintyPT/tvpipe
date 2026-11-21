// @ts-check
/**
 * What the TV page says, per language (the room's, `screen.lang`).
 * German is written for German speakers, not translated word for word.
 */

import { format } from "../phone/i18n.js";

/** @param {import("../phone/i18n.js").Format} f */
const en = (f) => ({
  /** What the lobby says about latecomers (`join.lateJoin`). @type {Record<string, string>} */
  late: { open: "Join anytime, even during the game", wait: "Latecomers join at the next round", closed: "Joining closes when the game starts" },
  reconnecting: "Reconnecting to the game…",
  over: "The game is over.",
  /** @param {number} n */
  joinedMore: (n) => `+ ${f.n(n)} more`,
  /** @param {string} msg */
  cannotShow: (msg) => `Cannot show the game: ${msg}`,
  // The lobby.
  scanToJoin: "Scan to join with your phone",
  players: "Players",
  seatWaiting: "waiting…",
  seatFree: "room for one more",
  /** @param {number} n */
  needed: (n) => f.p(n, { one: "# more player needed.", other: "# more players needed." }),
  /** @param {string | undefined} vip */
  vipStarts: (vip) => `${vip ?? "The VIP"} starts the game on their phone.`,
  // The rules (the lobby's badges).
  /** @param {number} n */
  roundsN: (n) => f.p(n, { one: "# round", other: "# rounds" }),
  animated: "Animated: 2 frames",
  undoOff: "No undo",
  undoOn: "Undo on",
  shades: "Two shades each",
  colorMode: "Colour mode",
  adult: "18+ prompts",
  // Progress.
  /** @param {number} n @param {number} of */
  done: (n, of) => `${f.n(n)} of ${f.n(of)} done`,
  /** @param {number} n @param {number} of */
  voted: (n, of) => `${f.n(n)} of ${f.n(of)} voted`,
  // Drawing and the gallery.
  /** @param {number} r @param {number} of */
  roundOf: (r, of) => `Round ${f.n(r)} of ${f.n(of)}`,
  drawPrompt: "Draw your prompt on your phone!",
  drawAnimated: "Animate your prompt on your phone!",
  /** @param {number} r */
  roundN: (r) => `Round ${f.n(r)}`,
  /** @param {number} n @param {number} of */
  nOf: (n, of) => `${f.n(n)} of ${f.n(of)}`,
  doneWord: "done",
  lastSeconds: "Last 10 seconds!",
  // A drawer's card.
  drawingNow: "drawing…",
  thinking: "thinking…",
  doneShort: "done!",
  hurry: "hurry!",
  startedOver: "started over!",
  stampDone: "DONE ✓",
  /** @param {number} r @param {number} page @param {number} pages */
  gallery: (r, page, pages) => `Round ${f.n(r)} · the gallery${pages > 1 ? ` · ${f.n(page)} of ${f.n(pages)}` : ""}`,
  /** @param {string} name */
  by: (name) => `by ${name}`,
  /** @param {number} liars @param {string | undefined} artist @param {number} done */
  meanwhile: (liars, artist, done) =>
    `Meanwhile ${f.p(liars, { one: "# liar is", other: "# liars are" })} writing for ${artist ? `${artist}'s drawing` : "the first drawing"} · ${f.n(done)} done`,
  // Lies and votes.
  /** @param {number} spot @param {number} spots */
  spotOf: (spot, spots) => ` · drawing ${f.n(spot)} of ${f.n(spots)}`,
  /** Around the artist's name: "Anna drew this". */
  drewBefore: "",
  drewAfter: "drew this",
  /** @param {number} spot @param {number} spots */
  drawingOf: (spot, spots) => `Drawing ${f.n(spot)} of ${f.n(spots)}`,
  /** @param {number} n */
  liarsWriting: (n) => f.p(n, { one: "What is it called? The liar is writing a fake title.", other: "What is it called? # liars are writing fake titles." }),
  whichReal: "Which one is the real title?",
  /** @param {number} n */
  writingNext: (n) => f.p(n, { one: "Meanwhile # liar writes for the next drawing.", other: "Meanwhile # liars write for the next drawing." }),
  /** The frame's plate before the reveal tells the title. */
  untitled: "Untitled",
  // The reveal.
  answers: "The answers",
  votes: "Votes",
  stampLie: "LIE",
  stampOurs: "OUR LIE",
  stampTruth: "TRUTH",
  /** @param {string[]} names */
  foundBy: (names) => `found by ${f.list(names)}`,
  /** @param {number} count @param {number} seen */
  foundByN: (count, seen) => `found by ${f.n(count)} of ${f.n(seen)}`,
  each: "each",
  nobodyFound: "nobody found it",
  /** @param {string[]} names */
  fellForIt: (names) => `${f.list(names)} fell for it`,
  /** @param {number} count @param {number} seen */
  fooledOf: (count, seen) => `fooled ${f.n(count)} of ${f.n(seen)}`,
  sameIdea: " (same idea!)",
  // Stingers: the word between two phases.
  stDraw: "DRAW!",
  stPens: "PENS DOWN!",
  stBluff: "BLUFF!",
  stVote: "VOTE!",
  stScores: "SCORES",
  stFinal: "AND THE WINNER IS…",
  // Scores.
  /** @param {string | undefined} name */
  wins: (name) => `${name ?? "Nobody"} wins!`,
  finalScores: "Final scores",
  /** @param {number} r */
  scoresAfter: (r) => `Scores after round ${f.n(r)}`,
  bestLiar: "Best liar",
  sharpestEye: "Sharpest eye",
  /** @param {number} n */
  fooledN: (n) => `fooled ${f.n(n)}`,
  /** @param {number} n @param {number} of */
  foundN: (n, of) => `found ${f.n(n)} of ${f.n(of)}`,
  /** @param {number} total */
  rankOnPhone: (total) => `${f.n(total)} players · your rank is on your phone`,
  anotherGame: "The VIP can start another game on their phone.",
  /** @param {number} r */
  rank: (r) => `${f.n(r)}.`,
  /** @param {number} n */
  n: (n) => f.n(n),
});

/** @type {typeof en} */
const de = (f) => ({
  late: { open: "Jederzeit einsteigen, auch mitten im Spiel", wait: "Nachzügler steigen in der nächsten Runde ein", closed: "Einsteigen nur bis zum Spielstart" },
  reconnecting: "Verbinde wieder mit dem Spiel…",
  over: "Das Spiel ist vorbei.",
  joinedMore: (n) => `+ ${f.n(n)} weitere`,
  cannotShow: (msg) => `Das Spiel lässt sich nicht anzeigen: ${msg}`,
  scanToJoin: "Scann den Code mit dem Handy",
  players: "Mitspieler",
  seatWaiting: "fehlt noch…",
  seatFree: "noch ein Platz frei",
  needed: (n) => f.p(n, { one: "Noch # Mitspieler fehlt.", other: "Noch # Mitspieler fehlen." }),
  vipStarts: (vip) => `${vip ?? "Der VIP"} startet das Spiel am Handy.`,
  roundsN: (n) => f.p(n, { one: "# Runde", other: "# Runden" }),
  animated: "Animiert: 2 Bilder",
  undoOff: "Kein Rückgängig",
  undoOn: "Rückgängig an",
  shades: "Zwei Töne pro Person",
  colorMode: "Farbmodus",
  adult: "Begriffe ab 18",
  done: (n, of) => `${f.n(n)} von ${f.n(of)} fertig`,
  voted: (n, of) => `${f.n(n)} von ${f.n(of)} abgestimmt`,
  roundOf: (r, of) => `Runde ${f.n(r)} von ${f.n(of)}`,
  drawPrompt: "Zeichne deinen Begriff auf dem Handy!",
  drawAnimated: "Animiere deinen Begriff am Handy!",
  roundN: (r) => `Runde ${f.n(r)}`,
  nOf: (n, of) => `${f.n(n)} von ${f.n(of)}`,
  doneWord: "fertig",
  lastSeconds: "Noch 10 Sekunden!",
  drawingNow: "zeichnet…",
  thinking: "überlegt…",
  doneShort: "fertig!",
  hurry: "schnell!",
  startedOver: "fängt neu an!",
  stampDone: "FERTIG ✓",
  gallery: (r, page, pages) => `Runde ${f.n(r)} · die Galerie${pages > 1 ? ` · ${f.n(page)} von ${f.n(pages)}` : ""}`,
  by: (name) => `von ${name}`,
  meanwhile: (liars, artist, done) =>
    `Währenddessen ${f.p(liars, { one: "schreibt # Lügner", other: "schreiben # Lügner" })} für ${artist ? `die Zeichnung von ${artist}` : "die erste Zeichnung"} · ${f.n(done)} fertig`,
  spotOf: (spot, spots) => ` · Zeichnung ${f.n(spot)} von ${f.n(spots)}`,
  drewBefore: "Gezeichnet von",
  drewAfter: "",
  drawingOf: (spot, spots) => `Zeichnung ${f.n(spot)} von ${f.n(spots)}`,
  liarsWriting: (n) =>
    f.p(n, { one: "Wie heißt das? Der Lügner denkt sich einen falschen Titel aus.", other: "Wie heißt das? # Lügner denken sich falsche Titel aus." }),
  whichReal: "Welcher Titel ist echt?",
  writingNext: (n) => f.p(n, { one: "Währenddessen schreibt # Lügner für die nächste Zeichnung.", other: "Währenddessen schreiben # Lügner für die nächste Zeichnung." }),
  untitled: "Ohne Titel",
  answers: "Die Antworten",
  votes: "Stimmen",
  stampLie: "LÜGE",
  stampOurs: "UNSERE LÜGE",
  stampTruth: "WAHRHEIT",
  foundBy: (names) => `erkannt von ${f.list(names)}`,
  foundByN: (count, seen) => `erkannt von ${f.n(count)} von ${f.n(seen)}`,
  each: "pro Kopf",
  nobodyFound: "keiner hat's erkannt",
  fellForIt: (names) => `${f.list(names)} ${names.length === 1 ? "ist" : "sind"} reingefallen`,
  fooledOf: (count, seen) => `hat ${f.n(count)} von ${f.n(seen)} reingelegt`,
  sameIdea: " (gleiche Idee!)",
  stDraw: "ZEICHNEN!",
  stPens: "STIFTE WEG!",
  stBluff: "BLUFFEN!",
  stVote: "ABSTIMMEN!",
  stScores: "PUNKTE",
  stFinal: "UND GEWONNEN HAT…",
  wins: (name) => `${name ?? "Niemand"} gewinnt!`,
  finalScores: "Endstand",
  scoresAfter: (r) => `Punkte nach Runde ${f.n(r)}`,
  bestLiar: "Bester Bluff",
  sharpestEye: "Adlerauge",
  fooledN: (n) => `hat ${f.n(n)} reingelegt`,
  foundN: (n, of) => `${f.n(n)} von ${f.n(of)} erkannt`,
  rankOnPhone: (total) => `${f.n(total)} Mitspieler · deinen Platz siehst du am Handy`,
  anotherGame: "Der VIP kann am Handy ein neues Spiel starten.",
  rank: (r) => `${f.n(r)}.`,
  n: (n) => f.n(n),
});

/** @typedef {ReturnType<typeof en>} Strings */

/**
 * The TV's strings in a language.
 * @param {import("../phone/i18n.js").Lang} lang
 * @returns {Strings}
 */
export function strings(lang) {
  return (lang === "de" ? de : en)(format(lang));
}
