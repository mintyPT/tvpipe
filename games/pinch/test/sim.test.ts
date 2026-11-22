import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeInk, inkMask } from "../game/ink.ts";
import { DOOR_CLOSED, DOOR_LOCKED, DOOR_OPEN } from "../game/move.ts";
import { applyPublic, publicState, type PublicState } from "../game/protocol.ts";
import { dir8, Heist, type HeistOptions } from "../game/sim.ts";
import { doorMap, kinds, kitCatalogue, kitEstate, kitHeist, lootCatalogue, lootEstate, openMap, put, steps } from "./sim-kit.ts";

const loot = (guards = ["G", "H"], opts = {}) => kitHeist(lootEstate(), guards, lootCatalogue(), opts);
const slots = (h: Heist) => h.peek("T")!.slots;
const res = (h: Heist) => h.result;

test("the start: the thief at the car, guards in the security office, the ticker starts", () => {
  const e = kitEstate(openMap(), { car: 1 });
  const h = kitHeist(e, ["G", "H"]);
  const t = h.peek("T")!;
  assert.ok(t.x >= 23 && t.x < 25 && Math.floor(t.y) === 8);
  for (const g of ["G", "H"]) assert.equal(e.map.roomAt[Math.floor(h.peek(g)!.y) * e.map.w + Math.floor(h.peek(g)!.x)], 0);
  assert.deepEqual(kinds(h), ["start"]);
  assert.equal(h.left, 210);
  assert.equal(h.thief, "T");
  assert.deepEqual(h.guards, ["G", "H"]);
});

test("taking: loose 0.6 s quiet, case 2 s with glass, safe 5 s quiet; slots; reach and sight", () => {
  const h = loot();
  assert.equal(h.take("T", 3), "nothingHere", "not seen from the car");
  put(h, "T", 8, 3);
  assert.equal(h.take("T", 1), "tooFar");
  assert.equal(h.take("G", 3), "role");
  assert.equal(h.take("T", 99), "nothingHere");
  assert.ok(h.frame("T")!.me.offers.some((o) => o.a === "take" && o.item === 3));
  assert.equal(h.take("T", 3), null);
  assert.equal(h.take("T", 3), "busy");
  steps(h, 11);
  assert.deepEqual(slots(h), []);
  steps(h, 1);
  assert.deepEqual(slots(h), [3]);
  assert.equal(h.take("T", 3), "nothingHere");
  assert.deepEqual(kinds(h), ["start"], "quiet");

  put(h, "T", 10, 3);
  assert.equal(h.take("T", 2), null);
  assert.deepEqual(kinds(h).slice(-1), ["glass"], "the glass breaks at once");
  h.publicDelta();
  assert.equal(h.publicLayer().noises[0]?.kind, "glass");
  steps(h, 39);
  assert.deepEqual(slots(h), [3]);
  steps(h, 1);
  assert.deepEqual(slots(h), [3, 2]);

  put(h, "T", 12, 3);
  assert.equal(h.take("T", 1), null);
  steps(h, 99);
  assert.deepEqual(slots(h), [3, 2]);
  steps(h, 1);
  assert.deepEqual(slots(h), [3, 2, 1]);
  assert.equal(kinds(h).filter((k) => k === "glass").length, 1);
  const me = h.frame("T")!.me as { free: number; slots: { item: number; tagged: boolean }[] };
  assert.equal(me.free, 0);
  assert.deepEqual(me.slots, [{ item: 3, tagged: false }, { item: 2, tagged: false }, { item: 1, tagged: true }]);
  put(h, "T", 14, 3);
  assert.equal(h.take("T", 0), "handsFull");
});

test("walking away cancels taking", () => {
  const h = loot();
  put(h, "T", 12, 3);
  assert.equal(h.take("T", 1), null);
  steps(h, 50);
  assert.equal(h.go("T", 9.5, 3.5), null);
  steps(h, 100);
  assert.deepEqual(slots(h), []);
  assert.equal(h.peekItems()[1]!.taken, null);
});

test("the pedestal: 1 s, then the police alarm sets the clock to 60 s", () => {
  const h = loot();
  put(h, "T", 14, 3);
  assert.equal(h.take("T", 0), null);
  steps(h, 19);
  assert.equal(h.left > 200, true);
  steps(h, 1);
  assert.deepEqual(slots(h), [0]);
  assert.equal(h.left, 60);
  const ev = h.ticker.at(-1)!;
  assert.equal(ev.k, "alarm");
  assert.deepEqual(ev.k === "alarm" && ev.where, { room: 1 });
  h.publicDelta();
  assert.deepEqual(h.publicLayer().alarm, { t: 1, room: 1, x: 14.5, y: 2.5 });
  // an alarm with less than 60 s left keeps the clock
  const h2 = loot(["G", "H"], { length: 30 });
  put(h2, "T", 14, 3);
  h2.take("T", 0);
  steps(h2, 20);
  assert.ok(h2.left < 30 && h2.left > 28);
});

test("discovered thefts: a guard sees the empty place", () => {
  const h = loot();
  put(h, "T", 8, 3);
  h.take("T", 3);
  steps(h, 12);
  put(h, "T", 17, 4);
  steps(h, 5);
  assert.ok(!kinds(h).includes("missing"), "nobody saw it yet");
  put(h, "G", 4, 2); // in the security office: the loot room's door is closed
  steps(h, 5);
  assert.ok(!kinds(h).includes("missing"));
  put(h, "G", 9, 4);
  steps(h, 1);
  const ev = h.ticker.at(-1)!;
  assert.equal(ev.k, "missing");
  assert.equal(ev.k === "missing" && ev.item, 3);
  h.publicDelta();
  assert.deepEqual(h.publicLayer().missing.map((m) => [m.item, m.room, m.x, m.y]), [[3, 1, 8, 2]]);
  const f = h.frame("G")!;
  assert.deepEqual(f.empty, [{ item: 3, x: 8, y: 2, keep: "loose" }]);
});

test("tags: a ping every 20 s give or take; the workbench strips them in 3 s", () => {
  const h = loot();
  put(h, "T", 12, 3);
  h.take("T", 1); // the egg, tagged
  steps(h, 100);
  assert.deepEqual(slots(h), [1]);
  assert.equal((h.frame("T")!.me as { ping: number | null }).ping, 20);
  steps(h, 399);
  assert.ok(!kinds(h).includes("ping"));
  steps(h, 1);
  assert.deepEqual(kinds(h).slice(-1), ["ping"]);
  h.publicDelta();
  const p = h.publicLayer().pings[0]!;
  const t = h.peek("T")!;
  assert.ok(Math.hypot(p.x - t.x, p.y - t.y) <= 2.25 + 0.01);
  assert.equal(p.r, 3);
  // the ink restarted as a disc around the ping: the thief's tile is inked, the far lawn is not
  const ink = decodeInk(h.publicLayer().ink, inkMask(h.map))!;
  assert.equal(ink[3 * h.map.w + 12], 1);
  assert.equal(ink[8 * h.map.w + 1], 0);
  steps(h, 400);
  assert.equal(kinds(h).filter((k) => k === "ping").length, 2);
  // strip
  assert.equal(h.strip("T"), "tooFar");
  put(h, "T", 16, 3);
  assert.ok(h.frame("T")!.me.offers.some((o) => o.a === "strip"));
  assert.equal(h.strip("T"), null);
  steps(h, 59);
  assert.equal((h.frame("T")!.me as { slots: { tagged: boolean }[] }).slots[0]!.tagged, true);
  steps(h, 1);
  assert.equal((h.frame("T")!.me as { slots: { tagged: boolean }[] }).slots[0]!.tagged, false);
  assert.equal((h.frame("T")!.me as { ping: number | null }).ping, null);
  steps(h, 500);
  assert.equal(kinds(h).filter((k) => k === "ping").length, 2);
  assert.equal(h.strip("T"), "nothingHere");
  assert.equal(h.strip("G"), "role");
});

test("firecrackers: two, up to 8 tiles, in sight, bang after 1 s", () => {
  const h = kitHeist(kitEstate(openMap()), ["G", "H"]);
  put(h, "T", 5, 8);
  assert.equal(h.firecracker("T", 15.5, 8.5), "tooFar");
  assert.equal(h.firecracker("T", 5.5, 3.5), "notInSight");
  assert.equal(h.firecracker("G", 6.5, 8.5), "role");
  assert.equal(h.firecracker("T", 12.5, 8.5), null);
  assert.equal((h.frame("T")!.me as { firecrackers: number }).firecrackers, 1);
  steps(h, 19);
  assert.ok(!kinds(h).includes("firecracker"));
  steps(h, 1);
  assert.deepEqual(kinds(h).slice(-1), ["firecracker"]);
  h.publicDelta();
  assert.deepEqual(h.publicLayer().noises.map((n) => [n.kind, n.x, n.y]), [["firecracker", 12.5, 8.5]]);
  assert.equal(h.firecracker("T", 8.5, 8.5), null);
  assert.equal(h.firecracker("T", 8.5, 8.5), "noFirecrackers");
  steps(h, 90);
  h.publicDelta();
  assert.equal(h.publicLayer().noises.length, 0, "ripples fade after 3 s");
});

test("cameras: a sighting in the lit cone; tampering 2 s; the dark hides", () => {
  const cams = [{ x: 0, y: 3, angle: 0 }];
  const h = kitHeist(kitEstate(openMap(), { cameras: cams }), ["G", "H"]);
  put(h, "T", 4, 3, 90);
  steps(h, 1);
  assert.deepEqual(kinds(h).slice(-1), ["sighting"]);
  h.publicDelta();
  assert.deepEqual(h.publicLayer().cameras[0], { id: 0, tampered: false, sees: { x: 4.5, y: 3.5, facing: 90 } });
  const ink = decodeInk(h.publicLayer().ink, inkMask(h.map))!;
  assert.equal(ink[3 * h.map.w + 4], 1);
  assert.equal(ink[8 * h.map.w + 3], 0, "the ink restarted from the sighting");
  steps(h, 10);
  assert.equal(kinds(h).filter((k) => k === "sighting").length, 1, "one line a sighting");
  put(h, "T", 4, 1); // out of the cone
  steps(h, 1);
  h.publicDelta();
  assert.equal(h.publicLayer().cameras[0]!.sees, null);
  // tamper
  assert.equal(h.tamper("T", 0), "tooFar");
  put(h, "T", 1, 3);
  assert.equal(h.tamper("G", 0), "role");
  assert.ok(h.frame("T")!.me.offers.some((o) => o.a === "tamper"));
  assert.equal(h.tamper("T", 0), null);
  steps(h, 39);
  assert.ok(!kinds(h).includes("tampered"));
  steps(h, 1);
  assert.deepEqual(kinds(h).slice(-1), ["tampered"]);
  put(h, "T", 4, 3);
  steps(h, 5);
  assert.deepEqual(kinds(h).slice(-1), ["tampered"]);
  h.publicDelta();
  assert.deepEqual(h.publicLayer().cameras[0], { id: 0, tampered: true, sees: null });
  assert.equal(h.tamper("T", 0), "nothingHere");

  const dark = kitHeist(kitEstate(openMap(true), { cameras: cams }), ["G", "H"]);
  put(dark, "T", 4, 3);
  steps(dark, 5);
  assert.ok(!kinds(dark).includes("sighting"));
});

test("doors: walking through opens with a 0.3 s pause; locked: guards open, the thief picks in 3 s", () => {
  const time = (locked: boolean, who: string) => {
    const h = kitHeist(kitEstate(doorMap(locked)), ["G", "H"]);
    put(h, who, 10, 2);
    assert.equal(h.go(who, 15.5, 2.5), null);
    let k = 0;
    while (h.peekDoors()[0] !== DOOR_OPEN && k < 200) {
      h.step();
      k++;
    }
    steps(h, 40);
    assert.ok(h.peek(who)!.x > 15, `${who} through`);
    return k * 0.05;
  };
  const guard = time(false, "G");
  assert.ok(guard > 0.6 && guard < 0.7, `${guard}`); // 1.2 tiles to touch it, then the pause
  assert.ok(Math.abs(time(true, "G") - guard) < 1e-6, "guards have the keys");
  const thief = time(true, "T");
  assert.ok(Math.abs(thief - guard - 2.7) < 0.06, `${thief}`);
  assert.ok(Math.abs(time(false, "T") - guard) < 1e-6);
});

test("doors: the action opens, closes; refused out of reach and with someone in the doorway; pick", () => {
  const h = kitHeist(kitEstate(doorMap(true)), ["G", "H"]);
  put(h, "T", 11, 2);
  put(h, "G", 2, 1);
  assert.equal(h.door("G", 0), "tooFar");
  assert.equal(h.pick("G", 0), "role");
  assert.deepEqual(h.frame("T")!.me.offers.filter((o) => o.a === "pick"), [{ a: "pick", door: 0, button: "pickLock" }]);
  assert.equal(h.pick("T", 0), null);
  assert.equal(h.frame("T")!.me.busy?.kind, "pick");
  steps(h, 59);
  assert.equal(h.peekDoors()[0], DOOR_LOCKED);
  steps(h, 1);
  assert.equal(h.peekDoors()[0], DOOR_OPEN);
  assert.equal(h.pick("T", 0), "nothingHere");
  put(h, "H", 12, 2); // in the doorway
  assert.equal(h.door("T", 0), "blocked");
  put(h, "H", 20, 1);
  assert.equal(h.door("T", 0), null);
  assert.equal(h.peekDoors()[0], DOOR_CLOSED);
  assert.equal(h.door("T", 0), null);
  steps(h, 5);
  assert.equal(h.peekDoors()[0], DOOR_CLOSED);
  steps(h, 1);
  assert.equal(h.peekDoors()[0], DOOR_OPEN);
  assert.equal(h.door("T", 7), "invalid");
});

test("windows: anyone climbs in 1.2 s", () => {
  const h = kitHeist(kitEstate(openMap()), ["G", "H"]);
  put(h, "G", 5, 5);
  assert.ok(h.frame("G")!.me.offers.some((o) => o.a === "climb" && o.window === 0));
  assert.equal(h.climb("G", 0), null);
  steps(h, 23);
  assert.equal(h.peek("G")!.y, 5.5);
  steps(h, 1);
  assert.deepEqual([h.peek("G")!.x, h.peek("G")!.y], [5.5, 7.5]);
  assert.equal(h.climb("G", 0), null);
  steps(h, 24);
  assert.deepEqual([h.peek("G")!.x, h.peek("G")!.y], [5.5, 5.5]);
  put(h, "T", 9, 3);
  assert.equal(h.climb("T", 0), "tooFar");
});

test("switches: from a switch tile, a public fact", () => {
  const h = kitHeist(kitEstate(openMap()), ["G", "H"]);
  put(h, "G", 5, 3);
  assert.equal(h.switchLight("G", 0), "tooFar");
  put(h, "G", 12, 5);
  assert.deepEqual(h.frame("G")!.me.offers.filter((o) => o.a === "switch"), [{ a: "switch", room: 0, button: "lightsOff" }]);
  assert.equal(h.switchLight("G", 0), null);
  assert.deepEqual(kinds(h).slice(-1), ["lightsOff"]);
  h.publicDelta();
  assert.deepEqual(h.publicLayer().rooms, [0]);
  assert.equal(h.switchLight("G", 0), null);
  assert.deepEqual(kinds(h).slice(-1), ["lightsOn"]);
  h.switchLight("G", 0);
  steps(h, 1);
  assert.equal(h.tape().result.stats["G"]!.lightsOff, 2);
});

test("lamps: the thief smashes one in 1 s, a noise; it stays dark", () => {
  const h = kitHeist(kitEstate(openMap()), ["G", "H"]);
  put(h, "T", 18, 8);
  assert.equal(h.smash("G", 0), "role");
  assert.equal(h.smash("T", 0), null);
  steps(h, 19);
  assert.ok(!kinds(h).includes("lamp"));
  steps(h, 1);
  assert.deepEqual(kinds(h).slice(-1), ["lamp"]);
  h.publicDelta();
  assert.deepEqual(h.publicLayer().lamps, [0]);
  assert.equal(h.publicLayer().noises[0]?.kind, "lamp");
  assert.equal(h.smash("T", 0), "nothingHere");
});

test("the car: walking back into the real spot gets away with the haul; another spot does nothing", () => {
  const e = kitEstate(openMap(), { car: 1 });
  const h = kitHeist(e, ["G", "H"], kitCatalogue([]));
  steps(h, 10);
  assert.equal(h.result, null, "starting in the car is not getting away");
  assert.equal(h.frame("T")!.me.role, "thief");
  assert.equal((h.frame("T")!.me as { car: number }).car, 1);
  h.go("T", 3.5, 8.5); // spot 0: a decoy
  steps(h, 120);
  assert.equal(h.result, null);
  h.go("T", 23.5, 8.5);
  steps(h, 200);
  assert.equal(res(h)?.outcome, "gotAway");
  assert.deepEqual(kinds(h).slice(-1), ["gotAway"]);

  const h2 = loot();
  put(h2, "T", 8, 3);
  h2.take("T", 3);
  steps(h2, 12);
  put(h2, "T", 3, 6);
  h2.go("T", 1.5, 7.5);
  steps(h2, 40);
  assert.equal(res(h2)?.outcome, "gotAway");
  assert.equal(res(h2)?.haul, 300);
  assert.deepEqual(res(h2)?.taken, [3]);
});

test("time's up: pinched by the police; the last minute is announced", () => {
  const h = kitHeist(kitEstate(openMap()), ["G", "H"], [], { length: 61 });
  steps(h, 19);
  assert.ok(!kinds(h).includes("lastMinute"));
  steps(h, 1);
  assert.deepEqual(kinds(h).slice(-1), ["lastMinute"]);
  steps(h, 1199);
  assert.equal(h.result, null);
  steps(h, 1);
  assert.equal(res(h)?.outcome, "police");
  assert.equal(res(h)?.haul, 0);
  assert.deepEqual(kinds(h).slice(-1), ["timeUp"]);
  const t = h.t;
  steps(h, 10);
  assert.equal(h.t, t, "nothing happens once over");
});

test("the thief leaving: 10 s away ends the heist; a guard away stands still", () => {
  const h = kitHeist(kitEstate(openMap()), ["G", "H"]);
  h.go("G", 20.5, 3.5);
  h.setAway("G", true);
  const g = h.peek("G")!;
  steps(h, 20);
  assert.deepEqual([h.peek("G")!.x, h.peek("G")!.y], [g.x, g.y]);
  h.setAway("T", true);
  steps(h, 100);
  h.setAway("T", false);
  h.setAway("T", true);
  steps(h, 199);
  assert.equal(h.result, null);
  steps(h, 1);
  assert.equal(res(h)?.outcome, "left");
  assert.deepEqual(kinds(h).slice(-1), ["left"]);
});

test("marks: at most 3, the 4th replaces the oldest, 90 s; Clear snaps and clears the ink; lies", () => {
  const h = kitHeist(kitEstate(openMap()), ["G", "H"]);
  steps(h, 200); // the ink has reached the room by now
  let pub = publicState(h.publicLayer(), h.map)!;
  const pd = h.publicDelta();
  pub = applyPublic(pub, pd, h.map)!;
  const roomTiles = (p: PublicState) => {
    let n = 0;
    for (let i = 0; i < p.ink.length; i++) if (p.ink[i] && h.map.roomAt[i] === 0) n++;
    return n;
  };
  assert.ok(roomTiles(pub) > 50);
  assert.equal(h.mark("T", "clear", 5, 3), "role");
  assert.equal(h.mark("G", "clear", 5.2, 3.7), null);
  const e = h.ticker.at(-1)!;
  assert.equal(e.k, "clear");
  assert.deepEqual(e.k === "clear" && e.where, { room: 0 });
  pub = applyPublic(pub, h.publicDelta(), h.map)!;
  assert.equal(roomTiles(pub), 0, "cleared");
  assert.equal(pub.marks.length, 1);
  assert.equal(h.mark("G", "seen", 7, 3, 90), null);
  assert.equal(h.mark("G", "look", 9, 3), null);
  assert.equal((h.frame("G")!.me as { marksLeft: number }).marksLeft, 0);
  assert.equal(h.mark("G", "post", 12.4, 7.2), null);
  pub = applyPublic(pub, h.publicDelta(), h.map)!;
  assert.deepEqual(pub.marks.map((m) => m.kind), ["seen", "look", "post"]);
  assert.equal(pub.marks[0]!.dir, "s");
  assert.deepEqual(pub.marks[2]!.where, { door: 0 }, "Post snaps to the door");
  assert.equal(h.unmark("G", pub.marks[1]!.id), null);
  assert.equal(h.unmark("H", pub.marks[0]!.id), "nothingHere");
  steps(h, 1799);
  pub = applyPublic(pub, h.publicDelta(), h.map)!;
  assert.equal(pub.marks.length, 2);
  steps(h, 1);
  pub = applyPublic(pub, h.publicDelta(), h.map)!;
  assert.equal(pub.marks.length, 0, "faded after 90 s");
  const tape = h.tape();
  // the Post at the door: G never went there (it stood in the office)
  assert.deepEqual(tape.truth.marks.map((m) => [m.kind, m.lie]), [["clear", false], ["seen", false], ["look", false], ["post", true]]);
  assert.ok(tape.moments.some((m) => m.k === "liePost"));
  assert.equal(tape.result.stats["G"]!.lies, 1);
});

test("a Clear with the thief inside is a lie; a Post where one stands is not", () => {
  const h = kitHeist(kitEstate(openMap()), ["G", "H"]);
  put(h, "T", 20, 4);
  put(h, "G", 12, 5);
  assert.equal(h.mark("G", "clear", 3, 3), null);
  assert.equal(h.mark("G", "post", 12.5, 5.5), null);
  steps(h, 1);
  const tape = h.tape();
  assert.deepEqual(tape.truth.marks.map((m) => [m.kind, m.lie]), [["clear", true], ["post", false]]);
  assert.ok(tape.moments.some((m) => m.k === "lieClear"));
});

test("dir8: the Seen arrow", () => {
  assert.equal(dir8(0), "e");
  assert.equal(dir8(45), "se");
  assert.equal(dir8(90), "s");
  assert.equal(dir8(180), "w");
  assert.equal(dir8(270), "n");
  assert.equal(dir8(-45), "ne");
  assert.equal(dir8(NaN), "e");
});

test("the ink starts on every parking spot", () => {
  const h = kitHeist(kitEstate(openMap()), ["G", "H"]);
  const ink = decodeInk(h.publicLayer().ink, inkMask(h.map))!;
  for (const s of h.map.spots) for (let x = s.rect.x; x < s.rect.x + s.rect.w; x++) assert.equal(ink[s.rect.y * h.map.w + x], 1);
  assert.equal(ink[3 * h.map.w + 5], 0);
});

test("the guards' flashlight follows walking; aiming only standing", () => {
  const h = kitHeist(kitEstate(openMap()), ["G", "H"]);
  put(h, "G", 5, 3, 0);
  h.aim("G", 123);
  assert.equal(h.peek("G")!.angle, 123);
  h.go("G", 5.5, 1.5);
  steps(h, 2);
  assert.ok(Math.abs(h.peek("G")!.angle - 270) < 1);
  h.aim("G", 10);
  assert.ok(Math.abs(h.peek("G")!.angle - 270) < 1, "ignored while walking");
  steps(h, 20);
  h.aim("G", 10);
  assert.equal(h.peek("G")!.angle, 10);
});

test("leave: the thief ends the heist at once; a guard stays away for good; timeUp runs the clock out", () => {
  let h = kitHeist(kitEstate(openMap()), ["G", "H"]);
  h.leave("G");
  h.setAway("G", false);
  const g = h.peek("G")!;
  assert.equal(h.go("G", 20.5, 3.5), null);
  steps(h, 20);
  assert.deepEqual([h.peek("G")!.x, h.peek("G")!.y], [g.x, g.y], "gone guards stand still");
  h.leave("T");
  assert.equal(res(h)?.outcome, "left");
  assert.deepEqual(kinds(h).slice(-1), ["left"]);
  h = kitHeist(kitEstate(openMap()), ["G", "H"]);
  h.timeUp();
  assert.equal(h.result, null);
  h.step();
  assert.equal(res(h)?.outcome, "police");
});

test("options take any numbers (Timings is widened)", () => {
  const opts: HeistOptions = { length: 99, times: { awayLimit: 3, holdRange: 4.5, take: { loose: 1, case: 1, safe: 1, pedestal: 1 } } };
  const h = kitHeist(kitEstate(openMap()), ["G", "H"], [], opts);
  assert.equal(h.times.awayLimit, 3);
  assert.equal(h.times.pick, 3, "the rest stay");
  h.setAway("T", true);
  steps(h, 60);
  assert.equal(res(h)?.outcome, "left");
});
