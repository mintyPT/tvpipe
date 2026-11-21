//! A game bundle (docs/playshare-design.md §3): a folder or a zip with
//! `tvpipe.json`, and the files below its `root`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::codec::json::Value;
use crate::error::{Error, Result};
use crate::util::zip;

/// The manifest's file name.
pub const MANIFEST: &str = "tvpipe.json";
/// The largest manifest.
const MAX_MANIFEST: usize = 64 * 1024;
/// `players.max` at most.
pub const MAX_PLAYERS: u32 = 1000;
/// The relay's per-connection limits at most.
pub const MAX_MESSAGE: u32 = 1 << 20;
pub const MAX_RATE: u32 = 200;

/// The entry pages, relative to `root`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pages {
    pub host: String,
    pub tv: String,
    pub phone: String,
    pub launcher: Option<String>,
}

/// The relay's per-connection limits (§6.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Largest message from a client, bytes.
    pub message: u32,
    /// Messages per second.
    pub rate: u32,
    /// Messages at once.
    pub burst: u32,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            message: 256 * 1024,
            rate: 20,
            burst: 50,
        }
    }
}

/// `tvpipe.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub name: String,
    pub title: String,
    /// The tvpipe the game is made for (`"0.3"`), checked already.
    pub tvpipe: Option<String>,
    /// The served directory, relative to the manifest (`""`: its own).
    pub root: String,
    pub pages: Pages,
    pub min_players: u32,
    pub max_players: u32,
    /// The TV page's viewport (its layout size in CSS pixels).
    pub tv_size: Option<(u32, u32)>,
    /// `tv.resolution: "fixed"`: the TV gets exactly `tv_size`, people
    /// cannot choose a resolution (else tvpipe scales the page to the
    /// chosen one, the layout unchanged).
    pub tv_fixed: bool,
    pub limits: Limits,
}

fn field(msg: impl std::fmt::Display) -> Error {
    Error::usage(format!("{MANIFEST}: {msg}"))
}

/// A path inside the bundle: `/`-separated, no `..`, `.`, hidden or empty
/// segments, no backslashes or NULs. `None` when it is not one.
pub fn clean_path(p: &str) -> Option<String> {
    let p = p.strip_prefix("./").unwrap_or(p);
    if p.is_empty() || p.starts_with('/') || p.contains('\\') || p.contains('\0') {
        return None;
    }
    let ok = p
        .split('/')
        .all(|s| !s.is_empty() && !s.starts_with('.') && s != "..");
    ok.then(|| p.to_owned())
}

impl Manifest {
    /// Parses and checks a manifest.
    pub fn parse(text: &str) -> Result<Manifest> {
        let v = Value::parse(text).map_err(|e| field(format!("not JSON: {e}")))?;
        if v.as_object().is_none() {
            return Err(field("not a JSON object"));
        }
        let name = v
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| field("\"name\" is missing (a short name like \"my-game\")"))?;
        if name.is_empty()
            || name.len() > 40
            || !name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(field(format!(
                "\"name\" must be 1-40 of a-z, 0-9 and -, not {name:?}"
            )));
        }
        // The tvpipe (and @tvpipe/party) the game is made for.
        let mut tvpipe = None;
        if let Some(t) = v.get("tvpipe").filter(|t| !t.is_null()) {
            let t = t
                .as_str()
                .ok_or_else(|| field("\"tvpipe\" must be a version like \"0.2\""))?;
            super::check::version_compatible(t, env!("CARGO_PKG_VERSION")).map_err(field)?;
            tvpipe = Some(t.to_owned());
        }
        let title = match v.get("title") {
            None | Some(Value::Null) => name.to_owned(),
            Some(t) => t
                .as_str()
                .filter(|t| !t.trim().is_empty() && t.len() <= 80)
                .ok_or_else(|| field("\"title\" must be a short string"))?
                .to_owned(),
        };
        let root = match v.get("root") {
            None | Some(Value::Null) => String::new(),
            Some(r) => {
                let r = r
                    .as_str()
                    .ok_or_else(|| field("\"root\" must be a string"))?;
                let r = r.trim_end_matches('/');
                if r.is_empty() || r == "." {
                    String::new()
                } else {
                    clean_path(r).ok_or_else(|| {
                        field(format!(
                            "\"root\" must be a folder inside the bundle, not {r:?}"
                        ))
                    })?
                }
            }
        };
        let pages = v
            .get("pages")
            .filter(|p| p.as_object().is_some())
            .ok_or_else(|| field("\"pages\" is missing (host, tv and phone)"))?;
        let page = |key: &str, required: bool| -> Result<Option<String>> {
            match pages.get(key) {
                None | Some(Value::Null) if !required => Ok(None),
                None | Some(Value::Null) => Err(field(format!("\"pages.{key}\" is missing"))),
                Some(p) => {
                    let s = p
                        .as_str()
                        .ok_or_else(|| field(format!("\"pages.{key}\" must be a path")))?;
                    clean_path(s).map(Some).ok_or_else(|| {
                        field(format!(
                            "\"pages.{key}\" must be a path inside the bundle, not {s:?}"
                        ))
                    })
                }
            }
        };
        let pages = Pages {
            host: page("host", true)?.unwrap_or_default(),
            tv: page("tv", true)?.unwrap_or_default(),
            phone: page("phone", true)?.unwrap_or_default(),
            launcher: page("launcher", false)?,
        };
        let num = |o: &Value, key: &str, lo: u32, hi: u32, what: &str| -> Result<Option<u32>> {
            match o.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(n) => n
                    .as_u32()
                    .filter(|n| (lo..=hi).contains(n))
                    .map(Some)
                    .ok_or_else(|| field(format!("\"{what}\" must be a whole number {lo}-{hi}"))),
            }
        };
        let (mut min_players, mut max_players) = (1, 8);
        if let Some(p) = v.get("players").filter(|p| !p.is_null()) {
            if p.as_object().is_none() {
                return Err(field("\"players\" must be an object (min, max)"));
            }
            min_players = num(p, "min", 1, MAX_PLAYERS, "players.min")?.unwrap_or(1);
            max_players = num(p, "max", 1, MAX_PLAYERS, "players.max")?.unwrap_or(8);
            if min_players > max_players {
                return Err(field("\"players.min\" is above \"players.max\""));
            }
        }
        let mut tv_size = None;
        let mut tv_fixed = false;
        if let Some(t) = v.get("tv").filter(|t| !t.is_null()) {
            let w = num(t, "width", 160, 3840, "tv.width")?;
            let h = num(t, "height", 120, 2160, "tv.height")?;
            match (w, h) {
                (Some(w), Some(h)) => tv_size = Some((w & !1, h & !1)),
                (None, None) => {}
                _ => return Err(field("\"tv\" needs both width and height")),
            }
            match t.get("resolution") {
                None | Some(Value::Null) => {}
                Some(r) => match r.as_str() {
                    Some("choice") => {}
                    Some("fixed") if tv_size.is_some() => tv_fixed = true,
                    Some("fixed") => {
                        return Err(field(
                            "\"tv.resolution\": \"fixed\" needs tv.width and tv.height",
                        ))
                    }
                    _ => {
                        return Err(field(
                            "\"tv.resolution\" is \"choice\" (the default) or \"fixed\"",
                        ))
                    }
                },
            }
        }
        let mut limits = Limits::default();
        if let Some(l) = v.get("limits").filter(|l| !l.is_null()) {
            if let Some(m) = num(l, "message", 1024, MAX_MESSAGE, "limits.message")? {
                limits.message = m;
            }
            if let Some(r) = num(l, "rate", 1, MAX_RATE, "limits.rate")? {
                limits.rate = r;
            }
            if let Some(b) = num(l, "burst", 1, 10 * MAX_RATE, "limits.burst")? {
                limits.burst = b;
            }
        }
        Ok(Manifest {
            name: name.to_owned(),
            title,
            tvpipe,
            root,
            pages,
            min_players,
            max_players,
            tv_size,
            tv_fixed,
            limits,
        })
    }

    /// The manifest as the API's `info` shows it.
    pub fn to_value(&self) -> Value {
        Value::object()
            .with("name", self.name.as_str())
            .with("title", self.title.as_str())
            .with(
                "players",
                Value::object()
                    .with("min", self.min_players)
                    .with("max", self.max_players),
            )
            .with(
                "pages",
                Value::object()
                    .with("host", format!("/{}", self.pages.host))
                    .with("tv", format!("/{}", self.pages.tv))
                    .with("phone", format!("/{}", self.pages.phone))
                    .with_opt(
                        "launcher",
                        self.pages.launcher.as_ref().map(|l| format!("/{l}")),
                    ),
            )
            .with(
                "tv",
                match self.tv_size {
                    Some((w, h)) => Value::object()
                        .with("width", w)
                        .with("height", h)
                        .with("resolution", if self.tv_fixed { "fixed" } else { "choice" }),
                    None => Value::Null,
                },
            )
    }
}

/// One file: its bytes and an ETag.
#[derive(Debug, Clone)]
pub struct File {
    pub bytes: Vec<u8>,
    pub etag: String,
}

/// What a path below `root` is.
#[derive(Debug)]
pub enum Lookup {
    File(File),
    /// A directory: redirect to `path/`.
    Dir,
    NotFound,
}

enum Source {
    Folder(PathBuf),
    /// Files below `root`, by clean path.
    Zip(HashMap<String, File>),
}

/// A loaded bundle.
pub struct Bundle {
    pub manifest: Manifest,
    source: Source,
    /// What it was opened from, for messages.
    pub origin: PathBuf,
}

impl std::fmt::Debug for Bundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bundle")
            .field("manifest", &self.manifest)
            .field("origin", &self.origin)
            .finish_non_exhaustive()
    }
}

/// A weak ETag from the contents (FNV-1a).
pub fn etag_of(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("W/\"{h:016x}-{:x}\"", bytes.len())
}

impl Bundle {
    /// Opens a folder (with `tvpipe.json`) or a `.zip`, and checks that the
    /// entry pages exist.
    pub fn open(path: &Path) -> Result<Bundle> {
        let meta =
            std::fs::metadata(path).map_err(|e| Error::io(format!("{}", path.display()), e))?;
        let b = if meta.is_dir() {
            Bundle::open_folder(path)?
        } else {
            let data = std::fs::read(path)
                .map_err(|e| Error::io(format!("read {}", path.display()), e))?;
            Bundle::from_zip(&data, path)?
        };
        b.check_pages(path)?;
        Ok(b)
    }

    /// A zip read from `path` (a cached download), named `label` (its
    /// source) in messages and logs.
    pub fn open_zip_as(path: &Path, label: &str) -> Result<Bundle> {
        let data =
            std::fs::read(path).map_err(|e| Error::io(format!("read {}", path.display()), e))?;
        let b = Bundle::from_zip(&data, Path::new(label))?;
        b.check_pages(Path::new(label))?;
        Ok(b)
    }

    /// A zip's file count and unpacked size; `None` for a folder.
    pub fn zip_stats(&self) -> Option<(usize, u64)> {
        match &self.source {
            Source::Zip(files) => Some((
                files.len(),
                files.values().map(|f| f.bytes.len() as u64).sum(),
            )),
            Source::Folder(_) => None,
        }
    }

    /// Every entry page is in the bundle.
    fn check_pages(&self, path: &Path) -> Result<()> {
        let m = &self.manifest;
        let mut pages = vec![
            ("host", &m.pages.host),
            ("tv", &m.pages.tv),
            ("phone", &m.pages.phone),
        ];
        if let Some(l) = &m.pages.launcher {
            pages.push(("launcher", l));
        }
        for (key, p) in pages {
            if !matches!(self.get(p), Lookup::File(_)) {
                let root = if m.root.is_empty() {
                    String::new()
                } else {
                    format!("{}/", m.root)
                };
                return Err(Error::usage(format!(
                    "{}: pages.{key}: {root}{p} is not in the bundle{}",
                    path.display(),
                    if m.root.is_empty() {
                        ""
                    } else {
                        " (is the game built?)"
                    }
                )));
            }
        }
        Ok(())
    }

    fn open_folder(dir: &Path) -> Result<Bundle> {
        let dir =
            std::fs::canonicalize(dir).map_err(|e| Error::io(format!("{}", dir.display()), e))?;
        let mpath = dir.join(MANIFEST);
        let text = std::fs::read(&mpath)
            .map_err(|e| Error::io(format!("{}: no {MANIFEST}", dir.display()), e))?;
        if text.len() > MAX_MANIFEST {
            return Err(field("too large"));
        }
        let manifest = Manifest::parse(&String::from_utf8_lossy(&text))?;
        let root = if manifest.root.is_empty() {
            dir.clone()
        } else {
            let r = dir.join(&manifest.root);
            std::fs::canonicalize(&r).map_err(|e| {
                Error::io(
                    format!(
                        "{}: root {:?} (is the game built?)",
                        dir.display(),
                        manifest.root
                    ),
                    e,
                )
            })?
        };
        if !root.starts_with(&dir) {
            return Err(field("\"root\" leaves the bundle"));
        }
        Ok(Bundle {
            manifest,
            source: Source::Folder(root),
            origin: dir,
        })
    }

    /// A bundle from a zip archive's bytes (`origin` for messages).
    pub fn from_zip(data: &[u8], origin: &Path) -> Result<Bundle> {
        let entries = zip::read(data, zip::Limits::default())
            .map_err(|e| Error::usage(format!("{}: {e}", origin.display())))?;
        // tvpipe.json at the root, or in the one top-level folder. What
        // archivers add beside it does not count: Finder's `__MACOSX/` and
        // hidden names (`.DS_Store`); they are never served anyway.
        let prefix = if entries.iter().any(|e| e.name == MANIFEST) {
            String::new()
        } else {
            let tops: std::collections::BTreeSet<&str> = entries
                .iter()
                .map(|e| e.name.split('/').next().unwrap_or(""))
                .filter(|t| !t.starts_with('.') && *t != "__MACOSX")
                .collect();
            match tops.iter().next() {
                Some(t)
                    if tops.len() == 1
                        && entries.iter().any(|e| e.name == format!("{t}/{MANIFEST}")) =>
                {
                    format!("{t}/")
                }
                _ => {
                    return Err(Error::usage(format!(
                        "{}: no {MANIFEST} at the top of the archive",
                        origin.display()
                    )))
                }
            }
        };
        let mtext = entries
            .iter()
            .find(|e| e.name == format!("{prefix}{MANIFEST}"))
            .map(|e| String::from_utf8_lossy(&e.data).into_owned())
            .unwrap_or_default();
        let manifest = Manifest::parse(&mtext)?;
        let base = if manifest.root.is_empty() {
            prefix
        } else {
            format!("{prefix}{}/", manifest.root)
        };
        let mut files = HashMap::new();
        for e in entries {
            let Some(rel) = e.name.strip_prefix(&base) else {
                continue;
            };
            // Names that are not clean paths are never served.
            let Some(rel) = clean_path(rel) else { continue };
            let etag = etag_of(&e.data);
            files.insert(
                rel,
                File {
                    bytes: e.data,
                    etag,
                },
            );
        }
        Ok(Bundle {
            manifest,
            source: Source::Zip(files),
            origin: origin.to_owned(),
        })
    }

    /// The file at a clean path below `root` (`""` is the root itself).
    pub fn get(&self, rel: &str) -> Lookup {
        match &self.source {
            Source::Zip(files) => {
                if let Some(f) = files.get(rel) {
                    return Lookup::File(f.clone());
                }
                let dir = format!("{rel}/");
                if rel.is_empty() || files.keys().any(|k| k.starts_with(&dir)) {
                    Lookup::Dir
                } else {
                    Lookup::NotFound
                }
            }
            Source::Folder(root) => {
                if rel.is_empty() {
                    return Lookup::Dir;
                }
                let Some(rel) = clean_path(rel) else {
                    return Lookup::NotFound;
                };
                let p = root.join(&rel);
                // Symlinks must stay below the root.
                let Ok(real) = std::fs::canonicalize(&p) else {
                    return Lookup::NotFound;
                };
                if !real.starts_with(root) {
                    return Lookup::NotFound;
                }
                match std::fs::metadata(&real) {
                    Ok(m) if m.is_dir() => Lookup::Dir,
                    Ok(m) if m.is_file() => match std::fs::read(&real) {
                        Ok(bytes) => {
                            let etag = etag_of(&bytes);
                            Lookup::File(File { bytes, etag })
                        }
                        Err(_) => Lookup::NotFound,
                    },
                    _ => Lookup::NotFound,
                }
            }
        }
    }
}

/// The MIME type by extension.
pub fn mime(path: &str) -> &'static str {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "txt" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Percent-decodes a URL path (`None`: bad escapes or not UTF-8).
pub fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
