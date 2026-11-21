//! The state of one playshare run (a session): the game in its slot,
//! the API sockets, the relay's client connections and its host, the
//! room, the launcher's selection, discovery, pairing and the cast
//! (docs/playshare-design.md §5, §6; docs/game-switching.md).
//!
//! Locks: `Hub::st` is taken briefly and never while waiting on a socket;
//! outboxes have locks of their own, taken after `st` or alone; the game
//! slot's after `st` or alone (never `st` while holding the slot).

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock, RwLockReadGuard};
use std::time::{Duration, Instant};

use crate::codec::json::Value;
use crate::error::{Error, Result};
use crate::events::{Events, Progress};
use crate::net::tunnel::PeerLookup;
use crate::net::websocket::Message;
use crate::util::stop::Stop;

use super::backend::{Backend, Cast, Discover, Pair};
use super::bundle::Bundle;
use super::conn::{self, Next, Out, WindowCounter};
use super::picker::{self, Picker};
use super::resolution::{Picture, Resolution};

/// Relay frame ops (§6.2).
pub const OP_TEXT: u8 = 1;
pub const OP_BINARY: u8 = 2;

/// A client's backlog that is reported as `busy`.
pub const BUSY_MARK: usize = 64 * 1024;
/// A client's backlog that closes it (4013, it reconnects).
pub const CLIENT_LIMIT: usize = 1 << 20;
/// The first message from a client must come within this.
pub const FIRST_MESSAGE: Duration = Duration::from_secs(10);
/// Upgrades per address and minute.
pub const UPGRADES_PER_MINUTE: usize = 60;
/// The API socket's largest message (the host sends to many clients).
pub const API_MAX_MESSAGE: usize = 16 << 20;
/// How long the host gets to say goodbye at the end.
pub const CLOSING_GRACE: Duration = Duration::from_secs(1);

/// The close code that tells clients the game ended (final for them).
pub const CLOSE_ENDED: u16 = 4011;
/// The close code for clients when the host went away (they reconnect).
pub const CLOSE_RESTART: u16 = 1012;
/// The close code for clients when another game took the slot: phones go
/// to their join link, which is the next game's now.
pub const CLOSE_NEXT_GAME: u16 = 4014;

/// The cookie that names the game a page was loaded with (`RUN.GEN`).
pub const GAME_COOKIE: &str = "tvpipe-game";

/// A game in the hub's slot.
pub struct Game {
    pub bundle: Bundle,
    /// The session's games counted: 1 for the first.
    pub gen: u64,
}

/// The room of the session: every game's party has this code and join
/// key, so the join link stays from game to game.
#[derive(Debug, Clone)]
pub struct Room {
    /// Four consonants (`roomCode()` of `@tvpipe/party`).
    pub code: String,
    /// 16 random bytes, base64url.
    pub key: String,
}

/// The letters of room codes (`CODE_LETTERS` of `@tvpipe/party`).
const CODE_LETTERS: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";

impl Room {
    pub fn new() -> Result<Room> {
        let r = crate::crypto::ring::random_array::<4>()?;
        let code = r
            .iter()
            .map(|b| CODE_LETTERS[*b as usize % CODE_LETTERS.len()] as char)
            .collect();
        let k = crate::crypto::ring::random_array::<16>()?;
        Ok(Room {
            code,
            key: base64url(&k),
        })
    }
}

/// Base64 with the URL alphabet, no padding.
pub fn base64url(data: &[u8]) -> String {
    crate::net::base64::encode(data)
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_")
}

/// Where a relayed connection came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    /// The public listener: the tunnel, or loopback for tests.
    Public,
    /// The LAN listener.
    Lan,
    /// The local listener: the TV page, previews in the host window.
    Local,
}

impl Via {
    pub fn as_str(self) -> &'static str {
        match self {
            Via::Public => "public",
            Via::Lan => "lan",
            Via::Local => "local",
        }
    }
}

/// The listeners' addresses, once bound.
#[derive(Debug, Clone, Copy)]
pub struct Ports {
    pub local: u16,
    pub public: u16,
    pub lan: Option<SocketAddr>,
}

/// The tunnel as the API reports it.
#[derive(Debug, Clone, Default)]
pub struct TunnelInfo {
    /// `off`, `starting`, `up`, `failed`.
    pub state: &'static str,
    pub provider: Option<String>,
    pub host: Option<String>,
    pub error: Option<String>,
}

struct Client {
    out: Out,
}

pub(super) struct Api {
    out: Out,
    watching: bool,
}

pub(super) struct St {
    next_conn: u32,
    next_api: u64,
    clients: HashMap<u32, Client>,
    pub(super) apis: HashMap<u64, Api>,
    host: Option<u64>,
    selection: Vec<String>,
    /// The chosen resolution (the launcher's or the cast picker's).
    resolution: Resolution,
    upgrades: WindowCounter,
    discovery: Option<Box<dyn Discover>>,
    devices: Value,
    pairs: HashMap<String, (Box<dyn Pair>, Value)>,
    cast: Option<Casting>,
    /// When the last API socket went away (none open), or when the run
    /// started if none came yet.
    apis_gone_since: Option<Instant>,
    seen_api: bool,
    closing: bool,
    /// The short link the front end was told about last.
    short_shown: Option<String>,
}

pub struct Hub {
    /// The game being played; empty until one is picked.
    game: RwLock<Option<Arc<Game>>>,
    pub token: String,
    /// This run in [`GAME_COOKIE`] (random, not secret).
    pub run: String,
    pub room: Room,
    /// The games list and the choice (`/_tvpipe/picker/`).
    pub(super) picker: Picker,
    pub ports: OnceLock<Ports>,
    pub tunnel: RwLock<TunnelInfo>,
    pub peers: RwLock<Option<PeerLookup>>,
    pub stop: Stop,
    pub version: &'static str,
    pub(super) backend: Box<dyn Backend>,
    st: Mutex<St>,
    pub(super) surfaces: Mutex<super::surface::Surfaces>,
    /// The run's progress for people (the CLI's terminal UI), set once.
    pub events: OnceLock<Events>,
    /// Short join links (`shortlink`), set once; unset: none.
    pub shortlinks: OnceLock<Arc<super::shortlink::ShortLinks>>,
    /// The TVs' display lags (the storage's `tv-lag`), by name.
    lags: Mutex<BTreeMap<String, u32>>,
    /// Test mode (`--dev`): `info.dev`, the games' test tools.
    pub dev: AtomicBool,
}

/// `{"t":"event","type":…,"data":…}`.
fn event(kind: &str, data: Value) -> String {
    Value::object()
        .with("t", "event")
        .with("type", kind)
        .with("data", data)
        .to_json()
}

fn reply_ok(n: &Value, value: Value) -> String {
    Value::object()
        .with("t", "reply")
        .with("n", n.clone())
        .with("ok", true)
        .with("value", value)
        .to_json()
}

fn reply_err(n: &Value, code: &str, message: &str) -> String {
    Value::object()
        .with("t", "reply")
        .with("n", n.clone())
        .with("ok", false)
        .with(
            "error",
            Value::object().with("code", code).with("message", message),
        )
        .to_json()
}

/// A relay data frame: `op | conn (u32be) | payload`.
pub fn frame(op: u8, conn: u32, payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(5 + payload.len());
    f.push(op);
    f.extend_from_slice(&conn.to_be_bytes());
    f.extend_from_slice(payload);
    f
}

/// A `resolution` parameter.
fn parse_resolution(v: &Value) -> Result<Resolution> {
    v.as_str().and_then(Resolution::parse).ok_or_else(|| {
        Error::usage("resolution is auto, 720p, 1080p or 2160p").with_code("bad-resolution")
    })
}

/// The running cast: the job, its last status, and what it shows where
/// (another page for the same TVs and picture goes into its tab).
pub(super) struct Casting {
    job: Box<dyn Cast>,
    last: Value,
    to: Vec<String>,
    picture: Picture,
}

/// The same receivers, in any order.
fn same_receivers(a: &[String], b: &[String]) -> bool {
    let norm = |l: &[String]| {
        let mut v: Vec<String> = l.iter().map(|s| s.trim().to_lowercase()).collect();
        v.sort();
        v.dedup();
        v
    };
    norm(a) == norm(b)
}

/// The pseudo-receiver for a browser tab on this computer.
pub fn browser_device() -> Value {
    Value::object()
        .with("name", "browser")
        .with("kind", "browser")
        .with("title", "A browser tab on this computer")
}

impl Hub {
    /// A hub with `bundle` in the slot and no games list (tests).
    pub fn new(bundle: Bundle, token: String, backend: Box<dyn Backend>, stop: Stop) -> Arc<Hub> {
        let hub = Hub::session(token, backend, stop, picker::Config::default());
        hub.put(bundle);
        hub
    }

    /// A hub without a game: the window picks one (`picker`).
    pub fn session(
        token: String,
        backend: Box<dyn Backend>,
        stop: Stop,
        picker: picker::Config,
    ) -> Arc<Hub> {
        let random = |n: usize| {
            crate::crypto::ring::random_array::<16>()
                .map(|b| crate::util::hex::encode(&b[..n]))
                .unwrap_or_default()
        };
        let room = Room::new().unwrap_or_else(|_| Room {
            code: "BCDF".into(),
            key: random(16),
        });
        let lags = match backend.storage().map(|s| s.tv_lags()) {
            Some(Ok(l)) => l,
            Some(Err(e)) => {
                warn!("playshare: the TVs' lags: {e}");
                BTreeMap::new()
            }
            None => BTreeMap::new(),
        };
        Arc::new_cyclic(|me| Hub {
            lags: Mutex::new(lags),
            dev: AtomicBool::new(false),
            game: RwLock::new(None),
            token,
            run: random(4),
            room,
            picker: Picker::new(picker, me.clone()),
            ports: OnceLock::new(),
            tunnel: RwLock::new(TunnelInfo {
                state: "off",
                ..TunnelInfo::default()
            }),
            peers: RwLock::new(None),
            stop,
            version: env!("CARGO_PKG_VERSION"),
            backend,
            surfaces: Mutex::default(),
            events: OnceLock::new(),
            shortlinks: OnceLock::new(),
            st: Mutex::new(St {
                short_shown: None,
                next_conn: 0,
                next_api: 0,
                clients: HashMap::new(),
                apis: HashMap::new(),
                host: None,
                selection: Vec::new(),
                resolution: Resolution::Auto,
                upgrades: WindowCounter::new(UPGRADES_PER_MINUTE, Duration::from_secs(60)),
                discovery: None,
                devices: Value::array(Vec::<Value>::new()),
                pairs: HashMap::new(),
                cast: None,
                apis_gone_since: Some(Instant::now()),
                seen_api: false,
                closing: false,
            }),
        })
    }

    pub(super) fn lock(&self) -> MutexGuard<'_, St> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn slot(&self) -> RwLockReadGuard<'_, Option<Arc<Game>>> {
        self.game.read().unwrap_or_else(|e| e.into_inner())
    }

    /// The game in the slot, if one was picked.
    pub fn game(&self) -> Option<Arc<Game>> {
        self.slot().clone()
    }

    /// The game, or the API's `no-game`.
    fn need_game(&self) -> Result<Arc<Game>> {
        self.game()
            .ok_or_else(|| Error::usage("no game yet: pick one in the window").with_code("no-game"))
    }

    /// The [`GAME_COOKIE`] of `game`'s pages.
    pub fn game_tag(&self, game: &Game) -> String {
        format!("{}.{}", self.run, game.gen)
    }

    /// Where the window starts: the game's launcher (its own or
    /// tvpipe's), the games list without a game.
    pub fn start_page(&self) -> String {
        match self.game() {
            Some(g) => launcher_of(&g.bundle),
            None => picker::PAGE.to_owned(),
        }
    }

    /// Puts `bundle` in the slot: the first game, or the next one
    /// (docs/game-switching.md): the relay's clients are closed with
    /// [`CLOSE_NEXT_GAME`] (phones go to their join link), surfaces stop,
    /// the host is detached, and the API sockets get `game` with the page
    /// to go to (the host page when TVs are chosen, else the launcher),
    /// which this returns.
    pub fn put(&self, bundle: Bundle) -> String {
        let game = {
            let mut slot = self.game.write().unwrap_or_else(|e| e.into_inner());
            let gen = slot.as_ref().map_or(1, |g| g.gen + 1);
            let game = Arc::new(Game { bundle, gen });
            *slot = Some(game.clone());
            game
        };
        let m = &game.bundle.manifest;
        let chosen = {
            let mut st = self.lock();
            if game.gen > 1 {
                Hub::close_clients(&mut st, CLOSE_NEXT_GAME, "next game");
                if st.host.take().is_some() {
                    info!("playshare: the host page of the last game is detached");
                }
            }
            !st.selection.is_empty()
        };
        if game.gen > 1 {
            self.surfaces_stop_all();
        }
        let url = if chosen {
            format!("/{}", m.pages.host)
        } else {
            launcher_of(&game.bundle)
        };
        info!(
            "playshare: {} from {}",
            m.title,
            game.bundle.origin.display()
        );
        if let Some(p) = self.ports.get() {
            let local = format!("http://127.0.0.1:{}/", p.public);
            let lan = p.lan.map(|lan| format!("http://{lan}/"));
            info!(
                "playshare: phones on this computer: {local}{}",
                lan.as_ref()
                    .map(|l| format!(", on the Wi-Fi: {l}"))
                    .unwrap_or_default()
            );
            self.progress(Progress::Game {
                title: m.title.clone(),
                local,
                lan,
            });
        }
        self.event(
            "game",
            Value::object()
                .with("name", m.name.as_str())
                .with("title", m.title.as_str())
                .with("url", url.as_str()),
        );
        url
    }

    fn ports(&self) -> Ports {
        self.ports.get().copied().unwrap_or(Ports {
            local: 0,
            public: 0,
            lan: None,
        })
    }

    /// The local origin (`http://127.0.0.1:L`).
    pub fn local_origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.ports().local)
    }

    /// What phones open: `(base URL, mode)`.
    pub fn phone_base(&self) -> (String, &'static str) {
        let t = self.tunnel.read().unwrap_or_else(|e| e.into_inner());
        if let (Some(host), "up") = (&t.host, t.state) {
            return (format!("https://{host}/"), "tunnel");
        }
        let p = self.ports();
        if let Some(lan) = p.lan {
            return (format!("http://{lan}/"), "lan");
        }
        (format!("http://127.0.0.1:{}/", p.public), "local")
    }

    /// The most connections the relay takes at once (the game's).
    pub fn max_clients(&self) -> usize {
        let max = self
            .slot()
            .as_ref()
            .map_or(8, |g| g.bundle.manifest.max_players);
        relay_limit(max)
    }

    // -----------------------------------------------------------------
    // Events

    fn broadcast(&self, st: &St, text: &str) {
        for a in st.apis.values() {
            a.out.text(text.to_owned());
        }
    }

    /// A progress event for the program's front end.
    pub fn progress(&self, p: Progress) {
        if let Some(e) = self.events.get() {
            e.progress(p);
        }
    }

    /// Sends an event to every API socket.
    pub fn event(&self, kind: &str, data: Value) {
        let text = event(kind, data);
        let st = self.lock();
        self.broadcast(&st, &text);
    }

    pub fn tunnel_value(&self) -> Value {
        let t = self.tunnel.read().unwrap_or_else(|e| e.into_inner());
        Value::object()
            .with("state", t.state)
            .with_opt("provider", t.provider.as_deref())
            .with_opt("url", t.host.as_ref().map(|h| format!("https://{h}/")))
            .with_opt("error", t.error.as_deref())
    }

    /// The tunnel changed: tell the API sockets.
    pub fn tunnel_changed(&self) {
        self.event("tunnel", self.tunnel_value());
    }

    // -----------------------------------------------------------------
    // The relay's clients

    /// Whether a new client may connect from `addr` (`Err`: the HTTP
    /// status and reason).
    pub fn admit(&self, addr: &str) -> std::result::Result<(), (u16, &'static str)> {
        let mut st = self.lock();
        if st.closing || st.host.is_none() {
            return Err((503, "Service Unavailable"));
        }
        if st.clients.len() >= self.max_clients() {
            return Err((503, "Service Unavailable"));
        }
        if !st.upgrades.hit(addr, Instant::now()) {
            return Err((429, "Too Many Requests"));
        }
        Ok(())
    }

    /// Runs an upgraded client socket until it ends.
    pub fn run_client(
        self: &Arc<Hub>,
        tcp: std::net::TcpStream,
        leftover: Vec<u8>,
        via: Via,
        addr: String,
        query: String,
        agent: String,
    ) {
        let (limits, gen) = match self.game() {
            Some(g) => (g.bundle.manifest.limits, Some(g.gen)),
            None => (super::bundle::Limits::default(), None),
        };
        let id = Arc::new(OnceLock::<u32>::new());
        let hub = self.clone();
        let mark_id = id.clone();
        let mark: conn::MarkFn = Box::new(move |busy| {
            if let Some(&conn) = mark_id.get() {
                let st = hub.lock();
                if let Some(h) = st.host.and_then(|h| st.apis.get(&h)) {
                    let t = if busy { "busy" } else { "drain" };
                    h.out
                        .text(Value::object().with("t", t).with("conn", conn).to_json());
                }
            }
        });
        let opts = conn::Options {
            name: "relay",
            max_message: limits.message as usize,
            first_message: Some(FIRST_MESSAGE),
            mark: Some((BUSY_MARK, mark)),
            limit: Some((CLIENT_LIMIT, 4013, "slow")),
        };
        let mut bucket = conn::Bucket::new(limits.rate, limits.burst);
        let hub = self.clone();
        let registered = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reg = registered.clone();
        let ended = conn::run(
            tcp,
            leftover,
            opts,
            |out| {
                // Another game since the upgrade: its join link.
                if hub.slot().as_ref().map(|g| g.gen) != gen {
                    out.close(CLOSE_NEXT_GAME, "next game");
                    return;
                }
                let mut st = hub.lock();
                let Some(host) = st.host.filter(|_| !st.closing) else {
                    out.close(CLOSE_RESTART, "no host");
                    return;
                };
                st.next_conn += 1;
                let conn = st.next_conn;
                let _ = id.set(conn);
                st.clients.insert(conn, Client { out: out.clone() });
                reg.store(true, std::sync::atomic::Ordering::SeqCst);
                let open = Value::object()
                    .with("t", "open")
                    .with("conn", conn)
                    .with("via", via.as_str())
                    .with("addr", addr.as_str())
                    .with("query", query.as_str())
                    .with("agent", agent.as_str())
                    .to_json();
                if let Some(h) = st.apis.get(&host) {
                    h.out.text(open);
                }
                debug!("playshare: client {conn} from {addr} ({})", via.as_str());
            },
            |msg| {
                let Some(&conn) = id.get() else {
                    return Next::Close(CLOSE_RESTART, "no host".into());
                };
                if !bucket.take() {
                    info!("playshare: client {conn} sends too fast; closed");
                    return Next::Close(4008, "rate-limited".into());
                }
                let (op, payload) = match msg {
                    Message::Text(t) => (OP_TEXT, t.into_bytes()),
                    Message::Binary(b) => (OP_BINARY, b),
                    Message::Close(_) => return Next::Continue,
                };
                let st = hub.lock();
                match st.host.and_then(|h| st.apis.get(&h)) {
                    Some(h) => {
                        h.out.binary(frame(op, conn, &payload));
                        Next::Continue
                    }
                    None => Next::Close(CLOSE_RESTART, "no host".into()),
                }
            },
        );
        if !registered.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let Some(&conn) = id.get() else { return };
        let mut st = self.lock();
        st.clients.remove(&conn);
        if let Some(h) = st.host.and_then(|h| st.apis.get(&h)) {
            h.out.text(
                Value::object()
                    .with("t", "close")
                    .with("conn", conn)
                    .with("code", u64::from(ended.code))
                    .with("reason", ended.reason.as_str())
                    .to_json(),
            );
        }
        debug!("playshare: client {conn} closed ({})", ended.code);
    }

    /// A page of an earlier game: accepted and closed with
    /// [`CLOSE_NEXT_GAME`] (it goes to its join link).
    pub(super) fn run_stale(&self, tcp: std::net::TcpStream, leftover: Vec<u8>) {
        let opts = conn::Options {
            name: "relay-stale",
            max_message: 4096,
            first_message: Some(FIRST_MESSAGE),
            mark: None,
            limit: None,
        };
        conn::run(
            tcp,
            leftover,
            opts,
            |out| out.close(CLOSE_NEXT_GAME, "next game"),
            |_| Next::Continue,
        );
    }

    fn close_clients(st: &mut St, code: u16, reason: &str) {
        for c in st.clients.values() {
            c.out.close(code, reason);
        }
    }

    /// Clients still connected.
    pub fn client_count(&self) -> usize {
        self.lock().clients.len()
    }

    // -----------------------------------------------------------------
    // API sockets

    /// Runs an upgraded API socket until it ends.
    pub fn run_api(self: &Arc<Hub>, tcp: std::net::TcpStream, leftover: Vec<u8>) {
        let id = {
            let mut st = self.lock();
            st.next_api += 1;
            st.next_api
        };
        let opts = conn::Options {
            name: "playshare-api",
            max_message: API_MAX_MESSAGE,
            first_message: None,
            mark: None,
            limit: None,
        };
        let hub = self.clone();
        let my_out: std::cell::OnceCell<Out> = std::cell::OnceCell::new();
        conn::run(
            tcp,
            leftover,
            opts,
            |out| {
                let _ = my_out.set(out.clone());
                let mut st = hub.lock();
                st.apis.insert(
                    id,
                    Api {
                        out: out.clone(),
                        watching: false,
                    },
                );
                st.seen_api = true;
                st.apis_gone_since = None;
                if st.closing {
                    out.text(event("closing", Value::Null));
                }
            },
            |msg| {
                match msg {
                    Message::Text(t) => hub.on_api_text(id, my_out.get(), &t),
                    Message::Binary(b) => hub.on_host_data(id, &b),
                    Message::Close(_) => {}
                }
                Next::Continue
            },
        );
        let mut st = self.lock();
        st.apis.remove(&id);
        if st.apis.is_empty() {
            st.apis_gone_since = Some(Instant::now());
        }
        if st.host == Some(id) {
            st.host = None;
            info!("playshare: the host page went away; phones reconnect when it is back");
            Hub::close_clients(&mut st, CLOSE_RESTART, "host restart");
        }
    }

    /// Data from the host for a client.
    fn on_host_data(&self, api: u64, data: &[u8]) {
        if data.len() < 5 {
            return;
        }
        let op = data[0];
        let conn = u32::from_be_bytes([data[1], data[2], data[3], data[4]]);
        // Pushing may report `busy`, which takes the lock: not under it.
        let out = {
            let st = self.lock();
            if st.host != Some(api) {
                return;
            }
            let Some(c) = st.clients.get(&conn) else {
                return;
            };
            c.out.clone()
        };
        let payload = &data[5..];
        match op {
            OP_TEXT => {
                if let Ok(t) = std::str::from_utf8(payload) {
                    out.text(t.to_owned());
                }
            }
            OP_BINARY => {
                out.binary(payload.to_vec());
            }
            _ => {}
        }
    }

    fn on_api_text(self: &Arc<Hub>, api: u64, out: Option<&Out>, text: &str) {
        let Some(out) = out else { return };
        let Ok(msg) = Value::parse(text) else {
            debug!("playshare: API message that is not JSON");
            return;
        };
        match msg.get("t").and_then(Value::as_str) {
            Some("call") => {
                let n = msg.get("n").cloned().unwrap_or(Value::Null);
                let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
                let params = msg.get("params").cloned().unwrap_or_else(Value::object);
                if matches!(method, "cast.start" | "surface.open" | "shortlink") {
                    // Starting a cast takes seconds, a short link a
                    // request to the service: not on the reader.
                    let (hub, out, method) = (self.clone(), out.clone(), method.to_owned());
                    let _ = std::thread::Builder::new()
                        .name(format!("playshare-{method}"))
                        .spawn(move || {
                            let r = hub.call(api, &method, &params);
                            out.text(match r {
                                Ok(v) => reply_ok(&n, v),
                                Err(e) => reply_err(&n, e.code().unwrap_or("failed"), e.message()),
                            });
                        });
                    return;
                }
                let r = self.call(api, method, &params);
                out.text(match r {
                    Ok(v) => reply_ok(&n, v),
                    Err(e) => reply_err(&n, e.code().unwrap_or("failed"), e.message()),
                });
            }
            Some("close") => {
                let st = self.lock();
                if st.host != Some(api) {
                    return;
                }
                let conn = msg.get("conn").and_then(Value::as_u64).unwrap_or(0);
                let code = msg
                    .get("code")
                    .and_then(Value::as_u64)
                    .and_then(|c| u16::try_from(c).ok())
                    .filter(|c| *c == 1000 || (3000..=4999).contains(c))
                    .unwrap_or(1000);
                let reason: String = msg
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(60)
                    .collect();
                if let Some(c) = u32::try_from(conn).ok().and_then(|c| st.clients.get(&c)) {
                    c.out.close(code, &reason);
                }
            }
            _ => {}
        }
    }

    /// One API call.
    pub fn call(self: &Arc<Hub>, api: u64, method: &str, params: &Value) -> Result<Value> {
        let unknown = || Error::usage(format!("no method {method:?}")).with_code("unknown-method");
        match method {
            "info" => self.info(),
            "devices.watch" => {
                let on = params.get("on").and_then(Value::as_bool).unwrap_or(true);
                let mut st = self.lock();
                if let Some(a) = st.apis.get_mut(&api) {
                    a.watching = on;
                }
                Ok(st.devices.clone())
            }
            "select" => {
                let list = params
                    .get("devices")
                    .and_then(Value::as_array)
                    .ok_or_else(|| Error::usage("select: devices is a list of names"))?;
                let names: Vec<String> = list
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.is_empty() && s.len() <= 200)
                    .take(16)
                    .map(str::to_owned)
                    .collect();
                let resolution = match params.get("resolution") {
                    None | Some(Value::Null) => None,
                    Some(r) => Some(parse_resolution(r)?),
                };
                let mut st = self.lock();
                st.selection = names;
                if let Some(r) = resolution {
                    st.resolution = r;
                }
                Ok(self.selection_value(&st))
            }
            "selection" => Ok(self.selection_value(&self.lock())),
            "pair.start" => {
                let device = params
                    .get("device")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::usage("pair.start: device"))?;
                let job = self.backend.pair(device)?;
                let mut st = self.lock();
                if let Some((old, _)) = st.pairs.remove(device) {
                    old.cancel();
                }
                st.pairs.insert(device.to_owned(), (job, Value::Null));
                Ok(Value::object())
            }
            "pair.pin" => {
                let device = params.get("device").and_then(Value::as_str).unwrap_or("");
                let pin = params
                    .get("pin")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::usage("pair.pin: pin"))?;
                let st = self.lock();
                let (job, _) = st
                    .pairs
                    .get(device)
                    .ok_or_else(|| Error::usage(format!("no pairing with {device:?}")))?;
                job.submit(pin)?;
                Ok(Value::object())
            }
            "pair.cancel" => {
                let device = params.get("device").and_then(Value::as_str).unwrap_or("");
                if let Some((job, _)) = self.lock().pairs.remove(device) {
                    job.cancel();
                }
                Ok(Value::object())
            }
            "cast.start" => self.cast_start(params),
            "tvsync.set" => self.tvsync_set(params),
            "cast.stop" => {
                let old = self.lock().cast.take();
                if let Some(c) = old {
                    c.job.stop();
                }
                self.event("cast", Value::object().with("state", "stopped"));
                self.progress(Progress::CastStopped);
                Ok(Value::object())
            }
            "qr" => {
                let text = params
                    .get("text")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::usage("qr: text"))?;
                let qr = crate::util::qr::encode(text.as_bytes(), crate::util::qr::MAX_VERSION)
                    .ok_or_else(|| Error::usage("qr: the text does not fit a QR code"))?;
                let rows = qr.rows();
                Ok(Value::object().with("size", rows.len()).with("rows", rows))
            }
            "relay.attach" => {
                self.need_game()?;
                let mut st = self.lock();
                if st.closing {
                    return Err(Error::closed("playshare is ending").with_code("closing"));
                }
                if let Some(old) = st.host.filter(|h| *h != api) {
                    if let Some(a) = st.apis.get(&old) {
                        a.out.text(event("detached", Value::Null));
                        a.out.close(1000, "replaced");
                    }
                    Hub::close_clients(&mut st, CLOSE_RESTART, "host restart");
                    info!("playshare: a new host page took over");
                }
                st.host = Some(api);
                drop(st);
                let (phone, mode) = self.phone_base();
                Ok(Value::object()
                    .with("public", phone)
                    .with("mode", mode)
                    .with("local", self.local_origin()))
            }
            "surface.open" => {
                let selection = self.lock().selection.clone();
                self.surface_open(params, selection)
            }
            "surface.close" => {
                let id = params
                    .get("id")
                    .and_then(Value::as_u32)
                    .ok_or_else(|| Error::usage("surface.close: id"))?;
                self.surface_close(id)
            }
            "shortlink" => self.shortlink(params),
            "quit" => {
                info!("playshare: the page asked to quit");
                self.stop.request();
                Ok(Value::object())
            }
            _ => Err(unknown()),
        }
    }

    /// `shortlink {url, code}`: a short link for the tunnel's join link
    /// (docs/short-links.md), `{url, code}`.
    fn shortlink(&self, params: &Value) -> Result<Value> {
        let url = params
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::usage("shortlink: url (the join link)"))?;
        let code = params.get("code").and_then(Value::as_str);
        let unavailable = |m: &'static str| Error::unsupported(m).with_code("unavailable");
        let host =
            {
                let t = self.tunnel.read().unwrap_or_else(|e| e.into_inner());
                match (&t.host, t.state) {
                    (Some(h), "up") => h.clone(),
                    _ => return Err(unavailable(
                        "short links are only for the tunnel's join link, and there is no tunnel",
                    )),
                }
            };
        let ours = url
            .strip_prefix("https://")
            .and_then(|r| r.strip_prefix(host.as_str()))
            .is_some_and(|r| r.starts_with('/'));
        if !ours {
            return Err(Error::usage(format!(
                "shortlink: only for the tunnel's join link (https://{host}/…)"
            ))
            .with_code("bad-url"));
        }
        let links = self
            .shortlinks
            .get()
            .filter(|l| l.enabled())
            .ok_or_else(|| unavailable("short links are off"))?;
        let (short, code) = links.register(url, code).inspect_err(|e| {
            // The terminal shows only the short link: this one instead.
            if self.lock().short_shown.is_none() {
                warn!(
                    "playshare: no short link ({e}); phones join at https://{host}/ (the QR code)"
                );
            }
        })?;
        let news = {
            let mut st = self.lock();
            let news = st.short_shown.as_deref() != Some(short.as_str());
            st.short_shown = Some(short.clone());
            news
        };
        if news {
            self.progress(Progress::ShortLink { url: short.clone() });
        }
        Ok(Value::object().with("url", short).with("code", code))
    }

    /// Whether a host page attached the relay (`tvpipe game check --smoke`).
    pub fn host_attached(&self) -> bool {
        self.lock().host.is_some()
    }

    /// `info`: the game, the room and how phones reach it.
    pub fn info(&self) -> Result<Value> {
        let game = self.need_game()?;
        let (phone, mode) = self.phone_base();
        let p = self.ports();
        Ok(game
            .bundle
            .manifest
            .to_value()
            .with(
                "phone",
                Value::object()
                    .with("url", phone)
                    .with("mode", mode)
                    .with_opt("lan", p.lan.map(|l| format!("http://{l}/"))),
            )
            .with("tunnel", self.tunnel_value())
            .with("local", self.local_origin())
            .with("version", self.version)
            .with("resolutions", self.resolutions(&game))
            .with("dev", self.dev.load(Ordering::Relaxed))
            .with(
                "room",
                Value::object()
                    .with("code", self.room.code.as_str())
                    .with("key", self.room.key.as_str()),
            )
            .with("game", game.gen))
    }

    /// The resolution until someone chooses one (`--resolution`).
    pub fn set_resolution(&self, r: Resolution) {
        self.lock().resolution = r;
    }

    /// The resolutions people may choose (none: `tv.resolution` fixed).
    fn resolutions(&self, game: &Game) -> Value {
        if game.bundle.manifest.tv_fixed {
            return Value::array(Vec::<Value>::new());
        }
        Value::array(Resolution::ALL.iter().map(|r| r.as_str()))
    }

    /// `select`'s and `selection`'s answer.
    fn selection_value(&self, st: &St) -> Value {
        Value::object().with("devices", st.selection.clone()).with(
            "resolution",
            if self
                .slot()
                .as_ref()
                .is_some_and(|g| g.bundle.manifest.tv_fixed)
            {
                Value::Null
            } else {
                Value::from(st.resolution.as_str())
            },
        )
    }

    /// `tvsync.set {device, displayMs}`: a TV's display lag as measured
    /// (`null`: forget it, the library's estimate again), kept in the
    /// storage; devices and statuses show it from the next tick.
    fn tvsync_set(&self, params: &Value) -> Result<Value> {
        let device = params
            .get("device")
            .and_then(Value::as_str)
            .filter(|d| !d.trim().is_empty() && d.len() <= 200)
            .ok_or_else(|| Error::usage("tvsync.set: device"))?;
        let ms = match params.get("displayMs") {
            None | Some(Value::Null) => None,
            Some(v) => Some(
                v.as_u32()
                    .filter(|ms| *ms <= crate::storage::MAX_TV_LAG_MS)
                    .ok_or_else(|| Error::usage("tvsync.set: displayMs is 0–2000 ms or null"))?,
            ),
        };
        if let Some(storage) = self.backend.storage() {
            storage.set_tv_lag(device, ms)?;
        }
        {
            let mut lags = self.lags.lock().unwrap_or_else(|e| e.into_inner());
            lags.retain(|k, _| !k.eq_ignore_ascii_case(device.trim()));
            if let Some(ms) = ms {
                lags.insert(device.trim().to_owned(), ms);
            }
        }
        match ms {
            Some(ms) => info!("playshare: {device} shows pictures {ms} ms late (kept)"),
            None => info!("playshare: {device}'s lag forgotten"),
        }
        // The devices list again, with it.
        let mut st = self.lock();
        if let Some(list) = st.devices.as_array() {
            let list = Value::array(list.iter().map(|d| self.with_display(d.clone())));
            if list != st.devices {
                st.devices = list.clone();
                self.broadcast(&st, &event("devices", list));
            }
        }
        drop(st);
        Ok(Value::object()
            .with("device", device)
            .with_opt("displayMs", ms))
    }

    /// A TV's display lag as kept.
    fn display_ms(&self, name: &str) -> Option<u32> {
        let lags = self.lags.lock().unwrap_or_else(|e| e.into_inner());
        crate::storage::tv_lag_of(&lags, name)
    }

    /// A device (`name`) or receiver status with its `displayMs`, if kept.
    fn with_display(&self, mut v: Value) -> Value {
        let ms = v
            .get("name")
            .and_then(Value::as_str)
            .and_then(|n| self.display_ms(n));
        if let Some(o) = v.as_object_mut() {
            o.remove("displayMs");
            if let Some(ms) = ms {
                o.insert("displayMs", ms);
            }
        }
        v
    }

    /// A cast or surface status with each receiver's `displayMs`.
    pub(super) fn status_with_display(&self, mut v: Value) -> Value {
        if let Some(o) = v.as_object_mut() {
            if let Some(Value::Array(list)) = o.get_mut("receivers") {
                for r in list.iter_mut() {
                    *r = self.with_display(std::mem::take(r));
                }
            }
        }
        v
    }

    fn cast_start(self: &Arc<Hub>, params: &Value) -> Result<Value> {
        let page = params
            .get("page")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::usage("cast.start: page (a path of this game)"))?;
        if !page.starts_with('/')
            || page.starts_with("//")
            || page.contains('\\')
            || page.len() > 4096
        {
            return Err(Error::usage(
                "cast.start: page must be a path on the local origin (/tv.html#…)",
            ));
        }
        let to: Vec<String> = match params.get("to").and_then(Value::as_array) {
            Some(list) => list
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            None => self.lock().selection.clone(),
        };
        if to.is_empty() {
            return Err(Error::usage("no receivers chosen").with_code("no-receivers"));
        }
        let resolution = match params.get("resolution") {
            None | Some(Value::Null) => self.lock().resolution,
            Some(r) => parse_resolution(r)?,
        };
        let game = self.need_game()?;
        let manifest = &game.bundle.manifest;
        let picture = Picture {
            layout: manifest.tv_size,
            resolution: (!manifest.tv_fixed).then_some(resolution),
        };
        let url = format!("{}{page}", self.local_origin());
        // The same TVs and picture: the page goes into the running tab,
        // the receivers keep their sessions (a game's next TV page, the
        // next game's: docs/game-switching.md).
        let running = self.lock().cast.take();
        let old = match running {
            Some(mut c) if same_receivers(&c.to, &to) && c.picture == picture => {
                let state = c.job.status();
                let live = matches!(
                    state.get("state").and_then(Value::as_str),
                    Some("starting" | "streaming")
                );
                match live.then(|| c.job.navigate(&url)) {
                    Some(Ok(())) => {
                        info!("playshare: the TVs show {page} now");
                        let status = self.status_with_display(state);
                        self.event("cast", status.clone().with("to", to.clone()));
                        c.last = status.clone();
                        self.lock().cast = Some(c);
                        return Ok(status);
                    }
                    Some(Err(e)) => {
                        debug!("playshare: cast anew ({e})");
                        Some(c)
                    }
                    None => Some(c),
                }
            }
            other => other,
        };
        if let Some(c) = old {
            c.job.stop();
        }
        self.event(
            "cast",
            Value::object()
                .with("state", "starting")
                .with("to", to.clone())
                .with_opt("resolution", picture.resolution.map(Resolution::as_str)),
        );
        info!("playshare: casting to {}", to.join(", "));
        self.progress(Progress::Casting(to.clone()));
        match self.backend.cast(&url, &to, picture) {
            Ok(mut job) => {
                if self.stop.requested() {
                    job.stop();
                    return Err(Error::closed("playshare is ending"));
                }
                let status = self.status_with_display(job.status());
                self.lock().cast = Some(Casting {
                    job,
                    last: Value::Null,
                    to,
                    picture,
                });
                Ok(status)
            }
            Err(e) => {
                warn!("playshare: cast: {e}");
                self.progress(Progress::CastFailed(e.message().to_owned()));
                self.event(
                    "cast",
                    Value::object()
                        .with("state", "failed")
                        .with("error", e.message()),
                );
                Err(e)
            }
        }
    }

    // -----------------------------------------------------------------
    // Background work

    /// Discovery, pairing and cast progress: called every ~200 ms.
    pub fn tick(&self) {
        let mut events: Vec<String> = Vec::new();
        let mut st = self.lock();
        let watching = st.apis.values().any(|a| a.watching);
        if watching && st.discovery.is_none() {
            match self.backend.discover() {
                Ok(d) => st.discovery = Some(d),
                Err(e) => warn!("playshare: discovery: {e}"),
            }
        } else if !watching && st.discovery.is_some() {
            st.discovery = None;
        }
        if let Some(d) = &st.discovery {
            let mut list = vec![browser_device()];
            list.extend(d.devices().into_iter().map(|v| self.with_display(v)));
            let list = Value::array(list);
            if list != st.devices {
                st.devices = list.clone();
                events.push(event("devices", list));
            }
        }
        let mut done = Vec::new();
        for (device, (job, last)) in st.pairs.iter_mut() {
            let v = job.state().with("device", device.as_str());
            if v != *last {
                *last = v.clone();
                let state = v.get("state").and_then(Value::as_str).unwrap_or("");
                if state == "done" || state == "failed" {
                    done.push(device.clone());
                }
                events.push(event("pair", v));
            }
        }
        for d in done {
            st.pairs.remove(&d);
        }
        let mut progress = None;
        if let Some(Casting { job, last, .. }) = st.cast.as_mut() {
            let v = self.status_with_display(job.status());
            if v != *last {
                let was = last.get("state").and_then(Value::as_str).map(str::to_owned);
                let state = v.get("state").and_then(Value::as_str).unwrap_or("");
                if was.as_deref() != Some(state) {
                    progress = match state {
                        "failed" => Some(Progress::CastFailed(
                            v.get("error")
                                .and_then(Value::as_str)
                                .unwrap_or("the cast failed")
                                .to_owned(),
                        )),
                        "stopped" => Some(Progress::CastStopped),
                        _ => None,
                    };
                }
                *last = v.clone();
                events.push(event("cast", v));
            }
        }
        for e in &events {
            self.broadcast(&st, e);
        }
        drop(st);
        if let Some(p) = progress {
            self.progress(p);
        }
        self.surfaces_tick();
    }

    /// With no window of our own: no API socket for this long ends the run.
    pub fn apis_gone_for(&self) -> Option<Duration> {
        let st = self.lock();
        if !st.seen_api {
            return None;
        }
        st.apis_gone_since.map(|t| t.elapsed())
    }

    /// The end (§10): `closing` to the pages, a second for the host's
    /// goodbyes, then clients closed with 4011 and the cast stopped.
    pub fn shutdown(&self) {
        {
            let mut st = self.lock();
            if st.closing {
                return;
            }
            st.closing = true;
            let has_host = st.host.is_some();
            let text = event("closing", Value::Null);
            self.broadcast(&st, &text);
            drop(st);
            if has_host {
                let until = Instant::now() + CLOSING_GRACE;
                while Instant::now() < until && self.client_count() > 0 {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        }
        let (cast, pairs) = {
            let mut st = self.lock();
            Hub::close_clients(&mut st, CLOSE_ENDED, "closed");
            st.discovery = None;
            (st.cast.take(), std::mem::take(&mut st.pairs))
        };
        for (_, (p, _)) in pairs {
            p.cancel();
        }
        if let Some(c) = cast {
            info!("playshare: stopping the cast");
            c.job.stop();
        }
        self.surfaces_stop_all();
        let st = self.lock();
        for a in st.apis.values() {
            a.out.close(1001, "ended");
        }
        drop(st);
        // Let the close frames go out.
        let until = Instant::now() + Duration::from_millis(500);
        while Instant::now() < until && self.client_count() > 0 {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// The relay's connections at most for a game of `max_players`.
pub fn relay_limit(max_players: u32) -> usize {
    (2 * max_players as usize + 16).max(64)
}

/// A game's launcher: its own, else tvpipe's.
pub fn launcher_of(bundle: &Bundle) -> String {
    match &bundle.manifest.pages.launcher {
        Some(l) => format!("/{l}"),
        None => super::server::LAUNCHER.to_owned(),
    }
}
