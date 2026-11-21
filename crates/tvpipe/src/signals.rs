//! Ctrl-C and SIGTERM as a stop request, so a program can end its
//! sessions cleanly: the receivers get their TEARDOWN/STOP and leave
//! mirroring mode (ARCHITECTURE.md, "Session Lifecycle"). Opt-in, with
//! the `signals` feature; the library never installs a handler by itself.
//!
//! ```no_run
//! # fn main() -> tvpipe::Result<()> {
//! let stream = tvpipe::stream(tvpipe::Options::new().to("Living Room"))?;
//! // One line: Ctrl-C stops the stream (a second Ctrl-C exits at once).
//! tvpipe::signals::stop_on_signal(stream.stopper());
//! # Ok(()) }
//! ```
//!
//! std cannot change how a process reacts to Ctrl-C: the default is to
//! die at once. This module and `util::timer` are the only places with
//! platform FFI outside the config-directory paths (see ARCHITECTURE.md,
//! "Platform-Specific Code"), against the C runtime std links anyway; no
//! crate.
//!
//! - unix: `signal(SIGINT/SIGTERM)` installs a handler that only stores
//!   into an atomic (async-signal-safe); a second signal calls `_exit(130)`.
//! - windows: `SetConsoleCtrlHandler`; the handler runs on its own thread,
//!   stores the flag and returns TRUE; on a second Ctrl-C it returns FALSE
//!   so the default handler ends the process.
//!
//! A handler may only touch an atomic, so [`on_signal`] and
//! [`stop_on_signal`] poll it from a thread of their own (every 20 ms).
//! [`before_forced_exit`] does the same for the second signal: with it,
//! the second signal leaves the exit to that thread (which first runs its
//! cleanup, e.g. restoring the terminal) and only a third exits at once.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::Stopper;

static REQUESTED: AtomicBool = AtomicBool::new(false);
/// A [`before_forced_exit`] thread waits for the second signal.
static DEFERRED: AtomicBool = AtomicBool::new(false);
/// The second signal came; the waiting thread exits.
static FORCED: AtomicBool = AtomicBool::new(false);

/// What the handler does on a signal: stop (first), leave the exit to
/// the [`before_forced_exit`] thread (second, if one waits), exit at once.
fn on_signal_flags() -> bool {
    if !REQUESTED.swap(true, Ordering::SeqCst) {
        return true;
    }
    DEFERRED.load(Ordering::SeqCst) && !FORCED.swap(true, Ordering::SeqCst)
}

/// Installs the Ctrl-C/SIGTERM handler (again is fine). Returns false if
/// the platform refused or has none here; Ctrl-C then ends the process as
/// usual.
pub fn install() -> bool {
    sys::install()
}

/// Whether Ctrl-C or SIGTERM came (after [`install`]). A program that
/// stops for this reason usually exits with status 130.
pub fn requested() -> bool {
    REQUESTED.load(Ordering::SeqCst)
}

/// Installs the handler and runs `f` once, on a thread of its own, when
/// Ctrl-C or SIGTERM comes. Returns false (and never runs `f`) if no
/// handler could be installed or the thread could not start.
pub fn on_signal(f: impl FnOnce() + Send + 'static) -> bool {
    if !install() {
        return false;
    }
    std::thread::Builder::new()
        .name("tvpipe-signals".into())
        .spawn(move || {
            while !requested() {
                std::thread::sleep(Duration::from_millis(20));
            }
            f();
        })
        .is_ok()
}

/// Runs `f` before a second Ctrl-C/SIGTERM ends the process (after
/// [`install`]): `f` runs on a thread of its own, then the process exits
/// with 130. Meant for quick cleanup such as restoring the terminal; a
/// third signal exits at once, also while `f` runs. Returns false if the
/// thread could not start (the second signal then exits at once, as
/// without this).
pub fn before_forced_exit(f: impl FnOnce() + Send + 'static) -> bool {
    let started = std::thread::Builder::new()
        .name("tvpipe-forced-exit".into())
        .spawn(move || {
            while !FORCED.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(20));
            }
            f();
            std::process::exit(130);
        })
        .is_ok();
    if started {
        DEFERRED.store(true, Ordering::SeqCst);
    }
    started
}

/// Stops a session or stream on Ctrl-C/SIGTERM ([`on_signal`] with
/// [`Stopper::stop`]).
pub fn stop_on_signal(stopper: Stopper) -> bool {
    on_signal(move || stopper.stop())
}

#[cfg(unix)]
mod sys {

    // POSIX signal numbers; identical on every unix we build for.
    const SIGINT: i32 = 2;
    const SIGTERM: i32 = 15;
    /// `SIG_ERR` is `(sighandler_t)-1`.
    const SIG_ERR: usize = usize::MAX;

    extern "C" {
        // `sighandler_t signal(int, sighandler_t)`; a handler is a
        // pointer-sized function address.
        fn signal(signum: i32, handler: usize) -> usize;
        fn _exit(status: i32) -> !;
    }

    extern "C" fn on_signal(_signum: i32) {
        // Only async-signal-safe operations: lock-free atomics, and
        // `_exit` (which runs no atexit handlers or destructors).
        if !super::on_signal_flags() {
            // SAFETY: `_exit` is async-signal-safe and takes any status.
            unsafe { _exit(130) }
        }
    }

    pub fn install() -> bool {
        let handler = on_signal as extern "C" fn(i32) as usize;
        // SAFETY: `signal` is the C library's; `on_signal` has the
        // `void (*)(int)` ABI it expects and only touches an atomic.
        unsafe { signal(SIGINT, handler) != SIG_ERR && signal(SIGTERM, handler) != SIG_ERR }
    }
}

#[cfg(windows)]
mod sys {
    const CTRL_C_EVENT: u32 = 0;
    const CTRL_BREAK_EVENT: u32 = 1;

    type HandlerRoutine = unsafe extern "system" fn(u32) -> i32;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetConsoleCtrlHandler(handler: Option<HandlerRoutine>, add: i32) -> i32;
    }

    unsafe extern "system" fn on_ctrl(event: u32) -> i32 {
        match event {
            // First press (and the second with a `before_forced_exit`
            // thread waiting): handled (TRUE); then not handled (FALSE), so
            // the default handler ends the process.
            CTRL_C_EVENT | CTRL_BREAK_EVENT => super::on_signal_flags() as i32,
            _ => 0,
        }
    }

    pub fn install() -> bool {
        // SAFETY: `on_ctrl` has the PHANDLER_ROUTINE ABI and only touches
        // an atomic; adding a handler has no other preconditions.
        unsafe { SetConsoleCtrlHandler(Some(on_ctrl), 1) != 0 }
    }
}

#[cfg(not(any(unix, windows)))]
mod sys {
    pub fn install() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs() {
        // Raising a signal here would set the process-wide flag for every
        // other test; the handler itself is checked by hand (see 0004).
        assert!(install());
        assert!(install(), "installing twice is fine");
        assert!(!requested());
    }
}
