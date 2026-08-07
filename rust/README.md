# kite-sdk

Emit events from your Rust application into [Kite](https://getkite.sh). Events
flow through the same ingest pipeline as GitHub or Stripe webhooks and arrive in
`kite stream`, `kite proxy`, and agent sessions as
[CloudEvents](https://cloudevents.io).

```
your app ──(SDK)──▶ api.getkite.sh ──▶ kite CLI / agents
```

- Built on `reqwest` (rustls) and the `cloudevents` crate — the same event model
  the server parses, so structured events round-trip exactly.
- Typed errors and automatic retry with backoff.

## Install

Install only a version listed on crates.io; a source checkout or local package
build does not establish registry availability.

```bash
cargo add kite-sdk
```

The SDK is async and runs on a Tokio runtime (add `tokio` with the `macros` and
`rt-multi-thread` features to your own project).

## Quickstart

First create an endpoint and hook token with the [Kite CLI](https://github.com/Alpha-Centauri-Cyberspace/kite-cli):

```bash
kite endpoints create --source my-app
# prints a hook token — store it as a secret
```

Then emit events:

```rust
use kite_sdk::Kite;

# async fn run() -> Result<(), kite_sdk::KiteError> {
let kite = Kite::builder()
    .team_id("your-team")
    .source("my-app")
    .token(std::env::var("KITE_HOOK_TOKEN").unwrap())
    .build()?;

// Build + send a CloudEvent with a custom type:
kite.emit("com.myapp.user.signup", serde_json::json!({ "userId": "u_123", "plan": "pro" }))
    .summary("User u_123 signed up (pro)")
    .send()
    .await?;
# Ok(())
# }
```

Watch it arrive:

```bash
kite stream
```

## API reference

### `Kite::builder()`

| Option | Type | Default | Notes |
|---|---|---|---|
| `team_id` | `impl Into<String>` | — | **Required.** Your team id. |
| `source` | `impl Into<String>` | — | **Required.** Event source slug. Validated client-side: lowercase alphanumeric + hyphen, must start alphanumeric, ≤64 chars, not `kite`. |
| `token` | `impl Into<String>` | — | **Required.** Hook token from `kite endpoints create`. |
| `ingest_url` | `impl Into<String>` | `https://api.getkite.sh` | Ingest base URL. |
| `auth_mode` | `AuthMode` | `AuthMode::Bearer` | `Bearer` sends an authorization header; `Path` puts the token in the URL. |
| `max_retries` | `u32` | `3` | Max retry attempts for retryable failures. |

`.build()` validates the config (including the source rules and the ingest URL)
and returns `Result<Kite, KiteError>`.

### `kite.emit(type, data) -> EmitBuilder`

Builds a structured CloudEvent with the given `type` and `data`
(`Content-Type: application/cloudevents+json`) via a fluent builder. Call
`.send().await` to emit.

| Method | Type | Default | Maps to |
|---|---|---|---|
| `.summary(_)` | `impl Into<String>` | — | `kitesummary` extension |
| `.subject(_)` | `impl Into<String>` | — | CloudEvent `subject` |
| `.source_uri(_)` | `impl Into<String>` | `https://{source}` | CloudEvent `source` |
| `.id(_)` | `impl Into<String>` | random UUID v4 | CloudEvent `id` |
| `.time(_)` | `DateTime<Utc>` or `SystemTime` | now | CloudEvent `time` |

### `kite.emit_event(event) -> Result<EmitResult>`

Escape hatch: send a fully-specified structured [`cloudevents::Event`] as-is.
Missing `id` and `source` are filled in; everything else (including extension
attributes) is preserved. Extension names must be lowercase alphanumeric — an
invalid name fails fast with `KiteError::Validation` rather than being silently
downgraded by the server.

```rust
use kite_sdk::{Kite, Event, EventBuilder, EventBuilderV10};

# async fn run(kite: Kite) -> Result<(), kite_sdk::KiteError> {
let event: Event = EventBuilderV10::new()
    .id("custom-id")
    .ty("com.myapp.order.paid")
    .source("https://myapp.example")
    .data("application/json", serde_json::json!({ "orderId": "o_1" }))
    .build()
    .unwrap();
kite.emit_event(event).await?;
# Ok(())
# }
```

### `kite.emit_raw(data) -> Result<EmitResult>`

Send plain JSON (`Content-Type: application/json`). The server wraps it into a
CloudEvent, deriving `type = com.{source}.event` and `source = https://{source}`.

### `EmitResult`

```rust
pub struct EmitResult {
    pub id: String,                    // event id from the server
    pub status: EmitStatus,            // Accepted | DuplicateIgnored
    pub created_at: Option<String>,    // server-stamped RFC3339 time
    pub usage: Option<EmitUsage>,      // events_used / events_limit / amount_charged_atomic
}
```

## Errors

Every fallible call returns `Result<T, KiteError>`. Each variant carries the HTTP
`status` (when server-side) and the server's `error` string when present.

| Variant | When |
|---|---|
| `KiteError::Validation` | Bad config, invalid source, or invalid event — raised client-side before any request. |
| `KiteError::Auth` | HTTP 401 / 403. |
| `KiteError::RateLimit` | HTTP 429. Carries `retry_after_secs`. |
| `KiteError::PayloadTooLarge` | HTTP 413, or the client-side pre-check when the serialized body exceeds 256 KB. Carries `max_bytes`. |
| `KiteError::Server` | HTTP 5xx or any other unexpected status. |
| `KiteError::Network` | A transport-level failure (connection reset, DNS failure, timeout). |

```rust
use kite_sdk::{Kite, KiteError};

# async fn run(kite: Kite) {
match kite.emit("com.myapp.thing", serde_json::json!({ "a": 1 })).send().await {
    Ok(result) => println!("emitted {}", result.id),
    Err(KiteError::RateLimit { retry_after_secs, .. }) => {
        eprintln!("rate limited; retry after {retry_after_secs:?}s");
    }
    Err(err) => eprintln!("{err}"),
}
# }
```

## Retry semantics

`emit`, `emit_event`, and `emit_raw` automatically retry on:

- **429** — respecting `retry_after_secs` from the server when present (capped at 30 s).
- **502 / 503 / 504**.
- **Network errors** (connection reset, DNS failure, etc.).

Retries use exponential backoff (base 300 ms) with full jitter, up to
`max_retries` attempts. Other 4xx responses (401, 403, 413, 400, …) are **never**
retried — they return immediately. A serialized body over 256 KB fails with
`KiteError::PayloadTooLarge` before any network call.

Delivery is **at-least-once**: on the accepted path the server mints a fresh
`event_id` per request, but the CloudEvent `id` you send is stable across
retries. Downstream consumers should dedup on the CloudEvent `id`.

## Runtime notes

- Async, Tokio-based. TLS uses `rustls` (no OpenSSL / system TLS needed).
- The client is cheap to `clone` and safe to share across tasks — reuse one
  `Kite` per source rather than building one per event.

## Example

See [`examples/emit.rs`](./examples/emit.rs) for a minimal runnable program that
reads config from environment variables:

```bash
KITE_TEAM_ID=... KITE_SOURCE=my-app KITE_HOOK_TOKEN=... \
  cargo run --example emit
```

## License

[MIT](./LICENSE) © Alpha Centauri Cyberspace
