//! Single keys on a terminal: stdin switched to non-canonical, no-echo
//! input (`stty -icanon -echo min 1 time 0`), so `q` needs no Enter.
//!
//! Through the `stty` program (std::process with stdin inherited), not
//! OS calls (AGENTS.md: platform-neutral code). Where stty is missing or
//! changes nothing (Windows consoles; an MSYS stty that only reports a
//! terminal of its own), [`enter`] fails and input stays line by line
//! (`q` + Enter).
//!
//! The terminal gets its old state back (`stty` with what `stty -g`
//! printed) on every way out: [`restore`] when `main` returns (normal end,
//! errors, `q`, the first Ctrl-C), on a panic (a hook), and before a
//! second Ctrl-C ends the process (main, through
//! `tvpipe::signals::before_forced_exit`);
//! [`Cooked`] lends the terminal back in its old state to a prompt
//! that reads a line.

use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// The terminal's state before [`enter`], as `stty -g` printed it.
static SAVED: OnceLock<String> = OnceLock::new();
/// Single keys are on now.
static ON: AtomicBool = AtomicBool::new(false);
/// [`restore`] ran: never single keys again.
static DONE: AtomicBool = AtomicBool::new(false);

const KEYS: [&str; 6] = ["-icanon", "-echo", "min", "1", "time", "0"];

/// Runs `stty ARGS` on stdin; its stdout if it succeeded.
fn stty(args: &[&str]) -> Option<String> {
    let out = Command::new("stty")
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// Switches stdin (a terminal; the caller checks) to single keys without
/// echo. False if that is not possible here: input stays line by line.
pub fn enter() -> bool {
    if DONE.load(Ordering::SeqCst) || SAVED.get().is_some() {
        return ON.load(Ordering::SeqCst);
    }
    let Some(before) = stty(&["-g"]).filter(|s| !s.is_empty()) else {
        return false;
    };
    if stty(&KEYS).is_none() {
        let _ = stty(&[&before]);
        return false;
    }
    // A stty that succeeds without changing the terminal (an MSYS stty on
    // a Windows console) leaves it line by line.
    if stty(&["-g"]).is_none_or(|after| after == before) {
        let _ = stty(&[&before]);
        return false;
    }
    if SAVED.set(before).is_err() {
        return false;
    }
    ON.store(true, Ordering::SeqCst);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        previous(info);
    }));
    true
}

/// Single keys are on (not while a [`Cooked`] prompt reads a line).
pub fn keys() -> bool {
    ON.load(Ordering::SeqCst)
}

/// Gives the terminal its old state back, for good. Idempotent; does
/// nothing if [`enter`] never succeeded.
pub fn restore() {
    DONE.store(true, Ordering::SeqCst);
    if ON.swap(false, Ordering::SeqCst) {
        if let Some(saved) = SAVED.get() {
            let _ = stty(&[saved]);
        }
    }
}

/// Restores the terminal when dropped (at the end of `main`).
pub struct Guard;

impl Drop for Guard {
    fn drop(&mut self) {
        restore();
    }
}

/// The terminal in its old state (lines, echo) while this lives, for a
/// prompt that reads a line; single keys again afterwards.
pub struct Cooked(bool);

impl Cooked {
    pub fn new() -> Cooked {
        let was = ON.swap(false, Ordering::SeqCst);
        if was {
            if let Some(saved) = SAVED.get() {
                let _ = stty(&[saved]);
            }
        }
        Cooked(was)
    }
}

impl Drop for Cooked {
    fn drop(&mut self) {
        if self.0 && !DONE.load(Ordering::SeqCst) && stty(&KEYS).is_some() {
            ON.store(true, Ordering::SeqCst);
        }
    }
}

/// Echo is off for a [`NoEcho`] prompt; what the terminal had before.
static HIDDEN: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Gives the terminal its echo back after a [`NoEcho`], once; whether it
/// was off.
fn show() -> bool {
    let saved = HIDDEN.lock().unwrap_or_else(|e| e.into_inner()).take();
    match saved {
        Some(saved) => {
            let _ = stty(&[&saved]);
            true
        }
        None => false,
    }
}

/// No echo while this lives, for a password prompt that reads a line
/// (inside a [`Cooked`]). Where stty cannot do it (Windows consoles) the
/// typing stays visible. Ctrl-C while it is off gives the echo back
/// before the usual: the process exits (130) unless a session catches
/// Ctrl-C to stop.
pub struct NoEcho {
    /// The echo is off.
    pub hidden: bool,
}

impl NoEcho {
    pub fn new() -> NoEcho {
        static WATCH: std::sync::Once = std::sync::Once::new();
        WATCH.call_once(|| {
            tvpipe::signals::on_signal(|| {
                if show() {
                    eprintln!();
                }
                // Without a session's handler Ctrl-C would have ended the
                // process; installing ours must not change that.
                if !crate::interrupt::linked() {
                    std::process::exit(130);
                }
            });
        });
        let mut hidden = false;
        if let Some(before) = stty(&["-g"]).filter(|s| !s.is_empty()) {
            if stty(&["-echo"]).is_some() {
                *HIDDEN.lock().unwrap_or_else(|e| e.into_inner()) = Some(before);
                hidden = true;
            }
        }
        NoEcho { hidden }
    }
}

impl Drop for NoEcho {
    fn drop(&mut self) {
        show();
    }
}
