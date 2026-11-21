//! The sender's media clock: maps stream timestamps to monotonic
//! [`Instant`]s (ARCHITECTURE.md, "Timing and Latency").
//!
//! The first observed frame anchors the clock: its media time corresponds
//! to its arrival instant. Every later frame is observed too; if one
//! arrives *earlier* than the clock predicts (the first frames were slowed
//! by encoder start-up), the anchor moves earlier so no frame is ever
//! scheduled before it existed. It never moves later: late frames are the
//! sinks' business (playout delay, dropping).
//!
//! Media time is shared by all tracks (video pts at 90 kHz and audio pts at
//! their sample rate both start near zero on one timeline, see
//! `media::source`), so one clock serves video and audio.
//!
//! One clock serves the whole session (ARCHITECTURE.md, "Several Receivers"): the fanout
//! schedules every frame on it as the frame leaves the input
//! ([`MediaClock::schedule`]), and every sink reads the same instants
//! through a [`SinkClock`], so all receivers present a frame at the same
//! instant plus the same playout budget. A sink used on its own (unit
//! tests) anchors a private clock with the same rule.
//!
//! Sources: ARCHITECTURE.md, "Timing and Latency".

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::util::time::ticks_to_duration;

/// Anchor moves smaller than this are ignored (scheduling jitter).
const REANCHOR_THRESHOLD: Duration = Duration::from_millis(1);

/// When [`MediaClock::schedule`] moves the anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tolerance {
    /// Frames later than this (a stalled source) re-anchor to now.
    pub late: Duration,
    /// Frames earlier than this (a jump in the input) re-anchor to now.
    pub early: Duration,
}

impl Tolerance {
    /// The session's rule (and the sinks' private one).
    pub const DEFAULT: Tolerance = Tolerance {
        late: Duration::from_millis(100),
        early: Duration::from_secs(1),
    };
}

#[derive(Debug, Clone, Copy)]
struct Anchor {
    at: Instant,
    media: Duration,
}

#[derive(Debug, Default)]
pub struct MediaClock {
    anchor: Mutex<Option<Anchor>>,
}

impl MediaClock {
    pub fn new() -> MediaClock {
        MediaClock::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Anchor>> {
        // A poisoned lock only means a panic elsewhere; the data is a Copy.
        self.anchor.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Records that the frame with `pts` (at `rate` Hz) arrived now.
    pub fn observe(&self, pts: u64, rate: u32) {
        self.observe_at(pts, rate, Instant::now());
    }

    /// Like [`MediaClock::observe`] with an explicit arrival time.
    pub fn observe_at(&self, pts: u64, rate: u32, now: Instant) {
        let media = ticks_to_duration(pts, rate);
        let mut a = self.lock();
        match *a {
            None => *a = Some(Anchor { at: now, media }),
            Some(old) => {
                // When the clock says this frame is due.
                let due = instant_for(old, media);
                if let Some(early) = due.checked_duration_since(now) {
                    if early > REANCHOR_THRESHOLD {
                        debug!(
                            "media clock: frame {} ms early, re-anchoring",
                            early.as_millis()
                        );
                        *a = Some(Anchor { at: now, media });
                    }
                }
            }
        }
    }

    /// Moves the anchor so that `pts` happens at `now`, also later (a sink
    /// that fell behind: a stalled encoder or a jump in the input).
    pub fn reanchor_at(&self, pts: u64, rate: u32, now: Instant) {
        let media = ticks_to_duration(pts, rate);
        *self.lock() = Some(Anchor { at: now, media });
    }

    /// The instant for a frame with `pts` that arrived at `now`, moving
    /// the anchor when needed: the first frame anchors the clock; early
    /// frames keep their pts-derived (future) instants (ffmpeg delivers in
    /// bursts, and moving the anchor earlier would squeeze a burst's
    /// frames together); frames more than `tol.late` late (a stalled
    /// source) or `tol.early` early (a jump in the input) re-anchor to now.
    pub fn schedule(&self, pts: u64, rate: u32, now: Instant, tol: Tolerance) -> Instant {
        let ok = |late: i128| {
            late <= tol.late.as_nanos() as i128 && -late <= tol.early.as_nanos() as i128
        };
        match (self.lateness(pts, rate, now), self.instant_for(pts, rate)) {
            (Some(late), Some(t)) if ok(late) => t,
            (late, _) => {
                if let Some(late) = late {
                    debug!(
                        "media clock: re-anchoring ({} ms {})",
                        late.unsigned_abs() / 1_000_000,
                        if late > 0 { "late" } else { "early" }
                    );
                }
                self.reanchor_at(pts, rate, now);
                now
            }
        }
    }

    pub fn is_anchored(&self) -> bool {
        self.lock().is_some()
    }

    /// The instant at which media time `pts / rate` happens (before any
    /// playout delay). `None` until the first frame is observed.
    pub fn instant_for(&self, pts: u64, rate: u32) -> Option<Instant> {
        let media = ticks_to_duration(pts, rate);
        self.lock().map(|a| instant_for(a, media))
    }

    /// The media time at `now`: where the stream "is" right now. `None`
    /// until anchored; zero before the anchor's media time.
    pub fn media_time_at(&self, now: Instant) -> Option<Duration> {
        self.lock().map(|a| {
            if now >= a.at {
                a.media + (now - a.at)
            } else {
                a.media.saturating_sub(a.at - now)
            }
        })
    }

    /// How late a frame is at `now` relative to when it was due (negative
    /// when early), in nanoseconds. `None` until anchored.
    pub fn lateness(&self, pts: u64, rate: u32, now: Instant) -> Option<i128> {
        let due = self.instant_for(pts, rate)?;
        Some(if now >= due {
            (now - due).as_nanos() as i128
        } else {
            -((due - now).as_nanos() as i128)
        })
    }
}

/// The session's clock as one sink sees it (ARCHITECTURE.md), handed over
/// by the fanout with [`Sink::set_clock`](crate::types::Sink::set_clock).
///
/// The fanout schedules each frame when it leaves the input and *pins*
/// that instant here right before it pushes the frame to this sink, so a
/// sink gets the instant that was decided for everyone even when the
/// shared anchor moved meanwhile (a stall seen while this sink's queue
/// still held older frames).
#[derive(Debug, Clone)]
pub struct SessionClock {
    clock: Arc<MediaClock>,
    pinned: Arc<Mutex<Option<Pinned>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Pinned {
    pts: u64,
    rate: u32,
    at: Instant,
}

impl SessionClock {
    /// A view of `clock` for one sink.
    pub fn new(clock: Arc<MediaClock>) -> SessionClock {
        SessionClock {
            clock,
            pinned: Arc::new(Mutex::new(None)),
        }
    }

    pub fn clock(&self) -> &Arc<MediaClock> {
        &self.clock
    }

    /// The frame about to be pushed was scheduled at `at`.
    pub fn pin(&self, pts: u64, rate: u32, at: Instant) {
        *self.pinned.lock().unwrap_or_else(|e| e.into_inner()) = Some(Pinned { pts, rate, at });
    }

    /// The scheduled instant of `pts`: the pinned one for the frame being
    /// pushed, else from the shared anchor. `None` before the first frame.
    pub fn instant_for(&self, pts: u64, rate: u32) -> Option<Instant> {
        let pinned = *self.pinned.lock().unwrap_or_else(|e| e.into_inner());
        match pinned {
            Some(p) if p.pts == pts && p.rate == rate => Some(p.at),
            _ => self.clock.instant_for(pts, rate),
        }
    }
}

/// A sink's view of the media clock: the session's (scheduled by the
/// fanout, read only here) or a private one the sink anchors itself.
#[derive(Debug)]
pub struct SinkClock {
    session: Option<SessionClock>,
    own: MediaClock,
    tol: Tolerance,
}

impl SinkClock {
    /// A clock of the sink's own, anchored on the first frame it gets.
    pub fn private(tol: Tolerance) -> SinkClock {
        SinkClock {
            session: None,
            own: MediaClock::new(),
            tol,
        }
    }

    /// The session's clock.
    pub fn shared(clock: SessionClock) -> SinkClock {
        SinkClock {
            session: Some(clock),
            own: MediaClock::new(),
            tol: Tolerance::DEFAULT,
        }
    }

    /// `shared` when the fanout handed one over, else `private`.
    pub fn new(session: Option<SessionClock>, tol: Tolerance) -> SinkClock {
        match session {
            Some(c) => SinkClock::shared(c),
            None => SinkClock::private(tol),
        }
    }

    pub fn is_shared(&self) -> bool {
        self.session.is_some()
    }

    /// The instant of a frame with `pts` that reached the sink at `now`.
    /// On the shared clock this is the instant the fanout scheduled (a
    /// sink that falls behind does not move everyone's timeline; its
    /// frames just have less headroom). It only anchors the shared clock
    /// when the fanout did not (a frame pushed outside a fanout).
    pub fn instant(&self, pts: u64, rate: u32, now: Instant) -> Instant {
        match &self.session {
            Some(s) => match s.instant_for(pts, rate) {
                Some(t) => t,
                None => s.clock.schedule(pts, rate, now, self.tol),
            },
            None => self.own.schedule(pts, rate, now, self.tol),
        }
    }

    /// The instant of `pts` without moving the anchor (`None` before the
    /// first frame).
    pub fn instant_for(&self, pts: u64, rate: u32) -> Option<Instant> {
        match &self.session {
            Some(s) => s.instant_for(pts, rate),
            None => self.own.instant_for(pts, rate),
        }
    }
}

fn instant_for(a: Anchor, media: Duration) -> Instant {
    if media >= a.media {
        a.at + (media - a.media)
    } else {
        // Before the anchor (e.g. audio that starts a bit before video).
        a.at.checked_sub(a.media - media).unwrap_or(a.at)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_on_first_frame() {
        let c = MediaClock::new();
        let t0 = Instant::now();
        assert!(c.instant_for(0, 90_000).is_none());
        c.observe_at(9_000, 90_000, t0); // 100 ms media time
        assert_eq!(c.instant_for(9_000, 90_000), Some(t0));
        assert_eq!(
            c.instant_for(18_000, 90_000),
            Some(t0 + Duration::from_millis(100))
        );
        // Audio at 48 kHz on the same timeline.
        assert_eq!(
            c.instant_for(9_600, 48_000),
            Some(t0 + Duration::from_millis(100))
        );
        assert_eq!(
            c.instant_for(0, 48_000),
            Some(t0 - Duration::from_millis(100))
        );
        assert_eq!(
            c.media_time_at(t0 + Duration::from_millis(50)),
            Some(Duration::from_millis(150))
        );
    }

    #[test]
    fn moves_earlier_never_later() {
        let c = MediaClock::new();
        let t0 = Instant::now();
        // First frame was 40 ms slow (encoder start-up).
        c.observe_at(0, 90_000, t0 + Duration::from_millis(40));
        // A late frame does not move the anchor.
        c.observe_at(3_000, 90_000, t0 + Duration::from_millis(200));
        assert_eq!(
            c.instant_for(0, 90_000),
            Some(t0 + Duration::from_millis(40))
        );
        assert_eq!(
            c.lateness(3_000, 90_000, t0 + Duration::from_millis(200)),
            Some(126_666_667) // 200 ms - (40 ms + 33.333333 ms)
        );
        // Frame at media 1 s arrives at t0 + 1.01 s: 30 ms early, re-anchor.
        c.observe_at(90_000, 90_000, t0 + Duration::from_millis(1010));
        assert_eq!(
            c.instant_for(0, 90_000),
            Some(t0 + Duration::from_millis(10))
        );
        // Sub-millisecond jitter is ignored.
        c.observe_at(180_000, 90_000, t0 + Duration::from_micros(2_009_500));
        assert_eq!(
            c.instant_for(0, 90_000),
            Some(t0 + Duration::from_millis(10))
        );
        assert!(c.lateness(0, 90_000, t0).unwrap() < 0);
        // An explicit re-anchor may move it later.
        c.reanchor_at(0, 90_000, t0 + Duration::from_secs(5));
        assert_eq!(
            c.instant_for(90_000, 90_000),
            Some(t0 + Duration::from_secs(6))
        );
    }

    #[test]
    fn schedule_keeps_early_frames_and_reanchors_far_ones() {
        let c = MediaClock::new();
        let tol = Tolerance::DEFAULT;
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        assert_eq!(c.schedule(0, 90_000, t0, tol), t0);
        // A burst: frames 50 ms early keep their instants.
        assert_eq!(c.schedule(9_000, 90_000, t0 + ms(50), tol), t0 + ms(100));
        // 80 ms late: still on the anchor.
        assert_eq!(c.schedule(18_000, 90_000, t0 + ms(280), tol), t0 + ms(200));
        // 300 ms late (a stall): re-anchored to now.
        assert_eq!(c.schedule(27_000, 90_000, t0 + ms(600), tol), t0 + ms(600));
        assert_eq!(c.instant_for(36_000, 90_000), Some(t0 + ms(700)));
        // A jump of 10 s ahead re-anchors too.
        let t = t0 + ms(700);
        assert_eq!(c.schedule(36_000 + 900_000, 90_000, t, tol), t);
        // Audio on the same timeline.
        assert_eq!(c.instant_for(499_200 + 4_800, 48_000), Some(t + ms(100)));
    }

    #[test]
    fn sink_clocks() {
        let t0 = Instant::now();
        let ms = Duration::from_millis;
        let session = Arc::new(MediaClock::new());
        let va = SessionClock::new(session.clone());
        let a = SinkClock::shared(va.clone());
        let b = SinkClock::shared(SessionClock::new(session.clone()));
        assert!(a.is_shared());
        // The fanout anchors at t0; a sink seeing the frame 300 ms later
        // still gets the session's instant (no private re-anchor).
        session.schedule(0, 90_000, t0, Tolerance::DEFAULT);
        assert_eq!(a.instant(0, 90_000, t0 + ms(300)), t0);
        assert_eq!(b.instant(9_000, 90_000, t0 + ms(5)), t0 + ms(100));
        // The anchor moved (a stall) while `a` still had frame 3_000
        // queued: the pinned instant wins for that frame only.
        let at = session.instant_for(3_000, 90_000).unwrap();
        session.reanchor_at(6_000, 90_000, t0 + ms(500));
        va.pin(3_000, 90_000, at);
        assert_eq!(a.instant(3_000, 90_000, t0 + ms(510)), at);
        assert_eq!(
            a.instant_for(3_000, 48_000),
            session.instant_for(3_000, 48_000)
        );
        assert_eq!(
            b.instant(3_000, 90_000, t0 + ms(510)),
            t0 + ms(466) + Duration::from_micros(666) + Duration::from_nanos(667)
        );
        // Unanchored shared clock (no fanout): the sink anchors it.
        let lone = SinkClock::new(
            Some(SessionClock::new(Arc::new(MediaClock::new()))),
            Tolerance::DEFAULT,
        );
        assert_eq!(lone.instant(90_000, 90_000, t0), t0);
        // A private clock re-anchors when its frames are late.
        let p = SinkClock::new(None, Tolerance::DEFAULT);
        assert!(!p.is_shared());
        assert_eq!(p.instant(0, 90_000, t0), t0);
        assert_eq!(p.instant(3_000, 90_000, t0 + ms(400)), t0 + ms(400));
        assert_eq!(p.instant_for(3_000, 90_000), Some(t0 + ms(400)));
    }
}
