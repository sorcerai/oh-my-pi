import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	claudeCodeEffort,
	claudeCodeToolDisplayName,
	claudeCodeToolTier,
} from "../src/providers/claude-agent-sdk-types";

describe("claude-agent-sdk maps", () => {
	test("tool tiers", () => {
		expect(claudeCodeToolTier("Read")).toBe("read");
		expect(claudeCodeToolTier("Grep")).toBe("read");
		expect(claudeCodeToolTier("Edit")).toBe("write");
		expect(claudeCodeToolTier("Write")).toBe("write");
		expect(claudeCodeToolTier("Bash")).toBe("exec");
		expect(claudeCodeToolTier("SomethingNew")).toBe("exec");
	});
	test("display names", () => {
		expect(claudeCodeToolDisplayName("Read")).toBe("read");
		expect(claudeCodeToolDisplayName("Glob")).toBe("find");
		expect(claudeCodeToolDisplayName("MultiEdit")).toBe("edit");
		expect(claudeCodeToolDisplayName("WebSearch")).toBe("web_search");
		expect(claudeCodeToolDisplayName("Task")).toBe("task");
	});
	test("effort", () => {
		expect(claudeCodeEffort(undefined)).toBeUndefined();
		expect(claudeCodeEffort(Effort.Minimal)).toBe("low");
		expect(claudeCodeEffort(Effort.Low)).toBe("low");
		expect(claudeCodeEffort(Effort.Medium)).toBe("medium");
		expect(claudeCodeEffort(Effort.High)).toBe("high");
		expect(claudeCodeEffort(Effort.XHigh)).toBe("xhigh");
		expect(claudeCodeEffort(Effort.Max)).toBe("max");
	});
});
