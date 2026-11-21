//! Cast Streaming RTCP: Sender Reports we send, and the
//! receiver's compound packets we parse (Receiver Report, Receiver
//! Reference Time XR, Cast feedback with NACKs and CST2 frame ACKs, PLI,
//! receiver frame logs). The receiver-side builders exist for the fake
//! receiver and tests.
//!
//! Common header: `V=2 P=0 RC/subtype(5) | PT | length in words - 1`.
//!
//! Cast feedback (PT 206, subtype 15):
//!
//! ```text
//! receiver SSRC | sender SSRC | "CAST"
//! checkpoint frame id (8 bits) | # loss fields | playout delay ms (16)
//! loss fields: frame id (8) | packet id (16) | bit vector of the next 8
//!              packets (packet id 0xffff = whole frame)
//! optional:    "CST2" | feedback count | # ack octets | ack bit vector
//!              (bit 0 = checkpoint + 2)
//! ```
//!
//! Sources: openscreen `cast/streaming/impl/{rtp_defines.h,rtcp_common.cc,
//! compound_rtcp_parser.cc,compound_rtcp_builder.cc,
//! sender_report_builder.cc,sender_report_parser.cc}` and their unit tests;
//! RFC 3550 §6.4, RFC 3611 §4.4, RFC 4585 §6.3.1.

use super::rtp::{expand_gt, expand_le, FrameId, ALL_PACKETS_LOST};
use crate::error::Result;
use crate::util::bytes::{Reader, Writer};

pub const PT_SENDER_REPORT: u8 = 200;
pub const PT_RECEIVER_REPORT: u8 = 201;
pub const PT_SOURCE_DESCRIPTION: u8 = 202;
pub const PT_APPLICATION_DEFINED: u8 = 204;
pub const PT_PAYLOAD_SPECIFIC: u8 = 206;
pub const PT_EXTENDED_REPORTS: u8 = 207;

pub const SUBTYPE_PLI: u8 = 1;
pub const SUBTYPE_RECEIVER_LOG: u8 = 2;
pub const SUBTYPE_FEEDBACK: u8 = 15;

const CAST: u32 = u32::from_be_bytes(*b"CAST");
const CST2: u32 = u32::from_be_bytes(*b"CST2");
const TIME: u32 = u32::from_be_bytes(*b"TIME");
const XR_RRTR: u8 = 4;
const MAX_ACK_OCTETS: usize = 254;

/// True if `buf` looks like RTCP (version 2, packet type 200..=207), as
/// opposed to RTP. Used to route packets on the shared UDP socket.
pub fn is_rtcp(buf: &[u8]) -> bool {
    buf.len() >= 8 && buf[0] >> 6 == 2 && (PT_SENDER_REPORT..=PT_EXTENDED_REPORTS).contains(&buf[1])
}

/// The SSRC that authored an RTCP packet (bytes 4..8), for routing.
pub fn author_ssrc(buf: &[u8]) -> Option<u32> {
    buf.get(4..8)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

fn header(w: &mut Writer, count_or_subtype: u8, pt: u8, payload_len: usize) {
    debug_assert!(payload_len % 4 == 0);
    w.u8(0x80 | (count_or_subtype & 0x1f))
        .u8(pt)
        .u16_be((payload_len / 4) as u16);
}

/// An RTCP report block (RFC 3550 §6.4.1). Cast sends zero or one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReportBlock {
    /// The SSRC being reported on (the media sender).
    pub ssrc: u32,
    pub fraction_lost: u8,
    /// 24-bit cumulative loss.
    pub cumulative_lost: u32,
    pub extended_high_sequence: u32,
    /// In RTP timebase ticks.
    pub jitter: u32,
    /// Middle 32 bits of the NTP time of the last Sender Report.
    pub last_sr: u32,
    /// Delay since that report, in 1/65536 s.
    pub delay_since_last_sr: u32,
}

impl ReportBlock {
    pub const SIZE: usize = 24;

    fn write(&self, w: &mut Writer) {
        w.u32_be(self.ssrc)
            .u32_be(((self.fraction_lost as u32) << 24) | (self.cumulative_lost & 0xff_ffff))
            .u32_be(self.extended_high_sequence)
            .u32_be(self.jitter)
            .u32_be(self.last_sr)
            .u32_be(self.delay_since_last_sr);
    }

    fn read(r: &mut Reader<'_>) -> Result<ReportBlock> {
        let ssrc = r.u32_be()?;
        let w2 = r.u32_be()?;
        Ok(ReportBlock {
            ssrc,
            fraction_lost: (w2 >> 24) as u8,
            cumulative_lost: w2 & 0xff_ffff,
            extended_high_sequence: r.u32_be()?,
            jitter: r.u32_be()?,
            last_sr: r.u32_be()?,
            delay_since_last_sr: r.u32_be()?,
        })
    }
}

/// A Sender Report (we never attach report blocks).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SenderReport {
    pub ssrc: u32,
    /// 64-bit NTP timestamp of `rtp_timestamp`.
    pub ntp: u64,
    pub rtp_timestamp: u32,
    pub packet_count: u32,
    pub octet_count: u32,
}

impl SenderReport {
    pub const SIZE: usize = 28;

    pub fn build(&self) -> Vec<u8> {
        let mut w = Writer::with_capacity(Self::SIZE);
        header(&mut w, 0, PT_SENDER_REPORT, 24);
        w.u32_be(self.ssrc)
            .u64_be(self.ntp)
            .u32_be(self.rtp_timestamp)
            .u32_be(self.packet_count)
            .u32_be(self.octet_count);
        w.into_vec()
    }

    /// The id a receiver echoes in `ReportBlock::last_sr`.
    pub fn report_id(&self) -> u32 {
        (self.ntp >> 16) as u32
    }

    /// Finds the Sender Report from `ssrc` in a compound packet.
    pub fn parse(buf: &[u8], ssrc: u32) -> Result<Option<SenderReport>> {
        for item in Packets::new(buf) {
            let (count, pt, mut body) = item?;
            if pt != PT_SENDER_REPORT {
                continue;
            }
            let _ = count;
            if body.remaining() < 24 {
                return Err(body.error("short sender report"));
            }
            let sr = SenderReport {
                ssrc: body.u32_be()?,
                ntp: body.u64_be()?,
                rtp_timestamp: body.u32_be()?,
                packet_count: body.u32_be()?,
                octet_count: body.u32_be()?,
            };
            if sr.ssrc == ssrc {
                return Ok(Some(sr));
            }
        }
        Ok(None)
    }
}

/// Iterates the packets of a compound RTCP datagram: `(count/subtype, packet
/// type, payload reader)`.
struct Packets<'a> {
    r: Reader<'a>,
    failed: bool,
}

impl<'a> Packets<'a> {
    fn new(buf: &'a [u8]) -> Packets<'a> {
        Packets {
            r: Reader::new(buf, "cast rtcp"),
            failed: false,
        }
    }
}

impl<'a> Iterator for Packets<'a> {
    type Item = Result<(u8, u8, Reader<'a>)>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.failed || self.r.is_at_end() {
            return None;
        }
        let rv = (|| {
            let b0 = self.r.u8()?;
            if b0 >> 5 != 0b100 {
                return Err(self.r.error("bad version/padding bits"));
            }
            let pt = self.r.u8()?;
            if !(PT_SENDER_REPORT..=PT_EXTENDED_REPORTS).contains(&pt) || pt == 203 || pt == 205 {
                return Err(self.r.error("unknown packet type"));
            }
            let words = self.r.u16_be()? as usize;
            let body = self.r.sub(words * 4)?;
            Ok((b0 & 0x1f, pt, body))
        })();
        self.failed = rv.is_err();
        Some(rv)
    }
}

/// A NACK for one packet of a frame, or (`packet_id == ALL_PACKETS_LOST`)
/// for the whole frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct PacketNack {
    pub frame_id: FrameId,
    pub packet_id: u16,
}

/// One frame's events from a receiver log (kept only for diagnostics).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameLog {
    /// Truncated RTP timestamp of the frame.
    pub rtp_timestamp: u32,
    /// `(event type, delay ms or packet id)` per event.
    pub events: Vec<(u8, u16)>,
}

/// Everything the sender learns from one compound RTCP packet.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Feedback {
    /// Receiver Reference Time (XR RRTR), as a 64-bit NTP timestamp.
    pub receiver_reference_ntp: Option<u64>,
    pub report: Option<ReportBlock>,
    pub logs: Vec<FrameLog>,
    /// `(checkpoint frame id, receiver's current playout delay in ms)`:
    /// every frame up to and including the checkpoint was received.
    pub checkpoint: Option<(FrameId, u16)>,
    /// Frames after the checkpoint that were fully received (CST2).
    pub received_frames: Vec<FrameId>,
    /// Sorted, de-duplicated NACKs; a whole-frame NACK subsumes the frame's
    /// packet NACKs.
    pub nacks: Vec<PacketNack>,
    pub picture_loss: bool,
}

impl Feedback {
    /// Parses a compound packet from the receiver.
    ///
    /// Only blocks addressed between `receiver_ssrc` and `sender_ssrc` are
    /// used; others are skipped. `max_frame_id` is the newest frame id we
    /// sent, used to expand the 8-bit checkpoint.
    pub fn parse(
        buf: &[u8],
        receiver_ssrc: u32,
        sender_ssrc: u32,
        max_frame_id: FrameId,
    ) -> Result<Feedback> {
        let mut fb = Feedback::default();
        for item in Packets::new(buf) {
            let (sub, pt, mut r) = item?;
            match pt {
                PT_RECEIVER_REPORT => {
                    if r.u32_be()? != receiver_ssrc {
                        continue;
                    }
                    if r.remaining() < sub as usize * ReportBlock::SIZE {
                        return Err(r.error("short receiver report"));
                    }
                    for _ in 0..sub {
                        let block = ReportBlock::read(&mut r)?;
                        if block.ssrc == sender_ssrc {
                            fb.report = Some(block);
                        }
                    }
                }
                PT_APPLICATION_DEFINED => {
                    if r.remaining() < 8 {
                        return Err(r.error("short application-defined packet"));
                    }
                    let ssrc = r.u32_be()?;
                    let name = r.u32_be()?;
                    if ssrc != receiver_ssrc {
                        continue;
                    }
                    if name != CAST {
                        if name == TIME {
                            continue;
                        }
                        return Err(r.error("unknown application-defined name"));
                    }
                    if sub == SUBTYPE_RECEIVER_LOG {
                        parse_logs(&mut r, &mut fb.logs)?;
                    }
                }
                PT_PAYLOAD_SPECIFIC => match sub {
                    SUBTYPE_PLI => {
                        if r.remaining() < 8 {
                            return Err(r.error("short PLI"));
                        }
                        if r.u32_be()? == receiver_ssrc && r.u32_be()? == sender_ssrc {
                            fb.picture_loss = true;
                        }
                    }
                    SUBTYPE_FEEDBACK => {
                        parse_feedback(&mut r, receiver_ssrc, sender_ssrc, max_frame_id, &mut fb)?
                    }
                    _ => {}
                },
                PT_EXTENDED_REPORTS => {
                    if r.u32_be()? != receiver_ssrc {
                        continue;
                    }
                    while !r.is_at_end() {
                        let ty = r.u8()?;
                        r.skip(1)?;
                        let len = r.u16_be()? as usize * 4;
                        let mut block = r.sub(len)?;
                        if ty == XR_RRTR {
                            if len != 8 {
                                return Err(block.error("bad RRTR length"));
                            }
                            fb.receiver_reference_ntp = Some(block.u64_be()?);
                        }
                    }
                }
                _ => {}
            }
        }
        canonicalize(&mut fb.nacks);
        Ok(fb)
    }

    pub fn is_empty(&self) -> bool {
        *self == Feedback::default()
    }
}

fn parse_logs(r: &mut Reader<'_>, out: &mut Vec<FrameLog>) -> Result<()> {
    while !r.is_at_end() {
        if r.remaining() < 8 {
            return Err(r.error("short frame log"));
        }
        let rtp_timestamp = r.u32_be()?;
        let n = (r.u32_be()? >> 24) as usize + 1;
        let mut events = Vec::with_capacity(n);
        for _ in 0..n {
            let value = r.u16_be()?;
            let ty_ts = r.u16_be()?;
            events.push(((ty_ts >> 12) as u8, value));
        }
        out.push(FrameLog {
            rtp_timestamp,
            events,
        });
    }
    Ok(())
}

fn parse_feedback(
    r: &mut Reader<'_>,
    receiver_ssrc: u32,
    sender_ssrc: u32,
    max_frame_id: FrameId,
    fb: &mut Feedback,
) -> Result<()> {
    if r.remaining() < 16 {
        return Err(r.error("short cast feedback"));
    }
    if r.u32_be()? != receiver_ssrc || r.u32_be()? != sender_ssrc {
        return Ok(());
    }
    if r.u32_be()? != CAST {
        return Err(r.error("cast feedback without CAST identifier"));
    }
    let checkpoint = expand_le(max_frame_id, r.u8()?);
    let loss_fields = r.u8()? as usize;
    let delay = r.u16_be()?;
    // Never let a (stale) feedback move the checkpoint backwards.
    if fb.checkpoint.is_some_and(|(c, _)| c > checkpoint) {
        return Ok(());
    }
    fb.checkpoint = Some((checkpoint, delay));
    fb.received_frames.clear();
    fb.nacks.clear();
    if r.remaining() < loss_fields * 4 {
        return Err(r.error("short loss fields"));
    }
    for _ in 0..loss_fields {
        let frame_id = expand_gt(checkpoint, r.u8()?);
        let mut packet_id = r.u16_be()?;
        let mut bits = r.u8()?;
        fb.nacks.push(PacketNack {
            frame_id,
            packet_id,
        });
        if packet_id != ALL_PACKETS_LOST {
            while bits != 0 {
                packet_id = packet_id.wrapping_add(1);
                if bits & 1 != 0 {
                    fb.nacks.push(PacketNack {
                        frame_id,
                        packet_id,
                    });
                }
                bits >>= 1;
            }
        }
    }
    // Optional CST2 frame ACKs; anything else trailing is ignored.
    if r.remaining() < 6 || r.u32_be()? != CST2 {
        return Ok(());
    }
    r.skip(1)?;
    let octets = r.u8()? as usize;
    let bits = r
        .bytes(octets)
        .map_err(|_| r.error("short ack bit vector"))?;
    let mut start = checkpoint + 2;
    for &b in bits {
        for bit in 0..8 {
            if b & (1 << bit) != 0 {
                fb.received_frames.push(start + bit);
            }
        }
        start += 8;
    }
    Ok(())
}

/// Sorts NACKs (whole-frame first within a frame) and drops duplicates and
/// packet NACKs made redundant by a whole-frame NACK.
fn canonicalize(nacks: &mut Vec<PacketNack>) {
    nacks.sort_by_key(|n| (n.frame_id, n.packet_id.wrapping_add(1)));
    let mut out: Vec<PacketNack> = Vec::with_capacity(nacks.len());
    for n in nacks.drain(..) {
        if let Some(last) = out.last() {
            if last.frame_id == n.frame_id
                && (last.packet_id == ALL_PACKETS_LOST || last.packet_id == n.packet_id)
            {
                continue;
            }
        }
        out.push(n);
    }
    *nacks = out;
}

/// Builds a receiver's compound feedback packet (used by the fake receiver
/// and tests): RR (+ optional report block), RRTR, optional PLI, Cast
/// feedback with NACKs and CST2 ACKs.
#[derive(Debug, Clone, Default)]
pub struct ReceiverPacket {
    pub receiver_ssrc: u32,
    pub sender_ssrc: u32,
    pub report: Option<ReportBlock>,
    pub reference_ntp: u64,
    pub picture_loss: bool,
    pub checkpoint: FrameId,
    pub playout_delay_ms: u16,
    /// Sorted.
    pub nacks: Vec<PacketNack>,
    /// Sorted frame ids after the checkpoint that were fully received.
    pub acks: Vec<FrameId>,
    pub feedback_count: u8,
}

impl ReceiverPacket {
    pub fn build(&self) -> Vec<u8> {
        let mut w = Writer::new();
        // Receiver Report.
        let n = self.report.is_some() as u8;
        header(
            &mut w,
            n,
            PT_RECEIVER_REPORT,
            4 + n as usize * ReportBlock::SIZE,
        );
        w.u32_be(self.receiver_ssrc);
        if let Some(rb) = &self.report {
            rb.write(&mut w);
        }
        // XR with a Receiver Reference Time block.
        header(&mut w, 0, PT_EXTENDED_REPORTS, 16);
        w.u32_be(self.receiver_ssrc)
            .u8(XR_RRTR)
            .u8(0)
            .u16_be(2)
            .u64_be(self.reference_ntp);
        if self.picture_loss {
            header(&mut w, SUBTYPE_PLI, PT_PAYLOAD_SPECIFIC, 8);
            w.u32_be(self.receiver_ssrc).u32_be(self.sender_ssrc);
        }
        // Cast feedback.
        let mut body = Writer::new();
        body.u32_be(self.receiver_ssrc)
            .u32_be(self.sender_ssrc)
            .u32_be(CAST)
            .u8(self.checkpoint as u8);
        let mut loss = Writer::new();
        let mut fields = 0usize;
        let mut i = self
            .nacks
            .iter()
            .position(|n| n.frame_id > self.checkpoint)
            .unwrap_or(self.nacks.len());
        while i < self.nacks.len() && fields < 255 {
            let first = self.nacks[i];
            let mut bits = 0u8;
            i += 1;
            while i < self.nacks.len() && self.nacks[i].frame_id == first.frame_id {
                let shift = self.nacks[i].packet_id.wrapping_sub(first.packet_id) as i32 - 1;
                if !(0..8).contains(&shift) || first.packet_id == ALL_PACKETS_LOST {
                    break;
                }
                bits |= 1 << shift;
                i += 1;
            }
            loss.u8(first.frame_id as u8)
                .u16_be(first.packet_id)
                .u8(bits);
            fields += 1;
        }
        body.u8(fields as u8)
            .u16_be(self.playout_delay_ms)
            .bytes(loss.as_slice());
        let mut ack = vec![0u8; 2];
        let base = self.checkpoint + 2;
        for &f in &self.acks {
            let bit = f - base;
            if bit < 0 {
                continue;
            }
            let octet = (bit / 8) as usize;
            if octet >= ack.len() {
                let new_len = 2 + (octet - 2 + 1).div_ceil(4) * 4;
                if new_len > MAX_ACK_OCTETS {
                    break;
                }
                ack.resize(new_len, 0);
            }
            ack[octet] |= 1 << (bit % 8);
        }
        body.u32_be(CST2)
            .u8(self.feedback_count)
            .u8(ack.len() as u8)
            .bytes(&ack);
        header(&mut w, SUBTYPE_FEEDBACK, PT_PAYLOAD_SPECIFIC, body.len());
        w.bytes(body.as_slice());
        w.into_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENDER: u32 = 1;
    const RECEIVER: u32 = 2;

    fn parse(buf: &[u8], max: FrameId) -> Result<Feedback> {
        Feedback::parse(buf, RECEIVER, SENDER, max)
    }

    // The fixtures below are from openscreen compound_rtcp_parser_unittest.cc.

    #[test]
    fn empty_and_garbage() {
        assert!(parse(&[], 0).unwrap().is_empty());
        let garbage = [
            0x42, 0x61, 0x16, 0x17, 0x26, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x69, 0x6e, 0x67,
            0x2f, 0x63, 0x61, 0x73, 0x74, 0x2f, 0x63, 0x6f, 0x6d, 0x70, 0x6f, 0x75, 0x6e, 0x64,
            0x5f, 0x72, 0x74, 0x63, 0x70, 0x5f,
        ];
        assert!(parse(&garbage, 0).is_err());
    }

    #[test]
    fn receiver_reports() {
        let without = [0x80, 201, 0x00, 0x01, 0, 0, 0, 2];
        assert!(parse(&without, 0).unwrap().is_empty());
        let with = [
            0x81, 201, 0x00, 0x07, 0, 0, 0, 2, 0, 0, 0, 1, 0x05, 0x01, 0x02, 0x03, 0x09, 0x09,
            0x09, 0x02, 0, 0, 0, 0xaa, 0x0b, 0x0c, 0x8f, 0xed, 0x00, 0x01, 0x00, 0x00,
        ];
        let rb = parse(&with, 0).unwrap().report.unwrap();
        assert_eq!(
            rb,
            ReportBlock {
                ssrc: SENDER,
                fraction_lost: 5,
                cumulative_lost: 0x010203,
                extended_high_sequence: 0x09090902,
                jitter: 170,
                last_sr: 0x0b0c8fed,
                delay_since_last_sr: 65536,
            }
        );
    }

    #[test]
    fn picture_loss() {
        let pli = [0x81, 206, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1];
        assert!(parse(&pli, 0).unwrap().picture_loss);
        let wrong_rx = [0x81, 206, 0, 2, 0, 0, 0, 3, 0, 0, 0, 1];
        assert!(!parse(&wrong_rx, 0).unwrap().picture_loss);
        let wrong_tx = [0x81, 206, 0, 2, 0, 0, 0, 2, 0, 0, 0, 3];
        assert!(!parse(&wrong_tx, 0).unwrap().picture_loss);
    }

    #[test]
    fn frame_logs() {
        let log = [
            0x82, 204, 0x00, 0x0a, 0, 0, 0, 2, b'C', b'A', b'S', b'T', 0x01, 0x02, 0x03, 0x04,
            0x02, 0x10, 0x20, 0x30, 0x01, 0x12, 0x93, 0x14, 0x01, 0x15, 0xe1, 0x19, 0x02, 0x17,
            0xc2, 0x27, 0x02, 0x02, 0x03, 0x04, 0x00, 0x40, 0x20, 0x30, 0x1e, 0x15, 0xe1, 0xf9,
        ];
        let fb = parse(&log, 0).unwrap();
        assert_eq!(
            fb.logs,
            vec![
                FrameLog {
                    rtp_timestamp: 0x01020304,
                    events: vec![(9, 0x0112), (14, 0x0115), (12, 0x0217)],
                },
                FrameLog {
                    rtp_timestamp: 0x02020304,
                    events: vec![(14, 7701)],
                },
            ]
        );
        let wrong_name = [
            0x82, 204, 0, 5, 0, 0, 0, 2, b'T', b'I', b'M', b'E', 1, 2, 3, 4, 0, 0x10, 0x20, 0x30,
            0x01, 0x12, 0x93, 0x14,
        ];
        assert!(parse(&wrong_name, 0).unwrap().logs.is_empty());
        let other_ssrc = [
            0x82, 204, 0, 5, 0, 0, 0, 9, b'C', b'A', b'S', b'T', 1, 2, 3, 4, 0, 0x10, 0x20, 0x30,
            0x01, 0x12, 0x93, 0x14,
        ];
        assert!(parse(&other_ssrc, 0).unwrap().logs.is_empty());
        let short = [
            0x82, 204, 0, 2, 0, 0, 0, 2, b'C', b'A', b'S', b'T', 1, 2, 3, 4, 0, 0x10, 0x20, 0x30,
        ];
        assert!(parse(&short, 0).is_err());
        let short_app = [0x82, 204, 0, 1, 0, 0, 0, 2];
        assert!(parse(&short_app, 0).is_err());
    }

    #[test]
    fn extended_reports() {
        let xr = [
            0x80, 207, 0x00, 0x0c, 0, 0, 0, 2, 0x02, 0x00, 0x00, 0x06, 1, 1, 1, 1, 2, 2, 2, 2, 3,
            3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 0x04, 0x00, 0x00, 0x02, 0xe0, 0x73, 0x2e,
            0x55, 0, 0, 0, 0, 0x00, 0x00, 0x00, 0x00,
        ];
        assert_eq!(
            parse(&xr, 0).unwrap().receiver_reference_ntp,
            Some(0xe0732e5500000000)
        );
    }

    #[test]
    fn simple_feedback_expands_checkpoint() {
        let fb = [
            0x8f, 206, 0, 4, 0, 0, 0, 2, 0, 0, 0, 1, b'C', b'A', b'S', b'T', 0x0a, 0x00, 0x02, 0x26,
        ];
        assert_eq!(parse(&fb, 42).unwrap().checkpoint, Some((10, 550)));
        assert_eq!(parse(&fb, 0x22a).unwrap().checkpoint, Some((0x20a, 550)));
    }

    #[test]
    fn feedback_with_nacks() {
        let fb = [
            0x8f,
            206,
            0x00,
            0x0b,
            0,
            0,
            0,
            2,
            0,
            0,
            0,
            1,
            b'C',
            b'A',
            b'S',
            b'T',
            0x0a,
            0x07,
            0x02,
            0x28,
            0x0b,
            0x00,
            0x03,
            0b0000_0000,
            0x0b,
            0x00,
            0x07,
            0b1000_1101,
            0x0d,
            0xff,
            0xff,
            0,
            0x0b,
            0x00,
            0x0b,
            0,
            0x0c,
            0xff,
            0xff,
            0,
            0x0d,
            0x00,
            0x01,
            0,
            0x0e,
            0x00,
            0x00,
            0b0100_0010,
        ];
        let got = parse(&fb, 42).unwrap();
        assert_eq!(got.checkpoint, Some((10, 552)));
        let n = |frame_id, packet_id| PacketNack {
            frame_id,
            packet_id,
        };
        assert_eq!(
            got.nacks,
            vec![
                n(11, 3),
                n(11, 7),
                n(11, 8),
                n(11, 10),
                n(11, 11),
                n(11, 15),
                n(12, ALL_PACKETS_LOST),
                n(13, ALL_PACKETS_LOST),
                n(14, 0),
                n(14, 2),
                n(14, 7),
            ]
        );
    }

    #[test]
    fn feedback_with_acks() {
        let small = [
            0x8f,
            206,
            0x00,
            0x07,
            0,
            0,
            0,
            2,
            0,
            0,
            0,
            1,
            b'C',
            b'A',
            b'S',
            b'T',
            0x0a,
            0x01,
            0x01,
            0x26,
            0x0b,
            0x00,
            0x03,
            0,
            b'C',
            b'S',
            b'T',
            b'2',
            0x99,
            0x02,
            0b0000_0010,
            0,
        ];
        let got = parse(&small, 100).unwrap();
        assert_eq!(got.checkpoint, Some((10, 294)));
        assert_eq!(got.received_frames, vec![13]);
        assert_eq!(
            got.nacks,
            vec![PacketNack {
                frame_id: 11,
                packet_id: 3
            }]
        );
        let large = [
            0x8f, 206, 0x00, 0x08, 0, 0, 0, 2, 0, 0, 0, 1, b'C', b'A', b'S', b'T', 0x0a, 0x00,
            0x01, 0x26, b'C', b'S', b'T', b'2', 0x99, 0x0a, 0xff, 0xff, 0, 1, 0, 0, 0, 0, 0, 0x80,
        ];
        let got = parse(&large, 100).unwrap();
        let mut want: Vec<FrameId> = (12..=27).collect();
        want.extend([36, 91]);
        assert_eq!(got.received_frames, want);
    }

    #[test]
    fn sender_report_roundtrip() {
        let sr = SenderReport {
            ssrc: 0x01020304,
            ntp: 0x0192a3b4c5d6e7f8,
            rtp_timestamp: 0x11223344,
            packet_count: 5,
            octet_count: 1000,
        };
        let b = sr.build();
        assert_eq!(
            b,
            [
                0x80, 200, 0, 6, 1, 2, 3, 4, 0x01, 0x92, 0xa3, 0xb4, 0xc5, 0xd6, 0xe7, 0xf8, 0x11,
                0x22, 0x33, 0x44, 0, 0, 0, 5, 0, 0, 0x03, 0xe8
            ]
        );
        assert_eq!(sr.report_id(), 0xa3b4c5d6);
        assert!(is_rtcp(&b));
        assert_eq!(author_ssrc(&b), Some(0x01020304));
        assert_eq!(SenderReport::parse(&b, 0x01020304).unwrap(), Some(sr));
        assert_eq!(SenderReport::parse(&b, 7).unwrap(), None);
        assert!(!is_rtcp(&[0x80, 96, 0, 0, 0, 0, 0, 0]));
    }

    #[test]
    fn receiver_packet_roundtrip() {
        let n = |frame_id, packet_id| PacketNack {
            frame_id,
            packet_id,
        };
        let pkt = ReceiverPacket {
            receiver_ssrc: RECEIVER,
            sender_ssrc: SENDER,
            report: Some(ReportBlock {
                ssrc: SENDER,
                last_sr: 0x1234,
                ..Default::default()
            }),
            reference_ntp: 0xe0732e5500000000,
            picture_loss: true,
            checkpoint: 300,
            playout_delay_ms: 400,
            nacks: vec![
                n(299, 1), // at/below checkpoint: skipped
                n(301, 2),
                n(301, 3),
                n(301, 10),
                n(301, 11),
                n(302, ALL_PACKETS_LOST),
            ],
            acks: vec![303, 304, 340],
            feedback_count: 7,
        };
        let b = pkt.build();
        let fb = parse(&b, 340).unwrap();
        assert_eq!(fb.receiver_reference_ntp, Some(0xe0732e5500000000));
        assert_eq!(fb.report.unwrap().last_sr, 0x1234);
        assert!(fb.picture_loss);
        assert_eq!(fb.checkpoint, Some((300, 400)));
        assert_eq!(
            fb.nacks,
            vec![
                n(301, 2),
                n(301, 3),
                n(301, 10),
                n(301, 11),
                n(302, ALL_PACKETS_LOST)
            ]
        );
        assert_eq!(fb.received_frames, vec![303, 304, 340]);
    }

    #[test]
    fn never_panics() {
        let mut x = 0x9e37_79b9u32;
        let base = [
            0x8f,
            206,
            0x00,
            0x07,
            0,
            0,
            0,
            2,
            0,
            0,
            0,
            1,
            b'C',
            b'A',
            b'S',
            b'T',
            0x0a,
            0x01,
            0x01,
            0x26,
            0x0b,
            0x00,
            0x03,
            0,
            b'C',
            b'S',
            b'T',
            b'2',
            0x99,
            0x02,
            0b0000_0010,
            0,
        ];
        for _ in 0..2000 {
            let mut b = base.to_vec();
            for _ in 0..3 {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                let i = x as usize % b.len();
                b[i] = (x >> 8) as u8;
            }
            let cut = (x >> 16) as usize % (b.len() + 1);
            let _ = parse(&b[..cut], 5);
            let _ = parse(&b, 5);
        }
    }
}
