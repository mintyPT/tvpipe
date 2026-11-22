/**
 * Layout checks run in the pages of Pinch's live checks (play.ts): what
 * overflows, overlaps or sits under tvpipe's join badge. Each is an
 * expression that returns a list of problems.
 */

/** The phone: nothing wider than the screen, the bars' parts and buttons clear of each other, no fitted word overflowing. */
export const PHONE_CHECK = `(() => {
    const bad = [];
    const W = innerWidth, H = innerHeight;
    const vis = (el) => el && !el.hidden && el.offsetParent !== null && getComputedStyle(el).visibility !== "hidden";
    const r = (el) => el.getBoundingClientRect();
    if (document.documentElement.scrollWidth > W + 1) bad.push("page wider than the screen: " + document.documentElement.scrollWidth);
    for (const el of document.querySelectorAll("[data-fit]")) {
      if (!vis(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1) bad.push("overflowing text: " + el.textContent);
    }
    for (const el of document.querySelectorAll("button, .slot, .clock, .rolebox, .holdbanner, .ticker, .hint")) {
      if (!vis(el)) continue;
      const b = r(el);
      if (b.width && (b.left < -1 || b.right > W + 1)) bad.push("off screen: " + el.className + " " + Math.round(b.left) + ".." + Math.round(b.right));
    }
    const heist = document.querySelector(".heist");
    if (heist) {
      const top = r(heist.querySelector(".hud-top")), bottom = r(heist.querySelector(".hud-bottom"));
      if (bottom.bottom > H + 1) bad.push("the bottom bar ends below the screen");
      const parts = [...heist.querySelectorAll(".hud-top > *")].filter(vis).map(r);
      for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i], b = parts[j];
        if (a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top && b.bottom > a.top) bad.push("top bar parts overlap " + i + "/" + j);
      }
      const bparts = [...heist.querySelectorAll(".hud-bottom > *, .hud-bottom .acts > *")].filter((e) => vis(e) && !e.classList.contains("acts")).map(r);
      for (let i = 0; i < bparts.length; i++) for (let j = i + 1; j < bparts.length; j++) {
        const a = bparts[i], b = bparts[j];
        if (a.right > b.left + 1 && b.right > a.left + 1 && a.bottom > b.top + 1 && b.bottom > a.top + 1) bad.push("bottom bar parts overlap " + i + "/" + j);
      }
      const big = heist.querySelector(".bigbtn");
      if (vis(big) && r(big).bottom > bottom.top) bad.push("big button over the bottom bar");
      const under = heist.querySelector(".under");
      for (const el of under.children) if (vis(el) && r(el).top < top.bottom) bad.push("under the top bar: " + el.className);
      for (const el of heist.querySelectorAll(".act, .tool")) if (vis(el) && r(el).height < 44) bad.push("small button: " + el.className);
    } else {
      for (const el of document.querySelectorAll("button")) if (vis(el) && r(el).height < 40) bad.push("small button: " + el.textContent);
      for (const el of document.querySelectorAll("#app *")) {
        if (!vis(el) || el.children.length) continue;
        const b = r(el);
        if (b.width && (b.right > W + 2 || b.left < -2)) bad.push("off the side: " + el.localName + "." + el.className);
      }
    }
    return bad;
  })()`;
/** The TV: no fitted word cut, nothing off the 1280×720 stage, no text under the join badge. */
export const TV_CHECK = `(() => {
    const problems = [];
    const shown = document.querySelector("tvpipe-rejoin")?.shadowRoot?.querySelector(".mini.shown, .shown");
    const badge = (document.getElementById("demo-badge") ?? shown)?.getBoundingClientRect();
    for (const el of document.querySelectorAll("[data-fit]")) {
      if (el.closest(".leaving") || el.hidden || !el.offsetParent) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
      if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 3 + fs * 0.35) problems.push("cut: " + el.className + " «" + el.textContent.slice(0, 60) + "»");
    }
    const moving = document.getAnimations().filter((a) => a.playState === "running" && !(a.effect?.getTiming?.().iterations === Infinity)).map((a) => a.effect?.target).filter((x) => x instanceof Element);
    const still = (el) => !moving.some((m) => m.contains(el));
    for (const el of document.querySelectorAll("#stage *")) {
      if (el.closest(".leaving") || !el.checkVisibility?.() || el instanceof SVGElement) continue;
      // Decoration (rays, VHS bands: empty boxes that may reach past the edge) aside: what has text or is a picture.
      const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
      if (!own && !["canvas", "img"].includes(el.localName)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && still(el) && (r.right > innerWidth + 2 || r.left < -2 || r.bottom > innerHeight + 2 || r.top < -2)) problems.push("off the screen: " + el.localName + "." + el.className);
    }
    if (badge && badge.width > 0) {
      const under = (r) => r.width > 0 && r.height > 0 && r.left < badge.right && r.right > badge.left && r.top < badge.bottom && r.bottom > badge.top;
      const walker = document.createTreeWalker(document.getElementById("stage"), NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.trim() || n.parentElement.closest(".leaving") || !n.parentElement.checkVisibility?.()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) if (under(r)) { problems.push("under the badge: «" + n.textContent.trim().slice(0, 40) + "»"); break; }
      }
    }
    return problems;
  })()`;
