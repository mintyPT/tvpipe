/**
 * Pinch's host page: the game runs here, in tvpipe's window
 * (docs/pinch-design.md §11; the app window keeps timers running in the
 * background). It makes the party on tvpipe's relay, puts the TV page
 * on the TVs the launcher chose, runs the game (`game/game.ts`, the
 * heist at 20 Hz) and shows the room on tvpipe's standard host page
 * (`HostPage`) with Pinch's settings. Bots are for tests: their buttons
 * show only in test mode (`tvpipe game play --dev`) or with `?bots`;
 * `?fast` plays short phases and a one-minute heist.
 */

import { HostPage, languageField, lateJoinField, preferredLang, type Field } from "@tvpipe/party";

import { Bot } from "../game/bots.ts";
import { FAST_TIMINGS, Pinch } from "../game/game.ts";
import { LANGS, type Lang } from "../game/items.ts";
import { TIMES } from "../game/protocol.ts";
import { SKIP, SKIP_LABEL, status } from "./strings.ts";

const robots: Bot[] = [];

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function settings(game: Pinch): Field[] {
  return [
    languageField({ langs: LANGS, get: () => game.lang, set: (lang) => game.configure({ lang }) }),
    {
      key: "length",
      type: "buttons",
      label: { en: "Heist", de: "Coup" },
      hint: { en: "How long the thief has before the police arrive.", de: "Wie lange der Dieb hat, bevor die Polizei kommt." },
      choices: TIMES.lengths.map((s) => ({ value: s, label: clock(s) })),
      get: () => game.settings.length,
      set: (length: number) => game.configure({ length }),
    },
    {
      key: "rounds",
      type: "buttons",
      label: { en: "Thief turns", de: "Diebesrunden" },
      hint: { en: "Every player is the thief once, or twice.", de: "Jeder ist einmal Dieb, oder zweimal." },
      choices: [
        { value: 1, label: { en: "once each", de: "einmal" } },
        { value: 2, label: { en: "twice each", de: "zweimal" } },
      ],
      get: () => game.settings.rounds,
      set: (rounds: 1 | 2) => game.configure({ rounds }),
    },
    { ...lateJoinField(game.party, ["wait", "closed"], (late) => game.configure({ late: late === "closed" ? "closed" : "wait" })), live: true },
    {
      key: "skip",
      type: "buttons",
      label: SKIP_LABEL,
      live: true,
      remember: false,
      hidden: () => game.phase !== "tape" && game.phase !== "scores",
      choices: [{ value: "skip", label: SKIP }],
      get: () => "",
      set: () => void game.skip(),
    },
  ];
}

async function main(): Promise<void> {
  const lang: Lang = preferredLang("pinch", LANGS);
  const page = await HostPage.connect({ name: "pinch", title: "Pinch", lang });
  const party = await page.tvpipe.party({ lateJoin: "wait" });
  const game = new Pinch(party, { lang });
  game.open();

  /** Bots for test mode and the live check: a thief that knows where the loot is (the host's truth), guards that patrol and chase (`skill` 0.6 by default). */
  const addBots = async (n: number, o: { names?: string[]; silent?: boolean; idle?: "thief" | "guard"; skill?: number } = {}) => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
    const names = o.names ?? ["Mugsy", "Lefty", "Dutch", "Bugsy", "Knuckles", "Slim", "Dapper"].map((x) => `${x}${robots.length + 1}`);
    for (let i = 0; i < n; i++) {
      const b = new Bot({
        url,
        room: party.code,
        key: party.joinKey,
        name: names[i % names.length]!,
        seed: robots.length + 1,
        oracle: () => game.truth(),
        silent: o.silent ?? false,
        idle: o.idle,
        // Not perfect guards: closer games.
        skill: o.skill ?? 0.6,
      });
      await b.join();
      robots.push(b);
    }
  };

  page.run({
    party,
    game,
    lang: () => game.lang,
    settings: settings(game),
    status: (l) => status(l as Lang, game.phase, game.roundNo, game.roundNo + game.queue.length, game.thief ? (party.player(game.thief)?.name ?? null) : null),
    bots: addBots,
  });
  game.on("settings", () => page.update());
  game.on("phase", () => page.update());
  page.tvpipe.on("closing", () => {
    for (const b of robots) b.close();
  });
  await page.castChosen();
  // For checks and tests (DevTools): the party and the game; `?fast` plays short.
  if (new URLSearchParams(location.search).has("fast")) game.configure({ timings: FAST_TIMINGS });
  Object.assign(globalThis, { pinch: { party, game, tvpipe: page.tvpipe, page, addBots, robots, FAST_TIMINGS } });
}

void main();
