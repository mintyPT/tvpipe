/**
 * Drawbluff's host page: the game runs here, in tvpipe's
 * window (docs/playshare-design.md). It makes the party on tvpipe's
 * relay, puts the TV page on the TVs the launcher chose, runs the rules
 * (`game/`), and shows the room: the QR code, the TVs,
 * the players, the settings and a preview of the TV. Bots are for tests:
 * their buttons show only with `?bots` in the page's URL. The room's
 * language (default: this browser's) is a setting: the prompts, every
 * phone, the TV and this page follow it.
 */

import { qrSvg, Tvpipe, type CastStatus, type HostedParty, type Player, type LateJoin, type SurfaceEncoder } from "@tvpipe/party";

import { bots, type Bot } from "../game/bots.ts";
import { DEFAULT_TIMINGS, Drawbluff, FAST_TIMINGS } from "../game/game.ts";
import { LANGS, parsePrompts, pickLang, type Lang, type Prompt } from "../game/rules.ts";
import { strings } from "./strings.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function showError(text: string | null): void {
  const e = $("error");
  e.hidden = !text;
  e.textContent = text ?? "";
}

let party: HostedParty;
let game: Drawbluff;
let tvpipe: Tvpipe;
const robots: Bot[] = [];

/** The room's language: last time's choice on this computer, else the browser's. */
const LANG_KEY = "drawbluff:host-lang";
let lang: Lang = pickLang(localStorage.getItem(LANG_KEY) ?? navigator.languages?.[0] ?? navigator.language);
let t = strings(lang);

/** The page's fixed texts and the language attribute (hyphenation). */
function renderLang(): void {
  document.documentElement.lang = lang;
  const page = t.page as Record<string, string>;
  for (const el of document.querySelectorAll<HTMLElement>("[data-t]")) {
    const text = page[el.dataset["t"]!];
    if (text !== undefined) el.textContent = text;
  }
  $<HTMLSelectElement>("lang").value = lang;
}

function renderJoin(): void {
  const j = party.joinInfo;
  // The QR code and the link it holds (the short one when tvpipe has it),
  // on one line to copy and send to someone who is not in the room.
  $("qr").innerHTML = qrSvg(j.qr, { quiet: 2 });
  // Shown without the scheme to fit; Copy copies the whole link.
  const link = j.short ?? j.url;
  $("join-url").textContent = link.replace(/^https?:\/\//, "");
  $("join-url").title = link;
  const tunnel = party.info.tunnel;
  $("link-note").textContent =
    j.mode === "tunnel" ? t.scanQr : j.mode === "lan" ? t.lanOnly : tunnel.state === "starting" ? t.opening : t.localOnly;
}

/** Copies the join link: the clipboard API, else a selected field. */
async function copyLink(): Promise<void> {
  const link = party.joinInfo.short ?? party.joinInfo.url;
  const button = $<HTMLButtonElement>("copy-link");
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const field = document.createElement("textarea");
    field.value = link;
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
  button.textContent = t.copied;
  setTimeout(() => (button.textContent = t.page.copy), 1500);
}

/** The player whose Remove waits for a second click (removing is for good). */
let confirmKick: string | undefined;
let confirmTimer: ReturnType<typeof setTimeout> | undefined;
/** What the players list shows now. */
let playersKey = "";

/**
 * A player's buttons, in the lobby and during a game: their rejoin code
 * (away players), make them the VIP (connected players; a tvpipe whose
 * library has `makeVip`), and remove them, which asks once more.
 */
function playerButtons(p: Player): HTMLButtonElement[] {
  const out: HTMLButtonElement[] = [];
  // Away: their own code to scan with any phone (a tvpipe whose library has `showRejoin`).
  if (!p.connected && typeof party.showRejoin === "function") {
    const back = document.createElement("button");
    back.className = "act";
    back.title = t.rejoinTitle(p.name);
    back.textContent = t.rejoin;
    back.onclick = () => void party.showRejoin(p).catch(() => {});
    out.push(back);
  }
  if (!p.vip && p.connected && typeof party.makeVip === "function") {
    const vip = document.createElement("button");
    vip.className = "act";
    vip.title = t.makeVipTitle(p.name);
    vip.textContent = t.makeVip;
    vip.onclick = () => party.makeVip(p);
    out.push(vip);
  }
  const kick = document.createElement("button");
  const sure = confirmKick === p.id;
  kick.className = sure ? "act kick sure" : "act kick";
  kick.title = t.remove(p.name);
  kick.textContent = sure ? t.removeSure : "✕";
  kick.onclick = () => {
    clearTimeout(confirmTimer);
    if (sure) {
      confirmKick = undefined;
      party.kick(p);
    } else {
      confirmKick = p.id;
      confirmTimer = setTimeout(() => {
        confirmKick = undefined;
        renderPlayers();
      }, 4000);
    }
    renderPlayers();
  };
  out.push(kick);
  return out;
}

function renderPlayers(): void {
  const list = $("players");
  const running = game.running;
  // Rebuilt only when it changes: views change many times a second
  // during a game, and a rebuilt button loses the click.
  const key = JSON.stringify([lang, confirmKick, party.players.map((p) => [p.id, p.name, p.vip, p.waiting, p.connected])]);
  if (key !== playersKey) {
    playersKey = key;
    list.replaceChildren(
      ...party.players.map((p) => {
        const li = document.createElement("li");
        if (!p.connected) li.className = "away";
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = p.name;
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = [p.vip ? t.vip : "", p.waiting ? t.waiting : "", p.connected ? "" : t.away].filter(Boolean).join(" · ");
        const end = document.createElement("span");
        end.className = "end";
        end.append(tag);
        end.append(...playerButtons(p));
        li.append(who, end);
        return li;
      }),
    );
  }
  $("count").textContent = `${party.players.length} / ${party.maxPlayers}`;
  ($("start") as HTMLButtonElement).disabled = running || party.connectedPlayers.length < game.minPlayers;
  $("start").textContent = running ? t.playing : party.connectedPlayers.length < game.minPlayers ? t.waitingMore(game.minPlayers - party.connectedPlayers.length) : t.start;
  for (const id of ["rounds", "timers", "late", "lang", "undo", "colormode", "adult"]) ($(id) as HTMLSelectElement).disabled = running;
  renderSettings();
}

/** The settings as the game has them (the VIP changes them from the lobby too). */
function renderSettings(): void {
  const s = game.settings;
  $<HTMLSelectElement>("undo").value = s.undo ? "on" : "off";
  $<HTMLSelectElement>("colormode").value = s.colorMode ? "on" : "off";
  $<HTMLSelectElement>("adult").value = s.adult ? "on" : "off";
  ($<HTMLSelectElement>("adult").options[1] as HTMLOptionElement).disabled = !game.adultOk;
  $<HTMLSelectElement>("late").value = party.lateJoin;
}

function renderCast(s: CastStatus): void {
  const list = $("tvs");
  // Stopped on purpose (no TVs chosen): as before the first cast.
  const none = s.state === "stopped" && !s.error && !s.receivers?.length;
  const rows = (s.receivers ?? []).map((r) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = r.name === "browser" ? t.browserTab : r.name;
    const tag = document.createElement("span");
    const ok = r.state === "connected" || r.state === "reconnected";
    tag.className = `tag ${ok ? "ok" : r.state === "failed" || r.state === "gave-up" ? "bad" : ""}`;
    tag.textContent = ok ? (s.state === "streaming" ? t.showing : t.connected) : r.error ? `${r.state}: ${r.error}` : r.state;
    li.append(name, tag);
    return li;
  });
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = none ? t.page.noTv : s.state === "starting" ? t.starting(s.to) : s.error ? t.tvFailed(s.error) : t.tvState(s.state);
    rows.push(li);
  }
  list.replaceChildren(...rows);
  $("cast-again").hidden = none || !(s.state === "failed" || s.state === "stopped");
  const player = $<HTMLAnchorElement>("player");
  player.hidden = !s.player;
  if (s.player) player.href = s.player;
}

/**
 * tvpipe's cast picker over this page: other TVs, another resolution.
 * The TV page (or the canvas) goes to the new choice; none stops it.
 */
async function changeTvs(): Promise<void> {
  showError(null);
  let sel;
  try {
    sel = await tvpipe.showCastPicker();
  } catch (err) {
    showError((err as Error).message);
    return;
  }
  if (!sel) return;
  if (sel.devices.length > 0) {
    await cast();
    return;
  }
  surface?.close();
  surface = undefined;
  stopCanvas?.();
  stopCanvas = undefined;
  await party.stopCast().catch(() => {});
  renderCast({ state: "stopped" });
}

/** How the TV gets its picture (docs/playshare-design.md §17). */
let tvMode: "page" | "canvas" = "page";
let surface: SurfaceEncoder | undefined;
let stopCanvas: (() => void) | undefined;

/** Whether this browser draws HTML into a canvas (Chrome 157+). */
const htmlInCanvas = "drawElementImage" in CanvasRenderingContext2D.prototype;

async function cast(): Promise<void> {
  showError(null);
  surface?.close();
  surface = undefined;
  stopCanvas?.();
  stopCanvas = undefined;
  try {
    if (tvMode === "canvas") await beamCanvas();
    else renderCast(await party.cast());
  } catch (err) {
    renderCast({ state: "failed", error: (err as Error).message });
  }
}

/**
 * The TV page in this window, inside a canvas that draws it
 * (HTML-in-Canvas), encoded here and streamed by tvpipe: no second
 * browser. Needs the window visible (painting stops when it is not); the
 * TV page's sound stays here.
 */
async function beamCanvas(): Promise<void> {
  await party.stopCast().catch(() => {});
  const canvas = document.createElement("canvas") as HTMLCanvasElement & { onpaint: (() => void) | null; requestPaint(): void };
  canvas.width = 1280;
  canvas.height = 720;
  canvas.setAttribute("layoutsubtree", "");
  canvas.setAttribute("content", "drawable");
  const tv = document.createElement("iframe");
  tv.setAttribute("drawable", "");
  tv.title = "The TV page";
  tv.style.cssText = "width:1280px;height:720px;border:0";
  tv.src = `${party.links.tv}&mute=1`;
  canvas.append(tv);
  const preview = $<HTMLIFrameElement>("preview");
  preview.hidden = true;
  preview.parentElement!.append(canvas);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D & { drawElementImage(e: Element, x: number, y: number, w: number, h: number): unknown };
  const s = await tvpipe.surface({ canvas, fps: 30 });
  surface = s;
  s.on("status", (st) => renderCast(st as CastStatus));
  s.on("error", (e) => showError(t.tvPicture(e.message)));
  canvas.onpaint = () => {
    ctx.reset();
    try {
      ctx.drawElementImage(tv, 0, 0, 1280, 720);
    } catch {
      return; // not painted yet
    }
    s.frame();
  };
  let live = true;
  const tick = () => {
    if (!live) return;
    canvas.requestPaint();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  stopCanvas = () => {
    live = false;
    canvas.remove();
    preview.hidden = false;
  };
}

function fitPreview(): void {
  const frame = $<HTMLIFrameElement>("preview");
  const box = frame.parentElement!;
  frame.style.transform = `scale(${box.clientWidth / 1280})`;
}

async function addBots(n: number): Promise<void> {
  showError(null);
  const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
  const names = ["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket", "Widget", "Servo"];
  try {
    const added = await bots(n, {
      url,
      room: party.code,
      key: party.joinKey,
      names: names.map((x) => `${x}${robots.length + 1}`),
      think: () => 800 + Math.random() * 4000,
    });
    robots.push(...added);
  } catch (err) {
    showError(t.botFailed((err as Error).message));
  }
}

async function main(): Promise<void> {
  renderLang();
  try {
    tvpipe = await Tvpipe.connect();
  } catch (err) {
    showError(t.noTvpipe((err as Error).message));
    return;
  }
  // Every language's prompts (data/prompts.txt, data/prompts.de.txt) and adult ones (data/prompts.adult.txt, …).
  const prompts: Partial<Record<Lang, Prompt[]>> = {};
  const adultPrompts: Partial<Record<Lang, Prompt[]>> = {};
  await Promise.all(
    LANGS.flatMap((l) =>
      [false, true].map(async (adult) => {
        const file = `prompts${adult ? ".adult" : ""}${l === "en" ? "" : `.${l}`}.txt`;
        const res = await fetch(new URL(`../data/${file}`, import.meta.url));
        if (res.ok) (adult ? adultPrompts : prompts)[l] = parsePrompts(await res.text());
      }),
    ),
  );
  if (!prompts[lang]) lang = "en";
  for (const o of $<HTMLSelectElement>("lang").options) o.disabled = !prompts[pickLang(o.value)];
  t = strings(lang);
  renderLang();
  party = await tvpipe.party({ lateJoin: "wait" });
  game = new Drawbluff(party, { prompts, adultPrompts, lang, rounds: 2 });
  game.open();
  renderJoin();
  renderPlayers();
  party.on("screen-view", () => {
    renderJoin();
    renderPlayers();
  });
  game.on("settings", renderSettings);
  game.on("phase", (p) => {
    $("phase").textContent = p === "lobby" ? t.lobby : p === "final" ? t.gameOver : t.round(Number(party.room.peek()["round"] ?? 0), t.phases[p] ?? p);
    renderPlayers();
  });
  tvpipe.on("cast", renderCast);
  tvpipe.on("tunnel", () => setTimeout(renderJoin, 100));
  tvpipe.on("close", () => showError(t.stopped));
  tvpipe.on("closing", () => {
    for (const b of robots) b.close();
  });

  const frame = $<HTMLIFrameElement>("preview");
  frame.src = `${party.links.watch}&mute=1`;
  fitPreview();
  addEventListener("resize", fitPreview);

  $<HTMLSelectElement>("lang").onchange = (e) => {
    const next = pickLang((e.target as HTMLSelectElement).value);
    try {
      game.configure({ lang: next });
    } catch (err) {
      showError((err as Error).message);
      $<HTMLSelectElement>("lang").value = lang;
      return;
    }
    lang = next;
    t = strings(lang);
    localStorage.setItem(LANG_KEY, lang);
    renderLang();
    renderJoin();
    renderPlayers();
    $("phase").textContent = game.phase === "lobby" ? t.lobby : game.phase === "final" ? t.gameOver : "";
  };
  ($("rounds") as HTMLSelectElement).onchange = (e) => game.configure({ rounds: Number((e.target as HTMLSelectElement).value) });
  ($("timers") as HTMLSelectElement).onchange = (e) =>
    game.configure({ timings: (e.target as HTMLSelectElement).value === "fast" ? FAST_TIMINGS : DEFAULT_TIMINGS });
  ($("late") as HTMLSelectElement).onchange = (e) => {
    party.lateJoin = (e.target as HTMLSelectElement).value as LateJoin;
    party.room.set({ lateJoin: party.lateJoin });
  };
  const setting = (id: string, key: "undo" | "colorMode" | "adult") => {
    $<HTMLSelectElement>(id).onchange = (e) => {
      try {
        game.configure({ [key]: (e.target as HTMLSelectElement).value === "on" });
      } catch (err) {
        showError((err as Error).message);
      }
      renderSettings();
    };
  };
  setting("undo", "undo");
  setting("colormode", "colorMode");
  setting("adult", "adult");
  // Bots are for tests, not for players: their buttons show only with ?bots.
  $("bots").hidden = !new URLSearchParams(location.search).has("bots");
  $("bot1").onclick = () => void addBots(1);
  $("bot3").onclick = () => void addBots(3);
  $("start").onclick = () => {
    if (game.running || party.connectedPlayers.length < game.minPlayers) return;
    void game.play();
    renderPlayers();
  };
  $("quit").onclick = () => void tvpipe.quit();
  $("cast-again").onclick = () => void cast();
  $("copy-link").onclick = () => void copyLink();
  $("change-tv").onclick = () => void changeTvs();
  const mode = $<HTMLSelectElement>("tvmode");
  if (!htmlInCanvas) {
    mode.disabled = true;
    mode.title = t.needsCanvas;
  }
  mode.onchange = () => {
    tvMode = mode.value === "canvas" ? "canvas" : "page";
    void cast();
  };

  const chosen = await tvpipe.selection();
  if (chosen.length > 0) await cast();
  // For checks and tests (DevTools): the party and the game.
  Object.assign(globalThis, { drawbluff: { party, game, tvpipe, addBots } });
}

void main();
