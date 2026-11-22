// The frame page, tvpipe.party/p (docs/short-links.md, "The frame
// page"): a game's phone page, which tvpipe serves through a tunnel,
// inside a page of tvpipe.party. Phones show tvpipe.party in the address
// bar, their history and Screen Time instead of a new tunnel name every
// game. Its fragment names the page:
//
//   /p#c=LABEL&r=ROOM&k=KEY          https://LABEL.trycloudflare.com/?r=ROOM#k=KEY
//   /p#o=ROUTE.ID&r=ROOM&k=KEY       https://ROUTE.ID.opentunnel.xyz/?r=ROOM#k=KEY
//
// More `name=value` pairs (a rejoin link's `p=TOKEN`) go into the
// page's fragment after the key. Nothing else can be framed: the host is
// put together here from one or two labels, and the page's CSP allows
// only those two domains in frames. The fragment never reaches a server.
//
// No dependencies; apps/tvpipe-party's tests import frameTarget.

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const CLOUDFLARE = new RegExp(`^${LABEL}$`);
const OPENTUNNEL = new RegExp(`^${LABEL}\\.${LABEL}$`);
const ROOM = /^[A-Z]{4,8}$/;
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
const EXTRA_NAME = /^[a-z]{1,16}$/;
const EXTRA_VALUE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_HASH = 600;
/** What a framed page sends (npm/party's frame.ts): its title and colour. */
const MESSAGE = "tvpipe-frame";

/**
 * The page a fragment of the frame page leads to, or null when it names
 * none: `origin` (the tunnel's), `src` (the page with room, key and the
 * extra pairs) and `hash` (the fragment without the extra pairs: what
 * the address bar keeps, so a rejoin token does not stay in it).
 *
 * @param {unknown} hash `location.hash`, with or without its `#`
 * @returns {{ origin: string, src: string, hash: string } | null}
 */
export function frameTarget(hash) {
  if (typeof hash !== "string") return null;
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (h === "" || h.length > MAX_HASH) return null;
  /** @type {string | null} */ let host = null;
  /** @type {string | null} */ let where = null;
  /** @type {string | null} */ let room = null;
  /** @type {string | null} */ let key = null;
  /** @type {string[]} */ const extra = [];
  const seen = new Set();
  for (const part of h.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 1) return null;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (seen.has(name)) return null;
    seen.add(name);
    if (name === "c" || name === "o") {
      if (host !== null) return null;
      if (name === "c" ? !CLOUDFLARE.test(value) : !OPENTUNNEL.test(value)) return null;
      host = name === "c" ? `${value}.trycloudflare.com` : `${value}.opentunnel.xyz`;
      where = `${name}=${value}`;
    } else if (name === "r") {
      if (!ROOM.test(value)) return null;
      room = value;
    } else if (name === "k") {
      if (!KEY.test(value)) return null;
      key = value;
    } else {
      if (!EXTRA_NAME.test(name) || !EXTRA_VALUE.test(value)) return null;
      extra.push(`${name}=${value}`);
    }
  }
  if (host === null || room === null || key === null) return null;
  const origin = `https://${host}`;
  return {
    origin,
    src: `${origin}/?r=${room}#${[`k=${key}`, ...extra].join("&")}`,
    hash: `${where}&r=${room}&k=${key}`,
  };
}

/** A colour from a framed page, or null (anything else is dropped). */
function colour(v) {
  return typeof v === "string" && /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9., %/]{1,48}\))$/.test(v) ? v : null;
}

function start() {
  const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("game"));
  const theme = document.querySelector('meta[name="theme-color"]');
  /** @type {{ origin: string, src: string, hash: string } | null} */
  let current = null;

  const show = () => {
    const t = frameTarget(location.hash);
    current = t;
    if (!t) {
      frame.removeAttribute("src");
      document.body.dataset.state = "bad";
      document.title = "tvpipe.party";
      return;
    }
    document.body.dataset.state = "loading";
    // The extra pairs (a rejoin token) go to the game once, not into the
    // address bar or the history.
    if (location.hash.slice(1) !== t.hash) {
      try {
        history.replaceState(history.state, "", `${location.pathname}${location.search}#${t.hash}`);
      } catch {}
    }
    frame.src = t.src;
  };

  frame.addEventListener("load", () => {
    if (current) document.body.dataset.state = "shown";
  });
  addEventListener("message", (ev) => {
    if (!current || ev.source !== frame.contentWindow || ev.origin !== current.origin) return;
    const d = ev.data;
    if (!d || typeof d !== "object" || d.type !== MESSAGE) return;
    if (typeof d.title === "string") {
      const title = d.title.replace(/\s+/g, " ").trim().slice(0, 80);
      document.title = title ? `${title} · tvpipe.party` : "tvpipe.party";
    }
    const c = colour(d.theme);
    if (c) {
      theme?.setAttribute("content", c);
      document.documentElement.style.backgroundColor = c;
    }
  });
  addEventListener("hashchange", show);
  show();
}

if (typeof document !== "undefined" && document.getElementById("game")) start();
