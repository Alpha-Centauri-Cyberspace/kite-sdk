import {
  KiteAuthError,
  KiteError,
  KitePayloadTooLargeError,
  KiteRateLimitError,
  KiteServerError,
  KiteValidationError,
} from "./errors.js";
import {
  type AuthMode,
  type CloudEvent,
  type EmitOptions,
  type EmitResult,
  type EmitUsage,
  type KiteConfig,
  DEFAULT_INGEST_URL,
  MAX_BODY_SIZE,
} from "./types.js";
import { assertValidSource, isValidExtensionName } from "./validate.js";
import { generateId } from "./id.js";

const CLOUDEVENTS_CONTENT_TYPE = "application/cloudevents+json; charset=utf-8";
const JSON_CONTENT_TYPE = "application/json";

/**
 * Standard CloudEvents 1.0 context attributes. Any other top-level key on an
 * event object is treated as an extension attribute and validated as such.
 */
const CE_ATTRIBUTES = new Set([
  "specversion",
  "id",
  "source",
  "type",
  "time",
  "subject",
  "datacontenttype",
  "dataschema",
  "data",
]);

/** Base backoff (ms) for retry attempt 0; grows exponentially. */
const BASE_BACKOFF_MS = 300;
/** Ceiling on any single backoff wait (ms), including server `retry_after`. */
const MAX_BACKOFF_MS = 30_000;

/** Raw JSON shape the server returns on ingest. */
interface ServerResponseBody {
  id?: string;
  status?: string;
  error?: string;
  created_at?: string;
  retry_after_secs?: number;
  max_bytes?: number;
  usage?: {
    events_used?: number;
    events_limit?: number;
    amount_charged_atomic?: number;
    amount_charged_sats?: number;
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Client for emitting events into Kite's ingest pipeline.
 *
 * ```ts
 * const kite = new Kite({ teamId, source: "my-app", token });
 * await kite.emit("com.myapp.user.signup", { userId: "u_123" });
 * ```
 */
export class Kite {
  private readonly teamId: string;
  private readonly source: string;
  private readonly token: string;
  private readonly ingestUrl: string;
  private readonly authMode: AuthMode;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: KiteConfig) {
    if (!config || typeof config !== "object") {
      throw new KiteValidationError("Kite config is required");
    }
    if (!config.teamId) {
      throw new KiteValidationError("teamId is required");
    }
    if (!config.source) {
      throw new KiteValidationError("source is required");
    }
    if (!config.token) {
      throw new KiteValidationError("token is required");
    }
    assertValidSource(config.source);

    const maxRetries = config.maxRetries ?? 3;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new KiteValidationError("maxRetries must be a non-negative integer");
    }

    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new KiteValidationError(
        "global fetch is not available in this runtime; pass a `fetch` implementation in the config",
      );
    }

    this.teamId = config.teamId;
    this.source = config.source;
    this.token = config.token;
    this.ingestUrl = (config.ingestUrl ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");
    this.authMode = config.authMode ?? "bearer";
    this.maxRetries = maxRetries;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Build and send a CloudEvent with a custom `type`.
   *
   * The event is sent in CloudEvents structured mode. When `options.summary`
   * is provided it is attached as the `kitesummary` extension.
   */
  async emit(
    type: string,
    data: unknown,
    options: EmitOptions = {},
  ): Promise<EmitResult> {
    if (typeof type !== "string" || type.length === 0) {
      throw new KiteValidationError("emit(type, ...): type must be a non-empty string");
    }

    const time =
      options.time instanceof Date
        ? options.time.toISOString()
        : (options.time ?? new Date().toISOString());

    const event: CloudEvent = {
      specversion: "1.0",
      id: options.id ?? generateId(),
      source: options.sourceUri ?? `https://${this.source}`,
      type,
      time,
      datacontenttype: JSON_CONTENT_TYPE,
      data,
    };
    if (options.subject !== undefined) {
      event.subject = options.subject;
    }
    if (options.summary !== undefined) {
      // Server-side change preserves a client-supplied kitesummary.
      event.kitesummary = options.summary;
    }

    return this.emitEvent(event);
  }

  /**
   * Send a fully-specified structured CloudEvent as-is. Missing `specversion`,
   * `id`, and `source` are filled in; everything else is preserved.
   *
   * Extension attributes are validated client-side: names must be lowercase
   * alphanumeric and values must be string, number, or boolean (per the
   * CloudEvents spec). This is deliberate — if the server cannot parse the
   * posted body as a CloudEvent (e.g. a bad extension value or a non-RFC3339
   * `time`), it silently wraps the body as `com.{source}.event` and still
   * returns 202, so the custom `type` would be lost with no error. Validating
   * here surfaces a `KiteValidationError` instead of that silent downgrade.
   */
  async emitEvent(event: CloudEvent): Promise<EmitResult> {
    if (!event || typeof event !== "object") {
      throw new KiteValidationError("emitEvent(event): event must be an object");
    }
    if (typeof event.type !== "string" || event.type.length === 0) {
      throw new KiteValidationError(
        "emitEvent(event): event.type must be a non-empty string",
      );
    }

    const payload: CloudEvent = {
      ...event,
      specversion: event.specversion ?? "1.0",
      id: event.id ?? generateId(),
      source: event.source ?? `https://${this.source}`,
    };

    this.validateExtensions(payload);

    const body = this.serialize(payload);
    return this.send(body, CLOUDEVENTS_CONTENT_TYPE);
  }

  /**
   * Validate CloudEvent extension attributes so a malformed event fails loudly
   * client-side rather than being silently downgraded to `com.{source}.event`
   * by the server. `undefined` values are ignored (dropped during serialization).
   */
  private validateExtensions(event: CloudEvent): void {
    for (const [key, value] of Object.entries(event)) {
      if (CE_ATTRIBUTES.has(key) || value === undefined) {
        continue;
      }
      if (!isValidExtensionName(key)) {
        throw new KiteValidationError(
          `invalid CloudEvent extension name "${key}": extension attribute names ` +
            `must be lowercase alphanumeric (no hyphens, underscores, or dots)`,
        );
      }
      const t = typeof value;
      if (t !== "string" && t !== "number" && t !== "boolean") {
        throw new KiteValidationError(
          `invalid CloudEvent extension value for "${key}": extension values must ` +
            `be a string, number, or boolean (got ${value === null ? "null" : t})`,
        );
      }
    }
  }

  /**
   * Send plain JSON. The server wraps it into a CloudEvent, deriving
   * `type = com.{source}.event` and `source = https://{source}`.
   */
  async emitRaw(data: unknown): Promise<EmitResult> {
    const body = this.serialize(data);
    return this.send(body, JSON_CONTENT_TYPE);
  }

  private serialize(value: unknown): string {
    let body: string;
    try {
      body = JSON.stringify(value);
    } catch (err) {
      throw new KiteValidationError(
        `event data is not JSON-serializable: ${(err as Error).message}`,
      );
    }
    if (body === undefined) {
      throw new KiteValidationError("event data serialized to undefined");
    }
    // Byte length, since the server limits bytes, not UTF-16 units.
    const byteLength = new TextEncoder().encode(body).length;
    if (byteLength > MAX_BODY_SIZE) {
      throw new KitePayloadTooLargeError(
        `payload is ${byteLength} bytes, which exceeds the ${MAX_BODY_SIZE} byte limit`,
        { maxBytes: MAX_BODY_SIZE },
      );
    }
    return body;
  }

  private buildUrl(): string {
    const base = `${this.ingestUrl}/hooks/${encodeURIComponent(this.teamId)}/${encodeURIComponent(this.source)}`;
    if (this.authMode === "path") {
      return `${base}/${encodeURIComponent(this.token)}`;
    }
    return base;
  }

  private buildHeaders(contentType: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": contentType,
    };
    if (this.authMode === "bearer") {
      headers["authorization"] = `Bearer ${this.token}`;
    }
    return headers;
  }

  private async send(body: string, contentType: string): Promise<EmitResult> {
    const url = this.buildUrl();
    const headers = this.buildHeaders(contentType);

    let lastError: KiteError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: "POST", headers, body });
      } catch (err) {
        // Network-level failure — retryable.
        lastError = new KiteServerError(
          `network error while emitting event: ${(err as Error).message}`,
          { cause: err },
        );
        if (attempt < this.maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw lastError;
      }

      const parsed = await parseBody(response);

      if (response.ok) {
        return toEmitResult(parsed);
      }

      const error = toError(response.status, parsed);

      if (isRetryable(response.status) && attempt < this.maxRetries) {
        lastError = error;
        const wait =
          error instanceof KiteRateLimitError && error.retryAfterSecs !== undefined
            ? Math.min(error.retryAfterSecs * 1000, MAX_BACKOFF_MS)
            : backoff(attempt);
        await sleep(wait);
        continue;
      }

      throw error;
    }

    // Loop only exits via return/throw above; this satisfies the type checker.
    throw lastError ?? new KiteServerError("emit failed after retries");
  }
}

/** Exponential backoff with full jitter, capped at MAX_BACKOFF_MS. */
function backoff(attempt: number): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.random() * ceiling;
}

/** Only 429 and 502/503/504 are retryable among HTTP statuses. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function parseBody(response: Response): Promise<ServerResponseBody> {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text) as ServerResponseBody;
  } catch {
    return { error: text };
  }
}

function toEmitResult(body: ServerResponseBody): EmitResult {
  const usage: EmitUsage | undefined = body.usage
    ? {
        eventsUsed: body.usage.events_used,
        eventsLimit: body.usage.events_limit,
        amountChargedAtomic:
          body.usage.amount_charged_atomic ?? body.usage.amount_charged_sats,
      }
    : undefined;

  return {
    id: body.id ?? "",
    status: body.status === "duplicate_ignored" ? "duplicate_ignored" : "accepted",
    createdAt: body.created_at,
    usage,
  };
}

function toError(status: number, body: ServerResponseBody): KiteError {
  const serverError = body.error;
  const message = serverError ?? `Kite ingest failed with status ${status}`;

  if (status === 401 || status === 403) {
    return new KiteAuthError(message, { status, serverError });
  }
  if (status === 429) {
    return new KiteRateLimitError(message, {
      status,
      serverError,
      retryAfterSecs: body.retry_after_secs,
    });
  }
  if (status === 413) {
    return new KitePayloadTooLargeError(message, {
      status,
      serverError,
      maxBytes: body.max_bytes ?? MAX_BODY_SIZE,
    });
  }
  if (status >= 500) {
    return new KiteServerError(message, { status, serverError });
  }
  return new KiteError(message, { status, serverError });
}
