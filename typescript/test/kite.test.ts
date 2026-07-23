import { describe, it, expect, vi } from "vitest";
import {
  Kite,
  KiteAuthError,
  KitePayloadTooLargeError,
  KiteRateLimitError,
  KiteServerError,
  KiteValidationError,
  MAX_BODY_SIZE,
  isValidSource,
} from "../src/index.js";

/** Build a Response-like object for the mock fetch. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ACCEPTED_BODY = {
  id: "01890000-0000-7000-8000-000000000000",
  created_at: "2026-07-22T00:00:00Z",
  usage: {
    events_used: 5,
    events_limit: 1000,
    amount_charged_atomic: 0,
  },
};

function newKite(overrides: Partial<ConstructorParameters<typeof Kite>[0]> = {}) {
  const fetchMock = vi.fn();
  const kite = new Kite({
    teamId: "team-123",
    source: "my-app",
    token: "kite_abc_secret",
    fetch: fetchMock as unknown as typeof fetch,
    ...overrides,
  });
  return { kite, fetchMock };
}

describe("emit — happy path", () => {
  it("sends a structured CloudEvent with the exact body and headers", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, ACCEPTED_BODY));

    const result = await kite.emit(
      "com.myapp.user.signup",
      { userId: "u_123" },
      {
        summary: "User u_123 signed up",
        subject: "u_123",
        id: "fixed-id",
        time: "2026-07-22T12:00:00.000Z",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.getkite.sh/hooks/team-123/my-app");
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer kite_abc_secret");
    expect(init.headers["content-type"]).toBe(
      "application/cloudevents+json; charset=utf-8",
    );

    const sent = JSON.parse(init.body);
    expect(sent).toEqual({
      specversion: "1.0",
      id: "fixed-id",
      source: "https://my-app",
      type: "com.myapp.user.signup",
      time: "2026-07-22T12:00:00.000Z",
      datacontenttype: "application/json",
      data: { userId: "u_123" },
      subject: "u_123",
      kitesummary: "User u_123 signed up",
    });

    expect(result).toEqual({
      id: ACCEPTED_BODY.id,
      status: "accepted",
      createdAt: "2026-07-22T00:00:00Z",
      usage: { eventsUsed: 5, eventsLimit: 1000, amountChargedAtomic: 0 },
    });
  });

  it("defaults id, time, and source when not provided", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, ACCEPTED_BODY));

    await kite.emit("com.myapp.thing", { a: 1 });

    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sent.source).toBe("https://my-app");
    expect(typeof sent.id).toBe("string");
    expect(sent.id.length).toBeGreaterThan(0);
    expect(typeof sent.time).toBe("string");
    expect(sent.kitesummary).toBeUndefined();
  });

  it("honors sourceUri override and Date time", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, ACCEPTED_BODY));

    await kite.emit("com.myapp.thing", null, {
      sourceUri: "https://example.com/svc",
      time: new Date("2026-01-01T00:00:00.000Z"),
    });

    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sent.source).toBe("https://example.com/svc");
    expect(sent.time).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("emitRaw", () => {
  it("sends plain JSON with application/json content-type", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, ACCEPTED_BODY));

    await kite.emitRaw({ hello: "world" });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ hello: "world" });
  });
});

describe("emitEvent", () => {
  it("preserves a fully-specified event and fills specversion/id", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, ACCEPTED_BODY));

    await kite.emitEvent({
      specversion: "1.0",
      id: "evt-1",
      source: "https://custom",
      type: "com.custom.type",
      data: { x: 1 },
      mycustomext: "keep-me",
    });

    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sent.id).toBe("evt-1");
    expect(sent.source).toBe("https://custom");
    expect(sent.mycustomext).toBe("keep-me");
  });

  it("accepts string, number, and boolean extension values", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, ACCEPTED_BODY));

    await kite.emitEvent({
      specversion: "1.0",
      id: "evt-2",
      source: "https://custom",
      type: "com.custom.type",
      strext: "s",
      numext: 42,
      boolext: true,
    });

    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sent.strext).toBe("s");
    expect(sent.numext).toBe(42);
    expect(sent.boolext).toBe(true);
  });

  it("rejects an invalid extension name before sending", async () => {
    const { kite, fetchMock } = newKite();

    await expect(
      kite.emitEvent({
        specversion: "1.0",
        id: "evt-3",
        source: "https://custom",
        type: "com.custom.type",
        "bad-name": "x",
      }),
    ).rejects.toBeInstanceOf(KiteValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-string/number/boolean extension value before sending", async () => {
    const { kite, fetchMock } = newKite();

    await expect(
      kite.emitEvent({
        specversion: "1.0",
        id: "evt-4",
        source: "https://custom",
        type: "com.custom.type",
        objext: { nested: true },
      }),
    ).rejects.toBeInstanceOf(KiteValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores undefined extension values", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, ACCEPTED_BODY));

    await kite.emitEvent({
      specversion: "1.0",
      id: "evt-5",
      source: "https://custom",
      type: "com.custom.type",
      maybe: undefined,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("retry behavior", () => {
  it("retries on 429 and respects retry_after_secs", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(429, { error: "rate limit exceeded", retry_after_secs: 0 }),
      )
      .mockResolvedValueOnce(jsonResponse(202, ACCEPTED_BODY));

    const result = await kite.emit("com.myapp.thing", { a: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("accepted");
  });

  it("retries on 503 then succeeds", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, { error: "unavailable" }))
      .mockResolvedValueOnce(jsonResponse(202, ACCEPTED_BODY));

    const result = await kite.emitRaw({ a: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("accepted");
  });

  it("retries on network error then succeeds", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(202, ACCEPTED_BODY));

    const result = await kite.emitRaw({ a: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("accepted");
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const { kite, fetchMock } = newKite({ maxRetries: 2 });
    fetchMock.mockResolvedValue(
      jsonResponse(429, { error: "rate limit exceeded", retry_after_secs: 0 }),
    );

    await expect(kite.emit("com.myapp.thing", {})).rejects.toBeInstanceOf(
      KiteRateLimitError,
    );
    // initial + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("no retry on non-retryable status", () => {
  it("does not retry on 401 and throws KiteAuthError", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "invalid hook token" }));

    const err = await kite.emit("com.myapp.thing", {}).catch((e) => e);
    expect(err).toBeInstanceOf(KiteAuthError);
    expect(err.status).toBe(401);
    expect(err.serverError).toBe("invalid hook token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 413 to KitePayloadTooLargeError with maxBytes", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(413, { error: "payload too large", max_bytes: MAX_BODY_SIZE }),
    );

    const err = await kite.emitRaw({ a: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(KitePayloadTooLargeError);
    expect(err.maxBytes).toBe(MAX_BODY_SIZE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 5xx to KiteServerError (non-retryable 500)", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));

    const err = await kite.emitRaw({ a: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(KiteServerError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("payload-too-large pre-check", () => {
  it("throws before sending when the serialized body exceeds 256KB", async () => {
    const { kite, fetchMock } = newKite();
    const big = { blob: "x".repeat(MAX_BODY_SIZE + 100) };

    await expect(kite.emitRaw(big)).rejects.toBeInstanceOf(KitePayloadTooLargeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("source validation", () => {
  it("accepts valid sources", () => {
    expect(isValidSource("my-app")).toBe(true);
    expect(isValidSource("github")).toBe(true);
    expect(isValidSource("0abc-9")).toBe(true);
  });

  it("rejects invalid or reserved sources", () => {
    expect(isValidSource("kite")).toBe(false);
    expect(isValidSource("My-App")).toBe(false);
    expect(isValidSource("-leading")).toBe(false);
    expect(isValidSource("under_score")).toBe(false);
    expect(isValidSource("")).toBe(false);
    expect(isValidSource("a".repeat(65))).toBe(false);
  });

  it("throws KiteValidationError from the constructor on a bad source", () => {
    expect(() => newKite({ source: "Bad Source" })).toThrow(KiteValidationError);
    expect(() => newKite({ source: "kite" })).toThrow(KiteValidationError);
  });

  it("throws KiteValidationError when required config is missing", () => {
    expect(() => new Kite({ teamId: "", source: "x", token: "t" })).toThrow(
      KiteValidationError,
    );
  });
});

describe("path auth mode", () => {
  it("puts the token in the URL and omits the Authorization header", async () => {
    const { kite, fetchMock } = newKite({ authMode: "path" });
    fetchMock.mockResolvedValueOnce(jsonResponse(202, ACCEPTED_BODY));

    await kite.emit("com.myapp.thing", { a: 1 });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.getkite.sh/hooks/team-123/my-app/kite_abc_secret");
    expect(init.headers["authorization"]).toBeUndefined();
  });
});

describe("duplicate response", () => {
  it("maps a 200 duplicate_ignored body to status duplicate_ignored", async () => {
    const { kite, fetchMock } = newKite();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { status: "duplicate_ignored", id: "dup-1" }),
    );

    const result = await kite.emit("com.myapp.thing", {});
    expect(result).toEqual({
      id: "dup-1",
      status: "duplicate_ignored",
      createdAt: undefined,
      usage: undefined,
    });
  });
});

describe("custom ingestUrl", () => {
  it("strips trailing slashes from the base URL", async () => {
    const { kite, fetchMock } = newKite({ ingestUrl: "http://localhost:8080/" });
    fetchMock.mockResolvedValueOnce(jsonResponse(202, ACCEPTED_BODY));

    await kite.emitRaw({ a: 1 });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://localhost:8080/hooks/team-123/my-app",
    );
  });
});
