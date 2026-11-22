/**
 * A live check of Pinch on `tvpipe game play` (not part of `npm test`,
 * docs/pinch-design.md §15): tvpipe serves the bundle (a snapshot of
 * `dist/`); one Chrome plays the window (the launcher, "A browser tab on
 * this computer", the host page), the TV (the watch link at 1280×720)
 * and two real phone pages at 390×844 that play by touches: in its
 * thief turn a phone walks by taps to the loot it sees (or knows of: the
 * host's truth stands in for the tip), takes it with the action button
 * and runs to its car; as a guard it switches the flashlight on,
 * patrols, walks after a thief it sees, taps HOLD when it shows and
 * comes to arrest when someone holds. Bots (game/bots.ts, skill 0.6)
 * play the rest: thieves that go for the loot and run; as guards they
 * stand (`idle: "guard"`) unless `--chase`, else a phone's 22 s turn as
 * the thief is mostly spent held. A whole game to the final with `?fast`'s timings and a
 * shorter heist (`--heist`, 22 s), within a hard time limit (`--limit`,
 * 180 s for 4 players): every phase is waited for with its own timeout,
 * and a run that is late fails naming what it waited for.
 *
 * Checks: every phase on the TV and on both phones, in order; the heist
 * screen on both phones in every heist; no page errors or console
 * errors; frames (`f`) on the phones and the public layer (`pub`) on the
 * TV at about 10 Hz on the wire (as a warning: with three headless
 * Chromes on one machine the timers are not a phone's); secrecy on the
 * wire (no car, tip or briefing in a guard's state or frames, nothing
 * secret in the TV's public layer, no tape on a phone); layout (nothing
 * off the screen, overlapping bars, words cut, text under the join
 * badge) on the TV and the phones (the heist at five sizes); a
 * screenshot per phase in `--out`.
 *
 *   npm run build && node test/live/play.ts [--lang de] [--players N] [--heist S] [--limit S] [--chase] [--out DIR] [--shots DIR] [--headed]
 *
 * `--shots DIR`: the games list's pictures (docs/game-catalog.md): the
 * TV's heist, a hold, the tape and the outcome at 1280×720, the thief's
 * and a guard's phone at 390×844, with people's names for the bots.
 * `PINCH_DEBUG=1` logs what the scripted phones do.
 *
 * Needs Chrome and tvpipe built (TVPIPE_BINARY, else target/release, else target/debug).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { Browser, type Tab } from "./browser.ts";
import { PHONE_CHECK, TV_CHECK } from "./checks.ts";
import { hostPage, log, PHONE_STATE, rate, sleep, startTvpipe, tap, tapToward, wire, wireTap, type PhoneState, type Tvpipe } from "./rig.ts";
import { keep } from "./shots.ts";

const { values: args } = parseArgs({
  options: {
    lang: { type: "string", default: "en" },
    players: { type: "string", default: "4" },
    heist: { type: "string", default: "22" },
    limit: { type: "string" },
    out: { type: "string" },
    shots: { type: "string" },
    headed: { type: "boolean", default: false },
    chase: { type: "boolean", default: false },
  },
});
const lang = args.lang === "de" ? "de" : "en";
const players = Math.max(3, Math.min(8, Number(args.players) || 4));
const heistSecs = Math.max(15, Number(args.heist) || 22);
/** `?fast` (game.ts FAST_TIMINGS) with a shorter heist and tape, so a whole game fits the limit. */
const TIMINGS = { briefing: 4000, outcome: 2500, tape: 6000, scores: 2500, heist: heistSecs };
const roundMs = TIMINGS.briefing + TIMINGS.outcome + TIMINGS.tape + TIMINGS.scores + heistSecs * 1000;
const limit = (Number(args.limit) || Math.max(180, Math.ceil((20_000 + players * roundMs) / 1000))) * 1000;
const out = args.out ?? `/tmp/pinch-play${lang === "de" ? "-de" : ""}`;
const shots = args.shots;
const debug = !!process.env["PINCH_DEBUG"];
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
if (shots) mkdirSync(shots, { recursive: true });
const NAMES = ["Anna", "Ben"];
const BOTS = ["Clara", "Dmitri", "Emil", "Fatou", "Greta", "Hiro"];

const problems: string[] = [];
const warnings: string[] = [];
const problem = (p: string) => {
  if (problems.includes(p)) return;
  problems.push(p);
  log(`PROBLEM ${p}`);
};
const warn = (p: string) => {
  warnings.push(p);
  log(`warning: ${p}`);
};

// ---------------------------------------------------------------- never hang

let tvpipe: Tvpipe | null = null;
let browser: Browser | null = null;
/** What the run waits for now (the time limit's message). */
let waiting = "tvpipe to start";
const cleanup = () => {
  browser?.close();
  tvpipe?.proc.kill();
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    log(`stopped (${sig}) while waiting for ${waiting}`);
    process.exit(130);
  });
}
const started = Date.now();
setTimeout(() => {
  log(`FAILED: over the time limit (${limit / 1000} s) while waiting for ${waiting}`);
  if (tvpipe) writeFileSync(`${out}/tvpipe.log`, tvpipe.lines.join("\n"));
  process.exit(1);
}, limit).unref();
/** Waits for `what` (an expression in `tab`) at most `ms`; a failure names it. */
const until = async (tab: Tab, what: string, expr: string, ms: number) => {
  waiting = what;
  try {
    await tab.until(expr, ms);
  } catch {
    throw new Error(`timed out after ${(ms / 1000).toFixed(0)} s waiting for ${what}`);
  }
};

let failed = false;
try {
  tvpipe = await startTvpipe();
  browser = await Browser.launch({ headed: args.headed });
  waiting = "the host page";
  const win = await hostPage(browser, tvpipe.start);
  log(`the host page runs the game (limit ${limit / 1000} s)`);
  await win.eval(`(() => { pinch.game.configure({ lang: ${JSON.stringify(lang)}, timings: { ...pinch.FAST_TIMINGS, ...${JSON.stringify(TIMINGS)} } }); return true; })()`);
  // The host's side of what happens: results, every hold and take tried, the pacing of frames.
  await win.eval(`(() => {
    globalThis.__results = [];
    globalThis.__acts = [];
    globalThis.__perf = { step: [], pub: [] };
    pinch.game.on("heist", (r) => __results.push({ outcome: r.outcome, thief: r.thief, haul: r.haul, taken: r.taken, holder: r.holder, arrester: r.arrester, t: r.t }));
    pinch.game.on("round", () => {
      const h = pinch.game.heist;
      const step = h.step.bind(h);
      h.step = () => {
        const t = performance.now();
        step();
        __perf.step.push(performance.now() - t);
      };
      const pd = h.publicDelta.bind(h);
      h.publicDelta = () => {
        __perf.pub.push(Date.now());
        return pd();
      };
      const act = h.act.bind(h);
      h.act = (id, a) => {
        const r = act(id, a);
        if (a.a !== "aim") __acts.push({ t: h.t, id, a: a.a, r: r ?? null });
        return r;
      };
    });
    return true;
  })()`);
  const links = await win.eval<{ join: string; watch: string }>(`({ join: pinch.party.links.join, watch: pinch.party.links.watch })`);
  const tv = await browser.open(`${links.watch}&mute=1`, { width: 1280, height: 720, init: wireTap({ role: "tv" }) });
  const PHONE = { width: 390, height: 844, mobile: true, locale: lang === "de" ? "de-DE" : "en-US" };
  const phones: Tab[] = [];
  for (const name of NAMES) {
    const p = await browser.open(links.join, { ...PHONE, context: true, init: wireTap({ role: "phone" }) });
    await until(p, `${name}'s join form`, `!!document.getElementById("name")`, 20_000);
    await p.eval(`document.getElementById("name").value = ${JSON.stringify(name)}; document.querySelector("form button").click(); true`);
    await until(p, `${name}'s lobby`, `document.body.dataset.phase === "lobby"`, 10_000);
    phones.push(p);
  }
  const [anna, ben] = phones as [Tab, Tab];
  const ids = await win.eval<string[]>(`${JSON.stringify(NAMES)}.map((n) => pinch.party.players.find((p) => p.name === n).id)`);
  const nameOf = (id: string | null) => (id ? (NAMES[ids.indexOf(id)] ?? "a bot") : "nobody");
  waiting = "the bots";
  await win.eval(`pinch.addBots(${players - 2}, { names: ${JSON.stringify(BOTS)}, skill: 0.6${args.chase ? "" : `, idle: "guard"`} }).then(() => true)`);
  await until(anna, "the bots in the lobby", `document.querySelectorAll(".chips .chip").length === ${players}`, 20_000);
  await until(tv, "the TV's lobby", `document.documentElement.dataset.phase === "lobby"`, 10_000);
  log(`${players - 2} bots joined`);
  const pages: [string, Tab][] = [["the window", win], ["the TV", tv], ["Anna's phone", anna], ["Ben's phone", ben]];

  // ---------------------------------------------------------------- screenshots

  const SIZES = [
    { width: 320, height: 568, tag: "320" },
    { width: 375, height: 667, tag: "375" },
    { width: 412, height: 915, tag: "412" },
    { width: 430, height: 932, tag: "430" },
  ];
  /** Tabs being resized: the scripts keep their fingers off. */
  const resizing = new Set<Tab>();
  let n = 0;
  const shot = async (tab: Tab, who: string, name: string, sizes = false) => {
    const file = `${out}/${String(++n).padStart(2, "0")}-${who}-${name}`;
    await tab.screenshot(`${file}.png`);
    const check = who === "tv" ? TV_CHECK : PHONE_CHECK;
    for (const f of await tab.eval<string[]>(check).catch((e: Error) => [`cannot check: ${e.message.slice(0, 80)}`])) problem(`${who} ${name}: ${f}`);
    if (!sizes) return;
    resizing.add(tab);
    try {
      for (const s of SIZES) {
        await tab.resize({ ...s, mobile: true });
        await sleep(300);
        for (const f of await tab.eval<string[]>(check).catch(() => [])) problem(`${who} ${s.tag} ${name}: ${f}`);
        await tab.screenshot(`${file}-${s.tag}.png`);
      }
    } finally {
      await tab.resize(PHONE);
      await sleep(200);
      resizing.delete(tab);
    }
  };
  const kept = new Set<string>();
  const pic = async (tab: Tab, name: string, kind: "tv" | "phone", settle = 300) => {
    if (!shots || kept.has(name)) return;
    kept.add(name);
    log(`picture: ${await keep(tab, shots, name, kind, settle)}`);
  };

  // ---------------------------------------------------------------- the phones' players

  /** The host's truth for the thief (stands in for the tip: where the loot is). */
  const truth = () =>
    win.eval<{ items: { item: number; access: number; keep: string; taken: number | null }[] } | null>(`(() => {
      const h = pinch.game.heist;
      return h ? { items: h.peekItems().map((i) => ({ item: i.item, access: i.place.access, keep: i.place.keep, taken: i.taken })) } : null;
    })()`);
  const stats = { walks: 0, takes: 0, holdTaps: 0, lightTaps: 0, wriggles: 0 };
  const centre = (i: number, w: number) => ({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 });

  /** One phone's player, whatever its role is this round. */
  const play = async (tab: Tab, me: string, done: () => boolean) => {
    let lastTap = 0;
    let goal = "";
    let lastLight = 0;
    let lastHold = 0;
    let said = 0;
    let patrol: { x: number; y: number } | null = null;
    const tried = new Map<number, number>();
    while (!done()) {
      await sleep(200);
      if (resizing.has(tab)) continue;
      const s = await tab.eval<PhoneState | null>(PHONE_STATE).catch(() => null);
      if (!s || s.end) continue;
      const now = Date.now();
      const say = (m: string) => {
        if (debug && now - said > 2000) {
          said = now;
          if (Math.hypot(s.body.x - s.me.x, s.body.y - s.me.y) > 2) {
            void (async () => {
              const bp = await tab.eval(`globalThis.__wire.view.room.blueprint`);
              const ph = await tab.eval(`(() => { const m = globalThis.pinchHeist; return { body: { ...m.body }, goal: m.goal, path: m.path && m.path.points, doors: [...m.mem.doors], hist: m.history.slice(-40) }; })()`);
              const host = await win.eval(`(() => { const h = pinch.game.heist; const p = h.peek(${JSON.stringify(me)}); return { x: p.x, y: p.y, doors: [...h.peekDoors()] }; })()`);
              writeFileSync(`${out}/div-${Date.now()}.json`, JSON.stringify({ bp, ph, host, frame: s.me }));
            })();
            void tab.eval<string>(`(() => { const m = globalThis.pinchHeist; return JSON.stringify({ goal: m.goal, path: m.path && { next: m.path.next, pts: m.path.points.map((p) => [+p.x.toFixed(1), +p.y.toFixed(1)]), doors: m.path.doors }, waitDoor: m.waitDoor, corr: m.corr, hist: m.history.length, quiet: performance.now() - m.goSent, hostGoal: m.frame.me.goal, busy: m.frame.me.busy, moving: m.frame.me.moving, doors: m.waitDoor >= 0 ? m.mem.doors[m.waitDoor] : null, t: m.frame.t }); })()`).then((x) => log(`  ${nameOf(me)} model: ${x}`));
          }
          log(`${nameOf(me)} (${s.me.role}): ${m}; at (${s.body.x.toFixed(1)},${s.body.y.toFixed(1)}), host frame (${s.me.x.toFixed(1)},${s.me.y.toFixed(1)}), left ${s.left.toFixed(0)} s`);
        }
      };
      if (s.me.role === "thief") {
        if (s.me.frozen) {
          if (s.big) {
            for (let k = 0; k < 4; k++) {
              await tap(tab, s.big);
              await sleep(80);
            }
            stats.wriggles += 4;
          }
          continue;
        }
        if (s.me.busy) continue;
        const offers = (s.me.offers as { a: string }[]).filter((o) => o.a !== "hold" && o.a !== "wriggle");
        const take = s.acts.find((b) => b.a === "take");
        if (offers.some((o) => o.a === "take") && !take) warn(`${nameOf(me)}'s phone offers no Take button where the host offers a take (${offers.map((o) => o.a)})`);
        if (take && s.me.free > 0 && s.left > 6) {
          say("take");
          await tap(tab, take);
          stats.takes++;
          await sleep(300);
          continue;
        }
        // Loot it sees first, else what it knows of (loose and cased, no safe, no pedestal); the car when it has some, or time runs short.
        let target: { x: number; y: number; why: string } | null = null;
        const t = s.me.slots.length < 1 && s.me.free > 0 && s.left > 9 ? await truth() : null;
        if (t) {
          const seen = new Set(s.items.map((i) => i.item));
          const score = (i: { item: number; access: number }) => {
            const c = centre(i.access, s.w);
            return Math.hypot(c.x - s.body.x, c.y - s.body.y) - (seen.has(i.item) ? 1000 : 0);
          };
          const best = t.items.filter((i) => i.taken === null && i.keep !== "pedestal" && i.keep !== "safe" && (tried.get(i.item) ?? 0) < 6).sort((a, b) => score(a) - score(b))[0];
          if (best) target = { ...centre(best.access, s.w), why: `item ${best.item}` };
        }
        if (!target && s.car) target = { ...s.car, why: "car" };
        if (!target) continue;
        if (Math.hypot(target.x - s.body.x, target.y - s.body.y) < 0.6) {
          // At the place and nothing to take (not seen yet, someone near): count it, look elsewhere after a few.
          if (target.why.startsWith("item")) tried.set(Number(target.why.slice(5)), (tried.get(Number(target.why.slice(5))) ?? 0) + 1);
          say(`at ${target.why}, offers ${offers.map((o) => o.a)}`);
          continue;
        }
        if (s.path && goal === target.why && now - lastTap < 2500) continue;
        const p = await tapToward(tab, s, target.x, target.y);
        say(`to ${target.why} (${target.x.toFixed(1)},${target.y.toFixed(1)})${p ? "" : ": nowhere to tap"}`);
        if (!p) continue;
        await tap(tab, p);
        stats.walks++;
        lastTap = now;
        goal = target.why;
      } else if (s.me.role === "guard") {
        if (s.me.hold) continue;
        if (s.me.light === "off" && s.tool && now - lastLight > 1500) {
          await tap(tab, s.tool);
          stats.lightTaps++;
          lastLight = now;
          continue;
        }
        if (s.big && !s.holds.length && now - lastHold > 400) {
          say("HOLD");
          await tap(tab, s.big);
          stats.holdTaps++;
          lastHold = now;
          continue;
        }
        if (s.me.frozen) continue;
        // To a public hold (the arrest), after a thief it sees (stopping short: a tap on the thief is a hold), else patrol the rooms.
        const held = s.holds[0];
        const thief = s.others.find((o) => o.role === "thief");
        let target: { x: number; y: number };
        if (held) target = { x: held.x, y: held.y };
        else if (thief) {
          const d = Math.hypot(thief.x - s.body.x, thief.y - s.body.y);
          if (d < 3) continue;
          target = { x: thief.x + ((s.body.x - thief.x) * 2) / d, y: thief.y + ((s.body.y - thief.y) * 2) / d };
        } else {
          if (!patrol || Math.hypot(patrol.x - s.body.x, patrol.y - s.body.y) < 1.5 || (!s.path && now - lastTap > 3000)) {
            patrol = await tab.eval<{ x: number; y: number }>(`(() => {
              const rooms = globalThis.pinchHeist.map.rooms;
              const r = rooms[Math.floor(Math.random() * rooms.length)].rect;
              return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
            })()`);
          }
          target = patrol;
        }
        if (s.path && now - lastTap < (thief || held ? 700 : 2500)) continue;
        const p = await tapToward(tab, s, target.x, target.y);
        say(`${held ? "to the hold" : thief ? "after the thief" : "patrol"}${p ? "" : ": nowhere to tap"}`);
        if (!p) continue;
        await tap(tab, p);
        stats.walks++;
        lastTap = now;
      }
    }
  };

  // ---------------------------------------------------------------- the game

  waiting = "Anna's start button";
  await shot(tv, "tv", "lobby");
  await pic(tv, "tv-lobby", "tv", 100);
  await shot(anna, "anna", "lobby");
  await shot(ben, "ben", "lobby");
  await until(anna, "Anna's start button", `!!document.getElementById("start") && !document.getElementById("start").disabled`, 10_000);
  await tap(anna, await anna.eval<{ x: number; y: number }>(`(() => { const r = document.getElementById("start").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`));
  let over = false;
  const scripts = [play(anna, ids[0]!, () => over), play(ben, ids[1]!, () => over)];
  const tvPhase = `document.documentElement.dataset.phase`;
  /** How long each phase may take to come (ms after the previous one began). */
  const SLACK = 8000;
  const within: Record<string, number> = {
    briefing: TIMINGS.scores + SLACK,
    heist: TIMINGS.briefing + SLACK,
    outcome: heistSecs * 1000 + SLACK,
    tape: TIMINGS.outcome + SLACK,
    scores: TIMINGS.tape + SLACK,
    final: TIMINGS.scores + SLACK,
  };
  const order = [...Array.from({ length: players }, () => ["briefing", "heist", "outcome", "tape", "scores"]).flat(), "final"];
  try {
    for (const [k, phase] of order.entries()) {
      const round = Math.floor(k / 5) + 1;
      const tag = phase === "final" ? "final" : `r${round}-${phase}`;
      await until(tv, `the TV's ${tag}`, `["${phase}", "final"].includes(${tvPhase})`, k === 0 ? 10_000 : within[phase]!);
      const now = await tv.eval<string>(tvPhase);
      if (now !== phase) throw new Error(`the TV went to ${now} while waiting for its ${tag}`);
      const thief = phase === "briefing" ? await win.eval<string>(`pinch.game.thief`) : null;
      log(`${tag}${thief ? ` (the thief: ${nameOf(thief)})` : ""}`);
      if (phase === "heist") {
        // Both phones show the heist screen (the script's state comes from it).
        for (const [name, tab] of [["Anna", anna], ["Ben", ben]] as const) {
          await until(tab, `${name}'s heist screen in ${tag}`, `document.body.dataset.phase === "heist" && !!document.querySelector(".heist canvas.map") && !!globalThis.pinchHeist?.frame`, 5000).catch((e: Error) => problem(e.message));
        }
        await sleep(1200);
        await shot(tv, "tv", tag);
        // Ten seconds in: the TV, both phones (the heist at every size, once per role), the pictures.
        await sleep(8000);
        if ((await tv.eval<string>(tvPhase)) === "heist") {
          await shot(tv, "tv", `${tag}-10s`);
          await pic(tv, "tv-heist", "tv", 100);
          const th = await win.eval<string>(`pinch.game.thief`);
          for (const [who, tab, id] of [["anna", anna, ids[0]], ["ben", ben, ids[1]]] as const) {
            const role = id === th ? "thief" : "guard";
            await shot(tab, who, `${tag}-${role}`, !kept.has(`sizes-${role}`));
            kept.add(`sizes-${role}`);
            await pic(tab, `phone-${role}`, "phone", 100);
          }
        }
        // A hold while it lasts: the TV and the phones.
        waiting = `a hold in ${tag}`;
        for (let i = 0; i < 80 && (await tv.eval<string>(tvPhase)) === "heist"; i++) {
          if (!kept.has(`held-${round}`) && (await win.eval<boolean>(`!!pinch.game.heist?.peekHold()`))) {
            kept.add(`held-${round}`);
            await sleep(400);
            await shot(tv, "tv", `${tag}-held`);
            await pic(tv, "tv-held", "tv", 100);
            await shot(anna, "anna", `${tag}-held`);
            await shot(ben, "ben", `${tag}-held`);
          }
          await sleep(250);
        }
        continue;
      }
      await sleep(phase === "final" ? 1500 : 700);
      await shot(tv, "tv", tag);
      if (phase === "outcome") await pic(tv, "tv-outcome", "tv", 100);
      if (phase === "tape") {
        await sleep(3000);
        await shot(tv, "tv", `${tag}-play`);
        await pic(tv, "tv-tape", "tv", 100);
      }
      for (const [who, tab, name] of [["anna", anna, "Anna"], ["ben", ben, "Ben"]] as const) {
        await until(tab, `${name}'s ${tag}`, `document.body.dataset.phase === "${phase}"`, 5000).catch((e: Error) => problem(e.message));
        await shot(tab, who, tag);
      }
    }
  } finally {
    over = true;
    waiting = "the phones' scripts to stop";
    await Promise.race([Promise.all(scripts), sleep(5000)]);
  }

  // ---------------------------------------------------------------- the checks

  waiting = "the checks";
  const results = await win.eval<{ outcome: string; thief: string; haul: number; taken: number[]; holder: string | null; arrester: string | null; t: number }[]>(`__results`);
  const acts = await win.eval<{ t: number; id: string; a: string; r: string | null }[]>(`__acts`);
  for (const [k, r] of results.entries()) {
    log(`round ${k + 1}: ${nameOf(r.thief)} the thief, ${r.outcome} after ${r.t.toFixed(0)} s, $${r.haul} (${r.taken.length} items)${r.holder ? `, held by ${nameOf(r.holder)}` : ""}${r.arrester ? `, arrested by ${nameOf(r.arrester)}` : ""}`);
  }
  if (results.length !== players) problem(`${results.length} heists for ${players} players`);
  for (const [k, id] of ids.entries()) {
    const own = results.find((r) => r.thief === id);
    const takes = acts.filter((a) => a.id === id && a.a === "take");
    const holds = acts.filter((a) => a.id === id && a.a === "hold");
    const refused = [...new Set(holds.filter((a) => a.r).map((a) => a.r))];
    log(`${NAMES[k]}: as the thief ${own ? `${own.outcome}, ${own.taken.length} items` : "never"}; ${takes.filter((a) => a.r === null).length}/${takes.length} takes; ${holds.filter((a) => a.r === null).length}/${holds.length} holds (refused: ${refused.join(", ") || "none"})`);
    if (own && own.outcome !== "left" && takes.length === 0) warn(`${NAMES[k]}'s phone took nothing in its thief turn`);
  }
  const refusals = new Map<string, number>();
  for (const a of acts) if (ids.includes(a.id) && a.r) refusals.set(`${a.a}: ${a.r}`, (refusals.get(`${a.a}: ${a.r}`) ?? 0) + 1);
  log(`the phones' actions refused: ${[...refusals].map(([k, v]) => `${k} ×${v}`).join(", ") || "none"}`);
  if (!acts.some((a) => ids.includes(a.id) && a.a === "hold")) warn("no phone tried a hold (the thief never came into a phone's light)");
  log(`scripted taps: ${stats.walks} walks, ${stats.takes} takes, ${stats.holdTaps} HOLD, ${stats.lightTaps} flashlight, ${stats.wriggles} wriggles`);

  // Phases in order, secrecy on the wire.
  const want = ["lobby", ...order];
  const wires = new Map<string, Awaited<ReturnType<typeof wire>>>();
  for (const [name, tab] of [["the TV", tv], ["Anna's phone", anna], ["Ben's phone", ben]] as const) {
    const w = await wire(tab);
    wires.set(name, w);
    const seen = w.phases.map((p) => p[1]).filter((p, i, a) => p !== a[i - 1]);
    if (JSON.stringify(seen) !== JSON.stringify(want)) problem(`${name}'s phases: ${seen.join(" → ")}`);
    else log(`${name}: all ${seen.length} phases in order`);
    for (const b of w.bad) problem(`secrecy, ${name}: ${b}`);
    if (!w.got) problem(`${name}: the wire tap saw nothing (not a WebSocket?)`);
  }
  // Frames on the wire during each heist (from a second in to half a second before its end).
  const tvw = wires.get("the TV")!;
  const heists: [number, number][] = [];
  for (const [i, [t, p]] of tvw.phases.entries()) if (p === "heist") heists.push([t + 1000, (tvw.phases[i + 1]?.[0] ?? Date.now()) - 500]);
  for (const [name, type] of [["Anna's phone", "f"], ["Ben's phone", "f"], ["the TV", "pub"]] as const) {
    const w = wires.get(name)!;
    const parts: string[] = [];
    for (const [a, b] of heists) {
      const r = rate(w.at[type], a, b);
      parts.push(`${r.hz.toFixed(1)} Hz (gaps p95 ${Math.round(r.p95)}, max ${Math.round(r.max)} ms)`);
      if (r.n === 0) problem(`${name}: no ${type} messages in a heist`);
      else if (r.hz < 8.5 || r.hz > 11) warn(`${name}: ${type} at ${r.hz.toFixed(1)} Hz in a heist`);
    }
    const secs = heists.reduce((s, [a, b]) => s + (b - a) / 1000, 0);
    log(`${name} ${type}: ${parts.join(", ")}; ${((w.bytes[type] ?? 0) / Math.max(1, secs) / 1024).toFixed(1)} KiB/s`);
  }
  const perf = await win.eval<{ step: number[]; pub: number[] }>(`__perf`);
  const q = (xs: number[], f: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * f)] ?? 0;
  const gaps = perf.pub.slice(1).map((t, i) => t - perf.pub[i]!).filter((g) => g < 2000);
  log(`the host: a step ${q(perf.step, 0.5).toFixed(2)} ms (p95 ${q(perf.step, 0.95).toFixed(2)}); frames every ${q(gaps, 0.5)} ms (p95 ${q(gaps, 0.95)}, max ${Math.max(...gaps)})`);
  for (const [name, tab] of pages) for (const e of tab.errors.splice(0)) problem(`${name}: ${e}`);
  writeFileSync(`${out}/report.txt`, [...problems.map((p) => `PROBLEM ${p}`), ...warnings.map((w) => `warning: ${w}`)].join("\n") + "\n");
  log(`${problems.length ? `${problems.length} problems` : "no problems"}, ${warnings.length} warnings in ${((Date.now() - started) / 1000).toFixed(0)} s; screenshots in ${out}${shots ? `, pictures in ${shots}` : ""}`);
  if (problems.length) failed = true;
  waiting = "tvpipe to end";
  await win.eval(`document.getElementById("quit")?.click(); true`).catch(() => {});
  await Promise.race([tvpipe.exited, sleep(3000)]);
} catch (err) {
  failed = true;
  log(`FAILED: ${(err as Error).message}`);
  if (debug) log((err as Error).stack ?? "");
  if (tvpipe) writeFileSync(`${out}/tvpipe.log`, tvpipe.lines.join("\n"));
} finally {
  cleanup();
}
process.exit(failed ? 1 : 0);
