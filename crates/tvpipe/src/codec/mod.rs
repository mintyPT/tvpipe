//! Wire formats.
//!
//! - [`json`]: JSON value, parser and serializer (Cast payloads, CLI output).
//! - [`bplist`]: binary property lists (AirPlay `/info`, RTSP SETUP bodies).
//! - [`tlv8`]: HAP TLV8 (AirPlay pair-setup / pair-verify).
//! - [`protobuf`]: protobuf wire helpers and the Cast `CastMessage`.
//!
//! Every decoder works on untrusted bytes: errors, never panics. Fixture
//! generators live in `scripts/vectors/`.

pub mod bplist;
mod fuzz;
pub mod json;
pub mod protobuf;
pub mod tlv8;
