//! Cast Streaming session negotiation: the OFFER we send on the
//! `urn:x-cast:com.google.cast.webrtc` namespace, the receiver's ANSWER,
//! and what they mean for the encode ([`Negotiated::capabilities`]).
//!
//! The OFFER lists every stream we could send; the receiver picks at most
//! one audio and one video stream (`sendIndexes`) and returns its own RTCP
//! SSRC for each (`ssrcs`), the UDP port for all media, and optional
//! constraints and display info.
//!
//! Sources: openscreen `cast/streaming/public/{offer_messages.cc,
//! answer_messages.cc,sender_session.cc,receiver_message.cc,constants.h}`,
//! `cast/streaming/{message_fields.h,resolution.cc,ssrc.cc}` and the
//! offer/answer unit tests.

use super::rtp::payload_type;
use crate::codec::json::Value;
use crate::crypto::ring::random_array;
use crate::error::{Error, Result};
use crate::types::{AudioCodec, AudioFamily, AudioFormat, Capabilities, VideoCodec};
use crate::util::hex;
use crate::util::ratio::Ratio;

/// RTP timebase for video (fixed by the spec).
pub const VIDEO_TIMEBASE: u32 = 90_000;
/// Receivers accept target delays in this range (ms).
pub const MIN_TARGET_DELAY_MS: u32 = 1;
pub const MAX_TARGET_DELAY_MS: u32 = 5000;
/// Smallest video bitrate the mirroring spec allows.
pub const MIN_VIDEO_BITRATE: u32 = 300_000;
pub const MIN_AUDIO_BITRATE: u32 = 32_000;
/// What an ANSWER without video constraints is taken to allow when we
/// offered more: openscreen's receiver defaults
/// (`cast/streaming/public/receiver_constraints.h`: 1920x1080 at 30 fps,
/// 10 Mbit/s; `constants.h`).
pub const DEFAULT_RECEIVER_MAX: (u32, u32, u32) = (1920, 1080, 30);
pub const DEFAULT_RECEIVER_MAX_BITRATE: u32 = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamKind {
    Audio,
    Video,
}

/// A Cast codec name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Codec {
    H264,
    Hevc,
    Opus,
    Aac,
}

impl Codec {
    pub fn name(self) -> &'static str {
        match self {
            Codec::H264 => "h264",
            Codec::Hevc => "hevc",
            Codec::Opus => "opus",
            Codec::Aac => "aac",
        }
    }

    pub fn kind(self) -> StreamKind {
        match self {
            Codec::H264 | Codec::Hevc => StreamKind::Video,
            Codec::Opus | Codec::Aac => StreamKind::Audio,
        }
    }

    fn payload_type(self, android_hack: bool) -> u8 {
        match (self, android_hack) {
            (Codec::Opus | Codec::Aac, true) => payload_type::AUDIO_ANDROID_HACK,
            (Codec::H264 | Codec::Hevc, true) => payload_type::VIDEO_ANDROID_HACK,
            (Codec::Opus, false) => payload_type::AUDIO_OPUS,
            (Codec::Aac, false) => payload_type::AUDIO_AAC,
            (Codec::H264 | Codec::Hevc, false) => payload_type::VIDEO_H264,
        }
    }

    pub fn from_video(c: VideoCodec) -> Codec {
        match c {
            VideoCodec::H264 => Codec::H264,
            VideoCodec::Hevc => Codec::Hevc,
        }
    }

    pub fn from_audio(c: AudioCodec) -> Option<Codec> {
        match c {
            AudioCodec::Opus => Some(Codec::Opus),
            AudioCodec::AacLc => Some(Codec::Aac),
            _ => None,
        }
    }
}

/// One stream in the OFFER.
#[derive(Clone, PartialEq, Eq)]
pub struct StreamOffer {
    pub index: u32,
    pub codec: Codec,
    pub ssrc: u32,
    pub payload_type: u8,
    /// Video: 90000; audio: the sample rate.
    pub rtp_timebase: u32,
    pub channels: u8,
    pub target_delay_ms: u32,
    pub aes_key: [u8; 16],
    pub aes_iv_mask: [u8; 16],
    /// Audio: the bitrate; video: the maximum bitrate (bits/s).
    pub bit_rate: u32,
    /// Video only.
    pub max_frame_rate: Ratio,
    /// Video only, preferred first.
    pub resolutions: Vec<(u32, u32)>,
}

impl std::fmt::Debug for StreamOffer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Keys stay out of logs.
        f.debug_struct("StreamOffer")
            .field("index", &self.index)
            .field("codec", &self.codec)
            .field("ssrc", &self.ssrc)
            .field("payload_type", &self.payload_type)
            .field("rtp_timebase", &self.rtp_timebase)
            .field("channels", &self.channels)
            .field("target_delay_ms", &self.target_delay_ms)
            .field("bit_rate", &self.bit_rate)
            .finish_non_exhaustive()
    }
}

impl StreamOffer {
    pub fn kind(&self) -> StreamKind {
        self.codec.kind()
    }

    pub fn to_json(&self) -> Value {
        let mut v = Value::object()
            .with("index", self.index)
            .with(
                "type",
                match self.kind() {
                    StreamKind::Audio => "audio_source",
                    StreamKind::Video => "video_source",
                },
            )
            .with("codecName", self.codec.name())
            .with("channels", self.channels)
            .with("rtpPayloadType", self.payload_type)
            .with("rtpProfile", "cast")
            .with("ssrc", self.ssrc)
            .with("targetDelay", self.target_delay_ms)
            .with("aesKey", hex::encode(&self.aes_key))
            .with("aesIvMask", hex::encode(&self.aes_iv_mask))
            .with("receiverRtcpEventLog", false)
            .with("timeBase", format!("1/{}", self.rtp_timebase))
            .with("codecParameter", "");
        match self.kind() {
            StreamKind::Audio => {
                v = v.with("bitRate", self.bit_rate);
            }
            StreamKind::Video => {
                v = v
                    .with("maxFrameRate", fraction(self.max_frame_rate))
                    .with("maxBitRate", self.bit_rate)
                    .with("protection", "")
                    .with("profile", "")
                    .with("level", "")
                    .with("errorRecoveryMode", "")
                    .with(
                        "resolutions",
                        Value::array(
                            self.resolutions
                                .iter()
                                .map(|&(w, h)| Value::object().with("width", w).with("height", h)),
                        ),
                    );
            }
        }
        v
    }
}

fn fraction(r: Ratio) -> String {
    if r.den == 1 {
        r.num.to_string()
    } else {
        format!("{}/{}", r.num, r.den)
    }
}

fn parse_fraction(v: &Value) -> Option<Ratio> {
    if let Some(n) = v.as_u32() {
        return (n > 0).then(|| Ratio::new(n, 1));
    }
    if let Some(f) = v.as_f64() {
        return (f.is_finite() && f > 0.0 && f < 1e6)
            .then(|| Ratio::new((f * 1000.0).round() as u32, 1000));
    }
    let s = v.as_str()?;
    let (n, d) = s.split_once('/').unwrap_or((s, "1"));
    let r = Ratio::new(n.trim().parse().ok()?, d.trim().parse().ok()?);
    (r.num > 0 && r.den > 0).then_some(r)
}

/// What we would like to send; turned into an [`Offer`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfferOptions {
    /// Target playout delay for every stream.
    pub latency_ms: u32,
    pub video: Option<VideoOptions>,
    /// Audio streams to offer, preferred first (Opus, AAC).
    pub audio: Vec<AudioOptions>,
    /// Use payload types 127/96 like Chrome's mirroring sender (needed by
    /// some Android TV receivers).
    pub android_rtp_hack: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoOptions {
    pub codec: VideoCodec,
    pub max_bitrate: u32,
    pub max_frame_rate: Ratio,
    /// Preferred first.
    pub resolutions: Vec<(u32, u32)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioOptions {
    pub codec: AudioCodec,
    pub sample_rate: u32,
    pub channels: u8,
    pub bit_rate: u32,
}

impl Default for OfferOptions {
    fn default() -> OfferOptions {
        OfferOptions {
            latency_ms: 200,
            video: Some(VideoOptions {
                codec: VideoCodec::H264,
                max_bitrate: 10_000_000,
                max_frame_rate: Ratio::new(60, 1),
                resolutions: vec![(1920, 1080), (1280, 720)],
            }),
            audio: vec![
                AudioOptions {
                    codec: AudioCodec::Opus,
                    sample_rate: 48_000,
                    channels: 2,
                    bit_rate: 128_000,
                },
                AudioOptions {
                    codec: AudioCodec::AacLc,
                    sample_rate: 48_000,
                    channels: 2,
                    bit_rate: 128_000,
                },
            ],
            android_rtp_hack: false,
        }
    }
}

/// An OFFER: audio streams first, then video (openscreen's ordering).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
    pub streams: Vec<StreamOffer>,
}

/// SSRCs like openscreen: audio from 1..=50000 (higher priority), video
/// from 50001..=100000.
fn random_ssrc(kind: StreamKind) -> Result<u32> {
    let r = u32::from_be_bytes(random_array()?);
    Ok(match kind {
        StreamKind::Audio => 1 + r % 50_000,
        StreamKind::Video => 50_001 + r % 50_000,
    })
}

impl Offer {
    pub fn new(opts: &OfferOptions) -> Result<Offer> {
        let delay = opts
            .latency_ms
            .clamp(MIN_TARGET_DELAY_MS, MAX_TARGET_DELAY_MS);
        let mut streams = Vec::new();
        for a in &opts.audio {
            let codec = Codec::from_audio(a.codec).ok_or_else(|| {
                Error::unsupported(format!("cast: audio codec {:?} not supported", a.codec))
            })?;
            if a.sample_rate == 0 || a.sample_rate > VIDEO_TIMEBASE || a.channels == 0 {
                return Err(Error::usage("cast: bad audio parameters"));
            }
            streams.push(StreamOffer {
                index: streams.len() as u32,
                codec,
                ssrc: random_ssrc(StreamKind::Audio)?,
                payload_type: codec.payload_type(opts.android_rtp_hack),
                rtp_timebase: a.sample_rate,
                channels: a.channels,
                target_delay_ms: delay,
                aes_key: random_array()?,
                aes_iv_mask: random_array()?,
                bit_rate: a.bit_rate.max(MIN_AUDIO_BITRATE),
                max_frame_rate: Ratio::new(0, 1),
                resolutions: Vec::new(),
            });
        }
        if let Some(v) = &opts.video {
            let codec = Codec::from_video(v.codec);
            streams.push(StreamOffer {
                index: streams.len() as u32,
                codec,
                ssrc: random_ssrc(StreamKind::Video)?,
                payload_type: codec.payload_type(opts.android_rtp_hack),
                rtp_timebase: VIDEO_TIMEBASE,
                channels: 1,
                target_delay_ms: delay,
                aes_key: random_array()?,
                aes_iv_mask: random_array()?,
                bit_rate: v.max_bitrate.max(MIN_VIDEO_BITRATE),
                max_frame_rate: v.max_frame_rate,
                resolutions: v.resolutions.clone(),
            });
        }
        if streams.is_empty() {
            return Err(Error::usage("cast: nothing to offer"));
        }
        Ok(Offer { streams })
    }

    /// The `offer` body.
    pub fn to_json(&self) -> Value {
        Value::object().with("castMode", "mirroring").with(
            "supportedStreams",
            Value::array(self.streams.iter().map(StreamOffer::to_json)),
        )
    }

    /// The full OFFER message.
    pub fn message(&self, seq_num: u32) -> Value {
        Value::object()
            .with("type", "OFFER")
            .with("seqNum", seq_num)
            .with("offer", self.to_json())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AudioConstraints {
    pub max_sample_rate: u32,
    pub max_channels: u32,
    pub min_bit_rate: u32,
    pub max_bit_rate: u32,
    pub max_delay_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VideoConstraints {
    pub max_pixels_per_second: Option<f64>,
    pub min_resolution: Option<(u32, u32)>,
    pub max_width: u32,
    pub max_height: u32,
    pub max_frame_rate: Ratio,
    pub min_bit_rate: u32,
    pub max_bit_rate: u32,
    pub max_delay_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Constraints {
    pub audio: Option<AudioConstraints>,
    pub video: Option<VideoConstraints>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Display {
    /// `(width, height, frame rate)`.
    pub dimensions: Option<(u32, u32, Ratio)>,
    pub aspect_ratio: Option<(u32, u32)>,
    /// `"sender"` (fixed aspect ratio) or `"receiver"`.
    pub scaling: Option<String>,
}

/// A parsed ANSWER body.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub udp_port: u16,
    pub send_indexes: Vec<u32>,
    pub ssrcs: Vec<u32>,
    pub constraints: Option<Constraints>,
    pub display: Option<Display>,
    pub rtp_extensions: Vec<Vec<String>>,
}

fn u32_array(v: &Value, key: &str) -> Result<Vec<u32>> {
    v.require_array(key)?
        .iter()
        .map(|x| {
            x.as_u32()
                .ok_or_else(|| Error::protocol(format!("cast answer: bad {key} entry")))
        })
        .collect()
}

fn dims(v: &Value) -> Option<(u32, u32, Ratio)> {
    let w = v["width"].as_u32().filter(|&w| w > 0)?;
    let h = v["height"].as_u32().filter(|&h| h > 0)?;
    let fps = if v["frameRate"].is_null() {
        Ratio::new(30, 1)
    } else {
        parse_fraction(&v["frameRate"])?
    };
    Some((w, h, fps))
}

impl AudioConstraints {
    fn parse(v: &Value) -> Result<AudioConstraints> {
        let bad = || Error::protocol("cast answer: bad audio constraints");
        Ok(AudioConstraints {
            max_sample_rate: v["maxSampleRate"].as_u32().ok_or_else(bad)?,
            max_channels: v["maxChannels"].as_u32().ok_or_else(bad)?,
            max_bit_rate: v["maxBitRate"].as_u32().ok_or_else(bad)?,
            min_bit_rate: v["minBitRate"].as_u32().unwrap_or(MIN_AUDIO_BITRATE),
            max_delay_ms: v["maxDelay"].as_u32(),
        })
    }
}

impl VideoConstraints {
    fn parse(v: &Value) -> Result<VideoConstraints> {
        let bad = || Error::protocol("cast answer: bad video constraints");
        let (max_width, max_height, max_frame_rate) = dims(&v["maxDimensions"]).ok_or_else(bad)?;
        Ok(VideoConstraints {
            max_pixels_per_second: v["maxPixelsPerSecond"].as_f64(),
            min_resolution: dims(&v["minResolution"]).map(|(w, h, _)| (w, h)),
            max_width,
            max_height,
            max_frame_rate,
            max_bit_rate: v["maxBitRate"].as_u32().ok_or_else(bad)?,
            min_bit_rate: v["minBitRate"].as_u32().unwrap_or(MIN_VIDEO_BITRATE),
            max_delay_ms: v["maxDelay"].as_u32(),
        })
    }
}

impl Answer {
    /// Parses the `answer` body.
    pub fn parse(v: &Value) -> Result<Answer> {
        let port = v.require_u32("udpPort")?;
        let udp_port = u16::try_from(port)
            .ok()
            .filter(|&p| p != 0)
            .ok_or_else(|| Error::protocol(format!("cast answer: bad udpPort {port}")))?;
        let send_indexes = u32_array(v, "sendIndexes")?;
        let ssrcs = u32_array(v, "ssrcs")?;
        if send_indexes.is_empty() || send_indexes.len() != ssrcs.len() {
            return Err(Error::protocol(
                "cast answer: sendIndexes and ssrcs must be non-empty and equally long",
            ));
        }
        let c = &v["constraints"];
        let constraints = if c.is_null() {
            None
        } else {
            Some(Constraints {
                audio: (!c["audio"].is_null())
                    .then(|| AudioConstraints::parse(&c["audio"]))
                    .transpose()?,
                video: (!c["video"].is_null())
                    .then(|| VideoConstraints::parse(&c["video"]))
                    .transpose()?,
            })
        };
        let d = &v["display"];
        let display = (!d.is_null()).then(|| Display {
            dimensions: dims(&d["dimensions"]),
            aspect_ratio: d["aspectRatio"].as_str().and_then(|s| {
                let (a, b) = s.split_once(':')?;
                Some((a.parse().ok()?, b.parse().ok()?))
            }),
            scaling: d["scaling"].as_str().map(str::to_owned),
        });
        let rtp_extensions = v["rtpExtensions"]
            .as_array()
            .unwrap_or_default()
            .iter()
            .map(|e| {
                e.as_array()
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|s| s.as_str().map(str::to_owned))
                    .collect()
            })
            .collect();
        Ok(Answer {
            udp_port,
            send_indexes,
            ssrcs,
            constraints,
            display,
            rtp_extensions,
        })
    }

    /// Parses a full message from the webrtc namespace, expecting an ANSWER
    /// to OFFER `seq_num`. `Ok(None)` for unrelated messages.
    pub fn from_message(msg: &Value, seq_num: u32) -> Result<Option<Answer>> {
        if msg["type"].as_str() != Some("ANSWER") {
            return Ok(None);
        }
        if msg["seqNum"].as_u32().is_some_and(|s| s != seq_num) {
            return Ok(None);
        }
        if msg["result"].as_str() != Some("ok") {
            let e = &msg["error"];
            return Err(Error::protocol(format!(
                "cast: receiver rejected the OFFER: {} (code {})",
                e["description"].as_str().unwrap_or("no description"),
                e["code"].as_i64().unwrap_or(-1)
            )));
        }
        Answer::parse(msg.require("answer")?).map(Some)
    }
}

/// A stream the receiver accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectedStream {
    pub offer: StreamOffer,
    /// The receiver's SSRC (its RTCP packets come from this).
    pub receiver_ssrc: u32,
}

/// The outcome of OFFER/ANSWER.
#[derive(Debug, Clone, PartialEq)]
pub struct Negotiated {
    pub udp_port: u16,
    pub audio: Option<SelectedStream>,
    pub video: Option<SelectedStream>,
    pub answer: Answer,
}

impl Negotiated {
    pub fn new(offer: &Offer, answer: Answer) -> Result<Negotiated> {
        let mut audio = None;
        let mut video = None;
        for (&idx, &rx_ssrc) in answer.send_indexes.iter().zip(&answer.ssrcs) {
            let Some(s) = offer.streams.iter().find(|s| s.index == idx) else {
                return Err(Error::protocol(format!(
                    "cast answer: selected unknown stream {idx}"
                )));
            };
            if rx_ssrc == s.ssrc {
                return Err(Error::protocol("cast answer: receiver reused our SSRC"));
            }
            let slot = match s.kind() {
                StreamKind::Audio => &mut audio,
                StreamKind::Video => &mut video,
            };
            if slot.is_some() {
                return Err(Error::protocol(
                    "cast answer: more than one stream of a kind selected",
                ));
            }
            *slot = Some(SelectedStream {
                offer: s.clone(),
                receiver_ssrc: rx_ssrc,
            });
        }
        if audio.is_none() && video.is_none() {
            return Err(Error::protocol("cast answer: no stream selected"));
        }
        Ok(Negotiated {
            udp_port: answer.udp_port,
            audio,
            video,
            answer,
        })
    }

    /// Capabilities for the encode plan, combining what we offered with the
    /// receiver's constraints and display.
    pub fn capabilities(&self) -> Capabilities {
        let c = self.answer.constraints.as_ref();
        let vc = c.and_then(|c| c.video.as_ref());
        let ac = c.and_then(|c| c.audio.as_ref());
        let (mut max_width, mut max_height, mut max_fps, mut max_bitrate) =
            (0, 0, Ratio::new(0, 1), None);
        let mut max_pixels = None;
        let mut video_codecs = Vec::new();
        if let Some(v) = &self.video {
            let (w, h) = v.offer.resolutions.first().copied().unwrap_or((1920, 1080));
            max_width = w;
            max_height = h;
            max_fps = v.offer.max_frame_rate;
            max_bitrate = Some(v.offer.bit_rate / 1000);
            video_codecs.push(match v.offer.codec {
                Codec::Hevc => VideoCodec::Hevc,
                _ => VideoCodec::H264,
            });
            if let Some(vc) = vc {
                max_width = max_width.min(vc.max_width);
                max_height = max_height.min(vc.max_height);
                if vc.max_frame_rate.as_f64() < max_fps.as_f64() {
                    max_fps = vc.max_frame_rate;
                }
                max_bitrate = max_bitrate.map(|b| b.min(vc.max_bit_rate / 1000));
                max_pixels = vc
                    .max_pixels_per_second
                    .filter(|p| p.is_finite() && *p >= 1.0)
                    .map(|p| p.min(u64::MAX as f64) as u64);
            } else if max_width > DEFAULT_RECEIVER_MAX.0 || max_height > DEFAULT_RECEIVER_MAX.1 {
                // A receiver that says nothing about video while we
                // offered more than 1080p: what openscreen's receivers
                // take by default, not the offer.
                let (w, h, fps) = DEFAULT_RECEIVER_MAX;
                max_width = max_width.min(w);
                max_height = max_height.min(h);
                if max_fps.as_f64() > fps as f64 {
                    max_fps = Ratio::new(fps, 1);
                }
                max_bitrate = max_bitrate.map(|b| b.min(DEFAULT_RECEIVER_MAX_BITRATE / 1000));
            }
        }
        let mut audio_formats = Vec::new();
        if let Some(a) = &self.audio {
            let codec = match a.offer.codec {
                Codec::Aac => AudioCodec::AacLc,
                _ => AudioCodec::Opus,
            };
            let mut channels = a.offer.channels;
            let mut sample_rate = a.offer.rtp_timebase;
            if let Some(ac) = ac {
                channels = channels.min(ac.max_channels.min(255) as u8).max(1);
                sample_rate = sample_rate.min(ac.max_sample_rate.max(1));
            }
            audio_formats.push(AudioFormat {
                codec,
                sample_rate,
                channels,
            });
        }
        let delay = self
            .video
            .as_ref()
            .or(self.audio.as_ref())
            .map(|s| s.offer.target_delay_ms);
        Capabilities {
            max_width,
            max_height,
            max_fps,
            video_codecs,
            audio_formats,
            audio_family: AudioFamily::Cast,
            max_bitrate_kbps: max_bitrate,
            max_pixels_per_second: max_pixels,
            min_latency_ms: None,
            preferred_latency_ms: delay,
            max_key_interval_ms: None,
            display_aspect: self
                .answer
                .display
                .as_ref()
                .and_then(|d| {
                    d.aspect_ratio
                        .and_then(|(a, b)| crate::types::aspect_of(a, b))
                        .or_else(|| {
                            d.dimensions
                                .and_then(|(w, h, _)| crate::types::aspect_of(w, h))
                        })
                })
                .or(Some(crate::types::DEFAULT_DISPLAY_ASPECT)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer() -> Offer {
        Offer::new(&OfferOptions::default()).unwrap()
    }

    #[test]
    fn offer_json_shape() {
        let o = offer();
        assert_eq!(o.streams.len(), 3);
        let v = o.message(4);
        assert_eq!(v["type"].as_str(), Some("OFFER"));
        assert_eq!(v["seqNum"].as_u32(), Some(4));
        assert_eq!(v["offer"]["castMode"].as_str(), Some("mirroring"));
        let s = &v["offer"]["supportedStreams"];
        let opus = &s[0];
        assert_eq!(opus["type"].as_str(), Some("audio_source"));
        assert_eq!(opus["codecName"].as_str(), Some("opus"));
        assert_eq!(opus["rtpPayloadType"].as_u32(), Some(96));
        assert_eq!(opus["timeBase"].as_str(), Some("1/48000"));
        assert_eq!(opus["bitRate"].as_u32(), Some(128_000));
        assert_eq!(opus["channels"].as_u32(), Some(2));
        assert_eq!(opus["rtpProfile"].as_str(), Some("cast"));
        assert_eq!(opus["aesKey"].as_str().unwrap().len(), 32);
        assert_eq!(opus["aesIvMask"].as_str().unwrap().len(), 32);
        let ssrc = opus["ssrc"].as_u32().unwrap();
        assert!((1..=50_000).contains(&ssrc));
        assert_eq!(s[1]["codecName"].as_str(), Some("aac"));
        assert_eq!(s[1]["rtpPayloadType"].as_u32(), Some(97));
        let h264 = &s[2];
        assert_eq!(h264["index"].as_u32(), Some(2));
        assert_eq!(h264["type"].as_str(), Some("video_source"));
        assert_eq!(h264["codecName"].as_str(), Some("h264"));
        assert_eq!(h264["rtpPayloadType"].as_u32(), Some(101));
        assert_eq!(h264["timeBase"].as_str(), Some("1/90000"));
        assert_eq!(h264["maxFrameRate"].as_str(), Some("60"));
        assert_eq!(h264["maxBitRate"].as_u32(), Some(10_000_000));
        assert_eq!(h264["targetDelay"].as_u32(), Some(200));
        assert_eq!(h264["resolutions"][0]["width"].as_u32(), Some(1920));
        assert!((50_001..=100_000).contains(&h264["ssrc"].as_u32().unwrap()));
        // Keys are fresh per offer.
        assert_ne!(o.streams[0].aes_key, offer().streams[0].aes_key);
        assert!(!format!("{:?}", o).contains(&hex::encode(&o.streams[0].aes_key)));
    }

    #[test]
    fn android_hack_payload_types() {
        let o = Offer::new(&OfferOptions {
            android_rtp_hack: true,
            ..OfferOptions::default()
        })
        .unwrap();
        assert_eq!(o.streams[0].payload_type, 127);
        assert_eq!(o.streams[2].payload_type, 96);
    }

    // The ANSWER below follows openscreen answer_messages_unittest.cc
    // (kValidAnswerJson), adapted to our offer's indexes.
    const ANSWER: &str = r#"{
      "type": "ANSWER", "seqNum": 4, "result": "ok",
      "answer": {
        "castMode": "mirroring",
        "udpPort": 1234,
        "sendIndexes": [0, 2],
        "ssrcs": [123, 456],
        "constraints": {
          "audio": {"maxSampleRate": 96000, "maxChannels": 5, "minBitRate": 32000,
                    "maxBitRate": 320000, "maxDelay": 5000},
          "video": {"maxPixelsPerSecond": 62208000,
                    "minResolution": {"width": 320, "height": 180, "frameRate": 0},
                    "maxDimensions": {"width": 1920, "height": 1080, "frameRate": "60"},
                    "minBitRate": 300000, "maxBitRate": 10000000, "maxDelay": 5000}
        },
        "display": {"dimensions": {"width": 1920, "height": 1080, "frameRate": "60000/1001"},
                    "aspectRatio": "64:27", "scaling": "sender"},
        "receiverRtcpEventLog": [0, 1],
        "receiverRtcpDscp": [234, 567],
        "rtpExtensions": [["adaptive_playout_delay"], ["adaptive_playout_delay"]]
      }
    }"#;

    #[test]
    fn parses_answer_and_negotiates() {
        let o = offer();
        let msg = Value::parse(ANSWER).unwrap();
        assert_eq!(Answer::from_message(&msg, 3).unwrap(), None);
        let a = Answer::from_message(&msg, 4).unwrap().unwrap();
        assert_eq!(a.udp_port, 1234);
        assert_eq!(a.send_indexes, vec![0, 2]);
        assert_eq!(a.ssrcs, vec![123, 456]);
        let c = a.constraints.clone().unwrap();
        let vc = c.video.unwrap();
        assert_eq!((vc.max_width, vc.max_height), (1920, 1080));
        assert_eq!(vc.max_frame_rate, Ratio::new(60, 1));
        assert_eq!(vc.min_resolution, None); // frameRate 0 is invalid
        assert_eq!(c.audio.unwrap().max_channels, 5);
        let d = a.display.clone().unwrap();
        assert_eq!(d.dimensions, Some((1920, 1080, Ratio::new(60000, 1001))));
        assert_eq!(d.aspect_ratio, Some((64, 27)));
        assert_eq!(d.scaling.as_deref(), Some("sender"));
        assert_eq!(
            a.rtp_extensions[0],
            vec!["adaptive_playout_delay".to_string()]
        );

        let n = Negotiated::new(&o, a).unwrap();
        assert_eq!(n.udp_port, 1234);
        assert_eq!(n.audio.as_ref().unwrap().offer.codec, Codec::Opus);
        assert_eq!(n.audio.as_ref().unwrap().receiver_ssrc, 123);
        assert_eq!(n.video.as_ref().unwrap().receiver_ssrc, 456);
        let caps = n.capabilities();
        assert_eq!((caps.max_width, caps.max_height), (1920, 1080));
        assert_eq!(caps.max_fps, Ratio::new(60, 1));
        assert_eq!(caps.video_codecs, vec![VideoCodec::H264]);
        assert_eq!(
            caps.audio_formats,
            vec![AudioFormat {
                codec: AudioCodec::Opus,
                sample_rate: 48_000,
                channels: 2
            }]
        );
        assert_eq!(caps.audio_family, AudioFamily::Cast);
        assert_eq!(caps.max_bitrate_kbps, Some(10_000));
        assert_eq!(caps.max_pixels_per_second, Some(62_208_000));
        assert_eq!(caps.preferred_latency_ms, Some(200));
        // aspectRatio wins over the dimensions' shape.
        assert_eq!(caps.display_aspect, Some((64, 27)));
    }

    #[test]
    fn a_4k_offer_without_constraints_takes_openscreens_defaults() {
        let uhd = Offer::new(&OfferOptions {
            video: Some(VideoOptions {
                codec: VideoCodec::H264,
                max_bitrate: 20_000_000,
                max_frame_rate: Ratio::new(60, 1),
                resolutions: vec![(3840, 2160), (1920, 1080), (1280, 720)],
            }),
            ..OfferOptions::default()
        })
        .unwrap();
        let video = |extra: &str| {
            let a = Answer::parse(
                &Value::parse(&format!(
                    r#"{{"udpPort": 1, "sendIndexes": [2], "ssrcs": [7]{extra}}}"#
                ))
                .unwrap(),
            )
            .unwrap();
            Negotiated::new(&uhd, a).unwrap().capabilities()
        };
        let caps = video("");
        assert_eq!((caps.max_width, caps.max_height), (1920, 1080));
        assert_eq!(caps.max_fps, Ratio::new(30, 1));
        assert_eq!(caps.max_bitrate_kbps, Some(10_000));
        assert_eq!(caps.max_pixels_per_second, None);
        // A receiver that says more gets the offer.
        let caps = video(
            r#", "constraints": {"video": {"maxDimensions": {"width": 3840, "height": 2160,
               "frameRate": "60"}, "maxBitRate": 40000000, "maxPixelsPerSecond": 497664000}}"#,
        );
        assert_eq!((caps.max_width, caps.max_height), (3840, 2160));
        assert_eq!(caps.max_fps, Ratio::new(60, 1));
        assert_eq!(caps.max_bitrate_kbps, Some(20_000));
        assert_eq!(caps.max_pixels_per_second, Some(497_664_000));
        // A 1080p offer without constraints is the offer (as before).
        let a = Answer::parse(
            &Value::parse(r#"{"udpPort": 1, "sendIndexes": [2], "ssrcs": [7]}"#).unwrap(),
        )
        .unwrap();
        let caps = Negotiated::new(&offer(), a).unwrap().capabilities();
        assert_eq!((caps.max_width, caps.max_fps), (1920, Ratio::new(60, 1)));
    }

    #[test]
    fn minimal_answer_and_errors() {
        let o = offer();
        let a = Answer::parse(
            &Value::parse(r#"{"udpPort": 2344, "sendIndexes": [2], "ssrcs": [77]}"#).unwrap(),
        )
        .unwrap();
        let n = Negotiated::new(&o, a).unwrap();
        assert!(n.audio.is_none());
        let caps = n.capabilities();
        assert!(caps.audio_formats.is_empty());
        // A TV that does not say is 16:9.
        assert_eq!(caps.display_aspect, Some((16, 9)));
        assert_eq!(caps.max_width, 1920);

        let bad = |s: &str| Answer::parse(&Value::parse(s).unwrap()).is_err();
        assert!(bad(r#"{"udpPort": 0, "sendIndexes": [0], "ssrcs": [1]}"#));
        assert!(bad(
            r#"{"udpPort": 70000, "sendIndexes": [0], "ssrcs": [1]}"#
        ));
        assert!(bad(r#"{"udpPort": 1, "sendIndexes": [], "ssrcs": []}"#));
        assert!(bad(
            r#"{"udpPort": 1, "sendIndexes": [0, 1], "ssrcs": [1]}"#
        ));
        assert!(bad(r#"{"udpPort": 1, "sendIndexes": [-1], "ssrcs": [1]}"#));
        assert!(bad(
            r#"{"udpPort": 1, "sendIndexes": [0], "ssrcs": [1], "constraints": {"video": {}}}"#
        ));

        let sel = |idx: &str| {
            let a = Answer::parse(
                &Value::parse(&format!(
                    r#"{{"udpPort": 1, "sendIndexes": {idx}, "ssrcs": [5, 6]}}"#
                ))
                .unwrap(),
            )
            .unwrap();
            Negotiated::new(&o, a)
        };
        assert!(sel("[0, 1]").is_err()); // two audio streams
        assert!(sel("[0, 9]").is_err()); // unknown index

        let err = Value::parse(
            r#"{"type":"ANSWER","seqNum":1,"result":"error","error":{"code":2,"description":"no streams"}}"#,
        )
        .unwrap();
        let e = Answer::from_message(&err, 1).unwrap_err();
        assert!(e.to_string().contains("no streams"));
        let other = Value::parse(r#"{"type":"STATUS_RESPONSE"}"#).unwrap();
        assert_eq!(Answer::from_message(&other, 1).unwrap(), None);
    }

    #[test]
    fn fractions() {
        assert_eq!(fraction(Ratio::new(30000, 1001)), "30000/1001");
        assert_eq!(parse_fraction(&Value::from("30")), Some(Ratio::new(30, 1)));
        assert_eq!(parse_fraction(&Value::from(25u32)), Some(Ratio::new(25, 1)));
        assert_eq!(parse_fraction(&Value::from("0")), None);
        assert_eq!(parse_fraction(&Value::from("1/0")), None);
        assert_eq!(parse_fraction(&Value::from("x")), None);
    }
}
