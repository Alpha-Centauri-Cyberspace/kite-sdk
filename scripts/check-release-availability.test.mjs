import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repository = "https://github.com/Alpha-Centauri-Cyberspace/kite-sdk";
const script = readFileSync(new URL("./check-release-availability.mjs", import.meta.url), "utf8");

function preflight(cratesResponse, source = script) {
  const root = mkdtempSync(path.join(tmpdir(), "kite-sdk-registry-contract-"));
  try {
    for (const dir of ["scripts", "typescript", "rust"]) mkdirSync(path.join(root, dir));
    writeFileSync(path.join(root, "scripts/check.mjs"), source);
    writeFileSync(path.join(root, "typescript/package.json"), JSON.stringify({ name: "@getkite/sdk", version: "0.1.0" }));
    writeFileSync(path.join(root, "rust/Cargo.toml"), '[package]\nname = "kite-sdk"\nversion = "0.1.0"\n');
    // Synthetic HTTP boundary: exercise the real executable with no registry writes or network.
    writeFileSync(path.join(root, "fetch-fixture.mjs"), `
      globalThis.fetch = async (url) => {
        if (url.startsWith("https://registry.npmjs.org/")) return new Response("{}", { status: 404 });
        if (url.startsWith("https://crates.io/api/v1/crates/")) return new Response(JSON.stringify(${JSON.stringify(cratesResponse)}), { status: 200 });
        throw new Error("Unexpected registry request");
      };
    `);
    return spawnSync(process.execPath, ["--import", path.join(root, "fetch-fixture.mjs"), path.join(root, "scripts/check.mjs"), "--target=npm"], { encoding: "utf8", timeout: 10_000 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("npm preflight permits an already-published owned crates.io version", () => {
  const result = preflight({ version: { repository, num: "0.1.0" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm=unpublished, crates.io=published/);
});

test("crates.io version identity fails closed for another repository", () => {
  const result = preflight({ version: { repository: "https://github.com/example/other" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not identify/);
});

test("crate-level metadata cannot substitute for version identity", () => {
  const result = preflight({ crate: { repository } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not identify/);
});

test("regression fixture detects the former crate-key lookup", () => {
  const previousLookup = script.replace("crates.body.version?.repository", "crates.body.crate?.repository");
  assert.notEqual(previousLookup, script, "mutation must change the executable lookup");
  const result = preflight({ version: { repository, num: "0.1.0" } }, previousLookup);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not identify/);
});
