//! The games list in the hub against the fake GitHub and games list of
//! remote's tests: the list with its pictures, the games on this
//! computer, a choice, the question, the game in the slot.

use std::time::{Duration, Instant};

use super::*;
use crate::net::fetch::Client;
use crate::playshare::remote::tests::{Fake, PNG};
use crate::playshare::remote::FetchOptions;
use crate::playshare::server::cookie_name;
use crate::playshare::{Options, Running, TunnelChoice};
use crate::util::stop::Stop;

struct T {
    running: Option<Running>,
    hub: Arc<Hub>,
    _fake: Option<Arc<Fake>>,
    client: Client,
    cookie: String,
}

impl Drop for T {
    fn drop(&mut self) {
        if let Some(r) = self.running.take() {
            r.end();
        }
    }
}

fn start(name: &str, yes: bool) -> T {
    start_with(Some(name), yes, Vec::new(), None)
}

/// A session with the fake games list (`online`: its name) and `local`
/// games, maybe with a first game.
fn start_with(online: Option<&str>, yes: bool, local: Vec<PathBuf>, first: Option<Bundle>) -> T {
    let fake = online.map(|n| Arc::new(Fake::new(n)));
    let make: Option<MakeFetcher> = fake.clone().map(|f| {
        Arc::new(move |events| {
            let mut fetcher = f.fetcher(FetchOptions::default(), None);
            fetcher.events = events;
            Ok(fetcher)
        }) as MakeFetcher
    });
    let backend = crate::playshare::tests::Fake {
        log: Arc::default(),
        fail_cast: false,
    };
    let opts = Options {
        tunnel: TunnelChoice::Off,
        no_short_link: true,
        ..Options::default()
    };
    let running = Running::start_with(
        first,
        Box::new(backend),
        &opts,
        Stop::new(),
        Events::none(),
        Config { make, yes, local },
    )
    .unwrap();
    let hub = running.hub.clone();
    let cookie = format!(
        "{}={}",
        cookie_name(hub.ports.get().unwrap().local),
        hub.token
    );
    T {
        running: Some(running),
        hub,
        _fake: fake,
        client: Client::default(),
        cookie,
    }
}

impl T {
    fn url(&self, path: &str) -> Url {
        Url::parse(&format!(
            "http://127.0.0.1:{}{path}",
            self.hub.ports.get().unwrap().local
        ))
        .unwrap()
    }

    fn get(&self, path: &str) -> (u16, Vec<u8>) {
        self.client
            .send(
                "GET",
                &self.url(path),
                &[("Cookie", &self.cookie)],
                None,
                4 << 20,
            )
            .unwrap()
    }

    fn get_json(&self, path: &str) -> Value {
        let (status, body) = self.get(path);
        assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
        Value::parse(&String::from_utf8_lossy(&body)).unwrap()
    }

    fn post(&self, body: &str) -> (u16, Value) {
        let (status, body) = self
            .client
            .send(
                "POST",
                &self.url("/_tvpipe/api/game"),
                &[("Cookie", &self.cookie)],
                Some(("application/json", body.as_bytes().to_vec())),
                1 << 20,
            )
            .unwrap();
        (
            status,
            Value::parse(&String::from_utf8_lossy(&body)).unwrap(),
        )
    }

    /// The state once it is not `fetching` any more.
    fn settled(&self) -> Value {
        let t0 = Instant::now();
        loop {
            let v = self.get_json("/_tvpipe/api/game");
            if v.get("state").and_then(Value::as_str) != Some("fetching") {
                return v;
            }
            assert!(t0.elapsed() < Duration::from_secs(20), "still fetching");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn title(&self) -> Option<String> {
        self.hub.game().map(|g| g.bundle.manifest.title.clone())
    }
}

fn state(v: &Value) -> &str {
    v.get("state").and_then(Value::as_str).unwrap_or("")
}

fn fixture(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/playshare")
        .join(rel)
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let dest = to.join(e.file_name());
        if e.path().is_dir() {
            copy_dir(&e.path(), &dest);
        } else {
            std::fs::copy(e.path(), dest).unwrap();
        }
    }
}

/// A folder of games: a folder game, a zip, a broken one, and what is
/// not a game.
fn games_folder(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/test-tmp")
        .join(name);
    let _ = std::fs::remove_dir_all(&dir);
    copy_dir(&fixture("game"), &dir.join("a-game"));
    std::fs::copy(fixture("game.zip"), dir.join("b.zip")).unwrap();
    std::fs::copy(fixture("game.zip"), dir.join(".hidden.zip")).unwrap();
    std::fs::create_dir_all(dir.join("broken")).unwrap();
    std::fs::write(dir.join("broken/tvpipe.json"), "{}").unwrap();
    std::fs::create_dir_all(dir.join("notes")).unwrap();
    std::fs::write(dir.join("notes/readme.txt"), "not a game").unwrap();
    dir
}

#[test]
fn the_list_with_its_pictures() {
    let t = start("picker-list", false);
    let c = t.get_json("/_tvpipe/api/catalog");
    assert_eq!(
        c.get("local").and_then(Value::as_array).map(|l| l.len()),
        Some(0)
    );
    let games = c.get("games").and_then(Value::as_array).unwrap();
    // "Bad Name" is no name.
    let names: Vec<&str> = games
        .iter()
        .filter_map(|g| g.get("name").and_then(Value::as_str))
        .collect();
    assert_eq!(names, ["g", "h"]);
    let g = &games[0];
    assert_eq!(g.get("summary").and_then(Value::as_str), Some("A game"));
    assert_eq!(g.get("min").and_then(Value::as_u64), Some(2));
    assert_eq!(g.get("downloaded").and_then(Value::as_bool), Some(false));
    // Plain http pictures are left out; the others are tvpipe's URLs.
    let shots = g.get("screenshots").and_then(Value::as_array).unwrap();
    assert_eq!(shots.len(), 2);
    let src = shots[0].get("src").and_then(Value::as_str).unwrap();
    assert_eq!(src, "/_tvpipe/catalog/0");
    let (status, body) = t.get(src);
    assert_eq!((status, body.as_slice()), (200, PNG));
    // Not a picture: refused.
    let src = shots[1].get("src").and_then(Value::as_str).unwrap();
    assert_eq!(t.get(src).0, 404);
    assert_eq!(t.get("/_tvpipe/catalog/9").0, 404);
}

#[test]
fn a_choice_asks_then_starts() {
    let t = start("picker-choice", false);
    let v = t.get_json("/_tvpipe/api/game");
    assert_eq!(state(&v), "idle");
    assert!(v.get("current").is_none());
    let (status, v) = t.post(r#"{"source":"g"}"#);
    assert_eq!(status, 200, "{v:?}");
    let v = t.settled();
    assert_eq!(state(&v), "ask", "{v:?}");
    let game = v.get("game").unwrap();
    assert_eq!(game.get("title").and_then(Value::as_str), Some("G nine"));
    assert_eq!(
        game.get("release").and_then(Value::as_str),
        Some("g-v1.9.0")
    );
    // Busy while asking.
    assert_eq!(t.post(r#"{"source":"h"}"#).0, 409);
    assert!(t.title().is_none());
    // Back: the list again; then the same game, and yes.
    assert_eq!(state(&t.post(r#"{"back":true}"#).1), "idle");
    t.post(r#"{"source":"g"}"#);
    assert_eq!(state(&t.settled()), "ask");
    let (_, v) = t.post(r#"{"trust":true}"#);
    // In the slot: no TVs chosen yet, so the launcher.
    assert_eq!(state(&v), "ready", "{v:?}");
    assert_eq!(
        v.get("url").and_then(Value::as_str),
        Some("/_tvpipe/launcher/")
    );
    let choice = v.get("choice").and_then(Value::as_u64).unwrap();
    assert_eq!(t.title().as_deref(), Some("G nine"));
    let current = v.get("current").unwrap();
    assert_eq!(current.get("name").and_then(Value::as_str), Some("g"));
    // The next game may be picked any time.
    let (status, v) = t.post(r#"{"back":true}"#);
    assert_eq!((status, state(&v)), (200, "idle"));
    assert!(v.get("choice").and_then(Value::as_u64).unwrap() > choice);
    // The window's start goes to the game's launcher now.
    let start = format!("/_tvpipe/start?t={}", t.hub.token);
    let raw = super::super::tests::http_get(t.url(&start).port, &start);
    assert!(raw.contains("Location: /_tvpipe/launcher/"), "{raw}");
}

#[test]
fn a_game_said_yes_to_or_yes_needs_no_question() {
    let t = start("picker-yes", true);
    t.post(r#"{"source":"gh:o/r/g@g-v*"}"#);
    assert_eq!(state(&t.settled()), "ready");
    assert_eq!(t.title().as_deref(), Some("G nine"));
}

#[test]
fn errors_and_refusals() {
    let t = start("picker-errors", false);
    // A path on this computer is the command line's.
    let (status, v) = t.post(r#"{"source":"./games/x"}"#);
    assert_eq!(status, 400, "{v:?}");
    t.post(r#"{"source":"nope"}"#);
    let v = t.settled();
    assert_eq!(state(&v), "failed");
    assert!(
        v.get("error")
            .and_then(Value::as_str)
            .unwrap()
            .contains("no game of that name"),
        "{v:?}"
    );
    assert_eq!(t.post(r#"{"trust":true}"#).0, 409);
    assert_eq!(state(&t.post(r#"{"back":true}"#).1), "idle");
    assert_eq!(t.post(r#"{"local":"/etc"}"#).0, 404);
    assert_eq!(t.post(r#"{"what":1}"#).0, 400);
    // No cookie: no API; the page itself is free.
    let anon = |path: &str| {
        t.client
            .send("GET", &t.url(path), &[], None, 1 << 20)
            .unwrap()
            .0
    };
    assert_eq!(anon("/_tvpipe/api/catalog"), 403);
    assert_eq!(anon("/_tvpipe/api/game"), 403);
    assert_eq!(anon("/"), 403);
    assert_eq!(anon("/_tvpipe/picker/"), 200);
    // Another site's page.
    let (status, _) = t
        .client
        .send(
            "POST",
            &t.url("/_tvpipe/api/game"),
            &[("Cookie", &t.cookie), ("Origin", "https://evil.test")],
            Some(("application/json", br#"{"back":true}"#.to_vec())),
            1 << 20,
        )
        .unwrap();
    assert_eq!(status, 403);
    // POST nowhere else.
    let (status, _) = t
        .client
        .send(
            "POST",
            &t.url("/_tvpipe/api/catalog"),
            &[("Cookie", &t.cookie)],
            Some(("application/json", b"{}".to_vec())),
            1 << 20,
        )
        .unwrap();
    assert_eq!(status, 405);
    // The start link sets the cookie and goes to the list.
    let start = format!("/_tvpipe/start?t={}", t.hub.token);
    let raw = super::super::tests::http_get(t.url(&start).port, &start);
    assert!(raw.starts_with("HTTP/1.1 302"), "{raw}");
    assert!(raw.contains(&format!("Location: {PAGE}")), "{raw}");
    // No game: phones wait.
    let public = t.hub.ports.get().unwrap().public;
    let raw = super::super::tests::http_get(public, "/?r=BCDF");
    assert!(raw.contains("Location: /_tvpipe/wait/?r=BCDF"), "{raw}");
    let raw = super::super::tests::http_get(public, "/_tvpipe/game");
    assert!(raw.ends_with(r#"{"game":false}"#), "{raw}");
    let raw = super::super::tests::http_get(public, "/phone/index.html");
    assert!(raw.starts_with("HTTP/1.1 404"), "{raw}");
}

#[test]
fn games_on_this_computer() {
    let dir = games_folder("picker-local");
    let found: Vec<String> = scan(std::slice::from_ref(&dir))
        .iter()
        .map(|g| g.path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(found, ["a-game", "b.zip", "broken"]);
    // A bundle given as it is, and the folder; no online list.
    let t = start_with(None, false, vec![fixture("game"), dir.clone()], None);
    let c = t.get_json("/_tvpipe/api/catalog");
    assert!(c.get("error").is_none(), "{c:?}");
    assert_eq!(c.get("online").and_then(Value::as_bool), Some(false));
    let local = c.get("local").and_then(Value::as_array).unwrap();
    assert_eq!(local.len(), 4);
    let titles: Vec<&str> = local
        .iter()
        .filter_map(|g| g.get("title").and_then(Value::as_str))
        .collect();
    assert_eq!(titles, ["Test game", "Test game", "Test game", "broken"]);
    assert!(local[3].get("error").is_some());
    assert_eq!(local[0].get("max").and_then(Value::as_u64), Some(4));
    let id = |i: usize| {
        local[i]
            .get("id")
            .and_then(Value::as_str)
            .unwrap()
            .to_owned()
    };
    // A broken one cannot be picked; a remote one needs the list.
    let (status, _) = t.post(&Value::object().with("local", id(3)).to_json());
    assert_eq!(status, 409);
    assert_eq!(t.post(r#"{"source":"g"}"#).0, 400);
    // The zip: in the slot at once.
    let (status, v) = t.post(&Value::object().with("local", id(2)).to_json());
    assert_eq!((status, state(&v)), (200, "ready"), "{v:?}");
    let game = t.hub.game().unwrap();
    assert_eq!(game.gen, 1);
    assert!(game.bundle.origin.ends_with("b.zip"));
    // And the next one.
    let (_, v) = t.post(&Value::object().with("local", id(1)).to_json());
    assert_eq!(state(&v), "ready");
    let game = t.hub.game().unwrap();
    assert_eq!(game.gen, 2);
    assert!(game.bundle.origin.ends_with("a-game"));
    assert_eq!(
        v.get("current")
            .and_then(|c| c.get("from"))
            .and_then(Value::as_str)
            .map(|f| f.ends_with("a-game")),
        Some(true)
    );
}

#[test]
fn local_games_take_the_online_entrys_pictures() {
    let dir = games_folder("picker-twins");
    // The fake list's "g" is the fixture game's twin by name.
    let m = std::fs::read_to_string(dir.join("a-game/tvpipe.json"))
        .unwrap()
        .replace("\"test-game\"", "\"g\"");
    std::fs::write(dir.join("a-game/tvpipe.json"), m).unwrap();
    let t = start_with(Some("picker-twins"), false, vec![dir], None);
    let c = t.get_json("/_tvpipe/api/catalog");
    let local = c.get("local").and_then(Value::as_array).unwrap();
    let twin = &local[0];
    assert_eq!(twin.get("name").and_then(Value::as_str), Some("g"));
    assert_eq!(twin.get("title").and_then(Value::as_str), Some("Test game"));
    assert_eq!(twin.get("summary").and_then(Value::as_str), Some("A game"));
    assert!(twin
        .get("screenshots")
        .and_then(Value::as_array)
        .is_some_and(|s| !s.is_empty()));
    assert!(local[1].get("summary").is_none());
    // The online list keeps its own entry.
    assert_eq!(
        c.get("games").and_then(Value::as_array).map(|g| g.len()),
        Some(2)
    );
}
