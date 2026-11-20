// @ts-check
/**
 * DOM helpers for the TV: element builders, the Web Animations wrapper, the
 * easing vocabulary and text fitting. The stage is a 1280×720 layout; every
 * position in the scenes is in stage pixels.
 */

/**
 * @typedef {Record<string, string | number | boolean | null | undefined>} Attrs
 * @typedef {Node | string | number | null | undefined | false} Kid
 */

/**
 * An element: `class`, `style` (css text) and other attributes; `false`/`null` skip.
 * @param {string} tag
 * @param {Attrs | null} [attrs]
 * @param {...(Kid | Kid[])} kids
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs)
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = String(v);
      else if (k === "style") e.style.cssText = String(v);
      else e.setAttribute(k, String(v));
    }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(typeof k === "object" ? k : String(k));
  return e;
}

/**
 * An element with constant markup (drawings made here, never text from players).
 * @param {string} tag
 * @param {Attrs | null} attrs
 * @param {string} markup
 */
export function hm(tag, attrs, markup) {
  const e = h(tag, attrs);
  e.innerHTML = markup;
  return e;
}

/** Copy with `*bold*` segments as nodes. @param {string} s */
export function rich(s) {
  return s.split(/(\*[^*]+\*)/).filter(Boolean).map((p) => (p.startsWith("*") && p.endsWith("*") ? h("b", null, p.slice(1, -1)) : p));
}

export const SVGNS = "http://www.w3.org/2000/svg";
/**
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 * @returns {SVGElement}
 */
export function svg(tag, attrs = {}) {
  const e = /** @type {SVGElement} */ (document.createElementNS(SVGNS, tag));
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export const EASE = {
  out: "cubic-bezier(.2,.8,.2,1)",
  in: "cubic-bezier(.55,0,.9,.35)",
  back: "cubic-bezier(.3,1.6,.5,1)",
  inout: "cubic-bezier(.65,0,.35,1)",
  lin: "linear",
};

/**
 * Web Animations with `fill: both` (staggered entrances hold their first frame).
 * @param {Element} el
 * @param {Keyframe[]} frames
 * @param {number} dur
 * @param {KeyframeAnimationOptions} [opt]
 */
export function A(el, frames, dur, opt = {}) {
  return el.animate(frames, { duration: Math.max(1, dur), fill: "both", easing: EASE.out, ...opt });
}

/** @param {number} a @param {number} b */
export const rnd = (a, b) => a + Math.random() * (b - a);
/** @param {number} v @param {number} lo @param {number} hi */
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** @param {Element} el @param {number} ms */
export function removeLater(el, ms) {
  setTimeout(() => el.remove(), ms);
}

/** @param {HTMLElement} el @param {number} [ms] */
export function fadeOut(el, ms = 300) {
  A(el, [{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], ms);
  removeLater(el, ms + 20);
}

/**
 * Shrinks a one-line text until it fits `avail` px: from `max` down to
 * `min` px, then condensed with scaleX (never below `minScale`).
 * @param {HTMLElement} el must be in the document
 * @param {number} max
 * @param {number} min
 * @param {number} avail
 * @param {number} [minScale]
 */
export function fitText(el, max, min, avail, minScale = 0.74) {
  let s = max;
  el.style.fontSize = s + "px";
  el.style.transform = "";
  el.style.letterSpacing = "";
  while (el.scrollWidth > avail && s > min) {
    s = Math.max(min, s - 2);
    el.style.fontSize = s + "px";
  }
  if (el.scrollWidth > avail) el.style.letterSpacing = "0";
  if (el.scrollWidth > avail) el.style.transform = `scaleX(${Math.max(minScale, avail / el.scrollWidth)})`;
}

/**
 * A person's name for tabs and copy (players type anything: cut, no newlines).
 * @param {string | undefined} name
 * @param {number} [max]
 */
export function short(name, max = 14) {
  const n = String(name ?? "").replace(/\s+/g, " ").trim() || "?";
  const chars = [...n];
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : n;
}
