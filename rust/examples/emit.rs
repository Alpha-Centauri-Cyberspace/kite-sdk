//! Minimal runnable example: emit an event into Kite.
//!
//! Prereqs:
//!   1. Create an endpoint + token:  kite endpoints create --source my-app
//!   2. Export the env vars below.
//!
//! Run with:
//!   KITE_TEAM_ID=... KITE_SOURCE=my-app KITE_HOOK_TOKEN=... \
//!     cargo run --example emit

use kite_sdk::{Kite, KiteError};

#[tokio::main]
async fn main() {
    let team_id = std::env::var("KITE_TEAM_ID").ok();
    let source = std::env::var("KITE_SOURCE").ok();
    let token = std::env::var("KITE_HOOK_TOKEN").ok();

    let (Some(team_id), Some(source), Some(token)) = (team_id, source, token) else {
        eprintln!(
            "Set KITE_TEAM_ID, KITE_SOURCE, and KITE_HOOK_TOKEN before running this example."
        );
        std::process::exit(1);
    };

    let mut builder = Kite::builder().team_id(team_id).source(source).token(token);
    if let Ok(url) = std::env::var("KITE_INGEST_URL") {
        builder = builder.ingest_url(url);
    }

    let kite = match builder.build() {
        Ok(kite) => kite,
        Err(err) => {
            eprintln!("failed to build Kite client: {err}");
            std::process::exit(1);
        }
    };

    let result = kite
        .emit(
            "com.myapp.user.signup",
            serde_json::json!({ "userId": "u_123", "plan": "pro" }),
        )
        .summary("User u_123 signed up (pro)")
        .send()
        .await;

    match result {
        Ok(result) => println!("emitted: {result:?}"),
        Err(KiteError::RateLimit {
            retry_after_secs, ..
        }) => {
            eprintln!("rate limited; retry after {retry_after_secs:?}s");
            std::process::exit(1);
        }
        Err(err) => {
            eprintln!("kite error: {err}");
            std::process::exit(1);
        }
    }
}
