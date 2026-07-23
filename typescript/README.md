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
| `id` | `string` | `crypto.randomUUID()` | CloudEvent `id` |
| `time` | `string \| Date` | now | CloudEvent `time` |

### `kite.emitEvent(event) → Promise<EmitResult>`

Escape hatch: send a fully-specified structured `CloudEvent` as-is. Missing
`specversion`, `id`, and `source` are filled in; everything else (including
extension attributes) is preserved. CloudEvents extension keys must be lowercase
alphanumeric.

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

## Runtime support

| Runtime | Supported | Notes |
|---|---|---|
| Node.js | ✅ 18+ | Uses global `fetch` / `crypto`. |
| Bun | ✅ | |
| Deno | ✅ | |
| Cloudflare Workers / edge | ✅ | No Node-only APIs in the runtime path. |
| Browsers | ⚠️ | Works technically, but do not ship hook tokens to untrusted clients. |

## Example

See [`examples/node-emit.ts`](./examples/node-emit.ts) for a minimal runnable
program that reads config from environment variables.

## License

[MIT](../LICENSE) © Alpha Centauri Cyberspace
