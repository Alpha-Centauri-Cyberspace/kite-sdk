//! Retry policy: which statuses are retryable and how long to back off.
//!
//! Mirrors the TypeScript SDK exactly — exponential backoff with full jitter,
//! base 300 ms, capped at 30 s, and a server-supplied `retry_after` that is
//! honored but also capped at 30 s.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Base backoff for retry attempt 0; grows exponentially per attempt.
const BASE_BACKOFF_MS: u64 = 300;
/// Ceiling on any single backoff wait, including a server `retry_after`.
const MAX_BACKOFF_MS: u64 = 30_000;

/// Only 429 and 502/503/504 are retryable among HTTP statuses. Every other
/// 4xx (and any 2xx/3xx) is terminal.
pub(crate) fn is_retryable_status(status: u16) -> bool {
    matches!(status, 429 | 502 | 503 | 504)
}

/// The exponential ceiling for a given attempt, before jitter is applied.
///
/// `BASE * 2^attempt`, saturating at [`MAX_BACKOFF_MS`]. Uses a checked shift so
/// large attempt counts saturate instead of overflowing.
fn backoff_ceiling(attempt: u32) -> Duration {
    let ceiling_ms = BASE_BACKOFF_MS
        .checked_shl(attempt)
        .unwrap_or(u64::MAX)
        .min(MAX_BACKOFF_MS);
    Duration::from_millis(ceiling_ms)
}

/// Backoff wait for a retryable failure: full jitter over the exponential
/// ceiling, i.e. a uniform random value in `[0, ceiling]`.
pub(crate) fn backoff(attempt: u32) -> Duration {
    let ceiling = backoff_ceiling(attempt);
    ceiling.mul_f64(jitter_fraction())
}

/// Wait derived from a server-supplied `retry_after_secs`, capped at 30 s.
pub(crate) fn retry_after_wait(secs: u64) -> Duration {
    Duration::from_secs(secs).min(Duration::from_millis(MAX_BACKOFF_MS))
}

/// A pseudo-random fraction in `[0, 1)` for jitter.
///
/// Derived from the wall-clock nanosecond component to avoid pulling in a
/// random-number dependency. Jitter only needs to spread retries across time,
/// not to be cryptographically strong.
fn jitter_fraction() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    f64::from(nanos) / 1_000_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_429_and_5xx_gateway_statuses_are_retryable() {
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(502));
        assert!(is_retryable_status(503));
        assert!(is_retryable_status(504));
    }

    #[test]
    fn client_errors_are_not_retryable() {
        assert!(!is_retryable_status(400));
        assert!(!is_retryable_status(401));
        assert!(!is_retryable_status(403));
        assert!(!is_retryable_status(413));
    }

    #[test]
    fn plain_500_is_not_retryable() {
        // Mirrors the TS SDK: only the gateway 5xx are retried, not a bare 500.
        assert!(!is_retryable_status(500));
    }

    #[test]
    fn backoff_ceiling_grows_exponentially_from_base() {
        assert_eq!(backoff_ceiling(0), Duration::from_millis(300));
        assert_eq!(backoff_ceiling(1), Duration::from_millis(600));
        assert_eq!(backoff_ceiling(2), Duration::from_millis(1200));
    }

    #[test]
    fn backoff_ceiling_saturates_at_max() {
        assert_eq!(backoff_ceiling(100), Duration::from_millis(30_000));
    }

    #[test]
    fn backoff_never_exceeds_ceiling() {
        for attempt in 0..8 {
            let ceiling = backoff_ceiling(attempt);
            assert!(backoff(attempt) <= ceiling);
        }
    }

    #[test]
    fn retry_after_is_capped_at_max() {
        assert_eq!(retry_after_wait(5), Duration::from_secs(5));
        assert_eq!(retry_after_wait(120), Duration::from_millis(30_000));
    }

    #[test]
    fn jitter_fraction_is_in_unit_interval() {
        for _ in 0..1000 {
            let f = jitter_fraction();
            assert!((0.0..1.0).contains(&f));
        }
    }
}
