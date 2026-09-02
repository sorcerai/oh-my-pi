import { describe, expect, test } from "bun:test";
import { ClaudeSdkBridge } from "../src/claude-sdk-bridge";

function bridge(
	overrides: Partial<ConstructorParameters<typeof ClaudeSdkBridge>[0]> = {},
	settings: Record<string, unknown> = {},
) {
	let persisted: string | undefined;
	const selections: string[] = [];
	const b = new ClaudeSdkBridge({
		getSettings: () => ({ get: (k: string) => settings[k] }),
		isAutoApprove: () => false,
		hasUI: () => true,
		select: async prompt => {
			selections.push(prompt);
			return "Approve";
		},
		loadPersistedSessionId: () => persisted,
		persistSessionId: id => {
			persisted = id;
		},
		...overrides,
	});
	return {
		b,
		selections,
		get persisted() {
			return persisted;
		},
	};
}

describe("ClaudeSdkBridge", () => {
	test("session id round-trips and resets", () => {
		const t = bridge();
		expect(t.b.getSdkSessionId()).toBeUndefined();
		t.b.setSdkSessionId("s1");
		expect(t.b.getSdkSessionId()).toBe("s1");
		expect(t.persisted).toBe("s1");
		t.b.resetSdkSession();
		expect(t.b.getSdkSessionId()).toBeUndefined();
	});
	test("reset before the first read tombstones an id persisted by an earlier process", () => {
		let persisted: string | undefined = "abc";
		const b = new ClaudeSdkBridge({
			getSettings: () => undefined,
			isAutoApprove: () => false,
			hasUI: () => false,
			select: async () => undefined,
			loadPersistedSessionId: () => persisted,
			persistSessionId: id => {
				persisted = id;
			},
		});
		b.resetSdkSession();
		expect(persisted).toBeUndefined();
		expect(b.getSdkSessionId()).toBeUndefined();
	});
	test("read tier auto-allows under write mode without prompting", async () => {
		const t = bridge({}, { "tools.approvalMode": "write" });
		const r = await t.b.requestToolPermission({
			toolName: "Read",
			input: { file_path: "/x" },
			signal: new AbortController().signal,
		});
		expect(r).toEqual({ behavior: "allow" });
		expect(t.selections).toHaveLength(0);
	});
	test("exec tier prompts under write mode and honors Deny", async () => {
		const t = bridge({ select: async () => "Deny" }, { "tools.approvalMode": "write" });
		const r = await t.b.requestToolPermission({
			toolName: "Bash",
			input: { command: "rm -rf /" },
			signal: new AbortController().signal,
		});
		expect(r).toMatchObject({ behavior: "deny" });
	});
	test("user policy deny wins", async () => {
		const t = bridge({}, { "tools.approvalMode": "yolo", "tools.approval": { "claude-code.Bash": "deny" } });
		const r = await t.b.requestToolPermission({
			toolName: "Bash",
			input: {},
			signal: new AbortController().signal,
		});
		expect(r).toMatchObject({ behavior: "deny" });
	});
	test("no UI and prompt required denies with guidance", async () => {
		const t = bridge({ hasUI: () => false }, { "tools.approvalMode": "always-ask" });
		const r = await t.b.requestToolPermission({
			toolName: "Edit",
			input: {},
			signal: new AbortController().signal,
		});
		expect(r).toMatchObject({ behavior: "deny" });
		expect((r as { message: string }).message).toContain("approvalMode");
	});
});
