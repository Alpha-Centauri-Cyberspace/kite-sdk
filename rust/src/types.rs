//! Shared constants and the public result/usage types returned by an emit.

/// Maximum ingest body size the server accepts (256 KB).
///
/// Mirrors `MAX_BODY_SIZE` in `kite-server`'s ingest handler. The client
/// enforces it before sending so an oversized payload fails fast with
/// [`crate::KiteError::PayloadTooLarge`] instead of a round trip.
pub const MAX_BODY_SIZE: usize = 256 * 1024;

/// Default Kite ingest base URL.
pub const DEFAULT_INGEST_URL: &str = "https://api.getkite.sh";

/// How the hook token is presented to the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AuthMode {
    /// Send the token in an `Authorization: Bearer <token>` header (default).
    #[default]
    Bearer,
    /// Put the token in the URL path: `/hooks/{team}/{source}/{token}`.
    Path,
}

/// Outcome of a successful emit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmitStatus {
    /// The server accepted a fresh event (HTTP 202).
    Accepted,
    /// The event was a duplicate and ignored idempotently (HTTP 200).
    DuplicateIgnored,
}

/// Per-request usage snapshot the server returns on a successful ingest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitUsage {
    /// Events used in the current billing period after this event.
    pub events_used: Option<u64>,
    /// Event quota for the current billing period.
    pub events_limit: Option<u64>,
    /// Amount charged for this event, in atomic units of the configured asset.
    pub amount_charged_atomic: Option<i64>,
}

/// Result of a successful [`crate::Kite::emit`], `emit_event`, or `emit_raw`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitResult {
    /// The event id assigned by the server.
    ///
    /// Note: on the accepted path the server mints a fresh id per request; on
    /// the duplicate path it echoes the id it already stored.
    pub id: String,
    /// Whether the event was newly accepted or a duplicate no-op.
    pub status: EmitStatus,
    /// Server-stamped creation time (RFC 3339), when provided.
    pub created_at: Option<String>,
    /// Usage snapshot, when provided.
    pub usage: Option<EmitUsage>,
}
