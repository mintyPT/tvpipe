// @ts-check
/**
 * Landgrab's TV page: tvpipe casts it with its own browser, or anyone
 * opens the watch link (the host page's preview, muted). It shows the
 * screen view (`{ roster, screen, join }`) in the room's language: the
 * world map always (`map.js`), and over it the lobby, the planning
 * phase (the round's banner, the clock, who is still thinking and who
 * is ready, uprisings), the battle (each event of the round played
 * along `game/timeline.ts`: reinforcements dropping in, armies marching
 * along war-map arrows, fights with their dice on the fight card,
 * territories flooding with the conqueror's colour, fanfares), and the
 * end (the winner's world, the podium, the awards). Sound is
 * `sound.js`. Players' names are always text.
 */

import { joinText, PartyClient, qrSvg } from "/_tvpipe/lib/client.js";
import { losses } from "../game/rules.js";
import { PACE, timeline } from "../game/timeline.js";
import { parseWorld } from "../game/world.js";
import { watchFit } from "../phone/fit.js";
import { pickLang } from "../phone/i18n.js";
import { WILD, WorldMap } from "./map.js";
import { mute, sfx } from "./sound.js";
import { strings } from "./strings.js";

/** @typedef {import("../game/world.js").World} World */
/** @typedef {import("../game/rules.js").Event} Event */
/** @typedef {import("../game/rules.js").Attack} Attack */
/** @typedef {[number, number]} P */

const params = new URLSearchParams(location.hash.slice(1));
// The bottom left corner (the South Pacific) is tvpipe's join badge.
const client = PartyClient.fromLocation({ role: /** @type {any} */ (params.get("role") ?? "screen"), rejoinBadge: { corner: "bottom-left" } });
const stage = /** @type {HTMLElement} */ (document.getElementById("stage"));
const hud = /** @type {HTMLElement} */ (document.getElementById("hud"));
const statusBar = /** @type {HTMLElement} */ (document.getElementById("status"));
mute(params.get("mute") === "1");

let lang = pickLang(undefined);
let t = strings(lang);

/** @type {World | null} */
let world = null;
/** @type {WorldMap | null} */
let map = null;

/** Where the HUD stands over the whole world, as fractions of the screen (the map's labels keep clear). */
const HUD_KEEP = /** @type {[number, number, number, number][]} */ ([
  [0, 0.24, 0.115, 0.48],
  [0, 0.69, 0.2, 0.31],
  [0.84, 0, 0.16, 0.14],
]);

// ---------------------------------------------------------------------------
// Helpers

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | null | undefined | false)} kids
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") for (const [p, x] of Object.entries(v)) el.style.setProperty(p, String(x));
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

const isColor = (/** @type {unknown} */ c) => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
/** A holder's colour from the screen view; the wild lands parchment. @param {string} id */
function colorOf(id) {
  if (!id) return WILD;
  const c = client.view?.screen?.colors?.[id];
  return isColor(c) ? c : "#7c8696";
}
/** @param {string} id */
function nameOf(id) {
  if (!id) return t.wild;
  const p = /** @type {any[]} */ (client.view?.screen?.players ?? []).find((x) => x.id === id);
  return p?.name ?? /** @type {any[]} */ (client.view?.roster ?? []).find((r) => r.id === id)?.name ?? "?";
}
/** @param {number} i */
const tName = (i) => world?.territories[i]?.name[lang] ?? "";
/** @param {string} id */
const cName = (id) => world?.continents.find((c) => c.id === id)?.name[lang] ?? id;

/** @type {ReturnType<typeof setTimeout>[]} timers of what plays now */
let timers = [];
function later(/** @type {number} */ ms, /** @type {() => void} */ fn) {
  timers.push(setTimeout(fn, Math.max(0, ms)));
}
function stopAll() {
  for (const x of timers) clearTimeout(x);
  timers = [];
  for (const d of rolling) d.stop();
  rolling = [];
}

/** A hexagonal chip in a colour, with something in it. @param {string} color @param {string} [text] */
const hexchip = (color, text = "") => h("span", { class: "hexchip", style: { "--c": color } }, text);

const SWORDS = `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M4 3l7.5 7.5-1.6 1.6L2.4 4.6V3zM20 3v1.6l-9.9 9.9 1.5 1.5-1.4 1.4-1.8-1.8-3 3 .6.6-1.4 1.4-2.8-2.8 1.4-1.4.6.6 3-3-1.8-1.8 1.4-1.4 1.5 1.5L18.4 3z" fill="currentColor"/></svg>`;

// ---------------------------------------------------------------------------
// The page

client.on("status", (st) => {
  statusBar.hidden = st === "open";
  statusBar.textContent = st === "reconnecting" || st === "connecting" ? t.reconnecting : st === "closed" ? t.over : "";
});
client.on("view", (view) => render(view));

// The sea's light under the map, and the vignette over it.
stage.prepend(h("div", { class: "glint a" }), h("div", { class: "glint b" }));
hud.before(h("div", { class: "vignette" }));

const fontsReady = Promise.all(['1em "Lilita One"', '1em "IM Fell English SC"', '600 1em "Barlow Condensed"', '800 1em "Barlow Condensed"'].map((f) => document.fonts.load(f))).catch(() => []);
Promise.all([fetch(new URL("../data/world.txt", import.meta.url)).then((r) => r.text()), fontsReady]).then(([text]) => {
  world = parseWorld(text);
  map = new WorldMap(world);
  /** @type {HTMLElement} */ (stage.querySelector(".glint.b")).after(map.el);
  labelMap();
  if (client.view) render(client.view);
});

let labelLang = "";
/** The continents' labels in the room's language. */
function labelMap() {
  if (!map || !world || labelLang === lang) return;
  labelLang = lang;
  map.labels(Object.fromEntries(world.continents.map((c) => [c.id, c.name[lang]])), HUD_KEEP, innerWidth / Math.max(1, innerHeight));
}

let phaseKey = "";
/** @type {{ el: HTMLElement, update?: (view: any) => void, frame?: () => void, dispose?: () => void } | null} */
let scene = null;
let lastStep = -1;

/** @param {any} view */
function render(view) {
  const sc = view.screen ?? {};
  const l = pickLang(sc.lang);
  const relang = l !== lang;
  if (relang) {
    lang = l;
    t = strings(l);
    document.documentElement.lang = l;
  }
  client.joinVisible = sc.phase === "lobby" || !sc.phase;
  if (!map || !world) return;
  labelMap();
  const key = `${sc.phase}:${sc.round ?? ""}`;
  if (key !== phaseKey || relang) {
    phaseKey = key;
    stopAll();
    map.clearFx();
    map.focus([]);
    map.glow([], "");
    map.noFronts();
    if (sc.phase !== "lobby") map.home(900);
    lastStep = -1;
    scene?.dispose?.();
    const old = scene;
    if (old) {
      old.el.classList.add("leaving");
      setTimeout(() => old.el.remove(), 450);
    }
    scene = build(sc);
    hud.append(scene.el);
  }
  // The board: everything but what the event on screen is animating.
  if (sc.board && sc.phase !== "battle") map.board(sc.board, colorOf);
  // In the battle the labels change with the events (a continent's fanfare), not ahead of them.
  if (sc.phase !== "battle") holders(sc.players ?? []);
  scene?.update?.(view);
}

/** The continents' labels in their holders' colours. @param {any[]} players */
function holders(players) {
  if (!world || !map) return;
  for (const c of world.continents) {
    const p = players.find((x) => (x.continents ?? []).includes(c.id));
    map.holder(c.id, p ? colorOf(p.id) : "");
  }
}

function frame() {
  scene?.frame?.();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** @param {any} sc */
function build(sc) {
  stage.dataset["phase"] = sc.phase ?? "";
  switch (sc.phase) {
    case "lobby":
      return lobby();
    case "plan":
      return plan(sc);
    case "battle":
      return battle(sc);
    case "final":
      return final(sc);
    default:
      return { el: h("div", { class: "scene" }) };
  }
}

function logo() {
  return h("div", { class: "logo" }, ..."LAND".split("").map((c, i) => h("span", { style: { "--i": i } }, c)), ..."GRAB".split("").map((c, i) => h("span", { class: "g", style: { "--i": i + 4 } }, c)));
}

/**
 * The standings in the Pacific: a hex in the player's colour with their
 * territories, the name, the armies, stars; in planning who is still
 * thinking and who is ready. Rows keep their elements and slide when the
 * order changes.
 */
function scoreboard() {
  const el = h("div", { class: "board" });
  /** @type {Map<string, { row: HTMLElement, chip: HTMLElement, name: HTMLElement, sub: HTMLElement, state: HTMLElement, lands: number, ready: boolean | undefined, key: string }>} */
  const rows = new Map();
  return {
    el,
    /** @param {any[]} players @param {{ ready?: boolean }} [o] */
    update(players, o = {}) {
      const seen = new Set();
      players.forEach((p, i) => {
        seen.add(p.id);
        let r = rows.get(p.id);
        if (!r) {
          const chip = hexchip(colorOf(p.id));
          const name = h("b", { "data-fit": "1" });
          const sub = h("small", { "data-fit": "1" });
          const state = h("span", { class: "state" });
          const row = h("div", { class: "player", style: { "--c": colorOf(p.id) } }, chip, h("span", { class: "who" }, name, sub), state);
          r = { row, chip, name, sub, state, lands: -1, ready: undefined, key: "" };
          rows.set(p.id, r);
          el.append(row);
        }
        r.row.style.transform = `translateY(${(i * 5.4).toFixed(1)}rem)`;
        r.row.classList.toggle("out", !!p.out);
        r.row.classList.toggle("gone", !!p.gone);
        if (r.name.textContent !== p.name) r.name.textContent = p.name;
        const key = `${p.lands}|${p.armies}|${p.stars}|${i === 0 && p.lands > 0}`;
        if (key !== r.key) {
          r.key = key;
          if (r.lands >= 0 && r.lands !== p.lands) {
            r.row.classList.remove("bumped");
            void r.row.offsetWidth;
            r.row.classList.add("bumped");
          }
          r.lands = p.lands;
          r.chip.textContent = String(p.lands);
          r.sub.replaceChildren(p.out ? t.out : `${t.n(p.armies)} ${t.armies}`, p.stars ? h("span", { class: "st" }, "★".repeat(p.stars)) : "");
          r.row.querySelector(".crown")?.remove();
          if (i === 0 && p.lands > 0 && players.length > 1) r.row.append(h("span", { class: "crown" }, "♛"));
        }
        const want = o.ready && !p.out && !p.gone ? !!p.ready : undefined;
        if (want !== r.ready) {
          const was = r.ready;
          r.ready = want;
          r.state.className = `state${want === true ? " ready" : want === false ? " thinking" : ""}`;
          r.state.replaceChildren(...(want === true ? ["✓"] : want === false ? [h("i"), h("i"), h("i")] : []));
          if (want === true && was === false) {
            r.row.classList.remove("justready");
            void r.row.offsetWidth;
            r.row.classList.add("justready");
            sfx.ready();
            // Their lands light up on the map.
            const m = map;
            if (m) m.flash(m.own.flatMap((o, i) => (o === p.id ? [i] : [])), colorOf(p.id));
          }
        }
      });
      for (const [id, r] of rows) if (!seen.has(id)) (r.row.remove(), rows.delete(id));
    },
  };
}

/** The medallion top right: the round, the phase, a ring (the clock, or the battle's progress). @param {any} sc @param {string} phase */
function medal(sc, phase) {
  const ring = h("div", { class: "clock" });
  ring.innerHTML = `<svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="40"/><circle class="run" cx="50" cy="50" r="40" pathLength="100" stroke-dasharray="100 100"/></svg><b></b>`;
  const run = /** @type {SVGCircleElement} */ (ring.querySelector(".run"));
  const mid = /** @type {HTMLElement} */ (ring.querySelector("b"));
  const el = h("div", { class: "medal" }, h("div", { class: "lbl" }, h("small", {}, phase), h("b", {}, `${sc.round ?? 1}`, h("em", {}, `/${sc.rounds ?? 1}`))), ring);
  let shown = -1;
  return {
    el,
    ring,
    mid,
    /** @param {number} f */
    fill(f) {
      run.setAttribute("stroke-dasharray", `${(Math.max(0, Math.min(1, f)) * 100).toFixed(2)} 100`);
    },
    /** The clock: the share left and the ms. @param {number} f @param {number} ms */
    clock(f, ms) {
      this.fill(f);
      const n = Math.max(0, Math.ceil(ms / 1000));
      if (n === shown) return;
      shown = n;
      mid.textContent = String(n);
      ring.classList.toggle("low", ms > 0 && ms <= 10_000);
      if (ms > 0 && n <= 5) sfx.tick();
    },
  };
}

/** A headline at the top (continents, players wiped out, uprisings). @param {HTMLElement} box @param {string} text @param {{ color?: string, sub?: string, icon?: string, ms?: number }} [o] */
function headline(box, text, o = {}) {
  box.querySelectorAll(".headline").forEach((x) => x.remove());
  const el = h("div", { class: "headline", style: o.color ? { "--c": o.color } : {} }, o.icon ? h("span", { class: "icon" }, o.icon) : null, h("div", {}, h("span", {}, text), o.sub ? h("small", {}, o.sub) : null));
  box.append(el);
  setTimeout(() => el.classList.add("gone"), o.ms ?? 3000);
  setTimeout(() => el.remove(), (o.ms ?? 3000) + 700);
}

// ---------------------------------------------------------------------------
// The lobby

function lobby() {
  const qr = h("div", { class: "qrcard" });
  const short = h("div", { class: "short" });
  const seats = h("div", { class: "seats" });
  const hint = h("p", { class: "hint" });
  const settings = h("div", { class: "settings" });
  const el = h(
    "div",
    { class: "scene lobby" },
    h("div", { class: "left" }, logo(), h("p", { class: "tagline" }, t.tagline), h("div", { class: "joinbox" }, qr, h("div", {}, h("div", { class: "big" }, t.scanToJoin), short, h("div", { class: "arrowhint" }, t.scanHint)))),
    h("div", { class: "right" }, h("h2", {}, t.generals), seats, hint, h("div", { class: "how" }, ...t.how.map(([b, x], i) => h("div", { class: "step" }, h("i", {}, String(i + 1)), h("b", {}, b), h("span", {}, x)))), settings),
  );
  let qrUrl = "";
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Map<string, HTMLElement>} */
  const seatEls = new Map();
  // The map drifts slowly behind the lobby, Europe and Africa in the middle.
  const t0 = performance.now();
  map?.paint();
  return {
    el,
    frame() {
      if (!map) return;
      const k = (performance.now() - t0) / 1000;
      map.look(map.W * (0.5 + Math.sin(k / 14) * 0.1), map.H * (0.45 + Math.cos(k / 17) * 0.06), 1.25 + Math.sin(k / 11) * 0.05);
    },
    /** @param {any} v */
    update(v) {
      const sc = v.screen ?? {};
      if (v.join?.url && v.join.url !== qrUrl) {
        qrUrl = v.join.url;
        qr.innerHTML = qrSvg(v.join.qr, { quiet: 2 });
      }
      short.textContent = joinText(v.join) ?? "";
      const roster = /** @type {any[]} */ (v.roster ?? []);
      const max = sc.maxPlayers ?? 6;
      const min = sc.minPlayers ?? 2;
      /** @type {HTMLElement[]} */
      const kids = roster.map((r) => {
        const fresh = !seen.has(r.id);
        if (fresh) seen.add(r.id), sfx.join();
        let seat = seatEls.get(r.id);
        if (!seat) {
          seat = h("div", { class: "seat fresh" });
          seatEls.set(r.id, seat);
        }
        seat.className = `seat${r.connected ? "" : " away"}${fresh ? " fresh" : ""}`;
        seat.style.setProperty("--c", colorOf(r.id));
        seat.replaceChildren(hexchip(colorOf(r.id)), h("b", { "data-fit": "1" }, r.name), ...(r.vip ? [h("small", {}, "VIP")] : []));
        return seat;
      });
      for (let i = roster.length; i < max; i++) kids.push(h("div", { class: "seat empty" }, hexchip("rgba(255,255,255,.3)"), h("b", {}, i < min ? t.waitingSeat : t.freeSeat)));
      seats.replaceChildren(...kids);
      const ready = roster.filter((r) => r.connected).length;
      hint.textContent = ready < min ? t.needed(min - ready) : t.vipStarts(roster.find((r) => r.vip)?.name);
      settings.replaceChildren(h("span", {}, t.rounds(sc.rounds ?? 8)), h("span", {}, t.planTime(sc.planTime ?? 60)));
    },
  };
}

// ---------------------------------------------------------------------------
// Planning

/** @param {any} sc */
function plan(sc) {
  const board = scoreboard();
  const md = medal(sc, t.planWord);
  const news = h("div", { class: "news" });
  const last = (sc.round ?? 1) === (sc.rounds ?? 0) && (sc.rounds ?? 0) > 1;
  const banner = h("div", { class: "banner" }, h("div", { class: "ribbon" }, h("small", {}, last ? t.lastRound : t.round(sc.round ?? 1, sc.rounds ?? 1)), h("b", {}, t.planNow)), h("span", {}, t.planSub));
  const el = h("div", { class: "scene plan" }, board.el, md.el, news, banner);
  sfx.roll();
  const bannerMs = Math.max(1200, sc.banner ?? 2500);
  later(bannerMs - 400, () => banner.classList.add("gone"));
  later(bannerMs + 400, () => banner.remove());
  // The fronts pulse while everyone plans.
  later(600, () => map?.fronts());
  // Uprisings, one after another after the banner: the camera flies there, the rebels' colour spreads.
  const rises = /** @type {[string, number][]} */ (sc.rises ?? []);
  rises.forEach(([id, ti], k) => {
    const at = bannerMs + k * 3200;
    later(at, () => {
      const m = map;
      if (!m) return;
      const [x, y] = m.point(ti);
      m.fly(x, y, 2.2, 800);
      m.focus([ti]);
      sfx.whoosh();
    });
    later(at + 800, () => {
      const m = map;
      if (!m) return;
      const [x, y] = m.point(ti);
      m.flood(ti, colorOf(id), x, y, 900, () => (m.thump(ti), m.bump(ti, "rise"), m.confetti([x, y], colorOf(id))));
      headline(news, t.uprising, { color: colorOf(id), sub: t.risesIn(nameOf(id), tName(ti)), icon: "✊", ms: 2200 });
      sfx.uprising();
    });
    if (k === rises.length - 1)
      later(at + 3000, () => {
        map?.focus([]);
        map?.home(900);
      });
  });
  let allReady = false;
  return {
    el,
    frame() {
      const v = client.view?.screen ?? {};
      const ms = (v.deadline ?? 0) - client.now();
      md.clock(ms / Math.max(1, (v.duration ?? 60_000) + (v.banner ?? 0)), ms);
    },
    /** @param {any} v */
    update(v) {
      const players = /** @type {any[]} */ (v.screen?.players ?? []);
      board.update(players, { ready: true });
      const playing = players.filter((p) => !p.out && !p.gone);
      const ready = playing.length > 0 && playing.every((p) => p.ready);
      if (ready && !allReady) {
        allReady = true;
        md.ring.classList.add("done");
        el.append(h("div", { class: "toast" }, t.allReady));
        sfx.allReady();
      }
    },
    dispose() {
      map?.noFronts();
    },
  };
}

// ---------------------------------------------------------------------------
// The battle

/** @param {any} sc */
function battle(sc) {
  const board = scoreboard();
  const md = medal(sc, t.battle);
  md.mid.innerHTML = SWORDS;
  md.ring.classList.add("battle");
  md.fill(0);
  const card = h("div", { class: "fight", hidden: true });
  const news = h("div", { class: "news" });
  const banner = h("div", { class: "banner battle" }, h("div", { class: "ribbon" }, h("small", {}, t.round(sc.round ?? 1, sc.rounds ?? 1)), h("b", {}, t.toBattle)));
  const el = h("div", { class: "scene battle" }, board.el, md.el, card, news, banner);
  sfx.battle();
  /** @type {any[]} the standings before the event on screen */
  let shownPlayers = sc.players ?? [];
  setTimeout(() => banner.classList.add("gone"), 1300);
  setTimeout(() => banner.remove(), 2200);
  return {
    el,
    /** @param {any} v */
    update(v) {
      const sc = v.screen ?? {};
      const players = /** @type {any[]} */ (sc.players ?? []);
      const step = sc.step;
      if (!map || !step) {
        board.update(players);
        shownPlayers = players;
        if (sc.board) map?.board(sc.board, colorOf);
        return;
      }
      md.fill(step.of ? (step.i + (step.ev ? 0.5 : 0)) / step.of : 1);
      if (step.i === lastStep) return;
      lastStep = step.i;
      stopAll();
      banner.remove();
      // The standings and the continents as they were before this event (the view is after it), until it has played.
      holders(shownPlayers);
      board.update(shownPlayers);
      const after = players;
      later((step.ms ?? 0) * 0.8, () => board.update(after));
      later((step.ms ?? 0) - 50, () => holders(after));
      shownPlayers = players;
      map.clearFx();
      // Everything but the event's territories as the view has it; those from where the event starts.
      const ev = /** @type {Event | null} */ (step.ev);
      if (sc.board) map.board(sc.board, colorOf);
      if (!ev) {
        // The round is over: stars for the conquerors.
        map.focus([]);
        map.home(900);
        hideCard(card);
        const starred = /** @type {string[]} */ (sc.starred ?? []);
        if (starred.length) {
          const line = h("div", { class: "starline" }, h("span", { class: "st" }, "★"), `${t.stars}:`);
          starred.forEach((id, i) => line.append(h("b", { style: { "--c": colorOf(id) } }, nameOf(id) + (i < starred.length - 1 ? "," : ""))));
          el.append(line);
          sfx.stars();
        }
        return;
      }
      for (const [i, own, arm] of ev.was) map.set(i, own, arm, colorOf);
      play(ev, step.ms, card, news);
    },
  };
}

/** @param {HTMLElement} card */
function hideCard(card) {
  if (card.hidden || card.classList.contains("out")) return;
  card.classList.add("out");
  setTimeout(() => {
    if (card.classList.contains("out")) card.hidden = true;
  }, 400);
}

/**
 * Plays one event of the battle in `ms` along its timeline.
 * @param {Event} ev @param {number} ms @param {HTMLElement} card @param {HTMLElement} news
 */
function play(ev, ms, card, news) {
  const m = /** @type {WorldMap} */ (map);
  const tl = timeline(ev, PACE);
  const total = tl.length ? (tl.at(-1)?.[1] ?? 0) + (tl.at(-1)?.[2] ?? 0) : 1;
  const k = ms / Math.max(1, total);
  /** When a mark starts and how long it is, scaled to `ms`. @param {string} name @returns {[number, number]} */
  const at = (name) => {
    const x = tl.find(([n]) => n === name);
    return x ? [x[1] * k, x[2] * k] : [0, 0];
  };
  switch (ev.type) {
    case "place": {
      hideCard(card);
      const [, len] = at("place");
      m.focus([]);
      m.home(500);
      const toast = h("div", { class: "toast reinf" }, t.reinforce);
      news.append(toast);
      setTimeout(() => toast.remove(), len);
      // Every reinforcement drops in, the leaders' first; the whole board settles at the end.
      const each = (len * 0.6) / Math.max(1, ev.add.length);
      ev.add.forEach(([i, p, n], j) =>
        later(150 + j * each, () => {
          m.drop(i, colorOf(p));
          later(Math.min(450, len * 0.15), () => {
            m.set(i, p, (m.arm[i] ?? 0) + n, colorOf);
            m.bump(i);
            m.float(m.point(i), `+${n}`, colorOf(p));
          });
          if (j < 24) sfx.drop(j);
        }),
      );
      later(len * 0.93, () => ev.set.forEach(([i, o, a]) => m.set(i, o, a, colorOf)));
      return;
    }
    case "move": {
      hideCard(card);
      const [, len] = at("move");
      const c = colorOf(ev.p);
      m.focus([ev.from, ev.to]);
      closeUp(ev.from, ev.to, len * 0.35, 0.8);
      m.set(ev.from, ev.p, (m.arm[ev.from] ?? 0) - ev.n, colorOf);
      m.bump(ev.from);
      const arrow = m.arrow(ev.from, ev.to, c, len * 0.4, { friendly: true });
      const tok = m.token(c, ev.n, arrow.from);
      later(len * 0.12, () => (tok.march([m.point(ev.from), ...arrow.pts, m.point(ev.to)], len * 0.55), sfx.march()));
      later(len * 0.7, () => {
        tok.end("merge");
        ev.set.forEach(([i, o, a]) => m.set(i, o, a, colorOf));
        m.bump(ev.to);
        m.float(m.point(ev.to), `+${ev.n}`, c);
        sfx.arrive();
      });
      return;
    }
    case "attack": {
      const [, intro] = at("intro");
      setupAttack(ev, intro);
      fightScene(ev, ev, at, card, news, intro * 0.55);
      return;
    }
    case "clash":
      clashScene(ev, at, card, news);
      return;
  }
}

/**
 * Flies to two territories, framing them above the fight card and right
 * of the standings.
 * @param {number} a @param {number} b @param {number} ms @param {number} [zoom] how close (1: a fight's)
 */
function closeUp(a, b, ms, zoom = 1) {
  const m = /** @type {WorldMap} */ (map);
  const [x1, y1] = m.point(a);
  const [x2, y2] = m.point(b);
  const u0 = m.unit();
  if (m.wraps(a, b)) {
    // Across the edge: the target's side, the arrow coming in from the edge, a little past it.
    const off = x2 < m.W / 2 ? -1 : 1;
    m.fly(x2 - off * ((innerWidth * 0.06) / (u0 * 2.2)), y2 + (innerHeight * 0.1) / (u0 * 2.2), 2.2, ms, true);
    return;
  }
  const span = Math.max(Math.abs(x2 - x1) / m.W, (Math.abs(y2 - y1) / m.H) * 1.6);
  const z = Math.max(1.4, Math.min(3, (0.36 / Math.max(0.04, span)) * zoom));
  // On the screen the pair should sit at about (56 %, 40 %): clear of the card below and the standings left.
  const u = u0 * z;
  const dx = (innerWidth * 0.06) / u;
  const dy = (innerHeight * -0.1) / u;
  m.fly((x1 + x2) / 2 - dx, (y1 + y2) / 2 - dy, z, ms, true);
  if (ms > 300) sfx.whoosh();
}

/**
 * An attack's opening: the camera, the armies leaving their territory,
 * the arrow growing, the token marching to the front. Returns the
 * arrow and the token.
 * @param {Attack} a @param {number} intro
 */
function setupAttack(a, intro) {
  const m = /** @type {WorldMap} */ (map);
  const c = colorOf(a.p);
  m.focus([a.from, a.to]);
  closeUp(a.from, a.to, intro * 0.6);
  m.set(a.from, a.p, (m.arm[a.from] ?? 0) - a.n, colorOf);
  m.bump(a.from);
  const arrow = m.arrow(a.from, a.to, c, intro * 0.5);
  const tok = m.token(c, a.n, arrow.from);
  later(intro * 0.15, () => {
    tok.march([arrow.from, ...arrow.pts], intro * 0.6);
    sfx.march();
  });
  attackParts = { arrow, tok };
}
/** The arrow and the marching token of the attack on screen. @type {{ arrow: ReturnType<WorldMap["arrow"]>, tok: ReturnType<WorldMap["token"]> } | null} */
let attackParts = null;

/**
 * The fight card: who against whom, their armies, their dice.
 * @param {HTMLElement} card @param {{ id: string, n: number, where: number }} att @param {{ id: string, n: number, where: number }} def @param {string} label @param {boolean} [clash]
 */
function fightCard(card, att, def, label, clash = false) {
  const side = (/** @type {{ id: string, n: number, where: number }} */ x, /** @type {string} */ cls) => {
    const n = h("b", { class: "n" }, String(x.n));
    const el = h("div", { class: `side ${cls}`, style: { "--c": colorOf(x.id) } }, h("span", { class: "name", "data-fit": "1" }, nameOf(x.id)), h("span", { class: "where", "data-fit": "1" }, tName(x.where)), n);
    return { el, n };
  };
  const A = side(att, "att");
  const D = side(def, "def");
  const dA = h("div", { class: "dice att" });
  const dD = h("div", { class: "dice def" });
  card.hidden = false;
  card.className = `fight${clash ? " clash" : ""}`;
  card.replaceChildren(A.el, dA, h("div", { class: "vs" }, h("b", {}, t.vs)), dD, D.el, h("div", { class: "label" }, label));
  return { A: { ...A, dice: dA }, D: { ...D, dice: dD } };
}

/** A die: it tumbles (its face flickering) until it lands. @param {string} color @param {number} ms how long it tumbles */
function die(color, ms) {
  const el = h("span", { class: `die tumble${ms < 300 ? " quick" : ""}`, style: { "--c": color } });
  for (let i = 0; i < 9; i++) el.append(h("i"));
  el.style.animationDuration = `${Math.max(120, Math.min(260, ms / 2))}ms`;
  el.dataset["n"] = String(1 + Math.floor(Math.random() * 6));
  const flicker = setInterval(() => (el.dataset["n"] = String(1 + Math.floor(Math.random() * 6))), 70);
  return {
    el,
    /** @param {number} n @param {"win" | "lose" | ""} how */
    land(n, how) {
      clearInterval(flicker);
      el.classList.remove("tumble");
      el.style.animationDuration = "";
      el.dataset["n"] = String(n);
      el.classList.add("land");
      later(180, () => {
        el.classList.toggle("win", how === "win");
        el.classList.toggle("lose", how === "lose");
      });
    },
    stop() {
      clearInterval(flicker);
    },
  };
}
/** @type {ReturnType<typeof die>[]} */
let rolling = [];

/** A number on the card drops (red flash). @param {HTMLElement} el @param {number} v */
function drop(el, v) {
  el.textContent = String(Math.max(0, v));
  el.classList.remove("drop");
  void el.offsetWidth;
  el.classList.add("drop");
}

/**
 * Throws one round of dice on the card at `t0` for `len`, and when they
 * land, `done(roll)` (the losses).
 * @param {{ A: any, D: any }} parts @param {[number[], number[]]} roll @param {string} ca @param {string} cd @param {number} t0 @param {number} len @param {boolean} headOn @param {(la: number, ld: number, slow: boolean) => void} done
 */
function throwDice(parts, roll, ca, cd, t0, len, headOn, done) {
  const slow = len > 500;
  const tumble = slow ? len * 0.42 : len * 0.35;
  later(t0, () => {
    for (const d of rolling) d.stop();
    const da = roll[0].map(() => die(ca, tumble));
    const dd = roll[1].map(() => die(cd, tumble));
    rolling = [...da, ...dd];
    parts.A.dice.replaceChildren(...da.map((d) => d.el));
    parts.D.dice.replaceChildren(...dd.map((d) => d.el));
    sfx.dice(!slow);
    later(tumble, () => {
      const pairs = Math.min(roll[0].length, roll[1].length, headOn ? 3 : 2);
      roll[0].forEach((n, i) => da[i]?.land(n, i < pairs ? (n > (roll[1][i] ?? 0) ? "win" : headOn && n === roll[1][i] ? "lose" : "lose") : ""));
      roll[1].forEach((n, i) => dd[i]?.land(n, i < pairs ? (headOn ? (n > (roll[0][i] ?? 0) ? "win" : "lose") : n >= (roll[0][i] ?? 0) ? "win" : "lose") : ""));
      if (slow) sfx.land();
      const [la, ld] = losses(roll, headOn);
      later(slow ? 160 : 40, () => done(la, ld, slow));
    });
  });
}

/**
 * An attack's throws and its end: the flood of the conqueror's colour,
 * or the attack breaking off.
 * @param {Event} ev the event (for its fanfare)
 * @param {Attack} a the attack
 * @param {(name: string) => [number, number]} at
 * @param {HTMLElement} card @param {HTMLElement} news
 * @param {number} cardAt when the fight card comes
 */
function fightScene(ev, a, at, card, news, cardAt) {
  const m = /** @type {WorldMap} */ (map);
  const c = colorOf(a.p);
  const cd = a.foe ? colorOf(a.foe) : WILD;
  let att = a.n;
  let def = a.def;
  /** @type {{ A: any, D: any } | null} */
  let parts = null;
  later(cardAt, () => {
    parts = fightCard(card, { id: a.p, n: att, where: a.from }, { id: a.foe, n: def, where: a.to }, t.attacker);
  });
  a.rolls.forEach((roll, r) => {
    const [t0, len] = at(`roll:${r}`);
    later(t0 - 1, () => {
      if (!parts) parts = fightCard(card, { id: a.p, n: att, where: a.from }, { id: a.foe, n: def, where: a.to }, t.attacker);
      throwDice(parts, roll, c, cd, 1, len, false, (la, ld, slow) => {
        if (!parts) return;
        att -= la;
        def -= ld;
        const tok = attackParts?.tok;
        const front = tok?.pos ?? m.point(a.to);
        const target = m.point(a.to);
        const mid = /** @type {P} */ ([(front[0] + target[0]) / 2, (front[1] + target[1]) / 2]);
        if (ld) {
          drop(parts.D.n, def);
          m.set(a.to, a.foe, def, colorOf);
          m.bump(a.to, "hit");
          m.float(target, `−${ld}`, "#ff6a55", "loss");
        }
        if (la) {
          drop(parts.A.n, att);
          tok?.set(att);
          tok?.hit();
          m.float(front, `−${la}`, "#ff6a55", "loss");
        }
        m.burst(mid, ld && !la ? c : la && !ld ? cd : "#fff", slow);
        if (slow) (m.shake(la + ld >= 2 ? "big" : "small"), sfx.hit(ld > 0));
        else sfx.tap();
        if (att <= 0) tok?.end("shatter");
      });
    });
  });
  const [o0, olen] = at("outro");
  later(o0, () => {
    const won = a.won;
    const p = parts ?? fightCard(card, { id: a.p, n: att, where: a.from }, { id: a.foe, n: def, where: a.to }, t.attacker);
    card.append(h("div", { class: "verdict", style: { "--c": won ? c : cd } }, won ? t.conquered : t.held));
    void p;
    const parts2 = attackParts;
    if (won) {
      const tok = parts2?.tok;
      const target = m.point(a.to);
      tok?.go(target, olen * 0.25);
      later(olen * 0.22, () => {
        const from = tok?.pos ?? target;
        tok?.end("merge");
        parts2?.arrow.remove();
        m.flood(a.to, c, from[0], from[1], olen * 0.4, () => {
          m.set(a.to, a.p, a.left, colorOf);
          m.bump(a.to, "conquer");
          m.thump(a.to);
          m.confetti(target, c);
        });
      });
      sfx.conquer();
    } else {
      parts2?.arrow.broken();
      parts2?.tok.end("shatter");
      m.set(a.to, a.foe, def, colorOf);
      m.bump(a.to, "conquer");
      sfx.held();
    }
    later(olen * 0.88, () => hideCard(card));
  });
  fanfare(ev, at, news);
}

/**
 * Two armies marching against each other: both arrows meet halfway, the
 * head-on throws (three dice each), then the side left standing marches
 * on into the other's territory, or both fall.
 * @param {Extract<Event, { type: "clash" }>} ev @param {(name: string) => [number, number]} at @param {HTMLElement} card @param {HTMLElement} news
 */
function clashScene(ev, at, card, news) {
  const m = /** @type {WorldMap} */ (map);
  const [, intro] = at("intro");
  const [ci] = at("clash-intro");
  const ca = colorOf(ev.p);
  const cb = colorOf(ev.q);
  m.focus([ev.a, ev.b]);
  closeUp(ev.a, ev.b, intro * 0.6);
  m.set(ev.a, ev.p, (m.arm[ev.a] ?? 0) - ev.na, colorOf);
  m.set(ev.b, ev.q, (m.arm[ev.b] ?? 0) - ev.nb, colorOf);
  m.bump(ev.a);
  m.bump(ev.b);
  const arA = m.arrow(ev.a, ev.b, ca, intro * 0.55, { meet: true, bend: 0.12 });
  const arB = m.arrow(ev.b, ev.a, cb, intro * 0.55, { meet: true, bend: 0.12, anchor: "from" });
  const tokA = m.token(ca, ev.na, arA.from);
  const tokB = m.token(cb, ev.nb, arB.from);
  later(intro * 0.2, () => {
    tokA.march([arA.from, ...arA.pts], intro * 0.7);
    tokB.march([arB.from, ...arB.pts], intro * 0.7);
    sfx.march();
  });
  let na = ev.na;
  let nb = ev.nb;
  /** @type {{ A: any, D: any } | null} */
  let parts = null;
  const mid = /** @type {P} */ ([(arA.tip[0] + arB.tip[0]) / 2, (arA.tip[1] + arB.tip[1]) / 2]);
  later(ci, () => {
    m.burst(mid, "#fff", true);
    m.shake("big");
    sfx.clash();
    parts = fightCard(card, { id: ev.p, n: na, where: ev.a }, { id: ev.q, n: nb, where: ev.b }, t.clash, true);
  });
  ev.rolls.forEach((roll, r) => {
    const [t0, len] = at(`clash:${r}`);
    later(t0 - 1, () => {
      if (!parts) parts = fightCard(card, { id: ev.p, n: na, where: ev.a }, { id: ev.q, n: nb, where: ev.b }, t.clash, true);
      throwDice(parts, roll, ca, cb, 1, len, true, (la, lb, slow) => {
        if (!parts) return;
        na -= la;
        nb -= lb;
        if (la) (drop(parts.A.n, na), tokA.set(na), tokA.hit(), m.float(tokA.pos, `−${la}`, "#ff6a55", "loss"));
        if (lb) (drop(parts.D.n, nb), tokB.set(nb), tokB.hit(), m.float(tokB.pos, `−${lb}`, "#ff6a55", "loss"));
        m.burst(mid, "#fff", slow);
        if (slow) (m.shake(), sfx.hit(true));
        else sfx.tap();
        if (na <= 0) tokA.end("shatter");
        if (nb <= 0) tokB.end("shatter");
      });
    });
  });
  if (ev.then) {
    const th = ev.then;
    const [first] = at("roll:0");
    const winA = th.p === ev.p;
    const tok = winA ? tokA : tokB;
    const lost = winA ? arB : arA;
    // The side left standing marches on: a new arrow to the other's home, a new card.
    later(first - Math.min(300, first * 0.1), () => {
      lost.broken();
      (winA ? arA : arB).remove();
      // Across the edge the camera is on b's side: there, or after the march to a.
      const wrap = m.wraps(th.from, th.to);
      if (wrap && th.to !== ev.b) m.fly(...m.point(th.to), 2.2, 300);
      const arrow = m.arrow(th.from, th.to, colorOf(th.p), 260);
      tok.march(wrap && th.to !== ev.b ? [arrow.from, ...arrow.pts] : [tok.pos, ...arrow.pts.slice(Math.floor(arrow.pts.length / 2))], 280);
      attackParts = { arrow, tok };
    });
    fightScene(ev, th, at, card, news, first);
  } else {
    const [o0, olen] = at("outro");
    later(o0, () => {
      card.append(h("div", { class: "verdict", style: { "--c": "#56606c" } }, t.bothFall));
      arA.broken();
      arB.broken();
      sfx.held();
      later(olen * 0.85, () => hideCard(card));
    });
  }
}

/** A continent taken whole, a player wiped out: the headline and the fanfare. @param {Event} ev @param {(name: string) => [number, number]} at @param {HTMLElement} news */
function fanfare(ev, at, news) {
  if (ev.type !== "attack" && ev.type !== "clash") return;
  if (!ev.continent && !ev.out) return;
  const [f0, flen] = at("fanfare");
  later(f0, () => {
    const m = map;
    const w = world;
    if (!m || !w) return;
    const winner = ev.type === "attack" ? ev.p : (ev.then?.p ?? "");
    if (ev.continent) {
      const c = w.continents.find((x) => x.id === ev.continent);
      holders(client.view?.screen?.players ?? []);
      headline(news, t.holdsAll(nameOf(winner), cName(ev.continent ?? "")), { color: colorOf(winner), sub: t.perRound(c?.bonus ?? 0), icon: "♛", ms: flen * 0.85 });
      const ids = (c?.territories ?? []).map((id) => w.byId.get(id)?.index ?? -1).filter((i) => i >= 0);
      // A wave over the continent from the territory just taken.
      const [ox, oy] = m.point(ev.type === "attack" ? ev.to : (ev.then?.to ?? 0));
      m.focus(ids);
      const xs = ids.map((i) => m.point(i));
      const cx = xs.reduce((s, p) => s + p[0], 0) / Math.max(1, xs.length);
      const cy = xs.reduce((s, p) => s + p[1], 0) / Math.max(1, xs.length);
      const span = Math.max(...xs.map((p) => Math.abs(p[0] - cx)), ...xs.map((p) => Math.abs(p[1] - cy) * 1.8), 4);
      m.fly(cx, cy - 1, Math.max(1, Math.min(2.2, (m.W * 0.22) / span)), flen * 0.3);
      for (const i of ids) {
        const [x, y] = m.point(i);
        later(flen * 0.15 + Math.hypot(x - ox, y - oy) * 30, () => (m.bump(i, "conquer"), m.thump(i)));
      }
      later(flen * 0.3, () => m.glow(ids, "#fff"));
      sfx.fanfare();
    } else if (ev.out) {
      headline(news, t.wipedOut(nameOf(ev.out)), { color: colorOf(ev.out), sub: t.comesBack, icon: "☠", ms: flen * 0.85 });
      m.shake("big");
      sfx.wipe();
    }
  });
}

// ---------------------------------------------------------------------------
// The end

/** @param {any} sc */
function final(sc) {
  const f = sc.final ?? {};
  const table = /** @type {any[]} */ (f.table ?? []);
  const win = table[0];
  const wc = win ? colorOf(win.id) : "#fff";
  const awards = Object.entries(f.awards ?? {}).filter(([, a]) => a);
  // The podium: second, first, third.
  const order = [1, 0, 2].filter((i) => table[i]);
  const heights = ["11rem", "15rem", "8rem"];
  const shower = h("div", { class: "shower" });
  for (let i = 0; i < 28; i++) shower.append(h("i", { style: { left: `${(i * 37) % 100}%`, "--c": i % 4 === 0 ? "#fff" : wc, "animation-duration": `${5 + ((i * 7) % 5)}s`, "animation-delay": `${-((i * 13) % 50) / 10}s` } }));
  const el = h(
    "div",
    { class: "scene final" },
    shower,
    h("div", { class: "crownbox", style: { "--c": wc } }, h("small", {}, f.by === "domination" ? t.byDomination : f.by === "players" ? t.byPlayers : t.byRounds), h("h1", { "data-fit": "2" }, win ? t.winner(win.name) : t.over)),
    h(
      "div",
      { class: "stand" },
      h(
        "div",
        { class: "podium" },
        ...order.map((i, k) => {
          const s = table[i];
          return h("div", { class: "step", style: { "--c": colorOf(s.id), "--h": heights[k === 1 ? 1 : k === 0 ? 0 : 2], "--d": i === 0 ? 2 : i === 1 ? 1 : 0 } }, h("b", { "data-fit": "1" }, s.name), h("div", { class: "block" }, h("i", {}, String(i + 1)), h("span", {}, `${s.lands} ${t.lands}`)));
        }),
      ),
      table.length > 3 ? h("div", { class: "rest" }, ...table.slice(3).map((s, i) => h("span", { style: { "--c": colorOf(s.id) } }, `${i + 4}. `, s.name))) : null,
      awards.length
        ? h(
            "div",
            { class: "awards" },
            ...awards.map(([k, a], i) => {
              const [title, what] = /** @type {any} */ (t.awards)[k] ?? [k, ""];
              return h("div", { class: "award", style: { "--c": colorOf(a.id), "--d": i } }, h("small", {}, title), h("b", { "data-fit": "1" }, nameOf(a.id)), h("span", {}, `${a.n} ${what}`));
            }),
          )
        : null,
    ),
  );
  sfx.victory();
  // The winner's world glows.
  if (map && win) {
    /** @type {number[]} */
    const ids = (/** @type {string[]} */ (sc.board?.own ?? [])).flatMap((o, i) => (o === win.id ? [i] : []));
    const m = map;
    later(1200, () => {
      m.focus(ids);
      m.glow(ids, "#fff");
      ids.forEach((i, k) => later(k * 60, () => m.bump(i, "conquer")));
    });
  }
  return { el };
}

// ---------------------------------------------------------------------------

watchFit();
client.connect().catch((e) => {
  statusBar.hidden = false;
  statusBar.textContent = String(e?.message ?? e);
});
