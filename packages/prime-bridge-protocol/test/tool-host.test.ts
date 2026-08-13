import { describe, expect, it } from "bun:test";
import { isToolHostFrame, parseToolHostFrame, type ToolHostFrame } from "../src";

const tool = {
	name: "read",
	description: "Read a file",
	inputSchema: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
};

const result: Extract<ToolHostFrame, { type: "tool_result" }>["result"] = {
	content: [{ type: "text", text: "ok" }],
	isError: false,
};

describe("ToolHostFrame protocol", () => {
	it("accepts each frame kind and preserves its payload", () => {
		const frames: ToolHostFrame[] = [
			{ type: "register", hostId: "host-1", sessionId: "session-a", tools: [tool] },
			{ type: "tools_changed", sessionId: "session-a", tools: [tool] },
			{
				type: "call_tool",
				requestId: "request-1",
				sessionId: "session-a",
				toolName: "read",
				arguments: { path: "x" },
			},
			{ type: "tool_result", requestId: "request-1", result },
			{ type: "tool_error", requestId: "request-1", code: "denied", message: "approval denied" },
			{ type: "cancel_tool", requestId: "request-1", sessionId: "session-a" },
			{ type: "unregister", sessionId: "session-a" },
		];

		for (const frame of frames) {
			expect(parseToolHostFrame(frame)).toEqual(frame);
			expect(isToolHostFrame(frame)).toBe(true);
		}
	});

	it("accepts a JSON-encoded frame", () => {
		const frame: ToolHostFrame = { type: "unregister", sessionId: "session-a" };
		expect(parseToolHostFrame(JSON.stringify(frame))).toEqual(frame);
	});

	it("rejects malformed frames", () => {
		const malformed: unknown[] = [
			null,
			{},
			{ type: "unknown", sessionId: "session-a" },
			{ type: "register", hostId: "host-1", sessionId: "session-a", tools: "not-an-array" },
			{
				type: "register",
				hostId: "host-1",
				sessionId: "session-a",
				tools: [{ name: "read", inputSchema: "not-an-object" }],
			},
			{ type: "register", hostId: "host-1", sessionId: "session-a", tools: [{ name: "read", inputSchema: [] }] },
			{ type: "tools_changed", sessionId: "session-a" },
			{ type: "cancel_tool", requestId: "", sessionId: "session-a" },
			{ type: "call_tool", requestId: "request-1", sessionId: "session-a", toolName: "read" },
			{ type: "tool_result", requestId: "request-1", result: { content: "not-an-array", isError: false } },
			{ type: "tool_error", requestId: "request-1", code: "denied", message: 42 },
			{ type: "unregister", sessionId: "" },
			"{malformed-json",
		];

		for (const frame of malformed) {
			expect(() => parseToolHostFrame(frame)).toThrow();
			expect(isToolHostFrame(frame)).toBe(false);
		}
	});
});
