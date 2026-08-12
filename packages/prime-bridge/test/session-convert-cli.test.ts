import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileCas } from "../src/session/cas";
import { convertSession, inspectSession, runSessionCommand } from "../src/session/convert";
import { findSessionManifest, SESSION_MANIFEST_FILENAME } from "../src/session/manifest";
import { readPrimeSession } from "../src/session/prime-reader";
import { collectCasRefs } from "../src/session/report";
import type { SessionSpecV1 } from "../src/session/spec";

const primeFixture = path.join(import.meta.dir, "fixtures", "sessions", "prime-v3.jsonl");
const ompFixture = path.join(import.meta.dir, "fixtures", "sessions", "omp-v3.jsonl");
const temporaryDirectories: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-convert-"));
	temporaryDirectories.push(root);
	return root;
}

async function copyFixture(source: string, root: string): Promise<string> {
	const destination = path.join(root, path.basename(source));
	await fs.copyFile(source, destination);
	return destination;
}

function minimalSpec(): SessionSpecV1 {
	return {
		specVersion: 1,
		header: {
			originHarness: "prime",
			sourceSessionId: "source-session",
			title: "Source",
			cwd: "/repo",
			createdAt: "2026-08-12T00:00:00.000Z",
			sourceSchema: "prime-session-v3",
		},
		nodes: [{ id: "root", parentId: null, role: "user", content: "hello" }],
		activeLeafId: "root",
		nativeIdMap: { root: { prime: "native-root" } },
		lossLedger: [],
	};
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("session conversion CLI", () => {
	it("detects Prime and OMP sources with strict readers and emits complete JSON reports", async () => {
		const root = await makeRoot();
		for (const [fixture, harness] of [
			[primeFixture, "prime"],
			[ompFixture, "omp"],
		] as const) {
			const sourcePath = await copyFixture(fixture, root);
			const result = await inspectSession({ sourcePath, format: "json" });
			const report = JSON.parse(result.text) as Record<string, unknown>;
			expect(report.sourceHarness).toBe(harness);
			expect(report.operation).toBe("inspect");
			expect(report.sourceChecksum).toMatch(/^[0-9a-f]{64}$/);
			expect(report.canonicalBranchCount).toBeGreaterThan(0);
			expect(report.canonicalNodeCount).toBeGreaterThan(0);
			expect(Array.isArray(report.casRefs)).toBe(true);
			expect(Array.isArray(report.losses)).toBe(true);
			await expect(fs.stat(path.join(root, ".omp-prime-bridge-tmp"))).rejects.toMatchObject({ code: "ENOENT" });
		}
	});

	it("requires --from whenever both strict readers accept the source", async () => {
		const root = await makeRoot();
		const spec = minimalSpec();
		const dependencies = {
			readPrime: async () => spec,
			readOmp: async () => spec,
		};
		for (const [name, harnessField] of [
			["prime-shaped", { rlmDepth: 0 }],
			["omp-shaped", { title: "OMP session" }],
		] as const) {
			const sourcePath = path.join(root, `${name}.jsonl`);
			await fs.writeFile(
				sourcePath,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: name,
					timestamp: "2026-08-12T00:00:00.000Z",
					cwd: "/repo",
					...harnessField,
				})}\n`,
			);
			await expect(inspectSession({ sourcePath }, dependencies)).rejects.toThrow(
				/Ambiguous session source: both prime and omp readers succeeded.*use --from/,
			);
		}
	});

	it("uses explicit --from to select one strict reader", async () => {
		const root = await makeRoot();
		const sourcePath = path.join(root, "ambiguous.jsonl");
		await fs.writeFile(sourcePath, "{}\n");
		const spec = minimalSpec();
		let primeReads = 0;
		let ompReads = 0;
		const dependencies = {
			readPrime: async () => {
				primeReads++;
				return spec;
			},
			readOmp: async () => {
				ompReads++;
				return spec;
			},
		};
		const prime = await runSessionCommand(["session", "inspect", sourcePath, "--from", "prime"], dependencies);
		const omp = await runSessionCommand(["session", "inspect", sourcePath, "--from", "omp"], dependencies);
		expect(prime.report.sourceHarness).toBe("prime");
		expect(omp.report.sourceHarness).toBe("omp");
		expect(primeReads).toBe(1);
		expect(ompReads).toBe(1);
	});

	it("reports both auto-detection failures without reader error content", async () => {
		const root = await makeRoot();
		const sourcePath = path.join(root, "invalid.jsonl");
		await fs.writeFile(sourcePath, "{}\n");
		const failure = inspectSession(
			{ sourcePath },
			{
				readPrime: async () => {
					throw new Error("prime parser included sensitive source content");
				},
				readOmp: async () => {
					throw new Error("omp parser included sensitive source content");
				},
			},
		);
		await expect(failure).rejects.toThrow(/prime reader failed; omp reader failed/);
		await expect(failure).rejects.not.toThrow(/sensitive source content/);
	});

	it("converts create-only, preserves source bytes, and reports the native destination", async () => {
		const root = await makeRoot();
		const sourcePath = await copyFixture(primeFixture, root);
		const before = await fs.readFile(sourcePath);
		const result = await convertSession({ sourcePath, target: "omp", format: "json" });
		const after = await fs.readFile(sourcePath);
		expect(await fs.readFile(path.join(result.report.outputPath!, SESSION_MANIFEST_FILENAME), "utf8")).toContain(
			result.report.bridgeDigest!,
		);
		expect(after).toEqual(before);
		expect(result.report.outputPath).toBe(`${sourcePath}.omp`);
		expect(result.report.nativeDestinationPath).toStartWith(`${sourcePath}.omp${path.sep}`);
		expect(await fs.stat(result.report.nativeDestinationPath!)).toBeDefined();
		expect(result.report.nativeNodeCount).toBe(result.report.canonicalNodeCount);
		expect(result.report.nativeBranchCount).toBe(result.report.canonicalBranchCount);
		expect(result.report.bridgeDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(result.report.activated).toBe(false);
		expect(result.report.nativeActiveLeafId).not.toBeNull();
		await expect(fs.stat(path.join(root, ".omp-prime-bridge-tmp"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(convertSession({ sourcePath, target: "omp" })).rejects.toThrow(/Refusing to overwrite/);
	});

	it("uses the canonical source cwd when projecting to OMP", async () => {
		const root = await makeRoot();
		const sourcePath = await copyFixture(primeFixture, root);
		const converted = await convertSession({ sourcePath, target: "omp" });
		const entries = Bun.JSONL.parse(await fs.readFile(converted.report.nativeDestinationPath!, "utf8")) as Array<
			Record<string, unknown>
		>;
		expect(entries.find(entry => entry.type === "session")?.cwd).toBe("/tmp/prime-project");
	});

	it("fails closed on a malformed session manifest and removes temporary state", async () => {
		const root = await makeRoot();
		const sourcePath = await copyFixture(primeFixture, root);
		await fs.writeFile(
			path.join(root, SESSION_MANIFEST_FILENAME),
			`${JSON.stringify({
				version: 2,
				harness: "prime",
				nativePath: path.basename(sourcePath),
				nativeDigest: "0".repeat(64),
				bridgeDigest: "1".repeat(64),
				casPath: "cas",
			})}\n`,
		);
		await expect(inspectSession({ sourcePath })).rejects.toThrow(/unsupported version/);
		await expect(fs.stat(path.join(root, ".omp-prime-bridge-tmp"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects a manifest whose CAS symlink escapes its destination", async () => {
		const root = await makeRoot();
		const destination = path.join(root, "destination");
		const outsideCas = path.join(root, "outside-cas");
		await Promise.all([fs.mkdir(destination), fs.mkdir(outsideCas)]);
		const sourcePath = await copyFixture(primeFixture, destination);
		await fs.symlink(outsideCas, path.join(destination, "cas"), "dir");
		await fs.writeFile(
			path.join(destination, SESSION_MANIFEST_FILENAME),
			`${JSON.stringify({
				version: 1,
				harness: "prime",
				nativePath: path.basename(sourcePath),
				nativeDigest: "0".repeat(64),
				bridgeDigest: "1".repeat(64),
				casPath: "cas",
			})}\n`,
		);
		await expect(findSessionManifest(sourcePath)).rejects.toThrow(/casPath must stay within its destination/);
	});
	it("preserves canonical IDs and historical CAS bytes across CLI A to B to A", async () => {
		const root = await makeRoot();
		const sourcePath = await copyFixture(primeFixture, root);
		const originalCas = new FileCas(path.join(root, "original-cas"));
		const original = await readPrimeSession(sourcePath, originalCas);
		const first = await convertSession({
			sourcePath,
			target: "omp",
			outputPath: path.join(root, "to-omp"),
		});
		const second = await convertSession({
			sourcePath: first.report.nativeDestinationPath!,
			target: "prime",
			outputPath: path.join(root, "to-prime"),
		});
		const finalCas = new FileCas(path.join(second.report.outputPath!, "cas"));
		const restored = await readPrimeSession(second.report.nativeDestinationPath!, finalCas, {
			trustedBridgeDigest: second.report.bridgeDigest,
		});
		expect(restored.nodes.map(node => [node.id, node.parentId])).toEqual(
			original.nodes.map(node => [node.id, node.parentId]),
		);
		expect(Object.keys(restored.nativeIdMap)).toEqual(Object.keys(original.nativeIdMap));
		for (const mapping of Object.values(restored.nativeIdMap)) {
			expect(mapping.prime).toBeString();
			expect(mapping.omp).toBeString();
		}
		for (const reference of collectCasRefs(original))
			expect(await finalCas.read(reference)).toEqual(await originalCas.read(reference));
	});

	it("does not trust a converted destination after native bytes are tampered", async () => {
		const root = await makeRoot();
		const sourcePath = await copyFixture(primeFixture, root);
		const converted = await convertSession({ sourcePath, target: "omp", outputPath: path.join(root, "converted") });
		const nativePath = converted.report.nativeDestinationPath!;
		const nativeText = await fs.readFile(nativePath, "utf8");
		await fs.writeFile(nativePath, `${nativeText}\n`);
		let trustedOptions: unknown;
		const spec = minimalSpec();
		await inspectSession(
			{ sourcePath: nativePath, sourceHarness: "omp" },
			{
				readPrime: async () => {
					throw new Error("not prime");
				},
				readOmp: async (_path, _cas, options) => {
					trustedOptions = options;
					return spec;
				},
			},
		);
		expect(trustedOptions).toBeUndefined();
	});

	it("does not overwrite a competing destination", async () => {
		const root = await makeRoot();
		const sourcePath = await copyFixture(primeFixture, root);
		const outputPath = path.join(root, "competing");
		await fs.mkdir(outputPath);
		const sentinel = path.join(outputPath, "sentinel");
		await fs.writeFile(sentinel, "owner-b");
		await expect(convertSession({ sourcePath, target: "omp", outputPath })).rejects.toThrow(/Refusing to overwrite/);
		expect(await fs.readFile(sentinel, "utf8")).toBe("owner-b");
	});

	it("removes a published output if the durability sync fails", async () => {
		const root = await makeRoot();
		const sourcePath = await copyFixture(primeFixture, root);
		const outputPath = path.join(root, "sync-failed");
		let syncCalls = 0;
		await expect(
			convertSession(
				{ sourcePath, target: "omp", outputPath },
				{
					syncDirectory: async () => {
						syncCalls += 1;
						if (syncCalls === 2) throw new Error("injected parent sync failure");
					},
				},
			),
		).rejects.toThrow(/injected parent sync failure/);
		await expect(fs.lstat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.readdir(root)).some(name => name.endsWith(".published"))).toBe(false);
		await expect(convertSession({ sourcePath, target: "omp", outputPath })).resolves.toBeDefined();
	});

	it("fails closed when a trusted Prime bridge CAS reference is missing", async () => {
		const root = await makeRoot();
		const sourcePath = await copyFixture(ompFixture, root);
		const converted = await convertSession({
			sourcePath,
			target: "prime",
			outputPath: path.join(root, "converted-prime"),
		});
		const cas = new FileCas(path.join(converted.report.outputPath!, "cas"));
		const restored = await readPrimeSession(converted.report.nativeDestinationPath!, cas, {
			trustedBridgeDigest: converted.report.bridgeDigest,
		});
		const reference = collectCasRefs(restored)[0];
		expect(reference).toBeDefined();
		await fs.unlink(cas.pathFor(reference!.hash));
		await expect(
			readPrimeSession(converted.report.nativeDestinationPath!, cas, {
				trustedBridgeDigest: converted.report.bridgeDigest,
			}),
		).rejects.toThrow(/CAS reference is unavailable/);
	});

	it("rejects recorded losses before publishing an output", async () => {
		const root = await makeRoot();
		const outputPath = path.join(root, "rejected-prime");
		await expect(
			convertSession(
				{ sourcePath: primeFixture, target: "prime", outputPath, lossPolicy: "reject" },
				{
					readPrime: async (sourcePath, cas, options) => {
						const spec = await readPrimeSession(sourcePath, cas, options);
						return {
							...spec,
							lossLedger: [...spec.lossLedger, { code: "entry_metadata_unrepresentable", detail: "test loss" }],
						};
					},
					readOmp: async () => {
						throw new Error("not omp");
					},
				},
			),
		).rejects.toThrow(/Conversion rejected by loss policy/);
		await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("selects the source active leaf only when activation is requested", async () => {
		const root = await makeRoot();
		const outputPath = path.join(root, "activated-omp");
		const result = await convertSession({
			sourcePath: primeFixture,
			target: "omp",
			outputPath,
			activate: true,
		});
		expect(result.report.activated).toBe(true);
		expect(result.report.activeLeafId).not.toBeNull();
		expect(result.report.nativeActiveLeafId).not.toBeNull();
	});

	it("parses JSON CLI output and returns a nonzero process status for invalid input", async () => {
		let output = "";
		const inspected = await runSessionCommand(["session", "inspect", primeFixture, "--json"], {
			writeOut: text => {
				output += text;
			},
		});
		expect(JSON.parse(output)).toEqual(inspected.report);

		const cli = path.join(import.meta.dir, "..", "src", "cli.ts");
		const child = Bun.spawn(
			[process.execPath, cli, "session", "inspect", path.join(import.meta.dir, "missing.jsonl")],
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("Prime bridge session command failed");
	});
});
