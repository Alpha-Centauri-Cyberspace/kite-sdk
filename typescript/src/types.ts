/** Maximum ingest body size the server accepts (256 KB). */
export const MAX_BODY_SIZE = 256 * 1024;

/** Default Kite ingest base URL. */
export const DEFAULT_INGEST_URL = "https://api.getkite.sh";

/** How the hook token is presented to the server. */
export type AuthMode = "bearer" | "path";

/**
 * A CloudEvents 1.0 structured-mode event.
 *
 * Extensions are inline top-level keys and, per the CloudEvents spec, MUST be
 * lowercase alphanumeric (e.g. `kitesummary`). The index signature models them.
 */
export interface CloudEvent {
  /** CloudEvents spec version. Always `"1.0"`. */
  specversion: "1.0";
  /** Unique event id. */
  id: string;
  /** Identifies the context in which the event happened (a URI-reference). */
  source: string;
  /** Describes the type of event, e.g. `com.myapp.user.signup`. */
  type: string;
  /** RFC3339 / ISO-8601 timestamp of when the event occurred. */
  time?: string;
  /** Subject of the event within the context of the source. */
  subject?: string;
  /** Media type of the `data` value. */
  datacontenttype?: string;
  /** Schema that `data` adheres to. */
  dataschema?: string;
  /** The event payload. */
  data?: unknown;
  /** CloudEvents extension attributes (lowercase alphanumeric keys). */
  [extension: string]: unknown;
}

/** Per-request usage snapshot returned by the server on success. */
export interface EmitUsage {
  eventsUsed?: number;
  eventsLimit?: number;
  amountChargedAtomic?: number;
}

/** Result of a successful emit. */
export interface EmitResult {
  /** The event id assigned/echoed by the server. */
  id: string;
  /** `"accepted"` for a fresh ingest, `"duplicate_ignored"` for a dedup no-op. */
  status: "accepted" | "duplicate_ignored";
  /** Server-stamped creation time (RFC3339), when provided. */
  createdAt?: string;
  /** Usage snapshot, when provided. */
  usage?: EmitUsage;
}

/** Options for {@link Kite.emit}. */
export interface EmitOptions {
  /** Human-readable summary → `kitesummary` extension. */
  summary?: string;
  /** CloudEvent `subject`. */
  subject?: string;
  /** CloudEvent `source` URI. Defaults to `https://{source}`. */
  sourceUri?: string;
  /** CloudEvent `id`. Defaults to `crypto.randomUUID()`. */
  id?: string;
  /** CloudEvent `time`. Defaults to now. */
  time?: string | Date;
}

/** Configuration for a {@link Kite} client. */
export interface KiteConfig {
  /** Team id (required). */
  teamId: string;
  /** Event source slug (required). Validated client-side. */
  source: string;
  /** Hook token from `kite endpoints create` (required). */
  token: string;
  /** Ingest base URL. Defaults to `https://api.getkite.sh`. */
  ingestUrl?: string;
  /** How to present the token. Defaults to `"bearer"`. */
  authMode?: AuthMode;
  /** Max retry attempts for retryable failures. Defaults to `3`. */
  maxRetries?: number;
  /** Custom `fetch` implementation (for testing / non-standard runtimes). */
  fetch?: typeof fetch;
}
