# Claude Agent SDK Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in omp provider `claude-code` (wire API `claude-agent-sdk`) that runs turns through `@anthropic-ai/claude-agent-sdk`, so a Claude Pro/Max subscription is used via the sanctioned path.

**Architecture:** A new `KnownApi` whose stream function spawns the SDK `query()` per turn, resumes the SDK session by id, and renders Claude Code's own tool calls into the omp transcript as already-resolved tool call/result pairs (the `cursor-agent` pattern: `kCursorExecResolved` blocks + the agent's `cursorOnToolResult` buffer). Tool permissions flow from the SDK `canUseTool` callback into omp's approval tiers and UI through a `ClaudeSdkHandlers` bridge built in `packages/coding-agent/src/sdk.ts`.

**Tech Stack:** Bun, TypeScript, `@anthropic-ai/claude-agent-sdk` ^0.3.224 (dynamic import), omp packages `pi-ai`, `pi-catalog`, `pi-agent-core`, `pi-coding-agent`. Tests with `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-01-claude-agent-sdk-provider-design.md`

## Global Constraints

- Provider id is exactly `claude-code`; API id is exactly `claude-agent-sdk`. Never prefix either with `pi-` (that prefix is claimed by the `pi-native` transport in `stream.ts`).
- The SDK is imported only via `await import("@anthropic-ai/claude-agent-sdk")` inside the stream function and the model-discovery factory. No top-level value import anywhere.
- Never pass `permissionMode: "bypassPermissions"` to the SDK.
- No OAuth token handling in omp for this provider. Login only detects Claude Code's own login state.
- All `cost` fields for `claude-code` models are `0`.
- Run `bun run typecheck` (root) and the package tests before every commit. Commit messages end with the session trailer lines used in this branch (see git log).
- Work on branch `feat/claude-agent-sdk-provider`.
- Read the existing precedent before editing: `packages/ai/src/providers/cursor.ts` (`synthesizeCursorExecToolCall` at ~3662, `pairSynthesizedExecResult` at ~3705), `packages/agent/src/agent.ts` lines 1296-1345 (`cursorOnToolResult` sink), `packages/ai/src/stream.ts` `case "cursor-agent"` at ~1014 and ~2284.

---

## File map

| File | Responsibility |
| --- | --- |
| `packages/catalog/src/types.ts` | `KnownApi` union gains `"claude-agent-sdk"`. No compat type (compat resolves to `undefined`, like `cursor-agent`). |
| `packages/catalog/src/provider-models/descriptors.ts` | `CATALOG_PROVIDERS` entry `claude-code`. |
| `packages/catalog/src/provider-models/special.ts` | `claudeCodeModelManagerOptions()` with SDK `supportedModels()` discovery + static fallback list. |
| `packages/catalog/src/provider-models/claude-code-static.ts` | Static model specs (new). |
| `packages/catalog/src/models.json` | Regenerated with the static `claude-code` models. |
| `packages/ai/src/providers/claude-agent-sdk-types.ts` | `ClaudeSdkHandlers` interface, `ClaudeAgentSdkOptions`, tool tier map, tool name map, effort map (new). |
| `packages/ai/src/providers/claude-agent-sdk.ts` | `streamClaudeAgentSdk` stream function (new). |
| `packages/ai/src/types.ts` | `ApiOptionsMap["claude-agent-sdk"]`, `StreamOptions.claudeSdkHandlers?`. |
| `packages/ai/src/api-registry.ts` | builtin id list. |
| `packages/ai/src/stream.ts` | dispatch + simple-options mapping. |
| `packages/ai/src/registry/claude-code.ts` | provider definition + login detection (new). |
| `packages/ai/src/registry/registry.ts` | one import + one `ALL` entry. |
| `packages/ai/package.json` | dependency. |
| `packages/ai/test/claude-agent-sdk.test.ts` | stream function tests with fake `query` (new). |
| `packages/ai/test/claude-code-login.test.ts` | login detection tests (new). |
| `packages/agent/src/agent.ts` | `claudeSdkHandlers` option threaded into stream options. |
| `packages/coding-agent/src/claude-sdk-bridge.ts` | `ClaudeSdkBridge implements ClaudeSdkHandlers`: session-id persistence, approval routing (new). |
| `packages/coding-agent/src/sdk.ts` | construct the bridge, pass to `Agent`. |
| `packages/coding-agent/test/claude-sdk-bridge.test.ts` | bridge tests (new). |
| `packages/ai/scripts/claude-sdk-smoke.ts` | live smoke, env-gated (new). |
| `docs/providers.md`, `docs/provider-endpoint-constraints.md` | docs. |

---

### Task 1: Catalog wire API and provider entry

**Files:**
- Modify: `packages/catalog/src/types.ts` (KnownApi union near line 8-23)
- Create: `packages/catalog/src/provider-models/claude-code-static.ts`
- Modify: `packages/catalog/src/provider-models/special.ts`
- Modify: `packages/catalog/src/provider-models/descriptors.ts`
- Modify: `packages/catalog/src/models.json` (regenerated)
- Test: `packages/catalog/test/claude-code-static.test.ts`

**Interfaces:**
- Produces: `KnownApi` includes `"claude-agent-sdk"`; `CLAUDE_CODE_STATIC_MODELS: ModelSpec<"claude-agent-sdk">[]`; `claudeCodeModelManagerOptions(): ModelManagerOptions<"claude-agent-sdk">`; provider id `"claude-code"` in `KnownProvider`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/catalog/test/claude-code-static.test.ts
import { describe, expect, test } from "bun:test";
import { CLAUDE_CODE_STATIC_MODELS } from "../src/provider-models/claude-code-static";

describe("claude-code static models", () => {
	test("every model is subscription-billed and on the claude-agent-sdk api", () => {
		expect(CLAUDE_CODE_STATIC_MODELS.length).toBeGreaterThanOrEqual(3);
		for (const m of CLAUDE_CODE_STATIC_MODELS) {
			expect(m.api).toBe("claude-agent-sdk");
			expect(m.provider).toBe("claude-code");
			expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(m.reasoning).toBe(true);
			expect(m.supportsTools).toBe(true);
		}
		expect(CLAUDE_CODE_STATIC_MODELS.map(m => m.id)).toEqual(
			expect.arrayContaining(["opus", "sonnet", "haiku", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]),
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/catalog && bun test test/claude-code-static.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Add the API id and static models**

In `packages/catalog/src/types.ts`, extend the union:

```ts
export type KnownApi =
	| "openai-completions"
	// ...existing members unchanged...
	| "devin-agent"
	| "claude-agent-sdk";
```

`CompatConfigOf` / `CompatOf` need no change; the new API falls to `undefined`.

Create `packages/catalog/src/provider-models/claude-code-static.ts`:

```ts
import type { ModelSpec } from "../types";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

function spec(id: string, name: string, contextWindow: number): ModelSpec<"claude-agent-sdk"> {
	return {
		id,
		name,
		api: "claude-agent-sdk",
		provider: "claude-code",
		baseUrl: "local://claude-code",
		reasoning: true,
		input: ["text", "image"],
		supportsTools: true,
		cost: { ...ZERO_COST },
		contextWindow,
		maxTokens: 64000,
		thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh", "max"] },
	} as ModelSpec<"claude-agent-sdk">;
}

/** Bundled fallback when the SDK model list cannot be fetched. Aliases resolve inside Claude Code. */
export const CLAUDE_CODE_STATIC_MODELS: ModelSpec<"claude-agent-sdk">[] = [
	spec("opus", "Claude Opus (alias)", 1_000_000),
	spec("sonnet", "Claude Sonnet (alias)", 1_000_000),
	spec("haiku", "Claude Haiku (alias)", 200_000),
	spec("claude-opus-5", "Claude Opus 5", 1_000_000),
	spec("claude-sonnet-5", "Claude Sonnet 5", 1_000_000),
	spec("claude-haiku-4-5", "Claude Haiku 4.5", 200_000),
];
```

If `ModelSpec` requires fields not listed above (check `packages/catalog/src/types.ts` `ModelSpec` and the `devin` entries in `models.json`), add them with the same values `devin` uses. Do not use `as ModelSpec` to hide a missing required field.

- [ ] **Step 4: Add the model manager and descriptor**

In `packages/catalog/src/provider-models/special.ts`, next to `devinModelManagerOptions`:

```ts
import { CLAUDE_CODE_STATIC_MODELS } from "./claude-code-static";

export function claudeCodeModelManagerOptions(): ModelManagerOptions<"claude-agent-sdk"> {
	return {
		providerId: "claude-code",
		cacheProviderId: resolveModelCacheProviderId("claude-code"),
		fetchDynamicModels: async () => {
			const { fetchClaudeCodeModels } = await claudeCodeDiscovery();
			return fetchClaudeCodeModels();
		},
	};
}

const claudeCodeDiscovery = once(() => import("../discovery/claude-code"));
```

Create `packages/catalog/src/discovery/claude-code.ts`:

```ts
import { CLAUDE_CODE_STATIC_MODELS } from "../provider-models/claude-code-static";
import type { ModelSpec } from "../types";

/**
 * Ask the SDK which models the logged-in Claude Code account can use. Falls
 * back to the static list on any failure (not installed, not logged in).
 */
export async function fetchClaudeCodeModels(): Promise<ModelSpec<"claude-agent-sdk">[]> {
	try {
		const sdk = await import("@anthropic-ai/claude-agent-sdk");
		const q = sdk.query({ prompt: "", options: { maxTurns: 0 } });
		const models = await q.supportedModels();
		await q.return?.(undefined);
		if (!Array.isArray(models) || models.length === 0) return CLAUDE_CODE_STATIC_MODELS;
		const byId = new Map(CLAUDE_CODE_STATIC_MODELS.map(m => [m.id, m]));
		for (const info of models) {
			const id = String((info as { value?: string; id?: string }).value ?? (info as { id?: string }).id ?? "");
			if (!id || byId.has(id)) continue;
			const base = CLAUDE_CODE_STATIC_MODELS[0];
			byId.set(id, { ...base, id, name: String((info as { displayName?: string }).displayName ?? id) });
		}
		return [...byId.values()];
	} catch {
		return CLAUDE_CODE_STATIC_MODELS;
	}
}
```

Check the actual `ModelInfo` shape in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`grep -n "type ModelInfo" -A8`) and use its real field names instead of the `value`/`id`/`displayName` guesses. `@anthropic-ai/claude-agent-sdk` must be added to `packages/catalog/package.json` dependencies as `"^0.3.224"` for this import to resolve (Task 2 adds it to `packages/ai` too).

In `packages/catalog/src/provider-models/descriptors.ts`, add to `CATALOG_PROVIDERS` after the `cursor` entry:

```ts
	{
		id: "claude-code",
		defaultModel: "opus",
		envVars: [],
		createModelManagerOptions: () => claudeCodeModelManagerOptions(),
		allowUnauthenticated: true,
		catalogDiscovery: { label: "Claude Code (subscription)", allowUnauthenticated: true },
	},
```

Import `claudeCodeModelManagerOptions` from `./special`.

- [ ] **Step 5: Regenerate models.json with the static entries**

Find how `gitlab-duo-agent` static models reach `models.json`: `grep -rn "gitlab-duo-agent\|devin" packages/catalog/scripts/generate-models.ts`. Mirror that path so `claude-code` emits `CLAUDE_CODE_STATIC_MODELS` when discovery is unavailable, then run the generator: `cd packages/catalog && bun scripts/generate-models.ts` (read its header for required flags; run offline-only mode if it supports one). Confirm with:

```bash
python3 -c "import json;d=json.load(open('packages/catalog/src/models.json'));print(sorted(d['claude-code'].keys()))"
```

Expected: the six ids above.

- [ ] **Step 6: Run tests and typecheck**

Run: `cd packages/catalog && bun test test/claude-code-static.test.ts && cd ../.. && bun run typecheck`
Expected: PASS. Typecheck may now fail in `packages/ai/src/api-registry.ts` with `BUILTIN_APIS is missing KnownApi values` and in `packages/ai/src/types.ts` ApiOptionsMap exhaustiveness. That is expected; Task 2 fixes it. Note the exact errors in the commit message body.

- [ ] **Step 7: Commit**

```bash
git add packages/catalog
git commit -m "feat(catalog): add claude-agent-sdk api and claude-code provider entry"
```

---

### Task 2: pi-ai types, registry list, dependency, handler interface

**Files:**
- Create: `packages/ai/src/providers/claude-agent-sdk-types.ts`
- Modify: `packages/ai/src/types.ts` (ApiOptionsMap ~line 75-90; StreamOptions ~line 620-640)
- Modify: `packages/ai/src/api-registry.ts` (BUILTIN_API_IDS)
- Modify: `packages/ai/package.json`
- Test: `packages/ai/test/claude-agent-sdk-types.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ClaudeSdkPermissionRequest { toolName: string; input: Record<string, unknown>; signal: AbortSignal }
export type ClaudeSdkPermissionResult = { behavior: "allow" } | { behavior: "deny"; message: string };
export interface ClaudeSdkHandlers {
	getSdkSessionId(): string | undefined;
	setSdkSessionId(id: string): void;
	resetSdkSession(): void;
	requestToolPermission(req: ClaudeSdkPermissionRequest): Promise<ClaudeSdkPermissionResult>;
	onRateLimit?(info: unknown): void;
}
export interface ClaudeAgentSdkOptions extends StreamOptions { cwd?: string; claudeSdkHandlers?: ClaudeSdkHandlers; onToolResult?: CursorToolResultHandler }
export type ClaudeCodeToolTier = "read" | "write" | "exec";
export function claudeCodeToolTier(toolName: string): ClaudeCodeToolTier
export function claudeCodeToolDisplayName(toolName: string): string
export function claudeCodeEffort(reasoning: Effort | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/ai/test/claude-agent-sdk-types.test.ts
import { describe, expect, test } from "bun:test";
import {
	claudeCodeEffort,
	claudeCodeToolDisplayName,
	claudeCodeToolTier,
} from "../src/providers/claude-agent-sdk-types";

describe("claude-agent-sdk maps", () => {
	test("tool tiers", () => {
		expect(claudeCodeToolTier("Read")).toBe("read");
		expect(claudeCodeToolTier("Grep")).toBe("read");
		expect(claudeCodeToolTier("Edit")).toBe("write");
		expect(claudeCodeToolTier("Write")).toBe("write");
		expect(claudeCodeToolTier("Bash")).toBe("exec");
		expect(claudeCodeToolTier("SomethingNew")).toBe("exec");
	});
	test("display names", () => {
		expect(claudeCodeToolDisplayName("Read")).toBe("read");
		expect(claudeCodeToolDisplayName("Glob")).toBe("find");
		expect(claudeCodeToolDisplayName("MultiEdit")).toBe("edit");
		expect(claudeCodeToolDisplayName("WebSearch")).toBe("web_search");
		expect(claudeCodeToolDisplayName("Task")).toBe("task");
	});
	test("effort", () => {
		expect(claudeCodeEffort(undefined)).toBeUndefined();
		expect(claudeCodeEffort("minimal")).toBe("low");
		expect(claudeCodeEffort("low")).toBe("low");
		expect(claudeCodeEffort("medium")).toBe("medium");
		expect(claudeCodeEffort("high")).toBe("high");
		expect(claudeCodeEffort("xhigh")).toBe("xhigh");
		expect(claudeCodeEffort("max")).toBe("max");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ai && bun test test/claude-agent-sdk-types.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create the types module**

```ts
// packages/ai/src/providers/claude-agent-sdk-types.ts
import type { CursorToolResultHandler, Effort, StreamOptions } from "../types";

export interface ClaudeSdkPermissionRequest {
	toolName: string;
	input: Record<string, unknown>;
	signal: AbortSignal;
}

export type ClaudeSdkPermissionResult = { behavior: "allow" } | { behavior: "deny"; message: string };

/**
 * Host bridge for the claude-agent-sdk provider. Implemented by the
 * coding-agent (session persistence + approval UI); the provider only calls it.
 */
export interface ClaudeSdkHandlers {
	getSdkSessionId(): string | undefined;
	setSdkSessionId(id: string): void;
	resetSdkSession(): void;
	requestToolPermission(req: ClaudeSdkPermissionRequest): Promise<ClaudeSdkPermissionResult>;
	onRateLimit?(info: unknown): void;
}

export interface ClaudeAgentSdkOptions extends StreamOptions {
	cwd?: string;
	claudeSdkHandlers?: ClaudeSdkHandlers;
	/** Sink for provider-executed tool results (the agent's cursorOnToolResult buffer). */
	onToolResult?: CursorToolResultHandler;
}

export type ClaudeCodeToolTier = "read" | "write" | "exec";

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoRead", "TodoWrite", "Task", "Skill"]);
const WRITE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export function claudeCodeToolTier(toolName: string): ClaudeCodeToolTier {
	if (READ_TOOLS.has(toolName)) return "read";
	if (WRITE_TOOLS.has(toolName)) return "write";
	return "exec";
}

const DISPLAY_NAMES: Record<string, string> = {
	Read: "read",
	Edit: "edit",
	MultiEdit: "edit",
	Write: "write",
	Bash: "bash",
	Grep: "grep",
	Glob: "find",
	LS: "ls",
	WebFetch: "fetch",
	WebSearch: "web_search",
};

export function claudeCodeToolDisplayName(toolName: string): string {
	return DISPLAY_NAMES[toolName] ?? toolName.toLowerCase();
}

export function claudeCodeEffort(
	reasoning: Effort | undefined,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
	switch (reasoning) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		case "max":
			return "max";
		default:
			return undefined;
	}
}
```

If `Effort` in `packages/ai/src/types.ts` does not contain `"xhigh"` or `"max"`, drop those cases and the matching test lines; do not widen the omp type.

- [ ] **Step 4: Wire types, registry list, dependency**

`packages/ai/src/types.ts`:
- In `ApiOptionsMap` add `"claude-agent-sdk": ClaudeAgentSdkOptions;` (import type from `./providers/claude-agent-sdk-types`).
- In `StreamOptions` (next to `cursorExecHandlers`) add:

```ts
	/** Host bridge for the claude-agent-sdk provider (session id + tool permission). */
	claudeSdkHandlers?: ClaudeSdkHandlers;
```

`packages/ai/src/api-registry.ts`: append `"claude-agent-sdk",` to `BUILTIN_API_IDS`.

`packages/ai/package.json` dependencies: add `"@anthropic-ai/claude-agent-sdk": "^0.3.224"`. Then `bun install` at the repo root.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd packages/ai && bun test test/claude-agent-sdk-types.test.ts && cd ../.. && bun run typecheck`
Expected: PASS; typecheck should now fail only in `packages/ai/src/stream.ts` (`Unhandled API` switch exhaustiveness, if enforced). Task 3 and 4 resolve it.

- [ ] **Step 6: Commit**

```bash
git add packages/ai/src/providers/claude-agent-sdk-types.ts packages/ai/src/types.ts packages/ai/src/api-registry.ts packages/ai/package.json packages/ai/test/claude-agent-sdk-types.test.ts bun.lock
git commit -m "feat(ai): claude-agent-sdk option types, handler bridge interface, dependency"
```

---

### Task 3: The stream function

**Files:**
- Create: `packages/ai/src/providers/claude-agent-sdk.ts`
- Test: `packages/ai/test/claude-agent-sdk.test.ts`

**Interfaces:**
- Consumes: Task 2 types; `createAssistantMessageEventStream` from `../utils/event-stream` (check the actual export used by `cursor.ts`); `kCursorExecResolved`, `kStreamingBlockKind`, `kStreamingBlockIndex` from `../utils/block-symbols`; `calculateCost` from `@oh-my-pi/pi-catalog/models`.
- Produces: `streamClaudeAgentSdk: StreamFunction<"claude-agent-sdk">`; `setClaudeSdkQueryForTests(fn | undefined)`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/ai/test/claude-agent-sdk.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import type { Context, Model, ToolResultMessage } from "../src/types";
import { setClaudeSdkQueryForTests, streamClaudeAgentSdk } from "../src/providers/claude-agent-sdk";
import type { ClaudeSdkHandlers } from "../src/providers/claude-agent-sdk-types";
import { kCursorExecResolved } from "../src/utils/block-symbols";

const model = {
	id: "opus",
	name: "opus",
	api: "claude-agent-sdk",
	provider: "claude-code",
	baseUrl: "local://claude-code",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 64000,
} as unknown as Model<"claude-agent-sdk">;

function ctx(text = "hi"): Context {
	return { systemPrompt: ["sys"], messages: [{ role: "user", content: text, timestamp: 1 }], tools: [] } as unknown as Context;
}

function handlers(initial?: string): ClaudeSdkHandlers & { id?: string; perms: string[] } {
	const h = {
		id: initial,
		perms: [] as string[],
		getSdkSessionId: () => h.id,
		setSdkSessionId: (id: string) => { h.id = id; },
		resetSdkSession: () => { h.id = undefined; },
		requestToolPermission: async (req: { toolName: string }) => {
			h.perms.push(req.toolName);
			return req.toolName === "Bash" ? { behavior: "deny" as const, message: "no" } : { behavior: "allow" as const };
		},
	};
	return h;
}

const init = { type: "system", subtype: "init", session_id: "sess-1", model: "opus" };
const textEvents = [
	{ type: "stream_event", session_id: "sess-1", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
	{ type: "stream_event", session_id: "sess-1", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } } },
	{ type: "stream_event", session_id: "sess-1", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } },
	{ type: "stream_event", session_id: "sess-1", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } },
];
const success = { type: "result", subtype: "success", session_id: "sess-1", is_error: false, result: "hello", usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } };

function fake(messages: unknown[], capture?: { params?: unknown }) {
	return (params: unknown) => {
		if (capture) capture.params = params;
		async function* gen() { for (const m of messages) yield m; }
		return gen();
	};
}

async function collect(stream: AsyncIterable<{ type: string }>) {
	const out: { type: string }[] = [];
	for await (const e of stream) out.push(e);
	return out;
}

afterEach(() => setClaudeSdkQueryForTests(undefined));

describe("streamClaudeAgentSdk", () => {
	test("streams text and finishes with usage", async () => {
		setClaudeSdkQueryForTests(fake([init, ...textEvents, success]) as never);
		const events = await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: handlers() }));
		expect(events.map(e => e.type)).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
		const done = events.at(-1) as { message: { usage: { input: number; output: number; cacheRead: number; cacheWrite: number } } };
		expect(done.message.usage).toMatchObject({ input: 10, output: 2, cacheRead: 3, cacheWrite: 4 });
	});

	test("captures session id from init and passes resume next time", async () => {
		const h = handlers();
		setClaudeSdkQueryForTests(fake([init, success]) as never);
		await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: h }));
		expect(h.id).toBe("sess-1");
		const capture: { params?: { options?: { resume?: string }; prompt?: unknown } } = {};
		setClaudeSdkQueryForTests(fake([init, success], capture) as never);
		await collect(streamClaudeAgentSdk(model, ctx("second"), { claudeSdkHandlers: h }));
		expect(capture.params?.options?.resume).toBe("sess-1");
		expect(capture.params?.prompt).toBe("second");
	});

	test("without a session id the prompt is the flattened history", async () => {
		const capture: { params?: { prompt?: unknown } } = {};
		setClaudeSdkQueryForTests(fake([init, success], capture) as never);
		const c = ctx("later");
		c.messages.unshift({ role: "assistant", content: [{ type: "text", text: "earlier reply" }], timestamp: 0 } as never);
		c.messages.unshift({ role: "user", content: "first", timestamp: 0 } as never);
		await collect(streamClaudeAgentSdk(model, c, { claudeSdkHandlers: handlers() }));
		expect(String(capture.params?.prompt)).toContain("first");
		expect(String(capture.params?.prompt)).toContain("earlier reply");
		expect(String(capture.params?.prompt)).toContain("later");
	});

	test("tool_use becomes a resolved toolCall and the tool_result is paired via onToolResult", async () => {
		const results: ToolResultMessage[] = [];
		const assistantToolUse = { type: "assistant", session_id: "sess-1", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x" } }] } };
		const userToolResult = { type: "user", session_id: "sess-1", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "file body", is_error: false }] } };
		setClaudeSdkQueryForTests(fake([init, assistantToolUse, userToolResult, ...textEvents, success]) as never);
		const events = await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: handlers(), onToolResult: r => { results.push(r); return undefined; } }));
		const tc = events.find(e => e.type === "toolcall_end") as { toolCall: Record<PropertyKey, unknown> };
		expect(tc.toolCall.name).toBe("read");
		expect(tc.toolCall.id).toBe("tu1");
		expect(tc.toolCall[kCursorExecResolved]).toBe(true);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ toolCallId: "tu1", toolName: "read", isError: false });
		expect((events.at(-1) as { reason: string }).reason).toBe("stop");
	});

	test("canUseTool routes to handlers.requestToolPermission", async () => {
		const h = handlers();
		const capture: { params?: { options?: { canUseTool?: (n: string, i: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<unknown> } } } = {};
		setClaudeSdkQueryForTests(fake([init, success], capture) as never);
		await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: h }));
		const canUseTool = capture.params?.options?.canUseTool!;
		expect(await canUseTool("Read", {}, { signal: new AbortController().signal })).toEqual({ behavior: "allow" });
		expect(await canUseTool("Bash", { command: "rm" }, { signal: new AbortController().signal })).toMatchObject({ behavior: "deny" });
		expect(h.perms).toEqual(["Read", "Bash"]);
	});

	test("error result becomes an error event", async () => {
		setClaudeSdkQueryForTests(fake([init, { type: "result", subtype: "error_during_execution", session_id: "sess-1", is_error: true, errors: ["boom"], usage: {} }]) as never);
		const events = await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: handlers() }));
		const last = events.at(-1) as { type: string; reason: string; error: { errorMessage?: string } };
		expect(last.type).toBe("error");
		expect(last.reason).toBe("error");
		expect(last.error.errorMessage).toContain("boom");
	});

	test("not-logged-in failure names claude login", async () => {
		setClaudeSdkQueryForTests((() => { async function* gen() { throw new Error("Not logged in · Please run /login"); } return gen(); }) as never);
		const events = await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: handlers() }));
		const last = events.at(-1) as { type: string; error: { errorMessage?: string } };
		expect(last.type).toBe("error");
		expect(last.error.errorMessage).toContain("claude login");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/ai && bun test test/claude-agent-sdk.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the stream function**

Read first: how `cursor.ts` creates its stream (`createAssistantMessageEventStream` import and the `output` AssistantMessage skeleton in `streamCursor` ~line 494-560), and `endCurrentTextBlock`/`endCurrentThinkingBlock` helpers there. Copy the small helpers you need into this file rather than importing cursor internals.

```ts
// packages/ai/src/providers/claude-agent-sdk.ts
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import * as AIError from "../error";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	StreamFunction,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { kCursorExecResolved, kStreamingBlockIndex, kStreamingBlockKind } from "../utils/block-symbols";
import { createAssistantMessageEventStream } from "../utils/event-stream";
import {
	type ClaudeAgentSdkOptions,
	type ClaudeSdkPermissionResult,
	claudeCodeEffort,
	claudeCodeToolDisplayName,
} from "./claude-agent-sdk-types";

type QueryFn = (params: { prompt: unknown; options?: Record<string, unknown> }) => AsyncIterable<unknown>;

let queryOverride: QueryFn | undefined;
/** Test seam: inject a fake `query`. */
export function setClaudeSdkQueryForTests(fn: QueryFn | undefined): void {
	queryOverride = fn;
}

async function loadQuery(): Promise<QueryFn> {
	if (queryOverride) return queryOverride;
	const sdk = await import("@anthropic-ai/claude-agent-sdk");
	return sdk.query as unknown as QueryFn;
}

function resolveExecutable(): string | undefined {
	const fromEnv = process.env.OMP_CLAUDE_CODE_EXECUTABLE?.trim();
	if (fromEnv) return fromEnv;
	const path = Bun.which("claude");
	return path ?? undefined;
}

function textOf(content: Message["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p): p is TextContent => (p as { type?: string }).type === "text")
		.map(p => p.text)
		.join("\n");
}

function lastUserMessage(context: Context): Message | undefined {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		if (context.messages[i].role === "user") return context.messages[i];
	}
	return undefined;
}

function flattenHistory(context: Context): string {
	return context.messages
		.filter(m => m.role === "user" || m.role === "assistant")
		.map(m => `${m.role}: ${textOf(m.content as Message["content"])}`.trim())
		.filter(Boolean)
		.join("\n\n");
}

function isLoginError(message: string): boolean {
	return /not logged in|\/login|authentication|invalid api key|please run .*login/i.test(message);
}

export const streamClaudeAgentSdk: StreamFunction<"claude-agent-sdk"> = (
	model: Model<"claude-agent-sdk">,
	context: Context,
	options?: ClaudeAgentSdkOptions,
): AssistantMessageEventStream => {
	const stream = createAssistantMessageEventStream();
	const handlers = options?.claudeSdkHandlers;
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "claude-agent-sdk",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	(async () => {
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		// index in SDK stream -> index in output.content
		const openBlocks = new Map<number, number>();
		const endedStreamedIndexes = new Set<number>();
		let started = false;
		const ensureStart = () => {
			if (started) return;
			started = true;
			stream.push({ type: "start", partial: output });
		};

		try {
			const query = await loadQuery();
			const resumeId = handlers?.getSdkSessionId();
			const last = lastUserMessage(context);
			const prompt = resumeId ? textOf((last?.content ?? "") as Message["content"]) : flattenHistory(context);
			const effort = claudeCodeEffort(options?.reasoning);
			const canUseTool = async (
				toolName: string,
				input: Record<string, unknown>,
				opts: { signal: AbortSignal },
			): Promise<ClaudeSdkPermissionResult> => {
				if (!handlers) return { behavior: "allow" };
				return handlers.requestToolPermission({ toolName, input, signal: opts.signal });
			};
			const q = query({
				prompt,
				options: {
					model: model.id,
					cwd: options?.cwd,
					resume: resumeId,
					includePartialMessages: true,
					abortController: abort,
					systemPrompt: {
						type: "preset",
						preset: "claude_code",
						append: context.systemPrompt?.length ? context.systemPrompt.join("\n\n") : undefined,
					},
					...(effort ? { effort } : {}),
					canUseTool,
					pathToClaudeCodeExecutable: resolveExecutable(),
					env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "oh-my-pi" },
				},
			});

			for await (const raw of q) {
				const msg = raw as Record<string, unknown>;
				if (abort.signal.aborted) break;
				switch (msg.type) {
					case "system": {
						if (msg.subtype === "init" && typeof msg.session_id === "string") handlers?.setSdkSessionId(msg.session_id);
						break;
					}
					case "rate_limit_event": {
						handlers?.onRateLimit?.(msg.rate_limit_info);
						break;
					}
					case "stream_event": {
						if (msg.parent_tool_use_id) break;
						ensureStart();
						handleStreamEvent(msg.event as Record<string, unknown>, output, stream, openBlocks, endedStreamedIndexes);
						break;
					}
					case "assistant": {
						if (msg.parent_tool_use_id) break;
						ensureStart();
						handleAssistantMessage(msg.message as { content: unknown[] }, output, stream, endedStreamedIndexes);
						break;
					}
					case "user": {
						if (msg.parent_tool_use_id) break;
						await handleUserMessage(msg.message as { content: unknown }, options?.onToolResult);
						break;
					}
					case "result": {
						ensureStart();
						closeOpenBlocks(output, stream, openBlocks);
						applyUsage(output, model, msg.usage as Record<string, number> | undefined);
						if (msg.is_error) {
							const errText = Array.isArray(msg.errors) ? msg.errors.join("; ") : String(msg.result ?? msg.subtype ?? "Claude Code failed");
							output.stopReason = "error";
							output.errorMessage = errText;
							stream.push({ type: "error", reason: "error", error: output });
							return;
						}
						output.stopReason = "stop";
						stream.push({ type: "done", reason: "stop", message: output });
						return;
					}
					default:
						break;
				}
			}
			// Generator ended without a result message.
			ensureStart();
			closeOpenBlocks(output, stream, openBlocks);
			if (abort.signal.aborted) {
				output.stopReason = "aborted";
				stream.push({ type: "error", reason: "aborted", error: output });
			} else {
				stream.push({ type: "done", reason: "stop", message: output });
			}
		} catch (err) {
			ensureStart();
			closeOpenBlocks(output, stream, openBlocks);
			const message = err instanceof Error ? err.message : String(err);
			if (abort.signal.aborted) {
				output.stopReason = "aborted";
				output.errorMessage = message;
				stream.push({ type: "error", reason: "aborted", error: output });
				return;
			}
			output.stopReason = "error";
			output.errorMessage = isLoginError(message)
				? `Claude Code is not logged in. Run 'claude login' in a terminal, then retry. (${message})`
				: message;
			stream.push({ type: "error", reason: "error", error: output });
		} finally {
			options?.signal?.removeEventListener("abort", onAbort);
			stream.end();
		}
	})();

	return stream;
};

function handleStreamEvent(
	event: Record<string, unknown>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	openBlocks: Map<number, number>,
	ended: Set<number>,
): void {
	const index = Number(event.index ?? -1);
	switch (event.type) {
		case "content_block_start": {
			const block = event.content_block as { type?: string } | undefined;
			if (block?.type === "text") {
				output.content.push({ type: "text", text: "" });
				openBlocks.set(index, output.content.length - 1);
				stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
			} else if (block?.type === "thinking") {
				output.content.push({ type: "thinking", thinking: "" } as ThinkingContent);
				openBlocks.set(index, output.content.length - 1);
				stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
			}
			// tool_use blocks are taken from the full `assistant` message instead.
			break;
		}
		case "content_block_delta": {
			const ci = openBlocks.get(index);
			if (ci === undefined) break;
			const delta = event.delta as { type?: string; text?: string; thinking?: string };
			const target = output.content[ci];
			if (delta.type === "text_delta" && target.type === "text") {
				target.text += delta.text ?? "";
				stream.push({ type: "text_delta", contentIndex: ci, delta: delta.text ?? "", partial: output });
			} else if (delta.type === "thinking_delta" && target.type === "thinking") {
				target.thinking += delta.thinking ?? "";
				stream.push({ type: "thinking_delta", contentIndex: ci, delta: delta.thinking ?? "", partial: output });
			}
			break;
		}
		case "content_block_stop": {
			const ci = openBlocks.get(index);
			if (ci === undefined) break;
			openBlocks.delete(index);
			ended.add(ci);
			const target = output.content[ci];
			if (target.type === "text") stream.push({ type: "text_end", contentIndex: ci, content: target.text, partial: output });
			else if (target.type === "thinking") stream.push({ type: "thinking_end", contentIndex: ci, content: target.thinking, partial: output });
			break;
		}
		default:
			break;
	}
}

function closeOpenBlocks(output: AssistantMessage, stream: AssistantMessageEventStream, openBlocks: Map<number, number>): void {
	for (const ci of openBlocks.values()) {
		const target = output.content[ci];
		if (target.type === "text") stream.push({ type: "text_end", contentIndex: ci, content: target.text, partial: output });
		else if (target.type === "thinking") stream.push({ type: "thinking_end", contentIndex: ci, content: target.thinking, partial: output });
	}
	openBlocks.clear();
}

function handleAssistantMessage(
	message: { content: unknown[] },
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	ended: Set<number>,
): void {
	const streamedText = ended.size > 0;
	for (const raw of message.content ?? []) {
		const block = raw as { type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string; thinking?: string };
		if (block.type === "tool_use" && block.id && block.name) {
			const toolCall: ToolCall & Record<symbol, unknown> = {
				type: "toolCall",
				id: block.id,
				name: claudeCodeToolDisplayName(block.name),
				arguments: block.input ?? {},
				[kStreamingBlockIndex]: output.content.length,
				[kStreamingBlockKind]: "claude-sdk",
				[kCursorExecResolved]: true,
			};
			output.content.push(toolCall);
			const ci = output.content.length - 1;
			stream.push({ type: "toolcall_start", contentIndex: ci, partial: output });
			stream.push({ type: "toolcall_end", contentIndex: ci, toolCall, partial: output });
		} else if (block.type === "text" && !streamedText && block.text) {
			// Non-streaming fallback: no stream_event arrived for this text.
			output.content.push({ type: "text", text: block.text });
			const ci = output.content.length - 1;
			stream.push({ type: "text_start", contentIndex: ci, partial: output });
			stream.push({ type: "text_delta", contentIndex: ci, delta: block.text, partial: output });
			stream.push({ type: "text_end", contentIndex: ci, content: block.text, partial: output });
		}
	}
}

const toolNamesById = new Map<string, string>();

async function handleUserMessage(
	message: { content: unknown },
	onToolResult: ClaudeAgentSdkOptions["onToolResult"],
): Promise<void> {
	if (!Array.isArray(message.content) || !onToolResult) return;
	for (const raw of message.content) {
		const block = raw as { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
		if (block.type !== "tool_result" || !block.tool_use_id) continue;
		const text = typeof block.content === "string"
			? block.content
			: Array.isArray(block.content)
				? block.content.map(c => (c as { text?: string }).text ?? "").join("\n")
				: "";
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: block.tool_use_id,
			toolName: toolNamesById.get(block.tool_use_id) ?? "tool",
			content: [{ type: "text", text }],
			isError: Boolean(block.is_error),
			timestamp: Date.now(),
		} as ToolResultMessage;
		await onToolResult(result);
	}
}

function applyUsage(output: AssistantMessage, model: Model<"claude-agent-sdk">, usage: Record<string, number> | undefined): void {
	if (!usage) return;
	output.usage.input = usage.input_tokens ?? 0;
	output.usage.output = usage.output_tokens ?? 0;
	output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
	output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
}
```

Two required fixes while implementing, do not skip:
1. `toolNamesById` must be populated in `handleAssistantMessage` (`toolNamesById.set(block.id, claudeCodeToolDisplayName(block.name))`) and must be per-stream state, not module-level. Move it into the closure and pass it to both helpers.
2. `ToolResultMessage` may not have `timestamp`; match the real interface in `packages/ai/src/types.ts:941`. If `AssistantMessage` lacks `errorMessage`, check how `cursor.ts` reports errors and mirror it.

- [ ] **Step 4: Run tests until green**

Run: `cd packages/ai && bun test test/claude-agent-sdk.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/providers/claude-agent-sdk.ts packages/ai/test/claude-agent-sdk.test.ts
git commit -m "feat(ai): claude-agent-sdk stream function"
```

---

### Task 4: Dispatch wiring in stream.ts and agent option threading

**Files:**
- Modify: `packages/ai/src/stream.ts` (switch at ~1014 and simple-options switch at ~2284)
- Modify: `packages/agent/src/agent.ts` (options interface ~line 276; stream options at ~1428)
- Test: `packages/ai/test/claude-agent-sdk-dispatch.test.ts`

**Interfaces:**
- Consumes: `streamClaudeAgentSdk`, `ClaudeAgentSdkOptions`, `ClaudeSdkHandlers`.
- Produces: `AgentOptions.claudeSdkHandlers?: ClaudeSdkHandlers` reaching `StreamOptions.claudeSdkHandlers`; `ClaudeAgentSdkOptions.onToolResult` is the agent's `cursorOnToolResult` sink.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ai/test/claude-agent-sdk-dispatch.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { setClaudeSdkQueryForTests } from "../src/providers/claude-agent-sdk";
import { streamSimple } from "../src/stream";
import type { Context, Model } from "../src/types";

afterEach(() => setClaudeSdkQueryForTests(undefined));

describe("claude-agent-sdk dispatch", () => {
	test("streamSimple routes claude-agent-sdk models to the SDK provider", async () => {
		let called = false;
		setClaudeSdkQueryForTests((() => { called = true; async function* gen() {
			yield { type: "system", subtype: "init", session_id: "s" };
			yield { type: "result", subtype: "success", is_error: false, result: "", usage: {} };
		} return gen(); }) as never);
		const model = { id: "opus", api: "claude-agent-sdk", provider: "claude-code", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1, baseUrl: "local://claude-code" } as unknown as Model<"claude-agent-sdk">;
		const context = { systemPrompt: [], messages: [{ role: "user", content: "x", timestamp: 1 }], tools: [] } as unknown as Context;
		const events: string[] = [];
		for await (const e of streamSimple(model, context, { apiKey: "claude-code-login" })) events.push(e.type);
		expect(called).toBe(true);
		expect(events.at(-1)).toBe("done");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ai && bun test test/claude-agent-sdk-dispatch.test.ts`
Expected: FAIL with `Unhandled API: claude-agent-sdk`.

- [ ] **Step 3: Wire dispatch**

In `packages/ai/src/stream.ts`:

Import: `import { streamClaudeAgentSdk } from "./providers/claude-agent-sdk";` and `import type { ClaudeAgentSdkOptions } from "./providers/claude-agent-sdk-types";`

In `streamDispatch` switch, after `case "devin-agent"`:

```ts
		case "claude-agent-sdk":
			return streamClaudeAgentSdk(
				providerModel as Model<"claude-agent-sdk">,
				context,
				providerOptions as ClaudeAgentSdkOptions,
			);
```

In the simple-options mapping switch (the one with `case "cursor-agent": { const execHandlers = ... }`), add:

```ts
		case "claude-agent-sdk":
			return castApi<"claude-agent-sdk">({
				...base,
				cwd: options?.cwd,
				claudeSdkHandlers: options?.claudeSdkHandlers,
				onToolResult: options?.cursorOnToolResult,
			});
```

Also check `streamSimple`'s auth gate: `claude-code` models have no real key. Find where `streamSimple` throws when `apiKey` is missing (grep `allowsMissingApiKey` / `apiKey` checks near the top of `streamSimple`) and make sure `claude-agent-sdk` is treated like providers with `allowsMissingApiKey` (Task 5 sets that on the registry def; confirm the runtime path consults it).

In `packages/agent/src/agent.ts`:
- Add to the options interface next to `cursorExecHandlers`:

```ts
	/** Host bridge for the claude-agent-sdk provider (session id + tool permission). */
	claudeSdkHandlers?: ClaudeSdkHandlers;
```

- Store it (`#claudeSdkHandlers`) in the constructor beside `#cursorExecHandlers`, and pass `claudeSdkHandlers: this.#claudeSdkHandlers,` next to `cursorExecHandlers: this.#cursorExecHandlers,` at ~line 1428. Confirm that the agent-loop forwards unknown option fields into the stream options (follow how `cursorExecHandlers` travels from that object into the call at `stream.ts:2285`; add `claudeSdkHandlers` at each hop the same way).

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/ai && bun test test/claude-agent-sdk-dispatch.test.ts test/claude-agent-sdk.test.ts && cd ../.. && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/stream.ts packages/agent/src/agent.ts packages/ai/test/claude-agent-sdk-dispatch.test.ts
git commit -m "feat(ai,agent): dispatch claude-agent-sdk and thread the handler bridge"
```

---

### Task 5: Provider definition with Claude Code login detection

**Files:**
- Create: `packages/ai/src/registry/claude-code.ts`
- Modify: `packages/ai/src/registry/registry.ts` (import + `ALL`)
- Test: `packages/ai/test/claude-code-login.test.ts`

**Interfaces:**
- Produces: `claudeCodeProvider` (`id: "claude-code"`), `detectClaudeCodeLogin(home?: string): Promise<{ found: boolean; source: "keychain" | "credentialsFile" | "claudeConfig" | "env" | null; account: string | null }>`, `CLAUDE_CODE_LOGIN_PLACEHOLDER = "claude-code-login"`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/ai/test/claude-code-login.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectClaudeCodeLogin } from "../src/registry/claude-code";

let home: string;
const savedKey = process.env.ANTHROPIC_API_KEY;
const savedTok = process.env.ANTHROPIC_AUTH_TOKEN;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "omp-claude-code-"));
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_AUTH_TOKEN;
	process.env.OMP_CLAUDE_CODE_SKIP_KEYCHAIN = "1";
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
	if (savedTok !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedTok;
	delete process.env.OMP_CLAUDE_CODE_SKIP_KEYCHAIN;
});

describe("detectClaudeCodeLogin", () => {
	test("nothing present", async () => {
		expect(await detectClaudeCodeLogin(home)).toEqual({ found: false, source: null, account: null });
	});
	test("credentials file wins and borrows the account label", async () => {
		mkdirSync(join(home, ".claude"));
		writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
		writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }));
		expect(await detectClaudeCodeLogin(home)).toEqual({ found: true, source: "credentialsFile", account: "a@b.c" });
	});
	test("claude config marker alone", async () => {
		writeFileSync(join(home, ".claude.json"), JSON.stringify({ userID: "u1" }));
		expect(await detectClaudeCodeLogin(home)).toMatchObject({ found: true, source: "claudeConfig" });
	});
	test("env fallback", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-test";
		expect(await detectClaudeCodeLogin(home)).toMatchObject({ found: true, source: "env" });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ai && bun test test/claude-code-login.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// packages/ai/src/registry/claude-code.ts
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const execFileAsync = promisify(execFile);

export const CLAUDE_CODE_LOGIN_PLACEHOLDER = "claude-code-login";

export interface ClaudeCodeLoginState {
	found: boolean;
	source: "keychain" | "credentialsFile" | "claudeConfig" | "env" | null;
	account: string | null;
}

function fileHasContent(path: string): boolean {
	try {
		return statSync(path).size > 0;
	} catch {
		return false;
	}
}

function readAccountLabel(home: string): { marker: boolean; label: string | null } {
	try {
		const raw = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as Record<string, unknown>;
		const acct = (raw.oauthAccount ?? null) as Record<string, unknown> | null;
		const label =
			(typeof acct?.emailAddress === "string" && acct.emailAddress) ||
			(typeof acct?.displayName === "string" && acct.displayName) ||
			null;
		const marker = Boolean(label || (acct && typeof acct.accountUuid === "string") || typeof raw.userID === "string");
		return { marker, label };
	} catch {
		return { marker: false, label: null };
	}
}

async function keychainHasCredentials(): Promise<boolean> {
	if (process.platform !== "darwin" || process.env.OMP_CLAUDE_CODE_SKIP_KEYCHAIN) return false;
	try {
		await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials"], { timeout: 3000 });
		return true;
	} catch {
		return false;
	}
}

/** Detect Claude Code's own login state. Never throws. */
export async function detectClaudeCodeLogin(home: string = homedir()): Promise<ClaudeCodeLoginState> {
	const { marker, label } = readAccountLabel(home);
	if (await keychainHasCredentials()) return { found: true, source: "keychain", account: label };
	if (fileHasContent(join(home, ".claude", ".credentials.json"))) return { found: true, source: "credentialsFile", account: label };
	if (marker) return { found: true, source: "claudeConfig", account: label };
	if (process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim()) return { found: true, source: "env", account: null };
	return { found: false, source: null, account: null };
}

export const claudeCodeProvider = {
	id: "claude-code",
	name: "Claude Code (subscription)",
	allowsMissingApiKey: true,
	login: async (cb: OAuthLoginCallbacks) => {
		cb.onProgress?.("Checking Claude Code login state...");
		const state = await detectClaudeCodeLogin();
		if (!state.found) {
			throw new Error("Claude Code is not logged in. Run 'claude login' in a terminal, then retry /login claude-code.");
		}
		cb.onProgress?.(`Claude Code login found (${state.source}${state.account ? `, ${state.account}` : ""}).`);
		return CLAUDE_CODE_LOGIN_PLACEHOLDER;
	},
} as const satisfies ProviderDefinition;
```

Check the macOS keychain service name Claude Code actually uses: run `security dump-keychain 2>/dev/null | grep -i "claude" | head` on this machine, and copy the exact `svce` value into `keychainHasCredentials`. cyboflow's `main/src/utils/claudeCredentials.ts` `probeKeychain` has the working value; prefer that.

In `packages/ai/src/registry/registry.ts`: `import { claudeCodeProvider } from "./claude-code";` and add `claudeCodeProvider,` to `ALL` right after `cursorProvider,`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/ai && bun test test/claude-code-login.test.ts && cd ../.. && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/registry/claude-code.ts packages/ai/src/registry/registry.ts packages/ai/test/claude-code-login.test.ts
git commit -m "feat(ai): claude-code provider definition with Claude Code login detection"
```

---

### Task 6: coding-agent bridge (session id persistence + approval UI)

**Files:**
- Create: `packages/coding-agent/src/claude-sdk-bridge.ts`
- Modify: `packages/coding-agent/src/sdk.ts` (near `new CursorExecHandlers(` at ~2774 and the `Agent` options at ~3262)
- Test: `packages/coding-agent/test/claude-sdk-bridge.test.ts`

**Interfaces:**
- Consumes: `ClaudeSdkHandlers`, `ClaudeSdkPermissionRequest`, `ClaudeSdkPermissionResult`, `claudeCodeToolTier` from `@oh-my-pi/pi-ai` (export them from `packages/ai/src/index.ts` if not already re-exported; check how `CursorExecHandlers` types are exported); `resolveApproval`, `formatApprovalPrompt`, `truncateForPrompt`, `ApprovalMode` from `./tools/approval`.
- Produces:

```ts
export const CLAUDE_SDK_SESSION_CUSTOM_TYPE = "claude_sdk_session";
export interface ClaudeSdkBridgeOptions {
	getSettings(): { get(key: string): unknown } | undefined;
	isAutoApprove(): boolean;
	hasUI(): boolean;
	select(prompt: string, choices: string[], opts: { signal?: AbortSignal }): Promise<string | undefined>;
	loadPersistedSessionId(): string | undefined;
	persistSessionId(id: string | undefined): void;
}
export class ClaudeSdkBridge implements ClaudeSdkHandlers
```

- [ ] **Step 1: Write the failing test**

```ts
// packages/coding-agent/test/claude-sdk-bridge.test.ts
import { describe, expect, test } from "bun:test";
import { ClaudeSdkBridge } from "../src/claude-sdk-bridge";

function bridge(overrides: Partial<ConstructorParameters<typeof ClaudeSdkBridge>[0]> = {}, settings: Record<string, unknown> = {}) {
	let persisted: string | undefined;
	const selections: string[] = [];
	const b = new ClaudeSdkBridge({
		getSettings: () => ({ get: (k: string) => settings[k] }),
		isAutoApprove: () => false,
		hasUI: () => true,
		select: async prompt => { selections.push(prompt); return "Approve"; },
		loadPersistedSessionId: () => persisted,
		persistSessionId: id => { persisted = id; },
		...overrides,
	});
	return { b, selections, get persisted() { return persisted; } };
}

describe("ClaudeSdkBridge", () => {
	test("session id round-trips and resets", () => {
		const t = bridge();
		expect(t.b.getSdkSessionId()).toBeUndefined();
		t.b.setSdkSessionId("s1");
		expect(t.b.getSdkSessionId()).toBe("s1");
		expect(t.persisted).toBe("s1");
		t.b.resetSdkSession();
		expect(t.b.getSdkSessionId()).toBeUndefined();
	});
	test("read tier auto-allows under write mode without prompting", async () => {
		const t = bridge({}, { "tools.approvalMode": "write" });
		const r = await t.b.requestToolPermission({ toolName: "Read", input: { file_path: "/x" }, signal: new AbortController().signal });
		expect(r).toEqual({ behavior: "allow" });
		expect(t.selections).toHaveLength(0);
	});
	test("exec tier prompts under write mode and honors Deny", async () => {
		const t = bridge({ select: async () => "Deny" }, { "tools.approvalMode": "write" });
		const r = await t.b.requestToolPermission({ toolName: "Bash", input: { command: "rm -rf /" }, signal: new AbortController().signal });
		expect(r).toMatchObject({ behavior: "deny" });
	});
	test("user policy deny wins", async () => {
		const t = bridge({}, { "tools.approvalMode": "yolo", "tools.approval": { "claude-code.Bash": "deny" } });
		const r = await t.b.requestToolPermission({ toolName: "Bash", input: {}, signal: new AbortController().signal });
		expect(r).toMatchObject({ behavior: "deny" });
	});
	test("no UI and prompt required denies with guidance", async () => {
		const t = bridge({ hasUI: () => false }, { "tools.approvalMode": "always-ask" });
		const r = await t.b.requestToolPermission({ toolName: "Edit", input: {}, signal: new AbortController().signal });
		expect(r).toMatchObject({ behavior: "deny" });
		expect((r as { message: string }).message).toContain("approvalMode");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/coding-agent && bun test test/claude-sdk-bridge.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the bridge**

```ts
// packages/coding-agent/src/claude-sdk-bridge.ts
import type { ClaudeSdkHandlers, ClaudeSdkPermissionRequest, ClaudeSdkPermissionResult } from "@oh-my-pi/pi-ai";
import { claudeCodeToolTier } from "@oh-my-pi/pi-ai";
import { type ApprovalMode, resolveApproval, truncateForPrompt } from "./tools/approval";

export const CLAUDE_SDK_SESSION_CUSTOM_TYPE = "claude_sdk_session";

export interface ClaudeSdkBridgeOptions {
	getSettings(): { get(key: string): unknown } | undefined;
	isAutoApprove(): boolean;
	hasUI(): boolean;
	select(prompt: string, choices: string[], opts: { signal?: AbortSignal }): Promise<string | undefined>;
	loadPersistedSessionId(): string | undefined;
	persistSessionId(id: string | undefined): void;
}

/** Host side of the claude-agent-sdk provider: session continuity + approval routing. */
export class ClaudeSdkBridge implements ClaudeSdkHandlers {
	#sessionId: string | undefined;
	#loaded = false;

	constructor(private readonly options: ClaudeSdkBridgeOptions) {}

	getSdkSessionId(): string | undefined {
		if (!this.#loaded) {
			this.#sessionId = this.options.loadPersistedSessionId();
			this.#loaded = true;
		}
		return this.#sessionId;
	}

	setSdkSessionId(id: string): void {
		this.#loaded = true;
		if (this.#sessionId === id) return;
		this.#sessionId = id;
		this.options.persistSessionId(id);
	}

	resetSdkSession(): void {
		this.#loaded = true;
		if (this.#sessionId === undefined) return;
		this.#sessionId = undefined;
		this.options.persistSessionId(undefined);
	}

	async requestToolPermission(req: ClaudeSdkPermissionRequest): Promise<ClaudeSdkPermissionResult> {
		const settings = this.options.getSettings();
		const mode: ApprovalMode = this.options.isAutoApprove()
			? "yolo"
			: ((settings?.get("tools.approvalMode") as ApprovalMode | undefined) ?? "yolo");
		const userPolicies = (settings?.get("tools.approval") ?? {}) as Record<string, unknown>;
		const tier = claudeCodeToolTier(req.toolName);
		const subject = { name: `claude-code.${req.toolName}`, approval: tier } as Parameters<typeof resolveApproval>[0];
		const resolved = resolveApproval(subject, req.input, mode, userPolicies);
		if (resolved.policy === "allow") return { behavior: "allow" };
		if (resolved.policy === "deny") {
			return { behavior: "deny", message: `Tool "${req.toolName}" is blocked by omp policy (tools.approval.claude-code.${req.toolName}: deny).` };
		}
		if (!this.options.hasUI()) {
			return {
				behavior: "deny",
				message:
					`Tool "${req.toolName}" requires approval but omp has no interactive UI. ` +
					`Set tools.approvalMode: yolo or tools.approval.claude-code.${req.toolName}: allow.`,
			};
		}
		const prompt = `Claude Code wants to run ${req.toolName} (${tier}):\n${truncateForPrompt(JSON.stringify(req.input, null, 2))}`;
		let choice: string | undefined;
		try {
			choice = await this.options.select(prompt, ["Approve", "Deny"], { signal: req.signal });
		} catch {
			return { behavior: "deny", message: "Approval aborted in omp." };
		}
		return choice === "Approve" ? { behavior: "allow" } : { behavior: "deny", message: "Denied by user in omp." };
	}
}
```

Check `resolveApproval`'s first parameter type (`ApprovalSubject = Pick<AgentTool, "name" | "approval" | "formatApprovalDetails">`) and pass `approval` in the shape it expects (a bare tier string is accepted per the `isToolTier` branch in `tools/approval.ts`). Check `truncateForPrompt`'s signature. Export the three `ClaudeSdk*` types and `claudeCodeToolTier` from `packages/ai/src/index.ts` next to the cursor exports.

- [ ] **Step 4: Wire it in sdk.ts**

Next to `const cursorExecHandlers = new CursorExecHandlers({` in `packages/coding-agent/src/sdk.ts`:

```ts
		const claudeSdkBridge = new ClaudeSdkBridge({
			getSettings: () => toolContextStore.getContext()?.settings ?? settings,
			isAutoApprove: () => toolContextStore.getContext()?.autoApprove === true,
			hasUI: () => extensionRunner?.hasUI() ?? false,
			select: (prompt, choices, opts) => extensionRunner!.getUIContext().select(prompt, choices, opts),
			loadPersistedSessionId: () => {
				let id: string | undefined;
				for (const entry of sessionManager.getEntries()) {
					if (entry.type === "custom" && entry.customType === CLAUDE_SDK_SESSION_CUSTOM_TYPE) {
						id = (entry.data as { sdkSessionId?: string } | undefined)?.sdkSessionId;
					}
				}
				return id;
			},
			persistSessionId: id => {
				sessionManager.appendCustomEntry(CLAUDE_SDK_SESSION_CUSTOM_TYPE, { sdkSessionId: id });
			},
		});
```

Use the real names in scope at that point of `sdk.ts` for the settings object, the extension runner, and the session entries iterator (follow how `USER_TODO_EDIT_CUSTOM_TYPE` is read back in `packages/coding-agent/src/tools/todo.ts:180` for the entry-walk API). Then add `claudeSdkHandlers: claudeSdkBridge,` next to `cursorExecHandlers,` in the `new Agent({...})` options.

Reset hooks: wherever `sdk.ts` or `session/agent-session.ts` handles compaction completion, `/clear`, fork, and branch/tree switch, call `claudeSdkBridge.resetSdkSession()`. Find them with `grep -n "compaction\|clearSession\|fork\|switchBranch" packages/coding-agent/src/session/agent-session.ts | head -30` and add one call at each. The last persisted `claude_sdk_session` entry with `sdkSessionId: undefined` reads back as "no session", which the loader above already handles.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd packages/coding-agent && bun test test/claude-sdk-bridge.test.ts && cd ../.. && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/claude-sdk-bridge.ts packages/coding-agent/src/sdk.ts packages/coding-agent/src/session/agent-session.ts packages/ai/src/index.ts packages/coding-agent/test/claude-sdk-bridge.test.ts
git commit -m "feat(coding-agent): claude sdk bridge for session resume and tool approval"
```

---

### Task 7: Effort controls, docs, smoke script

**Files:**
- Modify: `packages/coding-agent/src/thinking.ts`, `packages/coding-agent/src/session/model-controls.ts` (only if the static `thinking.efforts` from Task 1 is not enough for the effort picker to show `low..max`)
- Create: `packages/ai/scripts/claude-sdk-smoke.ts`
- Modify: `docs/providers.md` (provider table + OAuth-backed list), `docs/provider-endpoint-constraints.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Verify effort picker**

Run `bun packages/coding-agent/src/cli.ts --model claude-code/opus --help` (or the repo's dev entry, see `packages/coding-agent/package.json` scripts) and confirm the model resolves. In a dev session run `/thinking` and confirm the ladder shows low, medium, high, xhigh, max. If it does not, follow the `devin-agent` comments in `thinking.ts:241` and `model-controls.ts:591` and add the analogous `claude-agent-sdk` branch that trusts `thinking.efforts` from the model spec.

- [ ] **Step 2: Smoke script**

```ts
// packages/ai/scripts/claude-sdk-smoke.ts
// Live check against the real subscription. Run: OMP_CLAUDE_SDK_SMOKE=1 bun packages/ai/scripts/claude-sdk-smoke.ts
import { streamClaudeAgentSdk } from "../src/providers/claude-agent-sdk";
import type { Context, Model } from "../src/types";

if (!process.env.OMP_CLAUDE_SDK_SMOKE) {
	console.log("skipped: set OMP_CLAUDE_SDK_SMOKE=1");
	process.exit(0);
}

const model = {
	id: process.env.OMP_CLAUDE_SDK_MODEL ?? "sonnet",
	name: "smoke",
	api: "claude-agent-sdk",
	provider: "claude-code",
	baseUrl: "local://claude-code",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
} as unknown as Model<"claude-agent-sdk">;

let sessionId: string | undefined;
const handlers = {
	getSdkSessionId: () => sessionId,
	setSdkSessionId: (id: string) => { sessionId = id; },
	resetSdkSession: () => { sessionId = undefined; },
	requestToolPermission: async () => ({ behavior: "deny" as const, message: "smoke test: no tools" }),
};

const context = { systemPrompt: [], messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }], tools: [] } as unknown as Context;
let text = "";
for await (const e of streamClaudeAgentSdk(model, context, { claudeSdkHandlers: handlers, cwd: process.cwd() })) {
	if (e.type === "text_delta") text += e.delta;
	if (e.type === "error") { console.error("ERROR", e.error.errorMessage); process.exit(1); }
}
if (!/OK/.test(text)) { console.error("unexpected reply:", JSON.stringify(text)); process.exit(1); }
if (!sessionId) { console.error("no session id captured"); process.exit(1); }
console.log("OK", { sessionId, text: text.trim() });
```

Run: `OMP_CLAUDE_SDK_SMOKE=1 bun packages/ai/scripts/claude-sdk-smoke.ts`
Expected: prints `OK { sessionId: "...", text: "OK" }`. If it fails with a login error, run `claude login` and retry; if it fails otherwise, fix the provider before continuing.

- [ ] **Step 3: Docs**

`docs/providers.md`: add a row to the provider env table: `` `claude-code` `` with `none (uses Claude Code's own login; run \`claude login\`)`, and add `claude-code` to the OAuth-backed providers sentence near line 152 with the note "detects Claude Code's login instead of running OAuth". Add a short subsection:

```markdown
### Claude Code (subscription)

`claude-code` runs turns through the Claude Agent SDK, which spawns your installed Claude Code binary. Your Pro/Max/Team subscription is billed the same way Claude Code bills it, and no token is stored in omp. Log in once with `claude login`, then `/login claude-code` to confirm and `--model claude-code/opus` (aliases `opus`, `sonnet`, `haiku` or explicit ids). Claude Code executes its own tools; omp shows them in the transcript and routes each permission request through `tools.approvalMode` and `tools.approval.claude-code.<Tool>`. Set `OMP_CLAUDE_CODE_EXECUTABLE` to pin a specific binary.
```

`docs/provider-endpoint-constraints.md`: add a `claude-agent-sdk` entry: no HTTP retry, no `toolChoice`, no custom tools (omp tools are not sent), thinking effort via SDK `effort`, session resume by SDK id, results carry token counts with zero cost.

- [ ] **Step 4: Full test run and typecheck**

Run: `bun run typecheck && cd packages/ai && bun test && cd ../catalog && bun test && cd ../coding-agent && bun test test/claude-sdk-bridge.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ai/scripts/claude-sdk-smoke.ts docs/providers.md docs/provider-endpoint-constraints.md packages/coding-agent/src/thinking.ts packages/coding-agent/src/session/model-controls.ts
git commit -m "feat(claude-code): effort controls, docs, live smoke script"
```

---

## Validation gate (run by the orchestrator after all tasks)

1. `bun run typecheck` clean.
2. `cd packages/ai && bun test`, `cd packages/catalog && bun test`, `cd packages/coding-agent && bun test test/claude-sdk-bridge.test.ts` all green.
3. `OMP_CLAUDE_SDK_SMOKE=1 bun packages/ai/scripts/claude-sdk-smoke.ts` prints OK.
4. Interactive check: `omp --model claude-code/sonnet` (dev entry), ask "list the files in this directory"; expect a rendered `bash` or `ls` tool block, an approval prompt under `tools.approvalMode: write`, and a second turn that resumes (no history replay visible in `claude --resume` transcript).
5. `grep -rn "bypassPermissions" packages/ai/src/providers/claude-agent-sdk.ts` returns nothing.
6. `grep -rn "from \"@anthropic-ai/claude-agent-sdk\"" packages --include='*.ts' | grep -v "import type"` returns nothing (only dynamic imports).
