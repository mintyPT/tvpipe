//! `GET /info`: the receiver's binary plist with its name,
//! model, feature bits, long-term key, displays and audio formats, and its
//! mapping to [`Capabilities`].
//!
//! The dev Apple TV (AppleTV6,2, tvOS 26.6.1) answers a plain `GET /info`
//! with the same dictionary before pairing and over the encrypted channel
//! (`tests/fixtures/airplay/appletv-info-verified.bplist`): name, model,
//! ids, `features`, `pk`, `statusFlags`, `supportedFormats` bitmasks per
//! stream type and `receiverHDRCapability`, but no `displays`,
//! `audioFormats` or `audioLatencies`. Those are parsed when present
//! (other receivers, or a richer request we may send) and otherwise
//! [`Info::capabilities`] falls back to defaults. Every field is optional:
//! unknown or mistyped values are ignored, never fatal.
//!
//! Sources: key names as observed on the dev Apple TV (fixtures under
//! `tests/fixtures/net/` and `tests/fixtures/airplay/`); feature bits from
//! pyatv (MIT) via `airplay::discovery::features`.

use std::io::{Read, Write};

use crate::airplay::discovery::features;
use crate::codec::bplist::Plist;
use crate::error::{Error, Result};
use crate::net::rtsp::RtspClient;
use crate::types::{AudioCodec, AudioFamily, AudioFormat, Capabilities, VideoCodec};
use crate::util::ratio::Ratio;

/// One entry of `displays`.
#[derive(Debug, Clone, PartialEq)]
pub struct Display {
    pub width_pixels: Option<u32>,
    pub height_pixels: Option<u32>,
    /// Logical size (points).
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Seconds per frame as sent (e.g. 0.01666 for 60 Hz).
    pub refresh_rate: Option<f64>,
    pub max_fps: Option<u32>,
    pub uuid: Option<String>,
}

impl Display {
    /// The frame rate: `maxFPS`, else `1 / refreshRate`.
    pub fn fps(&self) -> Option<u32> {
        self.max_fps.filter(|&f| f > 0).or_else(|| {
            self.refresh_rate
                .filter(|r| *r > 0.0)
                .map(|r| (1.0 / r).round())
                .filter(|f| (1.0..=1000.0).contains(f))
                .map(|f| f as u32)
        })
    }
}

/// One entry of `audioFormats`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioFormats {
    /// Stream type (96 = realtime, 103 = buffered).
    pub stream_type: u64,
    pub input: u64,
    pub output: u64,
}

/// One entry of `audioLatencies`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioLatency {
    pub stream_type: u64,
    pub audio_type: Option<String>,
    pub input_micros: Option<u64>,
    pub output_micros: Option<u64>,
}

/// `supportedFormats`: an audio-format bitmask per stream type (the bits
/// are not interpreted; kept raw).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SupportedFormats {
    pub audio_stream: Option<u64>,
    pub screen_stream: Option<u64>,
    pub buffer_stream: Option<u64>,
    pub low_latency_audio_stream: Option<u64>,
}

/// The fields of `/info` we use. `raw` keeps the whole dictionary.
#[derive(Debug, Clone, PartialEq)]
pub struct Info {
    pub name: Option<String>,
    pub model: Option<String>,
    pub device_id: Option<String>,
    pub mac_address: Option<String>,
    pub source_version: Option<String>,
    pub features: u64,
    pub status_flags: Option<u64>,
    /// The receiver's long-term Ed25519 key.
    pub pk: Option<Vec<u8>>,
    pub pi: Option<String>,
    pub psi: Option<String>,
    /// `featuresEx`: the extended feature bits, as sent (base64).
    pub features_ex: Option<String>,
    pub protocol_version: Option<String>,
    pub os_build_version: Option<String>,
    /// e.g. `"4k30"`.
    pub hdr_capability: Option<String>,
    pub has_udp_mirroring: Option<bool>,
    pub supported_formats: SupportedFormats,
    pub displays: Vec<Display>,
    pub audio_formats: Vec<AudioFormats>,
    pub audio_latencies: Vec<AudioLatency>,
    pub raw: Plist,
}

fn int(p: Option<&Plist>) -> Option<i128> {
    p.and_then(Plist::as_i128)
}

fn u32_of(p: Option<&Plist>) -> Option<u32> {
    match p {
        Some(Plist::Real(r)) if *r >= 0.0 && *r <= u32::MAX as f64 => Some(r.round() as u32),
        other => int(other).and_then(|v| u32::try_from(v).ok()),
    }
}

fn u64_of(p: Option<&Plist>) -> Option<u64> {
    int(p).and_then(|v| u64::try_from(v).ok())
}

/// A 64-bit bitmask that may be sent as a negative signed integer.
fn bits_of(p: Option<&Plist>) -> Option<u64> {
    int(p)
        .filter(|v| *v >= i64::MIN as i128 && *v <= u64::MAX as i128)
        .map(|v| v as u64)
}

fn string(p: Option<&Plist>) -> Option<String> {
    p.and_then(Plist::as_str).map(str::to_owned)
}

impl Info {
    /// Parses the body of a `/info` response.
    pub fn parse(body: &[u8]) -> Result<Info> {
        let plist = Plist::from_bytes(body)?;
        Info::from_plist(plist)
    }

    pub fn from_plist(raw: Plist) -> Result<Info> {
        let d = raw
            .as_dict()
            .ok_or_else(|| Error::malformed("info: top level is not a dictionary"))?;
        // `features` is a 64-bit field sent as a signed integer.
        let features = bits_of(d.get("features")).unwrap_or_default();
        let sf = d.get("supportedFormats").and_then(Plist::as_dict);
        let bits = |key: &str| bits_of(sf.and_then(|f| f.get(key)));
        let supported_formats = SupportedFormats {
            audio_stream: bits("audioStream"),
            screen_stream: bits("screenStream"),
            buffer_stream: bits("bufferStream"),
            low_latency_audio_stream: bits("lowLatencyAudioStream"),
        };
        let displays = d
            .get("displays")
            .and_then(Plist::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(Plist::as_dict)
            .map(|e| Display {
                width_pixels: u32_of(e.get("widthPixels")),
                height_pixels: u32_of(e.get("heightPixels")),
                width: u32_of(e.get("width")),
                height: u32_of(e.get("height")),
                refresh_rate: e.get("refreshRate").and_then(Plist::as_f64),
                max_fps: u32_of(e.get("maxFPS")),
                uuid: string(e.get("uuid")),
            })
            .collect();
        let audio_formats = d
            .get("audioFormats")
            .and_then(Plist::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(Plist::as_dict)
            .filter_map(|e| {
                Some(AudioFormats {
                    stream_type: u64_of(e.get("type"))?,
                    input: u64_of(e.get("audioInputFormats")).unwrap_or_default(),
                    output: u64_of(e.get("audioOutputFormats")).unwrap_or_default(),
                })
            })
            .collect();
        let audio_latencies = d
            .get("audioLatencies")
            .and_then(Plist::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(Plist::as_dict)
            .filter_map(|e| {
                Some(AudioLatency {
                    stream_type: u64_of(e.get("type"))?,
                    audio_type: string(e.get("audioType")),
                    input_micros: u64_of(e.get("inputLatencyMicros")),
                    output_micros: u64_of(e.get("outputLatencyMicros")),
                })
            })
            .collect();
        Ok(Info {
            name: string(d.get("name")),
            model: string(d.get("model")),
            device_id: string(d.get("deviceID")),
            mac_address: string(d.get("macAddress")),
            source_version: string(d.get("sourceVersion")),
            features,
            status_flags: u64_of(d.get("statusFlags")),
            pk: d.get("pk").and_then(Plist::as_data).map(<[u8]>::to_vec),
            pi: string(d.get("pi")),
            psi: string(d.get("psi")),
            features_ex: string(d.get("featuresEx")),
            protocol_version: string(d.get("protocolVersion")),
            os_build_version: string(d.get("osBuildVersion")),
            hdr_capability: string(d.get("receiverHDRCapability")),
            has_udp_mirroring: d.get("hasUDPMirroringSupport").and_then(Plist::as_bool),
            supported_formats,
            displays,
            audio_formats,
            audio_latencies,
            raw,
        })
    }

    pub fn has(&self, feature: u64) -> bool {
        self.features & feature == feature
    }

    /// Whether the receiver keeps time with PTP (else NTP).
    pub fn uses_ptp(&self) -> bool {
        self.has(features::PTP)
    }

    /// The main display (the first one).
    pub fn display(&self) -> Option<&Display> {
        self.displays.first()
    }

    /// What the receiver can take for mirroring. Without `displays` (the
    /// Apple TV never sends them in `/info`) this assumes 1920x1080 at
    /// 60 fps, the safe mirroring default; HEVC is offered when the
    /// receiver sets the multi-codec screen feature (bit 42).
    pub fn capabilities(&self) -> Capabilities {
        let disp = self.display();
        let (w, h) = disp
            .and_then(|d| Some((d.width_pixels?, d.height_pixels?)))
            .filter(|&(w, h)| w > 0 && h > 0)
            .unwrap_or((1920, 1080));
        let fps = disp.and_then(Display::fps).unwrap_or(60);
        let mut video_codecs = vec![VideoCodec::H264];
        if self.has(features::SCREEN_MULTI_CODEC) {
            video_codecs.push(VideoCodec::Hevc);
        }
        // Realtime mirroring audio as ALAC 44.1 kHz stereo (ARCHITECTURE.md,
        // "AirPlay"), until `audioFormats` is read once its bits are specified.
        let audio_formats = if self.has(features::AUDIO) || self.has(features::SCREEN) {
            vec![AudioFormat {
                codec: AudioCodec::Alac,
                sample_rate: 44_100,
                channels: 2,
            }]
        } else {
            Vec::new()
        };
        let latency = self
            .audio_latencies
            .iter()
            .find(|l| l.stream_type == 96)
            .and_then(|l| l.output_micros)
            .and_then(|us| u32::try_from(us.div_ceil(1000)).ok());
        Capabilities {
            max_width: w,
            max_height: h,
            max_fps: Ratio::integer(fps),
            video_codecs,
            audio_formats,
            audio_family: AudioFamily::AirPlay,
            max_bitrate_kbps: None,
            max_pixels_per_second: None,
            min_latency_ms: latency,
            preferred_latency_ms: None,
            // The screen's shape comes with the SETUP canvas.
            display_aspect: Some(crate::types::DEFAULT_DISPLAY_ASPECT),
        }
    }
}

/// `GET /info` on a control connection (plain or encrypted).
pub fn get_info<S: Read + Write>(client: &mut RtspClient<S>) -> Result<Info> {
    let resp = client
        .request("GET", "/info", &[], None)?
        .error_for_status("info: GET /info")?;
    Info::parse(&resp.body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::http::{Conn, Version};

    fn fixture_body(rel: &str) -> Vec<u8> {
        let raw = crate::util::vectors::fixture(rel);
        let mut conn = Conn::new(crate::net::http::tests::Duplex::new(&raw));
        let resp = conn.read_response(false).unwrap();
        assert_eq!(resp.version, Version::Rtsp10);
        resp.body
    }

    #[test]
    fn unpaired_apple_tv() {
        let info = Info::parse(&fixture_body("net/appletv-info.rtsp")).unwrap();
        assert_eq!(info.model.as_deref(), Some("AppleTV6,2"));
        assert_eq!(info.name.as_deref(), Some("Livingroom"));
        assert_eq!(info.device_id.as_deref(), Some("AA:BB:CC:00:00:0A"));
        assert_eq!(info.features, 4330070159449382869);
        assert_eq!(
            crate::airplay::discovery::format_features(info.features),
            "0x4A7FDFD5,0x3C177FDE"
        );
        assert_eq!(info.pk.as_deref(), Some(&(0..32).collect::<Vec<u8>>()[..]));
        assert!(info.uses_ptp());
        assert!(info.displays.is_empty());
        let caps = info.capabilities();
        assert_eq!((caps.max_width, caps.max_height), (1920, 1080));
        assert_eq!(caps.video_codecs, [VideoCodec::H264, VideoCodec::Hevc]);
    }

    #[test]
    fn verified_apple_tv() {
        // Captured over the encrypted channel after pair-verify.
        let body = crate::util::vectors::fixture("airplay/appletv-info-verified.bplist");
        let info = Info::parse(&body).unwrap();
        assert_eq!(info.model.as_deref(), Some("AppleTV6,2"));
        assert_eq!(info.device_id.as_deref(), Some("AA:BB:CC:00:00:0A"));
        assert_eq!(info.source_version.as_deref(), Some("960.13.1"));
        assert_eq!(info.features, 4330070159449382869);
        assert_eq!(info.features_ex.as_deref(), Some("1d9/St5/Fzw4oY58"));
        assert_eq!(info.status_flags, Some(0x644));
        assert_eq!(info.hdr_capability.as_deref(), Some("4k30"));
        assert_eq!(info.has_udp_mirroring, Some(true));
        assert_eq!(info.pk.as_deref(), Some(&(0..32).collect::<Vec<u8>>()[..]));
        assert_eq!(
            info.supported_formats,
            SupportedFormats {
                audio_stream: Some(21235712),
                screen_stream: Some(21235712),
                buffer_stream: Some(-577021992844656640i64 as u64),
                low_latency_audio_stream: Some(0),
            }
        );
        assert!(info.displays.is_empty() && info.audio_formats.is_empty());
        assert!(info.has(features::SCREEN) && info.uses_ptp());
        let caps = info.capabilities();
        assert_eq!((caps.max_width, caps.max_height), (1920, 1080));
        assert_eq!(caps.max_fps, Ratio::integer(60));
        assert_eq!(caps.video_codecs, [VideoCodec::H264, VideoCodec::Hevc]);
        assert_eq!(caps.audio_family, AudioFamily::AirPlay);
        assert_eq!(caps.audio_formats.len(), 1);
        assert_eq!(caps.min_latency_ms, None);
    }

    #[test]
    fn lenient_fields() {
        let p = Plist::dict()
            .with("features", -1i64)
            .with("name", 5i64)
            .with(
                "displays",
                Plist::array([
                    Plist::dict()
                        .with("widthPixels", 1280.0)
                        .with("heightPixels", 720i64)
                        .with("refreshRate", 1.0 / 50.0),
                    Plist::from("junk"),
                ]),
            )
            .with(
                "audioLatencies",
                Plist::array([Plist::dict()
                    .with("type", 96i64)
                    .with("outputLatencyMicros", 20_500i64)]),
            );
        let info = Info::from_plist(p).unwrap();
        assert_eq!(info.features, u64::MAX);
        assert_eq!(info.name, None);
        assert_eq!(info.displays.len(), 1);
        let caps = info.capabilities();
        assert_eq!((caps.max_width, caps.max_height), (1280, 720));
        assert_eq!(caps.max_fps, Ratio::integer(50));
        assert_eq!(caps.min_latency_ms, Some(21));
        assert!(Info::from_plist(Plist::from("x")).is_err());
        assert!(Info::parse(b"bplist00garbage").is_err());
    }
}
