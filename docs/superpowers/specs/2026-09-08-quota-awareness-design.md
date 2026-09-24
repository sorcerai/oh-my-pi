# Quota-Aware OMP Delegation Design

## Approval and scope

The operator approved the optional quota-axi adapter and agent tool on 2026-09-08, then added: “I want the agent to be aware of the quota too. Especially when fanning out subagents.” This document incorporates that requirement. Beads planning record: `prime-model-spec-t8d`.

Deliver quota evidence before the agent chooses workers, not merely after a task batch has started. Preserve OMP's native credential selection, model catalog, retry, reserve, and task execution policies. This is an advisory integration, not an automatic router or quota admission controller.

## Release-blocking upstream prerequisite

Inspected upstream baseline: quota-axi `0.1.41`, commit `a19268827220e12e173067d11703e6ee36d5d88f`, tag `quota-axi-v0.1.41`.

This release is NOT approved for unattended integration:

- `src/commands.ts` passes `refreshCredentials: false` for `--no-credential-refresh`, but both Codex adapter entry points discard `ProviderOptions`; `fetchQuotaWithDependencies` can still call `probeCodexCli`. The resulting `codex -s read-only -a untrusted app-server` process can renew credentials.
- Claude and Cursor may read Keychain entries when an existing access marker is present, even without `--allow-keychain-prompt`. The no-refresh flag is not a no-Keychain guarantee.
- Alibaba delegates collection to `bl usage token-plan --output json`. A no-vendor-process guarantee must address this path too, rather than assuming a usage command never refreshes authentication.

A source-reviewed upstream release or independently verified wrapper MUST provide the unattended collection contract below before live enablement. Do not vendor a fork, patch a global install, copy credentials, open an upstream issue/PR, or install anything as part of this plan. Those actions require a separately authorized execution step. The missing release is a concrete external prerequisite, not permission to remove the safety requirement or silently omit requested providers.

### Required unattended collection contract

- Literal stored bearer credentials and first-party read-only requests are allowed after explicit operator enablement.
- No vendor agent/login/refresh commands; specifically no Codex app-server fallback, Claude/Grok refresh delegate, or Alibaba CLI invocation.
- No Keychain reads or presence probes that can prompt, including previously granted/marked entries. Unsupported sources return explicit unavailable evidence.
- No token minting, rotation, credential-store writes, browser login, or credential copying.
- quota-axi's non-secret quota cache writes remain permitted and documented; “read-only” here refers to credentials and provider operations, not a filesystem sandbox.
- Partial provider availability is preserved. An unavailable source remains named, not converted to zero or unlimited quota.
- Bounded execution and no subprocess left running after cancellation. This must be proven against the actual candidate, including descendant processes.
- Exact supported version, immutable source revision, invocation arguments, and package integrity are recorded when the prerequisite is resolved. `--version` or accepting a flag alone is not proof.

Stock 0.1.41 fails this contract. No current release is represented here as satisfying it. OMP-side implementation can be developed against synthetic protocol fixtures, but live enablement cannot pass the release gate until the prerequisite is resolved.

## Architecture

An opt-in extension under `packages/coding-agent/examples/extensions/quota-awareness/` owns the adapter, shared collector service, normalization, and context/tool presentation. This follows the existing multi-file extension pattern and ships with coding-agent examples. Enable through existing `extensions` configuration or explicit `-e`; no new built-in provider, daemon, or core tool is needed.

```text
explicit operator configuration
          |
verified unattended quota-axi executable
          | bounded full JSON report
          v
shared collector service (one per auth-storage + configuration)
          | validated, source-labelled vendor evidence
          v
session-local identity comparison and compact presentation
          |                         |
context hook before each LLM call   discoverable quota tool
          |
agent selects task / eval agent / workpool assignments
          |
native OMP execution, credentials and retries unchanged
```

### Verified OMP seams

- `src/extensibility/shared-events.ts:171-183`: `context` fires before each LLM call; replacement messages affect outbound context, not persisted session history.
- `src/extensibility/extensions/runner.ts:1629-1673`: `emitContext` clones and serially transforms messages.
- `src/sdk.ts:3462-3464`: the SDK connects `transformContext` to `emitContext`.
- `src/extensibility/extensions/types.ts`: extension factory `pi.runtimeMode` distinguishes `task` runtimes; `ctx.modelRegistry.authStorage` is available; `ctx.models.resolve` uses native model resolution.
- `packages/ai/src/auth-storage.ts:3191-3217`: `getOAuthAccountIdentity` is a read-only display/metadata lookup. It may return the first OAuth identity before session stickiness exists, so it does not prove a future child will execute with that credential.
- `src/task/executor.ts`: child sessions share the parent model registry/auth storage and rebind prepared extension factories. `src/extensibility/extensions/loader.ts:478-506` preserves the imported factory/module when binding a child runtime.

A `tool_call` hook is too late to influence the already-generated worker selection without rejection and replanning. Do not add a task rejection, input rewrite, or hidden extra turn. The pre-request `context` hook covers decisions made through native task, eval `agent()`, and workpool creation without parsing arbitrary eval source.

## Configuration and authority

The extension is inert without an explicitly configured absolute path to an operator-owned configuration file. Expose `--quota-config` through the existing extension flag API, with `OMP_QUOTA_CONFIG` as the process-local configuration fallback. Do not auto-load a project file that can opt the user into credential-bearing execution. Resolve and validate the configuration once per factory binding; no credential content is stored in it.

Configuration contains:

- Approved executable absolute path and exact expected version; the supported collector contract is a reviewed code-owned compatibility entry, not arbitrary command arguments in configuration.
- Explicit nonempty quota-axi provider allowlist. Never infer “all local providers.”
- Explicit provider associations: external provider ID to OMP provider ID. These are operator declarations, not model-family heuristics. No provider string matching or new model policy in TypeScript.
- Optional exact model/scope associations for display. They cannot override upstream bound uncertainty or establish account identity.

Constants: collector deadline 5,000 ms; stdout ceiling 1 MiB; stderr retained only as a bounded diagnostic tail and never forwarded; cache refresh interval 300,000 ms; failure retry interval 60,000 ms; automatic context presentation at most 2,048 UTF-8 bytes. These are integration resource bounds, not platform quota thresholds. A slow provider yields unavailable evidence rather than stalling an agent indefinitely.

The deadline is a proposed conservative default to verify with authorized live evidence, not a measured upstream latency claim. If the fixed budget prevents useful collection, adjust it explicitly with measured evidence; do not introduce unlimited waiting or detached refresh delegates.

## Evidence model

Keep external evidence separate from native `UsageReport`; do not insert it into auth storage or native usage caches.

Internally retain only allowlisted report fields needed for the tool:

- External provider and scope, report generation and provider refresh timestamps.
- Source freshness/status, effective remaining percentage, reset time, runway verdict and finite horizon, pace status, selection value.
- Unknown bound IDs, bound conflicts, and normalized reason codes.
- Account identifiers in private memory solely for comparison; never include them in the model-facing view, tool details, diagnostics, or persistent cache owned by the extension.

Use JSON schema version 5 only for the inspected baseline. Reject unsupported top-level schema versions. Validate every consumed field, finite numeric ranges, timestamps, enum values, and list sizes. Ignore additive fields not consumed, rather than copying raw JSON into prompts. One malformed provider produces an unavailable provider row; a malformed envelope invalidates the whole response. A requested provider omitted from the response receives an unavailable row.

Tool/model views separate two concepts:

1. **Vendor observation:** what quota-axi reported for its selected local source.
2. **OMP association:** `matched`, `unmatched`, or `unknown`, plus basis `stored-account-identity` or `none`.

Only exact provider-associated stable account IDs in a reviewed identity namespace may match. An email match, provider-name match, configured mapping, or first available OAuth account is not proof of the credential a future worker will use. Even `matched` means a stored-account match, NOT a credential reservation. Show that limitation in the fanout guidance. Missing organization/workspace dimensions needed to distinguish subscriptions force `unknown`.

For wrappers, API keys, broker-owned accounts, and sources without reliable IDs, retain `unknown`. Never read token values or invoke `getApiKey`/`fetchUsageReports` to manufacture a match; those paths may refresh credentials or advance selection.

### Freshness and uncertainty

Re-evaluate validity every time a cached report is presented. A recent `generatedAt` cannot rejuvenate an old provider `state.refreshedAt`.

- Require source status fresh, valid observation timestamps, and age within the 300-second refresh interval for a positive current signal.
- If a present reset has expired, demote its dependent scope before showing a current positive signal. Missing reset is not automatically exhaustion; preserve upstream unknown/untriggered semantics without guessing a duration.
- Stale, malformed, conflicting, absent, or unknown evidence never becomes `0`, unlimited capacity, or a positive spend recommendation.
- Preserve known zero exhaustion as a distinct observation. Preserve negative pressure even when the future worker binding is unknown, but label it external-account evidence rather than route-level exhaustion.
- `through_reset` is a cycle-average projection, not a promise. Do not linearly extrapolate after collection or recompute provider semantics in OMP.
- `spendPriority` is explanatory data, never an admission score or a quality override.

## Proactive agent awareness

### Parent model calls

On each `context` event in an enabled non-task runtime:

1. Obtain the shared service for the exact auth-storage object and normalized configuration identity.
2. Read a fresh cached report, coalesce with an existing fetch, or perform one bounded fetch if refresh is due.
3. Recompute freshness and session-local identity association without touching credentials.
4. Append one compact custom-message block to the outgoing message array. Remove only a prior block owned by this extension if present; do not alter user text or unrelated messages.
5. Include static fanout guidance from an imported Markdown template. Missing/blocked collector emits a short explicit unavailable notice, not an empty success.

No subprocess on `session_start`, no polling timer, no background reminder that starts a model turn. Refresh is demand-driven at model-call boundaries and through the explicit tool.

On the cold first call, wait only within the collector deadline, then continue with explicit unavailable evidence if necessary. This provides information, not a hard quota gate: an agent may proceed when evidence is unavailable but cannot claim it checked healthy quota.

### Child and nested fanout

Use a module-owned `WeakMap<AuthStorage, Map<configurationIdentity, QuotaEvidenceService>>`. Parent and in-process children reuse imported modules and the same auth storage.

Task-mode runtimes MUST NOT create a collector service or launch the executable. They read the existing shared snapshot if available and apply their own session-local association. Missing service returns `parent_snapshot_unavailable`; stale snapshot returns stale evidence and asks the parent to refresh before further delegation. A child `quota` call follows the same rule even with `refresh: true`.

Child lookup does not require CLI flag inheritance: when no child-local configuration is available, use the sole active service for that exact auth-storage object. Multiple active configurations are ambiguous and return `parent_snapshot_ambiguous`; never select an arbitrary entry. A child-local configuration can identify an already-owned matching service but cannot create one or authorize collection.

This gives nested delegators quota awareness without one network request per child. A standalone/revived child in a different process honestly has no parent snapshot. No cross-process cache, bridge, or credential transport is introduced.

Ordinary task/eval workers must not need the quota tool in their allowed tool list to receive context awareness. If explicit tool restrictions exclude it, do not silently widen permissions; the hook still provides the snapshot and unavailable/refresh guidance.

### Shared pools and fanout reasoning

Static agent instructions MUST say:

- Inspect quota evidence before selecting a fanout batch or starting a workpool.
- Prefer task fit and required quality; use valid quota evidence to compare otherwise suitable options.
- Workers on the same provider/account/scope share allowance; N workers do not imply N independent budgets.
- Do not divide projected runway by worker count or invent task token costs; concurrency changes future burn.
- Unknown or stale evidence cannot justify moving work to a supposedly healthier route.
- Request `quota` refresh before delegation if the evidence is stale and the tool is available; children ask the parent instead.
- Never abandon required work or reduce its acceptance criteria merely to conserve quota. Report an actual external capacity blocker when encountered.

The extension does not calculate per-agent dollar budgets, reserve quota, mutate concurrency, or reroute a submitted batch. A snapshot can age during a long model response; the hook is not an atomic pre-spawn check. State that limit rather than claiming enforcement.

## Agent tool

Register discoverable `quota` with parameters `{ providers?: string[], refresh?: boolean, full?: boolean }`. Provider requests must be subsets of the configured allowlist. The normal tool reads the same service; `refresh` bypasses the success TTL but not an existing in-flight request, a current failure backoff, or child restrictions.

Default text uses a compact TOON table. Use the maintained TOON encoder in the optional extension package, not handwritten escaping. Structured details use the same sanitized view; `full` adds window/reason evidence, never raw output, credential-source paths, emails, or account IDs. Full output is bounded; include counts and omitted-row disclosure. No provider row is ranked as a winner.

Use static imported Markdown for descriptions and context instructions. Never interpolate vendor error prose, remedy commands, URLs, or arbitrary account labels into instructions. TUI rendering uses existing sanitization and truncation helpers.

## Unchanged surfaces

Do not modify `CredentialRankingStrategy`, `AuthStorage` selection/refresh, native `UsageReport`, `omp usage`, `/usage`, advisor routing, task batch semantics, eval/workpool schemas, agent frontmatter, or the KDL model catalog. No telemetry, session-history quota archive, fleet-wide scheduler, automatic installer, or GitHub mutation.

## Verification and release criteria

Observable tests must prove:

1. Actual candidate collector rejects/suppresses refresh and prompt paths, even with expired credentials and existing Keychain markers. No credential fixture changes and no recording vendor/security subprocess runs.
2. Invalid envelope versus partial provider failure; absent provider; unknown schema; malformed numeric/timestamp fields; explicit zero; stale cache and expired reset; bound conflicts.
3. Native account mismatch cannot become an applicable positive route signal; same-email/different-account remains unknown or unmatched.
4. Multiple parent requests share one in-flight fetch; child context/tool calls never spawn; child shutdown cannot cancel the parent-owned collector; failure backoff survives repeated context calls.
5. Parent receives quota evidence on the provider request that precedes its first task/eval/workpool choice. Later same-turn provider requests receive a new view after expiry. No duplicate quota block or persisted history mutation.
6. Task/eval/workpool execution and model/credential selection are unchanged regardless of evidence state.
7. Missing collector does not prevent OMP from answering or executing requested work; no falsely healthy report.
8. The enabled extension works through the actual OMP runtime with one authorized live report and a small fanout smoke; disabled extension performs no quota subprocesses or credential work.

Run focused Bun tests, package lint/typecheck and root `bun check` during implementation, then fresh code review. A planning document is not implementation evidence. No live collector has been executed during this planning session.

## Sources

- https://github.com/kunchenguid/quota-axi/tree/a19268827220e12e173067d11703e6ee36d5d88f
- https://github.com/kunchenguid/quota-axi/blob/a19268827220e12e173067d11703e6ee36d5d88f/src/providers/codex.ts
- https://github.com/kunchenguid/quota-axi/blob/a19268827220e12e173067d11703e6ee36d5d88f/src/args.ts
- https://github.com/kunchenguid/quota-axi/blob/a19268827220e12e173067d11703e6ee36d5d88f/src/types.ts
- Local OMP source references listed under Verified OMP seams; `docs/extension-loading.md` for opt-in loading.
