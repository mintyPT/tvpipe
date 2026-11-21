//! Cast v2 control messages: namespaces, ids, and typed
//! builders/parsers for the JSON payloads of `tp.connection`,
//! `tp.heartbeat` and `receiver`.
//!
//! The webrtc namespace payloads (OFFER/ANSWER) live in
//! [`super::streaming`].
//!
//! Sources: openscreen `cast/common/channel/message_util.{h,cc}`
//! (namespaces, platform ids, CONNECT fields),
//! `cast/standalone_sender/looping_file_cast_agent.cc` (LAUNCH, STOP,
//! RECEIVER_STATUS handling), `cast/receiver/application_agent.cc`
//! (RECEIVER_STATUS layout), `cast/common/public/cast_streaming_app_ids.h`
//! (app ids); pychromecast (MIT) `controllers/receiver.py`.

use crate::codec::json::Value;
use crate::codec::protobuf::CastMessage;
use crate::error::{Error, Result};

pub const NS_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
pub const NS_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
pub const NS_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
pub const NS_WEBRTC: &str = "urn:x-cast:com.google.cast.webrtc";
pub const NS_REMOTING: &str = "urn:x-cast:com.google.cast.remoting";

/// Our id for platform-level messages.
pub const PLATFORM_SENDER_ID: &str = "sender-0";
/// The receiver's platform id.
pub const PLATFORM_RECEIVER_ID: &str = "receiver-0";
pub const BROADCAST_ID: &str = "*";

/// The Cast Streaming (mirroring) receiver app, audio + video.
pub const MIRRORING_APP_ID: &str = "0F5096E8";
/// The Cast Streaming receiver app, audio only.
pub const MIRRORING_AUDIO_APP_ID: &str = "85CDB22F";

const USER_AGENT: &str = concat!("tvpipe/", env!("CARGO_PKG_VERSION"));

/// `CONNECT` on `tp.connection` from `source` to `destination`.
pub fn connect(source: &str, destination: &str) -> CastMessage {
    let payload = Value::object()
        .with("type", "CONNECT")
        .with("connType", 0)
        .with("userAgent", USER_AGENT)
        .with("origin", Value::object())
        // No 1 and 2: those are the chunking versions, which we do not
        // implement. 3 moves string payloads to payload_binary (handled).
        .with("protocolVersionList", Value::array([0, 3]))
        .with(
            "senderInfo",
            Value::object()
                .with("sdkType", 2)
                .with("version", env!("CARGO_PKG_VERSION"))
                .with("browserVersion", env!("CARGO_PKG_VERSION"))
                .with("platform", 4)
                .with("connectionType", 1),
        );
    CastMessage::json(source, destination, NS_CONNECTION, &payload)
}

/// `CLOSE` on `tp.connection`.
pub fn close(source: &str, destination: &str) -> CastMessage {
    CastMessage::json(
        source,
        destination,
        NS_CONNECTION,
        &Value::object().with("type", "CLOSE"),
    )
}

/// Our heartbeat `PING` (platform ids).
pub fn ping() -> CastMessage {
    CastMessage::json(
        PLATFORM_SENDER_ID,
        PLATFORM_RECEIVER_ID,
        NS_HEARTBEAT,
        &Value::object().with("type", "PING"),
    )
}

/// The `PONG` answering `ping` (ids swapped).
pub fn pong_to(ping: &CastMessage) -> CastMessage {
    CastMessage::json(
        ping.destination_id.clone(),
        ping.source_id.clone(),
        NS_HEARTBEAT,
        &Value::object().with("type", "PONG"),
    )
}

/// `LAUNCH` on the receiver namespace.
pub fn launch(request_id: u32, app_id: &str) -> CastMessage {
    let payload = Value::object()
        .with("type", "LAUNCH")
        .with("requestId", request_id)
        .with("appId", app_id)
        .with("language", "en-US")
        .with("supportedAppTypes", Value::array(["WEB"]));
    platform(&payload)
}

/// `GET_STATUS` on the receiver namespace.
pub fn get_status(request_id: u32) -> CastMessage {
    platform(
        &Value::object()
            .with("type", "GET_STATUS")
            .with("requestId", request_id),
    )
}

/// `STOP` for an app session on the receiver namespace.
pub fn stop(request_id: u32, session_id: &str) -> CastMessage {
    platform(
        &Value::object()
            .with("type", "STOP")
            .with("requestId", request_id)
            .with("sessionId", session_id),
    )
}

fn platform(payload: &Value) -> CastMessage {
    CastMessage::json(
        PLATFORM_SENDER_ID,
        PLATFORM_RECEIVER_ID,
        NS_RECEIVER,
        payload,
    )
}

/// One running application from `RECEIVER_STATUS`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppInfo {
    pub app_id: String,
    pub session_id: Option<String>,
    pub transport_id: Option<String>,
    pub display_name: Option<String>,
    pub namespaces: Vec<String>,
}

/// A parsed message on the receiver namespace.
#[derive(Debug, Clone, PartialEq)]
pub enum ReceiverMessage {
    Status {
        request_id: Option<u32>,
        apps: Vec<AppInfo>,
    },
    LaunchStatus {
        request_id: Option<u32>,
        status: String,
    },
    LaunchError {
        request_id: Option<u32>,
        reason: String,
    },
    InvalidRequest {
        request_id: Option<u32>,
        reason: String,
    },
    /// Any other type; kept by name for logging.
    Other(String),
}

impl ReceiverMessage {
    pub fn parse(payload: &Value) -> Result<ReceiverMessage> {
        let ty = payload.require_str("type")?;
        let request_id = payload["requestId"]
            .as_u32()
            .or_else(|| payload["launchRequestId"].as_u32());
        let reason = || payload["reason"].as_str().unwrap_or("UNKNOWN").to_owned();
        Ok(match ty {
            "RECEIVER_STATUS" => {
                let mut apps = Vec::new();
                for app in payload["status"]["applications"]
                    .as_array()
                    .unwrap_or_default()
                {
                    let Some(app_id) = app["appId"].as_str() else {
                        continue;
                    };
                    let s = |k: &str| app[k].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
                    apps.push(AppInfo {
                        app_id: app_id.to_owned(),
                        session_id: s("sessionId"),
                        transport_id: s("transportId"),
                        display_name: s("displayName"),
                        namespaces: app["namespaces"]
                            .as_array()
                            .unwrap_or_default()
                            .iter()
                            .filter_map(|n| n["name"].as_str().map(str::to_owned))
                            .collect(),
                    });
                }
                ReceiverMessage::Status { request_id, apps }
            }
            "LAUNCH_STATUS" => ReceiverMessage::LaunchStatus {
                request_id,
                status: payload["status"].as_str().unwrap_or("").to_owned(),
            },
            "LAUNCH_ERROR" => ReceiverMessage::LaunchError {
                request_id,
                reason: reason(),
            },
            "INVALID_REQUEST" => ReceiverMessage::InvalidRequest {
                request_id,
                reason: reason(),
            },
            other => ReceiverMessage::Other(other.to_owned()),
        })
    }

    /// The app with `app_id` (case-insensitive), if this is a status.
    pub fn find_app(&self, app_id: &str) -> Option<&AppInfo> {
        match self {
            ReceiverMessage::Status { apps, .. } => {
                apps.iter().find(|a| a.app_id.eq_ignore_ascii_case(app_id))
            }
            _ => None,
        }
    }
}

/// True if `msg` is a `tp.connection` CLOSE.
pub fn is_close(msg: &CastMessage) -> bool {
    msg.namespace == NS_CONNECTION
        && msg
            .payload_json()
            .is_ok_and(|v| v["type"].as_str() == Some("CLOSE"))
}

/// The JSON payload's `type`, for logging and dispatch.
pub fn message_type(msg: &CastMessage) -> Result<String> {
    let v = msg.payload_json()?;
    v["type"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::protocol(format!("cast: message on {} has no type", msg.namespace)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builders() {
        let m = launch(7, MIRRORING_APP_ID);
        assert_eq!(m.namespace, NS_RECEIVER);
        assert_eq!(m.source_id, "sender-0");
        assert_eq!(m.destination_id, "receiver-0");
        assert_eq!(
            m.payload_str().unwrap(),
            r#"{"type":"LAUNCH","requestId":7,"appId":"0F5096E8","language":"en-US","supportedAppTypes":["WEB"]}"#
        );
        let c = connect("sender-0", "receiver-0");
        let v = c.payload_json().unwrap();
        assert_eq!(v["type"].as_str(), Some("CONNECT"));
        assert_eq!(v["connType"].as_u32(), Some(0));
        assert!(is_close(&close("a", "b")));
        assert!(!is_close(&c));
        let p = ping();
        let back = pong_to(&p);
        assert_eq!(back.source_id, "receiver-0");
        assert_eq!(back.destination_id, "sender-0");
        assert_eq!(
            stop(3, "abc").payload_str().unwrap(),
            r#"{"type":"STOP","requestId":3,"sessionId":"abc"}"#
        );
    }

    #[test]
    fn parses_receiver_status() {
        // Layout as produced by openscreen's ApplicationAgent.
        let v = Value::parse(
            r#"{"type":"RECEIVER_STATUS","requestId":0,"status":{
                "applications":[{"transportId":"streaming-receiver-42",
                  "sessionId":"8a3f","appId":"0F5096E8","universalAppId":"0F5096E8",
                  "displayName":"Cast Streaming Receiver Demo","isIdleScreen":false,
                  "launchedFromCloud":false,
                  "namespaces":[{"name":"urn:x-cast:com.google.cast.webrtc"}]}],
                "userEq":{},"volume":{"controlType":"attenuation","level":1.0}}}"#,
        )
        .unwrap();
        let m = ReceiverMessage::parse(&v).unwrap();
        let app = m.find_app("0f5096e8").unwrap();
        assert_eq!(app.transport_id.as_deref(), Some("streaming-receiver-42"));
        assert_eq!(app.session_id.as_deref(), Some("8a3f"));
        assert_eq!(app.namespaces, vec![NS_WEBRTC.to_string()]);
        assert!(m.find_app("CC1AD845").is_none());

        let idle = ReceiverMessage::parse(
            &Value::parse(r#"{"type":"RECEIVER_STATUS","status":{}}"#).unwrap(),
        )
        .unwrap();
        assert_eq!(
            idle,
            ReceiverMessage::Status {
                request_id: None,
                apps: vec![]
            }
        );
    }

    #[test]
    fn parses_errors() {
        let v =
            Value::parse(r#"{"type":"LAUNCH_ERROR","requestId":2,"reason":"NOT_FOUND"}"#).unwrap();
        assert_eq!(
            ReceiverMessage::parse(&v).unwrap(),
            ReceiverMessage::LaunchError {
                request_id: Some(2),
                reason: "NOT_FOUND".into()
            }
        );
        let v =
            Value::parse(r#"{"type":"LAUNCH_STATUS","launchRequestId":2,"status":"USER_ALLOWED"}"#)
                .unwrap();
        assert!(matches!(
            ReceiverMessage::parse(&v).unwrap(),
            ReceiverMessage::LaunchStatus {
                request_id: Some(2),
                ..
            }
        ));
        assert!(ReceiverMessage::parse(&Value::parse("{}").unwrap()).is_err());
        assert_eq!(
            ReceiverMessage::parse(&Value::parse(r#"{"type":"X"}"#).unwrap()).unwrap(),
            ReceiverMessage::Other("X".into())
        );
    }
}
