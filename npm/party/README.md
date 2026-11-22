# @tvpipe/party

Party games for [`tvpipe game play`](../../docs/playshare-design.md): the
TV shows the game, everyone plays with the browser on their phone. A game
is a web app (a folder or a zip with `tvpipe.json`); tvpipe serves it,
opens its host page in a window, casts its TV page to AirPlay and
Chromecast receivers, and relays the phones' WebSockets to the host page.
This package is what runs in those pages:

- **`Party`** (the host page): a room with a code and a join key, players
  with names, a VIP, phones that drop out and come back, **views** the
  host sets and phones show, **actions** phones send and the host handles
  (acknowledged, resent after a reconnect, applied once), joining
  mid-game, a shared clock.
- **`Tvpipe`**: tvpipe's local API (the receivers, AirPlay pairing,
  casting, QR codes, the relay); `tvpipe.party()` makes a `Party` on it.
- **`PartyClient`** (phones, the TV page): joins, reconnects, keeps the
  view up to date, sends actions; on the TV, the join code in a corner.
- **`HostPage`**: the standard host page (the join code, the TVs, the
  players, Start, a preview of the TV) with the game's settings drawn
  from a spec (`Field`s).
- **`memoryRelay()`**: a host and fake phones in one process, for tests.

tvpipe serves the built modules at `/_tvpipe/lib/` (`index.js`,
`client.js`, …), so pages import them without a bundler. The npm package
has the same modules with types, for type checking and for tests in Node
(≥ 22). No dependencies. Building, checking (`tvpipe game check`) and
running a game: [`docs/games.md`](../../docs/games.md). The protocol
between phones and the host:
[`docs/party-protocol.md`](../../docs/party-protocol.md). A whole game:
[`games/drawbluff`](../../games/drawbluff).

## A game in a few files

`tvpipe.json`:

```json
{
  "name": "quiz",
  "tvpipe": "0.3",
  "pages": { "host": "host.html", "tv": "tv.html", "phone": "phone.html" },
  "players": { "min": 2, "max": 12 }
}
```

The host page (`host.html` loads this module): the game's rules.

```js
import { Tvpipe, PartyError } from "/_tvpipe/lib/index.js";

const tvpipe = await Tvpipe.connect();       // tvpipe's API (the window's session)
const party = await tvpipe.party();          // the room, its join link and QR code
await party.cast();                          // the TV page on the TVs picked in the launcher

party.screen.set({ phase: "lobby" });
party.handle("start", (data, from) => {
  if (from.role !== "player" || !from.vip) throw new PartyError("not-vip", "Only the VIP can start");
  void round();
});

async function round() {
  party.inProgress = true;
  const deadline = party.deadline(60_000);   // 60 s from when the TV shows it
  party.withTv(() => {                       // phones switch when the TV does
    party.room.set({ phase: "answer", deadline });
    party.screen.set({ phase: "answer", deadline });
  });
  const answers = await party.collect("answer", { until: deadline });
  party.withTv(() => party.screen.set({ phase: "results", answers: [...answers.values()] }));
}
```

A phone page:

```js
import { PartyClient } from "/_tvpipe/lib/client.js";

const party = PartyClient.fromLocation();          // the room and key from the link
party.on("view", (view) => render(view));          // { roster, room, me }
if (party.canResume) await party.connect();        // this phone played before
else await party.join(prompt("Your name?"));
button.onclick = () => party.act("answer", { text: input.value }).catch((e) => show(e.message));
```

The TV page uses the same client; its link (`party.links.tv`, what
`party.cast()` casts) has `#role=screen` and the screen key, and its view
is `{ roster, screen, join }`: `qrSvg(view.join.qr)` draws the join
link's QR code, and `joinText(view.join)` is what to show people to type:
the short link (`tvpipe.party/BCDF`, which tvpipe registers when phones
come through a tunnel; docs/short-links.md) or `null` (show only the QR
code). Do not show the tunnel's link or the room code itself: too long to
type, and the room code alone lets nobody in.

## Players who drop out

Phones drop out all the time at a party: the signal goes, a screen
locks, a page is reloaded, the link is opened in another browser or on
another phone. The library brings them back to their seat, score and
turn; a game only has to keep going while they are away (deadlines, a
player who is away keeps their place) and let them carry on when they are
back.

- **The same phone** reconnects by itself with its resume token (kept in
  `localStorage`) and gets the whole view again.
- **Another phone or browser**: typing the same name takes the seat of
  a player who is away (the `reclaim` option, on by default), even when
  the room is locked, full or closed to newcomers.
- **The TV shows the way back**: TV pages draw a **join badge** by
  themselves: the join QR code and the short link in a corner the whole
  time; scanning it and typing the same name brings a player back.
  `PartyClient.fromLocation({ rejoinBadge: { corner: "top-left", layout:
  "row" } })` or `client.rejoinBadge.corner = …` moves it clear of the
  game, which keeps out of the corner with `data-tvpipe-join` and
  `--tvpipe-join-w`/`-h` on `<html>`; set `client.joinVisible = true`
  while the game shows its own join code (the lobby) and it steps aside
  (docs/games.md, "The join code is always on the TV").
- **The host page** can show a player their own code
  (`party.showRejoin(player)`: a QR code of `party.rejoinLink(player)`
  over the host page, closing when they are back). `HostPage` has the
  button beside away players.
- **Tests**: `dropOuts(phones)` from `@tvpipe/party/testing` drops and
  brings back phones while a whole game runs; every game should pass a
  game played through it (see Tests).

## Host API

`await tvpipe.party(options)`: options `maxPlayers` (default: the
manifest's `players.max`), `lateJoin`, `moderate`, `limits`, `grace`,
`log`, `code`, `tvDelay` (fixed; default: follow the TVs), `reclaim`
(default `true`: an away player's name takes their seat back).

| | |
|---|---|
| `party.room`, `party.screen`, `player.state` | `StateBox`es: `set(partial)` (`undefined` removes a field), `replace(value)`, `update(draft => …)`, `value`. Changes in one tick reach each client as one diff. |
| `party.handle(type, (data, from, info) => result)` | Actions of a type; throw `PartyError(code, message)` to refuse. `from` is a `Player` or a screen (`from.role`); `info.sentAt`: when the phone sent it (host clock, the phone's word within the last second). |
| `party.collect(type, { from, until, validate, replace, skipAway, reply, onAnswer, signal })` | One action per player, until all answered or the deadline (+ `grace`, 500 ms). Resolves with `Map<Player, value>`. |
| `party.withTv(() => { … })` | What changes inside (views, `send`, `broadcast`) reaches phones and watchers when the TV shows it (the TV page at once). For phases, reveals, results; not for replies to a phone's action. |
| `party.deadline(ms)`, `party.tvDelay`, `party.screenNow()` | A deadline `ms` after the TV shows what changes now; how far the TV is behind (ms, from the casts and surfaces; set it to fix it; `tv` event); the time a picture drawn now is on the TV (surfaces). |
| `party.send(player, type, data)`, `party.broadcast(type, data, role)` | Transient messages (`msg` events on phones). |
| `party.players`, `connectedPlayers`, `vip`, `player(id)` | Players in join order; `player.id`, `name`, `vip`, `connected`, `waiting`, `data` (yours). |
| `party.lock()`, `unlock()`, `kick(player)`, `close()` | No new players (resumes still work), remove one, end the party. |
| `party.rejoinLink(player)`, `party.showRejoin(player)` | A link that brings the player back on any phone (their resume token: show it to them only); the host page's dialog with its QR code, closing when they are back. |
| `party.inProgress`, `party.lateJoin`, `party.activate(player)` | Joining mid-game: `closed` (refused, `bye in-progress`), `wait` (default) or `open` (waiting players until the game activates them). |
| `party.now()` | The host's clock (ms); deadlines in views use it, phones are synced to it. |
| `party.links` | `join` (in the QR code), `tv` (the TV page with the screen key), `watch` (a read-only screen on this computer, e.g. an `<iframe>` preview). |
| `party.cast(to?)`, `party.stopCast()` | The TV page on receivers (default: the launcher's choice); `tvpipe.on("cast", status)` follows it. An AirPlay TV that fails for want of pairing (`code: "pairing-required"`: never paired, or it forgot the pairing) gets the pairing dialog, then the page is cast again (once per TV and `cast()`; the `pair` option of `tvpipe.party()`: your own function, or `false`). |
| `party.stats`, `party.screenView()` | What the views cost; what screens see. |
| events | `join`, `reconnect`, `away`, `leave`, `vip`, `active`, `screen`, `screen-view`, `input`, `tv` |

`HostPage` (the standard host page; docs/games.md has an example):
`await HostPage.connect({ name, title, lang })` draws it and connects to
tvpipe (`page.tvpipe`); `page.run({ party, game, lang, settings, status,
startLabel, tags, bots, previewNote, remember })` fills it in (`game`:
`running`, `minPlayers`, `play()`); `page.update()` after the game
changed (a phase, the VIP's settings), `page.castChosen()`,
`page.set(key, value)` (as if the host picked it: tests),
`page.error(text)`. `settings` is a list of `Field`s: `{ key, label,
hint, type: "select" | "buttons", choices: [{ value, label, disabled,
title }], get, set }` or `{ key, label, hint, type: "toggle", get, set,
disabled }`, with `live` (changeable during a game), `hidden()` and
`remember: false`; labels are `Text`s (a string, `{ en, de }` or `(lang)
=> string`). `languageField({ langs, get, set, available })` and
`lateJoinField(party, modes, changed)` are ready-made;
`preferredLang(name, langs)` is the language to start in;
`SettingsForm` is the form alone.

`Tvpipe`: `info()`, `watchDevices(on)` and the `devices` event,
`select(names)`, `selection()`, `pair(device)`, `pairPin(device, pin)`,
`pairCancel(device)` and the `pair` event, `showPairing(device)` (the
pairing dialog over the page), `setDisplayLag(device, ms)`
(a TV's lag as tapped along: the launcher's Sync), `cast({ page, to })`,
`stopCast()` and the `cast` event, `qr(text)`, `quit()`, the `tunnel`
and `closing` events. A game's own launcher uses these, then
`select()`s and navigates to the host page. `showGamePicker()` shows
tvpipe's games list in a dialog; when another game is picked the `game`
event (`{name, title, url}`) comes and a top-level page goes to `url`
(`followGames = false`: go yourself). `info().room` is the run's room
code and join key: `HostedParty` uses them, so the join link stays from
game to game (docs/game-switching.md).

## Surfaces: canvases on TVs

A canvas can go to the TVs without tvpipe's own browser capturing a
page: the library encodes it with WebCodecs here and tvpipe streams the
H.264 (docs/playshare-design.md §17). Cheaper, as fast or faster, in any
browser with WebCodecs, and one surface per TV gives every TV its own
picture.

```js
const tv = await tvpipe.surface({ canvas, fps: 30, audio: { context, node } });
function draw() { render(ctx); tv.frame(); requestAnimationFrame(draw); }
```

In a worker (keeps going while the window is hidden; `requestAnimationFrame`
does not):

```js
const info = await tvpipe.openSurface({ width: 1280, height: 720, fps: 30, to: ["Kitchen"] });
worker.postMessage({ canvas: canvas.transferControlToOffscreen(), info }, [canvas]);
// in the worker: const enc = new SurfaceEncoder(info, canvas); … draw; enc.frame(true) on a timer
```

`SurfaceEncoder`: `frame(force?)`, `pushAudio(pcm, ptsUs)`, `close()`,
events `status`, `stats` (`fps`, `kbps`, `lagMs` to tvpipe, `encodeMs`),
`end`, `error`; `captureAudio(context, node, channels, onPcm)` taps Web
Audio. A DOM TV page can be drawn into a canvas with Chrome's
HTML-in-Canvas (Drawbluff's "TV picture: drawn here").

## Client API

`PartyClient.fromLocation()` or `new PartyClient({ url, room, key, role,
storage, session, followGames, WebSocket })`; `join(name)`, `connect()`, `act(type, data)`
(rejects with `PartyActionError`: `code`, `message`), `input(data)`,
`on("view" | "msg" | "status" | "bye" | "welcome" | "tv", fn)`, `view`, `you`,
`status`, `now()`, `hostNow()`, `tvDelay`, `leave()`, `close()`; on
screens `rejoinBadge` (the join badge: `corner`; options `corner`,
`layout`, `rejoinBadge: false` for none) and `joinVisible`; `qrSvg(qr)`, `drawQr(ctx, qr, x,
y, size)`, `joinText(join)`, `memoryStorage()`. It reconnects by itself
(and when the page becomes visible again), keeps the player's identity in
`localStorage`, takes a rejoin link's token, and resends unacknowledged
actions. `drop({ away, forget })` (tests) loses the connection like a
phone would. When the room goes on with another game (`bye next-game`,
4014) a player's page goes to its join link: `carried` (`{name, data}`,
in `sessionStorage`) is what it was in the last game, `connect()` joins
with that name when there is no saved identity (`canResume` is true
then), and `carry(data)` stashes up to `CARRY_LIMIT` bytes of JSON for
the next one.

**The TV is behind** (render, capture, the receivers' playout delay, the
TV's own lag: ~0.25 s on an Apple TV, ~0.45 s on Cast). Changes the host
made in `party.withTv` wait on phones and watchers until the TV shows
them (in order: what comes after waits too). `now()`, what countdowns
use, is the host's clock on phones and on a TV page the time its picture
is on the TV (`hostNow() + tvDelay`), so the TV's countdown and the
phones' end together. Games need nothing else on the client.

## Tests

```js
import { Party } from "@tvpipe/party";
import { memoryStorage, PartyClient } from "@tvpipe/party/client";
import { memoryRelay } from "@tvpipe/party/testing";

const relay = memoryRelay();
const party = new Party({ maxPlayers: 8 }).listen(relay);
const phone = new PartyClient({ url: "ws://test/", room: party.code, key: party.joinKey, storage: memoryStorage(), WebSocket: relay.WebSocket });
await phone.join("Ann");
```

Play whole games with phones dropping out (bots on `PartyClient`s):

```js
import { dropOuts } from "@tvpipe/party/testing";

const chaos = dropOuts(bots.map((b) => b.client), { rng: seeded(1), every: 100, away: [0, 800] });
await bots[0].client.act("start");
await gameOver;
await chaos.stop();   // throws when a phone could not come back as itself
```

Each drop-out is a lost connection that comes back with its token
(`network`) or a page on another phone that comes back by name
(`device`); `chaos.counts` has how many of each.

`npm test`: the host and the client on a relay in memory (joins, names,
VIP, resumes, rejoining by name and by link, drop-outs, replayed actions, `collect`, late joins, limits, busy
phones, the protocol vectors in `test/vectors/`), and, when tvpipe is
built (`cargo build -p tvpipe-cli` or `TVPIPE_BINARY`), the real
`tvpipe game play` with Node as the host page and fake phones.
`npm run build` also copies the browser modules into the tvpipe crate
(`npm run check` fails when they are not up to date).

## Security

tvpipe checks `Host` and `Origin`, rate and size limits per connection;
this library checks the rest: the join key from the QR code's link (in
the fragment, so it is in no request line or log), screens' own keys,
`hello` within 5 s, failed joins per address, 20 messages/s per socket,
16 KiB for messages other than actions; names are normalised (NFC,
emoji, invisible and control characters removed, 16 characters) and
unique. `cleanText` removes emoji from any text, `stripEmoji` on its
own; on phones, `blockEmoji()` (from the client) removes them from text
fields as they are typed.
Render everything players send as text.
