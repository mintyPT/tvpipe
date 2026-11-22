/**
 * Emoji: games take none as input (names, answers, clues). The host
 * removes them from what phones send ({@link stripEmoji}, part of
 * `cleanText`); phones remove them as they are typed ({@link blockEmoji}).
 *
 * An emoji is a character shown as emoji by default (`Emoji_Presentation`),
 * any pictograph from U+1F000 on (most render as emoji on phones even
 * without a variation selector), any pictograph asked to be one (U+FE0F),
 * a flag (regional indicators, tag sequences), a keycap (`1️⃣`), with its
 * skin tones and ZWJ sequences. Text symbols stay: `©`, `™`, `♥`, `→`.
 */
const PICTURE = String.raw `(?:(?=\p{Extended_Pictographic})[\u{1F000}-\u{1FAFF}]|\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[#*0-9]\uFE0F?\u20E3)`;
const TAIL = String.raw `[\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F\u20E3\u{E0020}-\u{E007F}]`;
const EMOJI = new RegExp(String.raw `${PICTURE}${TAIL}*(?:\u200D(?:${PICTURE}|\p{Extended_Pictographic})${TAIL}*)*|[\uFE0F\u20E3\u{E0020}-\u{E007F}]`, "gu");
/** `s` without emoji (and without stray emoji selectors, keycaps and tags). */
export function stripEmoji(s) {
    return s.replace(EMOJI, "");
}
/** Whether `s` has an emoji. */
export function hasEmoji(s) {
    EMOJI.lastIndex = 0;
    const found = EMOJI.test(s);
    EMOJI.lastIndex = 0;
    return found;
}
/**
 * Removes emoji from every text field below `root` (the page by default)
 * as they are typed or pasted, keeping the caret where it was. Returns
 * the function that stops it. Range, number and other non-text inputs
 * are left alone; a field is cleaned once an IME composition ends.
 */
export function blockEmoji(root = globalThis.document) {
    if (!root)
        return () => { };
    const listener = (e) => {
        if (e.isComposing)
            return;
        const el = e.target;
        if (!el || typeof el.value !== "string")
            return;
        const tag = el.tagName?.toUpperCase();
        if (tag !== "TEXTAREA" && !(tag === "INPUT" && TEXT_TYPES.has((el.type ?? "text").toLowerCase())))
            return;
        if (!hasEmoji(el.value))
            return;
        const caret = el.selectionStart ?? el.value.length;
        const before = stripEmoji(el.value.slice(0, caret));
        el.value = before + stripEmoji(el.value.slice(caret));
        try {
            el.setSelectionRange(before.length, before.length);
        }
        catch { }
    };
    // Capture: before the page's own input handlers see the emoji.
    root.addEventListener("input", listener, true);
    root.addEventListener("compositionend", listener, true);
    return () => {
        root.removeEventListener("input", listener, true);
        root.removeEventListener("compositionend", listener, true);
    };
}
const TEXT_TYPES = new Set(["text", "search", "url", "email", "tel", "password", ""]);
