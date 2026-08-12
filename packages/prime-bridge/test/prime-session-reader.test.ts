import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileCas } from "../src/session/cas";
import { readPrimeSession } from "../src/session/prime-reader";
import type { JsonValue, SessionSpecNode } from "../src/session/spec";

const temporaryDirectories: string[] = [];
const fixturePath = path.join(import.meta.dir, "fixtures", "sessions", "prime-v3.jsonl");
const decoder = new TextDecoder();

async function makeCas(): Promise<FileCas> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prime-reader-"));
	temporaryDirectories.push(directory);
	return new FileCas(directory);
}

function metadata(node: SessionSpecNode): Record<string, JsonValue> {
	return node.metadata ?? {};
}

function refFrom(value: JsonValue | undefined): { hash: string; byteLength: number } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("missing CAS ref");
	if (typeof value.hash !== "string" || typeof value.byteLength !== "number") throw new Error("invalid CAS ref");
	return { hash: value.hash, byteLength: value.byteLength };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("Prime v3 session reader", () => {
	it("reads the representative fixture and preserves the complete tree", async () => {
		const cas = await makeCas();
		const source = await fs.readFile(fixturePath, "utf8");
		const physicalLines = source.split("\n").filter(line => line.length > 0);
		expect(JSON.parse(physicalLines[0]).type).toBe("session");

		const spec = await readPrimeSession(fixturePath, cas);
		expect(spec.header.originHarness).toBe("prime");
		expect(spec.header.sourceSessionId).toBe("prime-session-001");
		expect(spec.header.title).toBe("prime-v3.jsonl");
		expect(spec.header.cwd).toBe("/tmp/prime-project");
		expect(spec.header.createdAt).toBe("2026-08-11T00:00:00.000Z");
		expect(spec.header.sourceSchema).toBe("prime-session-v3");
		expect(spec.header.sourceRef).toBeDefined();
		expect(decoder.decode(await cas.read(spec.header.sourceRef!))).toBe(physicalLines[0]);
		expect(spec.nodes.map(node => node.id)).toEqual([
			"u0000001",
			"a0000001",
			"r0000001",
			"m0000001",
			"t0000001",
			"c0000001",
			"x0000001",
			"b0000002",
			"a0000002",
			"b0000001",
			"u0000002",
		]);
		expect(spec.nodes.map(node => node.parentId)).toEqual([
			null,
			"u0000001",
			"a0000001",
			"r0000001",
			"m0000001",
			"t0000001",
			"c0000001",
			"x0000001",
			"u0000001",
			"a0000002",
			"b0000001",
		]);
		expect(spec.activeLeafId).toBe("u0000002");
		expect(spec.nodes.filter(node => node.parentId === "u0000001").map(node => node.id)).toEqual([
			"a0000001",
			"a0000002",
		]);
		const user = spec.nodes[0];
		expect(user.role).toBe("user");
		expect(Array.isArray(user.content)).toBe(true);
		expect((user.content as Array<Record<string, JsonValue>>).some(block => block.type === "image")).toBe(true);
		expect(spec.nodes.find(node => node.id === "m0000001")?.metadata?.sourceType).toBe("model_change");
		expect(spec.nodes.find(node => node.id === "t0000001")?.metadata?.sourceType).toBe("thinking_level_change");
		expect(spec.nodes.find(node => node.id === "x0000001")?.role).toBe("custom");
		expect(spec.nodes.find(node => node.id === "c0000001")?.role).toBe("compaction");
	});
	it("reads a header-only v3 session with no active leaf", async () => {
		const cas = await makeCas();
		const headerLine =
			'{"type":"session","version":3,"id":"header-only","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp/header-only"}';
		const filePath = path.join(cas.root, "header-only.jsonl");
		await fs.writeFile(filePath, `${headerLine}\n`);
		const spec = await readPrimeSession(filePath, cas);
		expect(spec.nodes).toEqual([]);
		expect(spec.activeLeafId).toBeNull();
		expect(spec.header.sourceRef).toBeDefined();
		expect(decoder.decode(await cas.read(spec.header.sourceRef!))).toBe(headerLine);
	});
	it("accepts the Prime service-tier union including null and rejects unknown values", async () => {
		const cas = await makeCas();
		const directory = cas.root;
		const validPath = path.join(directory, "service-tier.jsonl");
		await fs.writeFile(
			validPath,
			'{"type":"session","version":3,"id":"service-tier","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"service_tier_change","id":"tier","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","serviceTier":null}\n',
		);
		await expect(readPrimeSession(validPath, cas)).resolves.toMatchObject({ nodes: [{ id: "tier" }] });
		const invalidPath = path.join(directory, "invalid-service-tier.jsonl");
		await fs.writeFile(
			invalidPath,
			'{"type":"session","version":3,"id":"service-tier","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"service_tier_change","id":"tier","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","serviceTier":"turbo"}\n',
		);
		await expect(readPrimeSession(invalidPath, cas)).rejects.toThrow(/invalid serviceTier/);
		const invalidArrayPath = path.join(directory, "invalid-array-service-tier.jsonl");
		await fs.writeFile(
			invalidArrayPath,
			'{"type":"session","version":3,"id":"service-tier","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"service_tier_change","id":"tier","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","serviceTier":["auto"]}\n',
		);
		await expect(readPrimeSession(invalidArrayPath, cas)).rejects.toThrow(/invalid serviceTier/);
	});
	it("maps a persisted custom message without an unsupported-role loss", async () => {
		const cas = await makeCas();
		const filePath = path.join(cas.root, "custom-message.jsonl");
		await fs.writeFile(
			filePath,
			'{"type":"session","version":3,"id":"custom-message","timestamp":"2026-08-12T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"custom","parentId":null,"timestamp":"2026-08-12T00:00:01.000Z","message":{"role":"custom","customType":"extension","content":"hello","display":true,"details":{"source":"test"},"timestamp":1786406401000}}\n',
		);
		const spec = await readPrimeSession(filePath, cas);
		expect(spec.nodes[0]?.role).toBe("custom");
		expect(spec.nodes[0]?.metadata).toMatchObject({
			customType: "extension",
			display: true,
			details: { source: "test" },
		});
		expect(spec.lossLedger.some(loss => loss.code === "unsupported_role")).toBe(false);
	});

	it("stores exact physical lines and native message/tool/thinking bytes in CAS", async () => {
		const cas = await makeCas();
		const source = await fs.readFile(fixturePath, "utf8");
		const linesById = new Map(
			source
				.split("\n")
				.filter(line => line.length > 0)
				.slice(1)
				.map(line => [JSON.parse(line).id as string, line]),
		);
		const spec = await readPrimeSession(fixturePath, cas);
		for (const node of spec.nodes) {
			const line = linesById.get(node.id);
			if (!line) throw new Error(`missing fixture line ${node.id}`);
			expect(decoder.decode(await cas.read(refFrom(metadata(node).sourceLineRef)))).toBe(line);
		}
		const assistant = spec.nodes.find(node => node.id === "a0000001");
		if (!assistant?.toolPairs?.[0]) throw new Error("missing ipython tool pair");
		const assistantLine = linesById.get("a0000001")!;
		const assistantMessageStart = assistantLine.indexOf("{", assistantLine.indexOf('"message"'));
		expect(decoder.decode(await cas.read(refFrom(metadata(assistant).sourceMessageRef)))).toBe(
			assistantLine.slice(assistantMessageStart, assistantLine.lastIndexOf("}")),
		);
		expect(assistant.toolPairs[0].callId).toBe("call-ipython-001");
		const toolCallStart = assistantLine.indexOf('{"type":"toolCall"');
		const toolCallEnd = assistantLine.lastIndexOf("}", assistantLine.indexOf(" ],", toolCallStart)) + 1;
		expect(decoder.decode(await cas.read(assistant.toolPairs[0].originalCallRef!))).toBe(
			assistantLine.slice(toolCallStart, toolCallEnd),
		);
		const thinkingStart = assistantLine.indexOf('{"type":"thinking"');
		const thinkingEnd = assistantLine.indexOf('},{"type":"text"', thinkingStart) + 1;
		expect(decoder.decode(await cas.read(assistant.thinkingRef!))).toBe(
			assistantLine.slice(thinkingStart, thinkingEnd),
		);
		const signatureStart = assistantLine.indexOf('"\\u0070rime-thinking-signature"');
		expect(decoder.decode(await cas.read(assistant.providerPayloadRef!))).toBe(
			assistantLine.slice(signatureStart, signatureStart + '"\\u0070rime-thinking-signature"'.length),
		);
		const result = spec.nodes.find(node => node.id === "r0000001");
		if (!result?.toolPairs?.[0]) throw new Error("missing tool result pair");
		const resultLine = linesById.get("r0000001")!;
		const resultMessageStart = resultLine.indexOf("{", resultLine.indexOf('"message"'));
		expect(result.toolPairs[0].callId).toBe("call-ipython-001");
		expect(decoder.decode(await cas.read(result.toolPairs[0].resultRef!))).toBe(
			resultLine.slice(resultMessageStart, resultLine.lastIndexOf("}")),
		);
	});

	it("records source losses for unavailable and unsupported Prime payload classes", async () => {
		const spec = await readPrimeSession(fixturePath, await makeCas());
		expect(spec.lossLedger).toContainEqual(
			expect.objectContaining({ code: "missing_source_bytes", sourceType: "provider_payload" }),
		);
		expect(spec.lossLedger).toContainEqual(
			expect.objectContaining({ code: "unsupported_role", nodeId: "b0000002", sourceType: "message" }),
		);
		expect(spec.lossLedger.filter(loss => loss.code === "entry_metadata_unrepresentable")).toHaveLength(3);
		expect(spec.lossLedger.filter(loss => loss.code === "unsupported_role").map(loss => loss.nodeId)).toEqual([
			"b0000002",
		]);
	});

	it("rejects empty tool call IDs and names", async () => {
		const cas = await makeCas();
		const header = {
			type: "session",
			version: 3,
			id: "empty-tool-field",
			timestamp: "2026-08-12T00:00:00.000Z",
			cwd: "/tmp",
		};
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
			const filePath = path.join(cas.root, `empty-tool-field-${index}.jsonl`);
			const entry = {
				type: "message",
				id: `assistant-${index}`,
				parentId: null,
				timestamp: "2026-08-12T00:00:01.000Z",
				message: {
					role: "assistant",
					timestamp: 1,
					content: [toolCall],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5",
					usage,
					stopReason: "toolUse",
				},
			};
			await fs.writeFile(filePath, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
			await expect(readPrimeSession(filePath, cas)).rejects.toThrow(/non-empty string field/);
		}
	});

	it("rejects an invalid first header and a missing parent", async () => {
		const cas = await makeCas();
		const directory = cas.root;
		const invalidHeaderPath = path.join(directory, "invalid-header.jsonl");
		await fs.writeFile(invalidHeaderPath, '{"type":"message","id":"x"}\n');
		await expect(readPrimeSession(invalidHeaderPath, cas)).rejects.toThrow(/session header/);
		const missingParentPath = path.join(directory, "missing-parent.jsonl");
		await fs.writeFile(
			missingParentPath,
			'{"type":"session","version":3,"id":"s","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"custom","id":"root","parentId":null,"timestamp":"2026-01-01T00:00:00.500Z","customType":"x"}\n' +
				'{"type":"custom","id":"x","parentId":"missing","timestamp":"2026-01-01T00:00:01.000Z","customType":"x"}\n',
		);
		await expect(readPrimeSession(missingParentPath, cas)).rejects.toThrow(/missing parent/);
	});

	it("rejects a parent cycle before returning a canonical session", async () => {
		const cas = await makeCas();
		const directory = cas.root;
		const cyclePath = path.join(directory, "cycle.jsonl");
		await fs.writeFile(
			cyclePath,
			'{"type":"session","version":3,"id":"s","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"custom","id":"root","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","customType":"x"}\n' +
				'{"type":"custom","id":"a","parentId":"b","timestamp":"2026-01-01T00:00:02.000Z","customType":"x"}\n' +
				'{"type":"custom","id":"b","parentId":"a","timestamp":"2026-01-01T00:00:03.000Z","customType":"x"}\n',
		);
		await expect(readPrimeSession(cyclePath, cas)).rejects.toThrow(/cycle/);
	});

	it("rejects a later root and a forward parent", async () => {
		const cas = await makeCas();
		const directory = cas.root;
		const laterRoot = path.join(directory, "later-root.jsonl");
		await fs.writeFile(
			laterRoot,
			'{"type":"session","version":3,"id":"s","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"custom","id":"root","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","customType":"x"}\n' +
				'{"type":"custom","id":"root2","parentId":null,"timestamp":"2026-01-01T00:00:02.000Z","customType":"x"}\n',
		);
		await expect(readPrimeSession(laterRoot, cas)).rejects.toThrow(/exactly one root/);
		const forward = path.join(directory, "forward.jsonl");
		await fs.writeFile(
			forward,
			'{"type":"session","version":3,"id":"s","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n' +
				'{"type":"custom","id":"root","parentId":null,"timestamp":"2026-01-01T00:00:01.000Z","customType":"x"}\n' +
				'{"type":"custom","id":"child","parentId":"later","timestamp":"2026-01-01T00:00:02.000Z","customType":"x"}\n' +
				'{"type":"custom","id":"later","parentId":"root","timestamp":"2026-01-01T00:00:03.000Z","customType":"x"}\n',
		);
		await expect(readPrimeSession(forward, cas)).rejects.toThrow(/forward parent/);
	});
});
