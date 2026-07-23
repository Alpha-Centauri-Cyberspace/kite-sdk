//! Env-gated end-to-end test against a real Kite ingest server.
//!
//! Skipped unless all of `KITE_E2E_TOKEN`, `KITE_E2E_TEAM_ID`, and
//! `KITE_E2E_SOURCE` are set. `KITE_E2E_URL` overrides the default ingest URL.
//!
//! Run with:
//!   KITE_E2E_TEAM_ID=... KITE_E2E_SOURCE=my-app KITE_E2E_TOKEN=... \
//!     cargo test --test integration -- --nocapture

use kite_sdk::{EmitStatus, Kite};

#[tokio::test]
async fn emits_a_real_event() {
    let (Ok(team_id), Ok(source), Ok(token)) = (
        std::env::var("KITE_E2E_TEAM_ID"),
        std::env::var("KITE_E2E_SOURCE"),
        std::env::var("KITE_E2E_TOKEN"),
    ) else {
        eprintln!("skipping: set KITE_E2E_TEAM_ID, KITE_E2E_SOURCE, KITE_E2E_TOKEN to run");
        return;
    };

    let mut builder = Kite::builder().team_id(team_id).source(source).token(token);
    if let Ok(url) = std::env::var("KITE_E2E_URL") {
        builder = builder.ingest_url(url);
    }
    let kite = builder.build().expect("valid config");

    let result = kite
        .emit(
            "com.kitesdk.e2e.ping",
            serde_json::json!({ "ts": chrono::Utc::now().to_rfc3339() }),
        )
        .summary("kite-sdk rust e2e ping")
        .send()
        .await
        .expect("emit succeeds against the live server");

    assert!(!result.id.is_empty());
    assert!(matches!(
        result.status,
        EmitStatus::Accepted | EmitStatus::DuplicateIgnored
    ));
    eprintln!("e2e emitted: {result:?}");
}
