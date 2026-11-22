// The join page and the 404 page: small, self-contained HTML (inline CSS
// in the website's colours, no JavaScript).

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root { --bg: #FFFFFF; --ink: #172B46; --ink-2: rgba(23,43,70,.7); --rule: rgba(23,43,70,.12);
  --panel: #F5F6F8; --accent: #E8743B; --link: #B5501C; --btn-bg: #172B46; --btn-ink: #FFFFFF;
  color-scheme: light dark; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0D1828; --ink: #E8ECF2; --ink-2: rgba(232,236,242,.72); --rule: rgba(232,236,242,.11);
    --panel: #13223A; --link: #F0915F; --btn-bg: #E8743B; --btn-ink: #0D1828; }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { font: 17px/1.5 "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
main { width: 100%; max-width: 360px; text-align: center; }
h1 { font-size: 15px; letter-spacing: .12em; text-transform: uppercase; margin: 0 0 24px; }
h1 a { color: var(--ink); text-decoration: none; }
h1 span { color: var(--accent); }
p { margin: 0 0 20px; color: var(--ink-2); }
p.msg { color: var(--ink); background: var(--panel); border-left: 3px solid var(--accent);
  padding: 10px 14px; text-align: left; }
form { display: flex; flex-direction: column; gap: 12px; }
label { font-size: 14px; color: var(--ink-2); }
input { font: 600 32px/1.2 ui-monospace, "IBM Plex Mono", monospace; letter-spacing: .3em;
  text-align: center; text-transform: uppercase; padding: 12px; width: 100%;
  background: var(--panel); color: var(--ink); border: 1px solid var(--rule); border-radius: 6px; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { font: 600 17px/1 inherit; font-family: inherit; padding: 14px; border: 0; border-radius: 6px;
  background: var(--btn-bg); color: var(--btn-ink); cursor: pointer; }
a { color: var(--link); }
nav { margin-top: 28px; font-size: 15px; }
`;

/**
 * The join page's link preview: the join links' card, as site/build.py puts
 * it on the frame page (/p) and scripts/site.ts on /r/ (they add a hash of
 * the card for previewers' caches; this page is not built, so it has none).
 */
const JOIN_SOCIAL = `<meta name="description" content="You're invited to a party game on the TV: type the code, type a name and play along on your phone. Nothing to install.">
<meta property="og:type" content="website">
<meta property="og:site_name" content="tvpipe.party">
<meta property="og:title" content="Join the game">
<meta property="og:description" content="You're invited to a party game on the TV: type the code, type a name and play along on your phone. Nothing to install.">
<meta property="og:image" content="https://tvpipe.party/static/social/join.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Phones playing tvpipe party games">
<meta name="twitter:card" content="summary_large_image">
`;

function layout(title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
${head}<style>${STYLE}</style>
</head>
<body>
<main>
<h1><a href="/">tvpipe<span>.</span>party</a></h1>
${body}
</main>
</body>
</html>
`;
}

/** The join page: one field for the code, a GET form to /join. */
export function joinPage(message?: string, code = ""): string {
  const msg = message ? `<p class="msg" role="alert">${esc(message)}</p>\n` : "";
  return layout(
    "Join a game · tvpipe.party",
    `${msg}<form method="get" action="/join">
<label for="code">The code on the TV</label>
<input id="code" name="code" value="${esc(code)}" required autofocus autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" inputmode="text" maxlength="8" placeholder="BCDF">
<button type="submit">Join</button>
</form>
`,
    JOIN_SOCIAL,
  );
}

/** The page for what is neither a code nor a static file. */
export function notFoundPage(): string {
  return layout(
    "Not found · tvpipe.party",
    `<p>There is nothing here.</p>
<nav><a href="/join">Join a game</a> · <a href="/">tvpipe</a></nav>
`,
  );
}
