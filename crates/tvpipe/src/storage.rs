//! Where pairings and the player page's token live ([`Storage`]).
//!
//! Three text items: `credentials` (the AirPlay controller identity, one
//! block per paired receiver and one per receiver PTP failed with, the
//! format of `airplay::credentials`) and `player-token` (the browser
//! player page's token, so its URL stays the same across runs), both
//! secret, and `tv-lag` (each TV's display lag as matched by its Sync
//! in `tvpipe game play`: [`Storage::tv_lags`]).
//!
//! A program keeps them in its own directory by default
//! ([`Storage::app`]); [`Storage::cli`] shares the `tvpipe` CLI's,
//! [`Storage::memory`] keeps nothing on disk and [`Storage::custom`] puts
//! them wherever the program wants (a keychain, a save game).
//!
//! Directory stores write a temporary file and rename it (mode 0600 on
//! unix). `cfg(target_os)` here only picks the platform's config
//! directory (ARCHITECTURE.md, "Platform-Specific Code").

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::error::{Error, Result};

/// The item holding the AirPlay pairings.
pub const CREDENTIALS: &str = "credentials";
/// The item holding the browser player page's token.
pub const PLAYER_TOKEN: &str = "player-token";
/// The item holding the TVs' display lags ([`Storage::tv_lags`]).
pub const TV_LAG: &str = "tv-lag";
/// The largest display lag kept, ms.
pub const MAX_TV_LAG_MS: u32 = 2000;

/// Overrides the CLI's config directory ([`Storage::cli`]).
pub const CONFIG_DIR_ENV: &str = "TVPIPE_CONFIG_DIR";

/// A program's own storage for [`Storage::custom`]: text items by name
/// (`"credentials"`, `"player-token"`).
pub trait StorageBackend: Send + Sync + 'static {
    /// The item's text, or `None` if it was never saved.
    fn load(&self, item: &str) -> io::Result<Option<String>>;
    /// Replaces the item's text.
    fn save(&self, item: &str, text: &str) -> io::Result<()>;
}

/// A [`StorageBackend`] from two closures (see [`storage_fn`]).
pub struct StorageFn<L, S> {
    load: L,
    save: S,
}

/// A backend from a load and a save function:
/// `Storage::custom(storage_fn(|item| load(item), |item, text| save(item, text)))`.
pub fn storage_fn<L, S>(load: L, save: S) -> StorageFn<L, S>
where
    L: Fn(&str) -> io::Result<Option<String>> + Send + Sync + 'static,
    S: Fn(&str, &str) -> io::Result<()> + Send + Sync + 'static,
{
    StorageFn { load, save }
}

impl<L, S> StorageBackend for StorageFn<L, S>
where
    L: Fn(&str) -> io::Result<Option<String>> + Send + Sync + 'static,
    S: Fn(&str, &str) -> io::Result<()> + Send + Sync + 'static,
{
    fn load(&self, item: &str) -> io::Result<Option<String>> {
        (self.load)(item)
    }

    fn save(&self, item: &str, text: &str) -> io::Result<()> {
        (self.save)(item, text)
    }
}

/// How a storage keeps its items.
enum Kind {
    /// One file per item in a directory; `Err` when the directory could
    /// not be determined (the message says why).
    Dir(std::result::Result<PathBuf, String>),
    Memory(Mutex<BTreeMap<String, String>>),
    Custom(Box<dyn StorageBackend>),
}

type OnChange = dyn Fn(&Storage) + Send + Sync;

/// Where pairings and the player token are kept. Cloning shares it.
#[derive(Clone)]
pub struct Storage {
    kind: Arc<Kind>,
    on_change: Option<Arc<OnChange>>,
}

impl Storage {
    fn new(kind: Kind) -> Storage {
        Storage {
            kind: Arc::new(kind),
            on_change: None,
        }
    }

    /// The program's own directory, named by `id` (e.g.
    /// `"com.example.mygame"`): `~/Library/Application Support/<id>/tvpipe`
    /// on macOS, `%APPDATA%\<id>\tvpipe` on Windows,
    /// `$XDG_CONFIG_HOME/<id>/tvpipe` (or `~/.config/<id>/tvpipe`)
    /// elsewhere.
    pub fn app(id: &str) -> Storage {
        let dir = match platform_config_dir() {
            Some(base) if valid_id(id) => Ok(base.join(id).join("tvpipe")),
            Some(_) => Err(format!("storage: {id:?} is not a usable directory name")),
            None => Err("storage: cannot determine the config directory".to_owned()),
        };
        Storage::new(Kind::Dir(dir))
    }

    /// The default when a program names none: [`Storage::app`] with the
    /// executable's file name.
    pub fn default_app() -> Storage {
        let id = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
            .filter(|s| valid_id(s))
            .unwrap_or_else(|| "tvpipe-app".to_owned());
        Storage::app(&id)
    }

    /// The `tvpipe` CLI's directory (`$TVPIPE_CONFIG_DIR` if set): pair
    /// once with `tvpipe pair` and use the pairing here, and the other way
    /// round.
    pub fn cli() -> Storage {
        Storage::new(Kind::Dir(cli_dir().map_err(|e| e.to_string())))
    }

    /// A directory of the program's choosing.
    pub fn dir(path: impl Into<PathBuf>) -> Storage {
        Storage::new(Kind::Dir(Ok(path.into())))
    }

    /// Nothing on disk: [`export`](Storage::export) gives the text to
    /// keep, [`memory_from`](Storage::memory_from) restores it.
    pub fn memory() -> Storage {
        Storage::new(Kind::Memory(Mutex::new(BTreeMap::new())))
    }

    /// A memory storage with what [`export`](Storage::export) gave.
    pub fn memory_from(text: &str) -> Result<Storage> {
        Ok(Storage::new(Kind::Memory(Mutex::new(parse_export(text)?))))
    }

    /// The program's own storage.
    pub fn custom(backend: impl StorageBackend) -> Storage {
        Storage::new(Kind::Custom(Box::new(backend)))
    }

    /// Calls `f` after every change (pairing, unpairing, a new identity
    /// or token), e.g. to persist [`export`](Storage::export) of a
    /// memory storage.
    pub fn on_change(mut self, f: impl Fn(&Storage) + Send + Sync + 'static) -> Storage {
        self.on_change = Some(Arc::new(f));
        self
    }

    /// Every item as one text (`[item]` lines, then the item's text),
    /// for [`memory_from`](Storage::memory_from). Items that cannot be
    /// read are left out.
    pub fn export(&self) -> String {
        let mut out = String::from("# tvpipe storage: private, do not share\n");
        for item in [CREDENTIALS, PLAYER_TOKEN, TV_LAG] {
            if let Ok(Some(text)) = self.load(item) {
                out.push_str(&format!("[{item}]\n"));
                out.push_str(&text);
                if !text.ends_with('\n') {
                    out.push('\n');
                }
            }
        }
        out
    }

    /// Each TV's display lag by its name (as discovered, as `--to`
    /// takes it): how much later than a phone or computer screen it
    /// shows a picture, beyond its receiver's playout delay (its picture
    /// processing, and the page's frame), ms. Measured by the Sync in
    /// `tvpipe game play`'s launcher (matching flashes); `@tvpipe/party` keeps phones in
    /// step with the TV by it.
    pub fn tv_lags(&self) -> Result<BTreeMap<String, u32>> {
        Ok(self
            .load(TV_LAG)?
            .map(|t| parse_tv_lags(&t))
            .unwrap_or_default())
    }

    /// Sets a TV's display lag (`None` forgets it), replacing one kept
    /// under the same name in another case.
    pub fn set_tv_lag(&self, name: &str, ms: Option<u32>) -> Result<()> {
        let name = name.trim();
        if name.is_empty() || name.len() > 200 || name.contains(['\n', '\r']) {
            return Err(Error::usage(format!("not a TV name: {name:?}")));
        }
        let mut lags = self.tv_lags()?;
        lags.retain(|k, _| !k.eq_ignore_ascii_case(name));
        if let Some(ms) = ms {
            lags.insert(name.to_owned(), ms.min(MAX_TV_LAG_MS));
        }
        self.save(TV_LAG, &format_tv_lags(&lags))
    }

    /// The directory, for directory storages.
    pub fn path(&self) -> Option<&Path> {
        match &*self.kind {
            Kind::Dir(Ok(d)) => Some(d),
            _ => None,
        }
    }

    /// The file an item is kept in, for directory storages.
    pub(crate) fn file(&self, item: &str) -> Option<PathBuf> {
        self.path().map(|d| d.join(file_name(item)))
    }

    /// Where an item is, for messages.
    pub(crate) fn describe(&self, item: &str) -> String {
        match &*self.kind {
            Kind::Dir(Ok(d)) => d.join(file_name(item)).display().to_string(),
            Kind::Dir(Err(_)) => format!("{item} (no directory)"),
            Kind::Memory(_) => format!("{item} (in memory)"),
            Kind::Custom(_) => format!("{item} (the program's storage)"),
        }
    }

    pub(crate) fn load(&self, item: &str) -> Result<Option<String>> {
        let ctx = || format!("storage: read {}", self.describe(item));
        match &*self.kind {
            Kind::Dir(dir) => {
                let path = dir.as_ref().map_err(|e| Error::not_found(e.clone()))?;
                if item == CREDENTIALS {
                    migrate_cli_dir(path);
                }
                match std::fs::read_to_string(path.join(file_name(item))) {
                    Ok(t) => Ok(Some(t)),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
                    Err(e) => Err(Error::io(ctx(), e)),
                }
            }
            Kind::Memory(m) => Ok(m
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(item)
                .cloned()),
            Kind::Custom(b) => b.load(item).map_err(|e| Error::io(ctx(), e)),
        }
    }

    pub(crate) fn save(&self, item: &str, text: &str) -> Result<()> {
        match &*self.kind {
            Kind::Dir(dir) => {
                let path = dir.as_ref().map_err(|e| Error::not_found(e.clone()))?;
                write_private(&path.join(file_name(item)), text.as_bytes())?;
            }
            Kind::Memory(m) => {
                m.lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(item.to_owned(), text.to_owned());
            }
            Kind::Custom(b) => b
                .save(item, text)
                .map_err(|e| Error::io(format!("storage: write {}", self.describe(item)), e))?,
        }
        if let Some(f) = &self.on_change {
            f(self);
        }
        Ok(())
    }
}

impl std::fmt::Debug for Storage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &*self.kind {
            Kind::Dir(Ok(d)) => f.debug_tuple("Storage::dir").field(d).finish(),
            Kind::Dir(Err(e)) => f.debug_tuple("Storage::dir").field(e).finish(),
            Kind::Memory(_) => f.write_str("Storage::memory"),
            Kind::Custom(_) => f.write_str("Storage::custom"),
        }
    }
}

impl Default for Storage {
    /// [`Storage::default_app`].
    fn default() -> Storage {
        Storage::default_app()
    }
}

/// A TV's lag in `lags` by name, any case.
pub(crate) fn tv_lag_of(lags: &BTreeMap<String, u32>, name: &str) -> Option<u32> {
    lags.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| *v)
}

/// `tv-lag`: lines `MS NAME`, `#` comments; anything else is skipped.
fn parse_tv_lags(text: &str) -> BTreeMap<String, u32> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((ms, name)) = line.split_once(' ') else {
            continue;
        };
        let name = name.trim();
        match ms.parse::<u32>() {
            Ok(ms) if !name.is_empty() => {
                out.insert(name.to_owned(), ms.min(MAX_TV_LAG_MS));
            }
            _ => {}
        }
    }
    out
}

fn format_tv_lags(lags: &BTreeMap<String, u32>) -> String {
    let mut out = String::from(
        "# tvpipe: how much later each TV shows a picture than a phone, beyond its\n\
         # receiver's playout delay, ms (the Sync in `tvpipe game play`)\n",
    );
    for (name, ms) in lags {
        out.push_str(&format!("{ms} {name}\n"));
    }
    out
}

fn file_name(item: &str) -> String {
    match item {
        CREDENTIALS => "credentials.txt".to_owned(),
        TV_LAG => "tv-lag.txt".to_owned(),
        other => other.to_owned(),
    }
}

/// A directory name: no separators, no `..`.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains(['/', '\\', ':', '\0'])
        && !id.starts_with('.')
}

fn parse_export(text: &str) -> Result<BTreeMap<String, String>> {
    let mut items = BTreeMap::new();
    let mut cur: Option<(String, String)> = None;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') && t.len() > 2 {
            if let Some((k, v)) = cur.take() {
                items.insert(k, v);
            }
            cur = Some((t[1..t.len() - 1].to_owned(), String::new()));
            continue;
        }
        match &mut cur {
            Some((_, v)) => {
                v.push_str(line);
                v.push('\n');
            }
            None if t.is_empty() || t.starts_with('#') => {}
            None => {
                return Err(Error::malformed(
                    "storage: the text does not start with an [item] line",
                ))
            }
        }
    }
    if let Some((k, v)) = cur {
        items.insert(k, v);
    }
    Ok(items)
}

// ---------------------------------------------------------------------------
// Directories

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// The CLI's config directory: `$TVPIPE_CONFIG_DIR`, else
/// `$XDG_CONFIG_HOME/tvpipe` (or `~/.config/tvpipe`) on unix,
/// `~/Library/Application Support/tvpipe` on macOS, and
/// `%APPDATA%\tvpipe` on Windows. Computed from environment variables
/// only.
pub(crate) fn cli_dir() -> Result<PathBuf> {
    if let Some(dir) = env_path(CONFIG_DIR_ENV) {
        return Ok(dir);
    }
    // Unit tests never touch the user's real credentials; the hardware
    // tests (which set TVPIPE_ATV) do on purpose.
    #[cfg(test)]
    if std::env::var_os("TVPIPE_ATV").is_none() {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("config-{}", std::process::id())));
    }
    platform_config_dir()
        .map(|d| d.join("tvpipe"))
        .ok_or_else(|| Error::not_found("storage: cannot determine the config directory"))
}

#[cfg(target_os = "macos")]
fn platform_config_dir() -> Option<PathBuf> {
    env_path("HOME").map(|h| h.join("Library").join("Application Support"))
}

#[cfg(target_os = "windows")]
fn platform_config_dir() -> Option<PathBuf> {
    env_path("APPDATA")
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_config_dir() -> Option<PathBuf> {
    env_path("XDG_CONFIG_HOME")
        .filter(|p| p.is_absolute())
        .or_else(|| env_path("HOME").map(|h| h.join(".config")))
}

/// Overrides the CLI's cache directory ([`cache_dir`]).
pub const CACHE_DIR_ENV: &str = "TVPIPE_CACHE_DIR";

/// The CLI's cache directory (games fetched from the internet):
/// `$TVPIPE_CACHE_DIR`, else `~/Library/Caches/tvpipe` on macOS,
/// `%LOCALAPPDATA%\tvpipe\cache` on Windows and `$XDG_CACHE_HOME/tvpipe`
/// (or `~/.cache/tvpipe`) elsewhere. Computed from environment variables
/// only. Unit tests get a scratch directory, as with [`cli_dir`].
#[cfg_attr(not(feature = "playshare"), allow(dead_code))]
pub(crate) fn cache_dir() -> Result<PathBuf> {
    if let Some(dir) = env_path(CACHE_DIR_ENV) {
        return Ok(dir);
    }
    #[cfg(test)]
    return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("test-tmp")
        .join(format!("cache-{}", std::process::id())));
    #[cfg(not(test))]
    platform_cache_dir()
        .ok_or_else(|| Error::not_found("storage: cannot determine the cache directory"))
}

#[cfg(all(target_os = "macos", not(test)))]
fn platform_cache_dir() -> Option<PathBuf> {
    env_path("HOME").map(|h| h.join("Library").join("Caches").join("tvpipe"))
}

#[cfg(all(target_os = "windows", not(test)))]
fn platform_cache_dir() -> Option<PathBuf> {
    env_path("LOCALAPPDATA").map(|d| d.join("tvpipe").join("cache"))
}

#[cfg(all(not(any(target_os = "macos", target_os = "windows")), not(test)))]
fn platform_cache_dir() -> Option<PathBuf> {
    env_path("XDG_CACHE_HOME")
        .filter(|p| p.is_absolute())
        .or_else(|| env_path("HOME").map(|h| h.join(".cache")))
        .map(|d| d.join("tvpipe"))
}

/// The project used to be called `streamlib`: the CLI's platform
/// directory is moved over once from the old name, so nobody has to pair
/// again. Only the platform directory has a legacy one next to it: not
/// `$TVPIPE_CONFIG_DIR`, not a program's own directory, and not the unit
/// tests' temporary directory.
fn migrate_cli_dir(dir: &Path) {
    if let Some(base) = platform_config_dir().filter(|b| dir == b.join("tvpipe")) {
        migrate_legacy_dir(&base.join("streamlib"), dir);
    }
}

/// Moves the old config directory `old` (with the pairing credentials)
/// to `dir` once. Best effort: on failure the old directory stays and is
/// ignored.
pub(crate) fn migrate_legacy_dir(old: &Path, dir: &Path) {
    if dir.exists() || !old.is_dir() {
        return;
    }
    match std::fs::rename(old, dir) {
        Ok(()) => info!(
            "moved the old config directory {} to {}",
            old.display(),
            dir.display()
        ),
        Err(e) => warn!(
            "cannot move the old config directory {} to {}: {e}",
            old.display(),
            dir.display()
        ),
    }
}

/// Writes `data` to `path` via a temporary file in the same directory and
/// a rename. The file is created with mode 0600 on unix.
pub(crate) fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)
        .map_err(|e| Error::io(format!("storage: create {}", dir.display()), e))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "item".to_owned());
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let ctx = |what: &str| format!("storage: {what} {}", tmp.display());
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let result = (|| {
        let mut f = opts.open(&tmp).map_err(|e| Error::io(ctx("create"), e))?;
        f.write_all(data).map_err(|e| Error::io(ctx("write"), e))?;
        f.sync_all().map_err(|e| Error::io(ctx("sync"), e))?;
        drop(f);
        std::fs::rename(&tmp, path)
            .map_err(|e| Error::io(format!("storage: rename to {}", path.display()), e))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A fresh directory under `target/test-tmp`.
    pub(crate) fn temp_dir(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn memory_export_round_trip() {
        let changes = Arc::new(Mutex::new(0));
        let c = changes.clone();
        let s = Storage::memory().on_change(move |_| *c.lock().unwrap() += 1);
        assert_eq!(s.load(CREDENTIALS).unwrap(), None);
        s.save(CREDENTIALS, "# c\ncontroller = X\nseed = 00\n")
            .unwrap();
        s.save(PLAYER_TOKEN, "abc\n").unwrap();
        assert_eq!(*changes.lock().unwrap(), 2);
        let text = s.export();
        let t = Storage::memory_from(&text).unwrap();
        assert_eq!(
            t.load(CREDENTIALS).unwrap().as_deref(),
            Some("# c\ncontroller = X\nseed = 00\n")
        );
        assert_eq!(t.load(PLAYER_TOKEN).unwrap().as_deref(), Some("abc\n"));
        assert!(Storage::memory_from("controller = X\n").is_err());
        assert!(Storage::memory_from("").is_ok());
    }

    #[test]
    fn dir_and_custom() {
        let dir = temp_dir("storage-dir");
        let s = Storage::dir(&dir);
        s.save(CREDENTIALS, "x").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("credentials.txt")).unwrap(),
            "x"
        );
        assert_eq!(s.file(PLAYER_TOKEN), Some(dir.join("player-token")));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let w = seen.clone();
        let c = Storage::custom(storage_fn(
            |item| Ok((item == CREDENTIALS).then(|| "c".to_owned())),
            move |item, text| {
                w.lock().unwrap().push((item.to_owned(), text.to_owned()));
                Ok(())
            },
        ));
        assert_eq!(c.load(CREDENTIALS).unwrap().as_deref(), Some("c"));
        assert_eq!(c.load(PLAYER_TOKEN).unwrap(), None);
        c.save(PLAYER_TOKEN, "t").unwrap();
        assert_eq!(seen.lock().unwrap()[0], ("player-token".into(), "t".into()));
    }

    #[test]
    fn tv_lags() {
        let s = Storage::memory();
        assert!(s.tv_lags().unwrap().is_empty());
        s.set_tv_lag("Living Room", Some(162)).unwrap();
        s.set_tv_lag("Kitchen", Some(9000)).unwrap();
        s.set_tv_lag("living room", Some(140)).unwrap();
        let lags = s.tv_lags().unwrap();
        assert_eq!(lags.len(), 2, "{lags:?}");
        assert_eq!(tv_lag_of(&lags, "LIVING ROOM"), Some(140));
        assert_eq!(tv_lag_of(&lags, "Kitchen"), Some(MAX_TV_LAG_MS));
        s.set_tv_lag("Kitchen", None).unwrap();
        assert_eq!(tv_lag_of(&s.tv_lags().unwrap(), "Kitchen"), None);
        assert!(s.set_tv_lag("a\nb", Some(1)).is_err());
        assert!(s.set_tv_lag("  ", Some(1)).is_err());
        let text = s.load(TV_LAG).unwrap().unwrap();
        assert!(text.ends_with("140 living room\n"), "{text}");
        // Hand edits: junk is skipped, names keep their spaces.
        let parsed = parse_tv_lags("# c\n120  Den TV \nx Den\n-5 Hall\n80\n\n33 a b\n");
        assert_eq!(
            parsed.into_iter().collect::<Vec<_>>(),
            [("Den TV".to_owned(), 120), ("a b".to_owned(), 33)]
        );
        // Exported with the rest.
        assert!(s.export().contains("[tv-lag]\n"));
    }

    #[test]
    fn app_ids_are_directory_names() {
        assert!(valid_id("com.example.game"));
        for bad in ["", ".", "..", "a/b", "a\\b", ".hidden"] {
            assert!(!valid_id(bad), "{bad:?}");
            assert!(Storage::app(bad).load(CREDENTIALS).is_err());
        }
    }

    #[test]
    fn tests_use_a_scratch_cli_dir() {
        let dir = cli_dir().unwrap();
        assert!(dir.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target")));
        let dir = cache_dir().unwrap();
        assert!(dir.starts_with(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target")));
    }

    #[test]
    fn migrates_legacy_dir_once() {
        let root = temp_dir("storage-migrate");
        let (old, dir) = (root.join("streamlib"), root.join("tvpipe"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("credentials.txt"), "x").unwrap();
        migrate_legacy_dir(&old, &dir);
        assert!(!old.exists());
        assert_eq!(
            std::fs::read_to_string(dir.join("credentials.txt")).unwrap(),
            "x"
        );
        // Never over an existing directory.
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("credentials.txt"), "y").unwrap();
        migrate_legacy_dir(&old, &dir);
        assert_eq!(
            std::fs::read_to_string(old.join("credentials.txt")).unwrap(),
            "y"
        );
    }
}
