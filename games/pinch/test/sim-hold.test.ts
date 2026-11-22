import assert from "node:assert/strict";
import { test } from "node:test";

import { holdTime, holdWindow } from "../game/protocol.ts";
import { Heist } from "../game/sim.ts";
import { doorMap, kinds, kitEstate, kitHeist, openMap, put, steps } from "./sim-kit.ts";

/** A guard G at (5,3) facing east with the light on, the thief at (tx,ty), one step taken (the lag window has an entry). */
function setup(tx: number, ty: number, o: { dark?: boolean; guards?: string[]; angle?: number } = {}): Heist {
  const h = kitHeist(kitEstate(openMap(o.dark)), o.guards ?? ["G", "H"]);
  put(h, "G", 5, 3, o.angle ?? 0);
  put(h, "H", 20, 1, 180);
  put(h, "T", tx, ty);
  h.flashlight("G", true);
  steps(h, 10);
  return h;
}

test("hold time by guards: 10 s with 2, 0.8 s less per extra guard, at least 6 s", () => {
  assert.equal(holdTime(1), 10);
  assert.equal(holdTime(2), 10);
  assert.ok(Math.abs(holdTime(3) - 9.2) < 1e-9);
  assert.ok(Math.abs(holdTime(5) - 7.6) < 1e-9);
  assert.equal(holdTime(7), 6);
  assert.equal(holdTime(8), 6);
  const e = kitEstate(openMap());
  assert.equal(kitHeist(e, ["A", "B"]).holdTime, 10);
  assert.ok(Math.abs(kitHeist(e, ["A", "B", "C", "D"]).holdTime - 8.4) < 1e-9);
  assert.equal(kitHeist(e, ["A", "B", "C", "D", "E", "F", "G"]).holdTime, 6);
  assert.equal(kitHeist(e, ["A", "B"], [], { holdTime: 3 }).holdTime, 3);
});

test("the flashlight takes 0.5 s to switch on; off at once", () => {
  const h = kitHeist(kitEstate(openMap()), ["G", "H"]);
  assert.equal(h.hold("G"), "lightOff");
  h.flashlight("G", true);
  steps(h, 9);
  assert.equal((h.frame("G")!.me as { light: string }).light, "warming");
  steps(h, 1);
  assert.equal((h.frame("G")!.me as { light: string }).light, "on");
  h.flashlight("G", false);
  assert.equal((h.frame("G")!.me as { light: string }).light, "off");
  assert.equal(h.flashlight("T", true), "role");
});

test("hold in the cone, within 5 tiles, in sight: both frozen", () => {
  const h = setup(9, 3);
  assert.equal((h.frame("G")!.me as { canHold: boolean }).canHold, true);
  assert.ok(h.frame("G")!.me.offers.some((o) => o.a === "hold"));
  assert.equal(h.hold("G", "T"), null);
  assert.deepEqual(kinds(h).slice(-1), ["held"]);
  const hold = h.peekHold()!;
  assert.equal(hold.guard, "G");
  assert.equal(hold.total, 10);
  assert.equal(h.go("T", 20, 3), "held");
  assert.equal(h.go("G", 20, 3), "holding");
  assert.equal(h.firecracker("T", 9, 1), "held");
  assert.equal(h.hold("H"), "alreadyHeld");
  const before = h.peek("T")!;
  steps(h, 20);
  assert.equal(h.peek("T")!.x, before.x);
  assert.equal(h.peek("T")!.frozen, true);
  assert.equal(h.peek("G")!.frozen, true);
  const seenByT = h.frame("T")!.others.find((o) => o.id === "G")!;
  assert.deepEqual([seenByT.held, seenByT.holding], [true, true]);
  const seenByG = h.frame("G")!.others.find((o) => o.id === "T")!;
  assert.deepEqual([seenByG.held, seenByG.holding], [true, false]);
  // public: the thief's place, never the guard's
  const pub = h.publicLayer();
  assert.equal(pub.holds.length, 0, "not until the next delta");
  h.publicDelta();
  const ph = h.publicLayer().holds[0]!;
  assert.equal(ph.x, 9.5);
  assert.equal(ph.y, 3.5);
  assert.ok(!JSON.stringify(h.publicLayer()).includes('"x":5.5'));
});

test("hold refused out of the cone, out of range, unlit; a miss costs 2 s", () => {
  let h = setup(5, 1); // north of the guard, who faces east
  assert.equal(h.hold("G"), "notInLight");
  assert.equal(h.hold("G"), "cooldown");
  steps(h, 39);
  assert.equal(h.hold("G"), "cooldown");
  steps(h, 1);
  assert.equal(h.hold("G"), "notInLight");
  h = setup(11, 3); // 6 tiles: in the cone (7) but beyond the hold's 5
  assert.equal(h.hold("G"), "tooFar");
  h = setup(10, 3); // exactly 5
  assert.equal(h.hold("G"), null);
  h = setup(9, 3);
  h.flashlight("G", false);
  assert.equal(h.hold("G"), "lightOff");
  assert.equal(h.hold("T"), "role");
  assert.equal(h.hold("G", "H"), "invalid");
  // in the dark: the beam lights the thief
  h = setup(9, 3, { dark: true });
  assert.equal(h.hold("G"), null);
  // in the dark, out of the cone
  h = setup(5, 1, { dark: true });
  assert.equal(h.hold("G"), "notInLight");
});

test("hold refused behind a closed door, fine through the open one", () => {
  const mk = () => {
    const h = kitHeist(kitEstate(doorMap()), ["G", "H"]);
    put(h, "G", 9, 2, 0);
    put(h, "H", 11, 1);
    put(h, "T", 14, 2);
    h.flashlight("G", true);
    steps(h, 10);
    return h;
  };
  let h = mk();
  assert.equal(h.hold("G"), "notInSight");
  h = mk();
  assert.equal(h.door("H", 0), null);
  steps(h, 6);
  assert.equal(h.peekDoors()[0], 1);
  assert.equal(h.hold("G"), null);
  // a door closing between them breaks the hold
  assert.equal(h.door("H", 0), null);
  assert.equal(h.peekDoors()[0], 0);
  steps(h, 1);
  assert.equal(h.peekHold(), null);
  assert.deepEqual(kinds(h).slice(-2), ["held", "holdBroken"]);
});

test("the 250 ms lag window", () => {
  const mk = (after: number) => {
    const h = setup(9, 3);
    put(h, "T", 5, 1); // out of the cone now
    steps(h, after);
    return h;
  };
  assert.equal(mk(5).hold("G"), null, "an entry 250 ms old counts");
  assert.equal(mk(6).hold("G"), "notInLight", "300 ms is too old");
  // the HOLD button shows only what is true now
  const h = mk(1);
  assert.equal((h.frame("G")!.me as { canHold: boolean }).canHold, false);
});

test("breaking: the light off; then 5 s of immunity", () => {
  const h = setup(9, 3);
  h.flashlight("H", true);
  put(h, "H", 13, 3, 180);
  steps(h, 10);
  assert.equal(h.hold("G"), null);
  steps(h, 20);
  h.flashlight("G", false);
  assert.equal(h.peekHold(), null);
  assert.deepEqual(kinds(h).slice(-1), ["holdBroken"]);
  assert.equal(h.peek("T")!.frozen, false);
  assert.equal(h.go("T", 9.5, 4.5), null);
  assert.equal(h.hold("H"), "slippery");
  assert.equal((h.frame("T")!.me as { immune: number }).immune, 5);
  steps(h, 99);
  put(h, "T", 9, 3);
  assert.equal(h.hold("H"), "slippery");
  steps(h, 1);
  assert.equal(h.hold("H"), null);
  assert.equal(h.result, null);
});

test("the hold runs out after the hold time; wriggling takes 0.15 s a tap, at most 3 s", () => {
  let h = setup(9, 3);
  assert.equal(h.hold("G"), null);
  steps(h, 199);
  assert.ok(h.peekHold());
  steps(h, 1);
  assert.equal(h.peekHold(), null);
  assert.deepEqual(kinds(h).slice(-1), ["holdSlipped"]);

  h = setup(9, 3);
  assert.equal(h.hold("G"), null);
  assert.equal(h.wriggle("G"), "holding");
  assert.equal(h.wriggle("T"), null);
  assert.equal(h.wriggle("T"), null); // the same step: counts once
  assert.ok(Math.abs(h.peekHold()!.wriggled - 0.15) < 1e-9);
  for (let k = 0; k < 30; k++) {
    h.step();
    h.wriggle("T");
  }
  assert.ok(Math.abs(h.peekHold()!.wriggled - 3) < 1e-9);
  // held at 0.5 s for 10 s, 3 s wriggled off: free at 7.5 s; now 2.0 s
  assert.ok(Math.abs(h.peekHold()!.until - 7.5) < 1e-9);
  assert.ok(Math.abs(h.t - 2) < 1e-9);
  steps(h, 109);
  assert.ok(h.peekHold());
  steps(h, 1);
  assert.equal(h.peekHold(), null);
  assert.equal(h.wriggle("T"), "nothingHere");
});

test("arrest: a second guard within 1.5 tiles of a held thief; not the holder, not without a hold", () => {
  let h = setup(6, 3); // the holder 1 tile from the thief
  put(h, "H", 7, 4); // a second guard 1.41 away, no hold: nothing
  steps(h, 5);
  assert.equal(h.result, null);
  put(h, "H", 20, 1);
  assert.equal(h.hold("G"), null);
  steps(h, 20);
  assert.equal(h.result, null, "the holder alone cannot arrest");
  put(h, "H", 8, 3); // 2 tiles: not yet
  steps(h, 1);
  assert.equal(h.result, null);
  assert.equal(h.go("H", 7.5, 3.5), null);
  steps(h, 12);
  const r = h.result!;
  assert.ok(r);
  assert.equal(r.outcome, "pinched");
  assert.equal(r.holder, "G");
  assert.equal(r.arrester, "H");
  assert.equal(r.haul, 0);
  assert.equal(r.stats["G"]!.holds, 1);
  assert.equal(r.stats["H"]!.arrests, 1);
  assert.deepEqual(kinds(h).slice(-2), ["held", "arrest"]);
  assert.equal(h.go("T", 1, 1), "over");
  h.publicDelta();
  assert.equal(h.publicLayer().end?.outcome, "pinched");
  assert.equal(h.publicLayer().arrest?.guard, "H");
});

test("the holder aims at the thief", () => {
  const h = setup(9, 4, { angle: 10 });
  assert.equal(h.hold("G"), null);
  steps(h, 1);
  const g = h.peek("G")!;
  assert.ok(Math.abs(g.angle - (Math.atan2(1, 4) * 180) / Math.PI) < 0.01);
});

test("frozen in a hold: the holder may only mark (and keep or drop the light), the thief only wriggle", () => {
  const h = setup(9, 3);
  assert.equal(h.hold("G"), null);
  // the holder
  assert.equal(h.mark("G", "look", 9.5, 3.5), null);
  assert.equal(h.ticker.at(-1)!.k, "look");
  const id = h.publicDelta().marks?.[0]?.id;
  assert.ok(id);
  assert.equal(h.unmark("G", id), null);
  assert.equal(h.mark("G", "seen", 9.5, 3.5, 0), null);
  for (const a of [
    { a: "go", x: 2.5, y: 2.5 }, { a: "stop" }, { a: "door", door: 0 }, { a: "climb", window: 0 }, { a: "switch", room: 0 },
    { a: "hold" }, { a: "take", item: 0 }, { a: "wriggle" },
  ]) assert.equal(h.act("G", a), "holding", JSON.stringify(a));
  assert.equal(h.flashlight("G", true), null, "keeping the light on is fine");
  assert.ok(h.peekHold());
  // the thief
  for (const a of [
    { a: "go", x: 2.5, y: 2.5 }, { a: "stop" }, { a: "door", door: 0 }, { a: "pick", door: 0 }, { a: "climb", window: 0 }, { a: "switch", room: 0 },
    { a: "take", item: 0 }, { a: "smash", lamp: 0 }, { a: "tamper", camera: 0 }, { a: "strip" }, { a: "firecracker", x: 9.5, y: 1.5 },
    { a: "mark", kind: "look", x: 1, y: 1 }, { a: "flashlight", on: true }, { a: "hold" },
  ]) assert.equal(h.act("T", a), "held", JSON.stringify(a));
  assert.equal(h.wriggle("T"), null);
  assert.deepEqual(h.offers("T"), [{ a: "wriggle", button: "wriggle" }]);
  assert.deepEqual(h.offers("G"), []);
  // positions untouched
  steps(h, 20);
  assert.deepEqual([h.peek("G")!.x, h.peek("T")!.x], [5.5, 9.5]);
  // the light off still breaks it
  assert.equal(h.flashlight("G", false), null);
  assert.equal(h.peekHold(), null);
  assert.equal(h.go("G", 2.5, 2.5), null);
  assert.equal(h.go("T", 12.5, 3.5), null);
});

test("the lag window grows with the action's age: 2 × age + 150 ms, 250–500 ms", () => {
  assert.equal(holdWindow(undefined), 0.25);
  assert.equal(holdWindow(NaN), 0.25);
  assert.equal(holdWindow(-1), 0.25);
  assert.equal(holdWindow(0), 0.25);
  assert.ok(Math.abs(holdWindow(0.15) - 0.45) < 1e-9);
  assert.equal(holdWindow(0.3), 0.5);
  assert.equal(holdWindow(5), 0.5);
  /** The thief leaves the cone; the hold arrives `after` steps later, `age` seconds old (null: no sentAt). */
  const exit = (after: number, age: number | null) => {
    const h = setup(9, 3);
    put(h, "T", 5, 1); // out of the cone from now on
    steps(h, after);
    return age === null ? h.hold("G") : h.act("G", { a: "hold" }, { age });
  };
  // 150 ms each way: the guard's picture is ~400 ms behind; the window is 450 ms
  assert.equal(exit(8, 0.15), null, "a fair late hold at the exit is taken");
  assert.equal(exit(8, null), "notInLight", "without sentAt: 250 ms");
  assert.equal(exit(5, null), null);
  assert.equal(exit(6, null), "notInLight");
  assert.equal(exit(9, 0.15), null);
  assert.equal(exit(10, 0.15), "notInLight");
  // never more than 500 ms, however old
  assert.equal(exit(10, 2), null);
  assert.equal(exit(11, 2), "notInLight", "older than 500 ms is refused");
  assert.equal(exit(11, 0.4), "notInLight");
});
