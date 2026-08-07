/**
 * Slice A focused tests for Task 0 (Facehugger P0 plan):
 *  - trusted `ExtensionAPI.runtimeMode` provenance supplied by the host;
 *  - late `registerTool` remaining inert until `refreshRegisteredTools`;
 *  - `refreshRegisteredTools` delegating the activation delta exactly once;
 *  - ACP UI presence NOT being mistaken for local-interactive provenance.
 *
 * These exercise the extension runner/API layer only. The session-level
 * refresh transaction, linearization, and cross-mode wiring are covered by
 * later slices.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionAPI, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createRecordingRefreshDelegate, createTestExtensionActions } from "./utils/extension-actions-fixture";

function makeActions(options: {
	runtimeMode: "local-interactive" | "acp" | "task" | "noninteractive";
	refreshRegisteredTools: (delta: { activate?: string[]; deactivate?: string[] }) => Promise<void>;
}) {
	return createTestExtensionActions(options);
}

const contextActions = {
	getModel: () => undefined,
	isIdle: () => true,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: async () => {},
	getSystemPrompt: () => [],
};

/** Non-noOp UI context so `runner.hasUI()` returns true (proves UI presence
 *  does not imply local-interactive provenance). */
const realUiContext: ExtensionUIContext = {
	ask: async () => undefined,
	select: async () => undefined,
	dialog: async () => undefined,
	setEditorComponent: () => {},
	setStatus: () => {},
	showError: () => {},
	showMessage: () => {},
	requestRender: () => {},
	getEditorText: () => "",
	setEditorText: () => {},
	clearEditor: () => {},
	focusEditor: () => {},
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
	setFooter: () => {},
	setHeader: () => {},
} as unknown as ExtensionUIContext;

describe("ExtensionRunner trusted runtimeMode + refreshRegisteredTools (Task 0 Slice A)", () => {
	let sharedTempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-provenance-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	it("reports noninteractive before initialize", async () => {
		const runtime = new ExtensionRuntime();
		const eventBus = new EventBus();
		let captured: ExtensionAPI | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				captured = pi;
			},
			".",
			eventBus,
			runtime,
			"provenance-default",
		);

		const sessionManager = SessionManager.inMemory();
		// No initialize() call: the pre-init default provenance must be noninteractive.
		const runner = new ExtensionRunner([extension], runtime, ".", sessionManager, modelRegistry);

		expect(captured).toBeDefined();
		expect(captured!.runtimeMode).toBe("noninteractive");
		expect(runner.getRuntimeMode()).toBe("noninteractive");
	});

	it("forwards the host-supplied runtimeMode through initialize", async () => {
		const runtime = new ExtensionRuntime();
		const eventBus = new EventBus();
		let captured: ExtensionAPI | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				captured = pi;
			},
			".",
			eventBus,
			runtime,
			"provenance-acp",
		);

		const sessionManager = SessionManager.inMemory();
		const runner = new ExtensionRunner([extension], runtime, ".", sessionManager, modelRegistry);
		runner.initialize(
			makeActions({ runtimeMode: "acp", refreshRegisteredTools: createRecordingRefreshDelegate() }),
			contextActions,
			undefined,
			realUiContext,
		);

		// ACP with a real UI is still ACP — never promoted to local-interactive.
		expect(runner.hasUI()).toBe(true);
		expect(runner.getRuntimeMode()).toBe("acp");
		expect(captured!.runtimeMode).toBe("acp");
		expect(captured!.runtimeMode).not.toBe("local-interactive");
	});

	it("keeps late registerTool inert until refreshRegisteredTools", async () => {
		const runtime = new ExtensionRuntime();
		const eventBus = new EventBus();
		let captured: ExtensionAPI | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				captured = pi;
			},
			".",
			eventBus,
			runtime,
			"late-register",
		);

		const sessionManager = SessionManager.inMemory();
		const runner = new ExtensionRunner([extension], runtime, ".", sessionManager, modelRegistry);

		const refreshSpy = vi.fn<(delta: { activate?: string[]; deactivate?: string[] }) => Promise<void>>();
		runner.initialize(makeActions({ runtimeMode: "task", refreshRegisteredTools: refreshSpy }), contextActions);

		// A tool registered AFTER the session was built must not auto-activate.
		const { Type } = captured!.typebox;
		captured!.registerTool({
			name: "late_tool",
			label: "Late Tool",
			description: "Registered after session construction",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "late" }] };
			},
		});

		// The runner sees the registration (so a refresh can snapshot it)…
		const tools = runner.getAllRegisteredTools();
		expect(tools.map(t => t.definition.name)).toContain("late_tool");

		// …but registration alone never invoked the refresh action.
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	it("delegates the activation delta through refreshRegisteredTools exactly once", async () => {
		const runtime = new ExtensionRuntime();
		const eventBus = new EventBus();
		let captured: ExtensionAPI | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				captured = pi;
			},
			".",
			eventBus,
			runtime,
			"refresh-once",
		);

		const sessionManager = SessionManager.inMemory();
		const runner = new ExtensionRunner([extension], runtime, ".", sessionManager, modelRegistry);

		const refreshSpy = vi.fn<(delta: { activate?: string[]; deactivate?: string[] }) => Promise<void>>(
			async () => {},
		);
		runner.initialize(
			makeActions({ runtimeMode: "local-interactive", refreshRegisteredTools: refreshSpy }),
			contextActions,
		);

		await captured!.refreshRegisteredTools({ activate: ["late_tool"], deactivate: ["stale_tool"] });

		expect(refreshSpy).toHaveBeenCalledTimes(1);
		expect(refreshSpy).toHaveBeenCalledWith({ activate: ["late_tool"], deactivate: ["stale_tool"] });
	});

	it("propagates refresh errors to the caller", async () => {
		const runtime = new ExtensionRuntime();
		const eventBus = new EventBus();
		let captured: ExtensionAPI | undefined;
		const extension = await loadExtensionFromFactory(
			pi => {
				captured = pi;
			},
			".",
			eventBus,
			runtime,
			"refresh-error",
		);

		const sessionManager = SessionManager.inMemory();
		const runner = new ExtensionRunner([extension], runtime, ".", sessionManager, modelRegistry);

		const failure = new Error("session rejected the refresh");
		runner.initialize(
			makeActions({
				runtimeMode: "noninteractive",
				refreshRegisteredTools: async () => {
					throw failure;
				},
			}),
			contextActions,
		);

		await expect(captured!.refreshRegisteredTools({ activate: ["x"] })).rejects.toBe(failure);
	});
});
