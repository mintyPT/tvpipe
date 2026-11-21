//! `share URL` end to end with the browser replaced by fake pages (the Rust
//! one from `browser::share::tests`): the receivers connect first, the
//! page is sized from them, a page that goes away (a navigation) is
//! replaced by the next one on the same timeline, and the session ends
//! when the browser is gone.

use std::sync::Mutex;
use std::thread::JoinHandle;

use super::tests::{connect_test, fake_airplay, never, SharedTally, Tallied};
use super::*;
use crate::airplay::fake_mirror::{Behaviour, FakeMirror};
use crate::airplay::MirrorOptions;
use crate::browser::share::tests::{spawn_page, PageScript, PageSeen};
use crate::cast::fake_receiver::{FakeReceiver, Options as CastFake};
use crate::codec::json::Value;
use crate::opts::PageOptions;
use crate::types::Resolution;

fn browse_opts(to: Vec<String>) -> ShareOptions {
    ShareOptions {
        to,
        latency_ms: Some(100),
        page: Some(PageOptions {
            url: "http://127.0.0.1:1/".into(),
            ..PageOptions::default()
        }),
        ..ShareOptions::default()
    }
}

/// Fake pages one after the other (each a document of the tab), then the
/// browser "closes" (`ShareHandle::end`). Joined when dropped.
struct FakeBrowser(
    Option<JoinHandle<Vec<PageSeen>>>,
    std::sync::Arc<Mutex<Vec<PageSeen>>>,
);

impl Drop for FakeBrowser {
    fn drop(&mut self) {
        if let Some(t) = self.0.take() {
            let seen = t.join().unwrap();
            *self.1.lock().unwrap() = seen;
        }
    }
}

#[test]
fn pages_to_cast_and_airplay_across_a_navigation() {
    let rx = FakeReceiver::spawn(CastFake::default());
    let fake = FakeMirror::start(Behaviour {
        nack_after: None,
        ..Behaviour::default()
    });
    let (cast_tally, airplay_tally) = (SharedTally::default(), SharedTally::default());
    let connect = |t: &Target, c: &CastOptions, m: &MirrorOptions| -> Result<Box<dyn Sink>> {
        Ok(match t {
            Target::Browser(_) => connect_test(t, c, m)?,
            Target::Cast { addr, name } => {
                Tallied::boxed(Box::new(cast::connect(*addr, name, c)?), None, &cast_tally)
            }
            Target::AirPlay { .. } => {
                let m = MirrorOptions {
                    ptp: false,
                    ..m.clone()
                };
                Tallied::boxed(
                    fake_airplay(&fake, "fake-airplay", &m)?,
                    None,
                    &airplay_tally,
                )
            }
        })
    };
    let viewport = Mutex::new(None);
    let seen: std::sync::Arc<Mutex<Vec<PageSeen>>> = Default::default();
    let launcher =
        |server: &ShareServer, vp: (u32, u32), _: f64| -> Result<Box<dyn std::any::Any>> {
            *viewport.lock().unwrap() = Some(vp);
            let url = server.ws_url();
            let handle = server.handle();
            let t = std::thread::spawn(move || {
                let script = PageScript {
                    frames: 20,
                    capture: vp,
                    send_ended: false,
                    ..PageScript::default()
                };
                let first = spawn_page(url.clone(), script.clone()).join().unwrap();
                let second = spawn_page(url, script).join().unwrap();
                handle.end("the browser was closed");
                vec![first, second]
            });
            Ok(Box::new(FakeBrowser(Some(t), seen.clone())))
        };
    let o = ShareOptions {
        // Small, so the built-in encoder in the fake page is quick.
        size: Some(Size {
            width: 320,
            height: 180,
        }),
        ..browse_opts(vec![rx.addr.to_string(), format!("airplay:{}", fake.addr)])
    };
    browse::browse_with(&o, &connect, &never(), &launcher).unwrap();
    assert_eq!(*viewport.lock().unwrap(), Some((320, 180)));
    let seen = std::mem::take(&mut *seen.lock().unwrap());
    assert_eq!(seen.len(), 2);
    for (i, s) in seen.iter().enumerate() {
        assert!(!s.busy, "page {i} was told busy");
        let plan = s
            .plan
            .as_ref()
            .unwrap_or_else(|| panic!("page {i}: no plan"));
        assert_eq!(plan.get("width").unwrap().as_u32(), Some(320));
        assert_eq!(plan.get("height").unwrap().as_u32(), Some(180));
        // The page fills the frame: no bars.
        let c = plan.get("content").unwrap();
        assert_eq!(c.get("width").unwrap().as_u32(), Some(320));
        assert_eq!(c.get("x").unwrap().as_u32(), Some(0));
        assert_eq!(s.frames_sent, 20);
    }
    let config = seen[0].config.as_ref().unwrap();
    assert_eq!(config.get("sampleRate").unwrap().as_u32(), Some(44_100));
    assert_eq!(config.get("fps").unwrap().as_f64(), Some(30.0));

    // Both pages' frames reached both receivers.
    let state = rx.shutdown();
    let st = state.lock().unwrap();
    assert!(st.stopped, "STOP not received");
    assert!(st.streams.iter().any(|s| s.codec == "aac"), "Cast audio");
    let (tc, ta) = (*cast_tally.lock().unwrap(), *airplay_tally.lock().unwrap());
    assert_eq!(tc.video, 40, "{tc:?}");
    assert_eq!(ta.video, 40, "{ta:?}");
    let r = fake.rec();
    assert!(r.teardown, "TEARDOWN not received");
    assert!(!r.audio.is_empty(), "AirPlay audio");
}

#[test]
fn page_size_follows_the_receivers_and_a_browser_failure_stops_them() {
    // The fake receiver's ANSWER allows 1280x720: the page is that.
    let rx = FakeReceiver::spawn(CastFake::default());
    let viewport = Mutex::new(None);
    let launcher = |_: &ShareServer, vp: (u32, u32), _: f64| -> Result<Box<dyn std::any::Any>> {
        *viewport.lock().unwrap() = Some(vp);
        Err(Error::not_found(
            "browser: cannot open x: net::ERR_NAME_NOT_RESOLVED",
        ))
    };
    let o = ShareOptions {
        no_audio: true,
        ..browse_opts(vec![rx.addr.to_string()])
    };
    let e = browse::browse_with(&o, &connect_test, &never(), &launcher).unwrap_err();
    assert!(e.to_string().contains("ERR_NAME_NOT_RESOLVED"), "{e}");
    assert_eq!(*viewport.lock().unwrap(), Some((1280, 720)));
    let state = rx.shutdown();
    let st = state.lock().unwrap();
    assert!(st.stopped, "the receiver was not stopped");
    // The offer was the most the browser mode sends: 1920x1080@30.
    let offer = st.offer.as_ref().unwrap();
    let video = offer["offer"]["supportedStreams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["type"].as_str() == Some("video_source"))
        .unwrap()
        .clone();
    let res = &video["resolutions"].as_array().unwrap()[0];
    assert_eq!(
        (res["width"].as_u32(), res["height"].as_u32()),
        (Some(1920), Some(1080)),
        "{video:?}"
    );
    assert_eq!(video["maxFrameRate"].as_str(), Some("30"), "{video:?}");
}

#[test]
fn a_browser_that_fails_later_fails_the_session() {
    let rx = FakeReceiver::spawn(CastFake::default());
    let launcher =
        |server: &ShareServer, _: (u32, u32), _: f64| -> Result<Box<dyn std::any::Any>> {
            let handle = server.handle();
            // The page never shares; the keeper gives up.
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                handle.fail(Error::protocol(
                    "the page cannot share itself: NotAllowedError",
                ));
            });
            Ok(Box::new(()))
        };
    let o = ShareOptions {
        no_audio: true,
        ..browse_opts(vec![rx.addr.to_string()])
    };
    let e = browse::browse_with(&o, &connect_test, &never(), &launcher).unwrap_err();
    assert!(e.to_string().contains("NotAllowedError"), "{e}");
    let state = rx.shutdown();
    assert!(state.lock().unwrap().stopped);
}

/// `share URL` with `o` until the browser starts (it fails): the layout
/// and the scale the page was launched with.
fn launched(o: &ShareOptions, connect: Connector<'_>) -> ((u32, u32), f64) {
    let got = Mutex::new(None);
    let launcher = |_: &ShareServer, vp: (u32, u32), s: f64| -> Result<Box<dyn std::any::Any>> {
        *got.lock().unwrap() = Some((vp, s));
        Err(Error::not_found("browser: not in this test"))
    };
    let e = browse::browse_with(o, connect, &never(), &launcher).unwrap_err();
    assert!(e.to_string().contains("not in this test"), "{e}");
    got.into_inner()
        .unwrap()
        .expect("the browser was not started")
}

/// `share URL --resolution r` (and `--size` as the layout).
fn at_resolution(to: Vec<String>, layout: Option<(u32, u32)>, r: Resolution) -> ShareOptions {
    let mut o = ShareOptions {
        no_audio: true,
        size: layout.map(|(width, height)| Size { width, height }),
        ..browse_opts(to)
    };
    o.page.as_mut().unwrap().resolution = Some(r);
    o
}

/// The first (largest) resolution of the Cast OFFER's video stream.
fn offered(st: &crate::cast::fake_receiver::State) -> (u32, u32) {
    let offer = st.offer.as_ref().expect("no OFFER");
    let video = offer["offer"]["supportedStreams"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["type"].as_str() == Some("video_source"))
        .unwrap()
        .clone();
    let res = &video["resolutions"].as_array().unwrap()[0];
    (
        res["width"].as_u32().unwrap(),
        res["height"].as_u32().unwrap(),
    )
}

#[test]
fn a_resolution_renders_the_layout_at_a_scale() {
    use crate::cast::fake_receiver::VideoLimits;
    use Resolution::*;
    let uhd = VideoLimits {
        max: (3840, 2160, 30),
        max_bit_rate: 40_000_000,
        max_pixels_per_second: None,
    };
    let hd720 = VideoLimits::default();
    // A 4K maximum, but only 1080p30's pixel rate (openscreen's default).
    let rate_1080 = VideoLimits {
        max_pixels_per_second: Some(1920 * 1080 * 30),
        ..uhd
    };
    // (the ANSWER's video constraints, --size, --resolution) ->
    // (layout, scale, the OFFER's largest resolution)
    type Case = (
        Option<VideoLimits>,
        Option<(u32, u32)>,
        Resolution,
        (u32, u32),
        f64,
        (u32, u32),
    );
    let cases: [Case; 12] = [
        (
            Some(uhd),
            Some((1280, 720)),
            P2160,
            (1280, 720),
            3.0,
            (3840, 2160),
        ),
        (
            Some(uhd),
            Some((1280, 720)),
            P1080,
            (1280, 720),
            1.5,
            (1920, 1080),
        ),
        (
            Some(uhd),
            Some((1280, 720)),
            Auto,
            (1280, 720),
            1.5,
            (1920, 1080),
        ),
        (
            Some(uhd),
            Some((1280, 720)),
            P720,
            (1280, 720),
            1.0,
            (1280, 720),
        ),
        (Some(uhd), None, P2160, (1920, 1080), 2.0, (3840, 2160)),
        (Some(uhd), None, Auto, (1920, 1080), 1.0, (1920, 1080)),
        (
            Some(uhd),
            Some((960, 720)),
            P2160,
            (960, 720),
            3.0,
            (3840, 2160),
        ),
        // The receiver allows 720p: the layout stays, the scale shrinks.
        (
            Some(hd720),
            Some((1280, 720)),
            P2160,
            (1280, 720),
            1.0,
            (3840, 2160),
        ),
        (Some(hd720), None, Auto, (1920, 1080), 0.6666, (1920, 1080)),
        // maxPixelsPerSecond lowers the size (not the frame rate).
        (
            Some(rate_1080),
            Some((1280, 720)),
            P2160,
            (1280, 720),
            1.5,
            (3840, 2160),
        ),
        // No constraints under a 4K offer: openscreen's 1080p30.
        (
            None,
            Some((1280, 720)),
            P2160,
            (1280, 720),
            1.5,
            (3840, 2160),
        ),
        (
            None,
            Some((1280, 720)),
            P1080,
            (1280, 720),
            1.5,
            (1920, 1080),
        ),
    ];
    for (video, layout, r, want_layout, want_scale, want_offer) in cases {
        let rx = FakeReceiver::spawn(CastFake {
            video,
            ..CastFake::default()
        });
        let o = at_resolution(vec![rx.addr.to_string()], layout, r);
        let (vp, scale) = launched(&o, &connect_test);
        let what = format!("{video:?} {layout:?} {r:?}");
        assert_eq!(vp, want_layout, "{what}");
        assert!((scale - want_scale).abs() < 1e-3, "{what}: scale {scale}");
        let state = rx.shutdown();
        let st = state.lock().unwrap();
        assert_eq!(offered(&st), want_offer, "{what}");
    }
}

#[test]
fn an_explicit_resolution_uses_an_apple_tvs_decoder() {
    // The fake is the dev Apple TV: 1280x720 nominal, 3840x2160 max.
    for (r, want) in [
        (Resolution::Auto, 1.0),
        (Resolution::P1080, 1.5),
        (Resolution::P2160, 3.0),
    ] {
        let fake = FakeMirror::start(Behaviour {
            nack_after: None,
            ..Behaviour::default()
        });
        let connect = |t: &Target, c: &CastOptions, m: &MirrorOptions| -> Result<Box<dyn Sink>> {
            match t {
                Target::AirPlay { .. } => fake_airplay(
                    &fake,
                    "fake-airplay",
                    &MirrorOptions {
                        ptp: false,
                        ..m.clone()
                    },
                ),
                _ => connect_test(t, c, m),
            }
        };
        let o = at_resolution(vec![format!("airplay:{}", fake.addr)], Some((1280, 720)), r);
        let (vp, scale) = launched(&o, &connect);
        assert_eq!(vp, (1280, 720), "{r:?}");
        assert!((scale - want).abs() < 1e-3, "{r:?}: scale {scale}");
    }
}

#[test]
fn scale_arithmetic() {
    use Resolution::*;
    let s = |w, h| Size {
        width: w,
        height: h,
    };
    assert_eq!(browse::requested_size((1280, 720), P2160), s(3840, 2160));
    assert_eq!(browse::requested_size((1280, 720), P1080), s(1920, 1080));
    assert_eq!(browse::requested_size((1920, 1080), P720), s(1280, 720));
    assert_eq!(browse::requested_size((1280, 720), Auto), s(1920, 1080));
    // Other shapes fit inside the box.
    assert_eq!(browse::requested_size((1280, 800), P1080), s(1728, 1080));
    assert_eq!(browse::requested_size((1100, 760), P1080), s(1562, 1080));
    assert_eq!(browse::render_scale((1280, 720), (3840, 2160)), 3.0);
    assert_eq!(browse::render_scale((1280, 720), (1920, 1080)), 1.5);
    // A 4:3 layout in a 16:9 frame: the height decides (bars beside).
    assert_eq!(browse::render_scale((960, 720), (1920, 1080)), 1.5);
    assert_eq!(browse::render_scale((1920, 1080), (1280, 720)), 0.6666);
}

// ---------------------------------------------------------------------------
// Real Chrome and Firefox (opt-in):
//
// TVPIPE_TEST_CHROME=/path/to/chrome cargo test --release chrome_browser -- --ignored --nocapture
// TVPIPE_TEST_FIREFOX=/path/to/firefox cargo test --release firefox_browser -- --ignored --nocapture
//
// `tvpipe share URL` on a local test page (a moving clock and a 440 Hz
// tone, reloaded every 4 s by --reload to exercise sharing again) to the
// fake Cast receiver and the `--to browser` player, watched by a second
// headless browser of the same kind for TVPIPE_TEST_BROWSER_SECS
// (default 6): the player
// decodes and plays video and audio on time, Cast gets video and AAC
// (decoded by ffprobe when it is on PATH), and afterwards no browser
// process and no temporary profile is left.

const TEST_PAGE: &str = r#"<!doctype html><html><head><title>tvpipe test clock</title>
<style>html,body{margin:0;height:100%;background:#123;color:#fff;font:bold 12vh monospace;overflow:hidden}
#c{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
#bar{position:absolute;bottom:0;height:5vh;width:10%;background:#f80}</style></head>
<body><div id="c">--</div><div id="bar"></div><script>
let n = 0;
(function draw() {
  document.getElementById('c').textContent = new Date().toISOString().slice(11, 23) + ' #' + (n++);
  document.getElementById('bar').style.left = ((performance.now() / 20) % 90) + '%';
  requestAnimationFrame(draw);
})();
const a = new AudioContext(), o = a.createOscillator(), g = a.createGain();
o.frequency.value = 440; g.gain.value = 0.2; o.connect(g); g.connect(a.destination); o.start();
</script></body></html>"#;

/// Lines of `ps` that mention `needle` (unix; empty elsewhere).
fn processes_with(needle: &str) -> Vec<String> {
    if cfg!(windows) {
        return Vec::new();
    }
    let out = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,command="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.contains(needle))
        .map(str::to_owned)
        .collect()
}

#[test]
#[ignore]
fn chrome_browser_to_cast_and_player() {
    let Ok(bin) = std::env::var("TVPIPE_TEST_CHROME") else {
        eprintln!("TVPIPE_TEST_CHROME not set");
        return;
    };
    browser_to_cast_and_player(
        bin,
        std::env::var("TVPIPE_TEST_CHROME_HEADED").is_ok(),
        |bin, url| {
            let mut c = super::browser_tests::chrome(bin, url);
            super::player_tests::watch_player(&mut |s| c.eval(s));
        },
    );
}

#[test]
#[ignore]
fn firefox_browser_to_cast_and_player() {
    let Some(bin) = super::browser_tests::firefox_bin() else {
        eprintln!("TVPIPE_TEST_FIREFOX not set");
        return;
    };
    browser_to_cast_and_player(
        bin,
        std::env::var("TVPIPE_TEST_FIREFOX_HEADED").is_ok(),
        |bin, url| {
            let mut f = super::browser_tests::firefox(bin, url, (1280, 720));
            super::player_tests::watch_player(&mut |s| f.eval(s));
        },
    );
}

/// `share URL` with browser `bin`; `view(bin, url)` watches the player
/// page at `url` in another one.
fn browser_to_cast_and_player(bin: String, headed: bool, view: fn(&str, &str)) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    if std::env::var("TVPIPE_TEST_BROWSER_DEBUG").is_ok() {
        crate::log::set_level(crate::log::Level::Debug);
    }
    static STOP: std::sync::LazyLock<crate::util::stop::Stop> =
        std::sync::LazyLock::new(crate::util::stop::Stop::new);
    STOP.clear();
    // The test page, counting its loads.
    let loads = std::sync::Arc::new(AtomicUsize::new(0));
    let l = loads.clone();
    let handler: crate::net::httpd::Handler = std::sync::Arc::new(move |req| {
        use crate::net::httpd::{error_response, response, Reply};
        if req.target != "/" {
            return Reply::Response(error_response(404, "Not Found"));
        }
        l.fetch_add(1, Ordering::SeqCst);
        Reply::Response(response(
            200,
            "OK",
            "text/html; charset=utf-8",
            TEST_PAGE.as_bytes().to_vec(),
        ))
    });
    let site = crate::net::httpd::Server::bind(([127, 0, 0, 1], 0).into(), handler).unwrap();
    let page_url = format!("http://127.0.0.1:{}/", site.local_addr().port());

    let rx = FakeReceiver::spawn(CastFake::default());
    let cast_tally = SharedTally::default();
    let viewer = Mutex::new(None);
    let b = bin.clone();
    let connect = |t: &Target, c: &CastOptions, _: &MirrorOptions| -> Result<Box<dyn Sink>> {
        Ok(match t {
            Target::Browser(o) => {
                let o = crate::browser::player::PlayerOptions {
                    port: Some(0),
                    ..(**o).clone()
                };
                let sink = BrowserSink::bind(&o, &never())?;
                let url = format!("{}&stats=1", sink.url());
                let bin = b.clone();
                *viewer.lock().unwrap() = Some(std::thread::spawn(move || {
                    let r = std::panic::catch_unwind(|| view(&bin, &url));
                    STOP.request();
                    r
                }));
                Box::new(sink)
            }
            Target::Cast { addr, name } => {
                Tallied::boxed(Box::new(cast::connect(*addr, name, c)?), None, &cast_tally)
            }
            Target::AirPlay { .. } => unreachable!(),
        })
    };
    let profile = Mutex::new(None);
    let viewport = Mutex::new(None);
    let launcher =
        |server: &ShareServer, vp: (u32, u32), scale: f64| -> Result<Box<dyn std::any::Any>> {
            *viewport.lock().unwrap() = Some(vp);
            let h = crate::browser::headless::Headless::start(
                crate::browser::headless::HeadlessOptions {
                    url: page_url.clone(),
                    launch: crate::browser::launch::LaunchOptions {
                        bin: bin.clone().into(),
                        viewport: vp,
                        scale,
                        visible: headed,
                        app: None,
                        screen: None,
                    },
                    profile: None,
                    reload: Some(Duration::from_secs(4)),
                    control: None,
                },
                server.handle(),
                STOP.clone(),
            )?;
            *profile.lock().unwrap() = Some(h.profile_dir().to_path_buf());
            Ok(Box::new(h))
        };
    let o = browse_opts(vec![rx.addr.to_string(), "browser".into()]);
    let t0 = Instant::now();
    let r = browse::browse_with(&o, &connect, &Ctx::from(STOP.clone()), &launcher);
    let secs = t0.elapsed().as_secs_f64();
    let watched = viewer.lock().unwrap().take().map(|h| h.join().unwrap());
    if let Some(Err(panic)) = watched {
        std::panic::resume_unwind(panic);
    }
    r.unwrap();

    // The page is the receivers' size (the fake's ANSWER allows 1280x720)
    // and was loaded again by --reload.
    assert_eq!(*viewport.lock().unwrap(), Some((1280, 720)));
    let loads = loads.load(Ordering::SeqCst);
    eprintln!("the test page was loaded {loads} times in {secs:.1} s");
    assert!(loads >= 2, "--reload did not reload");

    // Cast: video at about the page's frame rate across the reloads, and
    // AAC.
    let tc = *cast_tally.lock().unwrap();
    eprintln!("cast {tc:?}");
    assert!(tc.video as f64 > secs * 15.0, "{tc:?} in {secs:.1} s");
    assert!(tc.audio > 0, "{tc:?}");
    let state = rx.shutdown();
    let st = state.lock().unwrap();
    assert!(st.stopped);
    let v = st.streams.iter().find(|s| s.codec == "h264").unwrap();
    let annexb: Vec<u8> = v.frames.values().flat_map(|f| f.data.clone()).collect();
    let path =
        std::env::temp_dir().join(format!("tvpipe-browser-test-{}.h264", std::process::id()));
    std::fs::write(&path, &annexb).unwrap();
    match std::process::Command::new("ffprobe")
        .args(["-v", "error", "-count_frames", "-select_streams", "v:0"])
        .args([
            "-show_entries",
            "stream=width,height,nb_read_frames",
            "-of",
            "csv=p=0",
        ])
        .arg(&path)
        .output()
    {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            eprintln!("ffprobe: {} {}", stdout.trim(), stderr.trim());
            let f: Vec<&str> = stdout.trim().split(',').collect();
            assert_eq!(&f[..2], ["1280", "720"], "{stdout}");
            let decoded: u64 = f[2].parse().unwrap();
            assert!(
                decoded + 5 >= v.frames.len() as u64,
                "{decoded} of {}",
                v.frames.len()
            );
            assert!(stderr.trim().is_empty(), "decode errors: {stderr}");
        }
        Err(e) => eprintln!("no ffprobe ({e}); not decoding"),
    }
    let _ = std::fs::remove_file(&path);

    // Nothing left behind.
    let dir = profile.lock().unwrap().clone().unwrap();
    assert!(!dir.exists(), "{} is still there", dir.display());
    let left = processes_with(&dir.to_string_lossy());
    assert!(left.is_empty(), "browser processes left: {left:#?}");
}

// TVPIPE_TEST_CHROME=/path/to/chrome cargo test --release chrome_browser_4k -- --ignored --nocapture
//
// `tvpipe share URL --size 1280x720 --resolution 4k` on the test page to
// a fake Cast receiver that allows 3840x2160@30: the page keeps its
// 1280x720 layout and renders at 3x, the tab is captured at 3840x2160,
// the browser's H.264 is 3840x2160 at level 5.1 and arrives at about the
// page's frame rate for TVPIPE_TEST_BROWSER_SECS (default 6).

#[test]
#[ignore]
fn chrome_browser_4k_to_cast() {
    use crate::cast::fake_receiver::VideoLimits;
    let Ok(bin) = std::env::var("TVPIPE_TEST_CHROME") else {
        eprintln!("TVPIPE_TEST_CHROME not set");
        return;
    };
    if std::env::var("TVPIPE_TEST_BROWSER_DEBUG").is_ok() {
        crate::log::set_level(crate::log::Level::Debug);
    }
    let secs: u64 = std::env::var("TVPIPE_TEST_BROWSER_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(6);
    static STOP: std::sync::LazyLock<crate::util::stop::Stop> =
        std::sync::LazyLock::new(crate::util::stop::Stop::new);
    STOP.clear();
    let handler: crate::net::httpd::Handler = std::sync::Arc::new(move |req| {
        use crate::net::httpd::{error_response, response, Reply};
        if req.target != "/" {
            return Reply::Response(error_response(404, "Not Found"));
        }
        Reply::Response(response(
            200,
            "OK",
            "text/html; charset=utf-8",
            TEST_PAGE.as_bytes().to_vec(),
        ))
    });
    let site = crate::net::httpd::Server::bind(([127, 0, 0, 1], 0).into(), handler).unwrap();
    let page_url = format!("http://127.0.0.1:{}/", site.local_addr().port());

    let rx = FakeReceiver::spawn(CastFake {
        video: Some(VideoLimits {
            max: (3840, 2160, 30),
            max_bit_rate: 40_000_000,
            max_pixels_per_second: None,
        }),
        ..CastFake::default()
    });
    let tally = SharedTally::default();
    let connect = |t: &Target, c: &CastOptions, _: &MirrorOptions| -> Result<Box<dyn Sink>> {
        match t {
            Target::Cast { addr, name } => Ok(Tallied::boxed(
                Box::new(cast::connect(*addr, name, c)?),
                None,
                &tally,
            )),
            _ => unreachable!(),
        }
    };
    let profile = Mutex::new(None);
    let launched_at = Mutex::new(None);
    let launch = Mutex::new(None);
    let launcher =
        |server: &ShareServer, vp: (u32, u32), scale: f64| -> Result<Box<dyn std::any::Any>> {
            *launch.lock().unwrap() = Some((vp, scale));
            *launched_at.lock().unwrap() = Some(Instant::now());
            let h = crate::browser::headless::Headless::start(
                crate::browser::headless::HeadlessOptions {
                    url: page_url.clone(),
                    launch: crate::browser::launch::LaunchOptions {
                        bin: bin.clone().into(),
                        viewport: vp,
                        scale,
                        visible: false,
                        app: None,
                        screen: None,
                    },
                    profile: None,
                    reload: None,
                    control: None,
                },
                server.handle(),
                STOP.clone(),
            )?;
            *profile.lock().unwrap() = Some(h.profile_dir().to_path_buf());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(secs + 2));
                STOP.request();
            });
            Ok(Box::new(h))
        };
    let o = at_resolution(
        vec![rx.addr.to_string()],
        Some((1280, 720)),
        Resolution::P2160,
    );
    let r = browse::browse_with(&o, &connect, &Ctx::from(STOP.clone()), &launcher);
    let elapsed = launched_at.lock().unwrap().unwrap().elapsed().as_secs_f64();
    r.unwrap();
    assert_eq!(*launch.lock().unwrap(), Some(((1280, 720), 3.0)));

    // About the page's 30 fps once it shares (a second or two after the
    // start).
    let t = *tally.lock().unwrap();
    eprintln!("cast {t:?} in {elapsed:.1} s");
    assert!(
        t.video as f64 > (elapsed - 2.5) * 20.0,
        "{t:?} in {elapsed:.1} s"
    );
    let state = rx.shutdown();
    let st = state.lock().unwrap();
    let v = st.streams.iter().find(|s| s.codec == "h264").unwrap();
    let annexb: Vec<u8> = v.frames.values().flat_map(|f| f.data.clone()).collect();
    // The SPS: High/Main/Baseline at level 5.1 (3840x2160@30).
    let sps = annexb
        .windows(4)
        .position(|w| w[..3] == [0, 0, 1] && w[3] & 0x1f == 7)
        .map(|i| &annexb[i + 4..i + 7])
        .expect("no SPS");
    eprintln!("SPS profile {} level {}", sps[0], sps[2]);
    assert_eq!(sps[2], 51, "level_idc");
    let path = std::env::temp_dir().join(format!("tvpipe-4k-test-{}.h264", std::process::id()));
    std::fs::write(&path, &annexb).unwrap();
    match std::process::Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "v:0"])
        .args(["-show_entries", "stream=width,height", "-of", "csv=p=0"])
        .arg(&path)
        .output()
    {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            eprintln!("ffprobe: {}", stdout.trim());
            assert_eq!(stdout.trim(), "3840,2160");
        }
        Err(e) => eprintln!("no ffprobe ({e}); not checking the size"),
    }
    let _ = std::fs::remove_file(&path);
    let dir = profile.lock().unwrap().clone().unwrap();
    assert!(!dir.exists(), "{} is still there", dir.display());
    let left = processes_with(&dir.to_string_lossy());
    assert!(left.is_empty(), "browser processes left: {left:#?}");
}

/// The page crashes (`Page.crash`), then the whole browser
/// (`Browser.crash`), each from a second DevTools client: the stream goes
/// on after each, and nothing is left behind.
#[test]
#[ignore]
fn chrome_browser_survives_crashes() {
    let Ok(bin) = std::env::var("TVPIPE_TEST_CHROME") else {
        eprintln!("TVPIPE_TEST_CHROME not set");
        return;
    };
    browser_survives_crashes(bin, crash_twice);
}

/// The same with Firefox: its tab's content process is killed, then
/// Firefox itself (unix: `kill -9` of the processes on the profile).
#[test]
#[ignore]
fn firefox_browser_survives_crashes() {
    let Some(bin) = super::browser_tests::firefox_bin() else {
        eprintln!("TVPIPE_TEST_FIREFOX not set");
        return;
    };
    if cfg!(windows) {
        eprintln!("not on Windows (kills processes with kill(1))");
        return;
    }
    browser_survives_crashes(bin, kill_firefox_twice);
}

/// `share URL` shows other pages in its tab (`Session::navigate`): the
/// receiver's session goes on, the page is loaded (a fragment of the same
/// document too) and shares again. `TVPIPE_TEST_CHROME=PATH`.
#[test]
#[ignore]
fn chrome_browser_goes_to_another_page() {
    let Ok(bin) = std::env::var("TVPIPE_TEST_CHROME") else {
        eprintln!("TVPIPE_TEST_CHROME not set");
        return;
    };
    let control = crate::opts::PageControl::default();
    let c = control.clone();
    let seen = browser_driven(
        bin,
        Some(control),
        Box::new(
            move |_dir: &std::path::Path, tally: &SharedTally, base: &str| {
                wait_frames(tally, 30, "at the start");
                c.navigate(format!("{base}next#k=1"));
                let gap = wait_frames(tally, 30, "after the navigation");
                eprintln!("30 frames {} ms after the navigation", gap.as_millis());
                // The same document with another fragment: loaded again.
                c.navigate(format!("{base}next#k=2"));
                std::thread::sleep(Duration::from_millis(1500));
                wait_frames(tally, 30, "after the second navigation");
            },
        ),
    );
    let count = |p: &str| seen.iter().filter(|s| s.as_str() == p).count();
    assert_eq!((count("/"), count("/next")), (1, 2), "{seen:?}");
}

/// `share URL` with browser `bin` while `crash(profile, tally)` crashes
/// it.
fn browser_survives_crashes(bin: String, crash: fn(&std::path::Path, &SharedTally)) {
    browser_driven(bin, None, Box::new(move |dir, tally, _| crash(dir, tally)));
}

/// What a driver does to the browser of profile `dir` while it shares
/// (`base`: the site's URL).
type Drive = Box<dyn FnOnce(&std::path::Path, &SharedTally, &str) + Send + std::panic::UnwindSafe>;

/// `share URL` with browser `bin` while `drive` acts on it; the paths the
/// site served.
fn browser_driven(
    bin: String,
    control: Option<crate::opts::PageControl>,
    drive: Drive,
) -> Vec<String> {
    if std::env::var("TVPIPE_TEST_BROWSER_DEBUG").is_ok() {
        crate::log::set_level(crate::log::Level::Debug);
    }
    let stop = crate::util::stop::Stop::new();
    let seen = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
    let log = seen.clone();
    let handler: crate::net::httpd::Handler = std::sync::Arc::new(move |req| {
        let path = req.target.split('?').next().unwrap_or("").to_owned();
        if path != "/favicon.ico" {
            log.lock().unwrap().push(path);
        }
        crate::net::httpd::Reply::Response(crate::net::httpd::response(
            200,
            "OK",
            "text/html; charset=utf-8",
            TEST_PAGE.as_bytes().to_vec(),
        ))
    });
    let site = crate::net::httpd::Server::bind(([127, 0, 0, 1], 0).into(), handler).unwrap();
    let page_url = format!("http://127.0.0.1:{}/", site.local_addr().port());
    let rx = FakeReceiver::spawn(CastFake::default());
    let tally = SharedTally::default();
    let connect = |t: &Target, c: &CastOptions, _: &MirrorOptions| -> Result<Box<dyn Sink>> {
        let Target::Cast { addr, name } = t else {
            unreachable!()
        };
        Ok(Tallied::boxed(
            Box::new(cast::connect(*addr, name, c)?),
            None,
            &tally,
        ))
    };
    let profile = std::sync::Arc::new(Mutex::new(None));
    let driver = Mutex::new(None);
    let drive = Mutex::new(Some(drive));
    let launcher =
        |server: &ShareServer, vp: (u32, u32), scale: f64| -> Result<Box<dyn std::any::Any>> {
            let h = crate::browser::headless::Headless::start(
                crate::browser::headless::HeadlessOptions {
                    url: page_url.clone(),
                    launch: crate::browser::launch::LaunchOptions {
                        bin: bin.clone().into(),
                        viewport: vp,
                        scale,
                        visible: false,
                        app: None,
                        screen: None,
                    },
                    profile: None,
                    reload: None,
                    control: control.clone(),
                },
                server.handle(),
                stop.clone(),
            )?;
            let dir = h.profile_dir().to_path_buf();
            *profile.lock().unwrap() = Some(dir.clone());
            let tally = tally.clone();
            let base = page_url.clone();
            let stop = stop.clone();
            if let Some(drive) = drive.lock().unwrap().take() {
                *driver.lock().unwrap() = Some(std::thread::spawn(move || {
                    let r = std::panic::catch_unwind(move || drive(&dir, &tally, &base));
                    stop.request();
                    r
                }));
            }
            Ok(Box::new(h))
        };
    let o = ShareOptions {
        size: Some(Size {
            width: 640,
            height: 360,
        }),
        ..browse_opts(vec![rx.addr.to_string()])
    };
    let r = browse::browse_with(&o, &connect, &Ctx::from(stop.clone()), &launcher);
    let drove = driver.lock().unwrap().take().map(|h| h.join().unwrap());
    if let Some(Err(panic)) = drove {
        std::panic::resume_unwind(panic);
    }
    r.unwrap();
    let state = rx.shutdown();
    assert!(state.lock().unwrap().stopped);
    let dir = profile.lock().unwrap().clone().unwrap();
    assert!(!dir.exists(), "{} is still there", dir.display());
    let left = processes_with(&dir.to_string_lossy());
    assert!(left.is_empty(), "browser processes left: {left:#?}");
    let seen = seen.lock().unwrap().clone();
    seen
}

/// Kills Firefox's content processes (the page's among them: they are
/// not told apart by their command lines), then its main process (the one
/// started with `--profile`).
fn kill_firefox_twice(dir: &std::path::Path, tally: &SharedTally) {
    let pids = |main: bool| -> Vec<String> {
        let needle = dir.to_string_lossy().into_owned();
        processes_with(&needle)
            .into_iter()
            .filter(|l| {
                let is_main = l.contains("--profile");
                if main {
                    is_main
                } else {
                    !is_main && l.trim_end().ends_with(" tab")
                }
            })
            .filter_map(|l| l.split_whitespace().next().map(str::to_owned))
            .collect()
    };
    let kill = |pids: Vec<String>| {
        assert!(!pids.is_empty(), "no process to kill");
        let st = std::process::Command::new("kill")
            .arg("-9")
            .args(&pids)
            .status()
            .unwrap();
        assert!(st.success());
    };
    wait_frames(tally, 30, "at the start");
    eprintln!("killing the tabs");
    kill(pids(false));
    let gap = wait_frames(tally, 30, "after the tab crashed");
    eprintln!("30 frames {} ms after the tab crashed", gap.as_millis());
    eprintln!("killing the browser");
    kill(pids(true));
    let gap = wait_frames(tally, 30, "after the browser crashed");
    eprintln!("30 frames {} ms after the browser crashed", gap.as_millis());
}

/// Waits for `n` more video frames to reach the receiver.
fn wait_frames(tally: &SharedTally, n: u64, what: &str) -> Duration {
    let t0 = Instant::now();
    let base = tally.lock().unwrap().video;
    while tally.lock().unwrap().video < base + n {
        assert!(t0.elapsed() < Duration::from_secs(30), "no video {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
    t0.elapsed()
}

/// A second DevTools client on the browser of profile `dir`.
fn devtools(dir: &std::path::Path) -> crate::browser::cdp::Cdp {
    let t0 = Instant::now();
    loop {
        if let Ok(s) = std::fs::read_to_string(dir.join("DevToolsActivePort")) {
            let mut l = s.lines();
            if let (Some(port), Some(path)) = (l.next(), l.next()) {
                let url = format!("ws://127.0.0.1:{port}{path}");
                if let Ok(c) = crate::browser::cdp::Cdp::connect(&url, Duration::from_secs(5)) {
                    return c;
                }
            }
        }
        assert!(t0.elapsed() < Duration::from_secs(20), "no DevTools port");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn crash_twice(dir: &std::path::Path, tally: &SharedTally) {
    wait_frames(tally, 30, "at the start");
    let cdp = devtools(dir);
    let targets = cdp
        .call(None, "Target.getTargets", Value::object())
        .unwrap();
    let page = targets
        .get("targetInfos")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .find(|t| t.get("type").and_then(Value::as_str) == Some("page"))
        .and_then(|t| t.get("targetId").and_then(Value::as_str))
        .unwrap()
        .to_owned();
    let session = cdp
        .call(
            None,
            "Target.attachToTarget",
            Value::object()
                .with("targetId", page.as_str())
                .with("flatten", true),
        )
        .unwrap()
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    eprintln!("crashing the page");
    let _ = cdp.call_timeout(
        Some(&session),
        "Page.crash",
        Value::object(),
        Duration::from_secs(2),
    );
    let gap = wait_frames(tally, 30, "after the page crashed");
    eprintln!("30 frames {} ms after the page crashed", gap.as_millis());
    eprintln!("crashing the browser");
    let _ = cdp.call_timeout(
        None,
        "Browser.crash",
        Value::object(),
        Duration::from_secs(2),
    );
    drop(cdp);
    let gap = wait_frames(tally, 30, "after the browser crashed");
    eprintln!("30 frames {} ms after the browser crashed", gap.as_millis());
}
