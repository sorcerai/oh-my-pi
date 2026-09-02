// packages/ai/test/claude-agent-sdk.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { setClaudeSdkQueryForTests, streamClaudeAgentSdk } from "../src/providers/claude-agent-sdk";
import type { ClaudeSdkHandlers } from "../src/providers/claude-agent-sdk-types";
import type { Context, Model, ToolResultMessage } from "../src/types";
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
	return {
		systemPrompt: ["sys"],
		messages: [{ role: "user", content: text, timestamp: 1 }],
		tools: [],
	} as unknown as Context;
}

function handlers(initial?: string): ClaudeSdkHandlers & { id?: string; perms: string[] } {
	const h = {
		id: initial,
		perms: [] as string[],
		getSdkSessionId: () => h.id,
		setSdkSessionId: (id: string) => {
			h.id = id;
		},
		resetSdkSession: () => {
			h.id = undefined;
		},
		requestToolPermission: async (req: { toolName: string }) => {
			h.perms.push(req.toolName);
			return req.toolName === "Bash" ? { behavior: "deny" as const, message: "no" } : { behavior: "allow" as const };
		},
	};
	return h;
}

const init = { type: "system", subtype: "init", session_id: "sess-1", model: "opus" };
const textEvents = [
	{
		type: "stream_event",
		session_id: "sess-1",
		parent_tool_use_id: null,
		event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	},
	{
		type: "stream_event",
		session_id: "sess-1",
		parent_tool_use_id: null,
		event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } },
	},
	{
		type: "stream_event",
		session_id: "sess-1",
		parent_tool_use_id: null,
		event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
	},
	{
		type: "stream_event",
		session_id: "sess-1",
		parent_tool_use_id: null,
		event: { type: "content_block_stop", index: 0 },
	},
];
const success = {
	type: "result",
	subtype: "success",
	session_id: "sess-1",
	is_error: false,
	result: "hello",
	usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
};

function fake(messages: unknown[], capture?: { params?: unknown }) {
	return (params: unknown) => {
		if (capture) capture.params = params;
		async function* gen() {
			for (const m of messages) yield m;
		}
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
		const done = events.at(-1) as unknown as {
			message: { usage: { input: number; output: number; cacheRead: number; cacheWrite: number } };
		};
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
		c.messages.unshift({
			role: "assistant",
			content: [{ type: "text", text: "earlier reply" }],
			timestamp: 0,
		} as never);
		c.messages.unshift({ role: "user", content: "first", timestamp: 0 } as never);
		await collect(streamClaudeAgentSdk(model, c, { claudeSdkHandlers: handlers() }));
		expect(String(capture.params?.prompt)).toContain("first");
		expect(String(capture.params?.prompt)).toContain("earlier reply");
		expect(String(capture.params?.prompt)).toContain("later");
	});

	test("tool_use becomes a resolved toolCall and the tool_result is paired via onToolResult", async () => {
		const results: ToolResultMessage[] = [];
		const assistantToolUse = {
			type: "assistant",
			session_id: "sess-1",
			parent_tool_use_id: null,
			message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/x" } }] },
		};
		const userToolResult = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: null,
			message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "file body", is_error: false }] },
		};
		setClaudeSdkQueryForTests(fake([init, assistantToolUse, userToolResult, ...textEvents, success]) as never);
		const events = await collect(
			streamClaudeAgentSdk(model, ctx(), {
				claudeSdkHandlers: handlers(),
				onToolResult: r => {
					results.push(r);
					return undefined;
				},
			}),
		);
		const tc = events.find(e => e.type === "toolcall_end") as unknown as { toolCall: Record<PropertyKey, unknown> };
		expect(tc.toolCall.name).toBe("read");
		expect(tc.toolCall.id).toBe("tu1");
		expect(tc.toolCall[kCursorExecResolved]).toBe(true);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ toolCallId: "tu1", toolName: "read", isError: false });
		expect((events.at(-1) as unknown as { reason: string }).reason).toBe("stop");
	});

	test("canUseTool routes to handlers.requestToolPermission", async () => {
		const h = handlers();
		const capture: {
			params?: {
				options?: {
					canUseTool?: (n: string, i: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<unknown>;
				};
			};
		} = {};
		setClaudeSdkQueryForTests(fake([init, success], capture) as never);
		await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: h }));
		const canUseTool = capture.params!.options!.canUseTool!;
		expect(await canUseTool("Read", {}, { signal: new AbortController().signal })).toEqual({ behavior: "allow" });
		expect(await canUseTool("Bash", { command: "rm" }, { signal: new AbortController().signal })).toMatchObject({
			behavior: "deny",
		});
		expect(h.perms).toEqual(["Read", "Bash"]);
	});

	test("error result becomes an error event", async () => {
		setClaudeSdkQueryForTests(
			fake([
				init,
				{
					type: "result",
					subtype: "error_during_execution",
					session_id: "sess-1",
					is_error: true,
					errors: ["boom"],
					usage: {},
				},
			]) as never,
		);
		const events = await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: handlers() }));
		const last = events.at(-1) as { type: string; reason: string; error: { errorMessage?: string } };
		expect(last.type).toBe("error");
		expect(last.reason).toBe("error");
		expect(last.error.errorMessage).toContain("boom");
	});

	test("not-logged-in failure names claude login", async () => {
		setClaudeSdkQueryForTests((() => {
			// biome-ignore lint/correctness/useYield: models an SDK generator that throws before its first yield
			async function* gen() {
				throw new Error("Not logged in · Please run /login");
			}
			return gen();
		}) as never);
		const events = await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: handlers() }));
		const last = events.at(-1) as { type: string; error: { errorMessage?: string } };
		expect(last.type).toBe("error");
		expect(last.error.errorMessage).toContain("claude login");
	});
});
