import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Skill } from "../src/extensibility/skills";
import type { ToolSession } from "../src/tools";
import { SkillSearchTool, searchSkills } from "../src/tools/skill-search";

function skill(name: string, description: string, hide = false): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		source: "test",
		hide,
	};
}

function makeTool(skills: readonly Skill[]): SkillSearchTool {
	return new SkillSearchTool({ skills } as ToolSession);
}

function textOf(result: AgentToolResult): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("skill_search tool", () => {
	it("ranks exact name matches above description matches", () => {
		const matches = searchSkills(
			[skill("testing", "General development"), skill("react", "Testing React components")],
			"testing",
		);

		expect(matches.map(match => match.name)).toEqual(["testing", "react"]);
		expect(matches[0].score).toBeGreaterThan(matches[1].score);
	});

	it("returns metadata only without loading skill bodies", async () => {
		const result = await makeTool([skill("react-testing", "Test React components with Vitest")]).execute("call-1", {
			query: "react testing",
		});
		const text = textOf(result);

		expect(text).toContain("skill://react-testing");
		expect(text).toContain("Test React components with Vitest");
		expect(text).toContain("Use read with skill://react-testing");
		expect(text).not.toContain("# full skill body");
		expect(result.details).toMatchObject({ results: [{ name: "react-testing", source: "test" }] });
	});

	it("omits hidden skills", async () => {
		const result = await makeTool([skill("secret-workflow", "Private workflow", true)]).execute("call-2", {
			query: "secret workflow",
		});

		expect(textOf(result)).toBe("No matching skills found.");
		expect(result.useless).toBe(true);
	});

	it("percent-encodes reserved characters in skill URLs", () => {
		const [match] = searchSkills([skill("tool/name?test", "Tool capability")], "tool name");
		expect(match.path).toBe("skill://tool%2Fname%3Ftest");
	});

	it("caps results at eight", () => {
		const skills = Array.from({ length: 12 }, (_, index) => skill(`testing-${index}`, "Testing tools"));
		expect(searchSkills(skills, "testing")).toHaveLength(8);
	});

	it("marks an empty result useless", async () => {
		const result = await makeTool([skill("frontend", "Design interfaces")]).execute("call-3", { query: "database" });
		expect(result.useless).toBe(true);
		expect(result.details).toEqual({ query: "database", results: [] });
	});
});
