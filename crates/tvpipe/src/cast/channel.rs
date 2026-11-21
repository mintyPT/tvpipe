//! The Cast v2 control channel: TLS to the receiver (port 8009
//! by default), `u32be length | CastMessage` framing, and the
//! `tp.heartbeat` keep-alive.
//!
//! - TLS uses rustls with the ring provider. Cast receivers present
//!   self-signed (device) certificates, so [`AcceptAnyCert`] accepts any
//!   certificate chain but still verifies the handshake signatures against
//!   the presented key. Device authentication (`tp.deviceauth`) is not done.
//! - One reader thread owns the receive side. It decodes frames (at most
//!   [`MAX_MESSAGE_SIZE`] bytes each), answers `PING` with `PONG` itself,
//!   sends our own `PING` every [`HEARTBEAT_INTERVAL`], and hands every
//!   other message to [`Channel::recv_timeout`]. If the peer is silent for
//!   [`PEER_TIMEOUT`] the channel closes.
//! - Writes go through [`ChannelSender`] (cloneable, usable from any thread).
//!
//! Virtual connections (`tp.connection` CONNECT/CLOSE) are plain messages;
//! see [`super::messages`].
//!
//! Sources: openscreen `cast/common/channel/message_framer.cc` (64 KiB body
//! limit), `cast/common/channel/message_util.h` (namespaces, platform ids);
//! pychromecast `socket_client.py` (MIT) for heartbeat behaviour.

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme};

use super::messages;
use crate::codec::protobuf::CastMessage;
use crate::error::{Error, ErrorKind, Result};

/// Largest accepted message body (openscreen `kMaxBodySize`).
pub const MAX_MESSAGE_SIZE: usize = 65536;
/// How often we send `PING`.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
/// Silence from the peer after which the channel is considered dead.
pub const PEER_TIMEOUT: Duration = Duration::from_secs(20);
/// Default Cast control port.
pub const DEFAULT_PORT: u16 = 8009;

/// How long a blocking write may take before the channel gives up.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Reader poll granularity (drives the heartbeat timer).
const READ_POLL: Duration = Duration::from_millis(500);
/// Incoming messages buffered before the reader blocks.
const QUEUE_LEN: usize = 256;

/// A certificate verifier for Cast devices: any certificate is accepted
/// (they are self-signed or chain to Google's device CAs, which we do not
/// ship), but TLS handshake signatures are still checked so the peer must
/// hold the private key of the certificate it presented.
#[derive(Debug)]
pub struct AcceptAnyCert {
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl AcceptAnyCert {
    pub fn new(provider: Arc<rustls::crypto::CryptoProvider>) -> AcceptAnyCert {
        AcceptAnyCert { provider }
    }
}

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// The rustls client configuration used for Cast receivers.
pub fn tls_config() -> Result<Arc<ClientConfig>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::crypto(format!("cast: TLS config: {e}")))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyCert::new(provider)))
        .with_no_client_auth();
    Ok(Arc::new(config))
}

/// Splits complete frames off the front of `buf`.
///
/// Returns the decoded messages; a frame that does not decode is an error
/// (the stream is then out of sync and must be closed).
pub fn deframe(buf: &mut Vec<u8>) -> Result<Vec<CastMessage>> {
    let mut out = Vec::new();
    let mut pos = 0;
    loop {
        let rest = &buf[pos..];
        if rest.len() < 4 {
            break;
        }
        let len = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
        if len == 0 || len > MAX_MESSAGE_SIZE {
            return Err(Error::malformed(format!(
                "cast channel: bad message length {len}"
            )));
        }
        if rest.len() < 4 + len {
            break;
        }
        out.push(CastMessage::decode(&rest[4..4 + len])?);
        pos += 4 + len;
    }
    buf.drain(..pos);
    Ok(out)
}

struct Tls {
    conn: ClientConnection,
    sock: TcpStream,
}

impl Tls {
    /// Encrypts `plain` and flushes all pending TLS records to the socket.
    fn write_all(&mut self, plain: &[u8]) -> Result<()> {
        self.conn
            .writer()
            .write_all(plain)
            .map_err(|e| Error::io("cast channel: TLS write", e))?;
        self.flush()
    }

    fn flush(&mut self) -> Result<()> {
        while self.conn.wants_write() {
            self.conn
                .write_tls(&mut self.sock)
                .map_err(|e| Error::io("cast channel: socket write", e))?;
        }
        Ok(())
    }
}

struct Shared {
    tls: Mutex<Tls>,
    closed: AtomicBool,
    /// Why the reader stopped, if it did.
    close_reason: Mutex<Option<String>>,
}

impl Shared {
    fn send(&self, msg: &CastMessage) -> Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(self.closed_error());
        }
        let framed = msg.encode_framed();
        if framed.len() - 4 > MAX_MESSAGE_SIZE {
            return Err(Error::protocol("cast channel: message too large"));
        }
        trace!(
            "-> {} {} -> {}: {}",
            msg.namespace,
            msg.source_id,
            msg.destination_id,
            msg.payload_str().unwrap_or("<binary>")
        );
        let mut tls = self
            .tls
            .lock()
            .map_err(|_| Error::closed("cast channel: poisoned"))?;
        tls.write_all(&framed)
    }

    fn closed_error(&self) -> Error {
        let reason = self
            .close_reason
            .lock()
            .ok()
            .and_then(|r| r.clone())
            .unwrap_or_else(|| "closed".into());
        Error::closed(format!("cast channel: {reason}"))
    }

    fn mark_closed(&self, reason: String) {
        if let Ok(mut r) = self.close_reason.lock() {
            r.get_or_insert(reason);
        }
        self.closed.store(true, Ordering::Release);
    }
}

/// A cloneable handle for sending on a [`Channel`] from other threads.
#[derive(Clone)]
pub struct ChannelSender {
    shared: Arc<Shared>,
}

impl ChannelSender {
    pub fn send(&self, msg: &CastMessage) -> Result<()> {
        self.shared.send(msg)
    }

    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
    }
}

/// A TLS connection to a Cast receiver.
pub struct Channel {
    shared: Arc<Shared>,
    rx: Receiver<CastMessage>,
    reader: Option<JoinHandle<()>>,
    peer: SocketAddr,
}

impl Channel {
    /// Connects and completes the TLS handshake within `timeout`.
    pub fn connect(addr: SocketAddr, timeout: Duration) -> Result<Channel> {
        let sock = TcpStream::connect_timeout(&addr, timeout)
            .map_err(|e| Error::io(format!("cast: connect to {addr}"), e))?;
        Channel::from_tcp(sock, timeout)
    }

    /// Runs the TLS handshake over an already connected socket.
    pub fn from_tcp(mut sock: TcpStream, timeout: Duration) -> Result<Channel> {
        let peer = sock
            .peer_addr()
            .map_err(|e| Error::io("cast: peer address", e))?;
        let _ = sock.set_nodelay(true);
        let name = ServerName::IpAddress(peer.ip().into());
        let mut conn = ClientConnection::new(tls_config()?, name)
            .map_err(|e| Error::crypto(format!("cast: TLS setup: {e}")))?;
        sock.set_read_timeout(Some(timeout))
            .and_then(|_| sock.set_write_timeout(Some(timeout)))
            .map_err(|e| Error::io("cast: socket options", e))?;
        let deadline = Instant::now() + timeout;
        while conn.is_handshaking() {
            if Instant::now() > deadline {
                return Err(Error::timeout("cast: TLS handshake timed out"));
            }
            conn.complete_io(&mut sock).map_err(|e| {
                if e.kind() == std::io::ErrorKind::InvalidData {
                    Error::crypto(format!("cast: TLS handshake with {peer}: {e}"))
                } else {
                    Error::io(format!("cast: TLS handshake with {peer}"), e)
                }
            })?;
        }
        debug!(
            "TLS to {peer}: {:?} {:?}",
            conn.protocol_version(),
            conn.negotiated_cipher_suite().map(|s| s.suite())
        );
        sock.set_read_timeout(Some(READ_POLL))
            .and_then(|_| sock.set_write_timeout(Some(WRITE_TIMEOUT)))
            .map_err(|e| Error::io("cast: socket options", e))?;
        let read_sock = sock
            .try_clone()
            .map_err(|e| Error::io("cast: clone socket", e))?;
        let shared = Arc::new(Shared {
            tls: Mutex::new(Tls { conn, sock }),
            closed: AtomicBool::new(false),
            close_reason: Mutex::new(None),
        });
        let (tx, rx) = mpsc::sync_channel(QUEUE_LEN);
        let reader_shared = shared.clone();
        let reader = std::thread::Builder::new()
            .name("cast-channel".into())
            .spawn(move || {
                let reason = match read_loop(&reader_shared, read_sock, tx) {
                    Ok(()) => "closed by peer".to_string(),
                    Err(e) => e.to_string(),
                };
                debug!("channel reader done: {reason}");
                reader_shared.mark_closed(reason);
            })
            .map_err(|e| Error::io("cast: spawn reader", e))?;
        Ok(Channel {
            shared,
            rx,
            reader: Some(reader),
            peer,
        })
    }

    pub fn peer(&self) -> SocketAddr {
        self.peer
    }

    pub fn sender(&self) -> ChannelSender {
        ChannelSender {
            shared: self.shared.clone(),
        }
    }

    pub fn send(&self, msg: &CastMessage) -> Result<()> {
        self.shared.send(msg)
    }

    /// The next incoming message (heartbeats are handled internally).
    /// `Ok(None)` on timeout; a `Closed` error once the connection is gone
    /// and every buffered message was delivered.
    pub fn recv_timeout(&self, timeout: Duration) -> Result<Option<CastMessage>> {
        match self.rx.recv_timeout(timeout) {
            Ok(m) => Ok(Some(m)),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err(self.shared.closed_error()),
        }
    }

    /// Like [`Channel::recv_timeout`] but never waits.
    pub fn try_recv(&self) -> Result<Option<CastMessage>> {
        match self.rx.try_recv() {
            Ok(m) => Ok(Some(m)),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => Err(self.shared.closed_error()),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
    }

    /// Sends a TLS close_notify, shuts the socket down and joins the reader.
    /// Safe to call more than once.
    pub fn close(&mut self) {
        if let Ok(mut tls) = self.shared.tls.lock() {
            if !self.shared.closed.load(Ordering::Acquire) {
                tls.conn.send_close_notify();
                let _ = tls.flush();
            }
            let _ = tls.sock.shutdown(Shutdown::Both);
        }
        self.shared.mark_closed("closed locally".into());
        if let Some(h) = self.reader.take() {
            let _ = h.join();
        }
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        self.close();
    }
}

fn read_loop(shared: &Shared, mut sock: TcpStream, tx: SyncSender<CastMessage>) -> Result<()> {
    let mut buf = vec![0u8; 16 * 1024];
    let mut plain = Vec::new();
    let mut last_rx = Instant::now();
    let mut last_ping = Instant::now();
    loop {
        if shared.closed.load(Ordering::Acquire) {
            return Ok(());
        }
        if last_ping.elapsed() >= HEARTBEAT_INTERVAL {
            last_ping = Instant::now();
            shared.send(&messages::ping())?;
        }
        if last_rx.elapsed() >= PEER_TIMEOUT {
            return Err(Error::timeout("heartbeat timed out"));
        }
        let n = match sock.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            Err(e) => return Err(Error::io("socket read", e)),
        };
        last_rx = Instant::now();
        let mut eof = false;
        {
            let mut tls = shared
                .tls
                .lock()
                .map_err(|_| Error::closed("cast channel: poisoned"))?;
            let mut input = &buf[..n];
            while !input.is_empty() {
                tls.conn
                    .read_tls(&mut input)
                    .map_err(|e| Error::io("TLS read", e))?;
                let state = tls
                    .conn
                    .process_new_packets()
                    .map_err(|e| Error::crypto(format!("TLS: {e}")));
                // Send any alert or post-handshake reply rustls queued.
                let _ = tls.flush();
                let state = state?;
                let avail = state.plaintext_bytes_to_read();
                if avail > 0 {
                    let start = plain.len();
                    plain.resize(start + avail, 0);
                    tls.conn
                        .reader()
                        .read_exact(&mut plain[start..])
                        .map_err(|e| Error::io("TLS plaintext", e))?;
                }
                if state.peer_has_closed() {
                    eof = true;
                }
            }
        }
        for msg in deframe(&mut plain)? {
            trace!(
                "<- {} {} -> {}: {}",
                msg.namespace,
                msg.source_id,
                msg.destination_id,
                msg.payload_str().unwrap_or("<binary>")
            );
            if msg.namespace == messages::NS_HEARTBEAT {
                if let Ok(v) = msg.payload_json() {
                    if v["type"].as_str() == Some("PING") {
                        shared.send(&messages::pong_to(&msg))?;
                    }
                }
                continue;
            }
            if tx.send(msg).is_err() {
                // Nobody listens any more; keep the heartbeat going only as
                // long as the owner holds the channel.
                return Ok(());
            }
        }
        if eof {
            return Ok(());
        }
    }
}

/// True for errors that mean the channel is gone (as opposed to a bad
/// message).
pub fn is_closed_error(e: &Error) -> bool {
    matches!(e.kind(), ErrorKind::Closed | ErrorKind::Timeout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cast::testing::TlsTestServer;

    #[test]
    fn deframe_splits_and_keeps_partial() {
        let a = CastMessage::text("s", "d", "ns", "{\"type\":\"A\"}");
        let b = CastMessage::text("s", "d", "ns", "{\"type\":\"B\"}");
        let mut buf = a.encode_framed();
        let fb = b.encode_framed();
        buf.extend_from_slice(&fb[..5]);
        let got = deframe(&mut buf).unwrap();
        assert_eq!(got, vec![a]);
        assert_eq!(buf, fb[..5]);
        buf.extend_from_slice(&fb[5..]);
        assert_eq!(deframe(&mut buf).unwrap(), vec![b]);
        assert!(buf.is_empty());
    }

    #[test]
    fn deframe_rejects_bad_lengths() {
        let mut buf = vec![0, 0, 0, 0];
        assert!(deframe(&mut buf).is_err());
        let mut buf = (MAX_MESSAGE_SIZE as u32 + 1).to_be_bytes().to_vec();
        assert!(deframe(&mut buf).is_err());
        let mut buf = vec![0, 0, 0, 3, 0xff, 0xff, 0xff];
        assert!(deframe(&mut buf).is_err());
    }

    #[test]
    fn tls_roundtrip_and_ping() {
        let server = TlsTestServer::spawn(|mut conn| {
            // Echo the first message back, then ping the client.
            let msg = conn.recv().unwrap();
            conn.send(&msg).unwrap();
            conn.send(&CastMessage::text(
                "receiver-0",
                "sender-0",
                messages::NS_HEARTBEAT,
                "{\"type\":\"PING\"}",
            ))
            .unwrap();
            let pong = conn.recv().unwrap();
            assert_eq!(pong.namespace, messages::NS_HEARTBEAT);
            assert_eq!(pong.payload_json().unwrap()["type"].as_str(), Some("PONG"));
        });
        let mut ch = Channel::connect(server.addr(), Duration::from_secs(5)).unwrap();
        let msg = CastMessage::text("a", "b", "urn:x-cast:test", "{\"x\":1}");
        ch.send(&msg).unwrap();
        let back = ch.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        assert_eq!(back, msg);
        server.join();
        // The server closed: the channel reports it.
        let err = loop {
            match ch.recv_timeout(Duration::from_secs(5)) {
                Ok(Some(_)) => continue,
                Ok(None) => panic!("no close"),
                Err(e) => break e,
            }
        };
        assert_eq!(err.kind(), ErrorKind::Closed);
        ch.close();
        ch.close();
    }
}
