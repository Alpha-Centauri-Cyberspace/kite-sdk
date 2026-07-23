//! Client-side validation mirroring the server's rules, so bad input fails
//! fast instead of being silently downgraded or rejected after a round trip.

use crate::error::KiteError;

/// Sources reserved by the server; cannot be used by the SDK.
///
/// Mirrors `RESERVED_SOURCES` in `kite-server`'s `routes/tokens.rs`.
const RESERVED_SOURCES: &[&str] = &["kite"];

/// Validate a `source` slug against the server's `validate_source` rules:
/// lowercase alphanumeric + hyphen, must start with an alphanumeric, at most
/// 64 characters, and not a reserved source (`kite`).
///
/// Mirrors `kite-server`'s `routes/tokens.rs::validate_source`.
pub fn is_valid_source(source: &str) -> bool {
    if source.is_empty() || source.len() > 64 {
        return false;
    }
    if RESERVED_SOURCES.contains(&source) {
        return false;
    }
    let mut chars = source.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Return a [`KiteError::Validation`] if `source` is invalid.
pub(crate) fn assert_valid_source(source: &str) -> Result<(), KiteError> {
    if is_valid_source(source) {
        Ok(())
    } else {
        Err(KiteError::Validation(format!(
            "invalid source \"{source}\": must be lowercase alphanumeric and hyphens, \
             start with a letter or digit, be at most 64 characters, and not be \"kite\""
        )))
    }
}

/// CloudEvents extension attribute names must be lowercase alphanumeric (no
/// hyphens, underscores, or dots) per the CloudEvents spec. The server silently
/// downgrades events with malformed extensions to `com.{source}.event`, so the
/// SDK guards extension keys to fail fast instead.
pub fn is_valid_extension_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_sources() {
        assert!(is_valid_source("github"));
        assert!(is_valid_source("stripe"));
        assert!(is_valid_source("my-app"));
        assert!(is_valid_source("kite-prod"));
        assert!(is_valid_source("0abc"));
    }

    #[test]
    fn rejects_reserved_kite_source() {
        assert!(!is_valid_source("kite"));
    }

    #[test]
    fn rejects_empty_source() {
        assert!(!is_valid_source(""));
    }

    #[test]
    fn rejects_oversized_source() {
        assert!(!is_valid_source(&"a".repeat(65)));
    }

    #[test]
    fn rejects_uppercase_source() {
        assert!(!is_valid_source("GitHub"));
    }

    #[test]
    fn rejects_underscore_source() {
        assert!(!is_valid_source("foo_bar"));
    }

    #[test]
    fn rejects_source_starting_with_hyphen() {
        assert!(!is_valid_source("-foo"));
    }

    #[test]
    fn assert_valid_source_errors_on_reserved() {
        let err = assert_valid_source("kite").unwrap_err();
        assert!(matches!(err, KiteError::Validation(_)));
    }

    #[test]
    fn accepts_lowercase_alphanumeric_extension_name() {
        assert!(is_valid_extension_name("kitesummary"));
        assert!(is_valid_extension_name("trace0"));
    }

    #[test]
    fn rejects_extension_name_with_hyphen() {
        assert!(!is_valid_extension_name("kite-summary"));
    }

    #[test]
    fn rejects_empty_extension_name() {
        assert!(!is_valid_extension_name(""));
    }
}
