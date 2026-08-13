import { describe, expect, it } from "bun:test";
import type { ToolHostFrame } from "../src/protocol/tool-host";
import { ToolHostRegistry } from "../src/tool-host/registry";

const readTool = {
	name: "read",
	inputSchema: { type: "object", properties: { path: { type: "string" } } },
};
const sessionBReadTool = {
	name: "read",
	description: "Session B read",
	inputSchema: { type: "object", properties: { path: { type: "string" }, session: { const: "b" } } },
};
const writeTool = {
	name: "write",
	inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
};

type RegisterFrame = Extract<ToolHostFrame, { type: "register" }>;

function registration(hostId: string, sessionId: string, tools: RegisterFrame["tools"]): RegisterFrame {
	return { type: "register", hostId, sessionId, tools };
}

describe("ToolHostRegistry", () => {
	it("replaces a session owner on reconnect and rejects late frames from the old owner", () => {
		const registry = new ToolHostRegistry();
		const oldOwner = registry.register(registration("host-old", "session-a", [readTool]));
		const newOwner = registry.register(registration("host-new", "session-a", [writeTool]));

		expect(registry.getTools("session-a")).toEqual([writeTool]);
		expect(registry.isCurrentOwner(oldOwner)).toBe(false);
		expect(registry.isCurrentOwner(newOwner)).toBe(true);
		expect(() => registry.assertCurrentOwner(oldOwner)).toThrow(/stale|owner/i);
		expect(() => registry.update(oldOwner, [readTool])).toThrow(/stale|owner/i);
		expect(() => registry.unregister(oldOwner)).toThrow(/stale|owner/i);
		expect(registry.getTool("session-a", "write")).toEqual(writeTool);
		expect(registry.getTool("session-a", "read")).toBeUndefined();

		registry.update(newOwner, [readTool]);
		expect(registry.getTool("session-a", "read")).toEqual(readTool);
	});

	it("keeps same-named tools isolated between sessions", () => {
		const registry = new ToolHostRegistry();
		const sessionA = registry.register(registration("host-a", "session-a", [readTool]));
		const sessionB = registry.register(registration("host-b", "session-b", [sessionBReadTool]));

		expect(registry.getTool("session-a", "read")).toEqual(readTool);
		expect(registry.getTool("session-b", "read")).toEqual(sessionBReadTool);
		expect(registry.getTools("missing-session")).toEqual([]);

		registry.unregister(sessionA);
		expect(registry.getTool("session-a", "read")).toBeUndefined();
		expect(registry.getTool("session-b", "read")).toEqual(sessionBReadTool);
		expect(registry.isCurrentOwner(sessionB)).toBe(true);
	});
	it("clones and deep-freezes registered tools and schemas", () => {
		const registry = new ToolHostRegistry();
		const mutableTool = {
			name: "mutable",
			inputSchema: { nested: { enabled: true }, properties: { path: { type: "string" } } },
		};
		const owner = registry.register(registration("host-mutable", "session-mutable", [mutableTool]));
		mutableTool.inputSchema.nested.enabled = false;

		const stored = registry.getTool(owner.sessionId, "mutable");
		expect(stored).not.toBe(mutableTool);
		expect(stored?.inputSchema.nested).toEqual({ enabled: true });
		expect(Object.isFrozen(stored)).toBe(true);
		expect(Object.isFrozen(stored?.inputSchema)).toBe(true);
		expect(Object.isFrozen(stored?.inputSchema.nested)).toBe(true);
		const nested = stored?.inputSchema.nested as { enabled: boolean };
		expect(() => {
			nested.enabled = false;
		}).toThrow();
	});
	it("preserves an own __proto__ schema key while cloning", () => {
		const registry = new ToolHostRegistry();
		const inputSchema = JSON.parse('{ "type": "object", "__proto__": { "safe": true } }') as Record<string, unknown>;
		const owner = registry.register(registration("host-proto", "session-proto", [{ name: "proto", inputSchema }]));

		const storedSchema = registry.getTool(owner.sessionId, "proto")?.inputSchema;
		expect(storedSchema && Object.hasOwn(storedSchema, "__proto__")).toBe(true);
		expect(Reflect.get(storedSchema ?? {}, "__proto__")).toEqual({ safe: true });
	});

	it("applies current-owner changes and rejects stale or mismatched frames without mutation", () => {
		const registry = new ToolHostRegistry();
		const owner = registry.register(registration("host-a", "session-a", [readTool]));

		registry.apply(owner, { type: "tools_changed", sessionId: "session-a", tools: [writeTool] });
		expect(registry.getTool("session-a", "write")).toEqual(writeTool);
		expect(registry.getTool("session-a", "read")).toBeUndefined();

		expect(() => registry.apply(owner, { type: "tools_changed", sessionId: "session-b", tools: [readTool] })).toThrow(
			/session/i,
		);
		expect(registry.getTool("session-a", "write")).toEqual(writeTool);

		const replacement = registry.register(registration("host-b", "session-a", [readTool]));
		expect(() =>
			registry.apply(owner, { type: "tools_changed", sessionId: "session-a", tools: [writeTool] }),
		).toThrow(/stale|owner/i);
		expect(() => registry.apply(owner, { type: "unregister", sessionId: "session-a" })).toThrow(/stale|owner/i);
		expect(registry.getTool("session-a", "read")).toEqual(readTool);

		registry.apply(replacement, { type: "unregister", sessionId: "session-a" });
		expect(registry.getTools("session-a")).toEqual([]);
	});

	it("does not fall back to another session when a lookup misses", () => {
		const registry = new ToolHostRegistry();
		registry.register(registration("host-a", "session-a", [readTool]));
		registry.register(registration("host-b", "session-b", [writeTool]));

		expect(registry.getTool("session-a", "write")).toBeUndefined();
		expect(registry.getTool("session-b", "read")).toBeUndefined();
		expect(registry.getTools("unknown")).toEqual([]);
	});
});
