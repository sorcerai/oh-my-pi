import { readFileSync } from "node:fs";
import type { SessionLoss } from "./loss-ledger";
import type { CasRef, SessionSpecV1 } from "./spec";

export type SessionHarness = "prime" | "omp";
export type SessionReportOperation = "inspect" | "convert";

export interface SessionReport {
	readonly operation: SessionReportOperation;
	readonly sourcePath: string;
	readonly sourceHarness: SessionHarness;
	readonly targetHarness: SessionHarness | null;
	readonly sourceNativePath: string;
	readonly nativeDestinationPath: string | null;
	readonly outputPath: string | null;
	readonly sourceChecksum: string;
	readonly losses: readonly SessionLoss[];
	readonly casRefs: readonly CasRef[];
	readonly canonicalBranchCount: number;
	readonly nativeBranchCount: number;
	readonly canonicalNodeCount: number;
	readonly nativeNodeCount: number;
	readonly activeLeaf: string | null;
	readonly activeLeafId: string | null;
	readonly nativeActiveLeafId: string | null;
	readonly bridgeDigest?: string;
	readonly activated: boolean;
}

function isCasRef(value: unknown): value is CasRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
	if (typeof record.hash !== "string" || !/^[0-9a-f]{64}$/.test(record.hash)) return false;
	if (record.byteLength === undefined) return true;
	return typeof record.byteLength === "number" && Number.isSafeInteger(record.byteLength) && record.byteLength >= 0;
}

function copyRef(ref: CasRef): CasRef {
	return ref.byteLength === undefined ? { hash: ref.hash } : { hash: ref.hash, byteLength: ref.byteLength };
}

export function collectCasRefs(spec: SessionSpecV1): CasRef[] {
	const refs = new Map<string, CasRef>();
	const add = (value: unknown): void => {
		if (!isCasRef(value)) return;
		const key = `${value.hash}:${value.byteLength ?? ""}`;
		if (!refs.has(key)) refs.set(key, copyRef(value));
	};
	add(spec.header.sourceRef);
	for (const node of spec.nodes) {
		add(node.thinkingRef);
		add(node.providerPayloadRef);
		const metadata = node.metadata;
		if (metadata !== undefined) {
			for (const key of ["sourceLineRef", "sourceMessageRef", "titleSlotRef"] as const) add(metadata[key]);
			if (Array.isArray(metadata.thinkingRefs)) for (const ref of metadata.thinkingRefs) add(ref);
		}
		for (const pair of node.toolPairs ?? []) {
			add(pair.originalCallRef);
			add(pair.synthesizedCallRef);
			add(pair.resultRef);
		}
	}
	return [...refs.values()].sort((left, right) => left.hash.localeCompare(right.hash));
}

export function countSessionLeaves(spec: SessionSpecV1): number {
	const parents = new Set(spec.nodes.map(node => node.parentId).filter((id): id is string => id !== null));
	return spec.nodes.filter(node => !parents.has(node.id)).length;
}

function countValidatedNativeDestination(path: string): { readonly nodes: number; readonly leaves: number } {
	const records = readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as Record<string, unknown>);
	const titleSlot = records[0]?.type === "title" && records[0]?.v === 1;
	const headerIndex = titleSlot ? 1 : 0;
	if (records[headerIndex]?.type !== "session")
		throw new Error(`Native session destination has no session header: ${path}`);
	const entries = records.slice(headerIndex + 1).filter(entry => entry.customType !== "prime-bridge/session-resume");
	const parents = new Set(
		entries.map(entry => entry.parentId).filter((parentId): parentId is string => typeof parentId === "string"),
	);
	return {
		nodes: entries.length,
		leaves: entries.filter(entry => typeof entry.id === "string" && !parents.has(entry.id)).length,
	};
}
export interface SessionReportInput {
	readonly operation: SessionReportOperation;
	readonly sourcePath: string;
	readonly sourceHarness: SessionHarness;
	readonly targetHarness?: SessionHarness;
	readonly sourceNativePath?: string;
	readonly nativeDestinationPath?: string;
	readonly outputPath?: string;
	readonly sourceChecksum: string;
	readonly spec: SessionSpecV1;
	readonly losses?: readonly SessionLoss[];
	readonly nativeIdMap?: SessionSpecV1["nativeIdMap"];
	readonly nativeActiveLeafId?: string | null;
	readonly bridgeDigest?: string;
	readonly activated?: boolean;
}

export function createSessionReport(input: SessionReportInput): SessionReport {
	const canonicalBranchCount = countSessionLeaves(input.spec);
	const nativeDestination =
		input.nativeDestinationPath === undefined
			? undefined
			: countValidatedNativeDestination(input.nativeDestinationPath);
	const nativeNodeCount =
		nativeDestination?.nodes ??
		(input.nativeIdMap === undefined ? input.spec.nodes.length : Object.keys(input.nativeIdMap).length);
	const nativeBranchCount = nativeDestination?.leaves ?? canonicalBranchCount;
	return {
		operation: input.operation,
		sourcePath: input.sourcePath,
		sourceHarness: input.sourceHarness,
		targetHarness: input.targetHarness ?? null,
		sourceNativePath: input.sourceNativePath ?? input.sourcePath,
		nativeDestinationPath: input.nativeDestinationPath ?? null,
		outputPath: input.outputPath ?? null,
		sourceChecksum: input.sourceChecksum,
		losses: [...(input.losses ?? input.spec.lossLedger)],
		casRefs: collectCasRefs(input.spec),
		canonicalBranchCount,
		nativeBranchCount,
		canonicalNodeCount: input.spec.nodes.length,
		nativeNodeCount,
		activeLeaf: input.spec.activeLeafId,
		activeLeafId: input.spec.activeLeafId,
		nativeActiveLeafId: input.nativeActiveLeafId ?? input.spec.activeLeafId,
		...(input.bridgeDigest === undefined ? {} : { bridgeDigest: input.bridgeDigest }),
		activated: input.activated ?? false,
	};
}

export function renderSessionReportJson(report: SessionReport): string {
	return JSON.stringify(report);
}

export function renderSessionReportHuman(report: SessionReport): string {
	const lines = [
		`operation: ${report.operation}`,
		`source: ${report.sourceHarness} ${report.sourcePath}`,
		`target: ${report.targetHarness ?? "none"}`,
		`native destination: ${report.nativeDestinationPath ?? "none"}`,
		`output: ${report.outputPath ?? "none"}`,
		`source checksum: ${report.sourceChecksum}`,
		`canonical branches: ${report.canonicalBranchCount}`,
		`native branches: ${report.nativeBranchCount}`,
		`canonical nodes: ${report.canonicalNodeCount}`,
		`native nodes: ${report.nativeNodeCount}`,
		`active leaf: ${report.activeLeaf ?? "none"}`,
		`native active leaf: ${report.nativeActiveLeafId ?? "none"}`,
		`activated: ${report.activated ? "yes" : "no"}`,
		`CAS refs: ${JSON.stringify(report.casRefs)}`,
		`losses: ${JSON.stringify(report.losses)}`,
	];
	if (report.bridgeDigest !== undefined) lines.push(`bridge digest: ${report.bridgeDigest}`);
	return lines.join("\n");
}
