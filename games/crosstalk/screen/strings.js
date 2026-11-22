// @ts-check
/**
 * What Crosstalk's TV says, per language (the room's: `screen.lang`).
 * Names, words, clues and pad lines are passed in and rendered as text.
 */

import { format } from "../phone/i18n.js";

/** @typedef {"red" | "blue"} Team */
/** @typedef {"neutral" | "theirs" | "assassin" | "used" | "pass" | "timeout" | "no-clue" | "nobody" | "found"} Stop */

/** @param {import("../phone/i18n.js").Format} f */
const en = (f) => {
  /** @type {Record<Team, string>} */
  const team = { red: "Red", blue: "Blue" };
  return {
    n: f.n,
    reconnecting: "Reconnecting…",
    over: "The game has ended.",
    team,
    // Lobby
    tagline: "Two teams. One board. Every word overheard.",
    scanToJoin: "Scan to play",
    orType: "or type",
    spymaster: "Spymaster",
    vip: "VIP",
    emptySeat: "free line",
    needed: (/** @type {number} */ n) => f.p(n, { one: "# more player to start", other: "# more players to start" }),
    vipStarts: (/** @type {string | undefined} */ name) => (name ? `${name} starts the game on the phone` : "The VIP starts the game"),
    switchHint: "Switch teams and volunteer as spymaster on your phone",
    how: [
      ["Two spymasters", "Each sends a secret clue that only reaches their team's phones."],
      ["Both teams guess at once", "Each step, both lock a card. They turn together."],
      ["Talk all you like", "But the other team is listening."],
    ],
    clueTime: (/** @type {number} */ s) => `Clues: ${f.n(s)} s`,
    stepTime: (/** @type {number} */ s) => `Per card: ${f.n(s)} s`,
    deal: { tangled: "Tangled board", mixed: "Mixed board" },
    difficulty: { easy: "Easy words", normal: "Normal words", hard: "Hard words" },
    // Intro
    rulesTitle: "The room's rules",
    rules: [
      ["Talk all you like.", "The other team can hear every word."],
      ["Spymasters say nothing.", "No faces, no pointing, no sighs."],
      ["Clues go to your team's phones only.", "The other team never sees them."],
      ["Each step, both teams lock one card.", "They turn over together."],
    ],
    spymasterOf: (/** @type {Team} */ t) => `${team[t]}'s spymaster`,
    startsIn: "First clues in",
    // In the game
    round: (/** @type {number} */ n) => `Round ${f.n(n)}`,
    step: (/** @type {number} */ n) => `Step ${f.n(n)}`,
    cluesPhase: "Clues",
    turning: "Turning…",
    roundDone: "Round over",
    roundOver: (/** @type {number} */ n) => `Round ${f.n(n)} is over`,
    nobody: "nobody",
    thinking: (/** @type {string} */ name) => (name ? `${name} is thinking…` : "Thinking…"),
    ready: "Clue sent ✓",
    guessing: "Guessing…",
    locked: "Locked ✓",
    /** @type {Record<Stop, string>} */
    stop: {
      neutral: "Done: a neutral card",
      theirs: "Done: one of theirs",
      assassin: "The assassin!",
      used: "Done: clue used up",
      pass: "Passed",
      timeout: "Done: time ran out",
      "no-clue": "No clue this round",
      nobody: "Nobody there",
      found: "All 8 found!",
    },
    callout: {
      right: (/** @type {Team} */ t) => `${team[t]} found one!`,
      neutral: (/** @type {Team} */ t) => `${team[t]}: neutral`,
      theirs: (/** @type {Team} */ t, /** @type {Team} */ o) => `${team[t]} hit one of ${team[o]}'s!`,
      assassin: (/** @type {Team} */ t) => `${team[t]} hit the assassin!`,
      pass: (/** @type {Team} */ t) => `${team[t]} passes`,
      timeout: (/** @type {Team} */ t) => `${team[t]}: time's up`,
      nobody: (/** @type {Team} */ t) => `${team[t]}: nobody there`,
    },
    foundThisRound: "this round",
    nothingThisRound: "nothing turned",
    // The end
    theKey: "The key",
    theClues: "The clues",
    thePads: "The pads",
    theResult: "The result",
    padOf: (/** @type {Team} */ t) => `${team[t]}'s pad`,
    emptyPad: "Nothing written.",
    noClues: "No clues.",
    roundShort: (/** @type {number} */ n) => `R${f.n(n)}`,
    wins: (/** @type {Team} */ t) => `${team[t]} wins!`,
    draw: "A draw!",
    gameOver: "Game over",
    /** @type {(winner: Team | null, reason: string | null, extra: { bothAssassin: boolean }) => string} */
    reason: (w, r, x) => {
      const o = w === "red" ? "blue" : "red";
      switch (r) {
        case "found":
          return w ? `${team[w]} turned all 8 of its cards.` : "";
        case "assassin":
          return w ? `${team[o]} turned the assassin.` : "";
        case "fewer-mistakes":
          return w ? `Both teams finished in the same step: ${team[w]} made fewer mistakes.` : "";
        case "draw":
          return x.bothAssassin ? "Both teams turned the assassin in the same step." : "Both teams finished in the same step, with as many mistakes.";
        case "too-few":
          return "Too few players left to go on.";
        default:
          return "";
      }
    },
    cards: (/** @type {number} */ n) => f.p(n, { one: "# card", other: "# cards" }),
    mistakes: (/** @type {number} */ n) => f.p(n, { one: "# mistake", other: "# mistakes" }),
    nextSpymaster: "Next spymaster",
    playAgain: (/** @type {string | undefined} */ name) => (name ? `${name} starts the next game on the phone` : "The VIP starts the next game"),
  };
};

/** @param {import("../phone/i18n.js").Format} f @returns {ReturnType<typeof en>} */
const de = (f) => {
  /** @type {Record<Team, string>} */
  const team = { red: "Rot", blue: "Blau" };
  return {
    n: f.n,
    reconnecting: "Verbindung wird wiederhergestellt…",
    over: "Das Spiel ist vorbei.",
    team,
    tagline: "Zwei Teams. Ein Spielfeld. Jedes Wort wird mitgehört.",
    scanToJoin: "Scannen und mitspielen",
    orType: "oder eintippen",
    spymaster: "Spionchef",
    vip: "VIP",
    emptySeat: "freie Leitung",
    needed: (/** @type {number} */ n) => f.p(n, { one: "Noch # Person zum Start", other: "Noch # Leute zum Start" }),
    vipStarts: (/** @type {string | undefined} */ name) => (name ? `${name} startet das Spiel am Handy` : "Der VIP startet das Spiel"),
    switchHint: "Am Handy: Team wechseln oder Spionchef werden",
    how: [
      ["Zwei Spionchefs", "Jeder schickt einen geheimen Hinweis, nur aufs Handy des eigenen Teams."],
      ["Beide Teams raten gleichzeitig", "Jeder Schritt: Beide loggen eine Karte ein. Sie drehen sich zusammen um."],
      ["Redet, so viel ihr wollt", "Aber das andere Team hört mit."],
    ],
    clueTime: (/** @type {number} */ s) => `Hinweise: ${f.n(s)} s`,
    stepTime: (/** @type {number} */ s) => `Pro Karte: ${f.n(s)} s`,
    deal: { tangled: "Verwobenes Spielfeld", mixed: "Gemischtes Spielfeld" },
    difficulty: { easy: "Leichte Wörter", normal: "Normale Wörter", hard: "Schwere Wörter" },
    rulesTitle: "Die Regeln im Raum",
    rules: [
      ["Redet, so viel ihr wollt.", "Das andere Team hört jedes Wort mit."],
      ["Spionchefs schweigen.", "Keine Mienen, kein Zeigen, kein Seufzen."],
      ["Hinweise kommen nur aufs Handy eures Teams.", "Das andere Team sieht sie nie."],
      ["Jeder Schritt: Beide Teams loggen eine Karte ein.", "Sie werden gleichzeitig umgedreht."],
    ],
    spymasterOf: (/** @type {Team} */ t) => `Spionchef ${team[t]}`,
    startsIn: "Erste Hinweise in",
    round: (/** @type {number} */ n) => `Runde ${f.n(n)}`,
    step: (/** @type {number} */ n) => `Schritt ${f.n(n)}`,
    cluesPhase: "Hinweise",
    turning: "Umdrehen…",
    roundDone: "Runde vorbei",
    roundOver: (/** @type {number} */ n) => `Runde ${f.n(n)} ist vorbei`,
    nobody: "niemand",
    thinking: (/** @type {string} */ name) => (name ? `${name} überlegt…` : "Überlegt…"),
    ready: "Hinweis ist raus ✓",
    guessing: "Rät…",
    locked: "Eingeloggt ✓",
    stop: {
      neutral: "Fertig: neutrale Karte",
      theirs: "Fertig: Karte der anderen",
      assassin: "Der Attentäter!",
      used: "Fertig: Hinweis ausgereizt",
      pass: "Gepasst",
      timeout: "Fertig: Zeit abgelaufen",
      "no-clue": "Kein Hinweis diese Runde",
      nobody: "Niemand da",
      found: "Alle 8 gefunden!",
    },
    callout: {
      right: (/** @type {Team} */ t) => `Treffer für ${team[t]}!`,
      neutral: (/** @type {Team} */ t) => `${team[t]}: neutral`,
      theirs: (/** @type {Team} */ t, /** @type {Team} */ o) => `${team[t]} erwischt eine von ${team[o]}!`,
      assassin: (/** @type {Team} */ t) => `${team[t]} trifft den Attentäter!`,
      pass: (/** @type {Team} */ t) => `${team[t]} passt`,
      timeout: (/** @type {Team} */ t) => `${team[t]}: Zeit um`,
      nobody: (/** @type {Team} */ t) => `${team[t]}: niemand da`,
    },
    foundThisRound: "diese Runde",
    nothingThisRound: "nichts umgedreht",
    theKey: "Die Lösung",
    theClues: "Die Hinweise",
    thePads: "Die Notizblöcke",
    theResult: "Das Ergebnis",
    padOf: (/** @type {Team} */ t) => `Block von ${team[t]}`,
    emptyPad: "Nichts notiert.",
    noClues: "Keine Hinweise.",
    roundShort: (/** @type {number} */ n) => `R${f.n(n)}`,
    wins: (/** @type {Team} */ t) => `${team[t]} gewinnt!`,
    draw: "Unentschieden!",
    gameOver: "Spielende",
    reason: (w, r, x) => {
      const o = w === "red" ? "blue" : "red";
      switch (r) {
        case "found":
          return w ? `${team[w]} hat alle 8 Karten umgedreht.` : "";
        case "assassin":
          return w ? `${team[o]} hat den Attentäter umgedreht.` : "";
        case "fewer-mistakes":
          return w ? `Beide Teams sind im selben Schritt fertig: ${team[w]} hat weniger Fehler gemacht.` : "";
        case "draw":
          return x.bothAssassin ? "Beide Teams haben im selben Schritt den Attentäter umgedreht." : "Beide Teams sind im selben Schritt fertig, mit gleich vielen Fehlern.";
        case "too-few":
          return "Zu wenige Leute übrig, um weiterzuspielen.";
        default:
          return "";
      }
    },
    cards: (/** @type {number} */ n) => f.p(n, { one: "# Karte", other: "# Karten" }),
    mistakes: (/** @type {number} */ n) => f.p(n, { one: "# Fehler", other: "# Fehler" }),
    nextSpymaster: "Nächster Spionchef",
    playAgain: (/** @type {string | undefined} */ name) => (name ? `${name} startet das nächste Spiel am Handy` : "Der VIP startet das nächste Spiel"),
  };
};

/** @param {"en" | "de"} lang */
export function strings(lang) {
  const f = format(lang);
  return lang === "de" ? de(f) : en(f);
}

/** @typedef {ReturnType<typeof strings>} Strings */
