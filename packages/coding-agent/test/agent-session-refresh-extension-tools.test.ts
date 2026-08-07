/**
 * Slice B focused tests for Task 0 (Facehugger P0 plan):
 *  - `AgentSession.refreshExtensionTools` atomic refresh/activate/invoke;
 *  - linearization of `setActiveToolsByName`, `refreshMCPTools`, `refreshRpcHostTools`,
 *    `activateVibeTools`, `deactivateVibeTools`, and `refreshExtensionTools` through
 *    one session queue/revision;
 *  - activate/deactivate deltas, duplicate idempotency, collision rejection,
 *    changed-definition refusal, rollback, and no implicit unregister.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { Extension, RegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { wrapRegisteredTool } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { type } from "arktype";

function createModel(): Model<"openai-responses"> {
	return buildModel({
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
}

function createBasicTool(name: string, label: string, description = `${label} tool`): AgentTool {
	return {
		name,
		label,
		description,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createRegisteredTool(name: string, label: string, description = `${label} tool`): RegisteredTool {
	return {
		definition: {
			name,
			label,
			description,
			parameters: type({ value: "string" }),
			async execute() {
				return { content: [{ type: "text" as const, text: `${name} executed` }] };
			},
		},
		extensionPath: "<test>",
	};
}

type CallableTestSchema = ((value: unknown) => unknown) & {
	rootApply: (...args: unknown[]) => unknown;
	assert: (...args: unknown[]) => unknown;
};
/** Minimal but complete `Extension` so the runner's iteration over
 *  `handlers`/`commands`/`flags`/`shortcuts` does not crash on invocation. */
function createTestExtension(tools: RegisteredTool[]): Extension {
	return {
		path: "<test>",
		resolvedPath: "<test>",
		handlers: new Map(),
		tools: new Map(tools.map(t => [t.definition.name, t])),
		assistantThinkingRenderers: [],
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

/** Push a late-registered tool into the runner so `getAllRegisteredTools()` sees it. */
function pushTool(runner: ExtensionRunner, tool: RegisteredTool): void {
	(runner as unknown as { extensions: ReturnType<typeof createTestExtension>[] }).extensions.push(
		createTestExtension([tool]),
	);
}
interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(value => {
		resolve = value;
	});
	return { promise, resolve };
}

interface PromptBarrier {
	started: Deferred<void>;
	release: Deferred<void>;
	rebuild: (toolNames: string[]) => Promise<string>;
	arm: () => void;
}

function createPromptBarrier(): PromptBarrier {
	const started = deferred<void>();
	const release = deferred<void>();
	let hold = false;
	return {
		started,
		release,
		arm: () => {
			hold = true;
		},
		rebuild: async toolNames => {
			if (hold) {
				hold = false;
				started.resolve(undefined);
				await release.promise;
			}
			return toolNames.join(",");
		},
	};
}

function createMcpRegisteredTool(name: string, label: string): RegisteredTool {
	const tool = createRegisteredTool(name, label);
	tool.definition.mcpServerName = "test-server";
	tool.definition.mcpToolName = name;
	return tool;
}

function createMcpTool(name: string, label: string): CustomTool {
	return {
		name,
		label,
		description: `${label} tool`,
		parameters: { type: "object", properties: {} },
		mcpServerName: "test-server",
		mcpToolName: name,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function newSession(
	options: {
		rebuildSystemPrompt?: (toolNames: string[]) => Promise<string>;
		initialRegisteredTools?: RegisteredTool[];
		initialMCPToolNames?: string[];
		createVibeTools?: () => AgentTool[];
	} = {},
): { session: AgentSession; runner: ExtensionRunner } {
	const readTool = createBasicTool("read", "Read");
	const mock = createModel();
	const sessionManager = SessionManager.inMemory();
	const initialRegisteredTools = options.initialRegisteredTools ?? [];
	const runner = new ExtensionRunner(
		[createTestExtension(initialRegisteredTools)],
		new ExtensionRuntime(),
		".",
		sessionManager,
		{
			getApiKey: async () => "test-key",
		} as never,
	);
	const toolRegistry = new Map<string, AgentTool>([[readTool.name, readTool]]);
	for (const registeredTool of initialRegisteredTools) {
		toolRegistry.set(registeredTool.definition.name, wrapRegisteredTool(registeredTool, runner));
	}
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["initial"], tools: [readTool], messages: [] },
		convertToLlm,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		toolRegistry,
		mcpToolNames: options.initialMCPToolNames,
		createVibeTools: options.createVibeTools,
		builtInToolNames: ["read"],
		extensionRunner: runner,
		rebuildSystemPrompt: async (toolNames, _tools) => ({
			systemPrompt: [await (options.rebuildSystemPrompt ?? (async () => "prompt"))(toolNames)],
		}),
	});
	agent.setTools([readTool]);
	return { session, runner };
}
async function newProductionCallableSession(
	schema: CallableTestSchema,
): Promise<{ session: AgentSession; runner: ExtensionRunner }> {
	const readTool = createBasicTool("read", "Read");
	const mock = createModel();
	const sessionManager = SessionManager.inMemory();
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		pi => {
			pi.registerTool({
				name: "ext_callable_mutated",
				label: "Callable",
				description: "Callable tool",
				parameters: schema as never,
				async execute() {
					return { content: [{ type: "text" as const, text: "ext_callable_mutated executed" }] };
				},
			});
		},
		".",
		new EventBus(),
		runtime,
		"<production>",
	);
	const runner = new ExtensionRunner([extension], runtime, ".", sessionManager, {
		getApiKey: async () => "test-key",
	} as never);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["initial"], tools: [readTool], messages: [] },
		convertToLlm,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		toolRegistry: new Map([[readTool.name, readTool]]),
		builtInToolNames: ["read"],
		extensionRunner: runner,
		rebuildSystemPrompt: async () => ({ systemPrompt: ["prompt"] }),
	});
	agent.setTools([readTool]);
	return { session, runner };
}

describe("AgentSession.refreshExtensionTools (Task 0 Slice B)", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("reuses an extension tool already installed during session startup", async () => {
		const initial = createRegisteredTool("ext_initial", "Initial");
		const { session, runner } = newSession({ initialRegisteredTools: [initial] });
		sessions.push(session);

		await session.refreshExtensionTools(runner.getAllRegisteredTools(), { activate: ["ext_initial"] });

		expect(session.getActiveToolNames()).toContain("ext_initial");
		expect(session.getToolByName("ext_initial")?.label).toBe("Initial");
	});
	it("rejects duplicate extension names in one refresh snapshot", async () => {
		const { session, runner } = newSession();
		sessions.push(session);
		const first = createRegisteredTool("ext_duplicate", "First");
		const second = createRegisteredTool("ext_duplicate", "Second");
		pushTool(runner, first);
		pushTool(runner, second);

		await expect(session.refreshExtensionTools(runner.getAllRegisteredTools(), {})).rejects.toThrow(
			/different definition/,
		);
		expect(session.getToolByName("ext_duplicate")).toBeUndefined();
	});

	it("applies activate/deactivate deltas atomically against the current set", async () => {
		const { session, runner } = newSession();
		sessions.push(session);

		const rt = createRegisteredTool("ext_a", "A");
		const rt2 = createRegisteredTool("ext_b", "B");
		pushTool(runner, rt);
		pushTool(runner, rt2);

		await session.refreshExtensionTools(runner.getAllRegisteredTools(), {
			activate: ["ext_a", "ext_b"],
		});
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "ext_a", "ext_b"]));
		const result = await session.getToolByName("ext_a")?.execute("call-1", { value: "live" });
		expect(result?.content).toEqual([{ type: "text", text: "ext_a executed" }]);

		// Deactivate ext_a only; ext_b stays.
		await session.refreshExtensionTools([], { deactivate: ["ext_a"] });
		expect(session.getActiveToolNames()).not.toContain("ext_a");
		expect(session.getActiveToolNames()).toContain("ext_b");
		expect(session.getActiveToolNames()).toContain("read");
	});

	it("is idempotent on duplicate identical refresh/delta", async () => {
		const rebuildSpy = vi.fn<(toolNames: string[]) => Promise<string>>(
			async toolNames => `tools:${toolNames.join(",")}`,
		);
		const { session, runner } = newSession({ rebuildSystemPrompt: rebuildSpy });
		sessions.push(session);

		const rt = createRegisteredTool("ext_idem", "Idem");
		pushTool(runner, rt);

		await session.refreshExtensionTools(runner.getAllRegisteredTools(), { activate: ["ext_idem"] });
		const firstRebuildCount = rebuildSpy.mock.calls.length;

		// Duplicate identical refresh + delta.
		await session.refreshExtensionTools(runner.getAllRegisteredTools(), { activate: ["ext_idem"] });
		// Registry unchanged (no duplicate entries), prompt rebuild skipped (same signature).
		expect(session.getAllToolNames().filter(n => n === "ext_idem").length).toBe(1);
		expect(rebuildSpy.mock.calls.length).toBe(firstRebuildCount);
	});

	it("treats ordinary object schemas as one canonical idempotent definition", async () => {
		const { session, runner } = newSession();
		sessions.push(session);
		const first = createRegisteredTool("ext_plain_schema", "Plain");
		first.definition.parameters = { type: "object", properties: { value: { type: "string" } } } as never;
		pushTool(runner, first);

		await session.refreshExtensionTools(runner.getAllRegisteredTools(), { activate: [first.definition.name] });
		await expect(
			session.refreshExtensionTools(runner.getAllRegisteredTools(), { activate: [first.definition.name] }),
		).resolves.toBeUndefined();
	});

	it("seeds startup MCP ownership so refresh replaces loaded MCP tools", async () => {
		const name = "mcp__test-server_tool";
		const startup = createMcpRegisteredTool(name, "Startup");
		const { session } = newSession({
			initialRegisteredTools: [startup],
			initialMCPToolNames: [name],
		});
		sessions.push(session);

		await expect(session.refreshMCPTools([createMcpTool(name, "Connected")])).resolves.toBeUndefined();
		expect(session.getToolByName(name)?.label).toBe("Connected");
	});

	it("keeps vibe mode restricted while queued activation changes restore afterward", async () => {
		const vibeTool = createBasicTool("vibe_restricted", "Vibe");
		const extension = createRegisteredTool("ext_vibe_queued", "Queued");
		const { session, runner } = newSession({ createVibeTools: () => [vibeTool] });
		sessions.push(session);
		pushTool(runner, extension);
		await session.refreshExtensionTools([extension], { activate: [extension.definition.name] });

		await session.activateVibeTools(["read"]);
		expect(session.getActiveToolNames()).toEqual(["read", "vibe_restricted"]);
		await session.refreshExtensionTools([extension], { deactivate: [extension.definition.name] });
		await session.refreshExtensionTools([extension], { activate: [extension.definition.name] });
		expect(session.getActiveToolNames()).toEqual(["read", "vibe_restricted"]);
		await session.deactivateVibeTools([]);
		expect(session.getActiveToolNames()).toContain("ext_vibe_queued");
		expect(session.getActiveToolNames()).not.toContain("vibe_restricted");
	});

	it("serializes nonempty MCP replacement across a deferred prompt rebuild", async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		let holdFirst = false;
		const { session } = newSession({
			rebuildSystemPrompt: async toolNames => {
				if (holdFirst) {
					holdFirst = false;
					started.resolve(undefined);
					await release.promise;
				}
				return toolNames.join(",");
			},
		});
		sessions.push(session);
		const first = createMcpTool("mcp__server_a_tool", "A");
		const second = createMcpTool("mcp__server_b_tool", "B");
		holdFirst = true;
		const firstRefresh = session.refreshMCPTools([first]);
		await started.promise;
		const secondRefresh = session.refreshMCPTools([second]);
		release.resolve(undefined);
		await Promise.all([firstRefresh, secondRefresh]);
		expect(session.getToolByName(first.name)).toBeUndefined();
		expect(session.getToolByName(second.name)?.label).toBe("B");
	});

	it("serializes RPC replacement and preserves a live execute wrapper", async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		let holdFirst = false;
		const { session } = newSession({
			rebuildSystemPrompt: async toolNames => {
				if (holdFirst) {
					holdFirst = false;
					started.resolve(undefined);
					await release.promise;
				}
				return toolNames.join(",");
			},
		});
		sessions.push(session);
		const first = createBasicTool("rpc_a", "A");
		const second = createBasicTool("rpc_b", "B");
		holdFirst = true;
		const firstRefresh = session.refreshRpcHostTools([first]);
		await started.promise;
		const secondRefresh = session.refreshRpcHostTools([second]);
		release.resolve(undefined);
		await Promise.all([firstRefresh, secondRefresh]);
		expect(session.getToolByName(first.name)).toBeUndefined();
		const live = session.getToolByName(second.name);
		expect(live?.label).toBe("B");
		const result = await live?.execute("rpc-call", {});
		expect(result?.content).toEqual([{ type: "text", text: "rpc_b executed" }]);
	});

	it("keeps vibe entry and exit restricted across queued active-set changes", async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		let holdFirst = false;
		const extension = createRegisteredTool("ext_vibe_race", "Race");
		const { session, runner } = newSession({
			createVibeTools: () => [createBasicTool("vibe_race", "Vibe")],
			rebuildSystemPrompt: async toolNames => {
				if (holdFirst) {
					holdFirst = false;
					started.resolve(undefined);
					await release.promise;
				}
				return toolNames.join(",");
			},
		});
		sessions.push(session);
		pushTool(runner, extension);
		await session.refreshExtensionTools([extension], { activate: [extension.definition.name] });

		holdFirst = true;
		const enter = session.activateVibeTools(["read"]);
		await started.promise;
		const queuedChange = session.setActiveToolsByName(["read", extension.definition.name]);
		release.resolve(undefined);
		await Promise.all([enter, queuedChange]);
		expect(session.getActiveToolNames()).toEqual(["read", "vibe_race"]);

		holdFirst = true;
		const exit = session.deactivateVibeTools([]);
		await started.promise;
		const queuedExitChange = session.setActiveToolsByName(["read"]);
		release.resolve(undefined);
		await Promise.all([exit, queuedExitChange]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
	});

	it("rejects collisions with built-in names", async () => {
		const { session, runner } = newSession();
		sessions.push(session);

		const collision = createRegisteredTool("read", "Fake Read");
		pushTool(runner, collision);

		await expect(session.refreshExtensionTools([collision], {})).rejects.toThrow(/conflicts/);
		// Built-in read must not be overwritten.
		expect(session.getToolByName("read")?.label).toBe("Read");
	});

	it("rejects changed same-name definition (fail closed)", async () => {
		const { session, runner } = newSession();
		sessions.push(session);

		const v1 = createRegisteredTool("ext_chg", "V1");
		pushTool(runner, v1);
		await session.refreshExtensionTools([v1], { activate: ["ext_chg"] });

		// Same name, different label → refusal.
		const v2 = createRegisteredTool("ext_chg", "V2");
		await expect(session.refreshExtensionTools([v2], {})).rejects.toThrow(/different definition/);
		expect(session.getToolByName("ext_chg")?.label).toBe("V1");
	});

	it("rolls back inserted tools when activation fails", async () => {
		let shouldFail = false;
		const { session, runner } = newSession({
			rebuildSystemPrompt: async toolNames => {
				if (shouldFail && toolNames.includes("ext_rb")) throw new Error("rebuild explosion");
				return `tools:${toolNames.join(",")}`;
			},
		});
		sessions.push(session);

		const rt = createRegisteredTool("ext_rb", "Rollback");
		pushTool(runner, rt);

		shouldFail = true;
		await expect(
			session.refreshExtensionTools(runner.getAllRegisteredTools(), { activate: ["ext_rb"] }),
		).rejects.toThrow(/rebuild explosion/);

		// Tool was rolled back out of the registry.
		expect(session.getAllToolNames()).not.toContain("ext_rb");
	});

	it("does not implicitly unregister from the runner", async () => {
		const { session, runner } = newSession();
		sessions.push(session);

		const rt = createRegisteredTool("ext_persist", "Persist");
		pushTool(runner, rt);
		const beforeCount = runner.getAllRegisteredTools().length;

		await session.refreshExtensionTools(runner.getAllRegisteredTools(), { activate: ["ext_persist"] });

		// The runner's registered set is unchanged — refreshExtensionTools only
		// inserts into the session registry; it never removes from the runner.
		expect(runner.getAllRegisteredTools().length).toBe(beforeCount);
		expect(runner.getAllRegisteredTools().map(t => t.definition.name)).toContain("ext_persist");
	});

	it("linearizes refresh against a concurrent setActiveToolsByName", async () => {
		const { session, runner } = newSession({
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		const rt = createRegisteredTool("ext_race", "Race");
		pushTool(runner, rt);

		// Fire both concurrently. Without linearization, the get/modify/set
		// interleaving could lose one side's change.
		const revBefore = session.getToolMutationRevision();
		const p1 = session.setActiveToolsByName(["read"]);
		const p2 = session.refreshExtensionTools(runner.getAllRegisteredTools(), {
			activate: ["ext_race"],
		});
		await Promise.all([p1, p2]);

		// Both changes survived: read stays active AND ext_race was activated.
		expect(session.getActiveToolNames()).toContain("read");
		expect(session.getActiveToolNames()).toContain("ext_race");
		expect(session.getToolMutationRevision()).toBe(revBefore + 2);
	});

	it("linearizes refresh against a concurrent refreshMCPTools", async () => {
		const { session, runner } = newSession({
			rebuildSystemPrompt: async toolNames => `tools:${toolNames.join(",")}`,
		});
		sessions.push(session);

		const rt = createRegisteredTool("ext_v_mcp", "ExtMCP");
		pushTool(runner, rt);

		const p1 = session.refreshMCPTools([]);
		const p2 = session.refreshExtensionTools(runner.getAllRegisteredTools(), {
			activate: ["ext_v_mcp"],
		});
		await Promise.all([p1, p2]);

		// ext_v_mcp survives the MCP refresh (which clears only MCP tools).
		expect(session.getActiveToolNames()).toContain("ext_v_mcp");
		expect(session.getActiveToolNames()).toContain("read");
	});
	type RaceOrder = "owner-first" | "extension-first";
	async function raceOwnerAndExtension(
		order: RaceOrder,
		ownerOperation: () => Promise<void>,
		extensionOperation: () => Promise<void>,
		barrier: PromptBarrier,
	): Promise<void> {
		if (order === "owner-first") {
			const owner = ownerOperation();
			await barrier.started.promise;
			const extension = extensionOperation();
			barrier.release.resolve(undefined);
			await Promise.all([owner, extension]);
			return;
		}
		const extension = extensionOperation();
		const owner = ownerOperation();
		await barrier.started.promise;
		barrier.release.resolve(undefined);
		await Promise.all([extension, owner]);
	}

	it("forces extension refresh across active-mode replacement in both deferred orders", async () => {
		for (const order of ["owner-first", "extension-first"] as const) {
			const barrier = createPromptBarrier();
			const { session, runner } = newSession({ rebuildSystemPrompt: barrier.rebuild });
			sessions.push(session);
			const extension = createRegisteredTool(`ext_mode_${order}`, "Extension mode");
			pushTool(runner, extension);
			barrier.arm();

			await raceOwnerAndExtension(
				order,
				() => session.setActiveToolsByName([]),
				() => session.refreshExtensionTools([extension], { activate: [extension.definition.name] }),
				barrier,
			);

			expect(session.getToolByName(extension.definition.name)).toBeDefined();
			expect(session.getActiveToolNames()).toEqual(order === "owner-first" ? [extension.definition.name] : []);
			expect(session.systemPrompt[0]).toBe(order === "owner-first" ? extension.definition.name : "");
		}
	});

	it("forces extension refresh across non-empty MCP replacement in both deferred orders", async () => {
		for (const order of ["owner-first", "extension-first"] as const) {
			const barrier = createPromptBarrier();
			const { session, runner } = newSession({ rebuildSystemPrompt: barrier.rebuild });
			sessions.push(session);
			const extension = createRegisteredTool(`ext_mcp_${order}`, "Extension MCP");
			const mcp = createMcpTool(`mcp__owner_${order}_tool`, "Owner MCP");
			pushTool(runner, extension);
			barrier.arm();

			await raceOwnerAndExtension(
				order,
				() => session.refreshMCPTools([mcp]),
				() => session.refreshExtensionTools([extension], { activate: [extension.definition.name] }),
				barrier,
			);

			expect(session.getToolByName(mcp.name)?.label).toBe("Owner MCP");
			expect(session.getToolByName(extension.definition.name)).toBeDefined();
			expect(session.getActiveToolNames()).toEqual(
				order === "owner-first"
					? ["read", mcp.name, extension.definition.name]
					: ["read", extension.definition.name, mcp.name],
			);
			expect(session.systemPrompt[0]).toContain(mcp.name);
			expect(session.systemPrompt[0]).toContain(extension.definition.name);
		}
	});

	it("rolls back the losing MCP owner or extension transaction after a deferred rebuild failure", async () => {
		for (const order of ["owner-first", "extension-first"] as const) {
			const barrier = createPromptBarrier();
			let failOwner = false;
			const extension = createRegisteredTool(`ext_mcp_rollback_${order}`, "Extension rollback");
			const mcp = createMcpTool(`mcp__rollback_${order}_tool`, "MCP rollback");
			const { session, runner } = newSession({
				rebuildSystemPrompt: async toolNames => {
					const shouldFail = failOwner && toolNames.includes(mcp.name);
					const prompt = await barrier.rebuild(toolNames);
					if (shouldFail) throw new Error("owner rebuild failed");
					return prompt;
				},
			});
			sessions.push(session);
			pushTool(runner, extension);
			barrier.arm();

			if (order === "owner-first") {
				const owner = session.refreshMCPTools([mcp]);
				await barrier.started.promise;
				failOwner = true;
				const extensionRefresh = session.refreshExtensionTools([extension], {
					activate: [extension.definition.name],
				});
				barrier.release.resolve(undefined);
				await expect(Promise.all([owner, extensionRefresh])).rejects.toThrow("owner rebuild failed");
				expect(session.getToolByName(mcp.name)?.label).toBe("MCP rollback");
				expect(session.getToolByName(extension.definition.name)).toBeUndefined();
				expect(session.getActiveToolNames()).toEqual(["read", mcp.name]);
			} else {
				const extensionRefresh = session.refreshExtensionTools([extension], {
					activate: [extension.definition.name],
				});
				const owner = session.refreshMCPTools([mcp]);
				await barrier.started.promise;
				failOwner = true;
				barrier.release.resolve(undefined);
				await expect(Promise.all([extensionRefresh, owner])).rejects.toThrow("owner rebuild failed");
				expect(session.getToolByName(extension.definition.name)).toBeDefined();
				expect(session.getToolByName(mcp.name)).toBeUndefined();
				expect(session.getActiveToolNames()).toEqual(["read", extension.definition.name]);
			}
			if (order === "owner-first") {
				expect(session.systemPrompt[0]).toContain(mcp.name);
			} else {
				expect(session.systemPrompt[0]).not.toContain(mcp.name);
			}
		}
	});

	it("forces extension refresh across RPC replacement in both deferred orders", async () => {
		for (const order of ["owner-first", "extension-first"] as const) {
			const barrier = createPromptBarrier();
			const { session, runner } = newSession({ rebuildSystemPrompt: barrier.rebuild });
			sessions.push(session);
			const extension = createRegisteredTool(`ext_rpc_${order}`, "Extension RPC");
			const rpc = createBasicTool(`rpc_owner_${order}`, "Owner RPC");
			pushTool(runner, extension);
			barrier.arm();

			await raceOwnerAndExtension(
				order,
				() => session.refreshRpcHostTools([rpc]),
				() => session.refreshExtensionTools([extension], { activate: [extension.definition.name] }),
				barrier,
			);

			expect(session.getToolByName(rpc.name)?.label).toBe("Owner RPC");
			expect(session.getToolByName(extension.definition.name)).toBeDefined();
			expect(session.getActiveToolNames()).toEqual(
				order === "owner-first"
					? ["read", rpc.name, extension.definition.name]
					: ["read", extension.definition.name, rpc.name],
			);
			expect(session.systemPrompt[0]).toContain(rpc.name);
			expect(session.systemPrompt[0]).toContain(extension.definition.name);
		}
	});

	it("forces extension refresh across vibe entry and restores the desired baseline in both orders", async () => {
		for (const order of ["owner-first", "extension-first"] as const) {
			const barrier = createPromptBarrier();
			const vibe = createBasicTool(`vibe_entry_${order}`, "Vibe entry");
			const { session, runner } = newSession({
				createVibeTools: () => [vibe],
				rebuildSystemPrompt: barrier.rebuild,
			});
			sessions.push(session);
			const extension = createRegisteredTool(`ext_vibe_entry_${order}`, "Extension vibe entry");
			pushTool(runner, extension);
			barrier.arm();

			await raceOwnerAndExtension(
				order,
				() => session.activateVibeTools(["read"]),
				() => session.refreshExtensionTools([extension], { activate: [extension.definition.name] }),
				barrier,
			);

			expect(session.getToolByName(extension.definition.name)).toBeDefined();
			expect(session.getActiveToolNames()).toEqual(["read", vibe.name]);
			expect(session.systemPrompt[0]).toContain(vibe.name);
			await session.deactivateVibeTools([]);
			expect(session.getActiveToolNames()).toEqual(["read", extension.definition.name]);
		}
	});

	it("forces extension refresh across vibe exit and preserves ownership in both orders", async () => {
		for (const order of ["owner-first", "extension-first"] as const) {
			const barrier = createPromptBarrier();
			const vibe = createBasicTool(`vibe_exit_${order}`, "Vibe exit");
			const { session, runner } = newSession({
				createVibeTools: () => [vibe],
				rebuildSystemPrompt: barrier.rebuild,
			});
			sessions.push(session);
			const extension = createRegisteredTool(`ext_vibe_exit_${order}`, "Extension vibe exit");
			pushTool(runner, extension);
			await session.activateVibeTools(["read"]);
			barrier.arm();

			await raceOwnerAndExtension(
				order,
				() => session.deactivateVibeTools([]),
				() => session.refreshExtensionTools([extension], { activate: [extension.definition.name] }),
				barrier,
			);

			expect(session.getToolByName(extension.definition.name)).toBeDefined();
			expect(session.getActiveToolNames()).toEqual(["read", extension.definition.name]);
			expect(session.systemPrompt[0]).toContain("read");
			expect(session.systemPrompt[0]).toContain(extension.definition.name);
		}
	});
	it("preserves extension activation changes across vibe entry and exit", async () => {
		const vibeTool = createBasicTool("vibe_tool", "Vibe");
		const { session, runner } = newSession({ createVibeTools: () => [vibeTool] });
		sessions.push(session);
		const before = createRegisteredTool("ext_before_vibe", "Before");
		const during = createRegisteredTool("ext_during_vibe", "During");
		pushTool(runner, before);
		await session.refreshExtensionTools([before], { activate: [before.definition.name] });
		await session.activateVibeTools(["read"]);
		pushTool(runner, during);
		await session.refreshExtensionTools([during], { activate: [during.definition.name] });
		await session.deactivateVibeTools(["read"]);
		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", "ext_before_vibe", "ext_during_vibe"]),
		);
		expect(session.getToolByName("vibe_tool")).toBeUndefined();
	});

	it("rolls back vibe registry ownership when activation or deactivation rebuild fails", async () => {
		let fail = false;
		const vibeTool = createBasicTool("vibe_rollback", "Vibe rollback");
		const { session } = newSession({
			createVibeTools: () => [vibeTool],
			rebuildSystemPrompt: async toolNames => {
				if (fail) throw new Error("vibe rebuild failed");
				return toolNames.join(",");
			},
		});
		sessions.push(session);
		await session.setActiveToolsByName(["read"]);
		fail = true;
		await expect(session.activateVibeTools(["read"])).rejects.toThrow("vibe rebuild failed");
		expect(session.getToolByName("vibe_rollback")).toBeUndefined();
		expect(session.getActiveToolNames()).toEqual(["read"]);

		fail = false;
		await session.activateVibeTools(["read"]);
		fail = true;
		await expect(session.deactivateVibeTools(["read"])).rejects.toThrow("vibe rebuild failed");
		expect(session.getToolByName("vibe_rollback")).toBeDefined();
		expect(session.getActiveToolNames()).toContain("vibe_rollback");
	});

	it("rejects activation deltas for tools not owned by the extension set", async () => {
		const { session } = newSession();
		sessions.push(session);
		await expect(session.refreshExtensionTools([], { activate: ["read"] })).rejects.toThrow(/extension-owned/);
	});

	it("does not let MCP refresh delete or replace an extension with an MCP-shaped name", async () => {
		const { session, runner } = newSession();
		sessions.push(session);
		const extension = createRegisteredTool("mcp__extension_owned", "Extension");
		pushTool(runner, extension);
		await session.refreshExtensionTools([extension], { activate: [extension.definition.name] });
		await session.refreshMCPTools([]);
		expect(session.getToolByName(extension.definition.name)?.label).toBe("Extension");
		const mcp: CustomTool = {
			name: extension.definition.name,
			label: "MCP replacement",
			description: "MCP replacement",
			parameters: type({ value: "string" }),
			async execute() {
				return { content: [{ type: "text", text: "mcp" }] };
			},
		};
		await expect(session.refreshMCPTools([mcp])).rejects.toThrow(/conflicts/);
		expect(session.getToolByName(extension.definition.name)?.label).toBe("Extension");
	});

	it("cannot stale-commit a base prompt rebuild after an extension refresh", async () => {
		const firstStarted = deferred<void>();
		const releaseFirst = deferred<void>();
		let rebuildCount = 0;
		const { session, runner } = newSession({
			rebuildSystemPrompt: async toolNames => {
				rebuildCount++;
				if (rebuildCount === 1) {
					firstStarted.resolve(undefined);
					await releaseFirst.promise;
				}
				return `tools:${toolNames.join(",")}`;
			},
		});
		sessions.push(session);
		const first = session.refreshBaseSystemPrompt();
		await firstStarted.promise;
		const extension = createRegisteredTool("ext_prompt_race", "Prompt race");
		pushTool(runner, extension);
		const refresh = session.refreshExtensionTools([extension], { activate: [extension.definition.name] });
		releaseFirst.resolve(undefined);
		await Promise.all([first, refresh]);
		expect(session.systemPrompt[0]).toContain("ext_prompt_race");
	});

	it("keeps the canonical definition when the originally registered object is mutated in place", async () => {
		const { session, runner } = newSession();
		sessions.push(session);
		const tool = createRegisteredTool("ext_mutated", "Original");
		pushTool(runner, tool);
		await session.refreshExtensionTools([tool], { activate: [tool.definition.name] });
		tool.definition.label = "Mutated";
		await expect(session.refreshExtensionTools([tool], {})).resolves.toBeUndefined();
		expect(session.getToolByName(tool.definition.name)?.label).toBe("Original");
	});

	it("keeps detached callable validation stable and rejects semantic source mutation", async () => {
		const schema = type({ value: "string" }) as unknown as CallableTestSchema;
		const { session, runner } = await newProductionCallableSession(schema);
		sessions.push(session);
		const registered = runner.getAllRegisteredTools()[0];
		expect(registered).toBeDefined();
		const toolName = registered!.definition.name;

		await session.refreshExtensionTools(runner.getAllRegisteredTools(), { activate: [toolName] });
		const liveTool = session.getToolByName(toolName);
		expect(liveTool).toBeDefined();
		expect(typeof liveTool?.parameters).toBe("object");
		expect(Object.isFrozen(liveTool?.parameters)).toBe(true);

		const validCall = {
			type: "toolCall" as const,
			id: "call-valid",
			name: toolName,
			arguments: { value: "Original" },
		};
		expect(validateToolArguments(liveTool!, validCall)).toEqual({ value: "Original" });
		expect(() =>
			validateToolArguments(liveTool!, {
				...validCall,
				id: "call-invalid",
				arguments: {},
			}),
		).toThrow(/Validation failed/);

		schema.rootApply = (() => ({ value: "Mutated" })) as CallableTestSchema["rootApply"];
		schema.assert = (() => ({ value: "Mutated" })) as CallableTestSchema["assert"];

		expect(validateToolArguments(liveTool!, validCall)).toEqual({ value: "Original" });
		expect(() =>
			validateToolArguments(liveTool!, {
				...validCall,
				id: "call-invalid-after-mutation",
				arguments: {},
			}),
		).toThrow(/Validation failed/);
		await expect(session.refreshExtensionTools(runner.getAllRegisteredTools(), {})).rejects.toThrow(
			/different definition|changed/i,
		);
	});
});
