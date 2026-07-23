//! The fluent request builder returned by [`Kite::emit`](crate::Kite::emit).

use chrono::{DateTime, Utc};
use cloudevents::{EventBuilder, EventBuilderV10};
use serde::Serialize;
use uuid::Uuid;

use crate::client::{JSON_CONTENT_TYPE, Kite};
use crate::error::{KiteError, Result};
use crate::types::EmitResult;

/// A builder for a single CloudEvent, returned by [`Kite::emit`](crate::Kite::emit).
///
/// Set optional attributes with the chained methods, then call
/// [`send`](Self::send) to build the CloudEvent and emit it in structured mode.
///
/// ```no_run
/// # async fn run(kite: kite_sdk::Kite) -> Result<(), kite_sdk::KiteError> {
/// kite.emit("com.myapp.user.signup", serde_json::json!({ "userId": "u_123" }))
///     .summary("User u_123 signed up")
///     .subject("u_123")
///     .send()
///     .await?;
/// # Ok(())
/// # }
/// ```
#[must_use = "an EmitBuilder does nothing unless `.send().await` is called"]
pub struct EmitBuilder<'a> {
    kite: &'a Kite,
    ty: String,
    // Serialization is deferred: any error is carried here and surfaced by
    // `send`, so the builder methods stay infallible and chainable.
    data: Result<serde_json::Value>,
    summary: Option<String>,
    subject: Option<String>,
    source_uri: Option<String>,
    id: Option<String>,
    time: Option<DateTime<Utc>>,
}

impl<'a> EmitBuilder<'a> {
    pub(crate) fn new(kite: &'a Kite, ty: impl Into<String>, data: impl Serialize) -> Self {
        let data = serde_json::to_value(data)
            .map_err(|e| KiteError::Validation(format!("event data is not serializable: {e}")));
        Self {
            kite,
            ty: ty.into(),
            data,
            summary: None,
            subject: None,
            source_uri: None,
            id: None,
            time: None,
        }
    }

    /// Attach a human-readable summary as the `kitesummary` extension.
    pub fn summary(mut self, summary: impl Into<String>) -> Self {
        self.summary = Some(summary.into());
        self
    }

    /// Set the CloudEvent `subject`.
    pub fn subject(mut self, subject: impl Into<String>) -> Self {
        self.subject = Some(subject.into());
        self
    }

    /// Set the CloudEvent `source` URI. Defaults to `https://{source}`.
    pub fn source_uri(mut self, source_uri: impl Into<String>) -> Self {
        self.source_uri = Some(source_uri.into());
        self
    }

    /// Set the CloudEvent `id`. Defaults to a random UUID v4.
    ///
    /// The id is stable across retries of the same emit, so a downstream
    /// consumer can dedup on it.
    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    /// Set the CloudEvent `time`. Defaults to now.
    ///
    /// Accepts a [`chrono::DateTime<Utc>`] or a [`std::time::SystemTime`].
    pub fn time(mut self, time: impl Into<DateTime<Utc>>) -> Self {
        self.time = Some(time.into());
        self
    }

    /// Build the CloudEvent and emit it in structured mode.
    pub async fn send(self) -> Result<EmitResult> {
        let data = self.data?;
        let source = self
            .source_uri
            .unwrap_or_else(|| format!("https://{}", self.kite.source()));
        let id = self.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let time = self.time.unwrap_or_else(Utc::now);

        let mut builder = EventBuilderV10::new()
            .id(id)
            .ty(self.ty)
            .source(source)
            .time(time)
            .data(JSON_CONTENT_TYPE, data);
        if let Some(subject) = self.subject {
            builder = builder.subject(subject);
        }
        if let Some(summary) = self.summary {
            builder = builder.extension("kitesummary", summary);
        }

        let event = builder
            .build()
            .map_err(|e| KiteError::Validation(format!("failed to build CloudEvent: {e}")))?;

        self.kite.emit_event(event).await
    }
}
