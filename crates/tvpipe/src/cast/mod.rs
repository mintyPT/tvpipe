//! Google Cast Streaming sender (ARCHITECTURE.md, "Cast").
//!
//! - [`channel`]: TLS control channel, framing, heartbeat.
//! - [`messages`]: `tp.connection` / `tp.heartbeat` / `receiver` payloads.
//! - [`rtp`]: Cast RTP packets, frame ids, AES-CTR frame crypto.
//! - [`rtcp`]: Sender Reports, receiver feedback (ACK/NACK/PLI/logs).
//! - [`streaming`]: OFFER/ANSWER and the negotiated session.
//! - [`retransmit`]: per-stream frame history, ACK/NACK, kickstart, limits.
//! - [`sink`]: [`StreamingSink`] (the `types::Sink`) and [`connect`].
//! - `annexb`: AVCC → Annex B for H.264 frames.
//!
//! Without the `cast` feature only [`CastOptions`] is compiled.

#[cfg(feature = "cast")]
mod annexb;
#[cfg(feature = "cast")]
pub mod channel;
#[cfg(feature = "cast")]
pub mod messages;
mod options;
#[cfg(feature = "cast")]
pub mod retransmit;
#[cfg(feature = "cast")]
pub mod rtcp;
#[cfg(feature = "cast")]
pub mod rtp;
#[cfg(feature = "cast")]
pub mod sink;
#[cfg(feature = "cast")]
pub mod streaming;

#[cfg(all(test, feature = "cast"))]
pub(crate) mod fake_receiver;
#[cfg(all(test, feature = "cast"))]
mod receiver_loop;
#[cfg(all(test, feature = "cast"))]
mod testing;

#[allow(unused_imports)]
pub use options::{AacFraming, CastOptions};
#[cfg(feature = "cast")]
#[allow(unused_imports)]
pub use sink::{connect, connect_device, StreamingSink};
