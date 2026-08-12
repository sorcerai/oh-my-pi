import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Message, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	AgentSession,
	AuthStorage,
	ModelRegistry,
	type SessionEntry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";
import { FileCas } from "../../src/session/cas";
import { projectToOmp } from "../../src/session/omp-projector";
import { readOmpSession } from "../../src/session/omp-reader";
import { projectToPrime } from "../../src/session/prime-projector";
import { readPrimeSession } from "../../src/session/prime-reader";
import type { CanonicalToolPair, SessionSpecNode, SessionSpecV1 } from "../../src/session/spec";
import {
	type FauxOpenAIMessage,
	type FauxOpenAIRequestRecord,
	startFauxOpenAIProvider,
} from "../fixtures/faux-provider/server";

const primeFixture = path.join(import.meta.dir, "..", "fixtures", "sessions", "prime-v3.jsonl");
const ompFixture = path.join(import.meta.dir, "..", "fixtures", "sessions", "omp-v3.jsonl");
const ompFixtureBlobBytes = Buffer.from("omp-image-bytes");
const ompFixtureBlobHash = new Bun.SHA256().update(ompFixtureBlobBytes).digest("hex");
const followUp = "Continue this resumed session deterministically.";
const temporaryDirectories: string[] = [];

type HistoricalRef = { readonly hash: string; readonly byteLength?: number };

type RpcRecord = {
	readonly type: string;
	readonly id?: string;
	readonly success?: boolean;
	readonly command?: string;
	readonly data?: unknown;
	readonly messages?: readonly unknown[];
};

function isRpcRecord(value: unknown): value is RpcRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof Reflect.get(value, "type") === "string"
	);
}

async function makeRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(root);
	return root;
}

function branchTips(spec: SessionSpecV1): SessionSpecNode[] {
	const parents = new Set(spec.nodes.flatMap(node => (node.parentId === null ? [] : [node.parentId])));
	return spec.nodes.filter(node => !parents.has(node.id));
}

function pathTo(spec: SessionSpecV1, leafId: string): SessionSpecNode[] {
	const byId = new Map(spec.nodes.map(node => [node.id, node]));
	const result: SessionSpecNode[] = [];
	let node = byId.get(leafId);
	while (node !== undefined) {
		result.push(node);
		node = node.parentId === null ? undefined : byId.get(node.parentId);
	}
	return result.reverse();
}
function isProviderCompletePath(path: readonly SessionSpecNode[]): boolean {
	const priorCalls = new Map<string, string>();
	const results = new Set<string>();
	for (const node of path) {
		if (node.role === "assistant")
			for (const pair of node.toolPairs ?? []) priorCalls.set(pair.callId, pair.toolName);
		else if (node.role === "toolResult")
			for (const pair of node.toolPairs ?? []) {
				if (priorCalls.get(pair.callId) !== pair.toolName) return false;
				results.add(pair.callId);
			}
	}
	return [...priorCalls.keys()].every(callId => results.has(callId));
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content) ?? "";
	return content
		.filter(
			item =>
				typeof item === "object" && item !== null && !Array.isArray(item) && "type" in item && item.type === "text",
		)
		.map(item => {
			if (typeof item !== "object" || item === null || Array.isArray(item) || !("text" in item)) return "";
			return typeof item.text === "string" ? item.text : "";
		})
		.join("");
}

type ExpectedProviderMessage = {
	readonly role: "user" | "assistant" | "tool";
	readonly calls?: readonly { readonly id: string; readonly name: string }[];
	readonly result?: { readonly id: string; readonly name: string };
};

function expectedProviderTrace(entries: readonly SessionEntry[]): ExpectedProviderMessage[] {
	const trace: ExpectedProviderMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			trace.push({ role: "user" });
		} else if (message.role === "assistant") {
			const calls = Array.isArray(message.content)
				? message.content
						.filter(block => block.type === "toolCall")
						.map(block => ({ id: block.id, name: block.name }))
				: [];
			trace.push({ role: "assistant", calls });
		} else if (message.role === "toolResult") {
			trace.push({ role: "tool", result: { id: message.toolCallId, name: message.toolName } });
		}
	}
	return trace;
}
function expectedProviderTraceForSpec(spec: SessionSpecV1, leafId: string): ExpectedProviderMessage[] {
	const trace: ExpectedProviderMessage[] = [];
	for (const node of pathTo(spec, leafId)) {
		if (node.role === "user") {
			trace.push({ role: "user" });
		} else if (node.role === "assistant") {
			trace.push({
				role: "assistant",
				calls: (node.toolPairs ?? []).map(pair => ({ id: pair.callId, name: pair.toolName })),
			});
		} else if (node.role === "toolResult") {
			for (const pair of node.toolPairs ?? []) {
				trace.push({ role: "tool", result: { id: pair.callId, name: pair.toolName } });
			}
		}
	}
	return trace;
}

function assertProviderBoundTrace(record: FauxOpenAIRequestRecord, expected: readonly ExpectedProviderMessage[]): void {
	if (!record.valid) throw new Error(`Provider rejected history: ${record.error ?? "unknown error"}`);
	const actual = record.request.messages.filter(
		(message): message is FauxOpenAIMessage & { role: "user" | "assistant" | "tool" } =>
			message.role === "user" || message.role === "assistant" || message.role === "tool",
	);
	expect(actual).toHaveLength(expected.length + 1);
	for (const [index, expectedMessage] of expected.entries()) {
		const message = actual[index];
		expect(message?.role).toBe(expectedMessage.role);
		if (expectedMessage.role === "assistant") {
			const calls = (message?.tool_calls ?? []).map(call => ({
				id: String(call.id),
				name: String(call.function?.name),
			}));
			expect(calls).toEqual([...(expectedMessage.calls ?? [])]);
		} else if (expectedMessage.role === "tool") {
			if (expectedMessage.result === undefined)
				throw new Error("Expected tool trace is missing its result identity");
			expect(message?.tool_call_id).toBe(expectedMessage.result.id);
			if (message?.name !== undefined) expect(message.name).toBe(expectedMessage.result.name);
		}
	}
	const followUpMessage = actual.at(-1);
	expect(followUpMessage?.role).toBe("user");
	expect(textFromContent(followUpMessage?.content)).toContain(followUp);
}
function assertProviderAcceptedToolTrace(
	record: FauxOpenAIRequestRecord,
	expected: readonly ExpectedProviderMessage[],
): void {
	if (!record.valid)
		throw new Error(
			`Provider rejected history: ${record.error ?? "unknown error"}\n${JSON.stringify(
				record.request.messages
					.filter(message => message.role !== "system")
					.map(message => ({
						role: message.role,
						calls: message.tool_calls?.map(call => ({ id: call.id, name: call.function?.name })),
						result: message.tool_call_id,
						name: message.name,
					})),
			)}`,
		);
	const actualCalls = new Map(
		record.request.messages.flatMap(message =>
			message.role === "assistant"
				? (message.tool_calls ?? []).map(call => [String(call.id), String(call.function?.name)] as const)
				: [],
		),
	);
	const actualResults = new Map(
		record.request.messages.flatMap(message =>
			message.role === "tool"
				? [[String(message.tool_call_id), message.name === undefined ? undefined : String(message.name)] as const]
				: [],
		),
	);
	for (const expectedMessage of expected) {
		for (const call of expectedMessage.calls ?? []) expect(actualCalls.get(call.id)).toBe(call.name);
		if (expectedMessage.result !== undefined) {
			expect(actualResults.has(expectedMessage.result.id)).toBe(true);
			const actualName = actualResults.get(expectedMessage.result.id);
			if (actualName !== undefined) expect(actualName).toBe(expectedMessage.result.name);
		}
	}
	const followUpMessage = record.request.messages.at(-1);
	expect(followUpMessage?.role).toBe("user");
	expect(textFromContent(followUpMessage?.content)).toContain(followUp);
}

function refsForPair(pair: CanonicalToolPair): HistoricalRef[] {
	return [pair.originalCallRef, pair.synthesizedCallRef, pair.resultRef].filter(
		(ref): ref is HistoricalRef => ref !== undefined,
	);
}

async function captureHistoricalToolBytes(spec: SessionSpecV1, cas: FileCas): Promise<Map<string, Uint8Array>> {
	const bytes = new Map<string, Uint8Array>();
	for (const node of spec.nodes) {
		for (const pair of node.toolPairs ?? []) {
			for (const ref of refsForPair(pair)) bytes.set(ref.hash, await cas.read(ref));
		}
	}
	return bytes;
}

async function assertHistoricalTools(
	source: SessionSpecV1,
	restored: SessionSpecV1,
	cas: FileCas,
	bytes: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
	const restoredById = new Map(restored.nodes.map(node => [node.id, node]));
	for (const sourceNode of source.nodes) {
		const restoredNode = restoredById.get(sourceNode.id);
		if (!restoredNode) throw new Error(`restored session omitted ${sourceNode.id}`);
		for (const sourcePair of sourceNode.toolPairs ?? []) {
			const restoredPair = restoredNode.toolPairs?.find(
				pair => pair.callId === sourcePair.callId && pair.toolName === sourcePair.toolName,
			);
			if (!restoredPair) throw new Error(`restored session omitted tool pair ${sourcePair.callId}`);
			for (const ref of refsForPair(sourcePair)) {
				expect(refsForPair(restoredPair)).toContainEqual(ref);
				const expected = bytes.get(ref.hash);
				if (!expected) throw new Error(`missing captured CAS bytes for ${ref.hash}`);
				expect(await cas.read(ref)).toEqual(expected);
			}
		}
	}
	for (const loss of source.lossLedger) expect(restored.lossLedger).toContainEqual(loss);
}

function modelForProvider(baseUrl: string): Model<"openai-completions"> {
	const bundled = getBundledModel<"openai-completions">("xai", "grok-code-fast-1");
	if (!bundled) throw new Error("missing public OpenAI-compatible catalog model for offline proof");
	return { ...bundled, baseUrl, compat: { ...bundled.compat, requiresToolResultName: true } };
}
function nativeAgentMessages(entries: readonly SessionEntry[]): Message[] {
	return entries.flatMap(entry => {
		if (entry.type !== "message") return [];
		const message = entry.message;
		return message.role === "user" || message.role === "assistant" || message.role === "toolResult" ? [message] : [];
	});
}

async function continueThroughOmpAgent(manager: SessionManager, root: string, baseUrl: string): Promise<string> {
	const authStorage = await AuthStorage.create(path.join(root, "omp-auth.db"));
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "omp-models.yml"));
	const model = modelForProvider(baseUrl);
	authStorage.setRuntimeApiKey(model.provider, "offline-faux-key");
	const agent = new Agent({
		getApiKey: () => "offline-faux-key",
		initialState: {
			model,
			systemPrompt: [],
			tools: [],
			messages: nativeAgentMessages(manager.getBranch()),
		},
		streamFn: streamSimple,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
		modelRegistry,
	});
	try {
		await session.prompt(followUp);
		const assistant = agent.state.messages.at(-1);
		if (assistant?.role !== "assistant") throw new Error("OMP prompt did not produce an assistant response");
		return textFromContent(assistant.content);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

async function continueThroughPrimeRpc(
	executable: string,
	projectedPath: string,
	primeHome: string,
	baseUrl: string,
): Promise<RpcRecord> {
	await fs.writeFile(
		path.join(primeHome, "models.json"),
		JSON.stringify({
			providers: {
				"faux-resume": {
					baseUrl,
					api: "openai-completions",
					apiKey: "offline-faux-key",
					models: [{ id: "resume-model", name: "Resume Model", reasoning: false }],
				},
			},
		}),
	);
	const executableArgs = executable.endsWith(".js") ? ["node", executable] : [executable];
	const child = Bun.spawn(
		[
			...executableArgs,
			"--mode",
			"rpc",
			"--daemon-socket",
			path.join(primeHome, "daemon.sock"),
			"--provider",
			"faux-resume",
			"--model",
			"resume-model",
			"--session-dir",
			path.dirname(projectedPath),
		],
		{
			cwd: path.dirname(projectedPath),
			env: { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: primeHome },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderrReader = child.stderr.getReader();
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let stderrText = "";
	const stderrPump = (async (): Promise<void> => {
		while (true) {
			const chunk = await stderrReader.read();
			if (chunk.done) return;
			stderrText += decoder.decode(chunk.value, { stream: true });
		}
	})();
	let buffered = "";
	const nextRecord = async (): Promise<RpcRecord> => {
		while (true) {
			const newline = buffered.indexOf("\n");
			if (newline >= 0) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line.length === 0) continue;
				const parsed: unknown = JSON.parse(line);
				if (!isRpcRecord(parsed)) throw new Error(`Prime RPC emitted an invalid record: ${line}`);
				return parsed;
			}
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`Prime RPC exited before completion: ${stderrText}`);
			buffered += decoder.decode(chunk.value, { stream: true });
		}
	};
	const waitFor = async (predicate: (record: RpcRecord) => boolean): Promise<RpcRecord> => {
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const record = await Promise.race([
				nextRecord(),
				Bun.sleep(remaining).then(() => {
					throw new Error(`Prime RPC response timed out: ${stderrText}`);
				}),
			]);
			if (predicate(record)) return record;
		}
		throw new Error(`Prime RPC response timed out: ${stderrText}`);
	};
	const send = (record: Record<string, unknown>): void => {
		child.stdin.write(`${JSON.stringify(record)}\n`);
		child.stdin.flush();
	};
	try {
		send({ id: "switch", type: "switch_session", sessionPath: projectedPath });
		const switched = await waitFor(record => record.id === "switch");
		if (switched.success !== true) throw new Error(`Prime RPC switch_session failed: ${JSON.stringify(switched)}`);
		send({ id: "prompt", type: "prompt", message: followUp });
		const accepted = await waitFor(record => record.id === "prompt");
		if (accepted.success !== true) throw new Error(`Prime RPC prompt failed: ${JSON.stringify(accepted)}`);
		return await waitFor(record => record.type === "agent_end");
	} finally {
		child.stdin.end();
		child.kill();
		await child.exited;
		await reader.cancel();
		await stderrPump;
	}
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("session resume integration proof", () => {
	it("validates Prime-to-OMP-to-Prime and OMP-to-Prime-to-OMP branches, tool CAS bytes, and loss parity", async () => {
		const root = await makeRoot("session-resume-schema-");
		const primeCas = new FileCas(path.join(root, "prime-state"));
		const ompCas = new FileCas(path.join(root, "omp-state"));
		const primeSource = await readPrimeSession(primeFixture, primeCas);
		const ompFixtureAgentDir = path.join(root, "omp-fixture-agent");
		await fs.mkdir(path.join(ompFixtureAgentDir, "blobs"), { recursive: true });
		await fs.writeFile(path.join(ompFixtureAgentDir, "blobs", ompFixtureBlobHash), ompFixtureBlobBytes);
		const incompleteOmpSource = await readOmpSession(ompFixture, ompCas, {
			ompAgentDir: ompFixtureAgentDir,
		});
		expect(await ompCas.read(ompFixtureBlobHash)).toEqual(ompFixtureBlobBytes);
		const fixturePrime = await projectToPrime(incompleteOmpSource, {
			primeHome: path.join(root, "fixture-omp-to-prime"),
			cas: ompCas,
			sessionId: "11111111-1111-4111-8111-111111111111",
			now: () => "2026-08-12T00:00:00.000Z",
		});
		const restoredFixturePrime = await readPrimeSession(fixturePrime.path, ompCas, {
			trustedBridgeDigest: fixturePrime.report.bridgeDigest,
		});
		const projectedIncompleteReturn = await projectToOmp(restoredFixturePrime, {
			cwd: root,
			sessionDir: path.join(root, "incomplete-omp-return"),
			cas: ompCas,
		});
		const restoredIncompleteOmp = await readOmpSession(projectedIncompleteReturn.path, ompCas, {
			trustedBridgeDigest: projectedIncompleteReturn.report.bridgeDigest,
		});
		expect(restoredIncompleteOmp.lossLedger).toEqual([...projectedIncompleteReturn.report.losses]);
		expect(restoredIncompleteOmp.lossLedger).toContainEqual(
			expect.objectContaining({
				code: "blob_unavailable",
				detail: `OMP blob is unavailable: ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`,
				sourceType: "blob",
			}),
		);
		const ompSeedCanonical = await readPrimeSession(primeFixture, ompCas);
		const ompSeed = await projectToOmp(ompSeedCanonical, {
			cwd: root,
			sessionDir: path.join(root, "blob-complete-omp-source"),
			cas: ompCas,
		});
		const ompSource = await readOmpSession(ompSeed.path, ompCas, {
			trustedBridgeDigest: ompSeed.report.bridgeDigest,
		});
		for (const [source, cas, kind] of [
			[primeSource, primeCas, "prime"],
			[ompSource, ompCas, "omp"],
		] as const) {
			const bytes = await captureHistoricalToolBytes(source, cas);
			for (const tip of branchTips(source)) {
				const sourceForTip: SessionSpecV1 = { ...source, activeLeafId: tip.id };
				if (kind === "prime") {
					const projectedToOmp = await projectToOmp(sourceForTip, {
						cwd: root,
						sessionDir: path.join(root, "prime-to-omp", tip.id),
						cas,
					});
					const restoredInOmp = await readOmpSession(projectedToOmp.path, cas, {
						trustedBridgeDigest: projectedToOmp.report.bridgeDigest,
					});
					expect(restoredInOmp.activeLeafId).toBe(tip.id);
					expect(restoredInOmp.lossLedger).toEqual([...projectedToOmp.report.losses]);
					await assertHistoricalTools(sourceForTip, restoredInOmp, cas, bytes);

					const projectedBackToPrime = await projectToPrime(restoredInOmp, {
						primeHome: path.join(root, "prime-to-omp-to-prime", tip.id),
						cas,
						sessionId: "11111111-1111-4111-8111-111111111111",
						now: () => "2026-08-12T00:00:00.000Z",
					});
					const restoredInPrime = await readPrimeSession(projectedBackToPrime.path, cas, {
						trustedBridgeDigest: projectedBackToPrime.report.bridgeDigest,
					});
					expect(restoredInPrime.activeLeafId).toBe(tip.id);
					expect(restoredInPrime.lossLedger).toEqual([...projectedBackToPrime.report.losses]);
					await assertHistoricalTools(sourceForTip, restoredInPrime, cas, bytes);
				} else {
					const projectedToPrime = await projectToPrime(sourceForTip, {
						primeHome: path.join(root, "omp-to-prime", tip.id),
						cas,
						sessionId: "11111111-1111-4111-8111-111111111111",
						now: () => "2026-08-12T00:00:00.000Z",
					});
					const restoredInPrime = await readPrimeSession(projectedToPrime.path, cas, {
						trustedBridgeDigest: projectedToPrime.report.bridgeDigest,
					});
					expect(restoredInPrime.activeLeafId).toBe(tip.id);
					expect(restoredInPrime.lossLedger).toEqual([...projectedToPrime.report.losses]);
					await assertHistoricalTools(sourceForTip, restoredInPrime, cas, bytes);

					const projectedBackToOmp = await projectToOmp(restoredInPrime, {
						cwd: root,
						sessionDir: path.join(root, "omp-to-prime-to-omp", tip.id),
						cas,
					});
					const restoredInOmp = await readOmpSession(projectedBackToOmp.path, cas, {
						trustedBridgeDigest: projectedBackToOmp.report.bridgeDigest,
					});
					expect(restoredInOmp.activeLeafId).toBe(tip.id);
					expect(restoredInOmp.lossLedger).toEqual([...projectedBackToOmp.report.losses]);
					await assertHistoricalTools(sourceForTip, restoredInOmp, cas, bytes);
				}
			}
		}
	});

	it("continues every Prime fixture branch tip through the OMP provider adapter", async () => {
		const root = await makeRoot("omp-session-resume-");
		const cas = new FileCas(path.join(root, "state"));
		const source = await readPrimeSession(primeFixture, cas);
		let sawToolBranch = false;
		for (const tip of branchTips(source)) {
			const sourceForTip: SessionSpecV1 = {
				...source,
				header: { ...source.header, cwd: root },
				activeLeafId: tip.id,
			};
			const sessionDir = path.join(root, "sessions", tip.id);
			const projected = await projectToOmp(sourceForTip, {
				cwd: root,
				sessionDir,
				cas,
			});
			const provider = await startFauxOpenAIProvider({ expectedPrompt: followUp });
			let manager: SessionManager | undefined;
			try {
				manager = await SessionManager.open(projected.path, sessionDir);
				expect(manager.getLeafId()).toBe(projected.report.nativeIdMap[tip.id]?.omp ?? null);
				const expected = expectedProviderTrace(manager.getBranch());
				sawToolBranch ||= expected.some(message => (message.calls?.length ?? 0) > 0 || message.role === "tool");
				const followUpText = await continueThroughOmpAgent(manager, root, provider.url);
				expect(followUpText).toBe("faux-resume-ok");
				expect(provider.requests).toHaveLength(1);
				assertProviderBoundTrace(provider.requests[0]!, expected);
			} finally {
				await manager?.close();
				await provider.stop();
			}
		}
		expect(sawToolBranch).toBe(true);
	});

	it("rejects malformed destination-built provider history before completion", async () => {
		const provider = await startFauxOpenAIProvider();
		try {
			const response = await fetch(`${provider.url}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "resume-model",
					messages: [
						{ role: "user", content: "history" },
						{
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call-malformed",
									type: "function",
									function: { name: "read", arguments: "{}" },
								},
							],
						},
						{ role: "tool", name: "wrong-name", tool_call_id: "call-malformed", content: "result" },
					],
				}),
			});
			expect(response.status).toBe(400);
			expect(provider.requests).toHaveLength(1);
			expect(provider.requests[0]?.valid).toBe(false);
			expect(provider.requests[0]?.error).toContain("expected read");
		} finally {
			await provider.stop();
		}
	});

	it("rejects assistant tool calls without matching results before completion", async () => {
		const provider = await startFauxOpenAIProvider();
		try {
			const response = await fetch(`${provider.url}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "resume-model",
					messages: [
						{ role: "user", content: "history" },
						{
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call-unmatched",
									type: "function",
									function: { name: "read", arguments: "{}" },
								},
							],
						},
						{ role: "user", content: followUp },
					],
				}),
			});
			expect(response.status).toBe(400);
			expect(provider.requests).toHaveLength(1);
			expect(provider.requests[0]?.valid).toBe(false);
			expect(provider.requests[0]?.error).toContain("call-unmatched");
		} finally {
			await provider.stop();
		}
	});

	it.skipIf(!process.env.PRIME_AGENT_BIN)(
		"continues every OMP fixture branch tip through native Prime RPC",
		async () => {
			const executable = process.env.PRIME_AGENT_BIN;
			if (!executable) {
				throw new Error(
					"Prime native continuation acceptance gate requires PRIME_AGENT_BIN. Install the Prime Agent binary and set PRIME_AGENT_BIN before running this test.",
				);
			}
			const root = await makeRoot("prime-session-resume-");
			const cas = new FileCas(path.join(root, "state"));
			const ompAgentDir = path.join(root, "omp-fixture-agent");
			await fs.mkdir(path.join(ompAgentDir, "blobs"), { recursive: true });
			await fs.writeFile(path.join(ompAgentDir, "blobs", ompFixtureBlobHash), ompFixtureBlobBytes);
			const source = await readOmpSession(ompFixture, cas, { ompAgentDir });
			const completedToolCallIds = new Set(["omp-call-read", "omp-call-bash"]);
			for (const node of source.nodes) {
				if (node.role === "assistant")
					node.toolPairs = node.toolPairs?.filter(pair => completedToolCallIds.has(pair.callId));
				else if (node.role === "toolResult")
					node.toolPairs = node.toolPairs?.filter(pair => completedToolCallIds.has(pair.callId));
			}
			const eligibleTips = branchTips(source).filter(candidate =>
				isProviderCompletePath(pathTo(source, candidate.id)),
			);
			expect(eligibleTips.length).toBeGreaterThan(0);
			const completedToolTip: SessionSpecNode = {
				id: "omp-complete-user",
				parentId: "omp-bash-result",
				role: "user",
				content: "continue completed tool branch",
			};
			const continuationTips = [...eligibleTips, completedToolTip];
			for (const [tipIndex, tip] of continuationTips.entries()) {
				const sourceForTip: SessionSpecV1 = {
					...source,
					header: { ...source.header, cwd: root },
					nodes: source.nodes.some(node => node.id === tip.id) ? source.nodes : [...source.nodes, tip],
					activeLeafId: tip.id,
				};
				const primeHome = path.join(root, `p${tipIndex}`);
				const projected = await projectToPrime(sourceForTip, {
					primeHome,
					cas,
					sessionId: `11111111-1111-4111-8111-${String(tipIndex + 1).padStart(12, "0")}`,
					now: () => "2026-08-12T00:00:00.000Z",
				});
				const providerView = await readPrimeSession(projected.path, cas);
				const nativeTip = projected.report.nativeIdMap[tip.id]?.prime;
				if (nativeTip === undefined) throw new Error(`missing native Prime ID for ${tip.id}`);
				const expected = expectedProviderTraceForSpec(providerView, nativeTip);
				const provider = await startFauxOpenAIProvider({ expectedPrompt: followUp });
				try {
					const ended = await continueThroughPrimeRpc(executable, projected.path, primeHome, provider.url);
					expect(provider.requests).toHaveLength(1);
					assertProviderAcceptedToolTrace(provider.requests[0]!, expected);
					expect(JSON.stringify(ended.messages)).toContain("faux-resume-ok");
				} finally {
					await provider.stop();
				}
			}
		},
		60_000,
	);
});
