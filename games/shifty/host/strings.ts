/**
 * What the host page says of Shifty itself, per language (the room's):
 * the status beside the logo. The page's own texts and the settings'
 * labels are @tvpipe/party's (`HostPage`) and `host.ts`'s.
 */

import type { Lang } from "../game/rules.ts";

const STAGES: Record<Lang, Record<string, string>> = {
  en: { lobby: "Lobby", final: "Game over", scores: "scores", deal: "the cards", clue: "clues", accuse: "accusing", verdict: "the verdict", last: "the last chance", reveal: "the reveal", gone: "the phony left" },
  de: { lobby: "Lobby", final: "Spielende", scores: "Punkte", deal: "die Karten", clue: "Hinweise", accuse: "Verdacht", verdict: "das Urteil", last: "letzte Chance", reveal: "die Auflösung", gone: "Schwindler weg" },
};

/** The status beside the logo: the lobby, the end, or the round and what happens in it. */
export function status(lang: Lang, phase: string, stage: string | null, round: number): string {
  const p = STAGES[lang] ?? STAGES.en;
  if (phase === "lobby" || phase === "final") return p[phase]!;
  const what = phase === "round" ? (stage ?? "") : phase;
  return `${lang === "de" ? "Runde" : "Round"} ${round} · ${p[what] ?? what}`;
}
