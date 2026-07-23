import { describe, it, expect, afterEach, vi } from "vitest";
import { generateId } from "../src/id.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateId", () => {
  it("uses crypto.randomUUID when available", () => {
    const randomUUID = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    vi.stubGlobal("crypto", { randomUUID });

    const id = generateId();
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("falls back to getRandomValues (Node 18 without randomUUID)", () => {
    const getRandomValues = vi.fn((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = i;
      return arr;
    });
    // No randomUUID on this crypto object.
    vi.stubGlobal("crypto", { getRandomValues });

    const id = generateId();
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(id).toMatch(UUID_RE);
  });

  it("falls back to Math.random when no WebCrypto exists", () => {
    vi.stubGlobal("crypto", undefined);

    const id = generateId();
    expect(id).toMatch(UUID_RE);
  });

  it("produces distinct ids across calls in the Math.random path", () => {
    vi.stubGlobal("crypto", undefined);
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
  });
});
