import { Effort } from "../effort";
import type { ModelSpec } from "../types";

/** Claude Code bills against the account's subscription, never per token. */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** Effort ladder the SDK exposes via `ModelInfo.supportedEffortLevels`. */
export const CLAUDE_CODE_EFFORTS: readonly Effort[] = [
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

export function buildClaudeCodeModel(id: string, name: string, contextWindow: number): ModelSpec<"claude-agent-sdk"> {
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
		maxTokens: 64_000,
		thinking: { mode: "effort", efforts: [...CLAUDE_CODE_EFFORTS] },
	};
}

/** Bundled fallback when the SDK model list cannot be fetched. Aliases resolve inside Claude Code. */
export const CLAUDE_CODE_STATIC_MODELS: ModelSpec<"claude-agent-sdk">[] = [
	buildClaudeCodeModel("opus", "Claude Opus (alias)", 1_000_000),
	buildClaudeCodeModel("sonnet", "Claude Sonnet (alias)", 1_000_000),
	buildClaudeCodeModel("haiku", "Claude Haiku (alias)", 200_000),
	buildClaudeCodeModel("claude-opus-5", "Claude Opus 5", 1_000_000),
	buildClaudeCodeModel("claude-sonnet-5", "Claude Sonnet 5", 1_000_000),
	buildClaudeCodeModel("claude-haiku-4-5", "Claude Haiku 4.5", 200_000),
];
