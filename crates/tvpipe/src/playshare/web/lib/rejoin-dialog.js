/**
 * The host page's rejoin dialog ({@link HostedParty.showRejoin}): a
 * player's own rejoin code (the join link with their resume token) as a
 * QR code and a link to copy, for a phone that lost its way back (another
 * browser, a new phone). It closes by itself when the player is back.
 */
import { qrSvg } from "./client.js";
const STRINGS = {
    en: {
        title: (n) => `Bring ${n} back`,
        body: (n) => `Scan this with ${n}'s phone to bring them back with their score. Only show it to ${n}.`,
        or: "Or scan the code on the TV and enter the same name.",
        copy: "Copy link",
        copied: "Copied",
        close: "Close",
        back: (n) => `${n} is back.`,
    },
    de: {
        title: (n) => `${n} zurückholen`,
        body: (n) => `Mit ${n}s Handy scannen: zurück im Spiel, mit allen Punkten. Nur ${n} zeigen.`,
        or: "Oder den Code am Fernseher scannen und denselben Namen eingeben.",
        copy: "Link kopieren",
        copied: "Kopiert",
        close: "Schließen",
        back: (n) => `${n} ist zurück.`,
    },
};
const CSS = `
.box { min-width: 320px; box-sizing: border-box; font: 15px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #15161c; display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 26px 28px 22px; text-align: center; }
h2 { margin: 0; font-size: 21px; }
p { margin: 0; color: #4b4d58; max-width: 320px; }
.qr { width: 260px; height: 260px; border-radius: 14px; overflow: hidden; box-shadow: 0 0 0 1px #e3e4ea; }
.qr svg { display: block; width: 100%; height: 100%; }
.back { font-size: 18px; font-weight: 700; color: #1d7a3c; padding: 40px 0; }
.row { display: flex; gap: 10px; margin-top: 4px; }
button { font: inherit; font-weight: 600; border-radius: 9px; padding: 8px 16px; border: 1px solid #c9cbd4; background: #fff; color: #15161c; cursor: pointer; }
button.primary { background: #15161c; color: #fff; border-color: #15161c; }
`;
/** Shows the dialog; resolves when it closes (`true` when the player came back meanwhile). */
export function showRejoinDialog(party, player, link, qr) {
    const doc = globalThis.document;
    const lang = (doc.documentElement.lang || "en").slice(0, 2).toLowerCase();
    const t = STRINGS[lang] ?? STRINGS["en"];
    return new Promise((resolve) => {
        const dialog = doc.createElement("dialog");
        dialog.className = "tvpipe-rejoin";
        dialog.style.cssText = "padding:0;border:0;border-radius:16px;background:#fff;box-shadow:0 20px 60px rgb(0 0 0 / 40%);max-width:94vw";
        const root = doc.createElement("div").attachShadow({ mode: "open" });
        const host = root.host;
        const style = doc.createElement("style");
        style.textContent = CSS;
        const box = doc.createElement("div");
        box.className = "box";
        const h = (tag, cls, text) => {
            const e = doc.createElement(tag);
            if (cls)
                e.className = cls;
            if (text !== undefined)
                e.textContent = text;
            return e;
        };
        const title = h("h2", "", t.title(player.name));
        const code = h("div", "qr");
        code.innerHTML = qrSvg(qr, { quiet: 3 });
        const copy = h("button", "", t.copy);
        copy.onclick = () => {
            void globalThis.navigator?.clipboard?.writeText(link).then(() => (copy.textContent = t.copied), () => { });
        };
        const close = h("button", "primary", t.close);
        close.autofocus = true;
        const row = h("div", "row");
        row.append(copy, close);
        box.append(title, ...(qr ? [code] : []), h("p", "", t.body(player.name)), h("p", "", t.or), row);
        root.append(style, box);
        dialog.append(host);
        let back = false;
        const done = () => {
            party.off("reconnect", onBack);
            party.off("leave", onLeave);
            if (dialog.open)
                dialog.close();
            dialog.remove();
            resolve(back);
        };
        const onBack = (p) => {
            if (p !== player)
                return;
            back = true;
            box.replaceChildren(title, h("div", "back", t.back(player.name)));
            setTimeout(done, 1500);
        };
        const onLeave = (p) => {
            if (p === player)
                done();
        };
        party.on("reconnect", onBack);
        party.on("leave", onLeave);
        close.onclick = done;
        dialog.addEventListener("cancel", (ev) => {
            ev.preventDefault();
            done();
        });
        doc.body.append(dialog);
        dialog.showModal();
    });
}
