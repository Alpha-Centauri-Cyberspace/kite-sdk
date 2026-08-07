#!/usr/bin/env bash
set -euo pipefail

target="${1:-both}"
version="${2:-$(node -p "require('./typescript/package.json').version")}"

case "$target" in
  npm|crates|both) ;;
  *)
    printf 'usage: %s [npm|crates|both] [version]\n' "$0" >&2
    exit 2
    ;;
esac

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || {
  printf 'invalid version: %s\n' "$version" >&2
  exit 2
}

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/kite-sdk-registry-consumer.XXXXXX")"
trap 'rm -rf -- "$temporary_directory"' EXIT

retry() {
  local attempts=12
  local delay_seconds=10
  local attempt=1

  until "$@"; do
    if (( attempt >= attempts )); then
      printf 'command failed after %d attempts: ' "$attempts" >&2
      printf '%q ' "$@" >&2
      printf '\n' >&2
      return 1
    fi
    printf 'registry artifact not ready (attempt %d/%d); retrying in %ds\n' \
      "$attempt" "$attempts" "$delay_seconds" >&2
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
  done
}

verify_npm() {
  local consumer="$temporary_directory/npm"
  mkdir -p "$consumer"
  printf '{"private":true,"type":"module"}\n' > "$consumer/package.json"

  retry npm view "@getkite/sdk@$version" version --registry=https://registry.npmjs.org/
  retry npm install \
    --prefix "$consumer" \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --no-package-lock \
    --registry=https://registry.npmjs.org/ \
    "@getkite/sdk@$version"

  (
    cd "$consumer"
    node --input-type=module -e '
      import assert from "node:assert/strict";
      import { Kite, DEFAULT_INGEST_URL } from "@getkite/sdk";
      assert.equal(DEFAULT_INGEST_URL, "https://api.getkite.sh");
      assert.equal(typeof new Kite({ teamId: "team", source: "consumer", token: "token" }).emit, "function");
    '
    node -e '
      const assert = require("node:assert/strict");
      const { Kite, DEFAULT_INGEST_URL } = require("@getkite/sdk");
      assert.equal(DEFAULT_INGEST_URL, "https://api.getkite.sh");
      assert.equal(typeof new Kite({ teamId: "team", source: "consumer", token: "token" }).emit, "function");
    '
  )
  printf 'clean npm registry consumer: ok (@getkite/sdk@%s)\n' "$version"
}

verify_crates() {
  local consumer="$temporary_directory/crates"
  mkdir -p "$consumer/src"
  cat > "$consumer/Cargo.toml" <<EOF
[package]
name = "kite-sdk-registry-consumer"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
kite-sdk = "=$version"
EOF
  cat > "$consumer/src/main.rs" <<'EOF'
use kite_sdk::{Kite, DEFAULT_INGEST_URL};

fn main() {
    assert_eq!(DEFAULT_INGEST_URL, "https://api.getkite.sh");
    let client = Kite::builder()
        .team_id("team")
        .source("consumer")
        .token("token")
        .build()
        .expect("valid client configuration");
    let _request = client.emit("com.example.consumer", ());
}
EOF

  retry cargo check --manifest-path "$consumer/Cargo.toml"
  printf 'clean crates.io registry consumer: ok (kite-sdk@%s)\n' "$version"
}

case "$target" in
  npm) verify_npm ;;
  crates) verify_crates ;;
  both)
    verify_npm
    verify_crates
    ;;
esac
