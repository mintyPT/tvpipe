/**
 * The games list (docs/game-catalog.md, docs/game-switching.md): the
 * window opens here when `tvpipe game play` has no game to start with,
 * and the host page shows it in a dialog (`?mode=switch`) to pick the
 * next game. The games on this computer (the command line's) come first,
 * then the online list (fetched by tvpipe with its screenshots). Picking
 * a game or typing a source asks tvpipe for it: a local one loads at
 * once, a remote one is downloaded and, when new, asked about; then
 * tvpipe puts it in its slot and the window goes to it.
 *
 * tvpipe.party (web mode, docs/browser-party-design.md) has no use for
 * it: its games list is the site's games page (`/games/`, and
 * `/games/?switch` in the dialog).
 */

/** The message to the page around the dialog (`Tvpipe.showGamePicker`). */
const GAME_PICKER_MESSAGE = "tvpipe:game-picker";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Shot {
  src: string;
  alt: string;
  kind: "tv" | "phone";
}

interface Entry {
  name?: string;
  title: string;
  summary?: string;
  min?: number;
  max?: number;
  languages?: string[];
  home?: string;
  downloaded?: boolean;
  screenshots?: Shot[];
  /** Local games: how tvpipe names it, where it is, why it cannot run. */
  id?: string;
  from?: string;
  error?: string;
}

interface Catalog {
  local?: Entry[];
  games: Entry[];
  /** Whether there is an online list at all. */
  online?: boolean;
  error?: string;
}

interface AskGame {
  name: string;
  title: string;
  from: string;
  release?: string;
  size: string;
  files: number;
  unpacked: string;
  tvpipe?: string;
  sha256: string;
  changed: boolean;
}

type State = { choice?: number; current?: { name: string; title: string; from: string } } & (
  | { state: "idle" }
  | { state: "fetching"; source: string; done: number; total?: number }
  | { state: "ask"; game: AskGame }
  | { state: "starting"; title: string }
  | { state: "ready"; url: string }
  | { state: "failed"; source: string; error: string }
);

const LANGUAGES: Record<string, string> = {
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  nl: "Dutch",
  pt: "Portuguese",
  ja: "Japanese",
};

/** In a dialog over the host page: pick the next game. */
const switching = new URLSearchParams(location.search).get("mode") === "switch";

let current: State = { state: "idle" };
/** The choice this page made (a `ready` of another one is not ours). */
let mine: number | null = null;
/** The card picked last, to mark it busy. */
let pickedKey: string | null = null;
let polling = false;
let catalog: Catalog = { games: [] };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setState(text: string, cls = ""): void {
  const st = $("state");
  st.textContent = text;
  st.className = `state ${cls}`;
}

function showError(text: string | null): void {
  const e = $("error");
  e.hidden = !text;
  e.textContent = text ?? "";
}

function players(g: Entry): string {
  if (g.min === undefined || g.max === undefined) return "";
  return g.min === g.max ? `${g.min} players` : `${g.min}–${g.max} players`;
}

/** Whether `g` is the game being played. */
function playing(g: Entry, local: boolean): boolean {
  const c = current.current;
  if (!c) return false;
  if (local) return g.from === c.from;
  // The online twin only when the game is not one of this computer's.
  return g.name === c.name && !(catalog.local ?? []).some((l) => l.from === c.from);
}

function card(g: Entry, local: boolean): HTMLLIElement {
  const li = el("li", "game");
  const key = local ? `local:${g.id}` : `online:${g.name}`;
  li.dataset["key"] = key;
  const cover = g.screenshots?.find((s) => s.kind === "tv") ?? g.screenshots?.[0];
  if (cover) {
    const img = el("img", "cover");
    img.src = cover.src;
    img.alt = cover.alt;
    img.loading = "lazy";
    img.onerror = () => img.removeAttribute("src");
    li.append(img);
  } else {
    li.append(el("div", "cover blank", g.title));
  }
  const bar = el("div", "bar");
  bar.append(el("i"));
  li.append(bar);
  if (playing(g, local)) li.append(el("span", "tag now", "Playing"));
  else if (!local && g.downloaded) li.append(el("span", "tag", "Downloaded"));
  const text = el("div", "text");
  text.append(el("h3", "", g.title));
  if (g.summary) text.append(el("p", "summary", g.summary));
  if (local && g.from) text.append(el("p", "from", g.from));
  if (g.error) text.append(el("p", "problem", g.error));
  const facts = [players(g), (g.languages ?? []).map((l) => LANGUAGES[l] ?? l).join(", ")].filter(Boolean).join(" · ");
  if (facts) text.append(el("p", "facts", facts));
  li.append(text);
  if (g.error) {
    li.classList.add("broken");
    li.setAttribute("aria-disabled", "true");
    return li;
  }
  li.tabIndex = 0;
  li.setAttribute("role", "button");
  li.setAttribute("aria-label", `Play ${g.title}`);
  const pick = () => void choose(key, local ? { local: g.id } : { source: g.name });
  li.onclick = pick;
  li.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick();
    }
  };
  return li;
}

function renderGames(): void {
  const local = catalog.local ?? [];
  $("local-part").hidden = local.length === 0;
  $("local").replaceChildren(...local.map((g) => card(g, true)));
  const online = catalog.online !== false;
  $("online-part").hidden = !online;
  $("elsewhere").hidden = !online;
  $("games").replaceChildren(...catalog.games.map((g) => card(g, false)));
  const empty = $("empty");
  empty.hidden = catalog.games.length > 0;
  empty.textContent = catalog.error
    ? `The online list did not load: ${catalog.error}.${local.length > 0 ? "" : " A game from elsewhere still works."}`
    : "The online list is empty.";
}

async function call(body: unknown): Promise<State> {
  const r = await fetch("/_tvpipe/api/game", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const v = (await r.json()) as State & { error?: string };
  if (!r.ok) throw new Error(v.error ?? `${r.status}`);
  return v;
}

/** Whether a new choice may start (nothing of this page's under way). */
function free(): boolean {
  return current.state === "idle" || current.state === "failed" || current.state === "ready";
}

async function choose(key: string, body: { local?: string | undefined; source?: string | undefined }): Promise<void> {
  if (!free()) return;
  showError(null);
  pickedKey = key;
  try {
    if (current.state === "failed") await call({ back: true });
    const s = await call(body);
    mine = s.choice ?? null;
    render(s);
    void poll();
  } catch (err) {
    pickedKey = null;
    showError((err as Error).message);
    render(current);
  }
}

function human(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1 << 20)).toFixed(1)} MiB`;
}

function ask(g: AskGame): void {
  const d = $<HTMLDialogElement>("ask");
  $("ask-title").textContent = g.title;
  $("ask-changed").hidden = !g.changed;
  const facts = $("ask-facts");
  facts.replaceChildren();
  const row = (k: string, v: string, cls = "") => {
    facts.append(el("dt", "", k));
    facts.append(el("dd", cls, v));
  };
  row("From", g.from);
  if (g.release) row("Release", g.release);
  row("Size", `${g.size}, ${g.files} files (${g.unpacked} unpacked)`);
  row("Made for", g.tvpipe ? `tvpipe ${g.tvpipe}` : "any tvpipe");
  row("SHA-256", g.sha256, "hash");
  if (!d.open) d.showModal();
}

/** The game is in tvpipe's slot: go there (in a dialog the page around it goes). */
function started(url: string): void {
  if (switching) window.parent.postMessage({ type: GAME_PICKER_MESSAGE, picked: true }, location.origin);
  else location.assign(url);
}

function render(s: State): void {
  // Another page's choice that is done: nothing for this page.
  const theirs = s.state === "ready" && s.choice !== mine;
  const was = current.current?.from;
  current = theirs ? { state: "idle", ...(s.current ? { current: s.current } : {}) } : s;
  if (current.current?.from !== was) renderGames();
  const busy = !free() || (s.state === "ready" && !theirs);
  for (const list of [$("games"), $("local")]) {
    list.classList.toggle("locked", busy);
    for (const li of list.querySelectorAll<HTMLElement>(".game")) {
      const picked = busy && li.dataset["key"] === pickedKey;
      li.classList.toggle("busy", picked);
      const bar = li.querySelector<HTMLElement>(".bar i");
      if (bar && picked && current.state === "fetching") {
        bar.style.width = current.total ? `${Math.round((100 * current.done) / current.total)}%` : "30%";
      }
    }
  }
  $<HTMLButtonElement>("open").disabled = busy;
  $<HTMLInputElement>("source").disabled = busy;
  const dialog = $<HTMLDialogElement>("ask");
  if (current.state !== "ask" && dialog.open) dialog.close();
  switch (current.state) {
    case "idle":
      setState(switching && current.current ? `Playing ${current.current.title}` : "Pick a game", "ok");
      $("game").textContent = current.current?.title ?? "Pick one";
      break;
    case "fetching":
      setState(current.done > 0 ? `Downloading ${human(current.done)}${current.total ? ` of ${human(current.total)}` : ""}` : "Downloading…", "on");
      $("game").textContent = current.source;
      break;
    case "ask":
      setState("Waiting for you", "on");
      $("game").textContent = current.game.title;
      ask(current.game);
      break;
    case "starting":
      setState("Starting…", "on");
      $("game").textContent = current.title;
      break;
    case "ready":
      setState("Starting…", "on");
      started(current.url);
      break;
    case "failed":
      setState("Something failed", "bad");
      showError(`${current.source}: ${current.error}`);
      break;
  }
}

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const r = await fetch("/_tvpipe/api/game");
      if (!r.ok) throw new Error(`tvpipe answered ${r.status}`);
      render((await r.json()) as State);
      if (free() || current.state === "ask") break;
      await new Promise((ok) => setTimeout(ok, 200));
    }
  } catch (err) {
    setState("Not connected", "bad");
    showError(`${(err as Error).message}: is tvpipe still running?`);
  } finally {
    polling = false;
  }
}

/** Closes the dialog without a new game (`?mode=switch`). */
async function cancel(): Promise<void> {
  if (current.state === "ask") await call({ back: true }).catch(() => {});
  window.parent.postMessage({ type: GAME_PICKER_MESSAGE, picked: false }, location.origin);
}

/** The light/dark/system switch, shared with tvpipe's other pages. */
function themes(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>(".theme button");
  const set = (t: string) => {
    document.documentElement.dataset["theme"] = t;
    try {
      localStorage.setItem("tvpipe-theme", t);
    } catch {
      // No storage: the choice lasts for this page.
    }
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset["t"] === t)));
  };
  set(document.documentElement.dataset["theme"] ?? "auto");
  buttons.forEach((b) => (b.onclick = () => set(b.dataset["t"] ?? "auto")));
}

async function main(): Promise<void> {
  themes();
  $("where").textContent = `tvpipe game · ${location.host}`;
  if (switching) {
    $("title").textContent = "Pick the next game";
    $("message").textContent = "The TVs and the join link stay; phones go to the next game by themselves.";
    $("cancel").hidden = false;
    $("cancel").onclick = () => void cancel();
    addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !$<HTMLDialogElement>("ask").open) void cancel();
    });
  }
  $("other").onsubmit = (e) => {
    e.preventDefault();
    const v = $<HTMLInputElement>("source").value.trim();
    if (v) void choose(`source:${v}`, { source: v });
  };
  $("ask-form").onsubmit = (e) => {
    e.preventDefault();
    void call({ trust: true })
      .then((s) => {
        render(s);
        void poll();
      })
      .catch((err: Error) => showError(err.message));
  };
  $("ask-no").onclick = () => {
    void call({ back: true })
      .then(render)
      .catch((err: Error) => showError(err.message));
  };
  $<HTMLDialogElement>("ask").oncancel = (e) => {
    e.preventDefault();
    $("ask-no").click();
  };
  // A reload in the middle: pick up where tvpipe is.
  try {
    const r = await fetch("/_tvpipe/api/game");
    if (r.status === 403) {
      setState("Not connected", "bad");
      $("title").textContent = "Open the link tvpipe printed";
      $("message").textContent = "This page talks to tvpipe through the link it printed (or the window it opened).";
      return;
    }
    const s = (await r.json()) as State;
    if (s.state !== "ready" && s.state !== "idle") mine = s.choice ?? null;
    current = s.state === "ready" ? { state: "idle", ...(s.current ? { current: s.current } : {}) } : s;
  } catch (err) {
    showError(`tvpipe did not answer: ${(err as Error).message}`);
  }
  try {
    const r = await fetch("/_tvpipe/api/catalog");
    catalog = (await r.json()) as Catalog;
  } catch (err) {
    catalog = { games: [], error: (err as Error).message };
  }
  renderGames();
  render(current);
  if (!free()) void poll();
}

void main();
