/**
 * A web room's join link (docs/browser-party-design.md, "Pages on
 * tvpipe.party"): `/r/?r=CODE#k=KEY[&p=TOKEN…]`. Asks tvpipe.party
 * which game the room plays (`GET /api/rooms/CODE`) and opens its phone
 * page with the room and the key, the extra fragment pairs (a rejoin
 * token) after the key. Without a host or a game yet it waits and asks
 * again; an unknown code says so. No imports: it runs on any phone.
 */

const ROOM = /^[A-Z]{4,8}$/;
const KEY = /^[A-Za-z0-9_-]{16,64}$/;
const EXTRA_NAME = /^[a-z]{1,16}$/;
const EXTRA_VALUE = /^[A-Za-z0-9_-]{1,128}$/;

interface RoomAnswer {
  code: string;
  host: boolean;
  game: { name: string; title: string; release: string; phone: string } | null;
}

const TEXTS = {
  en: {
    joining: "Joining the game…",
    waitTitle: "Waiting for the game",
    noHost: "The game's screen is away for a moment. This page goes on by itself.",
    noGame: "A game is being picked. This page goes on by itself.",
    badTitle: "No game here",
    noRoom: (c: string) => `No game with the code ${c}. Check the code on the TV.`,
    noKey: "This link is not complete. Scan the QR code on the TV again, or type the code shown there.",
    offline: "No connection to tvpipe.party. Trying again…",
    busy: "Many tries in a short time: waiting a little.",
    type: "Type a code",
    again: "Try again",
  },
  de: {
    joining: "Ins Spiel…",
    waitTitle: "Warten auf das Spiel",
    noHost: "Der Bildschirm des Spiels ist kurz weg. Diese Seite geht von selbst weiter.",
    noGame: "Ein Spiel wird ausgesucht. Diese Seite geht von selbst weiter.",
    badTitle: "Hier ist kein Spiel",
    noRoom: (c: string) => `Kein Spiel mit dem Code ${c}. Prüfe den Code auf dem Fernseher.`,
    noKey: "Dieser Link ist nicht vollständig. Scanne den QR-Code auf dem Fernseher noch einmal oder tippe den Code ein, der dort steht.",
    offline: "Keine Verbindung zu tvpipe.party. Neuer Versuch…",
    busy: "Viele Versuche in kurzer Zeit: kurz warten.",
    type: "Code eingeben",
    again: "Nochmal versuchen",
  },
};

const lang = (navigator.language || "en").toLowerCase().startsWith("de") ? "de" : "en";
const t = TEXTS[lang];

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function show(state: "look" | "wait" | "bad", title: string, text: string, more = false): void {
  document.body.dataset["state"] = state;
  $("title-text").textContent = title;
  $("text").textContent = text;
  $("more").hidden = !more;
  $("again").hidden = state !== "bad";
}

/** The link's parts: the code, the key and the extra pairs (`&p=…`), or null. */
export function parseJoin(search: string, hash: string): { code: string; key: string; extra: string } | null {
  const code = (new URLSearchParams(search).get("r") ?? "").toUpperCase();
  const pairs = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const key = pairs.get("k") ?? "";
  if (!ROOM.test(code) || !KEY.test(key)) return null;
  let extra = "";
  for (const [name, value] of pairs) {
    if (name !== "k" && EXTRA_NAME.test(name) && EXTRA_VALUE.test(value)) extra += `&${name}=${value}`;
  }
  return { code, key, extra };
}

/** The game's phone page for the link, or null when `phone` is no path of this site. */
export function phoneUrl(phone: string, code: string, key: string, extra: string): string | null {
  if (!phone.startsWith("/") || phone.startsWith("//") || phone.includes("\\")) return null;
  return `${phone.split(/[?#]/)[0]}?r=${code}#k=${key}${extra}`;
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function run(): Promise<void> {
  const link = parseJoin(location.search, location.hash);
  const typed = new URLSearchParams(location.search).get("r");
  if (!link) {
    show("bad", t.badTitle, t.noKey, true);
    $("again").hidden = true;
    if (typed) $("type").setAttribute("href", `/join?code=${encodeURIComponent(typed)}`);
    return;
  }
  const started = Date.now();
  for (let tries = 1; ; tries++) {
    // Soon at first (a host page reloading or starting the next game is back in a moment), then every 4 s, 8 s after two minutes.
    let wait = tries <= 3 ? 1500 : Date.now() - started < 120_000 ? 4000 : 8000;
    try {
      const r = await fetch(`/api/rooms/${link.code}`, { cache: "no-store", headers: { Accept: "application/json" } });
      if (r.status === 404) {
        show("bad", t.badTitle, t.noRoom(link.code), true);
        return;
      }
      if (r.status === 429) {
        show("wait", t.waitTitle, t.busy);
        wait = 20_000;
      } else if (!r.ok) {
        show("wait", t.waitTitle, t.offline);
      } else {
        const room = (await r.json()) as RoomAnswer;
        const to = room.host && room.game ? phoneUrl(room.game.phone, link.code, link.key, link.extra) : null;
        if (to) {
          show("look", t.joining, room.game?.title ?? "");
          location.replace(to);
          return;
        }
        show("wait", t.waitTitle, room.host ? t.noGame : t.noHost);
      }
    } catch {
      show("wait", t.waitTitle, t.offline);
    }
    await sleep(wait);
  }
}

// In a page (tests import the functions above without one).
if (typeof document !== "undefined") {
  document.documentElement.lang = lang;
  $("type").textContent = t.type;
  $("again").textContent = t.again;
  $("again").onclick = () => {
    show("look", t.joining, "");
    void run();
  };
  void run();
}
