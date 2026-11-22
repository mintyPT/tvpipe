// @ts-check
/**
 * What Landgrab's TV says, in English and German (the room's language).
 * Territory and continent names come from the world (`data/world.txt`).
 */

import { format } from "../phone/i18n.js";

/** @param {"en" | "de"} lang */
export function strings(lang) {
  const f = format(lang);
  const de = lang === "de";
  return {
    ...f,
    tagline: de ? "Plant gleichzeitig. Kämpft auf dem Fernseher." : "Plan together. Fight on the TV.",
    scanToJoin: de ? "Scannen zum Mitspielen" : "Scan to join",
    generals: de ? "Feldherren" : "Generals",
    waitingSeat: de ? "fehlt noch" : "needed",
    freeSeat: de ? "frei" : "free",
    needed: (/** @type {number} */ n) => (de ? f.p(n, { one: "Noch # Person fehlt", other: "Noch # Leute fehlen" }) : f.p(n, { one: "# more player needed", other: "# more players needed" })),
    vipStarts: (/** @type {string | undefined} */ name) => (de ? `${name ?? "Der VIP"} startet das Spiel` : `${name ?? "The VIP"} starts the game`),
    rounds: (/** @type {number} */ n) => (de ? `${n} Runden` : `${n} rounds`),
    planTime: (/** @type {number} */ n) => (de ? `${n} s planen` : `${n} s to plan`),
    how: de
      ? [
          ["Planen", "Alle gleichzeitig am Handy: Armeen verteilen, Angriffe befehlen."],
          ["Schlacht", "Der Fernseher spielt alle Befehle ab, mit Würfeln."],
          ["Erobern", "Ganze Kontinente bringen Verstärkung. Die meisten Gebiete gewinnen."],
        ]
      : [
          ["Plan", "Everyone at once on their phone: place armies, order attacks."],
          ["Battle", "The TV plays every order out, with dice."],
          ["Conquer", "Whole continents bring more armies. Most territories wins."],
        ],
    roundWord: de ? "Runde" : "Round",
    planWord: de ? "Planen" : "Plan",
    toBattle: de ? "Zur Schlacht!" : "To battle!",
    orders: (/** @type {number} */ n) => (de ? f.p(n, { one: "# Befehl", other: "# Befehle" }) : f.p(n, { one: "# order", other: "# orders" })),
    lastRound: de ? "Letzte Runde!" : "Last round!",
    scanHint: de ? "Kamera aufs Handy, Code scannen, Namen eintippen" : "Point your phone's camera here and pick a name",
    uprising: de ? "Aufstand!" : "Uprising!",
    risesIn: (/** @type {string} */ who, /** @type {string} */ where) => (de ? `${who} erhebt sich in ${where}` : `${who} rises in ${where}`),
    attacker: de ? "Angriff" : "Attack",
    defender: de ? "Verteidigung" : "Defence",
    bothFall: de ? "Beide fallen!" : "Both fall!",
    holdsAll: (/** @type {string} */ who, /** @type {string} */ c) => (de ? `${who} hält ganz ${c}!` : `${who} holds all of ${c}!`),
    perRound: (/** @type {number} */ b) => (de ? `+${b} Armeen pro Runde` : `+${b} armies every round`),
    comesBack: de ? "Kommt nächste Runde als Rebell zurück" : "Back next round as a rebel",
    round: (/** @type {number} */ r, /** @type {number} */ of) => (de ? `Runde ${r} von ${of}` : `Round ${r} of ${of}`),
    planNow: de ? "Plant eure Züge!" : "Plan your moves!",
    planSub: de ? "Am Handy: Armeen verteilen, Angriffe befehlen" : "On your phone: place armies, give orders",
    allReady: de ? "Alle bereit!" : "Everyone's ready!",
    battle: de ? "Schlacht" : "Battle",
    reinforce: de ? "Verstärkung" : "Reinforcements",
    lands: de ? "Gebiete" : "Lands",
    armies: de ? "Armeen" : "Armies",
    ready: de ? "bereit" : "ready",
    out: de ? "ausgelöscht" : "wiped out",
    wild: de ? "Wildnis" : "Wild lands",
    vs: "vs",
    attacks: de ? "greift an" : "attacks",
    conquered: de ? "Erobert!" : "Conquered!",
    held: de ? "Gehalten!" : "Held!",
    clash: de ? "Zusammenstoß!" : "Head-on clash!",
    marches: de ? "marschiert" : "marches",
    continent: (/** @type {string} */ c, /** @type {string} */ who, /** @type {number} */ b) => (de ? `${who} hält ganz ${c}! +${b} pro Runde` : `${who} holds all of ${c}! +${b} a round`),
    wipedOut: (/** @type {string} */ who) => (de ? `${who} wurde ausgelöscht!` : `${who} is wiped out!`),
    rebels: (/** @type {string} */ who, /** @type {string} */ where) => (de ? `Aufstand! ${who} erhebt sich in ${where}` : `Uprising! ${who} rises in ${where}`),
    stars: de ? "Sterne für Eroberer" : "Stars for conquerors",
    winner: (/** @type {string} */ who) => (de ? `${who} erobert die Welt!` : `${who} takes the world!`),
    byDomination: de ? "Drei Viertel der Welt!" : "Three quarters of the world!",
    byRounds: de ? "Nach der letzten Runde" : "After the last round",
    byPlayers: de ? "Zu wenige Feldherren übrig" : "Too few generals left",
    awards: {
      conqueror: de ? ["Eroberer", "Gebiete erobert"] : ["Conqueror", "territories taken"],
      warlord: de ? ["Kriegsherr", "Armeen besiegt"] : ["Warlord", "armies beaten"],
      giant: de ? ["Riesentöter", "Armeen in einer Schlacht"] : ["Giant slayer", "armies in one battle"],
      phoenix: de ? ["Phönix", "mal wieder auferstanden"] : ["Phoenix", "times risen again"],
    },
    reconnecting: de ? "Verbindung weg …" : "Reconnecting …",
    over: de ? "Spiel beendet" : "Game over",
  };
}
