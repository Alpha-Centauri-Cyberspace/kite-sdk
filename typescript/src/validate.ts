import { KiteValidationError } from "./errors.js";

/** Sources reserved by the server; cannot be used by the SDK. */
const RESERVED_SOURCES = new Set(["kite"]);

/**
 * Validate a `source` slug against the server's `validate_source` rules:
 * lowercase alphanumeric + hyphen, must start with alphanumeric, ≤64 chars,
 * and not a reserved source (`kite`).
 *
 * Mirrors `kite-server/.../routes/tokens.rs::validate_source`.
 */
export function isValidSource(source: string): boolean {
  if (source.length === 0 || source.length > 64) return false;
  if (RESERVED_SOURCES.has(source)) return false;
  const first = source.charAt(0);
  if (!/[a-z0-9]/.test(first)) return false;
  return /^[a-z0-9-]*$/.test(source.slice(1));
}

/** Throw {@link KiteValidationError} if `source` is invalid. */
export function assertValidSource(source: string): void {
  if (!isValidSource(source)) {
    throw new KiteValidationError(
      `invalid source "${source}": must be lowercase alphanumeric and hyphens, ` +
        `start with a letter or digit, be at most 64 characters, and not be "kite"`,
    );
  }
}

/**
 * CloudEvents extension attribute names must be lowercase alphanumeric (no
 * hyphens/underscores/dots) per the CE spec. Used to guard extension keys.
 */
export function isValidExtensionName(name: string): boolean {
  return /^[a-z0-9]+$/.test(name);
}
