// @ts-check
/**
 * The TV's own small words (the chrome around game/words.ts): the
 * lobby's labels, the top bar, the scores and the end, the tape's
 * on-screen display, the map's printed words. Everything with jokes in
 * it (ticker, captions, intertitles, outcomes, awards, estates) is in
 * game/words.ts. English and German, written separately.
 */

/** @typedef {"en" | "de"} Lang */

/** The map's printed and crayon words (draw.js MapWords), uppercase. */
const MAP_EN = {
  glass: "CRASH", lamp: "POP", firecracker: "BANG", alarm: "ALARM", held: "HELD", ping: "GPS PING", missing: "MISSING",
  pinched: "PINCHED", gotAway: "GOT AWAY", static: "STATIC", camera: "CAMERA", clear: "CLEAR", seen: "SEEN", post: "POST", look: "LOOK",
};
const MAP_DE = {
  glass: "KLIRR", lamp: "PLOPP", firecracker: "KNALL", alarm: "ALARM", held: "GESTELLT", ping: "GPS-PING", missing: "WEG",
  pinched: "GESCHNAPPT", gotAway: "WEG IST ER", static: "RAUSCHEN", camera: "KAMERA", clear: "LEER", seen: "GESEHEN", post: "POSTEN", look: "HIER",
};

const EN = {
  lang: /** @type {Lang} */ ("en"),
  scan: "Scan to join",
  orOpen: "or open",
  players: "On the guest list",
  need: (/** @type {number} */ n) => (n === 1 ? "One more guest and we can begin." : `${n} more guests and we can begin.`),
  vipStarts: (/** @type {string} */ name) => `${name} starts the night from their phone.`,
  nobody: "Nobody yet. The silver waits.",
  heist: "Heist",
  rounds: (/** @type {number} */ r) => /** @type {string} */ (r === 2 ? "everyone is the thief twice" : "everyone is the thief once"),
  round: (/** @type {number} */ n, /** @type {number} */ of) => (of > 0 ? `Round ${n} of ${of}` : `Round ${n}`),
  isThief: "is the thief",
  security: "Everyone else is house security.",
  briefing: "The catalogue is public. Where things are is not.",
  police: "POLICE",
  noSignal: "NO SIGNAL",
  tracking: "TRACKING",
  stop: "STOP",
  getaway: "GETAWAY CAR",
  carried: "In the sack",
  confiscated: "Returned to the owners",
  nothing: "Nothing. Not even a spoon.",
  rewards: "Rewards",
  noRewards: "No rewards tonight.",
  totals: "The books",
  nextUp: (/** @type {string} */ name) => `Next with the sack: ${name}`,
  lastRound: "That was the last round.",
  rounds2: "Round by round",
  awards: "Awards",
  reconnecting: "Reconnecting…",
  over: "The night is over.",
  map: MAP_EN,
};

/** @type {typeof EN} */
const DE = {
  lang: "de",
  scan: "Scannen und mitmachen",
  orOpen: "oder öffne",
  players: "Auf der Gästeliste",
  need: (n) => (n === 1 ? "Noch ein Gast, dann geht es los." : `Noch ${n} Gäste, dann geht es los.`),
  vipStarts: (name) => `${name} eröffnet die Nacht am Handy.`,
  nobody: "Noch niemand da. Das Silber wartet.",
  heist: "Einbruch",
  rounds: (r) => (r === 2 ? "jeder klaut zweimal" : "jeder klaut einmal"),
  round: (n, of) => (of > 0 ? `Runde ${n} von ${of}` : `Runde ${n}`),
  isThief: "hat heute den Sack",
  security: "Alle anderen schieben Wache.",
  briefing: "Der Katalog ist öffentlich. Wo die Sachen liegen, nicht.",
  police: "POLIZEI",
  noSignal: "KEIN SIGNAL",
  tracking: "SPURLAGE",
  stop: "STOP",
  getaway: "FLUCHTWAGEN",
  carried: "Im Sack",
  confiscated: "Zurück an die Besitzer",
  nothing: "Nichts. Nicht mal ein Löffel.",
  rewards: "Belohnungen",
  noRewards: "Heute keine Belohnung.",
  totals: "Die Bücher",
  nextUp: (name) => `Als Nächstes mit dem Sack: ${name}`,
  lastRound: "Das war die letzte Runde.",
  rounds2: "Runde für Runde",
  awards: "Auszeichnungen",
  reconnecting: "Verbinde neu…",
  over: "Die Nacht ist vorbei.",
  map: MAP_DE,
};

/** @param {unknown} lang @returns {typeof EN} */
export function strings(lang) {
  return lang === "de" ? DE : EN;
}

/** @param {unknown} lang @returns {Lang} */
export function pickLang(lang) {
  if (lang === "de" || lang === "en") return lang;
  try {
    return navigator.language?.toLowerCase().startsWith("de") ? "de" : "en";
  } catch {
    return "en";
  }
}
