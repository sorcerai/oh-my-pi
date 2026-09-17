# Quota-Aware OMP Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Checkboxes are acceptance steps; Beads remains the durable tracker. Do not commit or publish unless separately authorized.

**Goal:** Give OMP and its nested delegators source-labelled quota awareness before worker selection, plus an on-demand `quota` tool, without changing native routing or credentials.

**Architecture:** An optional multi-file extension collects full quota-axi JSON through an approved unattended executable. A module-shared service coalesces parent collection; each session builds its own sanitized view. The existing `context` event supplies evidence before every model call, while task-mode children consume the parent snapshot without probing.

**Tech Stack:** Bun, TypeScript, OMP ExtensionAPI, `@oh-my-pi/omptype`, `@oh-my-pi/pi-utils` process supervision, the optional extension's pinned `@toon-format/toon` encoder, Bun contract tests.

**Spec:** `docs/superpowers/specs/2026-09-08-quota-awareness-design.md`

**Approval:** Operator approved adapter/tool boundary and specifically required awareness during subagent fanout. This plan is the requested artifact, not authorization to install, implement, commit, or publish.

## Global constraints

- Stock quota-axi `0.1.41` at `a19268827220e12e173067d11703e6ee36d5d88f` is NOT a safe unattended collector. Task 0 is an external release prerequisite.
- No vendored quota-axi fork, runtime patching, credentials copied to temporary homes, automatic install/update, or upstream GitHub mutation.
- No token/key lookup, refresh, auth-store writes, Keychain prompts, vendor CLI fallback, or generated provider/model policy.
- Use the existing extension context event, not task rejection/input rewriting or post-spawn warnings as a substitute for pre-choice awareness.
- Task-mode children never invoke the collector, including explicit `quota(refresh=true)` calls.
- Unknown, stale, malformed, conflicted, or account-unmatched evidence cannot justify spending on an OMP route.
- Account match is a stored-identity comparison, never proof or reservation of a future worker credential.
- Keep native `UsageReport`, `/usage`, `omp usage`, credential ranking, model catalog, retry, task/eval/workpool schemas, and agent definitions unchanged.
- Collector deadline: 5,000 ms. Stdout cap: 1 MiB. Cache interval: 300,000 ms. Failure retry: 60,000 ms. Automatic context: 2,048 UTF-8 bytes maximum.
- No polling timer, session-start subprocess, persistent quota transcript, or cross-process cache.
- Static prompt prose lives in Markdown and is imported with `{ type: "text" }`. Render only validated data into it.
- At most five files per implementation phase. Tests protect real errors, transitions and consumer-visible behavior; no source-text assertions or `mock.module()`.
- All code below specifies interfaces or executable contract examples for the implementer. It is not code already present in the repository.

## Source-grounded boundary

Read these before implementation; use LSP references before modifying any existing exported symbol:

| Existing file | Use |
| --- | --- |
| `packages/coding-agent/src/extensibility/shared-events.ts:171-183` | Pre-model-call `context` contract; outbound messages only |
| `packages/coding-agent/src/extensibility/extensions/runner.ts:1629-1673` | Serial `emitContext` transform |
| `packages/coding-agent/src/sdk.ts:3462-3464` | SDK wiring for every provider request |
| `packages/coding-agent/src/extensibility/extensions/types.ts:455-490,1298-1301,1436-1482` | Runtime scope, auth storage access, registration and tool APIs |
| `packages/coding-agent/src/extensibility/extensions/loader.ts:478-506` | Reuse imported factories when rebinding children |
| `packages/coding-agent/src/task/executor.ts:2989-3006,3350-3405` | Shared auth storage/model registry and prepared extensions |
| `packages/ai/src/auth-storage.ts:3191-3217` | Non-mutating account identity lookup; first-account fallback caveat |
| `packages/utils/src/ptree.ts` | Process tree lifetime, timeout/abort, bounded stderr tail |
| `packages/coding-agent/examples/extensions/with-deps/package.json` | Optional multi-file extension package convention |
| `packages/coding-agent/test/agent-session-message-pipeline.test.ts:929-1015` | Real provider-context capture and session-history preservation |
| `docs/extension-loading.md` | Explicit extension enabling and parent/child packaging |

No production core mutation is planned. If a runtime test disproves imported-module/auth-storage sharing or child provenance, stop and report the exact missing seam instead of substituting a process-global credential cache or child probes.

## File map

All paths below are proposed new files unless marked modify.

| File | Responsibility |
| --- | --- |
| `packages/coding-agent/examples/extensions/quota-awareness/schema.ts` | Configuration, consumed wire schema, private evidence and public view contracts |
| `packages/coding-agent/examples/extensions/quota-awareness/collector.ts` | Approved CLI contract, fixed argv, bounded process lifetime and envelope parsing |
| `packages/coding-agent/examples/extensions/quota-awareness/service.ts` | Parent-owned single-flight cache, failure backoff, child read-only access |
| `packages/coding-agent/examples/extensions/quota-awareness/presentation.ts` | Freshness, conservative identity association, sanitized compact/full output |
| `packages/coding-agent/examples/extensions/quota-awareness/index.ts` | Optional extension factory, quota tool, context hook, runtime scope and shutdown |
| `packages/coding-agent/examples/extensions/quota-awareness/context.md` | Fanout-aware static instructions |
| `packages/coding-agent/examples/extensions/quota-awareness/tool.md` | Tool contract and limitations |
| `packages/coding-agent/examples/extensions/quota-awareness/package.json` | `omp.extensions` entry and exact TOON encoder dependency |
| `packages/coding-agent/examples/extensions/quota-awareness/bun.lock` | Reproducible optional-package dependency resolution |
| `packages/coding-agent/test/quota-awareness-schema.test.ts` | Malformed/unknown/partial evidence and configuration boundaries |
| `packages/coding-agent/test/quota-awareness-collector.test.ts` | Real process output, cancellation, overflow and nonzero exit behavior |
| `packages/coding-agent/test/quota-awareness-service.test.ts` | Concurrent requests, expiry, child reads and lifecycle ownership |
| `packages/coding-agent/test/quota-awareness-presentation.test.ts` | Source-to-view transformation, uncertainty and privacy |
| `packages/coding-agent/test/quota-awareness-context.test.ts` | Hook/tool exposure and nonpersistent pre-choice context |
| `packages/coding-agent/test/quota-awareness-fanout.test.ts` | Parent/child/task/eval/workpool runtime integration |
| `docs/quota-awareness.md` | Enabling, supported collector, privacy, unavailable states and limits |
| `packages/coding-agent/CHANGELOG.md` (modify) | User-facing entry after runtime proof |

Test fixtures are created in per-test temporary directories with existing temp utilities. Never read real user credentials or invoke a real vendor from ordinary tests. Avoid permanent fixture files when a bounded inline JSON fixture names the failure mode more clearly.

## Task 0: Resolve the unattended collector prerequisite

**Ownership:** External collector compatibility investigation, separate from OMP implementation. No upstream repository writes or publication are authorized by this plan.

**Current result:** BLOCKED for stock 0.1.41. Its Codex adapter discards `ProviderOptions`; `--no-credential-refresh` alone is insufficient. Keychain marker paths also remain reachable.

**Affected upstream source for an authorized remediation:** `src/types.ts`, `src/args.ts`, `src/commands.ts`, `src/providers/codex.ts`, `src/providers/alibaba.ts`, `src/providers/claude.ts`, `src/providers/grok.ts`, `src/providers/cursor-cli-credential.ts`. Preserve upstream defaults outside its new strict unattended contract. Do not silently redefine safety in OMP to fit an unsafe dependency.

- [ ] Obtain a source-reviewed release or verified wrapper that enforces the spec's unattended contract. A new flag name/version is not invented here; record the real supported invocation after it exists.
- [ ] Pin immutable source revision, package integrity, executable distribution and exact version. Read the built command and adapter path, not only README or CLI flag parsing.
- [ ] In an isolated synthetic credential home, force rejected/expired Codex and Pi sources; prove no app-server/vendor process and no credential file changes.
- [ ] Repeat for Claude/Grok delegate eligibility, Alibaba vendor CLI, and Claude/Cursor existing Keychain markers. A recording `security` executable must never be called, even with a marker. Explicitly test default/non-strict behavior separately in the collector's own suite.
- [ ] Exercise cancellation and output bounds against the actual collector candidate; no detached vendor remains running. A version/help-only probe does not satisfy this gate.
- [ ] Record supported argv and candidate evidence in `docs/quota-awareness.md` during Task 6. Until then, stock 0.1.41 must fail compatibility selection before a quota invocation.

**Dependency:** Tasks 1, 3, and synthetic portions of Tasks 2/4/5 may be implemented independently. Task 2's production compatibility entry and Task 6 live acceptance require Task 0. A branch with synthetic tests alone is not a shipped integration.

## Task 1: Define validated evidence and configuration

**Files (2):** create `schema.ts` and `test/quota-awareness-schema.test.ts` at the paths in the file map.

**Consumes:** JSON schema 5 contract from pinned upstream and operator configuration.

**Produces:** validated `QuotaConfig`, `QuotaSnapshot`, `QuotaView`, `parseQuotaConfig(input: unknown): QuotaConfig`, and `parseQuotaReport(input: unknown, requestedProviders: readonly string[], collectedAt: number): QuotaSnapshot`.

Use these internal interface boundaries; keep account fields out of `QuotaView`:

```ts
export interface QuotaConfig {
  executable: string;
  expectedVersion: string;
  providers: string[];
  associations: Array<{ externalProvider: string; ompProvider: string }>;
}

export interface QuotaScope {
  scope: string;
  status: "known" | "unknown";
  percentRemaining?: number;
  resetsAt?: number;
  runway: "exhausted_now" | "projected_exhaustion" | "through_reset" | "unknown";
  runwaySeconds?: number;
  spendPriority?: number;
  pace: "ahead" | "on_pace" | "behind" | "mixed" | "unknown";
  boundConflict: boolean;
  unknownBounds: string[];
}

export interface QuotaProviderEvidence {
  provider: string;
  status: "fresh" | "stale" | "unavailable" | "auth_required" | "rate_limited" | "error";
  observedAt?: number;
  accountId?: string;
  organization?: string;
  identityStatus?: "verified" | "unverified";
  scopes: QuotaScope[];
  reasons: string[];
}

export interface QuotaSnapshot {
  generatedAt: number;
  collectedAt: number;
  providers: QuotaProviderEvidence[];
}

export interface QuotaViewRow {
  provider: string;
  scope: string;
  binding: "matched" | "unmatched" | "unknown";
  evidence: "current" | "stale" | "unknown";
  percentRemaining?: number;
  runway: QuotaScope["runway"];
  runwaySeconds?: number;
  spendPriority?: number;
  reasons: string[];
}

export interface QuotaView {
  status: "available" | "partial" | "unavailable";
  generatedAt?: number;
  rows: QuotaViewRow[];
  reasons: string[];
}
```

- [ ] Implement configuration validation: executable absolute, expected version nonempty, provider IDs from the inspected quota protocol, unique explicit nonempty provider list, associations restricted to configured providers, no unknown config keys or arbitrary argv/shell strings. Provider labels are protocol vocabulary, not routing policy.
- [ ] Use the repository schema library and explicit consumed fields. Require schema version 5; normalize ISO timestamps to epoch ms; reject non-finite/out-of-range percentages and horizons; do not coerce strings into numbers.
- [ ] Normalize upstream `quotaSemantics.effectiveAvailability` into scopes. Preserve `boundedBy`/window information privately as necessary to find expired resets; add private fields when the consumed wire contract requires them, never reinterpret provider relationships.
- [ ] For each requested provider, create either validated evidence or an explicit unavailable row. Never let a malformed sibling discard valid provider evidence. Ignore unrequested/additive content; retain neither free-form errors nor remedy commands.
- [ ] Add the following envelope boundary regression and separate partial-provider/zero/conflict cases. Assertions concern visible availability, not copied fixture metadata.

```ts
import { expect, test } from "bun:test";
import { parseQuotaReport } from "../examples/extensions/quota-awareness/schema";

test("a missing requested provider cannot look like available quota", () => {
  const snapshot = parseQuotaReport({
    schemaVersion: 5,
    generatedAt: "2026-09-08T12:00:00.000Z",
    providers: [],
  }, ["codex"], Date.parse("2026-09-08T12:00:01.000Z"));
  expect(snapshot.providers.map(p => [p.provider, p.status, p.scopes.length]))
    .toEqual([["codex", "unavailable", 0]]);
});

test("an unknown envelope cannot be interpreted as healthy headroom", () => {
  expect(() => parseQuotaReport({
    schemaVersion: 999,
    generatedAt: "2026-09-08T12:00:00.000Z",
    providers: [],
  }, ["codex"], 0)).toThrow();
});
```

**Verify:** `bun test packages/coding-agent/test/quota-awareness-schema.test.ts` and package `bun check`. Tests import the example source, bringing it into the typecheck graph; do not assume examples are included by `tsconfig.json` directly.

## Task 2: Build the bounded collector adapter

**Files (2):** create `collector.ts` and `test/quota-awareness-collector.test.ts`.

**Consumes:** `QuotaConfig`, Task 0 approved candidate, Task 1 parser.

**Produces:** `collectQuota(config: QuotaConfig, signal: AbortSignal): Promise<QuotaSnapshot>` and typed `QuotaCollectionError` with sanitized codes `unsupported_collector`, `missing_executable`, `timeout`, `cancelled`, `output_limit`, `invalid_report`, `collector_failed`.

- [ ] Reject stock 0.1.41 as unsupported before any quota request. Register an exact production compatibility entry only after Task 0 provides the verified candidate and fixed strict-mode argv. Never expose arbitrary args in `QuotaConfig` or accept semver ranges as a safety proof.
- [ ] Use `ptree.spawn` with literal argv, ignored stdin, no shell, managed process tree, abort signal and fixed deadline. Reuse its stderr-tail and termination behavior; do not create another process-tree implementation or forward raw errors.
- [ ] Consume stdout with a byte ceiling before retaining/decoding the entire report. This is the JSON protocol size boundary; do not use unbounded `child.text()`/`ptree.exec` or truncate a JSON document and parse the prefix. Kill and await the process on overflow, cancellation or deadline. Drain/close pipes through the shared process helper.
- [ ] Do not set environment values that request prompts, refresh, browser login, arbitrary executables, or credential relocation. Only explicitly approved source context goes to the collector. Preserve source-context identity when caching; never cache only by provider name across different configuration/profile roots.
- [ ] Parse only a successful, complete JSON response. Convert launch errors/nonzero/invalid JSON to sanitized codes without echoing stdout/stderr or account identifiers.
- [ ] Use temporary executable fixtures for process tests: one emits valid bounded JSON; another continuously writes beyond 1 MiB; another waits with a descendant holding stdout; another exits nonzero after printing a credential-looking secret. Observe bounded termination and sanitized errors, not internal spawn option forwarding.

The adapter loop must enforce this order:

```text
validate approved collector and config
→ spawn managed process with fixed argv
→ read at most 1 MiB under deadline
→ await successful exit and complete EOF
→ JSON.parse once
→ parseQuotaReport
→ release process resources in finally
```

**Test cases:** output overflow never yields a partial report; cancellation stops the actual fixture process tree; nonzero output never becomes quota; no stderr secret appears in error/public view; missing executable returns unavailable through the service; unsupported collector never reaches the fixture's quota branch. Only the collector's test seam may supply a fixture command; production configuration cannot bypass the compatibility gate.

**Verify:** `bun test packages/coding-agent/test/quota-awareness-collector.test.ts` and package `bun check`. Live candidate check remains blocked by Task 0 until resolved.

## Task 3: Share snapshots across parent and child sessions

**Files (2):** create `service.ts` and `test/quota-awareness-service.test.ts`.

**Consumes:** `collectQuota`, `QuotaConfig`, exact shared AuthStorage object.

**Produces:** service registration and lookup plus single-flight read semantics:

```ts
export type QuotaReadResult =
  | { status: "snapshot"; snapshot: QuotaSnapshot }
  | { status: "unavailable"; reason: string };

export interface QuotaServiceDependencies {
  now(): number;
  collect(config: QuotaConfig, signal: AbortSignal): Promise<QuotaSnapshot>;
}

export interface QuotaReadOptions {
  refresh?: boolean;
  signal?: AbortSignal;
}

// Implement as a class with ES #private state.
// constructor(config: QuotaConfig, dependencies: QuotaServiceDependencies)
// read(options?: QuotaReadOptions): Promise<QuotaReadResult>
// peek(): QuotaReadResult
// dispose(): Promise<void>
// Registry: WeakMap<AuthStorage, Map<string, QuotaEvidenceService>>.
// registerQuotaService(storage, config) acquires an owner lease.
// findQuotaService(storage, config?) only reads; it never creates or collects.
```

The registry's configuration key includes canonical executable/config/source-context identity and sorted provider associations; do not retain secrets or use human account emails as cache keys. Use a typed owner lease so child shutdown cannot dispose the parent service. Multiple non-task owners sharing the same service keep it alive until the final owner releases it.

Child CLI flags are not assumed to be inherited. With no child-local config, resolve only a sole active service under the exact shared auth storage; multiple active configurations return `parent_snapshot_ambiguous`. With an explicit child config, require an existing exact entry. Test both cases. Child lookup must work before treating missing configuration as an inert parent.

- [ ] Implement fresh-cache reuse and one in-flight collection per service. Simultaneous refresh requests join it. `refresh` bypasses the success TTL only, never a failure cooldown.
- [ ] Keep one service-owned abort controller per fetch. An individual caller abort detaches that waiter without cancelling unrelated waiters. Final owner shutdown aborts the managed collector and awaits/drains its completion before release.
- [ ] Preserve the last report for diagnostic presentation after fetch failure, but return a view snapshot with its provider statuses demoted to stale; do not mutate observation timestamps or the original stored snapshot. Store failure code/backoff separately from cached success. A recent successful timestamp cannot conceal a subsequent failed refresh.
- [ ] Implement `peek` as strictly non-collecting. Task-mode extension handlers and tool calls use only `findQuotaService` + `peek`, even with `refresh: true`.
- [ ] Test concurrent parent readers, stale results after time advance, force-refresh coalescing, failed refresh retaining stale evidence, retry cooldown, one waiter cancellation and last-owner disposal. Test that a child without a registry entry gets unavailable and does not create one.

A concrete concurrent/child test sequence:

```ts
const gate = Promise.withResolvers<QuotaSnapshot>();
let calls = 0;
let now = 1_000;
const service = new QuotaEvidenceService(config, {
  now: () => now,
  collect: async () => { calls++; return await gate.promise; },
});
const first = service.read();
const second = service.read({ refresh: true });
expect(service.peek().status).toBe("unavailable");
expect(calls).toBe(1);
gate.resolve({ generatedAt: now, collectedAt: now, providers: [] });
await Promise.all([first, second]);
now += 300_001;
// Merely peeking (child behavior) must not cause another process call.
service.peek();
expect(calls).toBe(1);
await service.dispose();
```

Place this sequence inside a test using an inline validated synthetic `config`; it establishes the no-child-probe/single-flight contract. Distinct tests must assert stale/unknown public results, not merely call counts.

**Verify:** `bun test packages/coding-agent/test/quota-awareness-service.test.ts` and package `bun check`.

## Task 4a: Normalize identity/freshness and render compact evidence

**Files (4):** create `presentation.ts`, `test/quota-awareness-presentation.test.ts`, optional extension `package.json`, and its generated `bun.lock`.

**Consumes:** `QuotaReadResult`, current time, source-to-OMP associations and read-only session identities.

**Produces:** `buildQuotaView`, `renderQuotaView`, and an optional package manifest:

```ts
export interface QuotaIdentityAssociation {
  externalProvider: string;
  accountId?: string;
  organization?: string;
  comparableNamespace: boolean;
}

// buildQuotaView(
//   result: QuotaReadResult,
//   identities: readonly QuotaIdentityAssociation[],
//   now: number,
// ): QuotaView
// renderQuotaView(view: QuotaView, full: boolean): string
```

Identity associations are session-local inputs, not cached alongside vendor data. Use `getOAuthAccountIdentity(provider, sessionId)` only. Never fetch/refresh/rank credentials to improve an association. When namespace or organization comparison cannot be established from reviewed source evidence, pass `comparableNamespace: false` and display unknown.

- [ ] Recompute validity from both report and provider observation time, source status, applicable resets, scope status and bound conflicts. Do not revive stale data because `collectedAt` is recent.
- [ ] Preserve vendor observations separately from association. A public positive signal must not be phrased as a guaranteed worker budget. Remove positive current numeric fields from stale/unknown/conflicted scope summaries; full diagnostics may show historical values only with explicit historical labels.
- [ ] Match only comparable stable IDs; never use email equality or provider association alone. If IDs disagree, mark unmatched. Missing namespace/dimension is unknown.
- [ ] Render structured `QuotaView` through `@toon-format/toon` pinned to the reviewed exact encoder version `2.1.0` in the optional extension package. No quota-axi runtime package dependency. Use existing TUI sanitation and truncation at display boundaries.
- [ ] Bound automatic output to 2,048 UTF-8 bytes by dropping complete rows before encoding, not truncating encoded syntax. Include total/omitted counts and a `quota(full=true)` detail hint only if that tool is available. Never lose the unavailable/stale/unknown summary when trimming.
- [ ] Generate the optional package lock with the repository's Bun toolchain during implementation; do not run install in this planning session. The package uses `omp.extensions: ["./index.ts"]`; the future Task 4b file must be present before the package is enabled.

Test this concrete negative contract using an inline `QuotaSnapshot` with one fresh known scope and a positive `spendPriority`:

```ts
const view = buildQuotaView({ status: "snapshot", snapshot }, [{
  externalProvider: "codex",
  accountId: "different-account",
  comparableNamespace: true,
}], now);
expect(view.rows[0]?.binding).toBe("unmatched");
// A stale view must not preserve a spend-justifying scalar.
const stale = buildQuotaView({ status: "snapshot", snapshot }, [], now + 300_001);
expect(stale.rows[0]?.evidence).toBe("stale");
expect(stale.rows[0]?.spendPriority).toBeUndefined();
```

Also test valid zero exhaustion, contradictory inherited bounds, reset crossing, older `refreshedAt` with new `generatedAt`, missing namespace, terminal controls in external IDs, and account/secret removal from both default and full output. Assert decoded table values/semantic status rather than exact prose.

**Verify:** `bun test packages/coding-agent/test/quota-awareness-presentation.test.ts` and package `bun check` after optional dependencies are installed. Dependency installation must stay within the extension package; do not rewrite unrelated workspace dependency state.

## Task 4b: Connect the tool and proactive context hook

**Files (4):** create `index.ts`, `context.md`, `tool.md`, and `test/quota-awareness-context.test.ts`.

**Consumes:** service, parser/configuration, presentation and existing ExtensionAPI.

**Produces:** default `quotaAwarenessExtension(pi: ExtensionAPI): void`, discoverable `quota` tool, nonpersistent context awareness.

- [ ] Register the `quota-config` string flag. In non-task runtimes resolve it ahead of `OMP_QUOTA_CONFIG`; absent config means fully inert parent, with no service, tool activation, message, or credential-bearing work. Task runtimes first attempt inherited service lookup as specified in Task 3; missing CLI flags must not suppress inherited awareness. Validate config once when a live handler has runtime provenance, not at module import.
- [ ] Register the quota tool via existing tool lifecycle without overriding explicit tool restrictions. Use `{ providers?: string[], refresh?: boolean, full?: boolean }`; reject unknown inputs and provider requests outside configured scope before any collection. Parent tool calls share the service; child calls use `peek` only.
- [ ] In `context`, inspect `pi.runtimeMode` inside the handler (not before runtime initialization). Non-task owner obtains the shared service and bounded read. Task runtime only looks up an existing service. Build identities with `ctx.sessionManager.getSessionId()` and native read-only identity lookup.
- [ ] Return a new message array with one extension-owned custom message. Remove only a prior custom message whose `customType` equals `quota-awareness`. Do not remove text that merely mentions quota. Never call `pi.sendMessage`, trigger extra turns, or append persistent session entries for automatic context.
- [ ] Put all instructions in imported Markdown. Render the validated view as a quoted/data block with no raw provider errors, account labels or remedy commands.
- [ ] On session shutdown, release only the lease owned by that parent instance. A task runtime never owns a lease. Same-process child rebinds must read the existing module registry. Profile/config change gets a different registry key.

`context.md` must contain these normative instructions (render tool availability and parent/child refresh path, not model/provider policy):

```markdown
Quota evidence is advisory and timestamped; it does not reserve capacity.
Before selecting workers for task, agent(), or workpool(), inspect this snapshot.
Workers sharing a provider/account/scope consume the same allowance.
NEVER multiply allowance by worker count or divide runway by worker count.
Choose task fit and required quality first; compare valid evidence among suitable routes.
NEVER treat unknown, stale, conflicting, or unmatched evidence as healthy route capacity.
A stored-account match does not guarantee a future worker's selected credential.
Refresh stale evidence with quota when available; task children ask their parent to refresh.
NEVER lower acceptance criteria or abandon work merely to conserve quota.
```

`tool.md` must state when to request details/refresh, configured provider subset limits, child cache-only behavior, source/identity uncertainty, and no routing/credential effects. No instruction to install or log in automatically.

Valid custom-message shape follows `src/session/messages.ts`:

```ts
const message = {
  role: "custom" as const,
  customType: "quota-awareness",
  content: renderedContext,
  display: false,
  timestamp: Date.now(),
};
return {
  messages: [
    ...event.messages.filter(m => m.role !== "custom" || m.customType !== "quota-awareness"),
    message,
  ],
};
```

Use actual imported message types in implementation; ensure the message reaches the provider conversion path in tests. The rendered block must remain within the 2,048-byte bound including instructions; reserve room for fixed instructions before selecting table rows.

**Acceptance tests:** disabled path does no collection; first parent provider request sees evidence/unavailable before choosing tools; next request after expiry refreshes; history is unchanged; prior owned message is replaced without touching unrelated custom/user text; child context never collects; excluded quota tool does not become active; full tool result contains no raw identity/source paths; unavailable collector does not block the user turn.

**Verify:** `bun test packages/coding-agent/test/quota-awareness-context.test.ts` and package `bun check`.

## Task 5: Prove real fanout awareness and isolation

**Files (1):** create `test/quota-awareness-fanout.test.ts`. Use existing test fixtures/utilities by import, not by copying full SDK setup code. If an existing harness needs a small exported test helper, keep that change in this phase and within the five-file limit.

**Consumes:** complete extension factory, shared module service, native session/task/eval/workpool paths.

**Produces:** runtime evidence that the approved requirement is met, rather than a renderer-only test.

- [ ] Follow `agent-session-message-pipeline.test.ts` to create an isolated session with a synthetic provider that captures outbound messages and emits actual tool calls. Use a real extension runner/factory, not a mocked callback array.
- [ ] First captured provider request must contain the current quota data before the provider returns a two-child task call. Assert the captured data's semantic quota state, not prompt wording.
- [ ] Run the native fanout path with two synthetic worker responses. Confirm both child requests contain the parent snapshot and collector invocation count remains one. Observe actual task results and unchanged chosen agents/models.
- [ ] Advance the injected clock beyond TTL and make another parent decision. Confirm a new bounded collection precedes that provider request. In contrast, a nested child decision after expiry must show stale/parent-refresh-needed evidence and must not collect.
- [ ] Exercise eval `agent()` and workpool first/follow-up turns as distinct execution paths using existing evaluation harnesses. Do not parse eval strings in production. Each model-driven delegation decision receives the same context contract; programmatic pushes without an intervening model call are not claimed to be freshly checked.
- [ ] Exercise revived child with and without the shared registry, missing collector, cancellation, and explicitly restricted child tools. No child should gain forbidden tools or require a quota tool to receive context evidence.
- [ ] Confirm native preflight/registration semantics remain intact on malformed task input. Quota evidence does not turn a rejected spawn into a successful one or change async/sync behavior.

**Verification commands:**

```sh
bun test packages/coding-agent/test/quota-awareness-fanout.test.ts
bun test packages/coding-agent/test/task/task-preflight.test.ts packages/coding-agent/test/task/task-batch.test.ts
bun test packages/coding-agent/test/agent-session-message-pipeline.test.ts
```

Run package `bun check` after these pass. Runtime tests use deterministic fake provider behavior only as the controlled input; they must exercise the real hook and fanout orchestration, not merely assert mocks echoed expected values.

## Task 6: Authorized live acceptance, documentation and delivery review

**Files (2):** create `docs/quota-awareness.md`; modify `packages/coding-agent/CHANGELOG.md` under Unreleased only, after live proof. Do not publish a user-facing claim that the feature works while Task 0 is blocked.

**Prerequisites:** Task 0 compatible collector, Tasks 1–5, and explicit operator consent for the exact configured provider/credential sources. Planning approval alone is not consent for a live credential probe.

- [ ] Install/enable the optional extension only under explicit execution authorization, using existing `extensions` configuration or `-e`. Keep unrelated global configuration untouched. The install step must pin the verified candidate and optional encoder package, not use `npx latest`.
- [ ] Run actual OMP with the enabled extension. Capture one provider request showing the live sanitized snapshot before a small two-worker task fanout, then a nested fanout decision. Observe only parent-owned collector calls. Exercise the quota tool from parent and child; child refresh must not execute a collector.
- [ ] Repeat with missing executable and an expired/rejected synthetic credential context for the collector safety gate. Observe a usable OMP session with explicit unavailable evidence; do not perform a real credential mutation to test the failure.
- [ ] Exercise real terminal output for tool details and unavailable state. Confirm no raw secrets/identity/path leakage and no unsolicited Keychain/login UI. If visual confirmation is unavailable, report that limitation and do not claim it was verified.
- [ ] Document setup, exact supported collector provenance/argv, first-party calls and cache writes, provider coverage limits in strict mode, how to disable, the quota tool, 300-second freshness, five-second deadline, shared quota pools, stored-identity limits, and advisory-not-enforced fanout.
- [ ] Add a short coding-agent changelog entry: optional quota awareness before delegation. Do not describe it as automatic quota routing.
- [ ] Run the full focused quota test set, root `bun check`, and a fresh code review. Fix demonstrated defects and rerun affected gates. No tests for static prose or source text. Remove throwaway smoke artifacts after evidence is recorded.

```sh
bun test packages/coding-agent/test/quota-awareness-schema.test.ts packages/coding-agent/test/quota-awareness-collector.test.ts packages/coding-agent/test/quota-awareness-service.test.ts packages/coding-agent/test/quota-awareness-presentation.test.ts packages/coding-agent/test/quota-awareness-context.test.ts packages/coding-agent/test/quota-awareness-fanout.test.ts
bun check
```

No commit, push, merge, upstream issue, or deployment follows automatically. A later push request uses the repository's no-mistakes pipeline.

## Dependency and ownership graph

```text
Task 0 compatible collector ────────────────┐
Task 1 schema → Task 2 collector ─┐        │
              → Task 3 service ──┼→ 4b → 5 → 6 live/review
              → Task 4a view ────┘        │
Task 0 required for production adapter ────┘
```

After Task 1 contracts settle, collector, service and presentation have independent file ownership. If delegated, dispatch those slices together, skip intermediate project-wide validation, then integrate once. Task 4b owns shared extension wiring. Parent owns final verification and all git actions. Never delegate the external compatibility prerequisite as permission to patch/install third-party software.

## Completion criteria

The eventual feature is complete only when a real compatible collector is pinned, parent and child awareness passes runtime proof, all uncertainty/identity boundaries hold, and live OMP acceptance succeeds. Passing synthetic tests while the external collector prerequisite is unresolved is explicitly not feature completion.

The planning deliverable consists of this plan, its linked design, and Beads work with the collector blocker made visible. It does not claim any implementation, installation, or live quota verification.
