/**
 * What the host page says of Busted itself, per language (the room's):
 * the status beside the logo and the editor's desk. The page's own texts
 * and the settings' labels are @tvpipe/party's (`HostPage`) and
 * `host.ts`'s.
 */

import type { Kind, Lang } from "../game/rules.ts";

const STAGES: Record<Lang, Record<string, string>> = {
  en: { lobby: "Lobby", final: "Special edition", scores: "standings", ask: "the question", rank: "ranking", count: "the count", title: "front page", write: "writing", board: "the gossip column", match: "guessing", reveal: "busted!" },
  de: { lobby: "Lobby", final: "Sonderausgabe", scores: "Tabelle", ask: "die Frage", rank: "Abstimmung", count: "Auszählung", title: "Titelseite", write: "Schreiben", board: "Klatschspalte", match: "Raten", reveal: "Erwischt!" },
};

/** The status beside the logo: the lobby, the end, or the round and what happens in it. */
export function status(lang: Lang, phase: string, stage: string | null, round: number, kind: Kind | null): string {
  const p = STAGES[lang] ?? STAGES.en;
  if (phase === "lobby" || phase === "final") return p[phase]!;
  const what = phase === "round" ? (stage ?? "") : phase;
  const k = kind === "vote" ? (lang === "de" ? "Abstimmung" : "vote") : kind === "answer" ? (lang === "de" ? "Antworten" : "answers") : "";
  return `${lang === "de" ? "Runde" : "Round"} ${round}${k && phase === "round" ? ` (${k})` : ""} · ${p[what] ?? what}`;
}

export function deskStrings(lang: Lang) {
  return lang === "de"
    ? {
        desk: "Redaktion",
        skip: "Frage überspringen",
        skipHint: "Solange abgestimmt oder geschrieben wird: eine andere Frage kommt.",
        extras: "Ehrengäste",
        extrasHint: "Bis zu drei, die nicht mitspielen, aber gewählt werden können: der Hund, Oma, wer heute fehlt. Nur vor dem Spiel.",
        extraPlaceholder: "Name",
        add: "Hinzufügen",
        tips: "Leserfragen",
        tipsHint: "Vorschläge der Spieler. Die Runde bewertet sie auf den Handys; was gefällt, wird gespielt. Streichen nimmt eine vom Tisch.",
        noTips: "Noch keine Vorschläge.",
        spike: "Streichen",
        vote: "Wer würde am ehesten",
        answer: "Alle antworten",
        approved: "angenommen",
        pending: "wird bewertet",
      }
    : {
        desk: "The editor's desk",
        skip: "Skip this question",
        skipHint: "While people rank or write: another question comes.",
        extras: "Honorary candidates",
        extrasHint: "Up to three who are not playing but can be voted for: the dog, Grandma, whoever is missing tonight. Before a game only.",
        extraPlaceholder: "Name",
        add: "Add",
        tips: "Readers' questions",
        tipsHint: "Players' suggestions. The room rates them on the phones; the liked ones are played. Spike takes one off the desk.",
        noTips: "No suggestions yet.",
        spike: "Spike",
        vote: "Who would most likely",
        answer: "Everyone answers",
        approved: "approved",
        pending: "being rated",
      };
}
