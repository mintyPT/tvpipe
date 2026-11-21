// @ts-check
/**
 * What the TV says, per language (the room's, `screen.lang`). German is
 * written for German speakers, not translated word for word: the table's
 * host keeps its voice (cheeky, never mean, never a hint to the guesser),
 * the stamps are German stamps ("RICHTIG!", "DANEBEN"), JINX! stays the
 * game's own word.
 *
 * `t` is the current language's table (a live binding: the scenes read it
 * when they draw); the Tv switches it with {@link useLang} when a view
 * brings another language, and draws the scene again.
 *
 * Host lines: sentence case, `*bold*` marks emphasis; the second hit is
 * uppercase.
 *
 * @typedef {import("../game/views.ts").Reason} Reason
 * @typedef {import("../game/views.ts").RoomTitle} RoomTitle
 * @typedef {import("../game/views.ts").Award} Award
 */

import { format, pickLang } from "../phone/i18n.js";

/** @param {import("../phone/i18n.js").Format} f */
const en = (f) => ({
  /** @param {string} name */
  gen: (name) => (/s$/i.test(name) ? `${name}'` : `${name}'s`),
  reconnecting: "Reconnecting…",
  over: "The game is over.",
  // The header and the pieces.
  /** @param {string} name */
  guesses: (name) => `${name} guesses`,
  /** @param {number} found @param {number} total */
  tally: (found, total) => `${f.n(found)} of ${f.n(total)}`,
  thePot: "THE POT",
  shhh: "SHHH!",
  /** @param {string} name */
  isGuessing: (name) => `${name} is guessing`,
  bank: "BANK",
  bestClue: "BEST CLUE",
  // The lobby.
  /** @type {((name: string) => string)[]} */
  greet: [(n) => `Welcome, *${n}*. Mind your words.`, (n) => `*${n}* is in. The plot thickens.`, (n) => `Here comes *${n}*!`, (n) => `*${n}* pulls up a chair.`],
  /** @type {[string, string]} */
  tagline: ["One word each. ", "Don't think alike."],
  scanToJoin: "SCAN TO JOIN",
  atTable: "AT THE TABLE ",
  /** @param {number} min @param {number} max */
  lobbySub: (min, max) => `${f.n(min)} to ${f.n(max)} players · draw your face on your phone`,
  openSeat: "open seat",
  phonesOut: "Phones out. Scan in. *No word is safe.*",
  /** @param {number} n */
  waitingMore: (n) => `Waiting for *${f.n(n)} more* to play`,
  /** @param {string} vip */
  vipStarts: (vip) => `*${vip}* starts the game from their phone`,
  startFromPhone: "Start the game from a phone",
  // The round's start.
  /** @param {number} r @param {number} of */
  roundTab: (r, of) => `Round ${f.n(r)} of ${f.n(of)}`,
  makeItCount: "Everyone else: one word. *Make it count.*",
  /** The hot seat in two hits. @param {string} name uppercase @returns {[string, string]} */
  hotSeat: (name) => [`${name} IS IN\u00a0`, "THE HOT SEAT"],
  /** @param {number} each */
  writeLine: (each) => `${each === 2 ? "Two words each." : "One word each."} *Don't think alike.*`,
  /** @param {string} name */
  cantSee: (name) => `${name} can't see the word`,
  /** @param {number} sent @param {number} total */
  sentOf: (sent, total) => `${f.n(sent)} of ${f.n(total)} in`,
  cluesLocked: "*Clues locked!*",
  allIn: "All in!",
  tenSeconds: "*Ten seconds.* Commit to something!",
  // The jinx check.
  jinxCheck: "Jinx check",
  /** How a reason reads on tape. @type {Record<Reason, string>} */
  reasons: {
    "same word": "same word",
    "same number": "same number",
    spelling: "other spelling",
    plural: "plural",
    "verb form": "verb form",
    "word form": "other form",
    "same family": "same family",
    typo: "typo",
    "sounds the same": "sounds the same",
    "contains the word": "contains the word",
    "part of the word": "part of the word",
    "too close": "too close",
  },
  /** @param {number} n */
  sameWordTimes: (n) => `same word × ${f.n(n)}`,
  totalJinx: "Total jinx",
  everyCard: "Every single card…",
  jinxedHit: "JINXED.",
  /** @param {string} name */
  nobodyAlike: (name) => `Nobody thought alike. ${name}, *blindfold off.*`,
  /** @param {number} lost */
  lost: (lost) => `${f.n(lost)} lost…`,
  /** @param {number} left @param {string} name */
  leftFor: (left, name) => `${f.p(left, { one: "# CLUE LEFT", other: "# CLUES LEFT" })} FOR ${name.toUpperCase()}`,
  sameClueSmoke: "Same clue? *Both cards go up in smoke.*",
  cleanSweep: "Clean sweep!",
  nobodyAlikeHit: "NOBODY THOUGHT ALIKE.",
  clean: "Clean!",
  groupLines: ["Uh-oh. *Great minds…*", "And *again*…", "*Another one!*", "Is this *contagious*?"],
  selfJinx: "Self-jinx!",
  jinx: "Jinx!",
  tooCloseLine: "Too close to the word. *Out it goes.*",
  void: "Void",
  tooCloseTape: "too close to the word",
  // The reveal and the verdict.
  theReveal: "The reveal",
  /** @param {string} name */
  guessOf: (name) => `${name}'s guess`,
  /** @param {string} name */
  whoseFirst: (name) => `${name}, whose card do you turn *first*?`,
  another: "Turn another card… *or take a guess.*",
  everyUp: "Every card is up. *Guess, or pass.*",
  /** @param {string} name */
  mayAfterAny: (name) => `${name} may guess after any card`,
  /** @param {string} name */
  mayNow: (name) => `${name} may guess now`,
  /** @param {string} name uppercase */
  trusts: (name) => `${name} TRUSTS…`,
  boldPlus: "+2 bold",
  theVerdict: "The verdict",
  theWordWas: "THE WORD WAS",
  /** @param {string} reason */
  closeEnough: (reason) => `Close enough: *${reason}*.`,
  nailedIt: "Nailed it!",
  /** @param {number} n */
  forTheRoom: (n) => `+${f.n(n)} FOR THE ROOM`,
  soClose: "So close.",
  soWrong: "SO WRONG.",
  noGuess: "No guess.",
  bankSafe: "THE BANK IS SAFE.",
  emptyPot: "Every card jinxed. *The pot goes home empty.*",
  /** The verdict's stamps. @type {Record<"right" | "wrong" | "pass" | "lost", string>} */
  stamps: { right: "Right!", wrong: "Not it", pass: "Pass", lost: "Missed" },
  lockedIn: "Locked in",
  wordWas: "The word was…",
  // The replay and the bank.
  /** @param {number} r */
  replayTab: (r) => `Round ${f.n(r)} · replay`,
  /** @param {string} word uppercase @param {string} mark */
  howWeGot: (word, mark) => `How we got to *${word}*${mark}`,
  /** @param {string} name */
  selfJinxed: (name) => `${name} jinxed ${name}`,
  /** @param {number} n @param {string} word uppercase */
  ofYouWrote: (n, word) => `${n === 2 ? "Two" : f.n(n)} of you wrote ${word}`,
  notTurned: "not turned",
  thisRound: "THIS ROUND",
  /** @param {number} n */
  bankIs: (n) => `bank ${f.n(n)}`,
  /** @param {string} name */
  picksThe: (name) => `${name} picks the `,
  bestClueLower: "best clue",
  noBest: "No best clue this round",
  /** @param {string} name */
  whichCracked: (name) => `${name}, which clue *helped most*?`,
  bestClueHit: "BEST CLUE…",
  noBestLine: "No best clue this round. *Still a team.*",
  /** @param {string} name */
  thanks: (name) => `thanks, ${name}!`,
  /** @param {number} r @param {number} of */
  bankTab: (r, of) => `The bank · round ${f.n(r)} of ${f.n(of)}`,
  /** The titles as marks on the meter. @type {Record<RoomTitle, string>} */
  goalNames: { telepaths: "Telepaths", "mind readers": "Mind readers", "in sync": "In sync", "mixed signals": "Mixed signals", "total jinx": "Total jinx" },
  record: "record",
  /** @param {number} n @param {string} title */
  toGoal: (n, title) => `${f.p(n, { one: "# more chip", other: "# more chips" })} to *${title}*`,
  topGoal: "Telepath territory. *Hold it.*",
  /** @param {number} found @param {number} played */
  wordsSoFar: (found, played) => `${f.p(found, { one: "# word", other: "# words" })} of ${f.n(played)} so far`,
  /** @param {number} n @returns {string} */
  bankLine: (n) => (n > 0 ? "*We're in the money.*" : n < 0 ? "Ouch. *We'll win it back.*" : "*Steady.* On to the next one."),
  nextUp: "Next up:",
  thatsTheGame: "That's the game!",
  // The end.
  endRoom: "Game over · the room",
  of: "of",
  /** @param {number} chips @param {number} found @param {number} total */
  bankCaption: (chips, found, total) => `${f.p(chips, { one: "chip", other: "chips" })} in the bank · ${f.n(found)} of ${f.n(total)} words`,
  newRecord: "New record!",
  /** @param {number} n */
  recordWas: (n) => `the record was ${f.n(n)}`,
  /** The room's title on the stamp. @type {Record<RoomTitle, string>} */
  titles: { telepaths: "telepaths!", "mind readers": "mind readers!", "in sync": "in sync!", "mixed signals": "mixed signals!", "total jinx": "total jinx!" },
  endClues: "Game over · the best clues",
  cluesSub: "The clues that helped us most tonight",
  /** @param {string} word uppercase */
  forWord: (word) => `for ${word}`,
  endAwards: "Game over · awards",
  /** @type {[string, string]} */
  noAwards: ["No awards tonight. ", "We're all in this together."],
  /** @type {Record<Award["kind"], string>} */
  awards: { "mind meld": "mind meld", telepath: "telepath" },
  /** @param {Award} a */
  awardStat: (a) => {
    const n = a.count;
    if (a.kind === "mind meld") return n === 1 ? "jinxed each other once" : `jinxed each other ${f.n(n)} times`;
    return f.p(n, { one: "# clue turned before a right guess", other: "# clues turned before a right guess" });
  },
  and: " & ",
  wordWeb: "The word web",
  /** @param {number} n */
  webLinked: (n) => `${f.p(n, { one: "# word", other: "# words" })}, linked by the clues you shared`,
  /** @param {number} n */
  webAlone: (n) => `${f.p(n, { one: "# word", other: "# words" })} and the clues that led there. No clue went to two words!`,
  missed: "missed",
});

/** @type {typeof en} */
const de = (f) => ({
  gen: (name) => (/[sßxz]$/i.test(name) ? `${name}’` : `${name}s`),
  reconnecting: "Verbinde neu…",
  over: "Das Spiel ist vorbei.",
  guesses: (name) => `${name} rät`,
  tally: (found, total) => `${f.n(found)} von ${f.n(total)}`,
  thePot: "DER POTT",
  shhh: "PSSST!",
  isGuessing: (name) => `${name} rät gerade`,
  bank: "BANK",
  bestClue: "BESTER HINWEIS",
  greet: [(n) => `Willkommen, *${n}*. Wähl deine Worte gut.`, (n) => `*${n}* ist dabei. Jetzt wird's spannend.`, (n) => `Da kommt *${n}*!`, (n) => `*${n}* rückt einen Stuhl ran.`],
  tagline: ["Ein Wort pro Kopf. ", "Bloß nicht dasselbe."],
  scanToJoin: "HIER SCANNEN",
  atTable: "AM TISCH ",
  lobbySub: (min, max) => `${f.n(min)} bis ${f.n(max)} Leute · mal dein Gesicht am Handy`,
  openSeat: "frei",
  phonesOut: "Handys raus. Code scannen. *Kein Wort ist sicher.*",
  waitingMore: (n) => f.p(n, { one: "Es fehlt noch *#* zum Spielen", other: "Es fehlen noch *#* zum Spielen" }),
  vipStarts: (vip) => `*${vip}* startet das Spiel am Handy`,
  startFromPhone: "Startet das Spiel an einem Handy",
  roundTab: (r, of) => `Runde ${f.n(r)} von ${f.n(of)}`,
  makeItCount: "Alle anderen: ein Wort. *Aber ein gutes.*",
  hotSeat: (name) => [`${name} AUF DEM\u00a0`, "HEISSEN STUHL"],
  writeLine: (each) => `${each === 2 ? "Zwei Wörter pro Kopf." : "Ein Wort pro Kopf."} *Bloß nicht gleich denken.*`,
  cantSee: (name) => `${name} sieht das Wort nicht`,
  sentOf: (sent, total) => `${f.n(sent)} von ${f.n(total)} da`,
  cluesLocked: "*Alle Hinweise sind drin!*",
  allIn: "Alle drin!",
  tenSeconds: "*Zehn Sekunden.* Leg dich fest!",
  jinxCheck: "Jinx-Check",
  reasons: {
    "same word": "gleiches Wort",
    "same number": "gleiche Zahl",
    spelling: "andere Schreibweise",
    plural: "Plural",
    "verb form": "Verbform",
    "word form": "andere Form",
    "same family": "Wortfamilie",
    typo: "Tippfehler",
    "sounds the same": "klingt gleich",
    "contains the word": "enthält das Wort",
    "part of the word": "Teil des Wortes",
    "too close": "zu nah dran",
  },
  sameWordTimes: (n) => `gleiches Wort × ${f.n(n)}`,
  totalJinx: "Totaler Jinx",
  everyCard: "Jede einzelne Karte…",
  jinxedHit: "GEJINXT.",
  nobodyAlike: (name) => `Keiner dachte gleich. ${name}, *Augenbinde ab.*`,
  lost: (lost) => `${f.n(lost)} weg…`,
  leftFor: (left, name) => `${f.p(left, { one: "NOCH # HINWEIS", other: "NOCH # HINWEISE" })} FÜR ${name.toUpperCase()}`,
  sameClueSmoke: "Gleicher Hinweis? *Dann gehen beide in Rauch auf.*",
  cleanSweep: "Weiße Weste!",
  nobodyAlikeHit: "KEINER DACHTE GLEICH.",
  clean: "Sauber!",
  groupLines: ["Oh-oh. *Zwei Dumme, ein Gedanke…*", "Und *nochmal*…", "*Noch einer!*", "Ist das *ansteckend*?"],
  selfJinx: "Selbst-Jinx!",
  jinx: "Jinx!",
  tooCloseLine: "Zu nah am Wort. *Weg damit.*",
  void: "Ungültig",
  tooCloseTape: "zu nah am Wort",
  theReveal: "Aufdecken",
  guessOf: (name) => `${/[sßxz]$/i.test(name) ? `${name}’` : `${name}s`} Tipp`,
  whoseFirst: (name) => `${name}, wessen Karte drehst du *zuerst* um?`,
  another: "Noch eine Karte… *oder jetzt raten.*",
  everyUp: "Alle Karten liegen offen. *Raten oder passen.*",
  mayAfterAny: (name) => `${name} darf nach jeder Karte raten`,
  mayNow: (name) => `${name} darf jetzt raten`,
  trusts: (name) => `${name} VERTRAUT…`,
  boldPlus: "+2 mutig",
  theVerdict: "Die Auflösung",
  theWordWas: "DAS WORT WAR",
  closeEnough: (reason) => `Nah genug: *${reason}*.`,
  nailedIt: "Volltreffer!",
  forTheRoom: (n) => `+${f.n(n)} FÜR ALLE`,
  soClose: "So nah dran.",
  soWrong: "SO DANEBEN.",
  noGuess: "Kein Tipp.",
  bankSafe: "DIE BANK BLEIBT HEIL.",
  emptyPot: "Alles gejinxt. *Der Pott geht leer aus.*",
  stamps: { right: "Richtig!", wrong: "Daneben", pass: "Gepasst", lost: "Verloren" },
  lockedIn: "Eingeloggt",
  wordWas: "Das Wort war…",
  replayTab: (r) => `Runde ${f.n(r)} · Wiederholung`,
  howWeGot: (word, mark) => `So kamen wir auf *${word}*${mark}`,
  selfJinxed: (name) => `${name} jinxte sich selbst`,
  ofYouWrote: (n, word) => `${n === 2 ? "Zwei" : f.n(n)} von euch schrieben ${word}`,
  notTurned: "verdeckt",
  thisRound: "DIESE RUNDE",
  bankIs: (n) => `Bank ${f.n(n)}`,
  picksThe: (name) => `${name} wählt den `,
  bestClueLower: "besten Hinweis",
  noBest: "Diese Runde kein bester Hinweis",
  whichCracked: (name) => `${name}, welcher Hinweis hat dir *am meisten* geholfen?`,
  bestClueHit: "BESTER HINWEIS…",
  noBestLine: "Diese Runde kein bester Hinweis. *Trotzdem ein Team.*",
  thanks: (name) => `danke, ${name}!`,
  bankTab: (r, of) => `Die Bank · Runde ${f.n(r)} von ${f.n(of)}`,
  goalNames: { telepaths: "Telepathen", "mind readers": "Gedankenleser", "in sync": "Eingespielt", "mixed signals": "Funkstörung", "total jinx": "Totaler Jinx" },
  record: "Rekord",
  toGoal: (n, title) => `Noch ${f.p(n, { one: "# Chip", other: "# Chips" })} bis *${title}*`,
  topGoal: "Telepathen-Niveau. *Haltet es.*",
  wordsSoFar: (found, played) => `${f.p(found, { one: "# Wort", other: "# Wörter" })} von ${f.n(played)} bisher`,
  bankLine: (n) => (n > 0 ? "*Es klingelt in der Kasse.*" : n < 0 ? "Autsch. *Das holen wir uns zurück.*" : "*Ruhig Blut.* Weiter geht's."),
  nextUp: "Als Nächstes:",
  thatsTheGame: "Das war's!",
  endRoom: "Spiel vorbei · alle zusammen",
  of: "von",
  bankCaption: (chips, found, total) => `${f.p(chips, { one: "Chip", other: "Chips" })} in der Bank · ${f.n(found)} von ${f.n(total)} Wörtern`,
  newRecord: "Neuer Rekord!",
  recordWas: (n) => `der Rekord war ${f.n(n)}`,
  titles: { telepaths: "Telepathen!", "mind readers": "Gedankenleser!", "in sync": "Eingespielt!", "mixed signals": "Funkstörung!", "total jinx": "Totaler Jinx!" },
  endClues: "Spiel vorbei · die besten Hinweise",
  cluesSub: "Die Hinweise, die uns heute am meisten geholfen haben",
  forWord: (word) => `für ${word}`,
  endAwards: "Spiel vorbei · Auszeichnungen",
  noAwards: ["Heute keine Auszeichnungen. ", "Wir sind eben ein Team."],
  awards: { "mind meld": "Seelenverwandt", telepath: "Hellseher" },
  awardStat: (a) => {
    const n = a.count;
    if (a.kind === "mind meld") return n === 1 ? "haben sich einmal gegenseitig gejinxt" : `haben sich ${f.n(n)}-mal gegenseitig gejinxt`;
    return f.p(n, { one: "# Hinweis vor einem Treffer umgedreht", other: "# Hinweise vor einem Treffer umgedreht" });
  },
  and: " & ",
  wordWeb: "Das Wortnetz",
  webLinked: (n) => `${f.p(n, { one: "# Wort", other: "# Wörter" })}, verbunden durch eure gemeinsamen Hinweise`,
  webAlone: (n) => `${f.p(n, { one: "# Wort", other: "# Wörter" })} und die Hinweise dorthin. Kein Hinweis passte zu zwei Wörtern!`,
  missed: "verpasst",
});

/** @typedef {ReturnType<typeof en>} Strings */

/** The TV's language. @type {import("../phone/i18n.js").Lang} */
export let lang = "en";
/** The TV's strings (the current language's). @type {Strings} */
export let t = en(format("en"));

/**
 * Follows a view's language; true when it changed (the scene is drawn again).
 * @param {unknown} tag the view's `lang`
 */
export function useLang(tag) {
  const l = pickLang(tag);
  if (l === lang) return false;
  lang = l;
  t = (l === "de" ? de : en)(format(l));
  document.documentElement.lang = l;
  return true;
}
