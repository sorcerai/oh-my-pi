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

	test("streams thinking blocks", async () => {
		const ev = (event: unknown) => ({ type: "stream_event", session_id: "sess-1", parent_tool_use_id: null, event });
		setClaudeSdkQueryForTests(
			fake([
				init,
				ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
				ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
				ev({ type: "content_block_stop", index: 0 }),
				success,
			]) as never,
		);
		const events = await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: handlers() }));
		expect(events.map(e => e.type)).toEqual(["start", "thinking_start", "thinking_delta", "thinking_end", "done"]);
		const end = events.at(-2) as unknown as { content: string };
		expect(end.content).toBe("hmm");
	});

	test("assistant text at an index that never streamed is not dropped", async () => {
		// Block 0 streamed; block 1 arrived only on the full assistant message.
		const assistantBoth = {
			type: "assistant",
			session_id: "sess-1",
			parent_tool_use_id: null,
			message: {
				content: [
					{ type: "text", text: "hello" },
					{ type: "text", text: "second block" },
				],
			},
		};
		setClaudeSdkQueryForTests(fake([init, ...textEvents, assistantBoth, success]) as never);
		const events = await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: handlers() }));
		const done = events.at(-1) as unknown as { message: { content: { type: string; text: string }[] } };
		const texts = done.message.content.filter(c => c.type === "text").map(c => c.text);
		expect(texts).toEqual(["hello", "second block"]);
	});

	test("an unpaired tool_use gets a synthetic error result when the turn ends", async () => {
		const results: ToolResultMessage[] = [];
		const assistantToolUse = {
			type: "assistant",
			session_id: "sess-1",
			parent_tool_use_id: null,
			message: { content: [{ type: "tool_use", id: "tu9", name: "Bash", input: { command: "sleep 1" } }] },
		};
		// No `user` tool_result ever arrives before the result message.
		setClaudeSdkQueryForTests(fake([init, assistantToolUse, success]) as never);
		await collect(
			streamClaudeAgentSdk(model, ctx(), {
				claudeSdkHandlers: handlers(),
				onToolResult: r => {
					results.push(r);
					return undefined;
				},
			}),
		);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ toolCallId: "tu9", toolName: "bash", isError: true });
		expect(results[0].content[0]).toMatchObject({ text: expect.stringContaining("before this tool returned") });
	});

	test("aborting mid-stream ends with reason aborted", async () => {
		const controller = new AbortController();
		const released = Promise.withResolvers<void>();
		setClaudeSdkQueryForTests((() => {
			async function* gen() {
				yield init;
				controller.abort();
				released.resolve();
				await released.promise;
				yield success;
			}
			return gen();
		}) as never);
		const events = await collect(
			streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: handlers(), signal: controller.signal }),
		);
		const last = events.at(-1) as { type: string; reason: string };
		expect(last.type).toBe("error");
		expect(last.reason).toBe("aborted");
	});

	test("images in the last user message are sent as SDK content blocks", async () => {
		const capture: { params?: { prompt?: unknown } } = {};
		setClaudeSdkQueryForTests(fake([init, success], capture) as never);
		const c = ctx();
		c.messages[0] = {
			role: "user",
			content: [
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: "what is this" },
			],
			timestamp: 1,
		} as never;
		await collect(streamClaudeAgentSdk(model, c, { claudeSdkHandlers: handlers() }));
		const messages: { message: { content: { type: string; source?: { data: string; media_type: string } }[] } }[] =
			[];
		for await (const m of capture.params!.prompt as AsyncIterable<never>) messages.push(m);
		expect(messages).toHaveLength(1);
		const blocks = messages[0].message.content;
		expect(blocks[0]).toMatchObject({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "AAAA" },
		});
		expect(blocks.at(-1)).toMatchObject({ type: "text" });
	});

	test("usage carries token counts but no cost", async () => {
		// Priced model on purpose: with a zero-cost model this test would pass
		// even if calculateCost were still called.
		const priced = { ...model, cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } } as typeof model;
		setClaudeSdkQueryForTests(fake([init, success]) as never);
		const events = await collect(streamClaudeAgentSdk(priced, ctx(), { claudeSdkHandlers: handlers() }));
		const done = events.at(-1) as unknown as {
			message: { usage: { totalTokens: number; cost: Record<string, number> } };
		};
		expect(done.message.usage.totalTokens).toBe(19);
		expect(Object.values(done.message.usage.cost).every(v => v === 0)).toBe(true);
	});

	test("a stale resume id is cleared and the turn is retried once without it", async () => {
		const h = handlers("sess-1");
		let resets = 0;
		const reset = h.resetSdkSession.bind(h);
		h.resetSdkSession = () => {
			resets++;
			reset();
		};
		const calls: { options?: { resume?: string } }[] = [];
		let attempt = 0;
		setClaudeSdkQueryForTests(((params: { options?: { resume?: string } }) => {
			calls.push(params);
			attempt++;
			if (attempt === 1) throw new Error("No conversation found with session ID: sess-1");
			async function* gen() {
				yield init;
				yield success;
			}
			return gen();
		}) as never);
		const events = await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: h }));
		expect(calls.length).toBe(2);
		expect(calls[0].options?.resume).toBe("sess-1");
		expect(calls[1].options?.resume).toBeUndefined();
		expect(resets).toBe(1);
		// resetSdkSession() cleared the id; attempt two's init re-set it.
		expect(h.id).toBe("sess-1");
		expect(events.map(e => e.type)).toEqual(["start", "done"]);
	});

	test("a non-session failure is not retried", async () => {
		let attempt = 0;
		setClaudeSdkQueryForTests((() => {
			attempt++;
			throw new Error("connection reset");
		}) as never);
		const events = await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: handlers("sess-1") }));
		expect(attempt).toBe(1);
		expect(events.at(-1)?.type).toBe("error");
	});

	test("SDK block indexes reset between assistant messages", async () => {
		// Message 1 streams block 0; message 2 delivers block 0 only as a full
		// assistant text block, so it must still be emitted.
		const assistantOne = {
			type: "assistant",
			session_id: "sess-1",
			parent_tool_use_id: null,
			message: { content: [{ type: "text", text: "hello" }] },
		};
		const assistantTwo = {
			type: "assistant",
			session_id: "sess-1",
			parent_tool_use_id: null,
			message: { content: [{ type: "text", text: "after tools" }] },
		};
		setClaudeSdkQueryForTests(fake([init, ...textEvents, assistantOne, assistantTwo, success]) as never);
		const events = await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: handlers() }));
		const done = events.at(-1) as unknown as { message: { content: { type: string; text: string }[] } };
		expect(done.message.content.filter(c => c.type === "text").map(c => c.text)).toEqual(["hello", "after tools"]);
	});

	test("client app env carries the pi-ai version", async () => {
		const capture: { params?: { options?: { env?: Record<string, string> } } } = {};
		setClaudeSdkQueryForTests(fake([init, success], capture) as never);
		await collect(streamClaudeAgentSdk(model, ctx(), { claudeSdkHandlers: handlers() }));
		expect(capture.params?.options?.env?.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^oh-my-pi\/\d+\.\d+\.\d+/);
	});
});
