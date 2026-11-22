/**
 * The frame page (`tvpipe.party/p`, docs/short-links.md): phones open
 * the tunnel's join link inside a page of tvpipe.party, so their address
 * bar, history and Screen Time show tvpipe.party instead of a new tunnel
 * name every game.
 *
 * - {@link frameLink} (the host): the frame page's link for a join link,
 *   which the QR code carries.
 * - {@link announceToFrame} (a phone page in that frame): tells the frame
 *   page the game's title and colour, for the tab and the browser's bars.
 */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** Join links the frame page takes (the service's patterns, docs/short-links.md). */
const JOIN = new RegExp(`^https://(?:(${LABEL})\\.trycloudflare\\.com|(${LABEL}\\.${LABEL})\\.opentunnel\\.xyz)/\\?r=([A-Z]{4,8})#k=([A-Za-z0-9_-]{16,64})$`);
/** The message a framed page sends its frame page. */
export const FRAME_MESSAGE = "tvpipe-frame";
/**
 * The frame page's link for the join link `url`
 * (`https://tvpipe.party/p#c=LABEL&r=ROOM&k=KEY`, `…#o=ROUTE.ID&…`),
 * or `null` when there is no frame page (`page` unset: tvpipe's short
 * links are off) or `url` is not a Cloudflare or OpenTunnel join link
 * (the LAN, a self-hosted OpenTunnel): then phones open `url` itself.
 */
export function frameLink(page, url) {
    if (typeof page !== "string" || !/^https?:\/\/[^/?#\s]+\/[A-Za-z0-9_/-]*$/.test(page))
        return null;
    const m = JOIN.exec(url);
    if (!m)
        return null;
    const host = m[1] !== undefined ? `c=${m[1]}` : `o=${m[2]}`;
    return `${page}#${host}&r=${m[3]}&k=${m[4]}`;
}
let announcing = false;
/**
 * In a page another site frames (the frame page; same-origin frames such
 * as the host page's previews are left alone): sends the frame page the
 * page's title and its `theme-color` (else the body's background) now
 * and whenever they change. Harmless anywhere else; once per page.
 */
export function announceToFrame() {
    const g = globalThis;
    const w = g.window;
    const doc = g.document;
    if (announcing || !w || !doc || w.parent === w)
        return;
    try {
        // Readable: the same origin, not the frame page.
        void w.parent.location.href;
        return;
    }
    catch { }
    announcing = true;
    let last = "";
    const send = () => {
        const meta = doc.querySelector('meta[name="theme-color"]');
        let theme = meta?.getAttribute("content") ?? "";
        if (!theme && doc.body)
            theme = g.getComputedStyle?.(doc.body)?.backgroundColor ?? "";
        const msg = { type: FRAME_MESSAGE, title: String(doc.title ?? ""), theme };
        const text = JSON.stringify(msg);
        if (text === last)
            return;
        last = text;
        try {
            // Nothing secret: any page that may frame this one (tvpipe sends
            // `frame-ancestors`) may know its title and colour.
            w.parent.postMessage(msg, "*");
        }
        catch { }
    };
    let pending = false;
    const soon = () => {
        if (pending)
            return;
        pending = true;
        setTimeout(() => {
            pending = false;
            send();
        }, 50);
    };
    send();
    w.addEventListener?.("load", soon);
    if (typeof g.MutationObserver === "function") {
        const watch = new g.MutationObserver(soon);
        watch.observe(doc.head ?? doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        watch.observe(doc.documentElement, { attributes: true });
    }
}
