/**
 * The round the pictures for the games list show (`play.ts --shots`): a
 * fixed, hand-written table instead of the random bots, so what is on
 * screen makes sense. The deck holds one word (the window's fetch of the
 * word list is answered with its line only, over the DevTools Fetch
 * domain), the other seven players are scripted clients that draw their
 * faces and write their clues, and Phil, the guesser of round 1 (the join
 * order), turns the cards in `TURN` and types the word.
 *
 * VAMPIRE: Mia and Jonas both reach for the obvious FANGS (FANG and FANGS,
 * a plural: jinxed); Ben bets bold on DRACULA; Phil turns CAPE, GARLIC,
 * TWILIGHT and COFFIN and leaves the bold card face down.
 */

import type { Tab } from "./browser.ts";

export const WORD = "vampire";

/** The other players, in join order: name, clue, bold, face. */
export const PLAYERS: { name: string; clue: string; bold: boolean; face: number[][] }[] = [
  { name: "Mia", clue: "fangs", bold: false, face: [] },
  { name: "Jonas", clue: "fang", bold: false, face: [] },
  { name: "Lena", clue: "cape", bold: false, face: [] },
  { name: "Sam", clue: "garlic", bold: false, face: [] },
  { name: "Noah", clue: "twilight", bold: false, face: [] },
  { name: "Zoe", clue: "coffin", bold: false, face: [] },
  { name: "Ben", clue: "dracula", bold: true, face: [] },
];

/** The cards Phil turns, by author, in order. */
export const TURN = ["Lena", "Sam", "Noah", "Zoe"];

// ---------------------------------------------------------------------------
// Faces: doodles on the 1000 grid (the chip's cream circle is the grid's
// inscribed circle; everything stays within ~380 of the centre), with a
// little wobble so they look drawn by hand.

type Pt = [number, number];

/** A deterministic wobble (a few grid units) for face `seed`. */
function wobble(seed: number): (p: Pt, i: number) => Pt {
  return ([x, y], i) => [x + 7 * Math.sin(seed * 1.7 + i * 0.9), y + 7 * Math.cos(seed * 2.3 + i * 1.3)];
}

/** Points along an ellipse arc, degrees (0 right, 90 down). */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, n = 12): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / n) * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}

const dot = (x: number, y: number): Pt[] => arc(x, y, 14, 14, 0, 360, 8);

function face(seed: number, strokes: Pt[][]): number[][] {
  const w = wobble(seed);
  let i = 0;
  return strokes.map((s) => s.flatMap((p) => w(p, i++)).map((v) => Math.round(Math.max(0, Math.min(1000, v)))));
}

/** Phil's face, drawn on the phone's pad: round glasses, a big smile, a tuft. */
export const PHIL = face(1, [
  arc(375, 450, 92, 88, -90, 270, 16),
  arc(625, 450, 92, 88, -90, 270, 16),
  [
    [467, 440],
    [500, 425],
    [533, 440],
  ],
  dot(385, 460),
  dot(615, 460),
  arc(500, 610, 170, 105, 15, 165, 14),
  [
    [430, 245],
    [450, 185],
    [500, 150],
    [570, 150],
    [610, 185],
    [590, 220],
    [555, 205],
  ],
]);

PLAYERS[0]!.face = face(2, [
  // Mia: a wink, a grin with the tongue out, a bow of hair.
  dot(380, 450),
  [
    [345, 380],
    [372, 352],
  ],
  [
    [395, 372],
    [405, 342],
  ],
  arc(620, 470, 70, 55, 200, 340, 8),
  arc(500, 590, 175, 95, 10, 170, 14),
  arc(555, 660, 48, 60, 0, 180, 8),
  [
    [280, 300],
    [330, 210],
    [420, 160],
    [530, 150],
    [520, 210],
    [600, 170],
    [690, 210],
    [730, 290],
  ],
]);

PLAYERS[1]!.face = face(3, [
  // Jonas: heavy brows, a hooked nose, a curly moustache.
  [
    [300, 370],
    [440, 385],
  ],
  [
    [560, 385],
    [700, 370],
  ],
  dot(380, 450),
  dot(620, 450),
  [
    [500, 450],
    [470, 560],
    [525, 570],
  ],
  [
    [290, 590],
    [315, 640],
    [380, 655],
    [450, 630],
    [500, 610],
    [550, 630],
    [620, 655],
    [685, 640],
    [710, 590],
  ],
  [
    [455, 740],
    [545, 740],
  ],
]);

PLAYERS[2]!.face = face(4, [
  // Lena: big round eyes, raised brows, a small "o".
  arc(370, 470, 80, 85, 0, 360, 16),
  arc(630, 470, 80, 85, 0, 360, 16),
  dot(385, 490),
  dot(615, 490),
  arc(360, 330, 80, 40, 200, 320, 6),
  arc(640, 330, 80, 40, 220, 340, 6),
  arc(500, 680, 52, 58, 0, 360, 14),
]);

PLAYERS[3]!.face = face(5, [
  // Sam: sunglasses (hatched), a smirk.
  [
    [270, 400],
    [730, 400],
  ],
  [...arc(380, 410, 95, 75, 0, 180, 10)],
  [...arc(620, 410, 95, 75, 0, 180, 10)],
  [
    [310, 420],
    [360, 470],
    [400, 420],
    [430, 460],
  ],
  [
    [550, 420],
    [600, 470],
    [640, 420],
    [690, 450],
  ],
  [
    [400, 650],
    [520, 660],
    [610, 620],
    [640, 580],
  ],
]);

PLAYERS[4]!.face = face(6, [
  // Noah: eyes shut laughing, a wide open mouth, a curl.
  arc(385, 470, 70, 50, 200, 340, 8),
  arc(615, 470, 70, 50, 200, 340, 8),
  [
    [330, 580],
    [670, 580],
    ...arc(500, 580, 170, 160, 0, 180, 12).slice(1),
  ],
  arc(500, 705, 70, 30, 200, 340, 6),
  [...arc(500, 250, 60, 60, 90, 420, 12), [555, 160]],
]);

PLAYERS[5]!.face = face(7, [
  // Zoe: happy ^^ eyes, blush, a cat mouth.
  arc(380, 470, 65, 60, 200, 340, 8),
  arc(620, 470, 65, 60, 200, 340, 8),
  [
    [260, 560],
    [300, 520],
  ],
  [
    [300, 580],
    [340, 540],
  ],
  [
    [660, 540],
    [700, 580],
  ],
  [
    [700, 520],
    [740, 560],
  ],
  [...arc(455, 600, 45, 50, 0, 160, 6).reverse(), ...arc(545, 600, 45, 50, 20, 180, 6).reverse()],
]);

PLAYERS[6]!.face = face(8, [
  // Ben: one brow up, a lopsided smile, a goatee.
  [
    [300, 340],
    [370, 300],
    [440, 330],
  ],
  [
    [560, 395],
    [700, 385],
  ],
  dot(375, 430),
  dot(630, 450),
  [
    [380, 620],
    [470, 650],
    [580, 640],
    [660, 580],
  ],
  [
    [505, 480],
    [470, 560],
    [520, 575],
  ],
]);

// ---------------------------------------------------------------------------
// Hooks for play.ts

/** The word lists answered with `WORD`'s line (their URLs). */
export const dealt: string[] = [];

/**
 * The window's word lists hold `WORD`'s line only (headers kept): the deck
 * deals it. A list without the word (another language's) goes through.
 * Call before the host page loads.
 */
export async function deal(win: Tab): Promise<void> {
  type Paused = { requestId: string; request: { url: string }; responseStatusCode?: number; responseHeaders?: { name: string; value: string }[] };
  const answer = async (p: Paused): Promise<void> => {
    const pass = () => win.send("Fetch.continueRequest", { requestId: p.requestId });
    if (p.responseStatusCode !== 200) return pass();
    const body = (await win.send("Fetch.getResponseBody", { requestId: p.requestId })) as { body: string; base64Encoded: boolean };
    const text = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
    const lines = text.split("\n");
    const keep = lines.filter((l) => l.startsWith("#") || l.startsWith(`${WORD}\t`));
    if (!keep.some((l) => l.startsWith(`${WORD}\t`))) return pass();
    await win.send("Fetch.fulfillRequest", {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: (p.responseHeaders ?? []).filter((h) => !/^content-(length|encoding)$/i.test(h.name)),
      body: Buffer.from(keep.join("\n") + "\n").toString("base64"),
    });
    dealt.push(p.request.url);
  };
  win.on("Fetch.requestPaused", (p: Paused) => void answer(p).catch((e: Error) => console.error(`scenario: ${p.request.url}: ${e.message}`)));
  await win.send("Fetch.enable", { patterns: [{ urlPattern: "*/data/*words*.txt*", requestStage: "Response" }] });
}

/**
 * Script for the host page (`win.eval`): `PLAYERS` join as clients (as the
 * host's bots do, through tvpipe), draw their faces, and write their clue
 * a second or a few after the writing starts. Resolves once all joined.
 */
export function joinScript(): string {
  return `(async () => {
    const { memoryStorage, PartyClient } = await import("/_tvpipe/lib/client.js");
    const url = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/_tvpipe/ws";
    const players = ${JSON.stringify(PLAYERS)};
    globalThis.__people = [];
    for (const [i, p] of players.entries()) {
      const c = new PartyClient({ url, room: jinx.party.code, key: jinx.party.joinKey, storage: memoryStorage() });
      let sent = "";
      c.on("view", (v) => {
        const me = v.me ?? {};
        const round = String(v.room?.round ?? 0);
        if (me.task !== "write" || sent === round || !Array.isArray(me.sent) || me.sent[0] !== null) return;
        sent = round;
        setTimeout(() => c.act("clue", { text: p.clue, bold: p.bold, slot: 0 }).catch((e) => console.error("scenario: " + p.name + " could not write " + p.clue + ": " + (e.message ?? e))), 1200 + i * 700);
      });
      await c.join(p.name);
      await c.act("face", { strokes: p.face });
      globalThis.__people.push(c);
    }
    return true;
  })()`;
}

/** Draws `PHIL` on the phone's pad (touch drags; the pad's box in CSS px). */
export async function drawPhil(phone: Tab, box: { x: number; y: number; w: number }): Promise<void> {
  for (const s of PHIL) {
    const pts: [number, number][] = [];
    for (let i = 0; i + 1 < s.length; i += 2) pts.push([box.x + (s[i]! / 1000) * box.w, box.y + (s[i + 1]! / 1000) * box.w]);
    await phone.drag(pts);
  }
}
