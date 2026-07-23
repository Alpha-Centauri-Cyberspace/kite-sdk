/**
 * Error hierarchy for the Kite SDK.
 *
 * Every error thrown by the SDK extends {@link KiteError}, so a single
 * `catch (err) { if (err instanceof KiteError) ... }` catches them all.
 * Errors carry the HTTP `status` (when the failure originated server-side)
 * and the server-provided `error` string when one was returned.
 */

/** Base class for every error thrown by the Kite SDK. */
export class KiteError extends Error {
  /** HTTP status code, when the error came from a server response. */
  readonly status?: number;
  /** The `error` string from the server response body, when present. */
  readonly serverError?: string;

  constructor(
    message: string,
    options?: { status?: number; serverError?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "KiteError";
    this.status = options?.status;
    this.serverError = options?.serverError;
    // Restore prototype chain for transpiled targets that extend built-ins.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Client-side validation failure: bad config, source, or event shape. */
export class KiteValidationError extends KiteError {
  constructor(message: string) {
    super(message);
    this.name = "KiteValidationError";
  }
}

/** Authentication/authorization failure (HTTP 401 or 403). */
export class KiteAuthError extends KiteError {
  constructor(message: string, options?: { status?: number; serverError?: string }) {
    super(message, options);
    this.name = "KiteAuthError";
  }
}

/** Rate limited (HTTP 429). Carries `retryAfterSecs` when the server sent it. */
export class KiteRateLimitError extends KiteError {
  /** Seconds the server asked the client to wait, when provided. */
  readonly retryAfterSecs?: number;

  constructor(
    message: string,
    options?: { status?: number; serverError?: string; retryAfterSecs?: number },
  ) {
    super(message, options);
    this.name = "KiteRateLimitError";
    this.retryAfterSecs = options?.retryAfterSecs;
  }
}

/**
 * Payload exceeded the 256KB limit — either rejected by the server (HTTP 413)
 * or caught by the client-side pre-check before sending.
 */
export class KitePayloadTooLargeError extends KiteError {
  /** The maximum allowed body size in bytes. */
  readonly maxBytes: number;

  constructor(
    message: string,
    options: { maxBytes: number; status?: number; serverError?: string },
  ) {
    super(message, options);
    this.name = "KitePayloadTooLargeError";
    this.maxBytes = options.maxBytes;
  }
}

/** Server-side failure (HTTP 5xx). */
export class KiteServerError extends KiteError {
  constructor(
    message: string,
    options?: { status?: number; serverError?: string; cause?: unknown },
  ) {
    super(message, options);
    this.name = "KiteServerError";
  }
}
