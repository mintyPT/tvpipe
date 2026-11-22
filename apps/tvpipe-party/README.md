# tvpipe.party

The service behind `tvpipe.party`: a Cloudflare Worker with a D1
database and Durable Objects, on the free plan. It does these things:

- **Short join links.** tvpipe registers a game's tunnel join link
  (`https://….trycloudflare.com/?r=BCDF#k=…`) and gets
  `https://tvpipe.party/BCDF`, which the TV shows for people who cannot
  scan the QR code. `GET /BCDF` redirects to the frame page; `/join` is a
  page to type the code into. The design and the API are in
  [docs/short-links.md](../../docs/short-links.md).
- **The frame page.** `/p#c=LABEL&r=ROOM&k=KEY` shows the game's phone
  page from its tunnel in a full-screen frame, so phones stay on
  tvpipe.party; the QR codes lead there. A static file of the site
  (`site/static/p.html`, `site/static/frame.js`), so it costs no Worker
  request.
- **Web rooms.** The games in the browser
  ([docs/browser-party-design.md](../../docs/browser-party-design.md))
  register their join link `https://tvpipe.party/r/?r=CODE#k=KEY` in the
  same table (exactly that code, or `409`), and their phones reach the
  host page over WebRTC. The Worker does the signaling: a `Room` Durable
  Object per code (`src/room.ts`, hibernating WebSockets) passes each
  phone's offer to the host page and its answer back, and
  `GET /api/turn` hands out STUN and Cloudflare TURN servers. No game
  traffic passes through it.
- **The website.** The static files of `site/_out` (built by
  `site/build.py`) are the Worker's assets.

## How requests are routed

Cloudflare serves a request from the assets when it names a file (default
asset-first routing; `/manual` → `/manual/` and the like are Cloudflare's
`html_handling`). Only what is not a file runs the Worker
(`src/worker.ts` → `src/app.ts`):

| Path | |
|---|---|
| `POST /api/links`, `PUT`/`DELETE /api/links/CODE` | the API (JSON) |
| `GET /api/rooms/CODE` | a web room: `{code, host, game}` (its object, `404 no-room`) |
| `GET /api/rooms/CODE/host`, `/api/rooms/CODE/join?…` | WebSockets to the room's object: the host page, a phone or screen |
| `GET /api/turn` | `{iceServers, ttl}` for WebRTC |
| `/CODE` (four letters of `BCDFGHJKLMNPQRSTVWXZ`, any case) | `302` to the frame page (`/p#…`) or a web room's `/r/?r=CODE#k=KEY`, or the join page with "No game …" (`404`) |
| `/join`, `/join?code=…` | the join page / as `/CODE` |
| `/p` | a file (`p.html`): the frame page; the Worker does not run |
| anything else | `404` page linking `/` and `/join` |

Files: `src/links.ts` (validation, the frame page's link, web rooms'
links, codes, secrets, the SQL), `src/pages.ts` (the HTML), `src/app.ts`
(the handler), `src/room.ts` (the `Room` Durable Object: signaling),
`src/turn.ts` (`/api/turn`), `src/turncap.ts` (the monthly TURN cap),
`src/worker.ts` (the entry point, exports `Room`, runs the Cron Trigger), `src/env.ts` (the few Cloudflare types it needs, declared by
hand), `migrations/` (D1's schema). No runtime dependencies.

## Local development

```sh
npm install
npm test          # node --test, D1 on node:sqlite, a fake Durable Object runtime (Node 22+)
npm run check     # tsc
npm run build:web # the site and the games in the browser into site/_out
npm run dev       # build:web, migrates the local D1, wrangler dev
npm run live      # (with dev running) a web room's signaling over real WebSockets
node scripts/check-pages.ts   # (with dev running) the web pages in headless Chrome
node test/live/web-party.ts   # (with dev running) whole parties in browsers: a host, phones, screens over WebRTC
```

`build:web` is `python3 ../../site/build.py`, then `scripts/site.ts`:
it builds `npm/party` (tsc) and every game of `site/static/games.json`
(`npm ci` where `node_modules` is missing, `npm run build`) and adds
the web pages to `site/_out`: the library at `/_tvpipe/lib/` (`WEB =
true`) with the launcher and games list, `/play/`, `/r/`, `/tv/`,
`/_tvpipe/screen/`, the games at `/g/NAME/RELEASE/` with
`/g/index.json`, and the web app's files from `web/` (manifest, service
worker, icons, offline page). `--no-build` reuses the last builds.
`check-pages.ts` (BASE, default `http://localhost:8787`) opens each page
and reports errors, screenshots in `/tmp/tvpipe-pages/`
(docs/browser-party-design.md, "Pages on tvpipe.party").
`test/live/web-party.ts` (BASE likewise; `--only table,games,full,switch,reload,phone,window,quit,short,burst,looks`,
`--games` for some games, `--relay` for TURN only: every peer connection relayed, checked with getStats,
`--local-lib` for this checkout's built library on BASE's pages: a library change against production before it is deployed)
plays whole parties in one headless Chrome, a browser context per person:
the games list, the launcher, the host page in table mode, phones joining
over data channels (the game's bot moving on each phone's own client),
every game's first round, two games to the end, Other game, reloads, a
locked phone, an extra screen, a second window, End, the short link and 12
phones at once; screenshots in `/tmp/tvpipe-web-validate/`.

`wrangler dev` keeps its local D1, Durable Objects and rate limiters in
`.wrangler/`. It runs with `--local-upstream localhost:8787`: otherwise
the Worker would see `http://tvpipe.party` (the custom domain) as its
origin, and web rooms' links, which must be on the Worker's own origin,
would not register. Open pages at `http://localhost:8787` (not
`127.0.0.1`). `node test/live-signaling.ts BASE --slow` also waits for
the 15 s answer timeout. Without TURN secrets `/api/turn` is STUN only;
to try them locally put `TURN_KEY_ID=…` and `TURN_KEY_API_TOKEN=…` into
`.dev.vars` (git-ignored), and `TURN_ANALYTICS_TOKEN=…` for the cap
(`wrangler dev --test-scheduled`, then `curl
'localhost:8787/__scheduled?cron=*/10+*+*+*+*'` runs the check). Try it:

```sh
curl -X POST localhost:8787/api/links \
  -d '{"url":"https://some-words.trycloudflare.com/?r=BCDF#k=AbCdEfGhIjKlMnOp","code":"BCDF"}'
curl -i localhost:8787/bcdf
curl -i -X DELETE -H "Authorization: Bearer SECRET" localhost:8787/api/links/BCDF
```

tvpipe talks to another instance with `TVPIPE_PARTY_URL=http://127.0.0.1:8787`.

## First-time setup

1. An API token for the personal Cloudflare account (Workers Scripts,
   D1 and Workers Routes/custom domains: edit) and the account's id, in
   `.env` at the repository's root (git-ignored; `npm run deploy` passes
   it with `--env-file ../../.env`, so it wins over a `wrangler login`
   of another account; for other wrangler commands pass it the same way):

   ```sh
   CLOUDFLARE_API_TOKEN=…
   CLOUDFLARE_ACCOUNT_ID=…
   ```

   There is no `account_id` in `wrangler.jsonc` on purpose.
2. `npx wrangler d1 create tvpipe-party --env-file ../../.env`, and put
   the `database_id` it prints into `wrangler.jsonc` (done: the database
   is in EEUR).
3. The zone `tvpipe.party` must be on the same account; `wrangler deploy`
   attaches the Worker to it as a custom domain.
4. Optional, for TURN (phones that cannot reach the host page directly):
   a TURN key in the Cloudflare dashboard (Realtime → TURN), then
   `npx wrangler secret put TURN_KEY_ID --env-file ../../.env` and the same
   for `TURN_KEY_API_TOKEN`. Without them `/api/turn` gives public STUN
   only. With them, also set up the cap (below).

### The TURN cap

Cloudflare TURN is free up to 1,000 GB a month, then billed. A soft cap
keeps tvpipe.party under it:

- A Cron Trigger (`triggers.crons`, every 10 minutes) asks the GraphQL
  Analytics API for this calendar month's (UTC) TURN traffic of our key
  (`callsTurnUsageAdaptiveGroups`, filtered by `keyId` and the month's
  start; egress plus ingress, counted together on purpose) and stores
  it in D1 (`turn_usage`, a row per month).
- `/api/turn` gives STUN only once the month reaches
  `TURN_MONTHLY_LIMIT_GB` (a var in `wrangler.jsonc`, 900 by default:
  GB of 10⁹ bytes), and also when the last successful check is older
  than 2 hours or missing (the cron or the analytics broke: it fails
  closed). A new month starts at 0 at once.
- Credentials last 1 hour, so TURN stops within the hour of the cut
  (credentials handed out stay good until they expire; the analytics lag
  a few minutes). It is a soft cap: a month can end a little over the
  limit, which is why it is below the 1,000 GB.
- The token: a Cloudflare API token with **Account → Account Analytics →
  Read** for the account (no other permissions), stored with
  `npx wrangler secret put TURN_ANALYTICS_TOKEN --env-file ../../.env`.
  The account is the var `CF_ACCOUNT_ID` in `wrangler.jsonc` (an account
  id is no secret). Without the token TURN is not capped (logged once
  per isolate); right after the first deploy with it, TURN waits for the
  first check (at most 10 minutes).
- The logs (`wrangler tail`) say when TURN goes off or on again and when
  a check fails.
5. In GitHub, the repository secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` for `.github/workflows/tvpipe-party.yml`.

## Deploying

Pushes to `main` that touch `apps/tvpipe-party/`, `site/`, `npm/party/`,
`games/` or the fonts deploy through `.github/workflows/tvpipe-party.yml`
(tests, `npm run build:web`, D1 migrations, `wrangler deploy`). By hand:

```sh
npm run deploy    # build:web, d1 migrations apply --remote, wrangler deploy
```

## Limits and cost

Per client IP, with Cloudflare's `ratelimit` binding (counted per
location): 20 code lookups a minute (`/CODE`, `/join?code=`; hits count
too, so a scanner cannot tell live codes from dead ones), 10 registrations,
60 refreshes/deletes, 120 web room lookups (`GET /api/rooms/CODE`: a
party behind one address loads `/r/` in bursts), 60 `/api/turn`. Request
bodies are at most 4 KiB. The `Room` object limits offers (30 a minute
per address, 5 a second per room with a burst of 30), messages (16 KiB)
and open joins (144 per room).

Static files (the frame page too) do not run the Worker. A game costs about 2 Worker requests
(register, delete) plus one per 6 hours of refreshes, plus one per person
who types the code: tens of thousands of games a day fit the free plan's
100,000 requests. D1: a write per register, refresh and delete, a read
per lookup; rows of crashed runs stay until their code is reused (at most
160,000 rows, 20⁴).

Web rooms: a game in the browser costs about 4 Worker requests (register,
a refresh per 6 hours, delete, `/api/turn`), the host's socket (a Worker
and an object request, reconnects after a reload or a game switch), and
per phone joining: `/r/`'s `GET /api/rooms/CODE` (a Worker request, a D1
read, an object request), `/api/turn` and the join socket (a Worker
request, an object request, about one alarm and a row write or two). A
party of 8 for an evening with a few game switches: some 100 requests
of each kind, so on the order of a thousand parties a day fit the free
plan (100,000 Worker and 100,000 Durable Object requests). Idle rooms
hibernate: pings are answered without waking them. TURN is billed by
Cloudflare by traffic (1,000 GB a month free; capped below that, "The
TURN cap") and used only by phones that cannot connect directly. The cap
costs 144 cron runs a day (each a GraphQL request and a D1 write) and a
D1 read per `/api/turn`.
