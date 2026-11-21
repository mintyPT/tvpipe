//! The two listeners (docs/playshare-design.md §4): the local one (the
//! window: launcher, host page, API; the TV page) and the public one
//! (phones through the tunnel, or the LAN). Each checks `Host` (421:
//! DNS rebinding) and WebSocket `Origin` (403: cross-site hijacking).

use std::sync::Arc;

use crate::browser::fonts;
use crate::crypto::ring::ct_eq;
use crate::net::http::{Request, Response, Version};
use crate::net::httpd::{self, Handler, Reply};
use crate::net::websocket;

use super::bundle::{self, clean_path, percent_decode, Lookup};
use super::hub::{Hub, Via, GAME_COOKIE};
use super::{picker, web};

/// Which listener a handler serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listener {
    Local,
    Public,
    Lan,
}

/// The standard launcher.
pub const LAUNCHER: &str = "/_tvpipe/launcher/";
/// The phones' page while no game is picked yet.
pub const WAIT: &str = "/_tvpipe/wait/";

fn loopback_names(port: u16) -> [String; 3] {
    [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
    ]
}

fn redirect(status: u16, location: &str) -> Response {
    let mut r = httpd::response(
        status,
        if status == 301 {
            "Moved Permanently"
        } else {
            "Found"
        },
        "text/plain; charset=utf-8",
        Vec::new(),
    );
    r.headers.add("Location", location);
    r
}

/// The session cookie's name: per local port, since cookies are shared
/// by every port of a host.
pub fn cookie_name(port: u16) -> String {
    format!("tvpipe-{port}")
}

fn cookie<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers.get_all("cookie").find_map(|h| {
        h.split(';').find_map(|kv| {
            let (k, v) = kv.trim().split_once('=')?;
            (k == name).then_some(v)
        })
    })
}

fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix(key)?.strip_prefix('='))
}

impl Hub {
    fn host_ok(&self, req: &Request, l: Listener) -> bool {
        let Some(host) = req
            .headers
            .get("host")
            .map(|h| h.trim().to_ascii_lowercase())
        else {
            return false;
        };
        let p = self.ports.get().copied();
        let Some(p) = p else { return false };
        match l {
            Listener::Local => loopback_names(p.local).contains(&host),
            Listener::Lan => p.lan.is_some_and(|a| a.to_string() == host),
            Listener::Public => {
                if loopback_names(p.public).contains(&host) {
                    return true;
                }
                let bare = host.strip_suffix(":443").unwrap_or(&host);
                self.tunnel
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .host
                    .as_deref()
                    .is_some_and(|h| h.eq_ignore_ascii_case(bare))
            }
        }
    }

    fn origin_ok(&self, req: &Request, l: Listener) -> bool {
        // Not a browser: tokens and keys still apply.
        let Some(o) = req
            .headers
            .get("origin")
            .map(|o| o.trim().to_ascii_lowercase())
        else {
            return true;
        };
        let Some(p) = self.ports.get().copied() else {
            return false;
        };
        let loopback = |port: u16| {
            o.strip_prefix("http://")
                .is_some_and(|a| loopback_names(port).iter().any(|n| n == a))
        };
        match l {
            Listener::Local => loopback(p.local),
            Listener::Lan => p.lan.is_some_and(|a| o == format!("http://{a}")),
            Listener::Public => {
                loopback(p.public)
                    || o.strip_prefix("https://").is_some_and(|h| {
                        self.tunnel
                            .read()
                            .unwrap_or_else(|e| e.into_inner())
                            .host
                            .as_deref()
                            .is_some_and(|t| t.eq_ignore_ascii_case(h))
                    })
            }
        }
    }

    /// Whether the request carries the API token (cookie or `?t=`).
    pub fn token_ok(&self, req: &Request, query: &str) -> bool {
        let port = self.ports.get().map(|p| p.local).unwrap_or(0);
        let want = self.token.as_bytes();
        query_param(query, "t").is_some_and(|t| ct_eq(t.as_bytes(), want))
            || cookie(req, &cookie_name(port)).is_some_and(|t| ct_eq(t.as_bytes(), want))
    }

    /// The visitor's address for limits and the host.
    fn address(&self, req: &Request, l: Listener) -> String {
        let peer = httpd::current_peer();
        if l == Listener::Public {
            let host = req.headers.get("host").unwrap_or("").to_ascii_lowercase();
            let tunnel = !host.starts_with("127.0.0.1:")
                && !host.starts_with("localhost:")
                && !host.starts_with("[::1]:");
            if tunnel {
                if let Some(cf) = req
                    .headers
                    .get("cf-connecting-ip")
                    .map(str::trim)
                    .filter(|c| !c.is_empty() && c.len() < 64)
                {
                    return cf.to_owned();
                }
                let peers = self.peers.read().unwrap_or_else(|e| e.into_inner());
                if let Some(v) = peers.as_ref().and_then(|f| peer.and_then(|a| f(a))) {
                    return v;
                }
            }
        }
        peer.map(|a| a.ip().to_string())
            .unwrap_or_else(|| "?".into())
    }

    fn handle(self: &Arc<Hub>, req: &Request, l: Listener) -> Reply {
        if !self.host_ok(req, l) {
            return Reply::Response(httpd::error_response(421, "Misdirected Request"));
        }
        let (path, query) = req.target.split_once('?').unwrap_or((&req.target, ""));
        if websocket::is_upgrade(req) {
            return self.upgrade(req, l, path, query);
        }
        let post = l == Listener::Local && path == "/_tvpipe/api/game";
        if req.method != "GET" && req.method != "HEAD" && !(post && req.method == "POST") {
            let mut r = httpd::error_response(405, "Method Not Allowed");
            r.headers.add("Allow", "GET, HEAD");
            return Reply::Response(r);
        }
        // A service worker on the phones' origin would outlive the game:
        // the next game on the same name (a reused Cloudflare hostname,
        // `--lan`'s port) would run under it (§18).
        if l != Listener::Local
            && req
                .headers
                .get("service-worker")
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("script"))
        {
            return Reply::Response(httpd::error_response(
                403,
                "Forbidden: no service workers on the phones' link",
            ));
        }
        let r = self.get(req, l, path, query);
        Reply::Response(self.for_browser(req, l, r))
    }

    /// An error a browser navigated to becomes a page in tvpipe's look
    /// (scripts, `fetch` and tools keep the plain text).
    fn for_browser(&self, req: &Request, l: Listener, mut r: Response) -> Response {
        let navigation = req
            .headers
            .get("accept")
            .is_some_and(|a| a.contains("text/html"));
        if r.status < 400 || !navigation {
            return r;
        }
        let (heading, text) = match (r.status, l) {
            (403, Listener::Local) => (
                "Open the link tvpipe printed",
                "This browser has no key to the game yet: open the link tvpipe printed in the terminal, or use the window it opened.",
            ),
            (404, Listener::Local) => (
                "Nothing here",
                "The game has no page at this address. The link tvpipe printed opens the game.",
            ),
            (404, _) => (
                "Nothing here",
                "The game has no page at this address. To join, scan the QR code on the TV again.",
            ),
            _ => ("tvpipe refused this", "Open the game with the link tvpipe printed or the QR code on the TV."),
        };
        let reason = r.reason.split(':').next().unwrap_or("").to_owned();
        r.headers.set("Content-Type", "text/html; charset=utf-8");
        let title = self
            .game()
            .map(|g| g.bundle.manifest.title.clone())
            .unwrap_or_else(|| "tvpipe".into());
        r.body = web::error_page(r.status, &reason, &title, heading, text);
        r
    }

    fn get(&self, req: &Request, l: Listener, path: &str, query: &str) -> Response {
        if path == "/" {
            return match l {
                Listener::Local => {
                    if self.token_ok(req, "") {
                        redirect(302, &self.start_page())
                    } else {
                        httpd::error_response(403, "Forbidden: open the link tvpipe printed")
                    }
                }
                _ => {
                    // No game yet: a page that waits for one.
                    let phone = match self.game() {
                        Some(g) => format!("/{}", g.bundle.manifest.pages.phone),
                        None => WAIT.to_owned(),
                    };
                    if query.is_empty() {
                        redirect(302, &phone)
                    } else {
                        redirect(302, &format!("{phone}?{query}"))
                    }
                }
            };
        }
        if let Some(rest) = path.strip_prefix("/_tvpipe/") {
            if l == Listener::Local && rest == "start" {
                if !self.token_ok(req, query) {
                    return httpd::error_response(403, "Forbidden");
                }
                let port = self.ports.get().map(|p| p.local).unwrap_or(0);
                // `next`: a page of this origin instead of the launcher
                // (tests, a browser opened by hand).
                let next = query_param(query, "next")
                    .and_then(percent_decode)
                    .filter(|n| n.starts_with('/') && !n.starts_with("//") && !n.contains('\\'))
                    .unwrap_or_else(|| self.start_page());
                let mut r = redirect(302, &next);
                r.headers.add(
                    "Set-Cookie",
                    format!(
                        "{}={}; Path=/; HttpOnly; SameSite=Strict",
                        cookie_name(port),
                        self.token
                    ),
                );
                return r;
            }
            if rest == "launcher" && l == Listener::Local {
                return redirect(301, LAUNCHER);
            }
            // Whether there is a game (the wait page asks).
            if rest == "game" {
                let v = crate::codec::json::Value::object().with("game", self.game().is_some());
                let mut r = httpd::response(
                    200,
                    "OK",
                    "application/json; charset=utf-8",
                    v.to_json().into_bytes(),
                );
                r.headers.set("Cache-Control", "no-store");
                return r;
            }
            // The games list's API (the page itself is a file below).
            if l == Listener::Local && (rest.starts_with("api/") || rest.starts_with("catalog/")) {
                if !self.token_ok(req, "") {
                    return httpd::error_response(403, "Forbidden");
                }
                if req.method == "POST" && !self.origin_ok(req, l) {
                    return httpd::error_response(403, "Forbidden");
                }
                return match self.picker.handle(req, path) {
                    Some(r) => r,
                    None => httpd::error_response(404, "Not Found"),
                };
            }
            // tvpipe's look, for any page (the browser player's files).
            if rest == "ui.css" {
                let css = fonts::UI_CSS.as_bytes().to_vec();
                return file_response(req, "ui.css", css, None);
            }
            if let Some(name) = rest.strip_prefix("fonts/") {
                return fonts::font_response(fonts::font(name));
            }
            let Some(rel) = percent_decode(rest).and_then(|r| {
                let r = if r.is_empty() || r.ends_with('/') {
                    format!("{r}index.html")
                } else {
                    r
                };
                clean_path(&r)
            }) else {
                return httpd::error_response(404, "Not Found");
            };
            // The launcher, the games list and the TV sync page (cast
            // from the local origin) only on this computer.
            let allowed = rel.starts_with("lib/")
                || rel.starts_with("wait/")
                || (l == Listener::Local
                    && (rel.starts_with("launcher/")
                        || rel.starts_with("tvsync/")
                        || rel.starts_with(&picker::PAGE["/_tvpipe/".len()..])));
            if !allowed {
                return httpd::error_response(404, "Not Found");
            }
            return match web::get(&rel) {
                Some(bytes) => file_response(req, &rel, bytes.into_owned(), None),
                None => httpd::error_response(404, "Not Found"),
            };
        }
        self.bundle_file(req, path, query)
    }

    fn bundle_file(&self, req: &Request, path: &str, query: &str) -> Response {
        let Some(decoded) = percent_decode(path) else {
            return httpd::error_response(400, "Bad Request");
        };
        let rel = decoded.trim_start_matches('/');
        let rel = if rel.is_empty() || rel.ends_with('/') {
            format!("{rel}index.html")
        } else {
            rel.to_owned()
        };
        let Some(rel) = clean_path(&rel) else {
            return httpd::error_response(404, "Not Found");
        };
        if rel == "_tvpipe" || rel.starts_with("_tvpipe/") {
            return httpd::error_response(404, "Not Found");
        }
        let Some(game) = self.game() else {
            return httpd::error_response(404, "Not Found");
        };
        match game.bundle.get(&rel) {
            Lookup::File(f) => {
                let mut r = file_response(req, &rel, f.bytes, Some(f.etag));
                // Which game the page is of (docs/game-switching.md).
                r.headers.add(
                    "Set-Cookie",
                    format!(
                        "{GAME_COOKIE}={}; Path=/; SameSite=Lax",
                        self.game_tag(&game)
                    ),
                );
                r
            }
            Lookup::Dir => {
                let q = if query.is_empty() {
                    String::new()
                } else {
                    format!("?{query}")
                };
                redirect(301, &format!("{path}/{q}"))
            }
            Lookup::NotFound => httpd::error_response(404, "Not Found"),
        }
    }

    fn upgrade(self: &Arc<Hub>, req: &Request, l: Listener, path: &str, query: &str) -> Reply {
        let refuse =
            |status: u16, reason: &str| Reply::Response(httpd::error_response(status, reason));
        let api = path == "/_tvpipe/api";
        let surface = path == "/_tvpipe/surface" && l == Listener::Local;
        if !(path == "/_tvpipe/ws" || surface || (api && l == Listener::Local)) {
            return refuse(404, "Not Found");
        }
        if !self.origin_ok(req, l) {
            warn!(
                "playshare: a WebSocket from origin {:?} refused",
                req.headers.get("origin").unwrap_or("")
            );
            return refuse(403, "Forbidden");
        }
        if (api || surface) && !self.token_ok(req, query) {
            return refuse(403, "Forbidden");
        }
        let surface_id = if surface {
            match query_param(query, "id").and_then(|i| i.parse::<u32>().ok()) {
                Some(id) if self.surface_exists(id) => Some(id),
                _ => return refuse(404, "Not Found"),
            }
        } else {
            None
        };
        let resp = match websocket::server_response(req) {
            Ok(r) => r,
            Err(e) => return refuse(400, &format!("Bad Request: {}", e.message())),
        };
        let hub = self.clone();
        if let Some(id) = surface_id {
            return Reply::Upgrade(
                resp,
                Box::new(move |tcp, rest| hub.run_surface(tcp, rest, id)),
            );
        }
        if api {
            return Reply::Upgrade(resp, Box::new(move |tcp, rest| hub.run_api(tcp, rest)));
        }
        // A page of an earlier game: closed at once, it goes to its join
        // link (docs/game-switching.md).
        if let Some(g) = query_param(query, "g") {
            let current = self.game().map(|game| self.game_tag(&game));
            if current.as_deref() != Some(g) {
                return Reply::Upgrade(resp, Box::new(move |tcp, rest| hub.run_stale(tcp, rest)));
            }
        }
        let addr = self.address(req, l);
        if let Err((status, reason)) = self.admit(&addr) {
            return refuse(status, reason);
        }
        let via = match l {
            Listener::Local => Via::Local,
            Listener::Public => Via::Public,
            Listener::Lan => Via::Lan,
        };
        let query: String = query.chars().take(512).collect();
        let agent: String = req
            .headers
            .get("user-agent")
            .unwrap_or("")
            .chars()
            .take(256)
            .collect();
        Reply::Upgrade(
            resp,
            Box::new(move |tcp, rest| hub.run_client(tcp, rest, via, addr, query, agent)),
        )
    }
}

fn file_response(req: &Request, rel: &str, bytes: Vec<u8>, etag: Option<String>) -> Response {
    let etag = etag.unwrap_or_else(|| bundle::etag_of(&bytes));
    if req
        .headers
        .get("if-none-match")
        .is_some_and(|v| v.trim() == etag)
    {
        let mut r = Response::new(Version::Http11, 304, "Not Modified");
        r.headers.add("ETag", etag).add("Cache-Control", "no-cache");
        return r;
    }
    let mut r = httpd::response(200, "OK", bundle::mime(rel), bytes);
    r.headers
        .set("Cache-Control", "no-cache")
        .add("ETag", etag)
        .add("Referrer-Policy", "no-referrer");
    r
}

/// The handler of one listener.
pub fn handler(hub: Arc<Hub>, l: Listener) -> Handler {
    Arc::new(move |req: &Request| hub.handle(req, l))
}
