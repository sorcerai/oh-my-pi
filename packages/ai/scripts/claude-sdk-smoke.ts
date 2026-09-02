// Live check against the real subscription. Run: OMP_CLAUDE_SDK_SMOKE=1 bun packages/ai/scripts/claude-sdk-smoke.ts
import { streamClaudeAgentSdk } from "../src/providers/claude-agent-sdk";
import type { Context, Model } from "../src/types";

if (!process.env.OMP_CLAUDE_SDK_SMOKE) {
	console.log("skipped: set OMP_CLAUDE_SDK_SMOKE=1");
	process.exit(0);
}

const model = {
	id: process.env.OMP_CLAUDE_SDK_MODEL ?? "sonnet",
	name: "smoke",
	api: "claude-agent-sdk",
	provider: "claude-code",
	baseUrl: "local://claude-code",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 4096,
} as unknown as Model<"claude-agent-sdk">;

let sessionId: string | undefined;
const handlers = {
	getSdkSessionId: () => sessionId,
	setSdkSessionId: (id: string) => {
		sessionId = id;
	},
	resetSdkSession: () => {
		sessionId = undefined;
	},
	requestToolPermission: async () => ({ behavior: "deny" as const, message: "smoke test: no tools" }),
};

const context = {
	systemPrompt: [],
	messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: Date.now() }],
	tools: [],
} as unknown as Context;
let text = "";
for await (const e of streamClaudeAgentSdk(model, context, { claudeSdkHandlers: handlers, cwd: process.cwd() })) {
	if (e.type === "text_delta") text += e.delta;
	if (e.type === "error") {
		console.error("ERROR", e.error.errorMessage);
		process.exit(1);
	}
}
if (!/OK/.test(text)) {
	console.error("unexpected reply:", JSON.stringify(text));
	process.exit(1);
}
if (!sessionId) {
	console.error("no session id captured");
	process.exit(1);
}
console.log("OK", { sessionId, text: text.trim() });
