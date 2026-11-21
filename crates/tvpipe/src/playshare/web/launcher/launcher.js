/**
 * tvpipe's standard launcher (docs/playshare-design.md §7): the TVs as
 * they are found, AirPlay PIN pairing, then the game's host page. A game
 * may bring its own launcher with the same API.
 */
import { displayLag, Flasher, MAX_LAG_MS } from "../lib/flashsync.js";
import { GAME_PICKER, PICKER_MESSAGE, Tvpipe, TV_DISPLAY_MS, TV_RENDER_MS, TVSYNC_PAGE, } from "../lib/tvpipe.js";
const $ = (id) => document.getElementById(id);
const KIND = {
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
const RESOLUTION_LABEL = { auto: "Auto", "720p": "720p", "1080p": "1080p", "2160p": "4K" };
const RESOLUTION_NOTE = {
    auto: "What the TVs take, up to 1080p.",
    "2160p": "4K needs a 4K TV and a fast computer.",
};
const selected = new Set();
/** `null`: the game's picture has a fixed size. */
let resolution = null;
const pairing = new Map();
let devices = [];
let info;
let tvpipe;
/** The device the PIN dialog is open for. */
let pinFor = null;
/** Set while the selection is cast and the host page loads. */
let starting = null;
/** Set when tvpipe is gone or never answered. */
let stopped = null;
function showError(text) {
    const e = $("error");
    e.hidden = !text;
    e.textContent = text ?? "";
    renderState();
}
/** The status column: one state with a dot (grey, accent, pulsing, red). */
function renderState() {
    const tvs = devices.filter((d) => d.kind !== "browser").length;
    const busy = [...pairing.values()].find((p) => p.state === "connecting" || p.state === "pin");
    let text;
    let cls = "";
    if (stopped)
        [text, cls] = [stopped, "bad"];
    else if (starting)
        [text, cls] = [starting, "on"];
    else if (!$("error").hidden)
        [text, cls] = ["Something failed", "bad"];
    else if (busy)
        [text, cls] = [busy.state === "pin" ? "Waiting for the code" : "Pairing", "on"];
    else if (!info)
        text = "Connecting…";
    else if (tvs === 0)
        [text, cls] = ["Looking for TVs", "on"];
    else
        [text, cls] = [tvs === 1 ? "1 TV found" : `${tvs} TVs found`, "ok"];
    const st = $("state");
    st.textContent = text;
    st.className = `state ${cls}`;
}
function el(tag, cls, text) {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined)
        e.textContent = text;
    return e;
}
function pairingText(p) {
    if (p.state === "done")
        return ["Paired", "done"];
    if (p.state === "failed")
        return [`Pairing failed${p.error ? `: ${p.error}` : ""}`, "bad"];
    if (p.state === "pin")
        return ["Type the code the TV shows", ""];
    return ["Pairing…", ""];
}
function render() {
    const list = $("devices");
    list.replaceChildren(...devices.map((d) => {
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
            const sync = el("button", "btn small", typeof d.displayMs === "number" ? "Sync again" : "Sync");
            sync.title = "Measure how far this TV is behind the phones";
            sync.onclick = (ev) => {
                ev.stopPropagation();
                openSync(d.name);
            };
            end.append(sync);
        }
        if (d.needsPairing && pairing.get(d.name)?.state !== "done") {
            const pair = el("button", "btn small", "Pair");
            pair.onclick = (ev) => {
                ev.stopPropagation();
                void startPairing(d.name);
            };
            end.append(pair);
        }
        li.append(box, text, end);
        li.onclick = () => {
            if (selected.has(d.name))
                selected.delete(d.name);
            else
                selected.add(d.name);
            render();
        };
        return li;
    }));
    $("searching").hidden = devices.some((d) => d.kind !== "browser");
    // The picker may also take every TV away (the cast stops).
    $("start").disabled = (selected.size === 0 && !changing) || starting !== null || pairingFirst;
    renderState();
}
async function startPairing(device) {
    showError(null);
    pairing.set(device, { device, state: "connecting" });
    render();
    try {
        await tvpipe.pair(device);
    }
    catch (err) {
        pairing.set(device, { device, state: "failed", error: err.message });
        pairEnded(device, false);
        render();
    }
}
/** Set while Start pairs the chosen TVs. */
let pairingFirst = false;
/** Start waits for these pairings: called with whether the TV paired. */
const pairWaits = new Map();
function pairEnded(device, paired) {
    const w = pairWaits.get(device);
    pairWaits.delete(device);
    w?.(paired);
}
/**
 * Pairs the chosen AirPlay TVs that show a PIN and are not paired yet,
 * one after another (the PIN dialog for each); false when one was not
 * paired (cancelled or failed: its status says why).
 */
async function pairChosen(names) {
    for (const name of names) {
        const d = devices.find((x) => x.name === name);
        if (!d?.needsPairing || pairing.get(name)?.state === "done")
            continue;
        const paired = new Promise((resolve) => pairWaits.set(name, resolve));
        void startPairing(name);
        if (!(await paired))
            return false;
    }
    return true;
}
function openPin(device, error) {
    pinFor = device;
    $("pin-device").textContent = device;
    const e = $("pin-error");
    e.hidden = !error;
    e.textContent = error ?? "";
    $("pin-input").value = "";
    const dlg = $("pin");
    if (!dlg.open)
        dlg.showModal();
    $("pin-input").focus();
}
function closePin() {
    pinFor = null;
    const dlg = $("pin");
    if (dlg.open)
        dlg.close();
}
/** The resolution buttons (none when the game's size is fixed). */
function renderResolution() {
    const box = $("res");
    const choices = info?.resolutions ?? [];
    box.hidden = choices.length === 0 || resolution === null;
    if (box.hidden)
        return;
    $("res-options").replaceChildren(...choices.map((r) => {
        const b = el("button", "", RESOLUTION_LABEL[r] ?? r);
        b.type = "button";
        b.setAttribute("role", "radio");
        b.setAttribute("aria-checked", String(r === resolution));
        b.onclick = () => {
            resolution = r;
            renderResolution();
        };
        return b;
    }));
    $("res-note").textContent = (resolution && RESOLUTION_NOTE[resolution]) ?? "";
}
/** The cast picker's answer to the page it is in (`null`: cancelled). */
function answer(selection) {
    if (window.parent !== window) {
        window.parent.postMessage({ type: PICKER_MESSAGE, selection }, location.origin);
        return;
    }
    // Opened by itself: nothing to tell.
    starting = selection ? "Saved" : null;
    render();
}
async function start(devicesToUse) {
    showError(null);
    // A TV that needs pairing is paired first, then the game starts on it.
    pairingFirst = true;
    render();
    const paired = await pairChosen(devicesToUse);
    pairingFirst = false;
    render();
    if (!paired)
        return;
    if (changing) {
        try {
            answer(await tvpipe.select(devicesToUse, { resolution: resolution ?? undefined }));
        }
        catch (err) {
            showError(err.message);
        }
        return;
    }
    starting = devicesToUse.some((d) => d !== "browser") ? "Casting…" : "Starting…";
    render();
    try {
        await tvpipe.select(devicesToUse, { resolution: resolution ?? undefined });
        await tvpipe.watchDevices(false);
        location.assign(info.pages.host);
    }
    catch (err) {
        starting = null;
        render();
        showError(err.message);
    }
}
let sync = null;
/** The latest status of the sync page's cast. */
let syncCast = null;
/** In the cast picker: a sync replaced the game's picture, which must come back. */
let recast = false;
let flasher;
function syncTv() {
    const s = syncCast;
    if (!s || !sync)
        return { ready: false };
    if (s.state === "failed")
        return { ready: false, error: s.error ?? "The TV did not start the picture" };
    if (s.state === "stopped")
        return { ready: false, error: "The picture on the TV stopped" };
    const r = (s.receivers ?? []).find((x) => x.name === sync.device);
    if (r && (r.state === "failed" || r.state === "gave-up"))
        return { ready: false, error: r.error ?? "The TV refused the picture" };
    const up = s.state === "streaming" && r && (r.state === "connected" || r.state === "reconnected") && typeof r.delayMs === "number";
    return up ? { ready: true, delayMs: r.delayMs } : { ready: false };
}
function openSync(device) {
    showError(null);
    sync = { device };
    syncCast = null;
    if (changing)
        recast = true;
    tvpipe.cast({ page: TVSYNC_PAGE, to: [device] }).then((st) => {
        syncCast ??= st;
        renderSync();
    }, (err) => {
        syncCast = { state: "failed", error: err.message };
        renderSync();
    });
    $("sync-device").textContent = device;
    const dlg = $("sync");
    if (!dlg.open)
        dlg.showModal();
    renderSync();
}
function closeSync() {
    flasher?.stop();
    const was = sync;
    sync = null;
    const dlg = $("sync");
    if (dlg.open)
        dlg.close();
    // Before the game the TV goes dark again; in the picker the game's
    // picture comes back when the picker answers.
    if (was && !changing)
        void tvpipe.stopCast().catch(() => { });
}
/** Moves this screen's flashes (ms behind the clock, as far as the TV is). */
function setLag(ms) {
    if (!sync || sync.lag === undefined)
        return;
    sync.lag = Math.max(0, Math.min(MAX_LAG_MS, Math.round(ms)));
    renderSync();
}
function renderSync(error) {
    if (!sync)
        return;
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
    if (ready)
        flasher.start();
    else
        flasher.stop();
    const err = $("sync-error");
    err.hidden = !(error ?? tv.error);
    err.textContent = error ?? tv.error ?? "";
    $("sync-text").textContent = ready
        ? `Watch ${s.device} and this screen together and move the slider until both flash at the same moment with the same number. This one first: move right. The TV first: move left. (Arrow keys, Shift for bigger steps.)`
        : tv.error
            ? `The flashes could not start on ${s.device}.`
            : `Starting the flashes on ${s.device}…`;
    const range = $("sync-lag");
    range.max = String(MAX_LAG_MS);
    range.value = String(s.lag ?? 0);
    for (const id of ["sync-lag", "sync-less", "sync-more", "sync-go"])
        $(id).disabled = !ready;
    const value = $("sync-value");
    if (ready) {
        const delay = s.delayMs ?? 0;
        const own = displayLag(s.lag, delay);
        value.replaceChildren("The TV is ", el("b", "", `${s.lag} ms`), s.lag < delay
            ? ` behind this screen, less than the ${delay} ms the picture waits to stay smooth: it counts as ${delay} ms.`
            : ` behind this screen: ${delay} ms the picture waits to stay smooth, ${own} ms the TV itself.`);
    }
    else
        value.textContent = "";
    $("sync-forget").hidden = typeof known !== "number";
}
function setupSync() {
    const dlg = $("sync");
    const range = $("sync-lag");
    range.addEventListener("input", () => setLag(Number(range.value)));
    $("sync-less").onclick = () => setLag((sync?.lag ?? 0) - 10);
    $("sync-more").onclick = () => setLag((sync?.lag ?? 0) + 10);
    $("sync-go").onclick = () => {
        if (!sync || sync.lag === undefined)
            return;
        tvpipe.setDisplayLag(sync.device, displayLag(sync.lag, sync.delayMs ?? 0)).then(closeSync, (err) => renderSync(err.message));
    };
    $("sync-forget").onclick = () => {
        if (!sync)
            return;
        tvpipe.setDisplayLag(sync.device, null).then(closeSync, (err) => renderSync(err.message));
    };
    $("sync-close").onclick = closeSync;
    dlg.addEventListener("cancel", (ev) => {
        ev.preventDefault();
        closeSync();
    });
    dlg.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight")
            return;
        if (!sync || sync.lag === undefined)
            return;
        ev.preventDefault();
        const step = (ev.shiftKey ? 50 : 10) * (ev.key === "ArrowLeft" ? -1 : 1);
        setLag(sync.lag + step);
    });
    tvpipe.on("cast", (st) => {
        if (!sync)
            return;
        syncCast = st;
        renderSync();
    });
}
/** The cast picker's answer when cancelled: the old choice again if a sync took the TV. */
async function cancelPicker() {
    if (!recast)
        return answer(null);
    try {
        answer(await tvpipe.chosen());
    }
    catch {
        answer(null);
    }
}
/** The light/dark/system switch, shared with tvpipe's other pages. */
function themes() {
    const buttons = document.querySelectorAll(".theme button");
    const set = (t) => {
        document.documentElement.dataset["theme"] = t;
        try {
            localStorage.setItem("tvpipe-theme", t);
        }
        catch {
            // No storage: the choice lasts for this page.
        }
        buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset["t"] === t)));
    };
    set(document.documentElement.dataset["theme"] ?? "auto");
    buttons.forEach((b) => (b.onclick = () => set(b.dataset["t"] ?? "auto")));
}
async function main() {
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
    }
    catch (err) {
        stopped = "Not connected";
        $("title").textContent = "Open the link tvpipe printed";
        $("message").textContent = "This page talks to tvpipe through the link it printed (or the window it opened).";
        showError(`${err.message}.`);
        return;
    }
    info = await tvpipe.info();
    document.title = `${info.title} · tvpipe`;
    $("game").textContent = info.title;
    $("game").title = info.title;
    const { min, max } = info.players;
    $("players").textContent = min === max ? `${min}` : `${min}–${max}`;
    if (!changing)
        $("message").textContent = `${info.title} shows on the TVs you pick. Everyone plays on their own phone.`;
    const chosen = await tvpipe.chosen();
    for (const name of chosen.devices)
        selected.add(name);
    resolution = chosen.resolution;
    renderResolution();
    tvpipe.on("devices", (list) => {
        devices = list;
        render();
    });
    tvpipe.on("pair", (p) => {
        pairing.set(p.device, p);
        if (p.state === "pin")
            openPin(p.device);
        else if (pinFor === p.device && p.state !== "connecting")
            closePin();
        if (p.state === "done")
            selected.add(p.device);
        if (p.state === "done" || p.state === "failed")
            pairEnded(p.device, p.state === "done");
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
    // The games list (a tvpipe that has one gives the room).
    $("other-game").hidden = changing || !info.room;
    $("other-game").onclick = () => location.assign(GAME_PICKER);
    $("no-tv").onclick = () => (changing ? void cancelPicker() : void start([]));
    if (changing) {
        addEventListener("keydown", (ev) => {
            if (ev.key === "Escape" && !$("pin").open && !$("sync").open)
                void cancelPicker();
        });
    }
    $("pin-form").onsubmit = (ev) => {
        ev.preventDefault();
        const pin = $("pin-input").value.trim();
        if (!pinFor || !/^\d{4,8}$/.test(pin)) {
            const e = $("pin-error");
            e.hidden = false;
            e.textContent = "The code is the digits the TV shows.";
            return;
        }
        tvpipe.pairPin(pinFor, pin).catch((err) => openPin(pinFor ?? "", err.message));
    };
    $("pin-cancel").onclick = () => {
        if (pinFor)
            void tvpipe.pairCancel(pinFor);
        if (pinFor)
            pairing.delete(pinFor);
        if (pinFor)
            pairEnded(pinFor, false);
        closePin();
        render();
    };
}
void main();
