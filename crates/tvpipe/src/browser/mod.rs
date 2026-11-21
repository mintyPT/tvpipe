//! Streaming a browser.
//!
//! - [`share`]: `tvpipe share`, the 127.0.0.1 page server and the input
//!   the page's encoded H.264 and PCM feed.
//! - [`player`]: `--to browser`, a receiver that plays the stream
//!   in a browser tab (docs/player-protocol.md).
//! - [`protocol`]: the page's WebSocket messages (docs/share-protocol.md).
//! - [`headless`]: `tvpipe share URL`, a browser of tvpipe's own
//!   that shares its tab through the same capture script ([`launch`]
//!   starts it, [`cdp`] drives a Chromium-based one over the DevTools
//!   protocol, Firefox over WebDriver BiDi with [`bidi`]).
//! - [`screen`]: `tvpipe screen`, a browser of tvpipe's own that
//!   captures a screen or a window with the computer's sound.
//! - [`fonts`]: the fonts of the share and player pages, compiled in, and
//!   `ui.css`, tvpipe's look for the playshare launcher and games.
//! - [`platform`]: opening a URL with the OS's opener and the browsers'
//!   install paths (the one place with `cfg(target_os)` in this module,
//!   like a config path).

#[cfg(feature = "player")]
pub mod access;
#[cfg(feature = "player")]
pub mod agent;
#[cfg(feature = "headless")]
pub mod bidi;
#[cfg(feature = "headless")]
pub mod cdp;
#[cfg(feature = "player")]
pub mod fonts;
#[cfg(feature = "headless")]
pub mod headless;
#[cfg(feature = "headless")]
pub mod launch;
pub mod layout;
#[cfg(feature = "player")]
pub mod platform;
#[cfg(feature = "player")]
pub mod player;
pub mod player_options;
pub mod protocol;
#[cfg(feature = "headless")]
pub mod screen;
#[cfg(feature = "share")]
pub mod share;
