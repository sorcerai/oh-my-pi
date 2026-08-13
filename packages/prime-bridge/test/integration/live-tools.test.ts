import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveBridgeConfig } from "../../src/config";
import { type PrimeBridgeServer, startPrimeBridgeServer } from "../../src/server";
import { startFauxOpenAIProvider } from "../fixtures/faux-provider/server";

type NativeResult = {
	readonly tools: readonly { readonly name: string }[];
	readonly read?: unknown;
	readonly denied?: { readonly isError: boolean; readonly text: string };
	readonly canceled?: boolean;
	readonly progressCallbacks?: number;
	readonly error?: string;
};

const temporaryDirectories: string[] = [];
const runningServers: PrimeBridgeServer[] = [];
const sessions: AgentSession[] = [];
const authStorages: AuthStorage[] = [];

function modelForProvider(baseUrl: string) {
	const bundled = getBundledModel<"openai-completions">("xai", "grok-code-fast-1");
	if (!bundled) throw new Error("missing public OpenAI-compatible catalog model for live bridge proof");
	return { ...bundled, baseUrl, compat: { ...bundled.compat, requiresToolResultName: true } };
}

function readTool(root: string): CustomTool {
	return {
		name: "read",
		label: "Read",
		description: "Read a file from this session's working directory.",
		parameters: type({ path: "string" }),
		execute: async (_toolCallId, args) => {
			const input = type({ path: "string" }).assert(args);
			const content = await fs.readFile(path.join(root, input.path), "utf8");
			return { content: [{ type: "text", text: content }] };
		},
	} as CustomTool;
}

type CancellationObservation = {
	approvalPrompt?: string;
	approvalSettled: boolean;
	executionStarted: boolean;
	releaseApproval: () => void;
};

function pendingApprovalUI(observation: CancellationObservation): ExtensionUIContext {
	let settleApproval: (() => void) | undefined;
	observation.releaseApproval = () => settleApproval?.();
	return {
		// ExtensionToolWrapper calls only select() for this path. Do not invent behavior
		// for unrelated UI methods in this focused integration fixture.
		select: async (title: string, _options: ExtensionUISelectItem[], dialogOptions?: ExtensionUIDialogOptions) => {
			observation.approvalPrompt = title;
			await new Promise<void>((resolve, reject) => {
				settleApproval = () => {
					observation.approvalSettled = true;
					resolve();
				};
				const signal = dialogOptions?.signal;
				if (signal?.aborted) {
					observation.approvalSettled = true;
					reject(signal.reason);
					return;
				}
				signal?.addEventListener(
					"abort",
					() => {
						observation.approvalSettled = true;
						reject(signal.reason);
					},
					{ once: true },
				);
			});
			return undefined;
		},
	} as unknown as ExtensionUIContext;
}

function approvalWriteTool(observation: CancellationObservation): CustomTool {
	return {
		name: "write",
		label: "Write",
		description: "A write requiring a controlled approval wait.",
		parameters: type({ path: "string", content: "string" }),
		approval: { tier: "write", reason: "controlled cancellation approval wait" },
		execute: async () => {
			observation.executionStarted = true;
			return { content: [{ type: "text", text: "write unexpectedly executed" }] };
		},
	} as CustomTool;
}

async function makeRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(root);
	return root;
}

async function startBridge(root: string): Promise<PrimeBridgeServer> {
	const stateDir = path.join(root, "bridge-state");
	const config = resolveBridgeConfig({
		stateDir,
		primeConfigFile: path.join(stateDir, "omp-bridge.json"),
		port: 0,
	});
	const server = await startPrimeBridgeServer({ config, peers: () => [] });
	runningServers.push(server);
	return server;
}

async function startSession(
	root: string,
	bridge: PrimeBridgeServer,
	providerUrl: string,
	tools: CustomTool[],
	allowTools: readonly string[],
	approvalMode: "always-ask" | "write" | "yolo" = "yolo",
	approvalUI?: ExtensionUIContext,
): Promise<AgentSession> {
	const agentDir = path.join(root, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
	authStorages.push(authStorage);
	const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
	const created = await createAgentSession({
		cwd: root,
		agentDir,
		authStorage,
		modelRegistry,
		model: modelForProvider(providerUrl),
		getApiKey: () => "offline-faux-key",
		sessionManager: SessionManager.inMemory(root),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"plan.enabled": false,
			"tools.approvalMode": approvalMode,
			"primeBridge.toolHost.enabled": true,
			"primeBridge.url": bridge.url,
			"primeBridge.tokenPath": bridge.tokenFile,
			"primeBridge.toolHost.allowTools": [...allowTools],
			"primeBridge.toolHost.approvalTimeoutMs": 1_000,
		}),
		customTools: tools,
		toolNames: tools.map(tool => tool.name),
		restrictToolNames: true,
		allowRestrictedCustomTools: true,
		enableMCP: false,
		enableLsp: false,
		disableExtensionDiscovery: true,
		skipPythonPreflight: true,
	});
	const session = created.session;
	if (approvalUI !== undefined) {
		created.setToolUIContext(approvalUI, true);
		await initializeExtensions(session, {
			reportSendError: () => {},
			reportRuntimeError: () => {},
			uiContext: approvalUI,
		});
	}
	sessions.push(session);
	return session;
}

async function runNativeOmpTools(
	executable: string,
	configPath: string,
	sessionId: string,
	operation: "read" | "deny-write" | "cancel-write",
): Promise<NativeResult> {
	const root = await makeRoot("prime-bridge-native-runner-");
	const scriptPath = path.join(root, "runner.py");
	const skillSource = path.resolve(import.meta.dir, "..", "..", "prime-skill-tools", "src");
	const primeRoot = path.dirname(executable);
	const runtimeRoot = path.join(primeRoot, "prime-agent-runtime");
	await fs.writeFile(
		scriptPath,
		[
			"import asyncio, json, sys",
			"from contextlib import AsyncExitStack",
			"from omp_tools import OmpTools",
			"",
			"async def main():",
			"    integration = OmpTools().connect(sys.argv[1], config_path=sys.argv[2])",
			"    tools = await integration.list_tools()",
			"    output = {'tools': [{'name': item['name']} for item in tools]} ",
			"    if sys.argv[3] == 'read':",
			"        output['read'] = await integration.call_tool('read', {'path': 'same.txt'})",
			"    elif sys.argv[3] == 'deny-write':",
			"        async with AsyncExitStack() as stack:",
			"            session = await integration._open_session(stack)",
			"            result = await session.call_tool('write', {'path': 'same.txt', 'content': 'nope'})",
			"            output['denied'] = {'isError': bool(result.is_error), 'text': ' '.join(getattr(block, 'text', '') or '' for block in result.content)}",
			"    else:",
			"        callbacks = 0",
			"        async with AsyncExitStack() as stack:",
			"            session = await integration._open_session(stack)",
			"            def progress(_progress):",
			"                nonlocal callbacks",
			"                callbacks += 1",
			"            task = asyncio.create_task(session.call_tool('write', {'path': 'same.txt', 'content': 'nope'}, progress_callback=progress))",
			"            await asyncio.sleep(0.15)",
			"            task.cancel()",
			"            try:",
			"                result = await task",
			"                output['completed'] = True",
			"                output['completedText'] = ' '.join(getattr(block, 'text', '') or '' for block in result.content)",
			"            except asyncio.CancelledError:",
			"                output['canceled'] = True",
			"            except Exception as error:",
			"                output['clientError'] = str(error)",
			"            output['progressCallbacks'] = callbacks",
			"    print(json.dumps(output))",
			"",
			"asyncio.run(main())",
		].join("\n"),
	);
	const pythonEnv = {
		...process.env,
		PYTHONPATH: [skillSource, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
	};
	const child = Bun.spawn(
		[
			"uv",
			"run",
			"--with",
			"mcp",
			"--with",
			"httpx",
			"--with",
			runtimeRoot,
			"python",
			scriptPath,
			sessionId,
			configPath,
			operation,
		],
		{ cwd: primeRoot, env: pythonEnv, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	const exitCode = await child.exited;
	if (exitCode !== 0) return { tools: [], error: `native runner exited ${exitCode}: ${stderr}` };
	try {
		return JSON.parse(stdout.trim()) as NativeResult;
	} catch (error) {
		return { tools: [], error: `native runner emitted invalid JSON: ${stdout} ${String(error)}` };
	}
}

afterEach(async () => {
	await Promise.all(sessions.splice(0).map(session => session.dispose().catch(() => undefined)));
	await Promise.all(runningServers.splice(0).map(server => server.stop().catch(() => undefined)));
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	await Promise.all(temporaryDirectories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("live Prime native OMP tools bridge", () => {
	it.skipIf(!process.env.PRIME_AGENT_BIN)(
		"serves live read results, denies write, isolates same-name sessions, and records the approval-cancellation boundary",
		async () => {
			const executable = process.env.PRIME_AGENT_BIN;
			if (!executable) throw new Error("PRIME_AGENT_BIN is required for the live Prime bridge proof");
			const root = await makeRoot("prime-bridge-live-tools-");
			const firstRoot = path.join(root, "first");
			const secondRoot = path.join(root, "second");
			await fs.mkdir(firstRoot, { recursive: true });
			await fs.mkdir(secondRoot, { recursive: true });
			await fs.writeFile(path.join(firstRoot, "same.txt"), "first-session-content\n");
			await fs.writeFile(path.join(secondRoot, "same.txt"), "second-session-content\n");
			const provider = await startFauxOpenAIProvider();
			try {
				const bridge = await startBridge(root);
				const first = await startSession(firstRoot, bridge, provider.url, [readTool(firstRoot)], ["read"]);
				const second = await startSession(secondRoot, bridge, provider.url, [readTool(secondRoot)], ["read"]);
				const firstNative = await runNativeOmpTools(
					executable,
					bridge.config.primeConfigFile,
					first.sessionId,
					"read",
				);
				const secondNative = await runNativeOmpTools(
					executable,
					bridge.config.primeConfigFile,
					second.sessionId,
					"read",
				);
				expect(firstNative.error).toBeUndefined();
				expect(secondNative.error).toBeUndefined();
				expect(firstNative.tools.map(tool => tool.name)).toEqual(["read"]);
				expect(secondNative.tools.map(tool => tool.name)).toEqual(["read"]);
				expect(JSON.stringify(firstNative.read)).toContain("first-session-content");
				expect(JSON.stringify(firstNative.read)).not.toContain("second-session-content");
				expect(JSON.stringify(secondNative.read)).toContain("second-session-content");
				expect(JSON.stringify(secondNative.read)).not.toContain("first-session-content");

				const denied = await runNativeOmpTools(
					executable,
					bridge.config.primeConfigFile,
					first.sessionId,
					"deny-write",
				);
				expect(denied.tools.map(tool => tool.name)).toEqual(["read"]);
				expect(denied.denied?.isError).toBe(true);
				expect(denied.denied?.text).toContain("unknown");
				const cancellationObservation: CancellationObservation = {
					approvalSettled: false,
					executionStarted: false,
					releaseApproval: () => {},
				};

				const cancellationRoot = path.join(root, "cancellation");
				await fs.mkdir(cancellationRoot, { recursive: true });
				const cancellationSession = await startSession(
					cancellationRoot,
					bridge,
					provider.url,
					[approvalWriteTool(cancellationObservation)],
					["write"],
					"always-ask",
					pendingApprovalUI(cancellationObservation),
				);
				try {
					const canceled = await runNativeOmpTools(
						executable,
						bridge.config.primeConfigFile,
						cancellationSession.sessionId,
						"cancel-write",
					);
					expect(canceled.error).toBeUndefined();
					expect(canceled.tools.map(tool => tool.name)).toEqual(["write"]);
					expect(canceled.canceled).toBe(true);
					expect(canceled.progressCallbacks).toBe(0);
					expect(cancellationObservation.approvalPrompt).toContain("controlled cancellation approval wait");
					// The repaired public approval path forwards the host abort signal into
					// the controlled waiter. Cancellation must settle approval before the
					// tool can cross into execution.
					expect(cancellationObservation.approvalSettled).toBe(true);
				} finally {
					cancellationObservation.releaseApproval();
					expect(cancellationObservation.executionStarted).toBe(false);
				}
			} finally {
				await provider.stop();
			}
		},
		60_000,
	);
});
