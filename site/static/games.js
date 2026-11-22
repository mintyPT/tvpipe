// tvpipe.party's games pages, /games/ and /games/NAME/ (docs/browser-party-design.md,
// "Pages on tvpipe.party"): the web app and the dialog of a web party's
// Other game. Without this script the pages work as they are: Play now
// opens the launcher for the game.
//
//   /games/                     registers the service worker (/sw.js); on iPadOS
//                               and iOS in Safari, once, the Home Screen tip
//   /games/?bots                Play now passes ?bots (test players) on to the launcher
//   /games/?switch&current=NAME in the dialog over a web party's host page
//                               (Tvpipe.showGamePicker): no header or footer, NAME
//                               marked Playing; Play now tells the page
//                               {type: "tvpipe:game-picker", picked: true,
//                               game: {name, release}}, Cancel and Escape
//                               {type: "tvpipe:game-picker", picked: false}
(() => {
  const MESSAGE = "tvpipe:game-picker";
  const query = new URLSearchParams(location.search);
  const switching = query.has("switch");
  // Before the first paint: the site's header and footer stay hidden (style.css).
  if (switching) document.documentElement.dataset.switch = "";

  const ready = (f) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", f) : f());

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---------- the dialog of Other game ----------
  function tell(msg) {
    if (window.parent !== window) window.parent.postMessage(Object.assign({ type: MESSAGE }, msg), location.origin);
  }

  function switchMode() {
    const main = document.querySelector("main.gamespage");
    if (!main) return;
    // The games on the web and their releases (the host page resolves a missing one).
    const releases = fetch("/g/index.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => (v && Array.isArray(v.games) ? new Map(v.games.map((g) => [g.name, g.release])) : null))
      .catch(() => null);
    const head = el("header", "gh pick");
    const cancel = el("button", "btn", "Cancel");
    cancel.type = "button";
    cancel.onclick = () => tell({ picked: false });
    const row = el("div", "buttons");
    row.append(cancel);
    head.append(el("h1", "", "Pick the next game"), el("p", "", "The screen and the join link stay; phones go to the next game by themselves."), row);
    main.prepend(head);
    const current = query.get("current");
    for (const g of document.querySelectorAll("article.gm")) {
      if (g.id === current) g.querySelector("header > :first-child").append(" ", el("span", "now", "Playing"));
    }
    // Other links open beside the party, never in the dialog.
    for (const a of document.querySelectorAll("a[href]:not([data-play])")) {
      a.target = "_blank";
      a.rel = "noopener";
    }
    let picked = false;
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a[data-play]");
      if (!a) return;
      e.preventDefault();
      if (picked) return;
      picked = true;
      a.textContent = "Starting…";
      const name = a.dataset.play;
      releases.then((m) => {
        const release = m && m.get(name);
        tell({ picked: true, game: release ? { name, release } : { name } });
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") tell({ picked: false });
    });
    releases.then((m) => {
      // A game not on the web (a deploy without it): no Play now.
      if (m) for (const a of document.querySelectorAll("a[data-play]")) if (!m.has(a.dataset.play)) a.hidden = true;
    });
  }

  // ---------- the web app ----------
  /** Once, on iPadOS and iOS in Safari: tvpipe.party can be a Home Screen app. */
  function homeScreenTip() {
    const ua = navigator.userAgent;
    const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const ios = ipad || /iPhone|iPod/.test(ua);
    const app = navigator.standalone === true || matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches;
    if (!ios || app) return;
    try {
      if (localStorage.getItem("tvpipe-home-hint")) return;
      localStorage.setItem("tvpipe-home-hint", "1");
    } catch (e) {
      return;
    }
    const note = el("div", "note home-hint");
    const p = el("p", "", `In Safari, Share → Add to Home Screen makes tvpipe.party an app on this ${ipad ? "iPad" : "iPhone"}: full screen, one tap away. `);
    const ok = el("button", "btn", "OK");
    ok.type = "button";
    ok.onclick = () => note.remove();
    p.append(ok);
    note.append(el("span", "lbl", "Tip"), p);
    const at = document.querySelector("main.gamespage > .gh, main.gamespage > .back");
    if (at) at.after(note);
  }

  ready(() => {
    if (switching) return switchMode();
    if (query.has("bots")) for (const a of document.querySelectorAll("a[data-play]")) a.href += "&bots";
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    homeScreenTip();
  });
})();
