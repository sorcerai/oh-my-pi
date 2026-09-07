import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Effort } from "../effort";
import { buildClaudeCodeModel, CLAUDE_CODE_STATIC_MODELS } from "../provider-models/claude-code-static";
import type { ModelSpec } from "../types";

/**
 * Cheap presence check for Claude Code state, used to avoid spawning the CLI for
 * users who never selected the provider. Filesystem-only: no subprocess, and no
 * dependency on the richer login detection in `packages/ai` (catalog cannot
 * import from ai).
 */
function hasClaudeCodeState(home: string = homedir()): boolean {
	return existsSync(join(home, ".claude")) || existsSync(join(home, ".claude.json"));
}

/** Bound the CLI subprocess spawn + control-request round trip. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Ask the SDK which models the logged-in Claude Code account can use. Falls
 * back to the static list on any failure (SDK/CLI missing, not logged in,
 * control request unsupported, timeout).
 *
 * Discovery is additive: static entries always survive so the descriptor's
 * `defaultModel` resolves even when the account exposes a narrower list.
 */
export async function fetchClaudeCodeModels(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ModelSpec<"claude-agent-sdk">[]> {
	// The descriptor is `allowUnauthenticated`, so the model manager reaches this
	// for every user, including those who never chose the provider. Spawning the
	// CLI to ask them is wasted work, so require some Claude Code state on disk
	// first. Both login paths leave it: a keychain login still has the CLI's
	// `~/.claude` directory, and a credentials-file login has one or both.
	if (!hasClaudeCodeState()) return CLAUDE_CODE_STATIC_MODELS;
	try {
		const sdk = await import("@anthropic-ai/claude-agent-sdk");
		const abortController = new AbortController();
		const timer = setTimeout(() => abortController.abort(), timeoutMs);
		// Streaming-input mode: `supportedModels()` is a control request, which
		// the CLI only serves over a streaming session. The prompt iterable
		// yields nothing — we never send a turn, we only read the model list.
		const query = sdk.query({
			prompt: (async function* () {})(),
			options: { maxTurns: 0, abortController },
		});
		try {
			const models = await query.supportedModels();
			return mergeClaudeCodeModels(models);
		} finally {
			// Abort first: a hung `return()` must not be able to outlive the
			// timeout we just cleared, and must not delay resolving.
			abortController.abort();
			clearTimeout(timer);
			void query.return(undefined).catch(() => {});
		}
	} catch {
		return CLAUDE_CODE_STATIC_MODELS;
	}
}

/** Union the SDK's rows over the static list, keyed by model id (static wins). */
export function mergeClaudeCodeModels(
	models: readonly { value: string; displayName: string; supportedEffortLevels?: readonly string[] }[],
): ModelSpec<"claude-agent-sdk">[] {
	if (models.length === 0) return CLAUDE_CODE_STATIC_MODELS;
	const byId = new Map(CLAUDE_CODE_STATIC_MODELS.map(model => [model.id, model]));
	for (const info of models) {
		if (!info.value || byId.has(info.value)) continue;
		// The SDK's model list carries no context window, so a discovered id
		// gets the conservative floor rather than any static entry's window.
		const model = buildClaudeCodeModel(info.value, info.displayName || info.value, 200_000);
		// SDK levels are exactly the `Effort` string values minus "minimal".
		const efforts = info.supportedEffortLevels as readonly Effort[] | undefined;
		byId.set(info.value, efforts?.length ? { ...model, thinking: { mode: "effort", efforts: [...efforts] } } : model);
	}
	return [...byId.values()];
}
