//! Why a receiver refuses us, said so that people can fix it
//! (docs/airplay-mirroring.md §2.1): an Apple Home that takes only its
//! members, a Mac that takes only its own user, a 403 after pairing, a
//! password wanted as HTTP Digest. Each is an error with a stable code
//! (docs/machine.md) and the device's name.

use crate::error::Error;

/// What to change in the Home app for a members-only receiver.
pub const HOME_ACCESS: &str = "in the Home app, open Home Settings > Speakers & TV and set \
     Allow Speaker & TV Access to \"Anyone On the Same Network\" (or \"Everyone\")";

fn named(e: Error, name: &str) -> Error {
    e.with_device(name)
}

/// `home-only`: its advertisement says `acl=1`, only its Apple Home's
/// members may stream to it.
pub fn home_only(name: &str) -> Error {
    named(
        Error::auth(format!(
            "airplay: {name} takes AirPlay only from members of its Apple Home: {HOME_ACCESS}"
        ))
        .with_code("home-only"),
        name,
    )
}

/// `forbidden`: a Mac whose AirPlay Receiver allows only its own user
/// (`act=2`) refuses pair-setup.
pub fn owner_only(name: &str) -> Error {
    named(
        Error::auth(format!(
            "airplay: {name} takes AirPlay only from its own user's devices: on that Mac, in \
             System Settings > General > AirDrop & Handoff > AirPlay Receiver, set Allow \
             AirPlay for to \"Anyone on the same network\" or \"Everyone\""
        ))
        .with_code("forbidden"),
        name,
    )
}

/// `forbidden`: it took our pairing and answered the session 403. The
/// one known cause is an Apple Home that takes only its members.
pub fn forbidden(name: &str) -> Error {
    named(
        Error::auth(format!(
            "airplay: {name} refused the session (403 Forbidden); if it is in an Apple Home \
             that takes only its members, {HOME_ACCESS}"
        ))
        .with_code("forbidden"),
        name,
    )
}

/// `password-unsupported`: it answered the session 401 after pairing, so
/// it wants its password as HTTP Digest (§3), which tvpipe does not send.
pub fn password_unsupported(name: &str) -> Error {
    named(
        Error::unsupported(format!(
            "airplay: {name} wants its AirPlay password for streaming (401 Unauthorized), \
             which tvpipe cannot send: turn Require Password off (in the Home app under \
             Speakers & TV, in the TV's AirPlay settings, or on a Mac under AirPlay Receiver)"
        ))
        .with_code("password-unsupported"),
        name,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_and_devices() {
        for (e, code) in [
            (home_only("TV"), "home-only"),
            (owner_only("TV"), "forbidden"),
            (forbidden("TV"), "forbidden"),
            (password_unsupported("TV"), "password-unsupported"),
        ] {
            assert_eq!((e.code(), e.device()), (Some(code), Some("TV")), "{e}");
        }
        assert!(home_only("TV")
            .to_string()
            .contains("Anyone On the Same Network"));
        assert!(owner_only("TV").to_string().contains("Allow AirPlay for"));
    }
}
