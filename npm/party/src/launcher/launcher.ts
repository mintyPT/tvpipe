/**
 * tvpipe's standard launcher (docs/playshare-design.md §7): the TVs as
 * they are found, AirPlay PIN pairing, then the game's host page. A game
 * may bring its own launcher with the same API.
 */

import { displayLag, Flasher, MAX_LAG_MS } from "../flashsync.ts";
import {
  PICKER_MESSAGE,
  Tvpipe,
  TV_DISPLAY_MS,
  TV_RENDER_MS,
  TVSYNC_PAGE,
  type CastStatus,
  type Device,
  type Info,
  type PairStatus,
  type Resolution,
  type Selection,
} from "../tvpipe.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const KIND: Record<Device["kind"], string> = {
  airplay: "AirPlay",
  cast: "Cast",
  both: "AirPlay · Cast",
  browser: "This computer",
};

/**
 * `?mode=change`: the cast picker (docs/playshare-design.md §7.1), in a
 * dialog over the host page while the game runs: it saves the choice and
 * tells the page, which casts again. Else the start of the game.
 */
const changing = new URLSearchParams(location.search).get("mode") === "change";

const RESOLUTION_LABEL: Record<Resolution, string> = { auto: "Auto", "720p": "720p", "1080p": "1080p", "2160p": "4K" };
const RESOLUTION_NOTE: Partial<Record<Resolution, string>> = {
  auto: "What the TVs take, up to 1080p.",
  "2160p": "4K needs a 4K TV and a fast computer.",
};

const selected = new Set<string>();
/** `null`: the game's picture has a fixed size. */
let resolution: Resolution | null = null;
const pairing = new Map<string, PairStatus>();
let devices: Device[] = [];
let info: Info;
let tvpipe: Tvpipe;
/** The device the PIN dialog is open for. */
let pinFor: string | null = null;
/** Set while the selection is cast and the host page loads. */
let starting: string | null = null;
/** Set when tvpipe is gone or never answered. */
let stopped: string | null = null;

function showError(text: string | null): void {
  const e = $("error");
  e.hidden = !text;
  e.textContent = text ?? "";
  renderState();
}

/** The status column: one state with a dot (grey, accent, pulsing, red). */
function renderState(): void {
  const tvs = devices.filter((d) => d.kind !== "browser").length;
  const busy = [...pairing.values()].find((p) => p.state === "connecting" || p.state === "pin");
  let text: string;
  let cls = "";
  if (stopped) [text, cls] = [stopped, "bad"];
  else if (starting) [text, cls] = [starting, "on"];
  else if (!$("error").hidden) [text, cls] = ["Something failed", "bad"];
  else if (busy) [text, cls] = [busy.state === "pin" ? "Waiting for the code" : "Pairing", "on"];
  else if (!info) text = "Connecting…";
  else if (tvs === 0) [text, cls] = ["Looking for TVs", "on"];
  else [text, cls] = [tvs === 1 ? "1 TV found" : `${tvs} TVs found`, "ok"];
  const st = $("state");
  st.textContent = text;
  st.className = `state ${cls}`;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function pairingText(p: PairStatus): [string, string] {
  if (p.state === "done") return ["Paired", "done"];
  if (p.state === "failed") return [`Pairing failed${p.error ? `: ${p.error}` : ""}`, "bad"];
  if (p.state === "pin") return ["Type the code the TV shows", ""];
  return ["Pairing…", ""];
}

function render(): void {
  const list = $("devices");
  list.replaceChildren(
    ...devices.map((d) => {
      const li = el("li", `device${selected.has(d.name) ? " selected" : ""}`);
      li.dataset["name"] = d.name;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = selected.has(d.name);
      box.setAttribute("aria-label", d.name);
      const text = el("div", "grow");
      const browser = d.kind === "browser";
      // One line under the name: the model and the sync (rows stay low for many TVs).
      const synced = typeof d.displayMs === "number" ? `Synced with phones: ${d.displayMs} ms of its own` : "";
      const meta = browser ? "Try the game without a TV: the TV picture plays in a tab" : [d.model, synced].filter(Boolean).join(" · ");
      text.append(el("div", "name", browser ? (d.title ?? "A browser tab on this computer") : d.name), el("div", "meta", meta));
      const p = pairing.get(d.name);
      if (p) {
        const [t, c] = pairingText(p);
        text.append(el("div", `pairing ${c}`, t));
      }
      const end = el("div", "end");
      end.append(el("span", "tag", KIND[d.kind] ?? d.kind));
      if (!browser && !(d.needsPairing && pairing.get(d.name)?.state !== "done")) {
        const sync = el("button", "btn small", typeof d.displayMs === "number" ? "Sync again" : "Sync") as HTMLButtonElement;
        sync.title = "Measure how far this TV is behind the phones";
        sync.onclick = (ev) => {
          ev.stopPropagation();
          openSync(d.name);
        };
        end.append(sync);
      }
      if (d.needsPairing && pairing.get(d.name)?.state !== "done") {
        const pair = el("button", "btn small", "Pair") as HTMLButtonElement;
        pair.onclick = (ev) => {
          ev.stopPropagation();
          void startPairing(d.name);
        };
        end.append(pair);
      }
      li.append(box, text, end);
      li.onclick = () => {
        if (selected.has(d.name)) selected.delete(d.name);
        else selected.add(d.name);
        render();
      };
      return li;
    }),
  );
  $("searching").hidden = devices.some((d) => d.kind !== "browser");
  // The picker may also take every TV away (the cast stops).
  ($("start") as HTMLButtonElement).disabled = (selected.size === 0 && !changing) || starting !== null || pairingFirst;
  renderState();
}

async function startPairing(device: string): Promise<void> {
  showError(null);
  pairing.set(device, { device, state: "connecting" });
  render();
  try {
    await tvpipe.pair(device);
  } catch (err) {
    pairing.set(device, { device, state: "failed", error: (err as Error).message });
    pairEnded(device, false);
    render();
  }
}

/** Set while Start pairs the chosen TVs. */
let pairingFirst = false;
/** Start waits for these pairings: called with whether the TV paired. */
const pairWaits = new Map<string, (paired: boolean) => void>();

function pairEnded(device: string, paired: boolean): void {
  const w = pairWaits.get(device);
  pairWaits.delete(device);
  w?.(paired);
}

/**
 * Pairs the chosen AirPlay TVs that show a PIN and are not paired yet,
 * one after another (the PIN dialog for each); false when one was not
 * paired (cancelled or failed: its status says why).
 */
async function pairChosen(names: string[]): Promise<boolean> {
  for (const name of names) {
    const d = devices.find((x) => x.name === name);
    if (!d?.needsPairing || pairing.get(name)?.state === "done") continue;
    const paired = new Promise<boolean>((resolve) => pairWaits.set(name, resolve));
    void startPairing(name);
    if (!(await paired)) return false;
  }
  return true;
}

function openPin(device: string, error?: string): void {
  pinFor = device;
  $("pin-device").textContent = device;
  const e = $("pin-error");
  e.hidden = !error;
  e.textContent = error ?? "";
  ($("pin-input") as HTMLInputElement).value = "";
  const dlg = $("pin") as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
  ($("pin-input") as HTMLInputElement).focus();
}

function closePin(): void {
  pinFor = null;
  const dlg = $("pin") as HTMLDialogElement;
  if (dlg.open) dlg.close();
}

/** The resolution buttons (none when the game's size is fixed). */
function renderResolution(): void {
  const box = $("res");
  const choices = info?.resolutions ?? [];
  box.hidden = choices.length === 0 || resolution === null;
  if (box.hidden) return;
  $("res-options").replaceChildren(
    ...choices.map((r) => {
      const b = el("button", "", RESOLUTION_LABEL[r] ?? r) as HTMLButtonElement;
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(r === resolution));
      b.onclick = () => {
        resolution = r;
        renderResolution();
      };
      return b;
    }),
  );
  $("res-note").textContent = (resolution && RESOLUTION_NOTE[resolution]) ?? "";
}

/** The cast picker's answer to the page it is in (`null`: cancelled). */
function answer(selection: Selection | null): void {
  if (window.parent !== window) {
    window.parent.postMessage({ type: PICKER_MESSAGE, selection }, location.origin);
    return;
  }
  // Opened by itself: nothing to tell.
  starting = selection ? "Saved" : null;
  render();
}

async function start(devicesToUse: string[]): Promise<void> {
  showError(null);
  // A TV that needs pairing is paired first, then the game starts on it.
  pairingFirst = true;
  render();
  const paired = await pairChosen(devicesToUse);
  pairingFirst = false;
  render();
  if (!paired) return;
  if (changing) {
    try {
      answer(await tvpipe.select(devicesToUse, { resolution: resolution ?? undefined }));
    } catch (err) {
      showError((err as Error).message);
    }
    return;
  }
  starting = devicesToUse.some((d) => d !== "browser") ? "Casting…" : "Starting…";
  render();
  try {
    await tvpipe.select(devicesToUse, { resolution: resolution ?? undefined });
    await tvpipe.watchDevices(false);
    location.assign(info.pages.host);
  } catch (err) {
    starting = null;
    render();
    showError((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// TV sync: this screen's flashes, moved until they come with the TV's (flashsync.ts)

interface Sync {
  device: string;
  /** How far the TV is behind this screen, ms: the lag this screen's flashes run with. */
  lag?: number;
  /** The playout delay the TV's receiver runs with (from the cast status). */
  delayMs?: number;
}

let sync: Sync | null = null;
/** The latest status of the sync page's cast. */
let syncCast: CastStatus | null = null;
/** In the cast picker: a sync replaced the game's picture, which must come back. */
let recast = false;
let flasher: Flasher | undefined;

function syncTv(): { ready: boolean; error?: string; delayMs?: number } {
  const s = syncCast;
  if (!s || !sync) return { ready: false };
  if (s.state === "failed") return { ready: false, error: s.error ?? "The TV did not start the picture" };
  if (s.state === "stopped") return { ready: false, error: "The picture on the TV stopped" };
  const r = (s.receivers ?? []).find((x) => x.name === sync!.device);
  if (r && (r.state === "failed" || r.state === "gave-up")) return { ready: false, error: r.error ?? "The TV refused the picture" };
  const up = s.state === "streaming" && r && (r.state === "connected" || r.state === "reconnected") && typeof r.delayMs === "number";
  return up ? { ready: true, delayMs: r!.delayMs! } : { ready: false };
}

function openSync(device: string): void {
  showError(null);
  sync = { device };
  syncCast = null;
  if (changing) recast = true;
  tvpipe.cast({ page: TVSYNC_PAGE, to: [device] }).then(
    (st) => {
      syncCast ??= st;
      renderSync();
    },
    (err) => {
      syncCast = { state: "failed", error: (err as Error).message };
      renderSync();
    },
  );
  $("sync-device").textContent = device;
  const dlg = $("sync") as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
  renderSync();
}

function closeSync(): void {
  flasher?.stop();
  const was = sync;
  sync = null;
  const dlg = $("sync") as HTMLDialogElement;
  if (dlg.open) dlg.close();
  // Before the game the TV goes dark again; in the picker the game's
  // picture comes back when the picker answers.
  if (was && !changing) void tvpipe.stopCast().catch(() => {});
}

/** Moves this screen's flashes (ms behind the clock, as far as the TV is). */
function setLag(ms: number): void {
  if (!sync || sync.lag === undefined) return;
  sync.lag = Math.max(0, Math.min(MAX_LAG_MS, Math.round(ms)));
  renderSync();
}

function renderSync(error?: string): void {
  if (!sync) return;
  const s = sync;
  const tv = syncTv();
  const known = devices.find((d) => d.name === s.device)?.displayMs;
  if (tv.ready) {
    s.delayMs = tv.delayMs;
    // Start where tvpipe thinks the TV is: right already, if it was synced before.
    s.lag ??= Math.min(MAX_LAG_MS, (tv.delayMs ?? 0) + (known ?? TV_RENDER_MS + TV_DISPLAY_MS));
  }
  const ready = tv.ready && s.lag !== undefined;
  flasher ??= new Flasher($("sync-beat"));
  flasher.lag = s.lag ?? 0;
  if (ready) flasher.start();
  else flasher.stop();
  const err = $("sync-error");
  err.hidden = !(error ?? tv.error);
  err.textContent = error ?? tv.error ?? "";
  $("sync-text").textContent = ready
    ? `Watch ${s.device} and this screen together and move the slider until both flash at the same moment with the same number. This one first: move right. The TV first: move left. (Arrow keys, Shift for bigger steps.)`
    : tv.error
      ? `The flashes could not start on ${s.device}.`
      : `Starting the flashes on ${s.device}…`;
  const range = $("sync-lag") as HTMLInputElement;
  range.max = String(MAX_LAG_MS);
  range.value = String(s.lag ?? 0);
  for (const id of ["sync-lag", "sync-less", "sync-more", "sync-go"]) ($(id) as HTMLInputElement | HTMLButtonElement).disabled = !ready;
  const value = $("sync-value");
  if (ready) {
    const delay = s.delayMs ?? 0;
    const own = displayLag(s.lag!, delay);
    value.replaceChildren(
      "The TV is ",
      el("b", "", `${s.lag} ms`),
      s.lag! < delay
        ? ` behind this screen, less than the ${delay} ms the picture waits to stay smooth: it counts as ${delay} ms.`
        : ` behind this screen: ${delay} ms the picture waits to stay smooth, ${own} ms the TV itself.`,
    );
  } else value.textContent = "";
  $("sync-forget").hidden = typeof known !== "number";
}

function setupSync(): void {
  const dlg = $("sync") as HTMLDialogElement;
  const range = $("sync-lag") as HTMLInputElement;
  range.addEventListener("input", () => setLag(Number(range.value)));
  $("sync-less").onclick = () => setLag((sync?.lag ?? 0) - 10);
  $("sync-more").onclick = () => setLag((sync?.lag ?? 0) + 10);
  $("sync-go").onclick = () => {
    if (!sync || sync.lag === undefined) return;
    tvpipe.setDisplayLag(sync.device, displayLag(sync.lag, sync.delayMs ?? 0)).then(closeSync, (err) => renderSync((err as Error).message));
  };
  $("sync-forget").onclick = () => {
    if (!sync) return;
    tvpipe.setDisplayLag(sync.device, null).then(closeSync, (err) => renderSync((err as Error).message));
  };
  $("sync-close").onclick = closeSync;
  dlg.addEventListener("cancel", (ev) => {
    ev.preventDefault();
    closeSync();
  });
  dlg.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    if (!sync || sync.lag === undefined) return;
    ev.preventDefault();
    const step = (ev.shiftKey ? 50 : 10) * (ev.key === "ArrowLeft" ? -1 : 1);
    setLag(sync.lag + step);
  });
  tvpipe.on("cast", (st) => {
    if (!sync) return;
    syncCast = st;
    renderSync();
  });
}

/** The cast picker's answer when cancelled: the old choice again if a sync took the TV. */
async function cancelPicker(): Promise<void> {
  if (!recast) return answer(null);
  try {
    answer(await tvpipe.chosen());
  } catch {
    answer(null);
  }
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
  // The cast picker (`data-mode="change"` is set by the page's head: no header or footer).
  if (changing) {
    $("title").textContent = "Change the TVs";
    $("message").textContent = "The TVs you pick show the game; they start the picture again.";
    $("start").textContent = "Apply";
    $("no-tv").textContent = "Cancel";
  }
  $("where").textContent = `tvpipe game · ${location.host}`;
  try {
    tvpipe = await Tvpipe.connect();
  } catch (err) {
    stopped = "Not connected";
    $("title").textContent = "Open the link tvpipe printed";
    $("message").textContent = "This page talks to tvpipe through the link it printed (or the window it opened).";
    showError(`${(err as Error).message}.`);
    return;
  }
  info = await tvpipe.info();
  document.title = `${info.title} · tvpipe`;
  $("game").textContent = info.title;
  $("game").title = info.title;
  const { min, max } = info.players;
  $("players").textContent = min === max ? `${min}` : `${min}–${max}`;
  if (!changing) $("message").textContent = `${info.title} shows on the TVs you pick. Everyone plays on their own phone.`;
  const chosen = await tvpipe.chosen();
  for (const name of chosen.devices) selected.add(name);
  resolution = chosen.resolution;
  renderResolution();
  tvpipe.on("devices", (list) => {
    devices = list;
    render();
  });
  tvpipe.on("pair", (p) => {
    pairing.set(p.device, p);
    if (p.state === "pin") openPin(p.device);
    else if (pinFor === p.device && p.state !== "connecting") closePin();
    if (p.state === "done") selected.add(p.device);
    if (p.state === "done" || p.state === "failed") pairEnded(p.device, p.state === "done");
    render();
  });
  tvpipe.on("close", () => {
    stopped = "Stopped";
    showError("tvpipe stopped. Run it again to play.");
  });
  tvpipe.on("closing", () => {
    stopped = "Ending";
    showError("tvpipe is ending.");
  });
  devices = await tvpipe.watchDevices(true);
  render();
  setupSync();

  $("start").onclick = () => void start([...selected]);
  $("no-tv").onclick = () => (changing ? void cancelPicker() : void start([]));
  if (changing) {
    addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !($("pin") as HTMLDialogElement).open && !($("sync") as HTMLDialogElement).open) void cancelPicker();
    });
  }
  ($("pin-form") as HTMLFormElement).onsubmit = (ev) => {
    ev.preventDefault();
    const pin = ($("pin-input") as HTMLInputElement).value.trim();
    if (!pinFor || !/^\d{4,8}$/.test(pin)) {
      const e = $("pin-error");
      e.hidden = false;
      e.textContent = "The code is the digits the TV shows.";
      return;
    }
    tvpipe.pairPin(pinFor, pin).catch((err) => openPin(pinFor ?? "", (err as Error).message));
  };
  $("pin-cancel").onclick = () => {
    if (pinFor) void tvpipe.pairCancel(pinFor);
    if (pinFor) pairing.delete(pinFor);
    if (pinFor) pairEnded(pinFor, false);
    closePin();
    render();
  };
}

void main();
