import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { __resetDirsFromEnvForTests, getBlobsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { FileCas } from "../src/session/cas";
import { projectToOmp, readOmpSession } from "../src/session/omp-projector";
import { projectToPrime } from "../src/session/prime-projector";
import { readPrimeSession } from "../src/session/prime-reader";
import type { SessionSpecV1 } from "../src/session/spec";

const fixturePath = path.join(import.meta.dir, "fixtures", "sessions", "prime-v3.jsonl");
const ompFixturePath = path.join(import.meta.dir, "fixtures", "sessions", "omp-v3.jsonl");
const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];

type ImportNode = {
	readonly sourceId: string;
	readonly parentSourceId: string | null;
	readonly entry: unknown;
};

type ImportOptions = {
	readonly title?: string;
	readonly lossMarker?: unknown;
	readonly lossMarkerFactory?: (nativeIdMap: Readonly<Record<string, string>>) => unknown;
	readonly validateBeforePublish?: (
		sessionPath: string,
		nativeIdMap: Readonly<Record<string, string>>,
	) => Promise<void>;
	readonly [key: string]: unknown;
};

type ImportCall = {
	readonly cwd: string;
	readonly nodes: readonly ImportNode[];
	readonly activeLeafId: string | null;
	readonly options: ImportOptions;
};

async function makeRoot(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(root);
	return root;
}

async function makePrimeSpec(cas: FileCas): Promise<SessionSpecV1> {
	return readPrimeSession(fixturePath, cas);
}

function nativeMap(nodes: readonly ImportNode[]): Record<string, string> {
	return Object.fromEntries(nodes.map((node, index) => [node.sourceId, `omp-import-${index + 1}`]));
}

function asObject(value: unknown, context: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`missing ${context}`);
	return value as Record<string, unknown>;
}

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function isolateAgentDir(agentDir: string): () => void {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalOmpProfile = process.env.OMP_PROFILE;
	const originalPiProfile = process.env.PI_PROFILE;
	setAgentDir(agentDir);
	return () => {
		restoreEnvValue("OMP_PROFILE", originalOmpProfile);
		restoreEnvValue("PI_PROFILE", originalPiProfile);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDir);
		__resetDirsFromEnvForTests();
	};
}

async function makeOmpImageSpec(
	root: string,
	cas: FileCas,
): Promise<{
	readonly source: SessionSpecV1;
	readonly sourceAgentDir: string;
	readonly bytes: Buffer;
	readonly hash: string;
}> {
	const bytes = Buffer.from(`portable-omp-image-${crypto.randomUUID()}`);
	const hash = new Bun.SHA256().update(bytes).digest("hex");
	const sourceAgentDir = path.join(root, "source-agent");
	await fs.mkdir(getBlobsDir(sourceAgentDir), { recursive: true });
	await fs.writeFile(path.join(getBlobsDir(sourceAgentDir), hash), bytes);
	const sourcePath = path.join(root, "source.jsonl");
	await fs.writeFile(
		sourcePath,
		`${[
			JSON.stringify({
				type: "session",
				version: 3,
				id: "source-session",
				timestamp: "2026-08-12T00:00:00.000Z",
				cwd: root,
			}),
			JSON.stringify({
				type: "message",
				id: "source-image",
				parentId: null,
				timestamp: "2026-08-12T00:00:01.000Z",
				message: {
					role: "user",
					content: [{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }],
					timestamp: 1786492801000,
				},
			}),
		].join("\n")}\n`,
	);
	return {
		source: await readOmpSession(sourcePath, cas, { ompAgentDir: sourceAgentDir }),
		sourceAgentDir,
		bytes,
		hash,
	};
}

async function makeIpythonSpec(cas: FileCas, code: string, callId: string): Promise<SessionSpecV1> {
	const callRef = await cas.put(
		encoder.encode(JSON.stringify({ type: "toolCall", id: callId, name: "ipython", arguments: { code } })),
	);
	const resultRef = await cas.put(
		encoder.encode(
			JSON.stringify({
				role: "toolResult",
				toolCallId: callId,
				toolName: "ipython",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 1786406403000,
			}),
		),
	);
	const assistantId = `assistant-${callId}`;
	const resultId = `result-${callId}`;
	return {
		specVersion: 1,
		header: {
			originHarness: "prime",
			sourceSessionId: `session-${callId}`,
			title: "ipython mapping",
			cwd: "/tmp",
			createdAt: "2026-08-11T00:00:00.000Z",
			sourceSchema: "prime-v3",
		},
		nodes: [
			{ id: "user", parentId: null, role: "user", content: "run" },
			{
				id: assistantId,
				parentId: "user",
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: "ipython", arguments: { code } }],
				toolPairs: [{ toolName: "ipython", callId, argsSnapshot: { code }, originalCallRef: callRef }],
			},
			{
				id: resultId,
				parentId: assistantId,
				role: "toolResult",
				content: [{ type: "text", text: "result" }],
				toolPairs: [{ toolName: "ipython", callId, argsSnapshot: { code }, resultRef }],
			},
		],
		activeLeafId: resultId,
		nativeIdMap: { user: {}, [assistantId]: {}, [resultId]: {} },
		lossLedger: [],
	};
}
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("OMP session projector", () => {
	it("imports every canonical branch through the public importer and returns native path, mapping, and active leaf", async () => {
		const root = await makeRoot("omp-projector-tree-");
		const cas = new FileCas(path.join(root, "state"));
		const spec = await makePrimeSpec(cas);
		const sessionDir = path.join(root, "sessions");
		const sessionPath = path.join(sessionDir, "imported.jsonl");
		const calls: ImportCall[] = [];
		const importedMap = Object.fromEntries(spec.nodes.map((node, index) => [node.id, `native-${index}`]));

		const projected = await projectToOmp(spec, {
			cwd: spec.header.cwd,
			sessionDir,
			cas,
			importTree: async (
				cwd: string,
				nodes: readonly ImportNode[],
				activeLeafId: string | null,
				options: object = {},
			) => {
				calls.push({ cwd, nodes, activeLeafId, options: options as ImportOptions });
				await fs.mkdir(path.dirname(sessionPath), { recursive: true });
				await fs.writeFile(sessionPath, "{}\n");
				return { sessionPath, nativeIdMap: importedMap };
			},
			openSession: async openedPath => {
				expect(openedPath).toBe(sessionPath);
				return structuredClone(spec);
			},
		});
		expect(projected.report.nativeIdMap).toEqual(
			Object.fromEntries(
				spec.nodes.map((node, index) => [
					node.id,
					{
						omp: `native-${index}`,
						...(spec.nativeIdMap[node.id]?.prime === undefined
							? {}
							: { prime: spec.nativeIdMap[node.id]!.prime }),
					},
				]),
			),
		);

		expect(projected.report.activeLeafId).toBe(spec.activeLeafId);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.cwd).toBe(spec.header.cwd);
		expect(calls[0]!.activeLeafId).toBe(spec.activeLeafId);
		expect(calls[0]!.nodes.map(node => node.sourceId)).toEqual(spec.nodes.map(node => node.id));
		expect(calls[0]!.nodes.map(node => node.parentSourceId)).toEqual(spec.nodes.map(node => node.parentId));
		expect(calls[0]!.options.title).toBe(spec.header.title);
	});
	it("selects the same deterministic native leaf as Prime when activeLeafId is null", async () => {
		const root = await makeRoot("omp-projector-no-active-leaf-");
		const cas = new FileCas(path.join(root, "state"));
		const spec = await makePrimeSpec(cas);
		const source = { ...spec, activeLeafId: null };
		const sessionPath = path.join(root, "no-active-leaf.jsonl");
		let importedActiveLeafId: string | null = null;

		const projected = await projectToOmp(source, {
			cwd: source.header.cwd,
			cas,
			importTree: async (_cwd, nodes, activeLeafId) => {
				importedActiveLeafId = activeLeafId;
				await fs.writeFile(sessionPath, "{}\n");
				return { sessionPath, nativeIdMap: nativeMap(nodes) };
			},
			openSession: async () => structuredClone(source),
		});

		expect(importedActiveLeafId as string | null).toBe("b0000002");
		expect(projected.report.activeLeafId).toBeNull();
	});
	it("maps Prime ipython pairs to eval and exact single-line shell pairs to bash", async () => {
		for (const [code, expectedName] of [
			["print(1)", "eval"],
			["!printf hello", "bash"],
		] as const) {
			const root = await makeRoot("omp-projector-ipython-map-");
			const cas = new FileCas(path.join(root, "state"));
			const source = await makeIpythonSpec(cas, code, `call-${expectedName}`);
			const sessionPath = path.join(root, "mapped.jsonl");
			const imported: ImportNode[] = [];
			let marker: Record<string, unknown> | undefined;
			const projected = await projectToOmp(source, {
				cwd: root,
				cas,
				importTree: async (_cwd, nodes, _activeLeafId, options) => {
					imported.push(...nodes);
					const generatedMap = nativeMap(nodes);
					const factory = (options as ImportOptions).lossMarkerFactory;
					if (factory === undefined) throw new Error("missing bridge marker factory");
					marker = asObject(factory(generatedMap), "bridge marker");
					await fs.writeFile(sessionPath, "{}\n");
					return { sessionPath, nativeIdMap: generatedMap };
				},
				openSession: async () => structuredClone(source),
			});
			const assistant = imported.find(node => node.sourceId === `assistant-call-${expectedName}`);
			const result = imported.find(node => node.sourceId === `result-call-${expectedName}`);
			if (assistant === undefined || result === undefined) throw new Error("missing mapped tool entries");
			const assistantEntry = asObject(assistant.entry, "assistant entry");
			const resultEntry = asObject(result.entry, "result entry");
			expect(assistantEntry.type).toBe("message");
			expect(resultEntry.type).toBe("message");
			const assistantMessage = asObject(assistantEntry.message, "assistant message");
			const resultMessage = asObject(resultEntry.message, "result message");
			const assistantContent = assistantMessage.content;
			if (!Array.isArray(assistantContent)) throw new Error("mapped assistant content is not an array");
			const assistantCall = assistantContent
				.map(block =>
					typeof block === "object" && block !== null && !Array.isArray(block)
						? (block as Record<string, unknown>)
						: undefined,
				)
				.find(block => block?.type === "toolCall");
			expect(asObject(assistantCall, "mapped tool call").name).toBe(expectedName);
			expect(resultMessage).toMatchObject({ toolCallId: `call-${expectedName}`, toolName: expectedName });
			const provenance = asObject(asObject(marker?.data, "bridge marker data").provenance, "bridge provenance");
			const assistantProvenance = asObject(
				provenance[`assistant-call-${expectedName}`],
				"assistant bridge provenance",
			);
			const pairProvenance = (assistantProvenance.toolPairs as Array<Record<string, unknown>>)[0];
			expect(pairProvenance?.toolName).toBe("ipython");
			expect(pairProvenance?.synthesizedCallRef).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) });

			expect(projected.report.bridgeDigest).toMatch(/^[0-9a-f]{64}$/);
		}
	});
	it("demotes signed thinking and provider-native payloads under the historical OMP identity", async () => {
		const root = await makeRoot("omp-projector-demotion-");
		const cas = new FileCas(path.join(root, "state"));
		const source = await makePrimeSpec(cas);
		const assistant = source.nodes.find(node => node.role === "assistant" && node.thinkingRef);
		if (assistant === undefined) throw new Error("missing signed assistant");
		const imported: ImportNode[] = [];
		const sessionPath = path.join(root, "demoted.jsonl");
		const projected = await projectToOmp(source, {
			cwd: root,
			cas,
			importTree: async (_cwd, nodes) => {
				imported.push(...nodes);
				await fs.writeFile(sessionPath, "{}\n");
				return { sessionPath, nativeIdMap: nativeMap(nodes) };
			},
		});
		const importedAssistant = imported.find(node => node.sourceId === assistant.id);
		if (importedAssistant === undefined) throw new Error("missing imported assistant");
		const entry = asObject(importedAssistant.entry, "imported assistant");
		const message = asObject(entry.message, "imported assistant message");
		const content = message.content;
		if (!Array.isArray(content)) throw new Error("imported assistant content is not an array");
		const thinking = content.find(
			value => typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "thinking",
		);
		expect(thinking).toEqual({ type: "thinking", thinking: expect.any(String) });
		expect(message.providerPayload).toBeUndefined();
		expect(projected.report.losses.map(loss => loss.code)).toEqual(
			expect.arrayContaining(["thinking_demoted", "provider_payload_demoted"]),
		);
	});

	it("expands every canonical multi-pair result into a deterministic native chain", async () => {
		const root = await makeRoot("omp-projector-multi-pair-");
		const cas = new FileCas(path.join(root, "state"));
		const single = await makeIpythonSpec(cas, "print(1)", "call-one");
		const secondCallId = "call-two";
		const secondCallRef = await cas.put(
			encoder.encode(
				JSON.stringify({ type: "toolCall", id: secondCallId, name: "ipython", arguments: { code: "print(2)" } }),
			),
		);
		const secondResultRef = await cas.put(
			encoder.encode(
				JSON.stringify({
					role: "toolResult",
					toolCallId: secondCallId,
					toolName: "ipython",
					content: [{ type: "text", text: "result-two" }],
					isError: false,
					timestamp: 1786406403000,
				}),
			),
		);
		const assistantId = "assistant-call-one";
		const resultId = "result-call-one";
		const source: SessionSpecV1 = {
			...single,
			nodes: single.nodes.map(node => {
				if (node.id === assistantId)
					return {
						...node,
						content: [
							...(Array.isArray(node.content) ? node.content : []),
							{ type: "toolCall", id: secondCallId, name: "ipython", arguments: { code: "print(2)" } },
						],
						toolPairs: [
							...(node.toolPairs ?? []),
							{
								toolName: "ipython",
								callId: secondCallId,
								argsSnapshot: { code: "print(2)" },
								originalCallRef: secondCallRef,
							},
						],
					};
				if (node.id === resultId)
					return {
						...node,
						content: [{ type: "text", text: "result-one" }],
						toolPairs: [
							...(node.toolPairs ?? []),
							{
								toolName: "ipython",
								callId: secondCallId,
								argsSnapshot: { code: "print(2)" },
								resultRef: secondResultRef,
							},
						],
					};
				return node;
			}),
		};
		const imported: ImportNode[] = [];
		let marker: Record<string, unknown> | undefined;
		const sessionPath = path.join(root, "multi-pair.jsonl");
		await projectToOmp(source, {
			cwd: root,
			cas,
			importTree: async (_cwd, nodes, _activeLeafId, options) => {
				imported.push(...nodes);
				const generated = nativeMap(nodes);
				const factory = (options as ImportOptions).lossMarkerFactory;
				if (factory === undefined) throw new Error("missing bridge marker factory");
				marker = asObject(factory(generated), "bridge marker");
				await fs.writeFile(sessionPath, "{}\n");
				return { sessionPath, nativeIdMap: generated };
			},
		});
		const resultNodes = imported.filter(
			node => node.sourceId === `${resultId}.omp-tail-0` || node.sourceId === resultId,
		);
		expect(resultNodes.map(node => node.sourceId)).toEqual([`${resultId}.omp-tail-0`, resultId]);
		const resultMessages = resultNodes.map(node =>
			asObject(asObject(node.entry, "result entry").message, "result message"),
		);
		expect(resultMessages.map(message => [message.toolCallId, message.toolName])).toEqual([
			["call-one", "eval"],
			["call-two", "eval"],
		]);
		const tails = asObject(asObject(marker?.data, "bridge marker data").tails, "bridge tails");
		expect(tails[resultId]).toHaveLength(1);
	});

	it("passes the canonical loss ledger as the shared bridge marker", async () => {
		const root = await makeRoot("omp-projector-loss-marker-");
		const cas = new FileCas(path.join(root, "state"));
		const spec = await makePrimeSpec(cas);
		const losses = [
			...spec.lossLedger,
			{ code: "thinking_demoted" as const, nodeId: spec.nodes[1]!.id, sourceType: "assistant" },
		];
		const source = { ...spec, lossLedger: losses };
		let marker: Record<string, unknown> | undefined;
		const projected = await projectToOmp(source, {
			cwd: source.header.cwd,
			cas,
			importTree: async (_cwd, nodes, _activeLeafId, options) => {
				const generatedMap = nativeMap(nodes);
				const factory = (options as ImportOptions).lossMarkerFactory;
				if (factory === undefined) throw new Error("missing loss marker factory");
				marker = asObject(factory(generatedMap), "loss marker");
				const sessionPath = path.join(root, "loss-marker.jsonl");
				await fs.writeFile(sessionPath, "{}\n");
				return { sessionPath, nativeIdMap: generatedMap };
			},
			openSession: async () => structuredClone(source),
		});
		expect(marker).toMatchObject({ customType: "prime-bridge/session-resume" });
		const data = asObject(marker?.data, "loss marker data");
		expect(data).toMatchObject({ version: 1, activeLeafId: source.activeLeafId });
		expect(data.lossLedger).toEqual(expect.arrayContaining(losses));
		expect(data.provenance).toBeDefined();
		expect(projected.report.losses).toEqual(expect.arrayContaining(losses));
	});

	it("records explicit loss when exact OMP title-slot bytes cannot be restored", async () => {
		const root = await makeRoot("omp-projector-title-slot-loss-");
		const cas = new FileCas(path.join(root, "state"));
		const base = await makePrimeSpec(cas);
		const titleSlotRef = await cas.put(encoder.encode("exact OMP title-slot bytes"));
		const source: SessionSpecV1 = {
			...base,
			header: { ...base.header, originHarness: "omp", sourceSchema: "omp-session-v3" },
			nodes: base.nodes.map((node, index) =>
				index === 0
					? {
							...node,
							metadata: {
								...node.metadata,
								titleSlotRef: {
									hash: titleSlotRef.hash,
									...(titleSlotRef.byteLength === undefined ? {} : { byteLength: titleSlotRef.byteLength }),
								},
							},
						}
					: node,
			),
		};
		const firstNode = source.nodes[0];
		if (firstNode?.metadata?.titleSlotRef === undefined) throw new Error("missing OMP title-slot provenance");
		const sessionPath = path.join(root, "title-slot-loss.jsonl");
		let marker: Record<string, unknown> | undefined;

		const projected = await projectToOmp(source, {
			cwd: source.header.cwd,
			cas,
			importTree: async (_cwd, nodes, _activeLeafId, options) => {
				const generatedMap = nativeMap(nodes);
				const factory = (options as ImportOptions).lossMarkerFactory;
				if (factory === undefined) throw new Error("missing bridge marker factory");
				marker = asObject(factory(generatedMap), "bridge marker");
				await fs.writeFile(sessionPath, "{}\n");
				return { sessionPath, nativeIdMap: generatedMap };
			},
			openSession: async () => structuredClone(source),
		});

		const expectedLoss = expect.objectContaining({
			code: "entry_metadata_unrepresentable",
			nodeId: firstNode.id,
			sourceType: "title",
		});
		expect(projected.report.losses).toEqual(expect.arrayContaining([expectedLoss]));
		expect(asObject(marker?.data, "bridge marker data").lossLedger).toEqual(expect.arrayContaining([expectedLoss]));
	});

	it("validates the importer-created session path through the injected opener before returning", async () => {
		const root = await makeRoot("omp-projector-validation-");
		const cas = new FileCas(path.join(root, "state"));
		const spec = await makePrimeSpec(cas);
		const sessionPath = path.join(root, "validated.jsonl");
		const opened: string[] = [];

		await projectToOmp(spec, {
			cwd: spec.header.cwd,
			cas,
			importTree: async (_cwd, nodes, _activeLeafId, options) => {
				await fs.writeFile(sessionPath, "{}\n");
				await (options as ImportOptions).validateBeforePublish?.(sessionPath, nativeMap(nodes));
				return { sessionPath, nativeIdMap: nativeMap(nodes) };
			},
			openSession: async (openedPath, reopenOptions) => {
				opened.push(openedPath);
				expect(reopenOptions?.trustedBridgeDigest).toMatch(/^[0-9a-f]{64}$/);
				return structuredClone(spec);
			},
		});

		expect(opened).toEqual([sessionPath]);
	});
	it("propagates a destination-exists refusal without overwriting the source", async () => {
		const root = await makeRoot("omp-projector-nondestructive-");
		const cas = new FileCas(path.join(root, "state"));
		const spec = await makePrimeSpec(cas);
		const sourceSnapshot = structuredClone(spec);
		const sourceBytes = new Uint8Array(await Bun.file(fixturePath).arrayBuffer());
		const destinationError = Object.assign(new Error("destination exists; refusing overwrite"), { code: "EEXIST" });

		await expect(
			projectToOmp(spec, {
				cwd: spec.header.cwd,
				cas,
				importTree: async () => {
					throw destinationError;
				},
			}),
		).rejects.toThrow(/exist|overwrite|replace/i);
		expect(spec).toEqual(sourceSnapshot);
		expect(new Uint8Array(await Bun.file(fixturePath).arrayBuffer())).toEqual(sourceBytes);
	});
	it("reopens an OMP image with exact destination bytes after source storage and bridge CAS are unavailable", async () => {
		const root = await makeRoot("omp-projector-portable-blob-");
		const restoreAgentDir = isolateAgentDir(path.join(root, "destination-agent"));
		try {
			const cas = new FileCas(path.join(root, "state"));
			const { source, sourceAgentDir, bytes, hash } = await makeOmpImageSpec(root, cas);
			await fs.rm(sourceAgentDir, { recursive: true, force: true });
			expect(await cas.read(hash)).toEqual(bytes);
			const destinationBlobPath = path.join(getBlobsDir(), hash);
			const sessionDir = path.join(root, "sessions");

			const projected = await projectToOmp(source, { cwd: root, sessionDir, cas });
			await fs.rm(cas.root, { recursive: true, force: true });
			const reopened = await SessionManager.open(projected.path, sessionDir);
			try {
				const nativeId = projected.report.nativeIdMap["source-image"]?.omp;
				if (nativeId === undefined) throw new Error("missing imported image ID");
				const entry = reopened.getEntry(nativeId);
				if (entry?.type !== "message" || entry.message.role !== "user")
					throw new Error("missing imported image message");
				expect(entry.message.content).toEqual([
					{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
				]);
				expect(new Uint8Array(await fs.readFile(destinationBlobPath))).toEqual(new Uint8Array(bytes));
			} finally {
				await reopened.close();
			}
		} finally {
			restoreAgentDir();
		}
	});

	it("refuses OMP projection when referenced bridge CAS bytes are missing or corrupt", async () => {
		for (const mode of ["missing", "corrupt"] as const) {
			const root = await makeRoot(`omp-projector-${mode}-blob-`);
			const cas = new FileCas(path.join(root, "state"));
			const { source, sourceAgentDir, hash } = await makeOmpImageSpec(root, cas);
			await fs.rm(sourceAgentDir, { recursive: true, force: true });
			if (mode === "missing") await fs.rm(cas.pathFor(hash), { force: true });
			else await fs.writeFile(cas.pathFor(hash), "corrupt");
			let importerCalled = false;

			await expect(
				projectToOmp(source, {
					cwd: root,
					cas,
					importTree: async () => {
						importerCalled = true;
						throw new Error("importer must not run");
					},
				}),
			).rejects.toThrow(mode === "missing" ? /CAS blob unavailable/ : /CAS hash verification failed/);
			expect(importerCalled).toBe(false);
		}
	});

	it("round-trips through the native importer and trusted OMP reader with historical CAS refs", async () => {
		const root = await makeRoot("omp-projector-round-trip-");
		const cas = new FileCas(path.join(root, "state"));
		const spec = await makePrimeSpec(cas);
		const sourceAssistant = spec.nodes.find(node => node.role === "assistant" && node.thinkingRef);
		if (sourceAssistant === undefined) throw new Error("missing historical assistant refs");
		const providerPayloadRef = await cas.put(encoder.encode('{"provider":"prime","request":"historical"}'));
		const source: SessionSpecV1 = {
			...spec,
			header: { ...spec.header, cwd: root },
			nodes: spec.nodes.map(node => (node.id === sourceAssistant.id ? { ...node, providerPayloadRef } : node)),
		};
		const projectedSpecAssistant = source.nodes.find(node => node.id === sourceAssistant.id);
		const projectedSpecResult = source.nodes.find(
			node => node.role === "toolResult" && node.toolPairs?.some(pair => pair.resultRef),
		);
		if (projectedSpecAssistant === undefined || projectedSpecResult === undefined)
			throw new Error("missing projected historical refs");
		const historicalRefs = [
			source.header.sourceRef,
			projectedSpecAssistant.thinkingRef,
			projectedSpecAssistant.providerPayloadRef,
			...(projectedSpecAssistant.toolPairs ?? []).map(pair => pair.originalCallRef),
			...(projectedSpecResult.toolPairs ?? []).map(pair => pair.resultRef),
		].filter((ref): ref is NonNullable<typeof ref> => ref !== undefined);
		const historicalBytes = await Promise.all(historicalRefs.map(ref => cas.read(ref)));

		const projected = await projectToOmp(source, {
			cwd: root,
			sessionDir: path.join(root, "sessions"),
			cas,
		});

		expect(projected.report.bridgeDigest).toMatch(/^[0-9a-f]{64}$/);
		const roundTripped = await readOmpSession(projected.path, cas, {
			trustedBridgeDigest: projected.report.bridgeDigest,
		});
		expect(roundTripped.nodes).toHaveLength(source.nodes.length);
		expect(roundTripped.nodes.map(node => [node.id, node.parentId])).toEqual(
			source.nodes.map(node => [node.id, node.parentId]),
		);
		expect(roundTripped.header.sourceRef).toEqual(source.header.sourceRef);
		const restoredAssistant = roundTripped.nodes.find(node => node.id === projectedSpecAssistant.id);
		if (restoredAssistant === undefined) throw new Error("missing restored assistant refs");
		expect(restoredAssistant.thinkingRef).toEqual(projectedSpecAssistant.thinkingRef);
		expect(restoredAssistant.providerPayloadRef).toEqual(projectedSpecAssistant.providerPayloadRef);
		expect(restoredAssistant.toolPairs?.map(pair => pair.originalCallRef)).toEqual(
			projectedSpecAssistant.toolPairs?.map(pair => pair.originalCallRef),
		);
		const restoredResult = roundTripped.nodes.find(node => node.id === projectedSpecResult.id);
		if (restoredResult === undefined) throw new Error("missing restored tool result refs");
		expect(restoredResult.toolPairs?.map(pair => pair.resultRef)).toEqual(
			projectedSpecResult.toolPairs?.map(pair => pair.resultRef),
		);
		for (const [index, ref] of historicalRefs.entries()) expect(await cas.read(ref)).toEqual(historicalBytes[index]);
	});
	it("preserves original OMP title-slot CAS bytes through OMP to Prime to OMP", async () => {
		const root = await makeRoot("omp-projector-title-round-trip-");
		const cas = new FileCas(path.join(root, "state"));
		const source = await readOmpSession(ompFixturePath, cas, {
			ompAgentDir: root,
		});
		const titleSlotValue = source.nodes[0]?.metadata?.titleSlotRef;
		if (
			typeof titleSlotValue !== "object" ||
			titleSlotValue === null ||
			Array.isArray(titleSlotValue) ||
			typeof titleSlotValue.hash !== "string"
		)
			throw new Error("missing source OMP title-slot CAS ref");
		const titleSlotRef = titleSlotValue as { readonly hash: string; readonly byteLength?: number };
		const titleSlotBytes = await cas.read(titleSlotRef);
		const prime = await projectToPrime(source, {
			primeHome: path.join(root, "prime-home"),
			cas,
			sessionId: "22222222-2222-4222-8222-222222222222",
			now: "2026-08-12T00:00:00.000Z",
		});
		const primeSpec = await readPrimeSession(prime.path, cas, { trustedBridgeDigest: prime.report.bridgeDigest });
		const omp = await projectToOmp(primeSpec, {
			cwd: root,
			sessionDir: path.join(root, "sessions"),
			cas,
		});
		const restored = await readOmpSession(omp.path, cas, { trustedBridgeDigest: omp.report.bridgeDigest });
		const restoredTitleSlot = restored.nodes[0]?.metadata?.titleSlotRef;
		expect(restoredTitleSlot).toEqual(titleSlotRef);
		expect(await cas.read(titleSlotRef)).toEqual(titleSlotBytes);
	});

	it("does not treat a generated OMP title slot as canonical Prime title provenance", async () => {
		const root = await makeRoot("omp-projector-generated-title-");
		const cas = new FileCas(path.join(root, "state"));
		const source = await makePrimeSpec(cas);
		const omp = await projectToOmp(source, {
			cwd: root,
			sessionDir: path.join(root, "sessions"),
			cas,
		});
		const ompSpec = await readOmpSession(omp.path, cas, { trustedBridgeDigest: omp.report.bridgeDigest });
		expect(ompSpec.nodes.some(node => node.metadata?.titleSlotRef !== undefined)).toBe(false);
		const prime = await projectToPrime(ompSpec, {
			primeHome: path.join(root, "prime-home"),
			cas,
			sessionId: "33333333-3333-4333-8333-333333333333",
			now: "2026-08-12T00:00:00.000Z",
		});
		expect(prime.report.losses.some(loss => loss.sourceType === "title")).toBe(false);
	});
});
