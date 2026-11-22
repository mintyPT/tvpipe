/**
 * Draws data/world.txt as the TV would see it, to check the map by eye:
 *
 *   node scripts/preview.ts [OUT.html] [--png OUT.png] [--scale N] [--names]
 *
 * One SVG, 1280×720, the map edge to edge: hexes in their continent's
 * colour (territories in shades of it), territory borders thick, coasts
 * thin, badges as circles with the id, sea links dashed, and the places
 * the TV keeps free for its HUD outlined in red. With --png, headless
 * Chrome takes a screenshot of it (--scale 2: at twice the pixels, to
 * look closer).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { HEX_SIDES, hexCenter, hexCorners, hexNeighbors, mapSize, parseWorld } from "../game/world.ts";

const SCREEN_W = 1280;
const SCREEN_H = 720;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const COLORS: Record<string, string> = {
  na: "#d9a441",
  sa: "#c4553f",
  eu: "#4f7fc9",
  af: "#8c6bb8",
  as: "#5ba05a",
  oc: "#c96fa0",
};

/** The HUD's places (x, y, width, height in pixels), which want sea. */
const HUD: [number, number, number, number, string][] = [
  [0, 180, 130, 324, "scores"],
  [0, 510, 230, 210, "join"],
];

const args = process.argv.slice(2);
const pngAt = args.indexOf("--png");
const png = pngAt >= 0 ? args[pngAt + 1] : undefined;
const scaleAt = args.indexOf("--scale");
const scale = scaleAt >= 0 ? Number(args[scaleAt + 1]) : 1;
const names = args.includes("--names");
const out = args.find((a, i) => !a.startsWith("--") && i !== pngAt + 1 && i !== scaleAt + 1) ?? "/tmp/landgrab-world.html";

const w = parseWorld(readFileSync(new URL("../data/world.txt", import.meta.url), "utf8"));
const [mw, mh] = mapSize(w);
const size = Math.max(SCREEN_W / mw, SCREEN_H / mh);

/** Shade a colour by a factor (<1 darker, >1 lighter). */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(f > 1 ? v + (255 - v) * (f - 1) : v * f)));
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

const parts: string[] = [];
parts.push(`<rect width="${SCREEN_W}" height="${SCREEN_H}" fill="#173a5e"/>`);
const fills: string[] = [];
const borders: string[] = [];
const coasts: string[] = [];
for (let r = 0; r < w.rows; r++) {
  for (let c = 0; c < w.cols; c++) {
    const t = w.cells[r * w.cols + c]!;
    const [x, y] = hexCenter(c, r, size);
    const corners = hexCorners(x, y, size);
    if (t < 0) continue;
    const ter = w.territories[t]!;
    const k = w.continents.find((x) => x.id === ter.continent)!.territories.indexOf(ter.id);
    const fill = shade(COLORS[ter.continent] ?? "#888", [1, 0.82, 1.18, 0.9, 1.08, 0.74, 1.26, 0.97, 1.13][k % 9]!);
    fills.push(`<path d="M${corners.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join("L")}Z" fill="${fill}" stroke="${fill}" stroke-width="0.6"/>`);
    hexNeighbors(c, r).forEach(([nc, nr], side) => {
      const off = nc < 0 || nr < 0 || nc >= w.cols || nr >= w.rows;
      const o = off ? -1 : w.cells[nr * w.cols + nc]!;
      if (o === t) return;
      const [i, j] = HEX_SIDES[side]!;
      const [a, b] = corners[i]!;
      const [d, e] = corners[j]!;
      const line = `<line x1="${a.toFixed(1)}" y1="${b.toFixed(1)}" x2="${d.toFixed(1)}" y2="${e.toFixed(1)}"/>`;
      if (o < 0) coasts.push(line);
      else if (o > t) borders.push(line);
    });
  }
}
parts.push(...fills);
parts.push(`<g stroke="#0d2338" stroke-width="1.5" stroke-linecap="round">${coasts.join("")}</g>`);
parts.push(`<g stroke="#1a1a1a" stroke-width="2.6" stroke-linecap="round">${borders.join("")}</g>`);

const anchor = (id: string) => {
  const t = w.byId.get(id)!;
  return hexCenter(t.anchor[0], t.anchor[1], size);
};
const links: string[] = [];
for (const l of w.links) {
  const [ax, ay] = anchor(l.a);
  const [bx, by] = anchor(l.b);
  if (l.wrap) {
    const [lx, ly, rx, ry] = ax < bx ? [ax, ay, bx, by] : [bx, by, ax, ay];
    const my = (ly + ry) / 2;
    links.push(`<line x1="${lx}" y1="${ly}" x2="0" y2="${my}"/><line x1="${rx}" y1="${ry}" x2="${SCREEN_W}" y2="${my}"/>`);
  } else {
    links.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/>`);
  }
}
parts.push(`<g stroke="#ffffff" stroke-width="2" stroke-dasharray="6 5" opacity="0.8">${links.join("")}</g>`);

for (const t of w.territories) {
  const [x, y] = anchor(t.id);
  parts.push(`<circle cx="${x}" cy="${y}" r="${size * 1.05}" fill="#ffffff" stroke="#222" stroke-width="1.5"/>`);
  parts.push(`<text x="${x}" y="${y + size * 0.38}" font-size="${size * 1.05}" text-anchor="middle" font-family="Helvetica" font-weight="bold">${t.id}</text>`);
  if (names) parts.push(`<text x="${x}" y="${y + size * 2}" font-size="10" text-anchor="middle" font-family="Helvetica" fill="#fff">${t.name.en} ${t.hexes.length}</text>`);
}
for (const [x, y, wd, ht, label] of HUD) {
  parts.push(`<rect x="${x}" y="${y}" width="${wd}" height="${ht}" fill="none" stroke="#ff4040" stroke-width="2" stroke-dasharray="4 3"/>`);
  parts.push(`<text x="${x + 6}" y="${y + 16}" font-size="12" fill="#ff8080" font-family="Helvetica">${label}</text>`);
}

const html = `<!doctype html><html><body style="margin:0;background:#000;overflow:hidden">
<svg xmlns="http://www.w3.org/2000/svg" width="${SCREEN_W}" height="${SCREEN_H}" viewBox="0 0 ${SCREEN_W} ${SCREEN_H}">${parts.join("\n")}</svg>
</body></html>`;
writeFileSync(out, html);
console.log(`${out}: ${w.cols}×${w.rows} hexes of radius ${size.toFixed(2)} px`);
if (png) {
  execFileSync(CHROME, ["--headless=new", "--hide-scrollbars", `--screenshot=${resolve(png)}`, `--window-size=${SCREEN_W},${SCREEN_H}`, `--force-device-scale-factor=${scale}`, `file://${resolve(out)}`], { stdio: "ignore" });
  console.log(png);
}
