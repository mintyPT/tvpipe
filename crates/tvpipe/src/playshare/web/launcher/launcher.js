/**
 * tvpipe's standard launcher (docs/playshare-design.md §7): the TVs as
 * they are found, AirPlay PIN pairing, then the game's host page. A game
 * may bring its own launcher with the same API.
 */
import { displayLag, eventTime, Metronome, SKIP_TAPS, TAPS, tapRun } from "../lib/tapsync.js";
import { PICKER_MESSAGE, Tvpipe, TV_DISPLAY_MS, TV_RENDER_MS, TVSYNC_PAGE, } from "../lib/tvpipe.js";
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
        text.append(el("div", "name", browser ? (d.title ?? "A browser tab on this computer") : d.name), el("div", "meta", browser ? "Try the game without a TV: the TV picture plays in a tab" : (d.model ?? "")));
        const p = pairing.get(d.name);
        if (p) {
            const [t, c] = pairingText(p);
            text.append(el("div", `pairing ${c}`, t));
        }
        if (!browser && typeof d.displayMs === "number")
            text.append(el("div", "synced", `Synced with phones: ${d.displayMs} ms of its own`));
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
    $("start").disabled = (selected.size === 0 && !changing) || starting !== null;
    renderState();
}
function renderPhones() {
    const t = info.tunnel;
    const url = (u) => el("code", "", u);
    const parts = t.state === "starting"
        ? ["Opening the public link for phones…"]
        : t.state === "up" && t.url
            ? ["Phones join through ", url(t.url), ", on any network."]
            : info.phone.mode === "lan"
                ? ["Phones on this Wi-Fi join at ", url(info.phone.lan ?? info.phone.url), "."]
                : t.state === "failed"
                    ? [el("span", "bad", `No public link for phones (${t.error ?? "the tunnel failed"}).`), " Phones on this computer only."]
                    : ["Phones on this computer only: no public link (", url("--no-tunnel"), ")."];
    $("phones").replaceChildren(...parts);
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
        render();
    }
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
let audio;
let metronome;
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
    sync = { device, step: "intro", taps: [] };
    syncCast = null;
    if (changing)
        recast = true;
    // The TV starts its picture while people tap here (it takes seconds).
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
    metronome?.stop();
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
function syncTap(t) {
    if (!sync || (sync.step !== "here" && sync.step !== "tv"))
        return;
    sync.taps.push(t);
    const pad = $("sync-pad");
    pad.classList.remove("tapped");
    void pad.offsetWidth;
    pad.classList.add("tapped");
    if (sync.taps.length < SKIP_TAPS + TAPS)
        return renderSync();
    if (sync.step === "here") {
        const run = tapRun(sync.taps, 0);
        sync.taps = [];
        if (!run.ok)
            return renderSync(uneven(run));
        sync.here = run;
        metronome?.stop();
        sync.step = syncTv().ready ? "tv" : "wait";
        return renderSync();
    }
    const delayMs = sync.delayMs ?? 0;
    const known = devices.find((d) => d.name === sync.device)?.displayMs;
    const run = tapRun(sync.taps, delayMs + (known ?? TV_RENDER_MS + TV_DISPLAY_MS));
    sync.taps = [];
    if (!run.ok)
        return renderSync(uneven(run));
    sync.result = displayLag(sync.here, run, delayMs);
    sync.step = "result";
    renderSync();
}
function uneven(run) {
    return `The taps were too uneven (±${Math.round(run.spread)} ms). Try once more, as steadily as you can.`;
}
function renderSync(error) {
    if (!sync)
        return;
    const s = sync;
    const tv = syncTv();
    if (s.step === "wait" && tv.ready)
        s.step = "tv";
    if (s.step === "tv" || s.step === "wait")
        s.delayMs = tv.delayMs ?? s.delayMs;
    const failed = tv.error && s.step !== "result" ? tv.error : undefined;
    const err = $("sync-error");
    err.hidden = !(error ?? failed);
    err.textContent = error ?? failed ?? "";
    const text = {
        intro: "Phones show the game at once, the TV a little later. Tap along with flashes twice to measure how much: first with the flashes here, then with the flashes on the TV. Tap the circle, or press the space bar.",
        here: "Tap along with the flashes here, on the beat.",
        wait: `Starting the flashes on ${s.device}…`,
        tv: `Now look at ${s.device} and tap along with its flashes (and clicks).`,
        result: "",
    };
    if (s.step === "result" && s.result) {
        const r = s.result;
        text.result = `${s.device} shows a picture ${r.total} ms after this screen: ${s.delayMs ?? 0} ms the picture waits to stay smooth, ${r.displayMs} ms the TV itself takes. Save it, and phones keep in step with this TV from now on.`;
    }
    $("sync-text").textContent = text[s.step];
    const counting = s.step === "here" || s.step === "tv";
    const n = Math.max(0, s.taps.length - SKIP_TAPS);
    const dots = $("sync-dots");
    dots.hidden = !counting;
    dots.replaceChildren(...Array.from({ length: TAPS }, (_, i) => el("span", i < n ? "on" : "")));
    const pad = $("sync-pad");
    pad.disabled = !counting;
    pad.dataset["step"] = s.step;
    const go = $("sync-go");
    go.hidden = !(s.step === "intro" || s.step === "result");
    go.textContent = s.step === "result" ? "Save" : "Start";
    $("sync-again").hidden = s.step !== "result";
    const known = devices.find((d) => d.name === s.device)?.displayMs;
    $("sync-forget").hidden = typeof known !== "number" || s.step === "result";
}
function setupSync() {
    const dlg = $("sync");
    $("sync-go").onclick = () => {
        if (!sync)
            return;
        if (sync.step === "intro") {
            // A click: sound may start now.
            try {
                audio ??= new AudioContext();
            }
            catch {
                audio = undefined;
            }
            metronome ??= new Metronome($("sync-beat"), { audio });
            metronome.start();
            sync.step = "here";
            sync.taps = [];
            $("sync-pad").focus();
            return renderSync();
        }
        if (sync.step === "result" && sync.result) {
            const { device } = sync;
            const ms = sync.result.displayMs;
            tvpipe.setDisplayLag(device, ms).then(closeSync, (err) => renderSync(err.message));
        }
    };
    $("sync-again").onclick = () => {
        if (!sync)
            return;
        sync.step = syncTv().ready ? "tv" : "wait";
        sync.taps = [];
        renderSync();
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
    $("sync-pad").addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        syncTap(eventTime(ev));
    });
    dlg.addEventListener("keydown", (ev) => {
        if (ev.key !== " " && ev.key !== "Enter")
            return;
        if (!sync || (sync.step !== "here" && sync.step !== "tv"))
            return;
        ev.preventDefault();
        if (!ev.repeat)
            syncTap(eventTime(ev));
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
    $("message").textContent = `${info.title} shows on the TVs you pick. Everyone plays on their own phone.`;
    if (changing) {
        document.documentElement.dataset["mode"] = "change";
        $("title").textContent = "Change the TVs";
        $("message").textContent = "The TVs you pick show the game; they start the picture again.";
        $("start").textContent = "Apply";
        $("no-tv").textContent = "Cancel";
    }
    renderPhones();
    const chosen = await tvpipe.chosen();
    for (const name of chosen.devices)
        selected.add(name);
    resolution = chosen.resolution;
    renderResolution();
    tvpipe.on("devices", (list) => {
        devices = list;
        render();
    });
    tvpipe.on("tunnel", (t) => {
        info.tunnel = t;
        if (t.state === "up" && t.url)
            info.phone = { ...info.phone, url: t.url, mode: "tunnel" };
        renderPhones();
    });
    tvpipe.on("pair", (p) => {
        pairing.set(p.device, p);
        if (p.state === "pin")
            openPin(p.device);
        else if (pinFor === p.device && p.state !== "connecting")
            closePin();
        if (p.state === "done")
            selected.add(p.device);
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
        closePin();
        render();
    };
}
void main();
