/**
 * Builds the bundle `tvpipe game play` serves (`dist/`, the manifest's
 * `root`): the TypeScript (`game/`, `host/`) compiled by tsc, imports of
 * `@tvpipe/party` pointed at tvpipe's copy (`/_tvpipe/lib/`), and the
 * pages, styles and fonts copied as they are.
 *
 *   node scripts/build.ts    # dist/
 *
 * The compiled rules land in `dist/game/*.js`: the phone imports
 * `../game/move.js` and `../game/sight.js` from there for its prediction
 * (docs/pinch-design.md §14). `npm run zip` (scripts/pack.ts) packs the
 * bundle into pinch.zip with `tvpipe game pack`.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** Bare imports of the library, as tvpipe serves it. */
const LIBRARY: Record<string, string> = {
  "@tvpipe/party": "/_tvpipe/lib/index.js",
  "@tvpipe/party/client": "/_tvpipe/lib/client.js",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

rmSync(dist, { recursive: true, force: true });
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });
for (const f of files(dist)) {
  if (!f.endsWith(".js")) continue;
  const js = readFileSync(f, "utf8").replace(/from "(@tvpipe\/party(?:\/client)?)"/g, (m, spec: string) => {
    const to = LIBRARY[spec];
    if (!to) throw new Error(`${relative(root, f)}: unknown import ${spec}`);
    return `from "${to}"`;
  });
  if (/from "@tvpipe\//.test(js)) throw new Error(`${relative(root, f)}: an import of the library left`);
  writeFileSync(f, js);
}
for (const dir of ["phone", "screen"]) cpSync(join(root, dir), join(dist, dir), { recursive: true });
// The host page's static files (its script is compiled above).
for (const f of readdirSync(join(root, "host"))) {
  if (!f.endsWith(".ts")) cpSync(join(root, "host", f), join(dist, "host", f), { recursive: true });
}
console.log(`built ${relative(process.cwd(), dist) || "."}`);

for (const need of ["host/host.js", "game/map.js", "game/move.js", "game/sight.js"]) {
  if (!existsSync(join(dist, need))) throw new Error(`the build made no ${need}`);
}
