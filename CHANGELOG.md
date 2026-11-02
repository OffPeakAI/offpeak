# Changelog

Plain-language notes on what changed. Offpeak is pre-launch, so nothing here is on mainnet and there are no releases yet. Each release will get its own section once one exists.

## Unreleased

### Added

- Deploy steps in the README, from a fresh clone, linking the mainnet and host runbooks.
- `SECURITY.md`: how to report a vulnerability, what is in scope, and the known risks from the internal reviews.
- Continuous integration: a frozen install, contract build and tests, the claims lint, and the TypeScript tests with Redis. A second workflow scans all history with gitleaks, and runs Slither on the contracts and Semgrep on TypeScript. Every action is pinned to a full commit hash.
- `docs/architecture.md`: the components, who holds each privileged function, trust assumptions and external dependencies.
- `docs/invariants.md`: every Solidity invariant in plain language, linked to its test.
- `docs/audit-scope.md`: the paths in and out of scope for an audit.
- `docs/runbooks/pause.md`: when and how the guardian pauses, with placeholders for contacts.
- Alerts for a large fall in the protocol reserve and for the keeper key running short of gas.

### Changed

- The root `package.json` now names the Bun version in `packageManager` and `engines`.
- `foundry.toml` now states `bytecode_hash` and `cbor_metadata`, at their existing defaults. The bytecode is unchanged.
- `viem` is pinned exactly in every package outside the frontend.

### Fixed

- `docs/launch/gate-p1.md` said the auditor files nothing. The code can file, and swap filings wait for calibration on real GPUs.
