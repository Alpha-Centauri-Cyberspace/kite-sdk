//! The error type returned by every fallible operation in this crate.

/// Errors returned by the Kite SDK.
///
/// Client-side problems surface as [`KiteError::Validation`] before any network
/// call. Server responses map onto the status-specific variants, each carrying
/// the HTTP status and the server's `error` string when one was returned.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum KiteError {
    /// Bad configuration, an invalid source, or an invalid event — raised
    /// client-side before any request is made.
    #[error("{0}")]
    Validation(String),

    /// Authentication or authorization failure (HTTP 401 or 403).
    #[error("authentication failed (HTTP {status}){}", opt_suffix(.server_error))]
    Auth {
        /// The HTTP status returned by the server.
        status: u16,
        /// The server's `error` string, when present.
        server_error: Option<String>,
    },

    /// Rate limited (HTTP 429).
    #[error("rate limited (HTTP {status}){}", opt_suffix(.server_error))]
    RateLimit {
        /// The HTTP status returned by the server.
        status: u16,
        /// The server's `error` string, when present.
        server_error: Option<String>,
        /// Seconds the server asked the client to wait, when provided.
        retry_after_secs: Option<u64>,
    },

    /// Payload exceeded the 256 KB limit — either rejected by the server
    /// (HTTP 413) or caught by the client-side pre-check before sending.
    #[error("payload too large: exceeds the {max_bytes} byte limit{}", opt_suffix(.server_error))]
    PayloadTooLarge {
        /// The maximum allowed body size, in bytes.
        max_bytes: usize,
        /// The HTTP status, when this originated from a server response.
        status: Option<u16>,
        /// The server's `error` string, when present.
        server_error: Option<String>,
    },

    /// Server-side failure (HTTP 5xx or any other unexpected status).
    #[error("server error (HTTP {status}){}", opt_suffix(.server_error))]
    Server {
        /// The HTTP status returned by the server.
        status: u16,
        /// The server's `error` string, when present.
        server_error: Option<String>,
    },

    /// A transport-level failure (connection reset, DNS failure, timeout, …).
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
}

/// Render `": {msg}"` when a server error string is present, else nothing.
fn opt_suffix(server_error: &Option<String>) -> String {
    match server_error {
        Some(msg) => format!(": {msg}"),
        None => String::new(),
    }
}

/// Convenience alias for results returned by this crate.
pub type Result<T> = std::result::Result<T, KiteError>;
