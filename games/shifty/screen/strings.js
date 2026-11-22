// @ts-check
/**
 * What Shifty's TV says, in English and German. The room's language
 * comes with the screen view (`screen.lang`).
 */

import { format } from "../phone/i18n.js";

/** @param {"en" | "de"} lang */
export function strings(lang) {
  const f = format(lang);
  const n = f.n;
  if (lang === "de") {
    return {
      ...f,
      tagline: "Alle kennen das geheime Wort. Bis auf einen.",
      scanToJoin: "Scannen und mitspielen",
      tickerLine: "Einer von euch lügt",
      boardLabel: "Beweismittel · 16 Wörter",
      suspects: "Verdächtige",
      waitingSeat: "fehlt noch",
      freeSeat: "frei",
      /** @param {number} k */
      needed: (k) => f.p(k, { one: "Noch # Verdächtiger fehlt", other: "Noch # Verdächtige fehlen" }),
      /** @param {string | undefined} name */
      vipStarts: (name) => (name ? `${name} startet am Handy` : "Der VIP startet am Handy"),
      how: [
        ["Die Karte", "Alle bekommen dasselbe geheime Wort, nur der Schwindler nicht."],
        ["Ein Wort", "Nacheinander tippt jeder einen Hinweis. Die Nadel sieht, wer zögert."],
        ["Der Verdacht", "Geheim beschuldigen. Erwischt? Der Schwindler kann noch das Wort nennen."],
      ],
      /** @param {number} r */
      rounds: (r) => f.p(r, { one: "# Runde", other: "# Runden" }),
      typed: "Hinweise getippt",
      spoken: "Hinweise laut gesagt",
      /** @param {number} s */
      clueTime: (s) => `${s} s pro Hinweis`,
      /** @param {number} s */
      talkTime: (s) => `${s} s zum Reden`,
      typingOn: "Tippen sichtbar",
      typingOff: "Tippen verborgen",
      /** @param {number} r @param {number} of */
      round: (r, of) => `Runde ${r}/${of}`,
      category: "Kategorie",
      dealTitle: "Schaut auf eure Karte",
      dealHelp: "Alle kennen das Wort, bis auf den Schwindler.",
      /** @param {string} name */
      typing: (name) => `${name} tippt`,
      /** @param {string} name */
      sayIt: (name) => `${name}: sag es!`,
      clueHelp: "Ein Wort, das zeigt: Ich kenne das Wort.",
      sayHelp: "Ein Wort laut in die Runde, dann „Fertig“ am Handy.",
      /** @param {number} i @param {number} of */
      turnOf: (i, of) => `Hinweis ${i} von ${of}`,
      /** @param {string} name */
      away: (name) => `${name} ist weg`,
      silent: "…",
      awayCard: "weg",
      accuseTitle: "Wer ist der Schwindler?",
      accuseHelp: "Redet drüber, dann beschuldigt am Handy.",
      /** @param {number} k @param {number} of */
      accused: (k, of) => `${k} von ${of} haben beschuldigt`,
      accusedMark: "hat gewählt",
      verdictTitle: "Das Urteil",
      phonyStamp: "Schwindler",
      innocentStamp: "Unschuldig",
      nobodySure: "Keiner ist sich sicher",
      /** @param {string} name */
      phonyWas: (name) => `Der Schwindler war ${name}`,
      caught: "Erwischt!",
      /** @param {string} name */
      lastTitle: (name) => `${name}: die letzte Chance`,
      lastHelp: "Welches Wort war es?",
      /** @param {string} name */
      pickOf: (name) => `${name} tippt auf`,
      theWord: "Das Wort",
      named: "Das Wort erraten!",
      missed: "Daneben!",
      noPick: "Keine Antwort",
      goneTitle: "Der Schwindler ist gegangen",
      goneHelp: "Diese Runde zählt nicht.",
      scoresTitle: "Punkte",
      /** @param {number} r @param {number} of */
      scoresAfter: (r, of) => (r >= of ? "nach der letzten Runde" : `nach Runde ${r} von ${of}`),
      kinds: { accuse: "richtig verdächtigt", team: "erwischt", escape: "entkommen", word: "Wort genannt" },
      gameOver: "Fall abgeschlossen",
      awards: {
        liar: /** @type {[string, (k: number) => string]} */ (["Glattester Lügner", (/** @type {number} */ k) => f.p(k, { one: "# Punkt als Schwindler", other: "# Punkte als Schwindler" })]),
        eye: /** @type {[string, (k: number) => string]} */ (["Schärfster Blick", (/** @type {number} */ k) => f.p(k, { one: "# Treffer", other: "# Treffer" })]),
        hand: /** @type {[string, (k: number) => string]} */ (["Zittrigste Hand", (/** @type {number} */ k) => f.p(k, { one: "# Mal gelöscht", other: "# Mal gelöscht" })]),
      },
      /** @param {number} k */
      points: (k) => f.p(k, { one: "# Punkt", other: "# Punkte" }),
      playAgain: "Der VIP kann eine neue Partie starten",
      reconnecting: "Verbinde neu …",
      over: "Das Spiel ist vorbei",
      n,
    };
  }
  return {
    ...f,
    tagline: "Everyone knows the secret word. Except one.",
    scanToJoin: "Scan to join",
    tickerLine: "One of you is lying",
    boardLabel: "Evidence · 16 words",
    suspects: "Suspects",
    waitingSeat: "wanted",
    freeSeat: "free",
    /** @param {number} k */
    needed: (k) => f.p(k, { one: "# more suspect needed", other: "# more suspects needed" }),
    /** @param {string | undefined} name */
    vipStarts: (name) => (name ? `${name} starts on their phone` : "The VIP starts on their phone"),
    how: [
      ["The card", "Everyone gets the same secret word, except the phony."],
      ["One word", "One at a time, everyone types a clue. The needle sees who hesitates."],
      ["The accusation", "Accuse in secret. Caught? The phony can still name the word."],
    ],
    /** @param {number} r */
    rounds: (r) => f.p(r, { one: "# round", other: "# rounds" }),
    typed: "Clues typed",
    spoken: "Clues out loud",
    /** @param {number} s */
    clueTime: (s) => `${s} s a clue`,
    /** @param {number} s */
    talkTime: (s) => `${s} s to talk`,
    typingOn: "Typing shown",
    typingOff: "Typing hidden",
    /** @param {number} r @param {number} of */
    round: (r, of) => `Round ${r}/${of}`,
    category: "Category",
    dealTitle: "Look at your card",
    dealHelp: "Everyone knows the word, except the phony.",
    /** @param {string} name */
    typing: (name) => `${name} is typing`,
    /** @param {string} name */
    sayIt: (name) => `${name}: say it!`,
    clueHelp: "One word that shows you know the word.",
    sayHelp: "One word out loud, then Done on the phone.",
    /** @param {number} i @param {number} of */
    turnOf: (i, of) => `Clue ${i} of ${of}`,
    /** @param {string} name */
    away: (name) => `${name} is away`,
    silent: "…",
    awayCard: "away",
    accuseTitle: "Who's the phony?",
    accuseHelp: "Talk it over, then accuse on your phone.",
    /** @param {number} k @param {number} of */
    accused: (k, of) => `${k} of ${of} accused`,
    accusedMark: "voted",
    verdictTitle: "The verdict",
    phonyStamp: "Phony",
    innocentStamp: "Innocent",
    nobodySure: "No one is sure",
    /** @param {string} name */
    phonyWas: (name) => `The phony was ${name}`,
    caught: "Caught!",
    /** @param {string} name */
    lastTitle: (name) => `${name}: the last chance`,
    lastHelp: "Which word was it?",
    /** @param {string} name */
    pickOf: (name) => `${name}'s pick`,
    theWord: "The word",
    named: "Named it!",
    missed: "Wrong word!",
    noPick: "No answer",
    goneTitle: "The phony left",
    goneHelp: "This round does not count.",
    scoresTitle: "Scores",
    /** @param {number} r @param {number} of */
    scoresAfter: (r, of) => (r >= of ? "after the last round" : `after round ${r} of ${of}`),
    kinds: { accuse: "sharp accusation", team: "caught", escape: "got away", word: "named the word" },
    gameOver: "Case closed",
    awards: {
      liar: /** @type {[string, (k: number) => string]} */ (["Smoothest liar", (/** @type {number} */ k) => f.p(k, { one: "# point as the phony", other: "# points as the phony" })]),
      eye: /** @type {[string, (k: number) => string]} */ (["Sharpest eye", (/** @type {number} */ k) => f.p(k, { one: "# hit", other: "# hits" })]),
      hand: /** @type {[string, (k: number) => string]} */ (["Shakiest hand", (/** @type {number} */ k) => f.p(k, { one: "# deletion", other: "# deletions" })]),
    },
    /** @param {number} k */
    points: (k) => f.p(k, { one: "# point", other: "# points" }),
    playAgain: "The VIP can start another game",
    reconnecting: "Reconnecting …",
    over: "The game is over",
    n,
  };
}
