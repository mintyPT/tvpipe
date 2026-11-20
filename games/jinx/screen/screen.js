// @ts-check
/**
 * Jinx's TV page: tvpipe casts it with its own browser (with sound), or
 * anyone opens the watch link (the host page's preview, `#mute=1`). It
 * draws `view.screen` (a ScreenView, see ../game/views.ts) and `view.join`
 * (the room code, link and QR code).
 */

import { PartyClient, qrSvg } from "/_tvpipe/lib/client.js";
import { createTv } from "./app.js";
import { t } from "./strings.js";

const hash = new URLSearchParams(location.hash.slice(1));
const client = PartyClient.fromLocation({ role: /** @type {any} */ (hash.get("role") ?? "screen") });
const root = /** @type {HTMLElement} */ (document.getElementById("viewport"));
const status = /** @type {HTMLElement} */ (document.getElementById("status"));

const tv = createTv({ root, now: () => client.now(), qrSvg, muted: hash.get("mute") === "1" });

/** @type {Record<string, any> | null} */
let pending = null;
let ready = false;
client.on("view", (view) => {
  if (ready) tv.update(view);
  else pending = view;
});
client.on("status", (s) => {
  status.hidden = s === "open" || s === "idle" || s === "connecting";
  status.textContent = s === "reconnecting" ? t.reconnecting : s === "closed" ? t.over : "";
  // A view after a reconnect is drawn as it is, without replaying.
  if (s === "reconnecting") tv.cold();
});
// The fonts first: the cards' words are fitted to their width.
document.fonts.ready.then(() => {
  ready = true;
  if (pending) tv.update(pending);
  pending = null;
});
client.connect().catch((/** @type {any} */ e) => {
  status.hidden = false;
  status.textContent = e?.message ?? String(e);
});
