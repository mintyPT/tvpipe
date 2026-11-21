# Switching games, and games from a folder

Status: built. Extends playshare-design.md (§4, §5, §6.4, §7, §10) and
game-catalog.md.

Before this, one `tvpipe game play` ran one game: the hub held the
bundle for good, and the games list was a small server of its own that
handed the picked game to a second one (`run_picked`). Playing something
else meant ending the run: the tunnel, the short link, the cast and the
join code went with it. A folder holding several games could not be
played at all.

## What changes

- **One session, games in a slot.** A run is a session: the listeners,
  the token and cookie, the tunnel, the short link, discovery and
  pairing, the TV selection and resolution, the TVs' lags, test mode,
  the window, the games list, and the **room** (code and join key). The
  game (the bundle, a generation number, the relay's host and clients,
  surfaces) sits in a slot the hub can fill again.
- **The games list is the hub's.** `/_tvpipe/picker/` and its API are
  served by the local listener (one origin, one token, one port); the
  picker's own server goes. The tunnel starts with the session, before a
  game is picked.
- **Other game** in the standard host page: the list in a dialog over
  the running game (as the cast picker); once the new game is ready
  (downloaded, asked about), tvpipe swaps it in and everybody follows.
  The launcher has it too (the list as a page: nobody plays yet).
- **A folder of games**: `tvpipe game play games/` (a folder without
  `tvpipe.json` whose folders or zips have one) or several paths
  (`tvpipe game play ./a ./b.zip`). The list shows them first, under
  "On this computer", then the online list, separately (the same game may
  be in both).

## The command line

| `tvpipe game play …` | starts with | the list has |
|---|---|---|
| nothing | the list | the online list |
| one game (a folder or zip with `tvpipe.json`, a URL, `gh:…`, a name) | that game (asked in the terminal, as before) | that game if local, then the online list |
| a folder of games, or several local paths | the list | those games, then the online list |

Several sources are local only (a game from the internet is one source
on its own, or picked in the window). `--offline` keeps the online list
to what is cached.

## The room across games

tvpipe makes the room code (four consonants, as `roomCode()`) and the
join key (16 random bytes, base64url) once per session; `info.room`
gives them to the host page, and `HostedParty` uses them instead of new
ones. So the join link (`/?r=CODE#k=KEY`), its QR code and the short
link stay the same from game to game: a phone that scanned the TV once
follows every game, and the short link needs no new registration. The
screen and watch keys stay per party (the new host page casts again).

A player removed in one game still has the link for the next: the same
people are in the room, and a game's own removal is the game's.

## A switch

1. The host page's **Other game** asks first when a game is running
   ("this one ends for everybody"), then opens the list in a dialog
   (`/_tvpipe/picker/?mode=switch`), the current game marked. Cancel
   (and Escape) close it; the game went on meanwhile.
2. Picking works as in game-catalog.md: a local game loads at once, a
   remote one is downloaded and, when new, asked about in the dialog.
3. Loaded, the hub swaps the game: every relayed client is closed with
   **4014** "next game", surfaces stop, the host is detached, the slot
   gets the new bundle and the next generation, and every API socket
   gets the event `game` `{name, title, url}`. `url` is the new game's
   host page when TVs are chosen, else its launcher.
4. Pages on the API go to `url` (the `Tvpipe` client does it for top
   level pages). The new host page casts to the same TVs: the running
   cast's tab goes to the new TV page (below).
5. Phones (`PartyClient`, players in a browser) take 4014 (or a `bye
   next-game`) as "the room goes on with another game": the identity
   they had moves to the **carried** record, and the page goes to its
   join link `/?r=CODE#k=KEY`, which is the new game's phone page now.

### The TVs keep their sessions

The cast keeps running until the new host page casts (the old TV page
says its game ended meanwhile, a second or so). A `cast.start` for the
same TVs (in any order) and the same picture (the layout, fixed or not,
the resolution) while the cast is starting or streaming does not start a
new one: the page goes into the running tab (`Cast::navigate`, the share
session's `Session::navigate`, a `PageControl` the browser's keeper
takes). The AirPlay and Cast sessions, the `browser` receiver's player
tab and the headless browser stay; the tab loads the page (a document
with only another fragment, as every game's `/screen/index.html#…`, is
loaded again, not just re-hashed), its capture shares again, and the
receivers see the last picture for about 250 ms (measured with Chrome:
"video again after a 250 ms gap"; `chrome_browser_goes_to_another_page`:
30 frames 1.2 s after the navigation). Other TVs, another resolution, a
failed or stopped cast: a new cast, as before. The cast picker's Apply
with the same TVs and resolution reloads the TV page the same way.

### Stale pages

A phone asleep during the switch wakes up with the old game's page,
which would reconnect to the new host with the right code and key. So
tvpipe sets a cookie `tvpipe-game=RUN.GEN` (not secret, readable by
scripts) on every bundle file; `PartyClient.fromLocation` reads it when
the page loads and connects with `?g=RUN.GEN`. A relay connection whose
`g` is not the current game's is accepted and closed with 4014 at once,
so the old page goes to the join link too. Connections without `g`
(tests, bots in Node) are not checked.

### Carried identity

What a phone was in the last game is transient and the game's to use or
not: `PartyClient.carried` is `{name?, data?}` (in `sessionStorage`,
for this tab and this room) or `null`. The library fills `name` when it
leaves for the next game; a game may stash more for the next one with
`client.carry(data)` (any JSON, at most 4 KiB). `canResume` is also
true with a carried name, and `connect()` then joins with it: games that
start with `if (client.canResume) client.connect()` take their players
over without a change; a taken or invalid name rejects as before and the
game shows its name form. A game without names just ignores it.

## Without a game

Before the first pick the slot is empty: the local listener's `/`
and `/_tvpipe/start` go to the list, `info` and `relay.attach` answer
`no-game`, bundle paths 404. On the phones' side `/` goes to
`/_tvpipe/wait/` (the query and fragment kept), a tvpipe page that says
the game is being picked and goes back to `/` once `/_tvpipe/game`
(public: `{game: bool}`) says there is one.

## The list's API (local listener, token)

- `GET /_tvpipe/api/catalog`: `{local: [...], games: [...], error?}`.
  A local entry: `{id, name, title, from, min, max, languages, summary,
  screenshots, error?}`; `id` is how the page names it (its path as
  given or found), `from` the path shown; summary, languages and pictures
  come from the online list's entry of the same `name`, when there is
  one. A broken one (no `tvpipe.json`, not built) is listed with its
  error and cannot be picked. Folders are scanned again on every request.
- `GET /_tvpipe/api/game`: the choice's state as before, plus `choice`
  (a number per pick) and `current` (`{name, title, from}` of the game
  in the slot, if any). `ready` names the choice it is for, so a page
  opened later does not follow an old one.
- `POST /_tvpipe/api/game`: `{source}` (a remote source or a name of the
  online list), `{local: ID}` (an entry of the local list: the window
  never names paths of its own), `{trust: true}`, `{back: true}`.

## Clean-ups on the way

- `Running`, `start_game`, `run_picked` and the picker's server merge
  into one start: the session, then maybe a game.
- The picker's copies of the host, token and origin checks go.
- The listeners' connection limit is the session's (for the largest
  game); the relay's per-game limit stays in `admit`.
- `Progress::Game` comes again on every game; the terminal shows the
  new title.
