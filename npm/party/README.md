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
  view up to date, sends actions.
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
  const deadline = party.now() + 60_000;
  party.room.set({ phase: "answer", deadline });
  party.screen.set({ phase: "answer", deadline });
  const answers = await party.collect("answer", { until: deadline });
  party.screen.set({ phase: "results", answers: [...answers.values()] });
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

## Host API

`await tvpipe.party(options)`: options `maxPlayers` (default: the
manifest's `players.max`), `lateJoin`, `moderate`, `limits`, `grace`,
`log`, `code`.

| | |
|---|---|
| `party.room`, `party.screen`, `player.state` | `StateBox`es: `set(partial)` (`undefined` removes a field), `replace(value)`, `update(draft => …)`, `value`. Changes in one tick reach each client as one diff. |
| `party.handle(type, (data, from) => result)` | Actions of a type; throw `PartyError(code, message)` to refuse. `from` is a `Player` or a screen (`from.role`). |
| `party.collect(type, { from, until, validate, replace, skipAway, reply, onAnswer, signal })` | One action per player, until all answered or the deadline (+ `grace`, 500 ms). Resolves with `Map<Player, value>`. |
| `party.send(player, type, data)`, `party.broadcast(type, data, role)` | Transient messages (`msg` events on phones). |
| `party.players`, `connectedPlayers`, `vip`, `player(id)` | Players in join order; `player.id`, `name`, `vip`, `connected`, `waiting`, `data` (yours). |
| `party.lock()`, `unlock()`, `kick(player)`, `close()` | No new players (resumes still work), remove one, end the party. |
| `party.inProgress`, `party.lateJoin`, `party.activate(player)` | Joining mid-game: `closed` (refused, `bye in-progress`), `wait` (default) or `open` (waiting players until the game activates them). |
| `party.now()` | The host's clock (ms); deadlines in views use it, phones are synced to it. |
| `party.links` | `join` (in the QR code), `tv` (the TV page with the screen key), `watch` (a read-only screen on this computer, e.g. an `<iframe>` preview). |
| `party.cast(to?)`, `party.stopCast()` | The TV page on receivers (default: the launcher's choice); `tvpipe.on("cast", status)` follows it. |
| `party.stats`, `party.screenView()` | What the views cost; what screens see. |
| events | `join`, `reconnect`, `away`, `leave`, `vip`, `active`, `screen`, `screen-view`, `input` |

`Tvpipe`: `info()`, `watchDevices(on)` and the `devices` event,
`select(names)`, `selection()`, `pair(device)`, `pairPin(device, pin)`,
`pairCancel(device)` and the `pair` event, `cast({ page, to })`,
`stopCast()` and the `cast` event, `qr(text)`, `quit()`, the `tunnel`
and `closing` events. A game's own launcher uses these, then
`select()`s and navigates to the host page.

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
storage, WebSocket })`; `join(name)`, `connect()`, `act(type, data)`
(rejects with `PartyActionError`: `code`, `message`), `input(data)`,
`on("view" | "msg" | "status" | "bye" | "welcome", fn)`, `view`, `you`,
`status`, `now()`, `leave()`, `close()`; `qrSvg(qr)`, `drawQr(ctx, qr, x,
y, size)`, `joinText(join)`, `memoryStorage()`. It reconnects by itself
(and when the page becomes visible again), keeps the player's identity in
`localStorage`, and resends unacknowledged actions.

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

`npm test`: the host and the client on a relay in memory (joins, names,
VIP, resumes, replayed actions, `collect`, late joins, limits, busy
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
invisible and control characters removed, 16 characters) and unique.
Render everything players send as text.
