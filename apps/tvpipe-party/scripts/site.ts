/**
 * Adds "tvpipe.party in the browser" to the built website, after
 * `python3 ../../site/build.py` (docs/browser-party-design.md, "Pages on
 * tvpipe.party"):
 *
 *   /_tvpipe/lib/         the library (npm/party), `mode.js` saying WEB = true
 *   /_tvpipe/launcher/, /_tvpipe/tvsync/, /_tvpipe/wait/
 *                         its pages, as tvpipe serves them (npm/party/scripts/web.ts;
 *                         not the app's games list, /_tvpipe/picker/: on the web
 *                         that is /games/, with its Play now buttons)
 *   /_tvpipe/screen/      the TV page's window (cable, second window)
 *   /_tvpipe/ui.css, /_tvpipe/fonts/   tvpipe's look
 *   /r/                   a web room's join link
 *   /tv/                  an extra screen
 *   /g/NAME/RELEASE/      the games of site/static/games.json, built here
 *   /g/index.json         the list of them
 *   /manifest.webmanifest, /sw.js, /offline.html, /icons/, /apple-touch-icon.png
 *
 *   node scripts/site.ts              # builds npm/party and the games, then writes
 *   node scripts/site.ts --no-build   # uses what npm/party and the games built last
 *
 * Every game of the list must build: /games/ links each one's launcher
 * (`/games/NAME/launcher/`). Checks Cloudflare's limits for assets:
 * at most 20,000 files, 25 MiB each.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(app, "..", "..");
const party = join(repo, "npm", "party");
const out = join(repo, "site", "_out");
const build = !process.argv.includes("--no-build");

const MAX_FILES = 20_000;
const MAX_FILE = 25 * 1024 * 1024;

/** `/g/index.json` (docs/browser-party-design.md). */
export interface WebGames {
  v: 1;
  games: {
    name: string;
    title: string;
    summary: string;
    release: string;
    players: { min: number; max: number };
    languages: string[];
    tv: { width: number; height: number; resolution: "choice" | "fixed" } | null;
    path: string;
    pages: { host: string; tv: string; phone: string; launcher?: string };
    cover?: string;
  }[];
}

interface ListedGame {
  name: string;
  title: string;
  summary: string;
  players: { min: number; max: number };
  languages?: string[];
  screenshots: { src: string; kind: "tv" | "phone" }[];
}

interface Manifest {
  name: string;
  title?: string;
  root?: string;
  pages: { host: string; tv: string; phone: string; launcher?: string | null };
  players?: { min?: number; max?: number };
  tv?: { width: number; height: number; resolution?: "choice" | "fixed" } | null;
}

function run(cwd: string, cmd: string, args: string[]): void {
  console.log(`$ (${relative(repo, cwd) || "."}) ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
}

/** `npm ci` where there is no node_modules yet (CI, a fresh checkout). */
function install(dir: string): void {
  if (!existsSync(join(dir, "node_modules"))) run(dir, "npm", ["ci", "--no-audit", "--no-fund"]);
}

function write(rel: string, data: string | Buffer): void {
  const p = join(out, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** The tvpipe.party app in a page's head: the manifest, the icon, the colour. */
const APP_HEAD =
  '<link rel="manifest" href="/manifest.webmanifest">\n' +
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n' +
  '<meta name="apple-mobile-web-app-capable" content="yes">\n' +
  '<meta name="mobile-web-app-capable" content="yes">\n' +
  '<meta name="apple-mobile-web-app-title" content="tvpipe.party">\n';

function withAppHead(html: string): string {
  if (!html.includes("</head>")) throw new Error("a page without </head>");
  return html.replace('<link rel="icon" href="data:,">', '<link rel="icon" href="/static/logo.svg" type="image/svg+xml">').replace("</head>", `${APP_HEAD}</head>`);
}

/** A page of npm/party's own (no tvpipe copy): its `../x.js` imports are the library's. */
function pageJs(dir: string, js: string): string {
  return readFileSync(join(party, "dist", dir, js), "utf8")
    .replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n")
    .replace(/from "\.\.\/([a-z-]+\.js)"/g, 'from "/_tvpipe/lib/$1"');
}

// ---------------------------------------------------------------------------

if (!existsSync(join(out, "index.html"))) throw new Error("site/_out has no index.html: run python3 site/build.py first");

// The library and its pages.
if (build) {
  install(party);
  run(party, process.execPath, [join(party, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"]);
}
const { webFiles } = (await import(pathToFileURL(join(party, "scripts", "web.ts")).href)) as { webFiles(): Map<string, string> };
rmSync(join(out, "_tvpipe"), { recursive: true, force: true });
let webMode = false;
/** The launcher's page, also served as each game's `/games/NAME/launcher/`. */
let launcherHtml = "";
for (const [rel, text] of webFiles()) {
  // The app's games list talks to tvpipe only.
  if (rel.startsWith("picker/")) continue;
  let t = text;
  if (rel === "lib/mode.js") {
    t = text.replace(/^export const WEB = false;$/m, "export const WEB = true;");
    webMode = t !== text;
  }
  if (rel === "launcher/index.html") {
    t = withAppHead(t);
    launcherHtml = t;
  }
  write(`_tvpipe/${rel}`, t);
}
if (!launcherHtml) throw new Error("npm/party has no launcher/index.html");
if (!webMode) throw new Error("npm/party's lib/mode.js has no line `export const WEB = false;` to turn on");
const browser = join(repo, "crates", "tvpipe", "src", "browser");
cpSync(join(browser, "ui.css"), join(out, "_tvpipe", "ui.css"));
cpSync(join(browser, "fonts"), join(out, "_tvpipe", "fonts"), { recursive: true });

// tvpipe.party's own pages.
const pages: [src: string, js: string, to: string][] = [
  ["screen", "screen.js", "_tvpipe/screen"],
  ["join", "join.js", "r"],
  ["tvscreen", "tvscreen.js", "tv"],
];
for (const [src, js, to] of pages) {
  write(`${to}/index.html`, readFileSync(join(party, "src", src, "index.html"), "utf8"));
  write(`${to}/${js}`, pageJs(src, js));
}
// The web app: manifest, service worker, icons, the offline page.
cpSync(join(app, "web"), out, { recursive: true });

// The games.
const listed = (JSON.parse(readFileSync(join(repo, "site", "static", "games.json"), "utf8")) as { games: ListedGame[] }).games;
rmSync(join(out, "g"), { recursive: true, force: true });
const index: WebGames = { v: 1, games: [] };
for (const g of listed) {
  const dir = join(repo, "games", g.name);
  // /games/ has a Play now for every game of the list: each must be on the web.
  if (!existsSync(join(dir, "tvpipe.json"))) throw new Error(`games/${g.name}: listed in site/static/games.json but not in this repository (no tvpipe.json)`);
  if (build) {
    install(dir);
    run(dir, "npm", ["run", "build"]);
  }
  // Play now: /games/NAME/launcher/ is the launcher (its files stay in /_tvpipe/launcher/).
  write(
    `games/${g.name}/launcher/index.html`,
    launcherHtml.replace('href="launcher.css"', 'href="/_tvpipe/launcher/launcher.css"').replace('src="launcher.js"', 'src="/_tvpipe/launcher/launcher.js"'),
  );
  const release = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
  if (!/^[0-9A-Za-z.+-]{1,40}$/.test(release)) throw new Error(`games/${g.name}: version ${release} is no path`);
  const manifest = JSON.parse(readFileSync(join(dir, "tvpipe.json"), "utf8")) as Manifest;
  const root = join(dir, manifest.root ?? ".");
  if (!existsSync(join(root, manifest.pages.host))) throw new Error(`games/${g.name}: ${manifest.pages.host} not built (npm run build)`);
  const path = `/g/${g.name}/${release}/`;
  cpSync(root, join(out, path), { recursive: true, filter: (f) => !f.endsWith(".map") });
  write(`${path}tvpipe.json`, readFileSync(join(dir, "tvpipe.json")));
  // A directory's index.html by the directory: Cloudflare's html_handling would answer it with a 307 there.
  const page = (f: string) => path + f.replace(/(^|\/)index\.html$/, "$1");
  const cover = g.screenshots.find((s) => s.kind === "tv") ?? g.screenshots[0];
  const p = manifest.pages;
  index.games.push({
    name: g.name,
    title: manifest.title ?? g.title,
    summary: g.summary,
    release,
    players: { min: manifest.players?.min ?? g.players.min, max: manifest.players?.max ?? g.players.max },
    languages: g.languages ?? [],
    tv: manifest.tv ? { width: manifest.tv.width, height: manifest.tv.height, resolution: manifest.tv.resolution ?? "choice" } : null,
    path,
    pages: {
      host: page(p.host),
      tv: page(p.tv),
      phone: page(p.phone),
      ...(p.launcher ? { launcher: page(p.launcher) } : {}),
    },
    ...(cover ? { cover: `/${cover.src}` } : {}),
  });
}
write("g/index.json", `${JSON.stringify(index, null, 2)}\n`);

// Cloudflare's limits for a Worker's assets.
const all = files(out);
const big = all.filter((f) => statSync(f).size > MAX_FILE);
if (big.length > 0) throw new Error(`larger than 25 MiB (Cloudflare's limit): ${big.map((f) => relative(out, f)).join(", ")}`);
if (all.length > MAX_FILES) throw new Error(`${all.length} files, Cloudflare takes at most ${MAX_FILES}`);
console.log(`site/_out: ${index.games.length} games on the web (${index.games.map((g) => `${g.name} ${g.release}`).join(", ")}), ${all.length} files`);
