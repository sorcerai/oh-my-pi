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

const READ_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"LS",
	"WebFetch",
	"WebSearch",
	"TodoRead",
	"TodoWrite",
	"Task",
	"Skill",
]);
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
