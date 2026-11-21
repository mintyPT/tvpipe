//! Cast Streaming RTP: frame ids, whole-frame AES-128-CTR, and
//! the Cast RTP packet format (packetizer and parser).
//!
//! Wire format (all big-endian):
//!
//! ```text
//! byte 0      0x80: V=2, no padding, no RTP extension, CC=0
//! byte 1      M (last packet of the frame) | 7-bit payload type
//! bytes 2-3   sequence number (per stream, +1 per packet sent, random start)
//! bytes 4-7   RTP timestamp (lower 32 bits)
//! bytes 8-11  sender SSRC
//! byte 12     K (key frame) | R (reference frame id present) | 6-bit count
//!             of Cast header extensions
//! byte 13     frame id (lower 8 bits)
//! bytes 14-15 packet id
//! bytes 16-17 max packet id (packet count - 1)
//! [byte 18]   reference frame id (lower 8 bits), if R
//! extensions  u16 (type << 10 | size) + size bytes each; type 1 = adaptive
//!             latency: u16 new playout delay in ms
//! payload     a slice of the encrypted frame
//! ```
//!
//! Frame ids are 64-bit counters locally ([`FrameId`]) and are truncated to
//! 8 bits on the wire; [`expand_le`] / [`expand_gt`] / [`expand_near`]
//! recover them.
//!
//! Sources: openscreen `cast/streaming/impl/{rtp_defines.h,
//! rtp_packetizer.cc, rtp_packet_parser.cc, frame_crypto.cc,
//! expanded_value_base.h}`; RFC 3550 §5.1.

use crate::crypto::aes::Aes;
use crate::crypto::modes::Ctr;
use crate::error::{Error, Result};
use crate::util::bytes::{Reader, Writer};

/// A full-width frame id. The first frame is 0; [`LEADER`] (-1)
/// is "before the first frame".
pub type FrameId = i64;

/// The frame id before the first frame.
pub const LEADER: FrameId = -1;

/// Largest RTP packet for IPv4 UDP on Ethernet (1500 - 20 - 8).
pub const MAX_PACKET_SIZE_IPV4: usize = 1500 - 20 - 8;
/// Largest RTP packet for IPv6 UDP on Ethernet (1500 - 40 - 8).
pub const MAX_PACKET_SIZE_IPV6: usize = 1500 - 40 - 8;
/// Smallest valid packet: RTP header + Cast header without optional fields.
pub const MIN_PACKET_SIZE: usize = 18;
/// Header we always write: the minimum plus the reference frame id byte.
pub const BASE_HEADER_SIZE: usize = MIN_PACKET_SIZE + 1;
/// The adaptive-latency extension (2 bytes type/size + 2 bytes value).
pub const ADAPTIVE_LATENCY_SIZE: usize = 4;
pub const MAX_HEADER_SIZE: usize = BASE_HEADER_SIZE + ADAPTIVE_LATENCY_SIZE;
/// Packet id meaning "all packets of the frame" in NACKs.
pub const ALL_PACKETS_LOST: u16 = 0xffff;
/// Largest usable packet id.
pub const MAX_PACKET_ID: u16 = ALL_PACKETS_LOST - 1;

const FIRST_BYTE: u8 = 0b1000_0000;
const MARKER: u8 = 0b1000_0000;
const PAYLOAD_TYPE_MASK: u8 = 0b0111_1111;
const KEY_FRAME: u8 = 0b1000_0000;
const HAS_REFERENCE: u8 = 0b0100_0000;
const EXTENSION_COUNT_MASK: u8 = 0b0011_1111;
const ADAPTIVE_LATENCY_TYPE: u16 = 1;
const EXTENSION_SIZE_BITS: u16 = 10;

/// RTP payload types (Cast assignments in the dynamic range).
pub mod payload_type {
    pub const AUDIO_OPUS: u8 = 96;
    pub const AUDIO_AAC: u8 = 97;
    pub const AUDIO_PCM16: u8 = 98;
    pub const AUDIO_VARIOUS: u8 = 99;
    pub const VIDEO_VP8: u8 = 100;
    pub const VIDEO_H264: u8 = 101;
    pub const VIDEO_VARIOUS: u8 = 102;
    pub const VIDEO_VP9: u8 = 103;
    pub const VIDEO_AV1: u8 = 104;
    /// Legacy Android TV receivers want 127 for any audio and 96 for any
    /// video ("android RTP hack").
    pub const AUDIO_ANDROID_HACK: u8 = 127;
    pub const VIDEO_ANDROID_HACK: u8 = 96;

    pub fn is_valid(pt: u8) -> bool {
        (AUDIO_OPUS..=VIDEO_AV1).contains(&pt) || pt == AUDIO_ANDROID_HACK
    }
}

/// The greatest value `<= max` whose low `bits` bits are `x`.
fn expand_bits(max: i64, x: u64, bits: u32) -> i64 {
    let span = 1i64 << bits;
    let mask = span - 1;
    let mut v = (max & !mask) | (x as i64 & mask);
    if v > max {
        v -= span;
    }
    v
}

/// The greatest frame id `<= max` with low byte `x`.
pub fn expand_le(max: FrameId, x: u8) -> FrameId {
    expand_bits(max, x as u64, 8)
}

/// The smallest frame id `> base` with low byte `x`.
pub fn expand_gt(base: FrameId, x: u8) -> FrameId {
    expand_bits(base + 256, x as u64, 8)
}

/// The frame id closest to `base` with low byte `x` (within ±127).
pub fn expand_near(base: FrameId, x: u8) -> FrameId {
    expand_bits(base + 127, x as u64, 8)
}

/// Expands a truncated 32-bit RTP timestamp near `base`.
pub fn expand_rtp_timestamp(base: i64, x: u32) -> i64 {
    expand_bits(base + (u32::MAX / 2) as i64, x as u64, 32)
}

/// Per-stream frame encryption: AES-128-CTR over the whole frame, starting
/// at counter block `aesIvMask XOR (frame_id as u32 BE at bytes 8..12)`.
#[derive(Clone)]
pub struct FrameCrypto {
    aes: Aes,
    iv_mask: [u8; 16],
}

impl std::fmt::Debug for FrameCrypto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FrameCrypto { .. }")
    }
}

impl FrameCrypto {
    pub fn new(key: &[u8; 16], iv_mask: &[u8; 16]) -> Result<FrameCrypto> {
        Ok(FrameCrypto {
            aes: Aes::new(key)?,
            iv_mask: *iv_mask,
        })
    }

    /// The initial counter block for `frame_id`.
    pub fn nonce(&self, frame_id: FrameId) -> [u8; 16] {
        let mut n = self.iv_mask;
        let id = (frame_id as u32).to_be_bytes();
        for (b, x) in n[8..12].iter_mut().zip(id) {
            *b ^= x;
        }
        n
    }

    /// Encrypts or decrypts `data` in place (CTR is symmetric).
    pub fn apply(&self, frame_id: FrameId, data: &mut [u8]) {
        Ctr::new(self.aes.clone(), &self.nonce(frame_id)).apply(data);
    }
}

/// An encrypted frame ready for packetization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutFrame {
    pub frame_id: FrameId,
    pub keyframe: bool,
    pub referenced_frame_id: FrameId,
    pub rtp_timestamp: u32,
    /// Announces a new playout delay with this frame; 0 for none.
    pub new_playout_delay_ms: u16,
    pub data: Vec<u8>,
}

/// Splits frames into Cast RTP packets for one stream.
#[derive(Debug, Clone)]
pub struct Packetizer {
    payload_type: u8,
    ssrc: u32,
    max_packet_size: usize,
    sequence: u16,
}

impl Packetizer {
    /// `first_sequence` is normally random.
    pub fn new(
        payload_type: u8,
        ssrc: u32,
        max_packet_size: usize,
        first_sequence: u16,
    ) -> Packetizer {
        assert!(max_packet_size > MAX_HEADER_SIZE, "packet size too small");
        Packetizer {
            payload_type: payload_type & PAYLOAD_TYPE_MASK,
            ssrc,
            max_packet_size,
            sequence: first_sequence,
        }
    }

    pub fn ssrc(&self) -> u32 {
        self.ssrc
    }

    pub fn max_payload_size(&self) -> usize {
        self.max_packet_size - MAX_HEADER_SIZE
    }

    /// Packets needed for a frame of `len` bytes (at least one); `None` if
    /// the frame is too large to packetize.
    pub fn packet_count(&self, len: usize) -> Option<u16> {
        let n = len.div_ceil(self.max_payload_size()).max(1);
        if n <= MAX_PACKET_ID as usize {
            Some(n as u16)
        } else {
            None
        }
    }

    /// Writes packet `packet_id` of `frame` into `out` (cleared first) and
    /// advances the sequence number. Every call, retransmissions included,
    /// uses a fresh sequence number.
    pub fn packet(&mut self, frame: &OutFrame, packet_id: u16, out: &mut Vec<u8>) -> Result<()> {
        let count = self
            .packet_count(frame.data.len())
            .ok_or_else(|| Error::unsupported("cast rtp: frame too large"))?;
        if packet_id >= count {
            return Err(Error::protocol(format!(
                "cast rtp: packet {packet_id} of a {count}-packet frame"
            )));
        }
        let last = packet_id == count - 1;
        let latency = packet_id == 0 && frame.new_playout_delay_ms > 0;
        let chunk = self.max_payload_size();
        let start = chunk * packet_id as usize;
        let end = if last {
            frame.data.len()
        } else {
            start + chunk
        };

        let mut w = Writer::with_capacity(MAX_HEADER_SIZE + end - start);
        w.u8(FIRST_BYTE)
            .u8(if last { MARKER } else { 0 } | self.payload_type)
            .u16_be(self.sequence)
            .u32_be(frame.rtp_timestamp)
            .u32_be(self.ssrc)
            .u8(if frame.keyframe { KEY_FRAME } else { 0 } | HAS_REFERENCE | latency as u8)
            .u8(frame.frame_id as u8)
            .u16_be(packet_id)
            .u16_be(count - 1)
            .u8(frame.referenced_frame_id as u8);
        if latency {
            w.u16_be((ADAPTIVE_LATENCY_TYPE << EXTENSION_SIZE_BITS) | 2)
                .u16_be(frame.new_playout_delay_ms);
        }
        w.bytes(&frame.data[start..end]);
        self.sequence = self.sequence.wrapping_add(1);
        out.clear();
        out.extend_from_slice(w.as_slice());
        Ok(())
    }
}

/// A parsed Cast RTP packet (receiver side; used by tests and the fake
/// receiver).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RtpPacket<'a> {
    pub payload_type: u8,
    pub marker: bool,
    pub sequence: u16,
    pub rtp_timestamp: u32,
    pub ssrc: u32,
    pub keyframe: bool,
    pub frame_id: u8,
    pub packet_id: u16,
    pub max_packet_id: u16,
    /// Low byte of the reference frame id, if present.
    pub referenced_frame_id: Option<u8>,
    pub new_playout_delay_ms: Option<u16>,
    pub payload: &'a [u8],
}

impl<'a> RtpPacket<'a> {
    pub fn parse(buf: &'a [u8]) -> Result<RtpPacket<'a>> {
        let mut r = Reader::new(buf, "cast rtp");
        if buf.len() < MIN_PACKET_SIZE {
            return Err(r.error("packet too short"));
        }
        if r.u8()? != FIRST_BYTE {
            return Err(r.error("bad RTP version/flags"));
        }
        let b1 = r.u8()?;
        let payload_type = b1 & PAYLOAD_TYPE_MASK;
        if !payload_type::is_valid(payload_type) {
            return Err(r.error("unknown payload type"));
        }
        let sequence = r.u16_be()?;
        let rtp_timestamp = r.u32_be()?;
        let ssrc = r.u32_be()?;
        let b12 = r.u8()?;
        let frame_id = r.u8()?;
        let packet_id = r.u16_be()?;
        let max_packet_id = r.u16_be()?;
        if max_packet_id == ALL_PACKETS_LOST || packet_id > max_packet_id {
            return Err(r.error("bad packet id"));
        }
        let referenced_frame_id = if b12 & HAS_REFERENCE != 0 {
            Some(r.u8()?)
        } else {
            None
        };
        let mut new_playout_delay_ms = None;
        for _ in 0..(b12 & EXTENSION_COUNT_MASK) {
            let ts = r.u16_be()?;
            let ty = ts >> EXTENSION_SIZE_BITS;
            let size = (ts & ((1 << EXTENSION_SIZE_BITS) - 1)) as usize;
            let mut ext = r.sub(size)?;
            if ty == ADAPTIVE_LATENCY_TYPE {
                if size != 2 {
                    return Err(r.error("bad adaptive latency extension"));
                }
                new_playout_delay_ms = Some(ext.u16_be()?);
            }
        }
        Ok(RtpPacket {
            payload_type,
            marker: b1 & MARKER != 0,
            sequence,
            rtp_timestamp,
            ssrc,
            keyframe: b12 & KEY_FRAME != 0,
            frame_id,
            packet_id,
            max_packet_id,
            referenced_frame_id,
            new_playout_delay_ms,
            payload: r.rest(),
        })
    }

    /// The full reference frame id, given this packet's expanded frame id.
    /// Without the field, key frames reference themselves and others their
    /// predecessor.
    pub fn referenced(&self, frame_id: FrameId) -> FrameId {
        match self.referenced_frame_id {
            Some(x) => expand_near(frame_id, x),
            None if self.keyframe => frame_id,
            None => frame_id - 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::vectors;

    #[test]
    fn frame_crypto_vectors() {
        for b in vectors::load("cast/frame_crypto.txt") {
            let key: [u8; 16] = b.hex("key").try_into().unwrap();
            let mask: [u8; 16] = b.hex("mask").try_into().unwrap();
            let c = FrameCrypto::new(&key, &mask).unwrap();
            let id: FrameId = b.parse("frame_id");
            assert_eq!(c.nonce(id).to_vec(), b.hex("nonce"), "{}", b.name());
            let mut data = b.hex("pt");
            c.apply(id, &mut data);
            assert_eq!(data, b.hex("ct"), "{}", b.name());
            c.apply(id, &mut data);
            assert_eq!(data, b.hex("pt"), "{}", b.name());
        }
    }

    #[test]
    fn frame_id_expansion() {
        // openscreen expanded_value_base.h example: 0x1fe from 0xfe with max 0x202.
        assert_eq!(expand_le(0x202, 0xfe), 0x1fe);
        assert_eq!(expand_le(42, 10), 10);
        assert_eq!(expand_le(0x22a, 0x0a), 0x20a);
        assert_eq!(expand_le(5, 5), 5);
        assert_eq!(expand_le(0, 0xff), -1);
        assert_eq!(expand_gt(10, 11), 11);
        assert_eq!(expand_gt(10, 10), 266);
        assert_eq!(expand_gt(250, 2), 258);
        assert_eq!(expand_near(300, 0x2c), 300);
        assert_eq!(expand_near(300, 0x20), 288);
        assert_eq!(expand_near(255, 1), 257);
        assert_eq!(expand_rtp_timestamp(0, 5), 5);
        assert_eq!(expand_rtp_timestamp(0xffff_fff0, 3), 0x1_0000_0003);
    }

    // Fixtures from openscreen rtp_packet_parser_unittest.cc.
    #[test]
    fn parses_key_frame_packet() {
        let input = [
            0x80,
            96,
            0xbe,
            0xef,
            9,
            8,
            7,
            6,
            1,
            2,
            3,
            4,
            0b1000_0000,
            5,
            0xa,
            0xb,
            0xa,
            0xc,
            0xf,
            0xe,
            0xd,
            0xc,
            0xb,
            0xa,
            0x9,
            0x8,
        ];
        let p = RtpPacket::parse(&input).unwrap();
        assert_eq!(p.payload_type, payload_type::AUDIO_OPUS);
        assert_eq!(p.sequence, 0xbeef);
        assert_eq!(p.rtp_timestamp, 0x09080706);
        assert_eq!(p.ssrc, 0x01020304);
        assert!(p.keyframe);
        assert_eq!(p.frame_id, 5);
        assert_eq!(p.packet_id, 0x0a0b);
        assert_eq!(p.max_packet_id, 0x0a0c);
        assert_eq!(p.referenced(5), 5);
        assert_eq!(p.new_playout_delay_ms, None);
        assert_eq!(p.payload, &input[18..]);
    }

    #[test]
    fn parses_reference_and_extensions() {
        let with_ref = [
            0x80,
            96,
            0xde,
            0xad,
            2,
            4,
            6,
            8,
            0,
            0,
            1,
            1,
            0b0100_0000,
            42,
            0,
            0xb,
            0,
            0xc,
            39,
            1,
            3,
            5,
        ];
        let p = RtpPacket::parse(&with_ref).unwrap();
        assert!(!p.keyframe);
        assert_eq!(p.referenced(42), 39);
        assert_eq!(p.payload, &[1, 3, 5]);

        let without_ref = [
            0x80, 96, 0xde, 0xad, 2, 4, 6, 8, 0, 0, 1, 1, 0, 42, 0, 0xb, 0, 0xc, 1, 3,
        ];
        let p = RtpPacket::parse(&without_ref).unwrap();
        assert_eq!(p.referenced(42), 41);
        assert_eq!(p.payload, &[1, 3]);

        let multi = [
            0x80,
            96,
            0xde,
            0xad,
            2,
            4,
            6,
            8,
            0,
            0,
            1,
            1,
            0b1100_0011,
            64,
            0,
            0xb,
            0,
            0xc,
            64,
            8,
            2,
            0,
            0,
            4,
            2,
            1,
            14,
            16,
            5,
            0,
            0,
            0,
            0,
            0,
            1,
            3,
            5,
        ];
        let p = RtpPacket::parse(&multi).unwrap();
        assert!(p.keyframe);
        assert_eq!(p.new_playout_delay_ms, Some(270));
        assert_eq!(p.payload, &[1, 3, 5]);
    }

    #[test]
    fn rejects_bad_packets() {
        let good = [
            0x80, 96, 0xbe, 0xef, 9, 8, 7, 6, 1, 2, 3, 4, 0x80, 5, 0, 1, 0, 2,
        ];
        assert!(RtpPacket::parse(&good).is_ok());
        assert!(RtpPacket::parse(&good[..17]).is_err());
        let mut bad = good;
        bad[0] = 0x90;
        assert!(RtpPacket::parse(&bad).is_err());
        let mut bad = good;
        bad[1] = 50;
        assert!(RtpPacket::parse(&bad).is_err());
        let mut bad = good;
        bad[15] = 3; // packet id > max
        assert!(RtpPacket::parse(&bad).is_err());
        let mut bad = good;
        bad[16] = 0xff;
        bad[17] = 0xff;
        assert!(RtpPacket::parse(&bad).is_err());
        let mut bad = good.to_vec();
        bad[12] = 0x81; // one extension, missing
        assert!(RtpPacket::parse(&bad).is_err());
        bad.extend_from_slice(&[4, 3, 0, 0, 0]); // adaptive latency of size 3
        assert!(RtpPacket::parse(&bad).is_err());
        // Never panics on arbitrary input.
        let mut x = 0x1234_5678u32;
        for len in 0..64 {
            let data: Vec<u8> = (0..len)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 17;
                    x ^= x << 5;
                    x as u8
                })
                .collect();
            let _ = RtpPacket::parse(&data);
        }
    }

    #[test]
    fn packetizes_byte_exact() {
        let frame = OutFrame {
            frame_id: 0x105,
            keyframe: true,
            referenced_frame_id: 0x105,
            rtp_timestamp: 0x11223344,
            new_playout_delay_ms: 400,
            data: (0..10).collect(),
        };
        // max payload = 30 - 23 = 7 bytes per packet -> 2 packets.
        let mut p = Packetizer::new(payload_type::VIDEO_H264, 0xa1b2c3d4, 30, 0xfffe);
        assert_eq!(p.packet_count(10), Some(2));
        assert_eq!(p.packet_count(0), Some(1));
        let mut out = Vec::new();
        p.packet(&frame, 0, &mut out).unwrap();
        assert_eq!(
            out,
            [
                0x80,
                101,
                0xff,
                0xfe,
                0x11,
                0x22,
                0x33,
                0x44,
                0xa1,
                0xb2,
                0xc3,
                0xd4,
                0b1100_0001,
                0x05,
                0,
                0,
                0,
                1,
                0x05,
                0x04,
                0x02,
                0x01,
                0x90,
                0,
                1,
                2,
                3,
                4,
                5,
                6
            ]
        );
        p.packet(&frame, 1, &mut out).unwrap();
        assert_eq!(
            out,
            [
                0x80,
                0x80 | 101,
                0xff,
                0xff,
                0x11,
                0x22,
                0x33,
                0x44,
                0xa1,
                0xb2,
                0xc3,
                0xd4,
                0b1100_0000,
                0x05,
                0,
                1,
                0,
                1,
                0x05,
                7,
                8,
                9
            ]
        );
        // Sequence wraps; a retransmission gets a new number.
        p.packet(&frame, 1, &mut out).unwrap();
        assert_eq!(&out[2..4], &[0, 0]);
        assert!(p.packet(&frame, 2, &mut out).is_err());
    }

    #[test]
    fn packetize_parse_roundtrip() {
        // Mirrors openscreen rtp_packetizer_unittest: a 48269-byte key frame
        // takes 34 packets and a 10000-byte delta frame 7, at 1472 bytes.
        let mut p = Packetizer::new(payload_type::AUDIO_OPUS, 77, MAX_PACKET_SIZE_IPV4, 9);
        assert_eq!(p.packet_count(48269), Some(34));
        assert_eq!(p.packet_count(10000), Some(7));
        let data: Vec<u8> = (0..10000u32).map(|i| i as u8).collect();
        let frame = OutFrame {
            frame_id: 3,
            keyframe: false,
            referenced_frame_id: 2,
            rtp_timestamp: 987,
            new_playout_delay_ms: 0,
            data: data.clone(),
        };
        let mut joined = Vec::new();
        let mut out = Vec::new();
        for id in 0..7 {
            p.packet(&frame, id, &mut out).unwrap();
            assert!(out.len() <= MAX_PACKET_SIZE_IPV4);
            let pkt = RtpPacket::parse(&out).unwrap();
            assert_eq!(pkt.sequence, 9 + id);
            assert_eq!(pkt.packet_id, id);
            assert_eq!(pkt.max_packet_id, 6);
            assert_eq!(pkt.marker, id == 6);
            assert_eq!(pkt.referenced(3), 2);
            assert_eq!(pkt.new_playout_delay_ms, None);
            joined.extend_from_slice(pkt.payload);
        }
        assert_eq!(joined, data);
    }
}
