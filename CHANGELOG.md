# Changelog

All notable changes to the Kite TypeScript and Rust SDKs are documented here.
Both packages use the same version and follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Release metadata validation for package names, versions, repository identity,
  and byte-identical license files.
- Packed-artifact inventory checks and clean local ESM, CommonJS, and Rust
  consumer tests.
- Approval-gated npm and crates.io trusted-publishing workflow with post-publish
  public-registry consumer verification.
- Release, rollback, ownership, and security guidance.

### Changed

- npm and crate artifacts now include the repository's MIT license.

## [0.1.0] - Unreleased

Initial TypeScript and Rust SDK implementations. This heading does not establish
that either package is available from a public registry.

[Unreleased]: https://github.com/Alpha-Centauri-Cyberspace/kite-sdk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Alpha-Centauri-Cyberspace/kite-sdk/releases/tag/v0.1.0
