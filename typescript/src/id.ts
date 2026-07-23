/**
 * Generate a UUID for CloudEvent ids with zero dependencies and no Node-only APIs.
 *
 * Resolution order:
 *  1. `crypto.randomUUID()` — Node 19+, Deno, Bun, modern browsers, edge runtimes.
 *  2. A v4 UUID assembled from `crypto.getRandomValues()` — covers stock Node 18,
 *     where the global WebCrypto is present but `randomUUID` may be unavailable.
 *  3. A `Math.random()`-based v4 UUID — last resort when no WebCrypto exists at
 *     all. Non-cryptographic, but adequate for event identifiers.
 *
 * Exported for direct unit testing of the fallbacks; not part of the public API
 * surface documented in the README.
 */
export function generateId(): string {
  const webcrypto = (globalThis as { crypto?: Crypto }).crypto;

  if (webcrypto && typeof webcrypto.randomUUID === "function") {
    return webcrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (webcrypto && typeof webcrypto.getRandomValues === "function") {
    webcrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // Set the RFC 4122 version (4) and variant (10xx) bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}
