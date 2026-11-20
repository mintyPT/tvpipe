/**
 * What the host page says, per language: the room's (the Language
 * setting), so the person running the party reads what the players read.
 */

import type { Lang } from "../game/lang.ts";
import type { Phase } from "../game/game.ts";

function format(lang: Lang) {
  const nf = new Intl.NumberFormat(lang);
  return { n: (x: number) => nf.format(x) };
}
type Format = ReturnType<typeof format>;

const en = (f: Format) => ({
  /** The page's fixed texts, by `data-t`. */
  page: {
    onTv: "On the TV",
    copy: "Copy",
    noTv: "No TV: open the preview on a screen yourself.",
    changeTv: "Change TVs…",
    tryAgain: "Try again",
    openTv: "Open the TV view",
    players: "Players",
    addBot: "Add a bot",
    addBots: "Add 3 bots",
    language: "Language",
    rounds: "Rounds",
    roundsAuto: "auto (twice up to 5 players)",
    roundsOnce: "everyone guesses once",
    roundsTwice: "everyone guesses twice",
    writing: "Writing time",
    words: "Words",
    easy: "easy",
    normal: "normal",
    hard: "hard",
    end: "End",
    previewNote: "What the TV shows (a preview, no sound). The VIP's phone can start the game too.",
    previewTitle: "What the TV shows",
  } as Record<string, string>,
  /** "30 s" @param s seconds */
  seconds: (s: number) => `${f.n(s)} s`,
  noWords: (lang: string) => `No words in ${lang} (data files missing)`,
  scanQr: "Phones join with the QR code or the link on the TV",
  lanOnly: "On this Wi-Fi only",
  opening: "Opening a public link…",
  localOnly: "This computer only (no public link)",
  copied: "Copied",
  bot: "bot",
  vip: "VIP",
  waiting: "waiting",
  away: "away",
  remove: (name: string) => `Remove ${name}`,
  removeSure: "Remove?",
  rejoin: "Rejoin code",
  rejoinTitle: (name: string) => `Show ${name} a code to get back in on any phone`,
  makeVip: "Make VIP",
  makeVipTitle: (name: string) => `Make ${name} the VIP`,
  playing: "Playing…",
  waitingMore: (n: number) => `Waiting for ${f.n(n)} more`,
  playAgain: "Play again",
  start: "Start the game",
  browserTab: "A browser tab",
  showing: "showing",
  connected: "connected",
  noTv: "No TV: open the preview on a screen yourself.",
  starting: (to: string[] | undefined) => `Starting${to ? `: ${to.join(", ")}` : ""}…`,
  tvFailed: (e: string) => `The TV failed: ${e}`,
  tvState: (s: string) => `The TV: ${s}`,
  noTvpipe: (msg: string) => `${msg}. Start the game with tvpipe game play.`,
  stopped: "tvpipe stopped: the game is over.",
  botFailed: (msg: string) => `A bot could not join: ${msg}`,
  phases: {
    lobby: "lobby",
    hotseat: "hot seat",
    write: "writing",
    jinx: "jinx check",
    reveal: "reveal",
    verdict: "verdict",
    replay: "replay",
    bank: "the bank",
    end: "game over",
  } as Record<Phase, string>,
  round: (r: number, phase: string) => `round ${f.n(r)} · ${phase}`,
});

type Strings = ReturnType<typeof en>;

const de = (f: Format): Strings => ({
  page: {
    onTv: "Auf dem Fernseher",
    copy: "Kopieren",
    noTv: "Kein Fernseher: Öffne die Vorschau selbst auf einem Bildschirm.",
    changeTv: "Fernseher wechseln…",
    tryAgain: "Nochmal versuchen",
    openTv: "TV-Ansicht öffnen",
    players: "Mitspielende",
    addBot: "Bot dazu",
    addBots: "3 Bots dazu",
    language: "Sprache",
    rounds: "Runden",
    roundsAuto: "automatisch (zweimal bis 5 Leute)",
    roundsOnce: "alle raten einmal",
    roundsTwice: "alle raten zweimal",
    writing: "Schreibzeit",
    words: "Wörter",
    easy: "leicht",
    normal: "normal",
    hard: "schwer",
    end: "Beenden",
    previewNote: "Was der Fernseher zeigt (Vorschau, ohne Ton). Das Handy des VIP kann das Spiel auch starten.",
    previewTitle: "Was der Fernseher zeigt",
  },
  seconds: (s) => `${f.n(s)} s`,
  noWords: (lang) => `Keine Wörter auf ${lang} (Datendateien fehlen)`,
  scanQr: "Handys kommen per QR-Code oder über den Link auf dem Fernseher rein",
  lanOnly: "Nur in diesem WLAN",
  opening: "Öffne einen öffentlichen Link…",
  localOnly: "Nur dieser Computer (kein öffentlicher Link)",
  copied: "Kopiert",
  bot: "Bot",
  vip: "VIP",
  waiting: "wartet",
  away: "weg",
  remove: (name) => `${name} entfernen`,
  removeSure: "Entfernen?",
  rejoin: "Rückkehrcode",
  rejoinTitle: (name) => `${name} einen Code zeigen, um mit jedem Handy zurückzukommen`,
  makeVip: "Zum VIP",
  makeVipTitle: (name) => `${name} zum VIP machen`,
  playing: "Läuft…",
  waitingMore: (n) => `Es fehlen noch ${f.n(n)}`,
  playAgain: "Nochmal spielen",
  start: "Spiel starten",
  browserTab: "Ein Browser-Tab",
  showing: "zeigt an",
  connected: "verbunden",
  noTv: "Kein Fernseher: Öffne die Vorschau selbst auf einem Bildschirm.",
  starting: (to) => `Starte${to ? `: ${to.join(", ")}` : ""}…`,
  tvFailed: (e) => `Der Fernseher streikt: ${e}`,
  tvState: (s) => `Fernseher: ${s}`,
  noTvpipe: (msg) => `${msg}. Starte das Spiel mit tvpipe game play.`,
  stopped: "tvpipe wurde beendet: Das Spiel ist vorbei.",
  botFailed: (msg) => `Ein Bot kam nicht rein: ${msg}`,
  phases: {
    lobby: "Lobby",
    hotseat: "heißer Stuhl",
    write: "schreiben",
    jinx: "Jinx-Check",
    reveal: "aufdecken",
    verdict: "Auflösung",
    replay: "Wiederholung",
    bank: "die Bank",
    end: "Spiel vorbei",
  },
  round: (r, phase) => `Runde ${f.n(r)} · ${phase}`,
});

/** The host page's strings in a language. */
export function strings(lang: Lang): Strings {
  return (lang === "de" ? de : en)(format(lang));
}
