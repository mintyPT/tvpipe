/**
 * The phones' page while tvpipe has no game yet (docs/game-switching.md):
 * `/` sends them here with the join link's query and fragment, and this
 * page goes back to `/` (now the game's phone page) once there is one.
 */
const TEXTS = {
    en: { state: "Waiting", title: "The game is being picked", text: "This page goes on by itself as soon as it starts." },
    de: { state: "Warten", title: "Das Spiel wird ausgesucht", text: "Diese Seite geht von selbst weiter, sobald es losgeht." },
};
const lang = navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
const t = TEXTS[lang];
document.documentElement.lang = lang;
for (const id of ["state", "title", "text"]) {
    const e = document.getElementById(id);
    if (e)
        e.textContent = t[id];
}
async function poll() {
    for (;;) {
        try {
            const r = await fetch("/_tvpipe/game", { cache: "no-store" });
            if (r.ok && (await r.json()).game) {
                location.replace(`/${location.search}${location.hash}`);
                return;
            }
        }
        catch {
            // tvpipe or the link is away for a moment: ask again.
        }
        await new Promise((ok) => setTimeout(ok, 1500));
    }
}
void poll();
export {};
