# The games list with pictures, and picking a game in the window

Status: built, for 0.3.0. Extends playshare-design.md §18 ("The
games list"). 0.2.0 has no remote games at all, so nothing released
depends on the list's shape.

## What changes

- **The list** (`site/static/games.json`, served at
  `https://tvpipe.party/games.json`) has all of this repository's games
  (Drawbluff, Jinx, Garble, and since then Krakel) and screenshots for
  each.
- **The site** has a games page, `tvpipe.party/games/`, rendered from the
  list with the screenshots.
- **`tvpipe game play` without a game** opens the window on the list:
  pick a game (downloaded on the spot) or paste a source, then pick the
  TVs as before.

Names stay names: `tvpipe game play drawbluff` looks the name up in the
list, as §18 says. A game has no URL of its own at tvpipe.party.

## The list

```json
{
  "v": 1,
  "games": [
    {
      "name": "drawbluff",
      "title": "Drawbluff",
      "summary": "Draw your prompt, fake the others' titles, find the real one",
      "players": { "min": 3, "max": 50 },
      "languages": ["en", "de"],
      "source": "gh:mitsuhiko/tvpipe/drawbluff@drawbluff-v*",
      "home": "https://github.com/mitsuhiko/tvpipe/tree/main/games/drawbluff",
      "screenshots": [
        { "src": "static/games/drawbluff/tv-reveal.png", "alt": "The TV revealing the real title", "kind": "tv" },
        { "src": "static/games/drawbluff/phone-draw.png", "alt": "Drawing on a phone", "kind": "phone" }
      ]
    }
  ]
}
```

- `screenshots`: at least one; the first `tv` one is the cover. `src` is
  a URL relative to the list's own URL (so `static/games/NAME/…` is
  `https://tvpipe.party/static/games/NAME/…`, the file
  `site/static/games/NAME/…`); listed games keep their pictures in this
  repository, never hot-linked. `kind` is `tv` (16:9, 1280×720) or
  `phone` (portrait, 390×844). `alt` describes the picture.
- `python3 site/build.py` checks every entry: the fields, that each
  picture exists, is a PNG, JPEG or WebP, at most 400 KiB.

## The site

`/games/` lists the games, a block per game: the cover, the title, the
summary, players and languages, the phone shots beside it, the command
`tvpipe game play NAME`, and a link to `home`. The manual's "Games to
play" page and the landing page link to it.

## Picking in the window

`tvpipe game play` without `GAME` starts the server without a game and
opens the window on the launcher's first step:

1. tvpipe fetches the list (with its ETag, into the cache as before) and
   each picture (into the cache too, `games/pics/SHA`); the window gets
   them from the local API: `GET /_tvpipe/api/catalog` (the entries,
   pictures rewritten to `/_tvpipe/catalog/N`, and which games are
   downloaded already) and `GET /_tvpipe/catalog/N`. The window never
   talks to the internet. Offline or failing: the cached copy, else an
   empty list with the error; the source field still works.
2. The window shows a card per game (cover, title, summary, players,
   languages) and a field "Or a game from elsewhere" (an `https://` URL
   or `gh:OWNER/REPO`; local paths are the command line's).
3. Picking one: `POST /_tvpipe/api/game {"source": …}`. tvpipe fetches it
   in the background; the window polls `GET /_tvpipe/api/game` for
   `{state: "fetching" | "ask" | "ready" | "failed", …}`. A game not
   trusted before (§18) shows the question in the window: the name, where
   it comes from, the release, size, sha256 and tvpipe series, with
   Play and Back. `POST /_tvpipe/api/game {"trust": true}` remembers the
   answer, as the terminal does.
4. The bundle is loaded into the running server and the launcher moves on
   to the TVs and Start, as today.

The hub holds the game in a set-once slot; the game's pages and the host
API answer `409` ("no game yet") until it is filled. Once a game is
chosen it stays for the run (no going back to the list). With `GAME`
given, the list is skipped and the terminal asks as before; `--yes` also
skips the question in the window.

## Screenshots

Taken with each game's live check (`test/live/play.ts`), which plays a
round in headless Chrome with bots and shoots the TV and the phone per
phase; `--shots DIR` writes the chosen phases at the list's sizes (PNG,
WebP when the PNG is over the limit), with people's names for the bots.
Re-run when a game's look changes; each `play.ts` names the command.

## Releasing

**tvpipe 0.3.0:**

1. Bump to 0.3.0: `Cargo.toml` (the workspace, the internal dependency
   versions), `Cargo.lock`, `npm/party` and `npm/tvpipe` (`package.json`,
   lockfiles), `npm run build` in `npm/party`.
2. The games and docs to the 0.3 series: `"tvpipe": "0.3"` in every
   `games/*/tvpipe.json` (`games.yml` refuses a mismatch), the `"0.2"`
   examples in the docs.
3. The checks of AGENTS.md, `tvpipe game check --smoke` for each game,
   `release.yml` and `games.yml` (each game) by hand as dry runs.
4. Tag `v0.3.0`, push: the GitHub release, npm, crates.io.

**The games**, on the same commit, after `v0.3.0`: tag `drawbluff-v0.3.0`, `jinx-v0.1.0`,
`garble-v0.1.0` (each game's `package.json` version) and push; `games.yml`
publishes each, and `tvpipe game play NAME` finds it.
