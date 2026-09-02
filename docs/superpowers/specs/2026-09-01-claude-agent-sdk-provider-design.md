# Claude Agent SDK provider (`claude-code` / `claude-agent-sdk`)

Date: 2026-09-01. Status: approved design.

## Why

Anthropic prohibits using a Claude Pro/Max subscription OAuth token from a
non-Anthropic client against the Messages API (Feb 2026 terms, enforced
2026-04-04). omp's built-in `anthropic` OAuth provider does exactly that and
spoofs the Claude Code fingerprint, so it carries account risk.

Anthropic's help center states that third-party apps authenticating with a
subscription *through the Claude Agent SDK* are allowed
(support.claude.com article 15036540). The SDK spawns the real Claude Code
binary, which owns the login; no token ever enters omp.

This spec adds a first-class omp provider that drives the Agent SDK.

## Decisions (from brainstorm)

| Decision | Choice |
| --- | --- |
| Location | Built-in wire API in `packages/ai` + `packages/catalog` (not an extension). |
| Tools in v1 | Claude Code's own tools run inside the SDK; omp renders them as already-resolved tool calls. |
| Continuity | Resume the SDK session by id; send only the newest user message each turn. |
| Permissions | `canUseTool` routes into omp's approval tiers and prompt UI. |

## Identity

- Provider id: `claude-code`. Display name: `Claude Code (subscription)`.
- API id (`KnownApi`): `claude-agent-sdk`.
- Models: fetched at discovery via the SDK `Query.supportedModels()`; static
  fallback list `opus`, `sonnet`, `haiku` plus the current concrete ids
  (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`). `cost` fields are
  all zero (subscription billing). `contextWindow` from SDK model info when
  present, else 200000. `reasoning: true`, `input: ["text","image"]`,
  `supportsTools: true`.
- Auth: `allowsMissingApiKey: true`. `/login claude-code` does not run OAuth.
  It detects Claude Code's login state (macOS keychain item, then
  `~/.claude/.credentials.json`, then `~/.claude.json` `oauthAccount`/`userID`
  marker, then `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`) and returns a
  placeholder API-key string `claude-code-login` on success, or throws with the
  instruction `Run 'claude login' in a terminal, then retry.`
- Dependency: `@anthropic-ai/claude-agent-sdk` in `packages/ai/package.json`,
  loaded only through a dynamic import inside the stream function so startup
  cost is unchanged (the SDK entry is ~1 MB CJS).
- Executable: `pathToClaudeCodeExecutable` resolves in order: env
  `OMP_CLAUDE_CODE_EXECUTABLE`, `claude` on PATH, else undefined (SDK bundled
  CLI).

## Stream function

File: `packages/ai/src/providers/claude-agent-sdk.ts`, export
`streamClaudeAgentSdk: StreamFunction<"claude-agent-sdk">`. Options type
`ClaudeAgentSdkOptions extends StreamOptions` carries `cwd`, `sessionId`,
`reasoning`, `signal`, and `claudeSdkHandlers?: ClaudeSdkHandlers` (bridge, see
Permissions).

Request build:

- `prompt`: text of the last `user` message in `context.messages`. Image
  content is passed as SDK content blocks. If there is no stored SDK session
  (first turn, or after reset), the prompt is the full flattened omp history
  (`role: text` per message) so the SDK sees the conversation once.
- `options`: `model`, `cwd`, `resume: <stored sdk session id | undefined>`,
  `includePartialMessages: true`, `abortController` wired to `signal`,
  `systemPrompt: { type: "preset", preset: "claude_code", append: <omp
  systemPrompt joined> }`, `effort` mapped from omp reasoning effort
  (`minimal|low -> low`, `medium -> medium`, `high -> high`, `xhigh -> xhigh`,
  `max -> max`, undefined -> omitted), `canUseTool` (below),
  `pathToClaudeCodeExecutable`, `env: { ...process.env,
  CLAUDE_AGENT_SDK_CLIENT_APP: "oh-my-pi/<version>" }`.
- Never set `permissionMode: "bypassPermissions"`.

Event mapping (SDK message -> omp `AssistantMessageEvent`):

| SDK message | omp events |
| --- | --- |
| `system` subtype `init` | capture `session_id` -> `handlers.setSdkSessionId`. No event. |
| `stream_event` `content_block_start` text / thinking | `text_start` / `thinking_start` |
| `stream_event` `content_block_delta` text_delta / thinking_delta | `text_delta` / `thinking_delta` |
| `stream_event` `content_block_stop` | `text_end` / `thinking_end` |
| `assistant` message `tool_use` block (top level, `parent_tool_use_id === null`) | push `toolCall` block stamped `kCursorExecResolved: true` and `kStreamingBlockKind: "claude-sdk"`; emit `toolcall_start` + `toolcall_end`. Tool name mapped per Rendering. |
| `user` message with `tool_result` blocks | `handlers.onToolResult({ toolCallId, toolName, content, isError })` so the transcript gets the paired result. No stream event. |
| any message with `parent_tool_use_id !== null` | folded: text is appended to the parent Task tool's result via `onToolResult`; no top-level events. |
| `rate_limit_event` | `handlers.onRateLimit(info)` (optional); no stream event. |
| `result` subtype `success` | `done` with `reason: "stop"`, usage from `result.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`), cost zero. |
| `result` subtype error (`is_error`) | `error` with `reason: "error"` and the result text. |
| subprocess exit / thrown error | `error`; if the message indicates not logged in, wrap in `AIError` with the `claude login` instruction. |

Text deltas that arrive as full `assistant` messages without preceding
`stream_event`s (non-streaming fallback) are emitted as start/delta/end for
each block. Duplicate content (both stream_event and assistant for the same
block) is de-duplicated by content index tracking: assistant text blocks are
ignored when a stream_event block already ended at that index.

No retry wrapper: the central HTTP retry policy does not apply
(`retries: 0` equivalent). Abort ends the query via `abortController.abort()`
and emits `error` with `reason: "aborted"`.

## Session continuity

- `ClaudeSdkHandlers.getSdkSessionId(): string | undefined` and
  `setSdkSessionId(id)` are implemented in the coding-agent bridge and backed
  by a custom session entry type `claude-sdk-session` (`{ sdkSessionId }`) so
  resume survives restart.
- omp compaction, fork, branch, or `/clear` calls `handlers.resetSdkSession()`
  (clears the id). The next turn sends the full flattened history as the
  prompt and captures the new id from `init`.
- If `resume` fails (SDK reports unknown session), the provider clears the id
  and retries the turn once with the flattened history.

## Permissions

`ClaudeSdkHandlers.requestToolPermission(toolName, input, opts): Promise<PermissionResult>`
lives beside `CursorExecHandlers` in `packages/coding-agent/src/sdk.ts` and is
threaded the same way: `AgentOptions.claudeSdkHandlers` in
`packages/agent/src/agent.ts` -> stream options -> provider.

Tier map (Claude Code tool -> omp `ToolTier`):

| Tier | Tools |
| --- | --- |
| read | `Read`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `TodoRead`, `TodoWrite`, `Task`, `Skill` |
| write | `Edit`, `MultiEdit`, `Write`, `NotebookEdit` |
| exec | `Bash`, `KillShell`, and any unknown tool |

Resolution: reuse `packages/coding-agent/src/tools/approval.ts` comparison of
tier vs active approval mode plus user overrides keyed `claude-code.<Tool>`.
`allow` -> `{ behavior: "allow" }`. `deny` -> `{ behavior: "deny", message }`.
`prompt` -> omp's existing tool approval prompt with the tool name and a
truncated JSON of `input`; user accept -> allow, reject -> deny with
`message: "Denied by user in omp"`. Abort signal -> deny.

## Rendering

Tool name map for transcript blocks: `Read->read`, `Edit->edit`,
`MultiEdit->edit`, `Write->write`, `Bash->bash`, `Grep->grep`, `Glob->find`,
`LS->ls`, `WebFetch->fetch`, `WebSearch->web_search`, others keep the Claude
Code name lowercased. Arguments are passed through unchanged; renderers must
tolerate unknown keys (they already do for Cursor).

## Touch list

| File | Change |
| --- | --- |
| `packages/catalog/src/types.ts` | add `"claude-agent-sdk"` to `KnownApi`; compat type entry |
| `packages/catalog/src/build.ts` | compat case |
| `packages/catalog/src/provider-models/descriptors.ts`, `special.ts` | `claude-code` entry with `specialModelManager` using SDK `supportedModels()` and static fallback |
| `packages/ai/src/types.ts` | `ApiOptionsMap["claude-agent-sdk"] = ClaudeAgentSdkOptions`; `StreamOptions.claudeSdkHandlers?` |
| `packages/ai/src/api-registry.ts` | builtin name list |
| `packages/ai/src/stream.ts` | both dispatch switches |
| `packages/ai/src/providers/claude-agent-sdk.ts` | stream function (new) |
| `packages/ai/src/providers/claude-agent-sdk-types.ts` | `ClaudeSdkHandlers` interface, tier/name maps (new) |
| `packages/ai/src/registry/claude-code.ts` + `registry.ts` | provider def with login detection |
| `packages/ai/package.json` | dependency |
| `packages/agent/src/agent.ts` | `claudeSdkHandlers` option threaded to stream options |
| `packages/coding-agent/src/sdk.ts` | `ClaudeSdkHandlers` implementation (session entry, approval prompt) |
| `packages/coding-agent/src/thinking.ts`, `session/model-controls.ts` | effort support for the new api |
| `docs/providers.md`, `docs/provider-endpoint-constraints.md` | document |

## Testing

- `packages/ai/src/providers/__tests__/claude-agent-sdk.test.ts`: fake
  `query` async generator injected via a module-level `setQueryForTests`
  hook. Cases: text streaming order; thinking; tool_use -> resolved toolCall +
  paired result; init captures session id; resume passed when id stored;
  flattened prompt when no id; result usage mapping; is_error -> error;
  abort -> aborted; canUseTool tier routing allow/deny/prompt.
- `packages/ai/src/registry/__tests__/claude-code.test.ts`: login detection
  ordering with a temp HOME.
- Live smoke: `packages/ai/scripts/claude-sdk-smoke.ts`, runs only when
  `OMP_CLAUDE_SDK_SMOKE=1`, prompt `Reply with exactly: OK`, asserts the text
  and a non-empty session id.

## Out of scope for v1

Bridging omp's own tools into the SDK via MCP, omp `mcp.json` servers,
hooks, subagent transcripts as nested blocks, thinking display controls beyond
`effort`.
