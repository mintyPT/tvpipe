//! The client against a fake service on 127.0.0.1.

use std::collections::HashMap;

use super::*;
use crate::net::fetch::tests::{response, TestServer};
use crate::net::http::Request;

#[derive(Default)]
pub(crate) struct Fake {
    /// code → (url, secret)
    pub links: HashMap<String, (String, String)>,
    secrets: u32,
    broken: bool,
}

fn json(status: u16, v: Value) -> Vec<u8> {
    response(
        status,
        &[("Content-Type", "application/json")],
        v.to_json().as_bytes(),
    )
}

fn error(status: u16, code: &str) -> Vec<u8> {
    json(
        status,
        Value::object().with(
            "error",
            Value::object()
                .with("code", code)
                .with("message", format!("it is {code}")),
        ),
    )
}

pub(crate) fn service() -> (TestServer, Arc<Mutex<Fake>>) {
    let fake = Arc::new(Mutex::new(Fake::default()));
    let f = fake.clone();
    let s = TestServer::plain(Arc::new(move |r: &Request| {
        let mut f = f.lock().unwrap();
        if f.broken {
            return response(500, &[], b"oops");
        }
        let body = Value::parse(std::str::from_utf8(&r.body).unwrap_or("")).ok();
        let secret = r
            .headers
            .get("authorization")
            .and_then(|a| a.strip_prefix("Bearer "))
            .unwrap_or("")
            .to_owned();
        let link = |code: &str, url: &str| {
            Value::object()
                .with("code", code)
                .with("short", format!("https://party.test/{code}"))
                .with("url", url)
        };
        match (r.method.as_str(), r.target.strip_prefix("/api/links")) {
            ("POST", Some("")) => {
                let Some(url) = body.as_ref().and_then(|b| b.get("url")?.as_str()) else {
                    return error(400, "bad-request");
                };
                if !url.starts_with("https://") {
                    return error(400, "bad-url");
                }
                let code = body
                    .as_ref()
                    .and_then(|b| b.get("code")?.as_str())
                    .filter(|c| !f.links.contains_key(*c))
                    .unwrap_or("ZZZZ")
                    .to_owned();
                f.secrets += 1;
                let secret = format!("secret-{}", f.secrets);
                f.links
                    .insert(code.clone(), (url.to_owned(), secret.clone()));
                json(201, link(&code, url).with("secret", secret))
            }
            ("PUT", Some(code)) => {
                let code = code.trim_start_matches('/');
                let Some((url, s)) = f.links.get_mut(code) else {
                    return error(404, "not-found");
                };
                if *s != secret {
                    return error(404, "not-found");
                }
                if let Some(u) = body.as_ref().and_then(|b| b.get("url")?.as_str()) {
                    *url = u.to_owned();
                }
                json(200, link(code, url))
            }
            ("DELETE", Some(code)) => {
                let code = code.trim_start_matches('/');
                if f.links.get(code).is_some_and(|(_, s)| *s == secret) {
                    f.links.remove(code);
                }
                response(204, &[], b"")
            }
            _ => error(404, "not-found"),
        }
    }));
    (s, fake)
}

fn links(s: &TestServer, stop: &Stop) -> Arc<ShortLinks> {
    ShortLinks::new(Some(&format!("{}/", s.base(""))), stop.clone())
}

pub(crate) const JOIN: &str = "https://abc.opentunnel.xyz/?r=BCDF#k=0123456789abcdef";
const JOIN2: &str = "https://abc.opentunnel.xyz/?r=BCDF#k=fedcba9876543210";

fn methods(s: &TestServer) -> Vec<String> {
    let r = s.requests.lock().unwrap();
    r.iter()
        .map(|r| format!("{} {}", r.method, r.target))
        .collect()
}

#[test]
fn register_cache_replace_and_release() {
    let (s, fake) = service();
    let stop = Stop::new();
    let l = links(&s, &stop);
    assert!(l.enabled());
    let (short, code) = l.register(JOIN, Some("BCDF")).unwrap();
    assert_eq!(
        (short.as_str(), code.as_str()),
        ("https://party.test/BCDF", "BCDF")
    );
    {
        let reqs = s.requests.lock().unwrap();
        let body = Value::parse(std::str::from_utf8(&reqs[0].body).unwrap()).unwrap();
        assert_eq!(body.get("url").and_then(Value::as_str), Some(JOIN));
        assert_eq!(
            reqs[0].headers.get("content-type"),
            Some("application/json")
        );
    }
    // The same url: the same answer, no request.
    assert_eq!(l.register(JOIN, Some("BCDF")).unwrap().0, short);
    assert_eq!(methods(&s), ["POST /api/links"]);
    // Another url: PUT, the code stays.
    assert_eq!(l.register(JOIN2, Some("XXXX")).unwrap().1, "BCDF");
    assert_eq!(methods(&s)[1], "PUT /api/links/BCDF");
    assert_eq!(
        s.requests.lock().unwrap()[1].headers.get("authorization"),
        Some("Bearer secret-1")
    );
    assert_eq!(fake.lock().unwrap().links["BCDF"].0, JOIN2);
    // Refresh: PUT {}.
    l.refresh().unwrap();
    assert_eq!(methods(&s)[2], "PUT /api/links/BCDF");
    assert_eq!(s.requests.lock().unwrap()[2].body, b"{}");
    // The end: DELETE; nothing registers any more.
    l.release();
    assert_eq!(methods(&s)[3], "DELETE /api/links/BCDF");
    assert!(fake.lock().unwrap().links.is_empty());
    let e = l.register(JOIN, None).unwrap_err();
    assert_eq!(e.code(), Some("unavailable"));
    l.release();
    assert_eq!(methods(&s).len(), 4);
    stop.request();
}

#[test]
fn lost_links_are_registered_again() {
    let (s, fake) = service();
    let stop = Stop::new();
    let l = links(&s, &stop);
    l.register(JOIN, Some("BCDF")).unwrap();
    // The service gave the code to someone else.
    fake.lock().unwrap().links.insert(
        "BCDF".into(),
        ("https://x.trycloudflare.com/".into(), "other".into()),
    );
    let (short, code) = l.register(JOIN2, Some("BCDF")).unwrap();
    assert_eq!(
        (short.as_str(), code.as_str()),
        ("https://party.test/ZZZZ", "ZZZZ")
    );
    assert_eq!(methods(&s)[1..], ["PUT /api/links/BCDF", "POST /api/links"]);
    // And when a refresh finds it gone.
    fake.lock().unwrap().links.clear();
    l.refresh().unwrap();
    assert_eq!(methods(&s)[3..], ["PUT /api/links/ZZZZ", "POST /api/links"]);
    assert_eq!(fake.lock().unwrap().links["ZZZZ"].0, JOIN2);
    l.release();
    assert!(fake.lock().unwrap().links.is_empty());
    stop.request();
}

#[test]
fn failures_are_unavailable() {
    let (s, fake) = service();
    let stop = Stop::new();
    let l = links(&s, &stop);
    fake.lock().unwrap().broken = true;
    let e = l.register(JOIN, None).unwrap_err();
    assert_eq!(e.code(), Some("unavailable"), "{e}");
    assert!(e.message().contains("500"), "{e}");
    // Refusals carry the service's message.
    fake.lock().unwrap().broken = false;
    let e = l.register("", None).unwrap_err();
    assert_eq!(e.code(), Some("unavailable"));
    assert!(e.message().contains("it is bad-url"), "{e}");
    // Nobody listening.
    drop(s);
    let gone = ShortLinks::new(Some("http://127.0.0.1:1"), stop.clone());
    assert_eq!(
        gone.register(JOIN, None).unwrap_err().code(),
        Some("unavailable")
    );
    // Off.
    let off = ShortLinks::new(None, stop.clone());
    assert!(!off.enabled());
    assert_eq!(
        off.register(JOIN, None).unwrap_err().code(),
        Some("unavailable")
    );
    off.release();
    // A failing DELETE is only logged.
    let (s, fake) = service();
    let l = links(&s, &stop);
    l.register(JOIN, None).unwrap();
    fake.lock().unwrap().broken = true;
    l.release();
    stop.request();
}

#[test]
fn frame_page_and_origin() {
    let stop = Stop::new();
    let cases = [
        (
            Some("https://tvpipe.party"),
            Some("https://tvpipe.party/p"),
            Some("https://tvpipe.party"),
        ),
        (
            Some("https://tvpipe.party/"),
            Some("https://tvpipe.party/p"),
            Some("https://tvpipe.party"),
        ),
        (
            Some("http://127.0.0.1:8787"),
            Some("http://127.0.0.1:8787/p"),
            Some("http://127.0.0.1:8787"),
        ),
        (
            Some("https://Example.com:443/party"),
            Some("https://Example.com:443/party/p"),
            Some("https://example.com"),
        ),
        (
            Some("http://[::1]:8787"),
            Some("http://[::1]:8787/p"),
            Some("http://[::1]:8787"),
        ),
        (None, None, None),
        (Some("not a url"), None, None),
    ];
    for (base, page, origin) in cases {
        let l = ShortLinks::new(base, stop.clone());
        assert_eq!(l.frame_page().as_deref(), page, "{base:?}");
        assert_eq!(l.origin().as_deref(), origin, "{base:?}");
    }
    stop.request();
}

#[test]
fn answers_are_checked() {
    let s = TestServer::plain(Arc::new(|_: &Request| {
        json(
            201,
            Value::object()
                .with("code", "../x")
                .with("short", "https://party.test/x")
                .with("secret", "s"),
        )
    }));
    let stop = Stop::new();
    let e = links(&s, &stop).register(JOIN, None).unwrap_err();
    assert_eq!(e.code(), Some("unavailable"));
    let s = TestServer::plain(Arc::new(|_: &Request| {
        json(
            201,
            Value::object()
                .with("code", "BCDF")
                .with("short", "https://party.test/BCDF")
                .with("secret", "a\r\nb"),
        )
    }));
    let e = links(&s, &stop).register(JOIN, None).unwrap_err();
    assert_eq!(e.code(), Some("unavailable"));
    let s = TestServer::plain(Arc::new(|_: &Request| response(200, &[], b"not json")));
    let e = links(&s, &stop).register(JOIN, None).unwrap_err();
    assert_eq!(e.code(), Some("unavailable"));
}
