import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileCas } from "../src/session/cas";
import { LOSS_CODES, type LossCode, validateLossLedger } from "../src/session/loss-ledger";
import { type JsonValue, type SessionSpecV1, validateSessionSpec } from "../src/session/spec";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

function baseSpec(): SessionSpecV1 {
	return {
		specVersion: 1,
		header: {
			originHarness: "omp",
			sourceSessionId: "session-1",
			title: "Example",
			cwd: "/repo",
			createdAt: "2026-08-11T00:00:00.000Z",
			sourceSchema: "omp-v1",
		},
		nodes: [
			{ id: "root", parentId: null, role: "user", content: [{ type: "text", text: "hello" }] },
			{ id: "answer", parentId: "root", role: "assistant", content: "answer" },
		],
		activeLeafId: "answer",
		nativeIdMap: { root: { omp: "entry-1" } },
		lossLedger: [],
	};
}

function expectInvalid(spec: SessionSpecV1, message: RegExp): void {
	expect(() => validateSessionSpec(spec)).toThrow(message);
}

describe("SessionSpecV1 validation", () => {
	it("accepts a complete canonical tree", () => {
		expect(validateSessionSpec(baseSpec())).toEqual(baseSpec());
	});

	it("rejects duplicate node IDs", () => {
		const spec = baseSpec();
		spec.nodes[1] = { ...spec.nodes[1], id: "root" };
		expectInvalid(spec, /unique node IDs/);
	});

	it("rejects a missing parent", () => {
		const spec = baseSpec();
		spec.nodes[1] = { ...spec.nodes[1], parentId: "missing" };
		expectInvalid(spec, /parent/);
	});

	it("rejects cycles", () => {
		const spec = baseSpec();
		spec.nodes[0] = { ...spec.nodes[0], parentId: "answer" };
		expectInvalid(spec, /cycle/);
	});

	it("rejects an unknown active leaf", () => {
		const spec = baseSpec();
		spec.activeLeafId = "missing";
		expectInvalid(spec, /activeLeafId/);
	});

	it("rejects malformed optional CAS references", () => {
		const thinking = baseSpec();
		thinking.nodes[1] = { ...thinking.nodes[1], thinkingRef: { hash: "bad" } };
		expectInvalid(thinking, /SHA-256 hash/);

		const providerPayload = baseSpec();
		providerPayload.nodes[1] = {
			...providerPayload.nodes[1],
			providerPayloadRef: { hash: "bad" },
		};
		expectInvalid(providerPayload, /SHA-256 hash/);
	});

	it("requires node metadata to be an object map", () => {
		const spec = baseSpec();
		spec.nodes[1] = {
			...spec.nodes[1],
			metadata: ["not", "a", "map"] as unknown as { [key: string]: JsonValue },
		};
		expectInvalid(spec, /metadata must be an object/);
	});

	it("rejects empty tool call IDs and names", () => {
		for (const toolPair of [
			{ toolName: "read", callId: "", argsSnapshot: {} },
			{ toolName: "", callId: "call-1", argsSnapshot: {} },
		]) {
			const spec = baseSpec();
			spec.nodes[1] = { ...spec.nodes[1], toolPairs: [toolPair] };
			expectInvalid(spec, /must not be empty/);
		}
	});

	it("rejects duplicate call IDs in one assistant node", () => {
		const spec = baseSpec();
		spec.nodes[1] = {
			...spec.nodes[1],
			toolPairs: [
				{ toolName: "read", callId: "call-1", argsSnapshot: {} },
				{ toolName: "write", callId: "call-1", argsSnapshot: {} },
			],
		};
		expectInvalid(spec, /duplicate tool call ID call-1/);
	});

	it("rejects duplicate call IDs on one branch", () => {
		const spec = baseSpec();
		spec.nodes[1] = {
			...spec.nodes[1],
			toolPairs: [{ toolName: "read", callId: "call-1", argsSnapshot: {} }],
		};
		spec.nodes.push({
			id: "second-call",
			parentId: "answer",
			role: "assistant",
			content: "second",
			toolPairs: [{ toolName: "write", callId: "call-1", argsSnapshot: {} }],
		});
		spec.activeLeafId = "second-call";
		expectInvalid(spec, /duplicate tool call ID call-1/);
	});

	it("permits the same call ID on sibling branches", () => {
		const spec = baseSpec();
		spec.nodes[1] = {
			...spec.nodes[1],
			toolPairs: [{ toolName: "read", callId: "call-1", argsSnapshot: {} }],
		};
		spec.nodes.push({
			id: "sibling",
			parentId: "root",
			role: "assistant",
			content: "sibling",
			toolPairs: [{ toolName: "write", callId: "call-1", argsSnapshot: {} }],
		});
		expect(validateSessionSpec(spec).nodes).toHaveLength(3);
	});

	it("requires a result pair to match a preceding ancestor call", () => {
		const spec = baseSpec();
		spec.nodes.push({
			id: "result",
			parentId: "answer",
			role: "toolResult",
			content: "ok",
			toolPairs: [{ toolName: "read", callId: "call-1", argsSnapshot: {}, resultRef: { hash: "a".repeat(64) } }],
		});
		spec.activeLeafId = "result";
		expectInvalid(spec, /preceding tool call/);
	});

	it("rejects a toolResult node without tool pairs", () => {
		const spec = baseSpec();
		spec.nodes.push({ id: "result", parentId: "answer", role: "toolResult", content: "ok" });
		spec.activeLeafId = "result";
		expectInvalid(spec, /must have a tool pair/);
	});

	it("rejects an unmatched inline tool result pair", () => {
		const spec = baseSpec();
		spec.nodes.push({
			id: "result",
			parentId: "answer",
			role: "toolResult",
			content: "ok",
			toolPairs: [{ toolName: "read", callId: "missing", argsSnapshot: {} }],
		});
		spec.activeLeafId = "result";
		expectInvalid(spec, /preceding tool call/);
	});

	it("rejects a tool result from a sibling branch", () => {
		const spec = baseSpec();
		spec.nodes[1] = {
			...spec.nodes[1],
			toolPairs: [{ toolName: "read", callId: "call-1", argsSnapshot: {} }],
		};
		spec.nodes.push(
			{ id: "sibling", parentId: "root", role: "assistant", content: "other branch" },
			{
				id: "result",
				parentId: "sibling",
				role: "toolResult",
				content: "ok",
				toolPairs: [{ toolName: "read", callId: "call-1", argsSnapshot: {} }],
			},
		);
		spec.activeLeafId = "result";
		expectInvalid(spec, /preceding tool call/);
	});

	it("matches tool results to the same tool and verbatim call ID", () => {
		const spec = baseSpec();
		spec.nodes[1] = {
			...spec.nodes[1],
			toolPairs: [{ toolName: "read", callId: "call-1", argsSnapshot: {} }],
		};
		spec.nodes.push({
			id: "result",
			parentId: "answer",
			role: "toolResult",
			content: "ok",
			toolPairs: [{ toolName: "read", callId: "call-1", argsSnapshot: {}, resultRef: { hash: "a".repeat(64) } }],
		});
		spec.activeLeafId = "result";
		expect(validateSessionSpec(spec).nodes).toHaveLength(3);
	});

	it("accepts only the exact closed loss taxonomy", () => {
		expect(LOSS_CODES).toEqual([
			"missing_source_bytes",
			"unsupported_role",
			"thinking_demoted",
			"provider_payload_demoted",
			"blob_unavailable",
			"entry_metadata_unrepresentable",
		]);
		const ledger = LOSS_CODES.map(code => ({ code, detail: "recorded" }));
		expect(validateLossLedger(ledger)).toEqual(ledger);
		expect(() => validateLossLedger([...ledger, { code: "unknown" as LossCode }])).toThrow(/code/);
	});
});

describe("filesystem session CAS", () => {
	it("hashes bytes under the sha256 prefix layout", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "prime-session-cas-"));
		temporaryDirectories.push(root);
		const cas = new FileCas(root);
		const bytes = new TextEncoder().encode("hello");
		const ref = await cas.put(bytes);
		expect(ref.hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
		expect(cas.pathFor(ref.hash)).toBe(path.join(root, "cas", "sha256", ref.hash.slice(0, 2), ref.hash));
		expect(await Bun.file(cas.pathFor(ref.hash)).exists()).toBe(true);
	});

	it("verifies hashes on every read and rejects corruption", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "prime-session-cas-"));
		temporaryDirectories.push(root);
		const cas = new FileCas(root);
		const ref = await cas.put(new TextEncoder().encode("original"));
		await Bun.write(cas.pathFor(ref.hash), "corrupt");
		await expect(cas.read(ref)).rejects.toThrow(/hash verification/);
	});

	it("deduplicates identical bytes without replacing the existing blob", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "prime-session-cas-"));
		temporaryDirectories.push(root);
		const cas = new FileCas(root);
		const bytes = new TextEncoder().encode("same");
		const first = await cas.put(bytes);
		const fixedMtime = new Date("2020-01-02T03:04:05.000Z");
		await fs.utimes(cas.pathFor(first.hash), fixedMtime, fixedMtime);
		const firstStat = await fs.stat(cas.pathFor(first.hash));
		const second = await cas.put(bytes);
		const secondStat = await fs.stat(cas.pathFor(second.hash));
		expect(second).toEqual(first);
		expect(secondStat.ino).toBe(firstStat.ino);
		expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
	});

	it("publishes concurrent puts without exposing partial blobs", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "prime-session-cas-"));
		temporaryDirectories.push(root);
		const cas = new FileCas(root);
		const bytes = new TextEncoder().encode("concurrent");
		const refs = await Promise.all(Array.from({ length: 8 }, () => cas.put(bytes)));
		expect(new Set(refs.map(ref => ref.hash)).size).toBe(1);
		expect(await cas.read(refs[0])).toEqual(bytes);
	});
});

const _jsonValueTypeCheck: JsonValue = { nested: ["json", true, null] };
void _jsonValueTypeCheck;
