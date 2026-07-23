//! HTTP-level tests exercising the wire contract against a mock ingest server.

use kite_sdk::{AuthMode, EmitStatus, EventBuilder, Kite, KiteError};
use serde_json::Value;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A 202 accepted response body matching the server contract.
fn accepted_body() -> Value {
    serde_json::json!({
        "id": "evt_srv_1",
        "created_at": "2026-07-22T00:00:00Z",
        "usage": {
            "events_used": 5,
            "events_limit": 1000,
            "amount_charged_atomic": 12,
            "amount_charged_sats": 12
        }
    })
}

fn client(server: &MockServer, source: &str, auth_mode: AuthMode) -> Kite {
    Kite::builder()
        .team_id("team-1")
        .source(source)
        .token("kite_tok_secret")
        .ingest_url(server.uri())
        .auth_mode(auth_mode)
        .max_retries(3)
        .build()
        .expect("valid config")
}

#[tokio::test]
async fn emit_sends_structured_cloudevent_body_and_headers() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/hooks/team-1/my-app"))
        .and(header(
            "content-type",
            "application/cloudevents+json; charset=utf-8",
        ))
        .and(header("authorization", "Bearer kite_tok_secret"))
        .respond_with(ResponseTemplate::new(202).set_body_json(accepted_body()))
        .mount(&server)
        .await;

    let kite = client(&server, "my-app", AuthMode::Bearer);
    let result = kite
        .emit(
            "com.myapp.user.signup",
            serde_json::json!({ "userId": "u_123" }),
        )
        .summary("User u_123 signed up")
        .subject("u_123")
        .id("custom-id")
        .send()
        .await
        .expect("emit succeeds");

    assert_eq!(result.status, EmitStatus::Accepted);
    assert_eq!(result.id, "evt_srv_1");
    assert_eq!(result.created_at.as_deref(), Some("2026-07-22T00:00:00Z"));

    // Inspect the captured request body for the exact structured CloudEvent.
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body["specversion"], "1.0");
    assert_eq!(body["type"], "com.myapp.user.signup");
    assert_eq!(body["id"], "custom-id");
    assert_eq!(body["source"], "https://my-app");
    assert_eq!(body["subject"], "u_123");
    assert_eq!(body["kitesummary"], "User u_123 signed up");
    assert_eq!(body["datacontenttype"], "application/json");
    assert_eq!(body["data"]["userId"], "u_123");
}

#[tokio::test]
async fn emit_raw_sends_plain_json_content_type() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/hooks/team-1/my-app"))
        .and(header("content-type", "application/json"))
        .respond_with(ResponseTemplate::new(202).set_body_json(accepted_body()))
        .mount(&server)
        .await;

    let kite = client(&server, "my-app", AuthMode::Bearer);
    kite.emit_raw(serde_json::json!({ "hello": "world" }))
        .await
        .expect("emit_raw succeeds");

    let requests = server.received_requests().await.unwrap();
    let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body, serde_json::json!({ "hello": "world" }));
}

#[tokio::test]
async fn path_auth_puts_token_in_url_and_omits_header() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/hooks/team-1/my-app/kite_tok_secret"))
        .respond_with(ResponseTemplate::new(202).set_body_json(accepted_body()))
        .mount(&server)
        .await;

    let kite = client(&server, "my-app", AuthMode::Path);
    kite.emit_raw(serde_json::json!({ "a": 1 }))
        .await
        .expect("emit succeeds via path auth");

    let requests = server.received_requests().await.unwrap();
    assert_eq!(
        requests[0].url.path(),
        "/hooks/team-1/my-app/kite_tok_secret"
    );
    assert!(requests[0].headers.get("authorization").is_none());
}

#[tokio::test]
async fn duplicate_ignored_maps_to_status() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(
                serde_json::json!({ "status": "duplicate_ignored", "id": "evt_dup" }),
            ),
        )
        .mount(&server)
        .await;

    let kite = client(&server, "my-app", AuthMode::Bearer);
    let result = kite
        .emit_raw(serde_json::json!({ "a": 1 }))
        .await
        .expect("dup succeeds");
    assert_eq!(result.status, EmitStatus::DuplicateIgnored);
    assert_eq!(result.id, "evt_dup");
}

#[tokio::test]
async fn retries_on_429_and_honors_retry_after() {
    let server = MockServer::start().await;

    // First attempt: 429 with retry_after. Second: success.
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(429).set_body_json(
                serde_json::json!({ "error": "rate limited", "retry_after_secs": 1 }),
            ),
        )
        .up_to_n_times(1)
        .with_priority(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(202).set_body_json(accepted_body()))
        .with_priority(2)
        .mount(&server)
        .await;

    let kite = client(&server, "my-app", AuthMode::Bearer);
    let result = kite
        .emit_raw(serde_json::json!({ "a": 1 }))
        .await
        .expect("succeeds after retry");
    assert_eq!(result.status, EmitStatus::Accepted);

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2, "should have retried once");
}

#[tokio::test]
async fn does_not_retry_on_401() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(401)
                .set_body_json(serde_json::json!({ "error": "invalid token" })),
        )
        .mount(&server)
        .await;

    let kite = client(&server, "my-app", AuthMode::Bearer);
    let err = kite
        .emit_raw(serde_json::json!({ "a": 1 }))
        .await
        .expect_err("401 should error");
    assert!(matches!(err, KiteError::Auth { status: 401, .. }));

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1, "401 must not be retried");
}

#[tokio::test]
async fn maps_413_payload_too_large() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(413).set_body_json(
            serde_json::json!({ "error": "payload too large", "max_bytes": 262144 }),
        ))
        .mount(&server)
        .await;

    let kite = client(&server, "my-app", AuthMode::Bearer);
    let err = kite
        .emit_raw(serde_json::json!({ "a": 1 }))
        .await
        .expect_err("413 should error");
    assert!(matches!(
        err,
        KiteError::PayloadTooLarge {
            max_bytes: 262144,
            ..
        }
    ));
}

#[tokio::test]
async fn client_side_payload_precheck_rejects_before_sending() {
    let server = MockServer::start().await;

    // Any request that reaches the server would 500 the test intent; assert 0 hits.
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(202).set_body_json(accepted_body()))
        .expect(0)
        .mount(&server)
        .await;

    let kite = client(&server, "my-app", AuthMode::Bearer);
    // A > 256 KB string payload.
    let big = "x".repeat(300 * 1024);
    let err = kite
        .emit_raw(serde_json::json!({ "blob": big }))
        .await
        .expect_err("oversized payload should be rejected client-side");
    assert!(matches!(err, KiteError::PayloadTooLarge { .. }));
}

#[tokio::test]
async fn invalid_extension_name_fails_before_sending() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(202).set_body_json(accepted_body()))
        .expect(0)
        .mount(&server)
        .await;

    let kite = client(&server, "my-app", AuthMode::Bearer);
    let event = kite_sdk::EventBuilderV10::new()
        .id("e1")
        .ty("com.myapp.thing")
        .source("https://my-app")
        .extension("bad-name", "value")
        .build()
        .unwrap();

    let err = kite.emit_event(event).await.expect_err("invalid extension");
    assert!(matches!(err, KiteError::Validation(_)));
}
