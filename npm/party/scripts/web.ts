/**
 * Copies the built library and the standard launcher into the tvpipe
 * crate (`crates/tvpipe/src/playshare/web/`), which embeds them and
 * serves them at `/_tvpipe/lib/`, `/_tvpipe/launcher/`,
 * `/_tvpipe/tvsync/` (the TV sync page) and `/_tvpipe/picker/` (the game
 * picker)
 * (docs/playshare-design.md §8). Run by `npm run build` after `tsc`;
 * `--check` only compares (CI, `npm test`), exiting 1 when they differ.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const src = join(here, "..", "src");
export const WEB = join(here, "..", "..", "..", "crates", "tvpipe", "src", "playshare", "web");

/** The files tvpipe embeds, by path below `web/`, from the build. */
export function webFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const strip = (js: string) => js.replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n");
  for (const f of readdirSync(dist).sort()) {
    // Only what src/ still has: dist/ keeps the output of deleted modules.
    if (f.endsWith(".js") && existsSync(join(src, f.replace(/\.js$/, ".ts")))) {
      out.set(`lib/${f}`, strip(readFileSync(join(dist, f), "utf8")));
    }
  }
  // The launcher and the TV sync page sit beside lib/ when served:
  // `../x.js` is `../lib/x.js`.
  const page = (dir: string, js: string) =>
    strip(readFileSync(join(dist, dir, js), "utf8")).replace(/from "\.\.\/([a-z]+\.js)"/g, 'from "../lib/$1"');
  out.set("launcher/launcher.js", page("launcher", "launcher.js"));
  for (const f of ["index.html", "launcher.css"]) out.set(`launcher/${f}`, readFileSync(join(src, "launcher", f), "utf8"));
  out.set("tvsync/tvsync.js", page("tvsync", "tvsync.js"));
  out.set("tvsync/index.html", readFileSync(join(src, "tvsync", "index.html"), "utf8"));
  // The game picker (docs/game-catalog.md): no imports.
  out.set("picker/picker.js", strip(readFileSync(join(dist, "picker", "picker.js"), "utf8")));
  for (const f of ["index.html", "picker.css"]) out.set(`picker/${f}`, readFileSync(join(src, "picker", f), "utf8"));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("web.ts")) {
  const check = process.argv.includes("--check");
  const files = webFiles();
  const stale: string[] = [];
  for (const [rel, text] of files) {
    const p = join(WEB, rel);
    const old = existsSync(p) ? readFileSync(p, "utf8") : undefined;
    if (old === text) continue;
    if (check) stale.push(rel);
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  }
  for (const dir of ["lib", "launcher", "tvsync", "picker"]) {
    if (!existsSync(join(WEB, dir))) continue;
    for (const f of readdirSync(join(WEB, dir))) {
      if (!files.has(`${dir}/${f}`)) stale.push(`${dir}/${f} (not built: remove it)`);
    }
  }
  if (stale.length > 0) {
    console.error(`crates/tvpipe/src/playshare/web is not up to date (npm run build in npm/party):\n  ${stale.join("\n  ")}`);
    if (check) process.exit(1);
  }
}
