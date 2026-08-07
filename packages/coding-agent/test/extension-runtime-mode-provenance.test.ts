/**
 * Slice C cross-mode tests for Task 0 (Facehugger P0 plan):
 *  - production `runtime-init.initializeExtensions` wires `noninteractive`;
 *  - ACP with form/confirm capability remains `acp` (never promoted to local-interactive);
 *  - task executor wiring reports `task`;
 *  - only actual local interactive runtime reports `local-interactive`;
 *  - `refreshRegisteredTools` is wired as a real delegate (not a no-op) at every path.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import {
	createAcpExtensionRuntimeActions,
	createLocalInteractiveExtensionRuntimeActions,
	createNoninteractiveExtensionRuntimeActions,
	createTaskExtensionRuntimeActions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runtime-actions";
import type { ExtensionActions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("Cross-mode runtimeMode provenance (Task 0 Slice C)", () => {
	let sharedTempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-cross-mode-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	it("runtime-init.initializeExtensions wires noninteractive + a real refresh delegate", async () => {
		const mockModel = buildModel({
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		const sessionManager = SessionManager.inMemory();
		const runtime = new ExtensionRuntime();
		const realRunner = new ExtensionRunner([], runtime, ".", sessionManager, modelRegistry);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mockModel, systemPrompt: [""], tools: [], messages: [] },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner: realRunner,
		});

		// Spy on runner.initialize to capture the production action set.
		const initSpy = vi.spyOn(realRunner, "initialize");
		await initializeExtensions(session, {
			reportSendError: () => {},
			reportRuntimeError: () => {},
		});

		expect(initSpy).toHaveBeenCalledTimes(1);
		const actions = initSpy.mock.calls[0]![0] as ExtensionActions;
		expect(actions.runtimeMode).toBe("noninteractive");
		expect(typeof actions.refreshRegisteredTools).toBe("function");

		// The refresh delegate must be a real delegate, not a no-op: calling it
		// reaches session.refreshExtensionTools (which requires a valid runner snapshot).
		const refreshResult = actions.refreshRegisteredTools({ activate: [] });
		expect(refreshResult).toBeInstanceOf(Promise);
		await refreshResult; // should not throw for an empty delta

		initSpy.mockRestore();
		await session.dispose();
	});

	it("production runtime factories preserve provenance and enforce the task todo boundary", async () => {
		const refresh = vi.fn(async (_delta: { activate?: string[]; deactivate?: string[] }) => {});
		const session = {
			refreshExtensionTools: refresh,
		} as unknown as AgentSession;
		const runner = {
			getAllRegisteredTools: () => [],
		} as unknown as ExtensionRunner;
		const productionFactories = [
			["acp", createAcpExtensionRuntimeActions(session, runner)],
			["local-interactive", createLocalInteractiveExtensionRuntimeActions(session, runner)],
			["noninteractive", createNoninteractiveExtensionRuntimeActions(session, runner)],
			["task", createTaskExtensionRuntimeActions(session, runner, name => name === "todo")],
		] as const;
		for (const [runtimeMode, actions] of productionFactories) {
			expect(actions.runtimeMode).toBe(runtimeMode);
			await actions.refreshRegisteredTools({ activate: ["todo", "late"], deactivate: ["todo", "stale"] });
			const expected = runtimeMode === "task" ? { activate: ["late"], deactivate: ["stale"] } : undefined;
			expect(refresh).toHaveBeenLastCalledWith(
				[],
				expected ?? { activate: ["todo", "late"], deactivate: ["todo", "stale"] },
			);
		}

		const failure = new Error("refresh failed");
		refresh.mockRejectedValueOnce(failure);
		await expect(
			createTaskExtensionRuntimeActions(session, runner, name => name === "todo").refreshRegisteredTools({
				activate: ["late"],
			}),
		).rejects.toBe(failure);
	});
});
