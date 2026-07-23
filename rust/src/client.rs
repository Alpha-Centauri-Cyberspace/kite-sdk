//! The [`Kite`] client and its [`KiteBuilder`].

use cloudevents::{AttributesReader, AttributesWriter, Event};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::emit::EmitBuilder;
use crate::error::{KiteError, Result};
use crate::retry::{backoff, is_retryable_status, retry_after_wait};
use crate::types::{
    AuthMode, DEFAULT_INGEST_URL, EmitResult, EmitStatus, EmitUsage, MAX_BODY_SIZE,
};
use crate::validate::{assert_valid_source, is_valid_extension_name};

/// Content type for a structured-mode CloudEvent body.
pub(crate) const CLOUDEVENTS_CONTENT_TYPE: &str = "application/cloudevents+json; charset=utf-8";
/// Content type for a plain-JSON (`emit_raw`) body.
pub(crate) const JSON_CONTENT_TYPE: &str = "application/json";

/// Client for emitting events into Kite's ingest pipeline.
///
/// Construct one with [`Kite::builder`]:
///
/// ```no_run
/// # fn main() -> Result<(), kite_sdk::KiteError> {
/// let kite = kite_sdk::Kite::builder()
///     .team_id("your-team")
///     .source("my-app")
///     .token("kite_...")
///     .build()?;
/// # Ok(())
/// # }
/// ```
#[derive(Debug, Clone)]
pub struct Kite {
    team_id: String,
    source: String,
    token: String,
    /// Ingest base URL, already stripped of trailing slashes and parsed.
    base: Url,
    auth_mode: AuthMode,
    max_retries: u32,
    http: reqwest::Client,
}

impl Kite {
    /// Start building a [`Kite`] client.
    pub fn builder() -> KiteBuilder {
        KiteBuilder::default()
    }

    /// The configured event source slug.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// The configured team id.
    pub fn team_id(&self) -> &str {
        &self.team_id
    }

    /// Build and send a CloudEvent with a custom `type`.
    ///
    /// Returns a fluent [`EmitBuilder`]; set optional attributes on it and call
    /// `.send().await`. The event is sent in CloudEvents structured mode.
    pub fn emit(&self, ty: impl Into<String>, data: impl Serialize) -> EmitBuilder<'_> {
        EmitBuilder::new(self, ty, data)
    }

    /// Send a fully-specified structured [`cloudevents::Event`] as-is.
    ///
    /// Missing `id` and `source` are filled in (random UUID v4 and
    /// `https://{source}` respectively); everything else is preserved.
    /// Extension names are validated client-side — the server silently
    /// downgrades events with malformed extensions to `com.{source}.event`, so
    /// an invalid name fails fast with [`KiteError::Validation`].
    pub async fn emit_event(&self, event: Event) -> Result<EmitResult> {
        let event = self.prepare_event(event)?;
        let body = serde_json::to_vec(&event)
            .map_err(|e| KiteError::Validation(format!("failed to serialize CloudEvent: {e}")))?;
        self.send_bytes(body, CLOUDEVENTS_CONTENT_TYPE).await
    }

    /// Send plain JSON (`Content-Type: application/json`).
    ///
    /// The server wraps it into a CloudEvent, deriving `type = com.{source}.event`
    /// and `source = https://{source}`.
    pub async fn emit_raw(&self, data: impl Serialize) -> Result<EmitResult> {
        let body = serde_json::to_vec(&data)
            .map_err(|e| KiteError::Validation(format!("event data is not serializable: {e}")))?;
        self.send_bytes(body, JSON_CONTENT_TYPE).await
    }

    /// Validate and normalize an event before serialization.
    fn prepare_event(&self, mut event: Event) -> Result<Event> {
        if event.ty().is_empty() {
            return Err(KiteError::Validation(
                "event type must be a non-empty string".to_string(),
            ));
        }
        // Extension *values* are constrained to string/bool/integer by the
        // `ExtensionValue` type, so only the names need checking here.
        for (name, _value) in event.iter_extensions() {
            if !is_valid_extension_name(name) {
                return Err(KiteError::Validation(format!(
                    "invalid CloudEvent extension name \"{name}\": must be lowercase alphanumeric"
                )));
            }
        }
        if event.id().is_empty() {
            event.set_id(Uuid::new_v4().to_string());
        }
        if event.source().is_empty() {
            event.set_source(format!("https://{}", self.source));
        }
        Ok(event)
    }

    /// The ingest URL for a request, with team/source (and token, for path
    /// auth) as properly percent-encoded path segments.
    fn build_url(&self) -> Result<Url> {
        let mut url = self.base.clone();
        {
            let mut segments = url.path_segments_mut().map_err(|()| {
                KiteError::Validation(format!(
                    "ingest URL \"{}\" cannot have path segments",
                    self.base
                ))
            })?;
            segments
                .push("hooks")
                .push(&self.team_id)
                .push(&self.source);
            if self.auth_mode == AuthMode::Path {
                segments.push(&self.token);
            }
        }
        Ok(url)
    }

    /// Send a serialized body with retries, returning the mapped result.
    async fn send_bytes(&self, body: Vec<u8>, content_type: &str) -> Result<EmitResult> {
        // Client-side pre-check: fail fast before any network call.
        if body.len() > MAX_BODY_SIZE {
            return Err(KiteError::PayloadTooLarge {
                max_bytes: MAX_BODY_SIZE,
                status: None,
                server_error: Some(format!(
                    "payload is {} bytes, which exceeds the {MAX_BODY_SIZE} byte limit",
                    body.len()
                )),
            });
        }

        let url = self.build_url()?;
        let mut last_err: Option<KiteError> = None;

        for attempt in 0..=self.max_retries {
            let mut request = self
                .http
                .post(url.clone())
                .header(reqwest::header::CONTENT_TYPE, content_type)
                .body(body.clone());
            if self.auth_mode == AuthMode::Bearer {
                request = request.bearer_auth(&self.token);
            }

            let response = match request.send().await {
                Ok(response) => response,
                Err(err) => {
                    // Transport failure — retryable.
                    if attempt < self.max_retries {
                        last_err = Some(KiteError::Network(err));
                        tokio::time::sleep(backoff(attempt)).await;
                        continue;
                    }
                    return Err(KiteError::Network(err));
                }
            };

            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            let parsed = parse_body(&text);

            if (200..300).contains(&status) {
                return Ok(to_emit_result(parsed));
            }

            let error = to_error(status, parsed);
            if is_retryable_status(status) && attempt < self.max_retries {
                let wait = match &error {
                    KiteError::RateLimit {
                        retry_after_secs: Some(secs),
                        ..
                    } => retry_after_wait(*secs),
                    _ => backoff(attempt),
                };
                last_err = Some(error);
                tokio::time::sleep(wait).await;
                continue;
            }

            return Err(error);
        }

        // Reached only if the last attempt was a retryable failure.
        Err(last_err.unwrap_or_else(|| KiteError::Server {
            status: 0,
            server_error: Some("emit failed after retries".to_string()),
        }))
    }
}

/// Builder for a [`Kite`] client. Create one with [`Kite::builder`].
#[derive(Debug, Default)]
pub struct KiteBuilder {
    team_id: Option<String>,
    source: Option<String>,
    token: Option<String>,
    ingest_url: Option<String>,
    auth_mode: Option<AuthMode>,
    max_retries: Option<u32>,
}

impl KiteBuilder {
    /// Set the team id (required).
    pub fn team_id(mut self, team_id: impl Into<String>) -> Self {
        self.team_id = Some(team_id.into());
        self
    }

    /// Set the event source slug (required). Validated on [`build`](Self::build).
    pub fn source(mut self, source: impl Into<String>) -> Self {
        self.source = Some(source.into());
        self
    }

    /// Set the hook token from `kite endpoints create` (required).
    pub fn token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    /// Override the ingest base URL. Defaults to `https://api.getkite.sh`.
    pub fn ingest_url(mut self, ingest_url: impl Into<String>) -> Self {
        self.ingest_url = Some(ingest_url.into());
        self
    }

    /// Set how the hook token is presented. Defaults to [`AuthMode::Bearer`].
    pub fn auth_mode(mut self, auth_mode: AuthMode) -> Self {
        self.auth_mode = Some(auth_mode);
        self
    }

    /// Set the maximum retry attempts for retryable failures. Defaults to `3`.
    pub fn max_retries(mut self, max_retries: u32) -> Self {
        self.max_retries = Some(max_retries);
        self
    }

    /// Validate the configuration and build a [`Kite`] client.
    ///
    /// # Errors
    ///
    /// Returns [`KiteError::Validation`] if a required field is missing, the
    /// source violates the server's rules, or the ingest URL is not a valid
    /// absolute URL.
    pub fn build(self) -> Result<Kite> {
        let team_id = require(self.team_id, "team_id")?;
        let source = require(self.source, "source")?;
        let token = require(self.token, "token")?;
        assert_valid_source(&source)?;

        let ingest_url = self
            .ingest_url
            .unwrap_or_else(|| DEFAULT_INGEST_URL.to_string());
        let trimmed = ingest_url.trim_end_matches('/');
        let base = Url::parse(trimmed).map_err(|e| {
            KiteError::Validation(format!("invalid ingest_url \"{ingest_url}\": {e}"))
        })?;
        if base.cannot_be_a_base() {
            return Err(KiteError::Validation(format!(
                "invalid ingest_url \"{ingest_url}\": must be an absolute http(s) URL"
            )));
        }

        let http = reqwest::Client::builder()
            .build()
            .map_err(KiteError::Network)?;

        Ok(Kite {
            team_id,
            source,
            token,
            base,
            auth_mode: self.auth_mode.unwrap_or_default(),
            max_retries: self.max_retries.unwrap_or(3),
            http,
        })
    }
}

fn require(value: Option<String>, field: &str) -> Result<String> {
    match value {
        Some(v) if !v.is_empty() => Ok(v),
        _ => Err(KiteError::Validation(format!("{field} is required"))),
    }
}

/// The raw JSON shape the server returns on ingest.
#[derive(Debug, Default, Deserialize)]
struct ServerResponseBody {
    id: Option<String>,
    status: Option<String>,
    error: Option<String>,
    created_at: Option<String>,
    retry_after_secs: Option<u64>,
    max_bytes: Option<usize>,
    usage: Option<ServerUsage>,
}

#[derive(Debug, Default, Deserialize)]
struct ServerUsage {
    events_used: Option<u64>,
    events_limit: Option<u64>,
    amount_charged_atomic: Option<i64>,
    amount_charged_sats: Option<i64>,
}

fn parse_body(text: &str) -> ServerResponseBody {
    if text.is_empty() {
        return ServerResponseBody::default();
    }
    serde_json::from_str(text).unwrap_or_else(|_| ServerResponseBody {
        // Non-JSON body: surface it as the server error string, mirroring the TS SDK.
        error: Some(text.to_string()),
        ..Default::default()
    })
}

fn to_emit_result(body: ServerResponseBody) -> EmitResult {
    let usage = body.usage.map(|u| EmitUsage {
        events_used: u.events_used,
        events_limit: u.events_limit,
        amount_charged_atomic: u.amount_charged_atomic.or(u.amount_charged_sats),
    });
    let status = if body.status.as_deref() == Some("duplicate_ignored") {
        EmitStatus::DuplicateIgnored
    } else {
        EmitStatus::Accepted
    };
    EmitResult {
        id: body.id.unwrap_or_default(),
        status,
        created_at: body.created_at,
        usage,
    }
}

fn to_error(status: u16, body: ServerResponseBody) -> KiteError {
    let server_error = body.error;
    match status {
        401 | 403 => KiteError::Auth {
            status,
            server_error,
        },
        429 => KiteError::RateLimit {
            status,
            server_error,
            retry_after_secs: body.retry_after_secs,
        },
        413 => KiteError::PayloadTooLarge {
            max_bytes: body.max_bytes.unwrap_or(MAX_BODY_SIZE),
            status: Some(status),
            server_error,
        },
        // 5xx and any other unexpected non-success status. Other 4xx are not
        // retried (see `is_retryable_status`); they land here as terminal.
        _ => KiteError::Server {
            status,
            server_error,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_client(auth_mode: AuthMode) -> Kite {
        Kite::builder()
            .team_id("team abc")
            .source("my-app")
            .token("kite_tok/en")
            .auth_mode(auth_mode)
            .build()
            .expect("valid config")
    }

    #[test]
    fn build_requires_team_id() {
        let err = Kite::builder()
            .source("my-app")
            .token("t")
            .build()
            .unwrap_err();
        assert!(matches!(err, KiteError::Validation(m) if m.contains("team_id")));
    }

    #[test]
    fn build_rejects_reserved_source() {
        let err = Kite::builder()
            .team_id("t")
            .source("kite")
            .token("tok")
            .build()
            .unwrap_err();
        assert!(matches!(err, KiteError::Validation(_)));
    }

    #[test]
    fn build_rejects_bad_ingest_url() {
        let err = Kite::builder()
            .team_id("t")
            .source("my-app")
            .token("tok")
            .ingest_url("not a url")
            .build()
            .unwrap_err();
        assert!(matches!(err, KiteError::Validation(_)));
    }

    #[test]
    fn bearer_url_omits_token_and_encodes_segments() {
        let kite = test_client(AuthMode::Bearer);
        let url = kite.build_url().unwrap();
        assert_eq!(
            url.as_str(),
            "https://api.getkite.sh/hooks/team%20abc/my-app"
        );
    }

    #[test]
    fn path_url_appends_encoded_token() {
        let kite = test_client(AuthMode::Path);
        let url = kite.build_url().unwrap();
        assert_eq!(
            url.as_str(),
            "https://api.getkite.sh/hooks/team%20abc/my-app/kite_tok%2Fen"
        );
    }

    #[test]
    fn maps_401_to_auth_error() {
        let err = to_error(
            401,
            serde_json::from_str(r#"{"error":"bad token"}"#).unwrap(),
        );
        assert!(
            matches!(err, KiteError::Auth { status: 401, server_error } if server_error.as_deref() == Some("bad token"))
        );
    }

    #[test]
    fn maps_429_with_retry_after() {
        let err = to_error(
            429,
            serde_json::from_str(r#"{"error":"slow down","retry_after_secs":7}"#).unwrap(),
        );
        assert!(matches!(
            err,
            KiteError::RateLimit {
                retry_after_secs: Some(7),
                ..
            }
        ));
    }

    #[test]
    fn maps_413_with_max_bytes() {
        let err = to_error(
            413,
            serde_json::from_str(r#"{"error":"too big","max_bytes":262144}"#).unwrap(),
        );
        assert!(matches!(
            err,
            KiteError::PayloadTooLarge {
                max_bytes: 262144,
                ..
            }
        ));
    }

    #[test]
    fn maps_500_to_server_error() {
        let err = to_error(500, ServerResponseBody::default());
        assert!(matches!(err, KiteError::Server { status: 500, .. }));
    }

    #[test]
    fn maps_400_to_server_error() {
        let err = to_error(400, ServerResponseBody::default());
        assert!(matches!(err, KiteError::Server { status: 400, .. }));
    }

    #[test]
    fn emit_result_marks_duplicate() {
        let body: ServerResponseBody =
            serde_json::from_str(r#"{"status":"duplicate_ignored","id":"evt_1"}"#).unwrap();
        let result = to_emit_result(body);
        assert_eq!(result.status, EmitStatus::DuplicateIgnored);
        assert_eq!(result.id, "evt_1");
    }

    #[test]
    fn emit_result_maps_usage_with_atomic_fallback() {
        let body: ServerResponseBody =
            serde_json::from_str(r#"{"id":"e","usage":{"events_used":3,"amount_charged_sats":9}}"#)
                .unwrap();
        let result = to_emit_result(body);
        let usage = result.usage.unwrap();
        assert_eq!(usage.events_used, Some(3));
        assert_eq!(usage.amount_charged_atomic, Some(9));
    }
}
