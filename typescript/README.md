# @getkite/sdk

Emit events from your application into [Kite](https://getkite.sh). Events flow
through the same ingest pipeline as GitHub or Stripe webhooks and arrive in
`kite stream`, `kite proxy`, and agent sessions as [CloudEvents](https://cloudevents.io).

```
your app ──(SDK)──▶ api.getkite.sh ──▶ kite CLI / agents
```

- Zero runtime dependencies — built on the platform `fetch` and `crypto.randomUUID`.
- Dual ESM + CJS, full TypeScript types.
- Typed errors and automatic retry with backoff.

## Install

```bash
npm install @getkite/sdk
# or: pnpm add @getkite/sdk  /  bun add @getkite/sdk
```

## Quickstart

First create an endpoint and hook token with the [Kite CLI](https://github.com/Alpha-Centauri-Cyberspace/kite-cli):

```bash
kite endpoints create --source my-app
# prints a hook token — store it as a secret
```

Then emit events:

```ts
import { Kite } from "@getkite/sdk";

const kite = new Kite({
  teamId: "your-team",
  source: "my-app",
  token: process.env.KITE_HOOK_TOKEN!,
});

// Build + send a CloudEvent with a custom type:
await kite.emit(
  "com.myapp.user.signup",
  { userId: "u_123", plan: "pro" },
  { summary: "User u_123 signed up (pro)" },
);
```

Watch it arrive:

```bash
kite stream
```

## API reference

### `new Kite(config)`

| Option | Type | Default | Notes |
|---|---|---|---|
| `teamId` | `string` | — | **Required.** Your team id. |
| `source` | `string` | — | **Required.** Event source slug. Validated client-side: lowercase alphanumeric + hyphen, must start alphanumeric, ≤64 chars, not `kite`. |
| `token` | `string` | — | **Required.** Hook token from `kite endpoints create`. |
| `ingestUrl` | `string` | `https://api.getkite.sh` | Ingest base URL. |
| `authMode` | `"bearer" \| "path"` | `"bearer"` | `bearer` sends `Authorization: Bearer <token>`; `path` puts the token in the URL. |
| `maxRetries` | `number` | `3` | Max retry attempts for retryable failures. |
| `fetch` | `typeof fetch` | global `fetch` | Injectable for testing / custom runtimes. |

### `kite.emit(type, data, options?) → Promise<EmitResult>`

Builds a structured CloudEvent with the given `type` and `data` and sends it
(`Content-Type: application/cloudevents+json`).

| Option | Type | Default | Maps to |
|---|---|---|---|
| `summary` | `string` | — | `kitesummary` extension |
| `subject` | `string` | — | CloudEvent `subject` |
| `sourceUri` | `string` | `https://{source}` | CloudEvent `source` |
| `id` | `string` | generated UUID v4 | CloudEvent `id` |
| `time` | `string \| Date` | now | CloudEvent `time` |

### `kite.emitEvent(event) → Promise<EmitResult>`

Escape hatch: send a fully-specified structured `CloudEvent` as-is. Missing
`specversion`, `id`, and `source` are filled in; everything else (including
extension attributes) is preserved.

Extension attributes are validated client-side: names must be lowercase
alphanumeric, and values must be a string, number, or boolean (per the
CloudEvents spec). This guards against a **silent server-side downgrade**: if
the server cannot parse the posted body as a CloudEvent — for example a
non-string/number/boolean extension value, or a `time` that is not valid
RFC3339 — it wraps the body as a plain event with `type = com.{source}.event`
and still returns `202`, so your custom `type` would be lost with no error. The
SDK throws `KiteValidationError` up front instead.

### `kite.emitRaw(data) → Promise<EmitResult>`

Send plain JSON (`Content-Type: application/json`). The server wraps it into a
CloudEvent, deriving `type = com.{source}.event` and `source = https://{source}`.

### `EmitResult`

```ts
interface EmitResult {
  id: string;                                   // event id from the server
  status: "accepted" | "duplicate_ignored";
  createdAt?: string;                           // server-stamped RFC3339 time
  usage?: { eventsUsed?; eventsLimit?; amountChargedAtomic? };
}
```

## Errors

All errors extend `KiteError` and carry `status` (when server-side) and
`serverError` (the server's `error` string, when present).

| Error | When |
|---|---|
| `KiteValidationError` | Bad config, invalid source, or invalid event — thrown client-side before any request. |
| `KiteAuthError` | HTTP 401 / 403. |
| `KiteRateLimitError` | HTTP 429. Has `retryAfterSecs?`. |
| `KitePayloadTooLargeError` | HTTP 413, or the client-side pre-check when the serialized body exceeds 256 KB. Has `maxBytes`. |
| `KiteServerError` | HTTP 5xx or a network failure. |

```ts
import { KiteError, KiteRateLimitError } from "@getkite/sdk";

try {
  await kite.emit("com.myapp.thing", { a: 1 });
} catch (err) {
  if (err instanceof KiteRateLimitError) {
    console.warn(`rate limited; retry after ${err.retryAfterSecs}s`);
  } else if (err instanceof KiteError) {
    console.error(`${err.name} (${err.status}): ${err.message}`);
  }
}
```

## Retry semantics

`emit`, `emitEvent`, and `emitRaw` automatically retry on:

- **429** — respecting `retry_after_secs` from the server when present (capped at 30s).
- **502 / 503 / 504**.
- **Network errors** (connection reset, DNS failure, etc.).

Retries use exponential backoff with full jitter, up to `maxRetries` attempts.
Other 4xx responses (401, 403, 413, 400, …) are **never** retried — they throw
immediately. A serialized body over 256 KB throws `KitePayloadTooLargeError`
before any network call.

### At-least-once delivery

Delivery is **at-least-once**. If a request succeeds on the server but the
success response is lost (a dropped connection or a timeout on the way back),
the SDK retries and the event can be **delivered more than once**. The server
mints a fresh internal `event_id` per HTTP request, so it cannot deduplicate
these for you.

The CloudEvent `id` *is* stable across a request's retries — the body is
serialized once, before the retry loop — so **dedupe on the CloudEvent `id`**
in your consumer if you need exactly-once handling. Pass `options.id` (or set
`event.id` for `emitEvent`) to use a stable business key (e.g. an order id) as
the CloudEvent `id`, making that dedupe deterministic across process restarts.

## Runtime support

| Runtime | Supported | Notes |
|---|---|---|
| Node.js | ✅ 18+ | Uses global `fetch`; falls back to a WebCrypto/`Math.random` UUID when `crypto.randomUUID` is unavailable (stock Node 18). |
| Bun | ✅ | |
| Deno | ✅ | |
| Cloudflare Workers / edge | ✅ | No Node-only APIs in the runtime path. |
| Browsers | ⚠️ | Works technically, but do not ship hook tokens to untrusted clients. |

## Example

See [`examples/node-emit.ts`](./examples/node-emit.ts) for a minimal runnable
program that reads config from environment variables.

## License

[MIT](../LICENSE) © Alpha Centauri Cyberspace
