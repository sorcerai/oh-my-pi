import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const originalWebSocket = globalThis.WebSocket;
const roots: string[] = [];
const sessions: AgentSession[] = [];
const authStorages: AuthStorage[] = [];

class FailingWebSocket {
	static instances: FailingWebSocket[] = [];
	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;

	constructor() {
		FailingWebSocket.instances.push(this);
		queueMicrotask(() => this.onerror?.());
	}

	send(): void {}

	close(): void {
		this.closed = true;
		this.readyState = 3;
		this.onclose?.();
	}
}

afterEach(async () => {
	globalThis.WebSocket = originalWebSocket;
	FailingWebSocket.instances = [];
	await Promise.all(sessions.splice(0).map(session => session.dispose().catch(() => undefined)));
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Prime bridge tool host SDK startup", () => {
	it("continues creating the session when the optional bridge is offline", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-sdk-offline-"));
		roots.push(root);
		const tokenPath = path.join(root, "bridge.token");
		await fs.writeFile(tokenPath, "test-token\n");
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		authStorages.push(authStorage);
		globalThis.WebSocket = FailingWebSocket as unknown as typeof WebSocket;

		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage),
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.inMemory(root),
			settings: Settings.isolated({
				"primeBridge.toolHost.enabled": true,
				"primeBridge.url": "http://127.0.0.1:1",
				"primeBridge.tokenPath": tokenPath,
			}),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);

		expect(session.sessionId).toBeString();
		expect(FailingWebSocket.instances).toHaveLength(1);
		expect(FailingWebSocket.instances[0]?.closed).toBe(true);
	});
});
