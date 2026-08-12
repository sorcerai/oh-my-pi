import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileCas } from "../src/session/cas";
import { readOmpSession } from "../src/session/omp-reader";
import type { JsonValue, SessionSpecNode } from "../src/session/spec";

const fixturePath = path.join(import.meta.dir, "fixtures", "sessions", "omp-v3.jsonl");
const availableBlobBytes = Buffer.from("omp-image-bytes");
const availableBlobHash = new Bun.SHA256().update(availableBlobBytes).digest("hex");
const temporaryDirectories: string[] = [];
const decoder = new TextDecoder();

function refFrom(value: JsonValue | undefined): { hash: string; byteLength: number } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("missing CAS ref");
	if (typeof value.hash !== "string" || typeof value.byteLength !== "number") throw new Error("invalid CAS ref");
	return { hash: value.hash, byteLength: value.byteLength };
}

function metadata(node: SessionSpecNode): Record<string, JsonValue> {
	return node.metadata ?? {};
}

async function makeRoots(): Promise<{ root: string; cas: FileCas; agentDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reader-"));
	temporaryDirectories.push(root);
	const agentDir = path.join(root, "agent");
	const blobsDir = path.join(agentDir, "blobs");
	await fs.mkdir(blobsDir, { recursive: true });
	await fs.writeFile(path.join(blobsDir, availableBlobHash), availableBlobBytes);
	return { root, cas: new FileCas(path.join(root, "cas")), agentDir };
}
function sessionJsonl(entries: readonly Record<string, unknown>[], headerFields: Record<string, unknown> = {}): string {
	return `${[
		JSON.stringify({
			type: "session",
			version: 3,
			id: "test-session",
			timestamp: "2026-08-12T00:00:00.000Z",
			cwd: "/tmp",
			...headerFields,
		}),
		...entries.map(entry => JSON.stringify(entry)),
	].join("\n")}\n`;
}

function messageEntry(
	id: string,
	message: Record<string, unknown>,
	parentId: string | null = null,
): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-08-12T00:00:01.000Z",
		message,
	};
}

function noncanonicalTitleSlot(title: string): string {
	const prefix = ` { "type" : "title" , "v" : 1 , "title" : ${JSON.stringify(title)} , "updatedAt" : "2026-08-12T00:00:00.000Z" , "pad" : "`;
	const suffix = '" }';
	const padLength = 255 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
	if (padLength < 0) throw new Error("title is too long for title slot");
	return `${prefix}${" ".repeat(padLength)}${suffix}`;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("OMP v3 session reader", () => {
	it("peels the title slot, maps every v3 variant, and preserves the rooted branched tree", async () => {
		const { cas, agentDir } = await makeRoots();
		const source = await fs.readFile(fixturePath, "utf8");
		const lines = source.split("\n").filter(line => line.length > 0);
		expect(Buffer.byteLength(`${lines[0]}\n`)).toBe(256);
		expect(JSON.parse(lines[1]).type).toBe("session");

		const spec = await readOmpSession(fixturePath, cas, { ompAgentDir: agentDir });
		expect(spec.header).toMatchObject({
			originHarness: "omp",
			sourceSessionId: "omp-session-001",
			title: "OMP reader fixture",
			cwd: "/tmp/omp-project",
			createdAt: "2026-08-12T00:00:00.000Z",
			sourceSchema: "omp-session-v3",
		});
		expect(decoder.decode(await cas.read(spec.header.sourceRef!))).toBe(lines[1]);
		const titleRef = refFrom(metadata(spec.nodes[0]).titleSlotRef);
		expect(titleRef.byteLength).toBe(256);
		expect(decoder.decode(await cas.read(titleRef))).toBe(source.slice(0, source.indexOf("\n") + 1));

		expect(spec.nodes.map(node => node.id)).toEqual([
			"omp-user-1",
			"omp-assistant-1",
			"omp-read-result",
			"omp-bash-result",
			"omp-compaction",
			"omp-branch-assistant",
			"omp-branch-user",
			"omp-custom",
			"omp-unknown",
			"omp-active",
			"omp-developer",
			"omp-custom-role",
			"omp-hook",
			"omp-bash",
			"omp-python",
			"omp-file-mention",
			"omp-thinking-level",
			"omp-model",
			"omp-tier",
			"omp-branch-summary",
			"omp-reset",
			"omp-label",
			"omp-title-change",
			"omp-ttsr",
			"omp-credential",
			"omp-init",
			"omp-mode",
		]);
		expect(spec.nodes.map(node => node.parentId)).toEqual([
			null,
			"omp-user-1",
			"omp-assistant-1",
			"omp-assistant-1",
			"omp-bash-result",
			"omp-user-1",
			"omp-branch-assistant",
			"omp-compaction",
			"omp-custom",
			"omp-unknown",
			"omp-active",
			"omp-developer",
			"omp-custom-role",
			"omp-hook",
			"omp-bash",
			"omp-python",
			"omp-file-mention",
			"omp-thinking-level",
			"omp-model",
			"omp-tier",
			"omp-branch-summary",
			"omp-reset",
			"omp-label",
			"omp-title-change",
			"omp-ttsr",
			"omp-credential",
			"omp-init",
		]);
		expect(spec.activeLeafId).toBe("omp-mode");
		expect(spec.nodes.filter(node => node.parentId === "omp-user-1").map(node => node.id)).toEqual([
			"omp-assistant-1",
			"omp-branch-assistant",
		]);

		expect(new Set(spec.nodes.map(node => metadata(node).sourceType))).toEqual(
			new Set([
				"message",
				"thinking_level_change",
				"model_change",
				"service_tier_change",
				"compaction",
				"branch_summary",
				"reset_boundary",
				"custom",
				"custom_message",
				"label",
				"title_change",
				"ttsr_injection",
				"credential_pin",
				"session_init",
				"mode_change",
				"future_entry",
			]),
		);
		const expectedRoles: Record<string, SessionSpecNode["role"]> = {
			"omp-user-1": "user",
			"omp-assistant-1": "assistant",
			"omp-read-result": "toolResult",
			"omp-bash-result": "toolResult",
			"omp-compaction": "compaction",
			"omp-branch-assistant": "assistant",
			"omp-branch-user": "user",
			"omp-custom": "custom",
			"omp-unknown": "custom",
			"omp-active": "custom",
			"omp-developer": "system",
			"omp-custom-role": "custom",
			"omp-hook": "custom",
			"omp-bash": "custom",
			"omp-python": "custom",
			"omp-file-mention": "custom",
			"omp-thinking-level": "custom",
			"omp-model": "custom",
			"omp-tier": "custom",
			"omp-branch-summary": "custom",
			"omp-reset": "custom",
			"omp-label": "custom",
			"omp-title-change": "custom",
			"omp-ttsr": "custom",
			"omp-credential": "custom",
			"omp-init": "custom",
			"omp-mode": "custom",
		};
		for (const [id, role] of Object.entries(expectedRoles))
			expect(spec.nodes.find(node => node.id === id)?.role).toBe(role);
		expect(spec.nodes.find(node => node.id === "omp-branch-summary")?.content).toBe("branch");
		expect(spec.nodes.find(node => node.id === "omp-developer")?.content).toEqual([
			{ type: "text", text: "developer instruction" },
		]);
		expect(spec.nodes.find(node => node.id === "omp-custom-role")?.content).toBe("custom payload");
		expect(metadata(spec.nodes.find(node => node.id === "omp-hook")!).messageRole).toBe("hookMessage");
		expect(metadata(spec.nodes.find(node => node.id === "omp-bash")!).messageRole).toBe("bashExecution");
		expect(metadata(spec.nodes.find(node => node.id === "omp-python")!).messageRole).toBe("pythonExecution");
		expect(metadata(spec.nodes.find(node => node.id === "omp-file-mention")!).messageRole).toBe("fileMention");
		expect(spec.nativeIdMap["omp-active"]).toEqual({ omp: "omp-active" });

		const lineById = new Map(lines.slice(2).map(line => [JSON.parse(line).id as string, line]));
		for (const node of spec.nodes) {
			const line = lineById.get(node.id);
			if (!line) throw new Error(`missing fixture source line ${node.id}`);
			expect(decoder.decode(await cas.read(refFrom(metadata(node).sourceLineRef)))).toBe(line);
		}
	});

	it("stores exact physical, nested message, tool-call, thinking, provider, and result bytes", async () => {
		const { cas, agentDir } = await makeRoots();
		const source = await fs.readFile(fixturePath, "utf8");
		const lines = source.split("\n").filter(line => line.length > 0);
		const lineById = new Map(lines.slice(2).map(line => [JSON.parse(line).id as string, line]));
		const spec = await readOmpSession(fixturePath, cas, { ompAgentDir: agentDir });
		const assistant = spec.nodes.find(node => node.id === "omp-assistant-1");
		if (!assistant) throw new Error("missing assistant");
		const assistantLine = lineById.get(assistant.id);
		if (!assistantLine) throw new Error("missing assistant source line");
		const assistantMessageStart = assistantLine.indexOf("{", assistantLine.indexOf('"message"'));
		const assistantMessageRef = refFrom(metadata(assistant).sourceMessageRef);
		expect(decoder.decode(await cas.read(assistantMessageRef))).toBe(
			assistantLine.slice(assistantMessageStart, assistantLine.lastIndexOf("}")),
		);
		expect(assistant.toolPairs?.map(pair => [pair.toolName, pair.callId])).toEqual([
			["read", "omp-call-read"],
			["edit", "omp-call-edit"],
			["bash", "omp-call-bash"],
			["eval", "omp-call-eval"],
			["ipython", "omp-call-ipython"],
		]);
		const callStart = assistantLine.indexOf('{"type":"toolCall","name":"read"');
		const callEnd = assistantLine.indexOf(', {"type":"toolCall"', callStart);
		const firstCall = assistant.toolPairs?.[0]?.originalCallRef;
		if (!firstCall) throw new Error("missing original call ref");
		expect(decoder.decode(await cas.read(firstCall))).toBe(assistantLine.slice(callStart, callEnd));
		const thinkingStart = assistantLine.indexOf('{"type":"thinking"');
		const thinkingEnd = assistantLine.indexOf("}, {", thinkingStart) + 1;
		expect(decoder.decode(await cas.read(assistant.thinkingRef!))).toBe(
			assistantLine.slice(thinkingStart, thinkingEnd),
		);
		const providerStart = assistantLine.indexOf("{", assistantLine.indexOf('"providerPayload"'));
		const providerTimestamp = assistantLine.indexOf('"timestamp":1786492802000', providerStart);
		const providerEnd = assistantLine.lastIndexOf("}", providerTimestamp) + 1;
		expect(decoder.decode(await cas.read(assistant.providerPayloadRef!))).toBe(
			assistantLine.slice(providerStart, providerEnd),
		);

		const result = spec.nodes.find(node => node.id === "omp-read-result");
		if (!result?.toolPairs?.[0]?.resultRef) throw new Error("missing tool result ref");
		const resultLine = lineById.get(result.id);
		if (!resultLine) throw new Error("missing result source line");
		const resultMessageStart = resultLine.indexOf("{", resultLine.indexOf('"message"'));
		expect(decoder.decode(await cas.read(result.toolPairs[0].resultRef))).toBe(
			resultLine.slice(resultMessageStart, resultLine.lastIndexOf("}")),
		);
	});

	it("copies available blobs, records missing blobs, and accepts malformed blob-looking user text", async () => {
		const { cas, agentDir } = await makeRoots();
		const spec = await readOmpSession(fixturePath, cas, { ompAgentDir: agentDir });
		expect(decoder.decode(await cas.read(availableBlobHash))).toBe("omp-image-bytes");
		expect(spec.nodes.find(node => node.id === "omp-user-1")?.content).toEqual([
			{ type: "text", text: "hello \\nworld" },
			{ type: "text", text: "blob:sha256:not-a-valid-sha256-ref" },
			{
				type: "image",
				data: "blob:sha256:ea0ea6826c8d81551f3eb816b8941326b7ad0271833a4447a2c843722aa42eea",
				mimeType: "image/png",
			},
			{
				type: "image",
				data: "blob:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
				mimeType: "image/jpeg",
			},
		]);
		expect(spec.lossLedger.filter(loss => loss.code === "blob_unavailable")).toHaveLength(1);
		expect(spec.lossLedger).toContainEqual(
			expect.objectContaining({ code: "unsupported_role", nodeId: "omp-unknown", sourceType: "future_entry" }),
		);
	});

	it("rejects a corrupted blob instead of storing unverifiable bytes", async () => {
		const { cas, agentDir } = await makeRoots();
		await fs.writeFile(path.join(agentDir, "blobs", availableBlobHash), Buffer.from("corrupted"));
		await expect(readOmpSession(fixturePath, cas, { ompAgentDir: agentDir })).rejects.toThrow(
			/hash verification failed/,
		);
		await expect(cas.read(availableBlobHash)).rejects.toThrow();
	});

	it("keeps the loss ledger deterministic and projects stable loss identity", async () => {
		const { cas, agentDir } = await makeRoots();
		const spec = await readOmpSession(fixturePath, cas, { ompAgentDir: agentDir });
		expect(spec.lossLedger.map(({ code, nodeId, sourceType }) => [code, nodeId, sourceType])).toEqual([
			["entry_metadata_unrepresentable", undefined, "session"],
			["entry_metadata_unrepresentable", undefined, "session"],
			["entry_metadata_unrepresentable", undefined, "session"],
			["entry_metadata_unrepresentable", undefined, "session"],
			["blob_unavailable", undefined, "blob"],
			["unsupported_role", "omp-unknown", "future_entry"],
		]);
	});

	it("rejects duplicate JSON object keys before provenance extraction", async () => {
		const { root, cas } = await makeRoots();
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "duplicate-session",
			timestamp: "2026-08-12T00:00:00.000Z",
			cwd: "/tmp",
		});
		const duplicateLines = [
			'{"type":"custom","id":"first","id":"second","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","customType":"x"}',
			'{"type":"message","id":"nested","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","message":{"role":"user","role":"developer","content":"text","timestamp":1}}',
		];
		for (const [index, line] of duplicateLines.entries()) {
			const filePath = path.join(root, `duplicate-key-${index}.jsonl`);
			await fs.writeFile(filePath, `${header}\n${line}\n`);
			await expect(readOmpSession(filePath, cas)).rejects.toThrow(/duplicate JSON object keys/);
		}
	});

	it("rejects empty tool call IDs and names", async () => {
		const { root, cas } = await makeRoots();
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		for (const [index, toolCall] of [
			{ type: "toolCall", id: "", name: "read", arguments: {} },
			{ type: "toolCall", id: "call-1", name: "", arguments: {} },
		].entries()) {
			const filePath = path.join(root, `empty-tool-field-${index}.jsonl`);
			await fs.writeFile(
				filePath,
				sessionJsonl([
					messageEntry(`assistant-${index}`, {
						role: "assistant",
						content: [toolCall],
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5",
						usage,
						stopReason: "toolUse",
						timestamp: 1,
					}),
				]),
			);
			await expect(readOmpSession(filePath, cas)).rejects.toThrow(/non-empty string field/);
		}
	});

	it("accepts a header-only session with a nullable active leaf", async () => {
		const { root, cas } = await makeRoots();
		const filePath = path.join(root, "header-only.jsonl");
		const headerLine =
			'{"type":"session","version":3,"id":"header-only","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp"}';
		await fs.writeFile(filePath, `${headerLine}\n`);
		const spec = await readOmpSession(filePath, cas);
		expect(spec.nodes).toEqual([]);
		expect(spec.activeLeafId).toBeNull();
		expect(decoder.decode(await cas.read(spec.header.sourceRef!))).toBe(headerLine);
	});

	it("does not treat valid-looking blob refs in text or header data as blobs", async () => {
		const { root, cas, agentDir } = await makeRoots();
		const unavailableHash = "b".repeat(64);
		const filePath = path.join(root, "blob-text.jsonl");
		await fs.writeFile(
			filePath,
			sessionJsonl(
				[
					messageEntry("text", {
						role: "user",
						content: [{ type: "text", text: `ordinary text ${unavailableHash}` }],
						timestamp: 1,
					}),
					{
						type: "custom",
						id: "custom",
						parentId: "text",
						timestamp: "2026-08-12T00:00:02.000Z",
						customType: "blob-note",
						data: { note: `custom data blob:sha256:${unavailableHash}` },
					},
					messageEntry(
						"assistant",
						{
							role: "assistant",
							content: [],
							api: "openai-responses",
							provider: "openai",
							model: "gpt-5",
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							providerPayload: {
								type: "openaiResponsesHistory",
								items: [
									{
										nested: {
											type: "image",
											data: `blob:sha256:${unavailableHash}`,
											mimeType: "image/png",
										},
									},
								],
							},
							timestamp: 3,
						},
						"custom",
					),
				],
				{ title: `header note blob:sha256:${unavailableHash}` },
			),
		);
		const spec = await readOmpSession(filePath, cas, { ompAgentDir: agentDir });
		expect(spec.lossLedger.filter(loss => loss.code === "blob_unavailable")).toEqual([]);
	});

	it("uses the title slot, then the header title, then the basename", async () => {
		const { root, cas } = await makeRoots();
		const titleSlotPath = path.join(root, "title-slot.jsonl");
		const titleSlotLine = noncanonicalTitleSlot("slot title");
		await fs.writeFile(titleSlotPath, `${titleSlotLine}\n${sessionJsonl([], { title: "header title" })}`);
		expect((await readOmpSession(titleSlotPath, cas)).header.title).toBe("slot title");

		const headerTitlePath = path.join(root, "header-title.jsonl");
		await fs.writeFile(headerTitlePath, sessionJsonl([], { title: "header title" }));
		expect((await readOmpSession(headerTitlePath, cas)).header.title).toBe("header title");

		const basenamePath = path.join(root, "basename-fallback.jsonl");
		await fs.writeFile(basenamePath, sessionJsonl([]));
		expect((await readOmpSession(basenamePath, cas)).header.title).toBe("basename-fallback.jsonl");
	});

	it("records a title-slot loss when a title-only session has no canonical node", async () => {
		const { root, cas } = await makeRoots();
		const filePath = path.join(root, "title-only.jsonl");
		const titleSlotLine = noncanonicalTitleSlot("orphan title");
		await fs.writeFile(filePath, `${titleSlotLine}\n${sessionJsonl([])}`);
		const spec = await readOmpSession(filePath, cas);
		expect(spec.lossLedger).toContainEqual(
			expect.objectContaining({
				code: "entry_metadata_unrepresentable",
				sourceType: "title",
			}),
		);
	});

	it("accepts every currently supported optional role field", async () => {
		const { root, cas } = await makeRoots();
		const filePath = path.join(root, "optional-fields.jsonl");
		const usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const entries = [
			messageEntry("user", {
				role: "user",
				content: [
					{ type: "text", text: "user", textSignature: "user-signature" },
					{ type: "image", data: "inline", mimeType: "image/png", detail: "low" },
				],
				synthetic: true,
				steering: true,
				attribution: "agent",
				timestamp: 1,
			}),
			messageEntry(
				"developer",
				{
					role: "developer",
					content: "developer",
					attribution: "user",
					timestamp: 2,
				},
				"user",
			),
			messageEntry(
				"assistant",
				{
					role: "assistant",
					content: [
						{ type: "text", text: "assistant", textSignature: "assistant-signature" },
						{
							type: "thinking",
							thinking: "reasoning",
							thinkingSignature: "thinking-signature",
							itemId: "item-1",
						},
						{ type: "redactedThinking", data: "redacted" },
						{
							type: "toolCall",
							id: "call",
							name: "read",
							arguments: {},
							thoughtSignature: "thought-signature",
							intent: "inspect",
							rawBlock: "raw",
							customWireName: "read",
						},
						{ type: "image", data: "inline", mimeType: "image/png" },
					],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5",
					usage,
					stopReason: "stop",
					responseId: "response-1",
					upstreamProvider: "gateway",
					errorMessage: "none",
					providerPayload: { type: "openaiResponsesHistory", provider: "openai", dt: false, items: [{}] },
					timestamp: 3,
				},
				"developer",
			),
			messageEntry(
				"tool-result",
				{
					role: "toolResult",
					toolCallId: "call",
					toolName: "read",
					content: [{ type: "text", text: "result", textSignature: "result-signature" }],
					details: { ok: true },
					isError: false,
					timestamp: 4,
				},
				"assistant",
			),
			messageEntry(
				"custom",
				{
					role: "custom",
					customType: "custom",
					content: [{ type: "image", data: "inline", mimeType: "image/png", detail: "auto" }],
					display: true,
					details: { ok: true },
					attribution: "agent",
					timestamp: 5,
				},
				"tool-result",
			),
			messageEntry(
				"hook",
				{
					role: "hookMessage",
					customType: "hook",
					content: "hook",
					display: false,
					details: { ok: true },
					attribution: "user",
					timestamp: 6,
				},
				"custom",
			),
			messageEntry(
				"bash",
				{
					role: "bashExecution",
					command: "printf hi",
					output: "hi",
					exitCode: 0,
					cancelled: false,
					truncated: false,
					meta: { source: { type: "internal", value: "test" } },
					excludeFromContext: true,
					timestamp: 7,
				},
				"hook",
			),
			messageEntry(
				"python",
				{
					role: "pythonExecution",
					code: "print(2)",
					output: "2",
					cancelled: false,
					truncated: false,
					meta: { source: { type: "internal", value: "test" } },
					timestamp: 8,
				},
				"bash",
			),
			messageEntry(
				"file",
				{
					role: "fileMention",
					files: [
						{
							path: "image.png",
							content: "image",
							lineCount: 1,
							byteSize: 5,
							skippedReason: "binary",
							image: { type: "image", data: "inline", mimeType: "image/png" },
						},
					],
					timestamp: 9,
				},
				"python",
			),
		];
		await fs.writeFile(filePath, sessionJsonl(entries));
		const spec = await readOmpSession(filePath, cas);
		expect(spec.nodes).toHaveLength(entries.length);
	});

	it("rejects omitted nested fields and undeclared fields for every current role", async () => {
		const { root, cas } = await makeRoots();
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const malformedNested = [
			messageEntry("assistant-usage", {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5",
				usage,
				stopReason: "stop",
				timestamp: 1,
			}),
			messageEntry("assistant-tool-call", {
				role: "assistant",
				content: [{ type: "toolCall", id: "call", name: "read" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5",
				usage: { ...usage, cost: { ...usage.cost, total: 0 } },
				stopReason: "stop",
				timestamp: 1,
			}),
			messageEntry("tool-content", {
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text" }],
				isError: false,
				timestamp: 1,
			}),
			messageEntry("file-image", {
				role: "fileMention",
				files: [{ path: "x", content: "x", image: { type: "image", data: "inline" } }],
				timestamp: 1,
			}),
			messageEntry("provider-items", {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5",
				usage: { ...usage, cost: { ...usage.cost, total: 0 } },
				stopReason: "stop",
				providerPayload: { type: "openaiResponsesHistory" },
				timestamp: 1,
			}),
		];
		for (const [index, entry] of malformedNested.entries()) {
			const filePath = path.join(root, `nested-${index}.jsonl`);
			await fs.writeFile(filePath, sessionJsonl([entry]));
			await expect(readOmpSession(filePath, cas)).rejects.toThrow();
		}

		const roleCases: Array<[string, Record<string, unknown>]> = [
			["user", { role: "user", content: "x", timestamp: 1, api: "unexpected" }],
			["developer", { role: "developer", content: "x", timestamp: 1, customType: "unexpected" }],
			[
				"assistant",
				{
					role: "assistant",
					content: [],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5",
					usage: { ...usage, cost: { ...usage.cost, total: 0 } },
					stopReason: "stop",
					details: {},
					timestamp: 1,
				},
			],
			[
				"toolResult",
				{
					role: "toolResult",
					toolCallId: "call",
					toolName: "read",
					content: [],
					isError: false,
					command: "unexpected",
					timestamp: 1,
				},
			],
			[
				"custom",
				{ role: "custom", customType: "custom", content: "x", display: true, command: "unexpected", timestamp: 1 },
			],
			[
				"hookMessage",
				{
					role: "hookMessage",
					customType: "hook",
					content: "x",
					display: true,
					toolCallId: "unexpected",
					timestamp: 1,
				},
			],
			[
				"branchSummary",
				{ role: "branchSummary", summary: "summary", fromId: "root", timestamp: 1, content: "unexpected" },
			],
			[
				"compactionSummary",
				{
					role: "compactionSummary",
					summary: "summary",
					tokensBefore: 1,
					timestamp: 1,
					fromId: "unexpected",
				},
			],
			[
				"bashExecution",
				{
					role: "bashExecution",
					command: "echo",
					output: "",
					cancelled: false,
					truncated: false,
					code: "unexpected",
					timestamp: 1,
				},
			],
			[
				"pythonExecution",
				{
					role: "pythonExecution",
					code: "print(1)",
					output: "",
					cancelled: false,
					truncated: false,
					command: "unexpected",
					timestamp: 1,
				},
			],
			["fileMention", { role: "fileMention", files: [{ path: "x", content: "x" }], display: true, timestamp: 1 }],
		];
		for (const [role, message] of roleCases) {
			const filePath = path.join(root, `undeclared-${role}.jsonl`);
			await fs.writeFile(filePath, sessionJsonl([messageEntry(role, message)]));
			await expect(readOmpSession(filePath, cas)).rejects.toThrow();
		}
	});

	it("accepts native branch and compaction summary messages", async () => {
		const { root, cas } = await makeRoots();
		const filePath = path.join(root, "summary-messages.jsonl");
		await fs.writeFile(
			filePath,
			sessionJsonl([
				messageEntry("branch-summary", {
					role: "branchSummary",
					summary: "branch",
					fromId: "source",
					timestamp: 1,
				}),
				{
					...messageEntry("compaction-summary", {
						role: "compactionSummary",
						summary: "compacted",
						shortSummary: "short",
						tokensBefore: 42,
						blocks: [{ type: "text", text: "archive" }],
						images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
						warning: "warning",
						timestamp: 2,
					}),
					parentId: "branch-summary",
				},
			]),
		);
		const spec = await readOmpSession(filePath, cas);
		expect(spec.nodes.map(node => node.role)).toEqual(["custom", "custom"]);
	});

	it("rejects malformed known records, malformed optional fields, and invalid trees", async () => {
		const { root, cas } = await makeRoots();
		const malformedPath = path.join(root, "malformed.jsonl");
		await fs.writeFile(
			malformedPath,
			'{"type":"session","version":3,"id":"s","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"m","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","message":{"role":"assistant","content":[]}}\n',
		);
		await expect(readOmpSession(malformedPath, cas)).rejects.toThrow(/timestamp/);

		const malformedOptionalCases = [
			{
				name: "header-title-source",
				body: '{"type":"session","version":3,"id":"s","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp","titleSource":1}\n',
				error: /invalid titleSource|titleSource is invalid/,
			},
			{
				name: "user-synthetic",
				body:
					'{"type":"session","version":3,"id":"s","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp"}\n' +
					'{"type":"message","id":"m","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","message":{"role":"user","content":"x","synthetic":"yes","timestamp":1}}\n',
				error: /boolean field synthetic/,
			},
			{
				name: "file-skipped-reason",
				body:
					'{"type":"session","version":3,"id":"s","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp"}\n' +
					'{"type":"message","id":"m","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","message":{"role":"fileMention","files":[{"path":"x","content":"x","skippedReason":"unknown"}],"timestamp":1}}\n',
				error: /skippedReason is invalid/,
			},
		];
		for (const malformed of malformedOptionalCases) {
			const filePath = path.join(root, `${malformed.name}.jsonl`);
			await fs.writeFile(filePath, malformed.body);
			await expect(readOmpSession(filePath, cas)).rejects.toThrow(malformed.error);
		}

		const missingParentPath = path.join(root, "missing-parent.jsonl");
		await fs.writeFile(
			missingParentPath,
			'{"type":"session","version":3,"id":"s","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"custom","id":"root","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","customType":"x"}\n' +
				'{"type":"custom","id":"child","parentId":"missing","timestamp":"2026-08-12T00:00:02.000Z","customType":"x"}\n',
		);
		await expect(readOmpSession(missingParentPath, cas)).rejects.toThrow(/missing parent/);

		const laterRootPath = path.join(root, "later-root.jsonl");
		await fs.writeFile(
			laterRootPath,
			'{"type":"session","version":3,"id":"s","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"custom","id":"root","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","customType":"x"}\n' +
				'{"type":"custom","id":"root2","parentId":null,"timestamp":"2026-08-12T00:00:02.000Z","customType":"x"}\n',
		);
		await expect(readOmpSession(laterRootPath, cas)).rejects.toThrow(/exactly one root/);

		const forwardPath = path.join(root, "forward.jsonl");
		await fs.writeFile(
			forwardPath,
			'{"type":"session","version":3,"id":"s","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"custom","id":"root","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","customType":"x"}\n' +
				'{"type":"custom","id":"child","parentId":"later","timestamp":"2026-08-12T00:00:02.000Z","customType":"x"}\n' +
				'{"type":"custom","id":"later","parentId":"root","timestamp":"2026-08-12T00:00:03.000Z","customType":"x"}\n',
		);
		await expect(readOmpSession(forwardPath, cas)).rejects.toThrow(/forward parent/);
	});

	it("rejects invalid UTF-8 and preserves prototype-shaped native IDs", async () => {
		const { root, cas } = await makeRoots();
		const invalidUtf8Path = path.join(root, "invalid-utf8.jsonl");
		await fs.writeFile(
			invalidUtf8Path,
			Buffer.concat([
				Buffer.from(
					'{"type":"session","version":3,"id":"s","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp"}\n' +
						'{"type":"custom","id":"root","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","customType":"',
				),
				Buffer.from([0xff]),
				Buffer.from('"}\n'),
			]),
		);
		await expect(readOmpSession(invalidUtf8Path, cas)).rejects.toThrow();

		const prototypeIdPath = path.join(root, "prototype-id.jsonl");
		await fs.writeFile(
			prototypeIdPath,
			sessionJsonl([
				{
					type: "custom",
					id: "__proto__",
					parentId: null,
					timestamp: "2026-08-12T00:00:01.000Z",
					customType: "prototype-id",
				},
			]),
		);
		const spec = await readOmpSession(prototypeIdPath, cas);
		expect(Object.hasOwn(spec.nativeIdMap, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(spec.nativeIdMap, "__proto__")?.value).toEqual({
			omp: "__proto__",
		});
	});
	it("restores trusted bridge canonical identity and CAS provenance only with the exact file digest", async () => {
		const { root, cas } = await makeRoots();
		const filePath = path.join(root, "trusted-bridge.jsonl");
		const sourceRef = await cas.put(new TextEncoder().encode("source"));
		const lineRef = await cas.put(new TextEncoder().encode("line"));
		const thinkingRef = await cas.put(new TextEncoder().encode("thinking"));
		const originalCallRef = await cas.put(new TextEncoder().encode("original-call"));
		const synthesizedCallRef = await cas.put(new TextEncoder().encode("synthesized-call"));
		const markerData = {
			version: 1,
			activeLeafId: "canonical-user",
			header: { sourceRef },
			nativeIdMap: { "canonical-user": { omp: "physical-root" } },
			lossLedger: [],
			provenance: {
				"canonical-user": {
					role: "assistant",
					thinkingRef,
					metadata: { sourceLineRef: lineRef },
					toolPairs: [
						{
							pairIndex: 0,
							toolName: "bash",
							callId: "call-1",
							argsSnapshot: { command: "echo ok" },
							originalCallRef,
							synthesizedCallRef,
						},
					],
				},
			},
		};
		const source = sessionJsonl([
			{
				type: "custom",
				id: "physical-root",
				parentId: null,
				timestamp: "2026-08-12T00:00:01.000Z",
				customType: "physical",
				data: "physical",
			},
			{
				type: "custom",
				id: "bridge",
				parentId: "physical-root",
				timestamp: "2026-08-12T00:00:02.000Z",
				customType: "prime-bridge/session-resume",
				data: markerData,
			},
		]);
		await fs.writeFile(filePath, source);
		const digest = new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(source)).digest("hex");
		const spec = await readOmpSession(filePath, cas, { trustedBridgeDigest: digest });
		expect(spec.nodes.map(node => [node.id, node.parentId])).toEqual([["canonical-user", null]]);
		expect(spec.activeLeafId).toBe("canonical-user");
		expect(spec.nativeIdMap).toEqual({ "canonical-user": { omp: "physical-root" } });
		expect(spec.header.sourceRef).toEqual(sourceRef);
		expect(spec.nodes[0]?.role).toBe("assistant");
		expect(spec.nodes[0]?.thinkingRef).toEqual(thinkingRef);
		expect(JSON.stringify(metadata(spec.nodes[0]!).sourceLineRef)).toBe(JSON.stringify(lineRef));
		expect(spec.nodes[0]?.toolPairs).toEqual([
			{
				toolName: "bash",
				callId: "call-1",
				argsSnapshot: { command: "echo ok" },
				originalCallRef,
				synthesizedCallRef,
			},
		]);
	});

	it("does not elevate bridge metadata when the digest is missing or does not match", async () => {
		const { root, cas } = await makeRoots();
		const filePath = path.join(root, "untrusted-bridge.jsonl");
		const source = sessionJsonl([
			{
				type: "custom",
				id: "physical-root",
				parentId: null,
				timestamp: "2026-08-12T00:00:01.000Z",
				customType: "physical",
			},
			{
				type: "custom",
				id: "bridge",
				parentId: "physical-root",
				timestamp: "2026-08-12T00:00:02.000Z",
				customType: "prime-bridge/session-resume",
				data: {
					version: 1,
					activeLeafId: "canonical-user",
					header: {},
					nativeIdMap: { "canonical-user": { omp: "physical-root" } },
					lossLedger: [],
					provenance: { "canonical-user": { role: "assistant", toolPairs: [] } },
				},
			},
		]);
		await fs.writeFile(filePath, source);
		const withoutDigest = await readOmpSession(filePath, cas);
		const withWrongDigest = await readOmpSession(filePath, cas, { trustedBridgeDigest: "0".repeat(64) });
		for (const spec of [withoutDigest, withWrongDigest]) {
			expect(spec.nodes.map(node => node.id)).toEqual(["physical-root", "bridge"]);
			expect(spec.nodes.find(node => node.id === "bridge")?.role).toBe("custom");
			expect(spec.activeLeafId).toBe("bridge");
		}
	});

	it("rejects malformed or ambiguous bridge metadata when the supplied digest matches", async () => {
		const { root, cas } = await makeRoots();
		const makeTrusted = async (entries: readonly Record<string, unknown>[], name: string) => {
			const filePath = path.join(root, name);
			const source = sessionJsonl(entries);
			await fs.writeFile(filePath, source);
			const digest = new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(source)).digest("hex");
			return { filePath, digest };
		};
		const malformed = await makeTrusted(
			[
				{
					type: "custom",
					id: "root",
					parentId: null,
					timestamp: "2026-08-12T00:00:01.000Z",
					customType: "physical",
				},
				{
					type: "custom",
					id: "bridge",
					parentId: "root",
					timestamp: "2026-08-12T00:00:02.000Z",
					customType: "prime-bridge/session-resume",
					data: { version: 1, nativeIdMap: {} },
				},
			],
			"malformed-bridge.jsonl",
		);
		await expect(readOmpSession(malformed.filePath, cas, { trustedBridgeDigest: malformed.digest })).rejects.toThrow(
			/bridge/,
		);
		const duplicate = await makeTrusted(
			[
				{
					type: "custom",
					id: "root",
					parentId: null,
					timestamp: "2026-08-12T00:00:01.000Z",
					customType: "physical",
				},
				{
					type: "custom",
					id: "bridge-a",
					parentId: "root",
					timestamp: "2026-08-12T00:00:02.000Z",
					customType: "prime-bridge/session-resume",
					data: {
						version: 1,
						activeLeafId: "canonical",
						header: {},
						nativeIdMap: { canonical: { omp: "root" } },
						lossLedger: [],
						provenance: { canonical: { role: "user", toolPairs: [] } },
					},
				},
				{
					type: "custom",
					id: "bridge-b",
					parentId: "bridge-a",
					timestamp: "2026-08-12T00:00:03.000Z",
					customType: "prime-bridge/session-resume",
					data: {
						version: 1,
						activeLeafId: "canonical",
						header: {},
						nativeIdMap: { canonical: { omp: "root" } },
						lossLedger: [],
						provenance: { canonical: { role: "user", toolPairs: [] } },
					},
				},
			],
			"duplicate-bridge.jsonl",
		);
		await expect(readOmpSession(duplicate.filePath, cas, { trustedBridgeDigest: duplicate.digest })).rejects.toThrow(
			/duplicate|ambiguous/,
		);
	});
});
