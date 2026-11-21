//! SLRW: the framing a game writes to `tvpipe play ... -` (docs/slrw.md).
//!
//! ```text
//! "SLRW"                                   magic, once
//! repeated:
//!   u8   kind     1 = video, 2 = audio, 0 = end of stream
//!   u64  pts_us   presentation time in microseconds (little-endian)
//!   u32  len      payload length in bytes (little-endian)
//!   [len] payload one raw video frame, or interleaved PCM samples
//! ```
//!
//! An `end` record has `len = 0`. Multi-byte fields are little-endian
//! (docs/slrw.md).
//!
//! Encoded mode (`--raw-video WxH@FPS:h264`, docs/slrw.md)
//! adds three kinds:
//!
//! ```text
//!   3 = h264         u8 flags (0x01 keyframe, 0x02 Annex B) | access unit
//!   4 = h264-config  u8 format (0 avcC, 1 Annex B SPS+PPS) | data
//!   5 = control      u32 flags (0x01 keyframe requests on stdout)
//! ```
//!
//! This file has no dependencies on the rest of the crate so the example
//! generator (`examples/slrw-gen.rs`) can include it with `#[path]`.

#![allow(dead_code)]

use std::io::{self, Read, Write};

/// The `--raw-video` pixel format that selects encoded H.264 input
/// (docs/slrw.md); handled by `media::input`, not
/// here.
pub const ENCODED_PIX_FMT: &str = "h264";

/// The four bytes a stream starts with.
pub const MAGIC: &[u8; 4] = b"SLRW";
/// Largest payload accepted (an 8K RGBA frame is 133 MB).
pub const MAX_PAYLOAD: u32 = 256 << 20;
/// Largest encoded access unit.
pub const MAX_H264_PAYLOAD: u32 = 64 << 20;
/// Largest decoder configuration.
pub const MAX_CONFIG_PAYLOAD: u32 = 1 << 20;

/// `h264` flag: an IDR picture.
pub const H264_KEYFRAME: u8 = 0x01;
/// `h264` flag: start codes (else 4-byte lengths).
pub const H264_ANNEX_B: u8 = 0x02;
/// `h264-config` format: an `avcC` record.
pub const CONFIG_AVCC: u8 = 0;
/// `h264-config` format: Annex B SPS and PPS.
pub const CONFIG_ANNEX_B: u8 = 1;
/// `control` flags.
pub const CONTROL_KEYFRAME_REQUESTS: u32 = 0x01;
/// The line written to stdout for a keyframe request.
pub const KEYFRAME_REQUEST_LINE: &[u8] = b"keyframe\n";

/// A record's kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Kind {
    /// The end of the stream.
    End,
    /// One raw frame.
    Video,
    /// Interleaved PCM.
    Audio,
    /// Encoded H.264 access unit.
    H264,
    /// avcC or Annex B parameter sets.
    H264Config,
    /// Feature flags from the game.
    Control,
}

impl Kind {
    /// The byte on the wire.
    pub fn code(self) -> u8 {
        match self {
            Kind::End => 0,
            Kind::Video => 1,
            Kind::Audio => 2,
            Kind::H264 => 3,
            Kind::H264Config => 4,
            Kind::Control => 5,
        }
    }

    /// The kind of a byte on the wire.
    pub fn from_code(c: u8) -> Option<Kind> {
        Some(match c {
            0 => Kind::End,
            1 => Kind::Video,
            2 => Kind::Audio,
            3 => Kind::H264,
            4 => Kind::H264Config,
            5 => Kind::Control,
            _ => return None,
        })
    }

    /// Whether this kind belongs to encoded mode.
    pub fn is_encoded(self) -> bool {
        matches!(self, Kind::H264 | Kind::H264Config | Kind::Control)
    }
}

/// Writes an `h264` record.
pub fn write_h264(
    w: &mut impl Write,
    pts_us: u64,
    keyframe: bool,
    annex_b: bool,
    au: &[u8],
) -> io::Result<()> {
    let flags = if keyframe { H264_KEYFRAME } else { 0 } | if annex_b { H264_ANNEX_B } else { 0 };
    let mut payload = Vec::with_capacity(au.len() + 1);
    payload.push(flags);
    payload.extend_from_slice(au);
    write_packet(w, Kind::H264, pts_us, &payload)
}

/// Writes an `h264-config` record.
pub fn write_h264_config(w: &mut impl Write, format: u8, data: &[u8]) -> io::Result<()> {
    let mut payload = Vec::with_capacity(data.len() + 1);
    payload.push(format);
    payload.extend_from_slice(data);
    write_packet(w, Kind::H264Config, 0, &payload)
}

/// Writes a `control` record.
pub fn write_control(w: &mut impl Write, flags: u32) -> io::Result<()> {
    write_packet(w, Kind::Control, 0, &flags.to_le_bytes())
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// One record.
pub struct Packet {
    /// The record's kind.
    pub kind: Kind,
    /// Its time in microseconds.
    pub pts_us: u64,
    /// Its payload.
    pub payload: Vec<u8>,
}

fn invalid(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, format!("slrw: {msg}"))
}

/// Writes the magic.
pub fn write_magic(w: &mut impl Write) -> io::Result<()> {
    w.write_all(MAGIC)
}

/// Writes one record.
pub fn write_packet(w: &mut impl Write, kind: Kind, pts_us: u64, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len())
        .ok()
        .filter(|&l| l <= MAX_PAYLOAD)
        .ok_or_else(|| invalid("payload too large".into()))?;
    let mut head = [0u8; 13];
    head[0] = kind.code();
    head[1..9].copy_from_slice(&pts_us.to_le_bytes());
    head[9..13].copy_from_slice(&len.to_le_bytes());
    w.write_all(&head)?;
    w.write_all(payload)
}

/// Reads SLRW records from a stream.
pub struct SlrwReader<R> {
    inner: R,
    started: bool,
    done: bool,
    /// Per-kind payload limits (video, audio).
    max_video: u32,
    max_audio: u32,
}

impl<R: Read> SlrwReader<R> {
    /// A reader of `inner` (which starts with the magic).
    pub fn new(inner: R) -> SlrwReader<R> {
        SlrwReader {
            inner,
            started: false,
            done: false,
            max_video: MAX_PAYLOAD,
            max_audio: MAX_PAYLOAD,
        }
    }

    /// Refuses larger video and audio payloads.
    pub fn with_limits(mut self, max_video: u32, max_audio: u32) -> SlrwReader<R> {
        self.max_video = max_video.min(MAX_PAYLOAD);
        self.max_audio = max_audio.min(MAX_PAYLOAD);
        self
    }

    /// Fills `buf`; `Ok(false)` if the stream ended before the first byte.
    fn fill(&mut self, buf: &mut [u8]) -> io::Result<bool> {
        let mut got = 0;
        while got < buf.len() {
            match self.inner.read(&mut buf[got..]) {
                Ok(0) if got == 0 => return Ok(false),
                Ok(0) => return Err(invalid("truncated record".into())),
                Ok(n) => got += n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(true)
    }

    /// The next record. `None` after an `end` record or at EOF on a record
    /// boundary; the `end` record itself is returned once.
    pub fn next_packet(&mut self) -> io::Result<Option<Packet>> {
        if self.done {
            return Ok(None);
        }
        if !self.started {
            let mut magic = [0u8; 4];
            if !self.fill(&mut magic)? {
                self.done = true;
                return Ok(None);
            }
            if &magic != MAGIC {
                return Err(invalid("missing SLRW magic".into()));
            }
            self.started = true;
        }
        let mut head = [0u8; 13];
        if !self.fill(&mut head)? {
            self.done = true;
            return Ok(None);
        }
        let kind = Kind::from_code(head[0])
            .ok_or_else(|| invalid(format!("unknown record kind {}", head[0])))?;
        let mut pts = [0u8; 8];
        pts.copy_from_slice(&head[1..9]);
        let mut len = [0u8; 4];
        len.copy_from_slice(&head[9..13]);
        let (pts_us, len) = (u64::from_le_bytes(pts), u32::from_le_bytes(len));
        let max = match kind {
            Kind::End => 0,
            Kind::Video => self.max_video,
            Kind::Audio => self.max_audio,
            Kind::H264 => MAX_H264_PAYLOAD,
            Kind::H264Config => MAX_CONFIG_PAYLOAD,
            Kind::Control => 4,
        };
        let min = match kind {
            Kind::H264 | Kind::H264Config => 1,
            Kind::Control => 4,
            _ => 0,
        };
        if len < min {
            return Err(invalid(format!(
                "{kind:?} record of {len} bytes is too short"
            )));
        }
        if len > max {
            return Err(invalid(format!(
                "{kind:?} record of {len} bytes exceeds {max}"
            )));
        }
        let mut payload = vec![0u8; len as usize];
        if len > 0 && !self.fill(&mut payload)? {
            return Err(invalid("truncated record".into()));
        }
        if kind == Kind::End {
            self.done = true;
        }
        Ok(Some(Packet {
            kind,
            pts_us,
            payload,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_bytes() {
        let mut out = Vec::new();
        write_magic(&mut out).unwrap();
        write_packet(&mut out, Kind::Video, 0x0102, b"ab").unwrap();
        write_packet(&mut out, Kind::End, 7, b"").unwrap();
        assert_eq!(
            out,
            [
                b'S', b'L', b'R', b'W', // magic
                1, 2, 1, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, b'a', b'b', // video
                0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // end
            ]
        );
        let mut r = SlrwReader::new(&out[..]);
        let p = r.next_packet().unwrap().unwrap();
        assert_eq!(
            (p.kind, p.pts_us, p.payload.as_slice()),
            (Kind::Video, 0x102, &b"ab"[..])
        );
        assert_eq!(r.next_packet().unwrap().unwrap().kind, Kind::End);
        assert_eq!(r.next_packet().unwrap(), None);
    }

    #[test]
    fn encoded_kinds() {
        let mut out = Vec::new();
        write_magic(&mut out).unwrap();
        write_control(&mut out, CONTROL_KEYFRAME_REQUESTS).unwrap();
        write_h264_config(&mut out, CONFIG_AVCC, &[1, 2]).unwrap();
        write_h264(&mut out, 0x10, true, true, &[0, 0, 1, 0x65]).unwrap();
        assert_eq!(
            &out[4..],
            [
                5, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0, // control
                4, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 2, // config
                3, 0x10, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 3, 0, 0, 1, 0x65, // h264
            ]
        );
        let mut r = SlrwReader::new(&out[..]);
        let kinds: Vec<Kind> = std::iter::from_fn(|| r.next_packet().unwrap())
            .map(|p| p.kind)
            .collect();
        assert_eq!(kinds, [Kind::Control, Kind::H264Config, Kind::H264]);
        assert!(Kind::H264.is_encoded() && !Kind::Video.is_encoded());
        // Wrong sizes.
        let mut bad = b"SLRW\x05".to_vec();
        bad.extend([0; 8]);
        bad.extend(3u32.to_le_bytes());
        bad.extend([0; 3]);
        assert!(SlrwReader::new(&bad[..]).next_packet().is_err());
        let mut empty = b"SLRW\x03".to_vec();
        empty.extend([0; 12]);
        assert!(SlrwReader::new(&empty[..]).next_packet().is_err());
    }

    #[test]
    fn errors() {
        assert!(SlrwReader::new(&b"XXXX"[..]).next_packet().is_err());
        assert_eq!(SlrwReader::new(&b""[..]).next_packet().unwrap(), None);
        // EOF on a record boundary is a clean end.
        assert_eq!(SlrwReader::new(&b"SLRW"[..]).next_packet().unwrap(), None);
        // Truncated header / payload.
        assert!(SlrwReader::new(&b"SLRW\x01\0\0"[..]).next_packet().is_err());
        let mut short = b"SLRW\x02".to_vec();
        short.extend([0; 8]);
        short.extend(9u32.to_le_bytes());
        short.extend(b"abc");
        assert!(SlrwReader::new(&short[..]).next_packet().is_err());
        // Unknown kind; oversized payload.
        let mut bad = b"SLRW\x07".to_vec();
        bad.extend([0; 12]);
        assert!(SlrwReader::new(&bad[..]).next_packet().is_err());
        let mut big = b"SLRW\x01".to_vec();
        big.extend([0; 8]);
        big.extend(100u32.to_le_bytes());
        assert!(SlrwReader::new(&big[..])
            .with_limits(99, 99)
            .next_packet()
            .is_err());
    }
}
