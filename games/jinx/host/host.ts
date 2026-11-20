/**
 * Jinx's host page: the game runs here, in tvpipe's window
 * (docs/playshare-design.md). It makes the party on tvpipe's relay, puts
 * the TV page on the TVs the launcher chose, runs the rules (`game/`), and
 * shows the room: the join code and QR code, the TVs, the players, the
 * settings (rounds, writing time, words) and a muted preview of the TV.
 * Bots are for tests: their buttons show only with `?bots` in the page's
 * URL. The room's dealt words are kept in
 * `localStorage` per language, so no word comes twice until all were dealt,
 * and so are the room's records (the best bank per game length).
 * The room's language (default: this browser's, then the last choice
 * here) is a setting, changed only between games: the words, the clue
 * matcher, every phone, the TV and this page follow it. A language whose
 * data files are missing cannot be picked.
 */

import { qrSvg, Tvpipe, type CastStatus, type HostedParty, type Player } from "@tvpipe/party";

import { bots, type Bot } from "../game/bots.ts";
import { Jinx } from "../game/game.ts";
import { LANGS, matcher, pickLang, type Lang } from "../game/lang.ts";
import type { MatchOptions, WordEntry } from "../game/match.ts";
import type { Difficulty, RoundsSetting } from "../game/rules.ts";
import { strings } from "./strings.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function showError(text: string | null): void {
  const e = $("error");
  e.hidden = !text;
  e.textContent = text ?? "";
}

let party: HostedParty;
let game: Jinx;
let tvpipe: Tvpipe;
/** Every language's words (the bots' categories). */
let allWords: WordEntry[] = [];
/** Per language: words for the bots' random clues and wrong guesses. */
const dictWords: Partial<Record<Lang, string[]>> = {};
const robots: Bot[] = [];

/** The dealt words per language: English under the old key. */
const dealtKey = (l: Lang) => (l === "en" ? "jinx:dealt" : `jinx:dealt:${l}`);
/** The room's best bank per game length (rounds), every language. */
const RECORDS_KEY = "jinx:records";
const SETTINGS_KEY = "jinx:settings";

/** The room's language: last time's choice on this computer, else the browser's. */
const LANG_KEY = "jinx:host-lang";
let lang: Lang = pickLang(localStorage.getItem(LANG_KEY) ?? navigator.languages?.[0] ?? navigator.language);
let t = strings(lang);

/** The page's fixed texts and the language attribute (hyphenation). */
function renderLang(): void {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll<HTMLElement>("[data-t]")) {
    const text = t.page[el.dataset["t"]!];
    if (text !== undefined) el.textContent = text;
  }
  $("preview").title = t.page["previewTitle"] ?? "";
  for (const o of $<HTMLSelectElement>("write").options) o.textContent = t.seconds(Number(o.value));
  $<HTMLSelectElement>("lang").value = lang;
}

function renderPhase(): void {
  const p = game.phase;
  const round = Number(party.room.peek()["round"] ?? 0);
  $("phase").textContent = p === "lobby" || p === "end" ? t.phases[p] : t.round(round, t.phases[p]);
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function renderJoin(): void {
  const j = party.joinInfo;
  // Only the QR code here: the TV shows the short link to type
  // (tvpipe.party/CODE); never the tunnel's link or the room code.
  $("qr").innerHTML = qrSvg(j.qr, { quiet: 2 });
  const tunnel = party.info.tunnel;
  $("link-note").textContent = j.mode === "tunnel" ? t.scanQr : j.mode === "lan" ? t.lanOnly : tunnel.state === "starting" ? t.opening : t.localOnly;
}

/** The player whose Remove waits for a second click (removing is for good). */
let confirmKick: string | undefined;
let confirmTimer: ReturnType<typeof setTimeout> | undefined;
/** What the players list shows now. */
let playersKey = "";

/**
 * A player's buttons, in the lobby and during a game: make them the VIP
 * (connected players; a tvpipe whose library has `makeVip`), and remove
 * them, which asks once more.
 */
function playerButtons(p: Player): HTMLButtonElement[] {
  const out: HTMLButtonElement[] = [];
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
  const botIds = new Set(robots.map((b) => String(b.client.you?.["id"] ?? "")));
  // Rebuilt only when it changes: views change many times a second
  // during a game, and a rebuilt button loses the click.
  const key = JSON.stringify([lang, [...botIds], confirmKick, party.players.map((p) => [p.id, p.name, p.vip, p.waiting, p.connected])]);
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
        tag.textContent = [botIds.has(p.id) ? t.bot : "", p.vip ? t.vip : "", p.waiting ? t.waiting : "", p.connected ? "" : t.away].filter(Boolean).join(" · ");
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
  const ready = party.connectedPlayers.length;
  const start = $<HTMLButtonElement>("start");
  start.disabled = running || ready < game.minPlayers;
  start.textContent = running ? t.playing : ready < game.minPlayers ? t.waitingMore(game.minPlayers - ready) : game.phase === "end" ? t.playAgain : t.start;
  for (const id of ["lang", "rounds", "write", "difficulty"]) $<HTMLSelectElement>(id).disabled = running;
  $<HTMLButtonElement>("bot1").disabled = party.players.length >= party.maxPlayers;
  $<HTMLButtonElement>("bot3").disabled = party.players.length + 3 > party.maxPlayers;
}

/** The last cast status (drawn again when the language changes). */
let lastCast: CastStatus | undefined;

function renderCast(s: CastStatus): void {
  lastCast = s;
  const list = $("tvs");
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
    li.textContent = none ? t.noTv : s.state === "starting" ? t.starting(s.to) : s.error ? t.tvFailed(s.error) : t.tvState(s.state);
    rows.push(li);
  }
  list.replaceChildren(...rows);
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

/** tvpipe's cast picker: other TVs; none stops casting. */
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
  const names = ["Robo", "Pixel", "Gizmo", "Bolt", "Chip", "Sprocket", "Widget", "Servo"];
  try {
    const added = await bots(n, {
      url,
      room: party.code,
      key: party.joinKey,
      names: names.map((x) => `${x}${robots.length + 1}`),
      think: () => 800 + Math.random() * 3000,
      peek: () => game.secret,
      words: allWords,
      dict: dictWords,
    });
    for (const b of added) if (b.client.you) game.markBot(String(b.client.you["id"]));
    robots.push(...added);
    renderPlayers();
  } catch (err) {
    showError(t.botFailed((err as Error).message));
  }
}

/** A language's data files (its matcher's `files`), or nothing when one is missing. */
async function loadLang(l: Lang): Promise<{ words: WordEntry[]; match: MatchOptions } | undefined> {
  const m = matcher(l);
  try {
    const [wordsText, dictText] = await Promise.all(
      [m.files.words, m.files.dict].map(async (f) => {
        const res = await fetch(new URL(`../data/${f}`, import.meta.url));
        if (!res.ok) throw new Error(`data/${f}: ${res.status}`);
        return res.text();
      }),
    );
    const words = m.parseWordList(wordsText!);
    return words.length > 0 ? { words, match: m.dictionary(dictText!) } : undefined;
  } catch (err) {
    console.warn(`jinx: no ${l}: ${(err as Error).message}`);
    return undefined;
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
  // Every language's words and dictionary (data/words.txt, data/words.de.txt, …).
  const words: Partial<Record<Lang, WordEntry[]>> = {};
  const match: Partial<Record<Lang, MatchOptions>> = {};
  const dealt: Partial<Record<Lang, string[]>> = {};
  await Promise.all(
    LANGS.map(async (l) => {
      const data = await loadLang(l);
      if (!data) return;
      words[l] = data.words;
      match[l] = data.match;
      dealt[l] = loadJson<string[]>(dealtKey(l), []);
      // The bots' random clues and wrong guesses come from the curated word list:
      // the dictionary has names, places and words not for a party's TV.
      dictWords[l] = data.words.map((w) => w.word).filter((w) => /^\p{L}{4,10}$/u.test(w));
    }),
  );
  allWords = LANGS.flatMap((l) => words[l] ?? []);
  if (!words[lang]) lang = LANGS.find((l) => words[l]) ?? "en";
  for (const o of $<HTMLSelectElement>("lang").options) {
    const l = pickLang(o.value);
    o.disabled = !words[l];
    if (o.disabled) o.title = t.noWords(o.textContent ?? l);
  }
  t = strings(lang);
  renderLang();
  const settings = loadJson<{ rounds?: RoundsSetting; write?: number; difficulty?: Difficulty }>(SETTINGS_KEY, {});
  party = await tvpipe.party({ lateJoin: "wait" });
  game = new Jinx(party, {
    lang,
    words,
    match,
    dealt,
    records: loadJson<Record<number, number>>(RECORDS_KEY, {}),
    rounds: settings.rounds ?? "auto",
    difficulty: settings.difficulty ?? "normal",
    timings: { write: (settings.write ?? 45) * 1000 },
  });
  game.on("dealt", (used, l) => {
    try {
      localStorage.setItem(dealtKey(l), JSON.stringify(used));
    } catch {
      // Full or blocked: the deck still works for this session.
    }
  });
  game.on("record", (rounds, chips) => {
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify({ ...loadJson<Record<number, number>>(RECORDS_KEY, {}), [rounds]: chips }));
    } catch {
      // Full or blocked: the record lasts this session.
    }
  });
  game.open();
  renderJoin();
  renderPlayers();
  party.on("screen-view", () => {
    renderJoin();
    renderPlayers();
  });
  game.on("phase", () => {
    renderPhase();
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
    renderPhase();
    if (lastCast) renderCast(lastCast);
  };
  const rounds = $<HTMLSelectElement>("rounds");
  const write = $<HTMLSelectElement>("write");
  const difficulty = $<HTMLSelectElement>("difficulty");
  rounds.value = String(game.rounds);
  write.value = String(Math.round(game.timings.write / 1000));
  difficulty.value = game.difficulty;
  const save = () => {
    const s = { rounds: game.rounds, write: Math.round(game.timings.write / 1000), difficulty: game.difficulty };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  };
  rounds.onchange = () => {
    const v = rounds.value;
    game.configure({ rounds: v === "1" ? 1 : v === "2" ? 2 : "auto" });
    save();
  };
  write.onchange = () => {
    game.configure({ write: Number(write.value) * 1000 });
    save();
  };
  difficulty.onchange = () => {
    game.configure({ difficulty: difficulty.value as Difficulty });
    save();
  };
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
  $("change-tv").onclick = () => void changeTvs();

  const chosen = await tvpipe.selection();
  if (chosen.length > 0) await cast();
  // For checks and tests (DevTools): the party and the game.
  Object.assign(globalThis, { jinx: { party, game, tvpipe, addBots } });
}

void main();
