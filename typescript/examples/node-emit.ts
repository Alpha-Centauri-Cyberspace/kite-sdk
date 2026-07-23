/**
 * Minimal runnable example: emit an event into Kite.
 *
 * Prereqs:
 *   1. Create an endpoint + token:  kite endpoints create --source my-app
 *   2. Export the env vars below.
 *
 * Run with:
 *   KITE_TEAM_ID=... KITE_SOURCE=my-app KITE_HOOK_TOKEN=... \
 *     npx tsx examples/node-emit.ts
 */
import { Kite, KiteError } from "../src/index.js";

// `process` is provided by Node at runtime; declared locally so the example
// stays free of a hard @types/node dependency.
declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};

const { KITE_TEAM_ID, KITE_SOURCE, KITE_HOOK_TOKEN, KITE_INGEST_URL } = process.env;

if (!KITE_TEAM_ID || !KITE_SOURCE || !KITE_HOOK_TOKEN) {
  console.error(
    "Set KITE_TEAM_ID, KITE_SOURCE, and KITE_HOOK_TOKEN before running this example.",
  );
  process.exit(1);
}

const kite = new Kite({
  teamId: KITE_TEAM_ID,
  source: KITE_SOURCE,
  token: KITE_HOOK_TOKEN,
  ...(KITE_INGEST_URL ? { ingestUrl: KITE_INGEST_URL } : {}),
});

try {
  const result = await kite.emit(
    "com.myapp.user.signup",
    { userId: "u_123", plan: "pro" },
    { summary: "User u_123 signed up (pro)" },
  );
  console.log("emitted:", result);
} catch (err) {
  if (err instanceof KiteError) {
    console.error(`Kite error [${err.name}] status=${err.status}: ${err.message}`);
  } else {
    console.error("unexpected error:", err);
  }
  process.exit(1);
}
