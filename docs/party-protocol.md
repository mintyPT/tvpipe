# The party protocol (version 1)

What a party host (`Party` of `@tvpipe/party`, in a game's host page)
and its clients (phones, screens, watchers; `PartyClient`) say to each
other. The session vectors in `npm/party/test/vectors/` are recorded from
the host (`node test/vectors.ts --bless` in `npm/party`) and replayed by
its tests; they were first replayed by two hosts (Node and Rust), which
is why the protocol is written down this precisely. The design behind
it: `docs/party-design.md` §5; how the messages travel:
`docs/playshare-design.md` §6.

## 1. Transport

- One WebSocket per client at `/_tvpipe/ws` on the game's origin (a
  tunnel's `https://`, a LAN `http://IP:PORT`, or loopback). It ends in
  tvpipe, which relays it to the host page (`docs/playshare-design.md`
  §6): the host sees each message as sent. Text messages, each one JSON
  object with a `t` field. Binary messages are reserved: a host closes
  the socket on one (`bye protocol`).
- **Unknown `t` values and unknown fields are ignored** by both sides.
  Every addition below relies on this: an older peer does not see it.
- tvpipe closes a socket by itself only for its own limits or the end:
  1009 (a message too large), 4008 (too fast), 4013 (too far behind:
  the client reconnects), 1012 (the host page went away: the client
  reconnects), 4011 (the game ended). Clients treat 1009, 4008 and 4011
  as final even without a `bye`.

## 2. Roles and links

| Role | Joins with | Sees (`view`) | May send |
|---|---|---|---|
| `player` | the join key and a name (a new player, or one who is away: §4.1), or a resume token | `roster`, `room` (shared by players), `me` (own) | actions, input |
| `screen` | the screen key | `roster`, `screen`, `join` (`code`, `url`, `qr`, `mode`, `lateJoin`, `inProgress`) | actions |
| `watch` | the watch key | like `screen` | nothing (actions are refused `read-only`) |

Links: join `ORIGIN/?r=CODE#k=JOINKEY` (in the QR code), screen
`http://127.0.0.1:PORT/screen/#r=CODE&k=SCREENKEY&role=screen`, watch
`ORIGIN/screen/#r=CODE&k=WATCHKEY&role=watch`, a player's rejoin link
`ORIGIN/?r=CODE#k=JOINKEY&p=RESUMETOKEN` (§4.1). Keys sit in the fragment
so they never reach request lines or logs. Keys and resume tokens are
128 random bits, base64url, compared in constant time.

## 3. Messages

### Client → host

| `t` | Fields | |
|---|---|---|
| `hello` | `v` (1), `room`, `role`, `key`, `name` (a new player), `resume` (a token from an earlier `welcome`), `agent` | first message, within 5 s |
| `act` | `id` (integer 1…2⁵³−1, increasing per player), `type`, `data`, `at` (when it was first sent, the host's clock as the client knows it; optional) | answered by `ack` |
| `in` | `s` (integer ≥ 1), `data` | continuous input, never answered (§8) |
| `ping` | `c` (the client's clock, ms) | answered by `pong` |
| `resync` | | asks for the full view (after a gap in `rev`) |
| `leave` | | the player leaves for good |

(Earlier clients sent `caps` and `rtc` messages for a WebRTC fast path
of the Rust host; hosts ignore both, as any unknown field and type.)

### Host → client

| `t` | Fields | |
|---|---|---|
| `welcome` | `v`, `room` (`code`), `you` (`id`, `role`; players: `name`, `vip`, `resume`, `lastAct`), `now` (the host's clock, ms since the epoch), `view` (the full view), `rev` (0), `tv` (`delay`; only when there is one) | after a good `hello` |
| `state` | `rev`, and `set` / `del` (a diff) or `full` (the whole view); `at` (§7.1) | §5 |
| `ack` | `id`, `ok`; `result` (if any) or `error` (`code`, `message`); `dup` (a replay of an id the host has no result for any more) | §6 |
| `msg` | `type`, `data`, `at` (§7.1) | transient: a sound cue, a toast; lost when away |
| `tv` | `delay` | how far the TV picture is behind the host, ms (§7.1); sent when it changes |
| `pong` | `c` (echoed), `now` | |
| `bye` | `reason`, optional `message` | then the host closes the socket |

## 4. Closing and reconnecting

`bye` reasons and close codes:

| Reason | Code | Reconnect? |
|---|---|---|
| `protocol` | 4002 | no |
| `bad-key` | 4003 | no (the identity is forgotten) |
| `no-room` | 4004 | no |
| `no-player` (a resume token nobody has, and no name) | 4005 | no (forgotten) |
| `name-taken` (a connected player has the name), `name-invalid` | 4006, 4007 | no |
| `rate-limited` | 4008 | no |
| `replaced` (a newer socket with the same token) | 4009 | no |
| `kicked` | 4010 | no (forgotten) |
| `room-closed` | 4011 | no |
| `slow` | 4013 | yes |
| `full`, `locked` | 4029 | no |
| `in-progress` (a new name while a game is on and `lateJoin` is `closed`) | 4030 | no |
| (`left`, after `leave`) | 1000 | no |

On anything else (network loss, 1001, 1006, 1012) the client reconnects
with backoff (0.25 s doubling to 5 s, ±25 % jitter), at once when the
page becomes visible, and resumes: `hello` with `resume` gets the same
player, the full view and `lastAct`.

### 4.1 Rejoining without the token

A phone that lost its token (the link opened in another browser, a new
phone, cleared storage) has two ways back to the same player, its seat,
score and turn:

- **By name.** A `hello` with the join key and the name of a player who
  is away (no socket; the same uniqueness key as for taken names, so
  case and accents do not matter) is that player: the host makes a new
  resume token, sends `welcome` and tells the game (`reconnect`), as for
  a resume. It comes before the checks for newcomers, so a locked or
  full room, or a game closed to newcomers, takes its players back. The
  old token is gone (`no-player` for it); while the player is connected
  the name stays `name-taken`. A host may turn this off (`reclaim:
  false`): whoever has the join key could take an away player's seat.
- **By a rejoin link.** The join link with the player's resume token in
  the fragment (`&p=TOKEN`), which the host page shows only to that
  player (a QR code). The client keeps the token as its own, takes it
  out of the address bar, and resumes.

Screens show the way back: the client library draws a rejoin badge on
TV and watch pages (the join QR code, the short link, the names of
players away for 4 s or more) while `join.inProgress` is set, unless the
page says its own join code is showing.

## 5. Views and diffs

The host never tells a client what happened; it keeps what the client
shows. A player's view is `{roster, room, me}`, a screen's `{roster,
screen, join}`; `roster` is `[{id, name, vip, connected, waiting?}]` in
join order (`waiting: true` only for a waiting player, see §5.1).

- After changes the host sends each client one `state` with the
  difference against what that client last got: `set` is merged into the
  view (objects merge recursively; anything else, `null` and arrays
  included, replaces), then every path in `del` (a list of key lists) is
  removed.
- `rev` increases by one per `state` on a connection (`welcome` is 0). A
  client that sees a gap sends `resync` and gets `{t: "state", rev,
  full}`. A `state` whose `rev` is not above the client's is dropped.
- A client that does not read (tvpipe reports more than 64 KiB queued
  for it: `busy`) gets no diffs until it drains, then one diff against
  what it has (latest wins); past 1 MiB tvpipe closes it with 4013 and it
  resumes.

### 5.1 Joining mid-game

The game tells the host whether a game is in progress
(`party.inProgress`) and who may join meanwhile
(`lateJoin`: `closed`, `wait`, `open`; an option and a setter, default
`wait`). Screens see both in `join` (`lateJoin`, `inProgress`), so the
TV can say "join anytime" under the QR code.

- In the lobby (no game in progress) every new name joins as before.
- During a game, with `closed`, a new name gets `bye in-progress`
  (4030, the message "A game is in progress"); resume tokens keep
  working, and so do the names of players who are away (§4.1).
- With `wait` or `open` the newcomer joins the roster as a waiting
  player (`waiting: true` in the roster, `player.waiting`). The host
  does nothing else with it: the game deals them in when it wants
  (`party.activate(player)`: the flag goes, the `active` event). The two modes differ only in the game's rules
  (drawbluff: `wait` at the next round, `open` at the next drawing).
- Ending a game (`inProgress` false) changes nobody's flag: the game
  activates its waiting players itself.

## 6. Actions: exactly once

- `act` ids increase per player identity; `welcome.you.lastAct` tells a
  reloaded page where to continue. Screens' ids are per connection.
- The client keeps unacknowledged actions (at most 32) and sends them
  again after a reconnect. The host
  runs each id once: an id at or below the last one it ran is a replay,
  answered from a cache of the last 32 acks (`dup: true` when it is no
  longer there). Hence: **ids must arrive in order**.
- Within one host turn, `state` goes out before the acks: an ack's
  effects are in the view when the promise resolves.
- Unanswered actions get `error.code` `unknown-action`; watchers get
  `read-only`.

## 7. Clock

`ping` on connect (five, 300 ms apart) and every 10 s; the client keeps
the offset of the fastest of the last 16 round trips. Deadlines in views
are host times (`now()` on both sides), so a phone and the TV count down
to the same instant.

### 7.1 The TV's delay

The TV shows the host's changes late: its page is drawn, captured and
encoded, the receivers present each frame a playout delay after it was
made, and the TV adds its own picture processing. The host knows the
sum as `delay` (ms, 0 to 5000; `welcome.tv`, then `tv` messages; 0
without a TV) and stamps changes it wants seen with the TV
(`party.withTv`) with `at`: the host time at which the TV shows them,
the time of the change plus `delay`.

- A client handles a `state`, `msg` or `ack` with an `at` later than
  its `now()` when `now()` reaches it, and every `state`, `msg` and `ack`
  that arrives meanwhile after it, in order (so §6's "state before ack"
  and `rev` order hold). `pong`, `tv` and `bye` never wait. A `welcome`
  drops what waits (its view is newer).
- A client's `now()` is the host's clock plus its **lead**: `delay` on a
  `screen` (the TV page: what it draws now is shown `delay` later, so it
  shows a change at once and counts down to the same instant as the
  phones), 0 on players and watchers (they wait for `at`).
- `act.at` is when the phone sent the action (kept from the first
  attempt when it is resent). The host takes it as the action's
  `sentAt`, within the second before the action arrived (else the
  bound), or the arrival time without one: for ordering reactions
  fairly, not as proof.

## 8. Continuous input (`in`)

For a stick, a tilt, a slider: `{t: "in", s, data}`. Never answered,
may be lost, **latest wins**:

- `s` is a sequence number per connection; an `in` whose `s` is not
  above the last one seen on that connection is dropped, as are those
  without an integer `s` ≥ 1, those from screens and watchers, and those
  over 4 KiB.
- The host keeps it as `player.input` and emits the `input` event.
- `in` counts against the socket's rate limit (20/s), so the client
  sends it at most every 100 ms (the latest data).

## 9. Limits

| | |
|---|---|
| `hello` within | 5 s |
| messages per socket | 20/s, 50 at once (`bye rate-limited`; tvpipe's outer bound: the manifest's `limits`, close 4008) |
| message size | 256 KiB for `act` (tvpipe: the manifest's `limits.message`, close 1009), 16 KiB for the rest, 4 KiB for `in` (dropped) |
| sockets | 2 per player (`players.max`) + 16, at least 64, enforced by tvpipe; screens and watchers 16 |
| failed `hello`s per address | 20 a minute |
| pending actions per client | 32 |
| liveness | WebSocket pings every 15 s, closed after 45 s without a pong |
