# Changelog

## [Unreleased]

### Added

- Added per-caller bridge authority: the token file now accepts a grant map of tokens to `{principal, role, sessions}` records, resolved server-side on every request so rotated grants apply without a restart.
- Added session-scoped gates: MCP session requests, peer discovery, mesh message sending (`originSessionId`), inbox reads/claims, and waits are each restricted to the caller's granted sessions; `/v1/peers` POST and `/v1/audit` require a supervisor role.
- Added bridge authority proofs as regression tests: session-allowlisted discovery, administrative refusal of unprivileged callers, fail-closed unknown credentials, and non-self-assertable authority (forged headers or path encodings cannot escalate).

### Changed

- Changed bare-token files to authenticate as one full-authority supervisor, preserving legacy deployments; malformed grant files now authenticate nobody.

## [18.0.2] - 2026-08-23

### Added

- Added hermetic end-to-end control-mesh coverage for OMP and Prime message delivery, durable restart recovery, deduplication, and event cursor continuity.
- Documented bridge setup, OMP settings, token handling, recovery, and launch-broker supervision limits.
