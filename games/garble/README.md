# Garble

A telephone drawing game (our own rules, names and look) on
[`@tvpipe/party`](../../npm/party), for 4–12 players. Everyone draws a
prompt on their phone; the drawing goes to the next player, who guesses
it; the guess goes to the next, who draws it; and so on, seat to seat,
until every chain ends with a guess. You only ever see the step right
before yours. Then the TV unrolls each chain on a red thread, and its
author judges where it died.

Two secrets pull against keeping the chains alive:

- **A secret word for everyone**, new each round. Smuggle it into the
  chains: a later guess by someone else that says it pays you (300).
- **One Wrecker** per round, who scores for every chain that dies right
  at their drawing or guess (300 each), unless the room names them at
  the end of the round (then they lose it, and everyone who named them
  gets 200; if they get away, 400).

Every link that survives (a drawing and the guess after it) pays its
drawer and guesser 100 each. The rules, the numbers and why:
[`docs/garble-design.md`](../../docs/garble-design.md).

Drawing is in black ink only, with three pens. By default there is no
undo (every stroke counts); the room can turn on undo and clear. With
twists on (the default), round 2 is **Glimpse** (a drawing vanishes a few
seconds after it drew itself) and round 3 **Peephole** (you only see the
drawing under your finger). Chains are 4, 6 or 8 steps long (at most the
players). English and German.

It is a web app for [`tvpipe game play`](../../docs/playshare-design.md):
tvpipe serves it, the game runs in its host page (a window on the
computer), the TV page is cast to AirPlay and Chromecast receivers, and
phones join with the QR code.

| | | |
|---|---|---|
| `tvpipe.json` | the manifest | pages, 4–12 players, the TV's size; `root: dist` |
| `game/` | the rules (`rules.ts`: drawings, seating, the word matcher, points), the game (`game.ts`), bots (`bots.ts`) | TypeScript on `@tvpipe/party`, tested in Node |
| `host/` | the host page | the party, the TVs, the players, settings, a preview of the TV; `strings.ts` |
| `screen/` | the TV page | the lobby, the round's secrets, the ring of players passing slips, each chain on its thread and its verdict, the hunt, the ledger, the podium; `strings.js` |
| `phone/` | the phone page | joining, the lobby (the VIP's settings), the secret card, the pad, guessing with the twist, judging, accusing, reactions; `strings.js`, `ink.js` (the strokes, shared with the TV) |
| `data/` | prompts and secret words, English and German | fetched by the host page |

## Running it

```sh
cargo build --release -p tvpipe-cli
(cd npm/party && npm ci && npm run build)
cd games/garble && npm install && npm run build
../../target/release/tvpipe game play .
```

Pick the TVs (or "A browser tab on this computer"), then Start.

## Checking it

```sh
npm run check && npm test          # types; the rules and whole games with bots in Node
node test/live/play.ts             # a live game: tvpipe, headless Chrome, a phone, bots; screenshots in /tmp/garble-play
node test/live/play.ts --lang de --length 8 --undo
```

Bots are for tests: the host page's bot buttons show only with `?bots`
in its URL, and the live check adds them through `garble.addBots`. They
cannot see drawings: the host page tells them what a drawing was meant
to be, and they still get it wrong now and then, or fall for a smuggled
word. The live check needs Chrome and a built tvpipe; it also checks every phone
screen for text running out of its box at 390 and 320 px.
