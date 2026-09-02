import { describe, expect, test } from "bun:test";
import { CLAUDE_CODE_STATIC_MODELS } from "../src/provider-models/claude-code-static";

describe("claude-code static models", () => {
	test("every model is subscription-billed and on the claude-agent-sdk api", () => {
		expect(CLAUDE_CODE_STATIC_MODELS.length).toBeGreaterThanOrEqual(3);
		for (const m of CLAUDE_CODE_STATIC_MODELS) {
			expect(m.api).toBe("claude-agent-sdk");
			expect(m.provider).toBe("claude-code");
			expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(m.reasoning).toBe(true);
			expect(m.supportsTools).toBe(true);
		}
		expect(CLAUDE_CODE_STATIC_MODELS.map(m => m.id)).toEqual(
			expect.arrayContaining(["opus", "sonnet", "haiku", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]),
		);
	});
});
