/**
 * What the host page says of Drawbluff itself, per language (the
 * room's): the status beside the logo. The page's own texts and the
 * settings' labels are @tvpipe/party's (`HostPage`) and `host.ts`'s.
 */

import type { Lang } from "../game/rules.ts";

const PHASES: Record<Lang, Record<string, string>> = {
  en: { lobby: "Lobby", final: "Game over", draw: "drawing", gallery: "gallery", lie: "lies", vote: "vote", reveal: "reveal", scores: "scores" },
  de: { lobby: "Lobby", final: "Spiel vorbei", draw: "zeichnen", gallery: "Galerie", lie: "lügen", vote: "abstimmen", reveal: "Auflösung", scores: "Punkte" },
};

/** The status beside the logo: the lobby, the end, or the round and what happens in it. */
export function status(lang: Lang, phase: string, round: number): string {
  const p = PHASES[lang] ?? PHASES.en;
  if (phase === "lobby" || phase === "final") return p[phase]!;
  return `${lang === "de" ? "Runde" : "Round"} ${new Intl.NumberFormat(lang).format(round)} · ${p[phase] ?? phase}`;
}
