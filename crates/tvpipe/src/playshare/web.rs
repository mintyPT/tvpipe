//! Files tvpipe serves itself under `/_tvpipe/`: the game library
//! (`lib/`, built from `npm/party` by `npm run build`), the standard
//! launcher (`launcher/`), the TV sync page it casts (`tvsync/`), the
//! game picker (`picker/`) and the phones' page before a game (`wait/`). Embedded in the binary; with
//! `TVPIPE_PLAYSHARE_WEB=DIR` they are read from `DIR` instead (working
//! on the library without rebuilding tvpipe).

use std::borrow::Cow;
use std::path::Path;

/// One embedded file: its path below `web/` and its bytes.
pub struct Asset {
    pub path: &'static str,
    pub bytes: &'static [u8],
}

macro_rules! web {
    ($($file:literal),* $(,)?) => {
        &[$(Asset {
            path: $file,
            bytes: include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/playshare/web/", $file)),
        }),*]
    };
}

/// Every embedded file (a test compares the list with the directory).
pub static FILES: &[Asset] = web![
    "lib/client.js",
    "lib/emoji.js",
    "lib/emitter.js",
    "lib/flashsync.js",
    "lib/frame.js",
    "lib/host.js",
    "lib/index.js",
    "lib/limits.js",
    "lib/names.js",
    "lib/pair-dialog.js",
    "lib/party.js",
    "lib/rejoin-dialog.js",
    "lib/rejoin.js",
    "lib/relay.js",
    "lib/surface.js",
    "lib/sync.js",
    "lib/testing.js",
    "lib/tvpipe.js",
    "launcher/index.html",
    "launcher/launcher.css",
    "launcher/launcher.js",
    "tvsync/index.html",
    "tvsync/tvsync.js",
    "picker/index.html",
    "picker/picker.css",
    "picker/picker.js",
    "wait/index.html",
    "wait/wait.js",
];

/// The source directory (for the test and dev mode).
pub const SOURCE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src/playshare/web");

/// The file at `path` (below `web/`, already a clean path).
pub fn get(path: &str) -> Option<Cow<'static, [u8]>> {
    if let Some(dir) = std::env::var_os("TVPIPE_PLAYSHARE_WEB").filter(|d| !d.is_empty()) {
        return std::fs::read(Path::new(&dir).join(path))
            .ok()
            .map(Cow::Owned);
    }
    FILES
        .iter()
        .find(|f| f.path == path)
        .map(|f| Cow::Borrowed(f.bytes))
}

/// tvpipe's logo as an SVG `<symbol id="logo">` (the share page's).
const LOGO: &str = include_str!("../browser/logo.svg");

pub(crate) fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// An error page in tvpipe's look (`/_tvpipe/ui.css`), for a browser
/// that navigated somewhere tvpipe refuses: the status in the status
/// column, a heading and a line of text (plain text, escaped here).
pub fn error_page(status: u16, reason: &str, game: &str, heading: &str, text: &str) -> Vec<u8> {
    let e = html_escape;
    format!(
        concat!(
            "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n",
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n",
            "<title>{status} {reason} · tvpipe</title>\n",
            "<link rel=\"stylesheet\" href=\"/_tvpipe/ui.css\">\n</head>\n<body>\n{logo}",
            "<header class=\"top\">\n",
            "  <div class=\"mark\"><svg viewBox=\"0 0 560 520\" aria-hidden=\"true\"><use href=\"#logo\"/></svg><span>tv<b>pipe</b></span></div>\n",
            "  <div class=\"pair\">tvpipe<span>Party game</span></div>\n",
            "  <div class=\"pair\">Game<span>{game}</span></div>\n",
            "</header>\n<main>\n  <section class=\"row ph\">\n",
            "    <div class=\"meta\"><span class=\"lbl\">Status</span><span class=\"state bad\">{status} {reason}</span></div>\n",
            "    <div class=\"body\">\n      <h1>{heading}</h1>\n      <p class=\"lead\">{text}</p>\n    </div>\n",
            "  </section>\n</main>\n</body>\n</html>\n"
        ),
        status = status,
        reason = e(reason),
        logo = LOGO,
        game = e(game),
        heading = e(heading),
        text = e(text),
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_pages_escape_what_they_show() {
        let page = error_page(
            404,
            "Not Found",
            "Tom & <Jerry>",
            "Nothing \"here\"",
            "a < b",
        );
        let page = String::from_utf8(page).unwrap();
        assert!(
            page.contains("<span>Tom &amp; &lt;Jerry&gt;</span>"),
            "{page}"
        );
        assert!(page.contains("<h1>Nothing &quot;here&quot;</h1>"), "{page}");
        assert!(page.contains("<p class=\"lead\">a &lt; b</p>"), "{page}");
        assert!(page.contains("<symbol id=\"logo\""), "{page}");
    }
}
