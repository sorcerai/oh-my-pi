import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileCas } from "./cas";
import type { SessionLoss } from "./loss-ledger";
import { createSessionManifest, findSessionManifest, manifestDigestMatches, writeSessionManifest } from "./manifest";
import { type OmpProjectImportOptions, type OmpProjectionResult, projectToOmp } from "./omp-projector";
import { readOmpSession } from "./omp-reader";
import { type ProjectToPrimeOptions, projectToPrime } from "./prime-projector";
import { readPrimeSession } from "./prime-reader";
import {
	collectCasRefs,
	createSessionReport,
	renderSessionReportHuman,
	renderSessionReportJson,
	type SessionHarness,
	type SessionReport,
} from "./report";
import type { SessionSpecV1 } from "./spec";

export type SessionOutputFormat = "human" | "json";
export type SessionLossPolicy = "allow" | "reject";

export interface SessionInspectOptions {
	readonly sourcePath: string;
	readonly sourceHarness?: SessionHarness;
	readonly format?: SessionOutputFormat;
}

export interface SessionConvertOptions {
	readonly sourcePath: string;
	readonly sourceHarness?: SessionHarness;
	readonly target: SessionHarness;
	readonly outputPath?: string;
	readonly activate?: boolean;
	readonly lossPolicy?: SessionLossPolicy;
	readonly format?: SessionOutputFormat;
}

export interface SessionCliIo {
	readonly writeOut?: (text: string) => void | Promise<void>;
	readonly writeErr?: (text: string) => void | Promise<void>;
}

export interface SessionConvertDependencies {
	readonly stateRoot?: string;
	readonly tempRoot?: string;
	readonly readPrime?: typeof readPrimeSession;
	readonly readOmp?: typeof readOmpSession;
	readonly projectPrime?: typeof projectToPrime;
	readonly projectOmp?: typeof projectToOmp;
	readonly makeCas?: (root: string) => FileCas;
	readonly exists?: (filePath: string) => Promise<boolean>;
	readonly rename?: typeof fs.rename;
	readonly remove?: (filePath: string) => Promise<void>;
	readonly syncDirectory?: (directory: string) => Promise<void>;
	readonly makeTempDirectory?: (parent: string, prefix: string) => Promise<string>;
	readonly checksum?: (bytes: Uint8Array) => string;
}

export interface SessionDetection {
	readonly harness: SessionHarness;
	readonly spec: SessionSpecV1;
	readonly causes: Readonly<Partial<Record<SessionHarness, string>>>;
}

export interface SessionCommandResult {
	readonly report: SessionReport;
	readonly text: string;
}

function defaultOutputPath(sourcePath: string, target: SessionHarness): string {
	return path.join(path.dirname(sourcePath), `${path.basename(sourcePath)}.${target}`);
}

function defaultChecksum(bytes: Uint8Array): string {
	return FileCas.hash(bytes);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function defaultTempDirectory(parent: string, prefix: string): Promise<string> {
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	return fs.mkdtemp(path.join(parent, prefix));
}

async function defaultRemove(filePath: string): Promise<void> {
	await fs.rm(filePath, { recursive: true, force: true });
}

async function detect(
	sourcePath: string,
	cas: FileCas,
	deps: SessionConvertDependencies,
	sourceHarness?: SessionHarness,
	trustedBridgeDigest?: string,
): Promise<SessionDetection> {
	const primeReader = deps.readPrime ?? readPrimeSession;
	const ompReader = deps.readOmp ?? readOmpSession;
	let prime: SessionSpecV1 | undefined;
	let omp: SessionSpecV1 | undefined;
	let primeCause = "not attempted";
	let ompCause = "not attempted";
	const readerOptions = trustedBridgeDigest === undefined ? undefined : { trustedBridgeDigest };
	if (sourceHarness === undefined || sourceHarness === "prime") {
		try {
			prime = await primeReader(sourcePath, cas, readerOptions);
		} catch (error) {
			primeCause = errorMessage(error);
		}
	}
	if (sourceHarness === undefined || sourceHarness === "omp") {
		try {
			omp = await ompReader(sourcePath, cas, readerOptions);
		} catch (error) {
			ompCause = errorMessage(error);
		}
	}
	if (sourceHarness !== undefined) {
		const spec = sourceHarness === "prime" ? prime : omp;
		if (spec === undefined)
			throw new Error(
				`Unable to read ${sourceHarness} session source ${sourcePath}; ${sourceHarness === "prime" ? primeCause : ompCause}`,
			);
		return {
			harness: sourceHarness,
			spec,
			causes:
				sourceHarness === "prime"
					? { prime: "success", omp: "not attempted" }
					: { prime: "not attempted", omp: "success" },
		};
	}
	if (prime !== undefined && omp !== undefined)
		throw new Error(`Ambiguous session source: both prime and omp readers succeeded for ${sourcePath}; use --from`);
	if (prime === undefined && omp === undefined)
		throw new Error(`Unable to detect session source ${sourcePath}; prime reader failed; omp reader failed`);

	return prime !== undefined
		? { harness: "prime", spec: prime, causes: { prime: "success", omp: ompCause } }
		: { harness: "omp", spec: omp!, causes: { prime: primeCause, omp: "success" } };
}
type SourceContext = {
	readonly cas: FileCas;
	readonly trustedBridgeDigest?: string;
};

async function resolveSourceContext(
	sourcePath: string,
	checksum: string,
	staging: string,
	deps: SessionConvertDependencies,
): Promise<SourceContext> {
	const makeCas = deps.makeCas ?? ((root: string) => new FileCas(root));
	const manifest = await findSessionManifest(sourcePath);
	if (manifest !== undefined && manifestDigestMatches(manifest.manifest, checksum))
		return {
			cas: makeCas(manifest.casRoot),
			trustedBridgeDigest: manifest.manifest.bridgeDigest,
		};
	return {
		cas: makeCas(path.join(staging, "cas")),
	};
}

async function copyCasReferences(source: FileCas, destination: FileCas, spec: SessionSpecV1): Promise<void> {
	if (source.root === destination.root) return;
	for (const reference of collectCasRefs(spec)) await destination.put(await source.read(reference));
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function publishCreateOnly(
	staging: string,
	finalPath: string,
	rename: typeof fs.rename,
	sync: (directory: string) => Promise<void>,
): Promise<void> {
	const parent = path.dirname(finalPath);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	const publishedName = `.${path.basename(finalPath)}.${Bun.randomUUIDv7()}.published`;
	const publishedPath = path.join(parent, publishedName);
	await rename(staging, publishedPath);
	let linked = false;
	try {
		await sync(publishedPath);
		await fs.symlink(publishedName, finalPath, "dir");
		linked = true;
		await sync(parent);
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		if (linked) {
			try {
				if ((await fs.readlink(finalPath)) === publishedName) await fs.unlink(finalPath);
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
		}
		try {
			await fs.rm(publishedPath, { recursive: true, force: true });
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		if (cleanupErrors.length > 0)
			throw new AggregateError([error, ...cleanupErrors], `Failed to publish and clean up output: ${finalPath}`);
		if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
			throw new Error(`Refusing to overwrite existing output: ${finalPath}`, { cause: error });
		throw error;
	}
}

function outputText(report: SessionReport, format: SessionOutputFormat): string {
	return format === "json" ? renderSessionReportJson(report) : renderSessionReportHuman(report);
}

export async function inspectSession(
	options: SessionInspectOptions,
	deps: SessionConvertDependencies = {},
): Promise<SessionCommandResult> {
	const sourceBytes = new Uint8Array(await Bun.file(options.sourcePath).arrayBuffer());
	const checksum = (deps.checksum ?? defaultChecksum)(sourceBytes);
	const tempParent = deps.tempRoot ?? path.join(path.dirname(options.sourcePath), ".omp-prime-bridge-tmp");
	const staging = await (deps.makeTempDirectory ?? defaultTempDirectory)(tempParent, "inspect-");
	try {
		const source = await resolveSourceContext(options.sourcePath, checksum, staging, deps);
		const detected = await detect(
			options.sourcePath,
			source.cas,
			deps,
			options.sourceHarness,
			source.trustedBridgeDigest,
		);
		const report = createSessionReport({
			operation: "inspect",
			sourcePath: options.sourcePath,
			sourceHarness: detected.harness,
			sourceNativePath: options.sourcePath,
			sourceChecksum: checksum,
			spec: detected.spec,
		});
		return { report, text: outputText(report, options.format ?? "human") };
	} finally {
		await (deps.remove ?? defaultRemove)(staging);
		if (deps.tempRoot === undefined && deps.makeTempDirectory === undefined)
			await fs.rmdir(tempParent).catch(error => {
				if (
					typeof error !== "object" ||
					error === null ||
					!("code" in error) ||
					(error.code !== "ENOENT" && error.code !== "ENOTEMPTY")
				)
					throw error;
			});
	}
}

function projectionLosses(spec: SessionSpecV1, losses: readonly SessionLoss[]): SessionLoss[] {
	const result: SessionLoss[] = [];
	const seen = new Set<string>();
	for (const loss of [...spec.lossLedger, ...losses]) {
		const key = JSON.stringify(loss);
		if (!seen.has(key)) {
			seen.add(key);
			result.push(loss);
		}
	}
	return result;
}
function fallbackLeafId(spec: SessionSpecV1): string | null {
	const parentIds = new Set(spec.nodes.map(node => node.parentId).filter((id): id is string => id !== null));
	return [...spec.nodes].reverse().find(node => !parentIds.has(node.id))?.id ?? null;
}

function destinationPath(staging: string, finalPath: string, nativePath: string): string {
	const relative = path.relative(staging, nativePath);
	return path.join(finalPath, relative);
}

export async function convertSession(
	options: SessionConvertOptions,
	deps: SessionConvertDependencies = {},
): Promise<SessionCommandResult> {
	if (options.target !== "prime" && options.target !== "omp")
		throw new Error(`Unsupported target harness: ${options.target}`);
	const sourceBytes = new Uint8Array(await Bun.file(options.sourcePath).arrayBuffer());
	const checksum = (deps.checksum ?? defaultChecksum)(sourceBytes);
	const finalPath = options.outputPath ?? defaultOutputPath(options.sourcePath, options.target);
	const tempParent = deps.tempRoot ?? path.join(path.dirname(finalPath), ".omp-prime-bridge-tmp");
	const staging = await (deps.makeTempDirectory ?? defaultTempDirectory)(tempParent, "convert-");
	try {
		const source = await resolveSourceContext(options.sourcePath, checksum, staging, deps);
		const detected = await detect(
			options.sourcePath,
			source.cas,
			deps,
			options.sourceHarness,
			source.trustedBridgeDigest,
		);
		const cas = (deps.makeCas ?? ((root: string) => new FileCas(root)))(path.join(staging, "cas"));
		await copyCasReferences(source.cas, cas, detected.spec);
		const defaultLeafId = fallbackLeafId(detected.spec);
		const projectionSpec: SessionSpecV1 = {
			...detected.spec,
			activeLeafId: options.activate === true ? (detected.spec.activeLeafId ?? defaultLeafId) : defaultLeafId,
		};
		let nativePath: string;
		let nativeIdMap: SessionSpecV1["nativeIdMap"] | undefined;
		let nativeActiveLeafId: string | null | undefined;
		let bridgeDigest: string | undefined;
		let losses: readonly SessionLoss[] = [];
		if (options.target === "prime") {
			const projector = deps.projectPrime ?? projectToPrime;
			const result = await projector(projectionSpec, {
				primeHome: staging,
				cas,
				now: "2000-01-01T00:00:00.000Z",
			} satisfies ProjectToPrimeOptions);
			nativePath = result.path;
			nativeIdMap = result.report.nativeIdMap;
			nativeActiveLeafId =
				projectionSpec.activeLeafId === null ? null : (nativeIdMap[projectionSpec.activeLeafId]?.prime ?? null);
			bridgeDigest = result.report.bridgeDigest;
			losses = result.report.losses;
		} else {
			const projector = deps.projectOmp ?? projectToOmp;
			const result: OmpProjectionResult = await projector(projectionSpec, {
				cwd: projectionSpec.header.cwd,
				cas,
				sessionDir: path.join(staging, "session"),
			} satisfies OmpProjectImportOptions);
			nativePath = result.path;
			nativeIdMap = result.report.nativeIdMap;
			nativeActiveLeafId =
				projectionSpec.activeLeafId === null ? null : (nativeIdMap[projectionSpec.activeLeafId]?.omp ?? null);
			bridgeDigest = result.report.bridgeDigest;
			losses = result.report.losses;
		}
		const allLosses = projectionLosses(detected.spec, losses);
		if ((options.lossPolicy ?? "allow") === "reject" && allLosses.length > 0)
			throw new Error(`Conversion rejected by loss policy: ${JSON.stringify(allLosses)}`);
		if (bridgeDigest === undefined) throw new Error("Conversion projector did not return a bridge digest");
		const nativeBytes = new Uint8Array(await Bun.file(nativePath).arrayBuffer());
		const nativeDigest = (deps.checksum ?? defaultChecksum)(nativeBytes);
		const nativeRelativePath = path.relative(staging, nativePath);
		await writeSessionManifest(
			staging,
			createSessionManifest({
				harness: options.target,
				nativePath: nativeRelativePath,
				nativeDigest,
				bridgeDigest,
				casPath: "cas",
			}),
		);
		await publishCreateOnly(staging, finalPath, deps.rename ?? fs.rename, deps.syncDirectory ?? syncDirectory);
		const report = createSessionReport({
			operation: "convert",
			sourcePath: options.sourcePath,
			sourceHarness: detected.harness,
			targetHarness: options.target,
			sourceNativePath: options.sourcePath,
			nativeDestinationPath: destinationPath(staging, finalPath, nativePath),
			outputPath: finalPath,
			sourceChecksum: checksum,
			spec: detected.spec,
			losses: allLosses,
			nativeIdMap,
			nativeActiveLeafId,
			bridgeDigest,
			activated: options.activate === true && nativeActiveLeafId !== null && nativeActiveLeafId !== undefined,
		});
		return { report, text: outputText(report, options.format ?? "human") };
	} catch (error) {
		await (deps.remove ?? defaultRemove)(staging);
		throw error;
	} finally {
		if (deps.tempRoot === undefined && deps.makeTempDirectory === undefined)
			await fs.rmdir(tempParent).catch(error => {
				if (
					typeof error !== "object" ||
					error === null ||
					!("code" in error) ||
					(error.code !== "ENOENT" && error.code !== "ENOTEMPTY")
				)
					throw error;
			});
	}
}
function parseSourceHarness(value: string | undefined): SessionHarness | undefined {
	if (value === undefined) return undefined;
	if (value !== "prime" && value !== "omp") throw new Error("--from must be prime or omp");
	return value;
}

function parseTarget(value: string | undefined): SessionHarness {
	if (value !== "prime" && value !== "omp") throw new Error("--to must be prime or omp");
	return value;
}

function parseLossPolicy(value: string | undefined): SessionLossPolicy {
	if (value === undefined || value === "allow") return "allow";
	if (value === "reject") return "reject";
	throw new Error("--loss-policy must be allow or reject");
}

export async function runSessionCommand(
	argv: readonly string[],
	deps: SessionConvertDependencies & SessionCliIo = {},
): Promise<SessionCommandResult> {
	if (argv[0] !== "session") throw new Error("Expected session command");
	const operation = argv[1];
	const sourcePath = argv[2];
	if ((operation !== "inspect" && operation !== "convert") || sourcePath === undefined)
		throw new Error(
			"Usage: session inspect <path> [--from prime|omp] | session convert <path> --to prime|omp [--from prime|omp] [--output <dir>] [--activate] [--loss-policy allow|reject]",
		);
	const format: SessionOutputFormat = argv.includes("--json") ? "json" : "human";
	const value = (name: string): string | undefined => {
		const index = argv.indexOf(name);
		if (index < 0) return undefined;
		const result = argv[index + 1];
		if (result === undefined || result.startsWith("--")) throw new Error(`${name} requires a value`);
		return result;
	};
	const sourceHarness = parseSourceHarness(value("--from"));
	const result =
		operation === "inspect"
			? await inspectSession({ sourcePath, sourceHarness, format }, deps)
			: await convertSession(
					{
						sourcePath,
						sourceHarness,
						target: parseTarget(value("--to")),
						outputPath: value("--output"),
						activate: argv.includes("--activate"),
						lossPolicy: parseLossPolicy(value("--loss-policy")),
						format,
					},
					deps,
				);
	await deps.writeOut?.(`${result.text}\n`);
	return result;
}
