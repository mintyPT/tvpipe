//! `tvpipe share URL`: a browser of its own that shows URL and shares
//! its tab into the share pipeline.
//!
//! [`Headless::start`] starts the browser (`launch`) on `about:blank`,
//! attaches to the tab over the DevTools protocol (`cdp`), sets it up
//! (the viewport is the stream size; the tab may reach tvpipe's loopback
//! WebSocket: `Page.setBypassCSP` and the local-network permission), then
//! opens URL. After every navigation it evaluates `capture.js` and
//! `headless.js` in the page as a user gesture, which share the tab
//! (video and tab audio) to the [`ShareServer`](super::share::ShareServer)
//! in rejoin mode.
//!
//! A keeper thread then watches the tab until [`Headless::shutdown`]:
//!
//! - every second or two it polls the page's capture state and shares
//!   again when a document has none (a navigation it missed) or the share
//!   ended; it gives up after repeated failures;
//! - a crashed page is loaded again, a browser that died is started again
//!   (at most [`MAX_RESTARTS`] times a minute), a browser that quit
//!   normally (its window closed) or a closed tab ends the session;
//! - `--reload MIN` reloads the page periodically;
//! - the page's console errors and uncaught exceptions are logged at
//!   debug; dialogs are dismissed; an error status of the page itself is
//!   reported (sites that refuse automated browsers: tvpipe does not
//!   hide that it is one).
//!
//! On shutdown it asks the browser to quit (then kills it) and deletes
//! the temporary profile.
//!
//! Firefox (`launch::Engine::Firefox`) is driven over WebDriver BiDi
//! instead ([`firefox`]): the keeper is the same, the tab's setup, its
//! navigation, evaluation and events differ.
//!
//! Sources: Chrome DevTools Protocol docs (Target, Page, Runtime,
//! Network, Inspector, Browser, Emulation domains).

pub(crate) mod firefox;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::browser::bidi;
use crate::browser::cdp::Event;
use crate::browser::launch::{self, Browser, Engine, LaunchOptions, Profile};
use crate::browser::share::{ShareHandle, CAPTURE_JS};
use crate::codec::json::Value;
use crate::error::{Error, ErrorKind, Result};
use crate::media::input::Stop;

/// Starts the share in a page (`headless.js`; called with the ws URL).
pub const START_JS: &str = include_str!("headless.js");

/// A browser that dies this often within [`RESTART_WINDOW`] is not
/// started again.
pub const MAX_RESTARTS: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);
/// Shares in a row that end or never start before tvpipe gives up.
const MAX_FAILURES: u32 = 5;
/// How long a page may take from the start script to sharing.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(20);
/// Polls of the page's state that time out (a hung page) before it is
/// loaded again.
const MAX_HUNG_POLLS: u32 = 3;
const POLL_SHARING: Duration = Duration::from_secs(2);
const POLL_STARTING: Duration = Duration::from_millis(500);
const EVAL_TIMEOUT: Duration = Duration::from_secs(5);
const EVENT_WAIT: Duration = Duration::from_millis(200);

/// What [`Headless::start`] needs.
#[derive(Debug, Clone)]
pub struct HeadlessOptions {
    pub url: String,
    pub launch: LaunchOptions,
    /// `--profile DIR` (kept); `None`: a temporary profile.
    pub profile: Option<PathBuf>,
    /// `--reload MIN`.
    pub reload: Option<Duration>,
    /// Another page for the tab while it runs (`Session::navigate`).
    pub control: Option<crate::opts::PageControl>,
}

/// Refuses URLs tvpipe must not automate. Google Meet refuses automated
/// browsers and its terms forbid automating it (docs/meet.md): present a
/// `--to browser` tab with Meet's own UI instead.
pub fn check_url(url: &str) -> Result<()> {
    let rest = url
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(url)
        .to_ascii_lowercase();
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    let host = host.split(':').next().unwrap_or(host);
    if host == "meet.google.com" || host.ends_with(".meet.google.com") {
        return Err(Error::usage(
            "tvpipe does not join video calls by itself: Google Meet refuses automated \
             browsers. Run 'tvpipe play --to browser ...' and present that tab with Meet's \
             own 'Present' button (docs/meet.md)",
        ));
    }
    Ok(())
}

/// The page to open for the `URL` argument: `http(s)://` and `file://`
/// URLs as given, an existing local file as a `file://` URL, anything
/// else as `https://` (`http://` for localhost).
pub fn page_url(arg: &str) -> Result<String> {
    if let Some((scheme, _)) = arg.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        if matches!(scheme.as_str(), "http" | "https" | "file") {
            return Ok(arg.to_owned());
        }
        return Err(Error::usage(format!(
            "{arg}: only http://, https:// and file:// pages can be shown"
        )));
    }
    let path = Path::new(arg);
    if path.is_file() {
        let abs =
            std::fs::canonicalize(path).map_err(|e| Error::io(format!("resolve {arg}"), e))?;
        return Ok(file_url(&abs));
    }
    if arg.is_empty() || arg.contains(char::is_whitespace) {
        return Err(Error::usage(format!("{arg:?} is not a URL or a file")));
    }
    let local = ["localhost", "127.", "[::1]"]
        .iter()
        .any(|p| arg.starts_with(p));
    Ok(format!("{}://{arg}", if local { "http" } else { "https" }))
}

/// `file://` URL of an absolute path (percent-encoded; `\` and drive
/// letters of Windows paths become `/C:/...`).
fn file_url(abs: &Path) -> String {
    let s = abs.to_string_lossy().replace('\\', "/");
    // Windows' verbatim prefix from canonicalize.
    let s = s.strip_prefix("//?/").unwrap_or(&s);
    let mut out = String::from("file://");
    if !s.starts_with('/') {
        out.push('/');
    }
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~:".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

struct Ctl {
    shutdown: AtomicBool,
}

/// The browser and its keeper thread.
pub struct Headless {
    ctl: Arc<Ctl>,
    thread: Option<JoinHandle<()>>,
    profile_dir: PathBuf,
    pub product: String,
}

impl Headless {
    /// Starts the browser and opens the URL; the share starts once the
    /// page has loaded. Errors up to the navigation are returned here,
    /// later ones end the share through `share`.
    pub fn start(mut opts: HeadlessOptions, share: ShareHandle, stop: Stop) -> Result<Headless> {
        check_url(&opts.url)?;
        if opts.launch.engine() == Engine::Firefox && opts.launch.scale != 1.0 {
            // Whether Firefox's tab capture follows a BiDi device pixel
            // ratio is not verified: its page renders at scale 1 and the
            // picture is scaled to the stream.
            warn!(
                "browser: Firefox renders the page at scale 1, not {} (the picture is scaled \
                 to the stream; a Chromium-based browser renders it sharper)",
                opts.launch.scale
            );
            opts.launch.scale = 1.0;
        }
        let profile = match &opts.profile {
            Some(dir) => Profile::persistent(dir)?,
            None => Profile::temporary()?,
        };
        let profile_dir = profile.dir().to_path_buf();
        let start_expr = format!(
            "({})({})",
            START_JS.trim().trim_end_matches(';'),
            Value::from(share.ws_url()).to_json()
        );
        let tab = Tab::open(&opts, &profile, true)?;
        let product = tab.browser.product.clone();
        let (pw, ph) = launch::device_pixels(opts.launch.viewport, opts.launch.scale);
        info!(
            "browser: {} {} ({}x{}{}, profile {})",
            product,
            if opts.launch.visible {
                "in a window"
            } else {
                "headless"
            },
            opts.launch.viewport.0,
            opts.launch.viewport.1,
            if opts.launch.scale != 1.0 {
                format!(" CSS at {}x = {pw}x{ph}", opts.launch.scale)
            } else {
                String::new()
            },
            if opts.profile.is_some() {
                profile_dir.display().to_string()
            } else {
                "temporary".into()
            }
        );
        let ctl = Arc::new(Ctl {
            shutdown: AtomicBool::new(false),
        });
        let mut keeper = Keeper {
            next_reload: opts.reload.map(|r| Instant::now() + r),
            opts,
            profile,
            share,
            start_expr,
            stop,
            ctl: ctl.clone(),
            tab: Some(tab),
            restarts: Vec::new(),
            failures: 0,
            hung: 0,
        };
        let thread = std::thread::Builder::new()
            .name("browser-keeper".into())
            .spawn(move || keeper.run())
            .map_err(|e| Error::io("spawn browser keeper", e))?;
        Ok(Headless {
            ctl,
            thread: Some(thread),
            profile_dir,
            product,
        })
    }

    /// The browser's profile directory (gone after shutdown when
    /// temporary).
    pub fn profile_dir(&self) -> &Path {
        &self.profile_dir
    }

    /// Closes the browser and deletes the temporary profile; returns when
    /// both are done.
    pub fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        self.ctl.shutdown.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Headless {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A URL without its `#fragment`.
fn without_fragment(url: &str) -> &str {
    url.split_once('#').map_or(url, |(u, _)| u)
}

/// What the page's capture is doing (`globalThis.__tvpipe`).
#[derive(Debug, Clone, PartialEq, Eq)]
enum PageState {
    /// No capture in this document.
    None,
    Starting,
    Sharing,
    Ended(String),
}

/// The page's state and viewport from [`STATE_JS`].
fn parse_state(v: &Value) -> (PageState, Option<(u32, u32)>) {
    let s = v.as_str().unwrap_or("none");
    let mut parts = s.split('\n');
    let state = parts.next().unwrap_or("none");
    let error = parts.next().unwrap_or("");
    let viewport = parts.next().and_then(|v| {
        let (w, h) = v.split_once('x')?;
        Some((w.parse().ok()?, h.parse().ok()?))
    });
    let state = match state {
        "connecting" | "capturing" => PageState::Starting,
        "sharing" => PageState::Sharing,
        "ended" => PageState::Ended(if error.is_empty() {
            "the share ended".into()
        } else {
            error.to_owned()
        }),
        _ => PageState::None,
    };
    (state, viewport)
}

/// `state \n error \n WxH` (the viewport: Chrome's "sharing this tab"
/// bar takes room from the page once the capture runs).
const STATE_JS: &str = "(function () { var s = globalThis.__tvpipe; \
     return (s ? s.state + '\\n' + (s.error || '') : 'none\\n') + '\\n' + \
     innerWidth + 'x' + innerHeight; })()";
/// Times per document the window is resized to keep the viewport.
const MAX_FITS: u32 = 3;

/// The browser, its tab and what we know about the page in it.
struct Tab {
    browser: Browser,
    /// The tab's target (Firefox: its browsing context).
    target: String,
    /// The tab's flattened session (Firefox: none).
    session: String,
    main_frame: Option<String>,
    url: String,
    /// When the start script last ran in this document.
    started: Option<Instant>,
    sharing: bool,
    next_poll: Instant,
    /// Viewport corrections in this document.
    fits: u32,
    /// The page crashed and is being loaded again (both the target and
    /// the session report a crash).
    crashed: bool,
}

impl Tab {
    /// Starts the browser, sets its tab up and opens the URL.
    fn open(opts: &HeadlessOptions, profile: &Profile, first: bool) -> Result<Tab> {
        let browser = Browser::launch(&opts.launch, profile)?;
        let (target, session) = match browser.engine {
            Engine::Chromium => {
                attach_scaled(&browser, opts.launch.viewport, Some(opts.launch.scale))?
            }
            Engine::Firefox => (
                firefox::attach(&browser, opts.launch.viewport)?,
                String::new(),
            ),
        };
        let mut tab = Tab {
            browser,
            target,
            session,
            main_frame: None,
            url: opts.url.clone(),
            started: None,
            sharing: false,
            next_poll: Instant::now() + POLL_STARTING,
            fits: 0,
            crashed: false,
        };
        tab.navigate(&opts.url, first)?;
        Ok(tab)
    }

    fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.browser.cdp().call(Some(&self.session), method, params)
    }

    /// Opens `url`; a failure is an error on the first navigation, a
    /// warning later.
    fn navigate(&mut self, url: &str, first: bool) -> Result<()> {
        debug!("browser: opening {url}");
        let err = match self.browser.engine {
            Engine::Chromium => {
                let r = self.call("Page.navigate", Value::object().with("url", url))?;
                if let Some(frame) = r.get("frameId").and_then(Value::as_str) {
                    self.main_frame = Some(frame.to_owned());
                }
                r.get("errorText")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            }
            Engine::Firefox => match firefox::navigate(self.browser.cdp(), &self.target, url) {
                Ok(()) => None,
                // The connection is gone: the browser.
                Err(e) if e.kind() == ErrorKind::Closed => return Err(e),
                Err(e) => Some(e.to_string()),
            },
        };
        if let Some(err) = err {
            let msg = format!("browser: cannot open {url}: {err}");
            if first {
                return Err(Error::not_found(msg));
            }
            warn!("{msg}");
        }
        self.started = None;
        self.sharing = false;
        self.fits = 0;
        Ok(())
    }

    fn evaluate(&self, expr: &str, gesture: bool) -> Result<Value> {
        match self.browser.engine {
            Engine::Chromium => {
                self.browser
                    .cdp()
                    .evaluate(&self.session, expr, gesture, false, EVAL_TIMEOUT)
            }
            Engine::Firefox => bidi::evaluate(
                self.browser.cdp(),
                &self.target,
                expr,
                gesture,
                false,
                EVAL_TIMEOUT,
            ),
        }
    }

    fn reload(&self) -> Result<()> {
        match self.browser.engine {
            Engine::Chromium => self.call("Page.reload", Value::object()).map(|_| ()),
            Engine::Firefox => firefox::reload(self.browser.cdp(), &self.target),
        }
    }

    /// Makes the page's viewport `want` again.
    fn fit(&self, want: (u32, u32)) -> Result<()> {
        match self.browser.engine {
            Engine::Chromium => {
                fit_viewport(&self.browser, &self.target, &self.session, want).map(|_| ())
            }
            Engine::Firefox => firefox::set_viewport(self.browser.cdp(), &self.target, want),
        }
    }

    /// Runs the capture script and starts the share in the current
    /// document (does nothing where one runs).
    fn inject(&mut self, start_expr: &str) -> Result<()> {
        self.evaluate(CAPTURE_JS, false)?;
        let state = self.evaluate(start_expr, true)?;
        debug!(
            "browser: share started in the page ({})",
            state.as_str().unwrap_or("?")
        );
        self.started = Some(Instant::now());
        self.next_poll = Instant::now() + POLL_STARTING;
        Ok(())
    }
}

/// Sets up the browser's tab for sharing itself: attached (flattened
/// session), events on, CSP bypassed, loopback allowed, focused, the
/// viewport at `viewport`. Returns its target and session ids.
pub fn attach(browser: &Browser, viewport: (u32, u32)) -> Result<(String, String)> {
    attach_scaled(browser, viewport, None)
}

/// [`attach`], warning when the page's device scale is not `scale`
/// (`LaunchOptions::scale`; e.g. a `--visible` window on a screen that
/// cannot hold the scaled page).
pub fn attach_scaled(
    browser: &Browser,
    viewport: (u32, u32),
    scale: Option<f64>,
) -> Result<(String, String)> {
    let cdp = browser.cdp();
    cdp.call(
        None,
        "Target.setDiscoverTargets",
        Value::object().with("discover", true),
    )?;
    let targets = cdp.call(None, "Target.getTargets", Value::object())?;
    let target = targets
        .get("targetInfos")
        .and_then(Value::as_array)
        .unwrap_or(&[])
        .iter()
        .find(|t| t.get("type").and_then(Value::as_str) == Some("page"))
        .and_then(|t| t.get("targetId").and_then(Value::as_str))
        .ok_or_else(|| Error::protocol("browser: no tab to show the page in"))?
        .to_owned();
    let session = cdp
        .call(
            None,
            "Target.attachToTarget",
            Value::object()
                .with("targetId", target.as_str())
                .with("flatten", true),
        )?
        .require_str("sessionId")?
        .to_owned();
    let s = Some(session.as_str());
    for m in [
        "Page.enable",
        "Runtime.enable",
        "Network.enable",
        "Inspector.enable",
        "Log.enable",
    ] {
        cdp.call(s, m, Value::object())?;
    }
    // capture.js's worker and worklet are blob: URLs and it connects
    // to ws://127.0.0.1: a page's CSP must not stop either.
    cdp.call(
        s,
        "Page.setBypassCSP",
        Value::object().with("enabled", true),
    )?;
    // Local Network Access: pages from the internet may not reach
    // 127.0.0.1 without the user's permission; this browser's user is
    // tvpipe.
    grant_loopback(cdp);
    // The page behaves as if focused (pages that pause on blur).
    let _ = cdp.call(
        s,
        "Emulation.setFocusEmulationEnabled",
        Value::object().with("enabled", true),
    );
    let dpr = fit_viewport(browser, &target, &session, viewport)?;
    match scale {
        Some(s) if (dpr - s).abs() > 0.01 => warn!(
            "browser: the page renders at device scale {dpr}, not {s}: the tab is captured at \
             {}x{} (the picture is scaled to the stream)",
            (viewport.0 as f64 * dpr).round(),
            (viewport.1 as f64 * dpr).round()
        ),
        Some(_) => {}
        None if dpr != 1.0 => {
            // A window on a scaled screen: the capture is scaled to the
            // stream.
            debug!("browser: the page's device scale is {dpr}, not 1");
        }
        None => {}
    }
    Ok((target, session))
}

/// Local Network Access permission names, newest first (Chrome 142+
/// splits it into loopback and local network).
const LOOPBACK_PERMISSIONS: [&str; 3] = ["loopbackNetwork", "localNetwork", "localNetworkAccess"];

/// Grants every origin the permission to reach 127.0.0.1.
/// `Browser.grantPermissions` replaces what was granted before and fails
/// on names this browser does not know: one call with all of them, else
/// one with the names that work alone.
fn grant_loopback(cdp: &crate::browser::cdp::Cdp) {
    let grant = |names: &[&str]| {
        cdp.call(
            None,
            "Browser.grantPermissions",
            Value::object().with("permissions", Value::array(names.iter().copied())),
        )
    };
    if grant(&LOOPBACK_PERMISSIONS).is_ok() {
        return;
    }
    let known: Vec<&str> = LOOPBACK_PERMISSIONS
        .iter()
        .copied()
        .filter(|p| grant(&[p]).is_ok())
        .collect();
    match grant(&known) {
        Ok(_) if !known.is_empty() => debug!("browser: granted {known:?}"),
        _ => warn!(
            "browser: cannot allow pages to reach tvpipe on 127.0.0.1 (no Local Network \
             Access permission in this browser); sites on the internet may fail to share"
        ),
    }
}

/// Makes the page's viewport exactly `want` (CSS pixels): the window is
/// resized by the difference. Returns the page's device scale
/// (`devicePixelRatio`).
fn fit_viewport(b: &Browser, target: &str, session: &str, want: (u32, u32)) -> Result<f64> {
    let cdp = b.cdp();
    let mut inner = (0, 0);
    let mut dpr = 1.0;
    for _ in 0..3 {
        let v = cdp.evaluate(
            session,
            "[innerWidth, innerHeight, devicePixelRatio].join(' ')",
            false,
            false,
            EVAL_TIMEOUT,
        )?;
        let nums: Vec<f64> = v
            .as_str()
            .unwrap_or("")
            .split(' ')
            .filter_map(|n| n.parse().ok())
            .collect();
        let [w, h, scale] = nums[..] else {
            return Err(Error::protocol(format!("browser: odd viewport {v}")));
        };
        inner = (w as u32, h as u32);
        dpr = scale;
        if inner == want {
            return Ok(dpr);
        }
        let win = cdp.call(
            None,
            "Browser.getWindowForTarget",
            Value::object().with("targetId", target),
        )?;
        let id = win.require_u64("windowId")?;
        let bounds = win.require("bounds")?;
        let ww = bounds.get("width").and_then(Value::as_u64).unwrap_or(0) as i64;
        let wh = bounds.get("height").and_then(Value::as_u64).unwrap_or(0) as i64;
        let nw = (want.0 as i64 + (ww - inner.0 as i64)).max(want.0 as i64);
        let nh = (want.1 as i64 + (wh - inner.1 as i64)).max(want.1 as i64);
        debug!(
            "browser: viewport {}x{} in a {ww}x{wh} window; resizing the window to {nw}x{nh}",
            inner.0, inner.1
        );
        cdp.call(
            None,
            "Browser.setWindowBounds",
            Value::object().with("windowId", id).with(
                "bounds",
                Value::object()
                    .with("width", nw)
                    .with("height", nh)
                    .with("windowState", "normal"),
            ),
        )?;
        std::thread::sleep(Duration::from_millis(100));
    }
    warn!(
        "browser: the page is {}x{}, not {}x{} (a screen too small?); the picture is scaled to fit",
        inner.0, inner.1, want.0, want.1
    );
    Ok(dpr)
}

/// The keeper thread's state.
struct Keeper {
    opts: HeadlessOptions,
    profile: Profile,
    share: ShareHandle,
    start_expr: String,
    stop: Stop,
    ctl: Arc<Ctl>,
    tab: Option<Tab>,
    /// When the browser was started again.
    restarts: Vec<Instant>,
    /// Shares in a row that ended or never started.
    failures: u32,
    /// State polls in a row that timed out.
    hung: u32,
    next_reload: Option<Instant>,
}

/// Why the keeper stops.
enum Exit {
    /// The session is over (or the user closed the browser): end quietly.
    Done(String),
    Failed(Error),
}

impl Keeper {
    fn stopping(&self) -> bool {
        self.ctl.shutdown.load(Ordering::SeqCst) || self.stop.requested()
    }

    fn run(&mut self) {
        let exit = self.watch();
        if let Some(mut tab) = self.tab.take() {
            tab.browser.close();
        }
        match exit {
            None => {}
            Some(Exit::Done(why)) => {
                info!("browser: {why}");
                self.share.end(&why);
            }
            Some(Exit::Failed(e)) => {
                error!("browser: {e}");
                self.share.fail(e);
            }
        }
        // Dropping the profile deletes a temporary one.
    }

    /// Runs until shutdown (`None`) or the browser cannot go on.
    fn watch(&mut self) -> Option<Exit> {
        loop {
            if self.stopping() {
                return None;
            }
            let Some(tab) = &self.tab else {
                if let Err(e) = self.restart() {
                    return Some(Exit::Failed(e));
                }
                continue;
            };
            match tab.browser.cdp().next_event(EVENT_WAIT) {
                Ok(Some(ev)) => {
                    if let Some(exit) = self.event(ev) {
                        return Some(exit);
                    }
                }
                Ok(None) => {}
                Err(_) => {
                    if let Some(exit) = self.browser_gone() {
                        return Some(exit);
                    }
                    continue;
                }
            }
            if let Some(exit) = self.tick() {
                return Some(exit);
            }
        }
    }

    /// The DevTools connection closed: the browser quit or crashed.
    fn browser_gone(&mut self) -> Option<Exit> {
        let mut tab = self.tab.take()?;
        if self.stopping() {
            return None;
        }
        // Wait a moment for the exit status.
        let deadline = Instant::now() + Duration::from_secs(2);
        let status = loop {
            match tab.browser.exited() {
                Some(s) => break Some(s),
                None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                None => break None,
            }
        };
        if self.stopping() {
            return None;
        }
        if status.is_some_and(|s| s.success()) {
            return Some(Exit::Done("the browser was closed".into()));
        }
        // Its last words, unless a signal killed it.
        let why = match (status, tab.browser.last_error_line()) {
            (Some(s), Some(l)) if s.code().is_some() => format!("exited ({s}): {l}"),
            (Some(s), _) => format!("exited ({s})"),
            (None, _) => "stopped answering".into(),
        };
        drop(tab);
        warn!("browser: the browser {why}; starting it again");
        None
    }

    /// Starts the browser again (after a crash), unless it crashes too
    /// often.
    fn restart(&mut self) -> Result<()> {
        let now = Instant::now();
        self.restarts
            .retain(|t| now.duration_since(*t) < RESTART_WINDOW);
        if self.restarts.len() >= MAX_RESTARTS {
            return Err(Error::process(format!(
                "the browser died {} times within {} s; giving up",
                self.restarts.len() + 1,
                RESTART_WINDOW.as_secs()
            )));
        }
        // At once the first time, then backing off.
        let wait = Duration::from_millis(500) * self.restarts.len() as u32;
        let until = now + wait;
        while Instant::now() < until {
            if self.stopping() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.restarts.push(Instant::now());
        match Tab::open(&self.opts, &self.profile, false) {
            Ok(tab) => {
                info!("browser: started again");
                self.tab = Some(tab);
                self.failures = 0;
                self.hung = 0;
                Ok(())
            }
            Err(e) if self.restarts.len() >= MAX_RESTARTS => Err(e),
            Err(e) => {
                warn!("browser: cannot start it again: {e}");
                Ok(())
            }
        }
    }

    fn event(&mut self, ev: Event) -> Option<Exit> {
        let tab = self.tab.as_mut()?;
        if tab.browser.engine == Engine::Firefox {
            return self.firefox_event(ev);
        }
        let ours = ev.session.as_deref() == Some(tab.session.as_str());
        let p = &ev.params;
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        match ev.method.as_str() {
            "Page.domContentEventFired" if ours => {
                if let Err(e) = tab.inject(&self.start_expr) {
                    debug!("browser: cannot start the share yet: {e}");
                }
            }
            "Page.frameNavigated" if ours => {
                let frame = p.get("frame").cloned().unwrap_or(Value::Null);
                if frame.get("parentId").is_none() {
                    tab.url = s(&frame, "url");
                    tab.main_frame = Some(s(&frame, "id"));
                    tab.started = None;
                    tab.sharing = false;
                    tab.fits = 0;
                    tab.crashed = false;
                    debug!("browser: the page is now {}", tab.url);
                }
            }
            "Page.javascriptDialogOpening" if ours => {
                let kind = s(p, "type");
                info!(
                    "browser: the page opened a {kind} dialog ({:?}); dismissing it",
                    s(p, "message")
                );
                let _ = tab.call(
                    "Page.handleJavaScriptDialog",
                    Value::object().with("accept", kind == "beforeunload"),
                );
            }
            "Inspector.targetCrashed" if ours && !tab.crashed => return self.page_crashed(),
            "Target.targetCrashed" if s(p, "targetId") == tab.target && !tab.crashed => {
                return self.page_crashed()
            }
            "Target.targetDestroyed" if s(p, "targetId") == tab.target => {
                return Some(Exit::Done("the tab was closed".into()));
            }
            "Target.detachedFromTarget" if s(p, "sessionId") == tab.session => {
                return Some(Exit::Done("the tab was closed".into()));
            }
            "Runtime.exceptionThrown" if ours => {
                let d = p.get("exceptionDetails").cloned().unwrap_or(Value::Null);
                let text = d
                    .get("exception")
                    .and_then(|e| e.get("description"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| s(&d, "text"));
                debug!("page: {}", text.lines().next().unwrap_or(""));
            }
            "Runtime.consoleAPICalled" if ours => {
                let kind = s(p, "type");
                if matches!(kind.as_str(), "error" | "warning" | "assert") {
                    let args: Vec<String> = p
                        .get("args")
                        .and_then(Value::as_array)
                        .unwrap_or(&[])
                        .iter()
                        .map(|a| match a.get("value") {
                            Some(Value::String(v)) => v.clone(),
                            Some(v) => v.to_json(),
                            None => s(a, "description"),
                        })
                        .collect();
                    debug!("page console.{kind}: {}", args.join(" "));
                }
            }
            "Log.entryAdded" if ours => {
                let e = p.get("entry").cloned().unwrap_or(Value::Null);
                let level = s(&e, "level");
                if matches!(level.as_str(), "error" | "warning") {
                    debug!("page {level} ({}): {}", s(&e, "source"), s(&e, "text"));
                }
            }
            "Network.responseReceived" if ours => {
                let main = tab.main_frame.as_deref() == Some(s(p, "frameId").as_str());
                if s(p, "type") == "Document" && main {
                    let r = p.get("response").cloned().unwrap_or(Value::Null);
                    let status = r.get("status").and_then(Value::as_u64).unwrap_or(0);
                    if status >= 400 {
                        report_status(&s(&r, "url"), status, &s(&r, "statusText"));
                    }
                }
            }
            "Network.loadingFailed"
                if ours
                    && s(p, "type") == "Document"
                    && !p.get("canceled").and_then(Value::as_bool).unwrap_or(false) =>
            {
                debug!("browser: a document did not load: {}", s(p, "errorText"));
            }
            _ => {}
        }
        None
    }

    fn firefox_event(&mut self, ev: Event) -> Option<Exit> {
        let tab = self.tab.as_mut()?;
        match firefox::event(&ev, &tab.target) {
            firefox::Seen::Committed { url } => {
                debug!("browser: the page is now {url}");
                tab.url = url;
                tab.started = None;
                tab.sharing = false;
                tab.fits = 0;
                tab.crashed = false;
            }
            firefox::Seen::Ready { url } => {
                tab.url = url;
                if let Err(e) = tab.inject(&self.start_expr) {
                    debug!("browser: cannot start the share yet: {e}");
                }
            }
            firefox::Seen::Crashed if !tab.crashed => return self.page_crashed(),
            firefox::Seen::Closed => return Some(Exit::Done("the tab was closed".into())),
            firefox::Seen::Status { url, status, text } => report_status(&url, status, &text),
            _ => {}
        }
        None
    }

    /// The page's renderer died: load the URL again (counts as a restart).
    fn page_crashed(&mut self) -> Option<Exit> {
        let now = Instant::now();
        self.restarts
            .retain(|t| now.duration_since(*t) < RESTART_WINDOW);
        if self.restarts.len() >= MAX_RESTARTS {
            return Some(Exit::Failed(Error::process(format!(
                "the page crashed {} times within {} s; giving up",
                self.restarts.len() + 1,
                RESTART_WINDOW.as_secs()
            ))));
        }
        self.restarts.push(now);
        warn!("browser: the page crashed; loading it again");
        let url = self.opts.url.clone();
        let tab = self.tab.as_mut()?;
        tab.crashed = true;
        if let Err(e) = tab.navigate(&url, false) {
            warn!("browser: cannot load the page again: {e}");
            // Start the browser over.
            self.tab = None;
        }
        None
    }

    /// Periodic work: another page asked for, reloads and the page's
    /// share state.
    fn tick(&mut self) -> Option<Exit> {
        let now = Instant::now();
        let tab = self.tab.as_mut()?;
        if let Some(url) = self.opts.control.as_ref().and_then(|c| c.take()) {
            // The same document with another fragment would only change
            // the hash: load it for real (a game's next TV page).
            let same_doc = without_fragment(&url) == without_fragment(&tab.url);
            info!("browser: opening {url} in the same tab");
            let r =
                tab.navigate(&url, false).and_then(
                    |()| {
                        if same_doc {
                            tab.reload()
                        } else {
                            Ok(())
                        }
                    },
                );
            if let Err(e) = r {
                warn!("browser: {e}");
            }
            tab.url = url.clone();
            tab.started = None;
            tab.sharing = false;
            tab.fits = 0;
            tab.next_poll = now + POLL_STARTING;
            // A browser started again opens this one.
            self.opts.url = url;
            self.failures = 0;
            return None;
        }
        if let (Some(at), Some(every)) = (self.next_reload, self.opts.reload) {
            if now >= at {
                self.next_reload = Some(now + every);
                info!("browser: reloading the page (--reload)");
                if let Err(e) = tab.reload() {
                    warn!("browser: reload: {e}");
                }
                tab.started = None;
                tab.sharing = false;
            }
        }
        if now < tab.next_poll {
            return None;
        }
        tab.next_poll = now
            + if tab.sharing {
                POLL_SHARING
            } else {
                POLL_STARTING
            };
        let (state, viewport) = match tab.evaluate(STATE_JS, false) {
            Ok(v) => {
                self.hung = 0;
                parse_state(&v)
            }
            Err(e) if e.kind() == ErrorKind::Timeout => {
                self.hung += 1;
                warn!("browser: the page does not respond");
                if self.hung >= MAX_HUNG_POLLS {
                    self.hung = 0;
                    warn!("browser: loading the page again");
                    let url = tab.url.clone();
                    if let Err(e) = tab.navigate(&url, false) {
                        warn!("browser: {e}");
                    }
                }
                return None;
            }
            // Between documents (no context to evaluate in).
            Err(e) => {
                trace!("browser: state: {e}");
                return None;
            }
        };
        match state {
            PageState::Sharing => {
                if !tab.sharing {
                    debug!("browser: the page shares");
                    // Look again once the sharing bar is in.
                    tab.next_poll = now + POLL_STARTING;
                }
                tab.sharing = true;
                self.failures = 0;
                let want = self.opts.launch.viewport;
                if viewport.is_some_and(|v| v != want) && tab.fits < MAX_FITS {
                    tab.fits += 1;
                    if let Err(e) = tab.fit(want) {
                        debug!("browser: viewport: {e}");
                    }
                }
            }
            PageState::None => {
                if let Err(e) = tab.inject(&self.start_expr) {
                    debug!("browser: cannot start the share: {e}");
                }
            }
            PageState::Starting => {
                let late = tab
                    .started
                    .is_some_and(|t| now.duration_since(t) > CAPTURE_TIMEOUT);
                if late {
                    return self.failed(format!(
                        "the page did not start sharing within {} s",
                        CAPTURE_TIMEOUT.as_secs()
                    ));
                }
            }
            PageState::Ended(why) => {
                if self.stopping() {
                    return None;
                }
                return self.failed(why);
            }
        }
        None
    }

    /// A share that ended or never started: try again, up to a limit.
    fn failed(&mut self, why: String) -> Option<Exit> {
        self.failures += 1;
        let tab = self.tab.as_mut()?;
        tab.sharing = false;
        if self.failures >= MAX_FAILURES {
            return Some(Exit::Failed(Error::protocol(format!(
                "the page cannot share itself: {why}"
            ))));
        }
        warn!("browser: the share stopped ({why}); starting it again");
        // Back off: the next poll starts it again in a fresh state.
        let _ = tab.evaluate("delete globalThis.__tvpipe", false);
        tab.next_poll = Instant::now() + Duration::from_secs(self.failures as u64);
        None
    }
}

/// An error status of the page itself.
fn report_status(url: &str, status: u64, text: &str) {
    let refusal = matches!(status, 401 | 403 | 429);
    if refusal {
        // A warning: the page stays open (a login may follow).
        warn!(
            "browser: {url} answered {status} {text}: the site refuses this browser. Sites \
             that refuse automated browsers do not work with 'tvpipe share URL' (it does not \
             hide that it is automated); log in with --visible --profile DIR if it needs a login"
        );
    } else {
        warn!("browser: {url} answered {status} {text}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_states() {
        let st = |s: &str| parse_state(&Value::from(s)).0;
        assert_eq!(st("none"), PageState::None);
        assert_eq!(parse_state(&Value::Null), (PageState::None, None));
        assert_eq!(st("connecting\n"), PageState::Starting);
        assert_eq!(st("capturing\n"), PageState::Starting);
        assert_eq!(
            parse_state(&Value::from("sharing\n\n1920x1024")),
            (PageState::Sharing, Some((1920, 1024)))
        );
        assert_eq!(
            parse_state(&Value::from("none\n\n800x600")),
            (PageState::None, Some((800, 600)))
        );
        assert_eq!(
            st("ended\nNotAllowedError: Permission denied\n1x1"),
            PageState::Ended("NotAllowedError: Permission denied".into())
        );
        assert_eq!(st("ended\n"), PageState::Ended("the share ended".into()));
        assert_eq!(parse_state(&Value::from("sharing\n\nAxB")).1, None);
    }

    #[test]
    fn meet_is_refused() {
        for u in [
            "https://meet.google.com/abc-defg-hij",
            "https://MEET.google.com",
            "meet.google.com/x",
            "https://user@meet.google.com:443/x",
        ] {
            assert!(check_url(u).is_err(), "{u}");
        }
        for u in [
            "https://example.com/meet.google.com",
            "https://google.com/meet",
            "http://127.0.0.1:8080/?meet.google.com",
            "file:///tmp/x.html",
        ] {
            assert!(check_url(u).is_ok(), "{u}");
        }
    }

    #[test]
    fn page_urls() {
        assert_eq!(
            page_url("https://example.com/a?b").unwrap(),
            "https://example.com/a?b"
        );
        assert_eq!(page_url("HTTP://x").unwrap(), "HTTP://x");
        assert_eq!(
            page_url("file:///tmp/x.html").unwrap(),
            "file:///tmp/x.html"
        );
        assert_eq!(
            page_url("example.com/dash").unwrap(),
            "https://example.com/dash"
        );
        assert_eq!(page_url("localhost:3000").unwrap(), "http://localhost:3000");
        assert_eq!(
            page_url("127.0.0.1:8080/x").unwrap(),
            "http://127.0.0.1:8080/x"
        );
        assert!(page_url("javascript://alert(1)").is_err());
        assert!(page_url("chrome://settings").is_err());
        assert!(page_url("").is_err());
        assert!(page_url("two words").is_err());
        assert_eq!(
            file_url(Path::new("/tmp/my page#1.html")),
            "file:///tmp/my%20page%231.html"
        );
        assert_eq!(
            file_url(Path::new(r"\\?\C:\Users\me\x.html")),
            "file:///C:/Users/me/x.html"
        );
        // An existing file.
        let f = std::env::temp_dir().join(format!("tvpipe page {}.html", std::process::id()));
        std::fs::write(&f, "<p>hi</p>").unwrap();
        let u = page_url(f.to_str().unwrap()).unwrap();
        std::fs::remove_file(&f).unwrap();
        assert!(
            u.starts_with("file:///") && u.ends_with(".html") && u.contains("%20"),
            "{u}"
        );
    }

    #[test]
    fn start_script_is_an_expression() {
        // `(function (wsUrl) {...})` called with a JSON string.
        let s = START_JS.trim();
        assert!(s.ends_with("})"), "{}", &s[s.len() - 20..]);
        assert!(s.contains("(function (wsUrl, opts)"));
        assert!(s.contains("preferCurrentTab: true"));
    }
}
