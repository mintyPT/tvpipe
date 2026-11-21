//! Game input: SLRW records on stdin (see [`slrw`](super::slrw)) forwarded
//! to ffmpeg over two localhost TCP connections, one per raw stream
//! (docs/slrw.md). Works the same on every OS: no fd passing, no named pipes.
//!
//! Threads: one reads SLRW and dispatches payloads into bounded queues; one
//! per stream accepts ffmpeg's connection and writes. When ffmpeg falls
//! behind, video frames are dropped (the game never blocks on us for
//! long); audio has a deep queue and is dropped only when it overflows.
//!
//! Timestamps: ffmpeg stamps video frames with their arrival time
//! (`-use_wallclock_as_timestamps 1`), so dropped or late frames leave real
//! gaps; audio is timed by its sample count. `pts_us` is used to log drift
//! between the game's clock and arrival time.
//!
//! Sources: docs/slrw.md; ffmpeg-protocols(1) (tcp), ffmpeg-formats(1)
//! (rawvideo, pcm demuxers).

use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::error::{Error, Result};
use crate::media::ffmpeg::{RawAudioInput, RawVideoInput, Source};
use crate::media::slrw::{Kind, SlrwReader};
use crate::opts::{RawAudioSpec, RawVideoSpec};

/// Video frames queued per connection before new ones are dropped.
const VIDEO_QUEUE: usize = 3;
/// Audio records queued (a few seconds at typical 10-20 ms records).
const AUDIO_QUEUE: usize = 512;
/// How long to wait for ffmpeg to connect.
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(20);
/// Drift between pts and arrival that is worth a log line.
const DRIFT_LOG: Duration = Duration::from_millis(100);

pub use crate::media::slrw::ENCODED_PIX_FMT;

/// Bytes per video frame for common raw pixel formats; `None` if unknown
/// (then sizes are not checked).
pub fn frame_size(pix_fmt: &str, w: u32, h: u32) -> Option<usize> {
    let (w, h) = (w as usize, h as usize);
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    Some(match pix_fmt {
        "gray" | "gray8" => w * h,
        "rgb24" | "bgr24" | "yuv444p" => w * h * 3,
        "rgba" | "bgra" | "argb" | "abgr" | "rgb0" | "bgr0" | "0rgb" | "0bgr" => w * h * 4,
        "rgb48le" | "rgb48be" => w * h * 6,
        "rgba64le" | "rgba64be" => w * h * 8,
        "yuyv422" | "uyvy422" => 2 * cw * h * 2,
        "yuv420p" | "nv12" | "nv21" => w * h + 2 * cw * ch,
        "yuv422p" => w * h + 2 * cw * h,
        _ => return None,
    })
}

/// Bytes per sample for raw PCM formats ffmpeg demuxes by name.
pub fn sample_size(fmt: &str) -> Option<usize> {
    Some(match fmt {
        "u8" | "s8" => 1,
        "s16le" | "s16be" | "u16le" | "u16be" => 2,
        "s24le" | "s24be" | "u24le" | "u24be" => 3,
        "s32le" | "s32be" | "u32le" | "u32be" | "f32le" | "f32be" => 4,
        "f64le" | "f64be" => 8,
        _ => return None,
    })
}

/// Bound listeners, before ffmpeg starts.
pub struct RawInput {
    video: RawVideoInput,
    audio: Option<RawAudioInput>,
    video_listener: TcpListener,
    audio_listener: Option<TcpListener>,
    frame_bytes: Option<usize>,
    sample_frame_bytes: Option<usize>,
}

fn bind_local() -> Result<(TcpListener, SocketAddr)> {
    let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| Error::io("bind raw input listener", e))?;
    let addr = l
        .local_addr()
        .map_err(|e| Error::io("raw input listener address", e))?;
    Ok((l, addr))
}

impl RawInput {
    /// Binds a localhost listener per stream. Video is required.
    pub fn bind(video: Option<&RawVideoSpec>, audio: Option<&RawAudioSpec>) -> Result<RawInput> {
        let v = video.ok_or_else(|| Error::usage("raw input needs --raw-video"))?;
        if v.pix_fmt == ENCODED_PIX_FMT {
            return Err(Error::usage(
                "encoded SLRW input (pixel format h264) does not go through ffmpeg",
            ));
        }
        let frame_bytes = frame_size(&v.pix_fmt, v.size.width, v.size.height);
        if frame_bytes.is_none() {
            warn!(
                "unknown pixel format {:?}: frame sizes are not checked",
                v.pix_fmt
            );
        }
        let (video_listener, vaddr) = bind_local()?;
        let (audio, audio_listener, sample_frame_bytes) = match audio {
            Some(a) => {
                let (l, addr) = bind_local()?;
                let bytes = sample_size(&a.sample_fmt).map(|s| s * a.channels as usize);
                if bytes.is_none() {
                    warn!(
                        "unknown sample format {:?}: sizes are not checked",
                        a.sample_fmt
                    );
                }
                (
                    Some(RawAudioInput {
                        sample_rate: a.sample_rate,
                        channels: a.channels,
                        sample_fmt: a.sample_fmt.clone(),
                        addr,
                    }),
                    Some(l),
                    bytes,
                )
            }
            None => (None, None, None),
        };
        Ok(RawInput {
            video: RawVideoInput {
                width: v.size.width,
                height: v.size.height,
                fps: v.fps,
                pix_fmt: v.pix_fmt.clone(),
                addr: vaddr,
            },
            audio,
            video_listener,
            audio_listener,
            frame_bytes,
            sample_frame_bytes,
        })
    }

    /// The ffmpeg input for these listeners.
    pub fn source(&self) -> Source {
        Source::Raw {
            video: Some(self.video.clone()),
            audio: self.audio.clone(),
        }
    }

    /// Starts forwarding `input` (SLRW). Call after spawning ffmpeg.
    pub fn start<R: Read + Send + 'static>(self, input: R) -> Result<Forwarder> {
        let (vtx, vrx) = mpsc::sync_channel::<Vec<u8>>(VIDEO_QUEUE);
        let video_writer = spawn_writer("rawin-video", self.video_listener, vrx)?;
        let (atx, audio_writer) = match self.audio_listener {
            Some(l) => {
                let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(AUDIO_QUEUE);
                (Some(tx), Some(spawn_writer("rawin-audio", l, rx)?))
            }
            None => (None, None),
        };
        let (done_tx, done_rx) = mpsc::channel();
        let limits = (self.frame_bytes.map_or(u32::MAX, |n| n as u32), u32::MAX);
        let checks = (self.frame_bytes, self.sample_frame_bytes);
        let reader = std::thread::Builder::new()
            .name("rawin-reader".into())
            .spawn(move || {
                let r = SlrwReader::new(input).with_limits(limits.0, limits.1);
                let mut stats = pump(r, checks, vtx, atx);
                let writers = [Some(video_writer), audio_writer];
                for w in writers.into_iter().flatten() {
                    match w.join() {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => {
                            if stats.is_ok() {
                                stats = Err(e);
                            }
                        }
                        Err(_) => stats = Err(Error::process("raw input writer panicked")),
                    }
                }
                let _ = done_tx.send(stats);
            })
            .map_err(|e| Error::io("spawn raw input reader", e))?;
        Ok(Forwarder {
            done: done_rx,
            _reader: reader,
        })
    }
}

/// Counters from a forwarding run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ForwardStats {
    pub video_frames: u64,
    pub video_dropped: u64,
    pub audio_records: u64,
    pub audio_dropped: u64,
    pub bytes: u64,
    /// Whether the stream ended with an `end` record (vs. EOF).
    pub clean_end: bool,
}

/// A running forwarder.
pub struct Forwarder {
    done: Receiver<Result<ForwardStats>>,
    _reader: JoinHandle<()>,
}

impl Forwarder {
    /// Waits briefly for the forwarder to finish (it finishes when stdin
    /// ends). If the game keeps stdin open after ffmpeg is gone, the
    /// reader thread is left behind; the process exits soon anyway.
    pub fn finish(self) -> Result<ForwardStats> {
        match self.done.recv_timeout(Duration::from_secs(2)) {
            Ok(r) => r,
            Err(_) => Err(Error::timeout("raw input still open")),
        }
    }

    /// Blocks until the input ends.
    pub fn wait(self) -> Result<ForwardStats> {
        self.done
            .recv()
            .unwrap_or_else(|_| Err(Error::process("raw input reader vanished")))
    }
}

fn spawn_writer(
    name: &str,
    listener: TcpListener,
    rx: Receiver<Vec<u8>>,
) -> Result<JoinHandle<Result<()>>> {
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let mut conn = accept(&listener, ACCEPT_TIMEOUT)?;
            drop(listener);
            for payload in rx {
                if let Err(e) = conn.write_all(&payload) {
                    return match e.kind() {
                        // ffmpeg closed its input: it is quitting.
                        io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset => {
                            debug!("ffmpeg closed raw input");
                            Ok(())
                        }
                        _ => Err(Error::io("write raw input to ffmpeg", e)),
                    };
                }
            }
            let _ = conn.shutdown(std::net::Shutdown::Write);
            Ok(())
        })
        .map_err(|e| Error::io("spawn raw input writer", e))
}

fn accept(listener: &TcpListener, timeout: Duration) -> Result<TcpStream> {
    listener
        .set_nonblocking(true)
        .map_err(|e| Error::io("raw input listener", e))?;
    let deadline = Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((s, peer)) => {
                debug!("ffmpeg connected to raw input from {peer}");
                s.set_nonblocking(false)
                    .and_then(|()| s.set_nodelay(true))
                    .map_err(|e| Error::io("raw input connection", e))?;
                return Ok(s);
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(Error::timeout("ffmpeg did not connect to the raw input"));
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(Error::io("accept raw input connection", e)),
        }
    }
}

fn pump<R: Read>(
    mut r: SlrwReader<R>,
    (frame_bytes, sample_frame_bytes): (Option<usize>, Option<usize>),
    vtx: SyncSender<Vec<u8>>,
    atx: Option<SyncSender<Vec<u8>>>,
) -> Result<ForwardStats> {
    let mut stats = ForwardStats::default();
    let start = Instant::now();
    // Smallest (arrival - pts) seen: the game's best-case delivery.
    let mut best_offset: Option<i128> = None;
    let mut drifting = false;
    loop {
        let p = match r.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                return Err(Error::malformed(e.to_string()));
            }
            Err(e) => return Err(Error::io("read raw input", e)),
        };
        stats.bytes += p.payload.len() as u64;
        match p.kind {
            Kind::End => {
                stats.clean_end = true;
                break;
            }
            Kind::Video => {
                if let Some(n) = frame_bytes {
                    if p.payload.len() != n {
                        return Err(Error::malformed(format!(
                            "slrw: video frame of {} bytes, expected {n}",
                            p.payload.len()
                        )));
                    }
                }
                let offset = start.elapsed().as_micros() as i128 - p.pts_us as i128;
                let best = *best_offset.get_or_insert(offset);
                if offset < best {
                    best_offset = Some(offset);
                }
                let late = offset - best_offset.unwrap_or(offset) > DRIFT_LOG.as_micros() as i128;
                if late != drifting {
                    drifting = late;
                    debug!(
                        "raw video arrival is {} ms behind its pts",
                        (offset - best_offset.unwrap_or(offset)) / 1000
                    );
                }
                stats.video_frames += 1;
                match vtx.try_send(p.payload) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => {
                        stats.video_dropped += 1;
                        trace!("raw video queue full; dropped a frame");
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        return Err(Error::closed("ffmpeg stopped reading raw video"));
                    }
                }
            }
            k if k.is_encoded() => {
                return Err(Error::malformed(format!(
                    "slrw: {k:?} record (encoded H.264) in raw mode; \
                     use --raw-video WxH@FPS:{ENCODED_PIX_FMT}"
                )));
            }
            _ => {
                let Some(atx) = &atx else {
                    // No --raw-audio: ignore audio records.
                    continue;
                };
                if let Some(n) = sample_frame_bytes {
                    if p.payload.len() % n != 0 {
                        return Err(Error::malformed(format!(
                            "slrw: audio record of {} bytes is not a whole number of samples",
                            p.payload.len()
                        )));
                    }
                }
                stats.audio_records += 1;
                match atx.try_send(p.payload) {
                    Ok(()) => {}
                    Err(TrySendError::Full(_)) => {
                        stats.audio_dropped += 1;
                        warn!("raw audio queue full; dropped audio");
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        return Err(Error::closed("ffmpeg stopped reading raw audio"));
                    }
                }
            }
        }
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::slrw;
    use crate::opts::Size;
    use crate::util::ratio::Ratio;

    fn specs() -> (RawVideoSpec, RawAudioSpec) {
        (
            RawVideoSpec {
                size: Size {
                    width: 64,
                    height: 48,
                },
                fps: Ratio::integer(30),
                pix_fmt: "rgba".into(),
            },
            RawAudioSpec {
                sample_rate: 48_000,
                channels: 2,
                sample_fmt: "s16le".into(),
            },
        )
    }

    fn slrw_stream(frames: usize, frame_len: usize) -> Vec<u8> {
        let mut s = Vec::new();
        slrw::write_magic(&mut s).unwrap();
        for i in 0..frames {
            let pts = i as u64 * 33_333;
            slrw::write_packet(&mut s, Kind::Video, pts, &vec![i as u8; frame_len]).unwrap();
            slrw::write_packet(&mut s, Kind::Audio, pts, &[1u8; 1600 * 4]).unwrap();
        }
        slrw::write_packet(&mut s, Kind::End, 0, &[]).unwrap();
        s
    }

    #[test]
    fn sizes() {
        assert_eq!(frame_size("rgba", 64, 48), Some(64 * 48 * 4));
        assert_eq!(frame_size("yuv420p", 5, 3), Some(15 + 2 * 3 * 2));
        assert_eq!(frame_size("weird", 5, 3), None);
        assert_eq!(sample_size("s16le"), Some(2));
        assert_eq!(sample_size("f32le"), Some(4));
    }

    /// Forwards to two plain TCP clients standing in for ffmpeg.
    #[test]
    fn forwards_to_tcp_clients() {
        let (v, a) = specs();
        let raw = RawInput::bind(Some(&v), Some(&a)).unwrap();
        let Source::Raw {
            video: Some(vi),
            audio: Some(ai),
        } = raw.source()
        else {
            panic!("expected raw source")
        };
        let input = slrw_stream(5, 64 * 48 * 4);
        let fw = raw.start(io::Cursor::new(input)).unwrap();
        let read_all = |addr: SocketAddr| {
            std::thread::spawn(move || {
                let mut s = TcpStream::connect(addr).unwrap();
                let mut buf = Vec::new();
                s.read_to_end(&mut buf).unwrap();
                buf
            })
        };
        let (vh, ah) = (read_all(vi.addr), read_all(ai.addr));
        let video = vh.join().unwrap();
        let audio = ah.join().unwrap();
        let stats = fw.wait().unwrap();
        assert!(stats.clean_end);
        assert_eq!(stats.video_frames, 5);
        assert_eq!(audio.len(), 5 * 1600 * 4);
        // Frames are forwarded whole and in order (some may be dropped).
        let n = 64 * 48 * 4;
        assert_eq!(video.len() % n, 0);
        assert_eq!(video.len() / n + stats.video_dropped as usize, 5);
        let firsts: Vec<u8> = video.chunks(n).map(|c| c[0]).collect();
        assert!(firsts.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn rejects_encoded_records_in_raw_mode() {
        let (v, _) = specs();
        let raw = RawInput::bind(Some(&v), None).unwrap();
        let Source::Raw {
            video: Some(vi), ..
        } = raw.source()
        else {
            panic!()
        };
        let mut s = Vec::new();
        slrw::write_magic(&mut s).unwrap();
        slrw::write_h264(&mut s, 0, true, false, &[0, 0, 0, 1, 0x65]).unwrap();
        let fw = raw.start(io::Cursor::new(s)).unwrap();
        let c = std::thread::spawn(move || {
            let mut s = TcpStream::connect(vi.addr).unwrap();
            let _ = s.read_to_end(&mut Vec::new());
        });
        let e = fw.wait().unwrap_err();
        assert!(e.to_string().contains(":h264"), "{e}");
        c.join().unwrap();
        let mut enc = v.clone();
        enc.pix_fmt = ENCODED_PIX_FMT.into();
        assert!(RawInput::bind(Some(&enc), None).is_err());
    }

    #[test]
    fn rejects_bad_frame_size() {
        let (v, _) = specs();
        let raw = RawInput::bind(Some(&v), None).unwrap();
        let Source::Raw {
            video: Some(vi), ..
        } = raw.source()
        else {
            panic!()
        };
        let fw = raw.start(io::Cursor::new(slrw_stream(2, 10))).unwrap();
        let c = std::thread::spawn(move || {
            let mut s = TcpStream::connect(vi.addr).unwrap();
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf);
        });
        assert!(fw.wait().is_err());
        c.join().unwrap();
    }

    /// The real thing: SLRW → ffmpeg → Matroska → MediaReader.
    #[test]
    fn ffmpeg_end_to_end() {
        use crate::media::ffmpeg::{self, Output, Process};
        use crate::media::source::MediaReader;
        use crate::types::{AudioFamily, TrackKind};
        let Some((bin, probe)) = ffmpeg::tests::real_ffmpeg() else {
            return;
        };
        let (v, a) = specs();
        let raw = RawInput::bind(Some(&v), Some(&a)).unwrap();
        let mut plan = ffmpeg::tests::plan();
        plan.video.width = 64;
        plan.video.height = 48;
        plan.video.bitrate_kbps = 200;
        let inv = ffmpeg::build(&raw.source(), Output::Encode(&plan), &probe, "error").unwrap();
        let mut proc = Process::spawn(&bin, &inv.args).unwrap();
        let stdout = proc.take_stdout().unwrap();
        // A paced writer: 30 frames at 30 fps plus matching audio.
        let (mut w, r) = pipe();
        let fw = raw.start(r).unwrap();
        let writer = std::thread::spawn(move || {
            slrw::write_magic(&mut w).unwrap();
            let start = Instant::now();
            for i in 0..30u64 {
                let pts = i * 1_000_000 / 30;
                let frame: Vec<u8> = (0..64 * 48 * 4).map(|j| (j as u64 + i * 7) as u8).collect();
                slrw::write_packet(&mut w, Kind::Video, pts, &frame).unwrap();
                slrw::write_packet(&mut w, Kind::Audio, pts, &[0u8; 1600 * 4]).unwrap();
                let due = start + Duration::from_micros(pts + 33_333);
                std::thread::sleep(due.saturating_duration_since(Instant::now()));
            }
            slrw::write_packet(&mut w, Kind::End, 0, &[]).unwrap();
        });
        let mut reader = MediaReader::new(stdout, &inv.tracks).unwrap();
        assert_eq!(reader.info().video.width, 64);
        let mut video = 0;
        let mut audio = 0;
        while let Some(f) = reader.next_frame().unwrap() {
            match f.frame.track {
                TrackKind::Video => video += 1,
                TrackKind::Audio(AudioFamily::Cast) => audio += 1,
                _ => {}
            }
        }
        proc.wait().unwrap();
        writer.join().unwrap();
        let stats = fw.wait().unwrap();
        assert!(stats.clean_end);
        assert_eq!((stats.video_frames, stats.audio_records), (30, 30));
        // ffmpeg stamps raw video with the time it reads it and the fps
        // filter resamples that to 30 fps: on an idle machine 30, give or
        // take a frame at the edges. Under load, a stall and then a burst
        // (or a slow ffmpeg start, while the forwarder drops frames)
        // squeezes the stamps together and the filter drops frames, so
        // only ask for half; never more than the second allows.
        assert!(
            (15..=35).contains(&video),
            "video frames: {video}, {stats:?}"
        );
        // 1 s of audio in 10 ms Opus packets.
        assert!((95..=101).contains(&audio), "opus packets: {audio}");
    }

    /// An in-memory pipe (writer → reader) for paced tests.
    fn pipe() -> (PipeWriter, PipeReader) {
        let (tx, rx) = mpsc::channel();
        (
            PipeWriter(tx),
            PipeReader {
                rx,
                buf: Vec::new(),
                pos: 0,
            },
        )
    }

    struct PipeWriter(mpsc::Sender<Vec<u8>>);

    impl Write for PipeWriter {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0
                .send(b.to_vec())
                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct PipeReader {
        rx: Receiver<Vec<u8>>,
        buf: Vec<u8>,
        pos: usize,
    }

    impl Read for PipeReader {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            if self.pos == self.buf.len() {
                match self.rx.recv() {
                    Ok(b) => {
                        self.buf = b;
                        self.pos = 0;
                    }
                    Err(_) => return Ok(0),
                }
            }
            let n = out.len().min(self.buf.len() - self.pos);
            out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }
}
