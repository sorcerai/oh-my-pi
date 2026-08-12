import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetDirsFromEnvForTests, getBlobsDir, setAgentDir } from "@oh-my-pi/pi-utils";
import {
	MemorySessionStorage,
	SessionManager,
	type SessionTreeImportEntry,
	type SessionTreeImportNode,
} from "../src/index.js";
import { assistantMsg, userMsg } from "./utilities.js";

type ImportedSessionEntry = SessionTreeImportEntry;

function message(text: string, role: "user" | "assistant" = "user"): ImportedSessionEntry {
	return { type: "message", message: role === "assistant" ? assistantMsg(text) : userMsg(text) };
}

function node(sourceId: string, parentSourceId: string | null, entry: ImportedSessionEntry): SessionTreeImportNode {
	return { sourceId, parentSourceId, entry };
}

function branchedNodes(): SessionTreeImportNode[] {
	// Deliberately not topological. The importer must validate the complete graph,
	// then append each parent before its children through native SessionManager APIs.
	return [
		node("branch-b-leaf", "branch-b", message("branch b response", "assistant")),
		node("branch-a", "root", message("branch a")),
		node("root", null, message("root")),
		node("branch-b", "root", message("branch b")),
		node("branch-a-leaf", "branch-a", message("branch a response", "assistant")),
	];
}

function createImportStorage(): { cwd: string; sessionDir: string } {
	const cwd = mkdtempSync(join(tmpdir(), "session-import-api-"));
	return { cwd, sessionDir: join(cwd, "sessions") };
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

describe("SessionManager.importTree", () => {
	it("imports a full branched tree in topological parent order and returns every canonical-to-native ID", async () => {
		const { cwd, sessionDir } = createImportStorage();
		try {
			const nodes = branchedNodes();
			const result = await SessionManager.importTree(cwd, nodes, "branch-b-leaf", { sessionDir });
			const imported = await SessionManager.open(result.sessionPath, sessionDir);

			expect(Object.keys(result.nativeIdMap).sort()).toEqual(nodes.map(entry => entry.sourceId).sort());
			const importedIds = new Set(Object.values(result.nativeIdMap));
			expect(importedIds.size).toBe(nodes.length);

			const entries = imported.getEntries();
			const seen = new Set<string>();
			for (const canonicalNode of nodes) {
				const nativeId = result.nativeIdMap[canonicalNode.sourceId];
				const importedEntry = imported.getEntry(nativeId);
				expect(importedEntry).toBeDefined();
				expect(importedEntry?.parentId).toBe(
					canonicalNode.parentSourceId === null ? null : result.nativeIdMap[canonicalNode.parentSourceId],
				);
			}

			for (const entry of entries.filter(candidate => importedIds.has(candidate.id))) {
				if (entry.parentId !== null) {
					expect(seen.has(entry.parentId)).toBe(true);
				}
				seen.add(entry.id);
			}
			expect(seen).toEqual(importedIds);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("selects the requested active leaf, applies the existing title mechanism, and persists a hidden loss marker", async () => {
		const { cwd, sessionDir } = createImportStorage();
		try {
			const result = await SessionManager.importTree(cwd, branchedNodes(), "branch-b-leaf", {
				sessionDir,
				title: "  Imported branch tree  ",
				lossMarker: {
					customType: "omp.import.loss",
					data: { dropped: ["unsupported-tool-call"] },
				},
			});
			const imported = await SessionManager.open(result.sessionPath, sessionDir);

			expect(imported.getSessionName()).toBe("Imported branch tree");
			expect(imported.getEntries().some(entry => entry.type === "title_change")).toBe(false);
			expect(imported.getLeafId()).toBe(result.nativeIdMap["branch-b-leaf"]);
			expect(imported.getBranch().map(entry => entry.id)).toEqual([
				result.nativeIdMap.root,
				result.nativeIdMap["branch-b"],
				result.nativeIdMap["branch-b-leaf"],
			]);

			const markers = imported
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === "omp.import.loss");
			expect(markers).toHaveLength(1);
			expect(markers[0]).toMatchObject({
				type: "custom",
				customType: "omp.import.loss",
				data: { dropped: ["unsupported-tool-call"] },
			});
			expect(imported.getBranch().some(entry => entry.id === markers[0].id)).toBe(false);
			const persistedSeen = new Set<string>();
			for (const entry of imported.getEntries()) {
				if (entry.parentId !== null) expect(persistedSeen.has(entry.parentId)).toBe(true);
				persistedSeen.add(entry.id);
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("builds generated metadata from the complete native ID map and supports a root active leaf", async () => {
		const { cwd, sessionDir } = createImportStorage();
		try {
			const result = await SessionManager.importTree(cwd, [node("root", null, message("root"))], "root", {
				sessionDir,
				lossMarkerFactory: nativeIdMap => ({
					customType: "omp.import.generated",
					data: { nativeIdMap },
				}),
			});
			const imported = await SessionManager.open(result.sessionPath, sessionDir);
			const entries = imported.getEntries();
			const marker = entries.find(entry => entry.type === "custom" && entry.customType === "omp.import.generated");
			if (marker?.type !== "custom") throw new Error("Expected generated import metadata");
			expect(marker.data).toEqual({ nativeIdMap: result.nativeIdMap });
			expect(imported.getEntry(result.nativeIdMap.root)?.parentId).toBe(marker.id);
			expect(imported.getLeafId()).toBe(result.nativeIdMap.root);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects simultaneous static and generated loss markers", async () => {
		const { cwd, sessionDir } = createImportStorage();
		try {
			await expect(
				SessionManager.importTree(cwd, [node("root", null, message("root"))], "root", {
					sessionDir,
					lossMarker: { customType: "static", data: {} },
					lossMarkerFactory: () => ({ customType: "generated", data: {} }),
				}),
			).rejects.toThrow(/only one loss marker source/);
			expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects a missing parent without creating a partial imported session", async () => {
		const { cwd, sessionDir } = createImportStorage();
		try {
			const nodes = [
				node("root", null, message("root")),
				node("orphan", "missing-parent", message("orphan", "assistant")),
			];

			await expect(SessionManager.importTree(cwd, nodes, "orphan", { sessionDir })).rejects.toThrow();
			expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects an invalid parent reference without creating a partial imported session", async () => {
		const { cwd, sessionDir } = createImportStorage();
		try {
			const nodes = [
				node("root", null, message("root")),
				{
					sourceId: "invalid-parent",
					parentSourceId: 42 as unknown as string,
					entry: message("invalid parent", "assistant"),
				},
			];

			await expect(SessionManager.importTree(cwd, nodes, "invalid-parent", { sessionDir })).rejects.toThrow();
			expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects a cyclic parent graph without creating a partial imported session", async () => {
		const { cwd, sessionDir } = createImportStorage();
		try {
			const nodes = [
				node("cycle-a", "cycle-b", message("cycle a")),
				node("cycle-b", "cycle-a", message("cycle b", "assistant")),
			];

			await expect(SessionManager.importTree(cwd, nodes, "cycle-b", { sessionDir })).rejects.toThrow();
			expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects an invalid active leaf without creating a partial imported session", async () => {
		const { cwd, sessionDir } = createImportStorage();
		try {
			await expect(
				SessionManager.importTree(cwd, branchedNodes(), "does-not-exist", { sessionDir }),
			).rejects.toThrow();
			expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("maps compaction firstKeptEntryId to the native ancestor id and reopens it correctly", async () => {
		const { cwd, sessionDir } = createImportStorage();
		try {
			const nodes: SessionTreeImportNode[] = [
				node("root", null, message("root")),
				node("compaction", "root", {
					type: "compaction",
					summary: "compact",
					firstKeptEntryId: "root",
					tokensBefore: 10,
				}),
			];
			const result = await SessionManager.importTree(cwd, nodes, "compaction", { sessionDir });
			const imported = await SessionManager.open(result.sessionPath, sessionDir);
			const compaction = imported.getEntry(result.nativeIdMap.compaction);
			if (compaction?.type !== "compaction") throw new Error("Expected imported compaction entry");
			expect(compaction.firstKeptEntryId).toBe(result.nativeIdMap.root);
			expect(imported.getLeafId()).toBe(result.nativeIdMap.compaction);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects a compaction firstKeptEntryId that is not an ancestor", async () => {
		const { cwd, sessionDir } = createImportStorage();
		try {
			const nodes: SessionTreeImportNode[] = [
				node("root", null, message("root")),
				node("other", "root", message("other")),
				node("sibling", "root", message("sibling")),
				node("compaction", "other", {
					type: "compaction",
					summary: "compact",
					firstKeptEntryId: "sibling",
					tokensBefore: 10,
				}),
			];
			await expect(SessionManager.importTree(cwd, nodes, "compaction", { sessionDir })).rejects.toThrow();
			expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not list a session when final create-only publication fails", async () => {
		const { cwd, sessionDir } = createImportStorage();
		const storage = new MemorySessionStorage();
		storage.writeTextCreateOnly = async () => {
			throw new Error("injected publication failure");
		};
		try {
			await expect(
				SessionManager.importTree(cwd, [node("root", null, message("root"))], "root", { sessionDir, storage }),
			).rejects.toThrow("injected publication failure");
			expect(await SessionManager.list(cwd, sessionDir, storage)).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
	it("cleans the staged session when pre-publication validation fails", async () => {
		const { cwd, sessionDir } = createImportStorage();
		const storage = new MemorySessionStorage();
		try {
			await expect(
				SessionManager.importTree(cwd, [node("root", null, message("root"))], "root", {
					sessionDir,
					storage,
					validateBeforePublish: async () => {
						throw new Error("injected validation failure");
					},
				}),
			).rejects.toThrow("injected validation failure");
			expect(storage.listFilesSync(sessionDir, "*")).toEqual([]);
			expect(storage.listFilesSync(sessionDir, ".*.tmp")).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not overwrite a destination created during staged publication", async () => {
		const { cwd, sessionDir } = createImportStorage();
		const storage = new MemorySessionStorage();
		let destinationPath: string | undefined;
		const publishCreateOnly = storage.publishCreateOnly.bind(storage);
		storage.publishCreateOnly = async (stagedPath, destination) => {
			destinationPath = destination;
			await storage.writeTextCreateOnly(destination, "destination-race");
			await publishCreateOnly(stagedPath, destination);
		};
		try {
			await expect(
				SessionManager.importTree(cwd, [node("root", null, message("root"))], "root", {
					sessionDir,
					storage,
				}),
			).rejects.toMatchObject({ code: "EEXIST" });
			expect(destinationPath).toBeDefined();
			expect(await storage.readText(destinationPath!)).toBe("destination-race");
			expect(storage.listFilesSync(sessionDir, ".*.tmp")).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("publishes a validated session without leaving a staged temporary file", async () => {
		const { cwd, sessionDir } = createImportStorage();
		const storage = new MemorySessionStorage();
		try {
			const result = await SessionManager.importTree(cwd, [node("root", null, message("root"))], "root", {
				sessionDir,
				storage,
			});
			expect(storage.listFilesSync(sessionDir, ".*.tmp")).toEqual([]);
			expect(storage.listFilesSync(sessionDir, "*.jsonl")).toEqual([result.sessionPath]);
			expect(await storage.readText(result.sessionPath)).toContain('"type":"session"');
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("installs hash-verified blob bytes before staged validation and publication", async () => {
		const { cwd, sessionDir } = createImportStorage();
		const restoreAgentDir = isolateAgentDir(join(cwd, "agent"));
		const blobBytes = Buffer.from(`session-import-blob-${crypto.randomUUID()}`);
		const hash = new Bun.SHA256().update(blobBytes).digest("hex");
		const blobPath = join(getBlobsDir(), hash);
		try {
			const result = await SessionManager.importTree(
				cwd,
				[
					node("root", null, {
						type: "message",
						message: {
							role: "user",
							content: [{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }],
							timestamp: Date.now(),
						},
					}),
				],
				"root",
				{
					sessionDir,
					blobs: [{ hash, bytes: blobBytes }],
					validateBeforePublish: async (stagedPath, nativeIdMap) => {
						expect(Buffer.from(await Bun.file(blobPath).arrayBuffer())).toEqual(blobBytes);
						const staged = await SessionManager.open(stagedPath, sessionDir);
						try {
							const entry = staged.getEntry(nativeIdMap.root);
							if (entry?.type !== "message" || entry.message.role !== "user")
								throw new Error("Expected imported user image");
							expect(entry.message.content).toEqual([
								{ type: "image", data: blobBytes.toString("base64"), mimeType: "image/png" },
							]);
						} finally {
							await staged.close();
						}
					},
				},
			);

			expect(await Bun.file(result.sessionPath).exists()).toBe(true);
			expect(Buffer.from(await Bun.file(blobPath).arrayBuffer())).toEqual(blobBytes);
		} finally {
			restoreAgentDir();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects corrupt declared blob bytes without publishing a session", async () => {
		const { cwd, sessionDir } = createImportStorage();
		const restoreAgentDir = isolateAgentDir(join(cwd, "agent"));
		const declaredBytes = Buffer.from(`session-import-declared-${crypto.randomUUID()}`);
		const hash = new Bun.SHA256().update(declaredBytes).digest("hex");
		const blobPath = join(getBlobsDir(), hash);
		try {
			await expect(
				SessionManager.importTree(cwd, [node("root", null, message("root"))], "root", {
					sessionDir,
					blobs: [{ hash, bytes: Buffer.from("corrupt") }],
				}),
			).rejects.toThrow(/blob hash verification failed/);
			expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
			expect(await Bun.file(blobPath).exists()).toBe(false);
		} finally {
			restoreAgentDir();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("surfaces cleanup failure together with the publication failure", async () => {
		const { cwd, sessionDir } = createImportStorage();
		const storage = new MemorySessionStorage();
		storage.writeTextCreateOnly = async () => {
			throw new Error("injected publication failure");
		};
		storage.deleteSessionWithArtifacts = async () => {
			throw new Error("injected cleanup failure");
		};
		try {
			const error = await SessionManager.importTree(cwd, [node("root", null, message("root"))], "root", {
				sessionDir,
				storage,
			}).catch(error => error);
			expect(error).toBeInstanceOf(AggregateError);
			expect(String(error)).toContain("cleanup was incomplete");
			expect((error as AggregateError).errors).toHaveLength(2);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("accepts every declared native runtime message role", async () => {
		const { cwd, sessionDir } = createImportStorage();
		try {
			const timestamp = Date.now();
			const messages: SessionTreeImportEntry[] = [
				message("user"),
				{ type: "message", message: { ...assistantMsg("assistant"), timestamp } },
				{ type: "message", message: { role: "developer", content: "developer", timestamp } },
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "call",
						toolName: "tool",
						content: [],
						isError: false,
						timestamp,
					},
				},
				{
					type: "message",
					message: {
						role: "bashExecution",
						command: "echo",
						output: "",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						timestamp,
					},
				},
				{
					type: "message",
					message: {
						role: "pythonExecution",
						code: "1",
						output: "",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						timestamp,
					},
				},
				{
					type: "message",
					message: { role: "custom", customType: "x", content: "custom", display: true, timestamp },
				},
				{
					type: "message",
					message: { role: "hookMessage", customType: "x", content: "hook", display: true, timestamp },
				},
				{ type: "message", message: { role: "fileMention", files: [], timestamp } },
			];
			const nodes = messages.map((entry, index) =>
				node(`message-${index}`, index === 0 ? null : `message-${index - 1}`, entry),
			);
			const result = await SessionManager.importTree(cwd, nodes, "message-8", { sessionDir });
			expect(Object.keys(result.nativeIdMap)).toHaveLength(messages.length);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects summary and unknown runtime message roles", async () => {
		const { cwd, sessionDir } = createImportStorage();
		try {
			for (const role of ["branchSummary", "compactionSummary", "unknown"]) {
				const nodes = [
					node("root", null, message("root")),
					node("bad", "root", {
						type: "message",
						message: { role, summary: "not a runtime message", timestamp: Date.now() },
					} as unknown as SessionTreeImportEntry),
				];
				await expect(SessionManager.importTree(cwd, nodes, "bad", { sessionDir })).rejects.toThrow();
				expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
