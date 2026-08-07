#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const expectedRepository =
  "https://github.com/Alpha-Centauri-Cyberspace/kite-sdk";
const targetArgument = process.argv.find((argument) =>
  argument.startsWith("--target="),
);
const target = targetArgument?.slice("--target=".length) ?? "both";
if (!new Set(["both", "npm", "crates"]).has(target)) {
  throw new Error("--target must be one of: both, npm, crates");
}
if (process.argv.length > (targetArgument ? 3 : 2)) {
  throw new Error("usage: check-release-availability.mjs [--target=both|npm|crates]");
}

const npmPackage = JSON.parse(
  await readFile(path.join(root, "typescript/package.json"), "utf8"),
);
const cargoText = await readFile(path.join(root, "rust/Cargo.toml"), "utf8");
const cargoName = /^name\s*=\s*"([^"]+)"\s*$/mu.exec(cargoText)?.[1];
const version = npmPackage.version;
if (!cargoName || !version) throw new Error("package metadata is incomplete");

const npmUrl = `https://registry.npmjs.org/${npmPackage.name.replace("/", "%2f")}/${version}`;
const cratesUrl = `https://crates.io/api/v1/crates/${encodeURIComponent(cargoName)}/${encodeURIComponent(version)}`;

async function registryState(registry, url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "kite-sdk-release-preflight/1.0",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 404) return { present: false };
  if (!response.ok) {
    throw new Error(`${registry} registry check returned HTTP ${response.status}`);
  }
  return { present: true, body: await response.json() };
}

function normalizeRepository(value) {
  const url = typeof value === "string" ? value : value?.url;
  return url?.replace(/^git\+/u, "").replace(/\.git$/u, "");
}

const [npm, crates] = await Promise.all([
  registryState("npm", npmUrl),
  registryState("crates.io", cratesUrl),
]);

if (npm.present) {
  const repository = normalizeRepository(npm.body.repository);
  if (repository !== expectedRepository) {
    throw new Error(
      `${npmPackage.name}@${version} exists on npm but does not identify ${expectedRepository}`,
    );
  }
}
if (crates.present) {
  const repository = normalizeRepository(crates.body.crate?.repository);
  if (repository !== expectedRepository) {
    throw new Error(
      `${cargoName}@${version} exists on crates.io but does not identify ${expectedRepository}`,
    );
  }
}

const actual = { npm: npm.present, crates: crates.present };
const requestedRegistries =
  target === "both" ? ["npm", "crates"] : [target];
const alreadyPublished = requestedRegistries.filter(
  (registry) => actual[registry],
);
if (alreadyPublished.length > 0) {
  throw new Error(
    `refusing to overwrite ${version}: already published on ${alreadyPublished.join(", ")}`,
  );
}

console.log(
  `Registry preflight verified for target=${target}: npm=${npm.present ? "published" : "unpublished"}, crates.io=${crates.present ? "published" : "unpublished"}`,
);
