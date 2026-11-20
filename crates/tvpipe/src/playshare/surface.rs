//! Surfaces (docs/playshare-design.md §17): a page encodes a canvas with
//! WebCodecs and sends the H.264 and PCM as SLRW records over
//! `/_tvpipe/surface?id=N`; tvpipe streams them to the surface's
//! receivers on the program's-own-H.264 path (no browser of tvpipe's in
//! between). Keyframe requests go back to the page.
//!
//! Page → tvpipe: binary messages, one SLRW record each (`u8 kind | u64le
//! pts_us | u32le len | payload`; kinds 4 config, 3 H.264, 2 PCM, 0 end;
//! `pts_us` on the wall clock, `performance.timeOrigin + now()`).
//! tvpipe → page: `{"t":"status",…}` (the surface's state and receivers),
//! `{"t":"keyframe"}`, `{"t":"stats","fps","kbps","lagMs","lagMaxMs","dropped"}`
//! once a second while frames come.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::codec::json::Value;
use crate::error::{Error, Result};
use crate::net::websocket::Message;

use super::backend::{SurfaceSink, SurfaceSpec};
use super::conn::{self, Next, Out};
use super::hub::Hub;

/// The largest record (a 4K keyframe fits).
const MAX_RECORD: usize = 8 << 20;
/// Surfaces at once.
pub const MAX_SURFACES: usize = 8;

#[derive(Default)]
struct Stats {
    /// A video frame was queued: sound may follow (before it, the stream
    /// is not open and PCM would wait in its queue, stale).
    video_on: bool,
    /// The first record: its wall-clock pts and where that is on the
    /// stream's clock. Later records keep their distance to it.
    origin: Option<(u64, Duration)>,
    frames: u64,
    dropped: u64,
    bytes: u64,
    lag_sum_us: i64,
    lag_max_us: i64,
    since: Option<Instant>,
}

/// One surface.
pub(super) struct Entry {
    /// `None` once stopped (a socket may still hold the entry).
    sink: Arc<Mutex<Option<Box<dyn SurfaceSink>>>>,
    stats: Arc<Mutex<Stats>>,
    out: Option<Out>,
    last: Value,
}

/// The surfaces of a run.
#[derive(Default)]
pub(super) struct Surfaces {
    next: u32,
    map: HashMap<u32, Entry>,
}

fn wall_us() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Hub {
    fn surfaces(&self) -> std::sync::MutexGuard<'_, Surfaces> {
        lock(&self.surfaces)
    }

    /// `surface.open`.
    pub(super) fn surface_open(&self, params: &Value, selection: Vec<String>) -> Result<Value> {
        let num = |k: &str, lo: u32, hi: u32, default: Option<u32>| -> Result<u32> {
            match params.get(k) {
                None | Some(Value::Null) => {
                    default.ok_or_else(|| Error::usage(format!("surface.open: {k}")))
                }
                Some(v) => v
                    .as_u32()
                    .filter(|n| (lo..=hi).contains(n))
                    .ok_or_else(|| Error::usage(format!("surface.open: {k} is {lo}-{hi}"))),
            }
        };
        let width = num("width", 16, 3840, None)? & !1;
        let height = num("height", 16, 2160, None)? & !1;
        let fps = num("fps", 1, 120, Some(30))?;
        let bitrate = params
            .get("bitrate")
            .and_then(Value::as_u32)
            .map(|b| b / 1000);
        let audio = match params.get("audio") {
            Some(Value::Bool(true)) => Some((48_000, 2)),
            Some(a) if a.as_object().is_some() => Some((
                num_in(a, "sampleRate", 8_000, 192_000)?,
                num_in(a, "channels", 1, 2)? as u8,
            )),
            _ => None,
        };
        let to: Vec<String> = match params.get("to").and_then(Value::as_array) {
            Some(list) => list
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            None => selection,
        };
        if to.is_empty() {
            return Err(Error::usage("no receivers chosen").with_code("no-receivers"));
        }
        if self.surfaces().map.len() >= MAX_SURFACES {
            return Err(Error::usage("too many surfaces").with_code("too-many"));
        }
        let spec = SurfaceSpec {
            width,
            height,
            fps,
            audio,
            bitrate_kbps: bitrate,
        };
        info!(
            "playshare: a {width}x{height}@{fps} surface to {}",
            to.join(", ")
        );
        let sink = self.backend.surface(&to, spec)?;
        let mut s = self.surfaces();
        s.next += 1;
        let id = s.next;
        s.map.insert(
            id,
            Entry {
                sink: Arc::new(Mutex::new(Some(sink))),
                stats: Arc::default(),
                out: None,
                last: Value::Null,
            },
        );
        Ok(Value::object()
            .with("id", id)
            .with("path", format!("/_tvpipe/surface?id={id}"))
            .with("width", width)
            .with("height", height)
            .with("fps", fps)
            .with(
                "audio",
                match audio {
                    Some((r, c)) => Value::object()
                        .with("sampleRate", r)
                        .with("channels", u32::from(c)),
                    None => Value::Null,
                },
            ))
    }

    /// `surface.close`.
    pub(super) fn surface_close(&self, id: u32) -> Result<Value> {
        let e = self
            .surfaces()
            .map
            .remove(&id)
            .ok_or_else(|| Error::usage(format!("no surface {id}")))?;
        self.stop_entry(id, e);
        Ok(Value::object())
    }

    fn stop_entry(&self, id: u32, e: Entry) {
        if let Some(o) = &e.out {
            o.text(Value::object().with("t", "end").to_json());
            o.close(1000, "closed");
        }
        info!("playshare: surface {id} stopped");
        let sink = lock(&e.sink).take();
        if let Some(sink) = sink {
            sink.stop();
        }
        self.event(
            "surface",
            Value::object().with("id", id).with("state", "stopped"),
        );
    }

    /// Every surface (the end).
    pub(super) fn surfaces_stop_all(&self) {
        let all: Vec<(u32, Entry)> = self.surfaces().map.drain().collect();
        for (id, e) in all {
            self.stop_entry(id, e);
        }
    }

    /// Whether `id` is an open surface.
    pub(super) fn surface_exists(&self, id: u32) -> bool {
        self.surfaces().map.contains_key(&id)
    }

    /// Keyframe requests and status changes, to the pages and as events.
    pub(super) fn surfaces_tick(&self) {
        let mut events = Vec::new();
        let mut s = self.surfaces();
        for (id, e) in s.map.iter_mut() {
            let (status, key) = match lock(&e.sink).as_mut() {
                Some(sink) => (
                    self.status_with_display(sink.status()),
                    sink.keyframe_wanted(),
                ),
                None => continue,
            };
            if let Some(o) = &e.out {
                if key {
                    o.text(Value::object().with("t", "keyframe").to_json());
                }
            }
            if status != e.last {
                e.last = status.clone();
                if let Some(o) = &e.out {
                    o.text(status.clone().with("t", "status").to_json());
                }
                events.push(status.with("id", *id));
            }
            // Stats once a second.
            let mut st = lock(&e.stats);
            if let Some(since) = st.since {
                let dt = since.elapsed();
                if dt >= Duration::from_secs(1) {
                    let secs = dt.as_secs_f64();
                    let n = st.frames.max(1) as f64;
                    let v = Value::object()
                        .with("t", "stats")
                        .with("fps", (st.frames as f64 / secs * 10.0).round() / 10.0)
                        .with("kbps", (st.bytes as f64 * 8.0 / 1000.0 / secs).round())
                        .with("lagMs", (st.lag_sum_us as f64 / n / 100.0).round() / 10.0)
                        .with("lagMaxMs", (st.lag_max_us as f64 / 100.0).round() / 10.0)
                        .with("dropped", st.dropped);
                    debug!("playshare: surface {id}: {v}");
                    if let Some(o) = &e.out {
                        o.text(v.to_json());
                    }
                    let (origin, video_on) = (st.origin, st.video_on);
                    *st = Stats {
                        origin,
                        video_on,
                        since: Some(Instant::now()),
                        ..Stats::default()
                    };
                }
            }
        }
        drop(s);
        for e in events {
            self.event("surface", e);
        }
    }

    /// Runs a surface's socket until it ends.
    pub(super) fn run_surface(
        self: &Arc<Hub>,
        tcp: std::net::TcpStream,
        leftover: Vec<u8>,
        id: u32,
    ) {
        let Some((sink, stats)) = self
            .surfaces()
            .map
            .get(&id)
            .map(|e| (e.sink.clone(), e.stats.clone()))
        else {
            return;
        };
        let opts = conn::Options {
            name: "surface",
            max_message: MAX_RECORD,
            first_message: None,
            mark: None,
            limit: None,
        };
        let hub = self.clone();
        conn::run(
            tcp,
            leftover,
            opts,
            |out| {
                let mut s = hub.surfaces();
                if let Some(e) = s.map.get_mut(&id) {
                    if let Some(old) = e.out.replace(out.clone()) {
                        old.close(1000, "replaced");
                    }
                    e.last = Value::Null; // the new page gets the status
                }
            },
            |msg| match msg {
                Message::Binary(b) => match record(&sink, &stats, &b) {
                    Ok(()) => Next::Continue,
                    Err(e) => {
                        warn!("playshare: surface {id}: {e}");
                        Next::Close(1002, "bad record".into())
                    }
                },
                Message::Text(t) => {
                    if let Ok(v) = Value::parse(&t) {
                        if v.get("t").and_then(Value::as_str) == Some("log") {
                            info!(
                                "playshare: surface {id}: {} in {}",
                                v.get("codec").and_then(Value::as_str).unwrap_or("?"),
                                v.get("agent").and_then(Value::as_str).unwrap_or("?")
                            );
                        }
                    }
                    Next::Continue
                }
                Message::Close(_) => Next::Continue,
            },
        );
        let mut s = self.surfaces();
        if let Some(e) = s.map.get_mut(&id) {
            e.out = None;
        }
    }
}

fn num_in(v: &Value, k: &str, lo: u32, hi: u32) -> Result<u32> {
    v.get(k)
        .and_then(Value::as_u32)
        .filter(|n| (lo..=hi).contains(n))
        .ok_or_else(|| Error::usage(format!("surface.open: audio.{k} is {lo}-{hi}")))
}

/// One SLRW record from the page.
fn record(
    sink: &Mutex<Option<Box<dyn SurfaceSink>>>,
    stats: &Mutex<Stats>,
    b: &[u8],
) -> Result<()> {
    let mut guard = lock(sink);
    let Some(sink) = guard.as_mut() else {
        return Err(Error::closed("surface: closed"));
    };
    if b.len() < 13 {
        return Err(Error::malformed("surface: a short record"));
    }
    let kind = b[0];
    let pts = u64::from_le_bytes(b[1..9].try_into().unwrap_or([0; 8]));
    let len = u32::from_le_bytes(b[9..13].try_into().unwrap_or([0; 4])) as usize;
    let payload = &b[13..];
    if len != payload.len() {
        return Err(Error::malformed("surface: the record's length is wrong"));
    }
    // Onto the stream's clock, as a game in process stamps its frames:
    // the first record at now on that clock less how long ago the page
    // took it (its pts is the page's wall clock), the others at their
    // distance from it.
    let rel = {
        let mut st = lock(stats);
        let (p0, r0) = *st.origin.get_or_insert_with(|| {
            let age = Duration::from_micros(u64::try_from(wall_us() - pts as i64).unwrap_or(0));
            (pts, sink.elapsed().saturating_sub(age))
        });
        if pts >= p0 {
            r0 + Duration::from_micros(pts - p0)
        } else {
            r0.saturating_sub(Duration::from_micros(p0 - pts))
        }
    };
    match kind {
        4 => {
            let (&format, data) = payload
                .split_first()
                .ok_or_else(|| Error::malformed("surface: an empty config"))?;
            sink.config(data, format == 1)
        }
        3 => {
            let (&flags, au) = payload
                .split_first()
                .ok_or_else(|| Error::malformed("surface: an empty frame"))?;
            let queued = sink.video(au, rel, flags & 1 != 0, flags & 2 != 0)?;
            let mut st = lock(stats);
            st.since.get_or_insert_with(Instant::now);
            if queued {
                st.video_on = true;
                st.frames += 1;
                st.bytes += au.len() as u64;
                let lag = wall_us() - pts as i64;
                st.lag_sum_us += lag;
                st.lag_max_us = st.lag_max_us.max(lag);
            } else {
                st.dropped += 1;
            }
            Ok(())
        }
        2 => {
            if payload.len() % 2 != 0 {
                return Err(Error::malformed("surface: odd PCM"));
            }
            if !lock(stats).video_on {
                return Ok(());
            }
            let pcm: Vec<i16> = payload
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]))
                .collect();
            sink.audio(&pcm, rel)
        }
        0 => Ok(()),
        k => Err(Error::malformed(format!("surface: record kind {k}"))),
    }
}
