import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolResult } from "@oh-my-pi/prime-bridge-protocol";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapAgentToolResult(result: McpToolResult): CallToolResult {
	const structuredContent =
		result.details === undefined
			? {}
			: isRecord(result.details)
				? { structuredContent: result.details }
				: { structuredContent: { value: result.details } };
	return {
		content: result.content,
		...structuredContent,
		...(result.isError === undefined ? {} : { isError: result.isError }),
	};
}

export function mapAgentToolError(error: unknown): CallToolResult {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		isError: true,
	};
}
