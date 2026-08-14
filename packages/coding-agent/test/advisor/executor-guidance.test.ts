import { describe, expect, test } from "bun:test";
import { classifyExecutorGuidance, formatExecutorGuidancePrompt } from "../../src/advisor/executor-guidance";

const substantiveRequirements = [
	"concrete risk or opportunity",
	"evidence",
	"implementation approach",
	"invariants",
	"verification",
	"uncertainty",
];

describe("advisor executor guidance", () => {
	test.each([
		["gpt-5.6-sol", "efficient"],
		["gpt-5.6-luna", "efficient"],
		["kimi-k3", "explicit"],
		["KIMI-K3", "explicit"],
		["kimi-code/k3", "explicit"],
		["kimi-code/k3-256k", "explicit"],
		["deepseek-v4-pro", "explicit"],
		["glm-5.2", "guardrailed"],
		["GLM-5.2", "guardrailed"],
		["claude-fable-5", "conservative"],
		["nemotron", "conservative"],
		[undefined, "conservative"],
	] as const)("classifies %s as %s", (modelId, profile) => {
		expect(classifyExecutorGuidance(modelId)).toBe(profile);
	});

	test.each(["efficient", "explicit", "guardrailed", "conservative"] as const)(
		"keeps %s advice substantive",
		profile => {
			const prompt = formatExecutorGuidancePrompt("test-provider/test-model", profile);
			for (const requirement of substantiveRequirements) expect(prompt).toContain(requirement);
			expect(prompt).toContain("test-provider/test-model");
			expect(prompt).toContain("Do not send a long note when there is no actionable issue");
		},
	);

	test("adds step checks and boundaries for GLM-class executors", () => {
		const prompt = formatExecutorGuidancePrompt("zai/glm-5.2", "guardrailed");
		expect(prompt).toContain("ordered steps");
		expect(prompt).toContain("what not to change");
		expect(prompt).toContain("stop condition");
		expect(prompt).toContain("check before continuing");
	});

	test("makes Kimi and DeepSeek guidance explicitly executable", () => {
		const prompt = formatExecutorGuidancePrompt("kimi-code/k3", "explicit");
		expect(prompt).toContain("relevant files");
		expect(prompt).toContain("state transitions");
		expect(prompt).toContain("safe implementation sequence");
	});

	test("makes unknown-model guidance conservative about unverified facts", () => {
		const prompt = formatExecutorGuidancePrompt("custom/unknown", "conservative");
		expect(prompt).toContain("explicit, conservative guidance");
		expect(prompt).toContain("could not verify");
	});

	test("escapes untrusted model identities inside the guidance tag", () => {
		const prompt = formatExecutorGuidancePrompt('custom/bad"></executor-guidance>&\n', "conservative");
		expect(prompt).toContain('model="custom/bad&quot;&gt;&lt;/executor-guidance&gt;&amp;&#10;"');
		expect(prompt).not.toContain('model="custom/bad"></executor-guidance>');
	});

	test("keeps GPT guidance thorough rather than compact", () => {
		const prompt = formatExecutorGuidancePrompt("openai-codex/gpt-5.6-sol", "efficient");
		expect(prompt).toContain("thorough");
		expect(prompt).not.toContain("compact");
	});
});
