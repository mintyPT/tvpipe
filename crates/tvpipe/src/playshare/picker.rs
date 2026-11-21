//! The games list in the window (docs/game-catalog.md,
//! docs/game-switching.md): the games on this computer the command line
//! named (bundles, folders of them), then the online list with its
//! screenshots (fetched by tvpipe, never by the window), and the choice:
//! a game of either list or a source typed in, fetched in the background,
//! asked about in the window when it is new (§18), then put in the hub's
//! slot (the first game, or the next one). The page is served by the
//! local listener (`/_tvpipe/picker/`), the API here.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use crate::codec::json::Value;
use crate::error::{Error, Result};
use crate::events::{Event, Events, Progress};
use crate::net::fetch::Url;
use crate::net::http::{Request, Response};
use crate::net::httpd;

use super::bundle::{Bundle, Manifest, MANIFEST};
use super::check;
use super::hub::Hub;
use super::remote::{Fetched, Fetcher};
use super::source::{self, Source};

/// Makes a fetcher whose progress goes to these events.
pub type MakeFetcher = Arc<dyn Fn(Events) -> Result<Fetcher> + Send + Sync>;

/// The picker's page.
pub const PAGE: &str = "/_tvpipe/picker/";

/// What the picker offers.
#[derive(Clone, Default)]
pub struct Config {
    /// The online list and games from the internet; `None`: neither.
    pub make: Option<MakeFetcher>,
    /// `--yes`: no question.
    pub yes: bool,
    /// The command line's games on this computer: bundles (a folder with
    /// `tvpipe.json`, a zip) and folders of bundles.
    pub local: Vec<PathBuf>,
}

/// Where the choice is.
enum Job {
    Idle,
    Fetching {
        source: String,
        done: u64,
        total: Option<u64>,
    },
    /// A game nobody said yes to yet: the question in the window.
    Ask {
        fetcher: Box<Fetcher>,
        fetched: Box<Fetched>,
    },
    /// Chosen: going into the slot.
    Starting {
        title: String,
    },
    /// In the slot: the page goes to `url`.
    Ready {
        url: String,
    },
    Failed {
        source: String,
        error: String,
    },
}

/// The games list as the page gets it, and the screenshots' URLs.
struct Catalog {
    value: Value,
    pictures: Vec<Url>,
}

struct St {
    job: Job,
    /// Counts choices: a finished fetch of an older one is dropped, and
    /// a page follows `ready` only for its own.
    choice: u64,
    catalog: Option<Arc<Catalog>>,
}

struct Shared {
    cfg: Config,
    hub: Weak<Hub>,
    st: Mutex<St>,
}

/// The games list and the choice, in the hub.
pub(crate) struct Picker {
    shared: Arc<Shared>,
}

/// A game on this computer the list shows.
pub(crate) struct LocalGame {
    /// How the page names it: its path as given or found.
    pub id: String,
    pub path: PathBuf,
    /// Its manifest, or why it cannot be played.
    pub manifest: std::result::Result<Manifest, String>,
}

/// Whether `path` is one game (a folder with `tvpipe.json`, or a file)
/// rather than a folder of games.
pub fn is_bundle(path: &Path) -> bool {
    !path.is_dir() || path.join(MANIFEST).is_file()
}

/// The games of `roots`: each a bundle, or a folder whose folders with
/// `tvpipe.json` and zips are (hidden ones left out, by name).
pub(crate) fn scan(roots: &[PathBuf]) -> Vec<LocalGame> {
    let mut out = Vec::new();
    for root in roots {
        let mut paths = Vec::new();
        if is_bundle(root) {
            paths.push(root.clone());
        } else if let Ok(rd) = std::fs::read_dir(root) {
            let mut found: Vec<PathBuf> = rd
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name.starts_with('.') {
                        return false;
                    }
                    if p.is_dir() {
                        p.join(MANIFEST).is_file()
                    } else {
                        name.to_ascii_lowercase().ends_with(".zip")
                    }
                })
                .collect();
            found.sort();
            paths.extend(found);
        }
        for path in paths {
            let manifest = Bundle::open(&path)
                .map(|b| b.manifest)
                .map_err(|e| e.to_string());
            out.push(LocalGame {
                id: path.display().to_string(),
                path,
                manifest,
            });
        }
    }
    out
}

impl Picker {
    pub(crate) fn new(cfg: Config, hub: Weak<Hub>) -> Picker {
        Picker {
            shared: Arc::new(Shared {
                cfg,
                hub,
                st: Mutex::new(St {
                    job: Job::Idle,
                    choice: 0,
                    catalog: None,
                }),
            }),
        }
    }

    /// The API (`/_tvpipe/api/catalog`, `/_tvpipe/catalog/N`,
    /// `/_tvpipe/api/game`), for the local listener once the token and,
    /// for a POST, the origin are checked; `None`: not the picker's.
    pub(crate) fn handle(&self, req: &Request, path: &str) -> Option<Response> {
        let s = &self.shared;
        if path == "/_tvpipe/api/catalog" {
            return Some(json(200, &s.catalog_value()));
        }
        if let Some(n) = path.strip_prefix("/_tvpipe/catalog/") {
            return Some(s.picture(n));
        }
        if path != "/_tvpipe/api/game" {
            return None;
        }
        if req.method != "POST" {
            return Some(json(200, &s.state()));
        }
        let body = match Value::parse(&String::from_utf8_lossy(&req.body)) {
            Ok(v) => v,
            Err(_) => return Some(error_json(400, "a JSON object")),
        };
        Some(match s.post(&body) {
            Ok(()) => json(200, &s.state()),
            Err((status, msg)) => error_json(status, &msg),
        })
    }
}

fn json(status: u16, v: &Value) -> Response {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Error",
    };
    let mut r = httpd::response(
        status,
        reason,
        "application/json; charset=utf-8",
        v.to_json().into_bytes(),
    );
    r.headers.set("Cache-Control", "no-store");
    r
}

fn error_json(status: u16, msg: &str) -> Response {
    json(status, &Value::object().with("error", msg))
}

/// The games list's entries the page can show: a name, a title and a
/// source each; screenshots resolved against the list's URL (`https://`
/// only).
fn catalog_of(list: &Value, base: &Url, fetcher: &Fetcher) -> Catalog {
    let mut pictures = Vec::new();
    let mut games = Vec::new();
    for g in list.get("games").and_then(Value::as_array).unwrap_or(&[]) {
        let s = |k: &str| g.get(k).and_then(Value::as_str);
        let (Some(name), Some(title), Some(src)) = (s("name"), s("title"), s("source")) else {
            continue;
        };
        if !source::is_name(name) {
            continue;
        }
        let mut shots = Vec::new();
        for p in g
            .get("screenshots")
            .and_then(Value::as_array)
            .unwrap_or(&[])
        {
            let Some(url) = p
                .get("src")
                .and_then(Value::as_str)
                .and_then(|src| base.join(src).ok())
                .filter(|u| u.https || u.is_loopback())
            else {
                continue;
            };
            let kind = match p.get("kind").and_then(Value::as_str) {
                Some("phone") => "phone",
                _ => "tv",
            };
            shots.push(
                Value::object()
                    .with("src", format!("/_tvpipe/catalog/{}", pictures.len()))
                    .with("alt", p.get("alt").and_then(Value::as_str).unwrap_or(""))
                    .with("kind", kind),
            );
            pictures.push(url);
        }
        let players = g.get("players");
        let num = |k: &str| players.and_then(|p| p.get(k)).and_then(Value::as_u64);
        let languages: Vec<Value> = g
            .get("languages")
            .and_then(Value::as_array)
            .unwrap_or(&[])
            .iter()
            .filter_map(Value::as_str)
            .map(Value::from)
            .collect();
        games.push(
            Value::object()
                .with("name", name)
                .with("title", title)
                .with("summary", s("summary").unwrap_or(""))
                .with_opt("min", num("min"))
                .with_opt("max", num("max"))
                .with("languages", Value::Array(languages))
                .with_opt("home", s("home").filter(|h| h.starts_with("https://")))
                .with("downloaded", fetcher.downloaded(src))
                .with("screenshots", Value::Array(shots)),
        );
    }
    Catalog {
        value: Value::object().with("games", Value::Array(games)),
        pictures,
    }
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, St> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn fetcher(&self, events: Events) -> Result<Fetcher> {
        match &self.cfg.make {
            Some(make) => make(events),
            None => Err(Error::unsupported("no games from the internet here")),
        }
    }

    fn catalog(&self) -> Result<Arc<Catalog>> {
        if let Some(c) = &self.lock().catalog {
            return Ok(c.clone());
        }
        let fetcher = self.fetcher(Events::none())?;
        let list = fetcher.catalog()?;
        let c = Arc::new(catalog_of(&list, &fetcher.list_url()?, &fetcher));
        self.lock().catalog = Some(c.clone());
        Ok(c)
    }

    /// `GET /_tvpipe/api/catalog`: the games on this computer (scanned
    /// again each time), then the online list. A local game takes the
    /// summary, languages and pictures of the online entry of its name.
    fn catalog_value(&self) -> Value {
        let (online, error) = match (&self.cfg.make, self.catalog()) {
            (_, Ok(c)) => (Some(c), None),
            (None, Err(_)) => (None, None),
            (Some(_), Err(e)) => (None, Some(e.to_string())),
        };
        let games: &[Value] = online
            .as_ref()
            .and_then(|c| c.value.get("games"))
            .and_then(Value::as_array)
            .unwrap_or(&[]);
        let mut local = Vec::new();
        for g in scan(&self.cfg.local) {
            let mut v = Value::object()
                .with("id", g.id.as_str())
                .with("from", g.id.as_str());
            match &g.manifest {
                Ok(m) => {
                    v = v
                        .with("name", m.name.as_str())
                        .with("title", m.title.as_str())
                        .with("min", m.min_players)
                        .with("max", m.max_players);
                    let twin = games
                        .iter()
                        .find(|o| o.get("name").and_then(Value::as_str) == Some(m.name.as_str()));
                    for k in ["summary", "languages", "screenshots"] {
                        if let Some(x) = twin.and_then(|t| t.get(k)) {
                            v = v.with(k, x.clone());
                        }
                    }
                }
                Err(e) => {
                    let name = g
                        .path
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| g.id.clone());
                    v = v.with("title", name).with("error", e.as_str());
                }
            }
            local.push(v);
        }
        Value::object()
            .with("local", Value::Array(local))
            .with("games", Value::Array(games.to_vec()))
            .with("online", self.cfg.make.is_some())
            .with_opt("error", error)
    }

    fn picture(&self, n: &str) -> Response {
        let url = self.lock().catalog.as_ref().and_then(|c| {
            n.parse::<usize>()
                .ok()
                .and_then(|i| c.pictures.get(i).cloned())
        });
        let Some(url) = url else {
            return httpd::error_response(404, "Not Found");
        };
        let got = self.fetcher(Events::none()).and_then(|f| f.picture(&url));
        match got {
            Ok((bytes, mime)) => {
                let mut r = httpd::response(200, "OK", mime, bytes);
                r.headers.set("Cache-Control", "private, max-age=3600");
                r
            }
            Err(e) => {
                debug!("picker: {url}: {e}");
                httpd::error_response(404, "Not Found")
            }
        }
    }

    /// The choice's state for the page, with the game in the slot.
    fn state(&self) -> Value {
        let current = self.hub.upgrade().and_then(|h| h.game()).map(|g| {
            let m = &g.bundle.manifest;
            Value::object()
                .with("name", m.name.as_str())
                .with("title", m.title.as_str())
                .with("from", g.bundle.origin.display().to_string())
        });
        let st = self.lock();
        let v = match &st.job {
            Job::Idle => Value::object().with("state", "idle"),
            Job::Fetching {
                source,
                done,
                total,
            } => Value::object()
                .with("state", "fetching")
                .with("source", source.as_str())
                .with("done", *done)
                .with_opt("total", *total),
            Job::Ask { fetched: f, .. } => {
                let m = &f.bundle.manifest;
                let (files, unpacked) = f.bundle.zip_stats().unwrap_or((0, 0));
                Value::object().with("state", "ask").with(
                    "game",
                    Value::object()
                        .with("name", m.name.as_str())
                        .with("title", m.title.as_str())
                        .with("from", f.shown.as_str())
                        .with_opt("release", f.tag.as_deref())
                        .with("size", check::human(f.size))
                        .with("files", files)
                        .with("unpacked", check::human(unpacked))
                        .with_opt("tvpipe", m.tvpipe.as_deref())
                        .with("sha256", f.sha256.as_str())
                        .with("changed", f.changed),
                )
            }
            Job::Starting { title } => Value::object()
                .with("state", "starting")
                .with("title", title.as_str()),
            Job::Ready { url } => Value::object()
                .with("state", "ready")
                .with("url", url.as_str()),
            Job::Failed { source, error } => Value::object()
                .with("state", "failed")
                .with("source", source.as_str())
                .with("error", error.as_str()),
        };
        v.with("choice", st.choice).with_opt("current", current)
    }

    /// `{"source": S}` (a game from the internet or of the online list),
    /// `{"local": ID}` (a game of the local list), `{"trust": true}` (yes
    /// to the question), `{"back": true}` (no, or after an error: the
    /// list again).
    fn post(self: &Arc<Shared>, body: &Value) -> std::result::Result<(), (u16, String)> {
        let busy = |st: &St| {
            matches!(
                st.job,
                Job::Fetching { .. } | Job::Ask { .. } | Job::Starting { .. }
            )
        };
        if let Some(id) = body.get("local").and_then(Value::as_str) {
            let game = scan(&self.cfg.local)
                .into_iter()
                .find(|g| g.id == id)
                .ok_or_else(|| (404, format!("{id}: not a game of the list")))?;
            if let Err(e) = &game.manifest {
                return Err((409, e.clone()));
            }
            let mut st = self.lock();
            if busy(&st) {
                return Err((409, "a game is being fetched or started".into()));
            }
            st.choice += 1;
            let choice = st.choice;
            st.job = Job::Starting {
                title: id.to_owned(),
            };
            drop(st);
            let res = Bundle::open(&game.path);
            self.finish(choice, id, res);
            return Ok(());
        }
        if let Some(s) = body.get("source").and_then(Value::as_str) {
            let src = Source::parse_remote(s).map_err(|e| (400, e.to_string()))?;
            if self.cfg.make.is_none() {
                return Err((400, "no games from the internet here".into()));
            }
            let mut st = self.lock();
            if busy(&st) {
                return Err((409, "a game is being fetched or started".into()));
            }
            st.choice += 1;
            let choice = st.choice;
            st.job = Job::Fetching {
                source: s.trim().to_owned(),
                done: 0,
                total: None,
            };
            drop(st);
            let me = self.clone();
            let shown = s.trim().to_owned();
            std::thread::Builder::new()
                .name("picker-fetch".into())
                .spawn(move || me.fetch(choice, &shown, &src))
                .map_err(|e| (500, format!("spawn: {e}")))?;
            return Ok(());
        }
        if body.get("trust").and_then(Value::as_bool) == Some(true) {
            let mut st = self.lock();
            let job = std::mem::replace(&mut st.job, Job::Idle);
            let Job::Ask { fetcher, fetched } = job else {
                st.job = job;
                return Err((409, "no question to answer".into()));
            };
            if let Err(e) = fetcher.trust(&fetched) {
                warn!("picker: remembering the answer: {e}");
            }
            let choice = st.choice;
            st.job = Job::Starting {
                title: fetched.bundle.manifest.title.clone(),
            };
            drop(st);
            let shown = fetched.shown.clone();
            self.finish(choice, &shown, Ok(fetched.bundle));
            return Ok(());
        }
        if body.get("back").and_then(Value::as_bool) == Some(true) {
            let mut st = self.lock();
            if matches!(st.job, Job::Fetching { .. } | Job::Starting { .. }) {
                return Err((409, "a game is being fetched or started".into()));
            }
            st.choice += 1;
            st.job = Job::Idle;
            return Ok(());
        }
        Err((400, "expected local, source, trust or back".into()))
    }

    /// Fetches a choice (on its own thread).
    fn fetch(self: Arc<Shared>, choice: u64, shown: &str, src: &Source) {
        let me = Arc::downgrade(&self);
        let events = Events::to(move |e| {
            if let Event::Progress(Progress::Download { done, total }) = e {
                if let Some(me) = me.upgrade() {
                    let mut st = me.lock();
                    if st.choice == choice {
                        if let Job::Fetching {
                            done: d, total: t, ..
                        } = &mut st.job
                        {
                            *d = done;
                            *t = total;
                        }
                    }
                }
            }
        });
        let res = self.fetcher(events).and_then(|fetcher| {
            let f = fetcher.fetch(src)?;
            Ok((fetcher, f))
        });
        let mut st = self.lock();
        if st.choice != choice {
            return;
        }
        match res {
            Ok((_, f)) if f.pinned || f.trusted || self.cfg.yes => {
                st.job = Job::Starting {
                    title: f.bundle.manifest.title.clone(),
                };
                drop(st);
                self.finish(choice, &f.shown, Ok(f.bundle));
            }
            Ok((fetcher, f)) => {
                st.job = Job::Ask {
                    fetcher: Box::new(fetcher),
                    fetched: Box::new(f),
                }
            }
            Err(e) => {
                st.job = Job::Failed {
                    source: shown.to_owned(),
                    error: e.to_string(),
                }
            }
        }
    }

    /// The chosen game into the hub's slot (or why not).
    fn finish(&self, choice: u64, shown: &str, bundle: Result<Bundle>) {
        let job = match (bundle, self.hub.upgrade()) {
            (Ok(b), Some(hub)) => {
                info!("playshare: picked {} from {shown}", b.manifest.title);
                Job::Ready { url: hub.put(b) }
            }
            (Ok(_), None) => Job::Failed {
                source: shown.to_owned(),
                error: "playshare is ending".into(),
            },
            (Err(e), _) => Job::Failed {
                source: shown.to_owned(),
                error: e.to_string(),
            },
        };
        let mut st = self.lock();
        if st.choice == choice {
            st.job = job;
        }
    }
}

#[cfg(test)]
mod tests;
