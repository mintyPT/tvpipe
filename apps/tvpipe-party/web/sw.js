// tvpipe.party's service worker (docs/browser-party-design.md, "Pages on
// tvpipe.party"): network first. Pages and tvpipe.party's own files are
// kept as they come by, and answer from the cache only when the network
// fails; a page never seen gives the offline page. The API, the games'
// files and other origins are not touched. Registered by /play/ and the
// launcher (scope /).

const CACHE = "tvpipe-party-1";
// Cloudflare serves offline.html as /offline (a cached redirect could not answer a page).
const OFFLINE = "/offline";
/** Kept when fetched: the games list, the launcher, the library, the look. */
const KEEP = /^\/(?:play\/|_tvpipe\/|static\/|icons\/|offline$|manifest\.webmanifest$|g\/index\.json$|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll([OFFLINE, "/play/"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const navigate = req.mode === "navigate";
  if (!navigate && !KEEP.test(url.pathname)) return;
  event.respondWith(
    fetch(req).then(
      (res) => {
        if (res.ok && res.type === "basic" && KEEP.test(url.pathname)) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
        }
        return res;
      },
      async () => {
        const hit = await caches.match(req, { ignoreSearch: navigate });
        if (hit) return hit;
        if (navigate) return (await caches.match(OFFLINE)) ?? Response.error();
        return Response.error();
      },
    ),
  );
});
