//! SETUP request bodies and responses of a mirroring session (spec §4).
//!
//! - SETUP #1 (control-first): the session dict, no streams (§4.1).
//! - SETUP #2: `{streams: [audio descriptor]}`, layout S
//!   (`streamConnections`) or P (`controlPort`) (§4.6).
//! - SETUP #3: `{streams: [video descriptor]}` (§4.7).
//! - Media-first ordering: SETUP #2 carries the session dict too (§4.12).
//!
//! Sources: docs/airplay-mirroring.md §4.1, §4.6, §4.7, §4.12;
//! vectors tests/vectors/airplay-mirror/setup.txt, appletv-session.txt.

use crate::codec::bplist::{Dict, Plist};

pub const SOURCE_VERSION: &str = "980.71.1";
pub const OS_BUILD_VERSION: &str = "13F69";
pub const MODEL: &str = "Linux";
pub const FAIRPLAY_ET: i64 = 32;
pub const STREAM_TYPE_AUDIO: i64 = 96;
pub const STREAM_TYPE_VIDEO: i64 = 110;
pub const TIMESTAMP_INFO_NAMES: [&str; 5] = ["SubSu", "BePxT", "AfPxT", "BefEn", "EmEnc"];

/// How the session keeps time, as announced in SETUP #1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimingRequest {
    /// `timingPeerInfo` with our peer id and the control socket's local IP.
    Ptp { peer_id: String, address: String },
    /// Our UDP timing port.
    Ntp { port: u16 },
}

/// The session keys of SETUP #1 (or of the media-first SETUP #2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRequest {
    pub device_id: String,
    pub session_uuid: String,
    pub name: String,
    pub timing: TimingRequest,
    /// Legacy profile with FairPlay: `ekey` and `eiv` (`et` = 32).
    pub fairplay: Option<(Vec<u8>, [u8; 16])>,
}

impl SessionRequest {
    /// The dict; `control_first` adds `updateSessionRequest` and
    /// `combinedGetInfoWithControlSetup` (not sent in media-first order).
    pub fn to_plist(&self, control_first: bool) -> Plist {
        let mut d = Plist::dict()
            .with("deviceID", self.device_id.as_str())
            .with("macAddress", self.device_id.as_str())
            .with("sessionUUID", self.session_uuid.as_str())
            .with("sourceVersion", SOURCE_VERSION)
            .with("isScreenMirroringSession", true)
            .with(
                "timingProtocol",
                match self.timing {
                    TimingRequest::Ptp { .. } => "PTP",
                    TimingRequest::Ntp { .. } => "NTP",
                },
            )
            .with("osBuildVersion", OS_BUILD_VERSION)
            .with("model", MODEL)
            .with("name", self.name.as_str());
        if control_first {
            d = d
                .with("updateSessionRequest", false)
                .with("combinedGetInfoWithControlSetup", true);
        }
        match &self.timing {
            TimingRequest::Ntp { port } => d = d.with("timingPort", *port as i64),
            TimingRequest::Ptp { peer_id, address } => {
                let peer = || {
                    Plist::dict()
                        .with("ID", peer_id.as_str())
                        .with("Addresses", Plist::array([address.as_str()]))
                        .with("DeviceType", 0i64)
                        .with("SupportsClockPortMatchingOverride", true)
                };
                d = d
                    .with("timingPeerInfo", peer())
                    .with("timingPeerList", Plist::array([peer()]));
            }
        }
        if let Some((ekey, eiv)) = &self.fairplay {
            d = d
                .with("ekey", Plist::data(ekey.clone()))
                .with("eiv", Plist::data(eiv.to_vec()))
                .with("et", FAIRPLAY_ET);
        }
        d
    }
}

/// The audio codec of the screen stream (§8.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioCodecId {
    Alac,
    AacEld,
}

impl AudioCodecId {
    /// `(ct, spf, audioFormat)`.
    pub fn params(self) -> (i64, i64, i64) {
        match self {
            AudioCodecId::Alac => (2, 352, 0x40000),
            AudioCodecId::AacEld => (8, 480, 0x100_0000),
        }
    }
}

/// Which audio descriptor layout (§4.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioLayout {
    /// `streamConnections` (feature 59).
    S,
    /// Flat `controlPort`.
    P,
}

impl AudioLayout {
    pub fn other(self) -> AudioLayout {
        match self {
            AudioLayout::S => AudioLayout::P,
            AudioLayout::P => AudioLayout::S,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioRequest {
    pub stream_id: u64,
    pub codec: AudioCodecId,
    /// Audio lead in samples.
    pub latency_max: u32,
    /// `latencyMin` in samples: 0, the lead for an LG TV (§2.7).
    pub latency_min: u32,
    pub layout: AudioLayout,
    /// HAP profile: the 32-byte ChaCha audio key.
    pub shk: Option<[u8; 32]>,
    /// Our audio control (RTCP) port.
    pub control_port: u16,
    /// Layout S only: the MediaDataControl seed (§8.10).
    pub mdc_seed: Option<u64>,
}

impl AudioRequest {
    pub fn descriptor(&self) -> Plist {
        let (ct, spf, fmt) = self.codec.params();
        let mut d = Plist::dict()
            .with("type", STREAM_TYPE_AUDIO)
            .with("streamConnectionID", self.stream_id as i64)
            .with("ct", ct)
            .with("spf", spf)
            .with("sr", 44_100i64)
            .with("audioFormat", fmt)
            .with("audioMode", "default")
            .with("usingScreen", true)
            .with("latencyMin", self.latency_min as i64)
            .with("latencyMax", self.latency_max as i64)
            .with("redundantAudio", 2i64);
        match self.layout {
            AudioLayout::S => {
                d = d
                    .with("isMedia", false)
                    .with("supportsDynamicStreamID", true)
                    .with_opt("shk", self.shk.map(|k| Plist::data(k.to_vec())))
                    .with(
                        "streamConnections",
                        Plist::dict()
                            .with(
                                "streamConnectionTypeRTP",
                                Plist::dict().with(
                                    "streamConnectionKeyUseStreamEncryptionKey",
                                    self.shk.is_some(),
                                ),
                            )
                            .with(
                                "streamConnectionTypeRTCP",
                                Plist::dict()
                                    .with("streamConnectionKeyPort", self.control_port as i64),
                            )
                            .with_opt(
                                "streamConnectionTypeMediaDataControl",
                                self.mdc_seed.map(|seed| {
                                    Plist::dict()
                                        .with("streamConnectionKeyEncryptionSeed", seed as i64)
                                }),
                            ),
                    );
            }
            AudioLayout::P => {
                d = d
                    .with("controlPort", self.control_port as i64)
                    .with_opt("shk", self.shk.map(|k| Plist::data(k.to_vec())));
            }
        }
        d
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoRequest {
    pub stream_id: u64,
    pub latency_ms: u32,
    pub shk: [u8; 16],
    pub shiv: [u8; 16],
}

impl VideoRequest {
    pub fn descriptor(&self) -> Plist {
        Plist::dict()
            .with("type", STREAM_TYPE_VIDEO)
            .with("streamConnectionID", self.stream_id as i64)
            .with("latencyMs", self.latency_ms as i64)
            .with(
                "timestampInfo",
                Plist::array(
                    TIMESTAMP_INFO_NAMES
                        .iter()
                        .map(|n| Plist::dict().with("name", *n)),
                ),
            )
            .with("shk", Plist::data(self.shk.to_vec()))
            .with("shiv", Plist::data(self.shiv.to_vec()))
    }
}

/// `{streams: [descriptor]}`, optionally merged into a session dict.
pub fn streams_body(descriptor: Plist, session: Option<Plist>) -> Plist {
    session
        .unwrap_or_else(Plist::dict)
        .with("streams", Plist::array([descriptor]))
}

// ---------------------------------------------------------------------------
// Responses

fn int(p: Option<&Plist>) -> Option<i128> {
    p.and_then(Plist::as_i128)
}

fn port(p: Option<&Plist>) -> Option<u16> {
    int(p)
        .and_then(|v| u16::try_from(v).ok())
        .filter(|&p| p > 0)
}

/// A 64-bit value sent as a (possibly negative) bplist int.
pub fn bits64(p: Option<&Plist>) -> Option<u64> {
    int(p)
        .filter(|v| *v >= i64::MIN as i128 && *v <= u64::MAX as i128)
        .map(|v| v as u64)
}

/// The session keys of a SETUP response (§4.1, §4.12).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionResponse {
    pub event_port: Option<u16>,
    /// `timingPeerInfo.ClockID` (0 counts as missing).
    pub clock_id: Option<u64>,
    pub has_timing_peer_info: bool,
    pub async_ptp: bool,
    pub timing_port: Option<u16>,
    pub skip_record: bool,
    pub info: Option<Plist>,
}

impl SessionResponse {
    pub fn parse(p: &Plist) -> SessionResponse {
        let tpi = p.get("timingPeerInfo").and_then(Plist::as_dict);
        let flag = |k: &str| p.get(k).and_then(Plist::as_bool).unwrap_or(false);
        SessionResponse {
            event_port: port(p.get("eventPort")),
            clock_id: bits64(tpi.and_then(|d| d.get("ClockID"))).filter(|&c| c != 0),
            has_timing_peer_info: tpi.is_some(),
            async_ptp: flag("asyncPTPClockConfig"),
            timing_port: port(p.get("timingPort")),
            skip_record: flag("skipRecord"),
            info: p.get("info").filter(|i| i.as_dict().is_some()).cloned(),
        }
    }
}

/// The first stream dict of a SETUP response.
fn first_stream(p: &Plist) -> Option<&Dict> {
    p.get("streams")?.as_array()?.first()?.as_dict()
}

/// Receiver ports for audio (§4.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioPorts {
    pub rtp: u16,
    pub rtcp: u16,
    pub media_data_control: Option<u16>,
}

/// The audio ports from a SETUP #2 response; `None` means "no audio".
pub fn parse_audio_response(p: &Plist) -> Option<AudioPorts> {
    let s = first_stream(p)?;
    let sc = s.get("streamConnections").and_then(Plist::as_dict);
    let sc_port = |kind: &str| {
        port(
            sc.and_then(|d| d.get(kind))
                .and_then(|k| k.get("streamConnectionKeyPort")),
        )
    };
    let rtp = sc_port("streamConnectionTypeRTP").or_else(|| port(s.get("dataPort")))?;
    let rtcp = sc_port("streamConnectionTypeRTCP").or_else(|| port(s.get("controlPort")))?;
    Some(AudioPorts {
        rtp,
        rtcp,
        media_data_control: sc_port("streamConnectionTypeMediaDataControl"),
    })
}

/// The video `dataPort` from a SETUP #3 response.
pub fn parse_video_response(p: &Plist) -> Option<u16> {
    port(first_stream(p)?.get("dataPort"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::util::vectors;

    /// Sorts dict keys recursively so dicts compare by content.
    pub(crate) fn canon(p: &Plist) -> Plist {
        match p {
            Plist::Dict(d) => {
                let mut items: Vec<(String, Plist)> =
                    d.iter().map(|(k, v)| (k.to_owned(), canon(v))).collect();
                items.sort_by(|a, b| a.0.cmp(&b.0));
                Plist::Dict(items.into_iter().collect())
            }
            Plist::Array(a) => Plist::Array(a.iter().map(canon).collect()),
            other => other.clone(),
        }
    }

    fn vector(prefix: &str) -> Plist {
        let b = vectors::load("airplay-mirror/setup.txt")
            .into_iter()
            .find(|b| b.name().starts_with(prefix))
            .unwrap_or_else(|| panic!("no block {prefix}"));
        Plist::from_bytes(&b.hex("bplist")).unwrap()
    }

    fn ramp(start: u8, n: usize) -> Vec<u8> {
        (0..n).map(|i| start.wrapping_add(i as u8)).collect()
    }

    fn session(timing: TimingRequest) -> SessionRequest {
        SessionRequest {
            device_id: "02:34:73:DA:E2:DF".into(),
            session_uuid: "6cbd17e2-06f0-4c62-917a-551f29c8ca3b".into(),
            name: "saratoga".into(),
            timing,
            fairplay: None,
        }
    }

    #[test]
    fn setup1_vectors() {
        let ptp = session(TimingRequest::Ptp {
            peer_id: "649878b7-ccc2-4429-ae73-48a483b85571".into(),
            address: "192.168.1.101".into(),
        });
        assert_eq!(
            canon(&ptp.to_plist(true)),
            canon(&vector("SETUP 1 (session, PTP, HAP)"))
        );
        let mut ntp = session(TimingRequest::Ntp { port: 50000 });
        ntp.fairplay = Some((ramp(0, 72), ramp(0xf0, 16).try_into().unwrap()));
        assert_eq!(
            canon(&ntp.to_plist(true)),
            canon(&vector("SETUP 1 (session, NTP, legacy"))
        );
        // Media-first: no update/combined keys, plus the streams.
        let mf = ntp.to_plist(false);
        assert!(mf.get("updateSessionRequest").is_none());
        assert!(mf.get("combinedGetInfoWithControlSetup").is_none());
    }

    #[test]
    fn setup2_vectors() {
        let mut a = AudioRequest {
            stream_id: 1794957874532018000,
            codec: AudioCodecId::Alac,
            latency_max: 3748,
            latency_min: 0,
            layout: AudioLayout::S,
            shk: Some(ramp(0x80, 32).try_into().unwrap()),
            control_port: 50001,
            mdc_seed: None,
        };
        assert_eq!(
            canon(&streams_body(a.descriptor(), None)),
            canon(&vector("SETUP 2 (audio stream, streamConnections"))
        );
        a.layout = AudioLayout::P;
        a.shk = None;
        assert_eq!(
            canon(&streams_body(a.descriptor(), None)),
            canon(&vector("SETUP 2 (audio stream, controlPort"))
        );
    }

    #[test]
    fn setup3_vector() {
        let v = VideoRequest {
            stream_id: 1794957874731085000,
            latency_ms: 75,
            shk: ramp(0, 16).try_into().unwrap(),
            shiv: ramp(0xf0, 16).try_into().unwrap(),
        };
        assert_eq!(
            canon(&streams_body(v.descriptor(), None)),
            canon(&vector("SETUP 3 (video stream"))
        );
    }

    fn session_blocks() -> Vec<vectors::Block> {
        vectors::load("airplay-mirror/appletv-session.txt")
    }

    #[test]
    fn appletv_responses() {
        let setups: Vec<Plist> = session_blocks()
            .iter()
            .filter(|b| b.name().starts_with("Apple TV response to SETUP"))
            .map(|b| Plist::from_bytes(&b.hex("response_bplist")).unwrap())
            .collect();
        assert_eq!(setups.len(), 3);
        let s = SessionResponse::parse(&setups[0]);
        assert!(s.event_port.is_some());
        assert_eq!(s.clock_id, Some(0xaabb_ccff_fe00_000a));
        assert!(s.has_timing_peer_info && !s.async_ptp && !s.skip_record);
        assert!(s.info.is_none() && s.timing_port.is_none());
        let a = parse_audio_response(&setups[1]).unwrap();
        assert!(a.rtp > 0 && a.rtcp > 0);
        assert!(a.media_data_control.is_some());
        assert!(parse_video_response(&setups[2]).is_some());
        assert_eq!(parse_audio_response(&setups[2]), None);
        assert_eq!(parse_video_response(&setups[1]), None);
        // The real requests decode to what our builders produce, keys aside.
        let reqs: Vec<Plist> = session_blocks()
            .iter()
            .filter_map(|b| b.get("request_bplist").map(|_| b.hex("request_bplist")))
            .map(|b| Plist::from_bytes(&b).unwrap())
            .collect();
        let keys = |p: &Plist| -> Vec<String> {
            let mut k: Vec<String> = p.as_dict().unwrap().keys().map(str::to_owned).collect();
            k.sort();
            k
        };
        let ptp = session(TimingRequest::Ptp {
            peer_id: "x".into(),
            address: "y".into(),
        });
        assert_eq!(keys(&reqs[0]), keys(&ptp.to_plist(true)));
        let sent_audio = &reqs[1].get("streams").unwrap()[0];
        let mut ours = AudioRequest {
            stream_id: 1,
            codec: AudioCodecId::Alac,
            latency_max: 3748,
            latency_min: 0,
            layout: AudioLayout::S,
            shk: Some([0; 32]),
            control_port: 53817,
            mdc_seed: Some(1),
        }
        .descriptor();
        let mut sent_audio = sent_audio.clone();
        // The seed is random; compare the rest.
        for d in [&mut ours, &mut sent_audio] {
            if let Some(m) = d
                .as_dict_mut()
                .and_then(|d| d.get_mut("streamConnections"))
                .and_then(Plist::as_dict_mut)
                .and_then(|d| d.get_mut("streamConnectionTypeMediaDataControl"))
                .and_then(Plist::as_dict_mut)
            {
                m.insert("streamConnectionKeyEncryptionSeed", 0i64);
            }
        }
        assert_eq!(keys(&sent_audio), keys(&ours));
        for k in ["streamConnectionID", "shk"] {
            ours.as_dict_mut().unwrap().remove(k);
            sent_audio.as_dict_mut().unwrap().remove(k);
        }
        assert_eq!(canon(&sent_audio), canon(&ours));
        let sent_video = &reqs[2].get("streams").unwrap()[0];
        let v = VideoRequest {
            stream_id: 1,
            latency_ms: 75,
            shk: [0; 16],
            shiv: [0; 16],
        }
        .descriptor();
        assert_eq!(keys(sent_video), keys(&v));
    }

    #[test]
    fn ports_both_layouts() {
        let flat = streams_body(
            Plist::dict()
                .with("type", 96i64)
                .with("dataPort", 6000i64)
                .with("controlPort", 6001i64),
            None,
        );
        assert_eq!(
            parse_audio_response(&flat),
            Some(AudioPorts {
                rtp: 6000,
                rtcp: 6001,
                media_data_control: None
            })
        );
        let both = streams_body(
            Plist::dict()
                .with("dataPort", 6000i64)
                .with("controlPort", 6001i64)
                .with(
                    "streamConnections",
                    Plist::dict().with(
                        "streamConnectionTypeRTP",
                        Plist::dict().with("streamConnectionKeyPort", 7000i64),
                    ),
                ),
            None,
        );
        assert_eq!(parse_audio_response(&both).unwrap().rtp, 7000);
        assert_eq!(parse_audio_response(&both).unwrap().rtcp, 6001);
        assert_eq!(parse_audio_response(&Plist::dict()), None);
        assert_eq!(
            parse_audio_response(&streams_body(Plist::dict().with("dataPort", -1i64), None)),
            None
        );
    }
}
