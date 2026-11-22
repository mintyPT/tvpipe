/**
 * What the host page says of Pinch itself, per language (the room's):
 * the status beside the logo and the skip button. The page's own texts
 * are @tvpipe/party's (`HostPage`), the settings' labels `host.ts`'s.
 */

import type { Phase } from "../game/game.ts";
import type { Lang } from "../game/items.ts";

const PHASES: Record<Lang, Record<Phase, string>> = {
  en: { lobby: "Lobby", briefing: "the briefing", heist: "the heist", outcome: "the outcome", tape: "the tape", scores: "the scores", final: "Game over" },
  de: { lobby: "Lobby", briefing: "Lagebesprechung", heist: "der Coup", outcome: "das Ergebnis", tape: "das Band", scores: "Punktestand", final: "Spielende" },
};

/** The status beside the logo: the lobby, the end, or the round, its thief and what happens. */
export function status(lang: Lang, phase: Phase, round: number, rounds: number, thief: string | null): string {
  const p = PHASES[lang] ?? PHASES.en;
  if (phase === "lobby" || phase === "final") return p[phase];
  const who = thief ? (lang === "de" ? ` · ${thief} klaut` : ` · ${thief} steals`) : "";
  return `${lang === "de" ? "Runde" : "Round"} ${round}/${rounds}${who} · ${p[phase]}`;
}

/** The skip button at the tape and the scores. */
export const SKIP = { en: "Skip", de: "Überspringen" } as const;
export const SKIP_LABEL = { en: "The tape and the scores", de: "Band und Punktestand" } as const;
