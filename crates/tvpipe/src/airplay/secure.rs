//! The encrypted AirPlay control channel.
//!
//! After pair-verify (or transient pair-setup) every byte on the control
//! connection is framed as
//!
//! ```text
//! length: u16le | ChaCha20-Poly1305(plaintext[length]) | tag[16]
//! ```
//!
//! with at most 1024 plaintext bytes per frame, the two length bytes as
//! associated data, and a per-direction nonce counter starting at zero
//! (4 zero bytes, then the counter as 8 little-endian bytes). The keys are
//! HKDF-SHA512 of the pairing's shared secret with salt `Control-Salt` and
//! info `Control-Write-Encryption-Key` (sender → receiver) and
//! `Control-Read-Encryption-Key` (receiver → sender).
//!
//! [`SecureStream`] implements `Read + Write`, so `net::http::Conn` and
//! `net::rtsp::RtspClient` run on it unchanged.
//!
//! Sources: HAP specification §5.2.2 (frame layout, 1024-byte frames,
//! AAD); pyatv (MIT) `pyatv/auth/hap_session.py` (`HAPSession`),
//! `pyatv/support/chacha20.py` (8-byte LE counter nonce), and
//! `pyatv/protocols/airplay/auth/__init__.py` (`CONTROL_SALT`,
//! `CONTROL_OUTPUT_INFO`, `CONTROL_INPUT_INFO`).

use std::io::{self, Read, Write};

use crate::crypto::ring::{
    hkdf_sha512_array, nonce_counter, ChaCha20Poly1305, CHACHA_KEY_LEN, CHACHA_TAG_LEN,
};
use crate::error::Result;

pub const CONTROL_SALT: &[u8] = b"Control-Salt";
pub const CONTROL_WRITE_INFO: &[u8] = b"Control-Write-Encryption-Key";
pub const CONTROL_READ_INFO: &[u8] = b"Control-Read-Encryption-Key";

/// Largest plaintext per frame (HAP §5.2.2).
pub const MAX_FRAME: usize = 1024;

/// A pair of directional keys.
#[derive(Clone, PartialEq, Eq)]
pub struct Keys {
    /// Encrypts what we send.
    pub write: [u8; CHACHA_KEY_LEN],
    /// Decrypts what we receive.
    pub read: [u8; CHACHA_KEY_LEN],
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Keys { .. }")
    }
}

impl Keys {
    /// `write = HKDF(shared, salt, write_info)`, `read = HKDF(shared, salt,
    /// read_info)`, 32 bytes each.
    pub fn derive(shared: &[u8], salt: &[u8], write_info: &[u8], read_info: &[u8]) -> Result<Keys> {
        Ok(Keys {
            write: hkdf_sha512_array(salt, shared, write_info)?,
            read: hkdf_sha512_array(salt, shared, read_info)?,
        })
    }

    /// The sender's control channel keys for a pairing shared secret.
    pub fn control(shared: &[u8]) -> Result<Keys> {
        Keys::derive(shared, CONTROL_SALT, CONTROL_WRITE_INFO, CONTROL_READ_INFO)
    }

    /// The same keys from the other end's point of view.
    pub fn swapped(&self) -> Keys {
        Keys {
            write: self.read,
            read: self.write,
        }
    }
}

/// One direction's cipher state.
struct Direction {
    cipher: ChaCha20Poly1305,
    counter: u64,
}

impl Direction {
    fn new(key: &[u8; CHACHA_KEY_LEN]) -> Direction {
        Direction {
            cipher: ChaCha20Poly1305::new(key),
            counter: 0,
        }
    }

    fn next_nonce(&mut self) -> io::Result<[u8; 12]> {
        let n = nonce_counter(self.counter);
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or_else(|| io::Error::other("secure channel: nonce counter exhausted"))?;
        Ok(n)
    }
}

/// An encrypted stream over `S` (usually a `TcpStream`).
pub struct SecureStream<S> {
    inner: S,
    writer: Direction,
    reader: Direction,
    /// Raw bytes read from `inner`, not yet a whole frame.
    raw: Vec<u8>,
    /// Decrypted bytes not yet returned; `plain[plain_pos..]` is pending.
    plain: Vec<u8>,
    plain_pos: usize,
    /// Set when a write failed half way: the peer's counter is now out of
    /// step, so the stream is unusable.
    broken: bool,
}

impl<S> std::fmt::Debug for SecureStream<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecureStream")
            .field("sent_frames", &self.writer.counter)
            .field("received_frames", &self.reader.counter)
            .finish_non_exhaustive()
    }
}

const READ_CHUNK: usize = 4096;

impl<S> SecureStream<S> {
    pub fn new(inner: S, keys: &Keys) -> SecureStream<S> {
        SecureStream {
            inner,
            writer: Direction::new(&keys.write),
            reader: Direction::new(&keys.read),
            raw: Vec::new(),
            plain: Vec::new(),
            plain_pos: 0,
            broken: false,
        }
    }

    pub fn get_ref(&self) -> &S {
        &self.inner
    }

    /// The underlying stream (e.g. to set timeouts). Reading or writing it
    /// directly breaks the framing.
    pub fn get_mut(&mut self) -> &mut S {
        &mut self.inner
    }

    pub fn into_inner(self) -> S {
        self.inner
    }

    /// Encrypts `data` into frames appended to `out`.
    fn seal_frames(&mut self, data: &[u8], out: &mut Vec<u8>) -> io::Result<()> {
        for chunk in data.chunks(MAX_FRAME) {
            let len = (chunk.len() as u16).to_le_bytes();
            let nonce = self.writer.next_nonce()?;
            let start = out.len();
            out.extend_from_slice(&len);
            let mut buf = chunk.to_vec();
            self.writer
                .cipher
                .seal_in_place(&nonce, &len, &mut buf)
                .map_err(|e| io::Error::other(e.to_string()))?;
            out.extend_from_slice(&buf);
            debug_assert_eq!(out.len() - start, 2 + chunk.len() + CHACHA_TAG_LEN);
        }
        Ok(())
    }

    /// Decrypts one whole frame from the front of `raw`, if there is one.
    fn open_frame(&mut self) -> io::Result<bool> {
        if self.raw.len() < 2 {
            return Ok(false);
        }
        let len_bytes = [self.raw[0], self.raw[1]];
        let len = u16::from_le_bytes(len_bytes) as usize;
        let total = 2 + len + CHACHA_TAG_LEN;
        if self.raw.len() < total {
            return Ok(false);
        }
        let nonce = self.reader.next_nonce()?;
        let n = self
            .reader
            .cipher
            .open_in_place(&nonce, &len_bytes, &mut self.raw[2..total])
            .map_err(|e| {
                io::Error::new(io::ErrorKind::InvalidData, format!("secure channel: {e}"))
            })?
            .len();
        self.plain.clear();
        self.plain.extend_from_slice(&self.raw[2..2 + n]);
        self.plain_pos = 0;
        self.raw.drain(..total);
        Ok(true)
    }
}

impl<S: Read> Read for SecureStream<S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            if self.plain_pos < self.plain.len() {
                let pending = &self.plain[self.plain_pos..];
                let n = pending.len().min(buf.len());
                buf[..n].copy_from_slice(&pending[..n]);
                self.plain_pos += n;
                return Ok(n);
            }
            if self.open_frame()? {
                // A zero-length frame yields nothing; keep going.
                continue;
            }
            let mut chunk = [0u8; READ_CHUNK];
            let n = self.inner.read(&mut chunk)?;
            if n == 0 {
                if self.raw.is_empty() {
                    return Ok(0);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "secure channel: connection closed inside a frame",
                ));
            }
            self.raw.extend_from_slice(&chunk[..n]);
        }
    }
}

impl<S: Write> Write for SecureStream<S> {
    /// Frames and sends all of `buf` (so one `write_all` of a message is
    /// one burst of frames).
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.broken {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "secure channel: an earlier write failed",
            ));
        }
        if buf.is_empty() {
            return Ok(0);
        }
        let frames = buf.len().div_ceil(MAX_FRAME);
        let mut out = Vec::with_capacity(buf.len() + frames * (2 + CHACHA_TAG_LEN));
        self.seal_frames(buf, &mut out)?;
        if let Err(e) = self.inner.write_all(&out) {
            self.broken = true;
            return Err(e);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::http::tests::Duplex;
    use crate::util::vectors;

    #[test]
    fn known_frames() {
        for b in vectors::load("airplay/secure.txt") {
            let name = b.name();
            let keys = Keys::control(&b.hex("shared")).unwrap();
            assert_eq!(keys.write.to_vec(), b.hex("write_key"), "{name}");
            assert_eq!(keys.read.to_vec(), b.hex("read_key"), "{name}");
            let mut s = SecureStream::new(Duplex::new(&[]), &keys);
            for i in 0.. {
                let Some(pt) = b.get(&format!("pt{i}")) else {
                    break;
                };
                let pt = crate::util::hex::decode(pt).unwrap();
                s.write_all(&pt).unwrap();
            }
            assert_eq!(s.get_ref().output, b.hex("wire"), "{name}: wire");

            // The receiver's view decrypts it back.
            let wire = s.into_inner().output;
            let mut r = SecureStream::new(Duplex::new(&wire), &keys.swapped());
            let mut got = Vec::new();
            r.read_to_end(&mut got).unwrap();
            let mut want = Vec::new();
            for i in 0.. {
                let Some(pt) = b.get(&format!("pt{i}")) else {
                    break;
                };
                want.extend(crate::util::hex::decode(pt).unwrap());
            }
            assert_eq!(got, want, "{name}: plaintext");
        }
    }

    fn pair() -> (Keys, Keys) {
        let k = Keys::control(b"shared secret").unwrap();
        let s = k.swapped();
        (k, s)
    }

    #[test]
    fn large_writes_split_and_tiny_reads() {
        let (k, s) = pair();
        let data: Vec<u8> = (0..5000u32).map(|i| i as u8).collect();
        let mut w = SecureStream::new(Duplex::new(&[]), &k);
        w.write_all(&data).unwrap();
        let wire = w.into_inner().output;
        // 4 full frames + 904 bytes.
        assert_eq!(wire.len(), 5000 + 5 * 18);
        assert_eq!(&wire[..2], &1024u16.to_le_bytes());
        let mut duplex = Duplex::new(&wire);
        duplex.piece = 3;
        let mut r = SecureStream::new(duplex, &s);
        let mut got = Vec::new();
        let mut buf = [0u8; 7];
        loop {
            let n = r.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            got.extend_from_slice(&buf[..n]);
        }
        assert_eq!(got, data);
    }

    #[test]
    fn tampering_and_truncation_are_errors() {
        let (k, s) = pair();
        let mut w = SecureStream::new(Duplex::new(&[]), &k);
        w.write_all(b"hello").unwrap();
        w.write_all(b"world").unwrap();
        let wire = w.into_inner().output;

        let mut bad = wire.clone();
        bad[3] ^= 1;
        let mut r = SecureStream::new(Duplex::new(&bad), &s);
        let err = r.read(&mut [0u8; 16]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);

        // Frames out of order fail (nonce counter).
        let (a, b) = wire.split_at(wire.len() / 2);
        let swapped = [b, a].concat();
        let mut r = SecureStream::new(Duplex::new(&swapped), &s);
        assert!(r.read(&mut [0u8; 16]).is_err());

        let mut r = SecureStream::new(Duplex::new(&wire[..wire.len() - 1]), &s);
        let mut out = Vec::new();
        let err = r.read_to_end(&mut out).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
        assert_eq!(out, b"hello");

        // Wrong direction keys fail.
        let mut r = SecureStream::new(Duplex::new(&wire), &k);
        assert!(r.read(&mut [0u8; 16]).is_err());
    }

    #[test]
    fn http_over_secure_stream() {
        use crate::net::http::{Conn, Request, Version};
        let (k, s) = pair();
        // Receiver side: encrypt a canned response.
        let mut rx = SecureStream::new(Duplex::new(&[]), &s);
        rx.write_all(b"RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: 2\r\n\r\nok")
            .unwrap();
        let wire = rx.into_inner().output;
        let mut conn = Conn::new(SecureStream::new(Duplex::new(&wire), &k));
        let resp = conn
            .request(&Request::new("GET", "/info", Version::Rtsp10).header("CSeq", "1"))
            .unwrap();
        assert_eq!(resp.body, b"ok");
        // What we sent decrypts on the receiver side.
        let sent = conn.into_parts().0.into_inner().output;
        let mut rx = SecureStream::new(Duplex::new(&sent), &s);
        let mut text = String::new();
        rx.read_to_string(&mut text).unwrap();
        assert_eq!(text, "GET /info RTSP/1.0\r\nCSeq: 1\r\n\r\n");
    }
}
