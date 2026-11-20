# Party games on tvpipe (design)

Status: **superseded** by [`playshare-design.md`](playshare-design.md):
games are web apps now, their logic runs in a host page in the browser
(`@tvpipe/party` became a browser library), tvpipe serves them and relays
the phones (`tvpipe game play`); the Node host, the video screen and
`toTv` below are gone. Kept for the reasoning (§2, §6, §8) and the
measurements (§13); the protocol (§5) lives on in
[`party-protocol.md`](party-protocol.md). `tvpipe debug tunnel` and `tvpipe debug qr`
remain.
Goal: Jackbox-style
party games: the TV shows the game and a QR code, everyone joins with
their phone's browser over a public link, the game runs on the computer
that drives the TV. Two demonstrations of one Drawful-style game
(`drawbluff`, named to stay clear of Jackbox's trademark): its main screen
as a **video** the game renders, and as a **web page** tvpipe casts.

Contents: 1. the split, 2. where the message bus lives, 3. what tvpipe
adds, 4. `@tvpipe/party`, 5. the protocol, 6. security and abuse, 7. the
main screen on the TV, 8. latency, 9. a game author's view, 10.
Drawbluff, 11. tests, 12. plan and open questions, 13. as built.

## 1. The split

| Layer | Owns | Does not own |
|---|---|---|
| **tvpipe** (Rust: library, CLI, `--machine`) | streaming to TVs and tabs; casting a web page (`share URL`); **public tunnels for any loopback port** (new: `tvpipe tunnel PORT`, now `tvpipe debug tunnel PORT`); **QR codes as data** (new: `tvpipe qr`, now `tvpipe debug qr`; `tvpipe::qr`) | rooms, players, game messages, HTTP routing of someone else's app |
| **`@tvpipe/sdk`** (npm, exists) | spawning tvpipe: `stream`, `share`, …; new: `tunnel({ port })`, `qr(text)` | anything game-specific |
| **`@tvpipe/party`** (npm, new, `npm/party/`) | the HTTP + WebSocket server (static files, the bus), rooms and join codes, players, VIP, reconnect tokens, actions with acks, state sync, rate limits, Host/Origin/key checks; the join link and its QR; helpers to put the screen on the TV (web or video); a small browser client (`/party/client.js`) | rules, UI, prompts, scoring |
| **The game** (`games/drawbluff/`) | rules and phases, the phone UI (a static directory), the screen: a web page **or** a render function for video frames, assets | transport, identity, tunnels |

Rule of thumb: tvpipe gains only things that make sense without games
(expose a port, draw a QR code); everything with the notion of a player
is the party library; everything with the notion of a drawing is the game.

## 2. Where the message bus lives

**A. In tvpipe** ("app server mode"): tvpipe serves a directory and a
WebSocket hub through the tunnel, and relays messages to the program over
`--machine` (`client-message` events out, `send` commands in).

**B. In the party library**: the library runs its own HTTP/WebSocket
server on `127.0.0.1` (Node's `node:http`, a hand-rolled RFC 6455 server
side, ~250 lines: Node 22 ships a WebSocket client but no server), and
tvpipe only exposes that port publicly.

| | A: bus in tvpipe | B: bus in the party library |
|---|---|---|
| Path of a phone message | phone → tunnel → tvpipe → JSON line on stdout → Node | phone → tunnel → tvpipe → loopback TCP → Node |
| Binary data (drawings, images) | base64 inside JSON lines | as is |
| Head-of-line blocking | stdin is shared with SLRW media when the same process streams; needs a second process anyway | none: separate sockets |
| Party semantics (identity, resume, dedup, state diffs) | either in tvpipe (a game framework inside a streaming tool) or re-built by every SDK on a dumb relay | once, in the library, testable in-process |
| HTTP flexibility (own routes, uploads, a Vite dev server, express) | only what tvpipe serves | full: the game's server is a normal Node server |
| Other languages | free via `--machine` | need their own server (or a later Rust/other port of the library) |
| Public surface code | Rust, tvpipe's tested `access` rules | TypeScript, re-implemented and tested in the library |
| tvpipe growth | large (static server, hub, relay, new events/commands) | small and generic (`tunnel`, `qr`) |

**Proposal: B.** The bus is about players, not about streaming; it wants
binary messages, its own HTTP routes and in-process tests; and the TV
stream must be restartable (a TV dropped, another chosen) without
disconnecting the phones, which separate processes give for free. tvpipe
contributes the parts only it has (tunnels, QR, casting). The cost is the
public-facing checks in TypeScript (§6), which are small. A Rust port of
the library (`tvpipe-party` on a then-public `tvpipe::web` module: httpd,
websocket, access) can follow if a Rust game wants one; the protocol (§5)
is written so a second implementation can speak it.

## 3. What tvpipe adds

### 3.1 `tvpipe debug tunnel PORT`: a public link for any loopback port

```sh
tvpipe debug tunnel 8080                      # Cloudflare quick tunnel
tvpipe debug tunnel 8080 --tunnel=opentunnel  # TLS ends here
tvpipe --machine debug tunnel 8080            # {"type":"tunnel","page":"port","host":…,"url":…,"provider":…}
```

- Runs `net::tunnel::start(port, provider)` (existing) until Ctrl-C,
  `q`, the `stop` command or stdin EOF (the parent died); prints the URL
  and its QR code on a terminal, like the pages' tunnels.
- The `tunnel` event gains `host` (and `page: "port"`). Reconnects stay
  inside tvpipe (same hostname); `log` events tell about them.
- No access rules: the tunnel carries requests; the app at `PORT` decides
  (§6). The doc says so in bold, since `Host` arrives as the public name.
  The visitor's address reaches the app as `cf-connecting-ip` with
  Cloudflare; OpenTunnel copies TLS plaintext and has no header to add
  (rate limits work per connection and key there).
- Node SDK: `const t = await tunnel({ port, provider })` → `{ url, host,
  provider, stop(), done }`. Rust (after the public API lands):
  `tvpipe::Tunnel::start(port, provider)` → `url()`, `host()`, `Drop`.
- Party option `tunnel: "auto"`: Cloudflare, falling back to OpenTunnel
  when trycloudflare answers 429.

### 3.2 `tvpipe debug qr TEXT`: QR codes as data

The encoder exists (`util/qr.rs`, Nayuki-checked vectors). Expose it:

```sh
tvpipe debug qr https://example.com           # terminal (half blocks), as today
tvpipe debug qr --svg https://example.com     # an SVG document on stdout
tvpipe --machine debug qr TEXT                # {"type":"qr","version":5,"size":37,"rows":["1111111010…",…]}
```

- Rust: `tvpipe::qr::encode(text) -> Option<QrCode>` with `size()`,
  `dark(x, y)`, `to_svg(quiet)`; public once the API lands.
- Node SDK: `await qr(text)` → `QrCode { size, rows, dark(x, y), svg(opts),
  drawTo(ctx, x, y, px) }` (one spawn per code: the join link is made
  once per game). One encoder, tested once, rather than a TypeScript copy.

### 3.3 Nothing else is needed

- **Casting the screen page**: `share http://127.0.0.1:PORT/screen/#…`
  already works for loopback pages (tvpipe's browser may reach
  127.0.0.1; sound included). To check in phase B: the page's own
  WebSocket to the party server from inside the captured tab, and
  autoplay of game sounds (the capture runs as a user gesture).
- **Video screen**: `stream()` with raw RGBA and PCM, as today.
- To verify in phase B: the Cloudflare client with Node's HTTP server
  (chunked responses, keep-alive, WebSocket upgrade through `cftunnel`;
  the party server sends `Content-Length` everywhere anyway).

## 4. `@tvpipe/party`

`npm/party/`, ESM, Node ≥ 22, erasable TypeScript like the SDK, zero
runtime dependencies besides `@tvpipe/sdk` (used only for the tunnel, the
QR code and the TV). The browser client is a plain ES module with JSDoc
types (`client/party-client.js`, type-checked with `checkJs`): served as
is, no bundler for games.

```
npm/party/src/
  server.ts      node:http server: static dirs, /party/*, upgrade → ws
  ws.ts          RFC 6455 server side (frames, ping/pong, close, limits, bufferedAmount)
  room.ts        rooms, players, roles, VIP, lock, kick
  sync.ts        per-client views, diffs, coalescing
  limits.ts      token buckets, size limits, join throttling
  names.ts       name normalisation and uniqueness
  tv.ts          screen helpers: toTv({ to, mode: "web" | "video" }), QR drawing
  index.ts
npm/party/client/party-client.js   the browser client (+ .d.ts)
```

### Endpoints (one server, one port, loopback only)

| Path | What |
|---|---|
| `/` … | the game's phone directory (`index.html`, its assets) |
| `/screen/` … | the game's screen directory (web screens only) |
| `/party/client.js` | the browser client |
| `/party/ws` | the WebSocket (everything with data goes here) |
| game routes | `party.route(method, path, handler)` for anything else |

Static files: GET/HEAD only, no directory listings, `..` and absolute
paths refused, a fixed MIME table, `Content-Length` always,
`X-Content-Type-Options: nosniff`, a default CSP (`default-src 'self';
img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'`) a game may
widen, `Cache-Control: no-cache` (ETag by size+mtime). Nothing on HTTP
needs a key: pages and assets are public; every piece of data is behind
the WebSocket's `hello`.

### Links

- **Join** (in the QR code, on the TV): `https://HOST/?r=BCDF#k=JOINKEY`.
  `r` is the room code; the key sits in the fragment, so it never shows up
  in request lines, logs or `Referer` (the WebSocket `hello` carries it).
- **Screen** (local, for `share`): `http://127.0.0.1:PORT/screen/#r=BCDF&k=SCREENKEY`.
- **Watch** (optional, public, read-only screen for remote players):
  `https://HOST/screen/#r=BCDF&k=WATCHKEY`.

One server can hold several rooms (a hosted deployment); a game on a TV
uses one, made by `createParty()`.

## 5. The protocol (version 1)

The protocol as it is now, with the later additions (continuous input,
the WebRTC fast path), is specified in `docs/party-protocol.md`; this
section is the original design.

One WebSocket per client at `/party/ws`, JSON text messages with a `t`
field; binary messages are reserved (version 1 sends drawings as compact
JSON, §10). Unknown `t` and unknown fields are ignored by both sides.

### Roles

| Role | Joins with | Gets | May send |
|---|---|---|---|
| `player` | join key + name (or a resume token) | roster, `room` (players' shared state), `me` (own private state) | actions |
| `screen` | screen key | roster, `screen` state, `join` (code, URL, QR rows) | actions (e.g. "reveal animation done") |
| `watch` | watch key | like `screen` | nothing |
| `audience` | (later) | — | — |

### Messages

Client → server:

| `t` | Fields |
|---|---|
| `hello` | `v` (1), `room`, `role`, `key`, `name` (players, first join), `resume` (a token from an earlier `welcome`), `agent` |
| `act` | `id` (integer, increasing per player), `type`, `data` |
| `ping` | `c` (client clock, ms) |
| `resync` | — ask for a full state (after a gap in `rev`) |
| `leave` | — the player leaves for good |

Server → client:

| `t` | Fields |
|---|---|
| `welcome` | `v`, `room` (`code`), `you` (`id`, `name`, `role`, `vip`, `resume`, `lastAct`), `now` (server clock, ms), `view` (the full state), `rev` |
| `state` | `rev`, `set` (a nested object merged into the view: objects merge, everything else replaces, `null` included), `del` (key paths removed); or `full` (the whole view, the answer to `resync`) |
| `ack` | `id`, `ok`, `result` or `error` (`code`, `message`) |
| `msg` | `type`, `data`: transient (a sound cue, a toast); not replayed |
| `pong` | `c`, `now` |
| `bye` | `reason` (`kicked`, `replaced`, `room-closed`, `locked`, `full`, `bad-key`, `no-room`, `no-player` (a resume token nobody has, and no name), `name-taken`, `name-invalid`, `rate-limited`, `slow`, `protocol`), optional `message`, then a close |

Close codes: 4000 + a reason (`4002` protocol, `4003` bad key, `4004`
no room, `4005` no player, `4006` name taken, `4007` name invalid, `4008`
rate limited, `4009` replaced, `4010` kicked, `4011` room closed, `4013`
slow, `4029` full or locked). The client reconnects on everything else
(network loss, 1001, 1006, 1012, 4013) with backoff 0.25 s doubling to
5 s plus jitter, and at once when the page becomes visible again; never
after a `bye` other than `slow`.

### State sync: views, not events

The host never tells a phone *what happened*; it sets *what the phone
shows*. Each client has one **view**: `{ roster, room | screen, me }`.

- `roster`: kept by the library: `[{ id, name, connected, vip }]` in join
  order.
- `room`: the game's state for every player (`party.room.set(...)`);
  `screen`: the state for screens (`party.screen.set(...)`); `me`: one
  player's own state (`player.set(...)`).
- Changes made in one tick are coalesced (`queueMicrotask`) and sent as
  one `state` diff per client against what that client last got; `rev`
  increases by one per message, a client that sees a gap sends `resync`.
- A reconnect gets the full view in `welcome`, so anything a returning
  phone must see belongs in a view. `msg` is for what may be lost.
- The same `screen` view drives a web screen and the video renderer
  (`party.screen.view` on the host, `party.on("screen", …)`), which is how
  one game gets both main-screen variants.

### Actions: exactly once across reconnects

- `act` ids increase per player identity; `welcome.you.lastAct` tells a
  reloaded page where to continue.
- The client keeps unacknowledged actions (at most 32) and sends them
  again after a reconnect; the server answers a repeated id from a cache
  of the last 32 results without calling the game again. A submit that
  raced a dying connection is therefore applied once.
- The game's handler returns a result (`ack.result`) or throws
  `new PartyError(code, message)` (`ack.error`); unknown types get
  `unknown-action`. `party.collect(type, { from, until })` waits for one
  action per player or a deadline (the shape of most Jackbox phases).

### Players, identity, reconnects

- A new `hello` with a name creates a player: `id` (short, stable for the
  game), `resume` (128 random bits; the client keeps it in `localStorage`
  under the room code and host). The page also remembers the name.
- `hello` with a known `resume` is the same player: `connected` again,
  the full view, pending actions replayed. A second socket with the same
  token replaces the first (`bye replaced`): the newest tab wins.
- A lost socket makes the player `connected: false` (`away` event); the
  game decides what that means (skip their vote at the deadline). Players
  are removed only by `leave`, `party.kick()` or the game.
- **VIP**: the first player; passes to the next connected one when the
  VIP leaves; the host may pick another (`party.makeVip(player)`, the
  host pages' "Make VIP"). The VIP starts the game ("everybody's in").
- `party.lock()` (the game started): new names are refused (`bye
  locked`), resumes still work. `maxPlayers` (drawbluff: 50) and
  `minPlayers` (3) are the game's. Drawbluff no longer locks: a name
  that joins mid-game plays from the next round.
- **Clock**: `ping`/`pong` on connect (five) and every 10 s; the client
  keeps the offset of the shortest round trip (as the player page does)
  and exposes `client.now()`. Deadlines in views are server times, so a
  phone and the TV count down to the same instant.

### Backpressure

- Server → client: per socket, `state` is latest-wins: while a socket has
  more than 64 KiB unsent (`writableLength`), diffs are not built; on
  `drain` one diff against the last sent view catches up. `msg` and `ack`
  queue up to 256 KiB; beyond that the client is closed with `4013 slow`
  and resumes (getting the full view). Behind a tunnel this keeps one
  phone on a bad network from filling the shared relay link.
- Client → server: a token bucket per socket (20 messages/s, burst 50),
  at most 256 KiB per message (drawings) and 16 KiB for anything but
  `act`; beyond: `bye rate-limited`. The client sends nothing while
  `bufferedAmount` is over 64 KiB, and drawing UIs submit once, not per
  stroke.
- Liveness: WebSocket pings from the server every 15 s (tunnels drop idle
  sockets; Cloudflare after 100 s), closed after 45 s without a pong.

## 6. Security and abuse

- **Keys.** Join, screen and watch keys per room, resume tokens per
  player: 128 bits from `crypto.randomBytes`, base64url, compared with
  `timingSafeEqual`. The screen key never leaves the machine (the local
  `share` URL); the join key is in the QR code and the link on the TV
  (whoever sees the TV may play: the Jackbox model). The room code alone
  is not enough to join, so someone who learnt a fresh tunnel hostname
  (scanners do within seconds, `docs/tunnels.md`) cannot join.
- **Host check.** The server binds `127.0.0.1` only and accepts `Host`
  `127.0.0.1:PORT`, `localhost:PORT`, `[::1]:PORT` and the tunnel's host
  (from tvpipe's `tunnel` event): 421 otherwise (DNS rebinding).
- **Origin check.** WebSocket upgrades need `Origin` `https://TUNNELHOST`
  or `http://` a loopback name with the port; anything else is 403
  (cross-site WebSocket hijacking). Clients without `Origin` (tests,
  non-browsers) are let in; they still need a key.
- **Limits** (above) plus: `hello` within 5 s; at most 64 sockets per
  server and 16 per room beyond the players; joins per address
  (`cf-connecting-ip`, or the socket's) 20 per minute; failed keys are
  logged (a scanner shows up) and slowed down.
- **Content.** Everything a player sends is untrusted: the library
  normalises names (NFC, control and bidi-override characters removed,
  whitespace collapsed, 1–16 graphemes, unique case-insensitively); games
  validate their actions (drawbluff: point counts, coordinate ranges,
  text lengths). The client helpers and both screens render text with
  `textContent`/canvas `fillText`, never as HTML; the CSP forbids inline
  scripts.
- **Profanity and abuse.** Party games show strangers' words and drawings
  on a big screen, often in front of children. No word list ships
  (language-specific, both over- and under-blocks); instead: a
  `moderate(text, { kind, player })` hook on the server for names and
  every text the game shows (return a replacement or refuse), the VIP and
  the host can kick (`party.kick`, a "remove player" on the TV's lobby
  and the VIP's phone), a "family mode" switch a game may offer (hide
  names, skip free text), and the join key so only people who see the TV
  join. Drawings cannot be filtered; kicking is the answer, as in
  Jackbox.
- **Privacy.** With Cloudflare, Cloudflare reads everything (names,
  drawings, keys); OpenTunnel ends TLS in tvpipe. The link dies with the
  process; nothing is stored on disk except what the game stores.

## 7. The main screen on the TV

| | Web screen (variant 2) | Video screen (variant 1) |
|---|---|---|
| What renders | a page in tvpipe's own browser (`share URL`) | the game's code, frames into `stream()` |
| How | `share(party.screenUrl, { to })` | `stream({ to, video, audio })` + `drawLoop(canvas, (ctx, t) => render(ctx, party.screen.view, t))` |
| Sound | the page's (Web Audio, `<audio>`) | PCM the game writes |
| Needs | Chrome/Edge/Chromium/Brave or Firefox | a 2D canvas in Node (§10) or raw RGBA |
| Also viewable | in any browser (HDMI laptop, a remote friend: the watch link) | `--to browser`, public via the player's tunnel |

`party.toTv({ to, mode })` wraps both and restarts the TV session when it
ends unexpectedly; the phones never notice (separate processes).

**The QR code on the TV.** The library makes the join URL's QR once
(`@tvpipe/sdk` `qr()`), puts `join: { code, url, qr: { size, rows } }`
into every screen view, and draws it: `PartyClient.qrSvg(join.qr)` in a
web screen (an SVG string from the rows: no endpoint, no key in an image
URL), `drawQr(ctx, join.qr, x, y, px)` for a canvas in the video path,
`qrToRgba()` without a canvas. Big in the lobby (at least ~8 px per
module at 720p, 4 modules of quiet zone, dark on white), with the URL as
text below (for people who type) and the room code; small in a corner
during the game, for latecomers and phones that lost the page. The
terminal shows the same QR code (`tvpipe debug tunnel` on a TTY) for the
person setting up.

**Remote players** use the same join link; they watch the main screen
through the watch link (web screen: the page itself, crisp and cheap) or
tvpipe's public player (video screen: `to: ["Living Room", "browser"],
player: { tunnel: true }`, a second tunnel).

## 8. Latency budget

Party games are turn-based with timers in seconds; what matters is that
the phone answers at once (local UI), the TV follows within half a
second, and deadlines are fair.

| Step | Video screen | Web screen |
|---|---|---|
| Phone → host (tunnel, one way; `docs/tunnels.md`: RTT median/p95 Cloudflare 12/80 ms, OpenTunnel 44/110 ms) | 6–40 ms (CF), 22–55 ms (OT) | same |
| Host logic, diff | < 1 ms | < 1 ms |
| Host → screen page (loopback) | — | < 1 ms |
| Render | canvas 3–10 ms, waits for the next frame tick (≤ 33 ms at 30 fps) | next animation frame (≤ 16 ms) |
| Capture + encode | built-in H.264, 720p ~5–15 ms | tab capture ≤ 33 ms + WebCodecs 5–20 ms |
| Playout delay | Cast 300 ms, AirPlay 100–250 ms, browser 100 ms | same |
| **Phone tap → TV** | **~0.35 s Cast, ~0.15–0.3 s AirPlay** | **~0.4 s Cast, ~0.2–0.35 s AirPlay** |
| Host → phone | 6–55 ms | same |

Consequences: phones draw and type locally and submit once; the host
judges order and deadlines by its own clock (never by what the TV
shows); a deadline gets 500 ms of grace (tunnel p95) before `collect`
closes. A LAN mode (the server also on the LAN
address, phones on the same Wi-Fi, ~5 ms) is a later option; it trades
the tunnel's https and reachability from mobile data for latency.

### 8.1 Keeping phones with the TV

The table's "phone tap → TV" is also how far the TV is behind every
change the host makes, while phones see it after one tunnel hop. Left
alone, phones run ahead of the picture: the vote is on the phone before
the drawing is on the TV, a phone gives away the result the TV is about
to reveal, the TV's countdown ends a quarter to half a second after the
phones'. The library closes the gap with one number and two rules
(protocol: `docs/party-protocol.md` §7.1):

- **The TV's delay** (`party.tvDelay`): tvpipe reports each receiver's
  playout delay (`delayMs` in the `cast` and `surface` statuses; Cast's
  target delay, AirPlay's video lead, the player page's delay); a
  `HostedParty` takes the slowest connected receiver of any picture and
  adds the TV's own lag (`TV_DISPLAY_MS`, 120 ms: the Apple TV measured
  ~250 ms glass to glass at a 100 ms lead) and a frame of rendering
  (`TV_RENDER_MS`, 30 ms); the `browser` receiver gets no TV lag. Clients
  learn it in `welcome` and `tv` messages. A game can set its own
  (`tvDelay` option or setter, e.g. from a calibration screen): then the
  casts no longer change it.
- **What the TV shows, phones show with it**: changes made in
  `party.withTv(fn)` go out at once, stamped with `at` = now + delay;
  phones and watchers apply them then, TV pages at once. Phones get them
  early (the tunnel's jitter is absorbed) and hold them; later messages
  wait behind so the order never changes. Only what the game wraps waits:
  a phone's own feedback (an action's `done: true`) stays instant.
- **The TV draws ahead**: a TV page's `now()` is the host's clock plus
  the delay, the time its picture will be seen, so countdowns to the
  same deadline end on the TV and the phones together; deadlines come
  from `party.deadline(ms)` (now + delay + ms), so every player gets the
  whole time from when they see the question. A surface drawn in the
  host page uses `party.screenNow()`.

For fast-reaction games, actions carry `at` (when the phone sent them,
on the synced clock): `info.sentAt` orders presses by when people
pressed rather than by their tunnels, bounded to the second before
arrival (a phone's word, not proof). Since phones are with the TV,
reaction times can be measured from what the TV showed.

Not done: measuring the TV's own lag (a calibration step, e.g. a phone's
microphone hearing a chirp the TV plays, stored per receiver); one
delay serves every TV (the slowest), as tvpipe gives every receiver the
same budget anyway.

## 9. A game author's view

Host (Node):

```ts
import { createParty, PartyError } from "@tvpipe/party";

const party = await createParty({
  phone: new URL("./web/phone", import.meta.url),
  screen: new URL("./web/screen", import.meta.url),   // or a render function, below
  tunnel: "auto",
  players: { min: 3, max: 8 },
});
await party.toTv({ to: "Living Room", mode: "web" });
console.log(`join: ${party.joinUrl}`);

party.screen.set({ phase: "lobby" });
party.room.set({ phase: "lobby" });

party.handle("start", (player) => {
  if (!player.vip) throw new PartyError("not-vip", "Only the VIP starts the game");
  void play();
});

async function play() {
  party.lock();
  const deadline = party.now() + 60_000;
  party.room.set({ phase: "answer", deadline });
  party.screen.set({ phase: "answer", deadline });
  const answers = await party.collect("answer", { until: deadline });  // Map<Player, data>
  party.screen.set({ phase: "results", answers: [...answers.values()] });
}
```

Phone (`web/phone/index.html` + a module):

```js
import { PartyClient } from "/party/client.js";

const party = PartyClient.fromLocation();       // r and k from the link
await party.join(localStorage.name ?? prompt("Your name?"));
party.on("view", (view) => render(view));        // { roster, room, me }
button.onclick = () => party.act("answer", { text: input.value });  // acked, resent after reconnects
```

Video screen instead of `screen:`:

```ts
import { createCanvas } from "@napi-rs/canvas";
const canvas = createCanvas(1280, 720);
await party.toTv({ to: "Living Room", mode: "video", canvas,
  render: (ctx, view, t) => drawScreen(ctx, view, t) });   // view = party.screen.view
```

## 10. Drawbluff (the demo game)

Rules (Drawful's shape, our own prompts and names): 3–8 players, two
rounds (round 2 scores double). This section is the classic game as
first built; it now takes 3–50 players in one mode (spotlights and a
gallery, rotating liars, pipelined lies, sampled options, points per
exposure), described in [`drawbluff-scale.md`](drawbluff-scale.md).

1. **Lobby**: QR and players on the TV; the VIP starts.
2. **Draw**: everyone gets their own prompt ("a nervous cactus") and
   draws it on the phone (90 s).
3. Per drawing, in random order:
   - **Lie** (45 s): everyone but the artist writes a fake title. A lie
     equal to the real title (normalised) is refused: "That's the real
     one! Write something else."; equal lies merge.
   - **Vote** (25 s): the real title and the lies, shuffled, on the TV
     and the phones (without the voter's own lie); everyone but the artist
     votes.
   - **Reveal**: lies one by one with who wrote and who believed them,
     then the truth. Points: a correct guess 1000 to the guesser and 1000
     to the artist per correct guesser; each player fooled 500 to the
     liar.
4. **Scores** after each round; **final** podium; the VIP may play again.

Phases are the game's state machine on the host, using `collect` with
deadlines; away players are skipped at deadlines.

**Drawings** are vector strokes: `{ w: 1000, h: 1000, strokes: [[color,
width, x0, y0, x1, y1, …], …] }`, integers on a 1000×1000 grid, a fixed
8-colour palette, at most 300 strokes and 12 000 points (~60 KB JSON).
Validated on the host; drawn identically by the phone's canvas, the web
screen's canvas and the Node canvas of the video screen, scale-free.

Layout:

```
games/drawbluff/
  game/            rules, phases, scoring, prompts (pure TS, unit-tested, no I/O)
  web/phone/       the phone UI (shared by both variants): name, lobby, canvas, lie, vote, scores
  web/screen/      the TV page (variant 2)
  screen-video.ts  the video renderer: (ctx, view, t) → pixels (variant 1)
  main.ts          `node main.ts --to "Living Room" [--video] [--tunnel=opentunnel]`
  test/
```

The two variants differ only in the screen: `--video` renders frames
with `screen-video.ts` and `stream()`, otherwise tvpipe casts
`web/screen/`. The video renderer needs text in several sizes and
anti-aliased strokes: **`@napi-rs/canvas`** (prebuilt Skia, no install
scripts or system libraries, MIT) as a dependency of the game only, not
of the party library, with the fonts tvpipe already ships
(`crates/tvpipe/src/browser/fonts/`, OFL). The zero-dependency
alternative is raw RGBA with a public-domain bitmap font and our own
stroke rasteriser: retro, ASCII-only text (no "é" in names). Sound: a few
generated tones (join, timer, reveal) as PCM in the video variant, the
same as WAV files on the web screen.

## 11. Tests

- **Library, in process** (`node --test`): the WebSocket server against
  Node's `WebSocket` client and hand-made frames (fragmentation, masking,
  oversize, bad UTF-8, ping/pong, close codes; never a crash on bad
  input); static serving (traversal, MIME, HEAD); Host/Origin/key checks;
  join, names, VIP hand-over, lock, kick; resume after a dropped socket
  with the full view; action replay applied once; diff/merge round trips
  (property-style: random views, the client's merge equals the server's
  view); coalescing; slow consumers (a client that does not read);
  rate limits; `collect` with deadlines and away players.
- **Drawbluff**: rules and scoring as pure functions (lies equal to the
  truth, merged lies, nobody fooled, everyone fooled, round 2 doubling);
  whole games with 3 and 8 fake phones over real WebSockets, including a
  phone that drops mid-vote and resumes, and one that never answers.
- **Video renderer**: renders every phase into a canvas without throwing,
  QR modules land on the expected pixels.
- **Live**: both variants with `--to browser` (headless Chrome as the
  viewer, screenshots of each phase; the web screen through `share URL`),
  fake phones driving the game; then the tunnel (Cloudflare unless it
  answers 429, else OpenTunnel) with a real phone if the owner wants.
- **tvpipe**: `tunnel` against the fake OpenTunnel relay (exists) and the
  CLI/machine tests for `tunnel` and `qr` events; QR SVG known answers.

## 12. Plan and open questions

Phase B, in order (each step committed green, never pushed):

1. `@tvpipe/party`: ws, server, rooms, sync, client, tests (no tvpipe
   needed: `tunnel: false`, local URLs).
2. drawbluff: rules, phone UI, web screen, video screen; tests with fake
   phones.
3. tvpipe: `tunnel PORT` and `qr` (CLI, `--machine`, docs, tests), the
   SDK's `tunnel()` and `qr()`; rebased onto the public Rust API once
   rust-lib phase 4–6 lands, adding `tvpipe::Tunnel`/`tvpipe::qr`. Until
   then the CLI touches stay small (`cli.rs`, `machine.rs`, one new
   module) to keep the merge easy.
4. Live checks (§11), docs (`npm/party/README.md`, a manual page "Party
   games", `docs/party-protocol.md` split out of §5).

Questions for the owner:

1. Bus in the party library (B) rather than an app-server mode in tvpipe
   (A)?
2. Names: `tvpipe tunnel PORT`, `tvpipe qr TEXT` (now `tvpipe debug tunnel`, `tvpipe debug qr`); `@tvpipe/party` in
   `npm/party/`; the game `drawbluff` in `games/drawbluff/`.
3. `@napi-rs/canvas` for the video variant (in the game only), or the
   zero-dependency bitmap-font renderer?
4. `@tvpipe/party` versioned in lockstep with tvpipe and released by
   `release.yml`, or on its own (it speaks to tvpipe only through the
   SDK)?

## 13. As built

Decided with the lead (for the owner, 2026-11-19): the bus lives in
`@tvpipe/party` (§2 B); tvpipe adds only `tunnel PORT` and `qr TEXT`
(+ the SDK's `tunnel()`/`qr()`; a public Rust `tvpipe::Tunnel`/`qr` API
later); `@napi-rs/canvas` only as an optional dependency of Drawbluff;
`@tvpipe/party` versioned with the crate (0.2.0; CI and the release job
check it; publishing waits).

What changed against the design while building it:

- **tvpipe**: `tunnel PORT [--tunnel=PROVIDER] [--no-qr]` (event
  `tunnel` with `page: "port"`; `TunnelPage::Port` is a new, non-breaking
  variant) and `qr [--svg | --rows] TEXT` (plain stdout; refused with
  `--machine`, whose stdout is events). No `qr` event: the SDK runs
  `tvpipe debug qr --rows` once per code. Internal: `Command::Tunnel`/`Qr`,
  `Qr::rows`/`to_svg`, doc-hidden `__cli` re-exports. The `tunnel`
  event has no `host` field (§3.1): the SDK takes it from `url`.
- **Join throttling** counts only failed `hello`s (wrong key, unknown
  room, garbage), 20 per address and minute: a living room's phones share
  one public address (Cloudflare's `cf-connecting-ip`), and through
  OpenTunnel every visitor is 127.0.0.1, so counting every join would
  lock out a party. Joins are bounded by `maxPlayers`, sockets by 64.
- **`rate-limited` is final** for the client: a client that floods would
  flood again after reconnecting (its pending actions all at once).
- **`collect`** waits, with a deadline, also for players who are away
  (they may come back before it: a phone whose screen locked while
  drawing); `skipAway` stops waiting for them; `reply` makes the
  acknowledgement's result (Drawbluff answers a lie with its display form).
- **Screens' actions** are deduplicated per connection only (screens have
  no lasting identity).
- **The repository's binary**: Drawbluff and the live scripts use
  `target/release/tvpipe` (or `debug`) when `TVPIPE_BINARY` is unset.

Measurements (2026-11-19, Vienna, macOS 26, release build, the client on
the same Mac as the host, so each number crosses the internet twice):

| | Cloudflare | OpenTunnel |
|---|---|---|
| `createParty` to a working link | 6.6–7.2 s | 0.2 s (identity made before) |
| `act` round trip through the link (100, `test/live-rtt.ts`) | median 16.5–17.1 ms, p95 19.7 ms, max 26 ms | median 43 ms, p95 47 ms, max 54 ms |

Live checks (`games/drawbluff/test/live/play.ts`): a whole game with two
bots and a phone in headless Chrome (joining, drawing with touch events,
a lie, a vote), the TV in tvpipe's browser player, for the web screen and
the video screen, locally and with the phone on the public Cloudflare
link; screenshots of the TV and the phone in every phase matched. With
`--bots 49` the same check plays a full room of 50 on both hosts and
both screens (results in [`drawbluff-scale.md`](drawbluff-scale.md) §11). Not yet
checked: a real TV (Apple TV, Chromecast) and a real phone scanning the
QR code from a TV.
