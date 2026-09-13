#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageDirectory = path.join(root, "typescript");
const expectedFiles = [
  "package/LICENSE",
  "package/README.md",
  "package/dist/index.cjs",
  "package/dist/index.cjs.map",
  "package/dist/index.d.cts",
  "package/dist/index.d.ts",
  "package/dist/index.js",
  "package/dist/index.js.map",
  "package/package.json",
].sort();

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      ...options.env,
    },
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
  });
}

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "kite-sdk-npm-package-"),
);

try {
  const packOutput = execFileSync(
    "npm",
    ["pack", "--silent", "--pack-destination", temporaryDirectory],
    {
      cwd: packageDirectory,
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
      encoding: "utf8",
    },
  ).trim();
  const filename = packOutput.split(/\r?\n/u).at(-1);
  if (!filename || path.basename(filename) !== filename || !filename.endsWith(".tgz")) {
    throw new Error(`npm pack returned an unexpected filename: ${packOutput}`);
  }

  const tarball = path.join(temporaryDirectory, filename);
  const archiveFiles = execFileSync("tar", ["-tzf", tarball], {
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/u)
    .filter((entry) => entry !== "" && !entry.endsWith("/"))
    .sort();
  assert.deepEqual(
    archiveFiles,
    expectedFiles,
    `unexpected npm package contents:\n${archiveFiles.join("\n")}`,
  );

  const packedManifest = JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(packedManifest.name, "@getkite/sdk");
  assert.equal(packedManifest.main, "./dist/index.cjs");
  assert.equal(packedManifest.module, "./dist/index.js");
  assert.equal(packedManifest.types, "./dist/index.d.ts");
  assert.equal(packedManifest.exports?.["."]?.import?.default, "./dist/index.js");
  assert.equal(packedManifest.exports?.["."]?.require?.default, "./dist/index.cjs");

  const packedLicense = execFileSync("tar", [
    "-xOf",
    tarball,
    "package/LICENSE",
  ]);
  const rootLicense = await readFile(path.join(root, "LICENSE"));
  assert.deepEqual(packedLicense, rootLicense, "packed LICENSE differs from root LICENSE");

  const consumers = [
    {
      name: "esm",
      packageJson: { private: true, type: "module" },
      entry: "index.mjs",
      source: `import assert from "node:assert/strict";
import { Kite, KiteValidationError, DEFAULT_INGEST_URL } from "@getkite/sdk";
assert.equal(DEFAULT_INGEST_URL, "https://api.getkite.sh");
assert.throws(() => new Kite({ teamId: "team", source: "INVALID", token: "token" }), KiteValidationError);
const kite = new Kite({ teamId: "team", source: "my-app", token: "token" });
assert.equal(typeof kite.emit, "function");
console.log("clean ESM consumer: ok");
`,
    },
    {
      name: "cjs",
      packageJson: { private: true, type: "commonjs" },
      entry: "index.cjs",
      source: `const assert = require("node:assert/strict");
const { Kite, KiteValidationError, DEFAULT_INGEST_URL } = require("@getkite/sdk");
assert.equal(DEFAULT_INGEST_URL, "https://api.getkite.sh");
assert.throws(() => new Kite({ teamId: "team", source: "INVALID", token: "token" }), KiteValidationError);
const kite = new Kite({ teamId: "team", source: "my-app", token: "token" });
assert.equal(typeof kite.emit, "function");
console.log("clean CJS consumer: ok");
`,
    },
  ];

  for (const consumer of consumers) {
    const consumerDirectory = path.join(temporaryDirectory, consumer.name);
    await mkdir(consumerDirectory);
    await writeFile(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify(consumer.packageJson, null, 2)}\n`,
    );
    await writeFile(path.join(consumerDirectory, consumer.entry), consumer.source);
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-package-lock",
        tarball,
      ],
      { cwd: consumerDirectory },
    );
    run(process.execPath, [consumer.entry], { cwd: consumerDirectory });
  }

  const artifactDirectory = process.env.KITE_ARTIFACT_DIR;
  if (artifactDirectory) {
    await mkdir(artifactDirectory, { recursive: true });
    await copyFile(tarball, path.join(artifactDirectory, filename));
    console.log(`Copied verified npm artifact to ${path.join(artifactDirectory, filename)}`);
  }

  console.log(`Verified npm package contents (${archiveFiles.length} files):`);
  for (const file of archiveFiles) console.log(`  ${file}`);
  console.log("TypeScript package verification: ok");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
