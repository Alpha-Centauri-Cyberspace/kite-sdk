#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
manifest="$repo_root/rust/Cargo.toml"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/kite-sdk-rust-package.XXXXXX")"
trap 'rm -rf -- "$temporary_directory"' EXIT

metadata="$(cargo metadata --manifest-path "$manifest" --format-version 1 --no-deps)"
read -r crate_name crate_version < <(
  python3 -c 'import json, sys; package=json.load(sys.stdin)["packages"][0]; print(package["name"], package["version"])' <<<"$metadata"
)

package_target="$temporary_directory/package-target"
package_args=(
  package
  --manifest-path "$manifest"
  --target-dir "$package_target"
)
if [[ "${ALLOW_DIRTY:-0}" == "1" ]]; then
  package_args+=(--allow-dirty)
fi
cargo "${package_args[@]}"

archive="$package_target/package/${crate_name}-${crate_version}.crate"
[[ -f "$archive" ]] || {
  printf 'expected crate archive was not created: %s\n' "$archive" >&2
  exit 1
}

prefix="${crate_name}-${crate_version}"
# mapfile requires bash 4+; macOS ships bash 3.2, so fill the array with a loop.
archive_files=()
while IFS= read -r entry; do
  archive_files+=("$entry")
done < <(
  tar -tzf "$archive" | sed '/\/$/d' | LC_ALL=C sort
)
expected_files=(
  "$prefix/.cargo_vcs_info.json"
  "$prefix/Cargo.lock"
  "$prefix/Cargo.toml"
  "$prefix/Cargo.toml.orig"
  "$prefix/LICENSE"
  "$prefix/README.md"
  "$prefix/examples/emit.rs"
  "$prefix/src/client.rs"
  "$prefix/src/emit.rs"
  "$prefix/src/error.rs"
  "$prefix/src/lib.rs"
  "$prefix/src/retry.rs"
  "$prefix/src/types.rs"
  "$prefix/src/validate.rs"
  "$prefix/tests/http.rs"
  "$prefix/tests/integration.rs"
)
# mapfile requires bash 4+; macOS ships bash 3.2, so fill the array with a loop.
expected_files_sorted=()
while IFS= read -r entry; do
  expected_files_sorted+=("$entry")
done < <(printf '%s\n' "${expected_files[@]}" | LC_ALL=C sort)
expected_files=("${expected_files_sorted[@]}")

if [[ "$(printf '%s\n' "${archive_files[@]}")" != "$(printf '%s\n' "${expected_files[@]}")" ]]; then
  printf '%s\n' 'unexpected cargo package contents' >&2
  diff -u \
    <(printf '%s\n' "${expected_files[@]}") \
    <(printf '%s\n' "${archive_files[@]}") >&2 || true
  exit 1
fi

packed_license="$temporary_directory/LICENSE"
tar -xOf "$archive" "$prefix/LICENSE" >"$packed_license"
cmp "$repo_root/LICENSE" "$packed_license"

tar -xzf "$archive" -C "$temporary_directory"
packaged_crate="$temporary_directory/$prefix"
consumer="$temporary_directory/consumer"
mkdir -p "$consumer/src"
cat >"$consumer/Cargo.toml" <<EOF
[package]
name = "kite-sdk-package-consumer"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
kite-sdk = { path = "$packaged_crate", version = "=$crate_version" }
EOF
cat >"$consumer/src/lib.rs" <<'EOF'
#[test]
fn packaged_crate_is_consumable() {
    use kite_sdk::{DEFAULT_INGEST_URL, Kite};

    assert_eq!(DEFAULT_INGEST_URL, "https://api.getkite.sh");
    let kite = Kite::builder()
        .team_id("team")
        .source("my-app")
        .token("token")
        .build()
        .expect("valid client configuration");
    let _request = kite.emit("com.example.package-test", ());
}
EOF
cargo test \
  --manifest-path "$consumer/Cargo.toml" \
  --target-dir "$temporary_directory/consumer-target"

if [[ -n "${KITE_ARTIFACT_DIR:-}" ]]; then
  mkdir -p "$KITE_ARTIFACT_DIR"
  cp "$archive" "$KITE_ARTIFACT_DIR/"
  printf 'Copied verified crate artifact to %s/%s\n' \
    "$KITE_ARTIFACT_DIR" "$(basename -- "$archive")"
fi

printf 'Verified cargo package contents (%d files):\n' "${#archive_files[@]}"
printf '  %s\n' "${archive_files[@]}"
printf 'clean Rust package consumer: ok\n'
printf 'Rust package verification: ok\n'
