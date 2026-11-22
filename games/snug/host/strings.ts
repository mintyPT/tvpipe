/**
 * What the host page says of Snug itself, per language (the room's): the
 * status beside the logo. The page's own texts and the settings' labels
 * are @tvpipe/party's (`HostPage`) and `host.ts`'s.
 */

import type { Phase } from "../game/game.ts";
import type { Lang } from "../game/rules.ts";

const PHASES: Record<Lang, Record<Phase, string>> = {
  en: { lobby: "Lobby", board: "playing", solved: "solved!", over: "time's up", final: "Game over" },
  de: { lobby: "Lobby", board: "läuft", solved: "geschafft!", over: "Zeit um", final: "Spielende" },
};

/** The status beside the logo: the lobby, the end, or the shape and what happens. */
export function status(lang: Lang, phase: Phase, board: number, solved: number): string {
  const p = PHASES[lang] ?? PHASES.en;
  if (phase === "lobby" || phase === "final") return p[phase];
  return `${lang === "de" ? "Form" : "Shape"} ${board} · ${p[phase]} · ${solved} ${lang === "de" ? "geschafft" : "done"}`;
}
