// @ts-check
/**
 * The reveal (the guesser turns cards, the pot shrinks, the guess is
 * punched into a label-maker tape live, under a SHHH! sign and a
 * heartbeat) and the verdict (the drumroll, the envelope opens, RIGHT! or
 * NOT IT, the pot pours into the guesser or off the table, everyone's
 * points).
 *
 * @typedef {import("../game/views.ts").RevealScreen} RevealScreen
 * @typedef {import("../game/views.ts").VerdictScreen} VerdictScreen
 * @typedef {import("../game/views.ts").Card} Card
 * @typedef {import("../game/views.ts").ScreenView} ScreenView
 * @typedef {import("./tv.js").Ctx} Ctx
 */

import { A, EASE, fitText, h, short } from "./dom.js";
import { confetti, dust, floatText, shake, stampAt, strikeThrough } from "./fx.js";
import { reasonText } from "./jinx.js";
import { grid } from "./layout.js";
import { Dymo, cardEl, chip, dial, envelope, setWord, sign, swingIn } from "./pieces.js";
import { bed, heartbeat, sfx } from "./sound.js";
import { t as tr } from "./strings.js";

/**
 * @param {Ctx} ctx
 * @param {RevealScreen} v
 * @param {ScreenView | null} prev
 */
export function reveal(ctx, v, prev) {
  const L = ctx.layer;
  const g = ctx.person(v.guesser);
  const gname = short(g?.name, 12);
  const anim = !!prev;
  ctx.head.set({ tab: tr.theReveal, guesser: g, tally: v.tally }, anim);
  ctx.pot.show(true, anim && prev?.phase !== "jinx");
  if (prev?.phase !== "jinx" || ctx.pot.n !== v.pot) ctx.pot.set(v.pot);
  ctx.pool.off(false);

  const slots = grid(v.cards, { big: true });
  const two = v.cards.length > 4;
  /** @type {Map<string, HTMLElement>} */
  const els = new Map();
  /** @type {Map<string, number | undefined>} */
  const turned = new Map();
  v.cards.forEach((c, i) => {
    const s = slots.get(c.id);
    if (!s) return;
    const el = cardEl(c, ctx.person(c.author), { parent: L, down: !c.turned, x: s.x, y: s.y, w: s.w, h: s.h, who: s.who, whoLeft: s.whoLeft, font: 44 });
    els.set(c.id, el);
    turned.set(c.id, c.turned);
    if (anim && prev?.phase !== "jinx") A(el, [{ transform: "translateY(500px) rotate(20deg)" }, { transform: "none" }], 500, { delay: i * 90 });
  });

  const d = dial(1064, 150, 104);
  L.append(d.el);
  const tick = () => {
    const s = Math.max(0, Math.ceil((v.deadline - ctx.now()) / 1000));
    // the decision's length from `started` (typing moves only the deadline)
    d.set(s, v.started && v.deadline > v.started ? Math.round((v.deadline - v.started) / 1000) : 30);
    if (s <= 10 && s > 0 && !v.typing) sfx.tick();
  };
  tick();
  ctx.every(1000, tick);

  // the guess area
  const gy = two ? 594 : 540;
  const area = h("div", { class: "guess", style: `top:${gy}px` });
  const lbl = h("div", { class: "lbl" }, tr.guessOf(gname));
  if (!two) area.append(lbl);
  const slot = h("div", { class: "slot", style: `top:${two ? 6 : 40}px` });
  area.append(slot);
  L.append(area);
  const dymo = new Dymo(two ? 72 : 84);
  dymo.el.style.top = `${two ? 6 : 40}px`;
  /** @type {HTMLElement | null} */
  let signEl = null;
  let typingShown = false;

  /** @param {RevealScreen} v */
  const idleLine = (v, anim = true) => {
    const n = v.cards.filter((c) => c.turned).length;
    if (n === 0) ctx.host.say(tr.whoseFirst(gname), { anim });
    else if (n < v.cards.length) ctx.host.say(tr.another, { anim });
    else ctx.host.say(tr.everyUp, { anim });
    slot.textContent = n === 0 ? tr.mayAfterAny(gname) : tr.mayNow(gname);
  };

  /** @param {RevealScreen} v @param {boolean} anim */
  const typing = (v, anim) => {
    if (v.typing && !typingShown) {
      typingShown = true;
      ctx.host.hide(true);
      ctx.head.who.classList.add("off");
      signEl = sign(522, gname);
      L.append(signEl);
      slot.hidden = true;
      area.append(dymo.el);
      heartbeat(true);
      if (anim) {
        swingIn(signEl);
        ctx.later(330, sfx.thunk);
        A(dymo.el, [{ transform: "translateX(-50%) scaleX(.2)", opacity: 0 }, { transform: "translateX(-50%) scaleX(1)", opacity: 1 }], 260, { easing: EASE.back });
      }
    } else if (!v.typing && typingShown) {
      typingShown = false;
      heartbeat(false);
      bed(true);
      ctx.host.hide(false);
      ctx.head.who.classList.remove("off");
      if (signEl) {
        const s = signEl;
        A(s, [{ transform: "none" }, { transform: "translateY(-260px)" }], 400, { easing: EASE.in });
        setTimeout(() => s.remove(), 420);
      }
      dymo.set("", false);
      dymo.el.remove();
      slot.hidden = false;
    }
    if (v.typing) dymo.set(v.draft ?? "", anim);
  };

  /** A card turns: "ANNA TRUSTS… BEN", lift, hold, flip, badge, the pot drains. @param {Card} c @param {number} potFrom @param {number} potTo */
  const turn = async (c, potFrom, potTo) => {
    const el = els.get(c.id);
    const s = slots.get(c.id);
    if (!el || !s) return;
    const author = ctx.person(c.author);
    ctx.host.say(tr.trusts(gname.toUpperCase()), { second: short(author?.name, 12).toUpperCase() });
    ctx.pool.to(s.x + s.w / 2, s.y + s.h / 2, Math.max(s.w, s.h) * 0.78);
    el.style.zIndex = "10";
    A(el, [{ transform: "none" }, { transform: "translateY(-14px) scale(1.05)" }], 240);
    sfx.pop();
    if (!(await ctx.wait(1000))) return;
    sfx.whoosh();
    ctx.later(250, sfx.flipTick);
    const flip = el.querySelector(".flip");
    if (flip) A(flip, [{ transform: "rotateY(180deg)" }, { transform: "rotateY(0deg)" }], 640, { easing: EASE.inout });
    A(el, [{ transform: "translateY(-14px) scale(1.05)" }, { offset: 0.5, transform: "translateY(-50px) scale(1.32)" }, { transform: "none" }], 640, { easing: EASE.inout });
    if (!(await ctx.wait(620))) return;
    el.classList.remove("down");
    el.getAnimations().forEach((a) => a.cancel());
    el.querySelectorAll(".flip").forEach((f) => f.getAnimations().forEach((a) => a.cancel()));
    sfx.thwap();
    dust(s.x + s.w / 2, s.y + s.h + 6, 6, 120);
    const hl = el.querySelector(".hl");
    if (hl) A(hl, [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], 280, { delay: 100, easing: EASE.inout });
    const badge = h("div", { class: "order" }, String(c.turned ?? ""));
    el.querySelector(".order")?.remove();
    el.append(badge);
    A(badge, [{ transform: "scale(0)" }, { transform: "scale(1)" }], 260, { delay: 200, easing: EASE.back });
    if (c.bold) {
      el.querySelectorAll(".front .flame").forEach((f) => A(f, [{ transform: "scale(1)" }, { transform: "scale(1.6) rotate(-12deg)" }, { transform: "scale(1)" }], 500, { delay: 200 }));
      ctx.later(250, () => floatText(s.x + s.w - 10, s.y - 40, tr.boldX2, "plus", 1500));
      ctx.later(250, sfx.sparkle);
    }
    if (!(await ctx.wait(450))) return;
    if (potFrom > potTo) ctx.pot.drain(ctx.fx, potFrom - potTo);
    else if (ctx.pot.n !== potTo) ctx.pot.set(potTo);
    if (!(await ctx.wait(1400))) return;
    ctx.pool.off();
    if (!typingShown) idleLine(v);
  };

  idleLine(v, anim);
  typing(v, false);
  if (!v.typing) bed(true);
  return {
    continuous: prev?.phase === "jinx",
    /** @param {RevealScreen} nv @param {RevealScreen} pv */
    update(nv, pv) {
      v = nv;
      tick();
      const fresh = nv.cards.filter((c) => c.turned && !turned.get(c.id)).sort((a, b) => (a.turned ?? 0) - (b.turned ?? 0));
      const turnedNow = fresh.length > 0;
      fresh.forEach((c, i) => {
        turned.set(c.id, c.turned);
        const el = els.get(c.id);
        if (!el) return;
        setWord(el, c.word ?? "", 44);
        if (i < fresh.length - 1) {
          // several at once (a late view): only the last one turns on screen
          el.classList.remove("down");
          const hl = /** @type {HTMLElement | null} */ (el.querySelector(".hl"));
          if (hl) hl.style.transform = "";
          el.append(h("div", { class: "order" }, String(c.turned ?? "")));
        } else void turn(c, pv.pot, nv.pot);
      });
      if (!turnedNow && nv.pot !== pv.pot) ctx.pot.set(nv.pot);
      typing(nv, true);
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * @param {Ctx} ctx
 * @param {VerdictScreen} v
 * @param {ScreenView | null} prev
 */
export function verdict(ctx, v, prev) {
  const L = ctx.layer;
  const g = ctx.person(v.guesser);
  const gname = short(g?.name, 12);
  const right = v.result === "right";
  const fromReveal = prev?.phase === "reveal";
  const lockMs = fromReveal ? 900 : 0;
  const pace = prev ? ctx.pace(6400 + lockMs, v.until) : 0;
  const anim = pace > 0;
  const T = (/** @type {number} */ ms) => ms * (pace || 1);
  ctx.memo.payouts = v.payouts;
  ctx.memo.result = v.result;
  ctx.pool.off(anim);
  ctx.pot.show(true);
  const prevTally = prev && "tally" in prev ? prev.tally : v.tally;
  ctx.head.set({ tab: tr.theVerdict, guesser: g, tally: anim ? prevTally : v.tally }, anim);
  if (!fromReveal) {
    ctx.head.who.classList.remove("off");
    ctx.host.hide(false);
  }

  // the guesser, the envelope with the word, the tape
  const gt = chip(g, 150, { style: "left:84px;top:236px" });
  L.append(gt, h("div", { class: "seatname", style: "left:84px;top:398px;width:150px;font-size:30px" }, gname));
  const env = envelope(410, 190);
  const secret = h("div", { class: "secret paper", style: "left:-110px;top:10px;z-index:2;transform:scale(.5)" }, h("small", null, tr.theWordWas), h("div", { class: "w" }, v.word.toUpperCase()));
  env.insertBefore(secret, env.querySelector(".pocket"));
  L.append(env);
  const w = /** @type {HTMLElement} */ (secret.querySelector(".w"));
  fitText(w, 88, 40, 450, 0.6);
  const area = h("div", { class: "guess", style: "top:452px;left:102px" });
  const dymo = new Dymo(84, 660);
  dymo.set(v.guess ?? "", false);
  dymo.done();
  if (v.guess) area.append(dymo.el);
  dymo.el.style.transform = "translateX(-50%) rotate(-1.5deg)";
  L.append(area);
  const row = h("div", { class: "abs", style: "left:96px;top:606px;width:880px;height:70px" });
  L.append(row);

  // points
  /** @type {Map<string, number>} */
  const sums = new Map();
  // everyone who played this round (the card authors, then the rest of the room)
  for (const c of v.cards) if (c.author !== v.guesser) sums.set(c.author, 0);
  for (const p of v.people) if (p.id !== v.guesser && !p.left && !sums.has(p.id) && sums.size < 7) sums.set(p.id, 0);
  for (const p of v.payouts) if (p.id !== v.guesser) sums.set(p.id, (sums.get(p.id) ?? 0) + p.delta);
  const mine = v.payouts.filter((p) => p.id === v.guesser).reduce((s, p) => s + p.delta, 0);

  const outcome = () => {
    if (v.result === "right") ctx.host.say(v.near ? tr.closeEnough(reasonText(v.near)) : tr.nailedIt, { second: tr.plusFor(mine, gname), anim });
    else if (v.result === "wrong") ctx.host.say(tr.soClose, { second: tr.soWrong, anim });
    else if (v.result === "pass") ctx.host.say(tr.noGuess, { second: tr.noGlory, anim });
    else ctx.host.say(tr.emptyPot, { anim });
  };
  /** @param {boolean} anim */
  const final = (anim) => {
    // the stamp right of the paper: a long word ("GEBURTSTAGSKUCHEN", 450 px) stays readable
    const sc = { x: 640, y: 255 };
    if (v.result === "right") stampAt(L, sc.x + 340, sc.y + 40, tr.stamps.right, { cls: "green", rot: 10, size: 60, anim, shakePx: 8 });
    else stampAt(L, sc.x + 340, sc.y + 40, tr.stamps[v.result], { cls: "ink", rot: 10, size: 60, anim });
    if (v.near) {
      const tag = h("div", { class: "tape", style: "left:50%;top:-6px;transform:translateX(220px) rotate(4deg);font-size:24px;padding:4px 14px;z-index:5" }, `≈ ${reasonText(v.near)}`);
      area.append(tag);
    }
  };
  /** @param {boolean} anim */
  const points = (anim) => {
    let i = 0;
    for (const [id, dlt] of sums) {
      const x = i * 126;
      const t = chip(ctx.person(id), 56, { style: `left:${x}px;top:4px` });
      const tag = h("div", { class: `pts ${dlt > 0 ? "plus" : dlt < 0 ? "minus" : "zero"}`, style: `left:${x + 62}px;top:14px` }, dlt > 0 ? `+${dlt}` : dlt < 0 ? `−${-dlt}` : "0");
      row.append(t, tag);
      if (anim) {
        A(t, [{ transform: "translateY(110px)" }, { transform: "none" }], 380, { delay: i * 90, easing: EASE.back });
        A(tag, [{ transform: "scale(0)" }, { transform: dlt ? "scale(1.25)" : "scale(1)" }, { transform: "scale(1)" }], 360, { delay: 500 + i * 120, easing: EASE.back });
        if (dlt > 0) ctx.later(500 + i * 120, sfx.clink);
        else if (dlt < 0) ctx.later(500 + i * 120, sfx.bonk);
      }
      i++;
    }
  };

  if (!anim) {
    env.querySelectorAll(".body,.pocket,.flapwrap,.seal").forEach((e) => /** @type {HTMLElement} */ (e).remove());
    secret.style.transform = "translateY(-30px)";
    secret.style.zIndex = "6";
    area.style.transform = "translateY(-80px)";
    if (v.result === "wrong") strikeThrough(dymo.el, false);
    ctx.pot.set(0);
    final(false);
    points(false);
    outcome();
    return {};
  }

  // the old table's tape is snipped first (LOCKED IN / PASS)
  if (fromReveal && ctx.prevLayer) {
    const old = ctx.prevLayer;
    const od = /** @type {HTMLElement | null} */ (old.querySelector(".dymo"));
    if (v.result === "pass" || !v.guess) {
      const slotEl = /** @type {HTMLElement | null} */ (old.querySelector(".guess"));
      stampAt(old, 522, (slotEl ? parseFloat(slotEl.style.top) : 540) + 80, tr.stamps.pass, { cls: "ink", rot: -4, size: 54 });
    } else if (od) {
      od.classList.add("done");
      sfx.snip();
      A(od, [{ transform: "translateX(-50%) rotate(0)" }, { transform: "translateX(-50%) translateY(6px) rotate(-3deg)" }, { transform: "translateX(-50%) rotate(-1.5deg)" }], 300, { easing: EASE.back });
      const area0 = /** @type {HTMLElement | null} */ (old.querySelector(".guess"));
      const top = (area0 ? parseFloat(area0.style.top) : 540) + (parseFloat(od.style.top) || 40);
      // on the tape's right end, a little above it
      ctx.later(300, () => stampAt(old, Math.min(522 + od.offsetWidth / 2 - 30, 850), top - 6, tr.lockedIn, { cls: "gold", rot: 8, size: 30 }));
    }
  }
  L.style.visibility = "hidden";
  heartbeat(false);

  (async () => {
    if (!(await ctx.wait(lockMs))) return;
    L.style.visibility = "";
    A(L, [{ opacity: 0, transform: "translateY(40px)" }, { opacity: 1, transform: "none" }], 300);
    ctx.head.who.classList.remove("off");
    ctx.host.hide(false);
    ctx.host.say(tr.wordWas);
    if (!(await ctx.wait(T(300)))) return;
    sfx.drumroll(T(1100));
    A(env, [{ transform: "rotate(0)" }, { transform: "rotate(-2.5deg)" }, { transform: "rotate(2.5deg)" }, { transform: "rotate(0)" }], 120, { iterations: Math.max(3, Math.round(T(1100) / 120)), fill: "none", easing: EASE.lin });
    if (!(await ctx.wait(T(1150)))) return;
    sfx.cymbal();
    sfx.whoosh();
    const fw = /** @type {HTMLElement} */ (env.querySelector(".flapwrap"));
    A(fw, [{ transform: "rotateX(0)" }, { transform: "rotateX(180deg)" }], 340, { easing: EASE.inout });
    const seal = env.querySelector(".seal");
    if (seal) A(seal, [{ transform: "scale(1)", opacity: 1 }, { transform: "translateY(-60px) scale(1.3) rotate(40deg)", opacity: 0 }], 340);
    ctx.later(170, () => (fw.style.zIndex = "1"));
    if (!(await ctx.wait(360))) return;
    A(secret, [{ transform: "scale(.5)" }, { transform: "translateY(-150px) scale(.5)" }], T(380));
    sfx.slide();
    if (!(await ctx.wait(T(380)))) return;
    secret.style.zIndex = "6";
    for (const part of env.querySelectorAll(".body,.pocket,.flapwrap")) {
      const flap = part === fw;
      A(part, [{ transform: flap ? "rotateX(180deg)" : "none", opacity: 1 }, { transform: `translateY(120px)${flap ? " rotateX(180deg)" : ""}`, opacity: 0 }], 420, { easing: EASE.in });
    }
    A(secret, [{ transform: "translateY(-150px) scale(.5)" }, { transform: "translateY(-30px) scale(1)" }], 460, { easing: EASE.back });
    if (!(await ctx.wait(500))) return;
    sfx.thwap();
    shake(4);
    A(area, [{ transform: "none" }, { transform: "translateY(-80px)" }], 360, { easing: EASE.back });
    if (!(await ctx.wait(420))) return;
    if (v.result === "wrong") {
      strikeThrough(dymo.el);
      if (!(await ctx.wait(T(500)))) return;
    }
    final(true);
    outcome();
    if (right) {
      ctx.later(150, () => {
        confetti(560, 255, 54);
        sfx.fanfare();
      });
      A(secret, [{ transform: "translateY(-30px) scale(1)" }, { transform: "translateY(-30px) scale(1.08) rotate(-2deg)" }, { transform: "translateY(-30px) scale(1)" }], 400, { delay: 160, easing: EASE.back });
    } else {
      ctx.later(200, v.result === "lost" ? sfx.bonk : sfx.trombone);
      A(secret, [{ transform: "translateY(-30px) rotate(0)" }, { transform: "translateY(-30px) rotate(-2deg)" }, { transform: "translateY(-30px) rotate(1.5deg)" }, { transform: "translateY(-30px) rotate(0)" }], 600, { delay: 200 });
    }
    if (!(await ctx.wait(T(1000)))) return;
    const n = ctx.pot.n;
    if (right) {
      const ms = ctx.pot.drain(ctx.fx, n, { x: 159, y: 311 }, T(110));
      if (!(await ctx.wait(ms - 150))) return;
      floatText(159, 200, `+${mine}`, "plus", 2200);
      A(gt, [{ transform: "scale(1)" }, { transform: "translateY(-24px) scale(1.15) rotate(-6deg)" }, { transform: "scale(1)" }], 400, { easing: EASE.back, fill: "none" });
      sfx.sparkle();
    } else {
      const ms = ctx.pot.drain(ctx.fx, n, null, T(90));
      if (mine < 0) floatText(159, 200, `−${-mine}`, "minus", 2200);
      A(gt, [{ transform: "none" }, { transform: "rotate(-10deg) translateY(8px)" }, { transform: "none" }], 700, { fill: "none" });
      if (!(await ctx.wait(Math.min(ms, T(700))))) return;
    }
    if (!(await ctx.wait(T(300)))) return;
    points(true);
    ctx.head.setTally(v.tally, true);
  })();
  return { sweepDelay: lockMs };
}
