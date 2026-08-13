import { describe, expect, it } from "bun:test";
import type { McpToolResult } from "@oh-my-pi/prime-bridge-protocol";
import { mapAgentToolError, mapAgentToolResult } from "../src/mcp/result-map";

describe("MCP AgentToolResult mapping", () => {
	it("preserves text, image, and structured JSON blocks without concatenation", () => {
		const result = mapAgentToolResult({
			content: [
				{ type: "text", text: "first" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				{ type: "text", text: "last" },
			],
			details: { answer: 42, nested: { ok: true } },
		});

		expect(result).toEqual({
			content: [
				{ type: "text", text: "first" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				{ type: "text", text: "last" },
			],
			structuredContent: { answer: 42, nested: { ok: true } },
		});
	});

	it("preserves scalar, array, and null details from the declared protocol result", () => {
		const scalarResult: McpToolResult = { content: [], details: "value" };
		const arrayResult: McpToolResult = { content: [], details: [1, 2] };
		const nullResult: McpToolResult = { content: [], details: null };

		expect(mapAgentToolResult(scalarResult)).toMatchObject({ structuredContent: { value: "value" } });
		expect(mapAgentToolResult(arrayResult)).toMatchObject({ structuredContent: { value: [1, 2] } });
		expect(mapAgentToolResult(nullResult)).toMatchObject({ structuredContent: { value: null } });
	});

	it("maps host errors to an MCP isError result", () => {
		expect(mapAgentToolError(new Error("tool failed"))).toEqual({
			content: [{ type: "text", text: "tool failed" }],
			isError: true,
		});
	});
});
