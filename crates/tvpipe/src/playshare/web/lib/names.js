/** Player names and other short texts from phones: normalised, bounded, no emoji. */
import { stripEmoji } from "./emoji.js";
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/**
 * Control characters (C0, C1), bidi overrides and isolates, zero-width
 * characters other than ZWJ (some scripts need it), the BOM, line and
 * paragraph separators, and private-use characters.
 */
const STRIP = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\u2028\u2029\ue000-\uf8ff]/gu;
/** Number of user-perceived characters. */
export function graphemes(s) {
    let n = 0;
    for (const _ of segmenter.segment(s))
        n++;
    return n;
}
/** The first `max` user-perceived characters. */
export function truncateGraphemes(s, max) {
    let out = "";
    let n = 0;
    for (const { segment } of segmenter.segment(s)) {
        if (n++ >= max)
            break;
        out += segment;
    }
    return out;
}
/**
 * Untrusted text cleaned up for display: NFC, emoji ({@link stripEmoji}),
 * invisible and control characters removed, whitespace runs collapsed to one space, trimmed,
 * at most `max` characters (graphemes). Not an HTML escape: render it as
 * text.
 */
export function cleanText(input, max) {
    if (typeof input !== "string")
        return "";
    const s = stripEmoji(input.normalize("NFC")).replace(/\s+/gu, " ").replace(STRIP, "").replace(/ {2,}/g, " ").trim();
    return truncateGraphemes(s, max).trim();
}
/** How names compare for uniqueness: case- and accent-insensitive. */
export function nameKey(name) {
    return name
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLocaleLowerCase("en")
        .replace(/\s+/gu, "");
}
export const MAX_NAME = 16;
