/**
 * What the host page says of Garble itself, per language (the room's):
 * the status beside the logo. The page's own texts and the settings'
 * labels are @tvpipe/party's (`HostPage`) and `host.ts`'s.
 */

import type { Lang } from "../game/rules.ts";

const PHASES: Record<Lang, Record<string, string>> = {
  en: { lobby: "Lobby", final: "Game over", play: "drawing and guessing", reveal: "reveal", vote: "best move", best: "best move", scores: "scores" },
  de: { lobby: "Lobby", final: "Spielende", play: "zeichnen und raten", reveal: "Auflösung", vote: "bester Zug", best: "bester Zug", scores: "Punkte" },
};

/** The status beside the logo: the lobby, the end, or the round and what happens in it. */
export function status(lang: Lang, phase: string, round: number): string {
  const p = PHASES[lang] ?? PHASES.en;
  if (phase === "lobby" || phase === "final") return p[phase]!;
  return `${lang === "de" ? "Runde" : "Round"} ${round} · ${p[phase] ?? phase}`;
}
