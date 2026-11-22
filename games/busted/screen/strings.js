// @ts-check
/**
 * What the TV says, in English and German: the masthead, the headlines,
 * the captions. Players' texts never come from here.
 */

import { format } from "../phone/i18n.js";

/** @param {"en" | "de"} lang */
export function strings(lang) {
  const f = format(lang);
  const de = lang === "de";
  const weekday = new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return {
    ...f,
    masthead: de ? "Der Busted-Bote" : "The Daily Busted",
    motto: de ? "„Alles, was ihr nie über euch wissen wolltet.“" : "“All the news that's fit to guess.”",
    /** @param {number} n */
    issue: (n) => (de ? `Jahrgang I · Nr. ${n}` : `Vol. I · No. ${n}`),
    date: () => weekday.format(new Date()),
    edition: de ? "Spätausgabe" : "Late edition",
    price: de ? "Preis: ein Lacher" : "Price: one laugh",
    tonight: de ? "Heute Abend" : "Tonight",
    /** @param {number} n */
    readers: (n) => (de ? `${n} ${n === 1 ? "Leser" : "Leser"}` : f.p(n, { one: "# reader", other: "# readers" })),
    weather: de ? "Wetter: Klatsch, 100 %" : "Weather: gossip, 100%",
    /** @param {number} r @param {number} of */
    roundOf: (r, of) => (de ? `Runde ${r} von ${of}` : `Round ${r} of ${of}`),
    // Lobby
    extra: de ? "Extrablatt! Extrablatt!" : "Extra! Extra!",
    wanted: de ? "Reporter gesucht" : "Reporters wanted",
    lobbyDeck: de ? "Coupon scannen, ein Pressefoto von dir zeichnen und herausfinden, was deine Freunde wirklich über dich denken." : "Scan the coupon, draw your press photo, and find out what your friends really think of you.",
    clip: de ? "Ausschneiden & scannen" : "Clip & scan",
    orType: de ? "oder eintippen:" : "or type:",
    staff: de ? "Unsere Reporter" : "Our reporters",
    honorary: de ? "Ehrengast" : "Honorary",
    noStaff: de ? "Noch niemand in der Redaktion." : "The newsroom is empty.",
    /** @param {number} n */
    needMore: (n) => (de ? `Noch ${n === 1 ? "eine Person" : `${n} Leute`}, dann geht's los.` : `${f.p(n, { one: "One more reporter", other: "# more reporters" })} and we go to press.`),
    ready: de ? "Der VIP startet die erste Ausgabe." : "The VIP starts the first edition.",
    howTitle: de ? "So geht's" : "How it works",
    how: de
      ? [
          ["Wer würde am ehesten …?", "Alle wählen heimlich Gold, Silber und Bronze. Wer die meisten Punkte holt, kommt mit Titel auf die Titelseite."],
          ["Alle antworten", "Eine Frage, anonyme Antworten auf dem Fernseher. Rate, wer was geschrieben hat; wer richtig rät, punktet, wer täuscht, auch."],
          ["Leserfragen", "Schick eigene Fragen ein. Was der Runde gefällt, kommt ins Blatt, sonst nehmen wir unsere."],
        ]
      : [
          ["Who would most likely …?", "Everyone secretly ranks gold, silver and bronze. The most points make the front page, with a title."],
          ["Everyone answers", "One question, anonymous answers on the TV. Guess who wrote what: a right guess scores, and so does fooling the room."],
          ["Readers' questions", "Send in your own questions. The ones the room likes go to print; otherwise we use ours."],
        ],
    /** @param {number} n */
    inbox: (n) => (de ? `${n === 1 ? "Eine Leserfrage" : `${n} Leserfragen`} auf dem Tisch` : `${f.p(n, { one: "One reader's question", other: "# readers' questions" })} on the desk`),
    // Rounds
    poll: de ? "Umfrage des Tages" : "Poll of the day",
    askRoom: de ? "Die Runde fragt" : "Ask the room",
    /** @param {string} name */
    readerQ: (name) => (de ? `Leserfrage von ${name}` : `A reader's question from ${name}`),
    suspects: de ? "Die Verdächtigen" : "The suspects",
    rankHint: de ? "Am Handy: Gold, Silber, Bronze. Geheim." : "On your phone: gold, silver, bronze. In secret.",
    rankHint2: de ? "Am Handy: Gold und Silber. Geheim." : "On your phone: gold and silver. In secret.",
    answerHint: de ? "Alle antworten am Handy. Dann wird geraten, wer was geschrieben hat." : "Everyone answers on their phone. Then guess who wrote what.",
    /** @param {number} n */
    answerHint2: (n) => (de ? `Alle schreiben ${n} Antworten am Handy. Dann wird geraten.` : `Everyone writes ${n} answers on their phone. Then guess who wrote what.`),
    press: de ? "Andruck in" : "Goes to press in",
    filed: de ? "Abgegeben" : "Filed",
    letters: de ? "Leserbriefe" : "Letters to the editor",
    /** @param {number} a @param {number} b */
    inOf: (a, b) => (de ? `${a} von ${b} eingegangen` : `${a} of ${b} in`),
    // Count
    count: de ? "Die Auszählung" : "The count",
    /** @param {number} i @param {number} n */
    ballot: (i, n) => (de ? `Stimmzettel ${i} von ${n}` : `Ballot ${i} of ${n}`),
    secretBallot: de ? "Geheim" : "Secret ballot",
    noBallots: de ? "Keine Stimmen." : "No ballots.",
    winner: de ? "Sieg" : "Winner",
    pts: de ? "Pkt." : "pts",
    // Title
    exclusive: de ? "Exklusiv" : "Exclusive",
    shared: de ? "Geteilter Titel" : "A shared title",
    /** @param {number} g @param {number} n */
    sources: (g, n) => (de ? `${g} von ${n} Quellen gaben Gold.` : `${g} of ${n} sources gave gold.`),
    /** @param {string} q */
    asked: (q) => (de ? `Auf die Frage „${q}“ war die Antwort klar.` : `Asked “${q}”, the room had its answer.`),
    pictured: de ? "Im Bild:" : "Pictured:",
    pictureNote: de ? "kurz nach der Abstimmung" : "moments after the vote",
    noComment: de ? "Kein Kommentar" : "No comment",
    silent: de ? "Die Runde schwieg. Die Redaktion ist ratlos." : "The room stayed silent. The editors are baffled.",
    // Gossip column
    column: de ? "Die Klatschspalte" : "The gossip column",
    columnHint: de ? "Wer hat was geschrieben? Gleich am Handy zuordnen." : "Who wrote what? Match them on your phone next.",
    matchHint: de ? "Am Handy zuordnen: jede Antwort ihrem Namen. Ein Herz für die beste." : "Match on your phone: each answer to its writer. A heart for the best.",
    guesses: de ? "Tipps abgegeben" : "Guesses filed",
    /** @param {number} n */
    no: (n) => (de ? `Nr. ${n}` : `No. ${n}`),
    // Reveal
    whoWrote: de ? "Wer hat's geschrieben?" : "Who wrote it?",
    /** @param {number} i @param {number} n */
    tip: (i, n) => (de ? `Notiz ${i} von ${n}` : `Note ${i} of ${n}`),
    busted: de ? "Erwischt!" : "Busted!",
    gotAway: de ? "Entwischt" : "Got away",
    noGuess: de ? "Niemand hat getippt" : "Nobody guessed",
    // Scores
    standings: de ? "Die Tabelle" : "The standings",
    /** @param {number} r */
    afterRound: (r) => (de ? `Nach Runde ${r}` : `After round ${r}`),
    nextVote: de ? "Als Nächstes: Wer würde am ehesten …?" : "Next up: Who would most likely …?",
    nextAnswer: de ? "Als Nächstes: Alle antworten" : "Next up: Everyone answers",
    lastRound: de ? "Gleich: die Sonderausgabe" : "Coming up: the special edition",
    // Final
    special: de ? "Sonderausgabe" : "Special edition",
    /** @param {string} name */
    knows: (name) => (de ? `${name} kennt die Runde am besten` : `${name} knows the room best`),
    finalDeck: de ? "Alle Titel, alle Zitate: die Titelblätter des Abends am Kiosk." : "Every title, every quote: tonight's covers on the newsstand.",
    noWinner: de ? "Alle gleichauf" : "Nobody ahead",
    awards: {
      knows: de ? "Kennt die Runde" : "Knows the room",
      titles: de ? "Meiste Titel" : "Most titles",
      disguise: de ? "Meister der Verkleidung" : "Master of disguise",
      fans: de ? "Liebling der Leser" : "Readers' favourite",
      reporter: de ? "Starreporter" : "Star reporter",
    },
    /** @param {string} k @param {number} n */
    awardLine: (k, n) => {
      if (k === "knows") return de ? `${n} Punkte` : f.p(n, { one: "# point", other: "# points" });
      if (k === "titles") return de ? `${n} Titel` : f.p(n, { one: "# title", other: "# titles" });
      if (k === "disguise") return de ? `${n}× getäuscht` : f.p(n, { one: "fooled # time", other: "fooled # times" });
      if (k === "fans") return de ? `${n} ♥` : `${n} ♥`;
      return de ? `${n} Leserfrage${n === 1 ? "" : "n"} gedruckt` : f.p(n, { one: "# question printed", other: "# questions printed" });
    },
    newsstand: de ? "Am Kiosk" : "On the newsstand",
    coverMast: "BUSTED!",
    noTitles: de ? "Ohne Titel. Noch." : "No titles. Yet.",
    /** @param {number} n */
    points: (n) => (de ? `${n} Punkte` : f.p(n, { one: "# point", other: "# points" })),
  };
}

/** @typedef {ReturnType<typeof strings>} Strings */
