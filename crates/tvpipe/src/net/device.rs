//! The device model: one entry per physical receiver, merged from its
//! AirPlay, RAOP and Cast advertisements, plus name matching for
//! `--to NAME` (ARCHITECTURE.md, "Discovery").
//!
//! Cast TXT keys and capability bits follow pychromecast (MIT):
//! `pychromecast/discovery.py` and `CastCapability` in
//! `pychromecast/const.py`.

use std::net::IpAddr;

use super::dns::{self, Name};
use super::mdns::{Cache, Instance};
use crate::airplay::discovery::{split_raop_name, AirPlayTxt, Source};
use crate::error::{Error, Result};

pub const AIRPLAY_SERVICE: &str = "_airplay._tcp.local";
pub const RAOP_SERVICE: &str = "_raop._tcp.local";
pub const CAST_SERVICE: &str = "_googlecast._tcp.local";

/// The service types `discover` browses.
pub fn services() -> Vec<Name> {
    [AIRPLAY_SERVICE, RAOP_SERVICE, CAST_SERVICE]
        .iter()
        .filter_map(|s| Name::parse(s).ok())
        .collect()
}

/// Cast capability bits from the `ca` TXT key (pychromecast).
pub mod cast_caps {
    pub const VIDEO_OUT: u64 = 1 << 0;
    pub const VIDEO_IN: u64 = 1 << 1;
    pub const AUDIO_OUT: u64 = 1 << 2;
    pub const AUDIO_IN: u64 = 1 << 3;
    pub const DEV_MODE: u64 = 1 << 4;
    pub const MULTIZONE_GROUP: u64 = 1 << 5;
}

/// What we use from a `_googlecast._tcp` TXT record.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CastTxt {
    /// `fn`: friendly name.
    pub friendly_name: Option<String>,
    /// `md`: model name.
    pub model: Option<String>,
    /// `id`: device UUID (hex, no dashes).
    pub id: Option<String>,
    /// `ca`: capability bitmask (decimal).
    pub capabilities: Option<u64>,
    /// `rs`: status text of the running app, if any.
    pub status: Option<String>,
    /// `ve`: protocol version.
    pub version: Option<String>,
}

impl CastTxt {
    pub fn parse(pairs: &[(String, Option<Vec<u8>>)]) -> CastTxt {
        let get = |key: &str| -> Option<String> {
            pairs
                .iter()
                .find(|(k, _)| k == key)
                .and_then(|(_, v)| v.as_deref())
                .map(|v| String::from_utf8_lossy(v).trim().to_owned())
                .filter(|s| !s.is_empty())
        };
        CastTxt {
            friendly_name: get("fn"),
            model: get("md"),
            id: get("id"),
            capabilities: get("ca")
                .and_then(|v| v.parse().map_err(|_| debug!("cast txt: bad ca {v:?}")).ok()),
            status: get("rs"),
            version: get("ve"),
        }
    }

    pub fn has(&self, cap: u64) -> bool {
        self.capabilities.is_some_and(|c| c & cap == cap)
    }

    /// A multizone (speaker) group rather than a device.
    pub fn is_group(&self) -> bool {
        self.has(cast_caps::MULTIZONE_GROUP)
            || self
                .model
                .as_deref()
                .is_some_and(|m| m.eq_ignore_ascii_case("Google Cast Group"))
    }
}

/// One advertised service of a device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// Instance label, e.g. `Living Room`.
    pub instance: String,
    /// SRV target host, e.g. `Living-Room.local`.
    pub host: String,
    pub port: u16,
    pub addrs: Vec<IpAddr>,
}

impl Endpoint {
    fn from_instance(inst: &Instance) -> Option<Endpoint> {
        let port = inst.port?;
        let mut addrs = inst.addrs.clone();
        if addrs.is_empty() {
            addrs.extend(inst.source);
        }
        if addrs.is_empty() {
            return None;
        }
        Some(Endpoint {
            instance: inst.label(),
            host: inst.host.as_ref().map(Name::to_string).unwrap_or_default(),
            port,
            addrs,
        })
    }

    /// The address to connect to (IPv4 preferred).
    pub fn addr(&self) -> IpAddr {
        self.addrs[0]
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AirPlayEndpoint {
    pub endpoint: Endpoint,
    pub txt: AirPlayTxt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CastEndpoint {
    pub endpoint: Endpoint,
    pub txt: CastTxt,
}

/// One physical receiver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    /// Display name: the AirPlay instance name, else the Cast friendly
    /// name, else the RAOP name.
    pub name: String,
    pub airplay: Option<AirPlayEndpoint>,
    pub raop: Option<AirPlayEndpoint>,
    pub cast: Option<CastEndpoint>,
}

impl Device {
    /// All addresses of all services, without duplicates, IPv4 first.
    pub fn addrs(&self) -> Vec<IpAddr> {
        let mut out: Vec<IpAddr> = Vec::new();
        for ep in self.endpoints() {
            for a in &ep.addrs {
                if !out.contains(a) {
                    out.push(*a);
                }
            }
        }
        out.sort_by_key(|a| a.is_ipv6());
        out
    }

    fn endpoints(&self) -> impl Iterator<Item = &Endpoint> {
        self.airplay
            .as_ref()
            .map(|a| &a.endpoint)
            .into_iter()
            .chain(self.raop.as_ref().map(|a| &a.endpoint))
            .chain(self.cast.as_ref().map(|c| &c.endpoint))
    }

    /// Every name this device answers to.
    pub fn names(&self) -> Vec<&str> {
        let mut out = vec![self.name.as_str()];
        if let Some(a) = &self.airplay {
            push_unique(&mut out, &a.endpoint.instance);
        }
        if let Some(r) = &self.raop {
            push_unique(&mut out, split_raop_name(&r.endpoint.instance).1);
        }
        if let Some(c) = &self.cast {
            if let Some(f) = &c.txt.friendly_name {
                push_unique(&mut out, f);
            }
        }
        out
    }

    pub fn model(&self) -> Option<&str> {
        self.airplay
            .as_ref()
            .and_then(|a| a.txt.model.as_deref())
            .or_else(|| self.raop.as_ref().and_then(|r| r.txt.model.as_deref()))
            .or_else(|| self.cast.as_ref().and_then(|c| c.txt.model.as_deref()))
    }

    /// AirPlay with screen mirroring.
    pub fn airplay_mirroring(&self) -> bool {
        self.airplay
            .as_ref()
            .is_some_and(|a| a.txt.supports_mirroring())
    }

    /// Cast with video output.
    pub fn cast_video(&self) -> bool {
        self.cast
            .as_ref()
            .is_some_and(|c| c.txt.has(cast_caps::VIDEO_OUT))
    }

    fn device_id(&self) -> Option<&str> {
        self.airplay
            .as_ref()
            .and_then(|a| a.txt.deviceid.as_deref())
    }

    fn shares_addr(&self, ep: &Endpoint) -> bool {
        self.endpoints()
            .any(|own| own.addrs.iter().any(|a| ep.addrs.contains(a)))
    }

    fn has_name(&self, name: &str) -> bool {
        self.names().iter().any(|n| eq_name(n, name))
    }
}

fn push_unique<'a>(out: &mut Vec<&'a str>, name: &'a str) {
    if !name.is_empty() && !out.iter().any(|o| eq_name(o, name)) {
        out.push(name);
    }
}

fn eq_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// Builds the merged device list from a browse cache, sorted by name.
pub fn devices(cache: &Cache) -> Vec<Device> {
    let lookup = |s: &str| {
        Name::parse(s)
            .map(|svc| cache.instances(&svc))
            .unwrap_or_default()
    };
    let usable = |inst: &Instance| {
        let ep = Endpoint::from_instance(inst);
        if ep.is_none() {
            debug!("discover: incomplete instance {}", inst.name);
        }
        ep
    };
    let mut out: Vec<Device> = Vec::new();

    for inst in lookup(AIRPLAY_SERVICE) {
        let Some(endpoint) = usable(&inst) else {
            continue;
        };
        let txt = AirPlayTxt::parse(&inst.txt_pairs(), Source::AirPlay);
        out.push(Device {
            name: endpoint.instance.clone(),
            airplay: Some(AirPlayEndpoint { endpoint, txt }),
            raop: None,
            cast: None,
        });
    }

    for inst in lookup(RAOP_SERVICE) {
        let Some(endpoint) = usable(&inst) else {
            continue;
        };
        let txt = AirPlayTxt::parse(&inst.txt_pairs(), Source::Raop);
        let (mac, name) = split_raop_name(&endpoint.instance);
        let name = name.to_owned();
        let free = |d: &&mut Device| d.raop.is_none();
        let slot = match &mac {
            Some(mac) => out
                .iter_mut()
                .filter(free)
                .find(|d| d.device_id().is_some_and(|id| id.eq_ignore_ascii_case(mac))),
            None => None,
        };
        let slot = match slot {
            Some(d) => Some(d),
            None => out
                .iter_mut()
                .filter(free)
                .find(|d| d.shares_addr(&endpoint) || d.has_name(&name)),
        };
        let raop = AirPlayEndpoint { endpoint, txt };
        match slot {
            Some(d) => d.raop = Some(raop),
            None => out.push(Device {
                name,
                airplay: None,
                raop: Some(raop),
                cast: None,
            }),
        }
    }

    for inst in lookup(CAST_SERVICE) {
        let Some(endpoint) = usable(&inst) else {
            continue;
        };
        let txt = CastTxt::parse(&inst.txt_pairs());
        let name = txt
            .friendly_name
            .clone()
            .unwrap_or_else(|| endpoint.instance.clone());
        // Groups are hosted by a member device on its address; never merge
        // them into that device.
        let slot = if txt.is_group() {
            None
        } else {
            out.iter_mut()
                .filter(|d| d.cast.is_none())
                .find(|d| d.shares_addr(&endpoint) || d.has_name(&name))
        };
        let cast = CastEndpoint { endpoint, txt };
        match slot {
            Some(d) => d.cast = Some(cast),
            None => out.push(Device {
                name,
                airplay: None,
                raop: None,
                cast: Some(cast),
            }),
        }
    }

    out.sort_by_key(|d| d.name.to_lowercase());
    out
}

/// Finds the device for `--to QUERY`: an address, an exact name
/// (case-insensitive), or a unique case-insensitive prefix of a name.
pub fn select<'a>(devices: &'a [Device], query: &str) -> Result<&'a Device> {
    if let Ok(addr) = query.parse::<IpAddr>() {
        return devices
            .iter()
            .find(|d| d.addrs().contains(&addr))
            .ok_or_else(|| Error::not_found(format!("no receiver found at {addr}")));
    }
    let q = query.to_lowercase();
    let exact: Vec<&Device> = devices
        .iter()
        .filter(|d| d.names().iter().any(|n| n.to_lowercase() == q))
        .collect();
    let candidates = if exact.is_empty() {
        devices
            .iter()
            .filter(|d| d.names().iter().any(|n| n.to_lowercase().starts_with(&q)))
            .collect()
    } else {
        exact
    };
    match candidates.as_slice() {
        [one] => Ok(one),
        [] => Err(Error::not_found(format!("no receiver named {query:?}"))
            .with_code("no-receiver")
            .with_device(query)),
        many => Err(Error::usage(format!(
            "{query:?} matches several receivers: {}",
            many.iter()
                .map(|d| format!("{:?}", d.name))
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

/// Convenience for tests and fixtures: a cache from raw response packets.
pub fn cache_from_packets<'a>(
    packets: impl IntoIterator<Item = (IpAddr, &'a [u8])>,
) -> Result<Cache> {
    let mut cache = Cache::new();
    for (from, bytes) in packets {
        cache.insert(from, &dns::Message::parse(bytes)?);
    }
    Ok(cache)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::net::dns::{Message, RData, Record, FLAG_AA, FLAG_QR};
    use crate::util::vectors;
    use std::net::Ipv4Addr;

    /// The captured LAN responses (see `tests/fixtures/net/lan-airplay.txt`).
    pub(crate) fn lan_devices() -> Vec<Device> {
        let text =
            std::fs::read_to_string(vectors::path("tests/fixtures/net/lan-airplay.txt")).unwrap();
        let blocks = vectors::parse(&text);
        assert_eq!(blocks.len(), 26);
        let packets: Vec<(IpAddr, Vec<u8>)> = blocks
            .iter()
            .map(|b| (b.parse("from"), b.hex("msg")))
            .collect();
        let cache = cache_from_packets(packets.iter().map(|(ip, m)| (*ip, m.as_slice()))).unwrap();
        devices(&cache)
    }

    #[test]
    fn lan_capture_merges_airplay_and_raop() {
        let devs = lan_devices();
        assert_eq!(devs.len(), 13);
        for d in &devs {
            assert!(
                d.airplay.is_some() && d.raop.is_some(),
                "{} not merged",
                d.name
            );
            assert!(d.cast.is_none());
        }
        let tv = select(&devs, "livingroom").unwrap();
        assert_eq!(tv.name, "Livingroom (2)");
        assert_eq!(tv.model(), Some("AppleTV6,2"));
        assert!(tv.airplay_mirroring());
        let ap = tv.airplay.as_ref().unwrap();
        assert_eq!(ap.endpoint.port, 7000);
        assert_eq!(ap.endpoint.host, "Livingroom.local");
        assert_eq!(
            ap.endpoint.addr(),
            "192.168.1.34".parse::<IpAddr>().unwrap()
        );
        assert_eq!(ap.txt.deviceid.as_deref(), Some("AA:BB:CC:00:00:0A"));
        assert_eq!(ap.txt.features, Some(0x3C17_7FDE_4A7F_DFD5));
        assert_eq!(ap.txt.flags, Some(0x644));
        assert_eq!(ap.txt.osvers.as_deref(), Some("26.6.1"));
        assert_eq!(ap.txt.pk.as_ref().map(Vec::len), Some(32));
        assert!(tv
            .raop
            .as_ref()
            .unwrap()
            .endpoint
            .instance
            .ends_with("@Livingroom"));
        // The Sonos speakers advertise AirPlay audio but not mirroring.
        let sonos = select(&devs, "Kitchen").unwrap();
        assert!(!sonos.airplay_mirroring());
        assert_eq!(sonos.model(), Some("One"));
        assert!(sonos.addrs()[1..].iter().all(IpAddr::is_ipv6));
    }

    #[test]
    fn lan_capture_truncations_never_panic() {
        let text =
            std::fs::read_to_string(vectors::path("tests/fixtures/net/lan-airplay.txt")).unwrap();
        for b in vectors::parse(&text) {
            let msg = b.hex("msg");
            assert!(Message::parse(&msg).is_ok());
            for len in 0..msg.len() {
                assert!(Message::parse(&msg[..len]).is_err());
            }
        }
    }

    #[test]
    fn lan_capture_table() {
        let table = crate::net::discover::to_table(&lan_devices());
        let path = vectors::path("tests/fixtures/net/lan-airplay.table");
        if std::env::var_os("TVPIPE_UPDATE_FIXTURES").is_some() {
            std::fs::write(&path, &table).unwrap();
        }
        let want = std::fs::read_to_string(path).unwrap();
        assert_eq!(table, want);
    }

    #[test]
    fn selection_rules() {
        let devs = lan_devices();
        // Exact (case-insensitive) beats prefix; unique prefixes work.
        assert_eq!(select(&devs, "MARTIN").unwrap().name, "Martin");
        assert_eq!(select(&devs, "bal").unwrap().name, "Balcony");
        assert_eq!(select(&devs, "armin’s").unwrap().model(), Some("Mac17,7"));
        // RAOP names count too.
        assert_eq!(select(&devs, "Livingroom").unwrap().name, "Livingroom (2)");
        assert_eq!(
            select(&devs, "192.168.1.34").unwrap().name,
            "Livingroom (2)"
        );
        let err = select(&devs, "b").unwrap_err();
        assert_eq!(err.kind(), crate::error::ErrorKind::Usage);
        assert!(err.to_string().contains("\"Balcony\""), "{err}");
        let err = select(&devs, "nope").unwrap_err();
        assert_eq!(err.kind(), crate::error::ErrorKind::NotFound);
        // The machine interface's code (docs/machine.md) and the name.
        assert_eq!(
            (err.code(), err.device()),
            (Some("no-receiver"), Some("nope"))
        );
        assert_eq!(
            select(&devs, "10.0.0.1").unwrap_err().kind(),
            crate::error::ErrorKind::NotFound
        );
    }

    fn txt(strings: &[&str]) -> RData {
        RData::Txt(strings.iter().map(|s| s.as_bytes().to_vec()).collect())
    }

    /// A synthetic advertisement (one PTR answer with SRV/TXT/A additionals).
    fn advert(
        service: &str,
        label: &str,
        host: &str,
        port: u16,
        ip: [u8; 4],
        strings: &[&str],
    ) -> Message {
        let svc = Name::parse(service).unwrap();
        let inst = svc.child(label.as_bytes()).unwrap();
        let host = Name::parse(host).unwrap();
        Message {
            flags: FLAG_QR | FLAG_AA,
            answers: vec![Record::new(svc, 10, RData::Ptr(inst.clone()))],
            additionals: vec![
                Record::new(
                    inst.clone(),
                    10,
                    RData::Srv {
                        priority: 0,
                        weight: 0,
                        port,
                        target: host.clone(),
                    },
                ),
                Record::new(inst, 10, txt(strings)),
                Record::new(host, 10, RData::A(Ipv4Addr::from(ip))),
            ],
            ..Message::default()
        }
    }

    /// Cast merging, using TXT keys as documented by pychromecast. (No
    /// Cast device answered on the capture LAN; this one is synthetic.)
    #[test]
    fn cast_merges_by_address_and_keeps_groups_apart() {
        let tv_ip = [192, 168, 1, 50];
        let msgs = [
            advert(
                AIRPLAY_SERVICE,
                "LG TV",
                "LG-TV.local",
                7000,
                tv_ip,
                &["features=0x5A7FFFF7,0x1E", "model=OLED55C3"],
            ),
            advert(
                CAST_SERVICE,
                "LG-TV-00000000000000000000000000000001",
                "00000000-0000-0000-0000-000000000001.local",
                8009,
                tv_ip,
                &[
                    "id=00000000000000000000000000000001",
                    "md=LG TV",
                    "fn=Living TV",
                    "ca=264709",
                    "rs=",
                    "ve=05",
                ],
            ),
            advert(
                CAST_SERVICE,
                "Google-Cast-Group-0000000000000000000000000000000a",
                "00000000-0000-0000-0000-000000000001.local",
                32187,
                tv_ip,
                &[
                    "id=0000000000000000000000000000000a",
                    "md=Google Cast Group",
                    "fn=Everywhere",
                    "ca=199716",
                ],
            ),
            advert(
                CAST_SERVICE,
                "Chromecast-1",
                "cc.local",
                8009,
                [192, 168, 1, 51],
                &["fn=Bedroom TV", "md=Chromecast", "ca=4101"],
            ),
        ];
        let mut cache = Cache::new();
        for m in &msgs {
            cache.insert(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 99)), m);
        }
        let devs = devices(&cache);
        let names: Vec<&str> = devs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, ["Bedroom TV", "Everywhere", "LG TV"]);
        let lg = select(&devs, "living tv").unwrap();
        assert_eq!(lg.name, "LG TV");
        assert!(lg.airplay_mirroring());
        assert!(lg.cast_video());
        let cast = lg.cast.as_ref().unwrap();
        assert_eq!(cast.endpoint.port, 8009);
        assert_eq!(cast.txt.model.as_deref(), Some("LG TV"));
        assert_eq!(cast.txt.status, None);
        assert_eq!(cast.txt.version.as_deref(), Some("05"));
        let group = select(&devs, "everywhere").unwrap();
        assert!(group.cast.as_ref().unwrap().txt.is_group());
        assert!(!group.cast_video());
        assert!(select(&devs, "bedroom").unwrap().cast_video());
    }

    #[test]
    fn cast_txt_lenient() {
        let pairs = crate::net::dns::txt_pairs(&[b"ca=abc".to_vec(), b"fn=".to_vec()]);
        assert_eq!(CastTxt::parse(&pairs), CastTxt::default());
    }
}
