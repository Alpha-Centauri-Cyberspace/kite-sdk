# Releasing Kite SDKs

This repository releases two independent public packages at one shared version:

- npm: `@getkite/sdk`
- crates.io: `kite-sdk`

Source validation, local package creation, registry publication, and installation
from a clean public-registry consumer are separate release gates. A passing source
build does not mean a package is published.

## One-time registry and repository setup

Complete these steps before creating a release tag:

1. Verify that the `getkite` npm scope and `kite-sdk` crates.io name are controlled
   by the intended Kite maintainers. Check registry ownership and repository links;
   a matching name alone is not proof of identity.
2. Create a GitHub environment named `release`. Require a human reviewer, prevent
   administrators from bypassing approval, and limit deployments to protected
   `v*` tags.
3. Protect `main` and `v*` tags with repository rules. Require this repository's CI,
   pull-request review, and no force pushes or deletions.
4. Enable private vulnerability reporting and keep `.github/CODEOWNERS` current.
5. Configure registry trusted publishers only after each package exists:
   - npm organization/repository: `Alpha-Centauri-Cyberspace/kite-sdk`
   - npm workflow filename: `release.yml`
   - npm environment: `release`
   - npm allowed action: `npm publish`
   - crates.io repository: `Alpha-Centauri-Cyberspace/kite-sdk`
   - crates.io workflow filename: `release.yml`
   - crates.io environment: `release`
6. Once trusted publishing succeeds, configure npm to require 2FA and disallow
   token publishing. Remove any bootstrap credentials from GitHub and local npm or
   Cargo configuration.

Both registries require the package to exist before trusted publishing can be
configured. The first publication is therefore a bootstrap operation. An owner
must publish from a clean checkout of the reviewed, merged, tagged commit using
interactive 2FA or a narrowly scoped, short-lived registry credential. Never put
that credential in this repository, logs, command arguments, or a feature-branch
workflow. Delete/revoke it immediately after the first release and configure OIDC
before any later release.

## Prepare a release pull request

1. Update both package versions to the same SemVer value:
   - `typescript/package.json`
   - `typescript/package-lock.json`
   - `rust/Cargo.toml`
2. Move the release notes from `CHANGELOG.md`'s `Unreleased` section into a dated
   version heading.
3. Run the complete local release validation:

   ```bash
   node scripts/check-release-metadata.mjs
   cd typescript
   npm ci
   npm run check
   npm run verify:package
   cd ../rust
   cargo fmt --check
   cargo clippy --all-targets --all-features -- -D warnings
   cargo test
   cd ..
   bash scripts/verify-rust-package.sh
   ```

4. Open a pull request. Require CI and an owner review. Do not publish from the
   pull-request branch.

## Tag and publish

After the release pull request is merged and the protected `release` environment
and registry ownership have been verified:

1. Create an annotated `vX.Y.Z` tag on the merged commit and push the tag. Do not
   move or reuse release tags.
2. In GitHub Actions, dispatch **Publish SDK** from that tag. Select one registry
   per approved run. The workflow fails if the tag is not reachable from `main`,
   metadata differs from the tag, or that exact registry version already exists.
3. Approve the protected `release` environment only after reviewing the run's
   commit, target registry, package inventory, and preflight output.
4. Publish the second registry in a separate approved dispatch from the same tag.
5. Confirm each job's clean public-registry consumer check succeeds. Independently
   inspect registry metadata, repository links, owners, package files, and npm
   provenance before updating documentation from `Unpublished` to `Published`.
6. Create GitHub release notes for the immutable tag and link both registry pages.

## Failed or partial release

Registry versions are immutable. Never overwrite a version or move its tag.

- If publication fails before registry acceptance, fix the workflow through a PR
  and rerun the same target after confirming the version is still absent.
- If one registry succeeds and the other fails, leave the successful artifact in
  place and rerun only the missing target from the same tag.
- For a defective npm release, publish a fixed patch and deprecate the affected
  version with a concise migration message.
- For a defective crates.io release, yank the affected version and publish a fixed
  patch. Yanking is not deletion; existing lockfiles may continue to resolve it.
- Document the incident and corrective release in `CHANGELOG.md`.
