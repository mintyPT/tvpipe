/**
 * The pairing dialog ({@link Tvpipe.showPairing}): an AirPlay TV that
 * wants a PIN shows one, people type it here (`pair.start`, `pair` events,
 * `pair.pin`). A wrong code or a pairing that failed offers another try
 * (the TV shows a new code).
 */

import type { PairStatus, Tvpipe } from "./tvpipe.ts";

interface Strings {
  title: (device: string) => string;
  body: (device: string) => string;
  connecting: (device: string) => string;
  pin: (device: string) => string;
  done: (device: string) => string;
  failed: string;
  digits: string;
  pair: string;
  again: string;
  cancel: string;
  label: string;
}

const STRINGS: Record<string, Strings> = {
  en: {
    title: (d) => `Pair with ${d}`,
    body: (d) => `${d} needs pairing once before it shows the game. tvpipe keeps the pairing.`,
    connecting: (d) => `Asking ${d} for a code…`,
    pin: (d) => `Type the code ${d} shows.`,
    done: (d) => `Paired with ${d}.`,
    failed: "Pairing failed",
    digits: "The code is the digits the TV shows.",
    pair: "Pair",
    again: "Try again",
    cancel: "Cancel",
    label: "Code",
  },
  de: {
    title: (d) => `Mit ${d} koppeln`,
    body: (d) => `${d} muss einmal gekoppelt werden, bevor es das Spiel zeigt. tvpipe merkt sich die Kopplung.`,
    connecting: (d) => `${d} wird nach einem Code gefragt…`,
    pin: (d) => `Den Code eingeben, den ${d} zeigt.`,
    done: (d) => `Mit ${d} gekoppelt.`,
    failed: "Koppeln fehlgeschlagen",
    digits: "Der Code sind die Ziffern auf dem Fernseher.",
    pair: "Koppeln",
    again: "Nochmal",
    cancel: "Abbrechen",
    label: "Code",
  },
};

const CSS = `
form { width: 360px; max-width: 100%; box-sizing: border-box; font: 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #15161c; display: flex; flex-direction: column; gap: 12px; padding: 24px 26px 20px; margin: 0; }
h2 { margin: 0; font-size: 21px; }
p { margin: 0; color: #4b4d58; }
.state.done { color: #1d7a3c; font-weight: 600; }
.error { color: #b42318; }
input { font: inherit; font-size: 28px; letter-spacing: 0.3em; text-align: center; padding: 8px 10px; border: 1px solid #c9cbd4; border-radius: 9px; font-variant-numeric: tabular-nums; }
input:disabled { background: #f3f4f7; }
.row { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
button { font: inherit; font-weight: 600; border-radius: 9px; padding: 8px 16px; border: 1px solid #c9cbd4; background: #fff; color: #15161c; cursor: pointer; }
button.primary { background: #15161c; color: #fff; border-color: #15161c; }
button:disabled { opacity: 0.5; cursor: default; }
`;

/** Shows the dialog and pairs; resolves `true` once paired, `false` when cancelled. */
export function showPairDialog(tvpipe: Tvpipe, device: string): Promise<boolean> {
  const doc = globalThis.document;
  const lang = (doc.documentElement.lang || "en").slice(0, 2).toLowerCase();
  const t = STRINGS[lang] ?? STRINGS["en"]!;
  return new Promise((resolve) => {
    const dialog = doc.createElement("dialog");
    dialog.className = "tvpipe-pair";
    dialog.style.cssText = "padding:0;border:0;border-radius:16px;background:#fff;box-shadow:0 20px 60px rgb(0 0 0 / 40%);max-width:94vw";
    const root = doc.createElement("div").attachShadow({ mode: "open" });
    const host = root.host as HTMLElement;
    const style = doc.createElement("style");
    style.textContent = CSS;
    const h = <T extends HTMLElement>(tag: string, cls: string, text?: string) => {
      const e = doc.createElement(tag) as T;
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const form = h<HTMLFormElement>("form", "");
    const state = h("p", "state");
    const error = h("p", "error");
    const input = h<HTMLInputElement>("input", "");
    input.inputMode = "numeric";
    input.autocomplete = "one-time-code";
    input.maxLength = 8;
    input.setAttribute("aria-label", t.label);
    const ok = h<HTMLButtonElement>("button", "primary", t.pair);
    ok.type = "submit";
    const cancel = h<HTMLButtonElement>("button", "", t.cancel);
    cancel.type = "button";
    const row = h("div", "row");
    row.append(cancel, ok);
    form.append(h("h2", "", t.title(device)), h("p", "", t.body(device)), state, input, error, row);
    root.append(style, form);
    dialog.append(host);

    let step: PairStatus["state"] = "connecting";
    let finished = false;
    const show = (s: PairStatus["state"], err?: string) => {
      step = s;
      state.className = `state ${s}`;
      state.textContent = s === "pin" ? t.pin(device) : s === "done" ? t.done(device) : s === "failed" ? t.failed : t.connecting(device);
      error.hidden = !err;
      error.textContent = err ?? "";
      input.disabled = s !== "pin";
      input.hidden = s === "done" || s === "failed";
      ok.disabled = s === "connecting" || s === "done";
      ok.textContent = s === "failed" ? t.again : t.pair;
      if (s === "pin") {
        input.value = "";
        input.focus();
      }
    };
    const finish = (paired: boolean) => {
      if (finished) return;
      finished = true;
      off();
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(paired);
    };
    const start = () => {
      show("connecting");
      tvpipe.pair(device).catch((err) => show("failed", (err as Error).message));
    };
    const off = tvpipe.on("pair", (p) => {
      if (p.device !== device || finished) return;
      show(p.state, p.state === "failed" ? p.error : undefined);
      if (p.state === "done") setTimeout(() => finish(true), 700);
    });
    form.onsubmit = (ev) => {
      ev.preventDefault();
      if (step === "failed") return start();
      if (step !== "pin") return;
      const pin = input.value.trim();
      if (!/^\d{4,8}$/.test(pin)) {
        error.hidden = false;
        error.textContent = t.digits;
        return;
      }
      ok.disabled = true;
      tvpipe.pairPin(device, pin).catch((err) => {
        ok.disabled = false;
        error.hidden = false;
        error.textContent = (err as Error).message;
      });
    };
    const quit = () => {
      if (step !== "done" && step !== "failed") void tvpipe.pairCancel(device).catch(() => {});
      finish(step === "done");
    };
    cancel.onclick = quit;
    dialog.addEventListener("cancel", (ev) => {
      ev.preventDefault();
      quit();
    });
    doc.body.append(dialog);
    dialog.showModal();
    start();
  });
}
