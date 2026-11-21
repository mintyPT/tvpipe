/**
 * What the host page says of Jinx itself, per language (the room's):
 * the status beside the logo, Start after a game, a bot's tag. The
 * page's own texts and the settings' labels are @tvpipe/party's
 * (`HostPage`) and `host.ts`'s.
 */

import type { Phase } from "../game/game.ts";
import type { Lang } from "../game/lang.ts";

const en = {
  phases: {
    lobby: "Lobby",
    hotseat: "hot seat",
    write: "writing",
    jinx: "jinx check",
    reveal: "reveal",
    verdict: "verdict",
    replay: "replay",
    bank: "the bank",
    end: "Game over",
  } as Record<Phase, string>,
  round: (r: string, phase: string) => `Round ${r} · ${phase}`,
  playAgain: "Play again",
  bot: "bot",
  noWords: "No words in this language (data files missing)",
};

const de: typeof en = {
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
  round: (r, phase) => `Runde ${r} · ${phase}`,
  playAgain: "Nochmal spielen",
  bot: "Bot",
  noWords: "Keine Wörter in dieser Sprache (Datendateien fehlen)",
};

/** The host page's strings in a language. */
export function strings(lang: Lang): typeof en {
  return lang === "de" ? de : en;
}

/** The status beside the logo: the lobby, the end, or the round and what happens in it. */
export function status(lang: Lang, phase: Phase, round: number): string {
  const t = strings(lang);
  return phase === "lobby" || phase === "end" ? t.phases[phase] : t.round(new Intl.NumberFormat(lang).format(round), t.phases[phase] ?? phase);
}
