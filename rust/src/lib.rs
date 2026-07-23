//! Emit events from your Rust application into [Kite](https://getkite.sh).
//!
//! Events flow through the same ingest pipeline as GitHub or Stripe webhooks
//! and arrive in `kite stream`, `kite proxy`, and agent sessions as
//! [CloudEvents](https://cloudevents.io).
//!
//! ```text
//! your app ──(SDK)──▶ api.getkite.sh ──▶ kite CLI / agents
//! ```
//!
//! # Quickstart
//!
//! First create an endpoint and hook token with the [Kite CLI](https://github.com/Alpha-Centauri-Cyberspace/kite-cli):
//!
//! ```bash
//! kite endpoints create --source my-app
//! ```
//!
//! Then emit events:
//!
//! ```no_run
//! use kite_sdk::Kite;
//!
//! # async fn run() -> Result<(), kite_sdk::KiteError> {
//! let kite = Kite::builder()
//!     .team_id("your-team")
//!     .source("my-app")
//!     .token(std::env::var("KITE_HOOK_TOKEN").unwrap())
//!     .build()?;
//!
//! kite.emit("com.myapp.user.signup", serde_json::json!({ "userId": "u_123" }))
//!     .summary("User u_123 signed up")
//!     .send()
//!     .await?;
//! # Ok(())
//! # }
//! ```
//!
//! # Emit APIs
//!
//! - [`Kite::emit`] — build a structured CloudEvent with a custom `type` via a
//!   fluent builder.
//! - [`Kite::emit_event`] — send a fully-specified [`cloudevents::Event`].
//! - [`Kite::emit_raw`] — send plain JSON; the server derives
//!   `type = com.{source}.event`.
//!
//! # Retry semantics
//!
//! [`Kite::emit`], [`Kite::emit_event`], and [`Kite::emit_raw`] retry
//! automatically on HTTP 429 (honoring `retry_after_secs`, capped at 30 s),
//! 502/503/504, and transport errors, using exponential backoff with full
//! jitter up to `max_retries` attempts. Other 4xx responses are never retried.
//! A serialized body over 256 KB fails with [`KiteError::PayloadTooLarge`]
//! before any network call.
//!
//! Delivery is at-least-once: the server mints a fresh event id per accepted
//! request, but the CloudEvent `id` is stable across retries, so downstream
//! consumers should dedup on it.

#![deny(missing_docs)]

mod client;
mod emit;
mod error;
mod retry;
mod types;
mod validate;

pub use client::{Kite, KiteBuilder};
pub use emit::EmitBuilder;
pub use error::{KiteError, Result};
pub use types::{AuthMode, DEFAULT_INGEST_URL, EmitResult, EmitStatus, EmitUsage, MAX_BODY_SIZE};
pub use validate::{is_valid_extension_name, is_valid_source};

// Re-export the CloudEvents types needed to build events for `emit_event`.
pub use cloudevents::{Event, EventBuilder, EventBuilderV10};
