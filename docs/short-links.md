# Short join links (`tvpipe.party/CODE`) and the frame page (`tvpipe.party/p`)

Status: being built. The service is `apps/tvpipe-party/` (a Cloudflare
Worker on the free plan, the domain `tvpipe.party`); tvpipe registers
links from `crates/tvpipe/src/playshare/shortlink.rs`; the party library
puts the short link into `JoinInfo.short` and the frame page's link
into `JoinInfo.url`. The frame page is `site/static/p.html` and
`site/static/frame.js`.

## Why

A tunnel's join link is long: `https://baqlo7vg7agz.opentunnel.xyz/?r=BCDF#k=…`
or `https://some-random-words.trycloudflare.com/?r=BCDF#k=…`. Nobody types
that from a TV. The QR code carries it fine, but people who cannot scan
need something short. So the TV shows **`tvpipe.party/BCDF`**. Games
do not show the tunnel's link or the room code on their own any more.

A tunnel's name is also new every game (Cloudflare) or unknown to
anyone (OpenTunnel), so phones' address bars, histories and parental
controls (Screen Time's reports and limits, which go by site) show a
different meaningless name every time. So both the QR code and the
short link lead to **the frame page**, `tvpipe.party/p#…`: a static page
of tvpipe.party that shows the game's phone page from the tunnel in a
full-screen `<iframe>`. Phones stay on tvpipe.party the whole game.

## Decisions (the owner's)

- One small service, ours: a Worker with D1 on the free plan, which also
  serves the website (the static files of `site/_out`).
- No keep-alive traffic: a link is registered once and stays until tvpipe
  deletes it at the end of the game. A code nobody refreshed for **24
  hours** may be given to someone else (a crashed tvpipe never deletes
  its link). tvpipe refreshes its link every 6 hours, so even a game that
  runs for days keeps its code.
- Only tvpipe's own join links are accepted (no open redirect).
- The QR code and `/CODE` lead to the frame page `/p`, which frames
  only Cloudflare quick tunnels and OpenTunnel routes. It is a static
  file: opening it costs no Worker request (Cloudflare serves assets
  free and without limit). Everything it needs is in the fragment, which
  never reaches a server (the key included). Scanning now needs
  tvpipe.party's static files; with short links off
  (`--no-short-link`, `TVPIPE_PARTY_URL=off`) the QR code is the
  tunnel's link as before.

## The service

Base: `https://tvpipe.party` (tvpipe: `TVPIPE_PARTY_URL` overrides it,
for tests and self-hosting).

### Codes

Four letters of `BCDFGHJKLMNPQRSTVWXZ` (the room code alphabet:
no vowels, so no words; no 0/O). Lookups are case-insensitive, stored
upper case. A code is **free** when it has no row or its row's `updated`
is more than 24 hours old.

### Join links it accepts

```
https://LABEL.trycloudflare.com/?r=ROOM#k=KEY
https://ROUTE.ID.opentunnel.xyz/?r=ROOM#k=KEY
```

- `LABEL`, `ROUTE`, `ID`: `[a-z0-9-]{1,63}`, not starting or ending with
  `-`; exactly one label before trycloudflare.com, exactly two before
  opentunnel.xyz (a route per run under the machine's tunnel,
  docs/tunnels.md).
- No port, no user info, path exactly `/`, the query exactly `r=` plus
  4–8 letters `A-Z`, the fragment exactly `k=` plus 16–64 characters of
  `A-Za-z0-9_-`.
- At most 300 characters.

Anything else: `400 bad-url`.

### API (JSON; tvpipe calls it, browsers do not: no CORS)

Errors are `{"error": {"code": "…", "message": "…"}}`.

| Request | Answer |
|---|---|
| `POST /api/links` `{"url": JOIN, "code": "BCDF"?}` | `201 {"code", "short", "url", "secret"}`. The proposed `code` (the party's room code) if it is valid and free, else a random free code. `400 bad-url`, `400 bad-request` (not JSON, no url), `429 rate-limited`, `503 no-code` (no free code after 32 tries). |
| `PUT /api/links/CODE` `Authorization: Bearer SECRET`, body `{"url": JOIN}` or `{}` | `200 {"code", "short", "url"}`: `updated` is now, the url replaced when given. `404 not-found` when the code has no row or the secret does not match (it was given to someone else, or deleted): the caller registers again. `400 bad-url`. |
| `DELETE /api/links/CODE` `Authorization: Bearer SECRET` | `204`, also when there was nothing to delete; a wrong secret deletes nothing (still `204`). |

`short` is `https://tvpipe.party/CODE` (the request's origin). `secret`
is 32 random bytes, base64url; the database keeps its SHA-256 (hex).
Request bodies over 4 KiB: `413`.

### Pages

| Request | Answer |
|---|---|
| `GET /CODE` (4 letters, any case) | `302 Location: /p#…`, the frame page's link of the registered join link (below; the fragment included, browsers keep it), `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. Unknown code: `404`, the join page with "No game with the code BCDF. Check the code on the TV.". |
| `GET /join` | the join page: one field for the code, a button; a `GET` form to `/join` (no JavaScript needed). |
| `GET /join?code=bcdf` | as `GET /BCDF`. Empty or malformed code: the join page with a message. |
| `GET /p` | the frame page (a static file, `p.html`; the Worker does not run). |
| anything else | the website's static files (`site/_out`), served by Cloudflare before the Worker runs; what is not a file: `404` with a short page linking `/` and `/join`. |

The join page is small, self-contained HTML (inline CSS, the site's
colours, works on any phone, `<meta name="viewport">`, the field with
`autocapitalize="characters" autocomplete="off" inputmode="text"
maxlength="8"`, autofocus).

### The frame page (`/p`)

```
https://tvpipe.party/p#c=LABEL&r=ROOM&k=KEY      frames https://LABEL.trycloudflare.com/?r=ROOM#k=KEY
https://tvpipe.party/p#o=ROUTE.ID&r=ROOM&k=KEY   frames https://ROUTE.ID.opentunnel.xyz/?r=ROOM#k=KEY
```

- The fragment holds the parts of the join link, not the link: the page
  puts the host together from them (`c`: one label, `o`: two, the
  patterns above), so it cannot be made to frame anything else. Its
  `Content-Security-Policy` (a `<meta>`) allows frames of only
  `https://*.trycloudflare.com` and `https://*.opentunnel.xyz`, scripts
  of only its own origin.
- Pairs in any order, each name once. More `name=value` pairs (`[a-z]`
  names, `[A-Za-z0-9_-]` values: a rejoin link's `p=TOKEN`) go into the
  framed page's fragment after the key, and out of the frame page's
  address bar (`history.replaceState`) once the frame has them.
- As long as the join link or a little shorter (`https://tvpipe.party/p#c=`
  replaces `https://`, `.trycloudflare.com/`, `?` and `#`), so the QR
  code does not grow.
- The `<iframe>` fills the page (`position: fixed; inset: 0`) and allows
  `autoplay; clipboard-write; fullscreen; screen-wake-lock; web-share`
  (games' sounds, the wake lock). The page sends no referrer.
- A framed page tells the frame page its title and `theme-color`
  (`{type: "tvpipe-frame", title, theme}` by `postMessage`, from
  `@tvpipe/party`'s client, `announceToFrame`); the frame page takes
  them only from its frame's window and the tunnel's origin and shows
  `TITLE · tvpipe.party` and the colour (the browser's bars).
- No valid fragment: a message with a link to `/join`.
- A page in a frame of another site gets partitioned storage (by
  tvpipe.party and the tunnel), which still keeps a phone's seat for a
  rejoin; it gets no `SameSite=Lax` cookies, hence the game's tag in the
  query (docs/game-switching.md). `navigator.vibrate` works in a
  cross-origin frame once the person tapped in it, which players do.
- The framed pages say who may frame them: tvpipe's public and LAN
  listeners send `Content-Security-Policy: frame-ancestors 'self'
  ORIGIN` (`ORIGIN`: the service's, `https://tvpipe.party`).
- `/CODE` redirects to the same link (`framePath` in
  `apps/tvpipe-party/src/links.ts`); its tests check it against
  `frame.js` both ways.

What it does not change: the phone still connects to the tunnel's
host (DNS filters and school networks see that name), and an allow-list
of websites (Screen Time's "Allowed Websites Only") may also need the
tunnel's domains, because frames are filtered too.

### Limits

Per client IP (`CF-Connecting-IP`), with Cloudflare's `ratelimit`
binding (counted per location, which is enough):

- lookups (`/CODE`, `/join?code=` with a well-formed code), hits and
  misses alike: 20 a minute, then `429` with the join page saying to wait
  a minute (counting only misses would let a scanner tell live codes
  from the 302s once the misses are used up);
- `POST /api/links`: 10 a minute;
- `PUT`/`DELETE`: 60 a minute.

### Storage (D1)

```sql
CREATE TABLE links (
  code TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,      -- SHA-256 of the secret, hex
  created INTEGER NOT NULL,  -- ms since the epoch
  updated INTEGER NOT NULL
);
```

Taking a code is one statement, so two registrations cannot both get it:

```sql
INSERT INTO links (code, url, secret, created, updated) VALUES (?1, ?2, ?3, ?4, ?4)
ON CONFLICT (code) DO UPDATE SET url = ?2, secret = ?3, created = ?4, updated = ?4
WHERE links.updated < ?5      -- now - 24 h
```

(`changes` is 1 when the code was taken.) Lookups ignore age: a stale row
still redirects until its code is given away. Rows of crashed runs stay
until their code is reused (at most 160,000 rows).

### Cost

Static files, the frame page among them, do not run the Worker. A game costs about 2 Worker requests
(`POST`, `DELETE`) plus one per 6 hours, plus one per person who types
the code: tens of thousands of games a day within the free plan's
100,000 requests. D1: a write per register, refresh and delete, a read
per lookup.

## tvpipe

- The host page asks for the short link over the local API:
  `shortlink {url, code}` → `{url: "https://tvpipe.party/BCDF", code}`,
  or an error (`unavailable`: no tunnel, `--no-short-link`, the service
  failed; `bad-url`: the url is not on the tunnel's host). The call runs
  on its own thread (network).
- Only for the tunnel's join link (the LAN and this computer get none).
- tvpipe keeps one registration per run. The same url again: the same
  answer, no request. Another url (a reloaded host page, a new tunnel):
  `PUT` with the new url (the code stays); `404` there: `POST` again.
- A thread refreshes it every 6 hours (`PUT {}`) while the run lasts; at
  the end tvpipe sends `DELETE` (3 s at most; failures are only logged).
- `--no-short-link` (`tvpipe game play`) turns it off; so does
  `TVPIPE_PARTY_URL=off`. Both also turn off the frame page.
- `info` names the frame page: `phone.frame` (`BASE/p`, absent when
  off). The public and LAN listeners send `Content-Security-Policy:
  frame-ancestors 'self' ORIGIN` (the service's origin; only `'self'`
  when off) on every answer.
- Requests: HTTPS through `net::fetch` (Mozilla's roots), `User-Agent`
  tvpipe's, timeouts 5 s connect, 10 s read; plain http only to
  loopback (tests).

## The party library

- `JoinInfo.url`: what phones open, and the QR code. With a tunnel and
  `info.phone.frame` the frame page's link (`frameLink`:
  `https://tvpipe.party/p#c=…&r=…&k=…`), else tvpipe's join link (the
  LAN, this computer, a self-hosted OpenTunnel, short links off).
  `Party.rejoinLink` adds `&p=TOKEN` to either; the frame page passes
  it on.
- `JoinInfo.short?: string`: `https://tvpipe.party/BCDF`, when tvpipe
  registered one. `HostedParty.refreshJoin()` asks for it, for the
  tunnel's own join link, when the phone link is the tunnel's; failures
  leave it out.
- `joinText(join)` (exported from the client too): what a TV or host page
  shows people to type: the short link without `https://` (`tvpipe.party/BCDF`),
  or `null`: show only the QR code (a link without its `#k=` key would not
  let anyone in, so there is nothing else worth typing).
- The client (`PartyClient.fromLocation`) calls `announceToFrame()`: in
  a frame of another site it posts the title and colour to the frame
  page, now and when they change.
