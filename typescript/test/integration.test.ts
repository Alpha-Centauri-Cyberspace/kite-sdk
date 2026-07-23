import { describe, it, expect } from "vitest";
import { Kite } from "../src/index.js";

/**
 * Live integration test against a real Kite ingest endpoint.
 *
 * Skipped unless all of the following env vars are set:
 *   KITE_E2E_TOKEN, KITE_E2E_TEAM_ID, KITE_E2E_SOURCE
 * KITE_E2E_URL is optional (defaults to https://api.getkite.sh).
 *
 * Provision the endpoint first: `kite endpoints create --source <source>`.
 */
const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process
    ?.env ?? {};

const token = env.KITE_E2E_TOKEN;
const teamId = env.KITE_E2E_TEAM_ID;
const source = env.KITE_E2E_SOURCE;
const ingestUrl = env.KITE_E2E_URL;

const ready = Boolean(token && teamId && source);

describe.skipIf(!ready)("integration: live emit", () => {
  it("emits a CloudEvent and receives an id", async () => {
    const kite = new Kite({
      teamId: teamId!,
      source: source!,
      token: token!,
      ...(ingestUrl ? { ingestUrl } : {}),
    });

    const result = await kite.emit(
      "com.kite.sdk.e2e",
      { at: new Date().toISOString(), runner: "vitest" },
      { summary: "SDK e2e emit" },
    );

    expect(result.id).toBeTruthy();
    expect(["accepted", "duplicate_ignored"]).toContain(result.status);
  });
});
