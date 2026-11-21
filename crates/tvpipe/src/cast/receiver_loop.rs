//! Opt-in loop against a real receiver (openscreen's `cast_receiver`, or
//! hardware): streams ffmpeg-generated H.264 (and Opus) through
//! [`StreamingSink`]. See `scripts/receivers/cast-receiver.sh`.
//!
//! ```sh
//! TVPIPE_CAST_ADDR=127.0.0.1:8010 TVPIPE_CAST_SECS=10 \
//!     cargo test cast::receiver_loop -- --ignored --nocapture
//! ```
//!
//! `TVPIPE_CAST_LOSS=0.02` puts a relay in the media path that drops
//! 2% of the packets in each direction; `TVPIPE_CAST_AUDIO=0` sends
//! video only.
//!
//! The ffmpeg output is parsed here with a small parser of its own: Annex B H.264 with access unit delimiters, and Ogg Opus.

use std::net::{SocketAddr, UdpSocket};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::sink::{connect, CastOptions};
use crate::types::{
    AudioCodec, AudioFamily, AudioInfo, EncodedFrame, Sink, SinkStatus, TrackKind, VideoCodec,
    VideoInfo,
};
use crate::util::ratio::Ratio;

fn ffmpeg() -> String {
    std::env::var("TVPIPE_FFMPEG").unwrap_or_else(|_| {
        if std::path::Path::new("/opt/homebrew/bin/ffmpeg").exists() {
            "/opt/homebrew/bin/ffmpeg".into()
        } else {
            "ffmpeg".into()
        }
    })
}

/// Splits an Annex B stream into NAL units.
fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (k, &s) in starts.iter().enumerate() {
        let mut end = starts.get(k + 1).map_or(data.len(), |&n| n - 3);
        while end > s && data[end - 1] == 0 {
            end -= 1;
        }
        if end > s {
            out.push(&data[s..end]);
        }
    }
    out
}

/// `(avcC, [(keyframe, AVCC access unit)])` from an Annex B stream with
/// access unit delimiters.
pub fn h264_frames(annexb: &[u8]) -> (Vec<u8>, Vec<(bool, Vec<u8>)>) {
    let mut sps = None;
    let mut pps = None;
    let mut frames = Vec::new();
    let mut cur: Vec<u8> = Vec::new();
    let mut key = false;
    for nal in nal_units(annexb) {
        match nal[0] & 0x1f {
            9 => {
                if !cur.is_empty() {
                    frames.push((key, std::mem::take(&mut cur)));
                }
                key = false;
                continue;
            }
            7 => {
                sps.get_or_insert_with(|| nal.to_vec());
                continue;
            }
            8 => {
                pps.get_or_insert_with(|| nal.to_vec());
                continue;
            }
            5 => key = true,
            _ => {}
        }
        cur.extend_from_slice(&(nal.len() as u32).to_be_bytes());
        cur.extend_from_slice(nal);
    }
    if !cur.is_empty() {
        frames.push((key, cur));
    }
    let sps = sps.expect("no SPS");
    let pps = pps.expect("no PPS");
    let mut avcc = vec![1, sps[1], sps[2], sps[3], 0xff, 0xe1];
    avcc.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(&sps);
    avcc.push(1);
    avcc.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(&pps);
    (avcc, frames)
}

/// Opus packets from an Ogg stream (skipping the two header packets).
pub fn ogg_opus_packets(data: &[u8]) -> Vec<Vec<u8>> {
    let mut packets = Vec::new();
    let mut cur = Vec::new();
    let mut pos = 0;
    while pos + 27 <= data.len() && &data[pos..pos + 4] == b"OggS" {
        let nseg = data[pos + 26] as usize;
        let segs = &data[pos + 27..pos + 27 + nseg];
        let mut body = pos + 27 + nseg;
        for &len in segs {
            cur.extend_from_slice(&data[body..body + len as usize]);
            body += len as usize;
            if len < 255 {
                packets.push(std::mem::take(&mut cur));
            }
        }
        pos = body;
    }
    packets.into_iter().skip(2).collect()
}

/// Raw AAC access units from an ADTS stream.
pub fn adts_units(data: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut pos = 0;
    while pos + 7 <= data.len() && data[pos] == 0xff && data[pos + 1] & 0xf0 == 0xf0 {
        let len = (((data[pos + 3] & 3) as usize) << 11)
            | ((data[pos + 4] as usize) << 3)
            | (data[pos + 5] as usize >> 5);
        let header = if data[pos + 1] & 1 == 1 { 7 } else { 9 };
        if len < header || pos + len > data.len() {
            break;
        }
        out.push(data[pos + header..pos + len].to_vec());
        pos += len;
    }
    out
}

struct Generated {
    h264: Vec<u8>,
    opus: Vec<u8>,
    adts: Vec<u8>,
    /// 48 kHz stereo s16le.
    pcm: Vec<u8>,
}

fn generate(secs: u64, size: &str) -> Generated {
    let dir = std::env::temp_dir().join(format!("tvpipe-cast-loop-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let h264 = dir.join("v.h264");
    let opus = dir.join("a.opus");
    let aac = dir.join("a.aac");
    let pcm = dir.join("a.pcm");
    let t = secs.to_string();
    let status = Command::new(ffmpeg())
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args([
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc2=size={size}:rate=30"),
        ])
        .args(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"])
        .args(["-t", &t, "-map", "0:v"])
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
        ])
        .args([
            "-profile:v",
            "high",
            "-pix_fmt",
            "yuv420p",
            "-bf",
            "0",
            "-g",
            "30",
        ])
        .args(["-b:v", "4M", "-x264-params", "aud=1", "-f", "h264"])
        .arg(&h264)
        .args(["-t", &t, "-map", "1:a", "-ac", "2"])
        .args(["-c:a", "libopus", "-b:a", "128k", "-frame_duration", "20"])
        .args(["-application", "lowdelay", "-f", "ogg"])
        .arg(&opus)
        .args([
            "-t", &t, "-map", "1:a", "-ac", "2", "-c:a", "aac", "-b:a", "128k",
        ])
        .args(["-f", "adts"])
        .arg(&aac)
        .args(["-t", &t, "-map", "1:a", "-ac", "2", "-f", "s16le"])
        .arg(&pcm)
        .status()
        .expect("run ffmpeg");
    assert!(status.success(), "ffmpeg failed");
    let read = |p| std::fs::read(p).unwrap();
    let out = Generated {
        h264: read(&h264),
        opus: read(&opus),
        adts: read(&aac),
        pcm: read(&pcm),
    };
    let _ = std::fs::remove_dir_all(&dir);
    out
}

#[test]
fn parses_generated_streams() {
    if Command::new(ffmpeg()).arg("-version").output().is_err() {
        eprintln!("ffmpeg not found; skipping");
        return;
    }
    let g = generate(1, "320x240");
    let (avcc, frames) = h264_frames(&g.h264);
    assert_eq!(frames.len(), 30);
    assert!(frames[0].0);
    assert_eq!(frames.iter().filter(|f| f.0).count(), 1);
    assert!(super::annexb::AvcConfig::parse(&avcc).is_ok());
    let packets = ogg_opus_packets(&g.opus);
    assert!((49..=52).contains(&packets.len()), "{}", packets.len());
    let units = adts_units(&g.adts);
    assert!((46..=49).contains(&units.len()), "{}", units.len());
    assert_eq!(g.pcm.len(), 48_000 * 4);
}

/// A UDP relay that drops `loss` of the packets in each direction.
/// Returns its address for the sender and a stop flag.
fn lossy_relay(receiver: SocketAddr, loss: f64) -> (SocketAddr, Arc<AtomicBool>) {
    let front = UdpSocket::bind("127.0.0.1:0").unwrap();
    let back = UdpSocket::bind("127.0.0.1:0").unwrap();
    back.connect(receiver).unwrap();
    let addr = front.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let sender: Arc<std::sync::Mutex<Option<SocketAddr>>> = Default::default();
    let pump = |from: UdpSocket, to: UdpSocket, forward: bool, seed: u32| {
        let stop = stop.clone();
        let sender = sender.clone();
        std::thread::spawn(move || {
            from.set_read_timeout(Some(Duration::from_millis(50)))
                .unwrap();
            let mut buf = vec![0u8; 2048];
            let mut x = seed;
            let (mut passed, mut dropped) = (0u64, 0u64);
            while !stop.load(Ordering::Acquire) {
                let Ok((n, src)) = from.recv_from(&mut buf) else {
                    continue;
                };
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                if (x as f64 / u32::MAX as f64) < loss {
                    dropped += 1;
                    continue;
                }
                passed += 1;
                if forward {
                    *sender.lock().unwrap() = Some(src);
                    let _ = to.send(&buf[..n]);
                } else if let Some(s) = *sender.lock().unwrap() {
                    let _ = to.send_to(&buf[..n], s);
                }
            }
            let dir = if forward {
                "sender->receiver"
            } else {
                "receiver->sender"
            };
            eprintln!("relay {dir}: passed {passed}, dropped {dropped}");
        });
    };
    pump(
        front.try_clone().unwrap(),
        back.try_clone().unwrap(),
        true,
        0x1234_5678,
    );
    pump(back, front, false, 0x8765_4321);
    (addr, stop)
}

#[test]
#[ignore = "needs a Cast receiver (scripts/receivers/cast-receiver.sh)"]
fn openscreen_receiver_loop() {
    let addr: SocketAddr = std::env::var("TVPIPE_CAST_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8010".into())
        .parse()
        .unwrap();
    let secs: u64 = std::env::var("TVPIPE_CAST_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);
    let audio = std::env::var("TVPIPE_CAST_AUDIO").map_or(true, |v| v != "0");
    // opus (ffmpeg, 20 ms), aac (ffmpeg, raw units) or aacenc (ours).
    let acodec = std::env::var("TVPIPE_CAST_ACODEC").unwrap_or_else(|_| "opus".into());
    let latency_ms: u32 = std::env::var("TVPIPE_CAST_LATENCY")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(400);
    let loss: f64 = std::env::var("TVPIPE_CAST_LOSS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    crate::log::to_stderr(crate::log::Level::Debug);
    let g = generate(secs, "1280x720");
    let (avcc, vframes) = h264_frames(&g.h264);
    let (codec, frame_samples, apackets) = match acodec.as_str() {
        "opus" => (AudioCodec::Opus, 960, ogg_opus_packets(&g.opus)),
        "aac" => (AudioCodec::AacLc, 1024, adts_units(&g.adts)),
        "aacenc" => {
            let mut enc = crate::media::aacenc::Encoder::new(48_000, 2, 128_000).unwrap();
            let pcm: Vec<i16> = g
                .pcm
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect();
            let units = pcm
                .chunks_exact(2048)
                .map(|c| enc.encode(c).unwrap())
                .collect();
            (AudioCodec::AacLc, 1024, units)
        }
        other => panic!("unknown TVPIPE_CAST_ACODEC {other}"),
    };

    let opts = CastOptions {
        latency_ms,
        // TVPIPE_CAST_OFFER=both offers Opus and AAC (the receiver picks).
        audio_codecs: if std::env::var("TVPIPE_CAST_OFFER").is_ok_and(|v| v == "both") {
            vec![AudioCodec::Opus, AudioCodec::AacLc]
        } else {
            vec![codec]
        },
        max_width: 1280,
        max_height: 720,
        max_fps: Ratio::new(30, 1),
        max_bitrate_kbps: 5000,
        audio,
        ..CastOptions::default()
    };
    let mut relay_stop = None;
    let mut opts = opts;
    if loss > 0.0 {
        // The ANSWER's port is only known after connect, so the relay
        // targets the receiver's default Cast Streaming port.
        let port = std::env::var("TVPIPE_CAST_UDP_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(2344);
        let (relay, stop) = lossy_relay(SocketAddr::new(addr.ip(), port), loss);
        opts.media_relay = Some(relay);
        relay_stop = Some(stop);
    }
    let mut sink = connect(addr, "cast-receiver", &opts).expect("connect");
    eprintln!("capabilities: {:?}", sink.capabilities());
    sink.start(
        &VideoInfo {
            codec: VideoCodec::H264,
            width: 1280,
            height: 720,
            fps: Ratio::new(30, 1),
            avcc,
        },
        audio
            .then(|| AudioInfo {
                codec,
                sample_rate: 48_000,
                channels: 2,
                frame_samples,
                config: if codec == AudioCodec::AacLc {
                    vec![0x11, 0x90]
                } else {
                    Vec::new()
                },
            })
            .as_ref(),
    )
    .expect("start");

    // TVPIPE_CAST_EARLY=0: audio frames never leave before their time.
    let early: u64 = std::env::var("TVPIPE_CAST_EARLY")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let start = Instant::now();
    let mut ai = 0usize;
    let mut dropped = 0;
    for (i, (key, data)) in vframes.into_iter().enumerate() {
        let due = start + Duration::from_micros(i as u64 * 33_333);
        std::thread::sleep(due.saturating_duration_since(Instant::now()));
        let st = sink
            .push(&EncodedFrame {
                track: TrackKind::Video,
                pts: i as u64 * 3000,
                keyframe: key,
                data: Arc::from(data),
            })
            .unwrap();
        match st {
            SinkStatus::Finished => panic!("receiver ended the session"),
            SinkStatus::Dropped => dropped += 1,
            SinkStatus::Accepted => {}
        }
        while audio
            && ai < apackets.len()
            && (ai as u64 * frame_samples as u64) * 1000 / 48 <= (i as u64 + early) * 33_333
        {
            sink.push(&EncodedFrame {
                track: TrackKind::Audio(AudioFamily::Cast),
                pts: ai as u64 * frame_samples as u64,
                keyframe: true,
                data: Arc::from(apackets[ai].clone()),
            })
            .unwrap();
            ai += 1;
        }
    }
    std::thread::sleep(Duration::from_millis(500));
    eprintln!("stats: {:?}, dropped video {dropped}", sink.stats());
    sink.stop().unwrap();
    if let Some(stop) = relay_stop {
        stop.store(true, Ordering::Release);
        std::thread::sleep(Duration::from_millis(100));
    }
}
