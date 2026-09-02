import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderSegment } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

type Advisor = { name: string; status: string; model?: { id: string } };

function advisorsCtx(options: { configured?: boolean; advisors: Advisor[]; input?: number; cacheRead?: number }) {
	return {
		session: {
			getAdvisorStats: () => ({
				configured: options.configured ?? true,
				active: options.advisors.length > 0,
				tokens: {
					input: options.input ?? 0,
					cacheRead: options.cacheRead ?? 0,
					output: 0,
					reasoning: 0,
					cacheWrite: 0,
					total: 0,
				},
				advisors: options.advisors,
			}),
		},
	} as unknown as SegmentContext;
}

describe("advisors status-line segment", () => {
	it("is hidden when no advisor is configured", () => {
		const rendered = renderSegment("advisors", advisorsCtx({ configured: false, advisors: [] }));
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("shows count, model ids, and prompt tokens (input + cacheRead)", () => {
		const ctx = advisorsCtx({
			advisors: [
				{ name: "Task", status: "running", model: { id: "gpt-5.6-sol" } },
				{ name: "Adversarial", status: "running", model: { id: "gemini-3.1-pro" } },
			],
			input: 1_500,
			cacheRead: 1_200_000,
		});
		const text = stripVTControlCharacters(renderSegment("advisors", ctx).content);
		expect(text).toContain("2");
		expect(text).toContain("gpt-5.6-sol");
		expect(text).toContain("gemini-3.1-pro");
		expect(text).toContain("1.2M");
	});

	it("omits the token figure before any advisor turn ran", () => {
		const ctx = advisorsCtx({ advisors: [{ name: "Task", status: "paused", model: { id: "gpt-5.6-sol" } }] });
		const text = stripVTControlCharacters(renderSegment("advisors", ctx).content);
		expect(text).toContain("gpt-5.6-sol");
		expect(text).not.toMatch(/\d+(\.\d+)?[KM]\b/);
	});

	it("truncates long model ids", () => {
		const ctx = advisorsCtx({
			advisors: [{ name: "A", status: "running", model: { id: "claude-opus-4-6-20260101" } }],
		});
		const text = stripVTControlCharacters(renderSegment("advisors", ctx).content);
		expect(text).toContain("claude-opus-4…");
		expect(text).not.toContain("20260101");
	});
});
