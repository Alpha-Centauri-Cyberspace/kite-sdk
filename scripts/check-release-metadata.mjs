#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const expectedNpmName = "@getkite/sdk";
const expectedCrateName = "kite-sdk";
const expectedRepository =
  "https://github.com/Alpha-Centauri-Cyberspace/kite-sdk";

function fail(message) {
  throw new Error(message);
}

function parsePackageSection(toml) {
  const values = new Map();
  let inPackage = false;

  for (const rawLine of toml.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      if (inPackage) break;
      inPackage = line === "[package]";
      continue;
    }
    if (!inPackage || line === "" || line.startsWith("#")) continue;

    const match = /^([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/u.exec(
      line,
    );
    if (match) values.set(match[1], JSON.parse(match[2]));
  }

  return values;
}

function normalizeRepository(value) {
  const url = typeof value === "string" ? value : value?.url;
  return url?.replace(/^git\+/u, "").replace(/\.git$/u, "");
}

function parseTagArgument(argv) {
  let tag;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tag") {
      tag = argv[index + 1];
      if (!tag) fail("--tag requires a value");
      index += 1;
    } else if (argument.startsWith("--tag=")) {
      tag = argument.slice("--tag=".length);
      if (!tag) fail("--tag requires a value");
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  return tag;
}

const [npmText, lockText, cargoText, rootLicense, npmLicense, rustLicense] =
  await Promise.all([
    readFile(path.join(root, "typescript/package.json"), "utf8"),
    readFile(path.join(root, "typescript/package-lock.json"), "utf8"),
    readFile(path.join(root, "rust/Cargo.toml"), "utf8"),
    readFile(path.join(root, "LICENSE")),
    readFile(path.join(root, "typescript/LICENSE")),
    readFile(path.join(root, "rust/LICENSE")),
  ]);

const npmPackage = JSON.parse(npmText);
const lockfile = JSON.parse(lockText);
const cargoPackage = parsePackageSection(cargoText);
const cargoName = cargoPackage.get("name");
const cargoVersion = cargoPackage.get("version");
const cargoRepository = cargoPackage.get("repository");
const cargoHomepage = cargoPackage.get("homepage");
const cargoLicense = cargoPackage.get("license");
const lockRoot = lockfile.packages?.[""];

if (npmPackage.name !== expectedNpmName) {
  fail(`typescript/package.json name must be ${expectedNpmName}`);
}
if (cargoName !== expectedCrateName) {
  fail(`rust/Cargo.toml package name must be ${expectedCrateName}`);
}

const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
if (!semver.test(npmPackage.version)) {
  fail(`TypeScript version is not valid SemVer: ${npmPackage.version}`);
}
if (cargoVersion !== npmPackage.version) {
  fail(
    `version mismatch: TypeScript=${npmPackage.version}, Rust=${cargoVersion}`,
  );
}
if (lockRoot?.name !== npmPackage.name || lockRoot?.version !== npmPackage.version) {
  fail("typescript/package-lock.json root name/version do not match package.json");
}
if (npmPackage.license !== "MIT" || cargoLicense !== "MIT") {
  fail("both packages must declare the MIT license");
}
if (!rootLicense.equals(npmLicense) || !rootLicense.equals(rustLicense)) {
  fail("typescript/LICENSE and rust/LICENSE must be byte-identical to LICENSE");
}
if (
  normalizeRepository(npmPackage.repository) !== expectedRepository ||
  normalizeRepository(cargoRepository) !== expectedRepository
) {
  fail(`both package manifests must reference ${expectedRepository}`);
}
if (npmPackage.homepage !== cargoHomepage) {
  fail("TypeScript and Rust homepage metadata must match");
}

const tag = parseTagArgument(process.argv.slice(2));
if (tag !== undefined && tag !== `v${npmPackage.version}`) {
  fail(`release tag must be v${npmPackage.version}; received ${tag}`);
}

console.log(
  `Release metadata verified: ${npmPackage.name}@${npmPackage.version}; ${cargoName}@${cargoVersion}`,
);
if (tag !== undefined) console.log(`Release tag verified: ${tag}`);
