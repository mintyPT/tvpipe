/**
 * Krakel's host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It makes the party on tvpipe's relay, puts
 * the TV page on the TVs the launcher chose, runs the rules (`game/`),
 * and shows the room: the QR code, the TVs, the players, the settings and
 * a preview of the TV. Bots are for tests: their buttons show only in
 * test mode (`tvpipe game play --dev`) or with `?bots` in the page's URL.
 */

import { qrSvg, Tvpipe, type CastStatus, type HostedParty, type Player, type LateJoin } from "@tvpipe/party";

import { bots, type Bot } from "../game/bots.ts";
import { FAST_TIMINGS, Krakel } from "../game/game.ts";
import { LANGS, parseCategories, pickLang, type Category, type Lang } from "../game/rules.ts";
import { strings } from "./strings.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function showError(text: string | null): void {
  const e = $("error");
  e.hidden = !text;
  e.textContent = text ?? "";
}

let party: HostedParty;
let game: Krakel;
let tvpipe: Tvpipe;
const robots: Bot[] = [];

const LANG_KEY = "krakel:host-lang";
let lang: Lang = pickLang(localStorage.getItem(LANG_KEY) ?? navigator.languages?.[0] ?? navigator.language);
let t = strings(lang);

function renderLang(): void {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll<HTMLElement>("[data-t]")) {
    const text = t.page[el.dataset["t"]!];
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
  $("link-note").textContent = j.mode === "tunnel" ? t.scanQr : j.mode === "lan" ? t.lanOnly : tunnel.state === "starting" ? t.opening : t.localOnly;
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
  setTimeout(() => (button.textContent = t.page["copy"]!), 1500);
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
  const running = game.running;
  // Rebuilt only when it changes: views change many times a second
  // during a game, and a rebuilt button loses the click.
  const key = JSON.stringify([lang, confirmKick, party.players.map((p) => [p.id, p.name, p.vip, p.waiting, p.connected])]);
  if (key !== playersKey) {
    playersKey = key;
    $("players").replaceChildren(
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
  const short = party.connectedPlayers.length < game.minPlayers;
  $<HTMLButtonElement>("start").disabled = running || short;
  $("start").textContent = running ? t.playing : short ? t.waitingMore(game.minPlayers - party.connectedPlayers.length) : t.start;
  for (const id of ["rounds", "drawTime", "guessTime", "hints", "lockout", "late", "lang"]) $<HTMLSelectElement>(id).disabled = running;
  renderSettings();
}

/** The settings as the game has them (the VIP changes them from the lobby too). */
function renderSettings(): void {
  const s = game.settings;
  $<HTMLSelectElement>("drawTime").value = String(s.drawTime);
  $<HTMLSelectElement>("guessTime").value = String(s.guessTime);
  $<HTMLSelectElement>("hints").value = s.hints ? "on" : "off";
  $<HTMLSelectElement>("lockout").value = String(s.lockout);
  $<HTMLSelectElement>("rounds").value = String(game.rounds);
  $<HTMLSelectElement>("late").value = party.lateJoin === "closed" ? "closed" : "wait";
}

function renderCast(s: CastStatus): void {
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
    li.textContent = none ? t.page["noTv"]! : s.state === "starting" ? t.starting(s.to) : s.error ? t.tvFailed(s.error) : t.tvState(s.state);
    rows.push(li);
  }
  $("tvs").replaceChildren(...rows);
  $("cast-again").hidden = none || !(s.state === "failed" || s.state === "stopped");
  const player = $<HTMLAnchorElement>("player");
  player.hidden = !s.player;
  if (s.player) player.href = s.player;
}

async function cast(): Promise<void> {
  showError(null);
  try {
    renderCast(await party.cast());
  } catch (err) {
    renderCast({ state: "failed", error: (err as Error).message });
  }
}

/** tvpipe's cast picker over this page: other TVs, another resolution; none stops casting. */
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
  if (sel.devices.length > 0) return void (await cast());
  await party.stopCast().catch(() => {});
  renderCast({ state: "stopped" });
}

function fitPreview(): void {
  const frame = $<HTMLIFrameElement>("preview");
  frame.style.transform = `scale(${frame.parentElement!.clientWidth / 1280})`;
}

async function addBots(n: number): Promise<void> {
  showError(null);
  const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/_tvpipe/ws`;
  const names = ["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket", "Widget", "Servo", "Cog", "Dynamo", "Fuse"];
  try {
    const added = await bots(n, {
      url,
      room: party.code,
      key: party.joinKey,
      names: names.map((x) => `${x}${robots.length + 1}`),
      think: () => 1500 + Math.random() * 5000,
      // Bots cannot see drawings: the game tells them the word (they name it somewhere along the replay, sometimes after a wrong guess).
      oracle: (id) => game.meant(id),
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
  const words: Partial<Record<Lang, Category[]>> = {};
  await Promise.all(
    LANGS.map(async (l) => {
      const res = await fetch(new URL(`../data/words${l === "en" ? "" : `.${l}`}.txt`, import.meta.url));
      if (res.ok) words[l] = parseCategories(await res.text());
    }),
  );
  if (!words[lang]?.length) lang = "en";
  for (const o of $<HTMLSelectElement>("lang").options) o.disabled = !words[pickLang(o.value)]?.length;
  t = strings(lang);
  renderLang();
  party = await tvpipe.party({ lateJoin: "wait" });
  game = new Krakel(party, { words, lang, rounds: 2 });
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
  $<HTMLSelectElement>("rounds").onchange = (e) => game.configure({ rounds: Number((e.target as HTMLSelectElement).value) });
  $<HTMLSelectElement>("drawTime").onchange = (e) => game.configure({ drawTime: Number((e.target as HTMLSelectElement).value) });
  $<HTMLSelectElement>("guessTime").onchange = (e) => game.configure({ guessTime: Number((e.target as HTMLSelectElement).value) });
  $<HTMLSelectElement>("hints").onchange = (e) => game.configure({ hints: (e.target as HTMLSelectElement).value === "on" });
  $<HTMLSelectElement>("lockout").onchange = (e) => game.configure({ lockout: Number((e.target as HTMLSelectElement).value) });
  $<HTMLSelectElement>("late").onchange = (e) => {
    party.lateJoin = (e.target as HTMLSelectElement).value as LateJoin;
  };
  // Bots are for tests, not for players: their buttons show only in test
  // mode (tvpipe game play --dev) or with ?bots.
  $("bots").hidden = !party.info.dev && !new URLSearchParams(location.search).has("bots");
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

  if ((await tvpipe.selection()).length > 0) await cast();
  // For checks and tests (DevTools): the party and the game; `?fast` plays with short timers.
  if (new URLSearchParams(location.search).has("fast")) game.configure({ timings: FAST_TIMINGS });
  Object.assign(globalThis, { krakel: { party, game, tvpipe, addBots, robots, FAST_TIMINGS } });
}

void main();
