# Party games without tvpipe: tvpipe.party in the browser

Status: being built (branch `browser-party`). Extends
playshare-design.md (the host page, the relay), party-protocol.md
(unchanged on the wire), short-links.md (the code registry) and
game-switching.md (the room outlives a game). The UX was judged on a
mock-up first: every question under "Decisions" was answered "good".

## Why

`tvpipe game play` needs a computer with tvpipe on it. Many people who
would play have only a laptop, or only an iPad. The games themselves are
already web pages: the host page runs the rules in a browser, phones run
the phone page, the TV shows the TV page. What tvpipe adds is serving the
bundle, relaying the phones' sockets to the host page, the tunnel, and
casting to AirPlay and Cast. All but casting can move to the browsers and
to tvpipe.party, without tvpipe.party carrying game traffic.

## Decisions (the owner's)

- **A browser-only mode on tvpipe.party**, for the games of the list
  only. Games from a folder or zip and development games stay with the
  app (bots still work on the web with `?bots`).
- **Phones talk to the host page over WebRTC data channels.**
  tvpipe.party relays no game traffic.
- **Connecting:** public STUN first; **Cloudflare TURN** as the
  fallback, with short-lived credentials from the Worker.
- **Signaling:** a **Durable Object per room** with hibernating
  WebSockets, on the free plan. No polling.
- **One launcher, one question.** The app and the web share the steps
  and the look; "Pick the TVs" becomes **"Where should the game show?"**,
  whose options depend on the device, the best one selected.
- **Table mode:** no separate host screen. The room's controls sit behind
  ⋯ on the shared screen; starting and rounds stay on the VIP's phone.
- **The web launcher shows Apple TV and Chromecast greyed out** with
  "needs the tvpipe app", linking to the install.
- **AirPlay mirroring is instructions only**: a page can neither start
  nor detect it.
- **Any browser can be an extra screen** of any room (`tvpipe.party/tv`
  and the code), approved by the host.
- **Later, the app's phones use WebRTC too**, with the tunnel as the
  fallback (not in this branch).
- **One name for users:** everything people open is tvpipe.party; the
  command and its window are "the tvpipe app".

## The setups

| Setup | Runs the game | Shows it | Install | TV delay |
|---|---|---|---|---|
| Laptop + Apple TV / Chromecast | the app's window | AirPlay, Cast (as today) | the app | ~250 ms (measured, measurements.md) |
| Laptop + cable | the app's window or a browser tab | a full-screen window on the second display | none | ~0 |
| Laptop alone | a browser tab | the same screen, full screen | none | none |
| iPad on the table | Safari (or a Home Screen app) | the iPad | none | none |
| iPad + Apple TV | Safari | the iPad, mirrored by iPadOS | none | ~0.1–0.3 s (not measured) |
| Laptop + Chromecast, no app | a Chrome tab | Chrome's own "Cast tab" (instructions) | none | ~1 s (not measured) |

Whatever runs the game, the room is the same: a code, a join key, the QR
code and `tvpipe.party/CODE`. Phones never learn the setup.

## Web mode

The games are unchanged. They import `@tvpipe/party` from
`/_tvpipe/lib/` (games.md); tvpipe.party serves its own copy of the
library there, built from the same source, in which `mode.js` says
`WEB = true` (the crate's copy says `false`). In web mode:

- `Tvpipe.connect()` returns a `Tvpipe` whose calls are answered in the
  page by `WebHub` (`webhub.ts`) instead of tvpipe's API socket: `info`,
  `devices.watch`, `select`/`selection`, `cast.start`/`cast.stop`,
  `shortlink`, `qr`, `quit`, `relay.attach`, the games list. Pairing,
  `tvsync.set` and surfaces answer `unsupported`.
- `relay()` gives a `WebRtcRelay`: the host side of the data channels.
- `PartyClient.fromLocation()` connects over a data channel
  (`role` player and watch) or, for the host's own screens (`role`
  screen, and the host page's preview, whose watch link has `local=1`),
  over the local transport. A client made with a URL and no `WebSocket`
  (the games' bots in the host's tab, `/_tvpipe/ws`) uses the local
  transport too.

### The session (per tab, `sessionStorage["tvpipe-web"]`)

```ts
interface WebSession {
  room?: { code: string; key: string; secret: string; short: string };  // registered
  screen?: "this" | "window" | "cable" | "none";                       // the launcher's choice
  game?: { name: string; release: string };                            // the game in the slot
  screens?: string[];                                                  // approved extra screens' tokens
}
```

A reload keeps the room (game-switching.md: the room is the run's); a
new tab makes a new one.

## The launcher

One launcher in `@tvpipe/party` (`launcher/`), used by the app (with
tvpipe's API) and by the web (with `WebHub`). Steps: the games list,
"Where should the game show?", Start. In web mode the devices are
screens, `kind: "browser"`, with these names:

| Device name | Offered | Cast does |
|---|---|---|
| `this` "This screen" / "This iPad" | always; the best on touch devices | the TV page full screen in the host's tab, the host page behind ⋯ |
| `cable` "The TV on the cable" | `screen.isExtended` (Window Management API: Chrome, Edge) | a window of the TV page placed full screen on the other screen; controls stay |
| `window` "A second window" | browsers without touch and without a second screen (`cable` not offered) | a window of the TV page; "drag it onto the TV, then Full screen" |
| `none` "Another screen" | always | nothing here: screens join at `tvpipe.party/tv` |

Apple TV by mirroring (iPadOS, iOS, macOS) is instructions, then `this`.
Apple TV and Chromecast show greyed out with "needs the tvpipe app".
Chrome's "Cast tab" is instructions under "More".

Where the TV page runs in the host's tab or in a window of it, it is a
`role=screen` client over the **local transport** (`BroadcastChannel`),
not WebRTC.

## Rooms and codes

The code registry is short-links.md's D1 table, shared: a code is
either an app's short link or a web room, never both. A web room
registers the join link

```
ORIGIN/r/?r=CODE#k=KEY          (ORIGIN: the service's own, https://tvpipe.party)
```

with `POST /api/links {url, code}`, where `code` must be the link's
`CODE` (or left out; another code: `400 bad-request`): for a web link
the service takes exactly that code or answers `409 code-taken`, and the
page tries another random code (at most 8 times). `ORIGIN` is the
request's own origin, checked on the string (so `wrangler dev` works on
`http://localhost:8787`; another origin's link: `400 bad-url`). Refresh
(`PUT`, every 6 hours while the room lives; a new `url` only under its
own code) and delete (`DELETE`, at Quit) as short-links.md. `GET /CODE`
redirects to `/r/?r=CODE#k=KEY` for a web room.

The join key is in the stored link, so tvpipe.party knows it, as it does
for the app's short links. That is fine: tvpipe.party serves the pages'
code, so nothing could protect a room from it anyway. The key keeps
doing what it does now: the host admits a `hello` only with it
(party-protocol.md). Signaling needs no cryptography of its own.

## Signaling (a Durable Object per room)

`Room` objects (`env.ROOMS`, `idFromName(CODE)`), SQLite-backed, free
plan. All messages are JSON text.

| Request | |
|---|---|
| `GET /api/rooms/CODE` | `{code, host: bool, game: {name, title, release, phone} \| null}`; `404 no-room` when `CODE` is no web room; 120 a minute per address (`ROOM_LOOKUPS`; a party behind one address loads `/r/` in bursts), then `429` with `Retry-After` |
| `GET /api/rooms/CODE/host` (WebSocket) | the host; first message `{t: "host", secret}` within 10 s, checked against the registry (the secret's hash, a web link) |
| `GET /api/rooms/CODE/join?QUERY` (WebSocket) | a phone or screen, for one connection |
| `GET /api/turn` | `{iceServers, ttl}` |

The sockets need `Upgrade: websocket` (else `426`); a join's query is
at most 1 KiB (`414`); a code that is no code: `404 no-room`.

**The host socket.** After a good `{t: "host", secret}` the object
answers `{t: "hosted"}`; a bad one: `{t: "error", code: "bad-secret"}`
and close 4003. A newer host socket replaces the older one (`{t:
"replaced"}`, close 4009). Host → object: `{t: "game", game: {name,
title, release, phone}}` (kept, answered by `GET /api/rooms/CODE`),
`{t: "answer", conn, sdp}`, `{t: "reject", conn, reason}` (`game:
null` clears the game; other types are ignored). Object → host: `{t:
"offer", conn, sdp, query, addr, agent}` (`addr`: `CF-Connecting-IP`,
`agent`: `User-Agent`, at most 256 characters; `query` without the `?`).
The game is the registry row's owner's: a code given to another room
(stale, short-links.md) shows no old game. No `{t: "host"}` within 10 s:
`{t: "error", code: "timeout"}`, close 4002; a first message that is no
`host`, or a host message that is malformed: `{t: "error", code:
"bad-message"}`, close 1008; the registry failing: `{t: "error", code:
"unavailable"}`, close 1011 (retry). Pings: the text `ping` is
answered `pong` by `setWebSocketAutoResponse`, without waking the
object; pages ping every 30 s.

**A join socket.** The client sends `{t: "offer", sdp}`. No host:
`{t: "no-host"}` and close 1013 (the client retries after a while, as
for the relay's `503`). Else the object numbers the connection (`conn`,
a `u32` never reused in the room) and passes the offer on; the host's
answer comes back as `{t: "answer", sdp}`, a refusal as `{t: "reject",
reason}`, nothing within 15 s as `{t: "timeout"}`; the object closes the
socket after either (1000). The client may close it earlier. Offers
waiting for an answer get `{t: "no-host"}` (1013) when their host
disconnects or is replaced (its answers would never come).

**Limits** in the object: offers per address 30 a minute, per room 5 a
second with a burst of 30, messages up to 16 KiB, sockets up to
`2 × 64 + 16` open joins per room (and 8 host sockets). Past them, and
for other mistakes, a join socket gets (`{t: "error", code}`, then the
close):

| Error | Close |
|---|---|
| a message over 16 KiB (no message) | 1009 |
| `rate-limited` (offers) | 4008 |
| `full` (open joins) | 1013 |
| `bad-message` (not JSON, not an offer, a second offer) | 1008 |
| `timeout`: no offer within 10 s of the upgrade | 4002 |

The rate limiters live in the object's memory and start afresh when it
hibernates; deadlines are in the sockets' attachments and run on the
object's alarm. A room's storage (the game, the connection counter, the
owner) is dropped 25 hours after its host left, when no socket is open.

**No trickle:** both sides wait for ICE gathering to finish (at most
3 s) and send one description each: one offer, one answer per join.

**Cost** (free plan: 100,000 Worker requests and 100,000 Durable
Object requests a day, 100,000 SQLite row writes): a WebSocket is one
Worker request and one object request, incoming messages count one per
20, alarms one each; idle rooms hibernate (pings are answered without
waking them). A join costs a Worker request, an object request, about
one alarm (the deadlines of a burst of joins share it) and a row write
or two (the connection counter, the alarm); a host connection the same plus a few writes.
`GET /api/rooms/CODE` is a Worker request, a D1 read and an object
request.

## TURN credentials

`GET /api/turn` → `{iceServers: [...], ttl}`: public STUN
(`stun:stun.cloudflare.com:3478`, `stun:stun.l.google.com:19302`) and,
when the Worker has `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`, Cloudflare
TURN credentials from
`POST https://rtc.live.cloudflare.com/v1/turn/keys/ID/credentials/generate-ice-servers`
with `{ttl: 3600}` (its STUN and port 53 left out: browsers block
it). 60 a minute per address (`TURNS`), then `429`. Without the secrets:
STUN only, `ttl` 21600; when Cloudflare fails: STUN only, `ttl` 300.
Pages fetch it before each offer or answer (cached for `ttl / 2`). The
Worker shares credentials for half their life (an isolate asks
Cloudflare once per 30 minutes); `ttl` is what is left of their life.

**The monthly cap** (TURN is free up to 1,000 GB a month): a Cron
Trigger reads this calendar month's (UTC) TURN traffic of our key from
the GraphQL Analytics API every 10 minutes
(`callsTurnUsageAdaptiveGroups`, egress plus ingress) into D1. At
`TURN_MONTHLY_LIMIT_GB` (900 by default), or when the last successful
check is older than 2 hours or missing, `/api/turn` gives STUN only
(`ttl` 300); a new month starts at 0. Credentials last 1 hour, so a cut
takes effect within the hour. Without `TURN_ANALYTICS_TOKEN` (Account
Analytics Read) TURN is not capped.

## The transport (`@tvpipe/party`)

- **`WebRtcRelay implements Relay`** (host): holds the signaling socket
  (reconnects with backoff), answers offers with a new
  `RTCPeerConnection` each, and turns its data channel into a
  `RelayConn` (`via: "public"`, `address`, `agent`, `query` from the
  offer). It also takes the local transport's connections (`via:
  "local"`).
- **`DataChannelSocket implements WebSocketLike`** (clients): signaling,
  then one data channel; `PartyClient` gets it through its `WebSocket`
  factory.
- **One channel per peer**, label `party`, reliable and ordered.
- **Control messages** are text frames starting with `!`, JSON after it
  (the party protocol's messages start with `{`): `!{"t":"close","code":C,"reason":R}`
  before a close (a channel that ends without one is 1006), `!{"t":"ping"}`
  / `!{"t":"pong"}` every 15 s (closed after 45 s without a message;
  1006 as soon as the peer connection is `disconnected` for 5 s or
  `failed`: browsers drop a closed tab's connection without a word, and
  ICE notices in about 5 s), a page that goes (`pagehide`) closes its
  channel 1001, as a WebSocket would,
  `!{"t":"screen",...}` for extra screens (below).
- **Backpressure:** `busy` above 64 KiB of `bufferedAmount`, `drain` on
  `bufferedamountlow`.
- **Limits** (playshare-design.md §6.3) are kept by `WebRtcRelay`:
  messages up to **64 KiB** (1009), 20 a second with a burst of 50
  (4008), the connection limit (`2 × players.max + 16`), the first
  message within 10 s (4002).
- **The local transport**: `BroadcastChannel("tvpipe-local:CODE")`
  between the host's tab and its screens' windows, for `role=screen`
  (the screen key never leaves the browser), the host page's preview
  (`role=watch` with `local=1` in the link) and bots in the host's tab.
  On the channel: `{t: "open", id, query}`, `{t: "accept", id}`,
  `{t: "data", id, from, data}`, `{t: "close", id, from, code, reason}`
  (`from`: `h` or `c`), pings every 5 s (15 s without an answer: 1006),
  and `{t: "up"}` when a host page starts (open clients close 1012 and
  reconnect to it).
- **Another game's page**: pages under `/g/NAME/RELEASE/` join with
  `g=NAME/RELEASE` in the query; `WebRtcRelay` closes a connection of
  another game than its own with 4014 (the phone goes to `/r/`).
- **Refusals before the channel**: no host, `full`, a refused or timed
  out offer, a rate limit: `DataChannelSocket` closes 1013 (no host,
  refused, full) or 1006, never a final code, so `PartyClient` tries
  again with its backoff.
- **Built as** (top-level modules, served flat at `/_tvpipe/lib/`):
  `mode.ts` (`WEB`, `isWeb()`), `session.ts`, `qr.ts` (tvpipe's QR
  encoder, the same symbols), `rtc.ts` (browser APIs, `/api/turn`,
  gathering, the control framing), `signaling.ts` (`HostSignal`,
  `joinSignal`), `rtc-relay.ts` (`WebRtcRelay`), `rtc-socket.ts`
  (`DataChannelSocket`, `requestScreen`), `local.ts`, `screens.ts`
  (table mode, the windows, Wake Lock), `webhub.ts` (`WebHub`).

## Extra screens

`tvpipe.party/tv`: type the code (or `/tv/#r=CODE`). The page makes a
data channel with the query `screen=1&token=T` (`T`: random, kept in its
`localStorage`), and sends `!{"t":"screen","agent":…}`. The host asks
"A screen wants to join (BROWSER). Allow?" unless `T` was approved in
this room before; then it answers `!{"t":"screen","ok":true,"url":TV}`
(`TV`: the TV page with the watch key, `role=watch`) and closes 1000, or
`!{"t":"screen","ok":false}`. The `/tv` page shows `TV` full page in an
`<iframe>`; at the next game (4014) it asks again (approved silently).

## Pages on tvpipe.party

| Path | |
|---|---|
| `/play/` | the games list (web: the picker's page, its files at `/_tvpipe/picker/`), then the launcher; the web app's start: `/manifest.webmanifest` (`start_url` `/play/`, standalone, fullscreen where offered), `/icons/`, `/apple-touch-icon.png`, `/sw.js` (network first; pages and tvpipe.party's own files kept as they come by, `/offline.html` for a page never seen; not the API or the games' files). `/play/` and the launcher register it; `/play/` shows "Add to Home Screen" once on iPadOS and iOS |
| `/_tvpipe/lib/`, `/_tvpipe/launcher/`, `/_tvpipe/picker/`, `/_tvpipe/tvsync/`, `/_tvpipe/wait/` | the library (web build: `mode.js` says `WEB = true`) and its pages, the files tvpipe embeds (`npm/party/scripts/web.ts`); `/_tvpipe/ui.css` and `/_tvpipe/fonts/` as tvpipe serves them |
| `/_tvpipe/screen/?u=PATH` | a window of the TV page (cable, second window): `PATH` (a path of this site with its fragment, nothing else) in a frame, a Full screen button that goes once the window is full screen, "Drag this window onto the TV" beside it. The host talks to it on `BroadcastChannel("tvpipe-screen")`: `{t: "show", url}` (answered `{t: "shown", url}`), `{t: "close"}`; the window says `{t: "gone"}` when it goes. The launcher opens the window (blank) on the Start click, and for the cable moves it to the other screen (`getScreenDetails()`); the host page's cast takes it by its name |
| `/g/NAME/RELEASE/…` | the games of the list (`site/static/games.json`), built from this repository (`RELEASE`: the game's `package.json` version), the manifest's `root` and `tvpipe.json`; `/g/index.json` lists them (below), a page `…/index.html` as its directory `…/` (Cloudflare's `html_handling` answers `index.html` with a `307` to it) |
| `/r/?r=CODE#k=KEY` | a web room's join link: asks `GET /api/rooms/CODE`, then `location.replace`s to the game's phone page with `?r=CODE#k=KEY` and the link's other fragment pairs (`&p=…`); without a host or a game it waits and asks again (every 4 s, 8 s after two minutes, 20 s after a `429`); `404`: "No game with the code CODE", a link to `/join`. Self-contained (no library), English and German |
| `/tv/` | an extra screen: the code (or `#r=CODE`), `GET /api/rooms/CODE` (`404`: "No game with the code"; no host: waits), `requestScreen`, the TV page full page in a frame; a Full screen button, Wake Lock; asks again at the frame's `tvpipe:next-game` |

`apps/tvpipe-party/scripts/site.ts` (`npm run build:web` there: `site/build.py`, then it) builds npm/party (`tsc`) and every listed game (`npm ci` where `node_modules` is missing, `npm run build`), writes all of the above into `site/_out`, and checks Cloudflare's limits for assets (20,000 files, 25 MiB each); `npm run dev`, `npm run deploy` and the workflow run it. `node scripts/check-pages.ts` opens the pages in headless Chrome against `wrangler dev`.

`/g/index.json`:

```ts
interface WebGames {
  v: 1;
  games: {
    name: string; title: string; summary: string; release: string;
    players: { min: number; max: number }; languages: string[];
    tv: { width: number; height: number; resolution: "choice" | "fixed" } | null;
    path: string;                                   // "/g/NAME/RELEASE/"
    pages: { host: string; tv: string; phone: string; launcher?: string };  // absolute paths
    cover?: string;                                 // the list's first tv screenshot, absolute
  }[];
}
```

The games list (`/play/`, and `/_tvpipe/picker/` in web mode) sets the
session's `game` and goes to `/_tvpipe/launcher/`; the launcher's Start
goes to the game's host page. In a dialog over a host page
(`?mode=switch`) the picker posts `{type: "tvpipe:game-picker", picked:
true, game: {name, release}}`, and the host's `WebHub` switches.

Game switching (game-switching.md) works as with tvpipe: the host tells
the room the next game (`{t: "game"}`), closes clients with 4014, and
goes to the next game's host page; phones go to their join link (`/r/`),
which finds the next game.

## Table mode

- The TV page fills the screen; a ⋯ button shows the standard host page
  (players, settings, Other game, Change screen, End) instead, with a
  "Back to the game" button; it goes back by itself after 20 s without
  a touch. Everyone sees it.
- Wake Lock while the room is open (where the browser has it).
- Sound plays from the device; it needs the Start tap (autoplay rules).

## Not in this branch

- The app's phones over WebRTC.
- Saving the host's game state for a resume after a reload (a reload
  keeps the room; phones come back by name, as with tvpipe).
- Games from a zip in the browser.

## To measure (on devices)

How often TURN is needed (guest Wi-Fi, mobile data), how many phones an
iPad hosts, Safari's largest data channel message, Wake Lock in a Home
Screen app, mirroring delay, data channels in smart-TV browsers.
