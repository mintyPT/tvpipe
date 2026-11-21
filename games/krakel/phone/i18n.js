// @ts-check
/**
 * Languages for Krakel's phone and TV pages: which language, numbers the
 * way it writes them. The room's language comes with the views
 * (`room.lang`, `screen.lang`); the host page sets it.
 */

/** @typedef {"en" | "de"} Lang */

export const LANGS = /** @type {const} */ (["en", "de"]);

/**
 * A language tag (`de-AT`, `en`, …): German for `de…`, else English.
 * @param {unknown} tag
 * @returns {Lang}
 */
export function pickLang(tag) {
  return typeof tag === "string" && /^de\b/i.test(tag) ? "de" : "en";
}

/** The browser's language. */
export function browserLang() {
  return pickLang(globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language);
}

/**
 * @param {Lang} lang
 * @param {number} n
 */
export function num(lang, n) {
  return new Intl.NumberFormat(lang).format(n);
}
