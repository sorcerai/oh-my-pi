# Changelog

## [Unreleased]

- Added hermetic end-to-end control-mesh coverage for OMP and Prime message delivery, durable restart recovery, deduplication, and event cursor continuity.
- Documented bridge setup, OMP settings, token handling, recovery, and launch-broker supervision limits.
- Added deterministic offline session-resume integration proof for every Prime v3 and OMP session-v3 fixture branch tip, including tool continuity, CAS byte read-back, loss-ledger preservation, OMP SessionManager continuation, and explicit Prime runtime-gate reporting.
- Added an authenticated, session-scoped MCP bridge that lets Prime discover and call explicitly allowlisted tools from live OMP sessions.
