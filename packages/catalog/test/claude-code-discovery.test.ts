import { describe, expect, test } from "bun:test";
import { mergeClaudeCodeModels } from "../src/discovery/claude-code";
import { Effort } from "../src/effort";
import { CLAUDE_CODE_STATIC_MODELS } from "../src/provider-models/claude-code-static";

describe("mergeClaudeCodeModels", () => {
	test("a discovered id gets the 200k floor, not a static model's window", () => {
		const merged = mergeClaudeCodeModels([{ value: "claude-tiny-9", displayName: "Claude Tiny 9" }]);
		const discovered = merged.find(m => m.id === "claude-tiny-9");
		expect(discovered?.contextWindow).toBe(200_000);
		expect(discovered?.name).toBe("Claude Tiny 9");
	});

	test("static entries survive and win on id collisions", () => {
		const merged = mergeClaudeCodeModels([{ value: "opus", displayName: "Overridden" }]);
		expect(merged.find(m => m.id === "opus")?.name).toBe(CLAUDE_CODE_STATIC_MODELS.find(m => m.id === "opus")?.name);
		for (const m of CLAUDE_CODE_STATIC_MODELS) expect(merged.some(x => x.id === m.id)).toBe(true);
	});

	test("supportedEffortLevels become the model's effort ladder", () => {
		const merged = mergeClaudeCodeModels([
			{ value: "claude-tiny-9", displayName: "Claude Tiny 9", supportedEffortLevels: ["low", "high"] },
		]);
		expect(merged.find(m => m.id === "claude-tiny-9")?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High],
		});
	});
});
