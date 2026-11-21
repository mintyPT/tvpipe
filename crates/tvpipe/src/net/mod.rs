//! Networking: mDNS/DNS, interface selection, HTTP/RTSP framing, discovery,
//! and the loopback HTTP server and WebSocket used by the browser share.

pub mod base64;
#[cfg(feature = "tunnel")]
pub mod cftunnel;
pub mod device;
pub mod discover;
pub mod dns;
#[cfg(feature = "playshare")]
pub mod fetch;
pub mod http;
#[cfg(feature = "player")]
pub mod httpd;
pub mod iface;
pub mod mdns;
#[cfg(feature = "tunnel")]
pub mod opentunnel;
#[cfg(feature = "tunnel")]
mod roots;
pub mod rtsp;
#[cfg(feature = "tunnel")]
pub mod tls;
pub mod tunnel;
#[cfg(feature = "player")]
pub mod websocket;
