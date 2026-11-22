//! Short join links (`tvpipe.party/BCDF`, docs/short-links.md): the
//! client of the service. One registration per run: registered when the
//! host page asks (`shortlink` on the local API), the url replaced when it
//! asks with another, refreshed every [`REFRESH_EVERY`] while the run
//! lasts, deleted at the end.
//!
//! Every failure is an [`Error`] with the code `unavailable`: the page
//! then shows only the QR code.

use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::Duration;

use crate::codec::json::Value;
use crate::error::{Error, Result};
use crate::net::fetch::{Client, Url};
use crate::util::stop::Stop;

/// The service when `TVPIPE_PARTY_URL` does not name another.
pub const DEFAULT_BASE: &str = "https://tvpipe.party";
/// The environment variable that overrides the service (`off`: none).
pub const ENV: &str = "TVPIPE_PARTY_URL";
/// How often a link is refreshed (the service gives a code away after
/// 24 hours without one).
pub const REFRESH_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// The `DELETE` at the end takes at most this.
pub const RELEASE_WITHIN: Duration = Duration::from_secs(3);
/// The largest answer read.
const MAX_ANSWER: usize = 16 * 1024;
/// The longest join url sent (the service takes 300 characters).
const MAX_URL: usize = 2048;

/// The registered link.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Registration {
    code: String,
    secret: String,
    /// The join url it leads to.
    url: String,
    /// `https://tvpipe.party/CODE`.
    short: String,
}

#[derive(Default)]
struct State {
    reg: Option<Registration>,
    /// Released: nothing is registered any more.
    ended: bool,
    refreshing: bool,
}

/// The run's short link: the service (or none) and the registration.
pub struct ShortLinks {
    /// The service's base URL without a trailing `/`; `None`: off.
    base: Option<String>,
    client: Client,
    stop: Stop,
    /// Held while talking to the service (one request sequence at a time).
    busy: Mutex<()>,
    state: Mutex<State>,
}

fn unavailable(msg: impl Into<String>) -> Error {
    Error::protocol(msg.into()).with_code("unavailable")
}

/// A code as the service gives them (it goes into a path).
fn valid_code(c: &str) -> bool {
    (4..=8).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_alphabetic())
}

impl ShortLinks {
    /// `base`: the service (`None`: short links are off). `stop` ends the
    /// refresh thread.
    pub fn new(base: Option<&str>, stop: Stop) -> Arc<ShortLinks> {
        let base = base.and_then(|b| {
            let b = b.trim().trim_end_matches('/');
            match Url::parse(b) {
                Ok(_) => Some(b.to_owned()),
                Err(e) => {
                    warn!("playshare: short links are off: {e}");
                    None
                }
            }
        });
        let client = Client {
            connect_timeout: Duration::from_secs(5),
            read_timeout: Duration::from_secs(10),
            ..Client::from_env(None)
        };
        Arc::new(ShortLinks {
            base,
            client,
            stop,
            busy: Mutex::new(()),
            state: Mutex::default(),
        })
    }

    /// The service of `TVPIPE_PARTY_URL` (`off`: none) or
    /// [`DEFAULT_BASE`]; none at all with `disabled` (`--no-short-link`).
    pub fn from_env(disabled: bool, stop: Stop) -> Arc<ShortLinks> {
        let env = std::env::var(ENV).ok().filter(|v| !v.trim().is_empty());
        let base = match env.as_deref() {
            _ if disabled => None,
            Some(v) if v.trim().eq_ignore_ascii_case("off") => None,
            Some(v) => Some(v),
            None => Some(DEFAULT_BASE),
        };
        ShortLinks::new(base, stop)
    }

    /// Whether short links are on.
    pub fn enabled(&self) -> bool {
        self.base.is_some()
    }

    /// The frame page phones open the tunnel's join link in
    /// (`https://tvpipe.party/p`, docs/short-links.md); `None`: off.
    pub fn frame_page(&self) -> Option<String> {
        self.base.as_ref().map(|b| format!("{b}/p"))
    }

    /// The service's origin (`https://tvpipe.party`): the frame page's,
    /// which may frame the phones' pages (`frame-ancestors`); `None`: off.
    pub fn origin(&self) -> Option<String> {
        let u = Url::parse(self.base.as_deref()?).ok()?;
        // It goes into a header: only what a host name or address has.
        if !u
            .host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
        {
            return None;
        }
        let scheme = if u.https { "https" } else { "http" };
        let host = if u.host.contains(':') {
            format!("[{}]", u.host)
        } else {
            u.host.clone()
        };
        let default = if u.https { 443 } else { 80 };
        Some(if u.port == default {
            format!("{scheme}://{host}")
        } else {
            format!("{scheme}://{host}:{}", u.port)
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The short link for the join link `url` (`code`: the one to propose,
    /// the party's room code): `(short url, code)`.
    pub fn register(
        self: &Arc<ShortLinks>,
        url: &str,
        code: Option<&str>,
    ) -> Result<(String, String)> {
        if self.base.is_none() {
            return Err(unavailable("short links are off"));
        }
        if url.len() > MAX_URL {
            return Err(unavailable("the join link is too long for a short link"));
        }
        let _busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let current = {
            let st = self.state();
            if st.ended {
                return Err(unavailable("playshare is ending"));
            }
            st.reg.clone()
        };
        let code = code.filter(|c| valid_code(c));
        let reg = match current {
            Some(r) if r.url == url => return Ok((r.short, r.code)),
            Some(r) => match self.put(&r, Some(url))? {
                Some(r) => r,
                None => self.post(url, code.or(Some(r.code.as_str())))?,
            },
            None => self.post(url, code)?,
        };
        self.keep(reg.clone())?;
        Ok((reg.short, reg.code))
    }

    /// Keeps `reg` (and starts the refresh thread the first time); after
    /// the end it is deleted instead.
    fn keep(self: &Arc<ShortLinks>, reg: Registration) -> Result<()> {
        let mut st = self.state();
        if st.ended {
            drop(st);
            self.delete(&reg);
            return Err(unavailable("playshare is ending"));
        }
        if st.reg.as_ref().map(|r| &r.short) != Some(&reg.short) {
            info!("playshare: short link {} → {}", reg.short, reg.url);
        }
        st.reg = Some(reg);
        if !st.refreshing {
            st.refreshing = true;
            let links = self.clone();
            let _ = std::thread::Builder::new()
                .name("playshare-shortlink".into())
                .spawn(move || {
                    while !links.stop.wait(REFRESH_EVERY) {
                        if let Err(e) = links.refresh() {
                            warn!("playshare: refreshing the short link: {e}");
                        }
                    }
                });
        }
        Ok(())
    }

    /// Tells the service the link is still in use (`PUT {}`); registers it
    /// again when the service lost it.
    pub fn refresh(self: &Arc<ShortLinks>) -> Result<()> {
        let _busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let Some(r) = self.state().reg.clone() else {
            return Ok(());
        };
        let reg = match self.put(&r, None)? {
            Some(reg) => reg,
            None => {
                info!(
                    "playshare: the short link {} was lost; registering again",
                    r.short
                );
                self.post(&r.url, Some(&r.code))?
            }
        };
        self.keep(reg)
    }

    /// Deletes the link (at the end): within [`RELEASE_WITHIN`], failures
    /// only logged. Later registrations are refused.
    pub fn release(self: &Arc<ShortLinks>) {
        let reg = {
            let mut st = self.state();
            st.ended = true;
            st.reg.take()
        };
        let Some(reg) = reg else { return };
        let (tx, rx) = mpsc::channel();
        let links = self.clone();
        let spawned = std::thread::Builder::new()
            .name("playshare-shortlink-end".into())
            .spawn(move || {
                links.delete(&reg);
                let _ = tx.send(());
            });
        if spawned.is_ok() && rx.recv_timeout(RELEASE_WITHIN).is_err() {
            warn!("playshare: deleting the short link took too long");
        }
    }

    // -----------------------------------------------------------------
    // Requests

    fn url(&self, path: &str) -> Result<Url> {
        let base = self
            .base
            .as_deref()
            .ok_or_else(|| unavailable("short links are off"))?;
        Url::parse(&format!("{base}{path}")).map_err(|e| unavailable(e.message().to_owned()))
    }

    /// One request: the status and the answer as JSON (`Null` when it is
    /// none).
    fn call(
        &self,
        method: &str,
        url: &Url,
        secret: Option<&str>,
        body: Option<Value>,
    ) -> Result<(u16, Value)> {
        let auth = secret.map(|s| format!("Bearer {s}"));
        let headers: Vec<(&str, &str)> =
            auth.iter().map(|a| ("Authorization", a.as_str())).collect();
        let body = body.map(|b| ("application/json", b.to_json().into_bytes()));
        let (status, bytes) = self
            .client
            .send(method, url, &headers, body, MAX_ANSWER)
            .map_err(|e| {
                unavailable(format!(
                    "the short link service ({}) did not answer: {e}",
                    url.host
                ))
            })?;
        let v = std::str::from_utf8(&bytes)
            .ok()
            .and_then(|t| Value::parse(t).ok())
            .unwrap_or(Value::Null);
        Ok((status, v))
    }

    /// The error of an answer the caller cannot use.
    fn failed(&self, method: &str, status: u16, v: &Value) -> Error {
        let host = self.base.as_deref().unwrap_or("");
        let host = host.split("://").nth(1).unwrap_or(host);
        let msg = v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .map(|m| m.chars().take(200).collect::<String>());
        unavailable(match msg {
            Some(m) => format!("the short link service ({host}) refused: {m} ({method} {status})"),
            None => format!("the short link service ({host}) answered {method} with {status}"),
        })
    }

    /// `code` and `short` of an answer.
    fn link_of(&self, method: &str, status: u16, v: &Value) -> Result<(String, String)> {
        let code = v
            .get("code")
            .and_then(Value::as_str)
            .filter(|c| valid_code(c));
        let short = v
            .get("short")
            .and_then(Value::as_str)
            .filter(|s| s.len() <= 300 && Url::parse(s).is_ok());
        match (code, short) {
            (Some(c), Some(s)) => Ok((c.to_ascii_uppercase(), s.to_owned())),
            _ => Err(unavailable(format!(
                "the short link service answered {method} ({status}) without a code and a link"
            ))),
        }
    }

    /// `POST /api/links`: a new registration.
    fn post(&self, url: &str, code: Option<&str>) -> Result<Registration> {
        let body = Value::object().with("url", url).with_opt("code", code);
        let (status, v) = self.call("POST", &self.url("/api/links")?, None, Some(body))?;
        if !(200..300).contains(&status) {
            return Err(self.failed("POST", status, &v));
        }
        let (code, short) = self.link_of("POST", status, &v)?;
        let secret = v
            .get("secret")
            .and_then(Value::as_str)
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 256
                    && s.bytes().all(|b| {
                        b.is_ascii_alphanumeric()
                            || matches!(b, b'-' | b'_' | b'=' | b'.' | b'+' | b'/')
                    })
            })
            .ok_or_else(|| unavailable("the short link service answered POST without a secret"))?;
        Ok(Registration {
            code,
            secret: secret.to_owned(),
            url: url.to_owned(),
            short,
        })
    }

    /// `PUT /api/links/CODE`: `url` replaced (or only refreshed). `None`:
    /// the service no longer has it (404).
    fn put(&self, r: &Registration, url: Option<&str>) -> Result<Option<Registration>> {
        let body = Value::object().with_opt("url", url);
        let target = self.url(&format!("/api/links/{}", r.code))?;
        let (status, v) = self.call("PUT", &target, Some(&r.secret), Some(body))?;
        if status == 404 {
            return Ok(None);
        }
        if !(200..300).contains(&status) {
            return Err(self.failed("PUT", status, &v));
        }
        let (code, short) = self.link_of("PUT", status, &v)?;
        Ok(Some(Registration {
            code,
            secret: r.secret.clone(),
            url: url.unwrap_or(&r.url).to_owned(),
            short,
        }))
    }

    /// `DELETE /api/links/CODE`; failures only logged.
    fn delete(&self, r: &Registration) {
        let res = self
            .url(&format!("/api/links/{}", r.code))
            .and_then(|u| self.call("DELETE", &u, Some(&r.secret), None));
        match res {
            Ok((status, _)) if (200..300).contains(&status) || status == 404 => {
                debug!("playshare: short link {} deleted", r.short);
            }
            Ok((status, v)) => warn!(
                "playshare: deleting the short link: {}",
                self.failed("DELETE", status, &v)
            ),
            Err(e) => warn!("playshare: deleting the short link: {e}"),
        }
    }
}

#[cfg(test)]
pub(super) mod tests;
