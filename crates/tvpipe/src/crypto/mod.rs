//! Hand-rolled crypto (AES, modes, bigint, SRP) and thin `ring` wrappers.
//!
//! - [`aes`]: AES-128/192/256 block cipher (T-tables).
//! - [`modes`]: CTR (resumable keystream) and CBC (whole blocks).
//! - [`bigint`]: 4096-bit unsigned integers with Montgomery modpow.
//! - [`srp`]: SRP-6a client (and test server), SHA-512 / 3072-bit, HAP.
//! - [`ring`]: Ed25519, X25519, ChaCha20-Poly1305, HKDF, SHA, HMAC, RNG.
//!
//! Vectors: `tests/vectors/crypto/`; generators: `scripts/vectors/`.

pub mod aes;
pub mod bigint;
pub mod modes;
pub mod ring;
pub mod srp;
