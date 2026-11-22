/**
 * What the host page says of Crosstalk itself, per language (the room's):
 * the status beside the logo, Start's label after a game, the players'
 * tags. The page's own texts and the settings' labels are @tvpipe/party's
 * (`HostPage`) and `host.ts`'s.
 */

import type { Lang, Team } from "../game/rules.ts";
import type { Phase } from "../game/views.ts";

const PHASES: Record<Lang, Record<Phase, string>> = {
  en: { lobby: "Lobby", intro: "the rules", clue: "clues", guess: "guessing", round: "between rounds", end: "Game over" },
  de: { lobby: "Lobby", intro: "die Regeln", clue: "Hinweise", guess: "raten", round: "zwischen den Runden", end: "Spielende" },
};

/** The status beside the logo: the lobby, the end, or the round and what happens in it. */
export function status(lang: Lang, phase: Phase, round: number): string {
  const p = PHASES[lang] ?? PHASES.en;
  if (phase === "lobby" || phase === "end" || round === 0) return p[phase];
  return `${lang === "de" ? "Runde" : "Round"} ${round} · ${p[phase]}`;
}

export function strings(lang: Lang) {
  const de = lang === "de";
  return {
    playAgain: de ? "Nochmal spielen" : "Play again",
    team: (t: Team) => (de ? (t === "red" ? "Rot" : "Blau") : t === "red" ? "Red" : "Blue"),
    spymaster: de ? "Spionchef" : "spymaster",
    bot: "bot",
    noWords: de ? "Die deutschen Wörter fehlen" : "The English words are missing",
  };
}
