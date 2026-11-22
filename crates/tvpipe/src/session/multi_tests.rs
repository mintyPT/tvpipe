//! Replication tests (M10): one session, a fake Cast receiver and a fake
//! AirPlay mirror receiver, one encode, one shared timeline
//! (ARCHITECTURE.md), and the failure cases: a receiver that cannot be
//! reached, one that leaves mid-stream, and a stop request.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::tests::{
    assert_cast_frames, connect_test, fake_airplay, never, opts, SharedTally, Tallied,
};
use super::*;
use crate::airplay::fake_mirror::{Behaviour, FakeMirror};
use crate::airplay::MirrorOptions;
use crate::cast::fake_receiver::{FakeReceiver, Options as CastFake};
use crate::types::{AudioInfo, EncodedFrame, SinkStatus, VideoInfo, VIDEO_CLOCK_RATE};
use crate::util::time::NtpTime;

/// The built-in test pattern (no ffmpeg) to every `to`.
fn pattern_opts(to: Vec<String>) -> PlayOptions {
    PlayOptions {
        to,
        size: Some(Size {
            width: 320,
            height: 180,
        }),
        encoder: Encoder::Builtin,
        ..opts()
    }
}

fn no_io() -> GameIo {
    GameIo {
        stdin: Box::new(std::io::empty()),
        stdout: Box::new(std::io::sink()),
        approve: Box::new(|_, _| false),
    }
}

/// What a sink was told: `(pts, instant)` of every video frame it
/// accepted, read from the session clock it was given.
type Schedule = Arc<Mutex<Vec<(u64, Instant)>>>;

/// Records the schedule, and sleeps in its first video `push` (a sink
/// thread that falls behind at the start: a slow first encryption, a
/// scheduler hiccup). With a clock per sink, this receiver's timeline
/// would start that much later.
struct Observed {
    inner: Box<dyn Sink>,
    delay: Option<Duration>,
    clock: Option<crate::media::clock::SessionClock>,
    log: Schedule,
}

impl Sink for Observed {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn capabilities(&self) -> &Capabilities {
        self.inner.capabilities()
    }
    fn set_clock(&mut self, clock: crate::media::clock::SessionClock) {
        self.clock = Some(clock.clone());
        self.inner.set_clock(clock)
    }
    fn start(&mut self, v: &VideoInfo, a: Option<&AudioInfo>) -> Result<()> {
        self.inner.start(v, a)
    }
    fn push(&mut self, f: &EncodedFrame) -> Result<SinkStatus> {
        let video = f.track == TrackKind::Video;
        if video {
            if let Some(d) = self.delay.take() {
                std::thread::sleep(d);
            }
        }
        let r = self.inner.push(f);
        if video && matches!(r, Ok(SinkStatus::Accepted)) {
            let clock = self.clock.as_ref().expect("session clock");
            let at = clock.instant_for(f.pts, VIDEO_CLOCK_RATE).unwrap();
            self.log.lock().unwrap().push((f.pts, at));
        }
        r
    }
    fn wants_keyframe(&self) -> bool {
        self.inner.wants_keyframe()
    }
    fn stop(&mut self) -> Result<()> {
        self.inner.stop()
    }
}

fn fp_to_duration(fp: u64) -> Duration {
    Duration::from_nanos(((fp as u128 * 1_000_000_000) >> 32) as u64)
}

fn ntp_diff(a: u64, b: u64) -> f64 {
    (a.wrapping_sub(b) as i64) as f64 / 4_294_967_296.0
}

fn gap(a: Instant, b: Instant) -> Duration {
    if a > b {
        a - b
    } else {
        b - a
    }
}

#[test]
fn mixed_receivers_share_one_timeline() {
    // Instants ↔ wall-clock NTP (the Cast sink's Sender Reports) and the
    // AirPlay NTP-mode clock, sampled here.
    let (i0, n0) = (Instant::now(), NtpTime::now());
    let c0 = crate::airplay::timing::ntp_clock(i0);

    let rx = FakeReceiver::spawn(CastFake::default());
    let fake = FakeMirror::start(Behaviour {
        nack_after: None,
        ..Behaviour::default()
    });
    let seen_mirror = Mutex::new(None);
    let (cast_log, airplay_log) = (Schedule::default(), Schedule::default());
    let (cast_tally, airplay_tally) = (SharedTally::default(), SharedTally::default());
    let observed = |inner, ms, log: &Schedule, tally: &SharedTally| -> Box<dyn Sink> {
        let inner = Box::new(Observed {
            inner,
            delay: Some(Duration::from_millis(ms)),
            clock: None,
            log: log.clone(),
        });
        Tallied::boxed(inner, Some(24), tally)
    };
    let connect = |t: &Target, c: &CastOptions, m: &MirrorOptions| -> Result<Box<dyn Sink>> {
        match t {
            Target::Browser(_) => connect_test(t, c, m),
            Target::Cast { addr, name } => Ok(observed(
                Box::new(cast::connect(*addr, name, c)?),
                80,
                &cast_log,
                &cast_tally,
            )),
            Target::AirPlay { .. } => {
                *seen_mirror.lock().unwrap() = Some(m.clone());
                let m = MirrorOptions {
                    ptp: false,
                    ..m.clone()
                };
                Ok(observed(
                    fake_airplay(&fake, "fake-airplay", &m)?,
                    150,
                    &airplay_log,
                    &airplay_tally,
                ))
            }
        }
    };
    let o = pattern_opts(vec![rx.addr.to_string(), format!("airplay:{}", fake.addr)]);
    play_with(o, no_io(), &connect, &never()).unwrap();

    // One budget: no --latency with both families = the default everywhere.
    let m = seen_mirror.lock().unwrap().clone().unwrap();
    assert_eq!(m.latency_ms, Some(DEFAULT_LATENCY_MS));
    let state = rx.shutdown();
    let st = state.lock().unwrap();
    assert!(st.stopped, "STOP not received");
    let offer = st.offer.as_ref().unwrap();
    let streams = offer["offer"]["supportedStreams"].as_array().unwrap();
    assert!(!streams.is_empty());
    for s in streams {
        assert_eq!(s["targetDelay"].as_u32(), Some(DEFAULT_LATENCY_MS), "{s:?}");
    }
    let r = fake.rec();
    assert!(r.teardown, "TEARDOWN not received");
    let video_setup = r
        .setup_bodies
        .iter()
        .filter_map(|b| b.get("streams")?.as_array()?.first()?.get("latencyMs"))
        .find_map(|v| v.as_u32());
    assert_eq!(video_setup, Some(DEFAULT_LATENCY_MS));
    assert!(st.streams.iter().any(|s| s.codec == "aac"), "Cast audio");
    assert!(!r.audio.is_empty(), "AirPlay audio");

    // 1. Both sinks were given the same instant for the same frame,
    // although they got their first frames 80 and 150 ms late.
    let cast_log = cast_log.lock().unwrap().clone();
    let airplay_log = airplay_log.lock().unwrap().clone();
    let (tc, ta) = (*cast_tally.lock().unwrap(), *airplay_tally.lock().unwrap());
    // The session ran until both sinks had their 24; the logs are what
    // they accepted. Idle, that is all 24; a sink may drop some after a
    // long stall on a loaded machine (a full queue), so ask for half.
    assert_eq!((tc.video, ta.video), (24, 24), "{tc:?} {ta:?}");
    assert_eq!(cast_log.len() as u64, tc.video_accepted);
    assert_eq!(airplay_log.len() as u64, ta.video_accepted);
    let mut common = 0;
    for (pts, at) in &airplay_log {
        if let Some((_, c)) = cast_log.iter().find(|(p, _)| p == pts) {
            assert_eq!(at, c, "pts {pts}");
            common += 1;
        }
    }
    assert!(common >= 12, "{common} frames in common, {tc:?} {ta:?}");

    // 2. AirPlay: each frame's timestamp is its instant + the 200 ms lead
    // on the session timeline (NTP mode).
    let lead = fp_to_duration(crate::airplay::timing::fp_from_duration(
        Duration::from_millis(DEFAULT_LATENCY_MS as u64),
    ));
    let sent: Vec<Instant> = r
        .video
        .iter()
        .filter(|p| p.kind == 0)
        .map(|p| i0 + (fp_to_duration(p.ts - c0) - lead))
        .collect();
    assert_eq!(sent.len(), airplay_log.len());
    for (i, (t, (_, at))) in sent.iter().zip(&airplay_log).enumerate() {
        assert!(gap(*t, *at) < Duration::from_millis(1), "AirPlay frame {i}");
    }

    // 3. Cast: RTP timestamps are the pts, and every Sender Report maps
    // RTP to the wall clock on the schedule (offset of some frame's
    // instant from its pts: one offset per anchor, normally just one).
    // (The receiver has every accepted frame in order, but those still
    // being paced out at STOP may be missing at the end.)
    let v = st.streams.iter().find(|s| s.codec == "h264").unwrap();
    assert_cast_frames(&v.frames, tc.video_accepted);
    for (f, (pts, _)) in v.frames.values().zip(&cast_log) {
        assert_eq!(f.rtp_timestamp, *pts as u32);
    }
    let (p0, _) = cast_log[0];
    let offset = |pts: u64, at: Instant| -> f64 {
        let secs = if at >= i0 {
            (at - i0).as_secs_f64()
        } else {
            -(i0 - at).as_secs_f64()
        };
        secs - (pts as f64 - p0 as f64) / 90_000.0
    };
    let offsets: Vec<f64> = cast_log.iter().map(|(p, a)| offset(*p, *a)).collect();
    assert!(!v.sender_reports.is_empty(), "no Sender Report");
    for sr in &v.sender_reports {
        let dt = (sr.rtp_timestamp.wrapping_sub(p0 as u32) as i32) as f64 / 90_000.0;
        let sr_offset = ntp_diff(sr.ntp, n0.0) - dt;
        let best = offsets
            .iter()
            .map(|o| (o - sr_offset).abs())
            .fold(f64::MAX, f64::min);
        assert!(best < 0.003, "Sender Report {best} s off the schedule");
    }
}

/// What the Cast and the AirPlay sinks accepted.
#[derive(Default)]
struct Tallies {
    cast: SharedTally,
    airplay: SharedTally,
}

/// Cast targets connect to the fake; the AirPlay ones to `fake`. Every
/// sink counts into `tallies`.
fn mixed_connector<'a>(
    fake: &'a FakeMirror,
    cast_limit: Option<usize>,
    airplay_limit: Option<usize>,
    tallies: &'a Tallies,
) -> impl Fn(&Target, &CastOptions, &MirrorOptions) -> Result<Box<dyn Sink>> + Sync + 'a {
    move |t, c, m| {
        Ok(match t {
            Target::Browser(_) => connect_test(t, c, m)?,
            Target::Cast { addr, name } => Tallied::boxed(
                Box::new(cast::connect(*addr, name, c)?),
                cast_limit,
                &tallies.cast,
            ),
            Target::AirPlay { .. } => Tallied::boxed(
                fake_airplay(fake, "fake-airplay", m)?,
                airplay_limit,
                &tallies.airplay,
            ),
        })
    }
}

fn airplay_frames(fake: &FakeMirror) -> usize {
    fake.rec().video.iter().filter(|p| p.kind == 0).count()
}

#[test]
fn unreachable_receiver_is_left_out() {
    let rx = FakeReceiver::spawn(CastFake::default());
    let fake = FakeMirror::start(Behaviour::default());
    // Nothing listens on port 1: that receiver's connect fails.
    let tallies = Tallies::default();
    let connect = mixed_connector(&fake, Some(10), Some(10), &tallies);
    let o = pattern_opts(vec![
        rx.addr.to_string(),
        "cast:127.0.0.1:1".into(),
        format!("airplay:{}", fake.addr),
    ]);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut ctx = never();
    let s = seen.clone();
    ctx.events = Events::to(move |e| s.lock().unwrap().push(e));
    play_with(o, no_io(), &connect, &ctx).unwrap();
    // People's front ends see each receiver connecting (addresses are
    // not looked up), and how it went.
    let seen = seen.lock().unwrap();
    let connecting = seen
        .iter()
        .filter(|e| matches!(e, Event::Progress(Progress::Begin(Step::Connect(_)))))
        .count();
    assert_eq!(connecting, 3, "{seen:?}");
    assert!(!seen
        .iter()
        .any(|e| matches!(e, Event::Progress(Progress::Begin(Step::Find(_))))));
    assert!(
        seen.iter().any(|e| matches!(
            e,
            Event::Receiver(r) if r.name == "127.0.0.1:1" && r.state == ReceiverState::Failed
        )),
        "{seen:?}"
    );
    let state = rx.shutdown();
    let st = state.lock().unwrap();
    assert!(st.stopped);
    let v = st.streams.iter().find(|s| s.codec == "h264").unwrap();
    // Both reachable receivers were streamed to until they had their 10
    // (what a sink drops on a loaded machine never arrives).
    let (tc, ta) = (
        *tallies.cast.lock().unwrap(),
        *tallies.airplay.lock().unwrap(),
    );
    assert_eq!((tc.video, ta.video), (10, 10), "{tc:?} {ta:?}");
    assert_cast_frames(&v.frames, tc.video_accepted);
    assert!(fake.rec().teardown);
    assert_eq!(airplay_frames(&fake) as u64, ta.video_accepted, "{ta:?}");

    // Nobody reachable: the session fails with the connect error.
    let o = pattern_opts(vec!["cast:127.0.0.1:1".into(), "cast:127.0.0.1:2".into()]);
    let e = play_with(o, no_io(), &connect, &never()).unwrap_err();
    assert_eq!(e.kind(), crate::error::ErrorKind::Io, "{e}");
}

#[test]
fn airplay_receiver_leaving_does_not_stop_cast() {
    let rx = FakeReceiver::spawn(CastFake::default());
    // The Apple TV user stops mirroring after a few packets.
    let fake = FakeMirror::start(Behaviour {
        close_after_packets: Some(8),
        ..Behaviour::default()
    });
    let tallies = Tallies::default();
    let connect = mixed_connector(&fake, Some(45), None, &tallies);
    let o = pattern_opts(vec![rx.addr.to_string(), format!("airplay:{}", fake.addr)]);
    play_with(o, no_io(), &connect, &never()).unwrap();
    let state = rx.shutdown();
    let st = state.lock().unwrap();
    assert!(st.stopped);
    let v = st.streams.iter().find(|s| s.codec == "h264").unwrap();
    let tc = *tallies.cast.lock().unwrap();
    assert_eq!(tc.video, 45, "{tc:?}");
    assert_cast_frames(&v.frames, tc.video_accepted);
    assert!(airplay_frames(&fake) <= 8);
}

#[test]
fn cast_receiver_leaving_does_not_stop_airplay() {
    let rx = FakeReceiver::spawn(CastFake::default());
    let fake = FakeMirror::start(Behaviour::default());
    let tallies = Tallies::default();
    let connect = mixed_connector(&fake, None, Some(45), &tallies);
    let o = pattern_opts(vec![rx.addr.to_string(), format!("airplay:{}", fake.addr)]);
    // The Cast receiver goes away (control channel closed) after ~0.4 s.
    let killer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        rx.shutdown()
    });
    let t0 = Instant::now();
    play_with(o, no_io(), &connect, &never()).unwrap();
    let state = killer.join().unwrap();
    // 45 frames at 30 fps: the AirPlay sink was given all of them, well
    // after the Cast one left, and its receiver got what it accepted.
    assert!(t0.elapsed() >= Duration::from_millis(1400));
    let ta = *tallies.airplay.lock().unwrap();
    assert_eq!(ta.video, 45, "{ta:?}");
    assert_eq!(airplay_frames(&fake) as u64, ta.video_accepted, "{ta:?}");
    assert!(fake.rec().teardown);
    let st = state.lock().unwrap();
    let v = st.streams.iter().find(|s| s.codec == "h264").unwrap();
    assert!(v.frames.len() < 30, "{}", v.frames.len());
}

static STOP_REQUESTED: std::sync::LazyLock<crate::util::stop::Stop> =
    std::sync::LazyLock::new(crate::util::stop::Stop::new);

#[test]
fn stop_request_tears_every_receiver_down() {
    let rx = FakeReceiver::spawn(CastFake::default());
    let fake = FakeMirror::start(Behaviour::default());
    // No frame limit: the test pattern runs until the stop request.
    let tallies = Tallies::default();
    let connect = mixed_connector(&fake, None, None, &tallies);
    let o = pattern_opts(vec![rx.addr.to_string(), format!("airplay:{}", fake.addr)]);
    let stopper = std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(700));
        STOP_REQUESTED.request();
        Instant::now()
    });
    play_with(o, no_io(), &connect, &Ctx::from(STOP_REQUESTED.clone())).unwrap();
    let asked = stopper.join().unwrap();
    // No draining and no playout tail: down within a moment.
    assert!(
        asked.elapsed() < Duration::from_millis(1500),
        "{:?}",
        asked.elapsed()
    );
    let state = rx.shutdown();
    let st = state.lock().unwrap();
    assert!(st.stopped, "Cast STOP not received");
    assert!(!st.streams.is_empty());
    let r = fake.rec();
    assert!(r.teardown, "AirPlay TEARDOWN not received");
    assert!(r.video.iter().any(|p| p.kind == 0));
}

#[test]
fn budgets() {
    let cast = Target::Cast {
        addr: "127.0.0.1:8009".parse().unwrap(),
        name: "c".into(),
    };
    let airplay = Target::AirPlay {
        name: "a".into(),
        addr: "127.0.0.1:7000".parse().unwrap(),
        device: None,
    };
    let b = |l, t: &[Target]| shared_budget(l, t, true);
    let both = [cast.clone(), airplay.clone()];
    let d = DEFAULT_LATENCY_MS;
    assert_eq!(d, 300);
    assert_eq!(
        b(None, &both),
        Budget {
            cast_ms: d,
            airplay_ms: Some(d),
            browser_ms: d,
            session_ms: d,
        }
    );
    assert_eq!(
        b(None, std::slice::from_ref(&cast)),
        Budget {
            cast_ms: d,
            airplay_ms: None,
            browser_ms: d,
            session_ms: d,
        }
    );
    assert_eq!(
        b(None, &[airplay.clone(), airplay.clone()]),
        Budget {
            cast_ms: d,
            airplay_ms: None,
            browser_ms: BROWSER_LATENCY_MS,
            session_ms: d,
        }
    );
    assert_eq!(
        b(Some(120), &both),
        Budget {
            cast_ms: 120,
            airplay_ms: Some(120),
            browser_ms: 120,
            session_ms: 120,
        }
    );
    // Only browsers (`preview`, `play`/`share --to browser`): theirs.
    let browser = Target::Browser(Box::default());
    let only = b(None, &[browser.clone(), browser.clone()]);
    assert_eq!(
        (only.browser_ms, only.session_ms),
        (BROWSER_LATENCY_MS, BROWSER_LATENCY_MS)
    );
    // A browser next to a TV: the TV's.
    let mixed = b(None, &[browser.clone(), cast.clone()]);
    assert_eq!((mixed.browser_ms, mixed.session_ms), (d, d));
    let mixed = b(None, &[browser, airplay.clone()]);
    assert_eq!(
        (mixed.browser_ms, mixed.session_ms),
        (BROWSER_LATENCY_MS, d)
    );
    assert_eq!(b(Some(9000), &[]).session_ms, 2000);
    // An LG TV with sound: 300 ms everywhere, the others in step (§2.7).
    let mut dev = crate::net::device::tests::lan_devices()
        .into_iter()
        .find(|d| d.airplay.is_some())
        .unwrap();
    dev.airplay.as_mut().unwrap().txt.manufacturer = Some("LG".into());
    let lg = Target::AirPlay {
        name: "lg".into(),
        addr: "127.0.0.1:7000".parse().unwrap(),
        device: Some(Box::new(dev)),
    };
    let all = Budget {
        cast_ms: d,
        airplay_ms: Some(d),
        browser_ms: d,
        session_ms: d,
    };
    assert_eq!(b(None, std::slice::from_ref(&lg)), all);
    assert_eq!(b(None, &[lg.clone(), airplay.clone()]), all);
    assert_eq!(b(None, &[lg.clone(), Target::Browser(Box::default())]), all);
    assert_eq!(
        b(Some(120), &[lg.clone(), airplay.clone()]).airplay_ms,
        Some(120)
    );
    // Without sound the automatic profile, as for any receiver.
    let quiet = shared_budget(None, &[lg, airplay.clone()], false);
    assert_eq!(quiet.airplay_ms, None);
    // Clamped to what both protocols take.
    assert_eq!(b(Some(1), &both).cast_ms, 5);
    assert_eq!(b(Some(9000), &both).airplay_ms, Some(2000));
}
