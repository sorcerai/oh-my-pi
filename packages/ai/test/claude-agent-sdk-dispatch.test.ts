import { afterEach, describe, expect, test } from "bun:test";
import { setClaudeSdkQueryForTests } from "../src/providers/claude-agent-sdk";
import { streamSimple } from "../src/stream";
import { type Context, Effort, type Model } from "../src/types";

afterEach(() => setClaudeSdkQueryForTests(undefined));

describe("claude-agent-sdk dispatch", () => {
	test("streamSimple routes claude-agent-sdk models to the SDK provider and carries the chosen effort", async () => {
		let called = false;
		const capture: { params?: { options?: { effort?: string } } } = {};
		setClaudeSdkQueryForTests(((params: { options?: { effort?: string } }) => {
			called = true;
			capture.params = params;
			async function* gen() {
				yield { type: "system", subtype: "init", session_id: "s" };
				yield { type: "result", subtype: "success", is_error: false, result: "", usage: {} };
			}
			return gen();
		}) as never);
		const model = {
			id: "opus",
			api: "claude-agent-sdk",
			provider: "claude-code",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
			baseUrl: "local://claude-code",
		} as unknown as Model<"claude-agent-sdk">;
		const context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "x", timestamp: 1 }],
			tools: [],
		} as unknown as Context;
		const events: string[] = [];
		for await (const e of streamSimple(model, context, { apiKey: "claude-code-login", reasoning: Effort.High }))
			events.push(e.type);
		expect(called).toBe(true);
		expect(events.at(-1)).toBe("done");
		expect(capture.params?.options?.effort).toBe("high");
	});
});
