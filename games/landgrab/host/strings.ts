/**
 * What the host page says of Landgrab itself, per language (the room's):
 * the status beside the logo. The page's own texts and the settings'
 * labels are @tvpipe/party's (`HostPage`) and `host.ts`'s.
 */

import type { Lang } from "../game/rules.ts";

const PHASES: Record<Lang, Record<string, string>> = {
  en: { lobby: "Lobby", final: "Game over", plan: "planning", battle: "battle" },
  de: { lobby: "Lobby", final: "Spielende", plan: "Planung", battle: "Schlacht" },
};

/** The status beside the logo: the lobby, the end, or the round and its phase. */
export function status(lang: Lang, phase: string, round: number, rounds: number): string {
  const p = PHASES[lang] ?? PHASES.en;
  if (phase === "lobby" || phase === "final") return p[phase]!;
  return `${lang === "de" ? "Runde" : "Round"} ${round}/${rounds} · ${p[phase] ?? phase}`;
}
