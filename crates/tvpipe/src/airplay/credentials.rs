//! Persisted AirPlay pairing state: our controller identity
//! (an Ed25519 key pair plus a pairing identifier, generated once) and the
//! receivers we paired with (their identifier and long-term public key).
//!
//! The store is a small line-based text item, `credentials` in the
//! session's [`Storage`] (`credentials.txt` in a directory):
//!
//! ```text
//! # tvpipe AirPlay credentials: private, do not share
//! controller = 5B3C1A0E-...-UUID
//! seed = <64 hex digits>
//!
//! receiver = <identifier the receiver sent in pair-setup M6, as hex>
//! pk = <64 hex digits>
//! name = Livingroom (2)
//! deviceid = AA:BB:CC:00:00:0A
//! addr = 192.168.1.34:7000
//! ```
//!
//! A receiver paired with the legacy raw (non-TLV) pair-setup (spec
//! `airplay-mirroring.md` Appendix A) additionally has `pairing = raw`;
//! without that line a receiver is a HAP pairing, so older files load
//! unchanged.
//!
//! A receiver whose PTP setup failed (spec §2.5) gets a block of its own,
//! keyed by its `/info` `deviceID` and `sourceVersion`, so later sessions
//! use NTP with it at once (a software update makes it try PTP again):
//!
//! ```text
//! ptp-failed = AA:BB:CC:00:00:0B
//! srcvers = 377.40.00
//! name = Frame
//! ```
//!
//! Blocks are separated by blank lines; `#` starts a comment line. Unknown
//! keys are ignored, so later versions can add fields. Saving writes a
//! temporary file next to the store and renames it over the old one, with
//! permissions 0600 on unix.

use std::fmt::Write as _;

use crate::airplay::options::ReceiverKey;
use crate::crypto::ring::{random_array, Ed25519KeyPair, ED25519_PUBLIC_KEY_LEN};
use crate::error::{Error, Result};
use crate::storage::{Storage, CREDENTIALS};
use crate::util::hex;

/// Our long-term controller identity.
#[derive(Debug)]
pub struct Identity {
    /// The pairing identifier we present (an upper-case UUID).
    pub id: String,
    pub key: Ed25519KeyPair,
}

impl Identity {
    /// A fresh identity: a random Ed25519 key and a random v4 UUID.
    pub fn generate() -> Result<Identity> {
        Ok(Identity {
            id: random_uuid()?,
            key: Ed25519KeyPair::generate()?,
        })
    }

    pub fn public_key(&self) -> [u8; ED25519_PUBLIC_KEY_LEN] {
        self.key.public_key()
    }
}

/// A random version 4 UUID, upper case (the form Apple devices use).
pub fn random_uuid() -> Result<String> {
    let mut b: [u8; 16] = random_array()?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(&b).to_uppercase();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

/// A receiver we paired with.
#[derive(Clone, PartialEq, Eq)]
pub struct Receiver {
    /// The identifier the receiver sent in pair-setup M6 (and signs in
    /// pair-verify M2).
    pub id: Vec<u8>,
    /// Its long-term Ed25519 public key.
    pub public_key: [u8; ED25519_PUBLIC_KEY_LEN],
    /// Display name at pairing time.
    pub name: String,
    /// The TXT `deviceid`, if known.
    pub device_id: Option<String>,
    /// The last address we reached it at (`ip:port`).
    pub addr: Option<String>,
    /// A legacy raw pairing (`pairing = raw`): `public_key` came from raw
    /// pair-setup and `id` is ours (raw pairing has no receiver id).
    pub raw: bool,
}

impl std::fmt::Debug for Receiver {
    /// Abbreviates the key so logs stay short and do not carry it.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Receiver")
            .field("id", &self.id_display())
            .field(
                "public_key",
                &format_args!("{}..", hex::encode(&self.public_key[..4])),
            )
            .field("name", &self.name)
            .field("device_id", &self.device_id)
            .field("addr", &self.addr)
            .field("raw", &self.raw)
            .finish()
    }
}

impl Receiver {
    /// The identifier for display (lossy UTF-8).
    pub fn id_display(&self) -> String {
        String::from_utf8_lossy(&self.id).into_owned()
    }
}

/// What a lookup knows about the target.
#[derive(Debug, Clone, Default)]
pub struct Query<'a> {
    /// The receiver's TXT `pk` (its long-term key on Apple devices).
    pub public_key: Option<&'a [u8]>,
    pub device_id: Option<&'a str>,
    /// Names the device answers to (case-insensitive).
    pub names: Vec<&'a str>,
    /// `ip` or `ip:port`.
    pub addr: Option<&'a str>,
}

impl Query<'_> {
    fn matches(&self, r: &Receiver) -> bool {
        if let Some(pk) = self.public_key {
            if pk == r.public_key {
                return true;
            }
        }
        if let (Some(want), Some(have)) = (self.device_id, &r.device_id) {
            if want.eq_ignore_ascii_case(have) {
                return true;
            }
        }
        if self
            .names
            .iter()
            .any(|n| n.to_lowercase() == r.name.to_lowercase())
        {
            return true;
        }
        if let (Some(want), Some(have)) = (self.addr, &r.addr) {
            if want == have || have.rsplit_once(':').is_some_and(|(ip, _)| ip == want) {
                return true;
            }
        }
        false
    }
}

/// A receiver PTP failed with (spec §2.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtpFailed {
    pub key: ReceiverKey,
    /// Its name then, for people reading the file.
    pub name: String,
}

/// The credential store, loaded in memory.
#[derive(Debug)]
pub struct Store {
    storage: Storage,
    pub identity: Identity,
    pub receivers: Vec<Receiver>,
    pub ptp_failed: Vec<PtpFailed>,
}

const HEADER: &str = "# tvpipe AirPlay credentials: private, do not share\n";

impl Store {
    /// Loads the store from `storage`, creating a new identity (and
    /// saving it) if there is none yet.
    pub fn open(storage: &Storage) -> Result<Store> {
        if let Some(store) = Store::load(storage)? {
            return Ok(store);
        }
        let store = Store {
            storage: storage.clone(),
            identity: Identity::generate()?,
            receivers: Vec::new(),
            ptp_failed: Vec::new(),
        };
        debug!("created controller identity {}", store.identity.id);
        store.save()?;
        Ok(store)
    }

    /// Loads the store from `storage` without creating one.
    pub fn load(storage: &Storage) -> Result<Option<Store>> {
        match storage.load(CREDENTIALS)? {
            Some(text) => Ok(Some(Store::parse(storage, &text)?)),
            None => Ok(None),
        }
    }

    /// Where the store is, for messages: the file of a directory storage.
    pub fn location(&self) -> String {
        self.storage.describe(CREDENTIALS)
    }

    /// The file of a directory storage.
    pub fn file(&self) -> Option<std::path::PathBuf> {
        self.storage.file(CREDENTIALS)
    }

    pub fn find(&self, q: &Query<'_>) -> Option<&Receiver> {
        // Key and device id beat names and addresses.
        let strong = Query {
            public_key: q.public_key,
            device_id: q.device_id,
            ..Query::default()
        };
        self.receivers
            .iter()
            .find(|r| strong.matches(r))
            .or_else(|| self.receivers.iter().find(|r| q.matches(r)))
    }

    /// Adds `r`, replacing any receiver with the same id or public key.
    pub fn upsert(&mut self, r: Receiver) {
        self.receivers
            .retain(|o| o.id != r.id && o.public_key != r.public_key);
        self.receivers.push(r);
    }

    /// Removes the receivers matching `q`; returns them.
    pub fn remove(&mut self, q: &Query<'_>) -> Vec<Receiver> {
        let mut removed = Vec::new();
        while let Some(r) = self.find(q).cloned() {
            self.receivers.retain(|o| *o != r);
            removed.push(r);
        }
        removed
    }

    /// Whether PTP failed with this receiver (this software version).
    pub fn ptp_failed(&self, key: &ReceiverKey) -> bool {
        self.ptp_failed.iter().any(|p| p.key == *key)
    }

    /// Records that PTP failed with it (replacing an older version's
    /// record); [`save`](Store::save) persists it.
    pub fn remember_ptp_failed(&mut self, key: &ReceiverKey, name: &str) {
        self.ptp_failed
            .retain(|p| !p.key.device_id.eq_ignore_ascii_case(&key.device_id));
        self.ptp_failed.push(PtpFailed {
            key: key.clone(),
            name: name.to_owned(),
        });
    }

    /// Parses the file format (see the module docs).
    pub fn parse(storage: &Storage, text: &str) -> Result<Store> {
        let err = |line: usize, msg: &str| {
            Error::malformed(format!(
                "credentials: {}:{line}: {msg}",
                storage.describe(CREDENTIALS)
            ))
        };
        let mut identity: Option<Identity> = None;
        let mut receivers = Vec::new();
        let mut ptp_failed = Vec::new();
        for block in blocks(text) {
            let line = block.line;
            let (first, _) = &block.entries[0];
            match first.as_str() {
                "controller" => {
                    if identity.is_some() {
                        return Err(err(line, "more than one controller block"));
                    }
                    let id = block.get("controller").unwrap_or_default().to_owned();
                    if id.is_empty() {
                        return Err(err(line, "empty controller id"));
                    }
                    let seed = block
                        .get("seed")
                        .ok_or_else(|| err(line, "controller without seed"))?;
                    let seed = hex::decode(seed).map_err(|_| err(line, "bad seed hex"))?;
                    let key = Ed25519KeyPair::from_seed_slice(&seed)
                        .map_err(|_| err(line, "seed must be 32 bytes"))?;
                    identity = Some(Identity { id, key });
                }
                "receiver" => {
                    let id = hex::decode(block.get("receiver").unwrap_or_default())
                        .map_err(|_| err(line, "bad receiver id hex"))?;
                    if id.is_empty() {
                        return Err(err(line, "empty receiver id"));
                    }
                    let pk = block
                        .get("pk")
                        .ok_or_else(|| err(line, "receiver without pk"))?;
                    let pk = hex::decode(pk).map_err(|_| err(line, "bad pk hex"))?;
                    let public_key: [u8; ED25519_PUBLIC_KEY_LEN] = pk
                        .as_slice()
                        .try_into()
                        .map_err(|_| err(line, "pk must be 32 bytes"))?;
                    let opt = |k: &str| block.get(k).filter(|v| !v.is_empty()).map(str::to_owned);
                    receivers.push(Receiver {
                        id,
                        public_key,
                        name: block.get("name").unwrap_or_default().to_owned(),
                        device_id: opt("deviceid"),
                        addr: opt("addr"),
                        raw: block.get("pairing") == Some("raw"),
                    });
                }
                "ptp-failed" => {
                    let device_id = block.get("ptp-failed").unwrap_or_default();
                    if device_id.is_empty() {
                        debug!("credentials: ignoring empty ptp-failed at line {line}");
                        continue;
                    }
                    ptp_failed.push(PtpFailed {
                        key: ReceiverKey {
                            device_id: device_id.to_owned(),
                            source_version: block.get("srcvers").unwrap_or_default().to_owned(),
                        },
                        name: block.get("name").unwrap_or_default().to_owned(),
                    });
                }
                other => {
                    debug!("credentials: ignoring unknown block {other:?} at line {line}");
                }
            }
        }
        let identity = identity.ok_or_else(|| err(1, "no controller block"))?;
        Ok(Store {
            storage: storage.clone(),
            identity,
            receivers,
            ptp_failed,
        })
    }

    /// The file contents.
    pub fn to_text(&self) -> String {
        let mut out = String::from(HEADER);
        let _ = write!(
            out,
            "controller = {}\nseed = {}\n",
            clean(&self.identity.id),
            hex::encode(self.identity.key.seed())
        );
        for r in &self.receivers {
            let _ = write!(
                out,
                "\nreceiver = {}\npk = {}\nname = {}\n",
                hex::encode(&r.id),
                hex::encode(&r.public_key),
                clean(&r.name)
            );
            if let Some(d) = &r.device_id {
                let _ = writeln!(out, "deviceid = {}", clean(d));
            }
            if let Some(a) = &r.addr {
                let _ = writeln!(out, "addr = {}", clean(a));
            }
            if r.raw {
                out.push_str("pairing = raw\n");
            }
        }
        for p in &self.ptp_failed {
            let _ = write!(
                out,
                "\nptp-failed = {}\nsrcvers = {}\nname = {}\n",
                clean(&p.key.device_id),
                clean(&p.key.source_version),
                clean(&p.name)
            );
        }
        out
    }

    /// Writes the store (a directory storage writes a temporary file and
    /// renames it, creating the directory if needed).
    pub fn save(&self) -> Result<()> {
        self.storage.save(CREDENTIALS, &self.to_text())
    }
}

/// Values are single-line: control characters become spaces and the value
/// is trimmed, so a hostile mDNS name cannot inject keys.
fn clean(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_owned()
}

struct Block {
    line: usize,
    entries: Vec<(String, String)>,
}

impl Block {
    fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
}

fn blocks(text: &str) -> Vec<Block> {
    let mut out = Vec::new();
    let mut cur = Block {
        line: 0,
        entries: Vec::new(),
    };
    for (idx, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            if !cur.entries.is_empty() {
                out.push(std::mem::replace(
                    &mut cur,
                    Block {
                        line: 0,
                        entries: Vec::new(),
                    },
                ));
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            debug!("credentials: ignoring line {} without '='", idx + 1);
            continue;
        };
        if cur.entries.is_empty() {
            cur.line = idx + 1;
        }
        cur.entries.push((k.trim().to_owned(), v.trim().to_owned()));
    }
    if !cur.entries.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) use crate::storage::tests::temp_dir;

    fn receiver(n: u8) -> Receiver {
        Receiver {
            id: format!("receiver-{n}").into_bytes(),
            public_key: [n; 32],
            name: format!("TV {n}"),
            device_id: Some(format!("AA:BB:CC:00:00:{n:02X}")),
            addr: Some(format!("192.168.1.{n}:7000")),
            raw: false,
        }
    }

    /// A file written before `pairing = raw` existed loads as HAP
    /// pairings and saves byte for byte the same.
    #[test]
    fn old_format_still_loads() {
        let seed = "07".repeat(32);
        let pk = "ab".repeat(32);
        let old = format!(
            "{HEADER}controller = 5B3C1A0E-0000-4000-8000-000000000001\nseed = {seed}\n\n\
             receiver = 41413a4242\npk = {pk}\nname = Livingroom (2)\n\
             deviceid = AA:BB:CC:00:00:0A\naddr = 192.168.1.34:7000\n"
        );
        let store = Store::parse(&Storage::memory(), &old).unwrap();
        assert_eq!(store.receivers.len(), 1);
        assert!(!store.receivers[0].raw);
        assert_eq!(store.receivers[0].name, "Livingroom (2)");
        assert_eq!(store.to_text(), old);
        // A raw pairing round-trips its marker.
        let mut store = store;
        let mut r = receiver(9);
        r.raw = true;
        store.upsert(r.clone());
        let text = store.to_text();
        assert!(text.contains("pairing = raw\n"));
        let again = Store::parse(&Storage::memory(), &text).unwrap();
        assert_eq!(again.receivers[1], r);
        assert!(!again.receivers[0].raw);
        // Saved by a Windows editor: CRLF line ends read the same.
        let crlf = Store::parse(&Storage::memory(), &text.replace('\n', "\r\n")).unwrap();
        assert_eq!(crlf.receivers, again.receivers);
        assert_eq!(crlf.identity.id, again.identity.id);
    }

    #[test]
    fn ptp_failures_round_trip() {
        let mut store = Store::open(&Storage::memory()).unwrap();
        let frame = ReceiverKey {
            device_id: "AA:BB:CC:00:00:0B".into(),
            source_version: "377.40.00".into(),
        };
        assert!(!store.ptp_failed(&frame));
        store.remember_ptp_failed(&frame, "Frame");
        let text = store.to_text();
        assert!(
            text.ends_with("\nptp-failed = AA:BB:CC:00:00:0B\nsrcvers = 377.40.00\nname = Frame\n")
        );
        let again = Store::parse(&Storage::memory(), &text).unwrap();
        assert!(again.ptp_failed(&frame));
        assert_eq!(again.to_text(), text);
        // A new software version replaces the record (and gets PTP again).
        let updated = ReceiverKey {
            source_version: "380.1.0".into(),
            ..frame.clone()
        };
        assert!(!again.ptp_failed(&updated));
        store.remember_ptp_failed(&updated, "Frame");
        assert_eq!(store.ptp_failed.len(), 1);
        assert!(store.ptp_failed(&updated) && !store.ptp_failed(&frame));
    }

    #[test]
    fn create_save_reload() {
        let dir = temp_dir("credentials-roundtrip");
        let path = dir.join("sub").join("credentials.txt");
        let storage = Storage::dir(dir.join("sub"));
        let mut store = Store::open(&storage).unwrap();
        assert!(path.exists());
        assert_eq!(store.identity.id.len(), 36);
        store.upsert(receiver(1));
        store.upsert(receiver(2));
        let mut evil = receiver(3);
        evil.name = "line\nreceiver = 00\r".into();
        store.upsert(evil);
        store.save().unwrap();

        let again = Store::open(&storage).unwrap();
        assert_eq!(again.identity.id, store.identity.id);
        assert_eq!(again.identity.public_key(), store.identity.public_key());
        assert_eq!(again.receivers.len(), 3);
        assert_eq!(again.receivers[0], receiver(1));
        assert_eq!(again.receivers[2].name, "line receiver = 00");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // No temporary files left behind.
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [std::ffi::OsString::from("credentials.txt")]);
    }

    #[test]
    fn find_upsert_remove() {
        let mut store = Store {
            storage: Storage::memory(),
            identity: Identity::generate().unwrap(),
            receivers: vec![receiver(1), receiver(2)],
            ptp_failed: Vec::new(),
        };
        let by_pk = Query {
            public_key: Some(&[2; 32]),
            names: vec!["TV 1"],
            ..Query::default()
        };
        assert_eq!(store.find(&by_pk).unwrap().id, b"receiver-2");
        let by_name = Query {
            names: vec!["tv 1"],
            ..Query::default()
        };
        assert_eq!(store.find(&by_name).unwrap().id, b"receiver-1");
        let by_addr = Query {
            addr: Some("192.168.1.2"),
            ..Query::default()
        };
        assert_eq!(store.find(&by_addr).unwrap().id, b"receiver-2");
        let by_dev = Query {
            device_id: Some("aa:bb:cc:00:00:01"),
            ..Query::default()
        };
        assert_eq!(store.find(&by_dev).unwrap().id, b"receiver-1");
        assert!(store
            .find(&Query {
                names: vec!["nope"],
                ..Query::default()
            })
            .is_none());

        let mut newer = receiver(1);
        newer.name = "Renamed".into();
        store.upsert(newer);
        assert_eq!(store.receivers.len(), 2);
        assert_eq!(store.receivers[1].name, "Renamed");

        let removed = store.remove(&by_dev);
        assert_eq!(removed.len(), 1);
        assert_eq!(store.receivers.len(), 1);
    }

    #[test]
    fn parse_errors_are_errors() {
        let p = &Storage::memory();
        assert!(Store::parse(p, "").is_err());
        assert!(Store::parse(p, "controller = X\nseed = zz\n").is_err());
        assert!(Store::parse(p, "controller = X\nseed = 0011\n").is_err());
        let seed = "00".repeat(32);
        let ok = format!("controller = X\nseed = {seed}\n");
        assert!(Store::parse(p, &ok).is_ok());
        let bad_pk = format!("{ok}\nreceiver = 01\npk = 0102\n");
        assert!(Store::parse(p, &bad_pk).is_err());
        let unknown = format!("# c\n{ok}\nfuture = 1\nx = y\n\ngarbage line\n");
        assert!(Store::parse(p, &unknown).is_ok());
    }

    #[test]
    fn uuid_shape() {
        let u = random_uuid().unwrap();
        let parts: Vec<&str> = u.split('-').collect();
        assert_eq!(
            parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
            [8, 4, 4, 4, 12]
        );
        assert_eq!(&parts[2][..1], "4");
        assert!("89AB".contains(&parts[3][..1]));
    }
}
