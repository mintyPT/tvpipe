# tvpipe.party

The service behind `tvpipe.party`: a Cloudflare Worker with a D1
database, on the free plan. It does two things:

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
| `/CODE` (four letters of `BCDFGHJKLMNPQRSTVWXZ`, any case) | `302` to the frame page (`/p#…`), or the join page with "No game …" (`404`) |
| `/join`, `/join?code=…` | the join page / as `/CODE` |
| `/p` | a file (`p.html`): the frame page; the Worker does not run |
| anything else | `404` page linking `/` and `/join` |

Files: `src/links.ts` (validation, the frame page's link, codes, secrets, the SQL),
`src/pages.ts` (the HTML), `src/app.ts` (the handler), `src/env.ts` (the
few Cloudflare types it needs, declared by hand),
`migrations/` (D1's schema). No runtime dependencies.

## Local development

```sh
npm install
npm test          # node --test, D1 on node:sqlite (Node 22+)
npm run check     # tsc
npm run dev       # builds the site, migrates the local D1, wrangler dev
```

`wrangler dev` keeps its local D1 and rate limiters in `.wrangler/`. Try it:

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
4. In GitHub, the repository secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` for `.github/workflows/tvpipe-party.yml`.

## Deploying

Pushes to `main` that touch `apps/tvpipe-party/`, `site/` or the fonts
deploy through `.github/workflows/tvpipe-party.yml` (tests, the site's
build, D1 migrations, `wrangler deploy`). By hand:

```sh
npm run deploy    # site build, d1 migrations apply --remote, wrangler deploy
```

## Limits and cost

Per client IP, with Cloudflare's `ratelimit` binding (counted per
location): 20 code lookups a minute (`/CODE`, `/join?code=`; hits count
too, so a scanner cannot tell live codes from dead ones), 10 registrations,
60 refreshes/deletes. Request bodies are at most 4 KiB.

Static files (the frame page too) do not run the Worker. A game costs about 2 Worker requests
(register, delete) plus one per 6 hours of refreshes, plus one per person
who types the code: tens of thousands of games a day fit the free plan's
100,000 requests. D1: a write per register, refresh and delete, a read
per lookup; rows of crashed runs stay until their code is reused (at most
160,000 rows, 20⁴).
