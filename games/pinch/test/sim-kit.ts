/** Helpers for the simulation's tests: estates from ASCII maps, catalogues, stepping. */

import assert from "node:assert/strict";

import { itemById, type NightItem } from "../game/items.ts";
import { CAMERA_FOV, CAMERA_RANGE, parseAscii, propAccess, wingOf, type Estate, type Keep, type Place } from "../game/map.ts";
import { Heist, type HeistOptions } from "../game/sim.ts";

export interface KitPlace {
  x: number;
  y: number;
  keep: Keep;
}

/** An estate from rows (map.ts `parseAscii`) with loot places on furniture tiles, cameras on wall tiles and a workbench. */
export function kitEstate(
  rows: readonly string[],
  o: { car?: number; places?: KitPlace[]; cameras?: { x: number; y: number; angle: number }[]; workbench?: { x: number; y: number } } = {},
): Estate {
  const map = parseAscii(rows);
  const w = map.w;
  map.cameras = (o.cameras ?? []).map((c, id) => ({ id, x: c.x, y: c.y, i: c.y * w + c.x, angle: c.angle, fov: CAMERA_FOV, range: CAMERA_RANGE, room: -1 }));
  const propAt = (x: number, y: number) => map.props.findIndex((p) => x >= p.rect.x && y >= p.rect.y && x < p.rect.x + p.rect.w && y < p.rect.y + p.rect.h);
  if (o.workbench) {
    const prop = propAt(o.workbench.x, o.workbench.y);
    assert.ok(prop >= 0, "the workbench on furniture");
    map.workbench = { prop, room: map.props[prop]!.room, access: propAccess(map, map.props[prop]!).access };
  }
  const places: Place[] = (o.places ?? []).map((p, id) => {
    const prop = propAt(p.x, p.y);
    assert.ok(prop >= 0, `place ${id} on furniture`);
    const i = p.y * w + p.x;
    const access = [i + w, i - w, i + 1, i - 1].find((j) => map.tiles[j] === 0 && map.roomAt[j] === map.props[prop]!.room)!;
    return { id, prop, x: p.x, y: p.y, i, access, room: map.props[prop]!.room, keep: p.keep, depth: 10, wing: wingOf(map, 0, p.x, p.y) };
  });
  return { players: 3, seed: 1, attempt: 0, map, car: o.car ?? 0, places };
}

/** A catalogue: item ids (items.ts) on place indices, tagged or not. */
export function kitCatalogue(list: { id: string; place: number; tagged?: boolean }[]): NightItem[] {
  return list.map((l) => {
    const item = itemById(l.id);
    assert.ok(item, l.id);
    return { item, place: l.place, tagged: !!l.tagged };
  });
}

export function kitHeist(e: Estate, guards: string[], catalogue: NightItem[] = [], opts: HeistOptions = {}): Heist {
  return new Heist(e, { thief: "T", guards, catalogue }, opts);
}

/** Steps `n` times (50 ms each). */
export function steps(h: Heist, n: number): void {
  for (let k = 0; k < n; k++) h.step();
}

/** A tile's centre. */
export const c = (x: number, y: number) => ({ x: x + 0.5, y: y + 0.5 });

/** Puts a player on a tile's centre, facing `angle`; fails the test when it does not fit. */
export function put(h: Heist, id: string, x: number, y: number, angle = 0): void {
  assert.ok(h.place(id, x + 0.5, y + 0.5, angle), `${id} fits at ${x},${y}`);
}

/** Ticker kinds so far. */
export const kinds = (h: Heist) => h.ticker.map((e) => e.k);

/**
 * A lit room 24×5 (the security office, room 0), a door south to the
 * lawn (12,6), a window (5,6), two parking spots (spot 0 at 3–4,8; spot
 * 1 at 23–24,8), a lamp (19,8). `dark`: the room unlit.
 */
export function openMap(dark = false): string[] {
  const f = dark ? "." : ":";
  const row = "#" + f.repeat(24) + "#";
  return [
    "##########################",
    row,
    row,
    row,
    row,
    row,
    "#####'######+#############",
    ",,,,,,,,,,,,,,,,,,,,,,,,,,",
    ",,,PP,,,,,,,,,,,,,,*,,,PP,",
    ",,,,,,,,,,,,,,,,,,,,,,,,,,",
  ];
}

/** Two lit rooms (0: x 1–11, 1: x 13–23) with a door between at (12,2) (`X`: locked), a door to the lawn at (5,4), a spot. */
export function doorMap(locked = false): string[] {
  return [
    "#########################",
    "#:::::::::::#:::::::::::#",
    `#:::::::::::${locked ? "X" : "+"}:::::::::::#`,
    "#:::::::::::#:::::::::::#",
    "#####+###################",
    ",,,,,,,,,,,,,,,,,,,,,,,,,",
    ",,PP,,,,,,,,,,,,,,,,,,,,,",
    ",,,,,,,,,,,,,,,,,,,,,,,,,",
  ];
}

/** The security office (room 0, x 1–5) and a lit loot room (room 1, x 7–18) with furniture at (8,2) (10,2) (12,2) (14,2) (16,2); spots on the lawn. */
export function lootMap(): string[] {
  return [
    "####################",
    "#:::::#::::::::::::#",
    "#:::::+:o:o:o:o:o::#",
    "#:::::#::::::::::::#",
    "#:::::#::::::::::::#",
    "###+################",
    ",,,,,,,,,,,,,,,,,,,,",
    ",PP,,,,,,,,,,,PP,,,,",
    ",,,,,,,,,,,,,,,,,,,,",
  ];
}

/** The loot estate: places loose (8,2), case (10,2), safe (12,2), pedestal (14,2); the workbench (16,2). */
export function lootEstate(): Estate {
  return kitEstate(lootMap(), {
    car: 0,
    places: [
      { x: 8, y: 2, keep: "loose" },
      { x: 10, y: 2, keep: "case" },
      { x: 12, y: 2, keep: "safe" },
      { x: 14, y: 2, keep: "pedestal" },
    ],
    workbench: { x: 16, y: 2 },
  });
}

/** Catalogue for {@link lootEstate}: 0 ruby (pedestal, tagged), 1 egg (safe, tagged), 2 bible (case, large), 3 flask (loose). */
export function lootCatalogue(): NightItem[] {
  return kitCatalogue([
    { id: "ruby", place: 3, tagged: true },
    { id: "faberge-egg", place: 2, tagged: true },
    { id: "bible", place: 1 },
    { id: "hip-flask", place: 0 },
  ]);
}
