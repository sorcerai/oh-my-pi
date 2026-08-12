import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileCas } from "../src/session/cas";
import { type AtomicWriteRequest, projectToPrime } from "../src/session/prime-projector";
import { readPrimeSession } from "../src/session/prime-reader";
import type { CanonicalToolPair, JsonValue, SessionSpecV1 } from "../src/session/spec";
import { mapOmpToolPair } from "../src/session/tool-map";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fixedSessionId = "11111111-1111-4111-8111-111111111111";
const fixedNow = () => "2026-08-12T00:00:00.000Z";

type PrimeRecord = Record<string, JsonValue>;

type Fixture = {
	readonly spec: SessionSpecV1;
	readonly callRefs: readonly { readonly ref: { hash: string; byteLength?: number }; readonly bytes: Uint8Array }[];
	readonly resultRefs: readonly { readonly ref: { hash: string; byteLength?: number }; readonly bytes: Uint8Array }[];
};

async function makeRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(root);
	return root;
}

function asObject(value: JsonValue | undefined, context: string): Record<string, JsonValue> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`missing ${context}`);
	return value;
}

function recordsAt(filePath: string): Promise<PrimeRecord[]> {
	return Bun.file(filePath)
		.text()
		.then(text =>
			text
				.trimEnd()
				.split("\n")
				.map(line => JSON.parse(line) as PrimeRecord),
		);
}

async function makeFixture(cas: FileCas): Promise<Fixture> {
	const sourceHeaderBytes = encoder.encode(
		'{"origin":"omp","sessionId":"omp-session-001","sourceSchema":"omp-session-v3"}\n',
	);
	const readCallBytes = encoder.encode(
		'{"type":"toolCall","id":"call-read","name":"read","arguments":{"path":"README.md"}}',
	);
	const readResultBytes = encoder.encode(
		'{"role":"toolResult","toolCallId":"call-read","toolName":"read","content":[{"type":"text","text":"historical read"}],"isError":false}',
	);
	const bashCallBytes = encoder.encode(
		'{"type":"toolCall","id":"call-bash","name":"bash","arguments":{"command":"printf hello"}}',
	);
	const bashResultBytes = encoder.encode(
		'{"role":"toolResult","toolCallId":"call-bash","toolName":"bash","content":[{"type":"text","text":"hello"}],"isError":false}',
	);
	const thinkingBytes = encoder.encode('{"type":"thinking","thinking":"historical reasoning"}');
	const providerPayloadBytes = encoder.encode('{"provider":"omp","request":"historical"}');
	const [sourceRef, readCallRef, readResultRef, bashCallRef, bashResultRef, thinkingRef, providerPayloadRef] =
		await Promise.all([
			cas.put(sourceHeaderBytes),
			cas.put(readCallBytes),
			cas.put(readResultBytes),
			cas.put(bashCallBytes),
			cas.put(bashResultBytes),
			cas.put(thinkingBytes),
			cas.put(providerPayloadBytes),
		]);

	const readPair: CanonicalToolPair = {
		toolName: "read",
		callId: "call-read",
		argsSnapshot: { path: "README.md" },
		originalCallRef: readCallRef,
	};
	const readResultPair: CanonicalToolPair = {
		toolName: readPair.toolName,
		callId: readPair.callId,
		argsSnapshot: readPair.argsSnapshot,
		resultRef: readResultRef,
	};
	const bashPair: CanonicalToolPair = {
		toolName: "bash",
		callId: "call-bash",
		argsSnapshot: { command: "printf hello" },
		originalCallRef: bashCallRef,
	};
	const bashResultPair: CanonicalToolPair = {
		toolName: bashPair.toolName,
		callId: bashPair.callId,
		argsSnapshot: bashPair.argsSnapshot,
		resultRef: bashResultRef,
	};

	return {
		spec: {
			specVersion: 1,
			header: {
				originHarness: "omp",
				sourceSessionId: "omp-session-001",
				title: "Branched historical session",
				cwd: "/tmp/project",
				createdAt: "2026-08-11T00:00:00.000Z",
				sourceSchema: "omp-session-v3",
				sourceRef,
			},
			nodes: [
				{
					id: "node-system",
					parentId: null,
					role: "system",
					content: "You are a safe historical assistant.",
					metadata: { sourceNativeId: "omp-system-0001", sourceType: "system" },
				},
				{
					id: "node-user",
					parentId: "node-system",
					role: "user",
					content: [{ type: "text", text: "Inspect README.md and report the result." }],
					metadata: { sourceNativeId: "omp-user-0001", sourceType: "message" },
				},
				{
					id: "node-assistant-tools",
					parentId: "node-user",
					role: "assistant",
					content: [{ type: "text", text: "I will inspect the file and run the historical command." }],
					toolPairs: [readPair, bashPair],
					thinkingRef,
					providerPayloadRef,
					metadata: { sourceNativeId: "omp-assistant-0001", sourceType: "message" },
				},
				{
					id: "node-read-result",
					parentId: "node-assistant-tools",
					role: "toolResult",
					content: [{ type: "text", text: "historical read" }],
					toolPairs: [readResultPair],
					metadata: { sourceNativeId: "omp-tool-0001", sourceType: "toolResult" },
				},
				{
					id: "node-bash-result",
					parentId: "node-read-result",
					role: "toolResult",
					content: [{ type: "text", text: "hello" }],
					toolPairs: [bashResultPair],
					metadata: { sourceNativeId: "omp-tool-0002", sourceType: "toolResult" },
				},
				{
					id: "node-compaction",
					parentId: "node-bash-result",
					role: "compaction",
					content: "Historical tool use was compacted without executing it.",
					metadata: { sourceNativeId: "omp-compaction-0001", sourceType: "compaction" },
				},
				{
					id: "node-custom",
					parentId: "node-compaction",
					role: "custom",
					content: { kind: "extension-state", restored: true },
					metadata: { sourceNativeId: "omp-custom-0001", sourceType: "custom" },
				},
				{
					id: "node-alt-assistant",
					parentId: "node-user",
					role: "assistant",
					content: [{ type: "text", text: "The alternate branch is text-only." }],
					metadata: { sourceNativeId: "omp-assistant-0002", sourceType: "message" },
				},
				{
					id: "node-active-user",
					parentId: "node-alt-assistant",
					role: "user",
					content: [{ type: "text", text: "Continue from the alternate branch." }],
					metadata: { sourceNativeId: "omp-user-0002", sourceType: "message" },
				},
			],
			activeLeafId: "node-active-user",
			nativeIdMap: {
				"node-user": { omp: "omp-user-0001" },
				"node-assistant-tools": { omp: "omp-assistant-0001" },
				"node-read-result": { omp: "omp-tool-0001" },
			},
			lossLedger: [
				{
					code: "unsupported_role",
					nodeId: "node-system",
					detail: "Canonical system role requires a hidden Prime bridge marker.",
					sourceType: "system",
				},
				{
					code: "missing_source_bytes",
					detail: "Provider request bytes were not retained by the source harness.",
					sourceType: "provider_payload",
				},
			],
		},
		callRefs: [
			{ ref: readCallRef, bytes: readCallBytes },
			{ ref: bashCallRef, bytes: bashCallBytes },
		],
		resultRefs: [
			{ ref: readResultRef, bytes: readResultBytes },
			{ ref: bashResultRef, bytes: bashResultBytes },
		],
	};
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Prime v3 session projector", () => {
	it("writes a valid topological Prime session with every canonical branch and hidden bridge metadata", async () => {
		const root = await makeRoot("prime-projector-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const sourceSnapshot = structuredClone(fixture.spec);
		const expectedReadMapping = await mapOmpToolPair({
			pair: fixture.spec.nodes[2]!.toolPairs![0]!,
			result: {
				role: "toolResult",
				toolCallId: "call-read",
				toolName: "read",
				content: [{ type: "text", text: "historical read" }],
				isError: false,
			},
			cas,
		});

		const projected = await projectToPrime(fixture.spec, {
			primeHome,
			cas,
			sessionId: fixedSessionId,
			now: fixedNow,
		});

		const expectedPath = path.join(primeHome, "agent", "sessions", `${fixedSessionId}.jsonl`);
		expect(projected.path).toBe(expectedPath);
		expect(await Bun.file(expectedPath).exists()).toBe(true);
		expect(fixture.spec).toEqual(sourceSnapshot);

		const records = await recordsAt(expectedPath);
		const [header, ...entries] = records;
		expect(header).toMatchObject({
			type: "session",
			version: 3,
			id: fixedSessionId,
			timestamp: fixedNow(),
			cwd: fixture.spec.header.cwd,
		});
		expect(records.length).toBe(fixture.spec.nodes.length + 2);
		expect(entries.every(entry => typeof entry.id === "string" && typeof entry.parentId !== "undefined")).toBe(true);
		const rootPrimeId = projected.report.nativeIdMap["node-system"]?.prime;
		if (rootPrimeId === undefined) throw new Error("missing root native ID");
		expect(entries[0]!.id).toBe(rootPrimeId);
		expect(entries[1]).toMatchObject({ type: "custom_message", customType: "prime-bridge/session-resume" });

		const nativeIdMap = projected.report.nativeIdMap as Record<string, { prime?: string; omp?: string }>;
		const primeIds = fixture.spec.nodes.map(node => nativeIdMap[node.id]?.prime);
		expect(primeIds.every(id => typeof id === "string" && /^[0-9a-f]{8}$/.test(id))).toBe(true);
		expect(new Set(primeIds).size).toBe(fixture.spec.nodes.length);
		const activePrimeId = nativeIdMap[fixture.spec.activeLeafId!]?.prime;
		if (activePrimeId === undefined) throw new Error("missing active leaf native ID");
		expect(entries.at(-1)!.id).toBe(activePrimeId);
		expect(nativeIdMap["node-user"]?.omp).toBe("omp-user-0001");
		expect(nativeIdMap["node-assistant-tools"]?.omp).toBe("omp-assistant-0001");

		const byId = new Map(entries.map(entry => [String(entry.id), entry]));
		for (const node of fixture.spec.nodes) {
			const primeId = nativeIdMap[node.id]?.prime;
			if (primeId === undefined) throw new Error(`missing native ID for ${node.id}`);
			const entry = byId.get(primeId);
			if (entry === undefined) throw new Error(`missing Prime entry for ${node.id}`);
			const parentId = node.parentId;
			if (parentId !== null) {
				const parentPrimeId = nativeIdMap[parentId]?.prime;
				if (parentPrimeId === undefined) throw new Error(`missing Prime parent ID for ${parentId}`);
				expect(entry.parentId as string).toBe(parentPrimeId);
			} else expect(entry.parentId).toBe(null);
		}
		for (let index = 0; index < entries.length; index++) {
			const parentId = entries[index]!.parentId;
			if (parentId !== null) expect(entries.findIndex(entry => entry.id === parentId)).toBeLessThan(index);
		}

		const messageEntries = entries.filter(entry => entry.type === "message");
		const messageRoles = messageEntries.map(entry => String(asObject(entry.message, "message").role));
		expect(messageRoles).toEqual(expect.arrayContaining(["user", "assistant", "toolResult"]));
		const assistant = messageEntries
			.map(entry => asObject(entry.message, "assistant message"))
			.find(message => message.role === "assistant");
		if (assistant === undefined) throw new Error("missing assistant message");
		const assistantContent = assistant.content;
		if (!Array.isArray(assistantContent)) throw new Error("assistant content must be an array");
		const toolCalls = assistantContent.filter(
			block => typeof block === "object" && block !== null && !Array.isArray(block) && block.type === "toolCall",
		);
		expect(toolCalls.length).toBeGreaterThanOrEqual(2);
		for (const block of toolCalls) {
			const toolCall = asObject(block, "tool call");
			expect(toolCall.id).toEqual(expect.any(String));
			expect(toolCall.name).toEqual(expect.any(String));
			expect(asObject(toolCall.arguments, "tool call arguments")).toBeDefined();
		}
		expect(toolCalls.some(block => asObject(block, "tool call").id === expectedReadMapping.call.id)).toBe(true);
		const toolCallsById = new Map(
			toolCalls.map(block => [String(asObject(block, "tool call").id), asObject(block, "tool call")]),
		);
		for (const resultEntry of messageEntries.filter(
			entry => asObject(entry.message, "tool result").role === "toolResult",
		)) {
			const result = asObject(resultEntry.message, "tool result");
			expect(result.toolCallId).toEqual(expect.any(String));
			expect(result.toolName).toEqual(expect.any(String));
			expect(Array.isArray(result.content)).toBe(true);
			expect(typeof result.isError).toBe("boolean");
			expect(toolCallsById.get(String(result.toolCallId))?.name).toBe(result.toolName);
		}
		expect(entries.some(entry => entry.type === "compaction")).toBe(true);

		const bridgeEntry = entries.find(
			entry => entry.type === "custom_message" && entry.customType === "prime-bridge/session-resume",
		);
		if (bridgeEntry === undefined) throw new Error("missing hidden bridge metadata entry");
		expect(bridgeEntry.content).toBe("");
		expect(bridgeEntry.display).toBe(false);
		const bridgeDetails = asObject(bridgeEntry.details, "bridge details");
		expect(bridgeDetails.activeLeafId).toBe(fixture.spec.activeLeafId);
		expect(bridgeDetails.nativeIdMap).toEqual(nativeIdMap);
		expect(bridgeDetails.lossLedger).toEqual(expect.arrayContaining(fixture.spec.lossLedger));
		expect(projected.report.activeLeafId).toBe(fixture.spec.activeLeafId);
		expect(projected.report.losses).toEqual(expect.arrayContaining(fixture.spec.lossLedger));
		expect(projected.report.bridgeDigest).toMatch(/^[0-9a-f]{64}$/);

		const untrusted = await readPrimeSession(expectedPath, cas);
		const physicalUserPrime = nativeIdMap["node-user"]?.prime;
		if (physicalUserPrime === undefined) throw new Error("missing physical user Prime ID");
		expect(untrusted.nodes).toHaveLength(fixture.spec.nodes.length + 1);
		expect(untrusted.nodes.some(node => node.id === "node-system")).toBe(false);
		expect(untrusted.nodes.find(node => node.id === rootPrimeId)?.role).toBe("custom");
		expect(untrusted.nodes.find(node => node.id === physicalUserPrime)?.role).toBe("user");
		expect(untrusted.nodes.find(node => node.id === String(bridgeEntry.id))?.role).toBe("custom");

		const parsed = await readPrimeSession(expectedPath, cas, {
			trustedBridgeDigest: projected.report.bridgeDigest,
		});
		expect(parsed.nodes).toHaveLength(fixture.spec.nodes.length);
		const parsedRoles = new Set(parsed.nodes.map(node => node.role));
		for (const role of ["user", "assistant", "toolResult", "compaction", "custom"] as const) {
			expect(parsedRoles.has(role)).toBe(true);
		}
		expect(parsed.nodes.find(node => node.id === "node-system")?.role).toBe("system");
	});

	it("does not trust an inline bridge mapping without the exact caller-supplied digest", async () => {
		const root = await makeRoot("prime-projector-untrusted-bridge-");
		const cas = new FileCas(path.join(root, "state"));
		const sessionPath = path.join(root, "physical.jsonl");
		const header: PrimeRecord = {
			type: "session",
			version: 3,
			id: fixedSessionId,
			timestamp: fixedNow(),
			cwd: "/tmp/project",
		};
		const physicalUser: PrimeRecord = {
			type: "message",
			id: "11111111",
			parentId: null,
			timestamp: fixedNow(),
			message: {
				role: "user",
				content: [{ type: "text", text: "physical user" }],
				timestamp: 1,
			},
		};
		const bridgeEntry: PrimeRecord = {
			type: "custom_message",
			id: "22222222",
			parentId: "11111111",
			timestamp: fixedNow(),
			customType: "prime-bridge/session-resume",
			content: "",
			display: false,
			details: {
				version: 1,
				activeLeafId: "canonical-system",
				header: {},
				nativeIdMap: { "canonical-system": { prime: "11111111" } },
				lossLedger: [],
				provenance: { "canonical-system": { role: "system", toolPairs: [] } },
				tails: {},
			},
		};
		await Bun.write(
			sessionPath,
			`${[header, physicalUser, bridgeEntry].map(record => JSON.stringify(record)).join("\n")}\n`,
		);

		const reads = [
			await readPrimeSession(sessionPath, cas),
			await readPrimeSession(sessionPath, cas, { trustedBridgeDigest: "0".repeat(64) }),
		];
		for (const parsed of reads) {
			expect(parsed.nodes.map(node => node.id)).toEqual(["11111111", "22222222"]);
			expect(parsed.nodes.find(node => node.id === "11111111")?.role).toBe("user");
			expect(parsed.nodes.find(node => node.id === "22222222")?.role).toBe("custom");
			expect(parsed.nodes.some(node => node.id === "canonical-system")).toBe(false);
			expect(parsed.nativeIdMap).toEqual({
				"11111111": { prime: "11111111" },
				"22222222": { prime: "22222222" },
			});
		}
	});

	it("does not overlay a tampered bridge when the original digest is supplied", async () => {
		const root = await makeRoot("prime-projector-tampered-bridge-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const projected = await projectToPrime(fixture.spec, {
			primeHome,
			cas,
			sessionId: fixedSessionId,
			now: fixedNow,
		});
		const records = await recordsAt(projected.path);
		const bridgeIndex = records.findIndex(
			entry => entry.type === "custom_message" && entry.customType === "prime-bridge/session-resume",
		);
		if (bridgeIndex < 0) throw new Error("missing bridge entry");
		const bridge = records[bridgeIndex]!;
		const details = asObject(bridge.details, "bridge details");
		const provenance = asObject(details.provenance, "bridge provenance");
		const userProvenance = asObject(provenance["node-user"], "user provenance");
		bridge.details = {
			...details,
			provenance: {
				...provenance,
				"node-user": { ...userProvenance, role: "system" },
			},
		};
		await Bun.write(projected.path, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);

		const parsed = await readPrimeSession(projected.path, cas, {
			trustedBridgeDigest: projected.report.bridgeDigest,
		});
		const physicalSystemPrime = projected.report.nativeIdMap["node-system"]?.prime;
		if (physicalSystemPrime === undefined) throw new Error("missing physical system Prime ID");
		expect(parsed.nodes.some(node => node.id === "node-system")).toBe(false);
		expect(parsed.nodes.find(node => node.id === physicalSystemPrime)?.role).toBe("custom");
		expect(parsed.nodes.find(node => node.id === String(bridge.id))?.role).toBe("custom");
		expect(parsed.nodes.some(node => node.role === "user")).toBe(true);
	});

	it("does not overlay unchanged bridge details after physical message tampering", async () => {
		const root = await makeRoot("prime-projector-tampered-message-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const projected = await projectToPrime(fixture.spec, {
			primeHome,
			cas,
			sessionId: fixedSessionId,
			now: fixedNow,
		});
		const records = await recordsAt(projected.path);
		const userEntry = records.find(
			entry => entry.type === "message" && asObject(entry.message, "message").role === "user",
		);
		if (userEntry === undefined) throw new Error("missing physical user entry");
		const bridgeEntry = records.find(
			entry => entry.type === "custom_message" && entry.customType === "prime-bridge/session-resume",
		);
		if (bridgeEntry === undefined) throw new Error("missing physical bridge entry");
		userEntry.message = {
			...asObject(userEntry.message, "message"),
			content: [{ type: "text", text: "tampered physical content" }],
		};
		await Bun.write(projected.path, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);

		const parsed = await readPrimeSession(projected.path, cas, {
			trustedBridgeDigest: projected.report.bridgeDigest,
		});
		expect(parsed.nodes.some(node => node.id === "node-user")).toBe(false);
		expect(parsed.nodes.find(node => node.id === String(userEntry.id))?.role).toBe("user");
		expect(parsed.nodes.find(node => node.id === String(bridgeEntry.id))?.role).toBe("custom");
	});

	it("keeps canonical-to-native IDs deterministic, preserves the source, and refuses overwrite", async () => {
		const root = await makeRoot("prime-projector-deterministic-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const first = await projectToPrime(fixture.spec, { primeHome, cas, sessionId: fixedSessionId, now: fixedNow });
		const firstBytes = new Uint8Array(await Bun.file(first.path).arrayBuffer());
		const second = await projectToPrime(fixture.spec, {
			primeHome,
			cas,
			sessionId: "22222222-2222-4222-8222-222222222222",
			now: fixedNow,
		});
		const firstRecords = await recordsAt(first.path);
		const secondRecords = await recordsAt(second.path);
		expect(firstRecords.slice(1)).toEqual(secondRecords.slice(1));
		expect(first.report.nativeIdMap).toEqual(second.report.nativeIdMap);
		expect(new Uint8Array(await Bun.file(first.path).arrayBuffer())).toEqual(firstBytes);

		const sentinel = encoder.encode("do not replace this existing session\n");
		await Bun.write(first.path, sentinel);
		await expect(
			projectToPrime(fixture.spec, { primeHome, cas, sessionId: fixedSessionId, now: fixedNow }),
		).rejects.toThrow(/exist|overwrite|replace/i);
		expect(new Uint8Array(await Bun.file(first.path).arrayBuffer())).toEqual(sentinel);
	});

	it("removes the destination and sibling temp after an injected write failure", async () => {
		const root = await makeRoot("prime-projector-write-failure-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const writes: AtomicWriteRequest[] = [];
		const finalPath = path.join(primeHome, "agent", "sessions", `${fixedSessionId}.jsonl`);
		await expect(
			projectToPrime(fixture.spec, {
				primeHome,
				cas,
				sessionId: fixedSessionId,
				now: fixedNow,
				atomicWrite: async (request: AtomicWriteRequest) => {
					writes.push(request);
					throw new Error("injected atomic write failure");
				},
			}),
		).rejects.toThrow("injected atomic write failure");
		expect(writes).toHaveLength(1);
		expect(await Bun.file(finalPath).exists()).toBe(false);
		expect(await Bun.file(writes[0]!.tempPath).exists()).toBe(false);
	});
	it("fsyncs the destination session directory after linking the staged file before success", async () => {
		const root = await makeRoot("prime-projector-directory-sync-order-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const finalPath = path.join(primeHome, "agent", "sessions", `${fixedSessionId}.jsonl`);
		await fs.mkdir(path.dirname(finalPath), { recursive: true });
		const events: string[] = [];
		const projected = await projectToPrime(fixture.spec, {
			primeHome,
			cas,
			sessionId: fixedSessionId,
			now: fixedNow,
			atomicWrite: async (request: AtomicWriteRequest) => {
				const handle = await fs.open(request.tempPath, "wx", 0o600);
				try {
					await handle.writeFile(request.bytes);
					await handle.sync();
					events.push("staged-file-fsynced");
				} finally {
					await handle.close();
				}
			},
			syncDirectory: async directory => {
				events.push(`destination-directory-fsynced:${directory === path.dirname(finalPath)}`);
				expect(await Bun.file(finalPath).exists()).toBe(true);
			},
		});
		expect(projected.path).toBe(finalPath);
		expect(events).toEqual([`staged-file-fsynced`, `destination-directory-fsynced:true`]);
	});
	it("fsyncs the newly-created session directory parent chain before success", async () => {
		const root = await makeRoot("prime-projector-directory-create-durability-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const finalPath = path.join(primeHome, "agent", "sessions", `${fixedSessionId}.jsonl`);
		const syncs: string[] = [];
		await projectToPrime(fixture.spec, {
			primeHome,
			cas,
			sessionId: fixedSessionId,
			now: fixedNow,
			syncDirectory: async directory => {
				syncs.push(directory);
			},
		});
		expect(syncs).toEqual([path.dirname(finalPath), path.dirname(path.dirname(finalPath)), primeHome, root]);
	});

	it("retains an uncertain linked destination and cleans temp when destination directory fsync fails", async () => {
		const root = await makeRoot("prime-projector-directory-sync-failure-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const writes: AtomicWriteRequest[] = [];
		const finalPath = path.join(primeHome, "agent", "sessions", `${fixedSessionId}.jsonl`);
		await expect(
			projectToPrime(fixture.spec, {
				primeHome,
				cas,
				sessionId: fixedSessionId,
				now: fixedNow,
				atomicWrite: async (request: AtomicWriteRequest) => {
					writes.push(request);
					await Bun.write(request.tempPath, request.bytes);
				},
				syncDirectory: async directory => {
					expect(directory).toBe(path.dirname(finalPath));
					expect(await Bun.file(finalPath).exists()).toBe(true);
					throw new Error("injected destination directory fsync failure");
				},
			}),
		).rejects.toThrow("injected destination directory fsync failure");
		expect(await Bun.file(finalPath).exists()).toBe(true);
		expect(writes).toHaveLength(1);
		expect(await Bun.file(writes[0]!.tempPath).exists()).toBe(false);
	});
	it("removes a malformed temp file when post-write Prime validation fails", async () => {
		const root = await makeRoot("prime-projector-validation-failure-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const writes: AtomicWriteRequest[] = [];
		const finalPath = path.join(primeHome, "agent", "sessions", `${fixedSessionId}.jsonl`);
		await expect(
			projectToPrime(fixture.spec, {
				primeHome,
				cas,
				sessionId: fixedSessionId,
				now: fixedNow,
				atomicWrite: async (request: AtomicWriteRequest) => {
					writes.push(request);
					await Bun.write(request.tempPath, encoder.encode('{"type":"not-a-prime-session"}\n'));
				},
			}),
		).rejects.toThrow(/Prime session|header|version|validation/i);
		expect(writes).toHaveLength(1);
		expect(await Bun.file(finalPath).exists()).toBe(false);
		expect(await Bun.file(writes[0]!.tempPath).exists()).toBe(false);
	});
	it("rejects a corrupted declared provenance blob without publishing destination or temp", async () => {
		const root = await makeRoot("prime-projector-corrupt-cas-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const finalPath = path.join(primeHome, "agent", "sessions", `${fixedSessionId}.jsonl`);
		await Bun.write(cas.pathFor(fixture.spec.header.sourceRef!.hash), encoder.encode("corrupted"));
		await expect(
			projectToPrime(fixture.spec, { primeHome, cas, sessionId: fixedSessionId, now: fixedNow }),
		).rejects.toThrow(/hash verification|CAS/i);
		expect(await Bun.file(finalPath).exists()).toBe(false);
		expect(await fs.readdir(path.dirname(finalPath)).catch(() => [])).toEqual([]);
	});

	it("keeps an assistant call without a result inert and restores its original call bytes", async () => {
		const root = await makeRoot("prime-projector-call-only-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const callOnly = structuredClone(fixture.spec);
		const callOnlyBytes = encoder.encode(
			'{"type":"toolCall","id":"call-only","name":"read","arguments":{"path":"README.md"}}',
		);
		const sourceCallRef = await cas.put(callOnlyBytes);
		callOnly.nodes.push({
			id: "node-call-only",
			parentId: "node-active-user",
			role: "assistant",
			content: [{ type: "text", text: "Historical call had no captured result." }],
			toolPairs: [
				{
					toolName: "read",
					callId: "call-only",
					argsSnapshot: { path: "README.md" },
					originalCallRef: sourceCallRef,
				},
			],
		});
		callOnly.activeLeafId = "node-call-only";
		const projected = await projectToPrime(callOnly, { primeHome, cas, sessionId: fixedSessionId, now: fixedNow });
		const roundTripped = await readPrimeSession(projected.path, cas, {
			trustedBridgeDigest: projected.report.bridgeDigest,
		});
		const assistant = roundTripped.nodes.find(
			node => node.role === "assistant" && node.toolPairs?.some(pair => pair.callId === "call-only"),
		);
		const pair = assistant?.toolPairs?.find(item => item.callId === "call-only");
		expect(pair?.originalCallRef).toBeDefined();
		expect(await cas.read(pair!.originalCallRef!)).toEqual(callOnlyBytes);
	});

	it("projects an error tool result with isError true", async () => {
		const root = await makeRoot("prime-projector-error-result-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const errorSpec = structuredClone(fixture.spec);
		const resultIndex = errorSpec.nodes.findIndex(node => node.id === "node-read-result");
		const result = errorSpec.nodes[resultIndex]!;
		errorSpec.nodes[resultIndex] = { ...result, metadata: { ...(result.metadata ?? {}), isError: true } };
		const projected = await projectToPrime(errorSpec, { primeHome, cas, sessionId: fixedSessionId, now: fixedNow });
		const records = await recordsAt(projected.path);
		const errorMessage = records
			.filter(entry => entry.type === "message")
			.map(entry => asObject(entry.message, "message"))
			.find(message => message.role === "toolResult" && message.toolCallId === "call-read");
		expect(errorMessage?.isError).toBe(true);
	});

	it("adds a system demotion loss when the source ledger is empty", async () => {
		const root = await makeRoot("prime-projector-system-loss-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const lossless = structuredClone(fixture.spec);
		lossless.lossLedger = [];
		const projected = await projectToPrime(lossless, { primeHome, cas, sessionId: fixedSessionId, now: fixedNow });
		expect(projected.report.losses).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "unsupported_role", nodeId: "node-system" })]),
		);
	});

	it("uses a deterministic final canonical leaf when activeLeafId is null", async () => {
		const root = await makeRoot("prime-projector-no-active-leaf-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const noActiveLeaf = structuredClone(fixture.spec);
		noActiveLeaf.activeLeafId = null;
		const projected = await projectToPrime(noActiveLeaf, {
			primeHome,
			cas,
			sessionId: fixedSessionId,
			now: fixedNow,
		});
		const records = await recordsAt(projected.path);
		const map = projected.report.nativeIdMap as Record<string, { prime?: string }>;
		expect(projected.report.activeLeafId).toBeNull();
		const finalPrimeId = map[noActiveLeaf.nodes.at(-1)!.id]?.prime;
		if (finalPrimeId === undefined) throw new Error("missing deterministic leaf native ID");
		expect(records.at(-1)!.id).toBe(finalPrimeId);
		const bridge = records.find(
			entry => entry.type === "custom_message" && entry.customType === "prime-bridge/session-resume",
		);
		expect(asObject(bridge?.details, "bridge details").activeLeafId).toBeNull();
	});

	it("generates a UUID destination and rejects traversal or non-UUID session IDs", async () => {
		const root = await makeRoot("prime-projector-session-id-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const generated = await projectToPrime(fixture.spec, { primeHome, cas, now: fixedNow() });
		expect(path.basename(generated.path)).toMatch(/^[0-9a-f-]{36}\.jsonl$/);
		for (const sessionId of ["../escape", "not-a-uuid"]) {
			const invalidHome = path.join(root, `invalid-${sessionId.replaceAll(/[^a-z]/g, "-")}`);
			const escapedPath = path.join(invalidHome, "agent", "sessions", `${sessionId}.jsonl`);
			await expect(
				projectToPrime(fixture.spec, { primeHome: invalidHome, cas, sessionId, now: fixedNow }),
			).rejects.toThrow(/session|UUID|identifier|path/i);
			expect(await Bun.file(escapedPath).exists()).toBe(false);
			expect(await fs.readdir(invalidHome, { recursive: true }).catch(() => [])).toEqual([]);
		}
	});

	it("preserves a concurrent final sentinel and cleans temp after EEXIST", async () => {
		const root = await makeRoot("prime-projector-race-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const writes: AtomicWriteRequest[] = [];
		const finalPath = path.join(primeHome, "agent", "sessions", `${fixedSessionId}.jsonl`);
		const sentinel = encoder.encode("concurrent writer won\n");
		await expect(
			projectToPrime(fixture.spec, {
				primeHome,
				cas,
				sessionId: fixedSessionId,
				now: fixedNow,
				atomicWrite: async (request: AtomicWriteRequest) => {
					writes.push(request);
					await Bun.write(request.tempPath, request.bytes);
					await Bun.write(finalPath, sentinel);
				},
			}),
		).rejects.toThrow(/exist|overwrite|publish|rename/i);
		expect(writes).toHaveLength(1);
		expect(new Uint8Array(await Bun.file(finalPath).arrayBuffer())).toEqual(sentinel);
		expect(await Bun.file(writes[0]!.tempPath).exists()).toBe(false);
	});

	it("preserves hostile canonical IDs and represents every pair in a multi-pair result node", async () => {
		const root = await makeRoot("prime-projector-hostile-ids-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const replacements: Record<string, string> = {
			"node-system": "__proto__",
			"node-user": "constructor",
			"node-assistant-tools": "prototype",
			"node-read-result": "hostile-result",
			"node-bash-result": "hostile-result-2",
			"node-compaction": "hostile-compaction",
			"node-custom": "hostile-custom",
			"node-alt-assistant": "hostile-alt",
			"node-active-user": "hostile-active",
		};
		const hostile: SessionSpecV1 = {
			...fixture.spec,
			nodes: [
				...fixture.spec.nodes.map(node => ({
					...node,
					id: replacements[node.id]!,
					parentId: node.parentId === null ? null : replacements[node.parentId]!,
				})),
				{
					id: "hostile-multi-result",
					parentId: "prototype",
					role: "toolResult",
					content: [
						{ type: "text", text: "read result" },
						{ type: "text", text: "bash result" },
					],
					toolPairs: [
						{ toolName: "read", callId: "call-read", argsSnapshot: {}, resultRef: fixture.resultRefs[0]!.ref },
						{ toolName: "bash", callId: "call-bash", argsSnapshot: {}, resultRef: fixture.resultRefs[1]!.ref },
					],
				},
				{
					id: "hostile-multi-child",
					parentId: "hostile-multi-result",
					role: "user",
					content: [{ type: "text", text: "Continue after both historical results." }],
				},
			],
			activeLeafId: "hostile-multi-child",
			nativeIdMap: Object.create(null) as SessionSpecV1["nativeIdMap"],
		};
		const projected = await projectToPrime(hostile, { primeHome, cas, sessionId: fixedSessionId, now: fixedNow });
		for (const id of ["__proto__", "constructor", "prototype"]) {
			expect(Object.hasOwn(projected.report.nativeIdMap, id)).toBe(true);
		}
		const multiPrime = (
			Object.getOwnPropertyDescriptor(projected.report.nativeIdMap, "hostile-multi-result")?.value as
				| { readonly prime?: string }
				| undefined
		)?.prime;
		const childPrime = (
			Object.getOwnPropertyDescriptor(projected.report.nativeIdMap, "hostile-multi-child")?.value as
				| { readonly prime?: string }
				| undefined
		)?.prime;
		expect(multiPrime).toMatch(/^[0-9a-f]{8}$/);
		expect(childPrime).toMatch(/^[0-9a-f]{8}$/);
		const records = await recordsAt(projected.path);
		const multiIndex = records.findIndex(entry => entry.id === multiPrime);
		const childEntry = records.find(entry => entry.id === childPrime);
		const earlierResultIndex = records.findIndex(entry => {
			if (entry.type !== "message" || entry.id === multiPrime) return false;
			const message = asObject(entry.message, "message");
			return message.role === "toolResult" && message.toolCallId === "call-read";
		});
		expect(earlierResultIndex).toBeGreaterThan(-1);
		expect(earlierResultIndex).toBeLessThan(multiIndex);
		expect(asObject(records[multiIndex]?.message, "final multi-result message").toolCallId).toBe("call-bash");
		expect(childEntry?.parentId).toBe(multiPrime);
		const roundTripped = await readPrimeSession(projected.path, cas, {
			trustedBridgeDigest: projected.report.bridgeDigest,
		});
		const multiNode = roundTripped.nodes.find(node => node.id === "hostile-multi-result");
		expect(multiNode?.toolPairs?.map(pair => pair.callId)).toEqual(["call-read", "call-bash"]);
		expect(
			roundTripped.nodes.some(node => node.id === "hostile-multi-child" && node.parentId === "hostile-multi-result"),
		).toBe(true);
		expect(roundTripped.nodes.some(node => node.parentId === multiPrime)).toBe(false);
	});

	it("retains exact historical call and result bytes in CAS for A-to-B-to-A", async () => {
		const root = await makeRoot("prime-projector-round-trip-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const originalCallBytes = await Promise.all(fixture.callRefs.map(item => cas.read(item.ref)));
		const originalResultBytes = await Promise.all(fixture.resultRefs.map(item => cas.read(item.ref)));
		const projected = await projectToPrime(fixture.spec, {
			primeHome,
			cas,
			sessionId: fixedSessionId,
			now: fixedNow,
		});
		const roundTripped = await readPrimeSession(projected.path, cas, {
			trustedBridgeDigest: projected.report.bridgeDigest,
		});
		for (const [index, callId] of ["call-read", "call-bash"].entries()) {
			const assistantNode = roundTripped.nodes.find(
				node => node.role === "assistant" && node.toolPairs?.some(pair => pair.callId === callId),
			);
			const resultNode = roundTripped.nodes.find(
				node => node.role === "toolResult" && node.toolPairs?.some(pair => pair.callId === callId),
			);
			const callPair = assistantNode?.toolPairs?.find(pair => pair.callId === callId);
			const resultPair = resultNode?.toolPairs?.find(pair => pair.callId === callId);
			expect(callPair?.originalCallRef).toBeDefined();
			expect(resultPair?.resultRef).toBeDefined();
			expect(await cas.read(callPair!.originalCallRef!)).toEqual(originalCallBytes[index]);
			expect(await cas.read(resultPair!.resultRef!)).toEqual(originalResultBytes[index]);
		}
		for (const [index, item] of fixture.callRefs.entries())
			expect(await cas.read(item.ref)).toEqual(originalCallBytes[index]);
		for (const [index, item] of fixture.resultRefs.entries())
			expect(await cas.read(item.ref)).toEqual(originalResultBytes[index]);
		for (const item of fixture.callRefs) expect(await cas.read(item.ref)).toEqual(item.bytes);
		for (const item of fixture.resultRefs) expect(await cas.read(item.ref)).toEqual(item.bytes);
		const raw = decoder.decode(await Bun.file(projected.path).arrayBuffer());
		expect(raw.startsWith('{"type":"session"')).toBe(true);
	});

	it("restores exact CAS provenance for source, thinking, provider, and synthesized calls", async () => {
		const root = await makeRoot("prime-projector-provenance-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const sourceHeaderBytes = await cas.read(fixture.spec.header.sourceRef!);
		const thinkingBytes = encoder.encode(
			'{\n  "thinking": "provenance must stay byte-identical",\n  "type": "thinking"\n}\n',
		);
		const providerPayloadBytes = encoder.encode('{\n  "provider": "omp",\n  "request": "opaque"\n}\n');
		const synthesizedCallBytes = encoder.encode(
			'{\n  "type": "toolCall",\n  "id": "call-read",\n  "name": "ipython",\n  "arguments": {"code": "historical read"}\n}\n',
		);
		const [thinkingRef, providerPayloadRef, synthesizedCallRef] = await Promise.all([
			cas.put(thinkingBytes),
			cas.put(providerPayloadBytes),
			cas.put(synthesizedCallBytes),
		]);
		const source = structuredClone(fixture.spec);
		const assistantIndex = source.nodes.findIndex(node => node.id === "node-assistant-tools");
		const assistant = source.nodes[assistantIndex]!;
		source.nodes[assistantIndex] = {
			...assistant,
			thinkingRef,
			providerPayloadRef,
			toolPairs: assistant.toolPairs?.map((pair, index) => (index === 0 ? { ...pair, synthesizedCallRef } : pair)),
		};

		const projected = await projectToPrime(source, {
			primeHome,
			cas,
			sessionId: fixedSessionId,
			now: fixedNow,
		});
		const records = await recordsAt(projected.path);
		const assistantPrimeId = projected.report.nativeIdMap["node-assistant-tools"]?.prime;
		const primeAssistant = records.find(entry => entry.id === assistantPrimeId);
		const primeAssistantContent = asObject(primeAssistant?.message, "projected assistant").content;
		expect(Array.isArray(primeAssistantContent)).toBe(true);
		expect(
			(primeAssistantContent as JsonValue[]).some(
				block => typeof block === "object" && block !== null && !Array.isArray(block) && block.type === "thinking",
			),
		).toBe(false);
		expect(projected.report.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "thinking_demoted", nodeId: "node-assistant-tools" }),
			]),
		);
		const roundTripped = await readPrimeSession(projected.path, cas, {
			trustedBridgeDigest: projected.report.bridgeDigest,
		});
		const restoredAssistant = roundTripped.nodes.find(node => node.id === "node-assistant-tools");
		const restoredPair = restoredAssistant?.toolPairs?.find(pair => pair.callId === "call-read");

		expect(roundTripped.header.sourceRef).toEqual(fixture.spec.header.sourceRef);
		expect(await cas.read(roundTripped.header.sourceRef!)).toEqual(sourceHeaderBytes);
		expect(restoredAssistant?.thinkingRef).toEqual(thinkingRef);
		expect(await cas.read(restoredAssistant!.thinkingRef!)).toEqual(thinkingBytes);
		expect(restoredAssistant?.providerPayloadRef).toEqual(providerPayloadRef);
		expect(await cas.read(restoredAssistant!.providerPayloadRef!)).toEqual(providerPayloadBytes);
		expect(restoredPair?.synthesizedCallRef).toEqual(synthesizedCallRef);
		expect(await cas.read(restoredPair!.synthesizedCallRef!)).toEqual(synthesizedCallBytes);
		expect(projected.report.losses).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "provider_payload_demoted", nodeId: "node-assistant-tools" }),
			]),
		);
	});

	it("keeps sibling tool-result branches independent when call IDs and tool names repeat", async () => {
		const root = await makeRoot("prime-projector-sibling-results-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const callBytes = encoder.encode(
			'{"type":"toolCall","id":"shared-call","name":"bash","arguments":{"command":"printf shared"}}',
		);
		const branchABytes = encoder.encode(
			'{"role":"toolResult","toolCallId":"shared-call","toolName":"bash","content":[{"type":"text","text":"branch A"}],"isError":true}',
		);
		const branchBBytes = encoder.encode(
			'{"role":"toolResult","toolCallId":"shared-call","toolName":"bash","content":[{"type":"text","text":"branch B"}],"isError":false}',
		);
		const [originalCallRef, branchAResultRef, branchBResultRef] = await Promise.all([
			cas.put(callBytes),
			cas.put(branchABytes),
			cas.put(branchBBytes),
		]);
		const source: SessionSpecV1 = {
			...fixture.spec,
			nodes: [
				{
					id: "shared-assistant",
					parentId: null,
					role: "assistant",
					content: [{ type: "text", text: "Two historical branches." }],
					toolPairs: [
						{
							toolName: "bash",
							callId: "shared-call",
							argsSnapshot: { command: "printf shared" },
							originalCallRef,
						},
					],
				},
				{
					id: "branch-a",
					parentId: "shared-assistant",
					role: "toolResult",
					content: [{ type: "text", text: "branch A" }],
					toolPairs: [
						{
							toolName: "bash",
							callId: "shared-call",
							argsSnapshot: { command: "printf shared" },
							resultRef: branchAResultRef,
						},
					],
					metadata: { isError: true },
				},
				{
					id: "branch-b",
					parentId: "shared-assistant",
					role: "toolResult",
					content: [{ type: "text", text: "branch B" }],
					toolPairs: [
						{
							toolName: "bash",
							callId: "shared-call",
							argsSnapshot: { command: "printf shared" },
							resultRef: branchBResultRef,
						},
					],
					metadata: { isError: false },
				},
			],
			activeLeafId: "branch-b",
			nativeIdMap: Object.create(null) as SessionSpecV1["nativeIdMap"],
			lossLedger: [],
		};

		const projected = await projectToPrime(source, {
			primeHome,
			cas,
			sessionId: fixedSessionId,
			now: fixedNow,
		});
		const records = await recordsAt(projected.path);
		const nativeIdMap = projected.report.nativeIdMap as Record<string, { prime?: string }>;
		const expectedBranches = [
			{ id: "branch-a", content: [{ type: "text", text: "branch A" }], isError: true, ref: branchAResultRef },
			{ id: "branch-b", content: [{ type: "text", text: "branch B" }], isError: false, ref: branchBResultRef },
		] as const;
		for (const expected of expectedBranches) {
			const primeId = nativeIdMap[expected.id]?.prime;
			if (primeId === undefined) throw new Error(`missing Prime ID for ${expected.id}`);
			const entry = records.find(candidate => candidate.id === primeId);
			const message = asObject(entry?.message, `${expected.id} Prime message`);
			expect(message.content).toEqual([...expected.content]);
			expect(message.isError).toBe(expected.isError);
		}

		const roundTripped = await readPrimeSession(projected.path, cas, {
			trustedBridgeDigest: projected.report.bridgeDigest,
		});
		for (const expected of expectedBranches) {
			const node = roundTripped.nodes.find(candidate => candidate.id === expected.id);
			const pair = node?.toolPairs?.find(candidate => candidate.callId === "shared-call");
			expect(node?.parentId).toBe("shared-assistant");
			expect(node?.content).toEqual([...expected.content]);
			expect(pair?.resultRef).toEqual(expected.ref);
			expect(await cas.read(pair!.resultRef!)).toEqual(expected.id === "branch-a" ? branchABytes : branchBBytes);
			const persistedResult = JSON.parse(decoder.decode(await cas.read(pair!.resultRef!))) as PrimeRecord;
			expect(persistedResult.isError).toBe(expected.isError);
		}
	});

	it("does not collapse a canonical ID that matches a multi-result synthetic tail", async () => {
		const root = await makeRoot("prime-projector-canonical-tail-collision-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const multiResultId = "multi-result";
		const collisionId = `${multiResultId}:result:0`;
		const source: SessionSpecV1 = {
			...fixture.spec,
			nodes: [
				{
					id: "multi-assistant",
					parentId: null,
					role: "assistant",
					content: [{ type: "text", text: "Run both historical tools." }],
					toolPairs: [
						{
							toolName: "read",
							callId: "call-read",
							argsSnapshot: { path: "README.md" },
							originalCallRef: fixture.callRefs[0]!.ref,
						},
						{
							toolName: "bash",
							callId: "call-bash",
							argsSnapshot: { command: "printf hello" },
							originalCallRef: fixture.callRefs[1]!.ref,
						},
					],
				},
				{
					id: multiResultId,
					parentId: "multi-assistant",
					role: "toolResult",
					content: [
						{ type: "text", text: "historical read" },
						{ type: "text", text: "hello" },
					],
					toolPairs: [
						{
							toolName: "read",
							callId: "call-read",
							argsSnapshot: { path: "README.md" },
							resultRef: fixture.resultRefs[0]!.ref,
						},
						{
							toolName: "bash",
							callId: "call-bash",
							argsSnapshot: { command: "printf hello" },
							resultRef: fixture.resultRefs[1]!.ref,
						},
					],
				},
				{
					id: collisionId,
					parentId: multiResultId,
					role: "user",
					content: [{ type: "text", text: "Continue from the canonical tail node." }],
				},
			],
			activeLeafId: collisionId,
			nativeIdMap: Object.create(null) as SessionSpecV1["nativeIdMap"],
			lossLedger: [],
		};

		const projected = await projectToPrime(source, {
			primeHome,
			cas,
			sessionId: fixedSessionId,
			now: fixedNow,
		});
		const records = await recordsAt(projected.path);
		const nativeIdMap = projected.report.nativeIdMap as Record<string, { prime?: string }>;
		const assistantPrime = nativeIdMap["multi-assistant"]?.prime;
		const multiPrime = nativeIdMap[multiResultId]?.prime;
		const collisionPrime = nativeIdMap[collisionId]?.prime;
		if (assistantPrime === undefined || multiPrime === undefined || collisionPrime === undefined)
			throw new Error("missing canonical Prime IDs");
		expect(multiPrime).not.toBe(collisionPrime);
		expect(records.filter(entry => entry.id === collisionPrime)).toHaveLength(1);
		expect(records.find(entry => entry.id === collisionPrime)?.parentId).toBe(multiPrime);

		const roundTripped = await readPrimeSession(projected.path, cas, {
			trustedBridgeDigest: projected.report.bridgeDigest,
		});
		const multiNode = roundTripped.nodes.find(node => node.id === multiResultId);
		const collisionNode = roundTripped.nodes.find(node => node.id === collisionId);
		expect(multiNode?.parentId).toBe("multi-assistant");
		expect(multiNode?.toolPairs?.map(pair => pair.callId)).toEqual(["call-read", "call-bash"]);
		expect(collisionNode?.parentId).toBe(multiResultId);
		expect(roundTripped.nativeIdMap[multiResultId]?.prime).toBe(multiPrime);
		expect(roundTripped.nativeIdMap[collisionId]?.prime).toBe(collisionPrime);
		expect(roundTripped.nativeIdMap["multi-assistant"]?.prime).toBe(assistantPrime);
	});
	it("does not materialize a valid hidden bridge entry as a canonical node across a second projection", async () => {
		const root = await makeRoot("prime-projector-bridge-round-trip-");
		const firstPrimeHome = path.join(root, "first-prime-home");
		const secondPrimeHome = path.join(root, "second-prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const first = await projectToPrime(fixture.spec, {
			primeHome: firstPrimeHome,
			cas,
			sessionId: fixedSessionId,
			now: fixedNow,
		});
		const firstRecords = await recordsAt(first.path);
		const bridgeId = firstRecords.find(
			entry => entry.type === "custom_message" && entry.customType === "prime-bridge/session-resume",
		)?.id;
		if (typeof bridgeId !== "string") throw new Error("missing hidden bridge entry");
		const firstCanonical = await readPrimeSession(first.path, cas, {
			trustedBridgeDigest: first.report.bridgeDigest,
		});
		const tree = (spec: SessionSpecV1) =>
			spec.nodes
				.map(node => ({ id: node.id, parentId: node.parentId, role: node.role }))
				.sort((left, right) => left.id.localeCompare(right.id));
		expect(firstCanonical.nodes).toHaveLength(fixture.spec.nodes.length);
		expect(firstCanonical.nodes.some(node => node.id === bridgeId)).toBe(false);
		expect(tree(firstCanonical)).toEqual(tree(fixture.spec));

		const second = await projectToPrime(firstCanonical, {
			primeHome: secondPrimeHome,
			cas,
			sessionId: "22222222-2222-4222-8222-222222222222",
			now: fixedNow,
		});
		const secondCanonical = await readPrimeSession(second.path, cas, {
			trustedBridgeDigest: second.report.bridgeDigest,
		});
		expect(secondCanonical.nodes).toHaveLength(firstCanonical.nodes.length);
		expect(tree(secondCanonical)).toEqual(tree(firstCanonical));
		expect(new Set(secondCanonical.nodes.map(node => node.id))).toEqual(
			new Set(firstCanonical.nodes.map(node => node.id)),
		);
	});
	it("preserves every canonical tool args snapshot through a trusted A-to-B-to-A cycle", async () => {
		const root = await makeRoot("prime-projector-args-cycle-");
		const firstPrimeHome = path.join(root, "first-prime-home");
		const secondPrimeHome = path.join(root, "second-prime-home");
		const thirdPrimeHome = path.join(root, "third-prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const source = structuredClone(fixture.spec);
		const noRefArgs: JsonValue = {
			nested: { command: "printf no-ref", flags: [true, false] },
			quoted: "preserve this exact snapshot",
		};
		source.nodes.push(
			{
				id: "node-no-ref-assistant",
				parentId: "node-active-user",
				role: "assistant",
				content: [{ type: "text", text: "Run the uncaptured historical tool." }],
				toolPairs: [{ toolName: "opaque", callId: "call-no-ref", argsSnapshot: noRefArgs }],
			},
			{
				id: "node-no-ref-result",
				parentId: "node-no-ref-assistant",
				role: "toolResult",
				content: [{ type: "text", text: "uncaptured result" }],
				toolPairs: [{ toolName: "opaque", callId: "call-no-ref", argsSnapshot: noRefArgs }],
			},
		);
		source.activeLeafId = "node-no-ref-result";

		const first = await projectToPrime(source, {
			primeHome: firstPrimeHome,
			cas,
			sessionId: fixedSessionId,
			now: fixedNow,
		});
		const firstCanonical = await readPrimeSession(first.path, cas, {
			trustedBridgeDigest: first.report.bridgeDigest,
		});
		const second = await projectToPrime(firstCanonical, {
			primeHome: secondPrimeHome,
			cas,
			sessionId: "22222222-2222-4222-8222-222222222222",
			now: fixedNow,
		});
		const secondCanonical = await readPrimeSession(second.path, cas, {
			trustedBridgeDigest: second.report.bridgeDigest,
		});
		const third = await projectToPrime(secondCanonical, {
			primeHome: thirdPrimeHome,
			cas,
			sessionId: "33333333-3333-4333-8333-333333333333",
			now: fixedNow,
		});
		const restored = await readPrimeSession(third.path, cas, {
			trustedBridgeDigest: third.report.bridgeDigest,
		});

		const sourcePairCount = source.nodes.reduce((count, node) => count + (node.toolPairs?.length ?? 0), 0);
		const restoredPairCount = restored.nodes.reduce((count, node) => count + (node.toolPairs?.length ?? 0), 0);
		expect(restoredPairCount).toBe(sourcePairCount);
		for (const sourceNode of source.nodes) {
			const restoredNode = restored.nodes.find(node => node.id === sourceNode.id);
			expect(restoredNode?.toolPairs?.map(pair => pair.argsSnapshot)).toEqual(
				sourceNode.toolPairs?.map(pair => pair.argsSnapshot),
			);
		}
	});

	it("ledgers canonical content coercions with node IDs and restores their meaningful values", async () => {
		const root = await makeRoot("prime-projector-coercion-losses-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const callPair: CanonicalToolPair = {
			toolName: "read",
			callId: "coercion-call",
			argsSnapshot: { path: "README.md" },
			originalCallRef: fixture.callRefs[0]!.ref,
		};
		const resultPair: CanonicalToolPair = {
			...callPair,
			resultRef: fixture.resultRefs[0]!.ref,
		};
		const source: SessionSpecV1 = {
			...fixture.spec,
			nodes: [
				{
					id: "coercion-user",
					parentId: null,
					role: "user",
					content: { kind: "user-state", count: 3 },
				},
				{
					id: "coercion-assistant",
					parentId: "coercion-user",
					role: "assistant",
					content: { kind: "assistant-state", accepted: true },
					toolPairs: [callPair],
				},
				{
					id: "coercion-result",
					parentId: "coercion-assistant",
					role: "toolResult",
					content: [
						{ type: "text", text: "kept" },
						{ type: "unsupported", payload: "filtered" },
					],
					toolPairs: [resultPair],
				},
				{
					id: "coercion-compaction",
					parentId: "coercion-result",
					role: "compaction",
					content: { summary: "compact me", tokens: 9 },
				},
				{
					id: "coercion-custom",
					parentId: "coercion-compaction",
					role: "custom",
					content: { kind: "custom-state", enabled: true },
				},
			],
			activeLeafId: "coercion-custom",
			nativeIdMap: Object.create(null) as SessionSpecV1["nativeIdMap"],
			lossLedger: [],
		};
		const projected = await projectToPrime(source, { primeHome, cas, sessionId: fixedSessionId, now: fixedNow });
		for (const nodeId of [
			"coercion-user",
			"coercion-assistant",
			"coercion-result",
			"coercion-compaction",
			"coercion-custom",
		]) {
			expect(projected.report.losses).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "entry_metadata_unrepresentable", nodeId })]),
			);
		}

		const roundTripped = await readPrimeSession(projected.path, cas, {
			trustedBridgeDigest: projected.report.bridgeDigest,
		});
		expect(roundTripped.nodes.find(node => node.id === "coercion-user")?.content).toBe(
			JSON.stringify({ kind: "user-state", count: 3 }),
		);
		const assistantContent = roundTripped.nodes.find(node => node.id === "coercion-assistant")?.content;
		expect(assistantContent).toEqual(
			expect.arrayContaining([{ type: "text", text: JSON.stringify({ kind: "assistant-state", accepted: true }) }]),
		);
		expect(roundTripped.nodes.find(node => node.id === "coercion-compaction")?.content).toBe(
			JSON.stringify({ summary: "compact me", tokens: 9 }),
		);
		expect(roundTripped.nodes.find(node => node.id === "coercion-custom")?.content).toBe(
			JSON.stringify({ kind: "custom-state", enabled: true }),
		);
		const resultContent = roundTripped.nodes.find(node => node.id === "coercion-result")?.content;
		expect(resultContent).toEqual(expect.arrayContaining([{ type: "text", text: "kept" }]));
		expect(resultContent).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: expect.stringContaining("unsupported") }),
			]),
		);
	});

	it("discloses every unrepresented canonical metadata field in the loss ledger", async () => {
		const root = await makeRoot("prime-projector-metadata-losses-");
		const primeHome = path.join(root, "prime-home");
		const cas = new FileCas(path.join(root, "state"));
		const fixture = await makeFixture(cas);
		const source: SessionSpecV1 = {
			...fixture.spec,
			lossLedger: [],
			nodes: fixture.spec.nodes.map(node =>
				node.id === "node-user"
					? {
							...node,
							metadata: {
								...(node.metadata ?? {}),
								sourceNativeId: "omp-user-metadata-regression",
								sourceType: "canonical-user",
								customMetadata: { retained: false },
							},
						}
					: node,
			),
		};
		const projected = await projectToPrime(source, { primeHome, cas, sessionId: fixedSessionId, now: fixedNow });
		const metadataLosses = projected.report.losses.filter(
			loss => loss.code === "entry_metadata_unrepresentable" && loss.nodeId === "node-user",
		);
		expect(metadataLosses.length).toBeGreaterThan(0);
		const details = metadataLosses.map(loss => loss.detail ?? "").join("\n");
		expect(details).toContain("sourceNativeId");
		expect(details).toContain("sourceType");
		expect(details).toContain("customMetadata");
	});

	it("rejects duplicate JSON object keys before message and content provenance extraction", async () => {
		const root = await makeRoot("prime-projector-duplicate-keys-");
		const cas = new FileCas(path.join(root, "state"));
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "duplicate-key-session",
			timestamp: fixedNow(),
			cwd: "/tmp/project",
		});
		const assistantUsage =
			'"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}';
		const duplicateLines = [
			[
				"duplicate-message",
				'{"type":"message","id":"duplicate-message","parentId":null,"timestamp":"2026-08-12T00:00:00.000Z",' +
					'"message":{"role":"user","content":"first","timestamp":0},' +
					'"message":{"role":"user","content":[{"type":"text","text":"second"}],"timestamp":0}}',
			],
			[
				"duplicate-assistant-content",
				'{"type":"message","id":"duplicate-assistant-content","parentId":null,"timestamp":"2026-08-12T00:00:00.000Z",' +
					'"message":{"role":"assistant","content":[{"type":"text","text":"first"}],' +
					'"content":[{"type":"text","text":"second"}],"api":"openai-completions","provider":"omp",' +
					'"model":"historical",' +
					assistantUsage +
					',"stopReason":"stop","timestamp":0}}',
			],
		] as const;
		for (const [name, entry] of duplicateLines) {
			const filePath = path.join(root, `${name}.jsonl`);
			await Bun.write(filePath, `${header}\n${entry}\n`);
			await expect(readPrimeSession(filePath, cas)).rejects.toThrow(/duplicate|ambiguous|object key/i);
		}
	});
});
